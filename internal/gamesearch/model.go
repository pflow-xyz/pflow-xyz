package gamesearch

import (
	"math"
	"math/bits"
	"sort"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

// Indexed is a metamodel.Model's firing rule resolved to indices once: a
// port of pflow-metamodel's indexed.rs. A transition keeps its arcs as
// (place index, weight), and a marking is a dense []int64 in Places order.
//
// It applies the four rules arc by arc: a consuming arc needs at least
// weight tokens; a read arc needs at least weight and consumes none; an
// inhibitor arc blocks at weight or more; a capacity bounds the place after
// firing, net of what the same firing consumes from it. A negative weight
// makes a transition never enabled.
type Indexed struct {
	// Places are the token place ids in declaration order (the first of any
	// repeated id): the order of a dense marking.
	Places []string
	// Transitions are the transition ids in declaration order.
	Transitions []string

	arcs []arcs
	// conds is, per place, (transition, condition) for every condition on it.
	conds [][]placeCond
	// touched is, per transition, the places its firing changes.
	touched [][]int
}

type pw struct {
	p int
	w int64
}

type capacity struct {
	p      int
	add    int64
	bounds int64
}

type arcs struct {
	inputs, outputs, reads, inhibitors []pw
	// capacities are (place, net increase, capacity) for each capacity a
	// firing raises.
	capacities []capacity
	// invalid is a negative weight on any arc: never enabled.
	invalid bool
}

type condKind int

const (
	atLeast condKind = iota // a consuming or read arc: at least w
	below                   // an inhibitor arc: fewer than w
	capped                  // a capacity: count + w stays within bound
)

type cond struct {
	kind condKind
	w    int64
	cap  int64
}

type placeCond struct {
	t int
	c cond
}

func satAdd(a, b int64) int64 {
	c := a + b
	if (c > a) == (b > 0) {
		return c
	}
	if b > 0 {
		return math.MaxInt64
	}
	return math.MinInt64
}

func satSub(a, b int64) int64 {
	if b == math.MinInt64 {
		if a < 0 {
			return a - b
		}
		return math.MaxInt64
	}
	return satAdd(a, -b)
}

func (c cond) holds(v int64) bool {
	switch c.kind {
	case atLeast:
		return v >= c.w
	case below:
		return v < c.w
	default:
		return satAdd(v, c.w) <= c.cap
	}
}

func effectiveWeight(a *metamodel.Arc) int64 {
	if a.Weight == 0 {
		return 1
	}
	return int64(a.Weight)
}

// NewIndexed resolves m's firing rule to indices.
func NewIndexed(m *metamodel.Model) *Indexed {
	ix := &Indexed{}
	index := map[string]int{}
	byID := map[string]*metamodel.Place{}
	for i := range m.Places {
		p := &m.Places[i]
		if _, ok := byID[p.ID]; !ok {
			byID[p.ID] = p
		}
		if !p.IsToken() {
			continue
		}
		if _, ok := index[p.ID]; !ok {
			index[p.ID] = len(ix.Places)
			ix.Places = append(ix.Places, p.ID)
		}
	}
	place := func(id string) (int, bool) {
		p, ok := byID[id]
		if !ok || !p.IsToken() {
			return 0, false
		}
		i, ok := index[id]
		return i, ok
	}
	for ti := range m.Transitions {
		t := &m.Transitions[ti]
		ix.Transitions = append(ix.Transitions, t.ID)
		var a arcs
		for ai := range m.Arcs {
			arc := &m.Arcs[ai]
			w := effectiveWeight(arc)
			if arc.To == t.ID {
				p, ok := place(arc.From)
				if !ok {
					continue
				}
				if w < 0 {
					a.invalid = true
				}
				switch {
				case arc.IsInhibitor():
					a.inhibitors = append(a.inhibitors, pw{p, w})
				case arc.IsRead():
					a.reads = append(a.reads, pw{p, w})
				default:
					a.inputs = append(a.inputs, pw{p, w})
				}
			} else if arc.From == t.ID && !arc.IsReadOnly() {
				if p, ok := place(arc.To); ok {
					if w < 0 {
						a.invalid = true
					}
					a.outputs = append(a.outputs, pw{p, w})
				}
			}
		}
		net := map[int]int64{}
		for _, x := range a.inputs {
			net[x.p] = satSub(net[x.p], x.w)
		}
		for _, x := range a.outputs {
			net[x.p] = satAdd(net[x.p], x.w)
		}
		for pi := range m.Places {
			p := &m.Places[pi]
			if p.Capacity <= 0 || !p.IsToken() {
				continue
			}
			i, ok := index[p.ID]
			if !ok {
				continue
			}
			if d, ok := net[i]; ok && d > 0 {
				a.capacities = append(a.capacities, capacity{i, d, int64(p.Capacity)})
			}
		}
		ix.arcs = append(ix.arcs, a)
	}
	ix.conds = make([][]placeCond, len(ix.Places))
	for u := range ix.arcs {
		a := &ix.arcs[u]
		// An invalid transition is never enabled; its conditions never
		// matter.
		if a.invalid {
			continue
		}
		for _, x := range a.inputs {
			ix.conds[x.p] = append(ix.conds[x.p], placeCond{u, cond{kind: atLeast, w: x.w}})
		}
		for _, x := range a.reads {
			ix.conds[x.p] = append(ix.conds[x.p], placeCond{u, cond{kind: atLeast, w: x.w}})
		}
		for _, x := range a.inhibitors {
			ix.conds[x.p] = append(ix.conds[x.p], placeCond{u, cond{kind: below, w: x.w}})
		}
		for _, x := range a.capacities {
			ix.conds[x.p] = append(ix.conds[x.p], placeCond{u, cond{kind: capped, w: x.add, cap: x.bounds}})
		}
	}
	for i := range ix.arcs {
		a := &ix.arcs[i]
		var ps []int
		for _, x := range a.inputs {
			ps = append(ps, x.p)
		}
		for _, x := range a.outputs {
			ps = append(ps, x.p)
		}
		sort.Ints(ps)
		out := ps[:0]
		for j, p := range ps {
			if j == 0 || p != ps[j-1] {
				out = append(out, p)
			}
		}
		ix.touched = append(ix.touched, out)
	}
	return ix
}

// Dense is a marking over Places, from a map by place id.
func (ix *Indexed) Dense(m map[string]int64) []int64 {
	out := make([]int64, len(ix.Places))
	for i, p := range ix.Places {
		out[i] = m[p]
	}
	return out
}

// Enabled reports whether transition t can fire at mk.
func (ix *Indexed) Enabled(t int, mk []int64) bool {
	a := &ix.arcs[t]
	if a.invalid {
		return false
	}
	for _, x := range a.inputs {
		if mk[x.p] < x.w {
			return false
		}
	}
	for _, x := range a.reads {
		if mk[x.p] < x.w {
			return false
		}
	}
	for _, x := range a.inhibitors {
		if mk[x.p] >= x.w {
			return false
		}
	}
	for _, x := range a.capacities {
		if satAdd(mk[x.p], x.add) > x.bounds {
			return false
		}
	}
	return true
}

// deficit is how many tokens transition t is short of enabled at mk
// (math.MaxUint64 for a transition never enabled).
func (ix *Indexed) deficit(t int, mk []int64) uint64 {
	a := &ix.arcs[t]
	if a.invalid {
		return math.MaxUint64
	}
	short := func(x int64) uint64 {
		if x < 0 {
			return 0
		}
		return uint64(x)
	}
	sat := func(d, x uint64) uint64 {
		if d > math.MaxUint64-x {
			return math.MaxUint64
		}
		return d + x
	}
	var d uint64
	for _, x := range a.inputs {
		d = sat(d, short(satSub(x.w, mk[x.p])))
	}
	for _, x := range a.reads {
		d = sat(d, short(satSub(x.w, mk[x.p])))
	}
	for _, x := range a.inhibitors {
		d = sat(d, short(satAdd(satSub(mk[x.p], x.w), 1)))
	}
	for _, x := range a.capacities {
		d = sat(d, short(satSub(satAdd(mk[x.p], x.add), x.bounds)))
	}
	return d
}

// EnabledTransitions are the transitions enabled at mk, in index order.
func (ix *Indexed) EnabledTransitions(mk []int64) []int {
	var out []int
	for t := range ix.arcs {
		if ix.Enabled(t, mk) {
			out = append(out, t)
		}
	}
	return out
}

func (ix *Indexed) fireInPlace(t int, mk []int64) {
	a := &ix.arcs[t]
	for _, x := range a.inputs {
		mk[x.p] = satSub(mk[x.p], x.w)
	}
	for _, x := range a.outputs {
		mk[x.p] = satAdd(mk[x.p], x.w)
	}
}

func (ix *Indexed) fire(t int, mk []int64) []int64 {
	next := append([]int64(nil), mk...)
	ix.fireInPlace(t, next)
	return next
}

// tset is a set of transitions by index, as words.
type tset []uint64

func newTset(n int) tset { return make(tset, (n+63)/64) }

func (s tset) set(t int, on bool) {
	w, b := t/64, uint64(1)<<(t%64)
	if on {
		s[w] |= b
	} else {
		s[w] &^= b
	}
}

func (s tset) contains(t int) bool { return s[t/64]>>(t%64)&1 == 1 }

func (s tset) empty() bool {
	for _, w := range s {
		if w != 0 {
			return false
		}
	}
	return true
}

// firstIn is the first transition, in index order, in both sets.
func (s tset) firstIn(o tset) int {
	for i := range s {
		if w := s[i] & o[i]; w != 0 {
			return i*64 + bits.TrailingZeros64(w)
		}
	}
	return -1
}

// each calls f with the transitions in the set, in index order.
func (s tset) each(f func(t int)) {
	for i, w := range s {
		for w != 0 {
			f(i*64 + bits.TrailingZeros64(w))
			w &= w - 1
		}
	}
}

func (ix *Indexed) setOf(ts func(t int) bool) tset {
	s := newTset(len(ix.arcs))
	for t := range ix.arcs {
		if ts(t) {
			s.set(t, true)
		}
	}
	return s
}

// enabledState keeps, per transition, how many of its conditions the
// marking fails, and the set of those failing none.
type enabledState struct {
	set     tset
	failing []uint32
}

func (e enabledState) clone() enabledState {
	return enabledState{
		set:     append(tset(nil), e.set...),
		failing: append([]uint32(nil), e.failing...),
	}
}

func b2u(b bool) uint32 {
	if b {
		return 1
	}
	return 0
}

func (ix *Indexed) enabledSet(mk []int64) enabledState {
	n := len(ix.arcs)
	failing := make([]uint32, n)
	for t := range ix.arcs {
		failing[t] = b2u(ix.arcs[t].invalid)
	}
	for p, cs := range ix.conds {
		for _, pc := range cs {
			failing[pc.t] += b2u(!pc.c.holds(mk[p]))
		}
	}
	set := newTset(n)
	for t := 0; t < n; t++ {
		if failing[t] == 0 {
			set.set(t, true)
		}
	}
	return enabledState{set: set, failing: failing}
}

// fireTracked fires t in place and keeps en current: only the conditions on
// the places t touches are re-evaluated.
func (ix *Indexed) fireTracked(t int, mk []int64, en *enabledState) {
	touched := ix.touched[t]
	for _, p := range touched {
		for _, pc := range ix.conds[p] {
			en.failing[pc.t] -= b2u(!pc.c.holds(mk[p]))
		}
	}
	ix.fireInPlace(t, mk)
	for _, p := range touched {
		for _, pc := range ix.conds[p] {
			en.failing[pc.t] += b2u(!pc.c.holds(mk[p]))
			en.set.set(pc.t, en.failing[pc.t] == 0)
		}
	}
}
