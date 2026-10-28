package gamesearch

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

// game.value and game.move: pflow-native's two commands
// (crates/core/src/commands/game.rs, crates/core/src/game.rs), on a net
// given in the call. Same arguments, same results, same refusals; what is
// different is said where it is (no Report artifact is stored, a plan
// naming the "ode" estimate is refused, the caps are the server's).

// pflow-native's caps. A Config can lower them.
const (
	// Nodes searched when neither the plan nor `nodes` sets a budget.
	Nodes = 1_000_000
	// MaxNodes is the largest node budget taken.
	MaxNodes = 100_000_000
	// PlanMemo is the transposition-table entries when the plan names none.
	PlanMemo = 1 << 20
	// MaxMemo is the largest table taken.
	MaxMemo = 1 << 23
)

// Config is what a caller may change about a run.
type Config struct {
	// MaxNodes and MaxMemo lower the caps (0 keeps pflow-native's).
	MaxNodes, MaxMemo int
	// Cancel is called every 1,024 nodes; an error stops the search.
	Cancel func() error
}

func (c Config) maxNodes() int {
	if c.MaxNodes > 0 {
		return c.MaxNodes
	}
	return MaxNodes
}

func (c Config) maxMemo() int {
	if c.MaxMemo > 0 {
		return c.MaxMemo
	}
	return MaxMemo
}

// Net is a net and its marking. Only a net with one token colour is run.
type Net struct {
	Model   *metamodel.Model
	Marking map[string]int64
}

// ---- the commands' arguments ----

type argType int

const (
	tStr argType = iota
	tInt
	tStrList
	tJSON
)

func (t argType) String() string { return [...]string{"Str", "Int", "StrList", "Json"}[t] }

func (t argType) accepts(v any) bool {
	switch t {
	case tStr:
		_, ok := v.(string)
		return ok
	case tInt:
		f, ok := v.(float64)
		return ok && f == math.Trunc(f)
	case tStrList:
		l, ok := v.([]any)
		if !ok {
			return false
		}
		for _, e := range l {
			if _, ok := e.(string); !ok {
				return false
			}
		}
		return true
	}
	return true
}

type argSpec struct {
	name     string
	ty       argType
	required bool
	help     string
}

// The arguments both commands take, as pflow-native's ARGS has them.
var argSpecs = []argSpec{
	{"sides", tJSON, true, "{transition-id prefix: sign}: who moves, e.g. {\"x_\": 1, \"o_\": -1} (+1 maximizes the reward)"},
	{"reward", tJSON, true, "{place: weight} read from the final marking, from the +1 side's view, e.g. {\"win_x\": 1, \"win_o\": -1}"},
	{"auto", tStrList, false, "transition-id prefixes that fire as soon as they are enabled, before anyone chooses (e.g. [\"x_win_\", \"o_win_\"]: win claims)"},
	{"plan", tJSON, false, "a SearchPlan (pflow-metamodel), or a JSON string of one: {mode, order, filters, root, drivers, memo}; default {}. A time budget (budget.ms) is refused. Root estimate \"ode\" solves the mass-action ODE with every transition at rate 1, not the session's rates"},
	{"nodes", tInt, false, "the node budget when the plan's drivers set none (default 1,000,000; at most 100,000,000)"},
	{"book", tStr, false, "an opening book: the text of a label cache as the experimental rnn commands write it to `labels` (JSONL, a header line naming the net and rules, then one position per line); its positions are pinned in the table, exact"},
}

// ArgNames are the arguments the commands take, in order.
func ArgNames() []string {
	out := make([]string, len(argSpecs))
	for i, a := range argSpecs {
		out[i] = a.name
	}
	return out
}

func sortedKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func compact(v any) string {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return fmt.Sprint(v)
	}
	return strings.TrimSuffix(sb.String(), "\n")
}

