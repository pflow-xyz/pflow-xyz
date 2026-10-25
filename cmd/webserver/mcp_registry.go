package main

// The /mcp server's wider tool set and the guards every tool call runs behind.
//
// mcp.go keeps the seven original tools and the JSON-RPC plumbing. This file
// adds what the in-page Assistant's registry (public/llm-tools.json) can do
// without a browser: build and edit a net, read it, play the token game,
// validate and verify it, find its invariants, run SSA, scan a rate, export it.
// Each tool is stateless and model-in-argument: the net travels in the call,
// the answer (for an edit, the changed net) travels back, and nothing is stored
// on the server. The one tool that stores anything is pflow_save.
//
// Also here, so mcp.go changes stay small:
//   - annotations: every tool carries readOnlyHint and destructiveHint (the
//     claude.ai connector directory rejects a tool without one);
//   - a per-call timeout, so one tool cannot hold a request for minutes;
//   - a result-size guard, so one answer cannot exceed a client's budget.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/go-pflow/petri"
	"github.com/pflow-xyz/go-pflow/reachability"
	"github.com/pflow-xyz/go-pflow/solver"
	"github.com/pflow-xyz/go-pflow/stochastic"
	"github.com/pflow-xyz/go-pflow/validation"
	"github.com/pflow-xyz/go-pflow/verify"
	"github.com/pflow-xyz/pflow-xyz/internal/seal"
	"github.com/pflow-xyz/pflow-xyz/internal/svg"
)

const (
	// mcpCallTimeoutDefault bounds one tool call. The connector directory allows 300s;
	// the tools are bounded well inside this, so hitting it means a bug or an
	// adversarial net, and an error beats a hung request.
	mcpCallTimeoutDefault = 60 * time.Second
	// mcpMaxResultBytes is about 25k tokens of JSON (≈ 4 bytes a token).
	mcpMaxResultBytes = 100 << 10
	maxEditOps        = 500
	maxSSASteps       = 5_000_000
)

// mcpCallTimeout is a variable so a test can shorten it.
var mcpCallTimeout = mcpCallTimeoutDefault

// ---- annotations ----

// mcpAnnotation is a tool's behavioural hints and display title.
type mcpAnnotation struct {
	title       string
	readOnly    bool
	destructive bool
	idempotent  bool
}

// mcpAnnotations is keyed by tool name. A tool missing from it still lists
// (with conservative hints: not read-only, destructive) and the test
// TestMCPEveryToolIsAnnotated fails, so a new tool cannot ship unannotated.
//
// Judgement calls, documented:
//   - pflow_save is the only tool that writes server state (it stores the net
//     and records the author), so it is destructiveHint:true.
//   - pflow_edit returns a changed copy of the net it was given and stores
//     nothing, so it is readOnlyHint:true: calling it twice with the same
//     arguments changes nothing anywhere.
//   - pflow_ssa is seeded, so the same arguments give the same answer.
var mcpAnnotations = map[string]mcpAnnotation{
	"pflow_check":        {"Check a net", true, false, true},
	"pflow_cid":          {"Compute a net's CID", true, false, true},
	"pflow_get":          {"Fetch a stored net", true, false, true},
	"pflow_simulate":     {"Simulate a net (ODE)", true, false, true},
	"pflow_reachability": {"Explore reachable markings", true, false, true},
	"pflow_links":        {"Links to view a net", true, false, true},
	"pflow_save":         {"Save a net", false, true, true},

	"pflow_edit":       {"Build or edit a net", true, false, true},
	"pflow_info":       {"Summarise a net", true, false, true},
	"pflow_fire":       {"Fire transitions (token game)", true, false, true},
	"pflow_validate":   {"Validate a net", true, false, true},
	"pflow_verify":     {"Verify properties of a net", true, false, true},
	"pflow_invariants": {"Find invariants", true, false, true},
	"pflow_incidence":  {"Incidence matrix", true, false, true},
	"pflow_ssa":        {"Simulate a net (stochastic SSA)", true, false, true},
	"pflow_rate_scan":  {"Scan one transition's rate", true, false, true},
	"pflow_export":     {"Export a net (JSON-LD or SVG)", true, false, true},
}

// toolDescriptor is one entry of tools/list, with annotations.
func toolDescriptor(t mcpTool) map[string]any {
	a, ok := mcpAnnotations[t.Name]
	if !ok {
		a = mcpAnnotation{title: t.Name, destructive: true}
	}
	return map[string]any{
		"name":        t.Name,
		"title":       a.title,
		"description": t.Description,
		"inputSchema": t.InputSchema,
		"annotations": map[string]any{
			"title":           a.title,
			"readOnlyHint":    a.readOnly,
			"destructiveHint": a.destructive,
			"idempotentHint":  a.idempotent,
			// Every tool works on the net in the call or on this server's own
			// store; none reaches the open internet (pflow_save asks GitHub to
			// verify a token, which is authentication, not content).
			"openWorldHint": false,
		},
	}
}

// allMCPTools is the original seven plus the registry tools.
func allMCPTools() []mcpTool {
	return append(mcpTools(), registryTools()...)
}

// ---- timeout and size guard ----

