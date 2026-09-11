// public/petri-sde_test.ts — checks for the chemical Langevin SDE port
// (public/petri-sde.js), the third leg of Petri.jl's
// ODEProblem/JumpProblem/SDEProblem trio (go-pflow ROADMAP.md G6). Run via
// `make test-js` (deno test), alongside petri-ssa_test.ts.
//
// `parity/sde/*.json` (chain, sir, dimer, gates, coffeeshop) are byte-exact
// goldens — same portable-path contract as `parity/ssa/`, compared with
// `!==`, never a tolerance — closing the pflow-xyz side of the same
// three-way contract go-pflow↔pflow-rs already held (see `parity/sde/
// README.md`). The Gaussian sampler is additionally checked bit-for-bit
// against go-pflow's own `stochastic/portable_test.go`
// `TestPortableNormalVectors` at seed 42 (Go is the reference implementation
// for normal(): no external SDE spec, the same role it plays for
// wait()/uniform() in ssa-spec.md). The remaining tests are consistency
// checks against this repo's own SSA (petri-ssa.js), mirroring go-pflow's
// stochastic/sde_test.go: linear-chain mean tracks SSA, SIR-at-scale
// variance tracks SSA, weight-2 dimerisation tracks SSA (not the ODE's
// different rate law).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import chain from "../parity/ssa/chain.json" with { type: "json" };
import sir from "../parity/ssa/sir.json" with { type: "json" };
import dimer from "../parity/ssa/dimer.json" with { type: "json" };
import sdeChain from "../parity/sde/chain.json" with { type: "json" };
import sdeSir from "../parity/sde/sir.json" with { type: "json" };
import sdeDimer from "../parity/sde/dimer.json" with { type: "json" };
import sdeGates from "../parity/sde/gates.json" with { type: "json" };
import sdeCoffeeshop from "../parity/sde/coffeeshop.json" with { type: "json" };
import { simulate } from "./petri-ssa.js";
import { CHEMICAL_LANGEVIN_ASSUMPTION, combinationsReal, GaussianSampler, simulateSDE } from "./petri-sde.js";

// deno-lint-ignore no-explicit-any
type Any = any;

const view = new DataView(new ArrayBuffer(8));
function bitsOf(x: number): bigint {
  view.setFloat64(0, x);
  return view.getBigUint64(0);
}
function hex64(v: bigint): string {
  return "0x" + v.toString(16).toUpperCase().padStart(16, "0");
}

/** Exact comparison: `!==` (not Object.is) — 0 and -0 are the same value here. */
function expectNum(actual: number, expected: number, ctx: string) {
  if (actual !== expected) {
    throw new Error(
      `${ctx}: expected exact ${expected} (${hex64(bitsOf(expected))}), got ${actual} (${hex64(bitsOf(actual))}), diff ${actual - expected}`,
    );
  }
}
function expectArr(actual: number[], expected: number[], ctx: string) {
  assertEquals(actual.length, expected.length, `${ctx}: length`);
  for (let i = 0; i < expected.length; i++) expectNum(actual[i], expected[i], `${ctx}[${i}]`);
}

// ── 1. Gaussian sampler ─────────────────────────────────────────────────────

Deno.test("normal() matches go-pflow's TestPortableNormalVectors at seed 42", () => {
  const want = [
    0xBFE73D2FEB0FB377n,
    0xBFCB088028693F9Cn,
    0x3FCC5E21F7812A4Cn,
    0x3FE0BA8BB0C5FA51n,
    0x3FDDB514BFAC5B4En,
  ];
  const s = new GaussianSampler(42n);
  for (let i = 0; i < want.length; i++) {
    const v = s.normal();
    const got = bitsOf(v);
    if (got !== want[i]) {
      throw new Error(`normal()[${i}] = ${v} (${hex64(got)}), want ${hex64(want[i])}`);
    }
  }
});

// ── 2. Continuous propensity ────────────────────────────────────────────────

