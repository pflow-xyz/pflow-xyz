// public/petri-ssa_test.ts — the JS side of the four-way byte-exact SSA
// contract (run via `make test-js`, i.e. deno test).
//
// The portable Gillespie SSA in public/petri-ssa.js must reproduce go-pflow's
// `stochastic` package (portable path) BIT-FOR-BIT: same PRNG stream
// (SplitMix64 → xoshiro256**), same logarithm (a port of pure-Go math.log,
// never Math.log), same arithmetic order. Three layers are asserted here:
//
//   1. PRNG vectors  — SplitMix64 state for seeds 42 and 0, the first five
//      next()/uniform() values for seed 42, first outputs for seeds 0, 1 and
//      2^64-1 (wrapping in the seeding addition).
//   2. log vectors   — thirteen bit patterns. The `3.0` row is the witness:
//      glibc/V8 give 1.0986122886681098, the port gives ...096. If a runtime
//      log leaks onto the SSA path this row fails.
//   3. fixture replay — every double of times, values, stddev and final in
//      parity/ssa/*.json (chain, sir, dimer, gates, coffeeshop) compared with
//      `!==` (never a tolerance), plus the structural invariants
//      final[p] === values[p][S-1], the place set equals the model's, and
//      times.length === samples.
//
// The goldens are consumed here, not produced: go-pflow's cmd/ssa-goldens
// writes them to go-pflow/stochastic/testdata/portable/ (branch
// discrete-stochastic) and they are copied byte-identical into parity/ssa/
// (README.md names the generating commit and the sha256 of every copy). They
// are never regenerated to make a test pass.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import chain from "../parity/ssa/chain.json" with { type: "json" };
import sir from "../parity/ssa/sir.json" with { type: "json" };
import dimer from "../parity/ssa/dimer.json" with { type: "json" };
import gates from "../parity/ssa/gates.json" with { type: "json" };
import coffeeshop from "../parity/ssa/coffeeshop.json" with { type: "json" };
import timed from "../parity/ssa/timed.json" with { type: "json" };
import { combinations, compile, plog, simulate, splitmix64, Xoshiro256 } from "./petri-ssa.js";

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

// ── 1. PRNG ────────────────────────────────────────────────────────────────

Deno.test("splitmix64 state for seeds 42 and 0", () => {
  assertEquals(splitmix64(42n), [
    0xBDD732262FEB6E95n,
    0x28EFE333B266F103n,
    0x47526757130F9F52n,
    0x581CE1FF0E4AE394n,
  ]);
  assertEquals(splitmix64(0n), [
    0xE220A8397B1DCDAFn,
    0x6E789E6AA1B965F4n,
    0x06C45D188009454Fn,
    0xF88BB8A8724C81ECn,
  ]);
  // A plain number seed below 2^53 is accepted too (fixtures carry numbers).
  assertEquals(splitmix64(42), splitmix64(42n));
});

Deno.test("xoshiro256** first five outputs and uniforms for seed 42", () => {
  const raw = [
    0x15780B2E0C2EC716n,
    0x6104D9866D113A7En,
    0xAE17533239E499A1n,
    0xECB8AD4703B360A1n,
    0xFDE6DC7FE2EC5E64n,
  ];
  const uniforms = [
    0x3FB5780B2E0C2EC0n,
    0x3FD84136619B444En,
    0x3FE5C2EA66473C93n,
    0x3FED9715A8E0766Cn,
    0x3FEFBCDB8FFC5D8Bn,
  ];
  const a = new Xoshiro256(42n);
  for (let i = 0; i < 5; i++) assertEquals(a.next(), raw[i], `next()[${i}]`);
  const b = new Xoshiro256(42n);
  for (let i = 0; i < 5; i++) {
    const u = b.uniform();
    assertEquals(bitsOf(u), uniforms[i], `uniform()[${i}] = ${u}`);
    if (!(u >= 0 && u < 1)) throw new Error(`uniform out of [0,1): ${u}`);
  }
});