// callMCPTool runs a tool under mcpCallTimeout. The handler gets a request
// carrying the deadline, so the engines that take a context (SSA) stop on
// their own; the rest are bounded by their inputs and, if one is not, the
// caller still gets an answer on time (the goroutine finishes in the
// background).
func callMCPTool(s *Server, r *http.Request, t *mcpTool, args map[string]any) (any, error) {
	ctx, cancel := context.WithTimeout(r.Context(), mcpCallTimeout)
	defer cancel()
	type outcome struct {
		out any
		err error
	}
	done := make(chan outcome, 1)
	go func() {
		defer func() {
			if p := recover(); p != nil {
				done <- outcome{nil, fmt.Errorf("internal error in %s", t.Name)}
			}
		}()
		out, err := t.run(s, r.WithContext(ctx), args)
		done <- outcome{out, err}
	}()
	select {
	case o := <-done:
		return o.out, o.err
	case <-ctx.Done():
		return nil, fmt.Errorf("%s: gave up after %s; use a smaller net, horizon or state budget", t.Name, mcpCallTimeout)
	}
}

// mcpResult builds the tools/call result, keeping it under mcpMaxResultBytes.
func mcpResult(out any) map[string]any {
	return mcpResultLimit(out, mcpMaxResultBytes)
}

func mcpResultLimit(out any, limit int) map[string]any {
	text, err := json.Marshal(out)
	if err != nil {
		return map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": "result is not JSON"}}}
	}
	if len(text) <= limit {
		return map[string]any{"content": []map[string]any{{"type": "text", "text": string(text)}}, "structuredContent": out}
	}
	var generic any
	if json.Unmarshal(text, &generic) != nil {
		generic = string(text)
	}
	note := fmt.Sprintf("result was %d bytes, over the %d-byte limit; long arrays and strings were cut. Ask for less (a smaller net, fewer points, a place filter).", len(text), limit)
	for _, step := range []struct{ items, chars int }{{200, 2000}, {50, 500}, {10, 200}, {3, 80}} {
		env := map[string]any{"truncated": true, "original_bytes": len(text), "note": note, "result": shrink(generic, step.items, step.chars)}
		b, _ := json.Marshal(env)
		if len(b) <= limit {
			return map[string]any{"content": []map[string]any{{"type": "text", "text": string(b)}}, "structuredContent": env}
		}
	}
	// Even the smallest shrink is too big (a huge object of small values):
	// fall back to a cut preview of the text, which is no longer JSON.
	cut := limit / 2
	env := map[string]any{"truncated": true, "original_bytes": len(text), "note": note, "preview": string(text[:cut])}
	b, _ := json.Marshal(env)
	return map[string]any{"content": []map[string]any{{"type": "text", "text": string(b)}}, "structuredContent": env}
}

// shrink returns v with arrays cut to maxItems (marking the cut) and strings to
// maxChars. Objects keep all keys; a net with thousands of places falls through
// to the preview.
func shrink(v any, maxItems, maxChars int) any {
	switch x := v.(type) {
	case []any:
		n := len(x)
		if n > maxItems {
			n = maxItems
		}
		out := make([]any, 0, n+1)
		for _, e := range x[:n] {
			out = append(out, shrink(e, maxItems, maxChars))
		}
		if len(x) > n {
			out = append(out, fmt.Sprintf("… %d more item(s) not shown", len(x)-n))
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = shrink(e, maxItems, maxChars)
		}
		return out
	case string:
		if r := []rune(x); len(r) > maxChars {
			return string(r[:maxChars]) + fmt.Sprintf("… (%d more characters)", len(r)-maxChars)
		}
	}
	return v
}

// ---- the tools ----

var (
	idArg    = map[string]any{"type": "string"}
	intArr   = map[string]any{"description": "a token count, or one count per colour", "oneOf": []any{map[string]any{"type": "integer", "minimum": 0}, map[string]any{"type": "array", "items": map[string]any{"type": []any{"integer", "null"}, "minimum": 0}}}}
	maxStArg = map[string]any{"type": "integer", "description": "state budget (default 2000, ≤ 20000)"}
)

