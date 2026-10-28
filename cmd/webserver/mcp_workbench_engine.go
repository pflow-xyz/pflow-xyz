package main

// The engines behind the /mcp workbench tools (mcp_workbench.go): ports of
// what pflow-native runs for sim.sde, sim.what_if (sim.compare and
// sim.scenario) and opt.optimize, on go-pflow's engines.
//
// pflow-native is the reference. Its stochastic engines are pflow-solver's
// ports of go-pflow's, held byte-exact to go-pflow's portable path, so with
// the same model, rates and seed the SDE and the scenario SSA here give the
// same doubles native does. Its ODE is pflow-solver's Tsit5, the same
// algorithm as go-pflow's; the optimizer here integrates with go-pflow's
// tableaux in pflow-solver's summation order (odeRunner), so it gives the same
// doubles too unless a math library's last bit differs. What this file adds is
// everything around the engines, ported line by line from
// pflow-native-core (crates/core/src/commands/stochastic.rs, stochastic.rs,
// commands/opt.rs, sweep.rs, sim.rs at the commit pflow-native-wasm.lock
// names): defaults, caps, validation and its messages, realization seeding,
// aggregation, and the shape of the answer. parity/native/mcp_goldens.json,
// generated from native, holds it to that (mcp_workbench_parity_test.go).
//
// One difference cannot be ported: native lists places in the document's
// order, and the order of a JSON object's members does not survive decoding
// the call, so places come here in id order (colors in declaration order).
// That changes the order of series, table columns and the place list in two
// messages, never a number. Transitions are in id order on both sides
// (both parsers sort them), which is the order the engines draw randomness in.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/pflow-xyz/go-pflow/crmath"
	"github.com/pflow-xyz/go-pflow/metamodel"
	"github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/go-pflow/petri"
	"github.com/pflow-xyz/go-pflow/solver"
	"github.com/pflow-xyz/go-pflow/stochastic"
)

// pflow-native's caps (stochastic.rs, sweep.rs) and defaults; the MCP tools
// tighten some of them (mcp_workbench.go).
const (
	wbMaxRuns          = 200
	wbMaxHorizon       = 10_000.0
	wbMaxPlaceTokens   = 1_000_000
	wbMaxTotalTokens   = 4_000_000
	wbMaxSDESteps      = 50_000
	wbScenarioSamples  = 60
	wbSDEInternalSteps = 20
)

// ---- formatting, as pflow-native's messages print values ----

// rustFloat prints a float as Rust's Display does: shortest round-trip
// digits, never an exponent (1e-05 is "0.00001", 3.0 is "3").
func rustFloat(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// rustList prints strings as Rust's {:?} of a Vec<String>: ["a", "b"].
func rustList(xs []string) string {
	q := make([]string, len(xs))
	for i, x := range xs {
		q[i] = strconv.Quote(x)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

// rustI64 is Rust's `f as i64`: toward zero, saturating at the type's
// bounds, NaN as 0. Go's int64(f) is undefined out of range (1e300 printed
// as -9223372036854775808).
func rustI64(f float64) int64 {
	switch {
	case f != f:
		return 0
	case f >= 1<<63:
		return math.MaxInt64
	case f <= -(1 << 63):
		return math.MinInt64
	}
	return int64(f)
}

// rustU64 is Rust's `f as u64`: toward zero, saturating, NaN as 0.
func rustU64(f float64) uint64 {
	switch {
	case f != f || f <= 0:
		return 0
	case f >= 1<<64:
		return math.MaxUint64
	}
	return uint64(f)
}

// ---- the answer: JSON-safe, and small enough for the /mcp result guard ----

// jsonSafe is v with every NaN and ±Inf as null, as pflow-native writes them
// (serde_json's json! maps a non-finite f64 to null). encoding/json refuses
// them outright, which would fail the whole call ("result is not JSON").
func jsonSafe(v any) any {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return nil
		}
		return x
	case []float64:
		for _, f := range x {
			if math.IsNaN(f) || math.IsInf(f, 0) {
				out := make([]any, len(x))
				for i, g := range x {
					out[i] = jsonSafe(g)
				}
				return out
			}
		}
		return x
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = jsonSafe(e)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = jsonSafe(e)
		}
		return out
	}
	return v
}

// wbNumBytes bounds one number in an answer, with its separator:
// encoding/json writes a float64 in at most 25 characters
// (-0.0000012345678901234567). The upper bounds on an answer's size count
// every number at that length; the lower bounds at two ("0,").
const wbNumBytes = 26

// jsonLen is the bytes s takes as a JSON string (encoding/json escapes <, >
// and & as < and friends).
func jsonLen(s string) int {
	b, _ := json.Marshal(s)
	return len(b)
}

// answerBytes is the size of the text a tools/call result carries.
func answerBytes(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return math.MaxInt
	}
	return len(b)
}

// sizing is how a tool fits its answer's count of points (or samples) to the
// /mcp result guard, which would otherwise cut the answer's arrays.
type sizing struct {
	tool, what string // "pflow_sde", "points"
	def, min   int
	explicit   bool // the caller chose the count
	budget     int  // bytes
	// upper and lower bound the answer's bytes with count n: every number at
	// its longest (wbNumBytes) or its shortest ("0,"), the names as written.
	upper, lower func(n int) int
	// grid is how many points the answer's arrays hold with count n.
	grid func(n int) int
	hint string // what else makes the answer smaller
}

// fitAnswer builds the answer with count n, or a smaller one, so that it
// fits whole. When the upper bound says it fits it is built once. A count the
// caller chose that the lower bound says cannot fit is refused before
// anything runs, naming a count that fits for certain; in between, the answer
// is built and measured, and if it does not fit refused, naming the count its
// measured size says would. The default count is lowered instead, as far as
// the bounds and then the measured size say, and the answer says so in
// `note`. It is never cut.
func fitAnswer(s sizing, req int, build func(n int) (map[string]any, error)) (map[string]any, error) {
	// A lowered default says so; the note counts toward the answer's size.
	withNote := func(out map[string]any, k int) map[string]any {
		if k != req {
			out["note"] = fmt.Sprintf("%s is %d, not the default %d, so that the answer fits this server's %d-byte limit (%s)",
				s.what, k, s.def, s.budget, s.hint)
		}
		return out
	}
	finish := func(out map[string]any, k int) (map[string]any, error) {
		out = withNote(out, k)
		// The last guard: a caveat the engine wrote could be longer than
		// the bounds allow for. An answer that does not fit is an error.
		if b := answerBytes(out); b > s.budget {
			return nil, fmt.Errorf("%s: the answer came to %d bytes, over this server's %d-byte limit; %s", s.tool, b, s.budget, s.hint)
		}
		return out, nil
	}
	tooBig := func(k int) error {
		return fmt.Errorf("the answer would pass this server's %d-byte limit even at %d %s; %s", s.budget, k, s.what, s.hint)
	}
	sure := req // the most the upper bound says fit
	for sure >= s.min && s.upper(sure) > s.budget {
		sure--
	}
	if sure == req {
		out, err := build(req)
		if err != nil {
			return nil, err
		}
		return finish(out, req)
	}
	k := req
	if s.lower(k) > s.budget {
		if s.explicit {
			if sure >= s.min {
				return nil, fmt.Errorf("%s %d would make an answer of at least %d bytes, over this server's %d-byte limit; %d fit for certain, or %s",
					s.what, req, s.lower(req), s.budget, sure, s.hint)
			}
			return nil, fmt.Errorf("%s %d would make an answer of at least %d bytes, over this server's %d-byte limit; %s",
				s.what, req, s.lower(req), s.budget, s.hint)
		}
		for k > s.min && s.lower(k) > s.budget {
			k--
		}
		if s.lower(k) > s.budget {
			return nil, tooBig(k)
		}
	}
	for tries := 0; tries < 3 && k > sure; tries++ {
		out, err := build(k)
		if err != nil {
			return nil, err
		}
		size := answerBytes(withNote(out, k))
		if size <= s.budget {
			return finish(out, k)
		}
		// What the arrays that grow with the count take, per point, says
		// how many points would fit next to the rest.
		fixed := answerBytes(withoutPoints(out))
		fit := k - 1
		if points := s.grid(k); points > 0 && size > fixed {
			most := int(float64(s.budget-fixed) / (float64(size-fixed) / float64(points)) * 0.98)
			for fit >= s.min && s.grid(fit) > most {
				fit--
			}
		}
		if s.explicit {
			if fit >= s.min {
				return nil, fmt.Errorf("%s %d makes an answer of %d bytes, over this server's %d-byte limit; about %d fit, or %s",
					s.what, req, size, s.budget, fit, s.hint)
			}
			return nil, fmt.Errorf("%s %d makes an answer of %d bytes, over this server's %d-byte limit; %s",
				s.what, req, size, s.budget, s.hint)
		}
		if fit < s.min {
			return nil, tooBig(s.min)
		}
		k = fit
	}
	if sure < s.min {
		return nil, tooBig(s.min)
	}
	out, err := build(sure)
	if err != nil {
		return nil, err
	}
	return finish(out, sure)
}

// withoutPoints is an answer with its time series' arrays emptied: what the
// answer takes whatever its count of points.
func withoutPoints(out map[string]any) map[string]any {
	c := make(map[string]any, len(out))
	for k, v := range out {
		c[k] = v
	}
	ts, ok := out["timeseries"].(map[string]any)
	if !ok {
		return c
	}
	t2 := make(map[string]any, len(ts))
	for k, v := range ts {
		t2[k] = v
	}
	t2["x"] = []any{}
	series := []any{}
	list, _ := ts["series"].([]any)
	for _, e := range list {
		m, _ := e.(map[string]any)
		m2 := make(map[string]any, len(m))
		for k, v := range m {
			m2[k] = v
		}
		m2["values"] = []any{}
		if _, ok := m2["band"]; ok {
			m2["band"] = []any{}
		}
		series = append(series, m2)
	}
	t2["series"] = series
	c["timeseries"] = t2
	return c
}

