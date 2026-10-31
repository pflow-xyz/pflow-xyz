// View 8: incidence matrices. C = post − pre (places × transitions) of a P/T
// net, and how composition acts on it.
//
// orders: the block-diagonal C of the active instances (⊗ is a disjoint union)
// next to the C of the flat net (ctx.orders.flat: the registry's bundle.flatten,
// pflow-compose's port of go-pflow Flatten).
// An event link fuses transitions and MergeSum adds the fused columns; a token or
// data link fuses places and adds the fused rows; a guard link lowers to a read
// arc, which moves nothing, so C does not change. Under the flat matrix, y·C for
// every declared constraint that is a plain sum of tokens(...) == n, computed in
// this page from the flat net.
//
// connect4: a SearchPlan is not a net and has no incidence matrix. The view says
// so and draws the Connect-4 net's matrix instead: the registry's
// analysis.incidence on assets/connect-4.json (the c4 engine's document).
//
// Scene manifest (parity contract): orders `block` per instance (rows, cols),
// `matrix` "flat" (rows, cols), `invariant` per declared constraint (holds:
// y·C = 0 and y·M₀ = n; a constraint that is not a plain sum of tokens is not
// checked, holds false); connect4 `matrix` "connect-4" (rows, cols).
//
// No ports are drawn (a matrix has no boundary), so nothing is registered with
// ctx.snap; links are made in the views that draw ports and this one recomputes.

import { cite } from '../sources.js';
import { flatten, c4Incidence, FLATTEN_CITES } from '../model.js';

const go = (path, from, to = from, note = '') => cite('goPflow', path, from, to, note);
const rs = (path, from, to = from, note = '') => cite('pflowRs', path, from, to, note);
const road = (from, to, note) => cite('ontologyRoadmap', 'ROADMAP.md', from, to, note);

// Every line range below was read at the cited revision (go-pflow files are
// identical at 69257b3 and c802f34; pflow-rs at c396d46).
const CITE = {
  mergeArcs: go('metamodel/compose_flatten.go', 335, 411, 'mergeArcs: duplicates merge; under MergeSum weights add, which preserves each component\'s P-invariants (337-341)'),
  mergeSum: go('metamodel/compose.go', 200, 202, 'MergeSum: each component still consumes what it declared'),
  guard: go('metamodel/compose_flatten.go', 424, 482, 'applyGuardLinks: structural lowering adds a read (or inhibitor) arc, expression lowering a guard on the transition; neither moves tokens'),
  weightGo: go('petri/net.go', 98, 109, 'GetWeightSum: an arc\'s weight is the sum over its token colors (1 when empty); IncidenceMatrix uses it'),
  weightRs: rs('crates/pflow-core/src/net.rs', 100, 107, 'weight_sum: the same for a Shape A arc'),
  firing: go('metamodel/firing.go', 79, 120, 'Inputs/Outputs leave out read and inhibitor arcs; Tests holds them'),
  fire: go('metamodel/firing.go', 198, 212, 'Fire: subtract inputs, add outputs; read and inhibitor arcs move nothing'),
  incGo: go('reachability/invariants.go', 91, 151, 'IncidenceMatrix: C[p][t] = output − input; inhibitor arcs skipped'),
  structural: go('docs/MODEL-CORRECTNESS.md', 113, 113, 'method "structural": y*C = 0 on the incidence matrix'),
  incRs: rs('crates/pflow-reachability/src/invariants.rs', 142, 184, 'incidence_matrix: output − input; read and inhibitor arcs excluded'),
  inhibRs: rs('crates/pflow-reachability/src/invariants.rs', 497, 516, 'test: inhibitor arcs do not enter the incidence matrix'),
  rawArc: rs('crates/pflow-core/src/json.rs', 119, 131, 'RawArc: weight per token color, inhibitTransition'),
  rawWeight: rs('crates/pflow-core/src/json.rs', 186, 191, 'an absent weight is [1]'),
  fixture: rs('crates/pflow-metamodel/tests/fixtures/connect-4.json', 0, 0, 'the Connect-4 net; byte-identical to assets/connect-4.json'),
  road42: road(243, 245, 'Phase 4.2 (a planned deliverable): compare with pflow-jl glue on token links only; exit is the same incidence matrix up to place renaming'),
  road6: road(405, 413, 'Phase 6: ⊗ is disjoint union; token/data glue places; event fuses transitions; guard is outside the free SMC'),
};

// --- small helpers --------------------------------------------------------------------

const NEG = '#c8553d', NEG2 = '#8f2a1b', POS = '#3a76b4', POS2 = '#1d4b80';
const GRID = '#e5e8ec';
const INKC = '#2b2f36', MUTEDC = '#6a717c';
const CLASS_COLORS = ['#227744', '#7b4cc2', '#b26a00', '#a8457f', '#178f7f', '#566573'];
const SIN60 = Math.sin(Math.PI / 3);
const MONO = 6.05; // px per character of 10px monospace (layout estimate)
const EASE = 'cubic-bezier(.25,.8,.25,1)';
const SLIDE = 'cubic-bezier(.55,0,.3,1)'; // ease-in-out: the pieces visibly travel

const fmt = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');
const cellFill = (v) => (v <= -2 ? NEG2 : v < 0 ? NEG : v >= 2 ? POS2 : v > 0 ? POS : 'transparent');
const isToken = (p) => (p.kind || 'token') === 'token';
const readOnly = (a) => a.type === 'read' || a.type === 'inhibitor';
const K = (p, t) => `${p}\u0000${t}`;
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const memberKey = (ms) => [...ms].sort().join('|');
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const anim = (node, frames, opts) => { try { return node.animate(frames, opts); } catch { return null; } };

/**
 * C = post − pre over the arcs that move tokens (firing.go Inputs/Outputs):
 * place → transition is pre, transition → place is post, read and inhibitor
 * arcs are kept apart as tests. Only token places count (firing.go tokenPlace).
 */
function incidence(placeIds, transIds, arcs, tokenPlaces) {
  const P = new Set(placeIds), T = new Set(transIds);
  const pre = new Map(), post = new Map(), tests = new Map();
  const add = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
  for (const a of arcs) {
    const w = a.weight || 1;
    if (P.has(a.from) && T.has(a.to)) {
      if (readOnly(a)) { const k = K(a.from, a.to); if (!tests.has(k)) tests.set(k, []); tests.get(k).push(a); }
      else if (tokenPlaces.has(a.from)) add(pre, K(a.from, a.to), w);
    } else if (T.has(a.from) && P.has(a.to) && !readOnly(a) && tokenPlaces.has(a.to)) add(post, K(a.to, a.from), w);
  }
  const at = (p, t) => {
    const k = K(p, t), pr = pre.get(k) || 0, po = post.get(k) || 0;
    return { pre: pr, post: po, c: po - pr, tests: tests.get(k) || [] };
  };
  return { at, tests };
}

/** A constraint "tokens("a") + tokens("b") ... == n", or null if it is anything else. */
function tokenSum(expr) {
  const m = /^(.*)==\s*(-?\d+)\s*$/.exec(expr);
  if (!m) return null;
  const y = new Map();
  for (const term of m[1].split('+').map((s) => s.trim())) {
    const q = /^tokens\("([^"]+)"\)$/.exec(term);
    if (!q) return null;
    y.set(q[1], (y.get(q[1]) || 0) + 1);
  }
  return { y, n: Number(m[2]) };
}

const CSS = `
:where(.inc-svg text:not([fill])) { fill: ${INKC}; }
.inc-svg text { font-size: 11px; }
.inc-svg .id { font-family: var(--font-mono); font-size: 10px; }
.inc-svg .id.sm { font-size: 9px; }
.inc-svg .pre { fill: ${MUTEDC}; }
.inc-svg .mut { fill: ${MUTEDC}; }
.inc-svg .ttl { font-size: 13px; font-weight: 600; }
.inc-svg .sub { font-size: 11px; fill: ${MUTEDC}; }
.inc-svg .val { font-size: 9px; font-weight: 600; fill: #fff; pointer-events: none; }
.inc-svg .tag { font-size: 10px; font-weight: 700; }
.inc-svg .ok { fill: #1e7a46; font-weight: 600; }
.inc-svg .bad { fill: #c0392b; font-weight: 600; }
.inc-svg .hdr { pointer-events: bounding-box; }
.inc-svg .hdr.hl { font-weight: 700; }
.inc-svg .hit { cursor: help; }
.inc-svg .xh { fill: none; stroke: ${INKC}; stroke-width: 1.2; pointer-events: none; opacity: 0; }
.inc-svg .xh.on { opacity: 1; }
.inc-svg .yband { fill: #f2c94c; opacity: 0; pointer-events: none; transition: opacity .12s; }
.inc-svg .yband.on { opacity: 0.32; }
.inc-svg .inv:hover .inv-bg { fill: #eef2f7; }
.inc-svg .probe { fill: transparent; stroke: ${INKC}; stroke-width: 0.9; }
.inc-svg .c4band { fill: ${INKC}; opacity: 0.07; pointer-events: none; }
`;

// --- the view ----------------------------------------------------------------------------

