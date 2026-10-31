// The composition views' link to pflow-native's registry, in the vendored wasm
// (../petri-wasm.js newEngine). Every rule the page shows is decided here, by
// the registry's bundle.* and plan.* commands: which links are legal (pflow-
// compose's Bundle::validate plus the page rules PAGE_SAME_SUBNET and
// PAGE_DUPLICATE), the drag candidates, Flatten, the scenario runs, the lens
// test, and which plans pflow-rs accepts. The page re-implements none of them.
//
// Three engines, each with one job, so a query never disturbs what another
// holds open:
//
//   live    the composition and the plan the page shows (bundle.open, plan.open
//           and every edit). Neither is in session.dump_state, so a reload
//           re-opens them by command (state.js).
//   scratch questions about other configurations: the same instances with
//           another link set (a view comparing the previous links, the lens
//           test's repairs, a member on its own), and plans the page did not
//           open (a plan's canonical JSON, the default lists).
//   c4      the Connect-4 net (assets/connect-4.json) loaded as a document, for
//           the token game, the incidence matrix and runs on it (sim.*,
//           analysis.incidence).
//
// Results that store an artifact (bundle.flatten, .run, .lens, .validate,
// .verdicts) are cleared after the call: the page keeps the answer, not the
// engine.

import { newEngine } from '../petri-wasm.js';

const STORES_ARTIFACT = new Set(['bundle.flatten', 'bundle.run', 'bundle.lens', 'bundle.validate', 'bundle.verdicts', 'analysis.incidence', 'content.check']);

/** A refusal from the registry, with "[CODE] message; …" split into errors. */
export class Refusal extends Error {
  constructor(id, message) {
    super(message);
    this.command = id;
    this.errors = parseRefusal(message);
  }
}

/** "[E_X] a; [E_Y] b" → [{code, message}]; text without codes → one error with code null. */
export function parseRefusal(text) {
  const s = String(text || '');
  const parts = [];
  const re = /\[([A-Z0-9_]+)\]\s*/g;
  let m, last = null;
  while ((m = re.exec(s))) {
    if (last) parts.push({ code: last.code, message: s.slice(last.end, m.index).replace(/;\s*$/, '').trim() });
    last = { code: m[1], end: re.lastIndex };
  }
  if (last) parts.push({ code: last.code, message: s.slice(last.end).replace(/;\s*$/, '').trim() });
  return parts.length ? parts : [{ code: null, message: s }];
}

function wrap(eng, name) {
  return {
    name,
    version: eng.version,
    raw: eng,
    call(id, args = {}) {
      let out;
      try {
        out = eng.call(id, args);
      } catch (e) {
        throw new Refusal(id, String(e?.message || e));
      }
      if (STORES_ARTIFACT.has(id)) { try { eng.call('artifact.clear', {}); } catch { /* nothing stored */ } }
      return out;
    },
    /** call() that returns {ok, value} or {ok: false, error: Refusal} instead of throwing. */
    try(id, args = {}) {
      try { return { ok: true, value: this.call(id, args) }; } catch (e) { return { ok: false, error: e }; }
    },
    load(doc) { eng.load(doc); },
    commands() { return eng.commands(); },
  };
}

/** The page's engines, made once (init). */
export const engines = { live: null, scratch: null, c4: null, version: null };

/**
 * Make the three engines. Tests pass the wasm bytes (`bytes`). Resolves to
 * `engines`.
 * @param {{bytes?: BufferSource}} [o]
 */
export async function init(o = {}) {
  if (engines.live) return engines;
  const [a, b, c] = [await newEngine(o), await newEngine(o), await newEngine(o)];
  engines.live = wrap(a, 'live');
  engines.scratch = wrap(b, 'scratch');
  engines.c4 = wrap(c, 'c4');
  engines.version = a.version;
  return engines;
}

/** Forget the engines (tests: a fresh session per case). */
export function reset() {
  for (const k of ['live', 'scratch', 'c4']) {
    try { engines[k]?.raw.free(); } catch { /* freed */ }
    engines[k] = null;
  }
}

export const live = (id, args) => engines.live.call(id, args);
export const scratch = (id, args) => engines.scratch.call(id, args);
