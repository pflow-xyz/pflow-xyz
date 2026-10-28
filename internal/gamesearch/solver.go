package gamesearch

import (
	"math"
	"sort"
)

// The search: a port of pflow-metamodel's Solver (game.rs). Alpha-beta over
// the firing rule, one position at a time, with a node budget.
//
// A value is exact. Past its budget a search returns no value, never a
// guess; only Choose in play mode guesses.
//
// Rewards a final marking can have are few in most games (win, draw, loss),
// so a value is found as a run of yes/no searches, one per gap between
// adjacent rewards ("is it above this one?"), each with a window that
// narrow. They share one transposition table, bounded and persisting across
// calls, and a chain of order pieces orders the moves.

// DefaultMemo is the entries the table holds at most when a solver is
// given no size: 2^23.
const DefaultMemo = 1 << 23

// Options are what a plan makes of a solver.
type Options struct {
	// Budget is the node budget; 0 means none.
	Budget int
	Chain  Chain
	// Filters drop moves where the value is known (see DefaultFilters).
	Filters []Filter
	// NullWindow and MtdF find a value by yes/no searches.
	NullWindow, MtdF bool
	// RootNonLosing drops the root's moves that leave the other side a win
	// at once.
	RootNonLosing bool
	// Play lets Choose guess when the budget runs out.
	Play bool
	// Memo is the table's entries; 0 means DefaultMemo.
	Memo int
	// Cancel, when set, is called every 1,024 nodes; an error stops the
	// search and is returned.
	Cancel func() error
}

// Choice is the move Choose picks.
type Choice struct {
	// T is the move.
	T int
	// Value is the position's exact value (+1 side's view), when the search
	// found it.
	Value *float64
	// Exact reports whether T is a best move: always, outside play mode.
	Exact bool
}

type ranked struct {
	order []int
	rank  []uint64
}

// Solver is alpha-beta with a transposition table that persists across
// calls and a Chain of pieces for move order. One per goroutine.
type Solver struct {
	g       *Game
	chain   Chain
	filters filters
	tt      *table
	history []uint32
	nodes   int
	budget  int
	spilled bool

	nullWindow, mtdF bool
	rootNonLosing    bool
	ranked           *ranked
	play             bool
	cancel           func() error
}

func (g *Game) newTable(entries int) *table {
	kw := 2
	if g.bitsFit {
		words := (len(g.Ix.Places) + 63) / 64
		if words > kw {
			kw = words
		}
	}
	return newTable(entries, kw, len(g.values) > 0)
}

// NewSolver is a solver for g, refused when a piece of the chain needs what
// the net does not declare.
func NewSolver(g *Game, o Options) (*Solver, error) {
	if err := o.Chain.check(g); err != nil {
		return nil, err
	}
	memo := o.Memo
	if memo == 0 {
		memo = DefaultMemo
	}
	budget := o.Budget
	if budget <= 0 {
		budget = math.MaxInt
	}
	return &Solver{
		g:             g,
		chain:         o.Chain,
		filters:       filtersOf(o.Filters),
		tt:            g.newTable(memo),
		history:       make([]uint32, len(g.Ix.Transitions)),
		budget:        budget,
		nullWindow:    o.NullWindow,
		mtdF:          o.MtdF,
		rootNonLosing: o.RootNonLosing,
		play:          o.Play,
		cancel:        o.Cancel,
	}, nil
}

// Nodes are the nodes the last Value or Choose searched.
func (s *Solver) Nodes() int { return s.nodes }

// MemoLen is the entries the table holds now.
func (s *Solver) MemoLen() int { return s.tt.Len() }

// keyAt is the table's key for settled marking mk, and whether it is a
// counts key: as the search keys it, by bits when it fits.
func (s *Solver) keyAt(mk []int64) (key, bool) {
	if k, ok := s.g.bitMarking(mk); ok {
		return k, false
	}
	h := rehash(mk)
	return key{h[0], h[1], 0, 0}, true
}

// Book is exact values of positions, kept in a solver's table ahead of any
// search.
type Book struct {
	entries []bookEntry
}

type bookEntry struct {
	mk    []int64
	value float64
	best  int // -1 when unknown
}

// Len is the positions recorded.
func (b *Book) Len() int { return len(b.entries) }

// Add records that settled position mk is worth exactly value (+1 side's
// view), best doing best when known (-1 otherwise).
func (b *Book) Add(mk []int64, value float64, best int) {
	b.entries = append(b.entries, bookEntry{mk, value, best})
}

