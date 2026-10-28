package gamesearch

import "fmt"

// The pieces a plan picks: move order (order.rs) and filters (filter.rs).

// maxPieces is the most pieces a chain holds.
const maxPieces = 8

// Piece is a move-order piece, by name: one sort key per move, larger is
// tried sooner.
type Piece int

const (
	TtBest Piece = iota
	ImmediateWin
	History
	Centrality
	Threats
)

// PieceNames are the names ParsePiece takes.
var PieceNames = []string{"tt_best", "immediate_win", "history", "centrality", "threats"}

// ParsePiece is the piece called name.
func ParsePiece(name string) (Piece, error) {
	for i, n := range PieceNames {
		if n == name {
			return Piece(i), nil
		}
	}
	return 0, fmt.Errorf("unknown order piece %q (known: %s)", name, rustStrList(PieceNames))
}

// Name is the name ParsePiece takes for the piece.
func (p Piece) Name() string { return PieceNames[p] }

// needsGoals reports whether the piece reads the net's goals.
func (p Piece) needsGoals() bool { return p == Centrality || p == Threats }

// decisive reports whether a nonzero key settles the move's rank: the
// pieces after it do not sort it further.
func (p Piece) decisive() bool { return p == TtBest || p == ImmediateWin }

// ctx is what a piece may read when it ranks move t.
type ctx struct {
	g       *Game
	mover   float64
	first   uint32
	history []uint32
}

func (p Piece) key(cx *ctx, t int, next *walk) (uint64, error) {
	switch p {
	case TtBest:
		return b2u64(uint32(t) == cx.first), nil
	case ImmediateWin:
		if !next.over(cx.g) {
			return 0, nil
		}
		s, err := next.score(cx.g)
		if err != nil {
			return 0, err
		}
		return b2u64(cx.mover*s > 0), nil
	case History:
		return uint64(cx.history[t]), nil
	case Centrality:
		return uint64(cx.g.centrality[t]), nil
	default: // Threats
		var n uint64
		for _, i := range cx.g.fed[t] {
			if next.deficit(cx.g, cx.g.goals[i].t) == 1 {
				n++
			}
		}
		return n, nil
	}
}

func b2u64(b bool) uint64 {
	if b {
		return 1
	}
	return 0
}

// Chain is pieces in order of priority: a move's keys are compared piece by
// piece (up to a decisive piece's nonzero key), and ties keep the net's own
// order of the moves.
type Chain struct{ pieces []Piece }

// DefaultChain is the remembered best move, then a winning one, then by
// history.
func DefaultChain() Chain { return Chain{[]Piece{TtBest, ImmediateWin, History}} }

// NewChain is a chain of pieces, highest priority first.
func NewChain(pieces []Piece) (Chain, error) {
	if len(pieces) > maxPieces {
		return Chain{}, fmt.Errorf("an order chain holds at most %d pieces, not %d", maxPieces, len(pieces))
	}
	return Chain{append([]Piece(nil), pieces...)}, nil
}

// check refuses a chain that g cannot run: a piece that reads goals, when
// the net declares none (no automatic transition pays a reward).
func (c Chain) check(g *Game) error {
	for _, p := range c.pieces {
		if p.needsGoals() {
			if len(g.goals) == 0 {
				return fmt.Errorf("order piece %q reads the net's goals, but no automatic transition pays a reward place", p.Name())
			}
			return nil
		}
	}
	return nil
}

type orderKey [maxPieces]uint64

func (c Chain) key(cx *ctx, t int, next *walk) (orderKey, error) {
	var k orderKey
	for i, p := range c.pieces {
		v, err := p.key(cx, t, next)
		if err != nil {
			return k, err
		}
		k[i] = v
		if v != 0 && p.decisive() {
			break
		}
	}
	return k, nil
}