Deno.test("combinationsReal agrees with combinations at every non-negative integer", () => {
  function combinations(m: number, w: number): number {
    if (w <= 0) return 1.0;
    if (m < w) return 0.0;
    let result = 1.0;
    for (let i = 0; i < w; i++) {
      result = result * (m - i);
      result = result / (i + 1);
    }
    return result;
  }
  for (let m = 0; m <= 10; m++) {
    for (let w = 0; w <= 4; w++) {
      const want = combinations(m, w);
      const got = combinationsReal(m, w);
      if (Math.abs(got - want) > 1e-9) {
        throw new Error(`combinationsReal(${m}, ${w}) = ${got}, want ${want}`);
      }
    }
  }
});

Deno.test("combinationsReal goes negative below x = w - 1 (documented, not a bug)", () => {
  const got = combinationsReal(0.5, 2);
  if (Math.abs(got - -0.125) > 1e-12) {
    throw new Error(`combinationsReal(0.5, 2) = ${got}, want -0.125`);
  }
});

Deno.test("combinationsReal at weight 1 is the identity", () => {
  for (const x of [0, 0.3, 1, 5.7, 100]) {
    assertEquals(combinationsReal(x, 1), x);
  }
});

// ── 3. Gating refusal ───────────────────────────────────────────────────────

Deno.test("simulateSDE refuses a model with a read arc", () => {
  const model = {
    places: [
      { id: "a", initial: 10, capacity: 10 },
      { id: "licence", initial: 1 },
      { id: "b", initial: 0 },
    ],
    transitions: [{ id: "t", rate: 1 }],
    arcs: [
      { from: "a", to: "t" },
      { from: "licence", to: "t", type: "read" },
      { from: "t", to: "b" },
    ],
  };
  const res = simulateSDE(model, { horizon: 1, samples: 2, realizations: 1, seed: 1 });
  if (!res.diverged) throw new Error("simulateSDE did not refuse a model with a read arc");
  if (!res.caveats || res.caveats.length === 0) {
    throw new Error("diverged with no caveats naming why");
  }
});

Deno.test("simulateSDE refuses a model with a delayed transition (§5)", () => {
  const model = {
    places: [{ id: "a", initial: 3 }, { id: "b", initial: 0 }],
    transitions: [{ id: "t", delay: 1.5 }],
    arcs: [{ from: "a", to: "t" }, { from: "t", to: "b" }],
  };
  const res = simulateSDE(model, { horizon: 1, samples: 2, realizations: 1, seed: 1 });
  if (!res.diverged) throw new Error("simulateSDE did not refuse a delayed transition");
  if (!res.caveats?.some((c: string) => c.includes("delay"))) throw new Error(`caveats do not name the delay: ${res.caveats}`);
});

Deno.test("simulateSDE dispatches with the chemical Langevin assumption named", () => {
  const res = simulateSDE(chain.model as Any, { horizon: 1, samples: 5, realizations: 1, seed: 1 });
  if (res.diverged) throw new Error(`sde diverged on an ungated model: ${res.reason}`);
  if (typeof CHEMICAL_LANGEVIN_ASSUMPTION !== "string" || CHEMICAL_LANGEVIN_ASSUMPTION.length === 0) {
    throw new Error("CHEMICAL_LANGEVIN_ASSUMPTION is empty");
  }
});

// ── 4. Consistency against SSA (mirrors go-pflow's sde_test.go) ────────────

Deno.test("SDE mean tracks SSA mean on a mean-field-exact linear chain", () => {
  const opts = { horizon: 6, samples: 61, realizations: 400, seed: 20260902 };
  const ssa = simulate(chain.model as Any, opts);
  const sde = simulateSDE(chain.model as Any, opts);
  if (sde.diverged) throw new Error(`sde diverged: ${sde.reason}`);
  for (const p of sde.places) {
    let maxDiff = 0;
    const ssaValues = ssa.series[p].values;
    const sdeValues = sde.series[p].values;
    for (let i = 0; i < sdeValues.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(sdeValues[i] - ssaValues[i]));
    }
    if (maxDiff > 2.0) {
      throw new Error(`${p}: max|sde mean - ssa mean| = ${maxDiff} (limit 2.0)`);
    }
  }
  let finalSum = 0;
  for (const p of sde.places) finalSum += sde.final[p];
  if (Math.abs(finalSum - 100) > 2.0) {
    throw new Error(`sum of means at horizon = ${finalSum}, want ~100`);
  }
});

