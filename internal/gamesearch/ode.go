package gamesearch

import "math"

// The root estimate "ode": a port of pflow_solver::game::OdeEstimate (pflow-rs
// crates/pflow-solver/src/game.rs) with the adaptive Tsitouras 5(4) loop it
// runs (crates/pflow-solver/src/ode.rs, integrate_vec).
//
// From a position, every transition fires continuously at rate 1, both sides'
// moves and the automatic ones alike, for ODEHorizon model time, and the
// guess is the reward read off where the tokens end up. A transition's flux is
// the product of the tokens on its input and read places (mass action, weights
// left out of the product); it takes weight * flux from each input place and
// puts weight * flux on each output place, and a read arc only gates it.
// Inhibitors and capacities have no continuous form and are left out. A guess
// only orders the root's moves and picks where a run of yes/no searches
// starts, so a poor one costs nodes, never a value.
//
// The integrator is written out here rather than taken from go-pflow's solver
// package: that one builds a map-keyed net per solve and sums each place's flux
// terms in map order, which rounds differently from run to run, and it cannot
// express an arc list in which one place appears twice with its own weight.
// This one walks transitions in index order, as pflow-solver does, so the
// arithmetic is the same operation for operation. Every product that feeds a
// sum is wrapped in float64(...): the Go spec lets a compiler fuse x*y+z into
// one rounding (arm64 does), and an explicit conversion forbids that, which
// keeps the result the same on every machine.
//
// What can differ from pflow-native is math.Pow against the platform libm's
// pow, in the step controller. See docs/workbench-progress.md.

// ODEHorizon is the model time solved ahead, as pflow-native's ODE player.
const ODEHorizon = 3.0

// Estimate guesses the value (+1 side's view) of a settled position that has
// a move. Any number will do for the search's sake; one outside the game's
// bounds is read as the nearer bound.
type Estimate interface {
	Estimate(g *Game, mk []int64) (float64, error)
}

type flow struct {
	gates       []int
	takes, puts []pw
}

// OdeEstimate is the "ode" estimate of a game.
type OdeEstimate struct {
	flows   []flow
	places  int
	reward  []Reward
	horizon float64
	opts    odeOptions
	cancel  func() error
}

type odeOptions struct {
	dt, dtmin, dtmax, abstol, reltol float64
	maxiters                         int
}

// NewOdeEstimate is the estimate of g. cancel, when set, is called every 256
// steps of a solve; an error stops it.
func NewOdeEstimate(g *Game, cancel func() error) *OdeEstimate {
	ix := g.Ix
	flows := make([]flow, len(ix.Transitions))
	for t := range flows {
		a := &ix.arcs[t]
		var gates []int
		for _, x := range a.inputs {
			gates = append(gates, x.p)
		}
		for _, x := range a.reads {
			gates = append(gates, x.p)
		}
		flows[t] = flow{gates: gates, takes: a.inputs, puts: a.outputs}
	}
	return &OdeEstimate{
		flows:   flows,
		places:  len(ix.Places),
		reward:  g.Reward,
		horizon: ODEHorizon,
		opts:    odeOptionsFor(ODEHorizon),
		cancel:  cancel,
	}
}

// odeOptionsFor is pflow-native's: the default options, with at least 50
// steps over the horizon.
func odeOptionsFor(horizon float64) odeOptions {
	o := odeOptions{dt: 0.01, dtmin: 1e-6, dtmax: 0.1, abstol: 1e-6, reltol: 1e-3, maxiters: 100_000}
	o.dtmax = rmax(rmin(o.dtmax, horizon/50.0), o.dtmin)
	o.dt = rmin(o.dt, o.dtmax)
	return o
}

// rmin and rmax are f64::min and f64::max: a NaN gives way to the other.
func rmin(a, b float64) float64 {
	switch {
	case math.IsNaN(a):
		return b
	case math.IsNaN(b):
		return a
	case b < a:
		return b
	}
	return a
}

func rmax(a, b float64) float64 {
	switch {
	case math.IsNaN(a):
		return b
	case math.IsNaN(b):
		return a
	case b > a:
		return b
	}
	return a
}

// rate is du/dt at u, written into du.
func (e *OdeEstimate) rate(u, du []float64) {
	for i := range du {
		du[i] = 0
	}
	for i := range e.flows {
		f := &e.flows[i]
		flux := 1.0
		for _, p := range f.gates {
			if u[p] <= 0.0 {
				flux = 0.0
				break
			}
			flux *= u[p]
		}
		if flux > 0.0 {
			for _, x := range f.takes {
				du[x.p] -= float64(flux * float64(x.w))
			}
			for _, x := range f.puts {
				du[x.p] += float64(flux * float64(x.w))
			}
		}
	}
}

