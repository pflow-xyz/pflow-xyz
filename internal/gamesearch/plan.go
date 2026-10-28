package gamesearch

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
)

// A search plan: the pieces of a game search, picked by name in JSON. A
// port of pflow-metamodel's plan.rs, with its error messages.
//
//	{"mode": "exact",
//	 "order": ["tt_best", "immediate_win", "centrality", "history"],
//	 "filters": ["must_win", "non_losing"],
//	 "root": {"order": ["non_losing"]},
//	 "drivers": ["null_window", {"budget": {"nodes": 1000000}}],
//	 "memo": {"entries": 500000}}
//
// The estimate "ode" (a root piece) solves the mass-action ODE; see ode.go.
// The solver a plan builds takes the estimate from the caller (Options
// carries the plan's name for it in Estimate, and the "aspiration" driver
// in Aspiration), as pflow-rs' SearchPlan::solver_with does.

// SearchPlan is a plan, as the JSON gives it.
type SearchPlan struct {
	Mode       string
	Order      []string
	HasOrder   bool
	Drivers    []any
	HasDrivers bool
	Filters    []string
	HasFilters bool
	Root       *RootPlan
	Heuristics []string
	Memo       *Memo
}

// RootPlan is {"order": [...]}: the root's pieces.
type RootPlan struct{ Order []string }

// Memo is {"entries": N}.
type Memo struct{ Entries int }

type kind int

const (
	kindOrder kind = iota
	kindDriver
	kindFilter
	kindHeuristic
	kindEstimate
)

func (k kind) noun() string {
	return [...]string{"order piece", "driver", "filter", "heuristic", "estimate"}[k]
}

var (
	driverNames   = []string{"null_window", "mtd_f", "aspiration", "budget"}
	estimateNames = []string{"ode"}
	// unsound are the names of pieces that can change a value, none of them
	// built.
	unsound = []struct {
		name string
		kind kind
	}{{"beam", kindFilter}, {"static_eval", kindHeuristic}}
)

func contains(xs []string, x string) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}

// kindOf is what name is, if the registry knows it.
func kindOf(name string) (kind, bool) {
	if _, err := ParsePiece(name); err == nil {
		return kindOrder, true
	}
	if _, err := ParseFilter(name); err == nil {
		return kindFilter, true
	}
	if contains(driverNames, name) {
		return kindDriver, true
	}
	if contains(estimateNames, name) {
		return kindEstimate, true
	}
	for _, u := range unsound {
		if u.name == name {
			return u.kind, true
		}
	}
	return 0, false
}

func planError(format string, args ...any) error {
	return fmt.Errorf("search plan: "+format, args...)
}

// expect refuses a name unless it is a want.
func expect(name string, want kind) error {
	k, ok := kindOf(name)
	if !ok {
		var un []string
		for _, u := range unsound {
			un = append(un, u.name)
		}
		return planError("unknown %s %q (known: %s, %s, %s, %s, %s)", want.noun(), name,
			rustStrList(PieceNames), rustStrList(FilterNames), rustStrList(driverNames),
			rustStrList(estimateNames), rustStrList(un))
	}
	if k != want {
		return planError("%q is a %s, not a %s", name, k.noun(), want.noun())
	}
	return nil
}

// ---- reading a plan the way serde reads it ----

// serdeUnexpected describes v as serde's "invalid type" does.
func serdeUnexpected(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case bool:
		return fmt.Sprintf("boolean `%v`", x)
	case string:
		return fmt.Sprintf("string %s", strconv.Quote(x))
	case float64:
		if x == math.Trunc(x) && math.Abs(x) < 1e18 {
			return fmt.Sprintf("integer `%d`", int64(x))
		}
		return fmt.Sprintf("floating point `%s`", rustDebugF64(x))
	case []any:
		return "sequence"
	case map[string]any:
		return "map"
	case json.Number:
		return fmt.Sprintf("integer `%s`", x)
	}
	return fmt.Sprintf("%T", v)
}

func invalidType(v any, expected string) error {
	return planError("invalid type: %s, expected %s", serdeUnexpected(v), expected)
}