// checkArgs is pflow-native's CommandSpec::check_args: an argument the
// command does not take, a required one missing, or one of the wrong type,
// is refused before anything runs.
func checkArgs(id string, a map[string]any) error {
	for _, k := range sortedKeys(a) {
		known := false
		for _, s := range argSpecs {
			known = known || s.name == k
		}
		if !known {
			return fmt.Errorf("%s: unknown argument %s; takes %s", id, strconv.Quote(k), rustStrList(ArgNames()))
		}
	}
	for _, s := range argSpecs {
		v := a[s.name]
		if v == nil && s.required {
			return fmt.Errorf("%s: missing required argument %s (%s)", id, strconv.Quote(s.name), s.help)
		}
		if v != nil && !s.ty.accepts(v) {
			return fmt.Errorf("%s: argument %s should be %v, got %s", id, strconv.Quote(s.name), s.ty, compact(v))
		}
	}
	return nil
}

func argNum(a map[string]any, k string) (float64, bool) {
	f, ok := a[k].(float64)
	return f, ok
}

func argStr(a map[string]any, k string) (string, bool) {
	s, ok := a[k].(string)
	return s, ok
}

// jsonArg reads an argument that is a JSON value or a string holding one.
func jsonArg(a map[string]any, k string) (any, bool, error) {
	v := a[k]
	if v == nil {
		return nil, false, nil
	}
	if s, ok := v.(string); ok {
		var out any
		if err := json.Unmarshal([]byte(s), &out); err != nil {
			return nil, true, fmt.Errorf("%s: %s", k, jsonSyntax(err))
		}
		return out, true, nil
	}
	return v, true, nil
}

// jsonSyntax words a JSON syntax error as serde_json does, for the cases it
// is told apart (the position it adds, " at line 1 column 7", is not
// reproduced).
func jsonSyntax(err error) string {
	m := err.Error()
	switch {
	case strings.Contains(m, "unexpected end of JSON input"):
		return "EOF while parsing a value"
	case strings.Contains(m, "looking for beginning of value"):
		return "expected value"
	case strings.Contains(m, "in literal"):
		return "expected ident"
	case strings.Contains(m, "looking for beginning of object key string"):
		return "key must be a string"
	case strings.Contains(m, "after top-level value"):
		return "trailing characters"
	case strings.Contains(m, "after object key:value pair"):
		return "expected `,` or `}`"
	case strings.Contains(m, "after object key"):
		return "expected `:`"
	case strings.Contains(m, "after array element"):
		return "expected `,` or `]`"
	}
	return m
}

// ---- the rules: sides, reward, auto ----

type rules struct {
	sign   []float64
	reward []Reward
	auto   []bool
}

func hasPrefixAny(ts []string, p string) bool {
	for _, t := range ts {
		if strings.HasPrefix(t, p) {
			return true
		}
	}
	return false
}

func readRules(ix *Indexed, a map[string]any) (*rules, error) {
	ts := ix.Transitions
	// sides
	sidesV, ok, err := jsonArg(a, "sides")
	if err != nil {
		return nil, badArgs("%s", err.Error())
	}
	if !ok {
		return nil, badArgs("sides is required: {transition-id prefix: sign}, e.g. {\"x_\": 1, \"o_\": -1}")
	}
	obj, isObj := sidesV.(map[string]any)
	if !isObj {
		return nil, badArgs("sides must be an object {transition-id prefix: sign}")
	}
	type prefix struct {
		p string
		w float64
	}
	var prefixes []prefix
	for _, k := range sortedKeys(obj) {
		w, isNum := obj[k].(float64)
		if !isNum {
			return nil, badArgs("sides sign for %s must be a number", k)
		}
		if !hasPrefixAny(ts, k) {
			return nil, badArgs("sides names %s, which no transition id starts with", k)
		}
		prefixes = append(prefixes, prefix{k, w})
	}
	sign := make([]float64, len(ts))
	for i, t := range ts {
		best := -1
		for _, p := range prefixes {
			if strings.HasPrefix(t, p.p) && len(p.p) > best {
				best = len(p.p)
				sign[i] = p.w
			}
		}
	}
	// reward
	rewV, ok, err := jsonArg(a, "reward")
	if err != nil {
		return nil, badArgs("%s", err.Error())
	}
	if !ok {
		return nil, badArgs("reward is required: {place: weight}, e.g. {\"win_x\": 1, \"win_o\": -1}")
	}
	robj, isObj := rewV.(map[string]any)
	if !isObj {
		return nil, badArgs("reward must be an object {place: weight}")
	}
	var reward []Reward
	for _, k := range sortedKeys(robj) {
		w, isNum := robj[k].(float64)
		if !isNum {
			return nil, badArgs("reward weight for %s must be a number", k)
		}
		found := false
		for i, p := range ix.Places {
			if p == k {
				reward = append(reward, Reward{i, w})
				found = true
			}
		}
		if !found {
			return nil, badArgs("reward names %s, which is not a place of this net", k)
		}
	}
	// auto
	var prefs []string
	if l, ok := a["auto"].([]any); ok {
		for _, e := range l {
			if s, ok := e.(string); ok {
				prefs = append(prefs, s)
			}
		}
	}
	for _, p := range prefs {
		if !hasPrefixAny(ts, p) {
			return nil, badArgs("auto names %s, which no transition id starts with", p)
		}
	}
	auto := make([]bool, len(ts))
	for i, t := range ts {
		for _, p := range prefs {
			if strings.HasPrefix(t, p) {
				auto[i] = true
			}
		}
	}
	return &rules{sign, reward, auto}, nil
}

