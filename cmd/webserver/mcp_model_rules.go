package main

// The composition rules behind the pflow_bundle_* tools: a link's verdict,
// the candidates a drag from a port could reach, the flat net, a firing script
// on it and its incidence matrix.
//
// The decisions are go-pflow's: a link is judged by metamodel.Bundle.Validate
// (on a bundle of the link alone, as pflow-native judges it), the flat net is
// Bundle.FlattenWithMap, and a script fires through Model.EnabledWhyNot and
// Fire. What this file adds is the shape the answers have and a few rules
// that are not Validate's, all of them pflow-native's, so that a composition
// gets the same answer from this server as from the composition page (the
// vendored native build): see mcp_models_parity_test.go.
//
//   - two page rules (rule: "page" in a verdict): a link joins two different
//     subnets (PAGE_SAME_SUBNET; Validate does not refuse a link inside one
//     subnet) and the same link is not added twice (PAGE_DUPLICATE; an event
//     link either way round);
//   - candidates: which ports a drag from a port may reach, the first legal
//     kind winning, as the composition page's rules.candidates does;
//   - the names of what flattening makes, which are go-pflow's, and the order
//     of the warnings it adds (go-pflow lists them in map order, so they are
//     sorted by the canonical member of the fused class they name, native's
//     order).
//
// Verdicts leave out `passed`, the descriptive list of checks a legal link met
// that native's page cites into go-pflow's source lines: the verdict is the
// errors and warnings.

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

// ---- ports, links, endpoints

// mbPortKey is "subnet:port", the page's port reference (port ids may hold a
// colon, subnet ids do not).
func mbPortKey(e metamodel.Endpoint) string { return e.Subnet + ":" + e.Port }

// mbLinkKey is "kind:subnet:port->subnet:port".
func mbLinkKey(l metamodel.Link) string {
	return string(l.Kind) + ":" + mbPortKey(l.From) + "->" + mbPortKey(l.To)
}

func mbEnd(e metamodel.Endpoint) map[string]any {
	return map[string]any{"subnet": e.Subnet, "port": e.Port}
}

func mbLinkView(l metamodel.Link) map[string]any {
	return map[string]any{"kind": string(l.Kind), "from": mbEnd(l.From), "to": mbEnd(l.To)}
}

var mbKinds = []metamodel.LinkKind{metamodel.TokenLink, metamodel.DataLink, metamodel.EventLink, metamodel.GuardLink}

func mbParseKind(s string) (metamodel.LinkKind, error) {
	for _, k := range mbKinds {
		if string(k) == s {
			return k, nil
		}
	}
	return "", fmt.Errorf("unknown link kind %q (token, data, event, guard)", s)
}

// mbJSONText is a value as native prints it in a message: compact JSON.
func mbJSONText(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(v)
	}
	return string(b)
}

// mbParseEndpoint reads {"subnet", "port"} or "subnet:port".
func mbParseEndpoint(v any) (metamodel.Endpoint, error) {
	switch x := v.(type) {
	case string:
		a, b, ok := strings.Cut(x, ":")
		if !ok || a == "" || b == "" {
			return metamodel.Endpoint{}, fmt.Errorf("endpoint %q is not \"subnet:port\"", x)
		}
		return metamodel.Endpoint{Subnet: a, Port: b}, nil
	case map[string]any:
		a, _ := x["subnet"].(string)
		b, _ := x["port"].(string)
		if a == "" || b == "" {
			return metamodel.Endpoint{}, fmt.Errorf("endpoint %s needs \"subnet\" and \"port\"", mbJSONText(x))
		}
		return metamodel.Endpoint{Subnet: a, Port: b}, nil
	}
	return metamodel.Endpoint{}, fmt.Errorf("an endpoint is {\"subnet\", \"port\"} or \"subnet:port\", not %s", mbJSONText(v))
}

// mbParseLink reads {kind, from, to}.
func mbParseLink(v any) (metamodel.Link, error) {
	m, _ := v.(map[string]any)
	kind, ok := m["kind"].(string)
	if !ok {
		return metamodel.Link{}, fmt.Errorf("link %s has no \"kind\"", mbJSONText(v))
	}
	k, err := mbParseKind(kind)
	if err != nil {
		return metamodel.Link{}, err
	}
	from, err := mbParseEndpoint(m["from"])
	if err != nil {
		return metamodel.Link{}, err
	}
	to, err := mbParseEndpoint(m["to"])
	if err != nil {
		return metamodel.Link{}, err
	}
	return metamodel.Link{Kind: k, From: from, To: to}, nil
}