func readStrings(v any) ([]string, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, invalidType(v, "a sequence")
	}
	out := make([]string, 0, len(list))
	for _, e := range list {
		s, ok := e.(string)
		if !ok {
			return nil, invalidType(e, "a string")
		}
		out = append(out, s)
	}
	return out, nil
}

func unknownField(k string, expected ...string) error {
	q := make([]string, len(expected))
	for i, e := range expected {
		q[i] = "`" + e + "`"
	}
	var list string
	switch len(q) {
	case 1:
		list = q[0]
	case 2:
		list = q[0] + " or " + q[1]
	default:
		for i, s := range q {
			if i > 0 {
				list += ", "
			}
			list += s
		}
		list = "one of " + list
	}
	return planError("unknown field `%s`, expected %s", k, list)
}

// ParseSearchPlan reads a plan from decoded JSON (a map), as serde reads
// pflow-metamodel's SearchPlan: unknown fields and wrong types are
// refused.
func ParseSearchPlan(v any) (*SearchPlan, error) {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, invalidType(v, "struct SearchPlan")
	}
	p := &SearchPlan{Mode: "exact"}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		val := obj[k]
		switch k {
		case "mode":
			if val == nil {
				continue
			}
			s, ok := val.(string)
			if !ok {
				return nil, invalidType(val, "string or map")
			}
			if s != "exact" && s != "play" {
				return nil, planError("unknown variant `%s`, expected `exact` or `play`", s)
			}
			p.Mode = s
		case "order", "filters":
			if val == nil {
				continue
			}
			s, err := readStrings(val)
			if err != nil {
				return nil, err
			}
			if k == "order" {
				p.Order, p.HasOrder = s, true
			} else {
				p.Filters, p.HasFilters = s, true
			}
		case "drivers":
			if val == nil {
				continue
			}
			l, ok := val.([]any)
			if !ok {
				return nil, invalidType(val, "a sequence")
			}
			p.Drivers, p.HasDrivers = l, true
		case "root":
			if val == nil {
				continue
			}
			m, ok := val.(map[string]any)
			if !ok {
				return nil, invalidType(val, "struct RootPlan")
			}
			r := &RootPlan{}
			var seen bool
			for rk, rv := range m {
				if rk != "order" {
					return nil, unknownField(rk, "order")
				}
				s, err := readStrings(rv)
				if err != nil {
					return nil, err
				}
				r.Order, seen = s, true
			}
			if !seen {
				return nil, planError("missing field `order`")
			}
			p.Root = r
		case "heuristics":
			s, err := readStrings(val)
			if err != nil {
				return nil, err
			}
			p.Heuristics = s
		case "memo":
			if val == nil {
				continue
			}
			m, ok := val.(map[string]any)
			if !ok {
				return nil, invalidType(val, "struct Memo")
			}
			mm := &Memo{}
			var seen bool
			for mk, mv := range m {
				if mk != "entries" {
					return nil, unknownField(mk, "entries")
				}
				f, ok := mv.(float64)
				if !ok {
					return nil, invalidType(mv, "usize")
				}
				if f < 0 && f == math.Trunc(f) {
					return nil, planError("invalid value: integer `%d`, expected usize", int64(f))
				}
				if f != math.Trunc(f) {
					return nil, invalidType(mv, "usize")
				}
				mm.Entries, seen = int(math.Min(f, math.MaxInt32*4)), true
			}
			if !seen {
				return nil, planError("missing field `entries`")
			}
			p.Memo = mm
		default:
			return nil, unknownField(k, "mode", "order", "drivers", "filters", "root", "heuristics", "memo")
		}
	}
	return p, nil
}

// ---- what a plan comes to ----

type driverSet struct {
	nullWindow, mtdF, aspiration bool
	budget                       int
	hasBudget                    bool
	ms                           uint64
	hasMS                        bool
}

type budgetArgs struct {
	nodes *int
	ms    *uint64
}

