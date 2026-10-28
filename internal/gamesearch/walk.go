package gamesearch

import "math/bits"

// A walk is a settled marking the search plays moves from, with the enabled
// set kept current. pflow-metamodel has two engines, a bit marking (a few
// words, when every count is 0 or 1 and the net is small) and counts; they
// agree on every marking the bit engine holds, and differ in three ways
// this port keeps:
//
//   - the table key is the marking's bits, or a 128-bit Zobrist hash;
//   - a firing that would leave a place outside 0/1 is refused by the bit
//     engine ("spills"), and the search starts again by counts;
//   - a transition's deficit is the number of places it is short on, not
//     the number of tokens.
//
// One struct plays both: bit says which.
type walk struct {
	mk   []int64
	en   enabledState
	hash [2]uint64 // counts: the Zobrist hash, high and low words
	bits key       // bit engine: the marking
	bit  bool
}

// splitmix64's mixing step.
func smix(x uint64) uint64 {
	x += 0x9E37_79B9_7F4A_7C15
	x = (x ^ x>>30) * 0xBF58_476D_1CE4_E5B9
	x = (x ^ x>>27) * 0x94D0_49BB_1331_11EB
	return x ^ x>>31
}

// zobrist is the key of place p holding c tokens: 128 bits fixed by the
// pair alone, so no table is kept and a count has no ceiling.
func zobrist(p int, c int64) [2]uint64 {
	a := smix(smix(uint64(p)^0xD6E8_FEB8_6659_FD93) + uint64(c))
	b := smix(a ^ 0xA076_1D64_78BD_642F ^ bits.RotateLeft64(uint64(p), 32))
	return [2]uint64{a, b}
}

// rehash is the hash of a whole marking: the XOR of the keys of its places'
// counts.
func rehash(mk []int64) [2]uint64 {
	var h [2]uint64
	for p, c := range mk {
		z := zobrist(p, c)
		h[0] ^= z[0]
		h[1] ^= z[1]
	}
	return h
}

func newCounts(g *Game, mk []int64) *walk {
	m := append([]int64(nil), mk...)
	return &walk{mk: m, en: g.Ix.enabledSet(m), hash: rehash(m)}
}

func newBits(g *Game, mk []int64, k key) *walk {
	m := append([]int64(nil), mk...)
	return &walk{mk: m, en: g.Ix.enabledSet(m), bits: k, bit: true}
}

func (w *walk) clone() *walk {
	c := *w
	c.mk = append([]int64(nil), w.mk...)
	c.en = w.en.clone()
	return &c
}

// fire fires t, XORing the keys of the places it changes out at their old
// counts and in at their new ones; over bits, setting and clearing them.
func (w *walk) fire(g *Game, t int) {
	touched := g.Ix.touched[t]
	if !w.bit {
		for _, p := range touched {
			z := zobrist(p, w.mk[p])
			w.hash[0] ^= z[0]
			w.hash[1] ^= z[1]
		}
	}
	g.Ix.fireTracked(t, w.mk, &w.en)
	for _, p := range touched {
		if w.bit {
			if w.mk[p] == 1 {
				w.bits[p/64] |= 1 << (p % 64)
			} else {
				w.bits[p/64] &^= 1 << (p % 64)
			}
		} else {
			z := zobrist(p, w.mk[p])
			w.hash[0] ^= z[0]
			w.hash[1] ^= z[1]
		}
	}
}

// spills reports whether the firing of t left a place outside 0/1.
func (w *walk) spills(g *Game, t int) bool {
	for _, p := range g.Ix.touched[t] {
		if w.mk[p] != 0 && w.mk[p] != 1 {
			return true
		}
	}
	return false
}

// moves appends the moves here to out.
func (w *walk) moves(g *Game, out []int) []int {
	for i, word := range w.en.set {
		if w.bit {
			word &= g.moveSet[i]
		}
		for word != 0 {
			out = append(out, i*64+bits.TrailingZeros64(word))
			word &= word - 1
		}
	}
	return out
}

// over reports whether no move is enabled.
func (w *walk) over(g *Game) bool {
	for i, word := range w.en.set {
		if w.bit {
			word &= g.moveSet[i]
		}
		if word != 0 {
			return false
		}
	}
	return true
}

func (w *walk) has(t int) bool { return w.en.set.contains(t) }

// play plays move t and settles. False when the bit engine cannot represent
// the result, which leaves w meaning nothing.
func (w *walk) play(g *Game, t int) (bool, error) {
	w.fire(g, t)
	if w.bit && w.spills(g, t) {
		return false, nil
	}
	for i := 0; i < settleLimit; i++ {
		u := w.en.set.firstIn(g.autoSet)
		if u < 0 {
			return true, nil
		}
		w.fire(g, u)
		if w.bit && w.spills(g, u) {
			return false, nil
		}
	}
	return false, errEndless()
}

func (w *walk) score(g *Game) (float64, error) {
	if !w.bit {
		return g.Score(w.mk)
	}
	var s float64
	for _, r := range g.Reward {
		if w.mk[r.Place] == 1 {
			s += r.Weight
		}
	}
	return g.check(s)
}

func (w *walk) deficit(g *Game, t int) uint64 {
	if w.bit {
		return g.bitsDeficit(t, w.mk)
	}
	return g.Ix.deficit(t, w.mk)
}

// key is the transposition table's key: the marking's words over bits, a
// 128-bit hash of it over counts.
func (w *walk) key() key {
	if w.bit {
		return w.bits
	}
	return key{w.hash[0], w.hash[1], 0, 0}
}
