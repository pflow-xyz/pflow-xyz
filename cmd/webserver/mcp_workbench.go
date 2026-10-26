package main

// The /mcp workbench tools: pflow_sde, pflow_what_if and pflow_optimize, the
// editor's sim.sde, sim.what_if and opt.optimize without a browser. They were
// left out of the registry tools until they had parity tests; they have them
// now: parity/native/mcp_goldens.json is generated from pflow-native, and
// mcp_workbench_parity_test.go holds these tools to it (the SDE and the
// scenario SSA to the bit, the optimizer to the bit on most cases and within
// 1e-12 where a math library is involved). The engines and what they port are
// in mcp_workbench_engine.go.
//
// Like every registry tool they are stateless and model-in-argument, seeded
// (so idempotent: the same arguments give the same bytes), and bounded:
//   - native's caps, plus tighter ones on what the answer carries (points,
//     samples, parameters, objectives) and on the net (places, transitions);
//   - every answer fits the result guard (mcpMaxResultBytes, 60 KB) whole,
//     never cut (fitAnswer, and the optimizer's own prefix rule): its size is
//     bounded before anything runs, every number at its longest and at its
//     shortest. One the upper bound says fits runs once; a count the caller
//     chose that even the lower bound says cannot fit is refused before
//     anything runs; in between the answer is built and measured. A count the
//     caller chose that does not fit is refused, naming one that does; the
//     default points or samples is lowered instead, and the answer says so in
//     `note`;
//   - work and memory budgets that count places as well as transitions (the
//     SDE's dense deltas and per-sample state, the what-if SSA's per-run
//     samples, the optimizer's solver iterations), checked before the run
//     where the arguments decide them and during it where they cannot
//     (an adaptive solve's step count);
//   - the call's context, which every engine checks as it runs.

import (
	"fmt"
	"net/http"
)

const (
	wbMaxSDEPoints     = 500 // native: 5000
	wbMaxWhatIfSamples = 500 // native: 5000
	wbMaxOptSamples    = 500 // native: 2000
	wbMaxPlaces        = 300 // token places, colours unfolded; native: none
	wbMaxTransitions   = 300 // native: none
	wbMaxOptParams     = 64  // native: none (one per transition)
	wbMaxOptObjectives = 16  // native: none
	// wbMinTolerance floors the optimizer's abstol and reltol: below it the
	// adaptive step sits at its minimum and the solve runs out of steps.
	wbMinTolerance = 1e-12

	// The work and memory budgets below are sized so that a call at the
	// limit takes a second or two on one core of the deploy box.
	//
	// The SDE runs 20 Euler-Maruyama substeps per sample interval; each draws
	// a normal and evaluates a propensity per transition (wbSDETransitionCost
	// in units of one delta entry) and walks the transition's dense delta over
	// every place. Work is realizations × intervals × (transitions ×
	// (places + wbSDETransitionCost) + 2 × places). go-pflow keeps about five
	// doubles per sample and place.
	wbMaxSDEWork        = 100_000_000
	wbSDETransitionCost = 50
	wbMaxSDECells       = 500_000
	// The what-if SSA records realizations × samples × places per arm, and
	// each step copies the marking (the hook that gives the finals' min and
	// max), so its step budget per arm is the smaller of maxSSASteps and
	// wbWhatIfStepWork / (places + 6).
	wbMaxWhatIfCells = 4_000_000
	wbWhatIfStepWork = 45_000_000
	// The optimizer's solver iterations, each costing stages × (stages ×
	// places + arcs + transitions + 20), summed over every sample.
	wbMaxOptWork = 2_000_000_000
)

func init() {
	for name, a := range map[string]mcpAnnotation{
		"pflow_sde":      {"Simulate a net (chemical Langevin SDE)", true, false, true},
		"pflow_what_if":  {"What if a place had more tokens", true, false, true},
		"pflow_optimize": {"Optimize rates (Pareto front)", true, false, true},
	} {
		mcpAnnotations[name] = a
	}
}

var (
	sdeArgKinds = map[string]argKind{
		"net": argAny, "t_end": argNum, "seed": argInt, "runs": argInt, "points": argInt, "dt": argNum, "places": argStrList,
	}
	whatIfArgKinds = map[string]argKind{
		"net": argAny, "place": argStr, "delta": argInt, "t_end": argNum, "runs": argInt, "seed": argInt, "samples": argInt, "places": argStrList,
	}
	optimizeArgKinds = map[string]argKind{
		"net": argAny, "parameters": argAny, "objectives": argAny, "samples": argInt, "seed": argInt, "t_end": argNum,
		"method": argStr, "dt": argNum, "abstol": argNum, "reltol": argNum,
	}
	placesArg = map[string]any{"type": "array", "items": idArg, "description": "places whose series to return (default all; a document place selects all its colours); finals always cover every place"}
)