// ---- verdicts

// mbIssue is a refusal or warning, with whose rule it is.
type mbIssue struct{ code, message, rule string }

func (i mbIssue) view() map[string]any {
	return map[string]any{"code": i.code, "message": i.message, "rule": i.rule}
}

// mbVerdict is the judgment on one link.
type mbVerdict struct {
	ok       bool
	kind     string
	errors   []mbIssue
	warnings []mbIssue
}

func (v mbVerdict) view() map[string]any {
	view := func(is []mbIssue) []any {
		out := make([]any, len(is))
		for i, x := range is {
			out[i] = x.view()
		}
		return out
	}
	return map[string]any{"ok": v.ok, "kind": v.kind, "errors": view(v.errors), "warnings": view(v.warnings)}
}

// refusal is "[CODE] message; …", the error a refused edit returns.
func (v mbVerdict) refusal() string {
	parts := make([]string, len(v.errors))
	for i, e := range v.errors {
		parts[i] = "[" + e.code + "] " + e.message
	}
	return strings.Join(parts, "; ")
}

// mbLinkLabel is the label Validate gives the one link of the bundle a verdict
// is computed on.
const mbLinkLabel = "links[0]"

// mbValidateLink judges `l` against the bundle's subnets: the same-subnet page
// rule, then Validate on a bundle of the subnets `l` names and `l` alone.
// Errors are all of Validate's; warnings, the link's own.
func mbValidateLink(b *metamodel.Bundle, l metamodel.Link) mbVerdict {
	v := mbVerdict{ok: true, kind: string(l.Kind)}
	if l.From.Subnet == l.To.Subnet {
		v.ok = false
		v.errors = append(v.errors, mbIssue{"PAGE_SAME_SUBNET",
			fmt.Sprintf("%s: both ends are on subnet %q; a link connects two subnets", mbLinkLabel, l.From.Subnet), "page"})
		return v
	}
	one := metamodel.NewBundle("verdict")
	for i := range b.Subnets {
		if s := b.Subnets[i]; s.ID == l.From.Subnet || s.ID == l.To.Subnet {
			one.AddSubnet(s)
		}
	}
	one.AddLink(l)
	res := one.Validate()
	for _, e := range res.Errors {
		v.errors = append(v.errors, mbIssue{e.Code, e.Message, "pflow-compose"})
	}
	for _, w := range res.Warnings {
		if w.Element == mbLinkLabel {
			v.warnings = append(v.warnings, mbIssue{w.Code, w.Message, "pflow-compose"})
		}
	}
	v.ok = len(v.errors) == 0
	return v
}

// mbHasLink reports whether the bundle already has `l` (an event link either
// way round).
func mbHasLink(b *metamodel.Bundle, l metamodel.Link) bool {
	key := mbLinkKey(l)
	rev := mbLinkKey(metamodel.Link{Kind: l.Kind, From: l.To, To: l.From})
	for _, x := range b.Links {
		if k := mbLinkKey(x); k == key || (l.Kind == metamodel.EventLink && k == rev) {
			return true
		}
	}
	return false
}

// mbVerdictIn is the verdict on `l` against this bundle, page rules included
// (duplicate: against the links already there).
func mbVerdictIn(b *metamodel.Bundle, l metamodel.Link) mbVerdict {
	v := mbValidateLink(b, l)
	if v.ok && mbHasLink(b, l) {
		v.ok = false
		v.errors = append(v.errors, mbIssue{"PAGE_DUPLICATE", "already linked", "page"})
	}
	return v
}

// ---- candidates

type mbKindTry struct {
	kind metamodel.LinkKind
	swap bool // a guard oriented transition → place, the drag having started at the place
}

// mbKindsFor are the kinds worth trying from a port to a port, in the order
// "auto" prefers.
func mbKindsFor(fromTransition, toTransition bool) []mbKindTry {
	switch {
	case fromTransition && toTransition:
		return []mbKindTry{{metamodel.EventLink, false}}
	case fromTransition:
		return []mbKindTry{{metamodel.GuardLink, false}}
	case toTransition:
		return []mbKindTry{{metamodel.GuardLink, true}}
	}
	return []mbKindTry{{metamodel.TokenLink, false}, {metamodel.DataLink, false}}
}

