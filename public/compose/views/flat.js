// View 5: the flattened net.
//
// The one place/transition net Flatten produces from the composition (the
// registry's bundle.flatten: pflow-compose's flatten_with_map, pflow-rs's Rust
// port of go-pflow's FlattenWithMap), drawn the way RenderFlatDOT marks it (metamodel/composedot.go:59-115):
// a place is a circle, a transition a box, a fused element is double-bordered,
// a read arc is dashed and undirected, an arc weight above 1 is written on it.
// The light clusters are this page's grouping by member subnet; RenderFlatDOT
// draws none, and a flat net has no ports (Flatten removes the boundary).
//
// orders:   a token game on ctx.orders.flat.model (model.js whyNotEnabled/fire:
//           the registry's bundle.run {script}), the ROADMAP 4.4 scenarios run by
//           bundle.run {scenario} and replayed step by step, and the declared
//           constraints evaluated at the current marking.
// connect4: a search plan is not a net. Drawn instead: the net the plan searches,
//           at the fixture's own coordinates, playable on the registry's token
//           game (sim.fire / sim.enabled on the net loaded into its own engine);
//           automatic transitions settle as pflow-rs's Game does, with the sides
//           and rewards that pflow-rs tests/common/mod.rs declares for it.

import { cite } from '../sources.js';
import { FLATTEN_CITES, initialMarking, whyNotEnabled, fire, flatOf, flatPlaceOf, runOf, c4Model } from '../model.js';
import { NS } from '../model.js';
import { defaultLinks } from '../model.js';
import { CONNECT4_EXACT, toJSON } from '../model.js';
import { engines } from '../registry.js';

// --- sources ---------------------------------------------------------------------------

const go = (path, from, to = from, note = '') => cite('goPflow', path, from, to, note);
const ttl = (from, to = from, note = '') => cite('ontology', 'ns/patterns.ttl', from, to, note);
const road = (from, to, note) => cite('ontologyRoadmap', 'ROADMAP.md', from, to, note);
const rsSrc = (path, from, to, note) => cite('pflowRs', `crates/pflow-metamodel/src/${path}`, from, to, note);
const rsTest = (path, from, to, note) => cite('pflowRs', `crates/pflow-metamodel/tests/${path}`, from, to, note);

const C = {
  flatDot: go('metamodel/composedot.go', 59, 115, 'RenderFlatDOT: the flattened model, fused elements marked'),
  dotDoc: go('metamodel/composedot.go', 9, 19, 'a place is a circle, a transition a box; fused elements are double-bordered'),
  wirePeri: go('metamodel/composedot.go', 80, 83, 'a wire (places fused into one slot): peripheries=2'),
  fusedPeri: go('metamodel/composedot.go', 97, 100, 'several transitions that now fire as one: peripheries=2'),
  arcAttrs: go('metamodel/composedot.go', 243, 263, 'arcAttrs: inhibitor = circle head, read = dashed and undirected, weight > 1 labelled'),
  guardLower: go('metamodel/compose_flatten.go', 424, 482, 'applyGuardLinks: a guard link becomes a read (or inhibitor) arc'),
  constraints: go('metamodel/compose_flatten.go', 484, 504, 'rewriteConstraints: qualified IDs, place references rewritten'),
  initial: go('metamodel/firing.go', 49, 58, 'InitialMarking: token places only'),
  whyNot: go('metamodel/firing.go', 142, 196, 'EnabledWhyNot: the refusal wording shown here'),
  fire: go('metamodel/firing.go', 198, 212, 'Fire: read and inhibitor arcs move nothing'),
  leak: ttl(493, 497, 'pat:idiom-pool-release-saga-commit; its ns:caveat (line 496): "Fires only on commit…"'),
  poolInv: ttl(272, 275, 'pat:resource-pool-inv-conservation'),
  arcClasses: cite('ontology', 'ns/core.ttl', 25, 51, 'ns:Arc and its subclasses InputArc, OutputArc, ReadArc, InhibitorArc'),
  faith: road(247, 295, 'faithfulness checks: vacuity, scenario, semantic'),
  exit41: road(240, 242, '4.1 exit: "a failed conservation check on the rollback path"'),
  worked: road(276, 280, 'worked expectation: the rollback scenario fails, the worker never returns'),
  d44: road(289, 291, '4.4: the rollback scenario fails with the pool-leak evidence'),
  c4fixture: rsTest('fixtures/connect-4.json', 20457, 20457, 'the fixture\'s description (byte-identical to data/connect-4.json)'),
  c4names: rsTest('common/mod.rs', 5, 8, 'the fixtures name their parts by convention; this file declares sides, auto and rewards'),
  c4decl: rsTest('common/mod.rs', 23, 30, 'auto = name contains "win"; sign +1 for x_, -1 otherwise; reward win_x +1, win_o -1'),
  gameDoc: rsSrc('game.rs', 4, 11, 'auto transitions fire as soon as enabled; every other transition is a move'),
  settle: rsSrc('game.rs', 221, 232, 'settle: fire automatic transitions, lowest index first, until none is enabled'),
  idOrder: cite('pflowRs', 'crates/pflow-parser/src/lib.rs', 129, 131, 'model_from_json sorts the transition IDs, so a transition\'s index is its place in ID order'),
  score: rsSrc('game.rs', 239, 242, 'score: the reward of a final marking'),
};

// --- palette ---------------------------------------------------------------------------

const INK = '#2b2f36', MUTED = '#6a717c', PAPER = '#fafafa';
const ARC = '#868d97', ARC_HI = '#2b2f36';
const EN = '#1e7a46', EN_FILL = '#e6f4ea';
const FIRE = '#c47a12';
const READ = '#3366aa';  // RenderFlatDOT's read-arc color (composedot.go:253)
const INHIB = '#aa3333'; // and its inhibitor color (composedot.go:249)
const PRE = '#2f6fb3', POST = '#c47a12'; // connect-4 hover: preset / postset

// --- module state (survives re-renders; keyed so a changed net starts fresh) ----------------

