// Smoke test for the npm package: run against an EXTRACTED tarball, not the
// repo tree, so it exercises exactly the files that ship.
//
//   node scripts/npm-smoke.mjs <extracted-package-dir>
//
// Solves Lotka-Volterra and asserts the conserved quantity
//   V = k_death*ln(R) - k_pred*R + k_birth*ln(F) - k_pred*F
// drifts < 1e-4 across [0, 30] at reltol=1e-3. The solver currently holds
// ~3e-6, so this guards real integration regressions, not just "it ran".
//
// This bound was 1e-9 (measured ~2e-11, 2052 steps) before the Tsit5 bhat
// sign fix (btilde7 = -1/66, not +1/66 — see solver/tsit5.go). The old,
// wrong-signed error estimate never vanished at the requested tolerance, so
// the step controller over-refined by ~7x versus what reltol=1e-3 actually
// asked for, and the resulting drift was accidentally far tighter than
// requested. Post-fix (303 steps) the drift of ~3e-6 is the honest answer
// for reltol=1e-3 — well inside it, and consistent with a correctly-scaling
// controller (see public/petri-solver_test.ts's step-growth-per-decade
// assertion). Do not restore the old 1e-9 bound; it encoded the bug.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error("usage: node scripts/npm-smoke.mjs <extracted-package-dir>");
  process.exit(2);
}

const pf = await import(pathToFileURL(resolve(pkgDir, "public/petri-solver.js")));

const K_BIRTH = 1.1, K_PRED = 0.4, K_DEATH = 0.4;

const model = {
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  token: ["https://pflow.xyz/tokens/black"],
  places: {
    rabbits: { "@type": "Place", initial: [10], capacity: [0], x: 60, y: 60 },
    foxes: { "@type": "Place", initial: [5], capacity: [0], x: 260, y: 60 },
  },
  transitions: {
    birth: { "@type": "Transition", x: 60, y: 160 },
    predation: { "@type": "Transition", x: 160, y: 160 },
    death: { "@type": "Transition", x: 260, y: 160 },
  },
  arcs: [
    { "@type": "Arrow", source: "rabbits", target: "birth", weight: [1] },
    { "@type": "Arrow", source: "birth", target: "rabbits", weight: [2] },
    { "@type": "Arrow", source: "rabbits", target: "predation", weight: [1] },
    { "@type": "Arrow", source: "foxes", target: "predation", weight: [1] },
    { "@type": "Arrow", source: "predation", target: "foxes", weight: [2] },
    { "@type": "Arrow", source: "foxes", target: "death", weight: [1] },
  ],
};

const net = pf.fromJSON(model);
const prob = new pf.ODEProblem(net, pf.setState(net), [0, 30],
  pf.setRates(net, { birth: K_BIRTH, predation: K_PRED, death: K_DEATH }));
const sol = pf.solve(prob, pf.Tsit5(),
  { dt: 0.01, abstol: 1e-6, reltol: 1e-3, adaptive: true });

const tEnd = sol.t[sol.t.length - 1];
if (Math.abs(tEnd - 30) > 1e-12) {
  console.error(`FAIL: integration stopped at t=${tEnd}, expected 30 (maxiters hit?)`);
  process.exit(1);
}

const R = sol.getVariable("rabbits");
const F = sol.getVariable("foxes");
const V = (r, f) => K_DEATH * Math.log(r) - K_PRED * r + K_BIRTH * Math.log(f) - K_PRED * f;
const v0 = V(R[0], F[0]);
let drift = 0;
for (let i = 1; i < R.length; i++) drift = Math.max(drift, Math.abs(V(R[i], F[i]) - v0));

if (!(drift < 1e-4)) {
  console.error(`FAIL: LV invariant drift ${drift} >= 1e-4 over ${R.length} steps`);
  process.exit(1);
}

console.log(`ok: t reached ${tEnd}, ${R.length} steps, LV invariant drift ${drift.toExponential(2)} < 1e-4`);
