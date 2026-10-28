// crPow (petri-solver.js) against parity/crmath/pow.txt, a byte-identical
// copy of pflow-rs' tests/fixtures/crmath/pow.txt: every case bit for bit,
// the same check pflow-rs (native and wasm32) and go-pflow run on their ports.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { crPow, crPowSlow } from "./petri-solver.js";

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
const fromHex = (h: string) => { u64[0] = BigInt("0x" + h); return f64[0]; };
const hex = (x: number) => { f64[0] = x; return u64[0].toString(16).padStart(16, "0"); };
const same = (a: number, b: number) => hex(a) === hex(b) || (Number.isNaN(a) && Number.isNaN(b));

const cases = (await Deno.readTextFile(new URL("../parity/crmath/pow.txt", import.meta.url)))
  .trim().split("\n").map((l) => l.split(" ").map(fromHex));

Deno.test("crPow matches the shared corpus bit for bit", () => {
  if (cases.length < 13000) throw new Error(`corpus truncated: ${cases.length}`);
  const bad: string[] = [];
  let mathPowWrong = 0;
  for (const [x, y, want] of cases) {
    const got = crPow(x, y);
    if (!same(got, want)) bad.push(`crPow(${x} [${hex(x)}], ${y} [${hex(y)}]) = ${got}, want ${want}`);
    if (!same(Math.pow(x, y), want)) mathPowWrong++;
  }
  console.log(`Math.pow differs from the correctly rounded result on ${mathPowWrong} of ${cases.length} cases`);
  assertEquals(bad.slice(0, 20), []);
});

Deno.test("crPow's slow path matches the corpus", () => {
  for (const [x, y, want] of cases) {
    if (x > 0 && Number.isFinite(x) && x !== 1 && Number.isFinite(y) && y !== 0 && Number.isFinite(want) && want !== 0) {
      const got = crPowSlow(x, y);
      if (!same(got, want)) throw new Error(`crPowSlow(${x}, ${y}) = ${got}, want ${want}`);
    }
  }
});