export default {
  id: 'incidence',
  title: 'Incidence matrices',
  short: 'Incidence',
  consumes: ['analysis.incidence', 'assets/connect-4.json', 'bundle.flatten', 'bundle.state'],
  convention: {
    summary: 'A P/T net as its incidence matrix C = post − pre: one row per place, one column per transition, and C[p, t] is what one firing of t does to p (−w consumed, +w produced, blank for 0). Firing a sequence with count vector σ takes M to M + C·σ, so a row vector y with y·C = 0 is a P-invariant: y·M never changes. Composition acts on C directly. The monoidal product ⊗ (disjoint union) is the block-diagonal direct sum. An event link fuses transitions, and go-pflow Flatten adds the fused columns (MergeSum: weights add). A token or data link fuses places, and Flatten adds the fused rows. A guard link lowers to a read arc, which moves nothing, so C does not change.',
    honesty: [
      'Orders: C is computed in this page from the arcs of the instances and of the flat net (bundle.flatten), with go-pflow\'s and pflow-rs\'s definition (output − input over the arcs that move tokens). Connect-4: C is the registry\'s (analysis.incidence). Rows and columns are drawn in declaration (or prefix-grouped) order; go-pflow IncidenceMatrix sorts them by ID. That is a permutation, so nothing changes.',
      'C forgets read arcs, inhibitor arcs and self-loops (pre = post). A guard link changes the net but not C, and the Connect-4 win detectors\' reads of the board do not show in C.',
      'The P-invariant check (y·C = 0 and y·M₀ = n) is computed in this page from the flat net. It is not a run of go-pflow verify. Together the two prove the constraint for every reachable marking (go-pflow calls this the structural method). Capacities, read arcs and inhibitors only restrict firing, so they cannot break an invariant.',
      'Before/after of a new link (the merge animation): the previous link set is flattened by the registry too (bundle.flatten on a scratch engine).',
      'No ports are drawn: a matrix has no boundary. Links are made in the views that draw ports, and this one recomputes both matrices from them.',
      'ROADMAP 4.2 is a planned deliverable: compare this matrix with pflow-jl glue, on token links only and up to place renaming. That comparison is not run here.',
      'The event-class tags ⊗A, ⊗B… use RenderDOT\'s event-link glyph; that ⊗ is not the monoidal product ⊗ in the left title.',
    ],
    bib: ['baez-master', 'bruni-et-al'],
    cites: [CITE.incGo, CITE.incRs, CITE.firing, CITE.mergeArcs, CITE.mergeSum, CITE.guard, CITE.structural, CITE.road42, CITE.road6, CITE.rawArc, CITE.weightGo, CITE.fixture],
  },
  render(ctx) {
    ctx.root.append(ctx.el('style', { text: CSS }));
    if (ctx.example === 'connect4') renderConnect4(ctx);
    else renderOrders(ctx);
  },
};

// --- orders ------------------------------------------------------------------------------