const S = {
  games: new Map(), // flat-net shape key -> { marking, fired: [] }
  run: null,        // { key, scenario, result, shown }
  busy: false,
  gen: 0,           // bumped on every render; a stale animation stops
  c4: null,         // { marking, log, last }
  c4model: null,    // { net, model }: the fixture read for drawing, its token game on the registry's c4 engine
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const splitId = (id) => { const i = id.indexOf('/'); return i < 0 ? ['', id] : [id.slice(0, i + 1), id.slice(i + 1)]; };

// --- shared drawing bits ---------------------------------------------------------------------

const STYLE = `
.fv-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 0 0 8px; font-size: 12px; }
.fv-bar .fv-lab { color: var(--muted); }
.fv-bar .fv-sep { width: 1px; height: 18px; background: var(--line); margin: 0 4px; }
.fv-bar button { font: inherit; border: 1px solid var(--line); background: #fff; border-radius: 6px; padding: 3px 9px; cursor: pointer; }
.fv-bar button:hover { border-color: #aab2bd; }
.fv-bar button.fv-sc.active { background: var(--ink); color: #fff; border-color: var(--ink); }
.fv-bar button:disabled { opacity: 0.5; cursor: default; }
.fv-status { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.fv-status b { color: var(--ink); font-weight: 600; }
.fv-svg { background: ${PAPER}; }
.fv-svg text { font-family: var(--font-sans); }
.fv-svg .fv-mono { font-family: var(--font-mono); }
.fv-node { cursor: help; }
.fv-node .fv-shape { transition: stroke 0.15s, fill 0.15s; }
.fv-t.fv-en { cursor: pointer; }
.fv-t.fv-en .fv-shape { stroke: ${EN}; stroke-width: 2; fill: ${EN_FILL}; }
.fv-t.fv-en:hover .fv-shape { fill: #d3ecdb; }
.fv-t.fv-firing .fv-shape { stroke: ${FIRE}; stroke-width: 2.6; fill: #fdf1df; }
.fv-t.fv-blocked .fv-shape { stroke: #b2342a; stroke-width: 2.2; stroke-dasharray: 4 3; fill: #fbecea; }
.hover-tip { overflow-wrap: anywhere; } /* flat IDs are long and unbroken */
.fv-arc { transition: stroke 0.12s, opacity 0.12s; }
.fv-arc.fv-hi { stroke: ${ARC_HI}; stroke-width: 1.8; }
.fv-arc.fv-read.fv-hi { stroke: ${READ}; }
.fv-panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px; margin-top: 8px; }
.fv-card { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font-size: 12px; min-width: 0; }
.fv-card h4 { margin: 0 0 4px; font-size: 12.5px; }
.fv-card p { margin: 4px 0; }
.fv-card .fv-muted { color: var(--muted); }
.fv-card ol, .fv-card ul { margin: 4px 0; padding-left: 18px; }
.fv-card li { margin: 2px 0; }
.fv-card code, .fv-mono { font-family: var(--font-mono); font-size: 11px; overflow-wrap: anywhere; }
.fv-pass, .fv-fail, .fv-hold, .fv-viol, .fv-stop { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.03em; padding: 0 5px; border-radius: 3px; margin-right: 4px; vertical-align: 1px; }
.fv-pass, .fv-hold { background: #e3f3e8; color: ${EN}; }
.fv-fail, .fv-viol { background: #fbe4e1; color: #b2342a; }
.fv-stop { background: #fdf0dc; color: #9a5d0a; }
.fv-why { background: #fbf4e6; border-radius: 4px; padding: 4px 6px; margin: 6px 0 2px; }
.fv-agree { color: ${EN}; font-weight: 600; }
.fv-disagree { color: #b2342a; font-weight: 600; }
.fv-cons li { list-style: none; margin-left: -18px; }
.fv-cons .fv-expr { color: var(--muted); }
.fv-step-blocked { color: #9a5d0a; }
`;

function injectStyle(ctx) {
  ctx.root.appendChild(ctx.el('style', {}, STYLE));
}

function markers(ctx) {
  const m = (id, color) => ctx.svg('marker', { id, viewBox: '0 0 10 10', refX: 9.2, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse', markerUnits: 'userSpaceOnUse' },
    ctx.svg('path', { d: 'M0,1.2 L10,5 L0,8.8 z', fill: color }));
  return ctx.svg('defs', {},
    m('fv-ar', ARC), m('fv-ar-hi', ARC_HI), m('fv-ar-pre', PRE), m('fv-ar-post', POST),
    ctx.svg('filter', { id: 'fv-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' },
      ctx.svg('feGaussianBlur', { stdDeviation: 2.2, result: 'b' }),
      ctx.svg('feMerge', {}, ctx.svg('feMergeNode', { in: 'b' }), ctx.svg('feMergeNode', { in: 'SourceGraphic' }))));
}

/** Tokens inside a place: dots up to four, else the count. */
function paintTokens(ctx, g, n, r) {
  g.replaceChildren();
  if (!n) return;
  const d = r * 0.24;
  const dot = (x, y) => g.appendChild(ctx.svg('circle', { cx: x, cy: y, r: Math.max(2.2, r * 0.2), fill: INK }));
  if (n === 1) dot(0, 0);
  else if (n === 2) { dot(-d * 1.4, 0); dot(d * 1.4, 0); }
  else if (n === 3) { dot(0, -d * 1.3); dot(-d * 1.4, d * 0.9); dot(d * 1.4, d * 0.9); }
  else if (n === 4) { dot(-d * 1.3, -d * 1.3); dot(d * 1.3, -d * 1.3); dot(-d * 1.3, d * 1.3); dot(d * 1.3, d * 1.3); }
  else g.appendChild(ctx.svg('text', { x: 0, y: r * 0.36, 'text-anchor': 'middle', 'font-size': Math.max(9, r * 0.85), 'font-weight': 700, fill: INK }, String(n)));
}

/** Where a straight arc from a to b leaves a's boundary. */
function boundary(n, tx, ty, pad = 0) {
  const dx = tx - n.x, dy = ty - n.y, len = Math.hypot(dx, dy) || 1;
  if (n.kind === 'place') { const r = n.r + pad; return { x: n.x + (dx / len) * r, y: n.y + (dy / len) * r }; }
  const hw = n.w / 2 + pad, hh = n.h / 2 + pad;
  const s = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  return { x: n.x + dx * s, y: n.y + dy * s };
}

/** Consuming inputs and outputs of a transition, as firing.go's Inputs/Outputs (token places only). */
function ioArcs(model, tid) {
  const token = new Set(model.places.filter((p) => (p.kind || 'token') === 'token').map((p) => p.id));
  const ro = (a) => a.type === 'read' || a.type === 'inhibitor';
  return {
    inputs: model.arcs.filter((a) => a.to === tid && token.has(a.from) && !ro(a)),
    outputs: model.arcs.filter((a) => a.from === tid && token.has(a.to) && !ro(a)),
    tests: model.arcs.filter((a) => a.to === tid && token.has(a.from) && ro(a)),
  };
}

/** Move a token dot along a straight line (Web Animations on an SVG circle). */
function travel(ctx, layer, from, to, ms, delay = 0, r = 4.2) {
  const dot = ctx.svg('circle', { cx: 0, cy: 0, r, fill: INK, stroke: '#fff', 'stroke-width': 1.2, style: { transform: `translate(${from.x}px, ${from.y}px)` } });
  layer.appendChild(dot);
  const a = dot.animate([
    { transform: `translate(${from.x}px, ${from.y}px)`, opacity: 0.9 },
    { transform: `translate(${to.x}px, ${to.y}px)`, opacity: 1 },
  ], { duration: ms, delay, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'forwards' });
  return a.finished.then(() => dot.remove(), () => dot.remove());
}

/**
 * ctx.hover with facts that follow the token game: the info object is rebuilt
 * in place just before the inspector reads it (this listener runs first).
 */
function liveHover(ctx, node, build) {
  const info = build();
  const refresh = () => { const next = build(); for (const k of Object.keys(info)) delete info[k]; Object.assign(info, next); };
  node.addEventListener('pointerenter', refresh);
  node.addEventListener('click', refresh);
  ctx.hover(node, info);
}

// =============================================================================================
// orders: the flattened composition
// =============================================================================================

const PR = 16;                 // place radius
const U = 150;                 // saga column
const ROW = { C: 0, W: 70, M: 174, F: 278 }; // saga rows: compensated, unwind, fail/done, forward
const SAGA_H = ROW.F;
const BAND_GAP = 100;          // room between cluster rows for the fused elements
const PAD = 12, HEAD = 20;
const FS_PRE = 8.5, FS_LOC = 10.5, FS_FUSED = 10;
/** Width of monospace text (labels are flat IDs, set in the mono face). */
const mw = (s, size) => String(s).length * size * 0.61;

const shapeKey = (m) => JSON.stringify([m.places.map((p) => [p.id, p.initial || 0, p.capacity || 0, p.kind || 'token']), m.transitions.map((t) => t.id), m.arcs.map((a) => [a.from, a.to, a.weight || 1, a.type || ''])]);

/** Label lines of a flat element: its go-pflow flat ID, broken where it reads best. */
function linesOf(id, kind) {
  if (id.startsWith('fused:')) {
    const parts = id.slice(6).split('+');
    return parts.map((p, i) => (i === 0 ? `fused:${p}` : `+${p}`));
  }
  if (id.startsWith('wire:')) { const [pre, loc] = splitId(id.slice(5)); return [`wire:${pre}`, loc]; }
  const [pre, loc] = splitId(id);
  return [pre, loc];
}

function geomOf(ctx, kind, lines, fused) {
  const tw = mw;
  if (kind === 'transition') {
    if (fused) return { w: Math.max(...lines.map((l) => tw(l, FS_FUSED) * 1.04)) + 26, h: 13 * lines.length + 13 };
    return { w: Math.max(46, tw(lines[0], FS_PRE), tw(lines[1], FS_LOC)) + 16, h: 30 };
  }
  return { r: fused ? PR + 3 : PR };
}

/**
 * The label block of a place (two lines: the subnet prefix, then the rest of the
 * flat ID), as a box, for one of eight positions around the circle. Returns the
 * box and how to set the text in it.
 */
const LABEL_POS = ['below', 'above', 'right', 'left', 'bl', 'br', 'al', 'ar'];
function placeLabelBox(ctx, n, lab = n.lab) {
  const w = Math.max(mw(n.lines[0], FS_PRE), mw(n.lines[1], FS_LOC));
  const r = n.r, H = 26;
  const below = n.y + r + 2, above = n.y - r - 2 - H;
  const box = (x0, y0, anchor, tx) => ({ x0, x1: x0 + w, y0, y1: y0 + H, anchor, tx });
  switch (lab) {
    case 'above': return box(n.x - w / 2, above, 'middle', n.x);
    case 'right': return box(n.x + r + 5, n.y - H / 2, 'start', n.x + r + 5);
    case 'left': return box(n.x - r - 5 - w, n.y - H / 2, 'end', n.x - r - 5);
    case 'bl': return box(n.x + 6 - w, below, 'end', n.x + 6);
    case 'br': return box(n.x - 6, below, 'start', n.x - 6);
    case 'al': return box(n.x + 6 - w, above, 'end', n.x + 6);
    case 'ar': return box(n.x - 6, above, 'start', n.x - 6);
    default: return box(n.x - w / 2, below, 'middle', n.x);
  }
}

const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (a, r) => a.x0 >= r.x && a.x1 <= r.x + r.w && a.y0 >= r.y && a.y1 <= r.y + r.h;
/** Does segment (x1,y1)-(x2,y2) cross box b (Liang-Barsky)? */
function segHits(x1, y1, x2, y2, b) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - b.x0], [dx, b.x1 - x1], [-dy, y1 - b.y0], [dy, b.y1 - y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/**
 * Pick each place's label position: the pattern layout's preference unless an
 * arc, a node or another label is in the way. Deterministic (model order).
 */
function placeLabels(ctx, nodes, model) {
  const segs = [];
  for (const a of model.arcs) { const A = nodes.get(a.from), B = nodes.get(a.to); if (A && B) segs.push([A.x, A.y, B.x, B.y, a.from, a.to]); }
  const shapes = [...nodes.values()].map((n) => (n.kind === 'place'
    ? { id: n.id, x0: n.x - n.r, x1: n.x + n.r, y0: n.y - n.r, y1: n.y + n.r }
    : { id: n.id, x0: n.x - n.w / 2, x1: n.x + n.w / 2, y0: n.y - n.h / 2, y1: n.y + n.h / 2 }));
  const taken = [];
  for (const n of nodes.values()) {
    if (n.kind !== 'place') continue;
    const prefs = [...new Set([n.lab || 'below', ...LABEL_POS])];
    let best = null;
    prefs.forEach((lab, i) => {
      const b0 = placeLabelBox(ctx, n, lab);
      const b = { x0: b0.x0 + 1, x1: b0.x1 - 1, y0: b0.y0 + 2, y1: b0.y1 - 2 };
      let score = i;
      for (const [x1, y1, x2, y2] of segs) if (segHits(x1, y1, x2, y2, b)) score += 12;
      const grown = { x0: b.x0 - 4, x1: b.x1 + 4, y0: b.y0 - 5, y1: b.y1 + 5 }; // keep a little air
      for (const sh of shapes) if (sh.id !== n.id && overlaps(sh, b)) score += 100; else if (sh.id !== n.id && overlaps(sh, grown)) score += 6;
      for (const t of taken) if (overlaps(t, b)) score += 60; else if (overlaps(t, grown)) score += 14;
      if (n.rect && !inside(b0, n.rect)) score += 20;
      if (!best || score < best.score) best = { lab, b, score };
    });
    n.lab = best.lab;
    taken.push(best.b);
  }
}

function boxOf(n, pad = 0) {
  return n.kind === 'place'
    ? { x0: n.x - n.r - pad, x1: n.x + n.r + pad, y0: n.y - n.r - pad, y1: n.y + n.r + pad }
    : { x0: n.x - n.w / 2 - pad, x1: n.x + n.w / 2 + pad, y0: n.y - n.h / 2 - pad, y1: n.y + n.h / 2 + pad };
}

/**
 * An arc drawn straight through a node it does not touch reads as that node's arc.
 * Each fused element tries a fixed list of spots in its gap (so the layout stays
 * deterministic) and keeps the one where the fewest arcs cross other nodes,
 * without landing on another node.
 */
function refineFused(ctx, nodes, model, gaps, perGap) {
  const all = [...nodes.values()];
  const arcs = model.arcs.map((a) => [nodes.get(a.from), nodes.get(a.to)]).filter(([A, B]) => A && B);
  const through = (A, B, m) => m !== A && m !== B && segHits(A.x, A.y, B.x, B.y, boxOf(m, -2));
  const ext = (m) => (m.kind === 'place' ? extentOf(ctx, m) : boxOf(m));
  const cost = (n) => {
    let hits = 0;
    for (const [A, B] of arcs) {
      if (A === n || B === n) { for (const m of all) if (through(A, B, m)) hits++; } else if (through(A, B, n)) hits++;
    }
    const me = ext(n), grown = { x0: me.x0 - 10, x1: me.x1 + 10, y0: me.y0 - 4, y1: me.y1 + 4 };
    let clash = 0;
    for (const m of all) if (m !== n && overlaps(grown, ext(m))) clash++;
    return hits * 100 + clash * 1000;
  };
  const DX = [0, 36, -36, 72, -72, 110, -110, 150, -150, 200, -200], DY = [0, -22, 22];
  gaps.forEach((g, gi) => {
    for (const n of [...perGap[gi]].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const x0 = n.x, y0 = n.y, half = n.kind === 'place' ? n.r : n.h / 2, halfW = n.kind === 'place' ? n.r : n.w / 2;
      let best = { c: cost(n), x: x0, y: y0 };
      for (const dy of DY) {
        if (dy && (y0 + dy - half < g.y0 + 4 || y0 + dy + half > g.y1 - 4)) continue;
        for (const dx of DX) {
          if ((!dx && !dy) || x0 + dx - halfW < 8) continue;
          n.x = x0 + dx; n.y = y0 + dy;
          const c = cost(n) + Math.abs(dx) * 0.05 + Math.abs(dy) * 0.1;
          if (c < best.c) best = { c, x: n.x, y: n.y };
        }
      }
      n.x = best.x; n.y = best.y;
    }
  });
}

function extentOf(ctx, n) {
  if (n.kind === 'transition') return { x0: n.x - n.w / 2, x1: n.x + n.w / 2, y0: n.y - n.h / 2, y1: n.y + n.h / 2 };
  const lb = placeLabelBox(ctx, n);
  return { x0: Math.min(n.x - n.r, lb.x0), x1: Math.max(n.x + n.r, lb.x1), y0: Math.min(n.y - n.r, lb.y0), y1: Math.max(n.y + n.r, lb.y1) };
}

// --- pattern layouts: each element's home inside its cluster (local coordinates) -------------

function sagaHomes(s, flip) {
  const steps = s.steps || [];
  const n = steps.length;
  const c = (k) => k * U;
  const h = {};
  const swap = { above: 'below', below: 'above' };
  const put = (id, x, y, lab = 'below') => { h[id] = { x, y: flip ? SAGA_H - y : y, lab: flip ? (swap[lab] || lab) : lab }; };
  // The quadrant places sit nearer the middle row, so their labels clear the rows above and below.
  const qUp = ROW.W + 0.6 * (ROW.M - ROW.W), qDown = ROW.M + 0.4 * (ROW.F - ROW.M);
  // Which step moves an account, and whether do_<step> takes from it (debit) or pays it (credit).
  const moved = {};
  for (const a of s.arcs) {
    const m = /^do_(.+)$/.exec(a.to) || /^do_(.+)$/.exec(a.from);
    if (!m) continue;
    const acct = a.to.startsWith('do_') ? a.from : a.to;
    if (!(s.accounts || []).includes(acct) || moved[acct]) continue;
    moved[acct] = { step: m[1], debit: a.to.startsWith('do_') };
  }
  steps.forEach((st, i) => {
    const movesTokens = Object.values(moved).some((v) => v.step === st);
    put(`next_${st}`, c(2 * i), ROW.F, 'below');
    put(`do_${st}`, c(2 * i + 1), ROW.F);
    put(`fail_${st}`, c(2 * i), ROW.M);
    put(`undo_${st}`, c(2 * i + 1), ROW.W);
    put(`unwind_${st}`, c(2 * i + 2), ROW.W, 'above');
    put(`${st}_done`, c(2 * i + 1), ROW.M, movesTokens ? 'left' : 'right');
    put(`${st}_pending`, c(2 * i) + U / 2, qDown, 'below');
    put(`${st}_failed`, c(2 * i) + U / 2, qUp, 'above');
    put(`${st}_compensated`, c(2 * i + 1), ROW.C, 'right');
  });
  put('committing', c(2 * n), ROW.F, 'below');
  put('commit', c(2 * n + 1), ROW.F);
  put('completed', c(2 * n + 2), ROW.F, 'below');
  put('fail_commit', c(2 * n), ROW.M);
  put('rolled_back', c(0), ROW.W, 'above');
  let spare = 0;
  for (const acct of s.accounts || []) {
    const mv = moved[acct];
    if (mv) {
      const i = steps.indexOf(mv.step);
      put(acct, c(2 * i + 1) + U * 0.6, mv.debit ? ROW.M + 60 : ROW.M - 60, 'right');
    } else {
      put(acct, c(2 * n + 2), ROW.M - 50 + 64 * spare++, 'right');
    }
  }
  return h;
}

function queueHomes() {
  return { enqueue: { x: 0, y: 38 }, items: { x: 100, y: 0, lab: 'above' }, dequeue: { x: 200, y: 38 }, slots: { x: 100, y: 76, lab: 'below' } };
}

function poolHomes(s, w) {
  return { acquire: { x: 0, y: 38 }, available: { x: w / 2, y: 0, lab: 'above' }, in_use: { x: w / 2, y: 76, lab: 'below' }, release: { x: w, y: 38 } };
}

function gridHomes(s) { // any other pattern: places on top, transitions below
  const h = {};
  s.places.forEach((p, i) => { h[p.id] = { x: i * 120, y: 0, lab: 'below' }; });
  s.transitions.forEach((t, i) => { h[t.id] = { x: i * 120, y: 110 }; });
  return h;
}

/**
 * Positions for every flat element. A flat element with one member sits at that
 * member's home inside its cluster; a fused one sits in the gap between the
 * cluster rows, at the mean x of its members' homes.
 */
function layoutOrders(ctx, model, map) {
  const subnets = ctx.orders.subnets;
  const sagas = subnets.filter((s) => s.pattern === 'saga');
  const queues = subnets.filter((s) => s.pattern === 'queue');
  const pools = subnets.filter((s) => s.pattern === 'resource-pool');
  const others = subnets.filter((s) => !['saga', 'queue', 'resource-pool'].includes(s.pattern));

  const kindOf = (s, local) => (s.places.some((p) => p.id === local) ? 'place' : 'transition');
  const memberNode = (s, local, home) => {
    const kind = kindOf(s, local);
    const lines = [`${s.id}/`, local];
    return { kind, lines, x: home.x, y: home.y, lab: home.lab || 'below', ...geomOf(ctx, kind, lines, false) };
  };
  const localExtent = (s, homes) => {
    let b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (const [local, home] of Object.entries(homes)) {
      const e = extentOf(ctx, memberNode(s, local, home));
      b = { x0: Math.min(b.x0, e.x0), x1: Math.max(b.x1, e.x1), y0: Math.min(b.y0, e.y0), y1: Math.max(b.y1, e.y1) };
    }
    return b;
  };

  const clusters = []; // { s, homes (absolute), rect }
  const place = (s, homes, left, top) => {
    const e = localExtent(s, homes);
    const ox = left + PAD - e.x0, oy = top + PAD + HEAD - e.y0;
    const abs = Object.fromEntries(Object.entries(homes).map(([k, v]) => [k, { ...v, x: v.x + ox, y: v.y + oy }]));
    const rect = { x: left, y: top, w: e.x1 - e.x0 + 2 * PAD, h: e.y1 - e.y0 + 2 * PAD + HEAD };
    clusters.push({ s, homes: abs, rect });
    return rect;
  };

  const LEFT = 24;
  let top = 14;
  const bands = [];
  // Band 0: the first saga, forward track at the bottom (facing the queue and pool).
  let commitX = null, sagaLeft = LEFT;
  if (sagas[0]) {
    const r = place(sagas[0], sagaHomes(sagas[0], false), LEFT, top);
    bands.push({ y0: r.y, y1: r.y + r.h });
    const cl = clusters[clusters.length - 1];
    commitX = cl.homes.commit ? cl.homes.commit.x : null;
    sagaLeft = r.x;
    top = r.y + r.h + BAND_GAP;
  }
  // Band 1: queues, then pools, then anything else, left to right.
  let x = sagaLeft, bandBottom = top;
  const row = [...queues.map((s) => ['q', s]), ...pools.map((s) => ['p', s]), ...others.map((s) => ['o', s])];
  row.forEach(([k, s], i) => {
    let homes;
    if (k === 'q') homes = queueHomes(s);
    else if (k === 'p') {
      // One pool: stretch it so its release end sits under the saga's commit column,
      // where a release ⊗ commit fusion lands. Several pools: compact.
      let w = 230;
      if (pools.length === 1 && commitX !== null) {
        const accHalf = geomOf(ctx, 'transition', [`${s.id}/`, 'acquire'], false).w / 2;
        w = Math.max(230, Math.min(560, commitX - 26 - (x + PAD + accHalf)));
      }
      homes = poolHomes(s, w);
    } else homes = gridHomes(s);
    const r = place(s, homes, x, top);
    x = r.x + r.w + (i < row.length - 1 ? 44 : 0);
    bandBottom = Math.max(bandBottom, r.y + r.h);
  });
  // Make the band-1 clusters one height, so the row reads as a row.
  const b1 = clusters.filter((c) => c.s.pattern !== 'saga');
  const b1h = Math.max(...b1.map((c) => c.rect.h));
  for (const c of b1) { const dy = (b1h - c.rect.h) / 2; c.rect.h = b1h; for (const h of Object.values(c.homes)) h.y += dy; }
  bands.push({ y0: top, y1: top + b1h });
  const band1Right = x;
  top = top + b1h;
  // Band 2...: further sagas, mirrored so their forward track faces band 1.
  for (const s of sagas.slice(1)) {
    top += BAND_GAP;
    const r = place(s, sagaHomes(s, true), sagaLeft, top);
    bands.push({ y0: r.y, y1: r.y + r.h });
    top = r.y + r.h;
  }

  // Homes, absolute, by qualified member ID.
  const home = {};
  for (const cl of clusters) for (const [local, h] of Object.entries(cl.homes)) home[`${cl.s.id}/${local}`] = h;

  // Flat nodes.
  const nodes = new Map();
  const mk = (el, kind) => {
    const fused = el.members.length > 1;
    const lines = linesOf(el.id, kind);
    const n = { id: el.id, kind, el, fused, members: el.members, lines, ...geomOf(ctx, kind, lines, fused) };
    if (!fused) {
      const h = home[el.members[0]], sid = splitId(el.members[0])[0].slice(0, -1);
      Object.assign(n, { x: h.x, y: h.y, lab: h.lab || 'below', cluster: sid, rect: (clusters.find((c) => c.s.id === sid) || {}).rect });
    }
    nodes.set(el.id, n);
    return n;
  };
  model.places.forEach((p) => mk(p, 'place'));
  model.transitions.forEach((t) => mk(t, 'transition'));

  // Fused elements: into the gap between bands nearest the mean of their homes.
  const gaps = [];
  for (let i = 0; i + 1 < bands.length; i++) gaps.push({ y0: bands[i].y1, y1: bands[i + 1].y0 });
  if (!gaps.length) gaps.push({ y0: bands[0].y1, y1: bands[0].y1 + BAND_GAP });
  const fusedNodes = [...nodes.values()].filter((n) => n.fused);
  const perGap = gaps.map(() => []);
  for (const n of fusedNodes) {
    const hs = n.members.map((m) => home[m]).filter(Boolean);
    const cx = hs.reduce((a, h) => a + h.x, 0) / hs.length, cy = hs.reduce((a, h) => a + h.y, 0) / hs.length;
    let gi = 0, best = Infinity;
    gaps.forEach((g, i) => { const d = Math.abs((g.y0 + g.y1) / 2 - cy); if (d < best - 1e-6) { best = d; gi = i; } });
    n.x = cx; n.y = (gaps[gi].y0 + gaps[gi].y1) / 2; n.lab = n.kind === 'place' ? 'right' : null;
    perGap[gi].push(n);
  }
  // No two fused elements in one gap overlap: sweep left to right.
  for (const list of perGap) {
    list.sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const ext = (n) => (n.kind === 'transition' ? n.w / 2 : n.r + 6 + Math.max(...n.lines.map((l) => mw(l, FS_LOC))));
      const minDx = (a.kind === 'transition' ? a.w / 2 : ext(a)) + (b.kind === 'transition' ? b.w / 2 : b.r) + 24;
      if (b.x - a.x < minDx) b.x = a.x + minDx;
    }
  }
  refineFused(ctx, nodes, model, gaps, perGap);

  // A gap with no fused element in it closes up, so an unlinked composite is not split by blank bands.
  const CLOSE = BAND_GAP - 40;
  const shiftAt = (y) => gaps.reduce((s, g, i) => s + (perGap[i].length === 0 && y >= g.y1 - 0.5 ? CLOSE : 0), 0);
  for (const c of clusters) { const d = shiftAt(c.rect.y); if (!d) continue; c.rect.y -= d; for (const h of Object.values(c.homes)) h.y -= d; }
  for (const n of nodes.values()) n.y -= shiftAt(n.y);
  for (const b of bands) { const d = shiftAt(b.y0); b.y0 -= d; b.y1 -= d; }

  placeLabels(ctx, nodes, model);

  // Canvas.
  let x1 = 0, y1 = 0;
  for (const c of clusters) { x1 = Math.max(x1, c.rect.x + c.rect.w); y1 = Math.max(y1, c.rect.y + c.rect.h); }
  for (const n of nodes.values()) { const e = extentOf(ctx, n); x1 = Math.max(x1, e.x1); y1 = Math.max(y1, e.y1); }
  // Legend: right of band 1 when it fits, else under everything.
  const LW = 236, LH = 178;
  let legend;
  const W0 = Math.max(1150, x1 + 24);
  if (band1Right + 24 + LW <= W0 - 12 && bands[1]) legend = { x: W0 - 12 - LW, y: bands[1].y0 + Math.max(0, (bands[1].y1 - bands[1].y0 - LH) / 2), w: LW, h: LH };
  else { legend = { x: LEFT, y: y1 + 18, w: LW, h: LH }; y1 = legend.y + LH; }
  return { nodes, clusters, home, gaps, legend, W: W0, H: Math.ceil(y1 + 16) };
}

// --- orders: render ---------------------------------------------------------------------------

function renderOrders(ctx) {
  const gen = S.gen;
  const flat = ctx.orders.flat;
  if (!flat.ok) {
    ctx.note(`bundle.flatten refuses this composition, so there is no flat net to draw: ${flat.error || flat.errors.map((e) => `${e.code || ''} ${e.message}`).join('; ')}`, 'warn');
    return;
  }
  const model = flat.model, map = flat.map;
  const key = shapeKey(model);
  if (!S.games.has(key)) S.games.set(key, { marking: initialMarking(model), fired: [] });
  const game = S.games.get(key);
  if (S.run && S.run.key !== key) S.run = null;
  if (S.run && !S.run.done) { // a re-render interrupted a run: finish it at once
    const r = S.run.result;
    // replay the run's fired steps through the registry, so the marking keeps the script that reached it
    game.marking = initialMarking(model); game.fired = [];
    for (const x of r.steps.filter((y) => y.enabled)) { game.marking = fire(model, game.marking, x.flat); game.fired.push(x.flat); }
    S.run.shown = r.steps.length; S.run.done = true;
  }
  const lay = layoutOrders(ctx, model, map);

  injectStyle(ctx);

  // Control bar.
  const status = ctx.el('span', { class: 'fv-status' });
  // Each button carries the registry's verdict on its scenario (bundle.run {scenario}):
  // ✓ every predicate holds, ✗ one fails, ⏹ the run stopped early.
  const scButtons = ctx.orders.scenarios.map((sc) => {
    const r = scenarioRun(model, map, sc);
    const pass = r.expect.every((e) => e.pass);
    ctx.emit('scenario', sc.id, { pass, stopped_step: r.completed ? '' : (r.stoppedStep || '') });
    const badge = ctx.el('span', { class: pass ? 'fv-pass' : 'fv-fail', style: { 'margin-left': '5px' } }, r.completed ? (pass ? '✓' : '✗') : '⏹');
    return ctx.el('button', {
      class: `fv-sc${S.run && S.run.scenario.id === sc.id ? ' active' : ''}`,
      title: `${sc.title} — bundle.run: ${r.completed ? 'all steps fire' : `stops at ${r.stoppedStep}`}; ${pass ? 'every predicate holds' : `${r.expect.filter((e) => !e.pass).length} predicate(s) fail`}`,
      onclick: () => runScenario(sc),
    }, `▶ ${sc.id}`, badge);
  });
  const resetBtn = ctx.el('button', { onclick: () => { if (S.busy) return; game.marking = initialMarking(model); game.fired = []; S.run = null; refresh(); }, title: 'back to the initial marking (bundle.run of the empty script)' }, '↺ Reset marking');
  const bar = ctx.el('div', { class: 'fv-bar' },
    ctx.el('span', { class: 'fv-lab' }, 'Token game:'), resetBtn,
    ctx.el('span', { class: 'fv-sep' }),
    ctx.el('span', { class: 'fv-lab' }, 'Scenarios (ROADMAP 4.4):'), ...scButtons,
    status);
  ctx.root.appendChild(bar);

  // The net.
  const root = ctx.svgRoot(lay.W, lay.H, { class: 'view-svg fv-svg' });
  root.appendChild(markers(ctx));
  const gClusters = ctx.svg('g', {}), gArcs = ctx.svg('g', {}), gNodes = ctx.svg('g', {}), gLabels = ctx.svg('g', {}), gFx = ctx.svg('g', { 'pointer-events': 'none' });
  root.append(gClusters, gArcs, gNodes, gLabels, gFx);
  ctx.root.appendChild(root);

  // Clusters (the page's grouping: RenderFlatDOT has none).
  for (const cl of lay.clusters) {
    const s = cl.s, p = ctx.orders.patterns[s.pattern];
    const tint = ctx.theme.PATTERN_TINT[s.pattern] || '#eef0f3';
    const g = ctx.svg('g', { class: `fv-cluster${ctx.event && ctx.event.type === 'instance-added' && ctx.event.id === s.id ? ' just-added' : ''}` },
      ctx.svg('rect', { x: cl.rect.x, y: cl.rect.y, width: cl.rect.w, height: cl.rect.h, rx: 14, fill: tint, 'fill-opacity': 0.5, stroke: '#d3d9e0', 'stroke-width': 1 }),
      ctx.svg('text', { x: cl.rect.x + 12, y: cl.rect.y + 17, 'font-size': 11.5, fill: INK },
        ctx.svg('tspan', { 'font-weight': 700, class: 'fv-mono' }, `${s.id}/`),
        ctx.svg('tspan', { fill: MUTED, dx: 6 }, `${p ? p.prefLabel : s.pattern}${s.extra ? ' (second instance)' : ''}`)));
    const info = ctx.info.subnetInfo(s);
    info.note = `A cluster here only groups the flat elements whose ID starts with "${s.id}/". In the flat net there is no subnet any more: RenderFlatDOT draws it without clusters (composedot.go:62-115), and Flatten removes the ports.`;
    info.cites = [...(info.cites || []), C.flatDot];
    ctx.hover(g, info);
    gClusters.appendChild(g);
  }

  // Arcs. Each flat arc remembers the member arcs it came from (mergeArcs retargets
  // them onto flat IDs and merges duplicates).
  const sources = new Map();
  for (const sn of ctx.orders.subnets) for (const a of sn.arcs) {
    const fl = (x) => map.place[sn.id]?.[x] ?? map.transition[sn.id]?.[x] ?? `${sn.id}/${x}`;
    const k = `${fl(a.from)}\u0000${fl(a.to)}\u0000${a.type || ''}`;
    if (!sources.has(k)) sources.set(k, []);
    sources.get(k).push(`${sn.id}/${a.from} → ${sn.id}/${a.to}${(a.weight || 1) > 1 ? ` ×${a.weight}` : ''}`);
  }
  const gArcHits = ctx.svg('g', {});
  const arcEls = new Map(); // node id -> [arc elements]
  const addArcEl = (id, el) => { if (!arcEls.has(id)) arcEls.set(id, []); arcEls.get(id).push(el); };
  for (const a of model.arcs) {
    const A = lay.nodes.get(a.from), B = lay.nodes.get(a.to);
    if (!A || !B) continue;
    const ro = a.type === 'read' || a.type === 'inhibitor';
    const p0 = boundary(A, B.x, B.y, 1), p1 = boundary(B, A.x, A.y, ro ? 1 : 2);
    const attrs = { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, class: `fv-arc${a.type === 'read' ? ' fv-read' : ''}`, 'stroke-width': 1.25, fill: 'none' };
    let el;
    if (a.type === 'read') el = ctx.svg('line', { ...attrs, stroke: READ, 'stroke-dasharray': '5 3.5', 'stroke-width': 1.5 });
    else if (a.type === 'inhibitor') el = ctx.svg('line', { ...attrs, stroke: INHIB });
    else el = ctx.svg('line', { ...attrs, stroke: ARC, 'marker-end': 'url(#fv-ar)' });
    gArcs.appendChild(el);
    if (a.type === 'read') gArcs.appendChild(ctx.svg('circle', { cx: p1.x, cy: p1.y, r: 2.6, fill: READ }));
    if (a.type === 'inhibitor') gArcs.appendChild(ctx.svg('circle', { cx: p1.x, cy: p1.y, r: 3.4, fill: '#fff', stroke: INHIB, 'stroke-width': 1.4 }));
    if ((a.weight || 1) > 1) {
      const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
      gArcs.append(ctx.svg('rect', { x: mx - 8, y: my - 7.5, width: 16, height: 15, rx: 7.5, fill: '#fff', stroke: ARC, 'stroke-width': 0.8 }),
        ctx.svg('text', { x: mx, y: my + 3.8, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: INK }, String(a.weight)));
    }
    addArcEl(a.from, el); addArcEl(a.to, el);
    el._arc = a;
    // A wide transparent twin carries the hover.
    const hit = ctx.svg('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: 'transparent', 'stroke-width': 9 });
    hit.addEventListener('pointerenter', () => { el.classList.add('fv-hi'); if (el.getAttribute('marker-end')) el.setAttribute('marker-end', 'url(#fv-ar-hi)'); });
    hit.addEventListener('pointerleave', () => { el.classList.remove('fv-hi'); if (el.getAttribute('marker-end')) el.setAttribute('marker-end', 'url(#fv-ar)'); });
    const from = sources.get(`${a.from}\u0000${a.to}\u0000${a.type || ''}`) || [];
    ctx.hover(hit, {
      title: `${a.type === 'read' ? 'read arc' : a.type === 'inhibitor' ? 'inhibitor arc' : 'arc'} ${a.from} → ${a.to}`,
      concept: (() => {
        const placeFirst = !!model.places.find((q) => q.id === a.from);
        const cls = a.type === 'read' ? 'ReadArc' : a.type === 'inhibitor' ? 'InhibitorArc' : placeFirst ? 'InputArc' : 'OutputArc';
        return { iri: NS + cls, types: [`ns:${cls}`, ...(a.type ? ['ns:ContextualArc'] : []), 'ns:Arc'] };
      })(),
      definition: a.guard ? 'A guard link, lowered: its default condition "> 0" becomes a read arc of weight 1 from the observed place to the gated transition. It moves no token.' : a.type === 'read' ? 'A read arc: the transition needs the weight on the place and moves nothing.' : '',
      facts: [
        ['weight', String(a.weight || 1)],
        ['type', a.type || 'normal (consumes or produces)'],
        ['from member arcs', from.length ? from.join('; ') : (a.guard ? 'none: added by the guard link' : '?')],
        from.length > 1 ? ['merged', `${from.length} member arcs onto one pair of flat IDs: MergeSum adds the weights`] : null,
      ].filter(Boolean),
      cites: [C.arcClasses, FLATTEN_CITES[4], ...(a.guard ? [C.guardLower] : []), C.arcAttrs],
    });
    gArcHits.appendChild(hit);
  }

  gArcs.appendChild(gArcHits);

  // Nodes.
  const refs = { places: new Map(), trans: new Map() };
  const halo = { stroke: PAPER, 'stroke-width': 3.2, 'paint-order': 'stroke', 'stroke-linejoin': 'round' };
  for (const n of lay.nodes.values()) {
    const g = ctx.svg('g', { class: `fv-node ${n.kind === 'place' ? 'fv-p' : 'fv-t'}`, transform: `translate(${n.x},${n.y})`, 'data-flat-id': n.id });
    if (n.kind === 'place') ctx.emit('place', n.id, { initial: n.el.initial || 0, fused: (n.el.members || []).length > 1 });
    else ctx.emit('transition', n.id, { fused: (n.el.members || []).length > 1 });
    if (n.kind === 'place') {
      const isData = (n.el.kind || 'token') !== 'token';
      if (isData) { // RenderFlatDOT: a data place is a box (composedot.go:88-91)
        g.appendChild(ctx.svg('rect', { class: 'fv-shape', x: -n.r, y: -n.r * 0.8, width: 2 * n.r, height: 1.6 * n.r, rx: 2, fill: '#fff', stroke: INK, 'stroke-width': 1.3 }));
      } else {
        if (n.fused) g.appendChild(ctx.svg('circle', { cx: 0, cy: 0, r: n.r, fill: '#fff', stroke: INK, 'stroke-width': 1.3 }));
        g.appendChild(ctx.svg('circle', { class: 'fv-shape', cx: 0, cy: 0, r: n.fused ? n.r - 3.5 : n.r, fill: '#fff', stroke: INK, 'stroke-width': 1.4 }));
      }
      const tok = ctx.svg('g', {});
      g.appendChild(tok);
      refs.places.set(n.id, { g, tok, n, isData });
      // Label: the flat ID, prefix small and muted.
      const lb = placeLabelBox(ctx, n);
      const anchor = lb.anchor, lx = lb.tx - n.x;
      const y0 = lb.y0 + 9 - n.y;
      const t = ctx.svg('text', { x: lx, y: y0, 'text-anchor': anchor, ...halo },
        ctx.svg('tspan', { 'font-size': FS_PRE, fill: MUTED, x: lx, class: 'fv-mono' }, n.lines[0]),
        ctx.svg('tspan', { 'font-size': FS_LOC, fill: INK, x: lx, dy: 12.5, class: 'fv-mono' }, n.lines[1]));
      g.appendChild(t);
    } else {
      const { w, h } = n;
      if (n.fused) g.appendChild(ctx.svg('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 7, fill: '#fff', stroke: INK, 'stroke-width': 1.3 }));
      g.appendChild(ctx.svg('rect', { class: 'fv-shape', x: -w / 2 + (n.fused ? 3.5 : 0), y: -h / 2 + (n.fused ? 3.5 : 0), width: w - (n.fused ? 7 : 0), height: h - (n.fused ? 7 : 0), rx: n.fused ? 5 : 6, fill: PAPER, stroke: INK, 'stroke-width': 1.3 }));
      if (n.fused) {
        const t = ctx.svg('text', { 'text-anchor': 'middle', 'font-size': FS_FUSED, fill: INK, class: 'fv-mono' });
        n.lines.forEach((l, i) => t.appendChild(ctx.svg('tspan', { x: 0, y: -((n.lines.length - 1) * 13) / 2 + i * 13 + 3.5, fill: i === 0 ? INK : INK, 'font-weight': i === 0 ? 600 : 400 }, l)));
        g.appendChild(t);
      } else {
        g.appendChild(ctx.svg('text', { 'text-anchor': 'middle', class: 'fv-mono' },
          ctx.svg('tspan', { x: 0, y: -3, 'font-size': FS_PRE, fill: MUTED }, n.lines[0]),
          ctx.svg('tspan', { x: 0, y: 9.5, 'font-size': FS_LOC, fill: INK }, n.lines[1])));
      }
      refs.trans.set(n.id, { g, n });
      g.addEventListener('click', (e) => {
        if (S.busy) { e.preventDefault(); return; }
        if (whyNotEnabled(model, game.marking, n.id) !== null) return; // a disabled click pins the inspector instead
        e.preventDefault();
        fireOne(n.id);
      });
    }
    // Hover: inspector, and the node's arcs lit.
    g.addEventListener('pointerenter', () => (arcEls.get(n.id) || []).forEach((el) => { el.classList.add('fv-hi'); if (el.getAttribute('marker-end')) el.setAttribute('marker-end', 'url(#fv-ar-hi)'); }));
    g.addEventListener('pointerleave', () => (arcEls.get(n.id) || []).forEach((el) => { el.classList.remove('fv-hi'); if (el.getAttribute('marker-end')) el.setAttribute('marker-end', 'url(#fv-ar)'); }));
    liveHover(ctx, g, () => nodeInfo(ctx, n, model, () => game.marking));
    gNodes.appendChild(g);
  }

  drawLegend(ctx, root, lay.legend);

  // Panels.
  const panels = ctx.el('div', { class: 'fv-panels' });
  const pScen = ctx.el('div', { class: 'fv-card' }), pCons = ctx.el('div', { class: 'fv-card' }), pGo = ctx.el('div', { class: 'fv-card' });
  // pGo: who fires these runs (the registry), in one line.
  panels.append(pScen, pCons, pGo);
  ctx.root.appendChild(panels);

  function paint() {
    for (const { tok, n, isData } of refs.places.values()) paintTokens(ctx, tok, isData ? 0 : game.marking[n.id] || 0, n.fused ? n.r - 3.5 : n.r);
    let en = 0;
    const blocked = S.run && S.run.done && !S.run.result.completed ? S.run.result.steps[S.run.result.stoppedAt].flat : null;
    for (const { g, n } of refs.trans.values()) {
      const ok = whyNotEnabled(model, game.marking, n.id) === null;
      if (ok) en++;
      g.classList.toggle('fv-en', ok);
      g.classList.toggle('fv-blocked', n.id === blocked);
    }
    const last = game.fired[game.fired.length - 1];
    const verdict = [];
    if (S.run && S.run.done) {
      const f = S.run.result.expect.filter((e) => !e.pass).length, p = S.run.result.expect.length - f;
      verdict.push(' · ', ctx.el('b', {}, S.run.scenario.id), ': ', p ? ctx.el('span', { class: 'fv-pass' }, `${p} PASS`) : '', f ? ctx.el('span', { class: 'fv-fail' }, `${f} FAIL`) : '', S.run.result.completed ? '' : ctx.el('span', { class: 'fv-stop' }, `STOPPED AT ${S.run.result.stoppedAt + 1}`));
    }
    status.replaceChildren(ctx.el('b', {}, `${en}`), ` of ${model.transitions.length} enabled · fired `, ctx.el('b', {}, `${game.fired.length}`), ...verdict);
    for (const b of [resetBtn, ...scButtons]) b.disabled = S.busy;
    scButtons.forEach((b, i) => b.classList.toggle('active', !!(S.run && S.run.scenario.id === ctx.orders.scenarios[i].id)));
  }
  function refresh() {
    if (gen !== S.gen) return;
    paint();
    paintScenario(ctx, pScen, model, map);
    paintConstraints(ctx, pCons, model, map, game.marking, ctx.orders.byId);
    paintGo(ctx, pGo);
  }

  async function animate(tid, before) {
    const n = lay.nodes.get(tid);
    const { inputs, outputs, tests } = ioArcs(model, tid);
    const tRef = refs.trans.get(tid);
    tRef.g.classList.add('fv-firing');
    for (const a of tests) (arcEls.get(a.from) || []).filter((el) => el._arc === a).forEach((el) => el.classList.add('fv-hi'));
    // Tokens leave the input places...
    const mid = { ...before };
    for (const a of inputs) mid[a.from] = (mid[a.from] || 0) - (a.weight || 1);
    for (const [pid, r] of refs.places) if (mid[pid] !== before[pid]) paintTokens(ctx, r.tok, mid[pid] || 0, r.n.fused ? r.n.r - 3.5 : r.n.r);
    await Promise.all(inputs.flatMap((a) => {
      const P = lay.nodes.get(a.from);
      return Array.from({ length: Math.min(3, a.weight || 1) }, (_, k) => travel(ctx, gFx, { x: P.x, y: P.y }, { x: n.x, y: n.y }, 340, k * 70));
    }));
    if (gen !== S.gen) return;
    // ...and arrive at the outputs.
    await Promise.all(outputs.flatMap((a) => {
      const P = lay.nodes.get(a.to);
      return Array.from({ length: Math.min(3, a.weight || 1) }, (_, k) => travel(ctx, gFx, { x: n.x, y: n.y }, { x: P.x, y: P.y }, 340, k * 70));
    }));
    if (gen !== S.gen) return;
    tRef.g.classList.remove('fv-firing');
    for (const a of tests) (arcEls.get(a.from) || []).forEach((el) => el.classList.remove('fv-hi'));
  }

  async function fireOne(tid) {
    S.busy = true; paint();
    const before = game.marking;
    const after = fire(model, before, tid);
    await animate(tid, before);
    if (gen !== S.gen) return;
    game.marking = after; game.fired.push(tid);
    S.run = null; // the marking has left the scenario's run
    S.busy = false;
    refresh();
  }

  async function runScenario(sc) {
    if (S.busy) return;
    const result = scenarioRun(model, map, sc);
    S.run = { key, scenario: sc, result, shown: 0 };
    game.marking = initialMarking(model); game.fired = [];
    S.busy = true;
    refresh();
    await sleep(250);
    for (let i = 0; i < result.steps.length; i++) {
      if (gen !== S.gen) return;
      const st = result.steps[i];
      S.run.shown = i + 1;
      if (!st.enabled) break; // paint() marks the refused transition
      paintScenario(ctx, pScen, model, map);
      const before = game.marking;
      await animate(st.flat, before);
      if (gen !== S.gen) return;
      game.marking = fire(model, before, st.flat); game.fired.push(st.flat);
      paint();
      paintConstraints(ctx, pCons, model, map, game.marking, ctx.orders.byId);
      await sleep(140);
    }
    if (gen !== S.gen) return;
    S.run.shown = result.steps.length;
    S.run.done = true;
    S.busy = false;
    refresh();
  }

  refresh();
  mergeAnimation(ctx, lay, map, gFx, refs, arcEls);

  // Notes (prepended, so the last call shows first).
  ctx.note('No ports are drawn here: Flatten removes the boundary, and a flat net has only places, transitions and arcs. Links are made in the pattern-level views; this view shows the one net they produce, under Flatten\'s flat IDs (bundle.flatten).', 'na');
}

// --- orders: hover info ----------------------------------------------------------------------

function nodeInfo(ctx, n, model, marking) {
  const base = n.kind === 'place' ? ctx.info.flatPlaceInfo(n.el) : ctx.info.flatTransitionInfo(n.el);
  const facts = [...(base.facts || [])];
  const info = { ...base, facts, cites: [...(base.cites || [])] };
  if (n.kind === 'place') {
    const pre = model.arcs.filter((a) => a.to === n.id).map((a) => `${a.from}${a.type ? ` (${a.type})` : ''}`);
    const post = model.arcs.filter((a) => a.from === n.id).map((a) => `${a.to}${a.type ? ` (${a.type})` : ''}`);
    facts.push(['tokens now', (n.el.kind || 'token') === 'token' ? String(marking()[n.id] || 0) : 'a data place: no marking (firing.go)']);
    facts.push(['filled by', pre.join(', ') || 'nothing']);
    facts.push(['read or consumed by', post.join(', ') || 'nothing']);
    info.note = n.fused
      ? 'A wire: places fused by token or data links into one slot. RenderFlatDOT double-borders it (peripheries=2).'
      : 'One member, so the flat ID is the member\'s qualified ID.';
    info.cites.push(n.fused ? C.wirePeri : C.flatDot, C.initial);
  } else {
    const { inputs, outputs, tests } = ioArcs(model, n.id);
    const why = whyNotEnabled(model, marking(), n.id);
    facts.push(['consumes', inputs.map((a) => `${a.from}${(a.weight || 1) > 1 ? ` ×${a.weight}` : ''}`).join(', ') || 'nothing']);
    facts.push(['produces', outputs.map((a) => `${a.to}${(a.weight || 1) > 1 ? ` ×${a.weight}` : ''}`).join(', ') || 'nothing']);
    if (tests.length) facts.push(['reads (read arcs)', tests.map((a) => `${a.from} ≥ ${a.weight || 1}${a.guard ? ' (a guard link, lowered)' : ''}`).join(', ')]);
    facts.push(['at this marking', why === null ? 'enabled: click to fire' : `not enabled: ${why}`]);
    info.note = n.fused
      ? 'Several member transitions that now fire as one (event links). RenderFlatDOT double-borders it (peripheries=2). It fires only when every member could.'
      : 'One member, so the flat ID is the member\'s qualified ID.';
    info.cites.push(n.fused ? C.fusedPeri : C.flatDot, C.whyNot, C.fire);
  }
  return info;
}

// --- orders: legend --------------------------------------------------------------------------

function drawLegend(ctx, root, L) {
  const g = ctx.svg('g', { transform: `translate(${L.x},${L.y})` });
  g.appendChild(ctx.svg('rect', { x: 0, y: 0, width: L.w, height: L.h, rx: 10, fill: '#fff', stroke: '#dde1e6' }));
  const row = (i, glyph, text) => {
    const y = 18 + i * 21.5;
    const gg = ctx.svg('g', { transform: `translate(22,${y})` });
    glyph(gg);
    g.appendChild(gg);
    g.appendChild(ctx.svg('text', { x: 44, y: y + 3.8, 'font-size': 10.5, fill: INK }, text));
  };
  row(0, (gg) => { gg.appendChild(ctx.svg('circle', { r: 8, fill: '#fff', stroke: INK, 'stroke-width': 1.3 })); gg.appendChild(ctx.svg('circle', { r: 2.4, fill: INK })); }, 'place, with its tokens');
  row(1, (gg) => gg.appendChild(ctx.svg('rect', { x: -11, y: -7, width: 22, height: 14, rx: 4, fill: PAPER, stroke: INK, 'stroke-width': 1.3 })), 'transition');
  row(2, (gg) => gg.appendChild(ctx.svg('rect', { x: -11, y: -7, width: 22, height: 14, rx: 4, fill: EN_FILL, stroke: EN, 'stroke-width': 2 })), 'enabled: click to fire');
  row(3, (gg) => { gg.appendChild(ctx.svg('rect', { x: -12, y: -8, width: 24, height: 16, rx: 5, fill: '#fff', stroke: INK, 'stroke-width': 1.2 })); gg.appendChild(ctx.svg('rect', { x: -9, y: -5, width: 18, height: 10, rx: 3, fill: PAPER, stroke: INK, 'stroke-width': 1.2 })); }, 'fused (peripheries=2)');
  row(4, (gg) => gg.appendChild(ctx.svg('line', { x1: -14, y1: 0, x2: 13, y2: 0, stroke: ARC, 'stroke-width': 1.3, 'marker-end': 'url(#fv-ar)' })), 'arc; weight > 1 written on it');
  row(5, (gg) => { gg.appendChild(ctx.svg('line', { x1: -14, y1: 0, x2: 11, y2: 0, stroke: READ, 'stroke-width': 1.5, 'stroke-dasharray': '5 3.5' })); gg.appendChild(ctx.svg('circle', { cx: 12, cy: 0, r: 2.6, fill: READ })); }, 'read arc (guard link, lowered)');
  row(6, (gg) => gg.appendChild(ctx.svg('rect', { x: -12, y: -7, width: 24, height: 14, rx: 5, fill: '#f1ebfa', stroke: '#d3d9e0' })), 'cluster: one subnet prefix (page)');
  const t = ctx.svg('text', { x: 12, y: L.h - 8, 'font-size': 9.5, fill: MUTED }, 'shapes: go-pflow RenderFlatDOT');
  g.appendChild(t);
  ctx.hover(g, {
    title: 'How the flat net is drawn',
    definition: 'RenderFlatDOT: a place is a circle, a transition a rounded box, a wire or fused transition is double-bordered (peripheries=2). arcAttrs: an inhibitor arc has a circle head, a read arc is dashed and undirected, a weight above 1 is the arc\'s label.',
    facts: [['the dot on a read arc', 'this page\'s mark for the transition end (RenderFlatDOT draws the read arc with no head)'], ['clusters', 'this page\'s grouping by member subnet; RenderFlatDOT draws none'], ['green', 'enabled at the current marking (firing.go EnabledWhyNot returns nil)']],
    cites: [C.dotDoc, C.flatDot, C.wirePeri, C.fusedPeri, C.arcAttrs, C.whyNot],
  });
  root.appendChild(g);
}

// --- orders: merge animation (a link was just added) ---------------------------------------

function mergeAnimation(ctx, lay, map, gFx, refs, arcEls) {
  const ev = ctx.event;
  if (!ev || !['link-added', 'links-reset'].includes(ev.type)) return;
  const byId = ctx.orders.byId;
  const targets = new Set();
  const endOf = (ref) => { const s = byId[ref.subnet]; const p = s && s.ports.find((q) => q.id === ref.port); return p ? { s, p } : null; };
  if (ev.type === 'link-added') {
    const l = ev.link;
    const a = endOf(l.from), b = endOf(l.to);
    if (!a || !b) return;
    if (l.kind === 'event') targets.add(flatOf(map, `${a.s.id}/${a.p.transition}`));
    else if (l.kind === 'token' || l.kind === 'data') targets.add(flatPlaceOf(map, `${a.s.id}/${a.p.place}`));
    else if (l.kind === 'guard') {
      // A guard link adds a read arc: draw it in.
      const t = flatOf(map, `${a.s.id}/${a.p.transition}`), pl = flatPlaceOf(map, `${b.s.id}/${b.p.place}`);
      const T = lay.nodes.get(t), P = lay.nodes.get(pl);
      if (T && P) {
        const ln = ctx.svg('line', { x1: P.x, y1: P.y, x2: T.x, y2: T.y, stroke: READ, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.8 });
        gFx.appendChild(ln);
        const len = Math.hypot(T.x - P.x, T.y - P.y);
        ln.animate([{ strokeDasharray: `0 ${len}` }, { strokeDasharray: `${len} 0` }], { duration: 750, easing: 'ease-out' }).finished.then(() => ln.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 400 }).finished.then(() => ln.remove()));
      }
      return;
    }
  } else {
    for (const n of lay.nodes.values()) if (n.fused) targets.add(n.id);
  }
  for (const id of targets) {
    const n = lay.nodes.get(id);
    if (!n || !n.fused) continue;
    const ref = n.kind === 'transition' ? refs.trans.get(id) : refs.places.get(id);
    // The members start at their old homes and slide together; the fused element grows in.
    for (const m of n.members) {
      const h = lay.home[m];
      if (!h) continue;
      const [pre, loc] = splitId(m);
      const ghost = n.kind === 'transition'
        ? ctx.svg('g', {}, ctx.svg('rect', { x: -(mw(loc, 9.5) + 18) / 2, y: -14, width: mw(loc, 9.5) + 18, height: 28, rx: 6, fill: '#fff', stroke: ctx.theme.LINK_STYLE.event.color, 'stroke-width': 1.8 }), ctx.svg('text', { y: 4, 'text-anchor': 'middle', 'font-size': 9.5, fill: INK, class: 'fv-mono' }, loc))
        : ctx.svg('g', {}, ctx.svg('circle', { r: PR, fill: '#fff', stroke: ctx.theme.LINK_STYLE[ev.type === 'link-added' ? ev.link.kind : 'token'].color, 'stroke-width': 1.8 }), ctx.svg('text', { y: PR + 12, 'text-anchor': 'middle', 'font-size': 9.5, fill: INK, class: 'fv-mono' }, `${pre}${loc}`));
      gFx.appendChild(ghost);
      // Hold at home, slide together, then hand over to the fused element.
      ghost.animate([
        { transform: `translate(${h.x}px, ${h.y}px)`, opacity: 1 },
        { transform: `translate(${h.x}px, ${h.y}px)`, opacity: 1, offset: 0.12, easing: 'cubic-bezier(.5,0,.3,1)' },
        { transform: `translate(${n.x}px, ${n.y}px)`, opacity: 1, offset: 0.72 },
        { transform: `translate(${n.x}px, ${n.y}px) scale(0.9)`, opacity: 0 },
      ], { duration: 900, fill: 'forwards' }).finished.then(() => ghost.remove(), () => ghost.remove());
    }
    if (ref) {
      ref.g.animate([
        { opacity: 0, transform: `translate(${n.x}px, ${n.y}px) scale(0.7)` },
        { opacity: 0, transform: `translate(${n.x}px, ${n.y}px) scale(0.7)`, offset: 0.62 },
        { opacity: 1, transform: `translate(${n.x}px, ${n.y}px) scale(1.1)`, offset: 0.86 },
        { opacity: 1, transform: `translate(${n.x}px, ${n.y}px) scale(1)` },
      ], { duration: 900, easing: 'ease-out' });
    }
    for (const el of arcEls.get(id) || []) el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: 900 });
  }
}

