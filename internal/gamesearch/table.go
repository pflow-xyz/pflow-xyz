package gamesearch

import (
	"math"
	"math/bits"
)

// The transposition table: a port of pflow-metamodel's memo.rs, line for
// line. Node counts depend on it (which entry a full bucket gives up, when
// the table doubles), so its layout, hash and replacement rule are the
// Rust ones, not merely something that remembers.
//
// An entry is a run of words in one slice: the key (kw words), then a meta
// word (best move, the bounds, the work that found them, and when), then,
// when the rewards are too many to index, the two bounds. Beside the
// entries one byte per slot holds seven bits of the key's hash (zero when
// empty). Entries sit in buckets of four, and a key may sit in either of the
// two its hash picks.

const (
	tableWays  = 4
	keyWords   = 4
	tableStart = 1024
	dictMax    = 255

	bestMask  = 0xFFFF_FFFF
	loShift   = 32
	hiShift   = 40
	workShift = 48
	genShift  = 56
	genMask   = 0x7F
	pinnedGen = 0
	countsBit = uint64(1) << 63

	// noMove is "no best move known".
	noMove = uint32(math.MaxUint32)
)

// key is a table key: kw words of a bit marking, or of a hash for counts,
// the rest zero.
type key [keyWords]uint64

// entry is what a table holds for a position: its value lies in [lo, hi]
// (equal when exact), and best did best.
type entry struct {
	lo, hi float64
	best   uint32
}

type table struct {
	kw         int
	compact    bool
	stride     int
	slots      []uint64
	tags       []uint8
	buckets    int
	most       int
	ways       int
	len        int
	generation uint64
	dict       []uint64
}

func mix(k *key) uint64 {
	h := k[0]*0x9E37_79B9_7F4A_7C15 ^
		bits.RotateLeft64(k[1]*0xC2B2_AE3D_27D4_EB4F, 21) ^
		bits.RotateLeft64(k[2]*0x1656_67B1_9E37_79F9, 42) ^
		k[3]*0xFF51_AFD7_ED55_8CCD
	h ^= h >> 29
	h *= 0xBF58_476D_1CE4_E5B9
	return h ^ h>>32
}

type probe struct {
	buckets [2]int
	tag     uint8
}

// newTable is a table of at most entries, comparing kw words of key.
func newTable(entries, kw int, compact bool) *table {
	if entries < 1 {
		entries = 1
	}
	ways := tableWays
	if entries < ways {
		ways = entries
	}
	most := entries / ways
	buckets := tableStart / ways
	if most < buckets {
		buckets = most
	}
	if buckets < 1 {
		buckets = 1
	}
	stride := kw + 3
	if compact {
		stride = kw + 1
	}
	return &table{
		kw:         kw,
		compact:    compact,
		stride:     stride,
		slots:      make([]uint64, buckets*ways*stride),
		tags:       make([]uint8, buckets*ways),
		buckets:    buckets,
		most:       most,
		ways:       ways,
		generation: 1,
	}
}

// Len is the entries held.
func (t *table) Len() int { return t.len }

// age makes entries from here on newer than those before, which a new key
// replaces first.
func (t *table) age() { t.generation = t.generation%genMask + 1 }

func (t *table) probe(k *key) probe {
	h := mix(k)
	h2 := bits.RotateLeft64(h, 32) * 0x94D0_49BB_1331_11EB
	var p probe
	for i, x := range [2]uint64{h, h2} {
		hi, _ := bits.Mul64(x, uint64(t.buckets))
		p.buckets[i] = int(hi) * t.ways
	}
	p.tag = uint8(h2>>57) | 0x80
	return p
}

func (t *table) meta(i int) uint64 { return t.slots[i*t.stride+t.kw] }

func engineBit(counts bool) uint64 {
	if counts {
		return countsBit
	}
	return 0
}

func (t *table) holds(i int, k *key, engine uint64) bool {
	s := t.slots[i*t.stride : i*t.stride+t.kw+1]
	for j := 0; j < t.kw; j++ {
		if s[j] != k[j] {
			return false
		}
	}
	return s[t.kw]&countsBit == engine
}

// locate finds the slot holding k (found), or else the one k would take: an
// empty slot of its buckets, or failing that the weakest, an entry of an
// earlier age first, then the one found with the least work. Only a store
// needs the second; a lookup passes choose false and gets slot 0 for a key
// not held.
func (t *table) locate(k *key, counts, choose bool) (slot int, found bool) {
	p := t.probe(k)
	engine := engineBit(counts)
	for _, b := range p.buckets {
		room := -1
		for j := 0; j < t.ways; j++ {
			tag := t.tags[b+j]
			if tag == p.tag && t.holds(b+j, k, engine) {
				return b + j, true
			}
			if tag == 0 && room < 0 {
				room = b + j
			}
		}
		if room >= 0 {
			return room, false
		}
	}
	if !choose {
		return 0, false
	}
	rank := func(i int) uint64 {
		m := t.meta(i)
		gen := m >> genShift & genMask
		if gen == pinnedGen {
			return math.MaxUint64
		}
		var cur uint64
		if gen == t.generation {
			cur = 1
		}
		return cur<<8 | (m >> workShift & 0xFF)
	}
	best, bestRank := -1, uint64(0)
	for _, b := range p.buckets {
		for i := b; i < b+t.ways; i++ {
			if r := rank(i); best < 0 || r < bestRank {
				best, bestRank = i, r
			}
		}
	}
	return best, false
}