func registryTools() []mcpTool {
	return []mcpTool{
		{
			Name: "pflow_edit",
			Description: "Build or edit a net. Give `net` (omit it to start from an empty net) and an ordered list of `ops`; all are applied or none (an error names the failing op). Returns the changed net, its CID and a size summary. Stores nothing: pass the returned net back in for the next edit, or to pflow_save. " +
				"Ops (each {op, ...}): add_place{id?,label?,initial?,capacity?,x?,y?}, add_transition{id?,label?,rate?,x?,y?}, add_arc{source,target,weight?,inhibit?}, set_arc{source,target,weight?,inhibit?}, delete_arc{source,target}, " +
				"set_place{id,initial?,capacity?} (capacity 0/null = unbounded), add_tokens{id,delta?,color?}, set_rate{id,rate}, set_label{id,label}, rename{id,new_id}, move{id,x,y}, delete{ids}, set_details{name?,description?}. " +
				"Ids default to p0,p1,… / t0,t1,…; x,y default to a tidy grid. An arc joins a place and a transition; inhibit on place→transition is an inhibitor arc, on transition→place a read arc.",
			InputSchema: obj(map[string]any{
				"net": netArg,
				"ops": map[string]any{"type": "array", "maxItems": maxEditOps, "items": map[string]any{"type": "object", "properties": map[string]any{"op": map[string]any{"type": "string"}}, "required": []any{"op"}}},
			}, "ops"),
			run: mcpEdit,
		},
		{
			Name:        "pflow_info",
			Description: "Summarise a net: name, colours, every place (initial, capacity), transition (rate) and arc, plus the current marking and which transitions are enabled in it.",
			InputSchema: obj(map[string]any{"net": netArg}, "net"),
			run:         mcpInfo,
		},
		{
			Name:        "pflow_fire",
			Description: "Play the token game: fire the transitions in `sequence` in order from the net's marking (go-pflow's firing rules: weights, inhibitors, capacities). Stops at the first one that is not enabled and says which. Returns the marking reached and what is enabled there; for a single-colour net also the net with that marking as its initial marking.",
			InputSchema: obj(map[string]any{"net": netArg, "sequence": map[string]any{"type": "array", "items": idArg, "maxItems": 10000}}, "net", "sequence"),
			run:         mcpFire,
		},
		{
			Name:        "pflow_validate",
			Description: "go-pflow's structural checks: structure, connectivity, deadlocks, unboundedness, conservation (with the net's conservation laws as equations). With reachability=true also explores the state space (bounded by max_states). Errors and warnings carry the affected nodes and a suggestion.",
			InputSchema: obj(map[string]any{"net": netArg, "reachability": map[string]any{"type": "boolean", "description": "also explore reachable markings (default false)"}, "max_states": maxStArg}, "net"),
			run:         mcpValidate,
		},
		{
			Name: "pflow_verify",
			Description: "Check properties of a net and get proved / refuted / unknown with evidence: a structural proof from an invariant, or a replayable firing sequence for a counterexample (go-pflow verify). `properties` is a list of {kind, ...}: " +
				"deadlock-free, bounded, live, terminating, conserves, reachable{target:{place:n}}, unreachable{target}, invariant{expr:\"a + b == 3\"}, mutual-exclusion{places:[…],bound}. A reachable verdict carries the firing sequence. Unknown means the search hit max_states, not a pass.",
			InputSchema: obj(map[string]any{
				"net":        netArg,
				"properties": map[string]any{"type": "array", "maxItems": 50, "items": map[string]any{"type": "object", "properties": map[string]any{"kind": map[string]any{"type": "string"}}, "required": []any{"kind"}}},
				"max_states": maxStArg,
			}, "net", "properties"),
			run: mcpVerify,
		},
		{
			Name:        "pflow_invariants",
			Description: "Minimal semi-positive P-invariants (conservation laws, valued at the net's marking) and T-invariants (firing multisets that return the net to its marking), by Farkas elimination on the incidence matrix. `kind` is p, t or both (default both). `truncated` is true if the elimination hit its row limit: what is listed is valid, but may be incomplete.",
			InputSchema: obj(map[string]any{"net": netArg, "kind": map[string]any{"type": "string", "enum": []any{"p", "t", "both"}}}, "net"),
			run:         mcpInvariants,
		},
		{
			Name:        "pflow_incidence",
			Description: "The incidence matrix C = post − pre (rows: places, columns: transitions, both sorted by id; inhibitor and read arcs move nothing and are left out).",
			InputSchema: obj(map[string]any{"net": netArg}, "net"),
			run:         mcpIncidence,
		},
		{
			Name:        "pflow_ssa",
			Description: "Gillespie stochastic simulation (go-pflow's portable SSA, seeded, so the same call gives the same answer) from the net's marking with each transition's rate unless `rates` overrides it. With runs > 1 the series are means and `std_dev` the spread. Exact at small token counts, where the ODE of pflow_simulate is not; respects inhibitors, read arcs and capacities.",
			InputSchema: obj(map[string]any{
				"net":    netArg,
				"t_end":  map[string]any{"type": "number", "description": "end time (default 10, ≤ 10000)"},
				"seed":   map[string]any{"type": "integer", "description": "RNG seed (default 1); run r uses seed + r"},
				"runs":   map[string]any{"type": "integer", "description": "realizations averaged (default 1, ≤ 50)"},
				"points": map[string]any{"type": "integer", "description": "samples returned (default 51, 2..500)"},
				"rates":  map[string]any{"type": "object", "description": "{transition: rate} overrides"},
			}, "net"),
			run: mcpSSA,
		},
		{
			Name:        "pflow_rate_scan",
			Description: "Sweep one transition's rate across [from, to] in `steps` values and report every place's value at t_end each time (ODE, go-pflow Tsit5): which way, and how hard, that rate moves the outcome.",
			InputSchema: obj(map[string]any{
				"net":        netArg,
				"transition": idArg,
				"from":       map[string]any{"type": "number"},
				"to":         map[string]any{"type": "number"},
				"steps":      map[string]any{"type": "integer", "description": "values tried (default 11, 2..50)"},
				"t_end":      map[string]any{"type": "number", "description": "end time (default 10, ≤ 10000)"},
			}, "net", "transition", "from", "to"),
			run: mcpRateScan,
		},
		{
			Name:        "pflow_export",
			Description: "The net as `json` (normalised pflow.xyz JSON-LD with its CID, the default) or `svg` (the server's drawing of it; `layout` may be force-atlas-2, circular or hierarchical).",
			InputSchema: obj(map[string]any{
				"net":    netArg,
				"format": map[string]any{"type": "string", "enum": []any{"json", "svg"}},
				"layout": map[string]any{"type": "string", "enum": []any{"force-atlas-2", "circular", "hierarchical"}},
			}, "net"),
			run: mcpExport,
		},
	}
}

// ---- reading a net ----

