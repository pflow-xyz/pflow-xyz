// View 10: the composition laws, as Chyp checked them.
//
// What it draws. The four theory files in chyp/ (orderer-monoid, filter-meet,
// driver-wrap, sync-spiders) state composition laws as Chyp rules (ASSUMED:
// readings of the source lines each file cites) and then rewrites built from
// those rules (PROVED: Chyp's own checker checked every step, headless). The
// view reads what chyp_headless exported (assets/chyp/index.json and
// assets/chyp/<theory>.json) and the .chyp files themselves (chyp/<theory>.chyp,
// fetched for their comments; nothing in a comment box here is written by this
// view). When the view is opened in a browser it also runs Chyp's checker live
// under Pyodide (../laws-live.js) and compares the verdicts with the exported
// ones, then lays the diagrams out live and shows that layout; it always says
// which one is shown. It draws a rewrite the way Chyp's editor shows one
// (pflow-views-prototype docs/chyp-notes.md §4.4): one string diagram per term, left to right, inputs on the left and
// outputs on the right, boxes = generators (hyperedges), wires = vertices;
// each "=" carries the rule, its direction and Chyp's verdict. Where Chyp's
// matcher found the rule (diagrams.rewrites[].steps[].match, computed by
// chyp_headless with Chyp's own matcher), the matched part of the diagram
// before the step is highlighted; Chyp 3d28483 has that data but its own
// highlight is commented out (chyp/tactic/ruletac.py:41-48).
//
// Coordinates are Chyp's own (chyp.layout.convex_layout, exported by
// chyp_headless): box centres, layers, wire heights, and the routes wires take
// through Chyp's hidden identity boxes. Only box widths are widened here so the
// labels fit; ports stay on the box edges. Diagrams Chyp did not lay out (the
// live plan's chain and solver) are laid out with layout/hypergraph.js, which
// is adapted from Chyp (attribution in that file); wires use its wirePath,
// Chyp's tentacle cubic.
//
// Chyp: https://github.com/akissinger/chyp @3d28483, Copyright (C) 2022-2023
// Aleks Kissinger, Apache-2.0. No Chyp code is in this file. The port offsets
// (k/(n-1) - 0.5 units, chyp/gui/graphscene.py:151-170) and box sizes (1.1 x 0.8
// or 1.6 units, graphscene.py:29-31, 60-66) are restated from the prototype's
// docs/chyp-notes.md §3.
//
// The live plan and links come from the registry (ctx.plan: plan.state and
// plan.check; ctx.orders.flat: bundle.flatten); what the page says about them is
// what the registry says, never what a theory file's header says about its own
// date (those headers are quoted, as written, in the cards below).

import { layoutHypergraph, wirePath } from '../layout/hypergraph.js';
import { cite, citeLabel, citeURL } from '../sources.js';
import { chainOf, driversOf, fieldOrDefault, PLAN_LAWS_CITE, PLAN_DEFAULTS, PLAN_RS_REV, pieceByName } from '../model.js';
import { defaultLinks } from '../model.js';
import * as live from '../laws-live.js';
import { announce } from '../announce.js';

const THEORIES = ['orderer-monoid', 'filter-meet', 'driver-wrap', 'sync-spiders'];
const FOR_EXAMPLE = { connect4: ['orderer-monoid', 'filter-meet', 'driver-wrap'], orders: ['sync-spiders'] };
// The rewrite each theory opens on: the one the live state connects to.
const DEFAULT_RW = {
  'orderer-monoid': 'doc_chain_bracketing',
  'filter-meet': 'meet_repeat_absorbed',
  'driver-wrap': 'json_driver_order_irrelevant',
  'sync-spiders': 'fuse_L1_L2',
};

const rs = (path, a, b = a, note = '') => cite('pflowRs', `crates/pflow-metamodel/src/${path}`, a, b, note);
const go = (path, a, b = a, note = '') => cite('goPflow', path, a, b, note);
const road = (a, b = a, note = '') => cite('ontologyRoadmap', 'ROADMAP.md', a, b, note);

// Lines named in the .chyp files' own comments (and checked there); used for
// the convention panel. Per-rule cites are parsed from the files at run time.
const C = {
  orderKey: rs('order.rs', 250, 265, 'key(): one slot per piece in list order; before(): arrays compared lexicographically (orderer-monoid.chyp reads this as concatenation)'),
  planChain: rs('plan.rs', 196, 210, 'chain(): absent "order" is Chain::default(); a repeated piece is refused'),
  planDrivers: rs('plan.rs', 146, 194, 'drivers(): the list is read into two flags (driver-wrap.chyp)'),
  planFilters: rs('plan.rs', 222, 235, 'check() at c396d46, when filter-meet.chyp was written: every named filter refused (the file says PROPOSED); at the vendored pin plan.check decides'),
  fuse: go('metamodel/compose_fuse.go', 9, 20, 'fusion over equivalence classes: associative, a cycle is one class (sync-spiders.chyp)'),
  transClasses: go('metamodel/compose_flatten.go', 72, 88, 'transition classes: a union-find over event links'),
  roadSpider: road(410, 411, 'lk:event: draw it as a synchronising spider'),
};

// Colours. Wire types follow the page's palette: Order wires in the order-piece
// colour, Search in the driver colour, Filter in the filter colour, Value in the
// search Value colour; untyped Sync handles in RenderDOT's event-link green.
// Highlights use hues no wire type uses: a yellow marker under the matched part
// (plus Chyp's bold pen, width 3, on matched boxes: graphscene.py:80-83), violet
// for what a step inserted.
const HL = '#fab005';     // matched (the rule's left side, found by Chyp's matcher)
const HL_PEN = '#1b1e23';
const INS = '#7048e8';    // inserted (the rule's right side), shown on hover of "="
const VERDICT = { valid: '#1e7a46', invalid: '#c0392b', error: '#c47a12', assumed: '#6a717c' };
const DEFAULT_FILL = '#e3edf7';
const BOX_FONT = 11;
const SEPW = 132;

// --- module state ------------------------------------------------------------------

const DATA = { state: 'idle', index: null, th: {}, src: {}, sha: {}, err: null, promise: null };
// The live run (laws-live.js): idle → checking → checked → laying-out → live, or error.
const freshLive = () => ({ state: 'idle', status: '', cmp: null, python: null, t: {}, err: null, shown: 'precomputed', preCheck: null, focusText: false, retried: false });
const LIVE = freshLive();
const COMPOSE = new URL('../', import.meta.url); // public/compose/: the index's `source` paths are relative to it
const headless = (ctx) => !!ctx.headless || typeof Deno !== 'undefined' || typeof document === 'undefined';
const SEL = { orders: null, connect4: null }; // { theory, rw: {theory: name}, rule: {theory: name|null} }
// The data fetch and the live check finish whenever they finish, which may be while another view is shown (with a drag
// or keyboard linking going on there): they redraw and speak only while this view is, and the latest thing they
// would have said is said once when it is drawn again (laws-live.js createShownGate). The state stays in DATA and LIVE.
const gate = live.createShownGate({ announce });
const shown = (ctx) => (typeof ctx.shown === 'function' ? ctx.shown() : true);
const redraw = (ctx) => { if (shown(ctx)) ctx.rerender(); };
const say = (ctx, text) => gate.say(shown(ctx), text);
let lastWritten = null; // law|rw|rule as this view last wrote them into the hash

// --- loading ------------------------------------------------------------------------