function renderOrders(ctx) {
  const { svg } = ctx;
  const T = ctx.theme;
  const ev = ctx.event;
  const links = ctx.orders.links;
  const flat = ctx.orders.flat;
  const subs = [...ctx.orders.subnets].sort(byId); // Flatten's order (compose_flatten.go sortedSubnets)

  // Left: the disjoint union, block by block.
  const rowsL = [], colsL = [], blocks = [], arcsL = [], tokL = new Set();
  for (const s of subs) {
    const b = { s, r0: rowsL.length, c0: colsL.length };
    for (const p of s.places) { const id = `${s.id}/${p.id}`; rowsL.push({ id, s, p }); if (isToken(p)) tokL.add(id); }
    for (const t of s.transitions) colsL.push({ id: `${s.id}/${t.id}`, s, t });
    for (const a of s.arcs) arcsL.push({ ...a, from: `${s.id}/${a.from}`, to: `${s.id}/${a.to}` });
    b.r1 = rowsL.length; b.c1 = colsL.length;
    blocks.push(b);
  }
  const CL = incidence(rowsL.map((r) => r.id), colsL.map((c) => c.id), arcsL, tokL);
  const rowIdxL = new Map(rowsL.map((r, i) => [r.id, i]));
  const colIdxL = new Map(colsL.map((c, i) => [c.id, i]));

  // Event classes and wires, from Flatten's map.
  const portPlace = (ref) => { const s = ctx.orders.byId[ref.subnet]; const p = s && s.ports.find((q) => q.id === ref.port); return p && p.place ? `${s.id}/${p.place}` : null; };
  const portTrans = (ref) => { const s = ctx.orders.byId[ref.subnet]; const p = s && s.ports.find((q) => q.id === ref.port); return p && p.transition ? `${s.id}/${p.transition}` : null; };
  const classes = flat.ok ? Object.entries(flat.map.fusedGroups).sort(byName).map(([name, members], i) => ({
    name, members, tag: `⊗${String.fromCharCode(65 + i)}`, color: CLASS_COLORS[i % CLASS_COLORS.length],
    links: links.filter((l) => l.kind === 'event' && members.includes(portTrans(l.from))),
  })) : [];
  const wires = flat.ok ? Object.entries(flat.map.wires).sort(byName).map(([name, members], i) => {
    const ls = links.filter((l) => (l.kind === 'token' || l.kind === 'data') && (members.includes(portPlace(l.from)) || members.includes(portPlace(l.to))));
    const kind = ls.some((l) => l.kind === 'token') ? 'token' : 'data';
    return { name, members, kind, links: ls, tag: `${T.LINK_STYLE[kind].glyph}${i + 1}`, color: T.LINK_STYLE[kind].color };
  }) : [];
  const classOf = new Map(), wireOf = new Map();
  for (const c of classes) { c.members.forEach((m) => classOf.set(m, c)); classOf.set(c.name, c); }
  for (const w of wires) { w.members.forEach((m) => wireOf.set(m, w)); wireOf.set(w.name, w); }
  const guards = links.filter((l) => l.kind === 'guard');

  // Right: the flat net.
  const fm = flat.ok ? flat.model : { places: [], transitions: [], arcs: [], constraints: [] };
  const tokR = new Set(fm.places.filter(isToken).map((p) => p.id));
  const CR = incidence(fm.places.map((p) => p.id), fm.transitions.map((t) => t.id), fm.arcs, tokR);
  const rowIdxR = new Map(fm.places.map((p, i) => [p.id, i]));

  // Mechanical check: every flat entry is the sum of its member entries on the left.
  let checked = 0, agree = 0;
  const memberSum = (p, t) => { let s = 0; for (const pm of p.members) for (const tm of t.members) s += CL.at(pm, tm).c; return s; };
  for (const p of fm.places) for (const t of fm.transitions) { checked++; if (memberSum(p, t) === CR.at(p.id, t.id).c) agree++; }

  // P-invariants: declared constraints that are a plain sum of tokens.
  const invs = fm.constraints.map((c) => {
    const ts = tokenSum(c.expr);
    if (!ts) return { c, parsed: false };
    const missing = [...ts.y.keys()].filter((p) => !rowIdxR.has(p));
    const yC = fm.transitions.map((t) => {
      let s = 0; const terms = [];
      for (const [p, k] of ts.y) { const v = CR.at(p, t.id).c; if (v) { s += k * v; terms.push([p, k, v]); } }
      return { s, terms };
    });
    const yM0 = [...ts.y].reduce((acc, [p, k]) => acc + k * (fm.places[rowIdxR.get(p)]?.initial || 0), 0);
    return { c, parsed: true, ts, yC, yM0, bad: yC.filter((v) => v.s !== 0).length, missing };
  });

  // --- layout (depends only on the active instances, so a link keeps every cell put) ---
  const M = 14, GAP = 104, VERD = 172;
  const maxLen = (xs) => xs.reduce((m, s) => Math.max(m, s.length), 0);
  const labelWL = Math.ceil(maxLen(rowsL.map((r) => r.id)) * MONO) + 12;
  const labelWR = labelWL + Math.ceil(5 * MONO); // flat rows may add "wire:"
  const nL = colsL.length, mL = rowsL.length;
  const nR = fm.transitions.length, mR = fm.places.length;
  const cw = clamp(Math.floor((1150 - (2 * M + labelWL + GAP + labelWR + VERD)) / (2 * nL)), 11, 24);
  const rh = clamp(Math.round(cw * 0.78), 12, 17);
  const showVal = cw >= 15;
  const colFont = cw >= 15 ? 'id' : 'id sm';
  const colLabelH = Math.ceil(maxLen(colsL.map((c) => c.id)) * MONO * SIN60) + 10;
  const x0L = M + labelWL;
  const xMR = x0L + nL * cw;
  const x0R = xMR + GAP + labelWR;
  const xRegionR = xMR + GAP;

  // Pattern legend (flows onto a second line if it must).
  const patterns = [];
  for (const s of subs) { let p = patterns.find((q) => q.key === s.pattern); if (!p) patterns.push(p = { key: s.pattern, label: ctx.orders.patterns[s.pattern].prefLabel, subs: [] }); p.subs.push(s); }
  const legendItems = patterns.map((p) => ({ p, w: 16 + p.label.length * 6.3 + 6 + p.subs.reduce((a, s) => a + s.id.length * 6.1 + 8, 0) + 14 }));
  const legendLines = [[]]; let lx = 0;
  for (const it of legendItems) { if (lx + it.w > xMR - M && legendLines[legendLines.length - 1].length) { legendLines.push([]); lx = 0; } legendLines[legendLines.length - 1].push(it); lx += it.w; }
  const yLeg0 = 50;
  const yLab = yLeg0 + legendLines.length * 16 + colLabelH;
  const yM = yLab + 6;
  const yMBL = yM + mL * rh, yMBR = yM + mR * rh;

  const combStep = classes.length ? 12 : 0;
  const yCombEnd = yMBL + (classes.length ? 10 + classes.length * combStep : 0);
  const yInv0 = yMBR + 26;
  const invRowH = rh + 3;
  const yInvEnd = flat.ok ? yInv0 + 8 + invs.length * invRowH : yMBR;
  const legendLinesBottom = 2 + classes.length + (classes.length ? 1 : 0) + wires.length + (guards.length ? 1 : 0);
  const yBot = Math.max(yCombEnd, yInvEnd) + 26;
  const W = Math.max(x0R + Math.max(nR, 1) * cw + VERD + M, 900);
  const H = yBot + legendLinesBottom * 16 + 8;

  const root = ctx.svgRoot(W, H, { class: 'view-svg inc-svg' });
  ctx.root.append(root);
  root.append(svg('rect', { x: 0, y: 0, width: W, height: H, fill: '#fafafa' }));

  // Notes (prepended, so the last one called shows first).
  if (guards.length) ctx.note(`${guards.length === 1 ? 'A guard link lowers' : `${guards.length} guard links lower`} to a read arc (◇ on the right): it gates firing but moves nothing, so C does not change (applyGuardLinks, firing.go Inputs/Outputs).`, 'honesty');
  ctx.note('No ports here: an incidence matrix has no boundary. Make links in a view that draws ports (Cospans, Spiders, …); this view recomputes both matrices from the links. P-invariant checks below are computed in this page from the flat net.', 'honesty');
  if (!flat.ok) ctx.note(`Flatten refused the composition (${flat.errors.map((e) => e.code).join(', ')}), so there is no flat matrix.`, 'warn');

  // --- titles ---
  const text = (x, y, s, attrs = {}, ...kids) => svg('text', { x, y, ...attrs }, s, ...kids);
  root.append(
    text(M, 18, `C of ${subs.map((s) => s.id).join(' ⊗ ')}`, { class: 'ttl' }),
    text(M, 34, `block-diagonal: ⊗ is a disjoint union · ${mL} places × ${nL} transitions`, { class: 'sub' }),
  );
  if (flat.ok) root.append(
    text(xRegionR, 18, `C of the flat net (Flatten, ${links.length} link${links.length === 1 ? '' : 's'})`, { class: 'ttl' }),
    text(xRegionR, 34, `${mR} places × ${nR} transitions · event links add columns, token/data links add rows`, { class: 'sub' }),
  );

  // Pattern legend.
  legendLines.forEach((line, li) => {
    let x = M; const y = yLeg0 + li * 16;
    for (const { p } of line) {
      const sw = svg('rect', { x, y: y - 9, width: 12, height: 11, rx: 2, fill: T.PATTERN_TINT[p.key], stroke: '#c3cbd5' });
      root.append(sw, text(x + 16, y, p.label, { class: 'mut' }));
      x += 16 + p.label.length * 6.3 + 6;
      for (const s of p.subs) {
        const t = text(x, y, s.id, { class: 'id hdr hit' });
        ctx.hover(t, ctx.info.subnetInfo(s));
        root.append(t);
        x += s.id.length * 6.1 + 8;
      }
      x += 14;
    }
  });

  // --- left matrix ---
  const gL = svg('g', { class: 'inc-left' });
  root.append(gL);
  for (const b of blocks) {
    ctx.emit('block', b.s.id, { rows: b.r1 - b.r0, cols: b.c1 - b.c0 });
    const r = svg('rect', { x: x0L + b.c0 * cw, y: yM + b.r0 * rh, width: (b.c1 - b.c0) * cw, height: (b.r1 - b.r0) * rh, fill: T.PATTERN_TINT[b.s.pattern], stroke: '#c9d1db', 'stroke-width': 0.8 });
    gL.append(r);
    if (ev && ev.type === 'instance-added' && ev.id === b.s.id) anim(r, [{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: EASE });
  }
  // Bands under the cells: fused columns (event class), fused rows (wire).
  for (const c of classes) for (const m of c.members) { const j = colIdxL.get(m); if (j !== undefined) gL.append(svg('rect', { x: x0L + j * cw, y: yM, width: cw, height: mL * rh, fill: c.color, opacity: 0.1, 'data-cls': c.name, class: 'band' })); }
  for (const w of wires) for (const m of w.members) { const i = rowIdxL.get(m); if (i !== undefined) gL.append(svg('rect', { x: x0L, y: yM + i * rh, width: nL * cw, height: rh, fill: w.color, opacity: 0.1, 'data-wire': w.name, class: 'band' })); }
  gL.append(gridLines(svg, x0L, yM, nL, mL, cw, rh));

  const cellsL = svg('g', {});
  gL.append(cellsL);
  rowsL.forEach((r, i) => colsL.forEach((c, j) => {
    const e = CL.at(r.id, c.id);
    const cell = cellEl(svg, x0L + j * cw, yM + i * rh, cw, rh, e, showVal, T);
    cell.dataset.r = i; cell.dataset.c = j;
    ctx.hover(cell, leftCellInfo(ctx, r, c, e, wireOf, classOf));
    cellsL.append(cell);
  }));
  gL.append(matrixBrackets(svg, x0L, yM, nL * cw, mL * rh));

  // Row headers (left).
  const hdrRowsL = rowsL.map((r, i) => {
    const w = wireOf.get(r.id);
    const t = svg('text', { x: x0L - 7, y: yM + i * rh + rh / 2 + 3.5, 'text-anchor': 'end', class: 'id hdr hit' },
      svg('tspan', { class: 'pre' }, `${r.s.id}/`), svg('tspan', w ? { fill: w.color, 'font-weight': 700 } : {}, r.p.id));
    const info = ctx.info.placeInfo(r.s, r.p.id);
    info.facts.push(['row of C', `${colsL.filter((c) => CL.at(r.id, c.id).c).length} nonzero entries (all inside the ${r.s.id} block)`]);
    if (w) info.facts.push(['fuses into', `${w.name} (${w.tag}): its row is the sum of ${w.members.length} member rows`]);
    if (!isToken(r.p)) info.facts.push(['kind', 'data place: no token arcs count, so its row is 0 (firing.go tokenPlace)']);
    ctx.hover(t, info);
    gL.append(t);
    return t;
  });
  // Column headers (left), rotated.
  const hdrColsL = colsL.map((c, j) => {
    const k = classOf.get(c.id);
    const t = svg('text', { transform: `translate(${x0L + j * cw + cw / 2 + 3},${yLab}) rotate(-60)`, class: `${colFont} hdr hit` },
      svg('tspan', { class: 'pre' }, `${c.s.id}/`), svg('tspan', k ? { fill: k.color, 'font-weight': 700 } : {}, c.t.id));
    const info = ctx.info.transitionInfo(c.s, c.t.id);
    info.facts.push(['column of C', `${rowsL.filter((r) => CL.at(r.id, c.id).c).length} nonzero entries (all inside the ${c.s.id} block)`]);
    if (k) info.facts.push(['fuses into', `${k.tag} = ${k.name}: its column is the sum of ${k.members.length} member columns (MergeSum)`]);
    info.cites = [...(info.cites || []), CITE.mergeArcs];
    ctx.hover(t, info);
    gL.append(t);
    return t;
  });
  crosshair(svg, gL, cellsL, x0L, yM, cw, rh, nL, mL, hdrRowsL, hdrColsL);

  // Event-class combs under the left matrix.
  const combsL = new Map();
  classes.forEach((c, k) => {
    const js = c.members.map((m) => colIdxL.get(m)).filter((j) => j !== undefined).sort((a, b) => a - b);
    if (!js.length) return;
    const y = yMBL + 10 + k * combStep;
    const xs = js.map((j) => x0L + j * cw + cw / 2);
    const d = [`M${xs[0]},${y} H${xs[xs.length - 1]}`, ...xs.map((x) => `M${x},${yMBL + 1} V${y}`)].join(' ');
    const g = svg('g', { class: 'hit' });
    const path = svg('path', { d, fill: 'none', stroke: c.color, 'stroke-width': 1.6, 'pathLength': 1 });
    g.append(path, ...xs.map((x) => svg('circle', { cx: x, cy: y, r: 2.2, fill: c.color })),
      text(xs[0] - 6, y + 3.5, c.tag, { class: 'tag', 'text-anchor': 'end', fill: c.color }));
    ctx.hover(g, classInfo(c, ctx.orders.byId));
    gL.append(g);
    combsL.set(c.name, { path, g });
  });
  // Wire combs at the right of the left matrix.
  const wireStep = wires.length ? Math.min(12, 44 / wires.length) : 0;
  const combsW = new Map();
  wires.forEach((w, k) => {
    const is = w.members.map((m) => rowIdxL.get(m)).filter((i) => i !== undefined).sort((a, b) => a - b);
    if (!is.length) return;
    const x = xMR + 10 + k * wireStep;
    const ys = is.map((i) => yM + i * rh + rh / 2);
    const d = [`M${x},${ys[0]} V${ys[ys.length - 1]}`, ...ys.map((y) => `M${xMR + 1},${y} H${x}`)].join(' ');
    const g = svg('g', { class: 'hit' });
    const path = svg('path', { d, fill: 'none', stroke: w.color, 'stroke-width': 1.6, 'stroke-dasharray': w.kind === 'data' ? '2 2' : null, pathLength: 1 });
    g.append(path, ...ys.map((y) => svg('circle', { cx: x, cy: y, r: 2.2, fill: w.color })),
      text(x, ys[0] - 5, w.tag, { class: 'tag', 'text-anchor': 'middle', fill: w.color }));
    ctx.hover(g, wireInfo(w));
    gL.append(g);
    combsW.set(w.name, { path, g });
  });

  // Flatten arrow.
  if (flat.ok) {
    const ay = yM + Math.min(mL, mR) * rh / 2;
    const ax0 = xMR + 56, ax1 = xMR + GAP - 4;
    const arrow = svg('g', { class: 'hit' },
      svg('rect', { x: ax0 - 2, y: ay - 20, width: ax1 - ax0 + 4, height: 40, fill: 'transparent' }),
      svg('path', { d: `M${ax0},${ay} H${ax1 - 6}`, stroke: MUTEDC, 'stroke-width': 1.4, fill: 'none' }),
      svg('path', { d: `M${ax1},${ay} l-7,-4 v8 z`, fill: MUTEDC }),
      text((ax0 + ax1) / 2, ay - 7, 'Flatten', { 'text-anchor': 'middle', class: 'mut', 'font-size': 10 }),
      text((ax0 + ax1) / 2, ay + 15, 'Σ cols, Σ rows', { 'text-anchor': 'middle', class: 'mut', 'font-size': 8.5 }));
    ctx.hover(arrow, {
      title: 'Flatten: from the disjoint union to the flat net',
      definition: 'go-pflow Bundle.Flatten, as pflow-compose ports it (the registry\'s bundle.flatten): namespace every element, fuse places joined by token/data links and transitions joined by event links, merge duplicate arcs (MergeSum), lower guard links.',
      facts: [
        ['on C', 'event classes add columns, wires add rows, guard links leave C alone'],
        ['here', `${mL} × ${nL} → ${mR} × ${nR}; ${Object.keys(flat.map.fusedGroups).length} event class${Object.keys(flat.map.fusedGroups).length === 1 ? '' : 'es'}, ${Object.keys(flat.map.wires).length} wire${Object.keys(flat.map.wires).length === 1 ? '' : 's'}`],
      ],
      cites: [...FLATTEN_CITES, CITE.guard],
    });
    root.append(arrow);
  }

  // --- right matrix ---
  let colG = [], rowG = [];
  const modeRow = ev && ev.type === 'link-added' && (ev.link.kind === 'token' || ev.link.kind === 'data');
  const hdrRowsR = [], hdrColsR = [];
  let cellsR = null;
  const yBands = [];
  if (flat.ok) {
    const gR = svg('g', { class: 'inc-right' });
    root.append(gR);
    ctx.emit('matrix', 'flat', { rows: mR, cols: nR });
    for (const t of fm.transitions) { const c = classOf.get(t.id); if (c) gR.append(svg('rect', { x: x0R + fm.transitions.indexOf(t) * cw, y: yM, width: cw, height: mR * rh, fill: c.color, opacity: 0.1 })); }
    fm.places.forEach((p, i) => { const w = wireOf.get(p.id); if (w) gR.append(svg('rect', { x: x0R, y: yM + i * rh, width: nR * cw, height: rh, fill: w.color, opacity: 0.1 })); });
    fm.places.forEach((p, i) => { const b = svg('rect', { x: x0R - 2, y: yM + i * rh, width: nR * cw + 4, height: rh, class: 'yband' }); yBands.push(b); gR.append(b); });
    gR.append(gridLines(svg, x0R, yM, nR, mR, cw, rh));
    cellsR = svg('g', {});
    gR.append(cellsR);
    colG = fm.transitions.map(() => svg('g', {}));
    rowG = fm.places.map(() => svg('g', {}));
    (modeRow ? rowG : colG).forEach((g) => cellsR.append(g));
    fm.places.forEach((p, i) => fm.transitions.forEach((t, j) => {
      const e = CR.at(p.id, t.id);
      const cell = cellEl(svg, x0R + j * cw, yM + i * rh, cw, rh, e, showVal, T);
      cell.dataset.r = i; cell.dataset.c = j;
      ctx.hover(cell, rightCellInfo(p, t, e, memberSum(p, t), wireOf, classOf));
      (modeRow ? rowG[i] : colG[j]).append(cell);
    }));
    gR.append(matrixBrackets(svg, x0R, yM, nR * cw, mR * rh));

    fm.places.forEach((p, i) => {
      const w = wireOf.get(p.id);
      const slash = p.id.lastIndexOf('/');
      const t = svg('text', { x: x0R - 7, y: yM + i * rh + rh / 2 + 3.5, 'text-anchor': 'end', class: 'id hdr hit' },
        w ? svg('tspan', { fill: w.color, 'font-weight': 700 }, p.id) : [svg('tspan', { class: 'pre' }, p.id.slice(0, slash + 1)), svg('tspan', {}, p.id.slice(slash + 1))]);
      const info = ctx.info.flatPlaceInfo(p);
      if (w) info.facts.push(['row of C', `${w.tag}: the sum of the ${w.members.length} member rows on the left (place fusion)`]);
      info.facts.push(['nonzero entries', fm.transitions.filter((t2) => CR.at(p.id, t2.id).c).length]);
      ctx.hover(t, info);
      (modeRow ? rowG[i] : gR).append(t);
      hdrRowsR.push(t);
    });
    fm.transitions.forEach((t, j) => {
      const c = classOf.get(t.id);
      const slash = t.id.lastIndexOf('/');
      const lab = svg('text', { transform: `translate(${x0R + j * cw + cw / 2 + 3},${yLab}) rotate(-60)`, class: `${colFont} hdr hit` },
        c ? svg('tspan', { fill: c.color, 'font-weight': 700 }, `${c.tag} fused (${c.members.length})`) : [svg('tspan', { class: 'pre' }, t.id.slice(0, slash + 1)), svg('tspan', {}, t.id.slice(slash + 1))]);
      const info = ctx.info.flatTransitionInfo(t);
      if (c) info.facts.push(['column of C', `${c.tag}: the sum of the ${c.members.length} member columns on the left (MergeSum)`]);
      info.facts.push(['nonzero entries', fm.places.filter((p2) => CR.at(p2.id, t.id).c).length]);
      info.cites = [...(info.cites || []), CITE.mergeArcs];
      ctx.hover(lab, info);
      (modeRow ? gR : colG[j]).append(lab);
      hdrColsR.push(lab);
    });
    crosshair(svg, gR, cellsR, x0R, yM, cw, rh, nR, mR, hdrRowsR, hdrColsR);

    // --- y·C strips under the flat matrix ---
    const gI = svg('g', {});
    root.append(gI);
    gI.append(text(xRegionR, yInv0 - 6, '', { 'font-size': 10 },
      svg('tspan', { 'font-weight': 600 }, 'P-invariants: y·C for each declared Σ tokens(p) == n'),
      svg('tspan', { class: 'mut', 'font-style': 'italic', dx: 6 }, 'computed in this page from the flat net')));
    invs.forEach((iv, k) => {
      const y = yInv0 + 4 + k * invRowH;
      const g = svg('g', { class: 'inv hit' });
      g.append(svg('rect', { x: xRegionR, y: y - 1, width: x0R + nR * cw + VERD - xRegionR - 4, height: rh + 2, rx: 3, fill: 'transparent', class: 'inv-bg' }));
      g.append(text(x0R - 7, y + rh / 2 + 3.5, iv.c.id, { class: 'id', 'text-anchor': 'end' }));
      if (iv.parsed) {
        g.append(svg('rect', { x: x0R, y, width: nR * cw, height: rh, fill: '#fff', stroke: '#d5dae0', 'stroke-width': 0.8 }));
        iv.yC.forEach((v, j) => {
          if (!v.s) return;
          g.append(svg('rect', { x: x0R + j * cw + 0.5, y: y + 0.5, width: cw - 1, height: rh - 1, fill: cellFill(v.s) }));
          if (showVal) g.append(text(x0R + j * cw + cw / 2, y + rh / 2 + 3.2, fmt(v.s), { class: 'val', 'text-anchor': 'middle' }));
        });
        const okC = iv.bad === 0 && !iv.missing.length, okM = iv.yM0 === iv.ts.n;
        ctx.emit('invariant', iv.c.id, { holds: okC && okM });
        g.append(text(x0R + nR * cw + 8, y + rh / 2 + 3.5, '', {},
          svg('tspan', { class: okC ? 'ok' : 'bad' }, okC ? 'y·C = 0 ✓' : `y·C ≠ 0 at ${iv.bad} ✗`),
          svg('tspan', { class: 'mut', dx: 8 }, 'y·M₀ = '),
          svg('tspan', { class: okM ? 'ok' : 'bad' }, okM ? `${iv.yM0} ✓` : `${iv.yM0} ≠ ${iv.ts.n} ✗`)));
      } else {
        ctx.emit('invariant', iv.c.id, { holds: false });
        g.append(text(x0R, y + rh / 2 + 3.5, 'not a plain sum of tokens(…) == n: not checked here', { class: 'mut', 'font-style': 'italic', 'font-size': 10 }));
      }
      const info = invariantRowInfo(ctx, iv, fm);
      ctx.hover(g, info);
      if (iv.parsed) {
        const rows = [...iv.ts.y.keys()].map((p) => rowIdxR.get(p)).filter((i) => i !== undefined);
        g.addEventListener('pointerenter', () => rows.forEach((i) => yBands[i]?.classList.add('on')));
        g.addEventListener('pointerleave', () => rows.forEach((i) => yBands[i]?.classList.remove('on')));
      }
      gI.append(g);
    });
  }

  // --- bottom legend ---
  const gB = svg('g', {});
  root.append(gB);
  let y = yBot;
  let x = M;
  const sw = (fill, label, extra) => {
    gB.append(svg('rect', { x, y: y - 9, width: 14, height: 11, fill, stroke: fill === 'transparent' ? '#c3cbd5' : null }));
    if (extra) gB.append(extra(x + 7, y - 3.5));
    gB.append(text(x + 19, y, label, { class: 'mut', 'font-size': 10.5 }));
    x += 19 + label.length * 5.7 + 16;
  };
  sw(NEG, '−w: t consumes w from p (pre)');
  sw(POS, '+w: t produces w into p (post)');
  sw('transparent', 'blank: 0');
  sw('transparent', 'read arc (guard link): moves nothing, not in C', (cx, cy) => svg('path', { d: `M${cx},${cy - 4} l4,4 l-4,4 l-4,-4 z`, fill: 'none', stroke: T.LINK_STYLE.guard.color, 'stroke-width': 1.4 }));
  sw('transparent', 'pre = post: C is 0', (cx, cy) => svg('circle', { cx, cy, r: 3, fill: 'none', stroke: MUTEDC, 'stroke-width': 1.2 }));
  y += 16;
  for (const c of classes) {
    const row = text(M, y, '', { 'font-size': 10.5, class: 'hdr hit' }, svg('tspan', { class: 'tag', fill: c.color }, c.tag), svg('tspan', { class: 'id', dx: 6 }, c.name),
      svg('tspan', { class: 'mut', dx: 6 }, `column = sum of ${c.members.length} member columns (event links; MergeSum, compose_flatten.go:335-411)`));
    ctx.hover(row, classInfo(c, ctx.orders.byId));
    gB.append(row);
    y += 16;
  }
  if (classes.length) {
    gB.append(text(M, y, `${classes.map((c) => c.tag).join(', ')}: event classes, tagged with RenderDOT's event-link glyph ⊗; not the monoidal product ⊗ in the left title`, { class: 'mut', 'font-size': 10.5, 'font-style': 'italic' }));
    y += 16;
  }
  for (const w of wires) {
    const row = text(M, y, '', { 'font-size': 10.5, class: 'hdr hit' }, svg('tspan', { class: 'tag', fill: w.color }, w.tag), svg('tspan', { class: 'id', dx: 6 }, w.name),
      svg('tspan', { class: 'mut', dx: 6 }, `row = sum of ${w.members.length} member rows (${w.kind} link${w.links.length === 1 ? '' : 's'}: place fusion, a pushout along the shared place)`));
    ctx.hover(row, wireInfo(w));
    gB.append(row);
    y += 16;
  }
  if (guards.length) {
    gB.append(text(M, y, `${guards.length} guard link${guards.length === 1 ? '' : 's'}: read arc${guards.length === 1 ? '' : 's'} drawn as ◇ on the flat matrix; C is the same with or without ${guards.length === 1 ? 'it' : 'them'}`, { class: 'mut', 'font-size': 10.5 }));
    y += 16;
  }
  if (flat.ok) gB.append(text(M, y, '', { 'font-size': 10.5 },
    svg('tspan', { class: agree === checked ? 'ok' : 'bad' }, `${agree}/${checked}`),
    svg('tspan', { class: 'mut', dx: 5 }, 'flat entries equal the sum of their member entries on the left (checked in this page: composition acts on C by adding rows and columns)')));

  // --- merge animation ---
  if (ev && ev.type === 'link-added' && flat.ok) animateLink(ctx, { ev, fm, CR, colG, rowG, cw, rh, x0R, yM, combsL, combsW, classOf, wireOf, portPlace, portTrans, root, showVal, T });
}

function gridLines(svg, x0, y0, n, m, cw, rh) {
  const d = [];
  for (let i = 0; i <= m; i++) d.push(`M${x0},${y0 + i * rh}H${x0 + n * cw}`);
  for (let j = 0; j <= n; j++) d.push(`M${x0 + j * cw},${y0}V${y0 + m * rh}`);
  return svg('path', { d: d.join(''), stroke: GRID, 'stroke-width': 0.6, fill: 'none', 'pointer-events': 'none' });
}

function matrixBrackets(svg, x, y, w, h) {
  const s = 5, o = 3;
  return svg('path', { d: `M${x - o + s},${y - 1} H${x - o} V${y + h + 1} H${x - o + s} M${x + w + o - s},${y - 1} H${x + w + o} V${y + h + 1} H${x + w + o - s}`, fill: 'none', stroke: INKC, 'stroke-width': 1.3, 'pointer-events': 'none' });
}

function cellEl(svg, x, y, cw, rh, e, showVal, T) {
  const g = svg('g', { class: 'hit' });
  g.append(svg('rect', { x: x + 0.5, y: y + 0.5, width: cw - 1, height: rh - 1, fill: cellFill(e.c), 'pointer-events': 'all' }));
  if (e.c && showVal) g.append(svg('text', { x: x + cw / 2, y: y + rh / 2 + 3.2, 'text-anchor': 'middle', class: 'val' }, fmt(e.c)));
  if (!e.c && e.pre && e.post) g.append(svg('circle', { cx: x + cw / 2, cy: y + rh / 2, r: Math.min(cw, rh) / 4, fill: 'none', stroke: MUTEDC, 'stroke-width': 1.2, 'pointer-events': 'none' }));
  if (e.tests.length) {
    // A read arc: centred in an empty cell, in the corner when C has a value there (C is unchanged either way).
    const r = e.c ? Math.max(2.6, Math.min(cw, rh) / 5) : Math.min(cw, rh) / 2 - 2;
    const cx = e.c ? x + cw - r - 0.5 : x + cw / 2, cy = e.c ? y + r + 0.5 : y + rh / 2;
    g.append(svg('path', { d: `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`, fill: '#fff', stroke: T.LINK_STYLE.guard.color, 'stroke-width': 1.3, 'pointer-events': 'none', class: 'readmark' }));
  }
  return g;
}

/** One hover outline per matrix, moved by event delegation, plus bold headers. */
function crosshair(svg, g, cells, x0, y0, cw, rh, n, m, hdrRows, hdrCols) {
  const rowR = svg('rect', { x: x0, width: n * cw, height: rh, class: 'xh' });
  const colR = svg('rect', { y: y0, width: cw, height: m * rh, class: 'xh' });
  g.append(rowR, colR);
  let last = null;
  const off = () => { rowR.classList.remove('on'); colR.classList.remove('on'); if (last) { hdrRows[last[0]]?.classList.remove('hl'); hdrCols[last[1]]?.classList.remove('hl'); } last = null; };
  cells.addEventListener('pointerover', (e) => {
    const c = e.target.closest('[data-r]');
    if (!c) return;
    off();
    const i = Number(c.dataset.r), j = Number(c.dataset.c);
    rowR.setAttribute('y', y0 + i * rh); colR.setAttribute('x', x0 + j * cw);
    rowR.classList.add('on'); colR.classList.add('on');
    hdrRows[i]?.classList.add('hl'); hdrCols[j]?.classList.add('hl');
    last = [i, j];
  });
  cells.addEventListener('pointerleave', off);
  return { rowR, colR };
}

// --- inspector info ------------------------------------------------------------------------

function leftCellInfo(ctx, r, c, e, wireOf, classOf) {
  const same = r.s.id === c.s.id;
  const w = wireOf.get(r.id), k = classOf.get(c.id);
  return {
    title: `C[${r.id}, ${c.id}] = ${fmt(e.c)}`,
    facts: [
      ['place', r.id],
      ['transition', c.id],
      ['pre (arc place → transition)', e.pre || 'none'],
      ['post (arc transition → place)', e.post || 'none'],
      ['C = post − pre', fmt(e.c)],
      ['block', same ? `${r.s.id} (a ${ctx.orders.patterns[r.s.pattern].prefLabel})` : `off the diagonal: ${r.s.id} × ${c.s.id} is 0, because ⊗ is a disjoint union`],
      !e.c && e.pre && e.post ? ['self-loop', 'pre = post: the loop is in the net but C records 0'] : null,
      w ? ['row fuses into', `${w.name} (${w.tag})`] : null,
      k ? ['column fuses into', `${k.name} (${k.tag})`] : null,
    ].filter(Boolean),
    note: 'Computed in this page from the instance\'s arcs (the subnets are built by pflow-compose\'s constructors, ports of go-pflow\'s: bundle.state).',
    cites: [CITE.incGo, CITE.firing, ...(r.s.cites || [])],
  };
}

function rightCellInfo(p, t, e, sum, wireOf, classOf) {
  const w = wireOf.get(p.id), k = classOf.get(t.id);
  const n = p.members.length * t.members.length;
  return {
    title: `C[${p.id}, ${t.id}] = ${fmt(e.c)}`,
    facts: [
      ['place', p.id],
      ['transition', t.id],
      ['pre / post', `${e.pre || 0} / ${e.post || 0}`],
      ['C = post − pre', fmt(e.c)],
      p.members.length > 1 ? ['place members', p.members.join(', ')] : null,
      t.members.length > 1 ? ['transition members', t.members.join(', ')] : null,
      n > 1 ? ['sum of the member entries on the left', `${fmt(sum)} over ${n} entr${n === 1 ? 'y' : 'ies'} ${sum === e.c ? '= this entry ✓' : `≠ this entry ✗`}`] : null,
      e.tests.length ? ['read / inhibitor arcs', `${e.tests.map((a) => `${a.type} ${a.weight}${a.guard ? ' (guard link)' : ''}`).join(', ')}: move nothing, so they are not in C`] : null,
      !e.c && e.pre && e.post ? ['self-loop', 'pre = post: C records 0'] : null,
    ].filter(Boolean),
    note: 'C of the flat net, computed in this page from ctx.orders.flat (the registry\'s bundle.flatten, pflow-compose\'s port of go-pflow Flatten). Under MergeSum the arcs of fused members add, so this entry is the sum of the member entries.',
    cites: [CITE.mergeArcs, CITE.firing, ...(e.tests.length ? [CITE.guard] : [])],
  };
}

function classInfo(c, byIdMap) {
  return {
    title: `event class ${c.tag}: ${c.members.length} transitions fuse`,
    definition: 'Transitions joined by event links (union-find over the links; the class is named by its sorted members).',
    facts: [
      ['flat transition', c.name],
      ['members', c.members.join(', ')],
      ['links', c.links.map((l) => `${l.from.subnet}:${l.from.port} ⊗ ${l.to.subnet}:${l.to.port}${l.idiom ? ` (pat:${l.idiom})` : ''}`).join('; ') || 'none'],
      ['on C', `the flat column is the sum of the ${c.members.length} member columns`],
      ['P-invariants', 'a sum of columns keeps y·C = 0 for every y that was 0 on each member column (compose_flatten.go:337-341)'],
    ],
    bib: ['bruni-et-al'],
    cites: [CITE.mergeArcs, CITE.mergeSum, CITE.road6],
  };
}

function wireInfo(w) {
  return {
    title: `wire ${w.tag}: ${w.members.length} places fuse`,
    definition: 'Places joined by token or data links (union-find; named "wire:" + the smallest member).',
    facts: [
      ['flat place', w.name],
      ['members', w.members.join(', ')],
      ['links', w.links.map((l) => `${l.kind} ${l.from.subnet}:${l.from.port} → ${l.to.subnet}:${l.to.port}`).join('; ')],
      ['on C', `the flat row is the sum of the ${w.members.length} member rows`],
      ['initial marking', 'the members\' initial markings add (mergePlaces)'],
    ],
    note: `Place gluing is the pushout of open nets along the shared place (Baez–Master). ROADMAP 4.2 plans to compare the token-link part of this matrix with pflow-jl glue, up to place renaming${w.kind === 'data' ? ' (this wire is a data link, which 4.2 leaves out)' : ''}; that comparison is not run here.`,
    bib: ['baez-master'],
    cites: [CITE.mergeArcs, CITE.road42, CITE.road6],
  };
}

function invariantRowInfo(ctx, iv, fm) {
  const c = iv.c;
  const s = ctx.orders.byId[c.subnet];
  const local = c.id.slice(c.subnet.length + 1);
  let info;
  try { info = s ? ctx.info.invariantInfo(s, { id: local, expr: c.expr }) : null; } catch { info = null; }
  info = info || { title: '', facts: [], cites: [] };
  info.title = `y·C for ${c.id}`;
  info.definition = c.expr;
  // The shared fact says the constructor's invariant is not proved; here it is checked by linear algebra, so say which.
  info.facts = (info.facts || []).filter(([k]) => k !== 'status');
  info.facts.push(['status here', 'checked by linear algebra on the flat net in this page; go-pflow verify and sim_verify are the engines of record']);
  if (iv.parsed) {
    const coeffs = [...iv.ts.y].map(([p, k]) => (k === 1 ? p : `${k}·${p}`));
    const badCols = iv.yC.map((v, j) => [v, fm.transitions[j]]).filter(([v]) => v.s);
    info.facts.push(
      ['y (from the expression)', coeffs.join(' + ')],
      ['y·C', badCols.length ? badCols.map(([v, t]) => `${t.id}: ${v.terms.map(([p, k, x]) => `${k === 1 ? '' : `${k}·`}${fmt(x)}`).join(' ')} = ${fmt(v.s)}`).join('; ') : `0 in all ${fm.transitions.length} columns`],
      ['y·M₀', `${iv.yM0} (declared ${iv.ts.n})`],
      ['verdict', iv.bad ? `not a P-invariant of the flat net: ${iv.bad} transition${iv.bad === 1 ? '' : 's'} change the sum${iv.ts.y.size && [...iv.ts.y.keys()].some((p) => p.startsWith('wire:')) ? ' (a fused place\'s row also carries the other instance\'s arcs)' : ''}` : iv.yM0 === iv.ts.n ? 'holds in every reachable marking of this flat net (y·C = 0 and y·M₀ = n)' : 'y is still a P-invariant, but y·M₀ differs from the declared constant, so the constraint is false from the start'],
    );
    if ([...iv.ts.y.values()].some((k) => k > 1)) info.facts.push(['note', 'after fusion two terms name one place, so its coefficient is the count']);
    if (iv.missing.length) info.facts.push(['unknown places', iv.missing.join(', ')]);
  } else info.facts.push(['checked', 'no: the expression is not a plain sum of tokens(…) == n']);
  info.note = 'Computed in this page from the flat net: y·C over the matrix above and y·M₀ over its initial marking. It is not a run of go-pflow verify; capacities, read arcs and inhibitors only restrict firing, so they cannot break a P-invariant.';
  info.cites = [...(info.cites || []), CITE.structural, CITE.mergeArcs, CITE.fire];
  return info;
}

// --- the merge animation -----------------------------------------------------------------

function animateLink(ctx, o) {
  const { ev, fm, CR, colG, rowG, cw, rh, x0R, yM, combsL, combsW, classOf, wireOf, portPlace, portTrans, root, showVal, svg = ctx.svg } = o;
  const kind = ev.link.kind;
  const drawIn = (path) => { if (path) anim(path, [{ strokeDasharray: '1', strokeDashoffset: 1 }, { strokeDasharray: '1', strokeDashoffset: 0 }], { duration: 750, easing: EASE }); };

  if (kind === 'guard') {
    const fp = portPlace(ev.link.to), ft = portTrans(ev.link.from);
    const p = fm.places.find((q) => q.members.includes(fp)), t = fm.transitions.find((q) => q.members.includes(ft));
    if (!p || !t) return;
    const i = fm.places.indexOf(p), j = fm.transitions.indexOf(t);
    const cx = x0R + j * cw + cw / 2, cy = yM + i * rh + rh / 2;
    const ring = svg('circle', { cx, cy, r: 14, fill: 'none', stroke: o.T.LINK_STYLE.guard.color, 'stroke-width': 2 });
    const note = svg('text', { x: x0R + fm.transitions.length * cw + 10, y: cy + 3.5, 'font-size': 10, fill: o.T.LINK_STYLE.guard.color, 'font-weight': 600 }, '◇ read arc added: C unchanged');
    root.append(ring, note);
    anim(ring, [{ r: 22, opacity: 0, easing: EASE }, { r: 9, opacity: 1, offset: 0.5 }, { r: 9, opacity: 1, offset: 0.7 }, { r: 9, opacity: 0 }], { duration: 900, fill: 'forwards' })?.addEventListener('finish', () => ring.remove());
    anim(note, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 2200, fill: 'forwards' })?.addEventListener('finish', () => note.remove());
    return;
  }

  const prevLinks = ctx.orders.links.filter((l) => l.index !== ev.link.index).map(({ kind: k, from, to }) => ({ kind: k, from, to }));
  const prev = flatten(ctx.orders.subnets, prevLinks);
  if (!prev.ok) return;
  const pm = prev.model;
  const CP = incidence(pm.places.map((p) => p.id), pm.transitions.map((t) => t.id), pm.arcs, new Set(pm.places.filter(isToken).map((p) => p.id)));
  const dur = 850;
  const byAxis = kind === 'event'
    ? { now: fm.transitions, before: pm.transitions, groups: colG, step: cw, tr: (d) => `translate(${d}px,0px)` }
    : { now: fm.places, before: pm.places, groups: rowG, step: rh, tr: (d) => `translate(0px,${d}px)` };
  const prevIdx = new Map(byAxis.before.map((x, i) => [memberKey(x.members), i]));
  const nowRow = new Map(fm.places.map((p, i) => [p.id, i]));
  const nowCol = new Map(fm.transitions.map((t, j) => [t.id, j]));
  byAxis.now.forEach((x, j) => {
    const key = memberKey(x.members);
    if (prevIdx.has(key)) {
      const i = prevIdx.get(key);
      if (i !== j) anim(byAxis.groups[j], [{ transform: byAxis.tr((i - j) * byAxis.step) }, { transform: byAxis.tr(0) }], { duration: dur * 0.62, easing: SLIDE });
      return;
    }
    // x is the newly fused column (or row): its old pieces slide together, then their sum appears.
    const olds = byAxis.before.map((b, i) => ({ b, i })).filter(({ b }) => b.members.every((m) => x.members.includes(m)));
    anim(byAxis.groups[j], [{ opacity: 0 }, { opacity: 0, offset: 0.58, easing: 'ease-out' }, { opacity: 1 }], { duration: dur });
    for (const { b, i } of olds) {
      const ghost = svg('g', { 'pointer-events': 'none' });
      if (kind === 'event') {
        for (const p of pm.places) {
          const v = CP.at(p.id, b.id).c; const r = nowRow.get(p.id);
          if (!v || r === undefined) continue;
          ghost.append(svg('rect', { x: x0R + j * cw + 0.5, y: yM + r * rh + 0.5, width: cw - 1, height: rh - 1, fill: cellFill(v), stroke: '#fff', 'stroke-width': 0.8 }));
          if (showVal) ghost.append(svg('text', { x: x0R + j * cw + cw / 2, y: yM + r * rh + rh / 2 + 3.2, 'text-anchor': 'middle', class: 'val' }, fmt(v)));
        }
        ghost.append(svg('rect', { x: x0R + j * cw, y: yM, width: cw, height: fm.places.length * rh, fill: 'none', stroke: classOf.get(x.id)?.color || '#227744', 'stroke-width': 1.5 }));
      } else {
        for (const t of pm.transitions) {
          const v = CP.at(b.id, t.id).c; const c = nowCol.get(t.id);
          if (!v || c === undefined) continue;
          ghost.append(svg('rect', { x: x0R + c * cw + 0.5, y: yM + j * rh + 0.5, width: cw - 1, height: rh - 1, fill: cellFill(v), stroke: '#fff', 'stroke-width': 0.8 }));
          if (showVal) ghost.append(svg('text', { x: x0R + c * cw + cw / 2, y: yM + j * rh + rh / 2 + 3.2, 'text-anchor': 'middle', class: 'val' }, fmt(v)));
        }
        ghost.append(svg('rect', { x: x0R, y: yM + j * rh, width: fm.transitions.length * cw, height: rh, fill: 'none', stroke: wireOf.get(x.id)?.color || '#aa3333', 'stroke-width': 1.5 }));
      }
      root.append(ghost);
      // Per-keyframe easing: the slide eases, the fade that follows is linear.
      const a = anim(ghost, [
        { transform: byAxis.tr((i - j) * byAxis.step), opacity: 0.95, easing: SLIDE },
        { transform: byAxis.tr(0), opacity: 0.95, offset: 0.62 },
        { transform: byAxis.tr(0), opacity: 0 },
      ], { duration: dur, fill: 'forwards' });
      if (a) a.addEventListener('finish', () => ghost.remove()); else ghost.remove();
    }
    // Σ badge where the pieces meet.
    const bx = kind === 'event' ? x0R + j * cw + cw / 2 : x0R + fm.transitions.length * cw / 2;
    const by = kind === 'event' ? yM + fm.places.length * rh / 2 : yM + j * rh + rh / 2;
    const color = kind === 'event' ? (classOf.get(x.id)?.color || '#227744') : (wireOf.get(x.id)?.color || '#aa3333');
    const badge = svg('g', { 'pointer-events': 'none', style: 'transform-box: fill-box; transform-origin: center' },
      svg('circle', { cx: bx, cy: by, r: 9, fill: '#fff', stroke: color, 'stroke-width': 1.8 }),
      svg('text', { x: bx, y: by + 4, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: color }, 'Σ'));
    root.append(badge);
    anim(badge, [{ transform: 'scale(0.2)', opacity: 0 }, { transform: 'scale(0.2)', opacity: 0, offset: 0.36, easing: 'ease-out' }, { transform: 'scale(1.25)', opacity: 1, offset: 0.52 }, { transform: 'scale(1)', opacity: 1, offset: 0.62 }, { transform: 'scale(1)', opacity: 1, offset: 0.85 }, { transform: 'scale(1)', opacity: 0 }], { duration: 1500, fill: 'forwards' })?.addEventListener('finish', () => badge.remove());
  });
  // Left matrix: the bracket that names the class (or wire) draws itself in.
  if (kind === 'event') { const c = classOf.get(portTrans(ev.link.from)); if (c) drawIn(combsL.get(c.name)?.path); }
  else { const w = wireOf.get(portPlace(ev.link.from)); if (w) drawIn(combsW.get(w.name)?.path); }
}

