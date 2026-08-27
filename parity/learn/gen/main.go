// Command gen emits parity/learn/goldens.json: golden values for the JS/Go
// differentiable-fitting parity contract between go-pflow's learn package and
// public/petri-learn.js.
//
// For each case the generator runs go-pflow (the reference implementation)
// with solver.JSParityOptions() and records: the solved final state, the
// forward-sensitivity matrix at the final (and a mid) accepted step, MSE and
// relative-MSE loss+gradient at two fixed parameter points, the REVERSE-mode
// (adjoint) MSE loss+grad at the same two points via learn.MSELossAdjoint —
// packed with the same ParamIndex, so it compares directly against the
// forward-mode grad at that point — and the full Adam iterate sequence (every
// (theta, loss, grad) the optimizer evaluated) for a short fixed run. The
// decay case additionally records a Nelder-Mead call sequence and a
// learn.Fit result. public/petri-learn_test.ts replays all of it against
// petri-learn.js.
//
// Regenerate deliberately with `make learn-goldens` (never as a side effect
// of another target). The generator refuses to emit non-finite values, so a
// golden can never hide an Inf/NaN behind JSON.
//
// Determinism note: Go iterates maps in randomized order, so a place (or
// sensitivity row) that accumulates three or more flux terms from different
// transitions can differ between two Go runs in the last bit (float addition
// is commutative but not associative). The decay and tied cases are designed
// so no such sum exists — their goldens are bit-stable and the JS test
// asserts exact equality. The SIR case has one (place I), so its goldens
// carry last-bit jitter and the JS test asserts a tight relative tolerance
// instead; its Adam sequence is excluded (a last-bit difference can flip an
// adaptive-step acceptance and diverge macroscopically).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"os"

	"github.com/pflow-xyz/go-pflow/learn"
	"github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/go-pflow/solver"
)

// rateSpec declares one transition's rate function. Kind "scalar" is an
// independent learnable constant; kind "shared" ties every transition with
// the same Group to ONE parameter (learn.SharedScalar).
type rateSpec struct {
	Kind  string  `json:"kind"`
	Rate  float64 `json:"rate"`
	Group string  `json:"group,omitempty"`
}

type lossPoint struct {
	Loss float64   `json:"loss"`
	Grad []float64 `json:"grad"`
}

type fgCall struct {
	Theta []float64 `json:"theta"`
	Loss  float64   `json:"loss"`
	Grad  []float64 `json:"grad"`
}

type fCall struct {
	Theta []float64 `json:"theta"`
	Value float64   `json:"value"`
}

type optResult struct {
	Params      []float64 `json:"params"`
	InitialLoss float64   `json:"initialLoss"`
	FinalLoss   float64   `json:"finalLoss"`
	Iterations  int       `json:"iterations"`
	Converged   bool      `json:"converged"`
	Evals       int       `json:"evals"`
}

type adamGolden struct {
	MaxIters int       `json:"maxIters"`
	Calls    []fgCall  `json:"calls"`
	Result   optResult `json:"result"`
}

type nelderGolden struct {
	MaxIters int       `json:"maxIters"`
	Calls    []fCall   `json:"calls"`
	Result   optResult `json:"result"`
}

type pointGolden struct {
	Params []float64 `json:"params"`
	MSE    lossPoint `json:"mse"`
	RelMSE lossPoint `json:"relMse"`
}

type datasetGolden struct {
	Times        []float64            `json:"times"`
	Observations map[string][]float64 `json:"observations"`
	Places       []string             `json:"places"`
}

type caseGolden struct {
	Name     string              `json:"name"`
	Exact    bool                `json:"exact"`    // JS must match bit-for-bit
	Adaptive bool                `json:"adaptive"` // solver options: JSParityOptions with this Adaptive flag
	Model    json.RawMessage     `json:"model"`
	Tspan    [2]float64          `json:"tspan"`
	Rates    map[string]rateSpec `json:"rateFuncs"`

	ParamIndex map[string][2]int `json:"paramIndex"`
	NumParams  int               `json:"numParams"`

	Steps      int                  `json:"steps"`
	FinalTime  float64              `json:"finalTime"`
	FinalState map[string]float64   `json:"finalState"`
	MidIndex   int                  `json:"midIndex"`
	MidTime    float64              `json:"midTime"`
	FinalSens  map[string][]float64 `json:"finalSens"`
	MidSens    map[string][]float64 `json:"midSens"`

	Dataset datasetGolden `json:"dataset"`
	Point1  pointGolden   `json:"point1"` // at the declared rates
	Point2  pointGolden   `json:"point2"` // at a second fixed point

	// Adjoint (reverse-mode) loss+grad at the same two points, from
	// learn.MSELossAdjoint — one backward solve instead of n*P forward
	// sensitivity states. Grad is packed with the SAME ParamIndex as Point1/2,
	// so it compares directly against Point1.MSE.Grad / Point2.MSE.Grad.
	Point1Adjoint lossPoint `json:"point1Adjoint"`
	Point2Adjoint lossPoint `json:"point2Adjoint"`

	Adam   *adamGolden   `json:"adam,omitempty"`
	Nelder *nelderGolden `json:"nelder,omitempty"`
	Fit    *optResult    `json:"fit,omitempty"`
}