// --- orders: scenarios ------------------------------------------------------------------------

const holds = (op, a, n) => ({ '==': a === n, '!=': a !== n, '>=': a >= n, '<=': a <= n, '>': a > n, '<': a < n }[op]);

/**
 * A scenario as the registry runs it (bundle.run {scenario}): from the initial
 * marking, each member resolved to the flat transition that contains it, stopping
 * at the first that cannot fire, then the predicates. The flat net drawn here is
 * the live composition's, so the live engine runs it.
 */
function scenarioRun(model, map, sc) {
  const r = runOf(engines.live.call('bundle.run', { scenario: sc.id }));
  return { ...r, error: null };
}

/** Same links as the page default (event links compared either way round, as they have no direction rule) and no second instance. */
function isDefaultComposition(ctx) {
  const k = (l) => (l.kind === 'event' ? `event:${[`${l.from.subnet}:${l.from.port}`, `${l.to.subnet}:${l.to.port}`].sort().join('~')}` : `${l.kind}:${l.from.subnet}:${l.from.port}->${l.to.subnet}:${l.to.port}`);
  const a = ctx.orders.links.map(k).sort().join(','), b = defaultLinks().map(k).sort().join(',');
  return a === b && !(ctx.orders.extras || []).length;
}

/**
 * Why "the worker returns to the pool" failed, read off this flat net and this run
 * (not assumed): which flat transition holds workers/release, what it is fused with,
 * and whether the run fired it. The idiom's caveat is quoted only when its situation
 * is the one on screen: release fused with payment/commit alone, and the saga rolled back.
 */