Deno.test("xoshiro256** first output for seeds 0, 1 and 2^64-1", () => {
  assertEquals(new Xoshiro256(0n).next(), 0x99EC5F36CB75F2B4n);
  assertEquals(new Xoshiro256(1n).next(), 0xB3F2AF6D0FC710C5n);
  assertEquals(new Xoshiro256(0xFFFFFFFFFFFFFFFFn).next(), 0x8F5520D52A7EAD08n);
});

// ── 2. Portable log ─────────────────────────────────────────────────────────

Deno.test("plog matches the thirteen spec bit patterns (3.0 proves the port is in use)", () => {
  const rows: [number, bigint][] = [
    [0.5, 0xBFE62E42FEFA39EFn],
    [2.0, 0x3FE62E42FEFA39EFn],
    [0.1, 0xC0026BB1BBB55515n],
    [1e-300, 0xC085963447F87FB5n],
    [0.999999, 0xBEB0C6F82D74D230n],
    [3.0, 0x3FF193EA7AAD030An],
    [10.0, 0x40026BB1BBB55516n],
    [1.0, 0x0000000000000000n],
    [0.7071067811865476, 0xBFD62E42FEFA39EEn],
    [0.7071067811865475, 0xBFD62E42FEFA39F1n],
    [1.0000000000000002, 0x3CAFFFFFFFFFFFFFn],
    [0.9999999999999999, 0xBCA0000000000000n],
    [1e-9, 0xC034B927F32BFFB8n],
  ];
  for (const [x, want] of rows) {
    const got = plog(x);
    assertEquals(bitsOf(got), want, `plog(${x}) = ${got}, want ${hex64(want)}`);
  }
  // Special cases are total, as the spec requires.
  assertEquals(plog(Infinity), Infinity);
  assertEquals(plog(0), -Infinity);
  assertEquals(Number.isNaN(plog(-1)), true);
  assertEquals(Number.isNaN(plog(NaN)), true);
  // Subnormal path of frexp: exact scaling, then the same formula.
  assertEquals(Number.isFinite(plog(5e-324)), true);
});

// ── 3. Model semantics ──────────────────────────────────────────────────────

Deno.test("combinations multiplies then divides, once per i", () => {
  assertEquals(combinations(50, 2), 1225);
  assertEquals(combinations(1000, 20), 3.3948281130245768e41); // ~3.4e41, inside double range
  assertEquals(combinations(1, 2), 0);
  assertEquals(combinations(7, 0), 1);
  assertEquals(combinations(7, 1), 7);
});

Deno.test("compile preserves declaration order and derives capacity bounds", () => {
  const c = compile(coffeeshop.model as Any);
  assertEquals(c.places, coffeeshop.model.places.map((p: Any) => p.id));
  assertEquals(c.transitions.map((t: Any) => t.id), coffeeshop.model.transitions.map((t: Any) => t.id));
  // restock_* have no rate → 1.0; restock_coffee_beans outputs 500 into a place capped at 2000.
  const restock = c.transitions.find((t: Any) => t.id === "restock_coffee_beans")! as Any;
  assertEquals(restock.rate, 1.0);
  assertEquals(restock.caps, [[0, 500, 2000]]);
  // Editor-shaped aliases (source/target, inhibitTransition) map onto the same structure.
  const editor: Any = compile({
    places: [{ id: "p", initial: 3 }, { id: "q", initial: 0 }],
    transitions: [{ id: "t" }],
    arcs: [{ source: "p", target: "t" }, { source: "t", target: "q" }, { source: "q", target: "t", inhibitTransition: true, weight: 2 }],
  });
  assertEquals(editor.transitions[0].inputs, [[0, 1, true]]);
  assertEquals(editor.transitions[0].outputs, [[1, 1]]);
  assertEquals(editor.transitions[0].inhibits, [[1, 2]]);
});