// goNet parses the argument with go-pflow, the engines' reader.
func goNet(args map[string]any) (*petri.PetriNet, map[string]any, error) {
	raw, doc, err := netBytes(args)
	if err != nil {
		return nil, nil, err
	}
	net, err := parser.FromJSON(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	return net, doc, nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// startMarking is the net's initial marking, in the analyzers' (unfolded) names.
func startMarking(net *petri.PetriNet) reachability.Marking {
	exp, _ := net.ExpandColors()
	m := reachability.Marking{}
	for name, p := range exp.Places {
		m[name] = int(p.GetTokenCount())
	}
	return m
}

func enabledIn(net *petri.PetriNet) []string {
	an := reachability.NewAnalyzer(net)
	exp, _ := net.ExpandColors()
	out := []string{}
	for _, t := range sortedKeys(exp.Transitions) {
		if ok, _ := an.CanFire([]string{t}); ok {
			out = append(out, t)
		}
	}
	return out
}

func mcpInfo(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	net, doc, err := goNet(args)
	if err != nil {
		return nil, err
	}
	places := []map[string]any{}
	pm, _ := doc["places"].(map[string]any)
	for _, id := range sortedKeys(pm) {
		p, _ := pm[id].(map[string]any)
		e := map[string]any{"id": id, "initial": p["initial"], "capacity": p["capacity"]}
		if l, ok := p["label"]; ok {
			e["label"] = l
		}
		places = append(places, e)
	}
	trans := []map[string]any{}
	tm, _ := doc["transitions"].(map[string]any)
	rates := ratesOf(doc)
	for _, id := range sortedKeys(tm) {
		t, _ := tm[id].(map[string]any)
		rate := 1.0
		if r, ok := rates[id]; ok {
			rate = r
		}
		e := map[string]any{"id": id, "rate": rate}
		if l, ok := t["label"]; ok {
			e["label"] = l
		}
		trans = append(trans, e)
	}
	arcs := []map[string]any{}
	al, _ := doc["arcs"].([]any)
	for _, a := range al {
		if m, ok := a.(map[string]any); ok {
			arcs = append(arcs, map[string]any{"source": m["source"], "target": m["target"], "weight": m["weight"], "inhibit": m["inhibitTransition"] == true})
		}
	}
	out := map[string]any{
		"places": places, "transitions": trans, "arcs": arcs,
		"colors": colorCount(doc), "marking": startMarking(net), "enabled": enabledIn(net),
	}
	for _, k := range []string{"name", "description"} {
		if v, ok := doc[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}

func colorCount(doc map[string]any) int {
	if t, ok := doc["token"].([]any); ok && len(t) > 0 {
		return len(t)
	}
	return 1
}

func mcpFire(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	net, doc, err := goNet(args)
	if err != nil {
		return nil, err
	}
	seq, err := stringList(args["sequence"], "sequence")
	if err != nil {
		return nil, err
	}
	exp, _ := net.ExpandColors()
	for _, t := range seq {
		if _, ok := exp.Transitions[t]; !ok {
			return nil, fmt.Errorf("sequence: %q is not a transition", t)
		}
	}
	an := reachability.NewAnalyzer(net)
	out := map[string]any{}
	ok, marking := an.CanFire(seq)
	if !ok {
		// Find the first step that fails, for the message.
		for i := range seq {
			if okPrefix, _ := an.CanFire(seq[:i+1]); !okPrefix {
				out["failed_at"] = i
				out["failed_transition"] = seq[i]
				_, marking = an.CanFire(seq[:i])
				break
			}
		}
	}
	out["fired"] = ok
	out["marking"] = marking
	// What is enabled at the marking reached: fire each candidate on top of the sequence.
	prefix := seq
	if !ok {
		prefix = seq[:out["failed_at"].(int)]
	}
	enabled := []string{}
	for _, t := range sortedKeys(exp.Transitions) {
		if good, _ := an.CanFire(append(append([]string{}, prefix...), t)); good {
			enabled = append(enabled, t)
		}
	}
	out["enabled"] = enabled
	if colorCount(doc) == 1 {
		moved := cloneDoc(doc)
		if pm, ok := moved["places"].(map[string]any); ok {
			for id, v := range marking {
				if p, ok := pm[id].(map[string]any); ok {
					p["initial"] = []any{float64(v)}
				}
			}
		}
		out["net"] = moved
	}
	return out, nil
}

func stringList(v any, name string) ([]string, error) {
	l, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("%s: a list of strings", name)
	}
	out := make([]string, 0, len(l))
	for _, e := range l {
		s, ok := e.(string)
		if !ok {
			return nil, fmt.Errorf("%s: a list of strings", name)
		}
		out = append(out, s)
	}
	return out, nil
}

func mcpValidate(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	_, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	// The editor reads capacity 0 / null as unbounded, as do go-pflow's
	// engines, but its structure check sums the vector and flags a marked place
	// with capacity 0 as over capacity. Leave an all-unbounded capacity out so
	// the check sees what the editor means.
	doc = cloneDoc(doc)
	dropUnboundedCapacity(doc)
	raw, _ := json.Marshal(doc)
	net, err := parser.FromJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	v := validation.NewValidator(net)
	if b, _ := args["reachability"].(bool); b {
		max, err := numArg(args, "max_states", 2000, 1, maxMCPStates)
		if err != nil {
			return nil, err
		}
		return v.ValidateWithReachability(int(max)), nil
	}
	return v.Validate(), nil
}

func dropUnboundedCapacity(doc map[string]any) {
	pm, _ := doc["places"].(map[string]any)
	for _, v := range pm {
		p, ok := v.(map[string]any)
		if !ok {
			continue
		}
		caps, isList := p["capacity"].([]any)
		if !isList {
			continue
		}
		unbounded := true
		for _, c := range caps {
			if f, ok := c.(float64); ok && f != 0 {
				unbounded = false
			}
		}
		if unbounded {
			delete(p, "capacity")
		}
	}
}

func mcpVerify(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	net, _, err := goNet(args)
	if err != nil {
		return nil, err
	}
	max, err := numArg(args, "max_states", 2000, 1, maxMCPStates)
	if err != nil {
		return nil, err
	}
	rawProps, err := json.Marshal(args["properties"])
	if err != nil {
		return nil, errors.New("properties: a list of {kind, …}")
	}
	var props []verify.Property
	if err := json.Unmarshal(rawProps, &props); err != nil || len(props) == 0 {
		return nil, errors.New("properties: a non-empty list of {kind, …} (see the tool description)")
	}
	return verify.New(net).WithMaxStates(int(max)).Check(props...), nil
}

func mcpInvariants(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	net, _, err := goNet(args)
	if err != nil {
		return nil, err
	}
	kind, _ := args["kind"].(string)
	if kind == "" {
		kind = "both"
	}
	if kind != "p" && kind != "t" && kind != "both" {
		return nil, errors.New("kind: p, t or both")
	}
	exp, _ := net.ExpandColors()
	an := reachability.NewInvariantAnalyzer(exp)
	out := map[string]any{}
	if kind != "t" {
		var list []map[string]any
		for _, inv := range an.FindPInvariants(startMarking(net)) {
			inv := inv
			list = append(list, map[string]any{"equation": inv.String(), "coefficients": inv.Coefficients, "value": inv.Value})
		}
		out["p_invariants"] = list
		out["p_truncated"] = an.PInvariantBasis().Truncated
		out["conservative"] = an.CheckConservation(startMarking(net))
	}
	if kind != "p" {
		var list []map[string]any
		for _, inv := range an.FindTInvariants() {
			inv := inv
			list = append(list, map[string]any{"firing_multiset": inv.String(), "counts": inv.Counts})
		}
		out["t_invariants"] = list
		out["t_truncated"] = an.TInvariantBasis().Truncated
	}
	out["structurally_bounded"] = an.StructuralBoundedness()
	return out, nil
}

func mcpIncidence(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	net, _, err := goNet(args)
	if err != nil {
		return nil, err
	}
	exp, _ := net.ExpandColors()
	matrix, places, trans := reachability.NewInvariantAnalyzer(exp).IncidenceMatrix()
	return map[string]any{"places": places, "transitions": trans, "matrix": matrix}, nil
}

// ---- simulation ----

func mcpSSA(_ *Server, r *http.Request, args map[string]any) (any, error) {
	raw, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	tEnd, err := numArg(args, "t_end", 10, 1e-9, maxMCPTEnd)
	if err != nil {
		return nil, err
	}
	seed, err := numArg(args, "seed", 1, 0, 1<<53)
	if err != nil {
		return nil, err
	}
	runs, err := numArg(args, "runs", 1, 1, 50)
	if err != nil {
		return nil, err
	}
	pts, err := numArg(args, "points", 51, 2, 500)
	if err != nil {
		return nil, err
	}
	model, _, err := parser.ModelFromJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	rates := ratesOf(doc)
	if over, ok := args["rates"].(map[string]any); ok {
		for k, v := range over {
			f, ok := v.(float64)
			if !ok || f < 0 || math.IsInf(f, 0) {
				return nil, fmt.Errorf("rates.%s: a number ≥ 0", k)
			}
			rates[k] = f
		}
	}
	marking := map[string]int{}
	for _, p := range model.Places {
		marking[p.ID] = int(p.Initial)
	}
	res, err := stochastic.Simulate(model, marking, stochastic.Options{
		Horizon: tEnd, Samples: int(pts), Rates: rates, Seed: int64(seed), Realizations: int(runs),
		Portable: true, Context: r.Context(), MaxSteps: maxSSASteps, MaxPlaceTokens: 1_000_000,
	})
	if err != nil {
		return nil, fmt.Errorf("ssa: %v", err)
	}
	return res, nil
}

func mcpRateScan(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	net, doc, err := goNet(args)
	if err != nil {
		return nil, err
	}
	tr, _ := args["transition"].(string)
	if _, ok := net.Transitions[tr]; !ok {
		return nil, fmt.Errorf("transition: %q is not a transition of the net", tr)
	}
	from, err := numArg(args, "from", 0, 0, 1e6)
	if err != nil {
		return nil, err
	}
	to, err := numArg(args, "to", 0, 0, 1e6)
	if err != nil {
		return nil, err
	}
	if _, ok := args["from"]; !ok {
		return nil, errors.New("from: a number ≥ 0")
	}
	if _, ok := args["to"]; !ok {
		return nil, errors.New("to: a number ≥ 0")
	}
	steps, err := numArg(args, "steps", 11, 2, 50)
	if err != nil {
		return nil, err
	}
	tEnd, err := numArg(args, "t_end", 10, 1e-9, maxMCPTEnd)
	if err != nil {
		return nil, err
	}
	base := ratesOf(doc)
	n := int(steps)
	rows := make([]map[string]any, 0, n)
	for i := 0; i < n; i++ {
		rate := from + (to-from)*float64(i)/float64(n-1)
		rates := map[string]float64{}
		for k, v := range base {
			rates[k] = v
		}
		rates[tr] = rate
		sol := solver.Solve(solver.NewProblem(net, net.SetState(nil), [2]float64{0, tEnd}, net.SetRates(rates)), solver.Tsit5(), solver.DefaultOptions())
		rows = append(rows, map[string]any{"rate": rate, "final": sol.GetFinalState(), "truncated": sol.Truncated})
	}
	return map[string]any{"engine": "ode (go-pflow Tsit5)", "transition": tr, "t_end": tEnd, "scan": rows}, nil
}

func mcpExport(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	raw, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	format, _ := args["format"].(string)
	switch format {
	case "", "json":
		out := map[string]any{"net": doc}
		if cid, _, err := seal.SealJSONLD(raw); err == nil {
			out["cid"] = cid
		}
		return out, nil
	case "svg":
		layout, _ := args["layout"].(string)
		s, err := svg.GenerateSVGWithLayout(raw, layout)
		if err != nil {
			return nil, fmt.Errorf("cannot draw the net: %v", err)
		}
		return map[string]any{"format": "svg", "svg": s}, nil
	}
	return nil, errors.New("format: json or svg")
}

// ---- editing ----

func cloneDoc(doc map[string]any) map[string]any {
	b, _ := json.Marshal(doc)
	var out map[string]any
	json.Unmarshal(b, &out)
	return out
}

func emptyNetDoc() map[string]any {
	return map[string]any{
		"@context": "https://pflow.xyz/schema", "@type": "PetriNet", "@version": "1.1",
		"token": []any{"https://pflow.xyz/tokens/black"}, "places": map[string]any{}, "transitions": map[string]any{}, "arcs": []any{},
	}
}

func mcpEdit(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	var doc map[string]any
	if n, ok := args["net"]; ok && n != nil {
		m, ok := n.(map[string]any)
		if !ok {
			return nil, errors.New("net: a JSON object (the editor's format)")
		}
		doc = cloneDoc(m)
	} else {
		doc = emptyNetDoc()
	}
	for k, def := range map[string]any{"places": map[string]any{}, "transitions": map[string]any{}, "arcs": []any{}} {
		if doc[k] == nil {
			doc[k] = def
		}
	}
	if _, ok := doc["places"].(map[string]any); !ok {
		return nil, errors.New("net.places: an object keyed by place id")
	}
	if _, ok := doc["transitions"].(map[string]any); !ok {
		return nil, errors.New("net.transitions: an object keyed by transition id")
	}
	if _, ok := doc["arcs"].([]any); !ok {
		return nil, errors.New("net.arcs: a list")
	}
	if doc["@context"] == nil {
		doc["@context"] = "https://pflow.xyz/schema"
	}
	if doc["@type"] == nil {
		doc["@type"] = "PetriNet"
	}
	if doc["@version"] == nil {
		doc["@version"] = "1.1"
	}
	if doc["token"] == nil {
		doc["token"] = []any{"https://pflow.xyz/tokens/black"}
	}
	ops, ok := args["ops"].([]any)
	if !ok {
		return nil, errors.New("ops: a list of {op, …}")
	}
	if len(ops) > maxEditOps {
		return nil, fmt.Errorf("ops: at most %d per call", maxEditOps)
	}
	results := make([]any, 0, len(ops))
	for i, o := range ops {
		op, ok := o.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("ops[%d]: an object {op, …}", i)
		}
		res, err := applyOp(doc, op)
		if err != nil {
			return nil, fmt.Errorf("ops[%d] (%v): %v", i, op["op"], err)
		}
		results = append(results, res)
	}
	out := map[string]any{"net": doc, "applied": len(ops), "results": results}
	pm, tm, al := doc["places"].(map[string]any), doc["transitions"].(map[string]any), doc["arcs"].([]any)
	out["summary"] = map[string]any{"places": len(pm), "transitions": len(tm), "arcs": len(al)}
	if err := validateJSONLD(doc); err != nil {
		return nil, fmt.Errorf("the edited net is not valid JSON-LD: %v", err)
	}
	raw, _ := json.Marshal(doc)
	if cid, _, err := seal.SealJSONLD(raw); err == nil {
		out["cid"] = cid
	}
	if _, err := parser.FromJSON(raw); err != nil {
		out["warning"] = "go-pflow cannot read the result yet: " + err.Error()
	}
	return out, nil
}

// The edit helpers mirror public/petri-commands.js (net.*, edit.delete,
// sim.set_rate), so an edit made here and one made in the editor agree.

func nodeKind(doc map[string]any, id string) string {
	if _, ok := doc["places"].(map[string]any)[id]; ok {
		return "place"
	}
	if _, ok := doc["transitions"].(map[string]any)[id]; ok {
		return "transition"
	}
	return ""
}

func needNode(doc map[string]any, id any, want string) (map[string]any, error) {
	s, _ := id.(string)
	k := nodeKind(doc, s)
	if k == "" {
		return nil, fmt.Errorf("%q is not a place or transition", s)
	}
	if want != "" && k != want {
		return nil, fmt.Errorf("%q is a %s, not a %s", s, k, want)
	}
	coll := doc["places"].(map[string]any)
	if k == "transition" {
		coll = doc["transitions"].(map[string]any)
	}
	return coll[s].(map[string]any), nil
}

func newID(doc map[string]any, v any, prefix string) (string, error) {
	if v == nil {
		for i := 0; ; i++ {
			id := fmt.Sprintf("%s%d", prefix, i)
			if nodeKind(doc, id) == "" {
				return id, nil
			}
		}
	}
	id, ok := v.(string)
	if !ok || strings.TrimSpace(id) == "" || strings.ContainsAny(id, " \t\r\n") {
		return "", fmt.Errorf("%v is not a usable id (non-empty, no spaces)", v)
	}
	if len([]rune(id)) > 100 {
		return "", errors.New("an id is at most 100 characters")
	}
	switch id {
	case "__proto__", "constructor", "prototype":
		return "", fmt.Errorf("%q cannot be an id", id)
	}
	if nodeKind(doc, id) != "" {
		return "", fmt.Errorf("%q is already used", id)
	}
	return id, nil
}

func checkLabel(v any) (string, error) {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return "", errors.New("label cannot be empty")
	}
	if len([]rune(s)) > 100 {
		return "", errors.New("label must be 100 characters or fewer")
	}
	if strings.ContainsAny(s, "\r\n") {
		return "", errors.New("label must be a single line")
	}
	return s, nil
}

// vecOf turns a count or list of counts into one value per colour. nilFill
// marks a capacity slot as unbounded (0).
func vecOf(v any, colors int, fill float64) ([]any, error) {
	var out []any
	switch x := v.(type) {
	case float64:
		out = []any{x}
	case nil:
		out = []any{nil}
	case []any:
		out = append(out, x...)
	default:
		return nil, fmt.Errorf("%v: a count or a list of counts", v)
	}
	for i, e := range out {
		switch f := e.(type) {
		case nil:
		case float64:
			if f < 0 || f != math.Trunc(f) || math.IsInf(f, 0) {
				return nil, fmt.Errorf("[%d]: a whole number ≥ 0", i)
			}
		default:
			return nil, fmt.Errorf("[%d]: a whole number ≥ 0", i)
		}
	}
	for len(out) < colors {
		out = append(out, fill)
	}
	return out, nil
}

// capacityOf maps null to 0 (unbounded), the document's own convention.
func capacityOf(v any, colors int) ([]any, error) {
	c, err := vecOf(v, colors, 0)
	if err != nil {
		return nil, err
	}
	for i, e := range c {
		if e == nil {
			c[i] = float64(0)
		}
	}
	return c, nil
}

func initialOf(v any, colors int) ([]any, error) {
	c, err := vecOf(v, colors, 0)
	if err != nil {
		return nil, err
	}
	for i, e := range c {
		if e == nil {
			c[i] = float64(0)
		}
	}
	return c, nil
}

func withinCapacity(id string, p map[string]any) error {
	ini, _ := p["initial"].([]any)
	cap, _ := p["capacity"].([]any)
	for i := range ini {
		if i >= len(cap) {
			break
		}
		c, _ := cap[i].(float64)
		n, _ := ini[i].(float64)
		if c > 0 && n > c {
			return fmt.Errorf("places.%s: %g tokens exceed capacity %g", id, n, c)
		}
	}
	return nil
}

func num(op map[string]any, k string, def float64) (float64, error) {
	v, ok := op[k]
	if !ok || v == nil {
		return def, nil
	}
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, fmt.Errorf("%s: a number", k)
	}
	return f, nil
}