// mbCandidates judges every other port of the bundle as the far end of a link
// dragged from `from`. `prefer` is "auto" or one link kind. For each target the
// first legal kind wins; when none is legal the first kind tried is kept, so a
// caller can say why.
func mbCandidates(ctx context.Context, b *metamodel.Bundle, from metamodel.Endpoint, prefer string) ([]any, error) {
	var preferKind metamodel.LinkKind
	if prefer != "auto" {
		k, err := mbParseKind(prefer)
		if err != nil {
			return nil, err
		}
		preferKind = k
	}
	fs := b.SubnetByID(from.Subnet)
	if fs == nil {
		return nil, fmt.Errorf("no subnet %q in the composition", from.Subnet)
	}
	fp := fs.PortByID(from.Port)
	if fp == nil {
		return nil, fmt.Errorf("subnet %q has no port %q", from.Subnet, from.Port)
	}
	out := []any{}
	for si := range b.Subnets {
		s := &b.Subnets[si]
		for pi := range s.Ports {
			tp := &s.Ports[pi]
			if s.ID == from.Subnet && tp.ID == from.Port {
				continue
			}
			if err := ctx.Err(); err != nil {
				return nil, fmt.Errorf("gave up: %v", err)
			}
			to := metamodel.Endpoint{Subnet: s.ID, Port: tp.ID}
			kinds := mbKindsFor(fp.IsTransition(), tp.IsTransition())
			if preferKind != "" {
				kept := kinds[:0:0]
				for _, k := range kinds {
					if k.kind == preferKind {
						kept = append(kept, k)
					}
				}
				if len(kept) == 0 {
					kept = []mbKindTry{{preferKind, false}}
				}
				kinds = kept
			}
			type tried struct {
				link    metamodel.Link
				verdict mbVerdict
			}
			var all []tried
			best := -1
			for _, k := range kinds {
				l := metamodel.Link{Kind: k.kind, From: from, To: to}
				if k.swap {
					l = metamodel.Link{Kind: k.kind, From: to, To: from}
				}
				v := mbVerdictIn(b, l)
				all = append(all, tried{l, v})
				if v.ok {
					best = len(all) - 1
					break
				}
			}
			if best < 0 {
				best = 0
			}
			triedView := make([]any, len(all))
			for i, t := range all {
				triedView[i] = map[string]any{"link": mbLinkView(t.link), "verdict": t.verdict.view()}
			}
			out = append(out, map[string]any{
				"ref": mbEnd(to), "key": mbPortKey(to), "ok": all[best].verdict.ok,
				"link": mbLinkView(all[best].link), "verdict": all[best].verdict.view(), "tried": triedView,
			})
		}
	}
	return out, nil
}

// ---- the flat net

// mbFlat is a flattened bundle: the net and how it was made.
type mbFlat struct {
	model *metamodel.Model
	fm    *metamodel.FlattenMap
}

func mbFlatten(b *metamodel.Bundle) (*mbFlat, error) {
	m, fm, err := b.FlattenWithMap()
	if err != nil {
		return nil, err
	}
	// go-pflow adds one W_EVENTLINK_CYCLE warning per fused transition in the
	// order of a map; native lists them by each class's canonical member (the
	// smallest). Validate's own warnings come first and keep their order.
	var rest, cycles []metamodel.ValidationError
	for _, w := range fm.Warnings {
		if w.Code == metamodel.WarnEventLinkCycle {
			cycles = append(cycles, w)
		} else {
			rest = append(rest, w)
		}
	}
	root := func(w metamodel.ValidationError) string {
		if m := fm.FusedGroups[w.Element]; len(m) > 0 {
			return m[0] // the smallest member, the class's canonical one
		}
		return w.Element
	}
	sort.SliceStable(cycles, func(i, j int) bool { return root(cycles[i]) < root(cycles[j]) })
	fm.Warnings = append(rest, cycles...)
	return &mbFlat{m, fm}, nil
}

// transitionOf is the flat transition a member "<subnet>/<transition>" ended up in.
func (f *mbFlat) transitionOf(member string) (string, bool) {
	s, t, ok := strings.Cut(member, "/")
	if !ok {
		return "", false
	}
	flat, ok := f.fm.Transition[s][t]
	return flat, ok
}

func (f *mbFlat) placeOf(member string) (string, bool) {
	s, p, ok := strings.Cut(member, "/")
	if !ok {
		return "", false
	}
	flat, ok := f.fm.Place[s][p]
	return flat, ok
}

// members inverts a subnet → local → flat map: flat → sorted "subnet/local".
func mbInvert(m map[string]map[string]string) map[string][]string {
	out := map[string][]string{}
	for s, locals := range m {
		for local, flat := range locals {
			out[flat] = append(out[flat], s+"/"+local)
		}
	}
	for _, v := range out {
		sort.Strings(v)
	}
	return out
}