Deno.test("compile accepts id-keyed objects only while no key is integer-like", () => {
  // String ids: Object.entries order is insertion order, so it matches the array form.
  const asArrays = compile({
    places: [{ id: "p", initial: 3 }, { id: "q", initial: 0 }],
    transitions: [{ id: "t1" }, { id: "t0" }],
    arcs: [{ from: "p", to: "t1" }, { from: "t1", to: "q" }, { from: "q", to: "t0" }, { from: "t0", to: "p" }],
  });
  const asObjects = compile({
    places: { p: { initial: 3 }, q: { initial: 0 } },
    transitions: { t1: {}, t0: {} },
    arcs: [{ from: "p", to: "t1" }, { from: "t1", to: "q" }, { from: "q", to: "t0" }, { from: "t0", to: "p" }],
  });
  assertEquals(asObjects, asArrays);

  // Integer-like keys: JS enumerates "10" before "2" before "b" whatever the
  // insertion order, so the object carries no declaration order and must be refused.
  const cases: [string, Any][] = [
    ["places", { places: { b: { initial: 1 }, "2": { initial: 1 }, "10": { initial: 1 } }, transitions: [{ id: "t" }], arcs: [] }],
    ["transitions", { places: [{ id: "p", initial: 1 }], transitions: { z: {}, "0": {} }, arcs: [] }],
  ];
  for (const [what, model] of cases) {
    let msg = "";
    try { compile(model); } catch (e) { msg = String((e as Error).message); }
    if (!msg.includes("integer-like")) throw new Error(`${what}: expected an integer-like-key error, got ${JSON.stringify(msg)}`);
  }
  // Non-canonical numeric strings are ordinary string keys and stay in insertion order.
  const padded: Any = compile({ places: { "01": { initial: 1 }, "1.0": { initial: 2 } }, transitions: [], arcs: [] });
  assertEquals(padded.places, ["01", "1.0"]);
});

Deno.test("compile rejects guards and non-token places rather than guessing", () => {
  let threw = false;
  try {
    compile({ places: [{ id: "p", initial: 1 }], transitions: [{ id: "t", guard: "x > 0" }], arcs: [] });
  } catch { threw = true; }
  assertEquals(threw, true, "guard");
  threw = false;
  try {
    compile({ places: [{ id: "p", initial: 1, kind: "data" }], transitions: [], arcs: [] });
  } catch { threw = true; }
  assertEquals(threw, true, "kind");
});

Deno.test("read, inhibitor and capacity gating follow the spec", () => {
  // read arc: t needs q >= 2 without consuming; inhibitor: t blocked while r >= 1;
  // capacity: t produces into s capped at 1.
  const model = {
    places: [{ id: "p", initial: 5 }, { id: "q", initial: 2 }, { id: "r", initial: 0 }, { id: "s", initial: 0, capacity: 1 }],
    transitions: [{ id: "t", rate: 1 }],
    arcs: [
      { from: "p", to: "t" },
      { from: "q", to: "t", type: "read", weight: 2 },
      { from: "r", to: "t", type: "inhibitor" },
      { from: "t", to: "s" },
    ],
  };
  const res = simulate(model, { horizon: 100, samples: 3, realizations: 1, seed: 5 });
  // Exactly one firing: the second is blocked by s's capacity, so the marking
  // is dead after it and the final values are deterministic.
  assertEquals(res.final, { p: 4, q: 2, r: 0, s: 1 });
  assertEquals(res.series.p.stddev, undefined, "stddev only when realizations > 1");
  const inhibited = simulate({ ...model, places: [model.places[0], model.places[1], { id: "r", initial: 1 }, model.places[3]] },
    { horizon: 100, samples: 3, realizations: 1, seed: 5 });
  assertEquals(inhibited.final, { p: 5, q: 2, r: 1, s: 0 });
});

Deno.test("seed 0 is treated as seed 1 (mirrors go-pflow)", () => {
  const a = simulate(chain.model as Any, { ...chain.options, seed: 0 });
  const b = simulate(chain.model as Any, { ...chain.options, seed: 1 });
  expectArr(a.series.a.values, b.series.a.values, "seed0 vs seed1");
});

// ── 4. Fixture replay — the acceptance gate ─────────────────────────────────

const fixtures: Record<string, Any> = { chain, sir, dimer, gates, coffeeshop, timed };