// before reports whether move a is tried sooner than b: a's keys are
// greater, compared piece by piece.
func (c Chain) before(a, b *orderKey) bool {
	for i := range c.pieces {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

// tied reports whether neither is tried sooner.
func (c Chain) tied(a, b *orderKey) bool { return !c.before(a, b) && !c.before(b, a) }

func (c Chain) cutoff(history []uint32, t int) {
	for _, p := range c.pieces {
		if p == History {
			history[t]++
		}
	}
}

// Filter is a move filter, by name: pieces that drop moves, or settle a
// position at once, only where the value is already known.
type Filter int

const (
	MustWin Filter = iota
	NonLosing
)

// FilterNames are the names ParseFilter takes.
var FilterNames = []string{"must_win", "non_losing"}

// DefaultFilters are the filters a solver runs unless told otherwise.
var DefaultFilters = []Filter{MustWin}

// ParseFilter is the filter called name.
func ParseFilter(name string) (Filter, error) {
	for i, n := range FilterNames {
		if n == name {
			return Filter(i), nil
		}
	}
	return 0, fmt.Errorf("unknown filter %q (known: %s)", name, rustStrList(FilterNames))
}

// Name is the name ParseFilter takes for the filter.
func (f Filter) Name() string { return FilterNames[f] }

type filters struct{ mustWin, nonLosing bool }

func filtersOf(fs []Filter) filters {
	var out filters
	for _, f := range fs {
		switch f {
		case MustWin:
			out.mustWin = true
		case NonLosing:
			out.nonLosing = true
		}
	}
	return out
}

// bound is the best bound for side s.
func (f filters) bound(g *Game, s float64) float64 {
	if s > 0 {
		return g.Bounds[1]
	}
	return g.Bounds[0]
}

// best reports whether next is final at side s's best bound.
func (f filters) best(g *Game, s float64, next *walk) (bool, error) {
	if !next.over(g) {
		return false, nil
	}
	x, err := next.score(g)
	if err != nil {
		return false, err
	}
	return x == f.bound(g, s), nil
}

type tri int

const (
	triFalse tri = iota
	triTrue
	triSpill // the engine cannot hold a reply's result
)

// lost reports whether, after a move of side s, the other side is to move
// at next and has a reply ending the game at s's worst bound.
//
// With goals declared, only replies that can bring a goal of the other side
// from its deficit at next to enabled in one firing are played, and none
// when no goal is that close.
func (f filters) lost(g *Game, s float64, next *walk) (tri, error) {
	replies := next.moves(g, make([]int, 0, 8))
	if len(replies) == 0 {
		return triFalse, nil
	}
	m, err := g.Mover(replies)
	if err != nil {
		return triFalse, err
	}
	if m != -s {
		return triFalse, nil
	}
	wins := func(u int) (tri, error) {
		after := next.clone()
		ok, err := after.play(g, u)
		if err != nil {
			return triFalse, err
		}
		if !ok {
			return triSpill, nil
		}
		b, err := f.best(g, -s, after)
		if err != nil {
			return triFalse, err
		}
		if b {
			return triTrue, nil
		}
		return triFalse, nil
	}
	if len(g.goals) == 0 {
		for _, u := range replies {
			r, err := wins(u)
			if err != nil || r != triFalse {
				return r, err
			}
		}
		return triFalse, nil
	}
	var tried []uint32
	for i, goal := range g.goals {
		if goal.side != -s {
			continue
		}
		d := next.deficit(g, goal.t)
		if d > g.reach[i] {
			continue
		}
		for _, fd := range g.feeders[i] {
			if fd.touch < d || !next.has(int(fd.u)) || containsU32(tried, fd.u) {
				continue
			}
			tried = append(tried, fd.u)
			r, err := wins(int(fd.u))
			if err != nil || r != triFalse {
				return r, err
			}
		}
	}
	return triFalse, nil
}

func containsU32(xs []uint32, x uint32) bool {
	for _, y := range xs {
		if y == x {
			return true
		}
	}
	return false
}