func mbArcView(a metamodel.Arc) map[string]any {
	return map[string]any{"from": a.From, "to": a.To, "weight": a.Weight, "type": string(a.Type)}
}

func mbArcsView(m *metamodel.Model) []any {
	out := make([]any, len(m.Arcs))
	for i, a := range m.Arcs {
		out[i] = mbArcView(a)
	}
	return out
}

func mbConstraintsView(m *metamodel.Model) []any {
	out := make([]any, len(m.Constraints))
	for i, c := range m.Constraints {
		out[i] = map[string]any{"id": c.ID, "expr": c.Expr}
	}
	return out
}

func mbPlaceView(p *metamodel.Place) map[string]any {
	kind := "data"
	if p.IsToken() {
		kind = "token"
	}
	return map[string]any{
		"id": p.ID, "kind": kind, "initial": p.Initial, "capacity": p.Capacity,
		"exported": p.Exported, "resource": p.Resource, "description": p.Description,
	}
}

func mbStringsMap(m map[string][]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = mbStrings(v)
	}
	return out
}

func mbNestedMap(m map[string]map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		inner := make(map[string]any, len(v))
		for a, b := range v {
			inner[a] = b
		}
		out[k] = inner
	}
	return out
}

// mbFlatView is the flat net and its map: what pflow_bundle_flatten returns.
func mbFlatView(f *mbFlat) map[string]any {
	pm, tm := mbInvert(f.fm.Place), mbInvert(f.fm.Transition)
	places := make([]any, len(f.model.Places))
	for i := range f.model.Places {
		p := &f.model.Places[i]
		v := mbPlaceView(p)
		v["members"] = mbStrings(pm[p.ID])
		places[i] = v
	}
	transitions := make([]any, len(f.model.Transitions))
	mk := f.model.InitialMarking()
	enablement := make([]any, len(f.model.Transitions))
	for i := range f.model.Transitions {
		t := &f.model.Transitions[i]
		_, fused := f.fm.FusedGroups[t.ID]
		transitions[i] = map[string]any{"id": t.ID, "description": t.Description, "members": mbStrings(tm[t.ID]), "fused": fused}
		if err := f.model.EnabledWhyNot(t.ID, mk); err != nil {
			enablement[i] = map[string]any{"transition": t.ID, "enabled": false, "why": err.Error()}
		} else {
			enablement[i] = map[string]any{"transition": t.ID, "enabled": true, "why": ""}
		}
	}
	warnings := make([]any, len(f.fm.Warnings))
	for i, w := range f.fm.Warnings {
		warnings[i] = map[string]any{"code": w.Code, "element": w.Element, "message": w.Message}
	}
	return map[string]any{
		"ok": true, "error": "",
		"places": places, "transitions": transitions, "arcs": mbArcsView(f.model), "constraints": mbConstraintsView(f.model),
		"wires": mbStringsMap(f.fm.Wires), "fused_groups": mbStringsMap(f.fm.FusedGroups),
		"place_map": mbNestedMap(f.fm.Place), "transition_map": mbNestedMap(f.fm.Transition),
		"warnings": warnings, "initial_enablement": enablement,
	}
}

// ---- how big the answer is

// mbMaxAnswerBytes bounds what a flat net may weigh in the answer. The result
// guard cuts an answer to 60 KB, but only after the whole of it has been built
// and printed, and a fused transition's name is repeated in every map, arc and
// list that mentions it: a bundle of a few hundred KB can make an answer of
// tens of MB. The estimate below is made from the flat net before any of that
// is built, and a net that would weigh more is refused.
const mbMaxAnswerBytes = 2 << 20

