package main

// The firing rule of the flat net, as pflow-rs has it.
//
// go-pflow's Model.EnabledWhyNot and Fire are the rule's other half, and the
// two agree for every well-formed net. They part on two things a hostile or
// careless net can hold, so the tools do not call them:
//
//   - a negative arc weight. go-pflow lets a consuming arc with weight -2 be
//     always satisfied and firing it manufactures tokens; pflow-rs hardened that
//     on purpose ("never enabled", with the message below), and the composition
//     page runs pflow-rs. The weights are checked in the order pflow-rs checks
//     them, each arc's sign before its tokens: the inputs in arc order, then the
//     outputs, then the read and inhibitor arcs.
//   - a count past the integers. go-pflow's counts wrap around int64; pflow-rs'
//     saturate at its ends.
//
// Which arcs are inputs, outputs and tests, the default weight of 1 for an arc
// with none, and every message but the negative one are go-pflow's (the same
// words in pflow-rs).

import (
	"fmt"
	"math"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

func mbSatAdd(a, b int) int {
	if b > 0 && a > math.MaxInt-b {
		return math.MaxInt
	}
	if b < 0 && a < math.MinInt-b {
		return math.MinInt
	}
	return a + b
}

func mbSatSub(a, b int) int {
	if b < 0 {
		if a > math.MaxInt+b {
			return math.MaxInt
		}
	} else if a < math.MinInt+b {
		return math.MinInt
	}
	return a - b
}

// mbEnabledWhyNot is nil when `transition` can fire at `mk`, else the reason.
func mbEnabledWhyNot(m *metamodel.Model, transition string, mk metamodel.Marking) error {
	if m.TransitionByID(transition) == nil {
		return fmt.Errorf("no transition %q in model %q", transition, m.Name)
	}
	negative := func(place string, weight int) error {
		return fmt.Errorf("%s: arc to/from %s has negative weight %d", transition, place, weight)
	}
	inputs := m.Inputs(transition)
	for _, in := range inputs {
		if in.Weight < 0 {
			return negative(in.Place, in.Weight)
		}
		if have := mk[in.Place]; have < in.Weight {
			return fmt.Errorf("%s needs %d token(s) on %s, have %d", transition, in.Weight, in.Place, have)
		}
	}
	outputs := m.Outputs(transition)
	for _, out := range outputs {
		if out.Weight < 0 {
			return negative(out.Place, out.Weight)
		}
	}
	for _, t := range m.Tests(transition) {
		if t.Weight < 0 {
			return negative(t.Place, t.Weight)
		}
		have := mk[t.Place]
		if t.Type == metamodel.InhibitorArc {
			if have >= t.Weight {
				return fmt.Errorf("%s is inhibited: %s holds %d (>= %d)", transition, t.Place, have, t.Weight)
			}
		} else if have < t.Weight {
			return fmt.Errorf("%s reads %d token(s) from %s, have %d", transition, t.Weight, t.Place, have)
		}
	}
	// Capacity is a bound on the net effect of the firing.
	net := map[string]int{}
	for _, in := range inputs {
		net[in.Place] = mbSatSub(net[in.Place], in.Weight)
	}
	for _, out := range outputs {
		net[out.Place] = mbSatAdd(net[out.Place], out.Weight)
	}
	for i := range m.Places {
		p := &m.Places[i]
		if p.Capacity <= 0 || !p.IsToken() {
			continue
		}
		delta, ok := net[p.ID]
		if !ok || delta <= 0 {
			continue
		}
		if after := mbSatAdd(mk[p.ID], delta); after > p.Capacity {
			return fmt.Errorf("%s would leave %d token(s) on %s, over its capacity of %d", transition, after, p.ID, p.Capacity)
		}
	}
	return nil
}

// mbFire is the marking after `transition` fires (it does not check that it can).
func mbFire(m *metamodel.Model, transition string, mk metamodel.Marking) metamodel.Marking {
	next := mk.Clone()
	for _, in := range m.Inputs(transition) {
		next[in.Place] = mbSatSub(next[in.Place], in.Weight)
	}
	for _, out := range m.Outputs(transition) {
		next[out.Place] = mbSatAdd(next[out.Place], out.Weight)
	}
	return next
}