// WithBook pins book's positions in the table, exact.
func (s *Solver) WithBook(book *Book) {
	for _, e := range book.entries {
		k, counts := s.keyAt(e.mk)
		best := noMove
		if e.best >= 0 {
			best = uint32(e.best)
		}
		s.tt.pin(&k, counts, e.value, best)
	}
}

// rank runs the root's pieces at mk, or nil when none runs or there is no
// move.
func (s *Solver) rank(mk []int64) (*ranked, error) {
	g := s.g
	moves := g.Moves(mk)
	if !s.rootNonLosing || len(moves) == 0 {
		return nil, nil
	}
	sd, err := g.Mover(moves)
	if err != nil {
		return nil, err
	}
	type kept struct {
		guess float64
		t     int
	}
	var ks []kept
	for _, t := range moves {
		next, err := g.play(mk, t)
		if err != nil {
			return nil, err
		}
		w := newCounts(g, next)
		lost, err := s.filters.lost(g, sd, w)
		if err != nil {
			return nil, err
		}
		if lost == triTrue {
			continue
		}
		// No estimate is ported: every move guesses 0.
		ks = append(ks, kept{sd * 0.0, t})
	}
	// Stable: ties keep the net's order.
	sort.SliceStable(ks, func(i, j int) bool { return totalCmp(ks[j].guess, ks[i].guess) < 0 })
	r := &ranked{rank: make([]uint64, len(g.Ix.Transitions))}
	for i, k := range ks {
		r.rank[k.t] = uint64(len(ks) - i)
		r.order = append(r.order, k.t)
	}
	return r, nil
}

// Value is the exact value (+1 side's view) of a settled position with both
// sides playing perfectly, or ok false past the budget.
func (s *Solver) Value(mk []int64) (v float64, ok bool, err error) {
	s.start()
	r, err := s.rank(mk)
	if err != nil {
		return 0, false, err
	}
	return s.run(mk, r)
}

// Choose is a move at settled position mk: a best one and the position's
// value, found within the budget (for the whole call), or nil when there is
// no move or the budget runs out first. In play mode a budget that runs out
// gives a guess instead: the table's best move at mk if it has one, else
// the first the root's pieces rank.
func (s *Solver) Choose(mk []int64) (*Choice, error) {
	g := s.g
	s.start()
	moves := g.Moves(mk)
	if len(moves) == 0 {
		s.nodes = 0
		return nil, nil
	}
	sd, err := g.Mover(moves)
	if err != nil {
		return nil, err
	}
	r, err := s.rank(mk)
	if err != nil {
		return nil, err
	}
	order := moves
	if r != nil {
		order = r.order
	}
	if len(order) == 0 {
		// Every move leaves the other side a win: any is as good.
		s.nodes = 1
		v := s.filters.bound(g, -sd)
		return &Choice{T: moves[0], Value: &v, Exact: true}, nil
	}
	limit := s.budget
	v, vok, err := s.run(mk, r)
	if err != nil {
		return nil, err
	}
	total := s.nodes
	k, counts := s.keyAt(mk)
	known := -1
	if e, ok := s.tt.get(&k, counts); ok {
		for _, t := range order {
			if t == int(e.best) {
				known = t
			}
		}
	}
	found := -1
	if vok {
		cands := order
		if known >= 0 {
			cands = append([]int{known}, order...)
		}
	search:
		for _, t := range cands {
			next, err := g.play(mk, t)
			if err != nil {
				return nil, err
			}
			var x float64
			var xok bool
			if len(g.Moves(next)) == 0 {
				x, err = g.Score(next)
				if err != nil {
					return nil, err
				}
				xok = true
			} else {
				if limit > total {
					s.budget = limit - total
				} else {
					s.budget = 0
				}
				x, xok, err = s.run(next, nil)
				if err != nil {
					return nil, err
				}
				total += s.nodes
			}
			switch {
			case xok && x == v:
				found = t
				break search
			case xok:
			default:
				break search
			}
		}
	}
	s.budget = limit
	s.nodes = total
	switch {
	case found >= 0:
		return &Choice{T: found, Value: valuePtr(v, vok), Exact: true}, nil
	case s.play:
		t := order[0]
		if known >= 0 {
			t = known
		}
		return &Choice{T: t, Value: valuePtr(v, vok), Exact: false}, nil
	}
	return nil, nil
}

func valuePtr(v float64, ok bool) *float64 {
	if !ok {
		return nil
	}
	return &v
}

// start is a call's start: the table ages.
func (s *Solver) start() { s.tt.age() }