// answerBytes estimates the size of pflow_bundle_flatten's answer (the
// incidence matrix's names and pflow_bundle_run's final marking are parts of it).
func (f *mbFlat) answerBytes() int {
	n := 0
	for _, p := range f.model.Places {
		n += 160 + len(p.ID) + len(p.Description)
	}
	for _, t := range f.model.Transitions {
		// the transition, its entry in the initial enablement (the reason names
		// it and a place), and the lists of its members below
		n += 320 + 3*len(t.ID) + len(t.Description)
	}
	for _, a := range f.model.Arcs {
		n += 64 + len(a.From) + len(a.To)
	}
	for _, c := range f.model.Constraints {
		n += 32 + len(c.ID) + len(c.Expr)
	}
	for name, members := range f.fm.Wires {
		n += 16 + len(name)
		for _, m := range members {
			n += 6 + len(m)
		}
	}
	for name, members := range f.fm.FusedGroups {
		n += 16 + len(name)
		for _, m := range members {
			n += 6 + len(m)
		}
	}
	for subnet, locals := range f.fm.Place {
		for local, flat := range locals {
			n += 2*(len(subnet)+len(local)) + len(flat) + 24 // the map and the place's members
		}
	}
	for subnet, locals := range f.fm.Transition {
		for local, flat := range locals {
			n += 2*(len(subnet)+len(local)) + len(flat) + 24
		}
	}
	for _, w := range f.fm.Warnings {
		n += 64 + len(w.Code) + len(w.Element) + len(w.Message)
	}
	return n
}

// checkAnswer refuses a flat net whose answer would pass mbMaxAnswerBytes.
func (f *mbFlat) checkAnswer(tool string) error {
	if n := f.answerBytes(); n > mbMaxAnswerBytes {
		return fmt.Errorf("%s: the flat net's answer would be about %d bytes (at most %d): long fused transition names are repeated in every list and map that mentions them; use shorter ids or fewer event links", tool, n, mbMaxAnswerBytes)
	}
	return nil
}

// ---- running a script

// mbRun fires `script` (members "<subnet>/<transition>") on the flat net from
// its initial marking, through Model.EnabledWhyNot and Fire, stopping at the
// first member that is not in the net or cannot fire; then it evaluates
// `expect` on the marking reached.
func mbRun(f *mbFlat, id, title string, script []string, expect []mbExpect) (map[string]any, error) {
	mk := f.model.InitialMarking()
	steps := []any{}
	stoppedAt := -1
	// what the answer weighs: a step names its member, the flat transition it
	// fired and why not, and the final marking names every flat place
	size := 0
	for _, p := range f.model.Places {
		size += 24 + len(p.ID)
	}
	for i, member := range script {
		flat, found := f.transitionOf(member)
		var why string
		if !found {
			why = fmt.Sprintf("no member %q in the composition", member)
		} else if err := f.model.EnabledWhyNot(flat, mk); err != nil {
			why = err.Error()
		}
		var flatName any
		if found {
			flatName = flat
		}
		steps = append(steps, map[string]any{"member": member, "flat": flatName, "enabled": why == "", "why": why})
		if size += 80 + len(member) + len(flat) + len(why); size > mbMaxAnswerBytes {
			return nil, fmt.Errorf("pflow_bundle_run: the answer would be over %d bytes (the steps name long fused transitions); use a shorter script or shorter ids", mbMaxAnswerBytes)
		}
		if why != "" {
			stoppedAt = i
			break
		}
		mk = f.model.Fire(flat, mk)
	}
	results := make([]any, len(expect))
	for i, e := range expect {
		flat, found := f.placeOf(e.Place)
		var flatName any
		actual := 0
		if found {
			flatName = flat
			actual = mk[flat]
		}
		results[i] = map[string]any{
			"place": e.Place, "flat": flatName, "op": "==", "n": e.N, "says": e.Says,
			"actual": actual, "pass": actual == e.N,
		}
	}
	final := make(map[string]any, len(mk))
	for p, n := range mk {
		final[p] = n
	}
	var stoppedStep any
	if stoppedAt >= 0 {
		stoppedStep = script[stoppedAt]
	}
	return map[string]any{
		"id": id, "title": title, "steps": steps, "completed": stoppedAt < 0, "stopped_at": stoppedAt,
		"stopped_step": stoppedStep, "final_marking": final, "expect": results,
	}, nil
}

// ---- incidence

// mbIncidence is C = post − pre of a model (rows: places, columns: transitions,
// in model order). Read and inhibitor arcs move nothing.
func mbIncidence(m *metamodel.Model) [][]int {
	c := make([][]int, len(m.Places))
	for i := range c {
		c[i] = make([]int, len(m.Transitions))
	}
	pi := map[string]int{}
	for i, p := range m.Places {
		if _, dup := pi[p.ID]; !dup {
			pi[p.ID] = i
		}
	}
	ti := map[string]int{}
	for i, t := range m.Transitions {
		if _, dup := ti[t.ID]; !dup {
			ti[t.ID] = i
		}
	}
	for _, a := range m.Arcs {
		if a.IsReadOnly() {
			continue
		}
		if p, ok := pi[a.From]; ok {
			if t, ok := ti[a.To]; ok {
				c[p][t] -= a.Weight
				continue
			}
		}
		if t, ok := ti[a.From]; ok {
			if p, ok := pi[a.To]; ok {
				c[p][t] += a.Weight
			}
		}
	}
	return c
}