func applyOp(doc, op map[string]any) (any, error) {
	name, _ := op["op"].(string)
	places, trans := doc["places"].(map[string]any), doc["transitions"].(map[string]any)
	colors := colorCount(doc)
	switch name {
	case "add_place":
		id, err := newID(doc, op["id"], "p")
		if err != nil {
			return nil, err
		}
		n := float64(len(places))
		x, err := num(op, "x", 100+150*math.Mod(n, 6))
		if err != nil {
			return nil, err
		}
		y, err := num(op, "y", 100+150*math.Floor(n/6)*2)
		if err != nil {
			return nil, err
		}
		ini, err := initialOf(op["initial"], colors)
		if err != nil {
			return nil, fmt.Errorf("initial%v", err)
		}
		cap, err := capacityOf(op["capacity"], colors)
		if err != nil {
			return nil, fmt.Errorf("capacity%v", err)
		}
		p := map[string]any{"@type": "Place", "x": math.Round(x), "y": math.Round(y), "offset": float64(0), "initial": ini, "capacity": cap}
		if l, ok := op["label"]; ok {
			if p["label"], err = checkLabel(l); err != nil {
				return nil, err
			}
		}
		if err := withinCapacity(id, p); err != nil {
			return nil, err
		}
		places[id] = p
		return map[string]any{"id": id}, nil
	case "add_transition":
		id, err := newID(doc, op["id"], "t")
		if err != nil {
			return nil, err
		}
		n := float64(len(trans))
		x, err := num(op, "x", 100+150*math.Mod(n, 6))
		if err != nil {
			return nil, err
		}
		y, err := num(op, "y", 100+150*math.Floor(n/6)*2+150)
		if err != nil {
			return nil, err
		}
		t := map[string]any{"@type": "Transition", "x": math.Round(x), "y": math.Round(y)}
		if l, ok := op["label"]; ok {
			if t["label"], err = checkLabel(l); err != nil {
				return nil, err
			}
		}
		if r, ok := op["rate"]; ok && r != nil {
			f, ok := r.(float64)
			if !ok || f < 0 || math.IsInf(f, 0) {
				return nil, errors.New("rate: a number ≥ 0")
			}
			if f != 1.0 {
				t["rate"] = f
			}
		}
		trans[id] = t
		return map[string]any{"id": id}, nil
	case "add_arc", "set_arc":
		src, _ := op["source"].(string)
		dst, _ := op["target"].(string)
		arcs := doc["arcs"].([]any)
		if name == "add_arc" {
			sk, tk := nodeKind(doc, src), nodeKind(doc, dst)
			if _, err := needNode(doc, src, ""); err != nil {
				return nil, err
			}
			if _, err := needNode(doc, dst, ""); err != nil {
				return nil, err
			}
			if sk == tk {
				return nil, fmt.Errorf("an arc joins a place and a transition; %s and %s are both %ss", src, dst, sk)
			}
			inhibit, _ := op["inhibit"].(bool)
			for _, a := range arcs {
				m := a.(map[string]any)
				if m["source"] == src && m["target"] == dst && (m["inhibitTransition"] == true) == inhibit {
					return nil, fmt.Errorf("there is already an arc %s → %s; use set_arc", src, dst)
				}
			}
			w, err := vecOf(orDefault(op["weight"], float64(1)), colors, 0)
			if err != nil {
				return nil, fmt.Errorf("weight%v", err)
			}
			doc["arcs"] = append(arcs, map[string]any{"@type": "Arrow", "source": src, "target": dst, "weight": w, "inhibitTransition": inhibit})
			return map[string]any{}, nil
		}
		for _, a := range arcs {
			m := a.(map[string]any)
			if m["source"] == src && m["target"] == dst {
				if w, ok := op["weight"]; ok {
					v, err := vecOf(w, colors, 0)
					if err != nil {
						return nil, fmt.Errorf("weight%v", err)
					}
					m["weight"] = v
				}
				if inh, ok := op["inhibit"].(bool); ok {
					m["inhibitTransition"] = inh
				}
				return map[string]any{}, nil
			}
		}
		return nil, fmt.Errorf("no arc %s → %s", src, dst)
	case "delete_arc":
		src, _ := op["source"].(string)
		dst, _ := op["target"].(string)
		arcs := doc["arcs"].([]any)
		kept := make([]any, 0, len(arcs))
		for _, a := range arcs {
			if m := a.(map[string]any); !(m["source"] == src && m["target"] == dst) {
				kept = append(kept, a)
			}
		}
		if len(kept) == len(arcs) {
			return nil, fmt.Errorf("no arc %s → %s", src, dst)
		}
		doc["arcs"] = kept
		return map[string]any{}, nil
	case "set_place":
		p, err := needNode(doc, op["id"], "place")
		if err != nil {
			return nil, err
		}
		if v, ok := op["initial"]; ok {
			if p["initial"], err = initialOf(v, colors); err != nil {
				return nil, fmt.Errorf("initial%v", err)
			}
		}
		if v, ok := op["capacity"]; ok {
			if p["capacity"], err = capacityOf(v, colors); err != nil {
				return nil, fmt.Errorf("capacity%v", err)
			}
		}
		return map[string]any{}, withinCapacity(op["id"].(string), p)
	case "set_label":
		n, err := needNode(doc, op["id"], "")
		if err != nil {
			return nil, err
		}
		if n["label"], err = checkLabel(op["label"]); err != nil {
			return nil, err
		}
		return map[string]any{}, nil
	case "add_tokens":
		p, err := needNode(doc, op["id"], "place")
		if err != nil {
			return nil, err
		}
		delta, err := num(op, "delta", 1)
		if err != nil {
			return nil, err
		}
		ci, err := num(op, "color", 0)
		if err != nil {
			return nil, err
		}
		i := int(ci)
		ini, _ := p["initial"].([]any)
		if ci < 0 || ci != math.Trunc(ci) || (i >= colors && i >= len(ini)) {
			return nil, fmt.Errorf("color %d: the net has %d colour(s)", i, colors)
		}
		for len(ini) <= i {
			ini = append(ini, float64(0))
		}
		cur, _ := ini[i].(float64)
		if cur+delta < 0 {
			return nil, fmt.Errorf("%v has %g token(s); cannot remove %g", op["id"], cur, -delta)
		}
		ini[i] = cur + delta
		p["initial"] = ini
		if err := withinCapacity(op["id"].(string), p); err != nil {
			return nil, err
		}
		return map[string]any{"initial": ini}, nil
	case "set_rate":
		t, err := needNode(doc, op["id"], "transition")
		if err != nil {
			return nil, err
		}
		r, ok := op["rate"].(float64)
		if !ok || r < 0 || math.IsInf(r, 0) || math.IsNaN(r) {
			return nil, errors.New("rate: a number ≥ 0")
		}
		t["rate"] = r
		return map[string]any{}, nil
	case "move":
		n, err := needNode(doc, op["id"], "")
		if err != nil {
			return nil, err
		}
		x, errx := num(op, "x", math.NaN())
		y, erry := num(op, "y", math.NaN())
		if errx != nil || erry != nil || math.IsNaN(x) || math.IsNaN(y) {
			return nil, errors.New("x and y: numbers")
		}
		n["x"], n["y"] = math.Round(x), math.Round(y)
		return map[string]any{}, nil
	case "rename":
		old, _ := op["id"].(string)
		k := nodeKind(doc, old)
		if k == "" {
			return nil, fmt.Errorf("%q is not a place or transition", old)
		}
		nid, err := newID(doc, orDefault(op["new_id"], ""), "")
		if err != nil || op["new_id"] == nil {
			if err == nil {
				err = errors.New("new_id: required")
			}
			return nil, err
		}
		coll := places
		if k == "transition" {
			coll = trans
		}
		coll[nid] = coll[old]
		delete(coll, old)
		for _, a := range doc["arcs"].([]any) {
			m := a.(map[string]any)
			if m["source"] == old {
				m["source"] = nid
			}
			if m["target"] == old {
				m["target"] = nid
			}
		}
		return map[string]any{"id": nid}, nil
	case "delete":
		ids, err := stringList(op["ids"], "ids")
		if err != nil {
			return nil, err
		}
		gone := map[string]bool{}
		for _, id := range ids {
			if nodeKind(doc, id) == "" {
				return nil, fmt.Errorf("%q is not a place or transition", id)
			}
			gone[id] = true
		}
		for id := range gone {
			delete(places, id)
			delete(trans, id)
		}
		kept := []any{}
		for _, a := range doc["arcs"].([]any) {
			if m := a.(map[string]any); !gone[fmt.Sprint(m["source"])] && !gone[fmt.Sprint(m["target"])] {
				kept = append(kept, a)
			}
		}
		doc["arcs"] = kept
		return map[string]any{"deleted": ids}, nil
	case "set_details":
		for _, k := range []string{"name", "description"} {
			v, ok := op[k]
			if !ok {
				continue
			}
			s, ok := v.(string)
			if !ok {
				return nil, fmt.Errorf("%s: a string", k)
			}
			if s = strings.TrimSpace(s); s == "" {
				delete(doc, k)
			} else {
				doc[k] = s
			}
		}
		return map[string]any{}, nil
	}
	return nil, fmt.Errorf("unknown op %q (add_place, add_transition, add_arc, set_arc, delete_arc, set_place, add_tokens, set_rate, set_label, rename, move, delete, set_details)", name)
}

func orDefault(v, def any) any {
	if v == nil {
		return def
	}
	return v
}