func badArgs(format string, args ...any) error { return fmt.Errorf(format, args...) }

// ---- the plan, with the defaults filled in ----

func asU64(v any) (uint64, bool) {
	f, ok := v.(float64)
	if !ok || f < 0 || f != math.Trunc(f) || f >= 1<<64 {
		return 0, false
	}
	return uint64(f), true
}

// readPlan is `plan` in game.rs: the plan `a` gives, with the node budget
// (`nodes` when the plan's drivers set none) and the table size filled in.
// It returns the plan and its node budget.
func readPlan(a map[string]any, cfg Config) (*SearchPlan, int, error) {
	bad := func(format string, args ...any) error {
		return fmt.Errorf("plan: "+format, args...)
	}
	maxNodes, maxMemo := cfg.maxNodes(), cfg.maxMemo()
	var p any = map[string]any{}
	if v := a["plan"]; v != nil {
		if text, ok := v.(string); ok {
			var out any
			if err := json.Unmarshal([]byte(text), &out); err != nil {
				return nil, 0, bad("%s", jsonSyntax(err))
			}
			p = out
		} else {
			p = v
		}
	}
	src, ok := p.(map[string]any)
	if !ok {
		return nil, 0, bad("a SearchPlan is a JSON object")
	}
	// The plan is changed below; leave the caller's alone.
	obj := make(map[string]any, len(src)+2)
	for k, v := range src {
		obj[k] = v
	}
	var nodes *int
	if x, ok := argNum(a, "nodes"); ok {
		if x >= 1 && x <= float64(maxNodes) {
			n := int(x)
			nodes = &n
		} else {
			return nil, 0, badArgs("nodes must be in 1..%d, got %s", maxNodes, rustF64(x))
		}
	}
	// Null window is on by default and off when `drivers` is given without
	// it, so a budget added to a plan without drivers keeps it.
	drivers, has := obj["drivers"]
	if !has || drivers == nil {
		drivers = []any{"null_window"}
	}
	var budget *uint64
	if list, ok := drivers.([]any); ok {
		list = append([]any(nil), list...)
		for _, d := range list {
			dm, ok := d.(map[string]any)
			if !ok {
				continue
			}
			b, ok := dm["budget"]
			if !ok {
				continue
			}
			bm, _ := b.(map[string]any)
			if ms := bm["ms"]; ms != nil {
				return nil, 0, bad("a time budget (budget.ms) is refused: the result would depend on the machine, and the " +
					"clock it needs is not there in the browser (wasm32); give a node budget")
			}
			// The last budget is the one the plan runs.
			budget = nil
			if n, ok := asU64(bm["nodes"]); ok {
				budget = &n
			}
		}
		switch {
		case budget != nil && nodes != nil:
			return nil, 0, badArgs("give the node budget once: in the plan's drivers or as nodes")
		case budget != nil && *budget > uint64(maxNodes):
			return nil, 0, bad("budget.nodes must be at most %d, got %d", maxNodes, *budget)
		case budget != nil:
		default:
			n := Nodes
			if nodes != nil {
				n = *nodes
			}
			list = append(list, map[string]any{"budget": map[string]any{"nodes": float64(n)}})
			u := uint64(n)
			budget = &u
		}
		drivers = list
	}
	obj["drivers"] = drivers
	switch m := obj["memo"].(type) {
	case nil:
		obj["memo"] = map[string]any{"entries": float64(PlanMemo)}
	default:
		if mm, ok := m.(map[string]any); ok {
			if e, ok := asU64(mm["entries"]); ok && e > uint64(maxMemo) {
				return nil, 0, bad("memo.entries must be at most %d, got %d", maxMemo, e)
			}
		}
	}
	plan, err := ParseSearchPlan(obj)
	if err != nil {
		return nil, 0, err
	}
	if err := plan.Check(); err != nil {
		return nil, 0, err
	}
	n := Nodes
	if budget != nil {
		n = int(*budget)
	}
	return plan, n, nil
}