func workbenchTools() []mcpTool {
	return []mcpTool{
		{
			Name: "pflow_sde",
			Description: "Chemical Langevin SDE (Euler-Maruyama over the mass-action propensities, 20 steps per sample interval; go-pflow's portable path, seeded) from the net's marking with each transition's rate: continuous state with the net's own firing noise, cheap at large token counts where SSA is slow. " +
				"With runs > 1 the series are means with a ± std-dev band. The same numbers as pflow-native's sim.sde for the same seed (and the editor's, on a net that lists its transitions in id order). " +
				"Refuses a net with inhibitor or read arcs, or a capacity on a place some firing adds tokens to, which a diffusion cannot express (use pflow_ssa). A value that overflows is null, as native writes it. " +
				"The answer always fits whole: with the default points the server returns as many of the 101 as fit (and says so in `note`); asking for more points than fit is refused, naming how many do. `places` returns fewer series.",
			InputSchema: obj(map[string]any{
				"net":    netArg,
				"t_end":  map[string]any{"type": "number", "description": "end time (default 10, ≤ 10000)"},
				"seed":   map[string]any{"type": "integer", "minimum": 0, "description": "RNG seed (default 1, at most 2^53); realization r uses seed + r"},
				"runs":   map[string]any{"type": "integer", "minimum": 1, "maximum": wbMaxRuns, "description": "realizations averaged (default 1, ≤ 200)"},
				"points": map[string]any{"type": "integer", "minimum": 2, "maximum": wbMaxSDEPoints, "description": "points returned, 0 to t_end (default 101, fewer when that many would not fit the answer; ≤ 500)"},
				"dt":     map[string]any{"type": "number", "description": "integration step (default (t_end / (points-1)) / 20); the run then takes t_end / (20 dt) sample intervals, thinned to points"},
				"places": placesArg,
			}, "net"),
			run: mcpSDE,
		},
		{
			Name: "pflow_what_if",
			Description: "What if `place` had `delta` more tokens (default 1; negative removes)? Runs the net as is and with the change on go-pflow's scenario SSA (the discrete engine: inhibitors, read arcs and capacities respected), " +
				"both arms on one shared seed so the difference measures the change, not the dice. Returns each arm's summary (final means and spread, time-weighted mean and p95, throughput, depletion, contention), " +
				"an overlay time series (group = arm), a table of final means, and each arm's finals table (mean, sd, min, max). The editor's sim.what_if; the same numbers as pflow-native for the same seed. " +
				"The answer always fits whole: with the default samples the server returns as many of the 60 as fit (and says so in `note`); asking for more samples than fit is refused, naming how many do. `places` returns fewer series; every place stays in the summaries and finals.",
			InputSchema: obj(map[string]any{
				"net":     netArg,
				"place":   idArg,
				"delta":   map[string]any{"type": "integer", "description": "tokens to add (default 1; may be negative)"},
				"t_end":   map[string]any{"type": "number", "description": "horizon (default 10, ≤ 10000)"},
				"runs":    map[string]any{"type": "integer", "minimum": 1, "maximum": wbMaxRuns, "description": "realizations per arm (default 16, ≤ 200)"},
				"seed":    map[string]any{"type": "integer", "minimum": 0, "description": "the shared seed (default 7, at most 2^53)"},
				"samples": map[string]any{"type": "integer", "minimum": 2, "maximum": wbMaxWhatIfSamples, "description": "sample points, 0 to t_end (default 60, fewer when that many would not fit the answer; ≤ 500)"},
				"places":  placesArg,
			}, "net", "place"),
			run: mcpWhatIf,
		},
		{
			Name: "pflow_optimize",
			Description: "Monte Carlo over transition rates (seeded): sample each parameter in [min, max] (log-spaced with log: true), integrate the mass-action ODE to t_end once per sample (go-pflow Tsit5 unless `method` says otherwise; only the final state is read, so abstol defaults to 1e-4 and the step may grow to t_end/20), " +
				"read each objective place there and flag the non-dominated samples (the Pareto front). Returns the front, a scatter (the two first objectives against each other, or the first rate against the one objective) and a table of every sample. pflow-native's opt.optimize: the same doubles, or within 1e-12 where a math library is involved. " +
				"An objective that overflows is null (and, being incomparable, on the front, as native flags it). A solve that runs out of solver steps before t_end is an error, not an answer; a fixed-step method whose dt needs more steps than the solver allows, or a tolerance below 1e-12, is refused. " +
				"The answer always fits whole: with the default samples the server keeps as many of the first 100 as fit (native's answer for that many; `note` says so); asking for more samples than fit is refused, naming how many do. At most 64 parameters and 16 objectives.",
			InputSchema: obj(map[string]any{
				"net":        netArg,
				"parameters": map[string]any{"type": []any{"array", "object"}, "description": "[{transition, min, max, log?}], or sim's {transition: [min, max]} (taken in id order)"},
				"objectives": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{"place": idArg, "sense": map[string]any{"type": "string", "enum": []any{"max", "min"}}}, "required": []any{"place"}}, "description": "[{place, sense}]: sense max (default) or min (`direction` is accepted for sense); a document place sums its colours"},
				"samples":    map[string]any{"type": "integer", "minimum": 1, "maximum": wbMaxOptSamples, "description": "samples (default 100, fewer when that many would not fit the answer; ≤ 500)"},
				"seed":       map[string]any{"type": "integer", "description": "sampling seed (default 42, at most 2^53 in size)"},
				"t_end":      map[string]any{"type": "number", "description": "horizon of each run (default 10, ≤ 10000)"},
				"method":     map[string]any{"type": "string", "enum": []any{"tsit5", "rk45", "rk4", "euler", "heun", "midpoint", "bs32"}},
				"dt":         map[string]any{"type": "number", "description": "initial step, the step of a fixed-step method (default 0.01, at most t_end/20)"},
				"abstol":     map[string]any{"type": "number", "description": "absolute tolerance (default 1e-4, at least 1e-12)"},
				"reltol":     map[string]any{"type": "number", "description": "relative tolerance (default 1e-3, at least 1e-12)"},
			}, "net", "parameters", "objectives"),
			run: mcpOptimize,
		},
	}
}