func (p *SearchPlan) drivers() (driverSet, error) {
	if !p.HasDrivers {
		return driverSet{nullWindow: true}, nil
	}
	var d driverSet
	twice := func(name string) error { return planError("driver %q is listed twice", name) }
	budgeted := false
	for _, v := range p.Drivers {
		switch x := v.(type) {
		case string:
			if err := expect(x, kindDriver); err != nil {
				return d, err
			}
			switch x {
			case "null_window":
				if d.nullWindow {
					return d, twice(x)
				}
				d.nullWindow = true
			case "mtd_f":
				if d.mtdF {
					return d, twice(x)
				}
				d.mtdF = true
			case "aspiration":
				if d.aspiration {
					return d, twice(x)
				}
				d.aspiration = true
			default:
				return d, planError("driver %q takes arguments: {%q: {\"nodes\": N}}", x, x)
			}
		case map[string]any:
			if len(x) != 1 {
				return d, planError("a driver is a name or an object with one key, not %s", compactJSON(v))
			}
			var name string
			var args any
			for k, a := range x {
				name, args = k, a
			}
			if err := expect(name, kindDriver); err != nil {
				return d, err
			}
			if name != "budget" {
				return d, planError("driver %q takes no arguments", name)
			}
			if budgeted {
				return d, twice(name)
			}
			budgeted = true
			b, err := readBudget(args)
			if err != nil {
				return d, err
			}
			if b.nodes == nil && b.ms == nil {
				return d, planError("driver \"budget\" takes \"nodes\", \"ms\" or both")
			}
			if (b.nodes != nil && *b.nodes == 0) || (b.ms != nil && *b.ms == 0) {
				return d, planError("driver \"budget\": nodes and ms must be at least 1")
			}
			if b.nodes != nil {
				d.budget, d.hasBudget = *b.nodes, true
			}
			if b.ms != nil {
				d.ms, d.hasMS = *b.ms, true
			}
		default:
			return d, planError("a driver is a name or an object with one key, not %s", compactJSON(v))
		}
	}
	if d.nullWindow && d.mtdF {
		return d, planError("drivers \"null_window\" and \"mtd_f\" both find the value by yes/no searches: name one")
	}
	return d, nil
}

func compactJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// readBudget reads {"nodes": N, "ms": T} as serde reads the budget struct.
func readBudget(v any) (budgetArgs, error) {
	var b budgetArgs
	m, ok := v.(map[string]any)
	if !ok {
		return b, planError("driver \"budget\": %s", invalidTypeText(v, "struct Budget"))
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		val := m[k]
		if k != "nodes" && k != "ms" {
			return b, planError("driver \"budget\": %s", trimPrefix(unknownField(k, "nodes", "ms")))
		}
		if val == nil {
			continue
		}
		f, ok := val.(float64)
		if !ok {
			return b, planError("driver \"budget\": %s", invalidTypeText(val, "u64"))
		}
		if f != math.Trunc(f) {
			return b, planError("driver \"budget\": %s", invalidTypeText(val, "u64"))
		}
		if f < 0 {
			return b, planError("driver \"budget\": invalid value: integer `%d`, expected u64", int64(f))
		}
		n := uint64(f)
		if k == "nodes" {
			i := int(math.Min(float64(n), math.MaxInt64/2))
			b.nodes = &i
		} else {
			b.ms = &n
		}
	}
	return b, nil
}

func invalidTypeText(v any, expected string) string {
	return fmt.Sprintf("invalid type: %s, expected %s", serdeUnexpected(v), expected)
}

func trimPrefix(err error) string {
	const p = "search plan: "
	s := err.Error()
	if len(s) >= len(p) && s[:len(p)] == p {
		return s[len(p):]
	}
	return s
}

// chain is the order chain the plan names.
func (p *SearchPlan) chain() (Chain, error) {
	if !p.HasOrder {
		return DefaultChain(), nil
	}
	var pieces []Piece
	for _, n := range p.Order {
		if err := expect(n, kindOrder); err != nil {
			return Chain{}, err
		}
		piece, err := ParsePiece(n)
		if err != nil {
			return Chain{}, err
		}
		for _, q := range pieces {
			if q == piece {
				return Chain{}, planError("order piece %q is listed twice", n)
			}
		}
		pieces = append(pieces, piece)
	}
	return NewChain(pieces)
}