// run is the value at mk, with r the root's pieces there (or none).
func (s *Solver) run(mk []int64, r *ranked) (float64, bool, error) {
	g := s.g
	s.ranked = r
	if r != nil && len(r.order) == 0 {
		// non_losing dropped every move: each leaves the other side a win.
		s.nodes = 1
		sd, err := g.Mover(g.Moves(mk))
		if err != nil {
			return 0, false, err
		}
		return s.filters.bound(g, -sd), true, nil
	}
	if k, ok := g.bitMarking(mk); ok {
		w := newBits(g, mk, k)
		s.nodes = 0
		s.spilled = false
		v, vok, err := s.solve(w)
		if err != nil {
			return 0, false, err
		}
		if !s.spilled {
			return v, vok, nil
		}
	}
	s.nodes = 0
	return s.solve(newCounts(g, mk))
}

// solve is the value at w as a run of yes/no searches, one per gap between
// adjacent rewards, starting from the mover's worst, and going on the way
// the answers point. With too many rewards to step through, one search over
// the whole range.
func (s *Solver) solve(w *walk) (float64, bool, error) {
	g := s.g
	vals := g.values
	lo, hi := g.Bounds[0], g.Bounds[1]
	if len(vals) < 3 || !(s.nullWindow || s.mtdF) {
		return s.search(w, lo, hi, true)
	}
	moves := w.moves(g, nil)
	if len(moves) == 0 {
		v, err := w.score(g)
		return v, err == nil, err
	}
	sd, err := g.Mover(moves)
	if err != nil {
		return 0, false, err
	}
	gaps := len(vals) - 1
	if s.mtdF {
		return s.mtdFRun(w)
	}
	var k int
	if sd > 0 {
		k = 0
	} else {
		k = gaps - 1
	}
	// The value is one of vals[i..=j].
	i, j := 0, gaps
	for {
		a, b := vals[k], vals[k+1]
		v, ok, err := s.search(w, a, b, true)
		if err != nil || !ok {
			return 0, false, err
		}
		up := v > (a+b)/2.0
		if up {
			i = k + 1
		} else {
			j = k
		}
		if i >= j {
			return vals[i], true, nil
		}
		if up {
			k = i
		} else {
			k = j - 1
		}
	}
}

// partitionPoint is the first index of vals where pred is false, pred
// holding for a prefix (slice::partition_point).
func partitionPoint(vals []float64, pred func(float64) bool) int {
	return sort.Search(len(vals), func(i int) bool { return !pred(vals[i]) })
}

// mtdFRun is the value at w by MTD(f) over the gaps between adjacent
// rewards. The value is one of vals[i..=j]; a test between vals[k] and
// vals[k+1] fails high or low, and fail-soft says by how much, so the bound
// it proves can pass several rewards at once.
func (s *Solver) mtdFRun(w *walk) (float64, bool, error) {
	const eps = 1e-9
	g := s.g
	vals := g.values
	gaps := len(vals) - 1
	i, j := 0, gaps
	k0 := w.key()
	if e, ok := s.tt.get(&k0, !w.bit); ok {
		i = partitionPoint(vals, func(x float64) bool { return x < e.lo-eps })
		if i > gaps {
			i = gaps
		}
		j = partitionPoint(vals, func(x float64) bool { return x <= e.hi+eps })
		if j < 1 {
			j = 1
		}
		if j > gaps+1 {
			j = gaps + 1
		}
		j--
	}
	// No estimate is ported, so there is no guess to start from: f is none
	// and each test bisects the gaps left.
	for i < j {
		k := i + (j-i-1)/2
		a, b := vals[k], vals[k+1]
		v, ok, err := s.search(w, a, b, true)
		if err != nil || !ok {
			return 0, false, err
		}
		if v >= b {
			p := partitionPoint(vals, func(x float64) bool { return x < v-eps })
			if p > j {
				p = j
			}
			if p > i {
				i = p
			}
		} else {
			p := partitionPoint(vals, func(x float64) bool { return x <= v+eps })
			if p < 1 {
				p = 1
			}
			p--
			if p < j {
				j = p
			}
			if j < i {
				j = i
			}
		}
	}
	return vals[i], true, nil
}

type kid struct {
	key  orderKey
	t    int
	next *walk
}

