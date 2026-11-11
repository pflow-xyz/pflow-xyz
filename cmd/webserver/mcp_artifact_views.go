package main

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/pflow-xyz/go-pflow/petri"
)

// What a pflow_artifact page leads with, and what else the ontology can say
// about the net. Both are rules over the net's size, shape and verdicts, so a
// page never needs a model's opinion about what kind of model it is.
//
// The views are the page's sections: "game" (the token game), "graph" (the
// populations over time and the phase plane), "verdicts", "class" and "inv"
// (P-invariants). Every page can show every view: the person exposes a hidden
// one from the Explore this model panel. recommendViews only decides which are
// open when the page loads, and in what order.

const (
	viewGame     = "game"
	viewGraph    = "graph"
	viewVerdicts = "verdicts"
	viewClass    = "class"
	viewInv      = "inv"
)

var allViews = []string{viewGame, viewGraph, viewVerdicts, viewClass, viewInv}

// viewAdvice is what the page gets as D.views.
type viewAdvice struct {
	Shown  []string `json:"shown"`  // open on load, in page order
	All    []string `json:"all"`    // every view, for the Explore panel
	Reason string   `json:"reason"` // one sentence, shown in the panel
	Lead   string   `json:"lead"`   // "dynamics", "play" or "analysis"
}

// Size thresholds. A handful of places and transitions is a rate law, not a
// state space: the person wants the gradient (populations over time, the phase
// plane) and the dynamics, not a reachability verdict. A large net is the
// reverse: nobody reads a token game of 60 nodes, they want the verdicts and
// the conservation laws.
const (
	dynamicsMaxPlaces = 4
	dynamicsMaxTrans  = 6
	analysisMinNodes  = 60
)

// recommendViews is the rule. bounded is the reachability verdict (true,
// false or "unknown"); complete is whether the search finished.
func recommendViews(nPlaces, nTrans int, complete bool, bounded any) viewAdvice {
	a := viewAdvice{All: allViews}
	switch {
	case nPlaces+nTrans >= analysisMinNodes:
		// Size comes first: a 60-node net with an unfinished search is still a
		// net to read through verdicts and invariants, not a rate law.
		a.Lead = "analysis"
		a.Shown = []string{viewVerdicts, viewInv, viewClass, viewGame}
		a.Reason = "A net this size is read through its verdicts and conservation laws, so analysis leads. The graph is one click away."
	case bounded == false || !complete:
		// The state space is infinite or past the budget: tokens grow or
		// shrink continuously in effect, so the dynamics are the model.
		a.Lead = "dynamics"
		a.Shown = []string{viewGraph, viewGame, viewClass}
		a.Reason = "The state space is unbounded or too large to list, so the graph leads. Verdicts and invariants are one click away."
	case nPlaces <= dynamicsMaxPlaces && nTrans <= dynamicsMaxTrans:
		a.Lead = "dynamics"
		a.Shown = []string{viewGraph, viewGame, viewClass}
		a.Reason = "With this few places and transitions the dynamics are the point, so the graph leads. Verdicts and invariants are one click away."
	default:
		a.Lead = "play"
		a.Shown = []string{viewGame, viewVerdicts, viewClass, viewInv}
		a.Reason = "A small bounded net is understood by playing it and reading the verdicts. The graph is one click away."
	}
	return a
}

// structuralClasses are the classes the net's own shape earns, independent of
// any search: StateMachineNet and MarkedGraphNet from the arcs,
// ConservativeNet from a positive P-invariant over every place, and
// UnboundedNet from the reachability verdict. They sit beside the behavioural
// classes (LiveNet and the others); the ontology declares each of them.
func structuralClasses(places []artPlace, trans []artTransition, arcs []artArc, invs []map[string]any, bounded any) []string {
	var out []string
	if isStateMachine(trans, arcs) {
		out = append(out, "StateMachineNet")
	}
	if isMarkedGraph(places, arcs) {
		out = append(out, "MarkedGraphNet")
	}
	if isConservative(touchedPlaces(arcs), invs) {
		out = append(out, "ConservativeNet")
	}
	if bounded == false {
		out = append(out, "UnboundedNet")
	}
	return out
}