// ---- the book ----

func bookError(format string, args ...any) error {
	return fmt.Errorf("book: "+format, args...)
}

func f64s(v []float64) []any {
	out := make([]any, len(v))
	for i, x := range v {
		out[i] = x
	}
	return out
}

// readBook is `book` in game.rs and Book::from_labels: the book a label
// cache `text` holds for g.
func readBook(g *Game, text string) (*Book, error) {
	all := strings.Split(text, "\n")
	// str::lines: no empty last line from a final newline, and \r\n.
	if len(all) > 0 && all[len(all)-1] == "" {
		all = all[:len(all)-1]
	}
	for i := range all {
		all[i] = strings.TrimSuffix(all[i], "\r")
	}
	for n := 1; n < len(all); n++ {
		var x map[string]any
		if json.Unmarshal([]byte(all[n]), &x) != nil {
			continue
		}
		if vals, ok := x["vals"].([]any); ok && len(vals) == 0 {
			return nil, badArgs("book line %d: no values; a label line values the moves of a position that has some", n+1)
		}
	}
	var head map[string]any
	first := ""
	if len(all) > 0 {
		first = all[0]
	}
	if err := json.Unmarshal([]byte(first), &head); err != nil {
		return nil, bookError("header: %s", jsonSyntax(err))
	}
	places := make([]any, len(g.Ix.Places))
	for i, p := range g.Ix.Places {
		places[i] = p
	}
	trans := make([]any, len(g.Ix.Transitions))
	for i, p := range g.Ix.Transitions {
		trans[i] = p
	}
	auto := make([]any, len(g.Auto))
	for i, b := range g.Auto {
		auto[i] = b
	}
	rewardKey := func(rs [][2]float64) [][2]float64 {
		out := append([][2]float64(nil), rs...)
		sort.Slice(out, func(i, j int) bool {
			if out[i][0] != out[j][0] {
				return out[i][0] < out[j][0]
			}
			return out[i][1] < out[j][1]
		})
		return out
	}
	var want [][2]float64
	for _, r := range g.Reward {
		want = append(want, [2]float64{float64(r.Place), r.Weight})
	}
	for _, f := range []struct {
		name string
		want any
	}{
		{"labels", float64(1)},
		{"places", places},
		{"transitions", trans},
		{"auto", auto},
		{"sign", f64s(g.Sign)},
		{"reward", nil},
	} {
		same := false
		if f.name == "reward" {
			var got [][2]float64
			l, ok := head["reward"].([]any)
			same = ok
			for _, e := range l {
				pair, ok := e.([]any)
				if !ok || len(pair) != 2 {
					same = false
					break
				}
				p, ok1 := pair[0].(float64)
				w, ok2 := pair[1].(float64)
				if !ok1 || !ok2 {
					same = false
					break
				}
				got = append(got, [2]float64{p, w})
			}
			same = same && reflect.DeepEqual(rewardKey(got), rewardKey(want)) || (same && len(got) == 0 && len(want) == 0)
		} else {
			same = reflect.DeepEqual(head[f.name], f.want)
		}
		if !same {
			return nil, bookError("the labels' %s is not this game's: they are for another net or other rules", strconv.Quote(f.name))
		}
	}
	book := &Book{}
	lines := all[1:]
	for n, line := range lines {
		at := func(format string, args ...any) error {
			return bookError("line %d: "+format, append([]any{n + 2}, args...)...)
		}
		var x map[string]any
		if err := json.Unmarshal([]byte(line), &x); err != nil {
			if n+1 == len(lines) {
				break
			}
			return nil, at("%s", jsonSyntax(err))
		}
		mkAny, ok := x["mk"].([]any)
		if !ok {
			return nil, at("invalid type: %s, expected a sequence", serdeUnexpected(x["mk"]))
		}
		mk := make([]int64, len(mkAny))
		for i, e := range mkAny {
			f, ok := e.(float64)
			if !ok || f != math.Trunc(f) {
				return nil, at("invalid type: %s, expected i64", serdeUnexpected(e))
			}
			mk[i] = int64(f)
		}
		if x["vals"] == nil {
			continue
		}
		valsAny, ok := x["vals"].([]any)
		if !ok {
			return nil, at("invalid type: %s, expected a sequence", serdeUnexpected(x["vals"]))
		}
		vals := make([]float64, len(valsAny))
		for i, e := range valsAny {
			f, ok := e.(float64)
			if !ok {
				return nil, at("invalid type: %s, expected f64", serdeUnexpected(e))
			}
			vals[i] = f
		}
		if len(mk) != len(g.Ix.Places) {
			return nil, at("a marking of %d places, for a net of %d", len(mk), len(g.Ix.Places))
		}
		moves := g.Moves(mk)
		if len(moves) == 0 {
			return nil, at("a final position: there is no move to label")
		}
		if len(moves) != len(vals) {
			return nil, at("%d values for the %d moves there", len(vals), len(moves))
		}
		s, err := g.Mover(moves)
		if err != nil {
			return nil, err
		}
		best := 0
		for i, t := range moves {
			v := vals[i]
			if v > vals[best] {
				best = i
			}
			next, err := g.play(mk, t)
			if err != nil {
				return nil, err
			}
			book.Add(next, s*v, -1)
		}
		book.Add(mk, s*vals[best], moves[best])
	}
	return book, nil
}