Deno.test("SDE variance tracks SSA variance on the SIR fixture at scale", () => {
  // Scale the sir.json fixture x10 (N = 10,000) the way
  // go-pflow's consistency_test.go's sirModel(scale) does: population up,
  // rate proportionally down so R0 (and thus the trajectory shape) matches.
  const base = sir.model as Any;
  const scale = 10;
  const scaled = {
    places: base.places.map((p: Any) => ({ ...p, initial: p.initial * scale })),
    transitions: base.transitions.map((t: Any) =>
      t.id === "infect" ? { ...t, rate: t.rate / scale } : t
    ),
    arcs: base.arcs,
  };
  const opts = { horizon: 40, samples: 81, realizations: 100, seed: 20260902 };
  const ssa = simulate(scaled, opts);
  const sde = simulateSDE(scaled, opts);
  if (sde.diverged) throw new Error(`sde diverged: ${sde.reason}`);
  for (const p of sde.places) {
    const ssaStd = ssa.series[p].stddev!;
    const sdeStd = sde.series[p].stddev!;
    let peak = 0;
    for (let i = 1; i < ssaStd.length; i++) if (ssaStd[i] > ssaStd[peak]) peak = i;
    if (ssaStd[peak] < 1e-9) continue;
    const rel = Math.abs(sdeStd[peak] - ssaStd[peak]) / ssaStd[peak];
    if (rel > 0.35) {
      throw new Error(
        `${p}: stdev at peak (grid ${peak}) sde=${sdeStd[peak]} ssa=${ssaStd[peak]}, relative diff ${rel} (limit 0.35)`,
      );
    }
  }
});

Deno.test("SDE tracks SSA (not the ODE's different rate law) on weight-2 dimerisation", () => {
  const opts = { horizon: 5, samples: 51, realizations: 300, seed: 20260902 };
  const ssa = simulate(dimer.model as Any, opts);
  const sde = simulateSDE(dimer.model as Any, opts);
  if (sde.diverged) throw new Error(`sde diverged: ${sde.reason}`);
  for (const p of sde.places) {
    let maxDiff = 0;
    const ssaValues = ssa.series[p].values;
    const sdeValues = sde.series[p].values;
    for (let i = 0; i < sdeValues.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(sdeValues[i] - ssaValues[i]));
    }
    if (maxDiff > 3.0) {
      throw new Error(`${p}: max|sde - ssa| = ${maxDiff}, want close (both use C(m,w))`);
    }
  }
});

// ── 5. parity/sde fixture replay — the byte-exact acceptance gate ──────────

const sdeFixtures: Record<string, Any> = {
  chain: sdeChain,
  sir: sdeSir,
  dimer: sdeDimer,
  gates: sdeGates,
  coffeeshop: sdeCoffeeshop,
};

for (const [name, fx] of Object.entries(sdeFixtures)) {
  Deno.test(`parity/sde/${name}.json replays bit-for-bit`, () => {
    const res = simulateSDE(fx.model, fx.options);

    if (fx.diverged) {
      if (!res.diverged) {
        throw new Error(`${name}: expected simulateSDE to refuse (golden is diverged), it did not`);
      }
      assertEquals(res.reason, fx.reason, `${name}: reason`);
      assertEquals(res.caveats, fx.caveats, `${name}: caveats`);
      return;
    }

    if (res.diverged) {
      throw new Error(`${name}: simulateSDE refused an ungated golden: ${res.reason}`);
    }

    const modelPlaces = (fx.model.places as Any[]).map((p: Any) => p.id).sort();
    assertEquals(Object.keys(fx.expected.series).sort(), modelPlaces, "golden place set");
    assertEquals(res.places.slice().sort(), modelPlaces, `${name}: series place set`);
    assertEquals(Object.keys(res.final).sort(), modelPlaces, `${name}: final place set`);

    expectArr(res.times, fx.expected.times, `${name}.times`);
    for (const [place, want] of Object.entries(fx.expected.series) as [string, Any][]) {
      const got = res.series[place];
      expectArr(got.values, want.values, `${name}.${place}.values`);
      if (want.stddev) expectArr(got.stddev!, want.stddev, `${name}.${place}.stddev`);
      expectNum(res.final[place], fx.expected.final[place], `${name}.final.${place}`);
    }
  });
}