function leakWhy(ctx, map, r) {
  const el = ctx.el;
  const acq = flatOf(map, 'workers/acquire'), rel = flatOf(map, 'workers/release');
  const fired = new Set(r.steps.filter((s) => s.enabled).map((s) => s.flat));
  if (!acq || !rel || !fired.has(acq) || fired.has(rel)) return null;
  const partners = (map.fusedGroups[rel] || ['workers/release']).filter((m) => m !== 'workers/release');
  const rolled = flatPlaceOf(map, 'payment/rolled_back');
  const rolledBack = !!rolled && (r.finalMarking[rolled] || 0) > 0;
  const idiomCase = partners.length === 1 && partners[0] === 'payment/commit' && rolledBack;
  const kids = [el('b', {}, 'Why the worker does not return. ')];
  kids.push(acq === 'workers/acquire' ? 'workers/acquire fired, ' : ['workers/acquire fired as part of ', codeId(ctx, acq), ', ']);
  if (partners.length) kids.push('but workers/release fires only as part of ', codeId(ctx, rel), ` (fused with ${partners.join(', ')} by event links), and this run never fires it`);
  else kids.push('but workers/release is fused with nothing (no event link reaches workers:release here), and the script never fires it');
  kids.push(', so the token stays in workers/in_use: the pool leaks a unit.');
  if (idiomCase) kids.push(' That is the idiom\'s own caveat: "Fires only on commit. If the saga rolls back, no port fires, the worker stays in in_use and the pool leaks a unit." (patterns.ttl:496). ROADMAP Phase 4 expects exactly this failure (ROADMAP.md:276-280, 289-291).');
  const why = el('div', { class: 'fv-why' }, ...kids);
  ctx.hover(why, idiomCase
    ? { title: 'the pool-leak caveat', concept: { iri: 'https://ontology.pflow.xyz/pattern/idiom-pool-release-saga-commit', types: ['ns:CompositionIdiom'] }, definition: 'Release the worker when the saga commits.', facts: [['workers/release is in', rel], ['fired in this run', 'no']], caveats: ['Fires only on commit. If the saga rolls back, no port fires, the worker stays in in_use and the pool leaks a unit. Releasing on both outcomes is not expressible with the declared ports.'], cites: [C.leak, C.worked, C.d44] }
    : { title: 'why the worker does not return', definition: 'Read off this flat net: the flat transition that holds workers/release never fired in this run.', facts: [['workers/acquire is in', acq], ['workers/release is in', rel], ['fired in this run', 'acquire yes, release no']], note: 'The idiom caveat (patterns.ttl:496) is quoted only when workers/release is fused with payment/commit alone and the saga rolled back; that is not the situation in this run.', cites: [C.whyNot, C.fire] });
  return why;
}

