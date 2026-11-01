// chyp-rs, run live in the browser, for the Laws view.
//
// What runs: chyp-rs (https://github.com/stackdump/chyp-rs, Apache-2.0), a Rust port of the core of Chyp
// (https://github.com/akissinger/chyp @3d28483, Apache-2.0, Copyright (C) 2022-2023 Aleks Kissinger), built to
// WebAssembly and vendored in vendor/chyp-rs-wasm/ (with its LICENSE.txt and NOTICE.txt), on the four theories in chyp/*.chyp.
// Its contract is to give Chyp's verdicts: chyp-rs's tests hold these theories to Chyp's own results, and
// laws-live_test.ts holds the vendored bundle to the exported ones. See chyp/README.md.
//
// Nothing here comes from another host. The engine is imported and instantiated on the first check() (app.js imports
// this view's module only when it is opened, and engine() below only runs then), and a failure leaves the view on its
// precomputed results. The page's other nine views never reach this file.
// parity/composition-views/load_budget_test.ts holds both facts.

/** What check() downloads, said before it starts (the lock's brotli size, plus the glue). */
export const DOWNLOAD_NOTE = 'about 90 KB, from this site';
export const CHYP_RS_URL = 'https://github.com/stackdump/chyp-rs';
const BASE = new URL('./chyp/', import.meta.url);

let enginePromise = null;

/**
 * One readable line for a failure: the last line of the message, the one that says what went wrong.
 */
export function explain(e) {
  const lines = String(e && e.message ? e.message : e).split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || 'unknown error';
  return last.length > 240 ? `${last.slice(0, 237)}…` : last;
}

async function engine(onStatus) {
  enginePromise ||= (async () => {
    const t0 = performance.now();
    onStatus?.(`loading chyp-rs (WebAssembly, ${DOWNLOAD_NOTE})…`);
    const chyp = await import('../vendor/chyp-rs-wasm/chyp_rs.js');
    await chyp.default();
    return { chyp, loadSeconds: (performance.now() - t0) / 1000 };
  })();
  enginePromise.catch(() => { enginePromise = null; });
  return enginePromise;
}

/**
 * chyp-rs's outline of a checked theory as the report the precomputed export carries for its rewrites
 * (CheckReport.to_dict(), as far as compare() reads it): {rewrites: [{name, status, steps: [{status, line}]}]}.
 *
 * The rules are chyp_headless's. A rewrite statement is its RewriteParts in a row, each starting where the last one
 * ended, under one name. A step is 'error' if Chyp logged a message on its line (or it was never decided), else its
 * status. A rewrite is 'valid' if every step is, 'error' if any step is, else 'invalid'.
 */
export function reportOf(outline) {
  const messages = new Map();
  for (const e of outline.errors) messages.set(e.line, [...(messages.get(e.line) || []), e.msg]);
  const rewrites = [];
  let prev = null;
  for (const p of outline.parts) {
    if (p.kind === 'RewritePart') {
      const said = messages.get(p.line) || [];
      const step = { line: p.line, status: said.length || !['valid', 'invalid'].includes(p.status) ? 'error' : p.status, messages: said };
      if (prev?.kind === 'RewritePart' && p.start === prev.end && p.name === prev.name) rewrites[rewrites.length - 1].steps.push(step);
      else rewrites.push({ name: p.name, line: p.line, steps: [step] });
    }
    prev = p;
  }
  for (const r of rewrites) {
    const st = r.steps.map((s) => s.status);
    r.status = st.every((s) => s === 'valid') ? 'valid' : st.includes('error') ? 'error' : 'invalid';
  }
  return { rewrites, errors: outline.errors };
}

/** Run a loaded chyp-rs module on one theory's source: its report. */
export function checkSource(chyp, source) {
  const session = new chyp.Session(source);
  try {
    return reportOf(JSON.parse(session.check_all()));
  } finally {
    session.free();
  }
}

/**
 * chyp-rs's check of each theory: {results: {theory: report}, upstream, loadSeconds, checkSeconds}.
 */
export async function check(theories, onStatus) {
  const { chyp, loadSeconds } = await engine(onStatus);
  const sources = await Promise.all(theories.map(async (t) => {
    const url = new URL(`${t}.chyp`, BASE);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.text();
  }));
  onStatus?.('checking every rewrite with chyp-rs…');
  const t0 = performance.now();
  const results = Object.fromEntries(theories.map((t, i) => [t, checkSource(chyp, sources[i])]));
  return { results, upstream: chyp.upstream_commit(), loadSeconds, checkSeconds: (performance.now() - t0) / 1000 };
}

/**
 * Compare a live check with the precomputed one, rewrite by rewrite and step
 * by step: {agree, total, differences: [text]}.
 */
export function compare(live, pre) {
  const differences = [];
  let total = 0;
  for (const [name, rep] of Object.entries(pre)) {
    const lv = live[name];
    if (!lv) { differences.push(`${name}: not checked live`); continue; }
    const byName = Object.fromEntries(lv.rewrites.map((r) => [r.name, r]));
    for (const r of rep.rewrites) {
      total++;
      const l = byName[r.name];
      if (!l) { differences.push(`${name}/${r.name}: missing live`); continue; }
      if (l.status !== r.status) { differences.push(`${name}/${r.name}: live ${l.status}, precomputed ${r.status}`); continue; }
      const ls = l.steps.map((s) => s.status).join(','), ps = r.steps.map((s) => s.status).join(',');
      if (ls !== ps) differences.push(`${name}/${r.name}: steps live [${ls}], precomputed [${ps}]`);
    }
    for (const l of lv.rewrites) if (!rep.rewrites.some((r) => r.name === l.name)) differences.push(`${name}/${l.name}: only live`);
  }
  return { agree: total - differences.filter((d) => !d.includes('only live')).length, total, differences };
}

/**
 * What the Laws view's background work (the data arriving, the live check finishing) may do to the
 * page. It outlives the view's drawing: the person may be in another view by then, with a drag or keyboard linking
 * in progress there. A redraw would cut that (a redraw is the current view's, not Laws'), and a "Laws: ..." line
 * spoken in the middle of it would be about something that is not on screen. So it speaks, and redraws, only
 * while Laws is the view shown. What it would have said away is kept (the latest only: the bar says the rest) and
 * given back once by arrive(), when Laws is drawn again; `defer` puts it after the view's own label, which the
 * page announces in the same render.
 * @param {{announce: (text: string) => void, defer?: (f: () => void) => void}} o
 */
export function createShownGate({ announce, defer = (f) => queueMicrotask(f) }) {
  let missed = null;
  return {
    /** Speak `text` if Laws is shown (`shown`), else keep it for arrive(). */
    say(shown, text) { if (shown) announce(text); else missed = text; },
    /** Laws has just been drawn: say what happened while it was away, once. */
    arrive() {
      if (missed === null) return;
      const text = missed;
      missed = null;
      defer(() => announce(text));
    },
    /** What is waiting (a test hook). */
    missed: () => missed,
  };
}