// Tsitouras 5/4, with the error-estimate weights b - b_hat.
var (
	tsitC = []float64{0.0, 0.161, 0.327, 0.9, 0.9800255409045097, 1.0, 1.0}
	tsitA = [][]float64{
		{},
		{0.161},
		{-0.008480655492356924, 0.335480655492357},
		{2.8971530571054935, -6.359448489975075, 4.362295432869581},
		{5.325864828439257, -11.748883564062828, 7.4955393428898365, -0.09249506636175525},
		{5.86145544294642, -12.92096931784711, 8.159367898576159, -0.071584973281401, -0.028269050394068383},
		{0.09646076681806523, 0.01, 0.4798896504144996, 1.379008574103742, -3.290069515436081, 2.324710524099774, 0.0},
	}
	tsitB    = []float64{0.09646076681806523, 0.01, 0.4798896504144996, 1.379008574103742, -3.290069515436081, 2.324710524099774, 0.0}
	tsitBHat = []float64{0.001780011052226, 0.000816434459657, -0.007880878010262, 0.144711007173263, -0.582357165452555, 0.458082105929187, -1.0 / 66.0}
)

const tsitOrder = 5

// FinalState is the state ODEHorizon ahead of marking mk.
func (e *OdeEstimate) FinalState(mk []int64) ([]float64, error) {
	n := len(mk)
	o := e.opts
	ucur := make([]float64, n)
	for i, v := range mk {
		ucur[i] = float64(v)
	}
	tcur, tf := 0.0, e.horizon
	dtcur := o.dt
	nsteps := 0
	stages := len(tsitC)
	k := make([][]float64, stages)
	for i := range k {
		k[i] = make([]float64, n)
	}
	ustage := make([]float64, n)
	unext := make([]float64, n)
	iter := 0
	for tcur < tf && nsteps < o.maxiters {
		if e.cancel != nil && iter&255 == 0 {
			if err := e.cancel(); err != nil {
				return nil, err
			}
		}
		iter++
		// Don't overshoot.
		if tcur+dtcur > tf {
			dtcur = tf - tcur
		}
		e.rate(ucur, k[0])
		for stage := 1; stage < stages; stage++ {
			copy(ustage, ucur)
			for j := 0; j < stage; j++ {
				aj := 0.0
				if stage < len(tsitA) && j < len(tsitA[stage]) {
					aj = tsitA[stage][j]
				}
				if aj != 0.0 {
					scale := dtcur * aj
					for i := 0; i < n; i++ {
						ustage[i] += float64(scale * k[j][i])
					}
				}
			}
			e.rate(ustage, k[stage])
		}
		copy(unext, ucur)
		for j := range tsitB {
			if tsitB[j] != 0.0 {
				scale := dtcur * tsitB[j]
				for i := 0; i < n; i++ {
					unext[i] += float64(scale * k[j][i])
				}
			}
		}
		// The error estimate.
		err := 0.0
		for i := 0; i < n; i++ {
			errest := 0.0
			for j := range tsitBHat {
				errest += float64(float64(dtcur*tsitBHat[j]) * k[j][i])
			}
			uc, un := ucur[i], unext[i]
			scale := o.abstol + float64(o.reltol*rmax(math.Abs(uc), math.Abs(un)))
			if scale == 0.0 {
				scale = o.abstol
			}
			if val := math.Abs(errest) / scale; val > err {
				err = val
			}
		}
		if err <= 1.0 || dtcur <= o.dtmin {
			tcur += dtcur
			ucur, unext = unext, ucur
			nsteps++
			if err > 0.0 {
				factor := 0.9 * pow(1.0/err, 1.0/(tsitOrder+1))
				factor = rmin(factor, 5.0)
				dtcur = rmin(o.dtmax, rmax(o.dtmin, dtcur*factor))
			}
		} else {
			factor := 0.9 * pow(1.0/err, 1.0/(tsitOrder+1))
			factor = rmax(factor, 0.1)
			dtcur = rmax(o.dtmin, dtcur*factor)
		}
	}
	return ucur, nil
}

// Estimate is the reward read off the state ODEHorizon ahead of mk.
func (e *OdeEstimate) Estimate(_ *Game, mk []int64) (float64, error) {
	u, err := e.FinalState(mk)
	if err != nil {
		return 0, err
	}
	// Iterator::sum of f64 starts at -0.0, so an empty sum is -0.0.
	sum := math.Copysign(0, -1)
	for _, r := range e.reward {
		sum += float64(r.Weight * u[r.Place])
	}
	return sum, nil
}