type rootSet struct {
	estimate   string
	nonLosing  bool
	hasEstimat bool
}

func (p *SearchPlan) roots() (rootSet, error) {
	var r rootSet
	var names []string
	if p.Root != nil {
		names = p.Root.Order
	}
	for i, n := range names {
		if contains(names[:i], n) {
			return r, planError("root piece %q is listed twice", n)
		}
		k, known := kindOf(n)
		switch {
		case known && k == kindEstimate && r.hasEstimat:
			return r, planError("root: %q is a second estimate; the root takes one", n)
		case known && k == kindEstimate:
			r.estimate, r.hasEstimat = n, true
		case n == "non_losing":
			r.nonLosing = true
		case !known:
			return r, planError("unknown root piece %q (known: %s, \"non_losing\")", n, rustStrList(estimateNames))
		default:
			return r, planError("%q is a %s, not a root piece (an estimate, or \"non_losing\")", n, k.noun())
		}
	}
	return r, nil
}

// Estimate is the estimate the plan's root names, if any.
func (p *SearchPlan) Estimate() (string, bool, error) {
	r, err := p.roots()
	return r.estimate, r.hasEstimat, err
}

func (p *SearchPlan) filters() ([]Filter, error) {
	if !p.HasFilters {
		return DefaultFilters, nil
	}
	var out []Filter
	for _, n := range p.Filters {
		if err := expect(n, kindFilter); err != nil {
			return nil, err
		}
		f, err := ParseFilter(n)
		if err != nil {
			continue
		}
		for _, g := range out {
			if g == f {
				return nil, planError("filter %q is listed twice", n)
			}
		}
		out = append(out, f)
	}
	return out, nil
}

// Check is the legality check: every name is known and in its place, and in
// exact mode no filter or heuristic is there to change the value. It needs
// no net.
func (p *SearchPlan) Check() error {
	if _, err := p.chain(); err != nil {
		return err
	}
	d, err := p.drivers()
	if err != nil {
		return err
	}
	r, err := p.roots()
	if err != nil {
		return err
	}
	if d.aspiration && !r.hasEstimat {
		return planError("driver \"aspiration\" starts from the root's estimate: name one in root.order")
	}
	if p.Memo != nil && p.Memo.Entries == 0 {
		return planError("memo: entries must be at least 1")
	}
	if _, err := p.filters(); err != nil {
		return err
	}
	for _, set := range []struct {
		names []string
		kind  kind
	}{{p.Filters, kindFilter}, {p.Heuristics, kindHeuristic}} {
		for _, n := range set.names {
			if err := expect(n, set.kind); err != nil {
				return err
			}
		}
		for _, n := range set.names {
			for _, u := range unsound {
				if u.name == n {
					why := "is not built in this release"
					if p.Mode == "exact" {
						why = "can change the value, which exact mode does not allow"
					}
					return planError("%s %q %s", set.kind.noun(), n, why)
				}
			}
		}
	}
	return nil
}

// Budget is the node budget the plan's drivers set, if any.
func (p *SearchPlan) Budget() (int, bool, error) {
	d, err := p.drivers()
	return d.budget, d.hasBudget, err
}

// Options builds the solver options the plan comes to.
func (p *SearchPlan) Options() (Options, error) {
	if err := p.Check(); err != nil {
		return Options{}, err
	}
	d, err := p.drivers()
	if err != nil {
		return Options{}, err
	}
	r, err := p.roots()
	if err != nil {
		return Options{}, err
	}
	chain, err := p.chain()
	if err != nil {
		return Options{}, err
	}
	fs, err := p.filters()
	if err != nil {
		return Options{}, err
	}
	o := Options{
		Chain:         chain,
		Filters:       fs,
		NullWindow:    d.nullWindow,
		MtdF:          d.mtdF,
		RootNonLosing: r.nonLosing,
		Aspiration:    d.aspiration,
		Play:          p.Mode == "play",
	}
	if d.hasBudget {
		o.Budget = d.budget
	}
	if p.Memo != nil {
		o.Memo = p.Memo.Entries
	}
	return o, nil
}
