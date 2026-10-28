// Runs every case of parity/native/game_goldens.json through a pflow-native
// wasm shim (the browser's build: wasm32-unknown-unknown, wasm-bindgen
// --target web) and compares each answer with native's, exactly: values,
// moves, node counts, errors.
//
//   node parity/native/wasm_game_check.mjs <wasm-shim dir> [goldens.json]
//
// <wasm-shim dir> is pflow-native's `make wasm-shim` output
// (target/wasm-shim). Run from the repository root. A case's marking is put
// on the net by writing it as the fixture's initial marking before `load`
// (the shim's public API has no "set marking"); native's generator sets the
// same marking on its session after loading, and game.* reads only the
// current marking. Exits 1 on any difference.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = resolve(process.argv[2] ?? "");
const goldensPath = process.argv[3] ?? "parity/native/game_goldens.json";
const glue = await import(pathToFileURL(resolve(dir, "pflow_native_wasm.js")));
glue.initSync({ module: readFileSync(resolve(dir, "pflow_native_wasm_bg.wasm")) });

const goldens = JSON.parse(readFileSync(goldensPath, "utf8"));
const fixtures = new Map();

function docAt(fixture, marking) {
  if (!fixtures.has(fixture)) fixtures.set(fixture, readFileSync(`parity/${fixture}`, "utf8"));
  const doc = JSON.parse(fixtures.get(fixture));
  const colours = Array.isArray(doc.token) ? Math.max(doc.token.length, 1) : 1;
  for (const [id, p] of Object.entries(doc.places)) {
    const m = marking[id];
    const v = m === undefined ? new Array(colours).fill(0) : Array.isArray(m) ? m : [m];
    p.initial = v;
  }
  return JSON.stringify(doc);
}

// Deep equality, numbers compared with ===, key order ignored.
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]));
}

let bad = 0, ode = 0;
const firstBad = [];
for (const c of goldens.cases) {
  if (JSON.stringify(c.args).includes('"ode"')) ode++;
  const eng = new glue.Engine();
  let got;
  try {
    eng.load(docAt(c.fixture, c.marking));
    const out = JSON.parse(eng.execute(c.tool, JSON.stringify(c.args)));
    delete out.artifact;
    got = { expect: out };
  } catch (e) {
    got = { error: String(e.message ?? e) };
  }
  eng.free();
  const want = c.error !== undefined ? { error: c.error } : { expect: c.expect };
  if (!same(got, want)) {
    bad++;
    if (firstBad.length < 10) firstBad.push({ name: c.name, got, want });
  }
}
console.log(`${goldens.cases.length} cases (${ode} name the ode estimate): ${bad} differ from native (${goldens.pflow_native.slice(0, 7)})`);
for (const b of firstBad) console.log(JSON.stringify(b));
process.exit(bad ? 1 : 0);
