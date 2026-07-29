// ode_replay.mjs — JS side of the JS/Go ODE parity contract.
//
// Reads fixture models + solver settings from argv[2], integrates each with
// public/petri-solver.js (the same Tsit5 module the browser uses, default
// options), and prints the final state per model. The Go side
// (parity/ode/ode_parity_test.go) integrates the identical fixtures with
// go-pflow's solver and compares within tolerance.
//
// The two integrators are independent implementations of the same Tsit5
// tableau with matching default options, so final states agree to well within
// the solver's own error tolerance; the test bound is deliberately looser
// than machine epsilon and much tighter than any behavioral difference.
import { readFileSync } from 'node:fs';
import { fromJSON, setState, setRates, ODEProblem, solve, Tsit5 } from '../../public/petri-solver.js';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const results = [];
for (const entry of input.models) {
  const net = fromJSON(entry.model);
  const state = setState(net);
  const rates = setRates(net, entry.rates ?? null);
  const prob = new ODEProblem(net, state, entry.tspan, rates);
  const sol = solve(prob, Tsit5(), {});
  results.push({ name: entry.name, final: sol.getFinalState(), steps: sol.t.length });
}

process.stdout.write(JSON.stringify(results));