for (const [name, fx] of Object.entries(fixtures)) {
  Deno.test(`parity/ssa/${name}.json replays bit-for-bit`, () => {
    const res = simulate(fx.model, fx.options);
    const S = fx.options.samples;

    assertEquals(res.times.length, S, "times.length === samples");
    expectArr(res.times, fx.expected.times, `${name}.times`);

    const modelPlaces = fx.model.places.map((p: Any) => p.id).sort();
    assertEquals(Object.keys(res.series).sort(), modelPlaces, "series place set");
    assertEquals(Object.keys(fx.expected.series).sort(), modelPlaces, "golden place set");
    assertEquals(Object.keys(res.final).sort(), modelPlaces, "final place set");

    for (const [place, want] of Object.entries(fx.expected.series) as [string, Any][]) {
      const got = res.series[place];
      expectArr(got.values, want.values, `${name}.${place}.values`);
      expectArr(got.stddev!, want.stddev, `${name}.${place}.stddev`);
      expectNum(res.final[place], fx.expected.final[place], `${name}.final.${place}`);
      expectNum(res.final[place], got.values[S - 1], `${name}.final.${place} === values[S-1]`);
    }
  });
}

Deno.test("spec §3.8 reference points (chain seed 42, sir seed 11, dimer seed 7)", () => {
  const c = simulate(chain.model as Any, chain.options);
  assertEquals(bitsOf(c.series.a.values[1]), 0x4041D55555555555n);
  assertEquals(bitsOf(c.series.a.stddev![1]), 0x400A660E223F1B70n);
  const s = simulate(sir.model as Any, sir.options);
  assertEquals(bitsOf(s.series.S.stddev![1]), 0x3FF52A7FA9D2F8EAn);
  assertEquals(s.final, { S: 9.625, I: 71.5, R: 918.875 });
  const d = simulate(dimer.model as Any, dimer.options);
  assertEquals(bitsOf(d.series.A.stddev![1]), 0x3FFA887293FD6F34n);
  assertEquals(d.final, { A: 23.5, B: 13.25 });
});

Deno.test("gates fixture reaches the read/inhibitor/non-kinetic/capacity branches", () => {
  const g = simulate(gates.model as Any, gates.options);
  // buf is capped at 5: the ensemble mean can never exceed the capacity.
  for (const v of g.series.buf.values) if (!(v <= 5)) throw new Error(`buf mean ${v} > capacity 5`);
  // src drains into done through produce → consume/pair.
  assertEquals(g.final.src, 0);
  assertEquals(g.final.done, 30);
  // key/toggle is a 1-token flip-flop: means stay in [0, 1] and sum to 1.
  for (let i = 0; i < g.times.length; i++) {
    const k = g.series.key.values[i], t = g.series.toggle.values[i];
    if (!(k >= 0 && k <= 1 && t >= 0 && t <= 1)) throw new Error(`key/toggle out of [0,1] at ${i}`);
    expectNum(k + t, 1, `key+toggle[${i}]`);
  }
});

Deno.test("timed fixture: delayed transitions are clocks, not races (§5)", () => {
  const r = simulate(timed.model as Any, timed.options);
  // Two baristas: the pool mean never exceeds the pool, and is below it while
  // brews are in flight.
  for (const v of r.series.barista.values) if (!(v >= 0 && v <= 2)) throw new Error(`barista mean ${v} out of [0,2]`);
  // Cooling only ever adds: the cooled count is nondecreasing on every grid.
  const cooled = r.series.cooled.values;
  for (let i = 1; i < cooled.length; i++) if (cooled[i] < cooled[i - 1]) throw new Error(`cooled fell at ${i}`);
  // Refusals match go-pflow: a negative delay and a delayed source are errors.
  let threw = false;
  try { compile({ places: [{ id: "a", initial: 1 }], transitions: [{ id: "t", delay: -1 }], arcs: [{ from: "a", to: "t" }] }); } catch { threw = true; }
  if (!threw) throw new Error("negative delay accepted");
  threw = false;
  try { compile({ places: [{ id: "b", initial: 0 }], transitions: [{ id: "t", delay: 1 }], arcs: [{ from: "t", to: "b" }] }); } catch { threw = true; }
  if (!threw) throw new Error("delayed source transition accepted");
});