type hingeGolden struct {
	Decisions []struct {
		Scores    []float64 `json:"scores"`
		Preferred []bool    `json:"preferred"`
	} `json:"decisions"`
	Margin float64 `json:"margin"`
	Loss   float64 `json:"loss"`
}

type optRun struct {
	Objective string    `json:"objective"`
	Method    string    `json:"method"`
	X0        []float64 `json:"x0"`
	MaxIters  int       `json:"maxIters"`
	StepSize  float64   `json:"stepSize,omitempty"`
	Calls     []fgCall  `json:"calls"` // grad null for value-only objectives
	Result    optResult `json:"result"`
}

type goldens struct {
	Comment    string        `json:"_comment"`
	Cases      []caseGolden  `json:"cases"`
	Optimizers []optRun      `json:"optimizers"`
	Hinge      []hingeGolden `json:"hinge"`
}

// rosenbrock is the analytic optimizer-parity objective: pure +,-,*
// arithmetic in a fixed expression order, so every optimizer run over it is
// bit-exact across Go and JS (Adam's bias-correction pow is the integer-
// exponent path, ported bit-exactly as goPowInt).
func rosenbrock(x []float64) (float64, []float64) {
	a := 1 - x[0]
	b := x[1] - x[0]*x[0]
	f := a*a + 100*b*b
	g := []float64{-2*a - 400*x[0]*b, 200 * b}
	return f, g
}

// runOptimizers records the full call sequence of each optimizer over the
// analytic objective — the bit-exact half of the optimizer parity contract.
func runOptimizers() []optRun {
	x0 := []float64{-1.2, 1}
	var runs []optRun

	record := func(method string, maxIters int, stepSize float64, gradient bool) {
		var calls []fgCall
		var res *learn.FitResult
		var err error
		if gradient {
			rec := func(theta []float64) (float64, []float64) {
				loss, grad := rosenbrock(theta)
				mustFinite("optimizer call", loss)
				calls = append(calls, fgCall{
					Theta: append([]float64(nil), theta...),
					Loss:  loss,
					Grad:  append([]float64(nil), grad...),
				})
				return loss, grad
			}
			res, err = learn.MinimizeGradient(rec, x0, &learn.FitOptions{
				Method: method, MaxIters: maxIters, Tolerance: 0,
			})
		} else {
			rec := func(theta []float64) float64 {
				loss, _ := rosenbrock(theta)
				mustFinite("optimizer call", loss)
				calls = append(calls, fgCall{Theta: append([]float64(nil), theta...), Loss: loss})
				return loss
			}
			res, err = learn.Minimize(rec, x0, &learn.FitOptions{
				Method: method, MaxIters: maxIters, Tolerance: 0, StepSize: stepSize,
			})
		}
		if err != nil {
			log.Fatalf("optimizer %s: %v", method, err)
		}
		runs = append(runs, optRun{
			Objective: "rosenbrock",
			Method:    method,
			X0:        x0,
			MaxIters:  maxIters,
			StepSize:  stepSize,
			Calls:     calls,
			Result: optResult{
				Params: res.Params, InitialLoss: res.InitialLoss, FinalLoss: res.FinalLoss,
				Iterations: res.Iterations, Converged: res.Converged, Evals: res.Evals,
			},
		})
	}

	record("adam", 60, 0, true)
	record("gradient-descent", 30, 0, true)
	record("nelder-mead", 80, 0, false)
	record("coordinate-descent", 50, 0.01, false)
	return runs
}