func isStateMachine(trans []artTransition, arcs []artArc) bool {
	if len(trans) == 0 {
		return false
	}
	in, outc := map[string]int{}, map[string]int{}
	isT := map[string]bool{}
	for _, t := range trans {
		isT[t.ID] = true
	}
	for _, a := range arcs {
		if a.Inhibit || a.Weight != 1 {
			return false
		}
		if isT[a.Target] {
			in[a.Target]++
		} else if isT[a.Source] {
			outc[a.Source]++
		}
	}
	for _, t := range trans {
		if in[t.ID] != 1 || outc[t.ID] != 1 {
			return false
		}
	}
	return true
}

func isMarkedGraph(places []artPlace, arcs []artArc) bool {
	if len(places) == 0 {
		return false
	}
	isP := map[string]bool{}
	for _, p := range places {
		isP[p.ID] = true
	}
	in, outc := map[string]int{}, map[string]int{}
	for _, a := range arcs {
		if a.Inhibit || a.Weight != 1 {
			return false
		}
		if isP[a.Target] {
			in[a.Target]++
		} else if isP[a.Source] {
			outc[a.Source]++
		}
	}
	for _, p := range places {
		if in[p.ID] != 1 || outc[p.ID] != 1 {
			return false
		}
	}
	return true
}

