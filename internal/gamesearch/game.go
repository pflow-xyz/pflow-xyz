package gamesearch

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
)

// A Game reads a net as a two-sided game: a port of pflow-metamodel's
// game.rs (the Game type; the search is in solver.go).
//
// auto transitions fire as soon as they are enabled (a win detector, a
// cleanup step), lowest index first, until none is: the marking is then
// settled. Every other transition is a move, and sign says whose: +1 for
// the side maximizing the reward, -1 for the other. At a settled marking
// the side to move is the one every enabled move belongs to, and a marking
// with no move is final, worth the reward read from it: reward weights per
// place, each place holding at most one token at the end.

// inline is the most words of places, and of transitions, the bit engine
// keeps inline (256 of each).
const inline = 4

// maxValues is the most reward places, and distinct rewards, worth
// searching value by value; past either, a search takes the whole range at
// once.
const maxValues = 16

// settleLimit is how long settling may run before the automatic
// transitions count as never stopping.
const settleLimit = 10_000

func errEndless() error { return fmt.Errorf("automatic transitions never stop firing") }

// Reward is one place of the reward and its weight.
type Reward struct {
	Place  int
	Weight float64
}

type goal struct {
	t    int
	side float64
}

type feeder struct {
	u     uint32
	touch uint64
}

// bitCond is what the bit engine needs of a place for a transition to be
// enabled: set (one) or clear.
type bitCond struct {
	p   int
	one bool
}

// Game is a two-sided game on a net, over dense markings in Places order.
type Game struct {
	Ix *Indexed
	// Auto is, per transition: fires as soon as it is enabled.
	Auto []bool
	// Sign is, per transition, the side that chooses it (+1 maximizes the
	// reward).
	Sign []float64
	// Reward is read from a final marking.
	Reward []Reward
	// Bounds are the least and greatest reward a final marking can have
	// (each reward place holding 0 or 1 tokens).
	Bounds [2]float64

	autoSet, moveSet tset
	goals            []goal
	fed              [][]uint32
	centrality       []uint32
	feeders          [][]feeder
	reach            []uint64
	// values is every reward a final marking can have, ascending, when
	// there are few: the values a search decides between.
	values []float64

	// The bit engine, which applies when the net has at most 256 places and
	// 256 transitions and a marking's counts are all 0 or 1.
	bitsFit  bool
	bitsReq  [][]bitCond
	bitsNone []bool
}

// totalLess is f64::total_cmp's order.
func totalCmp(a, b float64) int {
	x, y := int64(math.Float64bits(a)), int64(math.Float64bits(b))
	x ^= int64(uint64(x>>63) >> 1)
	y ^= int64(uint64(y>>63) >> 1)
	switch {
	case x < y:
		return -1
	case x > y:
		return 1
	}
	return 0
}

// rewards are the distinct sums of some of weights, ascending, or none past
// maxValues.
func rewards(weights []float64) []float64 {
	if len(weights) > maxValues {
		return nil
	}
	sums := []float64{0}
	for _, w := range weights {
		for _, x := range append([]float64(nil), sums...) {
			sums = append(sums, x+w)
		}
		sort.SliceStable(sums, func(i, j int) bool { return totalCmp(sums[i], sums[j]) < 0 })
		out := sums[:1]
		for _, x := range sums[1:] {
			if math.Abs(x-out[len(out)-1]) >= 1e-9 {
				out = append(out, x)
			}
		}
		sums = out
		if len(sums) > maxValues {
			return nil
		}
	}
	return sums
}

// NewGame is a game over ix.
func NewGame(ix *Indexed, auto []bool, sign []float64, reward []Reward) *Game {
	n := len(auto)
	g := &Game{Ix: ix, Auto: auto, Sign: sign, Reward: reward}
	g.autoSet = ix.setOf(func(t int) bool { return auto[t] })
	g.moveSet = ix.setOf(func(t int) bool { return !auto[t] })
	for _, r := range reward {
		g.Bounds[0] += math.Min(r.Weight, 0)
		g.Bounds[1] += math.Max(r.Weight, 0)
	}
	g.goals = goalsOf(ix, auto, reward)
	g.fed = fedGoals(ix, g.goals, sign)
	g.feeders = touches(ix, auto, sign, g.goals)
	for _, f := range g.feeders {
		var m uint64
		for _, x := range f {
			if x.touch > m {
				m = x.touch
			}
		}
		g.reach = append(g.reach, m)
	}
	for _, f := range g.fed {
		g.centrality = append(g.centrality, uint32(len(f)))
	}
	ws := make([]float64, len(reward))
	for i, r := range reward {
		ws[i] = r.Weight
	}
	g.values = rewards(ws)
	g.bitsFit = len(ix.Places) <= 64*inline && n <= 64*inline
	g.buildBits()
	return g
}