// ---- the commands ----

type search struct {
	ix     *Indexed
	g      *Game
	plan   *SearchPlan
	budget int
	book   *Book
	mk     []int64
	moves  []int
	cfg    Config
}

func newSearch(net *Net, a map[string]any, cfg Config) (*search, error) {
	ix := NewIndexed(net.Model)
	r, err := readRules(ix, a)
	if err != nil {
		return nil, err
	}
	plan, budget, err := readPlan(a, cfg)
	if err != nil {
		return nil, err
	}
	g := NewGame(ix, r.auto, r.sign, r.reward)
	x := &search{ix: ix, g: g, plan: plan, budget: budget, cfg: cfg}
	if text, ok := argStr(a, "book"); ok {
		if x.book, err = readBook(g, text); err != nil {
			return nil, err
		}
	}
	mk := ix.Dense(net.Marking)
	if err := g.Settle(mk); err != nil {
		return nil, err
	}
	x.mk = mk
	x.moves = g.Moves(mk)
	return x, nil
}

// mover is Dense::mover: the side every move shares, or why not.
func (x *search) mover() (float64, error) {
	s, err := x.g.Mover(x.moves)
	if err != nil {
		return 0, fmt.Errorf("%v; give every transition a side in `sides`, and mark transitions nobody chooses (e.g. win claims) `auto`", err)
	}
	return s, nil
}