// workbenchNet checks the arguments and reads the net.
func workbenchNet(tool string, args map[string]any, kinds map[string]argKind, required ...string) (*wbNet, error) {
	if err := checkArgs(tool, args, kinds); err != nil {
		return nil, err
	}
	for _, k := range required {
		if args[k] == nil {
			return nil, fmt.Errorf("%s: missing argument %q", tool, k)
		}
	}
	_, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	n, err := newWBNet(doc)
	if err != nil {
		return nil, err
	}
	if err := n.checkNetSize(); err != nil {
		return nil, err
	}
	return n, nil
}

func mcpSDE(_ *Server, r *http.Request, args map[string]any) (any, error) {
	n, err := workbenchNet("pflow_sde", args, sdeArgKinds)
	if err != nil {
		return nil, err
	}
	return runSDE(r.Context(), n, args, mcpSDEOpts())
}

func mcpWhatIf(_ *Server, r *http.Request, args map[string]any) (any, error) {
	n, err := workbenchNet("pflow_what_if", args, whatIfArgKinds, "place")
	if err != nil {
		return nil, err
	}
	return runWhatIf(r.Context(), n, args, mcpWhatIfOpts())
}

func mcpOptimize(_ *Server, r *http.Request, args map[string]any) (any, error) {
	n, err := workbenchNet("pflow_optimize", args, optimizeArgKinds, "parameters", "objectives")
	if err != nil {
		return nil, err
	}
	return runOptimize(r.Context(), n, args, mcpOptOpts())
}

// The tools' caps, as the engines take them.
func mcpSDEOpts() sdeOpts {
	return sdeOpts{maxPoints: wbMaxSDEPoints, maxWork: wbMaxSDEWork, maxCells: wbMaxSDECells, maxBytes: mcpMaxResultBytes}
}

func mcpWhatIfOpts() whatIfOpts {
	return whatIfOpts{maxSamples: wbMaxWhatIfSamples, maxSteps: maxSSASteps, stepWork: wbWhatIfStepWork, maxCells: wbMaxWhatIfCells, maxBytes: mcpMaxResultBytes}
}

func mcpOptOpts() optOpts {
	return optOpts{maxSamples: wbMaxOptSamples, maxTEnd: maxMCPTEnd, maxWork: wbMaxOptWork, maxBytes: mcpMaxResultBytes}
}
