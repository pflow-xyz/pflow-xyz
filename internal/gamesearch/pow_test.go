package gamesearch

import (
	"math"
	"math/big"
	"math/rand"
	"testing"
)

// powReference is x^y rounded once from a 192-bit evaluation of exp(y ln x)
// with math/big: slow, and written apart from pow's double-double, so each
// checks the other.
func powReference(x, y float64) float64 {
	const prec = 192
	bf := func(v float64) *big.Float { return new(big.Float).SetPrec(prec).SetFloat64(v) }
	atanh := func(z *big.Float) *big.Float {
		sum := new(big.Float).SetPrec(prec).Set(z)
		z2 := new(big.Float).SetPrec(prec).Mul(z, z)
		term := new(big.Float).SetPrec(prec).Set(z)
		for k := int64(3); k < 400; k += 2 {
			term.Mul(term, z2)
			sum.Add(sum, new(big.Float).SetPrec(prec).Quo(term, new(big.Float).SetPrec(prec).SetInt64(k)))
		}
		return sum
	}
	ln2 := atanh(new(big.Float).SetPrec(prec).Quo(bf(1), bf(3)))
	ln2.Mul(ln2, bf(2))
	m, e := math.Frexp(x)
	z := new(big.Float).SetPrec(prec).Quo(new(big.Float).SetPrec(prec).Sub(bf(m), bf(1)), new(big.Float).SetPrec(prec).Add(bf(m), bf(1)))
	l := atanh(z)
	l.Mul(l, bf(2))
	l.Add(l, new(big.Float).SetPrec(prec).Mul(ln2, bf(float64(e))))
	l.Mul(l, bf(y))
	q := new(big.Float).SetPrec(prec).Quo(l, ln2)
	qf, _ := q.Float64()
	k := math.Round(qf)
	r := new(big.Float).SetPrec(prec).Sub(l, new(big.Float).SetPrec(prec).Mul(ln2, bf(k)))
	r.SetMantExp(r, -8)
	sum, term := bf(1), bf(1)
	for n := int64(1); n < 60; n++ {
		term.Mul(term, r)
		term.Quo(term, new(big.Float).SetPrec(prec).SetInt64(n))
		sum.Add(sum, term)
	}
	for i := 0; i < 8; i++ {
		sum.Mul(sum, sum)
	}
	sum.SetMantExp(sum, int(k))
	out, _ := sum.Float64()
	return out
}

// pow agrees with the correctly rounded value on every input tried, where
// math.Pow does not.
func TestPowMatchesTheBigFloatReference(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	ys := []float64{1.0 / 6.0, 0.1, 0.5, 2, 3.7, -0.25, 1.0 / 3.0, 7.5}
	mathPowWrong := 0
	for i := 0; i < 3000; i++ {
		x := math.Exp(rng.Float64()*60 - 30)
		y := ys[i%len(ys)]
		got, want := pow(x, y), powReference(x, y)
		if got != want {
			t.Fatalf("pow(%v, %v) = %v, want %v", x, y, got, want)
		}
		if math.Pow(x, y) != want {
			mathPowWrong++
		}
	}
	if mathPowWrong == 0 {
		t.Error("math.Pow was right every time: this test shows nothing")
	}
}