// --- connect4 ----------------------------------------------------------------------------

function renderConnect4(ctx) {
  const { svg } = ctx;
  const T = ctx.theme;
  const net = ctx.connect4.net;
  ctx.note('A SearchPlan has no incidence matrix: it is a composite of search pieces (plan.rs), not a P/T net, and its pieces have no places or transitions to put in one. Drawn instead, as the nearest honest thing: the incidence matrix of the Connect-4 net the plan searches (assets/connect-4.json, the pflow-rs fixture). Nothing here is a plan slot; pieces are placed in the plan views.', 'na');
  if (!net) { ctx.note('assets/connect-4.json did not load, so there is no net to draw.', 'warn'); return; }

  // C, pre and post are the registry's: analysis.incidence on the net loaded
  // into the c4 engine (rows: places in document order, cols: transitions).
  let inc;
  try { inc = c4Incidence(net); } catch (e) { ctx.note(`analysis.incidence refused the net: ${e.message}`, 'warn'); return; }
  const P = inc.rows, Tr = inc.cols;
  const ri = new Map(P.map((p, i) => [p, i])), ci = new Map(Tr.map((t, j) => [t, j]));
  // Inhibitor arcs are not in C; they are marked from the document's own arcs.
  const Pset = new Set(P);
  const inhib = new Map();
  let nInhib = 0;
  for (const a of net.arcs) {
    if (!a.inhibitTransition) continue;
    nInhib++;
    const w = Array.isArray(a.weight) && a.weight.length ? a.weight.reduce((s, v) => s + v, 0) : 1;
    inhib.set(Pset.has(a.source) ? K(a.source, a.target) : K(a.target, a.source), w);
  }
  const at = (p, t) => { const i = ri.get(p), j = ci.get(t); return { pre: inc.pre[i][j], post: inc.post[i][j], c: inc.incidence[i][j], inhib: inhib.get(K(p, t)) || 0 }; };

  // Groups by ID prefix (this page's grouping; the fixture has none).
  const cellRe = /^(open|x|o)_(\d+)_(\d+)$/;
  const rowGroups = [
    { key: 'open', label: 'open_c_r', test: (p) => /^open_\d+_\d+$/.test(p) },
    { key: 'x', label: 'x_c_r', test: (p) => /^x_\d+_\d+$/.test(p) },
    { key: 'o', label: 'o_c_r', test: (p) => /^o_\d+_\d+$/.test(p) },
    { key: 'other', label: 'other', test: () => true },
  ].map((g) => ({ ...g, items: [] }));
  for (const p of P) rowGroups.find((g) => g.test(p)).items.push(p);
  const colGroups = [
    { key: 'xplay', label: 'x_play_c_r', what: 'X drops', test: (t) => /^x_play_/.test(t) },
    { key: 'oplay', label: 'o_play_c_r', what: 'O drops', test: (t) => /^o_play_/.test(t) },
    { key: 'xwin', label: 'x_win_*', what: 'X win detectors', test: (t) => /^x_win_/.test(t) },
    { key: 'owin', label: 'o_win_*', what: 'O win detectors', test: (t) => /^o_win_/.test(t) },
    { key: 'other', label: 'other', what: 'other transitions', test: () => true },
  ].map((g) => ({ ...g, items: [] }));
  for (const t of Tr) colGroups.find((g) => g.test(t)).items.push(t);
  // Sub-groups: the column index c for cells and drops, the direction for win detectors.
  const subOf = (id) => { let m = cellRe.exec(id); if (m) return `c${m[2]}`; m = /^[xo]_play_(\d+)_\d+$/.exec(id); if (m) return `c${m[1]}`; m = /^[xo]_win_([a-z0-9]+)_/.exec(id); return m ? m[1] : ''; };
  for (const g of [...rowGroups, ...colGroups]) {
    const order = [];
    for (const id of g.items) { const s = subOf(id); if (!order.includes(s)) order.push(s); }
    g.items.sort((a, b) => order.indexOf(subOf(a)) - order.indexOf(subOf(b))); // stable: fixture order within a sub-group
    g.subs = order.map((s) => ({ key: s, items: g.items.filter((id) => subOf(id) === s) }));
  }
  const RG = rowGroups.filter((g) => g.items.length), CG = colGroups.filter((g) => g.items.length);

  // Layout.
  const M = 12, AX = 112, GG = 3, cw = 4.5, rh = 4.5;
  const x0 = M + AX, y0 = 86;
  const rows = [], cols = [];
  let x = x0;
  CG.forEach((g, gi) => { if (gi) x += GG; g.x0 = x; g.start = cols.length; for (const t of g.items) { cols.push({ id: t, x, g }); x += cw; } g.x1 = x; });
  let y = y0;
  RG.forEach((g, gi) => { if (gi) y += GG; g.y0 = y; g.start = rows.length; for (const p of g.items) { rows.push({ id: p, y, g }); y += rh; } g.y1 = y; });
  const xEnd = x, yEnd = y;
  const W = Math.max(1150, xEnd + M), H = yEnd + 104;

  // Counts (computed here).
  let nz = 0, neg = 0, pos = 0, cat = 0;
  const statsOf = (ps, ts) => { const s = { nz: 0, neg: 0, pos: 0, cat: 0 }; for (const p of ps) for (const t of ts) { const e = at(p, t); if (e.c) { s.nz++; if (e.c < 0) s.neg++; else s.pos++; } else if (e.pre && e.post) s.cat++; } return s; };
  const all = statsOf(P, Tr); nz = all.nz; neg = all.neg; pos = all.pos; cat = all.cat;

  const root = ctx.svgRoot(W, H, { class: 'view-svg inc-svg' });
  ctx.root.append(root);
  root.append(svg('rect', { x: 0, y: 0, width: W, height: H, fill: '#fafafa' }));
  const text = (tx, ty, s, attrs = {}, ...kids) => svg('text', { x: tx, y: ty, ...attrs }, s, ...kids);
  ctx.emit('matrix', 'connect-4', { rows: P.length, cols: Tr.length });
  root.append(
    text(M, 18, `C of the Connect-4 net: ${P.length} places × ${Tr.length} transitions`, { class: 'ttl' }),
    text(M, 34, `${net.name} · assets/connect-4.json (pflow-rs fixture) · C from the registry (analysis.incidence) · grouped by ID prefix on this page`, { class: 'sub' }),
  );
  const readout = text(xEnd, 34, 'hover a cell', { class: 'id', 'text-anchor': 'end', fill: MUTEDC });
  root.append(readout);

  // Block frames.
  for (const rg of RG) for (const cg of CG) root.append(svg('rect', { x: cg.x0, y: rg.y0, width: cg.x1 - cg.x0, height: rg.y1 - rg.y0, fill: '#fff', stroke: '#dde1e6', 'stroke-width': 0.7 }));
  // Sub-group separators.
  const sep = [];
  for (const cg of CG) { let xx = cg.x0; cg.subs.forEach((s, si) => { if (si) sep.push(`M${xx},${y0}V${yEnd}`); s.x0 = xx; xx += s.items.length * cw; s.x1 = xx; }); }
  for (const rg of RG) { let yy = rg.y0; rg.subs.forEach((s, si) => { if (si) sep.push(`M${x0},${yy}H${xEnd}`); s.y0 = yy; yy += s.items.length * rh; s.y1 = yy; }); }
  root.append(svg('path', { d: sep.join(''), stroke: '#eef0f3', 'stroke-width': 0.6, fill: 'none', 'pointer-events': 'none' }));

  // Cells.
  const gc = svg('g', { 'pointer-events': 'none' });
  root.append(gc);
  for (const r of rows) for (const c of cols) {
    const e = at(r.id, c.id);
    if (e.c) gc.append(svg('rect', { x: c.x + 0.3, y: r.y + 0.3, width: cw - 0.6, height: rh - 0.6, fill: cellFill(e.c) }));
    else if (e.pre && e.post) gc.append(svg('circle', { cx: c.x + cw / 2, cy: r.y + rh / 2, r: 1.15, fill: '#9aa1ab' }));
    if (e.inhib) gc.append(svg('path', { d: `M${c.x + 0.6},${r.y + 0.6}l${cw - 1.2},${rh - 1.2}M${c.x + cw - 0.6},${r.y + 0.6}l${-(cw - 1.2)},${rh - 1.2}`, stroke: T.LINK_STYLE.guard.color, 'stroke-width': 0.9 }));
  }

  // Axes: group labels and sub-group ticks.
  const groupInfo = (title, ids, ps, ts, extra = []) => {
    const s = statsOf(ps, ts);
    return {
      title,
      facts: [
        ['count', ids.length],
        ['IDs', ids.length <= 8 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')} … ${ids[ids.length - 1]}`],
        ['nonzero entries', `${s.nz} (${s.neg} × −1, ${s.pos} × +1)`],
        ['pre = post pairs (C = 0)', s.cat],
        ...extra,
      ],
      note: 'Grouped by ID prefix on this page; the fixture has no groups. Counts computed here from assets/connect-4.json.',
      definition: net.description,
      cites: [CITE.fixture, CITE.incGo],
    };
  };
  for (const g of RG) {
    const mid = (g.y0 + g.y1) / 2;
    const tall = g.y1 - g.y0 > 26;
    const lab = text(M, tall ? mid - 2 : mid + 3.5, g.label, { class: 'id hdr hit' });
    ctx.hover(lab, groupInfo(`places ${g.label} (${g.items.length})`, g.items, g.items, Tr));
    root.append(lab);
    if (tall) root.append(text(M, mid + 11, `${g.items.length} places`, { class: 'mut', 'font-size': 9.5 }));
    else root.append(text(M + g.label.length * MONO + 6, mid + 3.5, `(${g.items.length})`, { class: 'mut', 'font-size': 9.5 }));
    if (g.subs.length > 1) for (const s of g.subs) {
      const t = text(x0 - 4, (s.y0 + s.y1) / 2 + 2.6, s.key, { class: 'mut hdr hit', 'font-size': 7.5, 'text-anchor': 'end' });
      ctx.hover(t, groupInfo(`places ${g.label}, column ${s.key.slice(1)} (${s.items.length})`, s.items, s.items, Tr));
      root.append(t);
    }
  }
  for (const g of CG) {
    const mid = (g.x0 + g.x1) / 2;
    const lab = text(mid, y0 - 26, '', { 'text-anchor': 'middle', class: 'hdr hit' }, svg('tspan', { class: 'id' }, g.label), svg('tspan', { class: 'mut', 'font-size': 9.5, dx: 5 }, `${g.items.length} ${g.what}`));
    ctx.hover(lab, groupInfo(`transitions ${g.label}: ${g.what} (${g.items.length})`, g.items, P, g.items));
    root.append(lab, svg('path', { d: `M${g.x0 + 1},${y0 - 18}V${y0 - 15}H${g.x1 - 1}V${y0 - 18}`, stroke: '#b5bcc5', fill: 'none' }));
    if (g.subs.length > 1) for (const s of g.subs) {
      const sm = (s.x0 + s.x1) / 2;
      const isDir = !/^c\d+$/.test(s.key);
      const t = text(sm, y0 - 5, isDir ? `${s.key} ${s.items.length}` : s.key, { class: 'mut hdr hit', 'font-size': 7.5, 'text-anchor': 'middle' });
      ctx.hover(t, groupInfo(`transitions ${g.label}, ${isDir ? `direction ${s.key}` : `column ${s.key.slice(1)}`} (${s.items.length})`, s.items, P, s.items));
      root.append(t);
    }
  }

  // Hover: one probe per cell, made on demand (29k cells are too many to wire up).
  const hl = svg('g', {});
  const rowBand = svg('rect', { x: x0, width: xEnd - x0, height: rh, class: 'c4band', visibility: 'hidden' });
  const colBand = svg('rect', { y: y0, width: cw, height: yEnd - y0, class: 'c4band', visibility: 'hidden' });
  hl.append(rowBand, colBand);
  root.append(hl);
  const hit = svg('g', {});
  const overlay = svg('rect', { x: x0, y: y0, width: xEnd - x0, height: yEnd - y0, fill: 'transparent', 'pointer-events': 'all', class: 'hit' });
  hit.append(overlay);
  root.append(hit);
  let probe = null, probeKey = '';
  const locate = (e) => {
    const m = root.getScreenCTM();
    if (!m) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const c = CG.find((g) => pt.x >= g.x0 && pt.x < g.x1), r = RG.find((g) => pt.y >= g.y0 && pt.y < g.y1);
    if (!c || !r) return null;
    return { col: cols[c.start + Math.floor((pt.x - c.x0) / cw)], row: rows[r.start + Math.floor((pt.y - r.y0) / rh)] };
  };
  const cellInfo = (p, t, e) => ({
    title: `C[${p}, ${t}] = ${fmt(e.c)}`,
    facts: [
      ['place', `${p} (initial ${(net.places[p].initial || [0])[0] ?? 0})`],
      ['transition', t],
      ['pre (arc place → transition)', e.pre || 'none'],
      ['post (arc transition → place)', e.post || 'none'],
      ['C = post − pre', fmt(e.c)],
      !e.c && e.pre && e.post ? ['pre = post', 'the transition takes the token and puts it back (a catalytic read): in the net, not in C'] : null,
      e.inhib ? ['inhibitTransition arc', `weight ${e.inhib}: excluded from C`] : null,
    ].filter(Boolean),
    note: 'pre, post and C are the registry\'s (analysis.incidence on assets/connect-4.json): output − input over the arcs that move tokens, read and inhibitor arcs left out, as go-pflow IncidenceMatrix and pflow-rs incidence_matrix define it. The inhibitTransition mark is read from the document\'s arcs.',
    cites: [CITE.incGo, CITE.weightGo, CITE.incRs, CITE.inhibRs, CITE.rawArc, CITE.rawWeight, CITE.weightRs, CITE.fixture],
  });
  const clearHL = () => { rowBand.setAttribute('visibility', 'hidden'); colBand.setAttribute('visibility', 'hidden'); readout.textContent = 'hover a cell'; readout.setAttribute('fill', MUTEDC); };
  hit.addEventListener('pointermove', (e) => {
    const loc = locate(e);
    if (!loc) { if (probe) { probe.remove(); probe = null; probeKey = ''; } clearHL(); return; }
    const key = `${loc.row.id}|${loc.col.id}`;
    if (key === probeKey) return;
    if (probe) probe.remove();
    const ent = at(loc.row.id, loc.col.id);
    probe = svg('rect', { x: loc.col.x, y: loc.row.y, width: cw, height: rh, class: 'probe hit', 'pointer-events': 'all' });
    probe.dataset.cell = key;
    ctx.hover(probe, cellInfo(loc.row.id, loc.col.id, ent));
    hit.append(probe);
    probeKey = key;
    rowBand.setAttribute('y', loc.row.y); rowBand.setAttribute('visibility', 'visible');
    colBand.setAttribute('x', loc.col.x); colBand.setAttribute('visibility', 'visible');
    readout.textContent = `${loc.row.id} × ${loc.col.id}: C = ${fmt(ent.c)} (pre ${ent.pre}, post ${ent.post})${!ent.c && ent.pre && ent.post ? ', a catalytic read' : ''}`;
    readout.setAttribute('fill', ent.c < 0 ? NEG : ent.c > 0 ? POS : INKC);
    try { probe.dispatchEvent(new PointerEvent('pointerenter', { clientX: e.clientX, clientY: e.clientY })); } catch { /* the next move enters it */ }
  });
  hit.addEventListener('pointerleave', () => { if (probe) { probe.remove(); probe = null; probeKey = ''; } clearHL(); });

  // Legend and computed summary.
  let lx = M; let ly = yEnd + 26;
  const sw = (draw, label) => { root.append(draw(lx, ly - 9), text(lx + 18, ly, label, { class: 'mut', 'font-size': 10.5 })); lx += 18 + label.length * 5.7 + 18; };
  sw((sx, sy) => svg('rect', { x: sx, y: sy, width: 12, height: 11, fill: NEG }), '−1: consumes (pre)');
  sw((sx, sy) => svg('rect', { x: sx, y: sy, width: 12, height: 11, fill: POS }), '+1: produces (post)');
  sw((sx, sy) => svg('rect', { x: sx, y: sy, width: 12, height: 11, fill: '#fff', stroke: '#c3cbd5' }), 'blank: 0');
  sw((sx, sy) => svg('g', {}, svg('rect', { x: sx, y: sy, width: 12, height: 11, fill: '#fff', stroke: '#c3cbd5' }), svg('circle', { cx: sx + 6, cy: sy + 5.5, r: 1.8, fill: '#9aa1ab' })), 'pre = post = 1 (a win detector reads a cell): in the net, C = 0');
  sw((sx, sy) => svg('path', { d: `M${sx + 1},${sy + 1}l10,9M${sx + 11},${sy + 1}l-10,9`, stroke: T.LINK_STYLE.guard.color, 'stroke-width': 1.4 }), `inhibitTransition arc: left out of C (${nInhib} here)`);
  ly += 18;
  root.append(text(M, ly, `${thousands(P.length * Tr.length)} entries · ${nz} nonzero (${neg} × −1, ${pos} × +1) · ${cat} pre = post pairs that C cannot see · ${nInhib} inhibitTransition arcs · ${net.arcs.length} arcs · C, pre and post from the registry (analysis.incidence); the counts are this page's`, { class: 'mut', 'font-size': 10.5 }));
  ly += 16;
  root.append(text(M, ly, 'The fixture declares no invariants, so no y·C check is drawn. Rows and columns are grouped by prefix here; go-pflow and pflow-rs sort them by ID (a permutation of the same C).', { class: 'mut', 'font-size': 10.5 }));
}
