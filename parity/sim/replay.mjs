// replay.mjs — JS side of the JS/Go behavioral parity contract.
//
// Reads a batch of models (pflow.xyz JSON) plus a walk length from argv[1],
// then performs a DETERMINISTIC lockstep walk on each model using the same
// rule the Go side implements (parity/sim/sim_parity_test.go):
//
//   at each step: record the sorted enabled set; if empty, stop;
//   otherwise fire the lexicographically smallest enabled transition.
//
// No randomness is shared between the two sides — determinism comes entirely
// from the walk rule, so any divergence in enabled sets or markings is a
// semantic difference between public/petri-sim.js and go-pflow's engine.
//
// Output (stdout): JSON array, one entry per model:
//   { name, steps: [ { enabled: [...], fired: "t"|null, marking: {pid: n} } ] }
//
// Markings are reported as per-place scalar sums, matching go-pflow's
// integer marking. Runs under node or deno.
import { readFileSync } from 'node:fs';
import { marking, enabledTransitions, fire } from '../../public/petri-sim.js';

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));

function scalarize(marks) {
  const out = {};
  for (const [pid, vec] of Object.entries(marks)) {
    out[pid] = vec.reduce((a, b) => a + b, 0);
  }
  return out;
}

const results = [];
for (const entry of input.models) {
  const model = entry.model;
  let marks = marking(model);
  const steps = [];

  for (let i = 0; i < input.maxSteps; i++) {
    const enabled = enabledTransitions(model, marks).sort();
    if (enabled.length === 0) {
      steps.push({ enabled, fired: null, marking: scalarize(marks) });
      break;
    }
    const fired = enabled[0];
    const next = fire(model, fired, marks);
    if (next === null) {
      // enabled() said yes but fire() said no — internal inconsistency.
      steps.push({ enabled, fired: `FIRE_FAILED:${fired}`, marking: scalarize(marks) });
      break;
    }
    marks = next;
    steps.push({ enabled, fired, marking: scalarize(marks) });
  }

  results.push({ name: entry.name, steps });
}

process.stdout.write(JSON.stringify(results));