// caseOpts is solver.JSParityOptions with the case's Adaptive flag. Fixed-step
// (Adaptive false) removes the step controller — and with it the one pow()
// whose Go implementation (SLEEF-derived assembly on amd64) cannot be
// bit-matched from JS — so fixed-step cases are exactly reproducible.
func caseOpts(adaptive bool) *solver.Options {
	o := solver.JSParityOptions()
	o.Adaptive = adaptive
	return o
}

// buildProblem constructs a fresh LearnableProblem from a case's model and
// rate specs. Fresh per use: fitting mutates the rate functions in place.
func buildProblem(model json.RawMessage, tspan [2]float64, specs map[string]rateSpec) *learn.LearnableProblem {
	net, err := parser.FromJSON(model)
	if err != nil {
		log.Fatalf("parse model: %v", err)
	}
	shared := map[string]*learn.SharedScalar{}
	rfs := map[string]learn.RateFunc{}
	for name, spec := range specs {
		switch spec.Kind {
		case "scalar":
			rfs[name] = learn.NewScalarRateFunc(spec.Rate)
		case "shared":
			s, ok := shared[spec.Group]
			if !ok {
				s = learn.NewSharedScalar(spec.Rate)
				shared[spec.Group] = s
			}
			rfs[name] = s
		default:
			log.Fatalf("unknown rate kind %q", spec.Kind)
		}
	}
	return learn.NewLearnableProblem(net, net.SetState(nil), tspan, rfs)
}

// mustFinite refuses to emit a golden containing Inf/NaN — JSON would either
// fail or silently misencode it.
func mustFinite(where string, vs ...float64) {
	for _, v := range vs {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			log.Fatalf("non-finite value in golden %s: %v", where, v)
		}
	}
}

func lossAt(prob *learn.LearnableProblem, data *learn.Dataset, params []float64, indices map[string][2]int, opts *solver.Options) (pointGolden, *learn.Sensitivities) {
	prob.SetAllParams(params, indices)
	sens, err := prob.SolveWithSensitivities(solver.Tsit5(), opts)
	if err != nil {
		log.Fatalf("sensitivities: %v", err)
	}
	if sens.Truncated {
		log.Fatal("sensitivity solve truncated; goldens must not depend on truncation")
	}
	ml, mg := learn.MSELossGrad(sens, data)
	rl, rg := learn.RelativeMSELossGrad(sens, data)
	mustFinite("loss", append([]float64{ml, rl}, append(mg, rg...)...)...)
	return pointGolden{
		Params: append([]float64(nil), params...),
		MSE:    lossPoint{Loss: ml, Grad: mg},
		RelMSE: lossPoint{Loss: rl, Grad: rg},
	}, sens
}

// adjointAt evaluates MSELossAdjoint at the CURRENT parameter values of prob
// (the caller has already called SetAllParams, e.g. via a prior lossAt call
// sharing the same prob) — the reverse-mode counterpart of lossAt's forward
// computation, packed with the identical ParamIndex so it compares directly
// against the forward-mode grad already recorded for the same point.
func adjointAt(prob *learn.LearnableProblem, data *learn.Dataset, opts *solver.Options) lossPoint {
	res, err := learn.MSELossAdjoint(prob, data, solver.Tsit5(), opts)
	if err != nil {
		log.Fatalf("adjoint: %v", err)
	}
	mustFinite("adjoint loss", res.Loss)
	mustFinite("adjoint grad", res.Grad...)
	return lossPoint{Loss: res.Loss, Grad: res.Grad}
}

// valueGrad replicates fitGradientCore's gradient evaluation (forward mode,
// default MSELossGrad): the closure both Adam goldens are recorded through.
func valueGrad(prob *learn.LearnableProblem, data *learn.Dataset, indices map[string][2]int, opts *solver.Options) func([]float64) (float64, []float64) {
	return func(theta []float64) (float64, []float64) {
		prob.SetAllParams(theta, indices)
		sens, err := prob.SolveWithSensitivities(solver.Tsit5(), opts)
		if err != nil || sens.Truncated {
			return math.Inf(1), nil
		}
		loss, grad := learn.MSELossGrad(sens, data)
		if math.IsNaN(loss) || math.IsInf(loss, 0) {
			return math.Inf(1), nil
		}
		for _, g := range grad {
			if math.IsNaN(g) || math.IsInf(g, 0) {
				return math.Inf(1), nil
			}
		}
		return loss, grad
	}
}

