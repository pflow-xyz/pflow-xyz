// Chyp's own checker, run live in the browser under Pyodide, for the Laws view.
//
// What runs: Chyp (https://github.com/akissinger/chyp @3d28483, Apache-2.0,
// Copyright (C) 2022-2023 Aleks Kissinger), its non-GUI modules vendored
// unmodified in chyp/py/chyp/, driven by the prototype's chyp_headless
// (chyp/py/chyp_headless/), on the four theories in chyp/*.chyp. See
// chyp/README.md for the licences.
//
// What is fetched from elsewhere, and why that is allowed here: Pyodide
// 314.0.7 from cdn.jsdelivr.net and lark 1.3.1 from PyPI (micropip), plus
// Pyodide's own cvxpy-base and clarabel packages for the layout. pflow.xyz sets
// no Content-Security-Policy on its pages and the editor already loads Ace from
// cdnjs (petri-view.js), so a third-party CDN is within the repo's practice.
// Nothing is loaded until the Laws view asks (it is opened: app.js imports this
// view's module only then, and Pyodide is imported inside pyodide() below, on the
// first check()), and a failure (offline, CDN blocked) leaves the view on its
// precomputed results. The page's other nine views never reach this file.
// parity/composition-views/load_budget_test.ts holds both facts.
//
// Two steps, each awaited separately so the view can show the first while the
// second runs:
//   check()   load_theory + check() on every theory: ~1 s after Pyodide loads;
//             returns CheckReport.to_dict() per theory.
//   layout()  export() with Chyp's convex_layout (cvxpy, CLARABEL): several
//             seconds more; returns the full export per theory, the same
//             document assets/chyp/<theory>.json holds.

export const PYODIDE_VERSION = '314.0.7';
/** About what the two steps download, said before they start (measured: docs/compose-load-budget.md). */
export const DOWNLOAD_NOTE = 'about 6.5 MB for Pyodide and lark, then about 18 MB more for the live layout (numpy, scipy, cvxpy-base, clarabel)';
export const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`;
export const LARK = 'lark==1.3.1';
const BASE = new URL('./chyp/', import.meta.url);

let pyPromise = null;

/**
 * One readable line for a failure. A failed fetch says what it fetched; a
 * Python error (micropip with PyPI blocked, say) arrives as the whole
 * traceback, of which the last line is the one that says what went wrong.
 */
export function explain(e) {
  const lines = String(e && e.message ? e.message : e).split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || 'unknown error';
  return last.length > 240 ? `${last.slice(0, 237)}…` : last;
}

async function pyodide(onStatus) {
  pyPromise ||= (async () => {
    const t0 = performance.now();
    onStatus?.(`loading Pyodide ${PYODIDE_VERSION} (cdn.jsdelivr.net, about 6.5 MB)…`);
    const { loadPyodide } = await import(/* @vite-ignore */ PYODIDE_URL);
    const py = await loadPyodide();
    onStatus?.('loading Chyp 3d28483 and the theories into Pyodide…');
    const list = await (await fetch(new URL('files.json', BASE))).json();
    const write = async (url, dst) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      py.FS.mkdirTree(dst.slice(0, dst.lastIndexOf('/')));
      py.FS.writeFile(dst, new Uint8Array(await r.arrayBuffer()));
    };
    await Promise.all([
      ...list.python.map((f) => write(new URL(`py/${f.path}`, BASE), f.path.startsWith('chyp/') ? `/chyp/${f.path}` : `/w/${f.path}`)),
      ...list.theories.map((t) => write(new URL(t, BASE), `/w/chyp/${t}`)),
    ]);
    onStatus?.(`installing ${LARK} (PyPI, micropip)…`);
    await py.loadPackage('micropip');
    await py.runPythonAsync(`import micropip\nawait micropip.install('${LARK}')`);
    await py.runPythonAsync(`
import os, sys
os.environ['CHYP_PATH'] = '/chyp'
sys.path.insert(0, '/w')
os.chdir('/w')
import chyp_headless as ch
`);
    return { py, loadSeconds: (performance.now() - t0) / 1000 };
  })();
  pyPromise.catch(() => { pyPromise = null; });
  return pyPromise;
}

/**
 * Chyp's check() on each theory: {results: {theory: CheckReport.to_dict()},
 * python, loadSeconds, checkSeconds}.
 */
export async function check(theories, onStatus) {
  const { py, loadSeconds } = await pyodide(onStatus);
  onStatus?.('checking every rewrite with Chyp…');
  const t0 = performance.now();
  const out = await py.runPythonAsync(`