// ---- arguments, read with pflow-native's rules ----

// wbArgs is a tool call's arguments. JSON numbers decode to float64; an
// absent key and null are the same (native's `n(a, k)` and friends).
type wbArgs map[string]any

func (a wbArgs) num(k string) (float64, bool) {
	v, ok := a[k].(float64)
	return v, ok
}

func (a wbArgs) has(k string) bool { return a[k] != nil }

// uint is native's `uint`: absent is the default, negative an error.
func (a wbArgs) uint(k string, def int) (int, error) {
	x, ok := a.num(k)
	if !ok {
		return def, nil
	}
	if x < 0 {
		return 0, fmt.Errorf("%s must be ≥ 0, got %s", k, rustFloat(x))
	}
	if x > math.MaxInt32 {
		return math.MaxInt32, nil // over every cap; the caller's range check says so
	}
	return int(x), nil
}

// seed is native's `parse_seed`: a non-negative integer.
func (a wbArgs) seed(k string, def uint64) (uint64, error) {
	v, ok := a[k]
	if !ok || v == nil {
		return def, nil
	}
	x, ok := v.(float64)
	if !ok || math.IsInf(x, 0) || math.IsNaN(x) {
		return 0, fmt.Errorf("%s must be a finite number, got %v", k, jsonText(v))
	}
	if x != math.Trunc(x) {
		return 0, fmt.Errorf("%s must be an integer, got %s", k, jsonText(v))
	}
	if x < 0 {
		return 0, fmt.Errorf("%s must be ≥ 0, got %d", k, rustI64(x))
	}
	if x > 1<<53 {
		return 0, fmt.Errorf("%s must be at most %d", k, int64(1<<53))
	}
	return uint64(x), nil
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// argKind is what a tool argument must be.
type argKind int

const (
	argAny argKind = iota
	argNum
	argInt
	argStr
	argBool
	argStrList
)

var argKindName = map[argKind]string{argNum: "a number", argInt: "an integer", argStr: "a string", argBool: "a boolean", argStrList: "a list of strings"}

// checkArgs refuses an argument the tool does not take, or one of the wrong
// type (native's `CommandSpec::check_args`), before anything runs.
func checkArgs(tool string, a map[string]any, kinds map[string]argKind) error {
	for _, k := range sortedKeys(a) {
		kind, ok := kinds[k]
		if !ok {
			return fmt.Errorf("%s: unknown argument %q; takes %s", tool, k, rustList(sortedKeys(kinds)))
		}
		v := a[k]
		if v == nil || kind == argAny {
			continue
		}
		good := false
		switch kind {
		case argNum:
			_, good = v.(float64)
		case argInt:
			f, isNum := v.(float64)
			good = isNum && f == math.Trunc(f) && !math.IsInf(f, 0)
		case argStr:
			_, good = v.(string)
		case argBool:
			_, good = v.(bool)
		case argStrList:
			if l, isList := v.([]any); isList {
				good = true
				for _, x := range l {
					if _, s := x.(string); !s {
						good = false
					}
				}
			}
		}
		if !good {
			return fmt.Errorf("%s: argument %q should be %s, got %s", tool, k, argKindName[kind], jsonText(v))
		}
	}
	return nil
}

func checkRuns(what string, n int) error {
	if n < 1 || n > wbMaxRuns {
		return fmt.Errorf("%s %d is outside 1..%d", what, n, wbMaxRuns)
	}
	return nil
}

func checkSamples(what string, n, max int) error {
	if n < 2 || n > max {
		return fmt.Errorf("%s %d is outside 2..%d", what, n, max)
	}
	return nil
}

func checkHorizon(what string, h, max float64) error {
	if !(h > 0 && h <= max) {
		return fmt.Errorf("%s %s is outside (0, %s]", what, rustFloat(h), rustFloat(max))
	}
	return nil
}

// ---- the net, as native's stochastic engines see it ----

// wbNet is native's stochastic::Net: the document compiled to the metamodel
// (colors unfolded, output-side inhibitors as read arcs) with its token
// places in display order and display names (`place`, or `place.color`).
type wbNet struct {
	doc     map[string]any
	raw     []byte // the executable document, as JSON
	model   *metamodel.Model
	colors  *petri.ColorMap
	places  []string // token places (model ids), display order
	display []string // aligned with places
	// rates are the document's `rate` fields: native's session rates, which
	// file.load_json takes from the same fields. Absent means 1.
	rates map[string]float64
}

// executableDoc is native's sim::executable: an arc whose weights are all
// zero moves and tests nothing in pflow.xyz, but the engines read weight 0 as
// "unset" (1), so it is dropped. Inhibitor arcs are kept as written.
func executableDoc(doc map[string]any) map[string]any {
	arcs, _ := doc["arcs"].([]any)
	inert := func(a any) bool {
		m, ok := a.(map[string]any)
		if !ok || m["inhibitTransition"] == true {
			return false
		}
		switch w := m["weight"].(type) {
		case float64:
			return w == 0
		case []any:
			if len(w) == 0 {
				return false
			}
			for _, x := range w {
				if f, _ := x.(float64); f != 0 {
					return false
				}
			}
			return true
		}
		return false
	}
	kept := make([]any, 0, len(arcs))
	for _, a := range arcs {
		if !inert(a) {
			kept = append(kept, a)
		}
	}
	if len(kept) == len(arcs) {
		return doc
	}
	out := make(map[string]any, len(doc))
	for k, v := range doc {
		out[k] = v
	}
	out["arcs"] = kept
	return out
}

func newWBNet(doc map[string]any) (*wbNet, error) {
	exec := executableDoc(doc)
	raw, err := json.Marshal(exec)
	if err != nil {
		return nil, err
	}
	model, cm, err := parser.ModelFromJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	n := &wbNet{doc: doc, raw: raw, model: model, colors: cm, rates: ratesOf(doc)}
	type key struct {
		base  string
		color int
		id    string
	}
	var keys []key
	for i := range model.Places {
		if p := &model.Places[i]; p.IsToken() {
			b, c := n.base(p.ID)
			keys = append(keys, key{b, c, p.ID})
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := keys[i], keys[j]
		if a.base != b.base {
			return a.base < b.base
		}
		if a.color != b.color {
			return a.color < b.color
		}
		return a.id < b.id
	})
	for _, k := range keys {
		n.places = append(n.places, k.id)
		n.display = append(n.display, n.displayOf(k.id))
	}
	return n, nil
}

// base is the document place and color index of a model place.
func (n *wbNet) base(id string) (string, int) {
	if n.colors != nil {
		if r, ok := n.colors.Base[id]; ok {
			return r.Place, r.Color
		}
	}
	return id, 0
}

func (n *wbNet) displayOf(id string) string {
	if n.colors != nil {
		if r, ok := n.colors.Base[id]; ok {
			c := strconv.Itoa(r.Color)
			if r.Color < len(n.colors.Colors) {
				c = n.colors.Colors[r.Color]
			}
			return r.Place + "." + c
		}
	}
	return id
}

// resolvePlace is native's Net::resolve_place: a model id, a display name,
// or a document place that unfolded to exactly one token place.
func (n *wbNet) resolvePlace(key string) (string, error) {
	for i, p := range n.places {
		if p == key || n.display[i] == key {
			return p, nil
		}
	}
	var copies []string
	for _, p := range n.places {
		if b, _ := n.base(p); b == key {
			copies = append(copies, p)
		}
	}
	switch len(copies) {
	case 1:
		return copies[0], nil
	case 0:
		return "", fmt.Errorf("no token place %q; places are %s", key, rustList(n.display))
	}
	names := make([]string, len(copies))
	for i, p := range copies {
		names[i] = n.displayOf(p)
	}
	return "", fmt.Errorf("place %q holds several colors; name one of %s", key, rustList(names))
}

// start is the net's marking over the token places, read as native reads it
// (sim::initial_marking): the document's count for the place's color,
// rounded. go-pflow's parser would truncate a fractional count instead.
func (n *wbNet) start() map[string]int {
	places, _ := n.doc["places"].(map[string]any)
	out := make(map[string]int, len(n.places))
	for _, id := range n.places {
		b, c := n.base(id)
		v := 0.0
		if p, ok := places[b].(map[string]any); ok {
			switch x := p["initial"].(type) {
			case []any:
				if c < len(x) {
					v, _ = x[c].(float64)
				}
			case float64:
				if c == 0 {
					v = x
				}
			}
		}
		out[id] = int(math.Round(v))
	}
	return out
}

func (n *wbNet) rate(t string) float64 {
	if r, ok := n.rates[t]; ok {
		return r
	}
	return 1
}

// checkTokens is native's check_tokens: a starting marking over the caps is
// refused. The per-place cap guards the scenario engine's ledger.
func checkTokens(start map[string]int, perPlace bool) error {
	total := 0
	for _, k := range sortedKeys(start) {
		v := start[k]
		if v < 0 {
			return fmt.Errorf("marking for %q is negative (%d)", k, v)
		}
		if perPlace && v > wbMaxPlaceTokens {
			return fmt.Errorf("marking for %q is %d, over the %d cap", k, v, wbMaxPlaceTokens)
		}
		total += v
	}
	if total > wbMaxTotalTokens {
		return fmt.Errorf("marking totals %d tokens, over the %d cap", total, wbMaxTotalTokens)
	}
	return nil
}

// checkNetSize is this server's cap on the net the workbench tools take,
// whatever the arguments.
func (n *wbNet) checkNetSize() error {
	if len(n.places) > wbMaxPlaces {
		return fmt.Errorf("the net has %d token places (colours unfolded), over this server's cap of %d", len(n.places), wbMaxPlaces)
	}
	if t := len(n.model.Transitions); t > wbMaxTransitions {
		return fmt.Errorf("the net has %d transitions, over this server's cap of %d", t, wbMaxTransitions)
	}
	return nil
}

// seriesFilter is which places a `places` filter keeps (a display name, or a
// document place for all its colors), aligned with n.places; all of them
// without a filter.
func (n *wbNet) seriesFilter(filter []string) ([]bool, error) {
	keep := make([]bool, len(n.places))
	if filter == nil {
		for i := range keep {
			keep[i] = true
		}
		return keep, nil
	}
	for _, f := range filter {
		found := false
		for i, p := range n.places {
			if b, _ := n.base(p); n.display[i] == f || b == f {
				keep[i] = true
				found = true
			}
		}
		if !found {
			return nil, fmt.Errorf("places: no place %q; places are %s", f, rustList(n.display))
		}
	}
	return keep, nil
}

// selectSeries keeps the series of the places keep names, in their order.
func (n *wbNet) selectSeries(series []any, keep []bool) []any {
	kept := map[string]bool{}
	for i, k := range keep {
		if k {
			kept[n.display[i]] = true
		}
	}
	out := []any{}
	for _, s := range series {
		if kept[s.(map[string]any)["name"].(string)] {
			out = append(out, s)
		}
	}
	return out
}

// downsample is native's sim::downsample: indices thinning n samples to at
// most max points, keeping the last.
func downsample(n, max int) []int {
	if max < 2 {
		max = 2
	}
	stride := (n + max - 1) / max
	if stride < 1 {
		stride = 1
	}
	var idx []int
	for i := 0; i < n; i += stride {
		idx = append(idx, i)
	}
	if n > 0 && idx[len(idx)-1] != n-1 {
		idx = append(idx, n-1)
	}
	return idx
}

// downsampleLen is len(downsample(n, max)), without the slice.
func downsampleLen(n, most int) int {
	if n <= 0 {
		return 0
	}
	most = max(most, 2)
	stride := max((n+most-1)/most, 1)
	k := (n + stride - 1) / stride
	if (k-1)*stride != n-1 {
		k++
	}
	return k
}

func pick(v []float64, idx []int) []float64 {
	out := make([]float64, len(idx))
	for i, j := range idx {
		out[i] = v[j]
	}
	return out
}

func last(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	return v[len(v)-1]
}

// ---- pflow_sde: native sim.sde ----

// sdeGating is the refusal native's SDE makes (pflow-solver's
// gating_reasons, worded as go-pflow's Gating), over the model native hands
// it: transitions at rate 0 left out with their arcs. A capacity counts only
// where some transition's net delta raises the place.
func (n *wbNet) sdeGating(m *metamodel.Model) []string {
	var reads, inhibits, static int
	raised := map[string]bool{}
	delayed := false
	for i := range m.Transitions {
		t := &m.Transitions[i]
		if t.Delay > 0 {
			delayed = true
		}
		delta := map[string]int{}
		for _, a := range m.Inputs(t.ID) {
			delta[a.Place] -= max(a.Weight, 1)
			if !a.Kinetic {
				static++
			}
		}
		for _, a := range m.Outputs(t.ID) {
			delta[a.Place] += max(a.Weight, 1)
		}
		for _, a := range m.Tests(t.ID) {
			if a.Type == metamodel.InhibitorArc {
				inhibits++
			} else {
				reads++
			}
		}
		for p, d := range delta {
			if d > 0 {
				raised[p] = true
			}
		}
	}
	var out []string
	if reads > 0 {
		out = append(out, fmt.Sprintf("%d read arc(s) gate a firing without consuming; a continuous solver cannot test them", reads))
	}
	if inhibits > 0 {
		out = append(out, fmt.Sprintf("%d inhibitor arc(s) block a firing above a threshold; a continuous solver cannot test them", inhibits))
	}
	if static > 0 {
		out = append(out, fmt.Sprintf("%d non-kinetic input arc(s) gate and consume without scaling the rate; a mass-action solver has no way to omit them from the rate law", static))
	}
	var caps []string
	for _, id := range n.places {
		if p := m.PlaceByID(id); p != nil && p.Capacity > 0 && raised[id] {
			caps = append(caps, id)
		}
	}
	if len(caps) > 0 {
		out = append(out, fmt.Sprintf("capacity is declared on [%s] but is a post-firing bound, which has no continuous analogue", strings.Join(caps, " ")))
	}
	if delayed {
		out = append(out, "a delay is a deterministic timer — inputs consumed at start, outputs a fixed time later — which mass action cannot express")
	}
	return out
}

// sdeModel is the model native's SDE runs (Net::ssa_model): a transition at
// rate 0 is left out with its arcs (0 disables it there), every other rate is
// explicit.
func (n *wbNet) sdeModel() (*metamodel.Model, map[string]float64) {
	m := *n.model
	m.Transitions = nil
	m.Arcs = nil
	rates := map[string]float64{}
	drop := map[string]bool{}
	for _, t := range n.model.Transitions {
		if r := n.rate(t.ID); r > 0 {
			m.Transitions = append(m.Transitions, t)
			rates[t.ID] = r
		} else {
			drop[t.ID] = true
		}
	}
	for _, a := range n.model.Arcs {
		if !drop[a.From] && !drop[a.To] {
			m.Arcs = append(m.Arcs, a)
		}
	}
	m.Places = append([]metamodel.Place(nil), n.model.Places...)
	return &m, rates
}

// sdeOpts are pflow_sde's caps beyond native's.
type sdeOpts struct {
	maxPoints int
	maxWork   int // realizations × sample intervals × (transitions × (places + wbSDETransitionCost) + 2 × places)
	maxCells  int // samples × places
	maxBytes  int // the answer
}

// sdeSize bounds pflow_sde's answer in bytes as a function of the points it
// returns, with every number taking num bytes and slack bytes for the keys
// and a note.
func (n *wbNet) sdeSize(keep []bool, band bool, num, slack int) func(points int) int {
	b := 1
	if band {
		b = 2
	}
	fixed := slack + 4*num // engine, runs, seed, t_end, dt
	perPoint := num        // x
	for i, d := range n.display {
		fixed += (jsonLen(d) + 1 + num) * b // final, final_sd
		if keep[i] {
			fixed += jsonLen(d) // a series' name
			if slack > 0 {
				fixed += 32 // {"name":…,"values":[],"band":[]},
			}
			perPoint += num * b
		}
	}
	return func(k int) int { return fixed + perPoint*k }
}

// runSDE is native's sim.sde, its artifact inlined as `timeseries`.
func runSDE(ctx context.Context, n *wbNet, a wbArgs, o sdeOpts) (map[string]any, error) {
	tEnd := 10.0
	if v, ok := a.num("t_end"); ok {
		tEnd = v
	}
	if err := checkHorizon("t_end", tEnd, wbMaxHorizon); err != nil {
		return nil, err
	}
	runs, err := a.uint("runs", 1)
	if err != nil {
		return nil, err
	}
	if err := checkRuns("runs", runs); err != nil {
		return nil, err
	}
	points, err := a.uint("points", 101)
	if err != nil {
		return nil, err
	}
	if err := checkSamples("points", points, o.maxPoints); err != nil {
		return nil, err
	}
	seed, err := a.seed("seed", 1)
	if err != nil {
		return nil, err
	}
	// The SDE takes 20 Euler-Maruyama steps per sample interval, so a step
	// of dt means a grid of t_end / (20 dt) intervals, thinned to points.
	// Without dt the grid is the points.
	dtSamples := 0
	if dt, ok := a.num("dt"); ok {
		if !(dt > 0 && !math.IsInf(dt, 0)) {
			return nil, errors.New("dt must be a positive number")
		}
		k := math.Ceil(tEnd / (20 * dt))
		if k+1 > wbMaxSDESteps {
			return nil, fmt.Errorf("dt %s needs %d sample intervals over t_end %s, over the %d cap; use a larger dt",
				rustFloat(dt), rustU64(k), rustFloat(tEnd), wbMaxSDESteps)
		}
		dtSamples = max(int(k), 1) + 1
	}
	samplesFor := func(p int) int {
		if dtSamples > 0 {
			return dtSamples
		}
		return p
	}
	if err := checkTokens(n.start(), false); err != nil {
		return nil, err
	}
	m, rates := n.sdeModel()
	if g := n.sdeGating(m); len(g) > 0 {
		return nil, errors.New("sde refused: this model constrains firing in ways continuous diffusion cannot express, " +
			"so the SDE would silently model an unconstrained system. Use the discrete engine (Simulate). Specifically: " +
			strings.Join(g, "; "))
	}
	keep, err := n.seriesFilter(stringsArg(a["places"]))
	if err != nil {
		return nil, err
	}
	// Ungated, so no capacity can bind; go-pflow's own gating check counts
	// any capacity an output arc touches, native's only one a firing can
	// raise. The diffusion never reads a capacity either way.
	for i := range m.Places {
		m.Places[i].Capacity = 0
	}
	places := len(n.places)
	done := map[int]*stochastic.Result{}
	build := func(points int) (map[string]any, error) {
		samples := samplesFor(points)
		// SimulateSDE keeps about five doubles per sample and place, and each
		// of its 20 substeps per interval walks every transition's dense
		// delta.
		if cells := samples * places; cells > o.maxCells {
			return nil, fmt.Errorf("samples × places is %d, over this server's budget of %d; use a larger dt or fewer points",
				cells, o.maxCells)
		}
		perInterval := len(m.Transitions)*(places+wbSDETransitionCost) + 2*places
		if work := runs * (samples - 1) * perInterval; work > o.maxWork {
			return nil, fmt.Errorf("runs × sample intervals × (transitions × (places + %d) + 2 × places) is %d, over this server's budget of %d; use fewer runs, fewer points or a larger dt",
				wbSDETransitionCost, work, o.maxWork)
		}
		res, ok := done[samples]
		if !ok {
			res, err = stochastic.SimulateSDE(m, n.start(), stochastic.Options{
				Horizon: tEnd, Samples: samples, Rates: rates, Seed: int64(seed), Realizations: runs,
				Portable: true, Context: ctx,
			})
			if err != nil {
				return nil, fmt.Errorf("sde: %v", err)
			}
			done[samples] = res // with dt, fewer points thin the same run
		}
		// go-pflow marks a run whose values overflowed as diverged (its
		// checkDivergence) but still returns the series; native returns
		// them too, the overflowed values as null. A diverged result
		// without series is a refusal (a declared schedule).
		if res.Diverged && len(res.Series) == 0 {
			return nil, fmt.Errorf("sde refused: %s", res.Reason)
		}
		byPlace := map[string]stochastic.Series{}
		for _, s := range res.Series {
			byPlace[s.Place] = s
		}
		idx := downsample(len(res.Times), points)
		final := map[string]any{}
		var finalSD any
		sds := map[string]any{}
		series := []any{}
		for i, id := range n.places {
			s := byPlace[id]
			final[n.display[i]] = last(s.Values)
			e := map[string]any{"name": n.display[i], "values": pick(s.Values, idx)}
			if runs > 1 {
				sds[n.display[i]] = last(s.StdDev)
				e["band"] = pick(s.StdDev, idx)
			}
			series = append(series, e)
		}
		if runs > 1 {
			finalSD = sds
		}
		return jsonSafe(map[string]any{
			"engine": "sde", "runs": runs, "seed": seed, "t_end": tEnd,
			"dt":    tEnd / float64(samples-1) / wbSDEInternalSteps,
			"final": final, "final_sd": finalSD,
			"timeseries": map[string]any{"kind": "timeseries", "x_label": "t", "x": pick(res.Times, idx), "series": n.selectSeries(series, keep)},
		}).(map[string]any), nil
	}
	// The answer must fit the result guard: the points the caller asked
	// for, or as many of the default 101 as fit.
	grid := func(p int) int { return downsampleLen(samplesFor(p), p) }
	upper, lower := n.sdeSize(keep, runs > 1, wbNumBytes, 900), n.sdeSize(keep, runs > 1, 2, 0)
	return fitAnswer(sizing{
		tool: "pflow_sde", what: "points", def: 101, min: 2, explicit: a.has("points"), budget: o.maxBytes,
		upper: func(p int) int { return upper(grid(p)) }, lower: func(p int) int { return lower(grid(p)) },
		grid: grid, hint: "pass places to return fewer series",
	}, points, build)
}

func stringsArg(v any) []string {
	l, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(l))
	for _, x := range l {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// ---- pflow_what_if: the editor's sim.what_if over native sim.compare ----

// whatIfOpts are pflow_what_if's caps beyond native's.
type whatIfOpts struct {
	maxSamples int
	maxSteps   int64 // SSA steps per arm (go-pflow's MaxSteps)
	stepWork   int64 // and at most stepWork / (places + 6) of them
	maxCells   int   // realizations × samples × places, per arm
	maxBytes   int   // the answer
}

// whatIfSize bounds pflow_what_if's answer in bytes as a function of the
// samples, with every number taking num bytes. With lists, the upper bound,
// it also allows for the most the engine can report per place or transition
// (depletion, contention, utilization, in-flight firings, caveats) and for the
// keys and a note; without, the lower bound, it counts only what every answer
// carries.
func (n *wbNet) whatIfSize(keep []bool, band bool, arms []string, place string, num int, lists bool) func(samples int) int {
	b := 1
	if band {
		b = 2
	}
	places := len(n.places)
	names, keyed := 0, 0 // Σ name, Σ "name":number,
	for _, d := range n.display {
		names += jsonLen(d)
		keyed += jsonLen(d) + 1 + num
	}
	transKeyed, blocking, text := 0, 0, 1500
	for i := range n.model.Transitions {
		t := &n.model.Transitions[i]
		id := jsonLen(t.ID)
		transKeyed += id + 1 + num
		// A contention's blocking list names transitions that draw on the
		// place: at most one entry per input or test arc.
		blocking += (len(n.model.Inputs(t.ID)) + len(n.model.Tests(t.ID))) * (id + 1)
		// Caveats and the service assumption name delayed, staged and
		// guarded transitions.
		if t.Delay > 0 || t.Stages > 1 || t.Guard != "" {
			text += 600 + 2*id
		}
	}
	fixed := jsonLen(place) + 3*num + names // seed, place, from, to; the table's columns
	perPoint := num                         // x
	for _, arm := range arms {
		a := jsonLen(arm)
		fixed += a + 4*num              // a summary's name, hours, samples, realizations, seed
		fixed += keyed * b              // final, finalStdDev
		fixed += 2*keyed + transKeyed   // metrics: mean, p95, throughput
		fixed += names + places*(7*num) // the finals table
		fixed += a + places*num         // the scenario × place table's row
		if lists {
			fixed += 320 + 140 + 8                      // the keys of a summary, a finals table, a row
			fixed += keyed + transKeyed                 // metrics: utilization (pool names are shorter), inFlight
			fixed += names + places*(40+num)            // depleted
			fixed += names + places*(70+num) + blocking // contended, waitingForWork
			fixed += text + places*4                    // caveats, assumptions; a finals row's brackets
		}
		for i, d := range n.display {
			if keep[i] {
				fixed += jsonLen(d) + a // a series' name and group
				if lists {
					fixed += 42 // {"name":…,"values":[],"group":…,"band":[]},
				}
				perPoint += num * b
			}
		}
	}
	if lists {
		fixed += 900 + places // keys, a note; the table's column separators
	}
	return func(k int) int { return fixed + perPoint*k }
}

// wbFinal is one place's final value across realizations (native's Final).
type wbFinal struct {
	mean, min, max float64
	sd             *float64
}

// scenarioRun is native's ScenarioRun for the SSA engine, in display names.
type scenarioRun struct {
	t        []float64
	mean, sd [][]float64 // per place; sd nil for one realization
	finals   []wbFinal   // per place
	metrics  map[string]any
	depleted []any
	contend  []any
	waiting  []any
	caveats  []string
	assume   []string
}

// scenario is the part of native's Scenario sim.what_if sets.
type scenario struct {
	name                  string
	marking               map[string]int // model place id -> tokens
	hours                 float64
	samples, realizations int
	seed                  uint64
}

// runScenario is native's run_scenario on the SSA engine
// (run_scenario_ssa): go-pflow's scenario SSA, the engine pflow-solver's
// stochastic module ports, from the net's marking with the scenario's
// overrides and the document's rates.
func (n *wbNet) runScenario(ctx context.Context, sc scenario, maxSteps int64) (*scenarioRun, error) {
	start := n.start()
	for k, v := range sc.marking {
		start[k] = v
	}
	if err := checkTokens(start, true); err != nil {
		return nil, err
	}
	order, err := stochastic.TokenPlaces(n.model)
	if err != nil {
		return nil, fmt.Errorf("scenario: %v", err)
	}
	init := make([]int, len(order))
	for i, p := range order {
		init[i] = start[p]
	}
	// Every realization's last marking, from the engine's on-fire hook.
	ends := make([][]int, sc.realizations)
	for r := range ends {
		ends[r] = append([]int(nil), init...)
	}
	rates := make(map[string]float64, len(n.rates))
	for k, v := range n.rates {
		rates[k] = v
	}
	res, err := stochastic.Simulate(n.model, start, stochastic.Options{
		Horizon: sc.hours, Samples: sc.samples, Rates: rates, Seed: int64(sc.seed), Realizations: sc.realizations,
		Portable: true, Context: ctx, MaxSteps: maxSteps, MaxPlaceTokens: wbMaxPlaceTokens,
		OnFire: func(r int, _ float64, _ string, mk []int) {
			if r < len(ends) && len(mk) == len(ends[r]) {
				copy(ends[r], mk)
			}
		},
	})
	if err != nil {
		return nil, fmt.Errorf("scenario: %v", err)
	}
	if res.Truncated {
		// Native has no step budget and no token cap mid-run; rather than an
		// answer it would not give, say what stopped the run.
		return nil, fmt.Errorf("scenario: the run was cut short (%s); use a shorter t_end, fewer runs or a smaller marking", res.Reason)
	}
	byPlace := map[string]stochastic.Series{}
	for _, s := range res.Series {
		byPlace[s.Place] = s
	}
	tokenIdx := map[string]int{}
	for i, p := range order {
		tokenIdx[p] = i
	}
	run := &scenarioRun{t: res.Times}
	ns := len(res.Times)
	for _, id := range n.places {
		s, ok := byPlace[id]
		values := s.Values
		if !ok {
			values = make([]float64, ns)
		}
		f := wbFinal{mean: last(values)}
		if v, ok := res.Final[id]; ok {
			f.mean = v
		}
		if s.StdDev != nil {
			v := last(s.StdDev)
			f.sd = &v
		}
		f.min, f.max = f.mean, f.mean
		if ti, ok := tokenIdx[id]; ok && len(ends) > 0 {
			f.min, f.max = math.Inf(1), math.Inf(-1)
			for _, e := range ends {
				x := float64(e[ti])
				f.min, f.max = math.Min(f.min, x), math.Max(f.max, x)
			}
		}
		run.finals = append(run.finals, f)
		if sc.realizations > 1 {
			sd := s.StdDev
			if sd == nil {
				sd = make([]float64, ns)
			}
			run.sd = append(run.sd, sd)
		}
		run.mean = append(run.mean, values)
	}
	disp := n.displayOf
	byDisplay := func(m map[string]float64, rename bool) map[string]any {
		out := map[string]any{}
		for k, v := range m {
			if rename {
				k = disp(k)
			}
			out[k] = v
		}
		return out
	}
	if mt := res.Metrics; mt != nil {
		run.metrics = map[string]any{
			"throughput":  byDisplay(mt.Throughput, false),
			"mean":        byDisplay(mt.Mean, true),
			"p95":         byDisplay(mt.P95, true),
			"utilization": byDisplay(mt.Utilization, false),
			"inFlight":    byDisplay(mt.InFlight, false),
		}
	}
	run.depleted = []any{}
	for _, d := range res.Depleted {
		run.depleted = append(run.depleted, map[string]any{"place": disp(d.Place), "at": d.At, "recovered": d.Recovered})
	}
	run.contend, run.waiting = []any{}, []any{}
	for _, c := range res.Contended {
		blocking := c.Blocking
		if blocking == nil {
			blocking = []string{}
		}
		v := map[string]any{"place": disp(c.Place), "fraction": c.Fraction, "kind": string(c.Kind), "blocking": blocking}
		if c.Kind.IsCapacity() {
			run.contend = append(run.contend, v)
		} else {
			run.waiting = append(run.waiting, v)
		}
	}
	run.caveats = append([]string{}, res.Caveats...)
	run.assume = append([]string{}, res.Assumptions...)
	return run, nil
}

// summary is native's ScenarioRun::summary.
func (n *wbNet) summary(run *scenarioRun, sc scenario) map[string]any {
	finals, sds := map[string]any{}, map[string]any{}
	for i, f := range run.finals {
		finals[n.display[i]] = f.mean
		if f.sd != nil {
			sds[n.display[i]] = *f.sd
		}
	}
	out := map[string]any{
		"name": sc.name, "engine": "ssa", "hours": sc.hours, "samples": sc.samples,
		"realizations": sc.realizations, "seed": sc.seed, "final": finals,
	}
	if len(sds) > 0 {
		out["finalStdDev"] = sds
	}
	if run.metrics != nil {
		out["metrics"] = run.metrics
	}
	out["depleted"] = run.depleted
	out["contended"] = run.contend
	out["waitingForWork"] = run.waiting
	out["caveats"] = run.caveats
	out["assumptions"] = run.assume
	return out
}

// finalsTable is native's finals_table (what sim.scenario stores).
func (n *wbNet) finalsTable(run *scenarioRun) map[string]any {
	metric := func(k, p string) any {
		if m, ok := run.metrics[k].(map[string]any); ok {
			if v, ok := m[p]; ok {
				return v
			}
		}
		return nil
	}
	rows := []any{}
	for i, f := range run.finals {
		p := n.display[i]
		var depleted any
		for _, d := range run.depleted {
			if d.(map[string]any)["place"] == p {
				depleted = d.(map[string]any)["at"]
				break
			}
		}
		var sd any
		if f.sd != nil {
			sd = *f.sd
		}
		rows = append(rows, []any{p, f.mean, sd, f.min, f.max, metric("mean", p), metric("p95", p), depleted})
	}
	return map[string]any{
		"kind":    "table",
		"columns": []any{"place", "final_mean", "final_sd", "final_min", "final_max", "time_mean", "p95", "depleted_at"},
		"rows":    rows,
	}
}

// runWhatIf is the editor's sim.what_if (petri-commands.js): sim.compare of
// the net as is and with `delta` more tokens in `place`, both arms on one
// seed so the difference measures the change and not the dice. The compare's
// artifacts come inline (`timeseries`, `table`), and `finals` holds each
// arm's finals table (what native's sim.scenario stores for the same run).
func runWhatIf(ctx context.Context, n *wbNet, a wbArgs, o whatIfOpts) (map[string]any, error) {
	// The editor checks the arguments first, then the place.
	hours := 10.0
	if v, ok := a.num("t_end"); ok {
		hours = v
	}
	if err := checkHorizon("t_end", hours, wbMaxHorizon); err != nil {
		return nil, err
	}
	runs, err := a.uint("runs", 16)
	if err != nil {
		return nil, err
	}
	if err := checkRuns("runs", runs); err != nil {
		return nil, err
	}
	samples, err := a.uint("samples", wbScenarioSamples)
	if err != nil {
		return nil, err
	}
	if err := checkSamples("samples", samples, o.maxSamples); err != nil {
		return nil, err
	}
	seed, err := a.seed("seed", 7)
	if err != nil {
		return nil, err
	}
	place, _ := a["place"].(string)
	places, _ := n.doc["places"].(map[string]any)
	pd, isPlace := places[place].(map[string]any)
	if !isPlace {
		if ts, _ := n.doc["transitions"].(map[string]any); ts[place] != nil {
			return nil, fmt.Errorf("%q is a transition, not a place", place)
		}
		return nil, fmt.Errorf("%q is not a place or transition", place)
	}
	now := 0.0
	switch v := pd["initial"].(type) {
	case []any:
		for _, x := range v {
			f, _ := x.(float64)
			now += f
		}
	case float64:
		now = v
	}
	delta := 1.0
	if v, ok := a.num("delta"); ok {
		delta = v
	}
	if delta == 0 {
		delta = 0 // a -0 argument labels "+0", as the editor prints it
	}
	if now+delta < 0 {
		return nil, fmt.Errorf("%s has %s; cannot remove %s", place, rustFloat(now), rustFloat(-delta))
	}
	sign := ""
	if delta >= 0 {
		sign = "+"
	}
	arms := []scenario{
		{name: "as is", hours: hours, samples: samples, realizations: runs, seed: seed},
		{name: fmt.Sprintf("%s%s %s", sign, rustFloat(delta), place), hours: hours, samples: samples, realizations: runs, seed: seed},
	}
	// The second scenario's marking, read as native's parse_scenario reads it.
	id, err := n.resolvePlace(place)
	if err != nil {
		return nil, fmt.Errorf("scenario 2: %v", err)
	}
	to := now + delta
	if to != math.Trunc(to) {
		return nil, fmt.Errorf("scenario 2: marking for %q must be an integer, got %s", place, rustFloat(to))
	}
	if to > wbMaxPlaceTokens {
		return nil, fmt.Errorf("scenario 2: marking for %q is %d, over the %d cap", place, rustI64(to), wbMaxPlaceTokens)
	}
	arms[1].marking = map[string]int{id: int(to)}

	keep, err := n.seriesFilter(stringsArg(a["places"]))
	if err != nil {
		return nil, err
	}
	steps := o.maxSteps
	if o.stepWork > 0 {
		steps = min(steps, o.stepWork/int64(len(n.places)+6))
	}
	build := func(samples int) (map[string]any, error) {
		for i := range arms {
			arms[i].samples = samples
		}
		// go-pflow's SSA records every realization's samples of every place.
		if cells := runs * samples * len(n.places); cells > o.maxCells {
			return nil, fmt.Errorf("runs × samples × places is %d, over this server's budget of %d; use fewer runs or fewer samples",
				cells, o.maxCells)
		}
		runsOut := make([]*scenarioRun, len(arms))
		for i, sc := range arms {
			r, err := n.runScenario(ctx, sc, steps)
			if err != nil {
				return nil, fmt.Errorf("%s: %v", sc.name, err)
			}
			runsOut[i] = r
		}
		var overlay []any
		var x []float64
		summaries := []any{}
		finals := []any{}
		rows := []any{}
		for i, sc := range arms {
			r := runsOut[i]
			x = r.t
			for j := range n.places {
				s := map[string]any{"name": n.display[j], "values": r.mean[j], "group": sc.name}
				if r.sd != nil {
					s["band"] = r.sd[j]
				}
				overlay = append(overlay, s)
			}
			row := []any{sc.name}
			for _, f := range r.finals {
				row = append(row, f.mean)
			}
			rows = append(rows, row)
			summaries = append(summaries, n.summary(r, sc))
			finals = append(finals, n.finalsTable(r))
		}
		columns := []any{"scenario"}
		for _, d := range n.display {
			columns = append(columns, d)
		}
		return jsonSafe(map[string]any{
			"seed":       seed,
			"scenarios":  summaries,
			"timeseries": map[string]any{"kind": "timeseries", "x_label": "t", "x": x, "series": n.selectSeries(overlay, keep)},
			"table":      map[string]any{"kind": "table", "columns": columns, "rows": rows},
			"finals":     finals,
			"place":      place, "from": now, "to": to,
		}).(map[string]any), nil
	}
	// The answer must fit the result guard: the samples the caller asked
	// for, or as many of the default 60 as fit.
	names := []string{arms[0].name, arms[1].name}
	return fitAnswer(sizing{
		tool: "pflow_what_if", what: "samples", def: wbScenarioSamples, min: 2, explicit: a.has("samples"), budget: o.maxBytes,
		upper: n.whatIfSize(keep, runs > 1, names, place, wbNumBytes, true),
		lower: n.whatIfSize(keep, runs > 1, names, place, 2, false),
		grid:  func(k int) int { return k }, hint: "pass places to return fewer series",
	}, samples, build)
}

// ---- pflow_optimize: native opt.optimize ----

// optOpts are pflow_optimize's caps beyond native's.
type optOpts struct {
	maxSamples int
	maxTEnd    float64
	maxWork    int // solver iterations × the cost of one, over every sample
	maxBytes   int // the answer
}

type optParam struct {
	transition string
	min, max   float64
	log        bool
}

// checkRate is native's sweep::check_rate.
func checkRate(what string, v float64) error {
	if v >= 0 && !math.IsInf(v, 0) && !math.IsNaN(v) {
		return nil
	}
	return fmt.Errorf("%s %s is not a rate (a finite number ≥ 0)", what, rustFloat(v))
}

// parseParams is native's parse_params. sim's {transition: [min, max]} form
// is taken in id order: native takes the object's member order, which does
// not survive decoding the call.
func parseParams(v any) ([]optParam, error) {
	bad := errors.New("parameters must be a non-empty [{transition, min, max, log?}] or {transition: [min, max]}")
	var out []optParam
	switch x := v.(type) {
	case []any:
		for _, item := range x {
			p, _ := item.(map[string]any)
			t, ok1 := p["transition"].(string)
			lo, ok2 := p["min"].(float64)
			hi, ok3 := p["max"].(float64)
			if !ok1 || !ok2 || !ok3 {
				return nil, bad
			}
			log, _ := p["log"].(bool)
			out = append(out, optParam{t, lo, hi, log})
		}
	case map[string]any:
		for _, t := range sortedKeys(x) {
			r, _ := x[t].([]any)
			if len(r) != 2 {
				return nil, bad
			}
			lo, ok1 := r[0].(float64)
			hi, ok2 := r[1].(float64)
			if !ok1 || !ok2 {
				return nil, bad
			}
			out = append(out, optParam{transition: t, min: lo, max: hi})
		}
	default:
		return nil, bad
	}
	if len(out) == 0 {
		return nil, bad
	}
	seen := make(map[string]bool, len(out))
	for _, p := range out {
		if err := checkRate(p.transition+" min", p.min); err != nil {
			return nil, err
		}
		if err := checkRate(p.transition+" max", p.max); err != nil {
			return nil, err
		}
		if p.min > p.max {
			return nil, fmt.Errorf("%s: min %s is above max %s", p.transition, rustFloat(p.min), rustFloat(p.max))
		}
		if p.log && p.min <= 0 {
			return nil, fmt.Errorf("%s: log sampling needs min > 0", p.transition)
		}
		if seen[p.transition] {
			return nil, fmt.Errorf("%s appears twice in parameters", p.transition)
		}
		seen[p.transition] = true
	}
	return out, nil
}

type optObjective struct {
	place    string
	maximize bool
}

// parseObjectives is native's parse_objectives.
func parseObjectives(v any) ([]optObjective, error) {
	bad := errors.New(`objectives must be a non-empty [{place, sense: "max"|"min"}]`)
	items, _ := v.([]any)
	if len(items) == 0 {
		return nil, bad
	}
	var out []optObjective
	for _, item := range items {
		o, _ := item.(map[string]any)
		place, ok := o["place"].(string)
		if !ok {
			return nil, bad
		}
		raw, has := o["sense"]
		if !has {
			raw = o["direction"]
		}
		sense, ok := raw.(string)
		if !ok {
			sense = "max"
		}
		switch sense {
		case "max", "min":
			out = append(out, optObjective{place, sense == "max"})
		default:
			return nil, fmt.Errorf("objective %q: sense must be max or min, got %q", place, sense)
		}
	}
	return out, nil
}

var odeMethods = []string{"tsit5", "rk45", "rk4", "euler", "heun", "midpoint", "bs32"}

// odeMethod is native's sim::solver.
func odeMethod(name string) (*solver.Solver, error) {
	switch name {
	case "tsit5":
		return solver.Tsit5(), nil
	case "rk45":
		return solver.RK45(), nil
	case "rk4":
		return solver.RK4(), nil
	case "euler":
		return solver.Euler(), nil
	case "heun":
		return solver.Heun(), nil
	case "midpoint":
		return solver.Midpoint(), nil
	case "bs32":
		return solver.BS32(), nil
	}
	return nil, fmt.Errorf("unknown method %q; one of %s", name, rustList(odeMethods))
}

// gridSolverOptions is native's OdeOptions::grid(t_end) under the caller's
// dt / abstol / reltol, through OdeOptions::solver_options: pflow.xyz's
// defaults (dt 0.01, abstol 1e-6, reltol 1e-3) with abstol loosened to 1e-4
// and dtmax set to t_end / 20, since only the final state is read.
func gridSolverOptions(a wbArgs, tEnd float64) (*solver.Options, error) {
	o := solver.DefaultOptions()
	set := func(name string, def *float64, dst *float64) error {
		v, ok := a.num(name)
		if !ok {
			if def != nil {
				*dst = *def
			}
			return nil
		}
		if !(v > 0 && !math.IsInf(v, 0)) {
			return fmt.Errorf("%s must be a positive number, got %s", name, rustFloat(v))
		}
		*dst = v
		return nil
	}
	abstol := 1e-4
	if err := set("dt", nil, &o.Dt); err != nil {
		return nil, err
	}
	if err := set("abstol", &abstol, &o.Abstol); err != nil {
		return nil, err
	}
	if err := set("reltol", nil, &o.Reltol); err != nil {
		return nil, err
	}
	o.Dtmax = math.Max(tEnd/20, o.Dtmin)
	o.Dt = math.Min(o.Dt, o.Dtmax)
	return o, nil
}

// fixedStep says whether a method takes fixed steps: one without an error
// estimate (b̂ all zero) never adapts, whatever Options.Adaptive says.
func fixedStep(s *solver.Solver) bool {
	for _, b := range s.Bhat {
		if b != 0 {
			return false
		}
	}
	return true
}

// odeArc is one arc of the mass-action derivative: a state index and the
// arc's weight (go-pflow's arcEntry).
type odeArc struct {
	idx int
	w   float64
}

// odeTrans is one transition of the derivative (go-pflow's transitionEntry,
// without the rate, which varies per sample).
type odeTrans struct {
	id      string
	in, out []odeArc
}

// odeRunner is native's sweep::Runner: the net unfolded once, solved again
// for each set of rate overrides from the net's marking and rates.
//
// It integrates with go-pflow's method tableaux and the arithmetic of
// go-pflow's solver.Solve, step for step, but not through Solve, for two
// reasons. Solve builds its derivative by iterating a Go map of transitions,
// so each place's flux terms are summed in a different order on every call:
// the same rates gave answers a rounding apart, and an exact tie between
// samples (an objective the sampled rates cannot move) broke one way or the
// other at random, flipping Pareto flags. And Solve keeps the whole
// trajectory, a slice and a map per accepted step, where the optimizer reads
// only the final state: with a fine fixed step that was megabytes a sample.
// Here transitions are walked in id order, as pflow-solver walks them
// (sorted_labels in pflow-solver's ode.rs), so every call gives the same
// doubles, and only the current state is kept.
// TestWorkbenchODEIsGoPflowSolve holds the integration to go-pflow's Solve,
// bit for bit, on the same derivative.
type odeRunner struct {
	net      *petri.PetriNet // the unfolded net
	labels   []string        // state variables in sorted order
	index    map[string]int  // label -> position in labels
	u0       []float64
	trans    []odeTrans     // in id order
	tIndex   map[string]int // transition id -> position in trans
	rates    []float64      // the net's rates, aligned with trans
	method   *solver.Solver
	opts     *solver.Options
	tEnd     float64
	order    [][2]string // (state label, display name), as native's ContinuousNet::order
	iterCost int         // the work of one solver iteration, for the budget
}

// newODERunner is native's sim::continuous plus Runner::new. The order lists
// documents in id order (native: document order) and, on a colored net, only
// the colors a place can hold (initially marked, or moved by some arc).
func newODERunner(n *wbNet, method *solver.Solver, opts *solver.Options, tEnd float64) (*odeRunner, error) {
	net, err := parser.FromJSON(n.raw)
	if err != nil {
		return nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	r := &odeRunner{method: method, opts: opts, tEnd: tEnd}
	expanded, cm := net.ExpandColors()
	short := parser.ShortColorNames(net.Token)
	state := map[string]float64{}
	for _, id := range sortedKeys(net.Places) {
		p := net.Places[id]
		if cm == nil {
			r.order = append(r.order, [2]string{id, id})
			state[id] = 0
			if len(p.Initial) > 0 {
				state[id] = math.Round(p.Initial[0]) // native's marking: one count per color, rounded
			}
			continue
		}
		used := func(c int) bool {
			if c < len(p.Initial) && p.Initial[c] > 0 {
				return true
			}
			for _, a := range net.Arcs {
				if (a.Source == id || a.Target == id) && c < len(a.Weight) && a.Weight[c] > 0 {
					return true
				}
			}
			return false
		}
		for c, label := range cm.Expanded[id] {
			v := 0.0
			if c < len(p.Initial) {
				v = math.Round(p.Initial[c])
			}
			state[label] = v
			if !used(c) {
				continue
			}
			color := strconv.Itoa(c)
			if c < len(short) {
				color = short[c]
			}
			r.order = append(r.order, [2]string{label, id + "." + color})
		}
	}
	r.net = expanded
	r.labels = sortedKeys(state)
	r.index = make(map[string]int, len(r.labels))
	for i, l := range r.labels {
		r.index[l] = i
		r.u0 = append(r.u0, state[l])
	}
	rates := net.SetRates(n.rates)
	r.tIndex = map[string]int{}
	for _, id := range sortedKeys(expanded.Transitions) {
		r.tIndex[id] = len(r.trans)
		r.trans = append(r.trans, odeTrans{id: id})
		r.rates = append(r.rates, rates[id])
	}
	// go-pflow's buildVecODEFunction: arcs in the net's order, an input arc
	// when the target is a transition, an output arc when the source is.
	for _, a := range expanded.Arcs {
		w := a.GetWeightSum()
		if ti, ok := r.tIndex[a.Target]; ok {
			if pi, ok := r.index[a.Source]; ok {
				r.trans[ti].in = append(r.trans[ti].in, odeArc{pi, w})
			}
		}
		if ti, ok := r.tIndex[a.Source]; ok {
			if pi, ok := r.index[a.Target]; ok {
				r.trans[ti].out = append(r.trans[ti].out, odeArc{pi, w})
			}
		}
	}
	stages := len(method.C)
	r.iterCost = stages * (stages*len(r.labels) + len(expanded.Arcs) + len(r.trans) + 20)
	return r, nil
}

// deriv is go-pflow's mass-action derivative (solver.buildVecODEFunction's
// closure) with the transitions in id order: flux = rate × Π input tokens,
// off when an input is empty, taken from the inputs and given to the outputs
// by arc weight.
func (r *odeRunner) deriv(rates, u, du []float64) {
	for i := range du {
		du[i] = 0
	}
	for i := range r.trans {
		tr := &r.trans[i]
		flux := rates[i]
		for _, in := range tr.in {
			v := u[in.idx]
			if v <= 0 {
				flux = 0
				break
			}
			flux *= v
		}
		if flux > 0 {
			for _, in := range tr.in {
				du[in.idx] -= float64(flux * in.w)
			}
			for _, out := range tr.out {
				du[out.idx] += float64(flux * out.w)
			}
		}
	}
}

// odeEnd is where a solve stopped.
type odeEnd struct {
	u         []float64 // the state there, aligned with labels
	t         float64
	steps     int // accepted
	iters     int // accepted and rejected
	truncated bool
}

// solveFinal integrates from the marking to t_end as go-pflow's solver.Solve
// does (the same loop, the same expressions in the same order, so the same
// doubles), keeping only the current state. check runs before every 1024th
// iteration with the count so far, and its error stops the solve.
func (r *odeRunner) solveFinal(rates []float64, check func(iters int) error) (odeEnd, error) {
	s, o := r.method, r.opts
	n := len(r.u0)
	tf := r.tEnd
	dtmin, dtmax, abstol, reltol := o.Dtmin, o.Dtmax, o.Abstol, o.Reltol
	stages := len(s.C)
	k := make([][]float64, stages)
	for i := range k {
		k[i] = make([]float64, n)
	}
	ucur := append([]float64(nil), r.u0...)
	ustage := make([]float64, n)
	unext := make([]float64, n)
	tcur, dtcur := 0.0, o.Dt
	nsteps, iters := 0, 0
	for tcur < tf && nsteps < o.Maxiters {
		if iters&1023 == 0 && check != nil {
			if err := check(iters); err != nil {
				return odeEnd{}, err
			}
		}
		iters++
		if tcur+dtcur > tf {
			dtcur = tf - tcur
		}
		r.deriv(rates, ucur, k[0])
		for stage := 1; stage < stages; stage++ {
			copy(ustage, ucur)
			for j := 0; j < stage; j++ {
				aj := 0.0
				if len(s.A) > stage && len(s.A[stage]) > j {
					aj = s.A[stage][j]
				}
				if aj != 0 {
					scale := dtcur * aj
					for i := 0; i < n; i++ {
						ustage[i] += float64(scale * k[j][i])
					}
				}
			}
			r.deriv(rates, ustage, k[stage])
		}
		copy(unext, ucur)
		for j := 0; j < len(s.B); j++ {
			if s.B[j] != 0 {
				scale := dtcur * s.B[j]
				for i := 0; i < n; i++ {
					unext[i] += float64(scale * k[j][i])
				}
			}
		}
		err := 0.0
		if o.Adaptive {
			for i := 0; i < n; i++ {
				errest := 0.0
				for j := 0; j < len(s.Bhat); j++ {
					errest += float64(dtcur * s.Bhat[j] * k[j][i])
				}
				uc := ucur[i]
				un := unext[i]
				scale := abstol + float64(reltol*math.Max(math.Abs(uc), math.Abs(un)))
				if scale == 0 {
					scale = abstol
				}
				val := math.Abs(errest) / scale
				if val > err {
					err = val
				}
			}
		}
		if !o.Adaptive || err <= 1.0 || dtcur <= dtmin {
			tcur += dtcur
			ucur, unext = unext, ucur
			nsteps++
			if o.Adaptive && err > 0 {
				factor := 0.9 * crmath.Pow(1.0/err, 1.0/float64(s.Order+1))
				factor = math.Min(factor, 5.0)
				dtcur = math.Min(dtmax, math.Max(dtmin, dtcur*factor))
			}
		} else {
			factor := 0.9 * crmath.Pow(1.0/err, 1.0/float64(s.Order+1))
			factor = math.Max(factor, 0.1)
			dtcur = math.Max(dtmin, dtcur*factor)
		}
	}
	return odeEnd{u: ucur, t: tcur, steps: nsteps, iters: iters, truncated: nsteps >= o.Maxiters && tcur < tf}, nil
}

// sampleRates is the net's rates with the overrides, aligned with trans.
func (r *odeRunner) sampleRates(overrides map[string]float64) []float64 {
	rates := append([]float64(nil), r.rates...)
	for id, v := range overrides {
		if i, ok := r.tIndex[id]; ok {
			rates[i] = v
		}
	}
	return rates
}

// final is a solve's end state read as native's Runner::final_state reads
// it: one value per order entry.
func (r *odeRunner) final(u []float64) []float64 {
	out := make([]float64, len(r.order))
	for i, o := range r.order {
		out[i] = u[r.index[o[0]]]
	}
	return out
}

// selectPlace is native's Runner::select: an exact display name, or a
// document place for every color of it.
func (r *odeRunner) selectPlace(name string) ([]int, error) {
	var idx []int
	for i, o := range r.order {
		if o[1] == name {
			idx = append(idx, i)
		}
	}
	if len(idx) == 0 {
		for i, o := range r.order {
			if strings.HasPrefix(o[1], name+".") {
				idx = append(idx, i)
			}
		}
	}
	if len(idx) == 0 {
		known := make([]string, len(r.order))
		for i, o := range r.order {
			known[i] = o[1]
		}
		return nil, fmt.Errorf("no place %q; places are %s", name, rustList(known))
	}
	return idx, nil
}

// splitmix64 is native's sweep::Rng: the optimizer's sampler.
type splitmix64 struct{ s uint64 }

func (r *splitmix64) next() uint64 {
	r.s += 0x9E3779B97F4A7C15
	z := r.s
	z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9
	z = (z ^ (z >> 27)) * 0x94D049BB133111EB
	return z ^ (z >> 31)
}

// float64 is uniform in [0, 1), 53 bits.
func (r *splitmix64) float64() float64 {
	return float64(r.next()>>11) * (1.0 / float64(uint64(1)<<53))
}

// pareto is native's sweep::pareto: a sample is on the front when no other
// is at least as good on every objective and strictly better on one.
func pareto(values [][]float64, maximize []bool) []bool {
	dominates := func(a, b []float64) bool {
		better := false
		for k, mx := range maximize {
			va, vb := a[k], b[k]
			if !mx {
				va, vb = -va, -vb
			}
			if va < vb {
				return false
			}
			if va > vb {
				better = true
			}
		}
		return better
	}
	out := make([]bool, len(values))
	for i := range values {
		out[i] = true
		for j := range values {
			if j != i && dominates(values[j], values[i]) {
				out[i] = false
				break
			}
		}
	}
	return out
}

// optLabel is how native names an objective: "R (max)".
func optLabel(ob optObjective) string {
	if ob.maximize {
		return ob.place + " (max)"
	}
	return ob.place + " (min)"
}

// optLower is a lower bound on pflow_optimize's answer in bytes as a
// function of the samples: every number at its shortest ("0,"), the labels
// and columns as written, and one sample on the Pareto front (there is
// always one). How large the front is shows only after the run, when
// runOptimize measures the answer itself.
func optLower(params []optParam, objectives []optObjective) func(samples int) int {
	fixed := jsonLen("rate(" + params[0].transition + ")") // a label
	entry := 2 + 2                                         // a front entry's index, and its highlight
	for _, p := range params {
		fixed += jsonLen("rate("+p.transition+")") + 1
		entry += jsonLen(p.transition) + 1 + 2
	}
	for _, ob := range objectives {
		fixed += 2 * (jsonLen(optLabel(ob)) + 1)
		entry += jsonLen(ob.place) + 1 + 2
	}
	// A table row ([index, rates…, values…, false]) and a scatter point.
	perSample := 2 + (len(params)+len(objectives))*2 + 6 + 2*2
	return func(k int) int { return fixed + entry + perSample*k }
}

// runOptimize is native's opt.optimize, its scatter and table inlined.
func runOptimize(ctx context.Context, n *wbNet, a wbArgs, o optOpts) (map[string]any, error) {
	params, err := parseParams(a["parameters"])
	if err != nil {
		return nil, err
	}
	objectives, err := parseObjectives(a["objectives"])
	if err != nil {
		return nil, err
	}
	if len(params) > wbMaxOptParams {
		return nil, fmt.Errorf("%d parameters is over this server's cap of %d", len(params), wbMaxOptParams)
	}
	if len(objectives) > wbMaxOptObjectives {
		return nil, fmt.Errorf("%d objectives is over this server's cap of %d", len(objectives), wbMaxOptObjectives)
	}
	samplesF := 100.0
	if v, ok := a.num("samples"); ok {
		samplesF = v
	}
	if !(samplesF >= 1 && samplesF <= float64(o.maxSamples)) {
		return nil, fmt.Errorf("samples %s is outside 1..%d", rustFloat(samplesF), o.maxSamples)
	}
	samples := int(samplesF)
	seed := int64(42)
	if v, ok := a.num("seed"); ok {
		if math.Abs(v) > 1<<53 {
			return nil, fmt.Errorf("seed must be at most %d in size", int64(1<<53))
		}
		seed = int64(v)
	}
	tEnd := 10.0
	if v, ok := a.num("t_end"); ok {
		tEnd = v
	}
	if !(tEnd > 0 && !math.IsInf(tEnd, 0)) {
		return nil, errors.New("t_end must be a positive number")
	}
	if tEnd > o.maxTEnd {
		return nil, fmt.Errorf("t_end %s is over this server's cap of %s", rustFloat(tEnd), rustFloat(o.maxTEnd))
	}
	name, _ := a["method"].(string)
	if name == "" {
		name = "tsit5"
	}
	method, err := odeMethod(name)
	if err != nil {
		return nil, err
	}
	opts, err := gridSolverOptions(a, tEnd)
	if err != nil {
		return nil, err
	}
	r, err := newODERunner(n, method, opts, tEnd)
	if err != nil {
		return nil, err
	}
	for _, p := range params {
		if _, ok := r.tIndex[p.transition]; !ok {
			return nil, fmt.Errorf("no transition %q", p.transition)
		}
	}
	cols := make([][]int, len(objectives))
	for i, ob := range objectives {
		if cols[i], err = r.selectPlace(ob.place); err != nil {
			return nil, err
		}
	}

	// This server's limits, past native's checks.
	for _, t := range []struct {
		name string
		v    float64
	}{{"abstol", opts.Abstol}, {"reltol", opts.Reltol}} {
		if t.v < wbMinTolerance {
			return nil, fmt.Errorf("%s %s is below this server's floor of %s: the step would shrink to its minimum and the solve stop short of t_end",
				t.name, rustFloat(t.v), rustFloat(wbMinTolerance))
		}
	}
	// A fixed-step method takes t_end / dt steps; the solver stops at
	// Maxiters, short of t_end, where native would answer with that state.
	minSteps := int(math.Ceil(tEnd / opts.Dtmax)) // an adaptive solve takes at least these
	if fixedStep(method) {
		steps := math.Ceil(tEnd/opts.Dt) + 1
		if steps > float64(opts.Maxiters) {
			return nil, fmt.Errorf("method %s steps a fixed dt of %s: %d steps over t_end %s, past the solver's %d-step limit, so it would stop short of t_end; use a larger dt or an adaptive method (tsit5, rk45, bs32)",
				name, rustFloat(opts.Dt), rustU64(steps), rustFloat(tEnd), opts.Maxiters)
		}
		minSteps = int(steps)
	}
	// The answer must fit the result guard. What cannot is refused (the
	// caller's count) or lowered (the default) before anything runs; the
	// answer is measured after.
	explicit := a.has("samples")
	requested := samples
	if lower := optLower(params, objectives); lower(samples) > o.maxBytes {
		most := samples
		for most > 1 && lower(most) > o.maxBytes {
			most--
		}
		if lower(most) > o.maxBytes {
			return nil, fmt.Errorf("optimize: the answer would pass this server's %d-byte limit even with one sample; use fewer parameters or objectives", o.maxBytes)
		}
		if explicit {
			return nil, fmt.Errorf("samples %d would make an answer of at least %d bytes, over this server's %d-byte limit; no more than %d could fit, or use fewer parameters or objectives",
				samples, lower(samples), o.maxBytes, most)
		}
		samples = most
	}
	if work := samples * minSteps * r.iterCost; work > o.maxWork {
		return nil, fmt.Errorf("samples × solver steps × the cost of a step is at least %d, over this server's budget of %d; use fewer samples, a larger dt or a smaller net",
			work, o.maxWork)
	}

	rng := &splitmix64{uint64(seed)}
	rates := make([][]float64, 0, samples)
	values := make([][]float64, 0, samples)
	used := 0
	for s := 0; s < samples; s++ {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("optimize: gave up after %d of %d samples: %v", s, samples, err)
		}
		row := make([]float64, len(params))
		over := make(map[string]float64, len(params))
		for i, p := range params {
			u := rng.float64()
			if p.log {
				row[i] = math.Pow(10, float64(math.Log10(p.min))+float64(u*(float64(math.Log10(p.max))-float64(math.Log10(p.min)))))
			} else {
				row[i] = p.min + float64(u*(p.max-p.min))
			}
			over[p.transition] = row[i]
		}
		end, err := r.solveFinal(r.sampleRates(over), func(iters int) error {
			if err := ctx.Err(); err != nil {
				return fmt.Errorf("optimize: gave up after %d of %d samples: %v", s, samples, err)
			}
			if used+iters*r.iterCost > o.maxWork {
				return fmt.Errorf("optimize: the solves outgrew this server's budget of %d after %d of %d samples (a stiff net, or a tight tolerance); use fewer samples, a looser abstol or reltol, or a shorter t_end",
					o.maxWork, s, samples)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		used += end.iters * r.iterCost
		if end.truncated {
			// Native answers with the state where the solver stopped, as if
			// it were the state at t_end; say so instead.
			return nil, fmt.Errorf("optimize: sample %d's solve stopped at t = %s, short of t_end %s, at the solver's %d-step limit; use a looser abstol or reltol, a larger dt, a shorter t_end or another method",
				s, rustFloat(end.t), rustFloat(tEnd), opts.Maxiters)
		}
		fin := r.final(end.u)
		v := make([]float64, len(cols))
		for i, c := range cols {
			for _, j := range c {
				v[i] += fin[j]
			}
		}
		values = append(values, v)
		rates = append(rates, row)
	}
	maximize := make([]bool, len(objectives))
	for i, ob := range objectives {
		maximize[i] = ob.maximize
	}
	// The answer for the first k samples is native's answer for samples k:
	// the sampler draws them in order and each solve is independent.
	answer := func(k int) map[string]any {
		front := pareto(values[:k], maximize)
		highlight := []int{}
		for i, on := range front {
			if on {
				highlight = append(highlight, i)
			}
		}
		var xLabel, yLabel string
		points := make([]any, k)
		if len(objectives) >= 2 {
			xLabel, yLabel = optLabel(objectives[0]), optLabel(objectives[1])
			for i, v := range values[:k] {
				points[i] = []float64{v[0], v[1]}
			}
		} else {
			xLabel, yLabel = "rate("+params[0].transition+")", optLabel(objectives[0])
			for i := range points {
				points[i] = []float64{rates[i][0], values[i][0]}
			}
		}
		columns := []any{"sample"}
		for _, p := range params {
			columns = append(columns, "rate("+p.transition+")")
		}
		for _, ob := range objectives {
			columns = append(columns, optLabel(ob))
		}
		columns = append(columns, "pareto")
		rows := make([]any, k)
		for i := range rows {
			row := []any{i}
			for _, v := range rates[i] {
				row = append(row, v)
			}
			for _, v := range values[i] {
				row = append(row, v)
			}
			rows[i] = append(row, front[i])
		}
		front2 := []any{}
		for _, i := range highlight {
			rs, vs := map[string]any{}, map[string]any{}
			for j, p := range params {
				rs[p.transition] = rates[i][j]
			}
			for j, ob := range objectives {
				vs[ob.place] = values[i][j]
			}
			front2 = append(front2, map[string]any{"index": i, "rates": rs, "values": vs})
		}
		return jsonSafe(map[string]any{
			"samples": k, "seed": seed, "t_end": tEnd,
			"pareto_count": len(highlight), "pareto": front2,
			"scatter": map[string]any{"kind": "scatter", "x_label": xLabel, "y_label": yLabel, "points": points, "highlight": highlight},
			"table":   map[string]any{"kind": "table", "columns": columns, "rows": rows},
		}).(map[string]any)
	}
	// A lowered default says so; the note counts toward the answer's size.
	// (A count named in a refusal is the caller's to ask for, without one.)
	withNote := func(k int) map[string]any {
		out := answer(k)
		if k != requested && !explicit {
			out["note"] = fmt.Sprintf("samples is %d, not the default 100, so that the answer fits this server's %d-byte limit (use fewer parameters or objectives)",
				k, o.maxBytes)
		}
		return out
	}
	out := withNote(samples)
	if size := answerBytes(out); size > o.maxBytes {
		// Keep the longest prefix of the samples whose answer fits: it is
		// native's answer for that many samples.
		fits := func(k int) bool { return answerBytes(withNote(k)) <= o.maxBytes }
		lo, hi := 0, samples
		for hi-lo > 1 {
			if mid := (lo + hi) / 2; fits(mid) {
				lo = mid
			} else {
				hi = mid
			}
		}
		if lo < 1 || !fits(lo) {
			return nil, fmt.Errorf("optimize: the answer would pass this server's %d-byte limit even with one sample; use fewer parameters or objectives", o.maxBytes)
		}
		if explicit {
			return nil, fmt.Errorf("samples %d makes an answer of %d bytes (%d of them on the Pareto front), over this server's %d-byte limit; at most %d fit, or use fewer parameters or objectives",
				samples, size, out["pareto_count"], o.maxBytes, lo)
		}
		out = withNote(lo)
	}
	return out, nil
}