// goalsOf are the automatic transitions whose outputs pay a net reward.
func goalsOf(ix *Indexed, auto []bool, reward []Reward) []goal {
	var out []goal
	for t := range auto {
		if !auto[t] {
			continue
		}
		var paid float64
		for _, o := range ix.arcs[t].outputs {
			var r float64
			for _, x := range reward {
				if x.Place == o.p {
					r += x.Weight
				}
			}
			paid += r * float64(o.w)
		}
		if paid != 0 {
			side := 1.0
			if paid < 0 {
				side = -1
			}
			out = append(out, goal{t, side})
		}
	}
	return out
}

// fedGoals are, per transition, the goals (indices) of its own side that
// its output places feed, a goal being fed by a place it takes or reads
// from. A place every goal of the side needs says nothing of where to play
// and does not count.
func fedGoals(ix *Indexed, goals []goal, sign []float64) [][]uint32 {
	fed := func(g goal, p int) bool {
		a := &ix.arcs[g.t]
		for _, x := range a.inputs {
			if x.p == p {
				return true
			}
		}
		for _, x := range a.reads {
			if x.p == p {
				return true
			}
		}
		return false
	}
	out := make([][]uint32, len(sign))
	for t := range sign {
		var mine []int
		for i, g := range goals {
			if g.side == sign[t] {
				mine = append(mine, i)
			}
		}
		hit := make([]bool, len(mine))
		for _, o := range ix.arcs[t].outputs {
			all := true
			for _, i := range mine {
				if !fed(goals[i], o.p) {
					all = false
					break
				}
			}
			if all {
				continue
			}
			for j, i := range mine {
				hit[j] = hit[j] || fed(goals[i], o.p)
			}
		}
		for j, i := range mine {
			if hit[j] {
				out[t] = append(out[t], uint32(i))
			}
		}
	}
	return out
}

// touches are, for each goal, the moves u of its side with touch(u) > 0,
// where touch(u) sums |delta u(p)| over the goal's conditions (each input,
// read, inhibitor and capacity on a place p).
func touches(ix *Indexed, auto []bool, sign []float64, goals []goal) [][]feeder {
	delta := func(u, p int) int64 {
		at := func(xs []pw) int64 {
			var s int64
			for _, x := range xs {
				if x.p == p {
					s += x.w
				}
			}
			return s
		}
		return at(ix.arcs[u].outputs) - at(ix.arcs[u].inputs)
	}
	out := make([][]feeder, len(goals))
	for gi, g := range goals {
		a := &ix.arcs[g.t]
		var places []int
		for _, x := range a.inputs {
			places = append(places, x.p)
		}
		for _, x := range a.reads {
			places = append(places, x.p)
		}
		for _, x := range a.inhibitors {
			places = append(places, x.p)
		}
		for _, x := range a.capacities {
			places = append(places, x.p)
		}
		for u := range auto {
			if auto[u] || sign[u] != g.side {
				continue
			}
			var touch uint64
			for _, p := range places {
				d := delta(u, p)
				if d < 0 {
					d = -d
				}
				touch += uint64(d)
			}
			if touch > 0 {
				out[gi] = append(out[gi], feeder{uint32(u), touch})
			}
		}
	}
	return out
}

// buildBits resolves, per transition, what the bit engine needs of each
// place it looks at (BitModel::bits in bits.rs), for the deficit it counts.
func (g *Game) buildBits() {
	ix := g.Ix
	g.bitsReq = make([][]bitCond, len(ix.arcs))
	g.bitsNone = make([]bool, len(ix.arcs))
	for t := range ix.arcs {
		a := &ix.arcs[t]
		one, zero := map[int]bool{}, map[int]bool{}
		no := a.invalid
		need := func(p int, holdsAt [2]bool) {
			switch holdsAt {
			case [2]bool{true, true}:
			case [2]bool{false, true}:
				one[p] = true
			case [2]bool{true, false}:
				zero[p] = true
			default:
				no = true
			}
		}
		for _, x := range append(append([]pw(nil), a.inputs...), a.reads...) {
			need(x.p, [2]bool{0 >= x.w, 1 >= x.w})
		}
		for _, x := range a.inhibitors {
			need(x.p, [2]bool{0 < x.w, 1 < x.w})
		}
		for _, x := range a.capacities {
			need(x.p, [2]bool{x.add <= x.bounds, satAdd(x.add, 1) <= x.bounds})
		}
		for p := range one {
			if zero[p] {
				no = true
			}
		}
		var care []int
		for p := range one {
			care = append(care, p)
		}
		for p := range zero {
			if !one[p] {
				care = append(care, p)
			}
		}
		sort.Ints(care)
		for _, p := range care {
			g.bitsReq[t] = append(g.bitsReq[t], bitCond{p, one[p]})
		}
		g.bitsNone[t] = no
	}
}