func buildCase(name string, exact, adaptive bool, model string, tspan [2]float64, specs map[string]rateSpec,
	data datasetGolden, point2 []float64, withAdam, withNelderFit bool, adamIters int) caseGolden {

	sopts := caseOpts(adaptive)
	c := caseGolden{
		Name:     name,
		Exact:    exact,
		Adaptive: adaptive,
		Model:    json.RawMessage(model),
		Tspan:    tspan,
		Rates:    specs,
		Dataset:  data,
	}
	ds := &learn.Dataset{Times: data.Times, Observations: data.Observations, Places: data.Places}

	// --- trajectory + sensitivities at the declared rates ---
	prob := buildProblem(c.Model, tspan, specs)
	params0, indices := prob.GetAllParams()
	p1, sens := lossAt(prob, ds, params0, indices, sopts)
	c.Point1 = p1
	c.ParamIndex = sens.ParamIndex
	c.NumParams = sens.NumParams
	// prob's rates are already set to params0 (lossAt's SetAllParams) — read
	// the adjoint gradient at the same point before anything mutates them.
	c.Point1Adjoint = adjointAt(prob, ds, sopts)

	last := len(sens.T) - 1
	mid := last / 2
	c.Steps = last
	c.FinalTime = sens.T[last]
	c.MidIndex = mid
	c.MidTime = sens.T[mid]
	c.FinalState = map[string]float64{}
	c.FinalSens = map[string][]float64{}
	c.MidSens = map[string][]float64{}
	for _, place := range sens.StateLabels {
		v := sens.Sol.U[last][place]
		mustFinite("finalState", v)
		c.FinalState[place] = v
		fr := make([]float64, sens.NumParams)
		mr := make([]float64, sens.NumParams)
		for p := 0; p < sens.NumParams; p++ {
			fv, ok := sens.At(last, place, p)
			if !ok {
				log.Fatalf("At(%d, %s, %d) failed", last, place, p)
			}
			mv, _ := sens.At(mid, place, p)
			mustFinite("sens", fv, mv)
			fr[p] = fv
			mr[p] = mv
		}
		c.FinalSens[place] = fr
		c.MidSens[place] = mr
	}

	// --- loss+grad at a second fixed parameter point ---
	prob2 := buildProblem(c.Model, tspan, specs)
	_, indices2 := prob2.GetAllParams()
	p2, _ := lossAt(prob2, ds, point2, indices2, sopts)
	c.Point2 = p2
	c.Point2Adjoint = adjointAt(prob2, ds, sopts)

	// --- Adam iterate sequence via MinimizeGradient with a recording fg ---
	if withAdam {
		probA := buildProblem(c.Model, tspan, specs)
		pA, idxA := probA.GetAllParams()
		vg := valueGrad(probA, ds, idxA, sopts)
		var calls []fgCall
		rec := func(theta []float64) (float64, []float64) {
			loss, grad := vg(theta)
			mustFinite("adam call", loss)
			calls = append(calls, fgCall{
				Theta: append([]float64(nil), theta...),
				Loss:  loss,
				Grad:  append([]float64(nil), grad...),
			})
			return loss, grad
		}
		res, err := learn.MinimizeGradient(rec, pA, &learn.FitOptions{
			Method:   "adam",
			MaxIters: adamIters,
			// Tolerance 0: |Δloss| < 0 never holds, so the run length is fixed
			// by MaxIters (unless the gradient converges).
			Tolerance: 0,
		})
		if err != nil {
			log.Fatalf("adam: %v", err)
		}
		mustFinite("adam result", res.FinalLoss, res.InitialLoss)
		c.Adam = &adamGolden{
			MaxIters: adamIters,
			Calls:    calls,
			Result: optResult{
				Params: res.Params, InitialLoss: res.InitialLoss, FinalLoss: res.FinalLoss,
				Iterations: res.Iterations, Converged: res.Converged, Evals: res.Evals,
			},
		}
	}

	// --- Nelder-Mead call sequence + learn.Fit result (deterministic cases) ---
	if withNelderFit {
		probN := buildProblem(c.Model, tspan, specs)
		pN, idxN := probN.GetAllParams()
		var calls []fCall
		obj := func(theta []float64) float64 {
			probN.SetAllParams(theta, idxN)
			sol := probN.Solve(solver.Tsit5(), sopts)
			v := learn.MSELoss(sol, ds)
			mustFinite("nelder call", v)
			calls = append(calls, fCall{Theta: append([]float64(nil), theta...), Value: v})
			return v
		}
		const nmIters = 30
		res, err := learn.Minimize(obj, pN, &learn.FitOptions{
			Method:    "nelder-mead",
			MaxIters:  nmIters,
			Tolerance: 0,
		})
		if err != nil {
			log.Fatalf("nelder-mead: %v", err)
		}
		c.Nelder = &nelderGolden{
			MaxIters: nmIters,
			Calls:    calls,
			Result: optResult{
				Params: res.Params, InitialLoss: res.InitialLoss, FinalLoss: res.FinalLoss,
				Iterations: res.Iterations, Converged: res.Converged, Evals: res.Evals,
			},
		}

		probF := buildProblem(c.Model, tspan, specs)
		fres, err := learn.Fit(probF, ds, learn.MSELoss, &learn.FitOptions{
			Method:        "adam",
			MaxIters:      10,
			Tolerance:     0,
			SolverMethod:  solver.Tsit5(),
			SolverOptions: sopts,
		})
		if err != nil {
			log.Fatalf("fit: %v", err)
		}
		mustFinite("fit result", fres.InitialLoss, fres.FinalLoss)
		c.Fit = &optResult{
			Params: fres.Params, InitialLoss: fres.InitialLoss, FinalLoss: fres.FinalLoss,
			Iterations: fres.Iterations, Converged: fres.Converged, Evals: fres.Evals,
		}
	}

	return c
}