async function sha256(buf) {
  try {
    if (!globalThis.crypto || !crypto.subtle) return null;
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

function load(ctx) {
  if (DATA.state !== 'idle') return;
  DATA.state = 'loading';
  DATA.promise = (async () => {
    try {
      const r = await fetch(new URL('assets/chyp/index.json', COMPOSE));
      if (!r.ok) throw new Error(`assets/chyp/index.json: HTTP ${r.status}`);
      DATA.index = await r.json();
      await Promise.all(DATA.index.theories.map(async (t) => {
        const [j, buf] = await Promise.all([
          fetch(new URL(`assets/chyp/${t.file}`, COMPOSE)).then((x) => { if (!x.ok) throw new Error(`assets/chyp/${t.file}: HTTP ${x.status}`); return x.json(); }),
          // chyp/<theory>.chyp, vendored in public/compose/chyp/ (sha256 checked in provenance())
          fetch(new URL(t.source, COMPOSE)).then((x) => (x.ok ? x.arrayBuffer() : null)).catch(() => null),
        ]);
        DATA.th[t.name] = prepare(j);
        if (buf) {
          DATA.src[t.name] = parseChyp(new TextDecoder().decode(buf));
          DATA.sha[t.name] = await sha256(buf);
        }
      }));
      DATA.state = 'ready';
    } catch (e) {
      DATA.state = 'error';
      DATA.err = String(e && e.message ? e.message : e);
    }
  })();
  DATA.promise.then(() => redraw(ctx));
}

/**
 * The live check (browser only, once, when the view is first drawn with its
 * data): Chyp under Pyodide checks every theory, the verdicts are compared
 * with the exported ones, then the diagrams are laid out live and replace the
 * exported layout. Any failure leaves the precomputed display and says why.
 */
function startLive(ctx) {
  if (LIVE.state !== 'idle' || headless(ctx) || DATA.state !== 'ready') return;
  LIVE.state = 'checking';
  LIVE.preCheck = Object.fromEntries(Object.entries(DATA.th).map(([k, th]) => [k, th.check]));
  const status = (t) => { LIVE.status = t; paintLive(); };
  // After Retry the status line has focus and is read as it is: that is the one message, not a second one beside it.
  if (!LIVE.retried) say(ctx, `Laws: running Chyp's checker live in your browser. This fetches Pyodide from cdn.jsdelivr.net and lark from PyPI (${live.DOWNLOAD_NOTE}) and can take several seconds; the precomputed result is shown meanwhile.`);
  (async () => {
    try {
      const r = await live.check(THEORIES, status);
      LIVE.python = r.python;
      LIVE.t.load = r.loadSeconds; LIVE.t.check = r.checkSeconds;
      LIVE.cmp = live.compare(r.results, LIVE.preCheck);
      LIVE.state = 'checked';
      say(ctx, LIVE.cmp.differences.length ? `Laws: the live check differs from the precomputed one (${LIVE.cmp.differences.length} differences). Laying the diagrams out live.` : `Laws: the live check agrees with the precomputed one (${LIVE.cmp.agree} of ${LIVE.cmp.total} rewrites). Laying the diagrams out live.`);
      redraw(ctx);
      LIVE.state = 'laying-out';
      const l = await live.layout(THEORIES, status);
      LIVE.t.layout = l.layoutSeconds;
      let numbers = 0, maxDiff = 0, shapeDiffers = false;
      for (const [k, doc] of Object.entries(l.docs)) {
        const pre = DATA.th[k];
        if (pre) {
          const c = live.compareLayout(doc.diagrams, pre.diagrams);
          numbers += c.numbers; maxDiff = Math.max(maxDiff, c.maxDiff); shapeDiffers ||= c.shapeDiffers;
          // In Pyodide chyp_headless cannot read the Chyp checkout's git commit or a
          // dist version (it is the vendored copy): say which one it is.
          doc.provenance.chyp = { ...pre.provenance.chyp, path: 'public/compose/chyp/py (vendored, unmodified)' };
        }
        doc.provenance.python_implementation = `CPython (Pyodide ${live.PYODIDE_VERSION})`;
        DATA.th[k] = prepare(doc);
      }
      LIVE.layoutCmp = { numbers, maxDiff, shapeDiffers };
      LIVE.shown = 'live';
      LIVE.state = 'live';
      say(ctx, 'Laws: the live layout is drawn.');
      redraw(ctx);
    } catch (e) {
      console.warn(e); // the page says one line (explain); the whole error, with a Python traceback, is for the console
      LIVE.err = live.explain(e);
      LIVE.state = LIVE.cmp ? 'layout-error' : 'error';
      say(ctx, `Laws: the live ${LIVE.cmp ? 'layout' : 'check'} did not run (${LIVE.err}); the precomputed result stays.`);
      redraw(ctx);
    }
  })();
}

let liveBox = null;
const fmt = (x) => (x == null ? '?' : `${x.toFixed(1)} s`);
function liveText() {
  const ix = DATA.index;
  const pre = `precomputed: chyp_headless export of ${ix?.generated_at || '?'} (Chyp ${String(ix?.chyp?.commit || '').slice(0, 7)}, CPython ${ix?.python}, lark ${ix?.lark}, cvxpy ${ix?.cvxpy})`;
  const cmp = LIVE.cmp ? (LIVE.cmp.differences.length ? `live check DIFFERS from the precomputed one: ${LIVE.cmp.differences.join('; ')}` : `live check agrees (${LIVE.cmp.agree}/${LIVE.cmp.total} rewrites, every step's verdict)`) : null;
  const t = `Pyodide ${live.PYODIDE_VERSION} + Python ${LIVE.python || '?'}: load ${fmt(LIVE.t.load)}, check ${fmt(LIVE.t.check)}${LIVE.t.layout != null ? `, layout ${fmt(LIVE.t.layout)}` : ''}`;
  switch (LIVE.state) {
    case 'idle': return [`Shown: ${pre}.`, 'lw-muted'];
    case 'checking': return [`Shown: ${pre}. Running Chyp live: ${LIVE.status}`, 'lw-muted'];
    case 'checked':
    case 'laying-out': return [`Shown: ${pre}. ${cmp} (${t}). Laying the diagrams out live: ${LIVE.status}`, LIVE.cmp.differences.length ? 'warn' : 'ok'];
    case 'live': {
      const lc = LIVE.layoutCmp;
      const lay = lc ? (lc.shapeDiffers ? 'the live layout\'s structure differs from the precomputed one' : lc.maxDiff === 0 ? `the live layout equals the precomputed one (${lc.numbers} numbers)` : `the live layout differs from the precomputed one by at most ${lc.maxDiff.toPrecision(3)} units over ${lc.numbers} numbers`) : '';
      return [`Shown: the live result (Chyp 3d28483 under ${t}); ${cmp}; the layout drawn is the live one: ${lay}.`, LIVE.cmp.differences.length || (lc && lc.shapeDiffers) ? 'warn' : 'ok'];
    }
    case 'layout-error': return [`Shown: ${pre}. ${cmp} (${t}). The live layout could not run (${LIVE.err}); the precomputed layout is the one shown.`, 'warn'];
    case 'error': return [`Shown: ${pre}. The live check did not run (${LIVE.err}): Pyodide loads from cdn.jsdelivr.net and lark from PyPI, so it needs the network.`, 'warn'];
    default: return [`Shown: ${pre}.`, 'lw-muted'];
  }
}
function paintLive() {
  if (!liveBox) return;
  const [text, cls] = liveText();
  liveBox.querySelector('.lw-livetext').textContent = text;
  liveBox.setAttribute('class', `lw-livebar ${cls}`);
}

/**
 * Run the live check again after it failed (offline, a CDN or PyPI blocked, a package that did not load):
 * a failure is not final, and leaving Laws and coming back would not retry it (startLive runs once per
 * page load). Everything the last run set is reset; Pyodide's own load clears itself on failure
 * (laws-live.js), so this fetches again.
 */
function retryLive(ctx) {
  Object.assign(LIVE, freshLive(), { focusText: true, retried: true });
  ctx.rerender();
}

function liveBar(ctx) {
  const [text, cls] = liveText();
  const canRetry = LIVE.state === 'error' || LIVE.state === 'layout-error';
  // data-a11y-key: the page gives focus back to the element that had it when the stage is redrawn (a11y.js keyOf), and the
  // status line is redrawn every time the check moves on.
  const line = ctx.el('span', { class: 'lw-livetext', tabindex: '-1', 'data-a11y-key': 'laws-live-status' }, text);
  liveBox = ctx.el('div', { class: `lw-livebar ${cls}` },
    line,
    canRetry ? ctx.el('button', { type: 'button', class: 'btn lw-retry', onclick: () => retryLive(ctx) }, 'Retry the live check') : null);
  // The button that was pressed is gone with the old bar: keyboard focus goes to the new status line, which says what is
  // happening (the bar itself is a group named for the inspector, which reads none of it).
  if (LIVE.focusText) { LIVE.focusText = false; queueMicrotask(() => line.isConnected && line.focus?.({ preventScroll: true })); }
  ctx.hover(liveBox, { title: 'which Chyp result is shown', definition: 'The page first shows the result chyp_headless exported under CPython (assets/chyp/). In a browser it then runs Chyp 3d28483 itself under Pyodide, compares every rewrite\'s and every step\'s verdict with the exported ones, and lays the diagrams out with Chyp\'s convex_layout (cvxpy, CLARABEL); once that finishes the live layout replaces the exported one.', facts: [['Pyodide', `${live.PYODIDE_VERSION} (${live.PYODIDE_URL})`], ['lark', `${live.LARK} (PyPI)`], ['Chyp', '3d28483, vendored unmodified in chyp/py/chyp (Apache-2.0)']], bib: ['chyp'] });
  return liveBox;
}

function prepare(j) {
  const th = j;
  th.file = (j.provenance?.source?.path || `chyp/${j.name}.chyp`).split('/').pop();
  th.genByName = Object.fromEntries(j.theory.gens.map((g) => [g.name, g]));
  th.ruleByName = Object.fromEntries(j.theory.rules.map((r) => [r.name, r]));
  th.letByName = Object.fromEntries((j.theory.lets || []).map((l) => [l.name, l]));
  th.ruleDiag = Object.fromEntries(j.diagrams.rules.map((r) => [r.name, r]));
  th.rwByName = Object.fromEntries(j.check.rewrites.map((r) => [r.name, r]));
  th.diagByName = Object.fromEntries(j.diagrams.rewrites.map((r) => [r.name, r]));
  th.types = new Set();
  for (const g of j.theory.gens) for (const w of [...g.domain, ...g.codomain]) th.types.add(w.type ?? null);
  return th;
}

// --- reading the .chyp file ---------------------------------------------------------

function parseChyp(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let h = 0;
  while (h < lines.length && lines[h].startsWith('#')) h++;
  const header = { from: 1, to: h, lines: lines.slice(0, h) };
  let p = 0;
  while (p < lines.length && lines[p].startsWith('#') && lines[p].trim() !== '#') p++;
  const title = lines.slice(0, p).map((l) => l.replace(/^#\s?/, '')).join(' ').trim();
  const notEq = [];
  lines.forEach((l, i) => {
    if (!/^#\s*(NOT (equational|modelled)|There is NO rule)/.test(l)) return;
    let k = i;
    while (k + 1 < lines.length && lines[k + 1].startsWith('#') && lines[k + 1].trim() !== '#') k++;
    notEq.push({ from: i + 1, to: k + 1, lines: lines.slice(i, k + 1) });
  });
  return { lines, header, title, notEq, sources: parseSources(header.lines) };
}

/** The comment block above a statement (1-based line), skipping sibling rules or gens/lets. */
function commentAbove(src, line, kind) {
  if (!src || !line) return null;
  const L = src.lines;
  let i = line - 2;
  if (kind === 'rule') while (i >= 0 && /^(rule|def)\s/.test(L[i])) i--;
  if (kind === 'rewrite') while (i >= 0 && (/^\s*$/.test(L[i]) || /^(gen|let)\s/.test(L[i]))) i--;
  const end = i;
  while (i >= 0 && L[i].startsWith('#')) i--;
  if (end <= i) return null;
  return { from: i + 2, to: end + 1, lines: L.slice(i + 1, end + 1) };
}

const stripHash = (lines) => lines.map((l) => l.replace(/^#\s?/, '')).join(' ').replace(/\s+/g, ' ').trim();

// file:line references inside comments ("order.rs:250-265", "plan.rs:146-194, 242-251").
const REF = /\b((?:[\w-]+\/)*[\w-]+\.(?:rs|go|md|js|py)):(\d+)(?:-(\d+))?((?:,\s*\d+(?:-\d+)?)*)/g;

function repoFor(file) {
  const base = file.split('/').pop();
  if (/^(order|plan|game)\.rs$/.test(base)) return { repo: 'pflowRs', path: `crates/pflow-metamodel/src/${base}` };
  if (/^(compose_\w+|compose|unionfind)\.go$/.test(base)) return { repo: 'goPflow', path: `metamodel/${base}` };
  if (base === 'ROADMAP.md') return { repo: 'ontologyRoadmap', path: 'ROADMAP.md' };
  return null; // Chyp's own files, this repo's files: named in text only
}

/** cite() objects for every file:line a comment block names (text-only refs dropped). */
function refsIn(text, note = '') {
  const out = [];
  for (const m of text.matchAll(REF)) {
    const r = repoFor(m[1]);
    if (!r) continue;
    out.push(cite(r.repo, r.path, Number(m[2]), Number(m[3] || m[2]), note));
    for (const extra of (m[4] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [a, b] = extra.split('-').map(Number);
      out.push(cite(r.repo, r.path, a, b || a, note));
    }
  }
  const seen = new Set();
  return out.filter((c) => { const k = citeLabel(c); if (seen.has(k)) return false; seen.add(k); return true; });
}

// The "Sources (read, not modified):" block of a header: "#   <repo> <path>[:lines] @rev ..."
// headings, then "#     <lines>[ or file:lines]  note" items under them.
const REPO_KEY = { 'pflow-rs': 'pflowRs', 'go-pflow': 'goPflow', 'ontology-pflow-xyz': 'ontologyRoadmap' };

function parseSources(lines) {
  const out = [];
  let cur = null, last = null;
  lines.forEach((raw, i) => {
    const line = i + 1;
    const head = raw.match(/^#\s{1,3}(pflow-rs|go-pflow|ontology-pflow-xyz|this repo)\s+(\S+)(.*)$/);
    if (head) {
      const tok = head[2].replace(/[,:]+$/, '');
      const [path, lines2] = tok.split(':');
      const rev = (head[3].match(/@(\w{7,})/) || [])[1] || null;
      cur = { repo: head[1], path, rev, line };
      last = null;
      const note = head[3].replace(/@\w{7,}/, '').replace(/^[\s:,(]+|[\s:)]+$/g, '').trim();
      if (lines2) { last = item(cur, path, lines2, note, line, rev); out.push(last); }
      return;
    }
    const sub = raw.match(/^#\s{4,}(?:([\w.]+\.(?:rs|go|md|js)):)?(\d+(?:-\d+)?)\s+(.+)$/);
    if (sub && cur) {
      const path = sub[1] ? (/\.(rs|go|md|js)$/.test(cur.path) ? cur.path : `${cur.path}/${sub[1]}`) : cur.path;
      last = item(cur, path, sub[2], sub[3].trim(), line, cur.rev);
      out.push(last);
      return;
    }
    const cont = raw.match(/^#\s{5,}(\S.*)$/);
    if (cont && last && !/^\d/.test(cont[1])) { last.note += ` ${cont[1].trim()}`; return; }
    if (/^#\s{0,3}\S/.test(raw) || /^#\s*$/.test(raw)) { cur = null; last = null; }
  });
  return out;
}

function item(cur, path, lines, note, line, rev) {
  const [a, b] = lines.split('-').map(Number);
  const key = REPO_KEY[cur.repo];
  let c = null;
  if (key) {
    const p = key === 'pflowRs' && !path.startsWith('crates/') ? `crates/pflow-metamodel/src/${path}` : path;
    c = cite(key, p, a, b || a, note);
  }
  return { repo: cur.repo, path, from: a, to: b || a, note, rev, line, cite: c };
}

// --- selection (per example; deep-linkable via #law=<theory>&rw=<rewrite>|&rule=<rule>) --

function hashParams() { return new URLSearchParams(location.hash.slice(1)); }
function writeSel(sel) {
  const h = hashParams();
  h.set('law', sel.theory);
  const rule = sel.rule[sel.theory];
  if (rule) { h.set('rule', rule); h.delete('rw'); } else { h.set('rw', sel.rw[sel.theory]); h.delete('rule'); }
  lastWritten = `${h.get('law')}|${h.get('rw')}|${h.get('rule')}`;
  const s = `#${h.toString()}`;
  if (location.hash !== s) history.replaceState(null, '', s);
}

function selection(ctx) {
  const ex = ctx.example;
  if (!SEL[ex]) SEL[ex] = { theory: FOR_EXAMPLE[ex][0], rw: {}, rule: {} };
  const sel = SEL[ex];
  // The hash wins only when someone else changed it (a link, an edited URL); after the
  // example buttons it still holds what this view wrote for the other example.
  const h = hashParams();
  const law = h.get('law');
  if (law && `${law}|${h.get('rw')}|${h.get('rule')}` !== lastWritten) {
    if (DATA.th[law]) {
      sel.theory = law;
      const th = DATA.th[law];
      const rule = h.get('rule'), rw = h.get('rw');
      if (rule && th.ruleDiag[rule]) sel.rule[law] = rule;
      else if (rw && th.diagByName[rw]) { sel.rw[law] = rw; sel.rule[law] = null; }
    }
  }
  const th = DATA.th[sel.theory];
  if (!sel.rw[sel.theory] || !th.diagByName[sel.rw[sel.theory]]) sel.rw[sel.theory] = liveDefaultRewrite(ctx, sel.theory) || DEFAULT_RW[sel.theory] || th.check.rewrites[0]?.name;
  writeSel(sel);
  return sel;
}

/** For sync-spiders, open on the rewrite for the page's own link order. */
function liveDefaultRewrite(ctx, theory) {
  if (theory !== 'sync-spiders' || ctx.example !== 'orders') return null;
  const ev = namedEventLinks(ctx);
  const i1 = ev.findIndex((l) => l.L === 'L1'), i2 = ev.findIndex((l) => l.L === 'L2');
  if (i1 >= 0 && i2 >= 0) return i1 < i2 ? 'fuse_L1_L2' : 'fuse_L2_L1';
  return null;
}

function choose(ctx, sel, patch) {
  Object.assign(sel, patch.theory ? { theory: patch.theory } : {});
  if ('rw' in patch) { sel.rw[sel.theory] = patch.rw; sel.rule[sel.theory] = null; }
  if ('rule' in patch) sel.rule[sel.theory] = patch.rule;
  writeSel(sel);
  ctx.rerender();
}

// --- geometry: Chyp's coordinates, or hypergraph.js ---------------------------------

const portOff = (k, n) => (n > 1 ? k / (n - 1) - 0.5 : 0);

/** Widen a box so its label fits: free sides first (no ports there), else both, capped. */
function fitBox(label, nIn, nOut, baseW, S, tw) {
  let size = BOX_FONT;
  const need = (sz) => tw(label, sz) + 10;
  let grow = Math.max(0, need(size) - baseW);
  let gl = 0, gr = 0, overflow = false;
  if (grow > 0) {
    if (nIn === 0 && nOut > 0) gl = grow;
    else if (nOut === 0 && nIn > 0) gr = grow;
    else {
      const cap = Math.max(0, 2.3 * S - baseW);
      while (grow > cap && size > 9) { size -= 0.5; grow = Math.max(0, need(size) - baseW); }
      if (grow > cap) { overflow = true; grow = cap; }
      gl = grow / 2; gr = grow / 2;
    }
  }
  return { gl, gr, size, overflow };
}

/** A Chyp graph (assets/chyp JSON) at S px per Chyp unit, in its own coordinates. */
function fromChyp(g, S, styles, tw) {
  if (!g.vertices.every((v) => Number.isFinite(v.x)) || !g.edges.every((e) => Number.isFinite(e.x))) {
    return fromSpec({
      boxes: g.edges.map((e) => ({ id: e.id, label: e.label, inputs: e.inputs, outputs: e.outputs, bg: styles[e.label]?.bg, fg: styles[e.label]?.fg, src: e })),
      inputs: g.inputs, outputs: g.outputs,
      types: Object.fromEntries(g.vertices.map((v) => [v.id, v.type ?? null])),
      layerOrder: g.layers && g.layers.length ? g.layers : null,
    }, S, tw, g);
  }
  const P = (x, y) => ({ x: x * S, y: y * S });
  const boxes = g.edges.map((e) => {
    const baseW = (e.w ?? 1.1) * S, h = (e.h ?? 0.8) * S;
    const f = fitBox(e.label, e.inputs.length, e.outputs.length, baseW, S, tw);
    const cx = e.x * S, cy = e.y * S;
    const left = cx - baseW / 2 - f.gl, right = cx + baseW / 2 + f.gr;
    const st = styles[e.label] || {};
    return {
      id: e.id, label: e.label, left, right, top: cy - h / 2, bottom: cy + h / 2, cy, size: f.size, overflow: f.overflow,
      bg: st.bg || DEFAULT_FILL, fg: st.fg || '#111', inputs: e.inputs, outputs: e.outputs, src: e,
      ins: e.inputs.map((_, k) => ({ x: left, y: cy + portOff(k, e.inputs.length) * S })),
      outs: e.outputs.map((_, k) => ({ x: right, y: cy + portOff(k, e.outputs.length) * S })),
    };
  });
  const prod = {}, cons = {};
  for (const b of boxes) {
    b.outputs.forEach((v, k) => { prod[v] = b.outs[k]; });
    b.inputs.forEach((v, k) => { cons[v] = b.ins[k]; });
  }
  const wires = g.vertices.map((v) => {
    const pts = [];
    const vp = P(v.x, v.y);
    if (prod[v.id]) { pts.push(prod[v.id]); if (vp.x > prod[v.id].x + 0.5) pts.push(vp); } else pts.push(vp);
    for (const r of v.route || []) pts.push(P(r[0], r[1]));
    if (cons[v.id]) pts.push(cons[v.id]);
    return { id: v.id, type: v.type ?? null, polylines: [pts], src: v };
  });
  const byId = Object.fromEntries(wires.map((w) => [w.id, w]));
  const inDots = g.inputs.map((vid, i) => ({ ...byId[vid].polylines[0][0], v: vid, i }));
  const outDots = g.outputs.map((vid, j) => { const pl = byId[vid].polylines[0]; return { ...pl[pl.length - 1], v: vid, j }; });
  return normalize({ boxes, wires, inDots, outDots, graph: g, layout: 'chyp', S }, tw);
}

/** A diagram Chyp did not lay out: layoutHypergraph (layout/hypergraph.js) at Chyp's proportions. */
function fromSpec(spec, S, tw, graph = null) {
  const widths = spec.boxes.map((b) => Math.max(1.1 * S, tw(b.label, BOX_FONT) + 10));
  const L = layoutHypergraph({
    boxes: spec.boxes.map((b, i) => ({ id: b.id, inputs: b.inputs, outputs: b.outputs, width: widths[i] })),
    inputs: spec.inputs, outputs: spec.outputs,
  }, {
    boxMinHeight: 0.8 * S, portPitch: 0.8 * S, rowGap: 0.2 * S, wireGap: S, gap: 1.6 * S, margin: 4,
    portOffsets: (k, n) => portOff(k, n) * S, layerOrder: spec.layerOrder || null,
  });
  const boxes = spec.boxes.map((b) => {
    const q = L.boxes[b.id];
    return {
      id: b.id, label: b.label, left: q.inX, right: q.outX, top: q.y - q.h / 2, bottom: q.y + q.h / 2, cy: q.y, size: BOX_FONT, overflow: false,
      bg: b.bg || DEFAULT_FILL, fg: b.fg || '#111', inputs: b.inputs, outputs: b.outputs, src: b.src || b, info: b.info, anim: b.anim,
      ins: q.inY.map((y) => ({ x: q.inX, y })), outs: q.outY.map((y) => ({ x: q.outX, y })),
    };
  });
  const wires = Object.entries(L.vertices).map(([id, v]) => ({ id, type: spec.types[id] ?? null, polylines: v.route ? [v.route] : v.paths, src: { id }, info: spec.wireInfo?.[id] }));
  const inDots = L.inputs.map((p, i) => ({ x: p.x, y: p.y, v: p.vertex, i }));
  const outDots = L.outputs.map((p, j) => ({ x: p.x, y: p.y, v: p.vertex, j }));
  return normalize({ boxes, wires, inDots, outDots, graph, layout: 'hypergraph.js', S }, tw);
}

/** Shift to the origin with a margin; compute width, height, boundary x's. */
function normalize(D, tw, pad = 8) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x, y) => { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); };
  for (const b of D.boxes) {
    take(b.left, b.top); take(b.right, b.bottom);
    if (b.overflow) { const lw = tw(b.label, b.size); const cx = (b.left + b.right) / 2; take(cx - lw / 2 - 3, b.cy); take(cx + lw / 2 + 3, b.cy); }
  }
  for (const w of D.wires) for (const pl of w.polylines) for (const p of pl) take(p.x, p.y);
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 40; y1 = 0; }
  if (y1 - y0 < 14) { const m = (y0 + y1) / 2; y0 = m - 7; y1 = m + 7; }
  const dx = pad - x0, dy = pad - y0;
  const mv = (p) => ({ ...p, x: p.x + dx, y: p.y + dy });
  for (const b of D.boxes) {
    b.left += dx; b.right += dx; b.top += dy; b.bottom += dy; b.cy += dy;
    b.ins = b.ins.map(mv); b.outs = b.outs.map(mv);
  }
  for (const w of D.wires) w.polylines = w.polylines.map((pl) => pl.map(mv));
  D.inDots = D.inDots.map(mv); D.outDots = D.outDots.map(mv);
  D.w = x1 - x0 + 2 * pad; D.h = y1 - y0 + 2 * pad;
  D.xL = D.inDots.length ? Math.min(...D.inDots.map((p) => p.x)) : null;
  D.xR = D.outDots.length ? Math.max(...D.outDots.map((p) => p.x)) : null;
  return D;
}

// --- drawing one diagram ------------------------------------------------------------

function typeColor(ctx, type) {
  const t = ctx.theme;
  return {
    Order: t.PIECE_KIND_COLOR.Order,
    Search: t.PIECE_KIND_COLOR.Driver,
    Filter: t.PIECE_KIND_COLOR.Filter,
    Value: t.SEARCH_TYPE_COLOR.Value,
  }[type] || (type == null ? t.LINK_STYLE.event.color : '#777');
}
const typeName = (type) => (type == null ? 'Sync (untyped in the file)' : type);

/**
 * opts: { hl: {edges, vertices} | null, hlStep, ins: {edges, vertices} | null, insStep,
 *         boxInfo(b), wireInfo(w), graphInfo, anim(b) }
 */
function drawDiagram(ctx, D, ox, oy, opts = {}) {
  const S = ctx.svg;
  const g = S('g', { class: 'lw-diag', transform: `translate(${r2(ox)},${r2(oy)})` });
  const bg = S('rect', { x: 0, y: 0, width: r2(D.w), height: r2(D.h), fill: 'transparent', class: 'lw-diag-bg' });
  if (opts.graphInfo) ctx.hover(bg, opts.graphInfo);
  g.append(bg);
  // Boundaries: Chyp draws no frame; a faint rule marks where the inputs and outputs sit.
  for (const x of [D.xL, D.xR]) if (x !== null) g.append(S('line', { x1: r2(x), y1: 4, x2: r2(x), y2: r2(D.h - 4), class: 'lw-bound' }));
  const vset = (m) => new Set(m ? m.vertices : []), eset = (m) => new Set(m ? m.edges : []);
  const layers = [['hl', opts.hl, opts.hlStep, HL], ['ins', opts.ins, opts.insStep, INS]];
  for (const [kind, m, step, col] of layers) {
    if (!m) continue;
    const vs = vset(m), es = eset(m);
    for (const w of D.wires) if (vs.has(w.id)) for (const pl of w.polylines) g.append(S('path', { d: wirePath(pl), class: `lw-${kind} lw-halo-w`, stroke: col, 'data-step': step }));
    for (const b of D.boxes) if (es.has(b.id)) g.append(S('rect', { x: r2(b.left - 4), y: r2(b.top - 4), width: r2(b.right - b.left + 8), height: r2(b.bottom - b.top + 8), rx: 4, class: `lw-${kind} lw-halo-b`, stroke: col, fill: col, 'data-step': step }));
  }
  for (const w of D.wires) {
    const col = typeColor(ctx, w.type);
    const hit = opts.hl && vset(opts.hl).has(w.id);
    for (const pl of w.polylines) {
      const d = wirePath(pl);
      g.append(S('path', { d, class: `lw-wire${hit ? ' lw-wire-hit' : ''}`, stroke: col }));
      const h = S('path', { d, class: 'lw-wire-hitarea' });
      if (opts.wireInfo) ctx.hover(h, opts.wireInfo(w));
      g.append(h);
    }
  }
  for (const b of D.boxes) {
    const bx = S('g', { class: 'lw-box' });
    bx.append(S('rect', { x: r2(b.left), y: r2(b.top), width: r2(b.right - b.left), height: r2(b.bottom - b.top), rx: 1.5, fill: b.bg }));
    const cx = (b.left + b.right) / 2;
    bx.append(S('text', { x: r2(cx), y: r2(b.cy + b.size * 0.36), 'text-anchor': 'middle', 'font-size': b.size, fill: b.fg, class: b.overflow ? 'lw-halo-text' : null }, b.label));
    if (opts.boxInfo) ctx.hover(bx, opts.boxInfo(b));
    if (opts.anim && opts.anim(b)) animateIn(bx);
    g.append(bx);
  }
  // Chyp's highlight pen (width 3, graphscene.py:80-83) over matched / inserted boxes
  for (const [kind, m, step, col] of [['hl', opts.hl, opts.hlStep, HL_PEN], ['ins', opts.ins, opts.insStep, INS]]) {
    if (!m) continue;
    const es = eset(m);
    for (const b of D.boxes) if (es.has(b.id)) g.append(S('rect', { x: r2(b.left), y: r2(b.top), width: r2(b.right - b.left), height: r2(b.bottom - b.top), rx: 1.5, class: `lw-${kind} lw-pen`, stroke: col, 'data-step': step }));
  }
  for (const p of D.inDots) g.append(S('circle', { cx: r2(p.x), cy: r2(p.y), r: 2.4, fill: typeColor(ctx, D.wires.find((w) => w.id === p.v)?.type), class: 'lw-dot' }));
  for (const p of D.outDots) g.append(S('circle', { cx: r2(p.x), cy: r2(p.y), r: 2.4, fill: typeColor(ctx, D.wires.find((w) => w.id === p.v)?.type), class: 'lw-dot' }));
  return g;
}

const r2 = (v) => Math.round(v * 100) / 100;
const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
function animateIn(node) {
  if (reduced() || !node.animate) return;
  node.style.transformBox = 'fill-box';
  node.style.transformOrigin = 'center';
  node.animate([{ opacity: 0, transform: 'translateY(-18px) scale(0.6)' }, { opacity: 1, transform: 'none' }], { duration: 750, easing: 'cubic-bezier(.2,.8,.2,1)' });
}

// --- inspector info ---------------------------------------------------------------------

function boxInfo(ctx, th, b, extra = {}) {
  const gen = th ? th.genByName[b.label] : null;
  const e = b.src || {};
  const piece = ctx.plan.pieceByName[b.label];
  const facts = [
    gen ? ['generator', `gen ${gen.name} : ${gen.signature}  (${th.file}:${gen.line})`] : ['generator', 'not a generator of the theory'],
    ['ports', `${(b.inputs || []).join(', ') || '∅'} → ${(b.outputs || []).join(', ') || '∅'}`],
    Number.isFinite(e.x) ? ['Chyp layout', `centre (${e.x}, ${e.y}), box ${e.w} × ${e.h} units (drawn wider to fit the label)`] : ['layout', 'layout/hypergraph.js (Chyp did not lay this diagram out)'],
    ...(extra.facts || []),
  ];
  return {
    title: `box ${b.label}${e.id ? ` (${e.id})` : ''}`,
    definition: gen ? `A generator: a hyperedge with ${gen.arity} input${gen.arity === 1 ? '' : 's'} and ${gen.coarity} output${gen.coarity === 1 ? '' : 's'} (Chyp graph.py EData).` : '',
    facts,
    note: piece ? `In ${th ? th.file : 'the theory'}, the generator ${b.label} stands for the one-piece chain [${b.label}] (or the driver of that name); the piece itself is plan.rs's.` : extra.note,
    cites: [...(piece ? piece.cites : []), ...(extra.cites || [])],
    bib: ['chyp'],
  };
}

function wireInfo(ctx, th, D, w, extra = {}) {
  const g = D.graph;
  const prod = D.boxes.find((b) => (b.outputs || []).includes(w.id));
  const cons = D.boxes.find((b) => (b.inputs || []).includes(w.id));
  const iIn = g ? g.inputs.indexOf(w.id) : D.inDots.findIndex((p) => p.v === w.id);
  const iOut = g ? g.outputs.indexOf(w.id) : D.outDots.findIndex((p) => p.v === w.id);
  return {
    title: `wire ${w.id}: ${typeName(w.type)}`,
    definition: 'A vertex of Chyp\'s hypergraph is a wire (graph.py VData): one producer on its left, one consumer on its right.',
    facts: [
      ['type', typeName(w.type)],
      ['from', prod ? `${prod.label} (${prod.id}) output ${prod.outputs.indexOf(w.id)}` : iIn >= 0 ? `left boundary, input ${iIn}` : '—'],
      ['to', cons ? `${cons.label} (${cons.id}) input ${cons.inputs.indexOf(w.id)}` : iOut >= 0 ? `right boundary, output ${iOut}` : '—'],
      w.src && w.src.route ? ['route', `through ${Math.ceil(w.src.route.length / 2)} hidden layer${w.src.route.length > 2 ? 's' : ''} (Chyp's identity boxes, layer_decomp, chyp/term.py:59-63)`] : null,
      ...(extra.facts || []),
    ].filter(Boolean),
    note: extra.note,
    cites: extra.cites || [],
    bib: ['chyp'],
  };
}

function ruleKind(th, name) {
  const r = th.ruleByName[name];
  if (r) return r.kind === 'def' ? 'def' : 'assumed';
  const rw = th.rwByName[name];
  // A rewrite used as a rule counts as proved only if Chyp checked it (and it is not a must-fail control).
  if (rw) return rw.status === 'valid' && rw.expected !== 'invalid' ? 'proved' : 'unproved';
  return 'unknown';
}

function ruleCites(th, src, name) {
  const r = th.ruleByName[name];
  if (r) { const c = commentAbove(src, r.line, 'rule'); return c ? refsIn(c.lines.join('\n'), `cited by ${th.file}:${c.from}-${c.to}`) : []; }
  return [];
}

function stepInfo(ctx, th, src, ck, dg, rwName) {
  const by = ck.by || {};
  const kind = by.rule ? ruleKind(th, by.rule) : null;
  const r = by.rule ? th.ruleByName[by.rule] : null;
  const m = dg && dg.match;
  return {
    title: `${th.file}:${ck.line}  = … by ${by.text || '?'}`,
    definition: verdictText(ck),
    facts: [
      ['before', ck.term_before],
      ['after', ck.term_after],
      ['tactic', by.tactic + (by.direction ? ` (${by.direction === 'converse' ? 'converse: the rule read right to left' : 'forward'})` : '')],
      r ? [r.kind === 'def' ? 'definition (assumed)' : 'rule (assumed, not checked)', `${r.text}  (line ${r.line})`] : null,
      kind === 'proved' ? ['rule', `${by.rule}: a rewrite proved earlier in ${th.file}, used as a rule`] : null,
      kind === 'unproved' ? ['rule', `${by.rule}: a rewrite in ${th.file} that Chyp did NOT check (${th.rwByName[by.rule].status}), used as a rule`] : null,
      ['Chyp says', `${ck.chyp_status}${ck.message ? `: ${ck.message}` : ''}`],
      m ? ['match (Chyp\'s matcher)', `before: ${m.before.edges.join(', ') || 'no boxes'} / ${m.before.vertices.join(', ')}; inserted: ${m.after.edges.join(', ') || 'no boxes'}; enumeration #${m.attempt}`] : ['match', dg && dg.match_reason ? dg.match_reason : 'none'],
      ck.flags && ck.flags.length ? ['flags', ck.flags.join(', ')] : null,
    ].filter(Boolean),
    note: 'The verdict is Chyp\'s: chyp.checker.check, run headless by chyp_headless. The highlight is the match Chyp\'s rule tactic accepted (replayed with Chyp\'s matcher); Chyp 3d28483 itself does not draw it (tactic/ruletac.py:41-48).',
    cites: ruleCites(th, src, by.rule),
    bib: ['chyp'],
  };
}

function verdictText(ck) {
  if (ck.status === 'valid') return 'Chyp: VALID. This step follows from the rule (one application, or simp to a common normal form).';
  if (ck.status === 'invalid') return 'Chyp: INVALID. The rule does not take the left term to the right one.';
  return `Chyp reported an error on this line${ck.message ? `: ${ck.message}` : ''}.`;
}

// --- the chain of a rewrite (or a rule's two sides) ------------------------------------

function wrapTerm(text, maxW, tw, size) {
  const parts = String(text).split(' ; ');
  const lines = [];
  let cur = '';
  const push = (s) => { if (s) lines.push(s); };
  parts.forEach((p, i) => {
    const piece = i < parts.length - 1 ? `${p} ;` : p;
    const cand = cur ? `${cur} ${piece}` : piece;
    if (tw(cand, size) <= maxW || !cur) cur = cand; else { push(cur); cur = piece; }
    while (tw(cur, size) > maxW && cur.includes(' * ')) { // split a long tensor
      const k = cur.lastIndexOf(' * ', Math.floor(maxW / (size * 0.61)));
      if (k <= 0) break;
      push(`${cur.slice(0, k)} *`); cur = cur.slice(k + 3);
    }
  });
  push(cur);
  return lines;
}

const monoW = (s, size) => String(s).length * size * 0.61;

/** Build the chain items (graphs and separators) at scale S. */
function chainItems(ctx, th, sel, S) {
  const styles = th.diagrams.styles || {};
  const tw = ctx.textWidth;
  const rule = sel.rule[sel.theory];
  const graphs = [], seps = [];
  const mk = (g, text, full) => {
    const D = fromChyp(g, S, styles, tw);
    const maxW = Math.max(D.w, 190);
    const lines = wrapTerm(text, maxW, monoW, 10.5);
    const letDef = th.letByName[text];
    const w = Math.max(D.w, ...lines.map((l) => monoW(l, 10.5) + 6), letDef ? monoW(`let, line ${letDef.line}`, 9.5) : 0);
    return { D, text, full, lines, letDef, w };
  };
  if (rule) {
    const rd = th.ruleDiag[rule], r = th.ruleByName[rule];
    graphs.push(mk(rd.lhs, r ? r.lhs : rd.lhs.term, rd.lhs.term), mk(rd.rhs, r ? r.rhs : rd.rhs.term, rd.rhs.term));
    seps.push({ kind: 'rule', rule: r || { name: rule, line: rd.line } });
    return { graphs, seps };
  }
  const name = sel.rw[sel.theory];
  const ck = th.rwByName[name], dg = th.diagByName[name];
  dg.steps.forEach((s, k) => {
    const c = ck.steps[k];
    if (k === 0) graphs.push(mk(dg.graphs[s.before], c.text_before, c.term_before));
    if (s.after === null || s.after === undefined) return;
    seps.push({ kind: 'step', ck: c, dg: s, k });
    graphs.push(mk(dg.graphs[s.after], c.text_after, c.term_after));
  });
  return { graphs, seps };
}

function flowRows(items, W) {
  const rows = [];
  let row = { units: [{ g: 0 }], w: items.graphs[0] ? items.graphs[0].w : 0 };
  items.seps.forEach((_, k) => {
    const uw = SEPW + items.graphs[k + 1].w;
    if (row.w + uw > W && row.units.length) { rows.push(row); row = { units: [], w: 0 }; }
    row.units.push({ s: k }, { g: k + 1 });
    row.w += uw;
  });
  rows.push(row);
  return rows;
}

function pickChain(ctx, th, sel, W) {
  const long = sel.theory !== 'sync-spiders';
  const cands = long ? [38, 36, 34, 32, 30] : [36, 34, 32, 30, 28, 26, 24, 22];
  let best = null;
  for (const S of cands) {
    const items = chainItems(ctx, th, sel, S);
    const rows = flowRows(items, W);
    best = { S, items, rows };
    if (rows.length <= 2 && rows.every((r) => r.w <= W)) return best;
  }
  return best;
}

/** The "by ..." lines over an "=": one rule, or a simp list wrapped to the separator. */
function sepLines(th, sep) {
  if (sep.kind !== 'step') return [''];
  const by = sep.ck.by || {};
  if (by.tactic === 'rule') return [`by ${by.direction === 'converse' ? '−' : ''}${by.rule}`];
  const t = by.text || by.tactic || '?';
  if (monoW(`by ${t}`, 11) <= SEPW - 6) return [`by ${t}`];
  const inner = t.replace(/^\w+\(|\)$/g, '');
  const parts = inner ? inner.split(/,\s*/) : [];
  const all = th.theory.rules.map((r) => r.name);
  if (parts.length > 2 && parts.length === all.length && all.every((n) => parts.includes(n))) return [`by ${by.tactic}(all ${parts.length}`, 'rules of the file)'];
  const lines = [`by ${by.tactic}(`];
  let cur = '';
  for (const p of parts) { const c2 = cur ? `${cur}, ${p}` : p; if (monoW(c2, 11) > SEPW - 8 && cur) { lines.push(`${cur},`); cur = p; } else cur = c2; }
  lines.push(`${cur})`);
  return lines.length <= 4 ? lines : [`by ${by.tactic}(${parts.length} rules:`, 'see the hover)'];
}

/** Half-heights a separator needs above and below its centre line. */
function sepNeed(th, sep) {
  const n = sepLines(th, sep).length;
  return Math.max(30 + n * 12, 54);
}

function drawSeparator(ctx, th, src, sep, x, y, h, chainG) {
  const S = ctx.svg;
  const g = S('g', { class: 'lw-sep', transform: `translate(${r2(x)},${r2(y)})` });
  const cx = SEPW / 2, cy = h / 2;
  const hit = S('rect', { x: 2, y: 0, width: SEPW - 4, height: h, rx: 6, class: 'lw-sep-hit' });
  g.append(hit);
  if (sep.kind === 'rule') {
    const r = sep.rule;
    g.append(S('text', { x: cx, y: cy - 22, class: 'lw-by' }, r.kind === 'def' ? `def ${r.name.replace(/_def$/, '')}` : `rule ${r.name}`));
    g.append(S('text', { x: cx, y: cy + 10, class: 'lw-eq', fill: VERDICT.assumed }, '='));
    g.append(S('text', { x: cx, y: cy + 30, class: 'lw-verdict', fill: VERDICT.assumed }, 'ASSUMED'));
    g.append(S('text', { x: cx, y: cy + 44, class: 'lw-line' }, `not checked · line ${r.line}`));
    const c = commentAbove(src, r.line, 'rule');
    ctx.hover(g, {
      title: `${r.kind === 'def' ? 'definition' : 'rule'} ${r.name} (ASSUMED)`,
      definition: r.text || '',
      facts: [['status', 'a premise: Chyp uses it, does not check it'], ['as the file explains it', c ? stripHash(c.lines) : '(no comment above it)']],
      cites: c ? refsIn(c.lines.join('\n'), `cited by ${th.file}:${c.from}-${c.to}`) : [],
      bib: ['chyp'],
    });
    return g;
  }
  const { ck, dg, k } = sep;
  const by = ck.by || {};
  const col = VERDICT[ck.status] || VERDICT.error;
  g.dataset.step = k;
  const kind = by.rule ? ruleKind(th, by.rule) : null;
  const byLines = sepLines(th, sep);
  const tag = by.tactic === 'rule'
    ? (by.direction === 'converse' ? 'converse · ' : '') + ({ assumed: 'assumed rule', def: 'definition', proved: 'proved above', unproved: 'NOT proved above', unknown: 'rule' }[kind])
    : by.tactic === 'simp' ? 'repeated rewriting' : by.tactic;
  const top = cy - 16 - (byLines.length - 1) * 12;
  byLines.forEach((t, i) => g.append(S('text', { x: cx, y: top - 12 + i * 12, class: 'lw-by' }, t)));
  g.append(S('text', { x: cx, y: top + byLines.length * 12 - 9, class: `lw-tag lw-tag-${kind || 'simp'}` }, tag));
  g.append(S('text', { x: cx, y: cy + 16, class: 'lw-eq', fill: col }, '='));
  const vt = ck.status === 'valid' ? '✓ VALID' : ck.status === 'invalid' ? '✗ INVALID' : '⚠ error';
  g.append(S('text', { x: cx, y: cy + 34, class: 'lw-verdict', fill: col }, vt));
  g.append(S('text', { x: cx, y: cy + 48, class: 'lw-line' }, `line ${ck.line}${dg.match ? '' : ' · no match drawn'}`));
  ctx.hover(g, stepInfo(ctx, th, src, ck, dg));
  g.addEventListener('pointerenter', () => { chainG.classList.add('lw-focus'); chainG.querySelectorAll(`[data-step="${k}"]`).forEach((n) => n.classList.add('lw-on')); });
  g.addEventListener('pointerleave', () => { chainG.classList.remove('lw-focus'); chainG.querySelectorAll('.lw-on').forEach((n) => n.classList.remove('lw-on')); });
  return g;
}

function chainSvg(ctx, th, src, sel, W) {
  const { S: scale, items, rows } = pickChain(ctx, th, sel, W);
  const S = ctx.svg;
  const lg = legend(ctx, th, sel, W, scale);
  const legendH = lg.h;
  const rowGap = 14;
  const dims = rows.map((r) => {
    const gs = r.units.filter((u) => u.g !== undefined).map((u) => items.graphs[u.g]);
    const ss = r.units.filter((u) => u.s !== undefined).map((u) => items.seps[u.s]);
    const diagH = Math.max(96, ...gs.map((x) => x.D.h), ...ss.map((sp) => 2 * sepNeed(th, sp)));
    const textH = Math.max(...gs.map((x) => x.lines.length * 13 + (x.letDef ? 12 : 0)));
    return { diagH, textH, h: diagH + textH + 12 };
  });
  const H = legendH + dims.reduce((a, d) => a + d.h + rowGap, 0);
  const svg = ctx.svgRoot(W, H, { class: 'view-svg lw-svg' });
  const chainG = S('g', { class: 'lw-chain' });
  svg.append(lg.g);
  // which step's match shows on which graph: graph k shows the step leaving it (k), and
  // on hover of "=" k, graph k+1 shows what step k inserted.
  const leaving = {}, entering = {};
  items.seps.forEach((s, k) => { if (s.kind === 'step' && s.dg.match) { leaving[k] = s.dg.match.before; entering[k + 1] = s.dg.match.after; } });
  let y = legendH;
  rows.forEach((row, ri) => {
    const d = dims[ri];
    let x = 0;
    for (const u of row.units) {
      if (u.s !== undefined) {
        chainG.append(drawSeparator(ctx, th, src, items.seps[u.s], x, y, d.diagH, chainG));
        x += SEPW;
        continue;
      }
      const it = items.graphs[u.g];
      const gx = x + (it.w - it.D.w) / 2, gy = y + (d.diagH - it.D.h) / 2;
      const isRule = !!sel.rule[sel.theory];
      const stepOut = items.seps[u.g], stepIn = items.seps[u.g - 1];
      const hlNow = !isRule && leaving[u.g] ? leaving[u.g] : null;
      const insNow = !isRule && entering[u.g] ? entering[u.g] : null;
      const role = isRule ? (u.g === 0 ? 'left-hand side' : 'right-hand side') : (u.g === 0 ? 'the rewrite\'s left term' : `after step ${u.g} (line ${stepIn?.ck?.line})`);
      chainG.append(drawDiagram(ctx, it.D, gx, gy, {
        hl: hlNow, hlStep: u.g, ins: insNow, insStep: u.g - 1,
        boxInfo: (b) => boxInfo(ctx, th, b, { facts: [[hlNow && hlNow.edges.includes(b.id) ? 'matched' : 'role', hlNow && hlNow.edges.includes(b.id) ? `by step ${u.g + 1} (${stepOut.ck.by.text}): part of the rule's ${stepOut.ck.by.direction === 'converse' ? 'right' : 'left'}-hand side` : role]] }),
        wireInfo: (w) => wireInfo(ctx, th, it.D, w, { facts: hlNow && hlNow.vertices.includes(w.id) ? [['matched', `by step ${u.g + 1} (${stepOut.ck.by.text})`]] : [] }),
        graphInfo: {
          title: `${role}: ${it.text}`,
          definition: it.full,
          facts: [
            ['boxes / wires', `${it.D.boxes.length} / ${it.D.wires.length}`],
            ['boundary', `${(it.D.graph?.inputs || []).length} in → ${(it.D.graph?.outputs || []).length} out`],
            ['layers (Chyp)', (it.D.graph?.layers || []).map((l) => `[${l.join(' ')}]`).join(' ') || '—'],
            ['layout', it.D.layout === 'chyp' ? `${th.diagrams.layout.engine}, ${scale} px per unit` : 'layout/hypergraph.js'],
            it.letDef ? ['let', `${it.letDef.name} = ${it.letDef.term} (line ${it.letDef.line})`] : null,
          ].filter(Boolean),
          bib: ['chyp'],
        },
      }));
      const tx = x + it.w / 2;
      it.lines.forEach((l, i) => chainG.append(S('text', { x: r2(tx), y: r2(y + d.diagH + 14 + i * 13), class: 'lw-term' }, l)));
      if (it.letDef) chainG.append(S('text', { x: r2(tx), y: r2(y + d.diagH + 14 + it.lines.length * 13), class: 'lw-let' }, `let, line ${it.letDef.line}`));
      x += it.w;
    }
    y += d.h + rowGap;
  });
  svg.append(chainG);
  return svg;
}

/** The chain's legend, wrapped onto more lines when it does not fit in W. Returns { g, h }. */
function legend(ctx, th, sel, W, scale) {
  const S = ctx.svg;
  const g = S('g', { class: 'lw-legend', transform: 'translate(0,8)' });
  const items = [...th.types].map((t) => ({
    label: `${typeName(t)} wire`, gap: 34,
    mark: (x, y) => S('line', { x1: x, y1: y + 6, x2: x + 22, y2: y + 6, stroke: typeColor(ctx, t), 'stroke-width': 2.2 }),
  }));
  if (!sel.rule[sel.theory]) {
    items.push({
      label: 'matched by the step to its right (Chyp\'s matcher; bold box = Chyp\'s highlight pen)', gap: 36,
      mark: (x, y) => S('rect', { x, y, width: 22, height: 12, rx: 3, fill: HL, 'fill-opacity': 0.45, stroke: HL_PEN, 'stroke-width': 2 }),
    }, {
      label: 'what a step inserted (hover its =)', gap: 36,
      mark: (x, y) => S('rect', { x, y, width: 22, height: 12, rx: 3, fill: INS, 'fill-opacity': 0.3, stroke: INS, 'stroke-width': 2 }),
    });
  }
  const LINE = 18;
  let x = 0, y = 0;
  for (const it of items) {
    const w = it.gap + ctx.textWidth(it.label, 11);
    if (x > 0 && x + w - 8 > W) { x = 0; y += LINE; }
    g.append(it.mark(x, y), S('text', { x: x + 27, y: y + 10 }, it.label));
    x += w;
  }
  const c = `Chyp coordinates · ${scale} px/unit`;
  if (x + ctx.textWidth(c, 11) + 8 > W) y += LINE;
  g.append(S('text', { x: W, y: y + 10, 'text-anchor': 'end', class: 'lw-muted' }, c));
  return { g, h: y + 26 };
}

// --- live state -------------------------------------------------------------------------

/** The page's event links with the L1/L2/L3 names sync-spiders.chyp:19-21 gives defaultLinks(). */
function namedEventLinks(ctx) {
  const ends = (l) => [`${l.from.subnet}:${l.from.port}`, `${l.to.subnet}:${l.to.port}`].sort().join('~');
  const names = Object.fromEntries(defaultLinks().map((l, i) => [ends(l), `L${i + 1}`]));
  return ctx.orders.links.filter((l) => l.kind === 'event').map((l) => ({ ...l, L: names[ends(l)] || null }));
}

function memberOf(ctx, ref) {
  const s = ctx.orders.byId[ref.subnet];
  const p = s && s.ports.find((q) => q.id === ref.port);
  return p && p.transition ? `${ref.subnet}/${p.transition}` : null;
}

function chainTerm(pieces) {
  const n = pieces.length;
  if (!n) return 'empty';
  if (n === 1) return pieces[0];
  const layers = [];
  for (let k = 1; k < n; k++) layers.push(['chain', ...Array(n - 1 - k).fill('id')].join(' * '));
  return `${pieces.join(' * ')} ; ${layers.join(' ; ')}`;
}

function chainSpec(ctx, th, pieces) {
  const styles = th.diagrams.styles || {};
  const boxes = [];
  const types = {};
  if (!pieces.length) { boxes.push({ id: 'empty', label: 'empty', inputs: [], outputs: ['w0'], bg: styles.empty?.bg }); types.w0 = 'Order'; return { boxes, inputs: [], outputs: ['w0'], types }; }
  pieces.forEach((p, i) => { boxes.push({ id: `p${i}`, label: p, inputs: [], outputs: [`w${i}`], bg: styles[p]?.bg, anim: true }); types[`w${i}`] = 'Order'; });
  let acc = 'w0';
  for (let i = 1; i < pieces.length; i++) { boxes.push({ id: `chain${i}`, label: 'chain', inputs: [acc, `w${i}`], outputs: [`c${i}`], bg: styles.chain?.bg }); types[`c${i}`] = 'Order'; acc = `c${i}`; }
  return { boxes, inputs: [], outputs: [acc], types };
}

function liveSvg(ctx, th, spec, opts = {}) {
  const S = 30;
  const D = fromSpec(spec, S, ctx.textWidth);
  const svg = ctx.svgRoot(Math.ceil(D.w), Math.ceil(D.h), { class: 'view-svg lw-live-svg' });
  // Shrinks to fit the card (CSS max-width), but not below 3/4 size: past that the holder scrolls.
  svg.style.minWidth = `${Math.ceil(D.w * 0.75)}px`;
  svg.append(drawDiagram(ctx, D, 0, 0, {
    boxInfo: (b) => (ctx.plan.pieceByName[b.label] ? { ...ctx.info.pieceInfo(b.label), facts: [...(ctx.info.pieceInfo(b.label).facts || []), ['in the Chyp theory', th.genByName[b.label] ? `gen ${b.label} : ${th.genByName[b.label].signature} (${th.file}:${th.genByName[b.label].line})` : '—']] } : boxInfo(ctx, th, b, { note: opts.note })),
    wireInfo: (w) => wireInfo(ctx, th, D, w, { note: 'Laid out by layout/hypergraph.js: this term is built from the page\'s live plan, so Chyp has no coordinates for it.' }),
    anim: (b) => b.anim && ctx.event && ctx.event.type === 'piece-added' && ctx.event.name === b.label,
    graphInfo: opts.graphInfo,
  }));
  return svg;
}

function liveCard(ctx, sel, th) {
  const E = ctx.el;
  const ex = ctx.example, t = sel.theory;
  const pick = (rw) => E('button', { class: 'lw-link', onclick: () => choose(ctx, sel, { rw }) }, rw);
  const card = (title, body, drawing, slotId) => {
    const c = E('div', { class: 'lw-live' }, E('div', { class: 'lw-live-title' }, E('b', {}, 'Live · '), title));
    const row = E('div', { class: 'lw-live-row' });
    if (drawing) {
      const holder = E('div', { class: 'lw-live-draw' }, drawing);
      if (slotId) { ctx.snap.slot(holder, slotId); holder.title = `drop a palette piece here: it goes into the ${slotId} slot if pflow-rs accepts the plan it makes (plan.slot_candidates)`; }
      row.append(holder);
    }
    row.append(E('div', { class: 'lw-live-text' }, ...body));
    c.append(row);
    return c;
  };

  if (ex === 'connect4' && t === 'orderer-monoid') {
    const plan = ctx.plan.plan;
    const c = chainOf(plan);
    const body0 = [];
    if (ctx.plan.error) body0.push(E('p', { class: 'warn' }, `pflow-rs refuses the plan (plan.check): ${ctx.plan.error}`));
    const term = chainTerm(c.pieces);
    const docLeft = th.letByName.doc_left, def = th.ruleByName.default_order_def;
    const body = [
      ...body0,
      E('p', {}, E('code', {}, `"order": ${plan.order ? JSON.stringify(plan.order) : '(absent)'}`), c.isDefault ? ` → pflow-rs's default chain ${JSON.stringify(c.pieces)} (Chain::default; read from plan.slot_candidates @${PLAN_RS_REV})` : ' → Chain::new keeps the list as given (order.rs:220-230 @c396d46)'),
      E('p', {}, 'Folded from the left, as a JSON parser would, it is the Chyp term ', E('code', { class: 'lw-wrap' }, term)),
    ];
    if (c.isDefault && def && term === def.rhs) body.push(E('p', { class: 'ok' }, '= default_order (def, line ', String(def.line), '): ', pick('default_append_empty'), ' proves that appending [] to it changes nothing.'));
    else if (docLeft && term === docLeft.term) body.push(E('p', { class: 'ok' }, '= doc_left (line ', String(docLeft.line), '), the plan.rs:8 doc chain: Chyp proved its bracketings agree (', pick('doc_chain_bracketing'), ', ', pick('doc_chain_balanced'), ') and that [] on either end changes nothing (', pick('doc_chain_append_empty'), ', ', pick('doc_chain_prepend_empty'), ').'));
    else if (!c.pieces.length) body.push(E('p', {}, '"order": [] is ', E('code', {}, 'empty'), ', the unit of chain (rules unitL, unitR). It is not the absent key, which is Chain::default() (pflow-views-prototype chyp/RESULTS.md, mismatch 3).'));
    else body.push(E('p', { class: 'lw-na' }, `Not the doc chain. assoc, unitL and unitR are stated for every chain, but Chyp checked bracketings of the plan.rs:8 doc chain only, not of this ${c.pieces.length}-piece chain.`));
    body.push(E('p', { class: 'lw-muted' }, 'The chain does not commute (', pick('NOT_chains_commute'), ' fails, as it must); its value does (', pick('value_ignores_order'), ', from the assumed rule order_only, order.rs:4-6). Drop an order piece on the drawing to extend the chain.'));
    return card('the current plan\'s order chain, as the term Chyp brackets', body, liveSvg(ctx, th, chainSpec(ctx, th, c.pieces), { graphInfo: { title: `the live chain: ${term}`, definition: 'Built from the live plan\'s "order" (plan.state; an absent list is pflow-rs\'s default chain), folded from the left like doc_left (orderer-monoid.chyp:78). Laid out by layout/hypergraph.js.', cites: [C.planChain, C.orderKey], bib: ['chyp'] } }), 'order');
  }

  if (ex === 'connect4' && t === 'driver-wrap') {
    const plan = ctx.plan.plan;
    const d = driversOf(plan);
    if (ctx.plan.error) return card('the current plan\'s drivers', [E('p', { class: 'warn' }, `pflow-rs refuses the plan (plan.check): ${ctx.plan.error}`)]);
    const list = plan.drivers;
    const sig = list === undefined || list === null ? 'absent' : list.map((x) => (typeof x === 'string' ? x : Object.keys(x)[0])).join(',');
    const constName = { absent: 'json_absent', 'null_window,budget': 'json_nw_budget', 'budget,null_window': 'json_budget_nw', null_window: 'json_nw', '': 'json_empty', budget: 'json_budget' }[sig];
    const budgets = (list || []).filter((x) => typeof x === 'object').map((x) => x.budget?.nodes);
    const docOrder = JSON.stringify(chainOf(plan).pieces) === JSON.stringify(['tt_best', 'immediate_win', 'centrality', 'history']);
    const spec = { boxes: [{ id: 'o', label: 'doc_order', inputs: [], outputs: ['a'], bg: th.diagrams.styles.doc_order?.bg }, { id: 'ab', label: 'alpha_beta', inputs: ['a'], outputs: ['s0'], bg: th.diagrams.styles.alpha_beta?.bg }], inputs: [], outputs: [], types: { a: 'Order', s0: 'Search' } };
    let acc = 's0';
    if (d.nullWindow) { spec.boxes.push({ id: 'nw', label: 'null_window', inputs: [acc], outputs: ['s1'], bg: th.diagrams.styles.null_window?.bg, anim: true }); spec.types.s1 = 'Search'; acc = 's1'; }
    if (d.budget !== null) { spec.boxes.push({ id: 'bd', label: 'budget', inputs: [acc], outputs: ['s2'], bg: th.diagrams.styles.budget?.bg, anim: true }); spec.types.s2 = 'Search'; acc = 's2'; }
    spec.outputs = [acc];
    const solverTerm = `core${d.nullWindow ? ' ; null_window' : ''}${d.budget !== null ? ' ; budget' : ''}`;
    const rule = constName ? Object.values(th.ruleByName).find((r) => r.lhs === constName) : null;
    const body = [
      E('p', {}, E('code', { class: 'lw-wrap' }, `"drivers": ${list ? JSON.stringify(list) : '(absent)'}`), ` → flags { null_window: ${d.nullWindow}, budget: ${d.budget ?? 'None'} } (as plan.rs:146-194 reads the list) → the solver `, E('code', {}, solverTerm), ', budget outermost (plan.rs:242-251, game.rs:593-597).'),
    ];
    if (constName && rule) {
      body.push(E('p', { class: 'ok' }, 'This list is the JSON text ', E('code', {}, constName), ` (line ${th.genByName[constName]?.line}); the assumed rule `, E('code', {}, rule.name), ` reads it as `, E('code', {}, rule.rhs), '.'));
      if (constName === 'json_nw_budget' || constName === 'json_budget_nw') body.push(E('p', {}, 'Chyp proved both JSON orders denote the same solver: ', pick('json_driver_order_irrelevant'), '; and that it is the doc plan: ', pick('doc_plan'), '.'));
      if (constName === 'json_absent' || constName === 'json_nw') body.push(E('p', {}, 'Chyp proved leaving "drivers" out equals ["null_window"]: ', pick('drivers_absent_is_null_window'), '.'));
      if (constName === 'json_empty') body.push(E('p', {}, '"drivers": [] is not the absent key: ', pick('NOT_empty_is_absent'), ' fails, as it must.'));
      if (budgets.some((n) => n !== 1000000)) body.push(E('p', { class: 'lw-na' }, `The theory's json_* constants are written for {"budget": {"nodes": 1000000}}; this plan's budget is ${budgets.join(', ')}. The flags reading is the same, but Chyp checked the 1,000,000 text only.`));
    } else body.push(E('p', { class: 'lw-na' }, 'No json_* constant in driver-wrap.chyp names this list, so no rewrite there covers it.'));
    if (!docOrder) body.push(E('p', { class: 'lw-na' }, 'core is doc_order ; alpha_beta, the doc chain; this plan\'s order chain is a different one, so the theory does not describe this exact plan.'));
    body.push(E('p', { class: 'lw-muted' }, 'null_window and budget do not commute in the theory (', pick('NOT_drivers_commute'), ' fails, as it must). Drop a driver on the drawing to change the list.'));
    return card('the current plan\'s drivers, as the solver driver-wrap reads them', body, liveSvg(ctx, th, spec, { graphInfo: { title: `the live solver: ${solverTerm}`, definition: 'Built from the live plan\'s "drivers" (plan.state), read into flags as plan.rs:146-194 does; the order of the boxes is game.rs\'s nesting (budget outermost), not the JSON order. Laid out by layout/hypergraph.js.', cites: [C.planDrivers], bib: ['chyp'] } }), 'drivers');
  }

  if (ex === 'connect4' && t === 'filter-meet') {
    const plan = ctx.plan.plan;
    const explicit = Array.isArray(plan.filters);
    const fs = fieldOrDefault(plan, 'filters');
    const named = fs.filter((f) => typeof f === 'string');
    const S = th.diagrams.styles || {};
    // all_moves alone for an empty list; else the filters met left to right (meet is
    // associative and commutative in the theory, so the bracketing is immaterial there).
    const spec = { boxes: [], inputs: [], outputs: [], types: {} };
    if (!named.length) { spec.boxes.push({ id: 'a', label: 'all_moves', inputs: [], outputs: ['f'], bg: S.all_moves?.bg }); spec.outputs = ['f']; spec.types.f = 'Filter'; }
    else {
      named.forEach((n, i) => { spec.boxes.push({ id: `p${i}`, label: n, inputs: [], outputs: [`w${i}`], bg: S[n]?.bg, anim: true }); spec.types[`w${i}`] = 'Filter'; });
      let acc = 'w0';
      for (let i = 1; i < named.length; i++) { spec.boxes.push({ id: `m${i}`, label: 'meet', inputs: [acc, `w${i}`], outputs: [`c${i}`], bg: S.meet?.bg }); spec.types[`c${i}`] = 'Filter'; acc = `c${i}`; }
      spec.outputs = [acc];
    }
    const term = named.length ? chainTerm(named).replace(/\bchain\b/g, 'meet') : 'all_moves';
    const inTheory = named.filter((n) => th.genByName[n]);
    const notInTheory = named.filter((n) => !th.genByName[n]);
    const status = named.map((n) => `${n}: ${pieceByName[n]?.status || 'unknown to plan.pieces'}`).join(', ');
    const body = [
      E('p', {}, E('code', {}, `"filters": ${explicit ? JSON.stringify(plan.filters) : '(absent)'}`),
        explicit ? '' : ` → pflow-rs's default ${JSON.stringify(PLAN_DEFAULTS.filters || [])} (read from plan.slot_candidates @${PLAN_RS_REV})`,
        ctx.plan.error ? E('span', { class: 'warn' }, ` — refused by pflow-rs (plan.check): ${ctx.plan.error}`) : ` — pflow-rs @${PLAN_RS_REV} accepts the plan (plan.check).`),
      named.length ? E('p', {}, `As the theory reads it: the meet of ${named.join(', ')} (${status}).`) : E('p', {}, 'No filter: the plan\'s filter is all_moves, the unit of meet. Chyp: ', pick('empty_filter_list'), ' (all_moves ; fallback = all_moves) and ', pick('meet_unit'), '.'),
    ];
    if (named.length) {
      if (notInTheory.length) body.push(E('p', { class: 'lw-na' }, `${notInTheory.join(', ')} ${notInTheory.length === 1 ? 'is' : 'are'} not a generator of filter-meet.chyp, so no rewrite there is about ${notInTheory.length === 1 ? 'it' : 'them'}.`));
      if (inTheory.length) body.push(E('p', {}, 'Chyp proved, for the theory\'s filters: all_moves is the unit (', pick('meet_unit'), ') and the order filters are listed in does not matter (', pick('filter_list_order_irrelevant'), ').'));
    }
    body.push(E('p', { class: 'lw-na' }, `filter-meet.chyp was written at pflow-rs c396d46, when no filter was built (its header, quoted below, says PROPOSED). At the vendored pin pflow-rs @${PLAN_RS_REV} decides which filters a plan may name (plan.check); the theory's rules are still readings of the ROADMAP's design, not of that code.`));
    return card('the current plan\'s filters', body, liveSvg(ctx, th, spec, { graphInfo: { title: `the live filter: ${term}`, definition: 'The live plan\'s filters (plan.state; an absent list is pflow-rs\'s default), met as filter-meet.chyp reads them (set model). Laid out by layout/hypergraph.js.', cites: [C.planFilters], bib: ['chyp'] } }), 'filters');
  }

  if (ex === 'orders' && t === 'sync-spiders') return liveOrders(ctx, sel, th, card, pick);

  if (ex === 'connect4') return card('no event links in a search plan', [E('p', { class: 'lw-na' }, 'sync-spiders.chyp is about the orders example\'s event links (transition fusion). A search plan has none, so there is nothing live to compare; switch to the orders example to see its event classes next to these laws.')]);
  return card('no search plan in the orders example', [E('p', { class: 'lw-na' }, `${t}.chyp is about the Connect-4 search plan (order chain, filters, drivers). The orders composition has none of these, so there is nothing live to compare; switch to the connect-4 example.`)]);
}

function liveOrders(ctx, sel, th, card, pick) {
  const E = ctx.el, S = ctx.svg;
  const flat = ctx.orders.flat;
  if (!flat.ok) return card('event classes', [E('p', { class: 'warn' }, `Flatten refused the links (${(flat.errors || []).map((e) => e.code).join(', ')}): no classes.`)]);
  const ev = namedEventLinks(ctx);
  const groups = Object.entries(flat.map.fusedGroups);
  const lastEv = ctx.event && ctx.event.type === 'link-added' && ctx.event.link.kind === 'event' ? ctx.event.link : null;
  const classes = groups.map(([name, members]) => {
    const links = ev.filter((l) => members.includes(memberOf(ctx, l.from)) && members.includes(memberOf(ctx, l.to)));
    return { name, members, links };
  });
  // drawing: one spider per class, its members on the left, classes stacked
  const rowH = 24, bw = 136, sxOff = 184, W = 330;
  const blocks = [];
  let yy = 6;
  for (const c of classes) { const h = Math.max(1, c.members.length) * rowH + 8; blocks.push({ y: yy, h }); yy += h + 10; }
  const H = Math.max(56, yy);
  const svg = ctx.svgRoot(W, H, { class: 'view-svg lw-live-svg' });
  const green = ctx.theme.LINK_STYLE.event.color;
  classes.forEach((c, ci) => {
    const x0 = 2, sx = x0 + sxOff, sy = blocks[ci].y + blocks[ci].h / 2;
    const g = S('g', { class: 'lw-spider' });
    c.members.forEach((m, i) => {
      const y = sy + (i - (c.members.length - 1) / 2) * rowH;
      const [sub, tid] = m.split('/');
      const s = ctx.orders.byId[sub];
      const leg = S('path', { d: ctx.curve(x0 + bw, y, sx, sy), stroke: green, 'stroke-width': 2, fill: 'none', class: 'lw-leg' });
      const legHit = S('path', { d: ctx.curve(x0 + bw, y, sx, sy), class: 'lw-wire-hitarea' });
      const via = c.links.filter((l) => memberOf(ctx, l.from) === m || memberOf(ctx, l.to) === m);
      ctx.hover(legHit, {
        title: `leg: ${m} in ${c.name}`,
        definition: 'A leg of the spider: this member transition fires as the class (sync-spiders.chyp: a Sync handle into m, out of n).',
        facts: [['member', m], ['event links on it', via.map((l) => `${l.L || 'link'} #${l.index}: ${l.from.subnet}:${l.from.port} ~ ${l.to.subnet}:${l.to.port}`).join('; ')], ['class (flat name)', c.name]],
        cites: [C.transClasses, C.fuse],
        bib: ['coecke-duncan', 'chyp'],
      });
      g.append(leg, legHit);
      const bx = S('g', { class: 'lw-member' }, S('rect', { x: x0, y: y - 10, width: bw, height: 20, rx: 2, fill: th.diagrams.styles.orders_dequeue?.bg || '#fde2c4', stroke: '#333', 'stroke-width': 1 }), S('text', { x: x0 + bw / 2, y: y + 4, 'text-anchor': 'middle', 'font-size': 11 }, m));
      if (s) ctx.hover(bx, { ...ctx.info.transitionInfo(s, tid), note: 'A member transition: a Sync handle None → Sync in sync-spiders.chyp (gens orders_dequeue, workers_acquire, payment_do_reserve for the default class).' });
      g.append(bx);
    });
    const ft = flat.model.transitions.find((t) => t.id === c.name);
    const dot = S('circle', { cx: sx, cy: sy, r: 9, fill: green, stroke: '#fff', 'stroke-width': 1.5, class: 'lw-spider-dot' });
    ctx.hover(dot, { ...(ft ? ctx.info.flatTransitionInfo(ft) : { title: c.name }), note: `One event class = one spider: link${c.links.length === 1 ? '' : 's'} ${c.links.map((l) => l.L || `#${l.index}`).join(', ')} fuse its ${c.members.length} members into one flat transition (bundle.flatten: pflow-compose's union-find, after compose_fuse.go:9-20). sync-spiders.chyp proves the spider laws that make this independent of link order.`, bib: ['coecke-duncan', 'chyp'] });
    g.append(dot);
    const lbl = c.links.map((l) => `${l.L || 'link'} #${l.index}`).join(', ');
    g.append(S('text', { x: sx + 15, y: sy - 3, 'font-size': 11, fill: green, 'font-weight': 600 }, `${c.members.length}-member class`));
    g.append(S('text', { x: sx + 15, y: sy + 11, 'font-size': 10.5, fill: '#555' }, lbl));
    svg.append(g);
    if (lastEv) {
      const a = memberOf(ctx, lastEv.from), b = memberOf(ctx, lastEv.to);
      if (c.members.includes(a) && c.members.includes(b) && !reduced() && dot.animate) {
        dot.style.transformBox = 'fill-box'; dot.style.transformOrigin = 'center';
        dot.animate([{ transform: 'scale(0.2)', opacity: 0.3 }, { transform: 'scale(1.5)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)' }], { duration: 800, easing: 'ease-out' });
        g.querySelectorAll('.lw-leg').forEach((p) => { const len = 220; p.style.strokeDasharray = len; p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 750, easing: 'ease-out' }); });
      }
    }
  });
  if (!classes.length) svg.append(S('text', { x: 4, y: H / 2 + 4, 'font-size': 12, fill: '#6a717c' }, 'No event links: every transition is its own class.'));

  const body = [E('p', {}, `Flatten's event classes now (bundle.flatten fused_groups): ${classes.length} fused, from ${ev.length} event link${ev.length === 1 ? '' : 's'} `, E('code', { class: 'lw-wrap' }, ev.map((l) => `${l.L || '?'}=#${l.index} ${l.from.subnet}:${l.from.port}~${l.to.subnet}:${l.to.port}`).join('  ')), '.')];
  const L = Object.fromEntries(ev.filter((l) => l.L).map((l) => [l.L, l]));
  for (const c of classes) {
    const names = c.links.map((l) => l.L);
    if (c.members.length === 3 && names.includes('L1') && names.includes('L2') && c.links.length === 2) {
      const first = L.L1.index < L.L2.index ? 'fuse_L1_L2' : 'fuse_L2_L1';
      ctx.emit('cover', first, {});
      body.push(E('p', { class: 'ok' }, `The 3-member class from L1 and L2 (in this order: ${L.L1.index < L.L2.index ? 'L1 then L2' : 'L2 then L1'}) is spider3: `, pick(first), '; the other order gives the same spider (', pick('link_order_irrelevant'), ', on the member transitions ', pick('orders_example_fused'), ').'));
    } else if (c.members.length === 2 && c.links.length === 1) {
      body.push(E('p', {}, `${c.links[0].L || 'This link'} is one link = m ; n, a 2-member class; linking it again, or back the other way, is still one class (`, pick('link_idempotent'), ', ', pick('cycle_one_class'), ').'));
    } else if (c.members.length === 3) {
      body.push(E('p', { class: 'lw-na' }, `A 3-member class from ${c.links.length} links: Chyp proved a~b, b~c = b~c, a~b on unnamed handles (`, pick('fusion_assoc'), '); this wiring may need comm/cocomm steps that were not checked for it.'));
    } else {
      body.push(E('p', { class: 'lw-na' }, `A ${c.members.length}-member class: sync-spiders.chyp proves 2- and 3-member cases only; this class is bundle.flatten's union-find, not a Chyp-checked rewrite.`));
    }
  }
  if (L.L3 && L.L1 && L.L2) ctx.emit('cover', 'L3_position_irrelevant', {});
  if (L.L3 && L.L1 && L.L2) body.push(E('p', {}, 'L3 is on other handles, so its place in the link list does not matter: ', pick('L3_position_irrelevant'), ' (simp(): the interchange law).'));
  body.push(E('p', { class: 'lw-muted' }, 'The classes are the registry\'s (bundle.flatten, pflow-compose\'s Flatten); drop the links in another order (bundle.clear_links, then drag them back) and the classes come back the same, which is what these laws say.'));
  return card('event links as spiders (the laws below are why the order of links does not matter)', body, svg, null);
}

// --- the page parts ------------------------------------------------------------------------

function theoryBar(ctx, sel) {
  const E = ctx.el;
  const ex = ctx.example;
  const mine = FOR_EXAMPLE[ex], other = THEORIES.filter((t) => !mine.includes(t));
  const tab = (name) => {
    const ix = DATA.index.theories.find((t) => t.name === name);
    const c = ix ? ix.counts : {};
    const src = DATA.src[name];
    const b = E('button', { class: `lw-tab${sel.theory === name ? ' active' : ''}${ix && !ix.ok ? ' bad' : ''}`, onclick: () => choose(ctx, sel, { theory: name }) },
      E('b', {}, name),
      E('span', { class: 'lw-count' }, `${c.intended_valid}/${c.intended} proved`),
      c.negative_controls ? E('span', { class: 'lw-count' }, `${c.negative_controls_failed}/${c.negative_controls} must-fail fail${c.negative_controls === 1 ? 's' : ''}`) : null);
    ctx.hover(b, { title: `${name}.chyp`, definition: src ? src.title : '', facts: Object.entries(c).map(([k, v]) => [k.replace(/_/g, ' '), v]), bib: ['chyp'] });
    return b;
  };
  return E('div', { class: 'lw-bar' },
    E('span', { class: 'lw-lab' }, ex === 'connect4' ? 'Search-plan theories:' : 'Event-link theory:'),
    ...mine.map((n) => { ctx.emit('theory', n, {}); return tab(n); }),
    E('span', { class: 'lw-bsep' }),
    E('span', { class: 'lw-lab' }, 'other:'),
    ...other.map(tab));
}

function provenance(ctx, th, name) {
  const E = ctx.el;
  const p = th.provenance;
  const ch = p.chyp;
  const ix = DATA.index.theories.find((t) => t.name === name);
  const sha = DATA.sha[name];
  const shaNote = sha === undefined ? ['source not fetched', 'warn']
    : sha === null ? ['sha256 not recomputed here (no WebCrypto)', 'lw-muted']
      : sha === p.source.sha256 ? ['matches the file served here', 'ok'] : ['DIFFERS from the file served here: the export is stale', 'warn'];
  return E('div', { class: 'lw-prov' },
    'Checked by ', E('a', { href: `${ch.url}/tree/${ch.commit}`, target: '_blank', rel: 'noopener' }, `Chyp ${ch.commit.slice(0, 7)}`),
    ` (v${ch.version}, ${ch.license}, ${ch.copyright}), headless through ${p.generator} on ${p.python_implementation} ${p.python}, lark ${p.lark}; `,
    th.diagrams.layout.used === 'chyp'
      ? `layout ${String(th.diagrams.layout.engine || 'chyp.layout').split(' ')[0]} with cvxpy ${p.cvxpy}/${p.layout_solver?.default_lp_solver || '?'}; `
      : `no Chyp layout in this export (${th.diagrams.layout.reason || th.diagrams.layout.used}): drawn with layout/hypergraph.js; `,
    `generated ${p.generated_at}. `,
    E('code', {}, `${p.source.path}`), ` sha256 ${p.source.sha256.slice(0, 12)}… `, E('span', { class: shaNote[1] }, shaNote[0]),
    ix && !ix.ok ? E('span', { class: 'warn' }, ' · index says NOT OK') : null);
}

function chips(ctx, th, src, sel) {
  const E = ctx.el;
  const cur = sel.rule[sel.theory] ? { rule: sel.rule[sel.theory] } : { rw: sel.rw[sel.theory] };
  const ruleChip = (r) => {
    const c = commentAbove(src, r.line, 'rule');
    const b = E('button', { class: `lw-chip lw-rule${cur.rule === r.name ? ' active' : ''}`, onclick: () => choose(ctx, sel, { rule: r.name }) }, r.kind === 'def' ? `def ${r.lhs}` : r.name);
    ctx.hover(b, { title: `${r.kind === 'def' ? 'definition' : 'rule'} ${r.name}: ASSUMED`, definition: r.text, facts: [['line', r.line], ['the file says', c ? stripHash(c.lines) : '—']], cites: c ? refsIn(c.lines.join('\n'), `cited by ${th.file}:${c.from}-${c.to}`) : [], bib: ['chyp'] });
    return b;
  };
  const rwChip = (r) => {
    const neg = r.expected === 'invalid';
    const ok = r.as_expected;
    const mark = r.status === 'valid' ? '✓' : r.status === 'invalid' ? '✗' : '⚠';
    ctx.emit('rewrite', r.name, { status: r.status });
    const b = E('button', { class: `lw-chip lw-rw ${r.status}${neg ? ' neg' : ''}${!ok ? ' unexpected' : ''}${cur.rw === r.name ? ' active' : ''}`, onclick: () => choose(ctx, sel, { rw: r.name }) },
      E('span', { class: 'lw-mark' }, mark), ` ${r.name}`, neg ? E('span', { class: 'lw-negtag' }, ok ? 'must fail: fails' : 'must fail: CHECKED') : null);
    const c = commentAbove(src, r.line, 'rewrite');
    ctx.hover(b, { title: `rewrite ${r.name}${neg ? ' (negative control)' : ''}`, definition: c ? stripHash(c.lines) : '', facts: [['Chyp', `${r.status.toUpperCase()}${neg ? `; expected to fail: ${ok ? 'as expected' : 'NOT as expected'}` : ''}`], ['steps', r.steps.map((s) => `${s.line}: ${s.by.text} ${s.status}`).join(' · ')]], bib: ['chyp'] });
    return b;
  };
  const rules = th.theory.rules;
  const rws = th.check.rewrites;
  return E('div', { class: 'lw-chips' },
    E('div', { class: 'lw-chiprow' }, E('span', { class: 'lw-lab lw-assumed' }, `Rules · ASSUMED, not checked (${rules.length}):`), ...rules.map(ruleChip)),
    E('div', { class: 'lw-chiprow' }, E('span', { class: 'lw-lab lw-proved' }, `Rewrites · PROVED by Chyp from those rules (${rws.filter((r) => r.expected !== 'invalid').length}${rws.some((r) => r.expected === 'invalid') ? ` + ${rws.filter((r) => r.expected === 'invalid').length} must-fail` : ''}):`), ...rws.map(rwChip)));
}

function chainHeader(ctx, th, src, sel) {
  const E = ctx.el;
  const rule = sel.rule[sel.theory];
  if (rule) {
    const r = th.ruleByName[rule];
    const c = commentAbove(src, r.line, 'rule');
    return E('div', { class: 'lw-head' },
      E('div', {}, E('b', {}, `${r.kind === 'def' ? 'def' : 'rule'} ${r.name}`), E('span', { class: 'lw-where' }, ` ${th.file}:${r.line}`), E('span', { class: 'lw-badge assumed' }, 'ASSUMED · Chyp uses it, does not check it')),
      c ? E('div', { class: 'lw-comment' }, ...commentWithLinks(ctx, th, c)) : null);
  }
  const name = sel.rw[sel.theory];
  const r = th.rwByName[name];
  const neg = r.expected === 'invalid';
  const c = commentAbove(src, r.line, 'rewrite');
  const nValid = r.steps.filter((s) => s.status === 'valid').length;
  const badge = neg
    ? E('span', { class: `lw-badge ${r.as_expected ? 'negok' : 'bad'}` }, r.as_expected ? `negative control: Chyp says ${r.status.toUpperCase()}, as the file requires` : `negative control CHECKED: the theory proves what it must not`)
    : E('span', { class: `lw-badge ${r.status}` }, r.status === 'valid' ? `✓ Chyp: VALID · ${nValid}/${r.steps.length} step${r.steps.length === 1 ? '' : 's'} checked` : `✗ Chyp: ${r.status.toUpperCase()}`);
  return E('div', { class: 'lw-head' },
    E('div', {}, E('b', {}, `rewrite ${name}`), E('span', { class: 'lw-where' }, ` ${th.file}:${r.line}`), badge),
    c ? E('div', { class: 'lw-comment' }, ...commentWithLinks(ctx, th, c)) : null);
}

/** A comment block's text with its file:line references linked (or named, for private / local files). */
function commentWithLinks(ctx, th, c) {
  const E = ctx.el;
  const text = stripHash(c.lines);
  const out = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    out.push(text.slice(last, m.index));
    const cs = refsIn(m[0]);
    const u = cs.length ? citeURL(cs[0]) : null;
    out.push(u ? E('a', { href: u, target: '_blank', rel: 'noopener', title: citeLabel(cs[0]) }, m[0]) : cs.length ? E('span', { class: 'lw-ref', title: citeLabel(cs[0]) }, m[0]) : m[0]);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  out.push(E('span', { class: 'lw-where' }, `  (${th.file}:${c.from}${c.to !== c.from ? `-${c.to}` : ''})`));
  return out;
}

function verbatim(ctx, src, from, to) {
  const E = ctx.el;
  const w = String(to).length;
  return E('pre', { class: 'lw-src' }, src.lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(w)}  ${l}`).join('\n'));
}

function cards(ctx, th, src, sel) {
  const E = ctx.el;
  if (!src) return E('p', { class: 'warn' }, `chyp/${th.name}.chyp did not load, so its comments cannot be shown.`);
  const out = E('div', { class: 'lw-cards' });
  // 1. what the file says is not equational
  const ne = E('div', { class: 'lw-card' }, E('h3', {}, `What ${th.file} says is NOT in the theory`));
  if (src.notEq.length) for (const b of src.notEq) ne.append(verbatim(ctx, src, b.from, b.to));
  else ne.append(E('p', { class: 'lw-muted' }, 'The file has no such comment block.'));
  ne.append(E('p', { class: 'lw-muted' }, 'Verbatim from the file. Chyp checks equations between diagrams; side conditions, data-dependent properties and order relations are outside it (no "<=" rules: state.py:272-273; pflow-views-prototype chyp/RESULTS.md, What did not work, 5).'));
  out.append(ne);
  // 2. the selected statement as written
  const rule = sel.rule[sel.theory];
  let a, b;
  if (rule) { const r = th.ruleByName[rule]; const c = commentAbove(src, r.line, 'rule'); a = c ? c.from : r.line; b = r.line; }
  else {
    const r = th.rwByName[sel.rw[sel.theory]];
    const c = commentAbove(src, r.line, 'rewrite');
    a = c ? c.from : r.line;
    b = Math.max(r.line, ...r.steps.map((s) => s.line));
  }
  out.append(E('div', { class: 'lw-card' }, E('h3', {}, `As written (${th.file}:${a}-${b})`), verbatim(ctx, src, a, b),
    E('p', { class: 'lw-muted' }, rule ? 'A rule is a premise. Chyp matches it in a diagram and replaces it (double pushout, chyp/rewrite.py:23-96); whether it is true of the code is the reading its comment cites.' : 'Each "= T by r" line is one step Chyp checked: rule r (or -r, its converse) applied once, at a match Chyp\'s matcher found, gives a diagram isomorphic to T (chyp/tactic/ruletac.py:32-50). simp(...) rewrites with the listed rules until nothing applies, then compares.')));
  // 3. the sources the file cites
  const sc = E('div', { class: 'lw-card' }, E('h3', {}, `What the rules are readings of (${th.file}'s Sources block)`));
  const ul = E('ul', { class: 'lw-cites' });
  for (const s of src.sources) {
    const u = s.cite ? citeURL(s.cite) : null;
    const label = `${s.repo} ${s.path}:${s.from}${s.to !== s.from ? `-${s.to}` : ''}${s.rev ? ` @${s.rev}` : ''}`;
    const li = E('li', {}, u ? E('a', { href: u, target: '_blank', rel: 'noopener' }, label) : E('span', { class: 'lw-ref', title: s.cite ? 'private repo: file and line only' : 'this repository' }, label), s.note ? E('span', { class: 'lw-muted' }, ` — ${s.note}`) : null);
    const linkRev = s.cite ? citeLabel(s.cite).split('@').pop() : null;
    if (s.cite && s.rev && s.rev !== linkRev) li.append(E('span', { class: 'lw-muted' }, ` (link @${linkRev}${s.repo === 'go-pflow' ? ': identical file, git diff --stat empty' : ''})`));
    if (s.cite) ctx.hover(li, { title: label, definition: s.note, facts: [['cited at', `${th.file}:${s.line}`], s.rev && s.rev !== linkRev ? ['revision', `the file cites @${s.rev}; the page links @${linkRev}${s.repo === 'go-pflow' ? ' (go-pflow files identical at both: git diff --stat 69257b3 c802f34 is empty for compose_fuse.go and compose_flatten.go)' : ''}`] : null].filter(Boolean), cites: [s.cite] });
    ul.append(li);
  }
  sc.append(src.sources.length ? ul : E('p', { class: 'lw-muted' }, 'No Sources block found.'));
  sc.append(E('p', { class: 'lw-muted' }, 'Parsed from the file\'s header. Chyp did not read these lines; a person did, and wrote the ASSUMED rules from them.'));
  out.append(sc);
  // 4. generators
  const gc = E('div', { class: 'lw-card' }, E('h3', {}, `Generators (${th.theory.gens.length})`));
  const gl = E('ul', { class: 'lw-gens' });
  for (const g of th.theory.gens) {
    const st = th.diagrams.styles[g.name] || {};
    const li = E('li', {}, E('span', { class: 'lw-swatch', style: { background: st.bg || DEFAULT_FILL } }), E('code', {}, `gen ${g.name} : ${g.signature}`), E('span', { class: 'lw-muted' }, ` line ${g.line}`));
    ctx.hover(li, boxInfo(ctx, th, { label: g.name, inputs: g.domain.map((_, i) => `in${i}`), outputs: g.codomain.map((_, i) => `out${i}`), src: {} }));
    gl.append(li);
  }
  gc.append(gl);
  out.append(gc);
  // 5. header
  out.append(E('details', { class: 'lw-card lw-wide' }, E('summary', {}, `Header comment of ${th.file} (lines ${src.header.from}-${src.header.to}): sources, reading, attribution`), verbatim(ctx, src, src.header.from, src.header.to)));
  return out;
}

// --- styles ----------------------------------------------------------------------------------

const STYLE = `
.lw-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 6px; }
.lw-lab { color: var(--muted); font-size: 12px; }
.lw-bsep { width: 1px; height: 22px; background: var(--line); margin: 0 4px; }
.lw-tab { font: inherit; border: 1px solid var(--line); background: #fff; border-radius: 7px; padding: 4px 10px; cursor: pointer; display: inline-flex; gap: 8px; align-items: baseline; }
.lw-tab b { font-weight: 600; }
.lw-tab .lw-count { font-size: 11px; color: var(--muted); }
.lw-tab.active { background: var(--ink); color: #fff; border-color: var(--ink); }
.lw-tab.active .lw-count { color: #d6dbe2; }
.lw-tab.bad { border-color: var(--bad); }
.lw-prov { font-size: 11px; color: var(--muted); margin: 0 0 8px; line-height: 1.5; }
.lw-prov code { font-size: 10.5px; }
.lw-live { background: #fff; border: 1px solid var(--line); border-left: 4px solid #2f6fb3; border-radius: 8px; padding: 6px 10px 8px; margin: 0 0 8px; }
.lw-live-title { font-size: 12.5px; margin-bottom: 4px; }
.lw-live-row { display: flex; gap: 14px; align-items: flex-start; }
.lw-live-draw { flex: 0 0 auto; max-width: 52%; overflow-x: auto; border-radius: 6px; padding: 2px; }
.lw-live-draw .view-svg { max-width: 100%; height: auto; }
.lw-live-text { flex: 1 1 auto; min-width: 0; font-size: 12px; }
.lw-live-text p { margin: 2px 0 4px; }
.lw-live-text code { font-size: 11px; }
.lw-wrap { overflow-wrap: anywhere; }
.lw-na { color: #8a5a0a; }
.lw-muted { color: var(--muted); }
.lw-retry { margin-left: 10px; }
.lw-link { font: 11px var(--font-mono); border: 1px solid #c9d3df; background: #f4f7fb; border-radius: 4px; padding: 0 4px; cursor: pointer; color: var(--accent); }
.lw-link:hover { border-color: var(--accent); }
.lw-chips { margin: 0 0 6px; }
.lw-chiprow { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 3px 0; }
.lw-chiprow .lw-lab { margin-right: 4px; font-weight: 600; }
.lw-assumed { color: #6a717c !important; }
.lw-proved { color: #1e7a46 !important; }
.lw-chip { font: 11.5px var(--font-mono); border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 2px 9px; cursor: pointer; }
.lw-chip.lw-rule { border-style: dashed; color: #4a525e; }
.lw-chip.lw-rw.valid .lw-mark { color: #1e7a46; }
.lw-chip.lw-rw.invalid .lw-mark, .lw-chip.lw-rw.error .lw-mark { color: #c0392b; }
.lw-chip.neg { background: #fbf6f5; }
.lw-chip .lw-negtag { font: 10px var(--font-sans); color: #8a5a0a; margin-left: 6px; }
.lw-chip.unexpected { border-color: var(--bad); }
.lw-chip.active { background: var(--ink); color: #fff; border-color: var(--ink); border-style: solid; }
.lw-chip.active .lw-mark, .lw-chip.active .lw-negtag { color: #fff; }
.lw-head { margin: 6px 0 2px; font-size: 13px; }
.lw-head b { font-family: var(--font-mono); font-size: 13px; }
.lw-where { color: var(--muted); font-family: var(--font-mono); font-size: 11px; }
.lw-badge { display: inline-block; margin-left: 10px; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 4px; }
.lw-badge.valid { background: #e3f3e8; color: #1e7a46; }
.lw-badge.invalid, .lw-badge.error, .lw-badge.bad { background: #fbe4e1; color: #b2342a; }
.lw-badge.negok { background: #fdf0dc; color: #8a5a0a; }
.lw-badge.assumed { background: #eef0f3; color: #4a525e; }
.lw-comment { font-size: 12px; color: #3d434c; margin: 3px 0 0; font-style: italic; }
.lw-comment a, .lw-ref { font-style: normal; font-family: var(--font-mono); font-size: 11px; }
.lw-ref { border-bottom: 1px dotted #999; }
.lw-svg { background: var(--paper); margin-top: 4px; }
.lw-svg text { font-family: var(--font-sans); }
.lw-legend text { font-size: 11px; fill: #3d434c; }
.lw-legend .lw-muted { fill: #8a919b; }
.lw-bound { stroke: #cfd4db; stroke-width: 1; stroke-dasharray: 2 3; }
.lw-wire { fill: none; stroke-width: 1.8; }
.lw-wire-hit { stroke-width: 2.6; }
.lw-wire-hitarea { fill: none; stroke: transparent; stroke-width: 10; }
.lw-box rect { stroke: #1b1e23; stroke-width: 1; }
.lw-pen { fill: none; stroke-width: 3; pointer-events: none; transition: opacity 0.15s; }
.lw-halo-text { paint-order: stroke; stroke: #fff; stroke-width: 3px; stroke-linejoin: round; }
.lw-halo-w { pointer-events: none; fill: none; stroke-width: 10; stroke-linecap: round; opacity: 0.55; transition: opacity 0.15s; }
.lw-halo-b { pointer-events: none; fill-opacity: 0.35; stroke-width: 3; stroke-opacity: 0.9; transition: opacity 0.15s; }
.lw-ins { opacity: 0; }
.lw-focus .lw-hl { opacity: 0.08; }
.lw-focus .lw-hl.lw-on { opacity: 1; }
.lw-focus .lw-halo-w.lw-hl.lw-on { opacity: 0.7; }
.lw-focus .lw-ins.lw-on { opacity: 1; }
.lw-focus .lw-halo-w.lw-ins.lw-on { opacity: 0.45; }
.lw-sep-hit { fill: transparent; }
.lw-sep:hover .lw-sep-hit { fill: #eef2f7; }
.lw-eq { font-size: 44px; font-weight: 700; text-anchor: middle; }
.lw-by { font-family: var(--font-mono) !important; font-size: 11px; text-anchor: middle; fill: #1b1e23; }
.lw-tag { font-size: 9.5px; text-anchor: middle; fill: #6a717c; }
.lw-tag-proved { fill: #1e7a46; }
.lw-tag-def { fill: #7b4cc2; }
.lw-tag-unproved { fill: #b2342a; font-weight: 700; }
.lw-verdict { font-size: 11.5px; font-weight: 700; text-anchor: middle; letter-spacing: 0.02em; }
.lw-line { font-size: 9.5px; text-anchor: middle; fill: #8a919b; }
.lw-term { font-family: var(--font-mono) !important; font-size: 10.5px; text-anchor: middle; fill: #2b2f36; }
.lw-let { font-size: 9.5px; text-anchor: middle; fill: #8a919b; }
.lw-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 8px; margin-top: 10px; }
.lw-card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; min-width: 0; }
.lw-card h3 { margin: 0 0 4px; font-size: 12.5px; }
.lw-card p { margin: 4px 0; }
.lw-wide { grid-column: 1 / -1; }
.lw-wide summary { cursor: pointer; font-weight: 600; }
.lw-src { background: #f6f7f9; border-radius: 4px; padding: 6px 8px; margin: 4px 0; white-space: pre; font-size: 10px; line-height: 1.45; max-height: 340px; overflow: auto; }
.lw-cites { margin: 2px 0; padding-left: 16px; font-size: 11px; }
.lw-cites li { margin: 2px 0; }
.lw-cites a, .lw-cites .lw-ref { font-family: var(--font-mono); font-size: 10.5px; }
.lw-gens { list-style: none; margin: 0; padding: 0; font-size: 11px; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 1px 12px; }
.lw-gens li { margin: 1px 0; overflow-wrap: anywhere; }
.lw-swatch { display: inline-block; width: 10px; height: 10px; border: 1px solid #333; margin-right: 6px; vertical-align: -1px; }
.lw-spider .lw-member rect { stroke: #333; }
.lw-loading { color: var(--muted); padding: 20px; }
.lw-livebar { font-size: 11.5px; margin: 2px 0 8px; padding: 4px 8px; border-left: 3px solid #cfd4db; background: #f6f7f9; border-radius: 3px; }
.lw-livebar.ok { border-left-color: #1e7a46; color: #1e5c39; }
.lw-livebar.warn { border-left-color: #c47a12; }
`;

// --- the view ----------------------------------------------------------------------------------

export default {
  id: 'laws',
  title: 'Composition laws (checked by Chyp)',
  short: 'Laws',
  convention: {
    summary: 'Each file in chyp/ states some composition laws as Chyp rules (ASSUMED: a person\'s reading of the source lines the file cites) and then rewrites built only from those rules (PROVED: Chyp\'s own checker checked every step, headless). A rewrite is drawn as Chyp\'s editor shows one: one string diagram per term, left to right, inputs on the left and outputs on the right; boxes are generators, wires are vertices, coloured by wire type. Each "=" names the rule that justifies the step (−r is the rule read right to left) and Chyp\'s verdict: ✓ VALID green, ✗ INVALID red. Where Chyp\'s matcher found the rule, the matched part of the diagram before the step is marked in yellow (matched boxes get Chyp\'s bold pen); hover an "=" to see, in violet, what it inserted. Coordinates are Chyp\'s own layout. Rules are dashed chips; click one to see its two sides.',
    examples: {
      connect4: 'orderer-monoid (order chains under chaining: a monoid), filter-meet (sound filters under intersection: PROPOSED, nothing built) and driver-wrap (drivers as Search → Search boxes after the core). The live card draws the current plan\'s order chain as the term being bracketed (or its drivers as the solver they denote), laid out with hypergraph.js, and says which Chyp rewrite covers it. Drop palette pieces on that drawing.',
      orders: 'sync-spiders: an event link is the spider m ; n on two Sync handles, and a connected set of links is one spider (special commutative Frobenius laws). The live card draws Flatten\'s event classes (fusedGroups) as spiders next to the rewrite that covers this link order.',
    },
    honesty: [
      'Chyp checks that each rewrite follows from the stated rules. It does not check the rules: they are readings of the order.rs, plan.rs, game.rs, compose_fuse.go and ROADMAP lines each file cites (listed under the drawing), and they are marked ASSUMED.',
      'Chyp 3d28483 has no rewriting modulo Frobenius and no nested boxes (pflow-views-prototype chyp/RESULTS.md, What did not work, 5). So spiders are explicit generators m, u, n, v with the Frobenius rules and every fusion is a chain of single steps; drivers are drawn as Search → Search boxes after the core, not as boxes around it. No "<=" rules: nothing about order relations is checked.',
      'A bare step never checks at 3d28483 (pflow-views-prototype chyp/RESULTS.md item 1), so the files have none; the one purely symmetric-monoidal fact (L3_position_irrelevant) is closed by simp(). sync-spiders.chyp is untyped (typed identities fail to compose at 3d28483, item 2); every wire there is a Sync handle.',
      'The live cards compare the page\'s plan and links with the instances Chyp checked. When they differ the card says so: the laws read the same, but that instance was not checked.',
      'Box widths are widened to fit their labels; box centres, layers and wire heights are Chyp\'s layout (cvxpy, CLARABEL), which can vary with the solver (pflow-views-prototype docs/chyp-notes.md §8.6). The match highlight is Chyp\'s matcher replayed by chyp_headless; Chyp 3d28483\'s GUI does not draw one (tactic/ruletac.py:41-48).',
    ],
    bib: ['chyp', 'coecke-duncan', 'fong-spivak'],
    cites: [C.orderKey, C.planChain, C.planDrivers, C.planFilters, PLAN_LAWS_CITE, C.fuse, C.transClasses, C.roadSpider],
  },

  /**
   * Resolves once the Chyp export is loaded. If this ctx's render() could only
   * say "loading", draw it now (the headless parity test awaits this; in the
   * page the load's own rerender does the same).
   */
  async ready(ctx) {
    load(ctx);
    await DATA.promise;
    if (ctx.lawsDrawn) return;
    ctx.root.replaceChildren();
    this.render(ctx);
  },

  render(ctx) {
    const E = ctx.el;
    ctx.root.append(E('style', {}, STYLE));
    load(ctx);
    if (DATA.state === 'loading' || DATA.state === 'idle') { ctx.root.append(E('p', { class: 'lw-loading' }, 'Loading the Chyp check results (assets/chyp/) and theory files (chyp/*.chyp)…')); return; }
    ctx.lawsDrawn = true;
    gate.arrive();
    startLive(ctx);
    if (DATA.state === 'error') { ctx.note(`Could not load the Chyp export: ${DATA.err}. Regenerate it with chyp_headless export (chyp_headless/README.md).`, 'warn'); return; }
    const sel = selection(ctx);
    const th = DATA.th[sel.theory];
    const src = DATA.src[sel.theory];
    ctx.note('Chyp checked every rewrite from its file\'s rules; it did not check the rules. Those (ASSUMED) are readings of the source lines each file cites. Chyp 3d28483 cannot rewrite modulo Frobenius or nest boxes, so spiders are explicit generators and drivers are boxes after the core (pflow-views-prototype chyp/RESULTS.md).', 'honesty');
    if (!th.check.ok) ctx.note(`${th.file}: the export says NOT OK (${th.check.errors.length} errors).`, 'warn');
    // The stage's content width once its vertical scrollbar is there (this view is always
    // taller than the stage, but the bar is not there yet while it renders): padding + bar.
    const W = Math.max(720, (ctx.root.clientWidth || 1170) - 40);
    ctx.root.append(
      theoryBar(ctx, sel),
      provenance(ctx, th, sel.theory),
      liveBar(ctx),
      liveCard(ctx, sel, th),
      chips(ctx, th, src, sel),
      chainHeader(ctx, th, src, sel),
      chainSvg(ctx, th, src, sel, W),
      cards(ctx, th, src, sel),
    );
  },
};