// settle fires automatic transitions, lowest index first, until none is
// enabled.
func (g *Game) settle(mk []int64) error {
	for i := 0; i < settleLimit; i++ {
		t := -1
		for u := range g.Auto {
			if g.Auto[u] && g.Ix.Enabled(u, mk) {
				t = u
				break
			}
		}
		if t < 0 {
			return nil
		}
		g.Ix.fireInPlace(t, mk)
	}
	return errEndless()
}

// Settle fires the automatic transitions at mk until none is enabled.
func (g *Game) Settle(mk []int64) error { return g.settle(mk) }

// Moves are the moves at a settled marking.
func (g *Game) Moves(mk []int64) []int { return g.Ix.EnabledTransitions(mk) }

// Score is the reward of a final marking.
func (g *Game) Score(mk []int64) (float64, error) {
	var s float64
	for _, r := range g.Reward {
		s += r.Weight * float64(mk[r.Place])
	}
	return g.check(s)
}

// rustF64 prints x as Rust's Display does: shortest round-trip digits,
// never an exponent.
func rustF64(x float64) string {
	if math.IsNaN(x) {
		return "NaN"
	}
	if math.IsInf(x, 1) {
		return "inf"
	}
	if math.IsInf(x, -1) {
		return "-inf"
	}
	return strconv.FormatFloat(x, 'f', -1, 64)
}

// rustDebugF64 prints x as Rust's Debug does: Display, but with a fraction
// part (1.0, not 1).
func rustDebugF64(x float64) string {
	s := rustF64(x)
	if !strings.ContainsAny(s, ".IN") {
		s += ".0"
	}
	return s
}

func (g *Game) check(x float64) (float64, error) {
	if x < g.Bounds[0] || x > g.Bounds[1] {
		return 0, fmt.Errorf("a final marking scores %s, outside the reward's assumed range (%s, %s) (each reward place ending with at most one token)",
			rustF64(x), rustDebugF64(g.Bounds[0]), rustDebugF64(g.Bounds[1]))
	}
	return x, nil
}

// rustStrList prints names as Rust's {:?} of a Vec<&str>.
func rustStrList(names []string) string {
	q := make([]string, len(names))
	for i, n := range names {
		q[i] = strconv.Quote(n)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

// Mover is the side to move at a settled marking with moves moves.
func (g *Game) Mover(moves []int) (float64, error) {
	s := g.Sign[moves[0]]
	mixed := s == 0
	for _, t := range moves {
		if g.Sign[t] != s {
			mixed = true
		}
	}
	if mixed {
		names := make([]string, len(moves))
		for i, t := range moves {
			names[i] = g.Ix.Transitions[t]
		}
		return 0, fmt.Errorf("the enabled moves %s do not all belong to one side", rustStrList(names))
	}
	return s, nil
}

// play is the settled marking after move t.
func (g *Game) play(mk []int64, t int) ([]int64, error) {
	next := g.Ix.fire(t, mk)
	if err := g.settle(next); err != nil {
		return nil, err
	}
	return next, nil
}

// bitMarking is mk as bits, or false if some count is not 0 or 1 (or the
// net does not fit the bit engine).
func (g *Game) bitMarking(mk []int64) (key, bool) {
	var k key
	if !g.bitsFit {
		return k, false
	}
	for p, v := range mk {
		switch v {
		case 0:
		case 1:
			k[p/64] |= 1 << (p % 64)
		default:
			return k, false
		}
	}
	return k, true
}

// bitsDeficit is how many of transition t's conditions the 0/1 marking mk
// fails: the places among those it looks at that are not what it needs.
func (g *Game) bitsDeficit(t int, mk []int64) uint64 {
	if g.bitsNone[t] {
		return math.MaxUint64
	}
	var d uint64
	for _, c := range g.bitsReq[t] {
		if (mk[c.p] == 1) != c.one {
			d++
		}
	}
	return d
}