// isConservative: some P-invariant has a positive coefficient on every place,
// so the weighted token count never changes. The coefficients arrive as a
// list or a place-keyed map depending on the handler; read either.
func isConservative(touched map[string]bool, invs []map[string]any) bool {
	if len(touched) == 0 {
		return false
	}
	for _, inv := range invs {
		co := coefficientMap(inv)
		ok := true
		for id := range touched {
			if co[id] <= 0 {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// coefficientMap reads an invariant's coefficients, place id to weight.
func coefficientMap(inv map[string]any) map[string]float64 {
	raw, err := json.Marshal(inv["coefficients"])
	if err != nil {
		return nil
	}
	m := map[string]float64{}
	_ = json.Unmarshal(raw, &m)
	return m
}

// touchedPlaces are the places some arc names. In an unfolded coloured net the
// others are colour slots that never hold a token.
func touchedPlaces(arcs []artArc) map[string]bool {
	out := map[string]bool{}
	for _, a := range arcs {
		out[a.Source], out[a.Target] = true, true
	}
	return out
}

// meaningfulInvariants drops the invariants that only say an unused colour
// slot stays empty ("no brown tokens in Waiting Customers"): a conservation law
// has to involve a place the net actually uses.
func meaningfulInvariants(invs []map[string]any, touched map[string]bool) []map[string]any {
	out := []map[string]any{}
	for _, inv := range invs {
		for id, c := range coefficientMap(inv) {
			if c != 0 && touched[id] {
				out = append(out, inv)
				break
			}
		}
	}
	return out
}

// tokenSources names the transitions that create tokens from nothing (no
// input arc) and those that destroy them (no output arc), the usual reason
// nothing is conserved.
func tokenSources(trans []artTransition, arcs []artArc) (creators, destroyers []string) {
	creators, destroyers = []string{}, []string{}
	in, out := map[string]bool{}, map[string]bool{}
	for _, a := range arcs {
		if a.Inhibit {
			continue
		}
		in[a.Target], out[a.Source] = true, true
	}
	for _, t := range trans {
		if !in[t.ID] {
			creators = append(creators, t.ID)
		}
		if !out[t.ID] {
			destroyers = append(destroyers, t.ID)
		}
	}
	return
}

// capacityBound is the number of markings a net can have when every place it
// uses has a capacity, else 0 (no bound from capacities alone).
func capacityBound(places []artPlace, arcs []artArc) int {
	touched := touchedPlaces(arcs)
	b := 1
	for _, p := range places {
		if !touched[p.ID] {
			continue
		}
		if p.Capacity <= 0 {
			return 0
		}
		b *= p.Capacity + 1
		if b > 1<<30 {
			return 1 << 30
		}
	}
	return b
}

// unfoldedDoc is a coloured net's unfolding as a single-colour net document,
// the form the in-page engine and the editor read.
func unfoldedDoc(title string, places []artPlace, trans []artTransition, arcs []artArc, rates map[string]float64) map[string]any {
	pl, tr, ar := map[string]any{}, map[string]any{}, []any{}
	for _, p := range places {
		pl[p.ID] = map[string]any{"initial": []int{p.Initial}, "capacity": []int{p.Capacity}, "x": p.X, "y": p.Y, "label": p.Label}
	}
	for _, t := range trans {
		o := map[string]any{"x": t.X, "y": t.Y}
		if r, ok := rates[t.ID]; ok {
			o["rate"] = r
		}
		tr[t.ID] = o
	}
	for _, a := range arcs {
		o := map[string]any{"source": a.Source, "target": a.Target, "weight": []int{a.Weight}}
		if a.Inhibit {
			o["inhibitTransition"] = true
		}
		ar = append(ar, o)
	}
	return map[string]any{"@context": "https://pflow.xyz/schema", "@type": "PetriNet", "name": title, "places": pl, "transitions": tr, "arcs": ar}
}

func allPositive(v []float64) bool {
	for _, x := range v {
		if x <= 0 {
			return false
		}
	}
	return len(v) > 0
}

// transitionRates reads the optional per-transition rate (the schema's
// "rate") from the net as given; a transition without one runs at 1.
func transitionRates(doc map[string]any) map[string]float64 {
	out := map[string]float64{}
	ts, _ := doc["transitions"].(map[string]any)
	for id, v := range ts {
		if t, ok := v.(map[string]any); ok {
			if r, ok := t["rate"].(float64); ok && r > 0 {
				out[id] = r
			}
		}
	}
	return out
}

// tokenColor reads a token colour from its URL (https://pflow.xyz/tokens/red,
// or a bare hex such as .../tokens/ff0000) into a name and a CSS colour. The
// name is cut to letters and digits, so it is safe as an attribute value.
func tokenColor(url string) artColor {
	name := url
	if i := strings.LastIndex(url, "/"); i >= 0 {
		name = url[i+1:]
	}
	clean := make([]rune, 0, len(name))
	for _, r := range name {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			clean = append(clean, r)
		}
	}
	name = string(clean)
	if name == "" {
		name = "black"
	}
	css := name
	if (len(name) == 6 || len(name) == 3) && strings.Trim(name, "0123456789abcdefABCDEF") == "" {
		css = "#" + name
	}
	return artColor{Name: name, CSS: css}
}

// fallbackTitle names a page whose caller gave no title and whose net has no
// name: its first three place labels ("Coffee Beans, Empty Cups, Served
// Coffee +1"), one entry per place as written even when the net is coloured.
// "Petri net" remains only for a net with no usable labels.
func fallbackTitle(places []artPlace, cmap *petri.ColorMap) (string, string) {
	var labels []string
	seen := map[string]bool{}
	for _, p := range places {
		l, key := p.Label, p.ID
		if cmap != nil {
			l, key = p.BaseLabel, p.Base
		}
		if l == "" {
			l = key
		}
		if seen[key] || strings.TrimSpace(l) == "" {
			continue
		}
		seen[key] = true
		labels = append(labels, strings.TrimSpace(l))
	}
	if len(labels) == 0 {
		return "Petri net", "default"
	}
	t := strings.Join(labels[:min(3, len(labels))], ", ")
	if len(labels) > 3 {
		t += " +" + strconv.Itoa(len(labels)-3)
	}
	return t, "places"
}