func mbMatrixView(c [][]int) []any {
	out := make([]any, len(c))
	for i, row := range c {
		r := make([]any, len(row))
		for j, n := range row {
			r[j] = n
		}
		out[i] = r
	}
	return out
}

// mbInvariantHolds reads a declared constraint as a P-invariant: `tokens("a") +
// … == n` gives y (1 on each place named); it holds when y·C = 0 and y·M₀ = n
// (together they prove it for every reachable marking). ok is false when the
// expression is not a plain sum of tokens(…) equal to an integer.
func mbInvariantHolds(m *metamodel.Model, c [][]int, expr string) (holds, ok bool) {
	i := strings.LastIndex(expr, " == ")
	if i < 0 {
		return false, false
	}
	lhs, rhs := expr[:i], expr[i+len(" == "):]
	n, err := strconv.ParseInt(strings.TrimSpace(rhs), 10, 64)
	if err != nil {
		return false, false
	}
	y := make([]int, len(m.Places))
	for _, term := range strings.Split(lhs, " + ") {
		p, found := strings.CutPrefix(strings.TrimSpace(term), `tokens("`)
		if !found {
			return false, false
		}
		p, found = strings.CutSuffix(p, `")`)
		if !found {
			return false, false
		}
		pos := -1
		for j := range m.Places {
			if m.Places[j].ID == p {
				pos = j
				break
			}
		}
		if pos < 0 {
			return false, false
		}
		y[pos]++
	}
	var yM0 int64
	for j := range m.Places {
		yM0 += int64(y[j]) * int64(m.Places[j].Initial)
	}
	yC := true
	for t := range m.Transitions {
		sum := 0
		for p := range y {
			sum += y[p] * c[p][t]
		}
		if sum != 0 {
			yC = false
			break
		}
	}
	return yC && yM0 == n, true
}

// mbIncidenceView is the flat net's matrix, each subnet's own block and each
// declared constraint checked as y·C = 0.
func mbIncidenceView(b *metamodel.Bundle) (map[string]any, error) {
	f, err := mbFlatten(b)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, nil
	}
	if err := f.checkAnswer("pflow_bundle_incidence"); err != nil {
		return nil, err
	}
	// the matrices are rows x columns of numbers, of the flat net and of each subnet
	cells := len(f.model.Places) * len(f.model.Transitions)
	for i := range b.Subnets {
		if m := b.Subnets[i].Model; m != nil {
			cells += len(m.Places) * len(m.Transitions)
		}
	}
	if cells > mbMaxMatrixCells {
		return nil, fmt.Errorf("pflow_bundle_incidence: the matrices would have %d cells (%d flat places x %d flat transitions, and each subnet's own); at most %d, and the answer limit is %d KB. pflow_bundle_flatten lists the arcs, which are the matrix's non-zero cells",
			cells, len(f.model.Places), len(f.model.Transitions), mbMaxMatrixCells, mcpMaxResultBytes>>10)
	}
	c := mbIncidence(f.model)
	rows := make([]any, len(f.model.Places))
	for i, p := range f.model.Places {
		rows[i] = p.ID
	}
	cols := make([]any, len(f.model.Transitions))
	for i, t := range f.model.Transitions {
		cols[i] = t.ID
	}
	blocks := make([]any, len(b.Subnets))
	for i := range b.Subnets {
		s := &b.Subnets[i]
		r := make([]any, len(s.Model.Places))
		for j, p := range s.Model.Places {
			r[j] = p.ID
		}
		cc := make([]any, len(s.Model.Transitions))
		for j, t := range s.Model.Transitions {
			cc[j] = t.ID
		}
		blocks[i] = map[string]any{"subnet": s.ID, "rows": r, "cols": cc, "matrix": mbMatrixView(mbIncidence(s.Model))}
	}
	invariants := make([]any, len(f.model.Constraints))
	for i, k := range f.model.Constraints {
		var holds any
		if h, ok := mbInvariantHolds(f.model, c, k.Expr); ok {
			holds = h
		}
		invariants[i] = map[string]any{"id": k.ID, "expr": k.Expr, "holds": holds}
	}
	return map[string]any{"ok": true, "rows": rows, "cols": cols, "matrix": mbMatrixView(c), "blocks": blocks, "invariants": invariants}, nil
}