/** A flat ID as <code>, breakable after each "+" of a fused name. */
function codeId(ctx, id) {
  const parts = String(id).split('+');
  return ctx.el('code', {}, parts.flatMap((p, i) => (i ? [ctx.el('wbr', {}), `+${p}`] : [p])));
}

function paintScenario(ctx, box, model, map) {
  const el = ctx.el;
  const run = S.run;
  if (!run) {
    box.replaceChildren(el('h4', {}, 'Scenario checks'),
      el('p', {}, 'A scenario starts from the initial marking, fires its script one step at a time (each member transition resolved to the flat transition that contains it), stops at the first step that is not enabled, then checks its expected marking predicates.'),
      el('p', { class: 'fv-muted' }, 'The scripts and predicates are judgment, written from the description and then frozen (bundle.scenarios, ROADMAP 4.4). Whether a step is enabled, and what the marking becomes, is the registry\'s run (bundle.run: pflow-metamodel\'s enabled/fire, the firing rule of go-pflow\'s firing.go).'));
    return;
  }
  const sc = run.scenario, r = run.result;
  const shown = r.steps.slice(0, run.shown);
  const list = el('ol', {}, shown.map((st) => el('li', { class: st.enabled ? '' : 'fv-step-blocked' },
    st.enabled ? el('span', { class: 'fv-pass' }, 'FIRED') : el('span', { class: 'fv-stop' }, 'STOP'),
    el('code', {}, st.member), st.flat && st.flat !== st.member ? [' → ', codeId(ctx, st.flat)] : '',
    st.enabled ? '' : el('div', { class: 'fv-muted' }, `not enabled: ${st.why}`))));
  const kids = [el('h4', {}, `${sc.id}: ${sc.title}`), list];
  if (run.done) {
    kids.push(el('p', { class: 'fv-muted' }, r.completed ? `All ${r.steps.length} steps fired.` : `Stopped at step ${r.stoppedAt + 1} of ${sc.script.length}.`));
    kids.push(el('ul', { class: 'fv-cons' }, r.expect.map((e) => {
      const li = el('li', {}, e.pass ? el('span', { class: 'fv-pass' }, 'PASS') : el('span', { class: 'fv-fail' }, 'FAIL'), e.says, ' ',
        el('span', { class: 'fv-muted' }, `(${e.flat || e.place} ${e.op} ${e.n}; is ${e.actual ?? 'no such place'})`));
      ctx.hover(li, { title: `expected: ${e.says}`, definition: `${e.place} ${e.op} ${e.n}`, facts: [['flat place', e.flat || '(not in the flat net)'], ['at the end of the run', String(e.actual)], ['verdict', e.pass ? 'PASS' : 'FAIL']], note: 'A scenario predicate: judgment, written from the description and frozen (bundle.scenarios). The verdict is bundle.run\'s. ROADMAP 4.3 proposes recording such checks as ns:FaithfulnessCheck receipts; that class is not in the ontology yet.', cites: [C.faith, C.d44] });
      return li;
    })));
    const leakFail = r.expect.some((e) => !e.pass && e.place === 'workers/available') && r.completed;
    const why = leakFail ? leakWhy(ctx, map, r) : null;
    if (why) kids.push(why);
    if (sc.note) {
      kids.push(el('p', { class: 'fv-muted' }, isDefaultComposition(ctx)
        ? `Scenario note (bundle.scenarios): ${sc.note}`
        : `Scenario note (bundle.scenarios, written for the three-idiom composition; this composition differs, so read the run above instead): ${sc.note}`));
    }
  } else {
    kids.push(el('p', { class: 'fv-muted' }, 'firing…'));
  }
  box.replaceChildren(...kids);
}

