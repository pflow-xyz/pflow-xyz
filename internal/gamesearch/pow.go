package gamesearch

import "math"

// pow is Rust's f64::powf for a positive finite base: x^y rounded once, to
// the nearest double, from a double-double (about 106 bit) evaluation of
// exp(y * ln x).
//
// Rust's powf is the platform libm's pow (glibc's, Apple's), each within
// about half an ulp of the exact result; Go's math.Pow multiplies and halves
// and is off by an ulp or more. The ODE estimate (ode.go) feeds the pow of
// its step controller into every later step, and a move's guess is the
// reward off the final state, so an ulp in one step moves the last digits of
// every guess. Those digits matter: tic-tac-toe's symmetric moves have equal
// guesses up to rounding, and the order they are tried in is decided by it.
// Rounding the exact value correctly is what the platform libms do in all but
// a rare case (a result within a few thousandths of an ulp of halfway), so
// this agrees with them, where math.Pow does not.
//
// Anything else (zero, a negative or non-finite base or exponent, a base or
// result near the ends of the range) is math.Pow's, which agrees with libm
// there.
func pow(x, y float64) float64 {
	if !(x >= 0x1p-1000 && x <= 0x1p1000) || math.IsNaN(y) || math.IsInf(y, 0) || y == 0 {
		return math.Pow(x, y)
	}
	t := ddMulF(ddLog(x), y)
	// Stay clear of overflow and the subnormals.
	if math.Abs(t.hi) > 700 {
		return math.Pow(x, y)
	}
	r := ddExp(t)
	if math.IsNaN(r.hi) || math.IsInf(r.hi, 0) || r.hi == 0 {
		return math.Pow(x, y)
	}
	return r.hi
}

// dd is hi + lo, with |lo| at most half an ulp of hi.
type dd struct{ hi, lo float64 }

func twoSum(a, b float64) (s, e float64) {
	s = a + b
	bb := s - a
	e = (a - (s - bb)) + (b - bb)
	return
}

func quickTwoSum(a, b float64) (s, e float64) {
	s = a + b
	e = b - (s - a)
	return
}

// twoProd is a*b exactly as p + e. math.FMA rounds once on every machine.
func twoProd(a, b float64) (p, e float64) {
	p = a * b
	e = math.FMA(a, b, -p)
	return
}

func ddAdd(x, y dd) dd {
	s, e := twoSum(x.hi, y.hi)
	t, f := twoSum(x.lo, y.lo)
	e += t
	s, e = quickTwoSum(s, e)
	e += f
	s, e = quickTwoSum(s, e)
	return dd{s, e}
}

func ddMul(x, y dd) dd {
	p, e := twoProd(x.hi, y.hi)
	e += x.hi*y.lo + x.lo*y.hi
	p, e = quickTwoSum(p, e)
	return dd{p, e}
}

func ddMulF(x dd, f float64) dd {
	p, e := twoProd(x.hi, f)
	e += x.lo * f
	p, e = quickTwoSum(p, e)
	return dd{p, e}
}

func ddNeg(x dd) dd { return dd{-x.hi, -x.lo} }

// ddDivF is x / f.
func ddDivF(x dd, f float64) dd {
	q1 := x.hi / f
	p, e := twoProd(q1, f)
	r := ddAdd(x, dd{-p, -e})
	q2 := r.hi / f
	p, e = twoProd(q2, f)
	r = ddAdd(r, dd{-p, -e})
	q3 := r.hi / f
	s, t := quickTwoSum(q1, q2)
	return ddAdd(dd{s, t}, dd{q3, 0})
}

// ln2 to 106 bits.
var ddLn2 = dd{0.6931471805599453, 2.3190468138462996e-17}

// ddInvFact is 1/n! for n = 0..13.
var ddInvFact = func() [14]dd {
	var t [14]dd
	t[0] = dd{1, 0}
	for n := 1; n < len(t); n++ {
		t[n] = ddDivF(t[n-1], float64(n))
	}
	return t
}()

// ddExp is exp(a) for |a.hi| below about 700.
func ddExp(a dd) dd {
	k := math.Round(a.hi / ddLn2.hi)
	r := ddAdd(a, ddNeg(ddMulF(ddLn2, k)))
	// exp(r) = exp(r / 256)^256, with |r / 256| below 0.0014.
	const halvings = 8
	r = dd{math.Ldexp(r.hi, -halvings), math.Ldexp(r.lo, -halvings)}
	s := ddInvFact[len(ddInvFact)-1]
	for n := len(ddInvFact) - 2; n >= 0; n-- {
		s = ddAdd(ddMul(s, r), ddInvFact[n])
	}
	for i := 0; i < halvings; i++ {
		s = ddMul(s, s)
	}
	return dd{math.Ldexp(s.hi, int(k)), math.Ldexp(s.lo, int(k))}
}

// ddLog is ln(x) for a positive finite double: math.Log, and one Newton step
// in double-double, y + (x exp(-y) - 1), whose error is about the square of
// math.Log's.
func ddLog(x float64) dd {
	y := math.Log(x)
	// x * exp(-y): scale x by 2^e first so the product stays near 1.
	m, e := math.Frexp(x)
	t := ddExp(dd{-y, 0})
	u := ddMulF(t, m)
	u = dd{math.Ldexp(u.hi, e), math.Ldexp(u.lo, e)}
	u = ddAdd(u, dd{-1, 0})
	// ln(1 + u) = u - u^2 / 2.
	u = ddAdd(u, ddNeg(ddMulF(ddMulF(u, u.hi), 0.5)))
	return ddAdd(dd{y, 0}, u)
}