func main() {
	out := flag.String("o", "parity/learn/goldens.json", "output path")
	flag.Parse()

	g := goldens{
		Comment: "GENERATED by parity/learn/gen (make learn-goldens) against go-pflow's learn package. " +
			"Replayed by public/petri-learn_test.ts. Cases with exact=true (fixed-step, adaptive=false) are " +
			"asserted bit-for-bit in JS; adaptive cases are asserted at 1e-12 relative because Go's adaptive " +
			"step controller calls math.Pow whose amd64 assembly V8 cannot bit-match (and sir additionally " +
			"carries Go-map-order last-bit jitter). The optimizers section (analytic objective) is bit-exact. " +
			"Solver options: solver.JSParityOptions() with the case's adaptive flag, on both sides.",
	}

	// Case 1: A -> B decay. One transition, one scalar rate. Every du and
	// sensitivity component is a sum of at most two terms from one transition:
	// bit-stable, asserted exact.
	decayModel := `{
  "places": {"A": {"initial": [10]}, "B": {"initial": [0]}},
  "transitions": {"decay": {}},
  "arcs": [
    {"source": "A", "target": "decay", "weight": [1]},
    {"source": "decay", "target": "B", "weight": [1]}
  ]
}`
	decayData := datasetGolden{
		Times: []float64{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
		Observations: map[string][]float64{
			"B": {0, 3.93, 6.32, 7.77, 8.65, 9.18, 9.5, 9.7, 9.82, 9.89, 9.93},
		},
		Places: []string{"B"},
	}
	// Adaptive (JSParityOptions as-is): the step controller's pow() runs
	// through Go's SLEEF-derived amd64 assembly, which V8's Math.pow cannot
	// bit-match, so even the deterministic nets are tolerance-asserted here.
	g.Cases = append(g.Cases, buildCase("decay", false, true, decayModel, [2]float64{0, 10},
		map[string]rateSpec{"decay": {Kind: "scalar", Rate: 0.3}},
		decayData, []float64{0.8}, true, true, 25))
	// Fixed-step (Adaptive false): no controller, no pow — bit-exact.
	g.Cases = append(g.Cases, buildCase("decay-fixed", true, false, decayModel, [2]float64{0, 10},
		map[string]rateSpec{"decay": {Kind: "scalar", Rate: 0.3}},
		decayData, []float64{0.8}, true, true, 25))

	// Case 2: SIR. Place I accumulates three flux terms from two transitions,
	// so Go's own runs differ in the last bit (randomized map order); the JS
	// test asserts <= 1e-12 relative. No Adam sequence: last-bit jitter can
	// flip an adaptive-step acceptance and diverge macroscopically.
	sirModel := `{
  "places": {"S": {"initial": [999]}, "I": {"initial": [1]}, "R": {"initial": [0]}},
  "transitions": {"infect": {}, "recover": {}},
  "arcs": [
    {"source": "S", "target": "infect", "weight": [1]},
    {"source": "I", "target": "infect", "weight": [1]},
    {"source": "infect", "target": "I", "weight": [2]},
    {"source": "I", "target": "recover", "weight": [1]},
    {"source": "recover", "target": "R", "weight": [1]}
  ]
}`
	sirData := datasetGolden{
		Times: []float64{0, 2, 4, 6, 8, 10},
		Observations: map[string][]float64{
			"I": {1, 6, 32, 130, 320, 440},
			"R": {0, 1, 4, 17, 63, 152},
		},
		Places: []string{"I", "R"},
	}
	g.Cases = append(g.Cases, buildCase("sir", false, true, sirModel, [2]float64{0, 10},
		map[string]rateSpec{
			"infect":  {Kind: "scalar", Rate: 0.001},
			"recover": {Kind: "scalar", Rate: 0.1},
		},
		sirData, []float64{0.002, 0.05}, false, false, 0))

	// Case 3: tied parameter — one SharedScalar driving two transitions on
	// disjoint chains (A -t1-> B, C -t2-> D). theta appears ONCE in the packed
	// params; both transitions' dflux/dtheta sum into the shared column. Every
	// place touches one transition: bit-stable, asserted exact.
	tiedModel := `{
  "places": {"A": {"initial": [8]}, "B": {"initial": [0]}, "C": {"initial": [5]}, "D": {"initial": [0]}},
  "transitions": {"t1": {}, "t2": {}},
  "arcs": [
    {"source": "A", "target": "t1", "weight": [1]},
    {"source": "t1", "target": "B", "weight": [1]},
    {"source": "C", "target": "t2", "weight": [1]},
    {"source": "t2", "target": "D", "weight": [1]}
  ]
}`
	tiedData := datasetGolden{
		Times: []float64{0, 1, 2, 3, 4, 5},
		Observations: map[string][]float64{
			"B": {0, 3.15, 5.05, 6.22, 6.93, 7.35},
			"D": {0, 1.97, 3.16, 3.89, 4.33, 4.59},
		},
		Places: []string{"B", "D"},
	}
	g.Cases = append(g.Cases, buildCase("tied", false, true, tiedModel, [2]float64{0, 5},
		map[string]rateSpec{
			"t1": {Kind: "shared", Rate: 0.25, Group: "k"},
			"t2": {Kind: "shared", Rate: 0.25, Group: "k"},
		},
		tiedData, []float64{0.6}, true, false, 25))
	g.Cases = append(g.Cases, buildCase("tied-fixed", true, false, tiedModel, [2]float64{0, 5},
		map[string]rateSpec{
			"t1": {Kind: "shared", Rate: 0.25, Group: "k"},
			"t2": {Kind: "shared", Rate: 0.25, Group: "k"},
		},
		tiedData, []float64{0.6}, true, false, 25))

	g.Optimizers = runOptimizers()

	// Hinge ranking loss: pure arithmetic, exact.
	for _, h := range []struct {
		scores [][]float64
		pref   [][]bool
		margin float64
	}{
		{
			scores: [][]float64{{3, 1, 2}, {0.5, 0.6, 0.4}, {1, 2}},
			pref:   [][]bool{{true, false, false}, {false, true, false}, {true, true}},
			margin: 0.5,
		},
		{
			scores: [][]float64{{1, 1.2}, {2, 1}},
			pref:   [][]bool{{true, false}, {false, true}},
			margin: 0.1,
		},
	} {
		var hg hingeGolden
		var decisions []learn.RankedDecision
		for i := range h.scores {
			decisions = append(decisions, learn.RankedDecision{Scores: h.scores[i], Preferred: h.pref[i]})
			hg.Decisions = append(hg.Decisions, struct {
				Scores    []float64 `json:"scores"`
				Preferred []bool    `json:"preferred"`
			}{h.scores[i], h.pref[i]})
		}
		hg.Margin = h.margin
		hg.Loss = learn.HingeRankLoss(decisions, h.margin)
		g.Hinge = append(g.Hinge, hg)
	}

	buf, err := json.MarshalIndent(&g, "", "  ")
	if err != nil {
		log.Fatal(err)
	}
	buf = append(buf, '\n')
	if err := os.WriteFile(*out, buf, 0644); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("wrote %s (%d cases, %d optimizer runs, %d hinge fixtures)\n", *out, len(g.Cases), len(g.Optimizers), len(g.Hinge))
}