// --- orders: declared constraints at the current marking ------------------------------------

/** Evaluate a constraint of the form  tokens("a") + tokens("b") + 3 == N  (the form the constructors emit). */
function evalConstraint(expr, mk) {
  const m = /^(.*?)\s*(==|!=|>=|<=|>|<)\s*(.*)$/.exec(expr);
  if (!m) return null;
  const side = (s) => {
    let total = 0; const parts = [];
    for (const term of s.split('+').map((x) => x.trim())) {
      const t = /^tokens\("([^"]+)"\)$/.exec(term);
      if (t) { const v = mk[t[1]] || 0; total += v; parts.push(v); continue; }
      if (/^-?\d+$/.test(term)) { total += Number(term); parts.push(Number(term)); continue; }
      return null;
    }
    return { total, parts };
  };
  const l = side(m[1]), r = side(m[3]);
  if (!l || !r) return null;
  return { ok: holds(m[2], l.total, r.total), lhs: l.parts.join(' + '), op: m[2], rhs: r.total, total: l.total };
}

function paintConstraints(ctx, box, model, map, mk, byId) {
  const el = ctx.el;
  const rows = model.constraints.map((c) => {
    const v = evalConstraint(c.expr, mk);
    const local = c.id.slice(c.subnet.length + 1);
    const li = el('li', {},
      v === null ? el('span', { class: 'fv-stop' }, 'NOT EVALUATED') : v.ok ? el('span', { class: 'fv-hold' }, 'HOLDS') : el('span', { class: 'fv-viol' }, 'VIOLATED'),
      el('code', {}, c.id), ' ',
      v ? el('span', { class: 'fv-expr' }, `${v.lhs} ${v.op} ${v.rhs}`) : el('span', { class: 'fv-expr' }, c.expr));
    const s = byId[c.subnet];
    const info = s ? ctx.info.invariantInfo(s, { id: local, expr: c.expr }) : { title: c.id, facts: [] };
    info.facts = [...(info.facts || []), ['flat expression', c.expr], ['at this marking', v ? `${v.lhs} ${v.op} ${v.rhs}: ${v.ok ? 'holds' : 'violated'}` : 'not evaluated (expression form not handled here)']];
    info.cites = [...(info.cites || []), C.constraints];
    ctx.hover(li, info);
    return li;
  });
  // The leak, and why conservation does not catch it.
  const inUse = flatPlaceOf(map, 'workers/in_use'), rolled = flatPlaceOf(map, 'payment/rolled_back');
  const leaking = inUse && rolled && (mk[inUse] || 0) > 0 && (mk[rolled] || 0) > 0;
  const pool = model.constraints.find((c) => c.id === 'workers/pool_conservation');
  const kids = [el('h4', {}, 'Declared constraints, at this marking'), el('ul', { class: 'fv-cons' }, rows)];
  if (leaking && pool) {
    const v = evalConstraint(pool.expr, mk);
    const why = el('div', { class: 'fv-why' },
      el('b', {}, 'Conservation is not liveness. '),
      `The saga has rolled back with a worker still in workers/in_use, and pool_conservation still holds (${v ? `${v.lhs} == ${v.rhs}` : pool.expr}): a stuck token keeps the sum. That is the gap ROADMAP Phase 4's faithfulness checks are for: Validate and verify say what a net satisfies, not whether it is the system described, so frozen scenarios are run as well (ROADMAP.md:247-295). Its 4.1 exit expects the leak to show as "a failed conservation check on the rollback path" (lines 240-242); on this net the declared conservation constraint holds, and what fails is the scenario predicate.`);
    ctx.hover(why, { title: 'conservation is not liveness', concept: { iri: 'https://ontology.pflow.xyz/pattern/resource-pool-inv-conservation', types: ['ns:PatternInvariant'] }, definition: 'tokens("available") + tokens("in_use") == capacity', facts: [['at this marking', v ? `${v.lhs} == ${v.rhs}: holds` : '?'], ['what fails instead', 'the scenario predicate "the worker returns to the pool"']], cites: [C.poolInv, C.faith, C.exit41, C.worked] });
    kids.push(why);
  }
  kids.push(el('p', { class: 'fv-muted' }, 'The constructors declare these; Flatten carries them over with qualified IDs and rewritten place references. Holding at one marking is not a proof (go-pflow verify or sim_verify decide that).'));
  box.replaceChildren(...kids);
}

