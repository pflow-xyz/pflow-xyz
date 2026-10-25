package main

// pflow_simulate on a gated net. Mass-action ODE has no firing instant, so it
// cannot test an inhibitor arc, a read arc or a capacity; the page's engines of
// record (public/petri-sim.js, public/petri-ssa.js) do. A net that uses any of
// them is therefore run on go-pflow's discrete engine (stochastic.Simulate on
// the portable path, byte-exact with petri-ssa.js) instead of being integrated
// as if the gates were not there.

import (
	"fmt"
	"math"
	"sort"

	"github.com/pflow-xyz/go-pflow/metamodel"
	"github.com/pflow-xyz/go-pflow/stochastic"
)

const (
	mcpSSASeed         = 42
	mcpSSARealizations = 20
)

// firstInt reads an editor scalar-or-vector number as the portable contract
// does: the first component.
func firstInt(v any, def int) int {
	switch x := v.(type) {
	case float64:
		return int(x)
	case []any:
		if len(x) > 0 {
			return firstInt(x[0], def)
		}
	}
	return def
}

// gatedModel reads the editor's document as a go-pflow metamodel, keeping what
// the discrete engine enforces: inhibitor arcs, read arcs (`type: "read"`),
// output-side inhibitors (the editor's test arcs, which need tokens present)
// and place capacities. Places and transitions are in sorted id order.
func gatedModel(doc map[string]any, rates map[string]float64) *metamodel.Model {
	m := &metamodel.Model{Name: "net"}
	ps, _ := doc["places"].(map[string]any)
	ids := make([]string, 0, len(ps))
	for id := range ps {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	isPlace := map[string]bool{}
	for _, id := range ids {
		p, _ := ps[id].(map[string]any)
		isPlace[id] = true
		m.Places = append(m.Places, metamodel.Place{ID: id, Initial: firstInt(p["initial"], 0), Capacity: firstInt(p["capacity"], 0)})
	}
	ts, _ := doc["transitions"].(map[string]any)
	ids = ids[:0]
	for id := range ts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		rate := 1.0
		if r, ok := rates[id]; ok && r > 0 {
			rate = r
		}
		m.Transitions = append(m.Transitions, metamodel.Transition{ID: id, Rate: rate})
	}
	arcs, _ := doc["arcs"].([]any)
	for _, a := range arcs {
		am, _ := a.(map[string]any)
		src, _ := am["source"].(string)
		dst, _ := am["target"].(string)
		typ, _ := am["type"].(string)
		inhibit, _ := am["inhibitTransition"].(bool)
		w := firstInt(am["weight"], 1)
		arc := metamodel.Arc{From: src, To: dst, Weight: w}
		switch {
		case isPlace[src] && (inhibit || typ == "inhibitor"):
			arc.Type = metamodel.InhibitorArc
		case isPlace[src] && typ == "read":
			arc.Type = metamodel.ReadArc
		case isPlace[dst] && inhibit:
			// the editor's test arc (transition -> place): fires only while
			// the place holds at least w, consuming nothing
			arc = metamodel.Arc{From: dst, To: src, Weight: w, Type: metamodel.ReadArc}
		}
		m.Arcs = append(m.Arcs, arc)
	}
	return m
}

// simulateGated runs the discrete engine and shapes its answer like the ODE's.
func simulateGated(rates map[string]float64, tEnd float64, n int, gates []string, m *metamodel.Model) (any, error) {
	start := map[string]int{}
	for _, p := range m.Places {
		start[p.ID] = p.Initial
	}
	res, err := stochastic.Simulate(m, start, stochastic.Options{
		Horizon: tEnd, Samples: n, Seed: mcpSSASeed, Realizations: mcpSSARealizations, Portable: true,
	})
	if err != nil {
		return nil, fmt.Errorf("discrete engine: %v", err)
	}
	series := map[string][]float64{}
	for _, s := range res.Series {
		series[s.Place] = s.Values
	}
	final := map[string]float64{}
	for p, v := range res.Final {
		final[p] = math.Round(v*1e9) / 1e9
	}
	return map[string]any{
		"engine": fmt.Sprintf("ssa (go-pflow stochastic, mean of %d paths, seed %d)", mcpSSARealizations, mcpSSASeed),
		"why":    "the net has gates a continuous solver cannot test, so it ran on the discrete engine the page uses",
		"gates":  gates, "t_end": tEnd, "rates": rates, "final": final, "t": res.Times, "series": series,
		"truncated": res.Truncated,
	}, nil
}