func (t *table) get(k *key, counts bool) (entry, bool) {
	i, ok := t.locate(k, counts, false)
	if !ok {
		return entry{}, false
	}
	return t.read(i), true
}

func (t *table) read(i int) entry {
	s := t.slots[i*t.stride : (i+1)*t.stride]
	meta := s[t.kw]
	var lo, hi float64
	if t.compact {
		at := func(shift uint) float64 { return math.Float64frombits(t.dict[meta>>shift&0xFF]) }
		lo, hi = at(loShift), at(hiShift)
	} else {
		lo, hi = math.Float64frombits(s[t.kw+1]), math.Float64frombits(s[t.kw+2])
	}
	return entry{lo: lo, hi: hi, best: uint32(meta & bestMask)}
}

// index is the position of bound x in the dictionary, added if new and
// there is room.
func (t *table) index(x float64) (uint64, bool) {
	b := math.Float64bits(x)
	for i, d := range t.dict {
		if d == b {
			return uint64(i), true
		}
	}
	if len(t.dict) < dictMax {
		t.dict = append(t.dict, b)
		return uint64(len(t.dict) - 1), true
	}
	return 0, false
}

// store remembers e for k, found by nodes nodes of search, narrowed by what
// the table knew of k before.
func (t *table) store(k *key, counts bool, e entry, nodes int) {
	work := uint64(bits.Len64(uint64(nodes)))
	t.keep(k, counts, e, work, t.generation)
}

// pin remembers that k is worth exactly value, best doing best (noMove for
// none known), pinned: a new key takes its slot only when all the slots it
// could take are pinned.
func (t *table) pin(k *key, counts bool, value float64, best uint32) {
	t.keep(k, counts, entry{lo: value, hi: value, best: best}, 0xFF, pinnedGen)
}

func (t *table) keep(k *key, counts bool, e entry, work, gen uint64) {
	at, found := t.locate(k, counts, true)
	if found {
		old := t.read(at)
		e.lo = math.Max(e.lo, old.lo)
		e.hi = math.Min(e.hi, old.hi)
		if gen == pinnedGen && e.best == bestMask {
			e.best = old.best
		}
		m := t.meta(at)
		if w := m >> workShift & 0xFF; w > work {
			work = w
		}
		if m>>genShift&genMask == pinnedGen {
			gen = pinnedGen
		}
	}
	meta := uint64(e.best) | work<<workShift | gen<<genShift | engineBit(counts)
	var wide [2]uint64
	if t.compact {
		lo, okLo := t.index(e.lo)
		hi, okHi := t.index(e.hi)
		if !okLo || !okHi {
			// More distinct bounds than a byte indexes: not kept.
			return
		}
		meta |= lo<<loShift | hi<<hiShift
	} else {
		wide = [2]uint64{math.Float64bits(e.lo), math.Float64bits(e.hi)}
	}
	// Both buckets full: room is wanted, if the table may still grow.
	for !found {
		if t.tags[at] == 0 || t.buckets == t.most || t.len*4 < t.buckets*t.ways {
			break
		}
		t.grow()
		at, found = t.locate(k, counts, true)
	}
	t.put(at, k, meta, wide)
}

func (t *table) put(i int, k *key, meta uint64, wide [2]uint64) {
	if t.tags[i] == 0 {
		t.len++
	}
	t.tags[i] = t.probe(k).tag
	s := t.slots[i*t.stride : (i+1)*t.stride]
	copy(s[:t.kw], k[:t.kw])
	s[t.kw] = meta
	if !t.compact {
		s[t.kw+1], s[t.kw+2] = wide[0], wide[1]
	}
}

// grow doubles the buckets, up to the limit, and moves every entry over.
func (t *table) grow() {
	old, tags := t.slots, t.tags
	t.buckets *= 2
	if t.buckets > t.most {
		t.buckets = t.most
	}
	t.slots = make([]uint64, t.buckets*t.ways*t.stride)
	t.tags = make([]uint8, t.buckets*t.ways)
	t.len = 0
	for i := 0; i < len(tags); i++ {
		if tags[i] == 0 {
			continue
		}
		s := old[i*t.stride : (i+1)*t.stride]
		meta := s[t.kw]
		var k key
		copy(k[:t.kw], s[:t.kw])
		var wide [2]uint64
		if !t.compact {
			wide = [2]uint64{s[t.kw+1], s[t.kw+2]}
		}
		at, _ := t.locate(&k, meta&countsBit != 0, true)
		t.put(at, &k, meta, wide)
	}
}