// --- orders: who fires the runs ---------------------------------------------------------------

function paintGo(ctx, box) {
  const el = ctx.el;
  box.replaceChildren(el('h4', {}, 'Who fires these runs'),
    el('p', {}, 'Every step above, the token game and the scenario verdicts are the registry\'s (pflow-native\'s bundle.run, in the vendored wasm): pflow-metamodel\'s enabled/fire on pflow-compose\'s flat net. The page fires nothing itself.'),
    el('p', { class: 'fv-muted' }, 'No go-pflow run is shown beside them: the engine here is the registry, and pflow-native checks the same four scenario runs against go-pflow c802f34 in its own tests (crates/core/tests/views_compose.rs).'));
}

// =============================================================================================
// connect4: the net the plan searches
// =============================================================================================

/** The fixture's places, transitions and arcs, read for drawing (the token game is the c4 engine's). */
function netModel(net) {
  const one = (v, d) => (Array.isArray(v) ? (v[0] ?? d) : (v ?? d));
  return {
    name: net.name,
    places: Object.entries(net.places).map(([id, p]) => ({ id, kind: 'token', initial: one(p.initial, 0) || 0, capacity: one(p.capacity, 0) || 0 })),
    transitions: Object.keys(net.transitions).map((id) => ({ id })),
    arcs: net.arcs.map((a) => ({ from: a.source, to: a.target, weight: one(a.weight, 1) || 1, ...(a.inhibitTransition ? { type: 'inhibitor' } : {}) })),
  };
}

// The declaration pflow-rs tests/common/mod.rs makes for this fixture (lines 23-30).
const isAuto = (tid) => tid.includes('win');
const signOf = (tid) => (tid.startsWith('x_') ? 1 : -1);
const REWARD = { win_x: 1, win_o: -1 };

/**
 * Game::settle (game.rs:221-232): fire automatic transitions, lowest index first,
 * until none is enabled. pflow-rs's index order is ID order: model_from_json sorts
 * the transition IDs (pflow-parser/src/lib.rs:129-131), and Rust's byte order on
 * these ASCII IDs is JavaScript's default sort.
 */
function settle(model, mk) {
  if (!model.autoOrder) model.autoOrder = model.transitions.map((t) => t.id).filter(isAuto).sort();
  const fired = [];
  for (let i = 0; i < 1000; i++) {
    const t = model.autoOrder.find((id) => whyNotEnabled(model, mk, id) === null);
    if (!t) return { mk, fired };
    mk = fire(model, mk, t);
    fired.push(t);
  }
  return { mk, fired, endless: true };
}