// search is fail-soft alpha-beta in the +1 side's view. Inside the bounds
// every result is a bound on the true value; with the window the whole
// range, it is the value. root when w is the position Value was given,
// where the root's pieces run.
func (s *Solver) search(w *walk, a, b float64, root bool) (float64, bool, error) {
	s.nodes++
	if s.nodes > s.budget {
		return 0, false, nil
	}
	if s.cancel != nil && s.nodes&1023 == 0 {
		if err := s.cancel(); err != nil {
			return 0, false, err
		}
	}
	g := s.g
	n0 := s.nodes
	k := w.key()
	counts := !w.bit
	first := noMove
	if e, ok := s.tt.get(&k, counts); ok {
		if e.lo == e.hi || e.lo >= b {
			return e.lo, true, nil
		}
		if e.hi <= a {
			return e.hi, true, nil
		}
		a = math.Max(a, e.lo)
		b = math.Min(b, e.hi)
		first = e.best
	}
	moves := w.moves(g, make([]int, 0, 8))
	if len(moves) == 0 {
		x, err := w.score(g)
		if err != nil {
			return 0, false, err
		}
		s.store(&k, counts, x, x, noMove, 1)
		return x, true, nil
	}
	sd, err := g.Mover(moves)
	if err != nil {
		return 0, false, err
	}
	f := s.filters
	// Children, best first, as the order chain ranks them.
	cx := ctx{g: g, mover: sd, first: first, history: s.history}
	kids := make([]kid, 0, len(moves))
	for _, t := range moves {
		next := w.clone()
		ok, err := next.play(g, t)
		if err != nil {
			return 0, false, err
		}
		if !ok {
			s.spilled = true
			return 0, false, nil
		}
		if f.mustWin {
			best, err := f.best(g, sd, next)
			if err != nil {
				return 0, false, err
			}
			if best {
				// The cutoff the winning move would have made.
				s.chain.cutoff(s.history, t)
				x := f.bound(g, sd)
				s.store(&k, counts, x, x, uint32(t), s.nodes-n0)
				return x, true, nil
			}
		}
		ok2, err := s.chain.key(&cx, t, next)
		if err != nil {
			return 0, false, err
		}
		kids = append(kids, kid{ok2, t, next})
	}
	if f.nonLosing {
		keep := make([]kid, 0, len(kids))
		for _, kd := range kids {
			lost, err := f.lost(g, sd, kd.next)
			if err != nil {
				return 0, false, err
			}
			switch lost {
			case triSpill:
				s.spilled = true
				return 0, false, nil
			case triFalse:
				keep = append(keep, kd)
			}
		}
		if len(keep) == 0 {
			x := f.bound(g, -sd)
			s.store(&k, counts, x, x, noMove, s.nodes-n0)
			return x, true, nil
		}
		kids = keep
	}
	if r := s.ranked; r != nil && root {
		keep := kids[:0]
		for _, kd := range kids {
			if r.rank[kd.t] > 0 {
				keep = append(keep, kd)
			}
		}
		kids = keep
		sort.SliceStable(kids, func(i, j int) bool {
			x, y := &kids[i], &kids[j]
			if s.chain.before(&x.key, &y.key) {
				return true
			}
			return s.chain.tied(&x.key, &y.key) && r.rank[y.t] < r.rank[x.t]
		})
	} else {
		sort.SliceStable(kids, func(i, j int) bool { return s.chain.before(&kids[i].key, &kids[j].key) })
	}
	a0, b0 := a, b
	best := math.Inf(-1)
	if sd <= 0 {
		best = math.Inf(1)
	}
	bestMove := noMove
	for _, kd := range kids {
		v, ok, err := s.search(kd.next, a, b, false)
		if err != nil || !ok {
			return 0, false, err
		}
		if (sd > 0 && v > best) || (sd < 0 && v < best) {
			best, bestMove = v, uint32(kd.t)
		}
		if sd > 0 {
			a = math.Max(a, v)
		} else {
			b = math.Min(b, v)
		}
		if a >= b {
			s.chain.cutoff(s.history, kd.t)
			break
		}
	}
	v := best
	var lo, hi float64
	switch {
	case v <= a0:
		lo, hi = g.Bounds[0], v
	case v >= b0:
		lo, hi = v, g.Bounds[1]
	default:
		lo, hi = v, v
	}
	// Merged with what was known before this search narrowed the window.
	s.store(&k, counts, lo, hi, bestMove, s.nodes-n0)
	return v, true, nil
}

// store remembers that the value at k lies in [lo, hi] (and in what the
// table knew of it), best doing best, found by nodes nodes.
func (s *Solver) store(k *key, counts bool, lo, hi float64, best uint32, nodes int) {
	s.tt.store(k, counts, entry{lo, hi, best}, nodes)
}
