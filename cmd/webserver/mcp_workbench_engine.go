package main

// The engines behind the /mcp workbench tools (mcp_workbench.go): ports of
// what pflow-native runs for sim.sde, sim.what_if (sim.compare and
// sim.scenario) and opt.optimize, on go-pflow's engines.
//
// pflow-native is the reference. Its stochastic engines are pflow-solver's
// ports of go-pflow's, held byte-exact to go-pflow's portable path, so with
// the same model, rates and seed the SDE and the scenario SSA here give the
// same doubles native does; its ODE is pflow-solver's Tsit5, the same
// algorithm as go-pflow's, agreeing to rounding. What this file adds is
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
		return 0, fmt.Errorf("%s must be ≥ 0, got %d", k, int64(x))
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

// selectSeries picks the series a `places` filter names (a display name, or a
// document place for all its colors), keeping their order.
func (n *wbNet) selectSeries(series []any, filter []string) ([]any, error) {
	if filter == nil {
		return series, nil
	}
	keep := map[string]bool{}
	for _, f := range filter {
		found := false
		for i, p := range n.places {
			if b, _ := n.base(p); n.display[i] == f || b == f {
				keep[n.display[i]] = true
				found = true
			}
		}
		if !found {
			return nil, fmt.Errorf("places: no place %q; places are %s", f, rustList(n.display))
		}
	}
	out := []any{}
	for _, s := range series {
		if keep[s.(map[string]any)["name"].(string)] {
			out = append(out, s)
		}
	}
	return out, nil
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
	maxWork   int // realizations × sample intervals × transitions
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
	// of dt means a grid of t_end / (20 dt) intervals.
	samples := points
	if dt, ok := a.num("dt"); ok {
		if !(dt > 0 && !math.IsInf(dt, 0)) {
			return nil, errors.New("dt must be a positive number")
		}
		k := math.Ceil(tEnd / (20 * dt))
		if k+1 > wbMaxSDESteps {
			return nil, fmt.Errorf("dt %s needs %d sample intervals over t_end %s, over the %d cap; use a larger dt",
				rustFloat(dt), uint64(k), rustFloat(tEnd), wbMaxSDESteps)
		}
		samples = max(int(k), 1) + 1
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
	if work := runs * (samples - 1) * max(len(m.Transitions), 1); work > o.maxWork {
		return nil, fmt.Errorf("runs × sample intervals × transitions is %d, over this server's budget of %d; use fewer runs, fewer points or a larger dt",
			work, o.maxWork)
	}
	// Ungated, so no capacity can bind; go-pflow's own gating check counts
	// any capacity an output arc touches, native's only one a firing can
	// raise. The diffusion never reads a capacity either way.
	for i := range m.Places {
		m.Places[i].Capacity = 0
	}
	res, err := stochastic.SimulateSDE(m, n.start(), stochastic.Options{
		Horizon: tEnd, Samples: samples, Rates: rates, Seed: int64(seed), Realizations: runs,
		Portable: true, Context: ctx,
	})
	if err != nil {
		return nil, fmt.Errorf("sde: %v", err)
	}
	if res.Diverged {
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
	if series, err = n.selectSeries(series, stringsArg(a["places"])); err != nil {
		return nil, err
	}
	return map[string]any{
		"engine": "sde", "runs": runs, "seed": seed, "t_end": tEnd,
		"dt":    tEnd / float64(samples-1) / wbSDEInternalSteps,
		"final": final, "final_sd": finalSD,
		"timeseries": map[string]any{"kind": "timeseries", "x_label": "t", "x": pick(res.Times, idx), "series": series},
	}, nil
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
		return nil, fmt.Errorf("scenario 2: marking for %q is %d, over the %d cap", place, int64(to), wbMaxPlaceTokens)
	}
	arms[1].marking = map[string]int{id: int(to)}

	runsOut := make([]*scenarioRun, len(arms))
	for i, sc := range arms {
		r, err := n.runScenario(ctx, sc, o.maxSteps)
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
	if overlay, err = n.selectSeries(overlay, stringsArg(a["places"])); err != nil {
		return nil, err
	}
	columns := []any{"scenario"}
	for _, d := range n.display {
		columns = append(columns, d)
	}
	return map[string]any{
		"seed":       seed,
		"scenarios":  summaries,
		"timeseries": map[string]any{"kind": "timeseries", "x_label": "t", "x": x, "series": overlay},
		"table":      map[string]any{"kind": "table", "columns": columns, "rows": rows},
		"finals":     finals,
		"place":      place, "from": now, "to": to,
	}, nil
}

// ---- pflow_optimize: native opt.optimize ----

// optOpts are pflow_optimize's caps beyond native's.
type optOpts struct {
	maxSamples int
	maxTEnd    float64
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
	for i, p := range out {
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
		for _, q := range out[:i] {
			if q.transition == p.transition {
				return nil, fmt.Errorf("%s appears twice in parameters", p.transition)
			}
		}
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
	o.Dtmax = math.Max(math.Min(o.Dtmax, tEnd/50), o.Dtmin)
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

// odeRunner is native's sweep::Runner: the net unfolded once, solved again
// for each set of rate overrides from the net's marking and rates.
type odeRunner struct {
	net    *petri.PetriNet
	state  map[string]float64
	rates  map[string]float64
	method *solver.Solver
	opts   *solver.Options
	tEnd   float64
	order  [][2]string // (state label, display name), as native's ContinuousNet::order
}

// newODERunner is native's sim::continuous plus Runner::new. The order lists
// documents in id order (native: document order) and, on a colored net, only
// the colors a place can hold (initially marked, or moved by some arc).
func newODERunner(n *wbNet, method *solver.Solver, opts *solver.Options, tEnd float64) (*odeRunner, error) {
	net, err := parser.FromJSON(n.raw)
	if err != nil {
		return nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	r := &odeRunner{net: net, method: method, opts: opts, tEnd: tEnd, state: map[string]float64{}}
	_, cm := net.ExpandColors()
	short := parser.ShortColorNames(net.Token)
	for _, id := range sortedKeys(net.Places) {
		p := net.Places[id]
		if cm == nil {
			r.order = append(r.order, [2]string{id, id})
			r.state[id] = 0
			if len(p.Initial) > 0 {
				r.state[id] = math.Round(p.Initial[0]) // native's marking: one count per color, rounded
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
			r.state[label] = v
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
	r.rates = net.SetRates(n.rates)
	return r, nil
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

// finalState is native's Runner::final_state: the state at t_end, one value
// per order entry.
func (r *odeRunner) finalState(overrides map[string]float64) []float64 {
	rates := make(map[string]float64, len(r.rates))
	for k, v := range r.rates {
		rates[k] = v
	}
	for k, v := range overrides {
		rates[k] = v
	}
	sol := solver.Solve(solver.NewProblem(r.net, r.state, [2]float64{0, r.tEnd}, rates), r.method, r.opts)
	out := make([]float64, len(r.order))
	if len(sol.U) == 0 {
		return out
	}
	fin := sol.U[len(sol.U)-1]
	for i, o := range r.order {
		out[i] = fin[o[0]]
	}
	return out
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
		if _, ok := r.rates[p.transition]; !ok {
			return nil, fmt.Errorf("no transition %q", p.transition)
		}
	}
	cols := make([][]int, len(objectives))
	for i, ob := range objectives {
		if cols[i], err = r.selectPlace(ob.place); err != nil {
			return nil, err
		}
	}

	rng := &splitmix64{uint64(seed)}
	rates := make([][]float64, 0, samples)
	values := make([][]float64, 0, samples)
	for s := 0; s < samples; s++ {
		if err := ctx.Err(); err != nil {
			return nil, fmt.Errorf("optimize: gave up after %d of %d samples: %v", s, samples, err)
		}
		row := make([]float64, len(params))
		over := make(map[string]float64, len(params))
		for i, p := range params {
			u := rng.float64()
			if p.log {
				row[i] = math.Pow(10, math.Log10(p.min)+u*(math.Log10(p.max)-math.Log10(p.min)))
			} else {
				row[i] = p.min + u*(p.max-p.min)
			}
			over[p.transition] = row[i]
		}
		fin := r.finalState(over)
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
	front := pareto(values, maximize)
	highlight := []int{}
	for i, on := range front {
		if on {
			highlight = append(highlight, i)
		}
	}
	label := func(ob optObjective) string {
		if ob.maximize {
			return ob.place + " (max)"
		}
		return ob.place + " (min)"
	}
	var xLabel, yLabel string
	points := make([]any, samples)
	if len(objectives) >= 2 {
		xLabel, yLabel = label(objectives[0]), label(objectives[1])
		for i, v := range values {
			points[i] = []float64{v[0], v[1]}
		}
	} else {
		xLabel, yLabel = "rate("+params[0].transition+")", label(objectives[0])
		for i := range values {
			points[i] = []float64{rates[i][0], values[i][0]}
		}
	}
	columns := []any{"sample"}
	for _, p := range params {
		columns = append(columns, "rate("+p.transition+")")
	}
	for _, ob := range objectives {
		columns = append(columns, label(ob))
	}
	columns = append(columns, "pareto")
	rows := make([]any, samples)
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
	return map[string]any{
		"samples": samples, "seed": seed, "t_end": tEnd,
		"pareto_count": len(highlight), "pareto": front2,
		"scatter": map[string]any{"kind": "scatter", "x_label": xLabel, "y_label": yLabel, "points": points, "highlight": highlight},
		"table":   map[string]any{"kind": "table", "columns": columns, "rows": rows},
	}, nil
}