function renderConnect4(ctx) {
  const gen = S.gen;
  const net = ctx.connect4.net;
  injectStyle(ctx);
  if (!net) { ctx.note('data/connect-4.json did not load, so there is no net to draw.', 'warn'); return; }
  if (!S.c4model || S.c4model.net !== net) S.c4model = { net, model: c4Model(netModel(net), net) };
  ctx.emit('net', 'connect-4', { places: Object.keys(net.places).length, transitions: Object.keys(net.transitions).length, arcs: net.arcs.length });
  const model = S.c4model.model;
  if (!S.c4 || S.c4.name !== net.name) {
    const s0 = settle(model, initialMarking(model));
    S.c4 = { name: net.name, marking: s0.mk, log: [], last: null };
  }
  const st = S.c4;

  // Fit the fixture's coordinates.
  const all = [...Object.values(net.places), ...Object.values(net.transitions)];
  const minX = Math.min(...all.map((n) => n.x)), maxX = Math.max(...all.map((n) => n.x));
  const minY = Math.min(...all.map((n) => n.y)), maxY = Math.max(...all.map((n) => n.y));
  const W = 1150, M = 34, TOP = 34;
  const k = (W - 2 * M) / (maxX - minX);
  const H = Math.ceil(TOP + (maxY - minY) * k + 64);
  const X = (x) => M + (x - minX) * k, Y = (y) => TOP + (y - minY) * k;
  const RP = 7.2, TS = 8.6;

  const status = ctx.el('span', { class: 'fv-status' });
  const resetBtn = ctx.el('button', { onclick: () => { if (S.busy) return; const s0 = settle(model, initialMarking(model)); st.marking = s0.mk; st.log = []; st.last = null; paint(); } }, '↺ New game');
  ctx.root.appendChild(ctx.el('div', { class: 'fv-bar' }, ctx.el('span', { class: 'fv-lab' }, 'Play the net:'), resetBtn,
    ctx.el('span', { class: 'fv-lab' }, 'click a green drop transition (the registry fires it: sim.fire); automatic ones then settle (pflow-rs Game::settle).'), status));

  const root = ctx.svgRoot(W, H, { class: 'view-svg fv-svg' });
  root.appendChild(markers(ctx));
  const gGroups = ctx.svg('g', {}), gArcs = ctx.svg('g', {}), gHi = ctx.svg('g', { 'pointer-events': 'none' }), gNodes = ctx.svg('g', {}), gTop = ctx.svg('g', { 'pointer-events': 'none' });
  root.append(gGroups, gArcs, gHi, gNodes, gTop);
  ctx.root.appendChild(root);

  // Group captions: from the names, as tests/common/mod.rs reads them.
  const groups = [
    [/^open_\d+_\d+$/, 'open_<c>_<r>', 'places · row 0 is the bottom'],
    [/^x_\d+_\d+$/, 'x_<c>_<r>', 'places'],
    [/^o_\d+_\d+$/, 'o_<c>_<r>', 'places'],
  ];
  for (const [re, name, what] of groups) {
    const ids = Object.keys(net.places).filter((id) => re.test(id));
    if (!ids.length) continue;
    const xs = ids.map((id) => X(net.places[id].x)), ys = ids.map((id) => Y(net.places[id].y));
    const x0 = Math.min(...xs) - 14, x1 = Math.max(...xs) + 14, y0 = Math.min(...ys) - 14, y1 = Math.max(...ys) + 14;
    const gr = ctx.svg('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, rx: 10, fill: '#eef1f5', 'fill-opacity': 0.6, stroke: '#dde1e6' });
    ctx.hover(gr, {
      title: `${name}: ${ids.length} places of the fixture`,
      definition: 'A group by name only. The fixture\'s description says each column is an open-slot chain with row 0 at the bottom; the page draws the places where the fixture puts them.',
      facts: [['tokens now', String(ids.reduce((a, id) => a + (st.marking[id] || 0), 0))]],
      note: 'The grouping is the page\'s; the library reads no names (tests/common/mod.rs:5-8).',
      cites: [C.c4fixture, C.c4names],
    });
    gGroups.appendChild(gr);
    gGroups.appendChild(ctx.svg('text', { x: x0 + 2, y: y0 - 6, 'font-size': 11, fill: INK }, ctx.svg('tspan', { class: 'fv-mono', 'font-weight': 700 }, name), ctx.svg('tspan', { fill: MUTED, dx: 6 }, `${ids.length} ${what}`)));
  }
  const tGroups = [
    [/^x_play_/, 'x_play_<c>_<r>', 'moves, sign +1'],
    [/^o_play_/, 'o_play_<c>_<r>', 'moves, sign −1'],
    [/^x_win_/, 'x_win_*', 'automatic (name contains "win") → win_x'],
    [/^o_win_/, 'o_win_*', 'automatic → win_o'],
  ];
  for (const [re, name, what] of tGroups) {
    const ids = Object.keys(net.transitions).filter((id) => re.test(id));
    if (!ids.length) continue;
    const xs = ids.map((id) => X(net.transitions[id].x)), y = Y(net.transitions[ids[0]].y);
    gGroups.appendChild(ctx.svg('text', { x: Math.min(...xs) - 6, y: y - 10, 'font-size': 10.5, fill: INK }, ctx.svg('tspan', { class: 'fv-mono', 'font-weight': 700 }, name), ctx.svg('tspan', { fill: MUTED, dx: 6 }, `${ids.length} ${what}`)));
  }

  // Arcs: one faint path; a hovered node's preset and postset drawn on top.
  const nodeXY = (id) => { const p = net.places[id] || net.transitions[id]; return { x: X(p.x), y: Y(p.y), place: !!net.places[id] }; };
  let d = '';
  for (const a of model.arcs) { const p = nodeXY(a.from), q = nodeXY(a.to); d += `M${p.x.toFixed(1)},${p.y.toFixed(1)}L${q.x.toFixed(1)},${q.y.toFixed(1)}`; }
  gArcs.appendChild(ctx.svg('path', { d, stroke: '#8c939d', 'stroke-width': 0.6, 'stroke-opacity': 0.13, fill: 'none' }));
  const arcsOf = new Map();
  for (const a of model.arcs) { for (const id of [a.from, a.to]) { if (!arcsOf.has(id)) arcsOf.set(id, []); arcsOf.get(id).push(a); } }
  const showArcs = (id) => {
    gHi.replaceChildren();
    for (const a of arcsOf.get(id) || []) {
      const p = nodeXY(a.from), q = nodeXY(a.to);
      const isPre = a.to === id; // into the hovered node
      const color = isPre ? PRE : POST;
      const back = { x: q.x - p.x, y: q.y - p.y }, len = Math.hypot(back.x, back.y) || 1;
      const r = q.place ? RP + 1.5 : TS / 2 + 2.5;
      const p0 = { x: p.x + (back.x / len) * (p.place ? RP : TS / 2), y: p.y + (back.y / len) * (p.place ? RP : TS / 2) };
      const p1 = { x: q.x - (back.x / len) * r, y: q.y - (back.y / len) * r };
      gHi.appendChild(ctx.svg('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: color, 'stroke-width': 1.5, 'stroke-opacity': 0.9, 'marker-end': `url(#fv-ar-${isPre ? 'pre' : 'post'})` }));
    }
  };

  // Nodes.
  const refs = { places: new Map(), trans: new Map() };
  const ctrl = new Set(['x_turn', 'o_turn', 'game_active', 'win_x', 'win_o']);
  for (const [id, p] of Object.entries(net.places)) {
    const g = ctx.svg('g', { class: 'fv-node fv-p', transform: `translate(${X(p.x)},${Y(p.y)})`, 'data-flat-id': id });
    const big = ctrl.has(id);
    const r = big ? RP + 4 : RP;
    g.appendChild(ctx.svg('circle', { class: 'fv-shape', r, fill: '#fff', stroke: INK, 'stroke-width': big ? 1.4 : 1 }));
    const tok = ctx.svg('g', {});
    g.appendChild(tok);
    if (big) g.appendChild(ctx.svg('text', { y: r + 13, 'text-anchor': 'middle', 'font-size': 10.5, fill: INK, class: 'fv-mono', stroke: PAPER, 'stroke-width': 3, 'paint-order': 'stroke' }, id));
    refs.places.set(id, { g, tok, r });
    g.addEventListener('pointerenter', () => showArcs(id));
    g.addEventListener('pointerleave', () => gHi.replaceChildren());
    liveHover(ctx, g, () => c4Info(ctx, id, true, net, model, () => st.marking));
    gNodes.appendChild(g);
  }
  for (const [id, t] of Object.entries(net.transitions)) {
    const g = ctx.svg('g', { class: 'fv-node fv-t', transform: `translate(${X(t.x)},${Y(t.y)})`, 'data-flat-id': id });
    g.appendChild(ctx.svg('rect', { x: -6.5, y: -9, width: 13, height: 18, fill: 'transparent' })); // hit area
    g.appendChild(ctx.svg('rect', { class: 'fv-shape', x: -TS / 2, y: -TS / 2, width: TS, height: TS, rx: 1.5, fill: PAPER, stroke: isAuto(id) ? MUTED : INK, 'stroke-width': 1 }));
    refs.trans.set(id, { g });
    g.addEventListener('pointerenter', () => showArcs(id));
    g.addEventListener('pointerleave', () => gHi.replaceChildren());
    g.addEventListener('click', (e) => {
      if (S.busy) { e.preventDefault(); return; }
      if (isAuto(id)) return;
      if (whyNotEnabled(model, st.marking, id) !== null) return; // a disabled click pins the inspector instead
      e.preventDefault();
      play(id);
    });
    liveHover(ctx, g, () => c4Info(ctx, id, false, net, model, () => st.marking));
    gNodes.appendChild(g);
  }

  // Caption under the drawing.
  root.appendChild(ctx.svg('text', { x: M, y: H - 12, 'font-size': 10.5, fill: MUTED }, `Drawn at the fixture's own x/y, scaled. Hover a node: its preset arcs in blue, postset arcs in amber. ${net.arcs.length.toLocaleString('en-US')} arcs, ${model.arcs.some((a) => a.type === 'inhibitor') ? `${model.arcs.filter((a) => a.type === 'inhibitor').length} of them inhibitor arcs (inhibitTransition)` : 'all ordinary (no arc in this fixture sets inhibitTransition)'}.`));

  function paint() {
    if (gen !== S.gen) return;
    for (const [id, r] of refs.places) paintTokens(ctx, r.tok, st.marking[id] || 0, r.r);
    const moves = [];
    for (const [id, r] of refs.trans) {
      const ok = !isAuto(id) && whyNotEnabled(model, st.marking, id) === null;
      if (ok) moves.push(id);
      r.g.classList.toggle('fv-en', ok);
    }
    const sides = new Set(moves.map(signOf));
    const kids = [];
    if (moves.length) {
      kids.push(ctx.el('b', {}, `${moves.length}`), ` moves, all ${sides.size === 1 ? (sides.has(1) ? 'x_ (sign +1)' : 'o_ (sign −1)') : 'of mixed sides'}`);
    } else {
      const score = Object.entries(REWARD).reduce((a, [p, w]) => a + w * (st.marking[p] || 0), 0);
      kids.push(ctx.el('b', {}, 'final'), ` · no move · reward win_x·(+1) + win_o·(−1) = ${score}`);
    }
    kids.push(` · ply ${st.log.length}`);
    if (st.last && st.last.length) kids.push(` · settled: ${st.last.join(', ')}`);
    status.replaceChildren(...kids);
  }

  async function play(id) {
    S.busy = true;
    const t = net.transitions[id];
    const from = { x: X(t.x), y: Y(t.y) };
    const before = st.marking;
    const { inputs, outputs } = ioArcs(model, id);
    refs.trans.get(id).g.classList.add('fv-firing');
    await Promise.all(inputs.map((a) => travel(ctx, gTop, nodeXY(a.from), from, 260, 0, 3)));
    await Promise.all(outputs.map((a) => travel(ctx, gTop, from, nodeXY(a.to), 300, 0, 3)));
    if (gen !== S.gen) return;
    refs.trans.get(id).g.classList.remove('fv-firing');
    const s = settle(model, fire(model, before, id));
    st.marking = s.mk; st.log.push(id); st.last = s.fired;
    S.busy = false;
    for (const a of s.fired) {
      const g = refs.trans.get(a).g;
      g.classList.add('fv-firing');
      showArcs(a);
      setTimeout(() => { g.classList.remove('fv-firing'); gHi.replaceChildren(); }, 1400);
    }
    paint();
  }

  paint();
  ctx.note(`The net it searches is the pflow-rs fixture data/connect-4.json: "${net.description}" pflow-rs reads it as a game only through tests/common/mod.rs, which declares the *win* transitions automatic, x_ moves for the side with sign +1, and rewards win_x +1, win_o −1. Nothing else (no goal, no strategy) is claimed here.`, 'honesty');
  const planNow = JSON.stringify(ctx.plan.json), planExact = JSON.stringify(toJSON(CONNECT4_EXACT));
  const whichPlan = ctx.plan.error
    ? `The plan as it stands is refused (${ctx.plan.error}), so it searches nothing; drawn anyway is the net an accepted plan would search`
    : planNow === planExact ? 'Drawn instead: the net plan:connect4-exact searches' : 'Drawn instead: the net the current plan (edited from plan:connect4-exact, and accepted) searches';
  ctx.note(`A search plan is not a net, so Flatten has nothing to flatten and no plan slot is drawn here (pieces are composed in the plan views; adding or removing one does not change this net). ${whichPlan}, at the fixture's own coordinates.`, 'na');
}

function c4Info(ctx, id, isPlace, net, model, marking) {
  const node = isPlace ? net.places[id] : net.transitions[id];
  const pre = model.arcs.filter((a) => a.to === id).map((a) => a.from);
  const post = model.arcs.filter((a) => a.from === id).map((a) => a.to);
  const facts = [['fixture x, y', `${node.x}, ${node.y}`]];
  if (isPlace) {
    facts.push(['initial', String((node.initial || [0])[0] || 0)], ['tokens now', String(marking()[id] || 0)], ['arcs in / out', `${pre.length} / ${post.length}`]);
  } else {
    const why = whyNotEnabled(model, marking(), id);
    facts.push(['preset', pre.join(', ')], ['postset', post.join(', ')]);
    facts.push(['read as (tests/common/mod.rs)', isAuto(id) ? 'automatic: its name contains "win"; it fires as soon as it is enabled' : `a move, sign ${signOf(id) > 0 ? '+1 (x)' : '−1 (o)'}`]);
    facts.push(['at this marking', why === null ? (isAuto(id) ? 'enabled (settles at once)' : 'enabled: click to play') : `not enabled: ${why}`]);
  }
  return {
    title: `${isPlace ? 'place' : 'transition'} ${id}`,
    concept: { iri: NS + (isPlace ? 'Place' : 'Transition'), types: [isPlace ? 'ns:Place' : 'ns:Transition'] },
    definition: '',
    facts,
    note: isPlace && REWARD[id] !== undefined ? `A reward place: tests/common/mod.rs:30 weighs it ${REWARD[id] > 0 ? '+1' : '−1'}.` : undefined,
    cites: [C.c4fixture, C.c4decl, ...(isPlace ? [] : [C.gameDoc, C.settle, C.idOrder]), C.whyNot],
  };
}

// =============================================================================================

export default {
  id: 'flat',
  title: 'The flattened net',
  short: 'Flat net',
  convention: {
    summary: 'The single place/transition net Flatten produces from the composition (go-pflow\'s FlattenWithMap, run here by the registry as pflow-compose\'s port, bundle.flatten): every subnet\'s places and transitions under namespaced IDs, places joined by token or data links fused into one wire:… place, transitions joined by event links fused into one fused:… transition, duplicate arcs merged (MergeSum: weights add), guard links with the default condition "> 0" lowered to read arcs. The shapes are RenderFlatDOT\'s: places are circles, transitions rounded boxes, fused elements double-bordered (peripheries=2), an arc weight above 1 written on the arc, a read arc dashed and undirected. The tokens are drawn as dots in the place (RenderFlatDOT writes the initial count in the label instead). A green transition is enabled at the current marking; click it to fire.',
    examples: {
      orders: 'queue ⊗ pool ⊗ saga with the three event idioms flattens to 21 places and 9 transitions. fused:orders/dequeue+payment/do_reserve+workers/acquire and fused:payment/commit+workers/release sit between the clusters they join. Play the token game or run a ROADMAP 4.4 scenario: the refund run ends with the worker still in workers/in_use, so "the worker returns to the pool" fails, while pool_conservation still holds.',
      connect4: 'A search plan is not a net, so there is nothing to flatten. Drawn instead is the net the plan searches: the pflow-rs Connect-4 fixture (131 places, 222 transitions, 1,924 arcs) at its own coordinates. Click a green drop to play; the automatic win detectors then settle, as pflow-rs\'s Game does.',
    },
    honesty: [
      'The flat IDs, arcs, weights, initial markings and constraints are Flatten\'s (the registry\'s bundle.flatten: pflow-compose, pflow-rs\'s port of go-pflow\'s FlattenWithMap). The positions and the clusters are this page\'s layout: RenderFlatDOT draws no clusters, and in the flat net an element belongs to a subnet only through its ID.',
      'No ports are drawn: Flatten removes the boundary. Links are made in the pattern-level views.',
      'A read arc (a guard link, lowered) is dashed and undirected, as RenderFlatDOT draws it; the small dot that marks its transition end is this page\'s. A hollow circle head would be an inhibitor arc.',
      'The scenario scripts and their expected predicates are judgment, written from the description and frozen (bundle.scenarios). Whether a step is enabled, and the marking it leaves, is the registry\'s bundle.run (pflow-metamodel\'s enabled/fire, go-pflow\'s firing rule from firing.go); the page fires nothing itself.',
      'Constraints are evaluated at the current marking only. Holding at one marking proves no invariant, and an invariant that holds is not liveness: pool_conservation holds while the refund run leaks a worker.',
      'Connect-4: the sides, the automatic transitions and the rewards are what pflow-rs tests/common/mod.rs declares for this fixture; nothing else is claimed. Automatic transitions settle as Game::settle does, lowest index first, and pflow-rs\'s index order is the sorted transition IDs (pflow-parser model_from_json), so the page asks for the same detector pflow-rs would fire; each firing is the registry\'s (sim.fire on the fixture).',
    ],
    bib: ['meseguer-montanari', 'baez-master', 'bruni-et-al', 'mei-douglas'],
    cites: [C.flatDot, C.dotDoc, C.wirePeri, C.fusedPeri, C.arcAttrs, ...FLATTEN_CITES, C.guardLower, C.constraints, C.initial, C.whyNot, C.fire, C.leak, C.faith, C.exit41, C.worked, C.d44, C.c4fixture, C.c4names, C.c4decl, C.gameDoc, C.settle, C.idOrder, C.score],
  },
  render(ctx) {
    S.gen++;
    S.busy = false;
    if (ctx.example === 'orders') renderOrders(ctx);
    else renderConnect4(ctx);
  },
};
