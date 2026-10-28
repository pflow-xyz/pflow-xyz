package main

// What go-pflow leaves to the order of a map when it fuses transitions, made
// the order pflow-compose has.
//
// An event link fuses the transitions it joins into one class; flattening names
// each class (the link's id, else fused:<members>) and goes over the classes
// in the order of a map. Two things in an answer depend on that order and so
// differ from call to call in go-pflow: the W_EVENTLINK_CYCLE warnings, one per
// fused class, and, when two classes get the same name (two event links that
// fuse different transitions and share an id), which class the name's entry in
// the fused groups and the flat transition's description come from.
// pflow-compose goes over the classes in order of their smallest member (a
// BTreeMap), so the warnings come in that order and, for a shared name, the
// last class wins. The classes are recomputed here, from the links, and the
// answer is set to that: one answer for one bundle.
//
// (A shared name merges the classes into one flat transition in both engines,
// with the arcs of all of them, and Validate does not object; the tool's
// description says so.)

import (
	"fmt"
	"sort"
	"strings"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

// mbEventClass is a class of transitions the event links fuse (or a transition
// no event link touches, a class of one).
type mbEventClass struct {
	members []string    // sorted "<subnet>/<transition>"
	parts   [][2]string // the same, as subnet and transition
	flat    string      // the name it was given
}

// mbTransitionKey is the member "<subnet>/<transition>" an endpoint names.
func mbTransitionKey(b *metamodel.Bundle, e metamodel.Endpoint) (string, bool) {
	s := b.SubnetByID(e.Subnet)
	if s == nil {
		return "", false
	}
	switch {
	case e.Port != "":
		p := s.PortByID(e.Port)
		if p == nil || !p.IsTransition() {
			return "", false
		}
		return s.ID + "/" + p.Transition, true
	case e.Transition != "":
		return s.ID + "/" + e.Transition, true
	}
	return "", false
}

// mbEventClasses are the transition classes of the bundle, in order of their
// smallest member.
func mbEventClasses(b *metamodel.Bundle, fm *metamodel.FlattenMap) []mbEventClass {
	parent := map[string]string{}
	local := map[string][2]string{} // member → subnet, transition
	find := func(x string) string {
		root := x
		for parent[root] != root {
			root = parent[root]
		}
		for parent[x] != root {
			parent[x], x = root, parent[x]
		}
		return root
	}
	for i := range b.Subnets {
		s := &b.Subnets[i]
		if s.Model == nil {
			continue
		}
		for _, t := range s.Model.Transitions {
			key := s.ID + "/" + t.ID
			parent[key] = key
			local[key] = [2]string{s.ID, t.ID}
		}
	}
	for i := range b.Links {
		l := &b.Links[i]
		if l.Kind != metamodel.EventLink {
			continue
		}
		from, ok1 := mbTransitionKey(b, l.From)
		to, ok2 := mbTransitionKey(b, l.To)
		if !ok1 || !ok2 {
			continue
		}
		if _, ok := parent[from]; !ok {
			continue
		}
		if _, ok := parent[to]; !ok {
			continue
		}
		ra, rb := find(from), find(to)
		if ra == rb {
			continue
		}
		if rb < ra {
			ra, rb = rb, ra
		}
		parent[rb] = ra
	}
	groups := map[string][]string{}
	for key := range parent {
		root := find(key)
		groups[root] = append(groups[root], key)
	}
	roots := make([]string, 0, len(groups))
	for root := range groups {
		roots = append(roots, root)
	}
	sort.Strings(roots)
	out := make([]mbEventClass, 0, len(roots))
	for _, root := range roots {
		members := groups[root]
		sort.Strings(members)
		parts := make([][2]string, len(members))
		for i, key := range members {
			parts[i] = local[key]
		}
		out = append(out, mbEventClass{members: members, parts: parts, flat: fm.Transition[parts[0][0]][parts[0][1]]})
	}
	return out
}

// mbSettleFusion makes the fusion-dependent parts of the flattened answer the
// ones pflow-compose gives (see the file comment): the cycle warnings in class
// order, and for a name two classes share the fused group and the description
// of the class that comes last.
func mbSettleFusion(b *metamodel.Bundle, m *metamodel.Model, fm *metamodel.FlattenMap) {
	var cycles []int // positions of the cycle warnings
	for i, w := range fm.Warnings {
		if w.Code == metamodel.WarnEventLinkCycle {
			cycles = append(cycles, i)
		}
	}
	if len(cycles) == 0 {
		return
	}
	classes := mbEventClasses(b, fm)
	byName := map[string][]int{}
	var fused []int
	for i, c := range classes {
		byName[c.flat] = append(byName[c.flat], i)
		if len(c.members) > 1 {
			fused = append(fused, i)
		}
	}
	if len(fused) != len(cycles) {
		// Not the classes go-pflow formed (it should not happen): keep its
		// warnings, in an order that does not depend on the map.
		sort.SliceStable(fm.Warnings[cycles[0]:cycles[0]+len(cycles)], func(i, j int) bool {
			return fm.Warnings[cycles[0]+i].Message < fm.Warnings[cycles[0]+j].Message
		})
		return
	}
	// the cycle warnings, one per fused class, in class order, where go-pflow had them
	rebuilt := make([]metamodel.ValidationError, 0, len(fused)+len(fm.Warnings)-len(cycles))
	rebuilt = append(rebuilt, fm.Warnings[:cycles[0]]...)
	for _, i := range fused {
		c := classes[i]
		rebuilt = append(rebuilt, metamodel.ValidationError{
			Code:    metamodel.WarnEventLinkCycle,
			Message: fmt.Sprintf("transitions %s fire as one", strings.Join(c.members, ", ")),
			Element: c.flat,
		})
	}
	for i := cycles[0]; i < len(fm.Warnings); i++ {
		if fm.Warnings[i].Code != metamodel.WarnEventLinkCycle {
			rebuilt = append(rebuilt, fm.Warnings[i])
		}
	}
	fm.Warnings = rebuilt

	// a name two classes share
	for name, idxs := range byName {
		if len(idxs) < 2 {
			continue
		}
		for k := len(idxs) - 1; k >= 0; k-- {
			if c := classes[idxs[k]]; len(c.members) > 1 {
				fm.FusedGroups[name] = c.members
				break
			}
		}
		last := classes[idxs[len(idxs)-1]]
		for i := range m.Transitions {
			if m.Transitions[i].ID == name {
				m.Transitions[i].Description = mbFusionDescription(b, last)
				break
			}
		}
	}
}

// mbFusionDescription is the description of the flat transition a class makes:
// the members' own descriptions, then "fires with: <members>" for a fused class.
func mbFusionDescription(b *metamodel.Bundle, c mbEventClass) string {
	var descs []string
	for _, p := range c.parts {
		if s := b.SubnetByID(p[0]); s != nil && s.Model != nil {
			if t := s.Model.TransitionByID(p[1]); t != nil && t.Description != "" {
				descs = append(descs, t.Description)
			}
		}
	}
	if len(c.members) == 1 {
		return strings.Join(descs, "")
	}
	note := "fires with: " + strings.Join(c.members, ", ")
	if len(descs) == 0 {
		return note
	}
	return strings.Join(descs, " \u2297 ") + " (" + note + ")"
}