// solver is a solver running the plan, the book pinned in its table.
func (x *search) solver() (*Solver, error) {
	o, err := x.plan.Options()
	if err != nil {
		return nil, err
	}
	o.Cancel = x.cfg.Cancel
	if name, ok, err := x.plan.Estimate(); err != nil {
		return nil, err
	} else if ok {
		switch name {
		case "ode":
			o.Estimate = NewOdeEstimate(x.g, x.cfg.Cancel)
		default:
			return nil, fmt.Errorf("search plan: the root names estimate %q, which is not built into this server", name)
		}
	}
	s, err := NewSolver(x.g, o)
	if err != nil {
		return nil, err
	}
	if x.book != nil {
		s.WithBook(x.book)
	}
	return s, nil
}

// nodes is the nodes the solver searched. Past the budget it counts the node
// that stopped it, one more than the budget: that one is not reported.
func (x *search) nodes(s *Solver) int {
	if n := s.Nodes(); n < x.budget {
		return n
	}
	return x.budget
}

func (x *search) common() map[string]any {
	out := map[string]any{"budget": x.budget, "book": nil}
	if x.book != nil {
		out["book"] = x.book.Len()
	}
	return out
}

func merge(out, more map[string]any) map[string]any {
	for k, v := range more {
		out[k] = v
	}
	return out
}

func numOrNull(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

// Value is game.value: the exact value of the net's position, from the +1
// side's view, with both sides playing perfectly. The value is null when
// the search runs past its node budget (`nodes` then reports the budget).
func Value(net *Net, args map[string]any, cfg Config) (map[string]any, error) {
	if err := checkArgs("game.value", args); err != nil {
		return nil, err
	}
	x, err := newSearch(net, args, cfg)
	if err != nil {
		return nil, err
	}
	if len(x.moves) == 0 {
		score, err := x.g.Score(x.mk)
		if err != nil {
			return nil, err
		}
		return merge(map[string]any{"value": score, "exact": true, "nodes": 0, "mover": nil, "moves": 0}, x.common()), nil
	}
	mover, err := x.mover()
	if err != nil {
		return nil, err
	}
	s, err := x.solver()
	if err != nil {
		return nil, err
	}
	v, ok, err := s.Value(x.mk)
	if err != nil {
		return nil, err
	}
	var vp *float64
	if ok {
		vp = &v
	}
	return merge(map[string]any{
		"value": numOrNull(vp), "exact": ok, "nodes": x.nodes(s), "mover": mover, "moves": len(x.moves),
	}, x.common()), nil
}

// Move is game.move: a best move at the net's position and its exact value.
// Past the node budget there is no move (transition null, reason "past the
// budget"), unless the plan's mode is "play", where the move is a guess
// (exact false). The move is not fired.
func Move(net *Net, args map[string]any, cfg Config) (map[string]any, error) {
	if err := checkArgs("game.move", args); err != nil {
		return nil, err
	}
	x, err := newSearch(net, args, cfg)
	if err != nil {
		return nil, err
	}
	if len(x.moves) == 0 {
		score, err := x.g.Score(x.mk)
		if err != nil {
			return nil, err
		}
		return merge(map[string]any{
			"transition": nil, "value": score, "exact": true, "nodes": 0,
			"reason": "no move: the position is final",
		}, x.common()), nil
	}
	if _, err := x.mover(); err != nil {
		return nil, err
	}
	s, err := x.solver()
	if err != nil {
		return nil, err
	}
	c, err := s.Choose(x.mk)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if c != nil {
		out = map[string]any{
			"transition": x.ix.Transitions[c.T], "value": numOrNull(c.Value), "exact": c.Exact, "nodes": x.nodes(s),
		}
		if !c.Exact {
			out["reason"] = "past the budget: a guess (mode \"play\"), not proven best"
		}
	} else {
		out = map[string]any{
			"transition": nil, "value": nil, "exact": false, "nodes": x.nodes(s),
			"reason": "past the budget: no move was proven best within it (mode \"play\" guesses one)",
		}
	}
	return merge(out, x.common()), nil
}