import json, sys
json.dumps({'python': sys.version.split()[0], 'results': {f: ch.check(ch.load_theory(f'chyp/{f}.chyp')).to_dict() for f in ${JSON.stringify(theories)}}})
`);
  return { ...JSON.parse(out), loadSeconds, checkSeconds: (performance.now() - t0) / 1000 };
}

/** The packages Chyp's layout needs, besides the numpy and scipy they pull in. */
export const LAYOUT_PACKAGES = ['cvxpy-base', 'clarabel'];

const pep503 = (name) => String(name).toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Which of `wanted` Pyodide does not list as loaded (`pyodide.loadedPackages`: name -> channel). Needed
 * because loadPackage does not throw when a wheel is blocked or cannot be fetched: it logs a warning
 * per package and resolves.
 */
export function missingPackages(loadedPackages, wanted = LAYOUT_PACKAGES) {
  const have = new Set(Object.keys(loadedPackages || {}).map(pep503));
  return wanted.filter((w) => !have.has(pep503(w)));
}

/**
 * Why a live layout cannot be presented as the live result, or null. Two ways it silently becomes
 * something else: a package did not load (see missingPackages), or Chyp could not import cvxpy and
 * exported topology only (diagrams.layout.used is 'none', with a reason), which draws a different
 * structure. The text is what the page says, in plain words.
 * @param {{loadedPackages?: object, docs?: object}} o  py.loadedPackages, and the exports once there are some
 * @returns {string | null}
 */
export function layoutProblem({ loadedPackages, docs }) {
  const missing = missingPackages(loadedPackages);
  if (missing.length) return `${missing.join(' and ')} did not load: ${missing.length > 1 ? 'their files' : 'its file'} could not be fetched from cdn.jsdelivr.net`;
  if (docs) {
    const topologyOnly = Object.entries(docs).filter(([, d]) => d?.diagrams?.layout?.used !== 'chyp');
    if (topologyOnly.length) return `Chyp drew no coordinates: ${topologyOnly.map(([k, d]) => `${k} ${d?.diagrams?.layout?.reason || `(layout used: ${d?.diagrams?.layout?.used ?? 'unknown'})`}`).join('; ')}`;
  }
  return null;
}

/** The layout step on a loaded Pyodide `py`: throws, saying why, unless Chyp's own layout ran. */
export async function layoutOn(py, theories, onStatus) {
  onStatus?.('loading numpy, scipy, cvxpy-base and clarabel for Chyp\'s layout (about 18 MB)…');
  const t0 = performance.now();
  await py.loadPackage(LAYOUT_PACKAGES);
  const notLoaded = layoutProblem({ loadedPackages: py.loadedPackages });
  if (notLoaded) throw new Error(notLoaded);
  onStatus?.('laying the diagrams out with Chyp (convex_layout)…');
  const out = await py.runPythonAsync(`
import json
json.dumps({f: json.loads(ch.dumps(ch.export(ch.load_theory(f'chyp/{f}.chyp')))) for f in ${JSON.stringify(theories)}})
`);
  const docs = JSON.parse(out);
  const problem = layoutProblem({ loadedPackages: py.loadedPackages, docs });
  if (problem) throw new Error(problem);
  return { docs, layoutSeconds: (performance.now() - t0) / 1000 };
}

/** export() with Chyp's layout on each theory: {docs: {theory: export}, layoutSeconds}. */
export async function layout(theories, onStatus) {
  const { py } = await pyodide(onStatus);
  return layoutOn(py, theories, onStatus);
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
 * Compare two exported diagram sets number by number (the live layout against
 * the precomputed one): {numbers, maxDiff, shapeDiffers}.
 */
export function compareLayout(a, b) {
  let numbers = 0, maxDiff = 0, shapeDiffers = false;
  const walk = (x, y) => {
    if (typeof x === 'number' && typeof y === 'number') { numbers++; maxDiff = Math.max(maxDiff, Math.abs(x - y)); return; }
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) shapeDiffers = true; for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i]); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { for (const k of Object.keys(x)) if (k in y) walk(x[k], y[k]); else shapeDiffers = true; return; }
    if (x !== y && !(typeof x === 'string' && typeof y === 'string')) shapeDiffers = true;
  };
  walk(a, b);
  return { numbers, maxDiff, shapeDiffers };
}
