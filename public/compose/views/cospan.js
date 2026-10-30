// View 1: open Petri nets as cospans.
//
// Baez and Master, "Open Petri Nets" (arXiv 1808.05415): an open Petri net is a
// cospan X → S ← Y of finite sets into the net's set of places S. Two open nets
// compose by gluing the right foot of one to the left foot of the next, which
// is a pushout along boundary places: the glued places become one place. The
// ontology ROADMAP (Phase 6, ROADMAP.md:399 and 405-416 at f854116) reads that
// as the exact semantics of go-pflow's lk:token and lk:data links (place
// fusion), and nothing else: unlinked instances are only the monoidal product
// ⊗ (disjoint union), lk:event is transition fusion (Bruni et al., nets with
// boundaries), lk:guard is contextual and outside the free SMC.
//
// What is drawn, per instance: the left foot X (in and inout place ports), the
// right foot Y (out and inout place ports: an inout port is in both feet), the
// legs from each foot point to its place, observe ports as dotted taps on the
// top edge, and the transition ports on the bottom edge, outside the cospan.
// A token or data link (from ctx.orders.links: bundle.state, every link
// validated by the registry's bundle.add_link, pflow-compose's port of go-pflow
// validateLink) is drawn as the pushout: the two instances side by side, the
// glued boundary points fused into one place on the seam, named and marked as
// bundle.flatten names and marks it (wire:<smallest member>, initial markings
// summed). Event and guard links are drawn as faint ghosts that say what they
// are instead.
//
// Connect-4: a search plan is not an open net, so the view draws the game net
// as the closed net ∅ → N ← ∅ the plan runs over, and the plan as a strip of
// slots beside it (its slots take snap drops; pflow-rs's check decides, by
// plan.slot_candidates / plan.add_piece).

import { cite } from '../sources.js';
import { NS, LINK_STYLE_CITE } from '../model.js';
import { CONNECT4_EXACT, toJSON, fieldOrDefault, PLAN_RS_REV } from '../model.js';

const go = (path, from, to = from, note = '') => cite('goPflow', path, from, to, note);
const road = (from, to, note) => cite('ontologyRoadmap', 'ROADMAP.md', from, to, note);
const rs = (path, from, to = from, note = '') => cite('pflowRs', `crates/pflow-metamodel/src/${path}`, from, to, note);
const onto = (path, from, to = from, note = '') => cite('ontology', path, from, to, note);

// Every range below was read at the cited revision: go-pflow 69257b3 (identical
// at c802f34 for these files), ROADMAP.md f854116, ontology bc4a996 (cq/13 and
// ns/core.ttl unchanged at 9a31771), pflow-rs c396d46.
const C = {
  cospanRow: road(399, 399, 'Open Petri nets as cospans: composition is a pushout along boundary places; the exact semantics of token and data links'),
  boundariesRow: road(400, 400, 'Nets with boundaries: the semantics of event links, which a cospan of places does not express'),
  model: road(405, 416, 'Model composition: ⊗ when unlinked, a pushout for token/data, transition fusion for event, guard outside the free SMC; observe ports are side taps, inout ports are drawn on both sides'),
  tensor: road(407, 407, 'Unlinked subnets: the monoidal product ⊗ (disjoint union)'),
  pushout: road(408, 409, 'lk:token / lk:data: a pushout of open nets along a shared place; data links add the observer-does-not-consume restriction'),
  event: road(410, 411, 'lk:event: transition fusion; its semantics is Bruni et al.\'s, not Baez–Master\'s'),
  guard: road(412, 413, 'lk:guard: a cross-subnet read or inhibitor arc, outside the free-SMC fragment; drawn, flagged, no functorial semantics'),
  sides: road(415, 416, 'port direction gives domain/codomain; observe ports are side taps; inout ports are drawn on both sides'),
  placeClasses: go('metamodel/compose_flatten.go', 55, 70, 'Flatten: token and data links union the two places into one class'),
  wireName: go('metamodel/compose_flatten.go', 201, 209, 'flatPlaceName: a fused class is named "wire:" + its canonical member'),
  smallest: go('metamodel/unionfind.go', 5, 6, 'the canonical member of a class is its lexicographically smallest'),
  initialSum: go('metamodel/compose_flatten.go', 291, 292, 'mergePlaces: the fused place\'s initial marking is the sum; its capacity is the tighter one'),
  linkStyle: LINK_STYLE_CITE,
  direction: go('metamodel/compose.go', 676, 683, 'the only port-kind checks on a token link: from is not an in-port, to is not an out-port (observe passes both)'),
  schema: go('metamodel/compose.go', 667, 673, 'port schema tags must agree when both are set (E_SCHEMA_MISMATCH)'),
  autoWin: cite('pflowRs', 'crates/pflow-metamodel/tests/common/mod.rs', 23, 23, 'the test game declares every transition whose name contains "win" automatic'),
  laws: road(420, 427, 'orderers: a partial monoid under chaining; drivers: endomorphisms composed around the core'),
  cq13: onto('cq/13-linkable-ports.rq', 7, 7, 'expect event candidates and no token candidates: the three patterns\' place ports carry different schemas'),
  depthPort: onto('ns/patterns.ttl', 220, 221, 'queue-port-depth: place items, for a data or guard link (observe the backlog)'),
  arcs: onto('ns/core.ttl', 27, 37, 'ns:InputArc (place → transition) and ns:OutputArc (transition → place)'),
  fixture: cite('pflowRs', 'crates/pflow-metamodel/tests/fixtures/connect-4.json', 0, 0, 'the Connect-4 net (assets/connect-4.json is a byte-identical copy of this fixture at c396d46)'),
  solver: rs('plan.rs', 240, 252, 'SearchPlan::solver(&self, g: &Game): the plan builds a solver over a game; it is not glued to the net'),
  game: rs('game.rs', 42, 45, 'Game: a two-sided game on a net'),
};
const BIB_ORDERS = ['baez-master', 'bruni-et-al', 'sobocinski-2010', 'meseguer-montanari', 'catlab'];

// --- geometry ------------------------------------------------------------------------

const W0 = 1150;        // drawing width (the stage at a 1600px window)
const SIDE = 40;        // margin + boundary column + its point, each side
const COLX = 18;        // boundary column distance from the frame edge
const GAP = 96;         // frame to frame between ⊗-separated components
const SEAM = 140;       // frame to frame between two glued instances
const FH = 400;         // frame height
const BAND = 44;        // event-port band at the bottom of a frame
const ROW_HEAD = 40;    // title and tap labels above a frame
const LANE = 130;       // ghost lane under a row
const HEAD = 52;
const FOOT = 154;
const PREF_W = { queue: 180, 'resource-pool': 180, saga: 516 };
const MIN_SAGA = 480;
const FS = 8;           // node label size
const PAPER = '#fafafa';
const FRAME_FILL = { queue: '#f1f6fc', 'resource-pool': '#fcf6ec', saga: '#f6f2fc' };
const LEG = '#8e97a2';
const ARC = '#6d7580';
const NODE = '#3c4656';

const STYLE = `
.cospan-svg text { font-family: var(--font-sans); }
.cospan-svg .cp-t { paint-order: stroke; stroke: var(--halo, ${PAPER}); stroke-width: 3px; stroke-linejoin: round; }
.cospan-svg .cp-mono { font-family: var(--font-mono); }
.cospan-svg .cp-ring { fill: none; stroke: transparent; stroke-width: 2; pointer-events: none; }
.cospan-svg .cp-port:hover .cp-ring { stroke: #9aa1aa; }
.cospan-svg .cp-port.snap-legal .cp-ring { stroke: var(--snap-color); animation: cp-pulse .8s ease-in-out infinite alternate; }
.cospan-svg .cp-port.snap-source .cp-ring { stroke: #111; stroke-width: 2.5; }
@keyframes cp-pulse { from { stroke-width: 1.5; } to { stroke-width: 4.5; } }
.cospan-svg .cp-conn { opacity: 0; transition: opacity .15s; pointer-events: none; }
.cospan-svg .cp-conn.show { opacity: 1; }
.cospan-svg .cp-node.cp-hl .cp-shape { stroke: #111; stroke-width: 2.2; }
.cospan-svg .cp-hit { fill: transparent; stroke: none; }
.cospan-svg .cp-arc-hit { fill: none; stroke: transparent; stroke-width: 7; }
.cospan-svg .cp-arc:hover .cp-arc-line, .cospan-svg .cp-leg:hover .cp-leg-line { stroke: #2b2f36; }
.cospan-svg .cp-ghost:hover .cp-ghost-line { opacity: 1; }
.cospan-svg .cp-chip:hover rect { stroke-width: 2; }
.cospan-svg .cp-slot.snap-legal > rect.cp-slot-box { stroke: var(--snap-color); stroke-width: 2.5; animation: cp-slot-pulse .8s ease-in-out infinite alternate; }
@keyframes cp-slot-pulse { from { stroke-width: 1.5; } to { stroke-width: 4; } }
.cospan-svg .cp-anim { transform-box: fill-box; transform-origin: center; }
`;

// --- small helpers ---------------------------------------------------------------------

function mk(ctx) {
  const S = ctx.svg;
  const text = (x, y, s, attrs = {}) => S('text', { x, y, 'font-size': FS, fill: '#4a525c', class: 'cp-t', ...attrs }, s);
  return { S, text };
}

const tw = (s, size) => String(s).length * size * 0.58;
// The manifest's name for where a port is drawn: its foot (X left, Y right,
// both for an inout port), the top edge (observe taps) or the bottom edge
// (transition ports: event ports, outside the cospan).
const SIDE_NAME = (port) => { const s = portSides(port); return s.includes('X') && s.includes('Y') ? 'both' : ({ X: 'left', Y: 'right', top: 'top', bottom: 'bottom' })[s[0]]; };
const portSides = (port) => (port.target === 'transition' ? ['bottom'] : ({ in: ['X'], out: ['Y'], inout: ['X', 'Y'], observe: ['top'] }[port.kind] || ['X']));

/** Shorten a segment so it starts/ends at the node boundary. */
function clip(from, to, rFrom, rTo) {
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const off = (node, r) => (node.kind === 'transition' ? r / Math.max(Math.abs(ux), Math.abs(uy), 1e-6) : r);
  const a = off(from, rFrom), b = off(to, rTo);
  return { x1: from.x + ux * a, y1: from.y + uy * a, x2: to.x - ux * b, y2: to.y - uy * b };
}

function animate(node, keyframes, opts) {
  if (!node || typeof node.animate !== 'function') return null;
  try { return node.animate(keyframes, { duration: 760, easing: 'cubic-bezier(.2,.8,.2,1)', ...opts }); } catch { return null; }
}

// --- local layouts (frame coordinates) ------------------------------------------------

function layoutQueue(s, w) {
  const cx = w / 2, n = {};
  n.items = { x: cx, y: 124 };
  if (s.places.some((p) => p.id === 'slots')) n.slots = { x: cx, y: 244 };
  n.enqueue = { x: cx - 52, y: 184 };
  n.dequeue = { x: cx + 52, y: 184 };
  return { nodes: n, routes: {}, labels: {} };
}

function layoutPool(s, w) {
  const cx = w / 2;
  return {
    nodes: { available: { x: cx, y: 124 }, in_use: { x: cx, y: 244 }, acquire: { x: cx + 52, y: 184 }, release: { x: cx - 52, y: 184 } },
    routes: {}, labels: {},
  };
}

// Rows: two account lanes, forward control, failures, step state, unwind, compensated, rolled_back.
const SAGA_ROWS = { laneM: 44, laneC: 70, r0: 108, r1: 158, r2: 208, r3: 258, r4: 300, rb: 334 };

function layoutSaga(s, w) {
  const steps = s.steps || [];
  const n = steps.length;
  const ncol = 2 * n + 3;
  const S = (w - 68) / (ncol - 1);
  const col = (k) => 34 + k * S;
  const R = SAGA_ROWS;
  const nodes = {}, labels = {};
  steps.forEach((st, i) => {
    nodes[`next_${st}`] = { x: col(2 * i), y: R.r0 };
    nodes[`do_${st}`] = { x: col(2 * i + 1), y: R.r0 };
    nodes[`fail_${st}`] = { x: col(2 * i + 1), y: R.r1 };
    nodes[`undo_${st}`] = { x: col(2 * i + 1), y: R.r3 };
    nodes[`${st}_pending`] = { x: col(2 * i), y: R.r1 };
    nodes[`${st}_failed`] = { x: col(2 * i + 1), y: R.r2 };
    nodes[`${st}_done`] = { x: col(2 * i + 2), y: R.r2 };
    nodes[`${st}_compensated`] = { x: col(2 * i + 1), y: R.r4 };
    nodes[`unwind_${st}`] = { x: col(2 * i + 2), y: R.r3 };
  });
  nodes.committing = { x: col(2 * n), y: R.r0 };
  nodes.commit = { x: col(2 * n + 1), y: R.r0 };
  nodes.fail_commit = { x: col(2 * n + 1), y: R.r1 };
  nodes.completed = { x: col(2 * n + 2), y: R.r0 };
  nodes.rolled_back = { x: col(0), y: R.rb };
  // Accounts sit on their own lanes above the step that moves them, between columns.
  const accts = s.accounts || [];
  accts.forEach((a, ai) => {
    let j = steps.findIndex((st) => s.arcs.some((x) => (x.from === a && x.to === `do_${st}`) || (x.to === a && x.from === `do_${st}`)));
    if (j < 0) j = Math.max(0, n - 1);
    const left = ai % 2 === 0;
    const k = Math.floor(ai / 2);
    nodes[a] = { x: col(2 * j + 1) + (left ? -S / 2 : S / 2) + (left ? -k : k) * S, y: left ? R.laneC : R.laneM };
    labels[a] = 'above';
  });
  // An account's arcs to an undo transition run down the free corridor between columns.
  const routes = {};
  for (const a of accts) for (const st of steps) {
    const t = `undo_${st}`;
    for (const arc of s.arcs) {
      if (!((arc.from === a && arc.to === t) || (arc.from === t && arc.to === a))) continue;
      routes[`${arc.from}>${arc.to}`] = (P) => {
        const ap = P(a), tp = P(t);
        if (!ap.home || !tp.home) return null;
        // Down the corridor to just above the box, then a tight turn into its top corner.
        const sx = tp.x + (ap.x < tp.x ? -3.5 : 3.5);
        const knee = { x: ap.x, y: tp.y - 15 }, top = { x: sx, y: tp.y - 6.5 };
        const c1 = { x: ap.x, y: tp.y - 8 }, c2 = { x: sx, y: tp.y - 13 };
        if (arc.from === t) {
          const pts = [...cPts(top, c2, c1, knee, 6), { x: ap.x, y: ap.y + 9 }];
          return { d: `M${top.x},${top.y} C${c2.x},${c2.y} ${c1.x},${c1.y} ${knee.x},${knee.y} L${ap.x},${ap.y + 9}`, pts };
        }
        const pts = [{ x: ap.x, y: ap.y + 9 }, ...cPts(knee, c1, c2, top, 6)];
        return { d: `M${ap.x},${ap.y + 9} L${knee.x},${knee.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${top.x},${top.y}`, pts };
      };
    }
  }
  return { nodes, routes, labels, colSpacing: S };
}

function layoutFallback(s, w, nodes) {
  const missing = [...s.places.map((p) => p.id), ...s.transitions.map((t) => t.id)].filter((id) => !nodes[id]);
  const per = Math.max(1, Math.floor((w - 40) / 60));
  missing.forEach((id, i) => { nodes[id] = { x: 30 + (i % per) * 60, y: 300 + Math.floor(i / per) * 30 }; });
}

function localLayout(s, w) {
  const L = s.pattern === 'queue' ? layoutQueue(s, w) : s.pattern === 'resource-pool' ? layoutPool(s, w) : s.pattern === 'saga' ? layoutSaga(s, w) : { nodes: {}, routes: {}, labels: {} };
  layoutFallback(s, w, L.nodes);
  return L;
}

// --- geometry for label placement ----------------------------------------------------------

function qPts(p0, c, p1, n = 10) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = i / n, u = 1 - t; out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y }); }
  return out;
}
function cPts(p0, c1, c2, p1, n = 12) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({ x: u ** 3 * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * p1.x, y: u ** 3 * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * p1.y });
  }
  return out;
}
/** Does segment a-b pass through rect r (Liang–Barsky)? */
function segRect(a, b, r) {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy], q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}
/** A polyline with rounded corners. */
function roundedPath(pts, r) {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], c = pts[i], n = pts[i + 1];
    const l1 = Math.hypot(c.x - p.x, c.y - p.y) || 1, l2 = Math.hypot(n.x - c.x, n.y - c.y) || 1;
    const k1 = Math.min(r, l1 / 2), k2 = Math.min(r, l2 / 2);
    d += ` L${c.x - ((c.x - p.x) / l1) * k1},${c.y - ((c.y - p.y) / l1) * k1} Q${c.x},${c.y} ${c.x + ((n.x - c.x) / l2) * k2},${c.y + ((n.y - c.y) / l2) * k2}`;
  }
  const z = pts[pts.length - 1];
  return `${d} L${z.x},${z.y}`;
}
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function textRect(x, y, s, size, anchor = 'middle') {
  const w = String(s).length * size * 0.63; // a little wider than tw(): collisions must not be underestimated
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  return { x: x0 - 1.5, y: y - size * 0.82, w: w + 3, h: size + 1.5 };
}

const PLACE_CANDS = [[0, 18, 'middle'], [0, -12, 'middle'], [12, 3, 'start'], [-12, 3, 'end'], [7, 19, 'start'], [-7, 19, 'end'], [7, -11, 'start'], [-7, -11, 'end']];
const TRANS_CANDS = [[0, -10, 'middle'], [0, 18.5, 'middle'], [10, 3, 'start'], [-10, 3, 'end'], [6, -10, 'start'], [-6, -10, 'end'], [6, 18.5, 'start'], [-6, 18.5, 'end'], [0, -17, 'middle']];

/**
 * Greedy, deterministic label placement: each label takes the first candidate
 * position with the fewest crossings (arcs and legs it would sit on, nodes and
 * labels it would cover). Most constrained nodes go first.
 */
function placeLabels(items, polys, rects, labels) {
  const out = {};
  for (const it of items) {
    const base = it.kind === 'place' ? PLACE_CANDS : TRANS_CANDS;
    const cands = it.prefer === 'above' ? [base[1], base[0], ...base.slice(2)] : base;
    let best = null;
    cands.forEach(([dx, dy, anchor], i) => {
      const x = it.x + dx, y = it.y + dy;
      const r = textRect(x, y, it.text, FS, anchor);
      let score = i * 0.05;
      for (const poly of polys) {
        for (let k = 1; k < poly.length; k++) if (segRect(poly[k - 1], poly[k], r)) { score += 1; break; }
      }
      for (const rr of rects) if (overlap(r, rr)) score += 4;
      for (const rr of labels) if (overlap(r, rr)) score += 6;
      if (it.bounds && (r.x < it.bounds.x || r.x + r.w > it.bounds.x + it.bounds.w || r.y < it.bounds.y || r.y + r.h > it.bounds.y + it.bounds.h)) score += 3;
      if (!best || score < best.score - 1e-9) best = { x, y, anchor, score, r };
    });
    labels.push(best.r);
    out[it.key] = best;
  }
  return out;
}

// --- orders ----------------------------------------------------------------------------

function components(subnets, glue) {
  const parent = new Map(subnets.map((s) => [s.id, s.id]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (const l of glue) {
    const a = find(l.from.subnet), b = find(l.to.subnet);
    if (a !== b) parent.set(b, a);
  }
  const groups = new Map();
  subnets.forEach((s) => { const r = find(s.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s.id); });
  return [...groups.values()].map((ids) => {
    const links = glue.filter((l) => ids.includes(l.from.subnet));
    if (!links.length) return ids;
    const order = [links[0].from.subnet, links[0].to.subnet];
    for (let pass = 0; pass < ids.length; pass++) {
      for (const l of links) {
        const a = l.from.subnet, b = l.to.subnet;
        if (order.includes(a) && !order.includes(b)) order.push(b);
        else if (order.includes(b) && !order.includes(a)) order.unshift(a);
      }
    }
    for (const id of ids) if (!order.includes(id)) order.push(id);
    return order;
  });
}

function renderOrders(ctx) {
  const { S, text } = mk(ctx);
  const { subnets, byId, links, flat } = ctx.orders;
  const theme = ctx.theme;
  const glue = links.filter((l) => l.kind === 'token' || l.kind === 'data');
  const ghosts = links.filter((l) => l.kind === 'event' || l.kind === 'guard');
  const flatOk = flat && flat.ok;
  if (!flatOk && links.length) ctx.note(`bundle.flatten refused the links (${(flat?.errors || []).map((e) => e.code).join(', ')}); no pushout is drawn.`, 'warn');
  const haloOf = (s) => `--halo: ${FRAME_FILL[s.pattern] || '#f4f5f7'}`;

  // 1. Components (instances glued by token/data links) and their left-to-right order.
  const comps = components(subnets, flatOk ? glue : []);
  const inst = {};
  for (const s of subnets) inst[s.id] = { s, w: PREF_W[s.pattern] || 200 };

  // 2. Rows: pack components left to right, ⊗ between them; a glued pair that is too wide squeezes its sagas.
  const inner = W0 - 2 * SIDE;
  const compW = (ids) => ids.reduce((a, id) => a + inst[id].w, 0) + SEAM * (ids.length - 1);
  for (const ids of comps) {
    const excess = compW(ids) - inner;
    const sagas = ids.filter((id) => inst[id].s.pattern === 'saga');
    if (excess > 0 && sagas.length) {
      const cut = Math.min(excess / sagas.length, PREF_W.saga - MIN_SAGA);
      for (const id of sagas) inst[id].w = PREF_W.saga - cut;
    }
  }
  const rows = [];
  for (const ids of comps) {
    const w = compW(ids);
    const row = rows[rows.length - 1];
    if (row && row.width + GAP + w <= inner) { row.comps.push(ids); row.width += GAP + w; } else rows.push({ comps: [ids], width: w });
  }
  const W = Math.max(W0, ...rows.map((r) => r.width + 2 * SIDE));
  const rowPitch = ROW_HEAD + FH + LANE;
  const H = HEAD + rows.length * rowPitch + FOOT;
  rows.forEach((row, ri) => {
    row.top = HEAD + ri * rowPitch;
    row.y0 = row.top + ROW_HEAD;
    let x = (W - row.width) / 2;
    row.x = x;
    row.comps.forEach((ids, ci) => {
      if (ci) x += GAP;
      ids.forEach((id, k) => {
        if (k) x += SEAM;
        Object.assign(inst[id], { x0: x, y0: row.y0, row: ri, comp: ids, pos: k });
        x += inst[id].w;
      });
    });
  });
  for (const id of Object.keys(inst)) Object.assign(inst[id], localLayout(inst[id].s, inst[id].w));

  // 3. Glued places: one per flat wire class that spans two instances, on the seam between them.
  const merged = {}; // `${sid}/${pid}` -> P
  const Ps = [];
  if (flatOk) {
    for (const [name, members] of Object.entries(flat.map.wires || {})) {
      const subs = [...new Set(members.map((m) => m.split('/')[0]))].filter((sid) => inst[sid]);
      if (subs.length < 2) continue;
      const comp = inst[subs[0]].comp;
      const left = Math.min(...subs.map((sid) => comp.indexOf(sid)));
      const A = inst[comp[left]], B = inst[comp[left + 1]] || A;
      const homes = members.map((m) => { const [sid, pid] = m.split('/'); const I = inst[sid]; const n = I.nodes[pid]; return { sid, pid, x: I.x0 + n.x, y: I.y0 + n.y }; });
      const P = {
        name, members, homes,
        x: (A.x0 + A.w + B.x0) / 2,
        y: homes.reduce((a, h) => a + h.y, 0) / homes.length,
        seamLeft: A, seamRight: B,
        flatPlace: flat.model.places.find((p) => p.id === name),
        links: [],
      };
      Ps.push(P);
      for (const m of members) merged[m] = P;
    }
    const bySeam = new Map();
    for (const P of Ps) { const k = P.seamLeft.s.id; if (!bySeam.has(k)) bySeam.set(k, []); bySeam.get(k).push(P); }
    for (const list of bySeam.values()) {
      list.sort((a, b) => a.y - b.y || (a.name < b.name ? -1 : 1));
      for (let i = 1; i < list.length; i++) if (list[i].y - list[i - 1].y < 64) list[i].y = list[i - 1].y + 64;
    }
    for (const l of glue) {
      const fp = byId[l.from.subnet].ports.find((p) => p.id === l.from.port);
      const P = merged[`${l.from.subnet}/${fp.place}`];
      if (P) P.links.push(l);
    }
  }

  const isTransition = (s, id) => s.transitions.some((t) => t.id === id);
  const posOf = (sid, id) => {
    const I = inst[sid];
    const P = merged[`${sid}/${id}`];
    const n = I.nodes[id];
    const kind = isTransition(I.s, id) ? 'transition' : 'place';
    if (P) return { x: P.x, y: P.y, kind, home: false, P, hx: I.x0 + n.x, hy: I.y0 + n.y };
    return { x: I.x0 + n.x, y: I.y0 + n.y, kind, home: true };
  };

  // Foot points glued at a seam are drawn there (as half-rings), not on their column.
  const gluedSide = new Set();
  for (const P of Ps) for (const l of P.links) {
    for (const end of [l.from, l.to]) {
      const I = inst[end.subnet];
      const side = I === P.seamLeft ? 'Y' : I === P.seamRight ? 'X' : null;
      const port = I.s.ports.find((p) => p.id === end.port);
      if (side && portSides(port).includes(side)) gluedSide.add(`${end.subnet}|${end.port}|${side}`);
    }
  }

  // 4. Geometry: arcs, legs, taps, event ports, and the fixed labels.
  const geo = {}; // sid -> { arcs, feet, taps, tports, polys, fixed }
  for (const s of subnets) {
    const I = inst[s.id];
    const { x0, y0, w } = I;
    const G = { arcs: [], feet: [], taps: [], tports: [], polys: [], fixed: [] };
    geo[s.id] = G;
    for (const a of s.arcs) {
      const f = posOf(s.id, a.from), t = posOf(s.id, a.to);
      const route = I.routes[`${a.from}>${a.to}`];
      const rt = route ? route((id) => posOf(s.id, id)) : null;
      let d, pts;
      if (rt) ({ d, pts } = rt);
      else if (!f.home || !t.home) {
        const m = !f.home ? f : t, o = !f.home ? t : f;
        const c = { x: m.hx, y: m.hy };
        const dxo = c.x - o.x, dyo = c.y - o.y, lo = Math.hypot(dxo, dyo) || 1;
        const rO = o.kind === 'transition' ? 7 / Math.max(Math.abs(dxo / lo), Math.abs(dyo / lo), 1e-6) : 9;
        const op = { x: o.x + (dxo / lo) * rO, y: o.y + (dyo / lo) * rO };
        const dx = m.x - c.x, dy = m.y - c.y, len = Math.hypot(dx, dy) || 1;
        const mp = { x: m.x - (dx / len) * 12, y: m.y - (dy / len) * 12 };
        if (f === m) { d = `M${mp.x},${mp.y} Q${c.x},${c.y} ${op.x},${op.y}`; pts = qPts(mp, c, op); } else { d = `M${op.x},${op.y} Q${c.x},${c.y} ${mp.x},${mp.y}`; pts = qPts(op, c, mp); }
      } else {
        const k = clip(f, t, f.kind === 'transition' ? 6.5 : 8.5, t.kind === 'transition' ? 7 : 9);
        d = `M${k.x1},${k.y1} L${k.x2},${k.y2}`;
        pts = [{ x: k.x1, y: k.y1 }, { x: k.x2, y: k.y2 }];
      }
      G.arcs.push({ a, f, t, d, pts, mergedEnd: !f.home || !t.home });
      G.polys.push(pts);
    }
    // Feet: points spread so two ports never share a y on one side; label along the leg when it fits.
    for (const side of ['X', 'Y']) {
      const cx = side === 'X' ? x0 - COLX : x0 + w + COLX;
      const pts = s.ports.filter((p) => portSides(p).includes(side)).map((port) => ({ port, hy: y0 + I.nodes[port.place].y })).sort((a, b) => a.hy - b.hy);
      for (let i = 0; i < pts.length; i++) { pts[i].y = pts[i].hy; if (i && pts[i].y - pts[i - 1].y < 18) pts[i].y = pts[i - 1].y + 18; }
      for (const pt of pts) {
        const { port } = pt;
        const key = `${s.id}|${port.id}|${side}`;
        const target = posOf(s.id, port.place);
        const start = { x: cx + (side === 'X' ? 6 : -6), y: pt.y };
        let d, lp;
        if (!target.home) {
          const c = { x: target.hx, y: pt.y };
          const end = { x: target.x + (target.x > c.x ? -15 : 15), y: target.y };
          d = `M${start.x},${start.y} Q${c.x},${c.y} ${end.x},${end.y}`; lp = qPts(start, c, end);
        } else {
          const end = { x: target.x + (side === 'X' ? -10 : 10), y: target.y };
          d = `M${start.x},${start.y} L${end.x},${end.y}`; lp = [start, end];
        }
        const glued = gluedSide.has(key);
        const labelW = tw(port.id, FS);
        const legLen = Math.abs((target.home ? target.x : (side === 'X' ? x0 + w : x0)) - cx);
        let label = null;
        if (legLen >= labelW + 30) label = { x: side === 'X' ? cx + 9 : cx - 9, y: pt.y - 5, anchor: side === 'X' ? 'start' : 'end', halo: haloOf(s) };
        else if (port.id !== port.place) label = { x: cx, y: pt.y - 10, anchor: 'middle', halo: `--halo: ${PAPER}` };
        G.feet.push({ port, side, key, cx, y: pt.y, target, d, pts: lp, glued, label });
        if (!glued) {
          G.polys.push(lp);
          if (label) G.fixed.push(textRect(label.x, label.y, port.id, FS, label.anchor));
        }
      }
    }
    // Observe taps on the top edge.
    for (const port of s.ports.filter((p) => portSides(p).includes('top'))) {
      const home = { x: x0 + I.nodes[port.place].x, y: y0 + I.nodes[port.place].y };
      const target = posOf(s.id, port.place);
      const tx = home.x, ty = y0;
      let d, pts;
      if (target.home) { d = `M${tx},${ty + 5} L${tx},${target.y - 10}`; pts = [{ x: tx, y: ty + 5 }, { x: tx, y: target.y - 10 }]; } else {
        const end = { x: target.x, y: target.y - 15 };
        d = `M${tx},${ty + 5} Q${tx},${home.y} ${end.x},${end.y}`; pts = qPts({ x: tx, y: ty + 5 }, { x: tx, y: home.y }, end);
      }
      G.taps.push({ port, tx, ty, target, d, pts });
      G.polys.push(pts);
    }
    // Event ports on the bottom edge, outside the cospan: at their transition's x, or spread evenly when crowded.
    const tps = s.ports.filter((p) => p.target === 'transition').map((port, i) => ({ port, i, tx: I.nodes[port.transition].x })).sort((a, b) => a.tx - b.tx || a.i - b.i);
    let spread = false;
    for (let i = 1; i < tps.length; i++) if (tps[i].tx - tps[i - 1].tx < 60) spread = true;
    tps.forEach((tp, i) => {
      const px = x0 + (spread ? 30 + (i * (w - 60)) / Math.max(1, tps.length - 1) : tp.tx);
      G.tports.push({ port: tp.port, px, py: y0 + FH });
    });
  }

  // 5. Node labels: placed against the arcs, legs, nodes and fixed labels of their own frame.
  const labelAt = {};
  for (const s of subnets) {
    const I = inst[s.id], G = geo[s.id];
    const rects = [];
    for (const n of [...s.places, ...s.transitions]) {
      const p = posOf(s.id, n.id);
      if (!p.home) continue;
      rects.push({ x: p.x - 9, y: p.y - 9, w: 18, h: 18 });
    }
    const degree = {};
    for (const a of s.arcs) { degree[a.from] = (degree[a.from] || 0) + 1; degree[a.to] = (degree[a.to] || 0) + 1; }
    const items = [...s.places.map((p) => ({ id: p.id, kind: 'place' })), ...s.transitions.map((t) => ({ id: t.id, kind: 'transition' }))]
      .filter((n) => posOf(s.id, n.id).home)
      .map((n, order) => { const p = posOf(s.id, n.id); return { key: `${s.id}/${n.id}`, x: p.x, y: p.y, text: n.id, kind: n.kind, prefer: I.labels[n.id], deg: degree[n.id] || 0, order, bounds: { x: I.x0 + 2, y: I.y0 + 2, w: I.w - 4, h: FH - BAND - 4 } }; })
      .sort((a, b) => b.deg - a.deg || a.order - b.order);
    Object.assign(labelAt, placeLabels(items, G.polys, rects, [...G.fixed]));
  }

  // --- drawing ---
  const svg = ctx.svgRoot(W, H, { class: 'view-svg cospan-svg', role: 'img', 'aria-label': 'Each pattern instance drawn as an open Petri net, a cospan X → S ← Y' });
  svg.append(
    S('defs', {},
      S('marker', { id: 'cp-arr', viewBox: '0 0 8 8', refX: 7.2, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto', markerUnits: 'userSpaceOnUse' }, S('path', { d: 'M0,0.6 L8,4 L0,7.4 z', fill: ARC })),
      S('marker', { id: 'cp-arr-glue', viewBox: '0 0 8 8', refX: 7.2, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto', markerUnits: 'userSpaceOnUse' }, S('path', { d: 'M0,0.6 L8,4 L0,7.4 z', fill: theme.LINK_STYLE.token.color }))),
    S('rect', { x: 0, y: 0, width: W, height: H, fill: PAPER }));
  const layers = {};
  for (const k of ['frames', 'arcs', 'legs', 'nodes', 'ports', 'seams', 'ghosts', 'top', 'fx']) { layers[k] = S('g', { class: `cp-layer-${k}` }); svg.append(layers[k]); }
  const anim = { ports: {}, Ps: {}, ghosts: {}, frames: {} };
  const fadeFor = (name) => (anim.Ps[name] ||= { fade: [] }).fade;
  const nodeEls = {};

  // Header.
  layers.top.append(
    text(SIDE - 22, 20, 'Each instance is an open Petri net: a cospan X → S ← Y of finite sets into its places S (Baez–Master).', { 'font-size': 12.5, fill: theme.INK, 'font-weight': 600, class: '' }),
    text(SIDE - 22, 37, 'Feet X (left: in and inout ports) and Y (right: out and inout ports) map by legs (grey dashed) to places. Gluing Y of one net to X of the next is a pushout; in go-pflow that is lk:token and lk:data.', { 'font-size': 10.5, fill: theme.MUTED, class: '' }),
  );

  // Frames, titles, feet columns, event bands.
  for (const s of subnets) {
    const I = inst[s.id];
    const { x0, y0, w } = I;
    const g = S('g', { class: 'cp-inst', 'data-subnet': s.id, style: haloOf(s) });
    ctx.emit('subnet', s.id, { pattern: s.pattern });
    anim.frames[s.id] = g;
    layers.frames.append(g);
    const frame = S('rect', { x: x0, y: y0, width: w, height: FH, rx: 9, fill: FRAME_FILL[s.pattern] || '#f4f5f7', stroke: '#c5ccd5', 'stroke-width': 1.2 });
    const X = s.ports.filter((p) => portSides(p).includes('X')), Y = s.ports.filter((p) => portSides(p).includes('Y'));
    const taps = s.ports.filter((p) => portSides(p).includes('top')), tports = s.ports.filter((p) => p.target === 'transition');
    const finfo = ctx.info.subnetInfo(s);
    finfo.facts = [
      ['open net', `X = {${X.map((p) => p.id).join(', ')}} → S (${s.places.length} places) ← Y = {${Y.map((p) => p.id).join(', ')}}`],
      ['legs', [...new Set([...X, ...Y].map((p) => `${p.id} ↦ ${p.place}`))].join('; ')],
      taps.length ? ['taps (in neither foot)', taps.map((p) => `${p.id} ↦ ${p.place}`).join('; ')] : null,
      ['event ports (not legs)', tports.map((p) => p.id).join(', ')],
      ...finfo.facts,
    ].filter(Boolean);
    finfo.note = 'An open net in the Baez–Master sense: the feet X and Y are finite sets, the legs are functions into the places. Transition ports are not part of the cospan; event links compose them by fusion (nets with boundaries).';
    finfo.bib = ['baez-master'];
    finfo.cites = [C.cospanRow, C.sides, ...finfo.cites];
    ctx.hover(frame, finfo);
    g.append(frame);
    const p = ctx.orders.patterns[s.pattern];
    g.append(
      text(x0 - COLX, y0 - 25, s.id, { 'font-size': 12.5, 'font-weight': 700, fill: theme.INK, style: `--halo: ${PAPER}` }),
      text(x0 + w + COLX, y0 - 25, `${X.length} → ${s.places.length} ← ${Y.length}`, { 'font-size': 9.5, fill: theme.MUTED, 'text-anchor': 'end', class: 'cp-t cp-mono', style: `--halo: ${PAPER}` }),
    );
    // The pattern name after the id, shortened (or dropped) so it never reaches the size formula.
    const room = w + 2 * COLX - (tw(s.id, 12.5) * 1.06 + 7) - (`${X.length} → ${s.places.length} ← ${Y.length}`.length * 9.5 * 0.62 + 10);
    const pat = p ? p.prefLabel : s.pattern;
    const sub = [s.extra ? `${pat} · second instance` : pat, s.extra ? `${pat} · extra` : pat, pat, ''].find((t) => t.length * 10 * 0.6 <= room) ?? '';
    if (sub) g.append(text(x0 - COLX + tw(s.id, 12.5) * 1.06 + 7, y0 - 25, sub, { 'font-size': 10, fill: theme.MUTED, style: `--halo: ${PAPER}` }));
    const bandTop = y0 + FH - BAND;
    for (const [side, cx] of [['X', x0 - COLX], ['Y', x0 + w + COLX]]) {
      g.append(S('line', { x1: cx, y1: y0 + 14, x2: cx, y2: bandTop - 6, stroke: '#b9c0c8', 'stroke-width': 1, 'stroke-dasharray': '1.5 3' }));
      const hdr = text(cx, y0 - 8, side, { 'font-size': 12, 'font-style': 'italic', 'font-family': 'Georgia, serif', 'text-anchor': 'middle', fill: theme.INK, style: `--halo: ${PAPER}` });
      ctx.hover(hdr, { title: `${side === 'X' ? 'left foot X' : 'right foot Y'} of ${s.id}`, definition: side === 'X' ? 'The boundary points the net can be glued along on its left: its in and inout place ports.' : 'The boundary points the net can be glued along on its right: its out and inout place ports.', facts: [['points', (side === 'X' ? X : Y).map((q) => q.id).join(', ') || '∅']], cites: [C.sides], bib: ['baez-master'] });
      g.append(hdr);
    }
    g.append(S('line', { x1: x0 + 8, y1: bandTop, x2: x0 + w - 8, y2: bandTop, stroke: '#c9cfd6', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
    const capAttrs = { 'font-size': 7.5, 'font-style': 'italic', 'text-anchor': 'middle', fill: theme.MUTED };
    if (w > 320) g.append(text(x0 + w / 2, bandTop + 12, 'event ports: not part of a cospan (see Nets with boundaries)', capAttrs));
    else g.append(text(x0 + w / 2, bandTop + 11, 'event ports: not part of a cospan', capAttrs), text(x0 + w / 2, bandTop + 20, '(see Nets with boundaries)', capAttrs));
  }

  // Arcs.
  for (const s of subnets) {
    for (const { a, f, t, d, mergedEnd } of geo[s.id].arcs) {
      const isInput = f.kind === 'place';
      const mid = { x: (f.x + t.x) / 2, y: (f.y + t.y) / 2 };
      const g = S('g', { class: 'cp-arc' },
        S('path', { d, class: 'cp-arc-hit' }),
        S('path', { d, class: 'cp-arc-line', fill: 'none', stroke: mergedEnd ? theme.LINK_STYLE.token.color : ARC, 'stroke-width': 1, opacity: mergedEnd ? 0.75 : 1, 'marker-end': mergedEnd ? 'url(#cp-arr-glue)' : 'url(#cp-arr)' }),
        a.weight > 1 ? text(mid.x + 4, mid.y - 3, String(a.weight), { 'font-size': 8, 'font-weight': 700 }) : null);
      ctx.hover(g, {
        title: `arc ${s.id}/${a.from} → ${s.id}/${a.to}`,
        concept: { iri: NS + (isInput ? 'InputArc' : 'OutputArc'), types: ['ns:Arc'] },
        definition: isInput ? 'Place to transition. Weight tokens are consumed when the transition fires.' : 'Transition to place. Weight tokens are produced when the transition fires.',
        facts: [['weight', a.weight || 1], mergedEnd ? ['after the pushout', `the place is ${(f.P || t.P).name}: this arc now reads or writes the shared place`] : null].filter(Boolean),
        cites: [C.arcs, ...(s.cites || [])],
      });
      if (mergedEnd) fadeFor((f.P || t.P).name).push(g);
      layers.arcs.append(g);
    }
  }

  // Places and transitions (a glued place is drawn once, on its seam).
  const tokenDots = (x, y, n, r = 8) => {
    if (n <= 0) return [];
    if (n > 3) return [S('text', { x, y: y + 3.2, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: theme.INK }, String(n))];
    const pts = n === 1 ? [[0, 0]] : n === 2 ? [[-2.8, 0], [2.8, 0]] : [[0, -2.8], [-2.6, 2], [2.6, 2]];
    return pts.map(([dx, dy]) => S('circle', { cx: x + dx, cy: y + dy, r: r > 9 ? 2.4 : 2, fill: theme.INK }));
  };
  const placeStroke = (s, pid) => {
    const q = s.ports.find((p) => p.target === 'place' && p.place === pid);
    return q ? theme.portColor(q) : '#8a929c';
  };
  const nodeLabel = (s, id) => {
    const L = labelAt[`${s.id}/${id}`];
    return L ? text(L.x, L.y, id, { 'text-anchor': L.anchor }) : null;
  };
  for (const s of subnets) {
    for (const pl of s.places) {
      if (merged[`${s.id}/${pl.id}`]) continue;
      const p = posOf(s.id, pl.id);
      const g = S('g', { class: 'cp-node cp-place' },
        S('circle', { cx: p.x, cy: p.y, r: 8, fill: '#fff', stroke: placeStroke(s, pl.id), 'stroke-width': pl.exported ? 1.8 : 1.2, class: 'cp-shape' }),
        ...tokenDots(p.x, p.y, pl.initial),
        nodeLabel(s, pl.id));
      const info = ctx.info.placeInfo(s, pl.id);
      info.facts.push(['in this drawing', pl.exported ? 'a leg target: a foot point maps here' : 'interior: no foot point maps here']);
      ctx.hover(g, info);
      nodeEls[`${s.id}/${pl.id}`] = g;
      layers.nodes.append(g);
    }
    for (const t of s.transitions) {
      const p = posOf(s.id, t.id);
      const exported = s.ports.some((q) => q.transition === t.id);
      const g = S('g', { class: 'cp-node cp-transition' },
        S('rect', { x: p.x - 6, y: p.y - 6, width: 12, height: 12, rx: 1.5, fill: '#fff', stroke: NODE, 'stroke-width': 1.3, class: 'cp-shape' }),
        exported ? S('rect', { x: p.x - 6, y: p.y + 3.5, width: 12, height: 2.5, fill: NODE }) : null,
        nodeLabel(s, t.id));
      const info = ctx.info.transitionInfo(s, t.id);
      if (exported) info.note = 'The dark bar marks a transition exposed as an event port (bottom edge). Hover the port to see the connection.';
      ctx.hover(g, info);
      nodeEls[`${s.id}/${t.id}`] = g;
      layers.nodes.append(g);
    }
  }

  // Ports.
  const portGroup = (s, port, side, vis, hit, ring, info) => {
    const inner = S('g', { class: 'cp-anim-move' }, hit, ring, ...vis);
    const g = S('g', { class: 'cp-port', 'data-side': side }, inner);
    ctx.emit('port', `${s.id}:${port.id}`, { side: SIDE_NAME(port), target: port.target });
    ctx.snap.port(g, { subnet: s.id, port: port.id });
    ctx.hover(g, info);
    anim.ports[`${s.id}|${port.id}|${side}`] = { g: inner };
    return g;
  };
  const footInfo = (s, port, side) => {
    const info = ctx.info.portInfo(s, port);
    info.facts.push(['foot', side === 'X' ? 'X, the left foot (domain): in and inout ports' : 'Y, the right foot (codomain): out and inout ports'], ['leg', `${port.id} ↦ ${s.id}/${port.place}`]);
    if (port.kind === 'inout') info.note = 'An inout port is in both feet, so it is drawn on both sides (ROADMAP Phase 6); both points are this one port.';
    info.cites = [...info.cites, C.sides];
    info.bib = ['baez-master'];
    return info;
  };
  for (const s of subnets) {
    const G = geo[s.id];
    for (const ft of G.feet) {
      const { port, side, key, cx, y, target, d, glued, label } = ft;
      if (glued) continue; // fused at the seam
      const col = theme.portColor(port);
      const leg = S('g', { class: 'cp-leg' }, S('path', { d, class: 'cp-arc-hit' }), S('path', { d, class: 'cp-leg-line', fill: 'none', stroke: LEG, 'stroke-width': 1, 'stroke-dasharray': '4 3' }));
      const li = footInfo(s, port, side);
      li.title = `leg ${s.id}:${port.id} ↦ ${target.home ? `${s.id}/${port.place}` : target.P.name}`;
      li.note = `A leg of the cospan: the function from the foot ${side} to the places sends this point to ${target.home ? port.place : `the glued place ${target.P.name}`}.`;
      ctx.hover(leg, li);
      if (!target.home) fadeFor(target.P.name).push(leg);
      layers.legs.append(leg);
      const g = portGroup(s, port, side, [S('circle', { cx, cy: y, r: 5.5, fill: col, stroke: '#fff', 'stroke-width': 1.5 })], S('circle', { cx, cy: y, r: 9, class: 'cp-hit' }), S('circle', { cx, cy: y, r: 9, class: 'cp-ring' }), footInfo(s, port, side));
      Object.assign(anim.ports[key], { x: cx, y });
      layers.ports.append(g);
      if (label) layers.ports.append(text(label.x, label.y, port.id, { 'text-anchor': label.anchor, fill: col, 'font-weight': 600, style: label.halo }));
    }
    for (const tp of G.taps) {
      const { port, tx, ty, target, d } = tp;
      const col = theme.portColor(port);
      const leg = S('g', { class: 'cp-leg' }, S('path', { d, class: 'cp-arc-hit' }), S('path', { d, class: 'cp-leg-line', fill: 'none', stroke: col, 'stroke-width': 1.3, 'stroke-dasharray': '1.5 3' }));
      const info = ctx.info.portInfo(s, port);
      info.facts.push(['drawn as', 'a tap on the top edge, in neither foot: read-only by the ontology\'s reading (data or guard links)']);
      info.note = 'An observe port is a side tap (ROADMAP Phase 6), not a foot. Note: validateLink (go-pflow\'s rule, which the registry runs as pflow-compose\'s port) checks only in/out for token links, so a token link through this port is allowed; the ontology describes it for data or guard links.';
      info.cites = [...info.cites, C.sides, C.depthPort, C.direction];
      ctx.hover(leg, info);
      if (!target.home) fadeFor(target.P.name).push(leg);
      layers.legs.append(leg);
      const vis = [S('circle', { cx: tx, cy: ty, r: 5, fill: '#fff', stroke: col, 'stroke-width': 1.8 }), S('circle', { cx: tx, cy: ty, r: 1.6, fill: col })];
      const g = portGroup(s, port, 'top', vis, S('circle', { cx: tx, cy: ty, r: 9, class: 'cp-hit' }), S('circle', { cx: tx, cy: ty, r: 9, class: 'cp-ring' }), info);
      Object.assign(anim.ports[`${s.id}|${port.id}|top`], { x: tx, y: ty });
      layers.ports.append(g, text(tx, ty - 9, `${port.id} (observe)`, { 'text-anchor': 'middle', fill: col, 'font-weight': 600, style: `--halo: ${PAPER}` }));
    }
    for (const tp of G.tports) {
      const { port, px, py } = tp;
      const tpos = posOf(s.id, port.transition);
      const conn = S('path', { d: `M${px},${py - 5} C${px},${py - 60} ${tpos.x},${tpos.y + 60} ${tpos.x},${tpos.y + 7}`, fill: 'none', stroke: NODE, 'stroke-width': 1.2, 'stroke-dasharray': '2 2.5', class: 'cp-conn' });
      layers.fx.append(conn);
      const info = ctx.info.portInfo(s, port);
      info.note = 'A transition port is not a leg of a Baez–Master cospan, whose feet are sets of places. Event links compose it by transition fusion: nets with boundaries (Bruni et al.).';
      info.bib = ['bruni-et-al', 'sobocinski-2010'];
      info.cites = [...info.cites, C.boundariesRow, C.event];
      const vis = [S('rect', { x: px - 4.5, y: py - 4.5, width: 9, height: 9, rx: 1, fill: theme.TRANSITION_PORT_COLOR || NODE, stroke: '#fff', 'stroke-width': 1.2 })];
      const g = portGroup(s, port, 'bottom', vis, S('rect', { x: px - 8, y: py - 8, width: 16, height: 16, class: 'cp-hit' }), S('rect', { x: px - 8, y: py - 8, width: 16, height: 16, rx: 3, class: 'cp-ring' }), info);
      Object.assign(anim.ports[`${s.id}|${port.id}|bottom`], { x: px, y: py });
      const node = nodeEls[`${s.id}/${port.transition}`];
      const on = () => { conn.classList.add('show'); node && node.classList.add('cp-hl'); };
      const off = () => { conn.classList.remove('show'); node && node.classList.remove('cp-hl'); };
      g.addEventListener('pointerenter', on); g.addEventListener('pointerleave', off);
      if (node) { node.addEventListener('pointerenter', on); node.addEventListener('pointerleave', off); }
      layers.ports.append(g, text(px, py - 8, port.id, { 'text-anchor': 'middle', fill: NODE, 'font-size': 7.5, style: haloOf(s) }));
    }
  }

  // 6. Seams: the pushout. One place per glued wire class; the glued points are fused into it.
  const seamsDone = new Set();
  for (const P of Ps) {
    const A = P.seamLeft, B = P.seamRight;
    const kinds = [...new Set(P.links.map((l) => l.kind))];
    const lc = theme.LINK_STYLE[kinds.includes('token') ? 'token' : 'data'];
    if (!seamsDone.has(A.s.id)) {
      seamsDone.add(A.s.id);
      // The seam's label runs along it, in the longest stretch no glued place occupies.
      const top = A.y0 + 10, bot = A.y0 + FH - BAND - 6;
      const busy = Ps.filter((q) => q.seamLeft === A).map((q) => [q.y - 15 - 5 * q.links.length - 6, q.y + 15 + 5 * q.links.length + 34]).sort((u, v) => u[0] - v[0]);
      let free = [], cur = top;
      for (const [u, v] of busy) { if (u > cur) free.push([cur, u]); cur = Math.max(cur, v); }
      if (bot > cur) free.push([cur, bot]);
      free.sort((u, v) => (v[1] - v[0]) - (u[1] - u[0]));
      const [f0, f1] = free[0] || [top, bot];
      // Which way each link on this seam glues: a token link's from end is never an in-port, so it sits in
      // the from instance's Y (or is a tap); a link whose from instance is on the right glues back.
      const seamLinks = Ps.filter((q) => q.seamLeft === A).flatMap((q) => q.links);
      const back = seamLinks.filter((l) => inst[l.from.subnet].x0 > P.x).length;
      const fwd = seamLinks.length - back;
      const line2 = !back ? `Y of ${A.s.id} glued to X of ${B.s.id}` : !fwd ? `Y of ${B.s.id} glued to X of ${A.s.id}` : 'glued both ways (a loop)';
      const fits = tw(line2, 8) + 12 < f1 - f0;
      const rot = (dy, str, attrs) => S('text', { x: 0, y: dy, transform: `translate(${P.x},${(f0 + f1) / 2}) rotate(-90)`, 'text-anchor': 'middle', fill: lc.color, class: 'cp-t', style: `--halo: ${PAPER}`, ...attrs }, str);
      const seam = S('g', { class: 'cp-seam' },
        S('line', { x1: P.x, y1: top, x2: P.x, y2: bot, stroke: lc.color, 'stroke-width': 1.2, 'stroke-dasharray': lc.dash, opacity: 0.45 }),
        rot(-4, `${lc.glyph} pushout seam`, { 'font-weight': 700, 'font-size': 8.5 }),
        fits ? rot(9, line2, { 'font-size': 8 }) : null);
      ctx.hover(seam, {
        title: `pushout seam: ${A.s.id} ; ${B.s.id}`,
        definition: 'Gluing the right foot of one open net to the left foot of the next identifies the places the glued points map to: the pushout of the two place sets over the shared boundary.',
        facts: [['glued wires', Ps.filter((q) => q.seamLeft === A).map((q) => q.name).join(', ')], ['links', seamLinks.map((l) => `${l.kind}: ${l.from.subnet}:${l.from.port} → ${l.to.subnet}:${l.to.port}`).join('; ')]],
        note: back && fwd ? `Some links glue ${A.s.id}'s Y to ${B.s.id}'s X and others glue ${B.s.id}'s Y back to ${A.s.id}'s X. The registry allows both; the places are identified all the same (one class per wire), but the composite is no longer a plain sequence ${A.s.id} ; ${B.s.id}: it closes a loop. Drawn on one seam.` : back ? `The link runs from ${B.s.id} to ${A.s.id}; the view keeps the first link's from side on the left.` : null,
        cites: [C.cospanRow, C.pushout, C.placeClasses], bib: ['baez-master'],
      });
      layers.seams.append(seam);
    }
    const g = S('g', { class: 'cp-merged' });
    const inner = S('g', { class: 'cp-anim' });
    const sums = P.homes.map((h) => inst[h.sid].s.places.find((p) => p.id === h.pid)?.initial || 0);
    const total = P.flatPlace ? P.flatPlace.initial : sums.reduce((a, b) => a + b, 0);
    const schemaPort = P.links.length ? byId[P.links[0].from.subnet].ports.find((p) => p.id === P.links[0].from.port) : null;
    const sc = schemaPort ? theme.portColor(schemaPort) : '#888';
    inner.append(S('circle', { cx: P.x, cy: P.y, r: 10.5, fill: '#fff', stroke: sc, 'stroke-width': 2.2, class: 'cp-shape' }), ...tokenDots(P.x, P.y, total, 10.5));
    g.append(inner);
    const ringR = 15 + 5 * Math.max(0, P.links.length - 1);
    const lbl1 = text(P.x, P.y + ringR + 15, P.name, { 'text-anchor': 'middle', 'font-size': 7.6, 'font-weight': 700, fill: theme.INK, class: 'cp-t cp-mono' });
    const lbl2 = text(P.x, P.y + ringR + 25, `initial ${sums.join(' + ')} = ${total}`, { 'text-anchor': 'middle', 'font-size': 7.5, fill: theme.MUTED });
    g.append(lbl1, lbl2);
    if (P.flatPlace) {
      const fi = ctx.info.flatPlaceInfo(P.flatPlace);
      fi.title = `glued place ${P.name}`;
      fi.note = `The pushout: ${P.members.join(' and ')} are one place in the composite, named as Flatten names a fused class (its smallest member; bundle.flatten). The marking (${sums.join(' + ')} = ${total}) and the capacity (the tighter one) are Flatten's: a Baez–Master open net carries neither, so the pushout itself says nothing about them.`;
      fi.cites = [C.placeClasses, C.wireName, C.smallest, C.initialSum, C.pushout, ...fi.cites];
      fi.bib = ['baez-master', 'meseguer-montanari'];
      ctx.hover(g, fi);
    }
    layers.seams.append(g);
    anim.Ps[P.name] = { ...(anim.Ps[P.name] || { fade: [] }), g: inner, labels: [lbl1, lbl2], P, handles: {} };
    P.links.forEach((l, k) => {
      ctx.emit('link', l.key, { kind: l.kind, style: 'pushout' });
      const r = 15 + k * 5;
      for (const end of [l.from, l.to]) {
        const I = inst[end.subnet];
        const port = I.s.ports.find((p) => p.id === end.port);
        const onLeft = I.x0 < P.x;
        const sweep = onLeft ? 0 : 1;
        const arc = `M${P.x},${P.y - r} A${r},${r} 0 0 ${sweep} ${P.x},${P.y + r}`;
        const hitArc = `M${P.x},${P.y - r - 5} A${r + 5},${r + 5} 0 0 ${sweep} ${P.x},${P.y + r + 5} L${P.x},${P.y + r - 5} A${r - 5},${r - 5} 0 0 ${1 - sweep} ${P.x},${P.y - r + 5} Z`;
        const vis = [S('path', { d: arc, fill: 'none', stroke: theme.portColor(port), 'stroke-width': 3.2, 'stroke-linecap': 'round', 'stroke-dasharray': l.kind === 'data' && end === l.to ? '2 3' : null })];
        const info = ctx.info.linkInfo(l, byId);
        info.title = `${end.subnet}:${end.port}, glued (${l.kind} link)`;
        info.note = `This half-ring is the foot point ${end.subnet}:${end.port}; the other half is ${end === l.from ? `${l.to.subnet}:${l.to.port}` : `${l.from.subnet}:${l.from.port}`}. The pushout identifies them, so both map to ${P.name}. go-pflow keeps the port after linking, so it stays draggable.${l.kind === 'data' ? ' A data link is read-only on the observer side (E_DATALINK_CONSUMES): drawn dotted.' : ''}${port.kind === 'observe' ? ' This end is an observe port: validateLink allows a token link through it (only in/out are checked).' : ''}`;
        info.cites = [C.pushout, C.placeClasses, ...info.cites];
        info.bib = ['baez-master'];
        const pg = portGroup(I.s, port, `glue${l.index}`, vis, S('path', { d: hitArc, class: 'cp-hit' }), S('path', { d: arc, fill: 'none', class: 'cp-ring' }), info);
        // The merge animation starts each half-ring where its foot point was: the foot that faces the
        // seam when the port has one, else its other foot, else (an observe port) its tap.
        const sides = portSides(port);
        const side = onLeft ? (sides.includes('Y') ? 'Y' : sides.includes('X') ? 'X' : 'top') : (sides.includes('X') ? 'X' : sides.includes('Y') ? 'Y' : 'top');
        const ft = side === 'top' ? geo[end.subnet].taps.find((q) => q.port.id === port.id) : geo[end.subnet].feet.find((q) => q.port.id === port.id && q.side === side);
        const start = ft ? (side === 'top' ? { x: ft.tx, y: ft.ty } : { x: ft.cx, y: ft.y }) : { x: onLeft ? I.x0 + I.w + COLX : I.x0 - COLX, y: I.y0 + I.nodes[port.place].y };
        (anim.Ps[P.name].handles[l.index] ||= []).push({ g: pg.firstChild, dx: start.x - P.x, dy: start.y - P.y });
        layers.seams.append(pg);
      }
    });
  }

  // 7. ⊗ between components.
  for (const row of rows) {
    for (let ci = 1; ci < row.comps.length; ci++) {
      const prev = inst[row.comps[ci - 1][row.comps[ci - 1].length - 1]], next = inst[row.comps[ci][0]];
      const x = (prev.x0 + prev.w + next.x0) / 2, y = row.y0 + (FH - BAND) / 2;
      const g = S('g', { class: 'cp-tensor' }, S('circle', { cx: x, cy: y, r: 14, fill: PAPER, stroke: '#c5ccd5' }), S('text', { x, y: y + 6.5, 'text-anchor': 'middle', 'font-size': 19, fill: '#7a828c' }, '⊗'));
      ctx.hover(g, { title: 'monoidal product ⊗', definition: 'Side by side with no shared place: the disjoint union of the two open nets (feet and places). As a cospan composite this is all there is until a token or data link glues a foot.', facts: [['left', row.comps[ci - 1].join(' ; ')], ['right', row.comps[ci].join(' ; ')]], note: 'Event links between these instances do change the go-pflow composite (Flatten fuses the two transitions), but not by gluing places: transition fusion is not a cospan composite, so it is drawn as a ghost below the frames, not here.', cites: [C.tensor, C.event], bib: ['baez-master', 'bruni-et-al'] });
      layers.top.append(g);
    }
  }

  // 8. Ghosts: event links (transition fusion) and guard links (contextual). Both ends in one row: a
  // curve through that row's lane. Ends in different rows: a labelled stub at each end, so no ghost
  // cuts through a frame.
  const portEl = (ref, prefer) => {
    for (const side of prefer) { const p = anim.ports[`${ref.subnet}|${ref.port}|${side}`]; if (p && p.x !== undefined) return { ...p, side }; }
    return null;
  };
  const ghostInfo = (l) => {
    const info = ctx.info.linkInfo(l, byId);
    if (l.kind === 'event') {
      info.note = 'Event link: transition fusion, not a pushout. A Baez–Master cospan has places on its feet, so fusing two transitions is not a cospan composite; it is the composition of nets with boundaries (Bruni et al.). Drawn as a ghost: real in the flat net (bundle.flatten fuses the two transitions), not this convention\'s.';
      info.bib = ['bruni-et-al', 'sobocinski-2010'];
      info.cites = [C.event, C.boundariesRow, ...info.cites];
    } else {
      info.note = 'Guard link: a cross-subnet read arc (W_RESTRICTIVE_LINK). Contextual: outside the free-SMC fragment, so no cospan or functorial semantics is claimed for it.';
      info.cites = [C.guard, ...info.cites];
    }
    return info;
  };
  const glyphFor = (l, x, y) => {
    const st = theme.LINK_STYLE[l.kind];
    return S('g', { class: 'cp-anim' }, S('circle', { cx: x, cy: y, r: 7.5, fill: PAPER, stroke: l.leak ? theme.LEAK : st.color, 'stroke-width': l.leak ? 1.8 : 1.2 }),
      S('text', { x, y: y + 3.6, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: st.color }, st.glyph));
  };
  const sameRow = new Map(), crossRow = [];
  for (const l of ghosts) {
    const a = portEl(l.from, ['bottom']);
    const b = l.kind === 'event' ? portEl(l.to, ['bottom']) : portEl(l.to, ['top', 'X', 'Y']);
    if (!a || !b) continue;
    const ra = inst[l.from.subnet].row, rb = inst[l.to.subnet].row;
    if (ra !== rb) { crossRow.push({ l, a, b }); continue; }
    if (!sameRow.has(ra)) sameRow.set(ra, []);
    sameRow.get(ra).push({ l, a, b, span: Math.abs(a.x - b.x) });
  }
  // Stub depths per row: the rightmost stub is the shortest, so a label (which runs right) never
  // crosses a stub further right.
  // A stub to an observe tap does not go up into the title band: like a same-row guard it runs round the
  // frame through the gap beside it, and its glyph sits in the lane below with the bottom stubs (sx).
  const stubEnds = [];
  for (const { l, a, b } of crossRow) for (const [p, end] of [[a, l.from], [b, l.to]]) {
    const T = inst[end.subnet];
    const gx = p.side === 'top' ? (p.x < T.x0 + T.w / 2 ? T.x0 - COLX - 13 : T.x0 + T.w + COLX + 13) : null;
    stubEnds.push({ l, p, end, row: T.row, gx, sx: gx ?? p.x, lane: p.side === 'bottom' || p.side === 'top' });
  }
  const stubLen = new Map();
  for (let r = 0; r < rows.length; r++) {
    stubEnds.filter((x) => x.row === r && x.lane).sort((u, v) => v.sx - u.sx || u.l.index - v.l.index).forEach((x, j) => stubLen.set(x, 30 + 22 * j));
    stubEnds.filter((x) => x.row === r && !x.lane).forEach((x, j) => stubLen.set(x, 30 + 14 * j));
  }
  const laneDeep = {};
  // Rects that ghost labels must keep clear of, per row: every ghost glyph and label already drawn.
  const avoid = rows.map(() => []);
  const glyphRect = (x, y) => ({ x: x - 8.5, y: y - 8.5, w: 17, h: 17 });
  // The title band above each frame and the tap labels: a stub label must not sit on them.
  for (const s of subnets) {
    const I = inst[s.id];
    avoid[I.row].push({ x: I.x0 - COLX - 4, y: I.y0 - 37, w: I.w + 2 * COLX + 8, h: 15 }, { x: I.x0 - COLX - 8, y: I.y0 - 19, w: 16, h: 14 }, { x: I.x0 + I.w + COLX - 8, y: I.y0 - 19, w: 16, h: 14 });
    for (const tp of geo[s.id].taps) avoid[I.row].push(textRect(tp.tx, tp.ty - 9, `${tp.port.id} (observe)`, FS, 'middle'));
  }
  const inside = (r) => r.x >= 2 && r.x + r.w <= W - 2;
  // Cross-row: a stub at each end, naming the other end. Drawn first, so the same-row labels can avoid them.
  for (const { l, a, b } of crossRow) {
    const st = theme.LINK_STYLE[l.kind];
    const g = S('g', { class: 'cp-ghost' });
    let first = null;
    for (const [p, end, other] of [[a, l.from, l.to], [b, l.to, l.from]]) {
      const se = stubEnds.find((x) => x.l === l && x.end === end);
      const len = stubLen.get(se) || 30;
      let d, x2, y2;
      if (p.side === 'top') {
        const T = inst[end.subnet];
        x2 = se.gx; y2 = T.y0 + FH + len;
        d = roundedPath([{ x: p.x, y: p.y - 5.5 }, { x: p.x, y: T.y0 - 3 }, { x: x2, y: T.y0 - 3 }, { x: x2, y: y2 }], 9);
      } else {
        const dir = { bottom: [0, 1], X: [-1, 0], Y: [1, 0] }[p.side];
        const x1 = p.x + dir[0] * 6, y1 = p.y + dir[1] * 6;
        x2 = p.x + dir[0] * len; y2 = p.y + dir[1] * len;
        d = `M${x1},${y1} L${x2},${y2}`;
      }
      g.append(S('path', { d, class: 'cp-arc-hit' }), S('path', { d, class: 'cp-ghost-line', fill: 'none', stroke: st.color, 'stroke-width': 1.5, 'stroke-dasharray': l.kind === 'event' ? '5 4' : st.dash, opacity: 0.6 }));
      const glyph = glyphFor(l, x2, y2);
      g.append(glyph);
      first ||= glyph;
      const ri = inst[other.subnet].row, rs = inst[end.subnet].row;
      const where = ri > rs ? 'row below' : 'row above';
      const label = `${l.kind} link with ${other.subnet}:${other.port} (${where})${l.leak ? ': pool leaks a worker on rollback' : ''}`;
      // Beside the glyph, running away from the frame; else the other way; else above or below it.
      const away = p.side === 'X' ? [[-11, 3.2, 'end'], [11, 3.2, 'start']] : [[11, 3.2, 'start'], [-11, 3.2, 'end']];
      const cands = [...away, [0, 20, 'middle']].map(([dx, dy, anchor]) => ({ x: x2 + dx, y: y2 + dy, anchor, r: textRect(x2 + dx, y2 + dy, label, 8.5, anchor) }));
      avoid[rs].push(glyphRect(x2, y2));
      const pick = cands.find((c) => inside(c.r) && !avoid[rs].some((q) => overlap(c.r, q))) || cands.find((c) => inside(c.r)) || cands[0];
      g.append(text(pick.x, pick.y, label, { 'text-anchor': pick.anchor, fill: l.leak ? theme.LEAK : st.color, 'font-size': 8.5, 'font-weight': 600, style: `--halo: ${PAPER}` }));
      avoid[rs].push(pick.r);
      if (p.side === 'bottom' || p.side === 'top') laneDeep[rs] = Math.max(laneDeep[rs] || rows[rs].y0 + FH + 40, y2);
    }
    ctx.hover(g, ghostInfo(l));
    ctx.emit('link', l.key, { kind: l.kind, style: l.kind === 'guard' ? 'guard' : 'ghost' });
    anim.ghosts[l.index] = { g, glyph: first };
    layers.ghosts.append(g);
  }
  // Same row: one lane each. Event links take the shallow lanes and guard links the deep ones, so a
  // guard's lane and its caption run below every event curve instead of through them.
  for (const [r, list] of sameRow) {
    list.sort((p, q) => (p.l.kind === 'guard') - (q.l.kind === 'guard') || p.span - q.span || p.l.index - q.l.index);
    const e = rows[r].y0 + FH;
    const below = Math.max(0, ...stubEnds.filter((x) => x.row === r && x.lane).map((x) => stubLen.get(x)));
    const base = below ? (below + 26) / 0.75 : 36;
    const drawn = list.map(({ l, a, b }, k) => {
      const dd = base + 17 * k;
      let d, mx, my;
      if (l.kind === 'event') {
        d = `M${a.x},${e + 6} C${a.x},${e + 6 + dd} ${b.x},${e + 6 + dd} ${b.x},${b.y + 6}`;
        mx = (a.x + b.x) / 2; my = e + 6 + 0.75 * dd;
      } else {
        // A guard runs around the frames, not through them: down into the lane, along it to the
        // gap beside the target's frame, up that gap, and in to the target point.
        const T = inst[l.to.subnet];
        const left = T.x0 - COLX - 13, right = T.x0 + T.w + COLX + 13;
        const gx = b.side === 'X' ? left : b.side === 'Y' ? right : (a.x < T.x0 + T.w / 2 ? left : right);
        const ly = e + 6 + 0.75 * dd;
        const pts = b.side === 'top'
          ? [{ x: a.x, y: e + 6 }, { x: a.x, y: ly }, { x: gx, y: ly }, { x: gx, y: T.y0 - 3 }, { x: b.x, y: T.y0 - 3 }, { x: b.x, y: b.y - 5.5 }]
          : [{ x: a.x, y: e + 6 }, { x: a.x, y: ly }, { x: gx, y: ly }, { x: gx, y: b.y }, { x: b.x + (b.side === 'X' ? -6 : 6), y: b.y }];
        d = roundedPath(pts, 9);
        mx = (a.x + gx) / 2; my = ly;
      }
      avoid[r].push(glyphRect(mx, my));
      return { l, d, mx, my };
    });
    for (const { l, d, mx, my } of drawn) {
      const st = theme.LINK_STYLE[l.kind];
      const g = S('g', { class: 'cp-ghost' },
        S('path', { d, class: 'cp-arc-hit' }),
        S('path', { d, class: 'cp-ghost-line', fill: 'none', stroke: st.color, 'stroke-width': 1.5, 'stroke-dasharray': l.kind === 'event' ? '5 4' : st.dash, opacity: 0.6 }));
      const glyph = glyphFor(l, mx, my);
      g.append(glyph);
      let deepest = my;
      const caption = l.kind === 'guard' ? ['⊘ guard link: contextual, outside the free SMC', theme.LINK_STYLE.guard.color, 8.5]
        : l.leak ? ['pool leaks a worker on rollback (idiom caveat)', theme.LEAK, 8] : null;
      if (caption) {
        const [str, fill, size] = caption;
        // Below the glyph if that is clear, else above it, else further down (deterministic order).
        const cands = [19, -12, 31, 43].map((dy) => ({ y: my + dy, r: textRect(mx, my + dy, str, size, 'middle') }));
        const pick = cands.find((c) => !avoid[r].some((q) => overlap(c.r, q))) || cands[0];
        avoid[r].push(pick.r);
        deepest = Math.max(deepest, pick.y);
        g.append(text(mx, pick.y, str, { 'text-anchor': 'middle', fill, 'font-size': size, 'font-weight': 600, style: `--halo: ${PAPER}` }));
      }
      laneDeep[r] = Math.max(laneDeep[r] || e + 40, deepest - 19 > my ? deepest - 19 : my);
      ctx.hover(g, ghostInfo(l));
      ctx.emit('link', l.key, { kind: l.kind, style: l.kind === 'guard' ? 'guard' : 'ghost' });
      anim.ghosts[l.index] = { g, glyph };
      layers.ghosts.append(g);
    }
  }
  rows.forEach((row, r) => {
    const hasEvent = ghosts.some((l) => l.kind === 'event' && (inst[l.from.subnet]?.row === r || inst[l.to.subnet]?.row === r));
    if (!hasEvent) return;
    const e = row.y0 + FH;
    layers.ghosts.append(text(row.x - COLX, Math.min((laneDeep[r] || e + 40) + 36, e + LANE - 6), '⊗ event link: transition fusion, not a pushout (Bruni et al.). Drawn as a ghost: real in the flat net (bundle.flatten), not a cospan composite.', { fill: theme.LINK_STYLE.event.color, 'font-size': 9.5, 'font-weight': 600, style: `--halo: ${PAPER}` }));
  });

  // 9. Footer: the composite, and the legend.
  const fy = H - FOOT + 26;
  const loops = (ids) => glue.some((l) => ids.includes(l.from.subnet) && ids.indexOf(l.from.subnet) > ids.indexOf(l.to.subnet));
  const compExpr = rows.flatMap((r) => r.comps).map((ids) => (ids.length > 1 ? `(${ids.join(' ; ')}${loops(ids) ? ', glued both ways' : ''})` : ids[0])).join(' ⊗ ');
  const compTitle = `Cospan composite: ${compExpr}`;
  ctx.emit('composite', 'bundle', { form: rows.some((r) => r.comps.some((ids) => ids.length > 1)) ? 'pushout' : 'tensor' });
  layers.top.append(text(SIDE - 22, fy, compTitle, { 'font-size': 12.5, 'font-weight': 700, fill: theme.INK, class: 'cp-t cp-mono' }));
  const nEvent = ghosts.filter((l) => l.kind === 'event').length, nGuard = ghosts.length - nEvent;
  if (ghosts.length) {
    const parts = [nEvent ? `${nEvent} event fusion${nEvent === 1 ? '' : 's'}` : null, nGuard ? `${nGuard} guard read arc${nGuard === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
    const sfx = text(SIDE - 22 + compTitle.length * 12.5 * 0.62 + 14, fy, `+ ${parts} (${ghosts.length === 1 ? 'the ghost; not a cospan composite' : 'the ghosts; not cospan composites'})`, { 'font-size': 10.5, 'font-weight': 600, fill: nEvent ? theme.LINK_STYLE.event.color : theme.LINK_STYLE.guard.color });
    ctx.hover(sfx, { title: 'event and guard links in the composite', definition: 'The registry\'s composite (bundle.flatten) is the cospan composite plus these: Flatten fuses each event-linked pair of transitions into one (the composition of nets with boundaries, Bruni et al.) and lowers each guard link to a read arc across subnets (contextual, outside the free SMC). Neither glues places, so neither is a cospan composite.', cites: [C.model, C.event, C.guard, C.boundariesRow], bib: ['bruni-et-al'] });
    layers.top.append(sfx);
  }
  if (!glue.length) {
    layers.top.append(
      text(SIDE - 22, fy + 18, `No token or data links: as a cospan composite this is only the monoidal product ⊗ (disjoint union); no pushout.${nEvent ? ' The event links fuse transitions on top.' : ''}${nGuard ? ' Guard links add read arcs.' : ''}`, { 'font-size': 10.5, fill: theme.INK }),
      text(SIDE - 22, fy + 33, `cq/13 finds no token candidates among queue, pool and saga: their place schemas differ (queue:items, resource, account, saga:outcome). ${ctx.orders.extras.length ? 'A second instance is here: a token link to its same-schema twin glues two feet.' : 'Add a second instance to glue two feet.'}`, { 'font-size': 10.5, fill: theme.MUTED }),
    );
  } else {
    layers.top.append(
      text(SIDE - 22, fy + 18, '; is the cospan composite (the pushout along the glued foot: lk:token / lk:data). ⊗ is the monoidal product (disjoint union).', { 'font-size': 10.5, fill: theme.INK }),
      text(SIDE - 22, fy + 33, 'The glued place is named and marked as Flatten does it (bundle.flatten): wire:<smallest member>, initial markings summed (Flatten\'s choice: an open net carries no marking).', { 'font-size': 10.5, fill: theme.MUTED }),
    );
  }
  const ly = fy + 62;
  const lg = S('g', { class: 'cp-legend' });
  let lx = SIDE - 22;
  const item = (draw, label, info) => {
    const g = S('g', {}, draw(lx, ly), text(lx + 18, ly + 3.5, label, { 'font-size': 9.5, fill: theme.INK }));
    if (info) ctx.hover(g, info);
    lg.append(g);
    lx += 18 + tw(label, 9.5) + 20;
  };
  item((x, y) => S('circle', { cx: x + 6, cy: y, r: 5, fill: theme.schemaColor('queue:items'), stroke: '#fff', 'stroke-width': 1.5 }), 'foot point (X or Y), by schema', { title: 'foot point', definition: 'A boundary point of the cospan: a place port, colored by its schema (the wire type).', cites: [C.sides] });
  item((x, y) => S('line', { x1: x, y1: y, x2: x + 13, y2: y, stroke: LEG, 'stroke-dasharray': '4 3' }), 'leg', { title: 'leg', definition: 'The function from a foot to the places: each point maps to the place its port names.', bib: ['baez-master'] });
  item((x, y) => [S('circle', { cx: x + 6, cy: y, r: 5, fill: '#fff', stroke: theme.schemaColor('queue:items'), 'stroke-width': 1.8 }), S('circle', { cx: x + 6, cy: y, r: 1.6, fill: theme.schemaColor('queue:items') })], 'observe tap (top edge)', { title: 'observe tap', definition: 'An observe port: a side tap, in neither foot.', cites: [C.sides, C.depthPort] });
  item((x, y) => S('rect', { x: x + 1.5, y: y - 4.5, width: 9, height: 9, rx: 1, fill: NODE }), 'event port (bottom edge): not part of a cospan', { title: 'event port', definition: 'A transition port. Not a leg: event links compose these by fusion (nets with boundaries).', bib: ['bruni-et-al'], cites: [C.boundariesRow] });
  item((x, y) => [S('circle', { cx: x + 6, cy: y, r: 6, fill: '#fff', stroke: theme.schemaColor('account'), 'stroke-width': 1.8 }), S('path', { d: `M${x + 6},${y - 9} A9,9 0 0 0 ${x + 6},${y + 9}`, fill: 'none', stroke: theme.schemaColor('account'), 'stroke-width': 2.5 })], 'glued place (pushout); half-rings: the glued points', { title: 'glued place', definition: 'Two places identified by a token or data link: the pushout. The two half-rings are the two glued foot points.', cites: [C.pushout, C.placeClasses, C.wireName, C.smallest], bib: ['baez-master'] });
  layers.top.append(lg);
  const ly2 = ly + 22;
  let sx = SIDE - 22;
  layers.top.append(text(sx, ly2 + 3.5, 'Wire types (port schemas):', { 'font-size': 9.5, fill: theme.MUTED }));
  sx += tw('Wire types (port schemas):', 9.5) + 12;
  for (const sch of ['queue:items', 'resource', 'account', 'saga:outcome']) {
    const g = S('g', {}, S('circle', { cx: sx + 5, cy: ly2, r: 5, fill: theme.schemaColor(sch), stroke: '#fff', 'stroke-width': 1.5 }), text(sx + 14, ly2 + 3.5, sch, { 'font-size': 9.5, fill: theme.INK, class: 'cp-t cp-mono' }));
    ctx.hover(g, { title: `wire type ${sch}`, definition: 'A port schema. A token or data link between two ports that both carry one needs them to agree (E_SCHEMA_MISMATCH otherwise).', cites: [C.sides, C.schema, C.cq13] });
    layers.top.append(g);
    sx += 14 + tw(sch, 9.5) + 18;
  }
  layers.top.append(text(sx + 10, ly2 + 3.5, 'Numbers by each title: |X| → |S| ← |Y| (taps are in neither foot).', { 'font-size': 9.5, fill: theme.MUTED }));

  ctx.root.append(ctx.el('style', {}, STYLE), svg);

  if (!glue.length) {
    ctx.note(`Only lk:token and lk:data are cospan composites: a Baez–Master open net has places on its feet, and Flatten fuses the two places into one (its place classes; bundle.flatten). So as a cospan composite the instances are only ${compExpr}${nEvent ? '; the event links fuse transitions on top of that' : ''}. Among the three default instances cq/13 expects nothing to be glued: no token candidates (the place schemas differ). What lights up when you drag from a place port is the registry's answer (bundle.candidates), not this note's. ${ctx.orders.extras.length ? `A second instance is on the page (${ctx.orders.extras.join(', ')}): drag from one of its place ports to the same port of its twin (for example payment:account:customer to payment2:account:customer) to see the pushout.` : 'Add + payment2, + orders2 or + workers2 and drag between same-schema place ports to see the pushout.'} Event links fuse transitions (Bruni et al.) and guard links are contextual, outside the free SMC: both are drawn as ghosts.`, 'honesty');
  } else {
    ctx.note('The pushout is drawn where a token or data link glues two feet: the two instances meet at a seam and the two places become one, named and marked as Flatten does (bundle.flatten: wire:<smallest member>, initial markings summed). The composition keeps every port after linking, so the glued points stay draggable (the two half-rings). Event links (transition fusion, Bruni et al.) and guard links (contextual, outside the free SMC) are ghosts, not composites.', 'honesty');
  }

  // 10. Merge animations.
  const ev = ctx.event;
  if (!ev) return;
  if (ev.type === 'link-added' && (ev.link.kind === 'token' || ev.link.kind === 'data')) {
    const fp = byId[ev.link.from.subnet]?.ports.find((p) => p.id === ev.link.from.port);
    const P = fp && merged[`${ev.link.from.subnet}/${fp.place}`];
    const A = P && anim.Ps[P.name];
    if (!A) return;
    const dur = 820;
    // The two foot points slide together and meet on the seam.
    for (const h of A.handles[ev.link.index] || []) animate(h.g, [{ transform: `translate(${h.dx}px, ${h.dy}px)` }, { transform: 'translate(0px, 0px)' }], { duration: dur });
    // The two places fly to the seam and become one.
    for (const hm of P.homes) {
      const s = inst[hm.sid].s;
      const pl = s.places.find((p) => p.id === hm.pid);
      const ghost = S('g', {}, S('circle', { cx: hm.x, cy: hm.y, r: 8, fill: '#fff', stroke: placeStroke(s, hm.pid), 'stroke-width': 1.8 }), ...tokenDots(hm.x, hm.y, pl?.initial || 0));
      layers.fx.append(ghost);
      const a = animate(ghost, [{ transform: 'translate(0px, 0px)', opacity: 1 }, { transform: `translate(${P.x - hm.x}px, ${P.y - hm.y}px)`, opacity: 0.9, offset: 0.8 }, { transform: `translate(${P.x - hm.x}px, ${P.y - hm.y}px)`, opacity: 0 }], { duration: dur, fill: 'forwards' });
      if (a) a.onfinish = () => ghost.remove(); else ghost.remove();
    }
    animate(A.g, [{ transform: 'scale(0.2)', opacity: 0 }, { transform: 'scale(0.2)', opacity: 0, offset: 0.55 }, { transform: 'scale(1.3)', opacity: 1, offset: 0.82 }, { transform: 'scale(1)', opacity: 1 }], { duration: dur + 80 });
    for (const lb of A.labels || []) animate(lb, [{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: dur + 80 });
    for (const f of A.fade || []) animate(f, [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: dur + 80 });
  } else if (ev.type === 'link-added') {
    const G = anim.ghosts[ev.link.index];
    if (G) {
      animate(G.g, [{ opacity: 0 }, { opacity: 1 }], { duration: 700 });
      animate(G.glyph, [{ transform: 'scale(0)' }, { transform: 'scale(1.7)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 780 });
    }
    for (const end of [ev.link.from, ev.link.to]) {
      const p = anim.ports[`${end.subnet}|${end.port}|bottom`];
      if (p && p.g) { p.g.classList.add('cp-anim'); animate(p.g, [{ transform: 'scale(1)' }, { transform: 'scale(1.9)', offset: 0.4 }, { transform: 'scale(1)' }], { duration: 720 }); }
    }
  } else if (ev.type === 'instance-added' && anim.frames[ev.id]) {
    animate(anim.frames[ev.id], [{ opacity: 0, transform: 'translate(0px, 14px)' }, { opacity: 1, transform: 'translate(0px, 0px)' }], { duration: 650 });
  }
}

// --- connect-4 ---------------------------------------------------------------------------

function pieceLabel(entry) {
  if (typeof entry === 'string') return { name: entry, text: entry };
  const [name, args] = Object.entries(entry)[0];
  return { name, text: `${name} ${args && args.nodes !== undefined ? `nodes ${args.nodes}` : JSON.stringify(args)}` };
}

function renderConnect4(ctx) {
  const { S, text } = mk(ctx);
  const theme = ctx.theme;
  const net = ctx.connect4.net, sum = ctx.connect4.summary;
  ctx.note('Does not apply as drawn: a SearchPlan is not an open net. It composes searches by chaining order pieces, wrapping drivers around the search and filling slots, and there is no place on its boundary to glue. The nearest honest picture is the operad view (tab 3). The plan runs over this closed net (SearchPlan::solver takes the game), it does not compose with it: below, the net is drawn as ∅ → N ← ∅ with the plan beside it.', 'na');
  ctx.emit('note', 'closed', {});
  if (!net) { ctx.note('assets/connect-4.json did not load.', 'warn'); return; }
  const W = W0, H = 800;
  const svg = ctx.svgRoot(W, H, { class: 'view-svg cospan-svg', role: 'img', 'aria-label': 'The Connect-4 net as a closed net, empty feet on both sides' });
  svg.append(S('rect', { x: 0, y: 0, width: W, height: H, fill: PAPER }));
  svg.append(
    text(18, 20, 'Connect-4 as an open net: the closed net ∅ → N ← ∅ (both feet empty), the net a search plan runs over.', { 'font-size': 12.5, fill: theme.INK, 'font-weight': 600, class: '' }),
    text(18, 37, 'Any Petri net is an open net with both feet empty. Nothing on its boundary can be glued: no place is exposed. Places as dots, transitions as squares, at the fixture\'s own x/y.', { 'font-size': 10.5, fill: theme.MUTED, class: '' }),
  );
  const fx = 140, fy = 92, fw = 870, fh = 452;
  const frame = S('rect', { x: fx, y: fy, width: fw, height: fh, rx: 10, fill: '#f4f6f8', stroke: '#c5ccd5', 'stroke-width': 1.2 });
  ctx.emit('net', 'connect-4', { places: sum.places, transitions: sum.transitions });
  ctx.hover(frame, {
    title: `N: ${sum.name}, a closed net`,
    concept: { iri: NS + 'PetriNet', types: ['ns:PetriNet'] },
    definition: sum.description,
    facts: [['places', sum.places], ['transitions', sum.transitions], ['arcs', sum.arcs], ['drops (_play_)', sum.drops], ['other transitions (win detectors)', sum.other], ['as an open net', '∅ → N ← ∅: both feet empty']],
    cites: [C.fixture, C.game],
    bib: ['baez-master'],
  });
  svg.append(frame);
  svg.append(
    text(fx, fy - 12, `N: ${sum.name}`, { 'font-size': 12.5, 'font-weight': 700, fill: theme.INK, style: `--halo: ${PAPER}` }),
    text(fx + fw, fy - 12, `0 → ${sum.places} ← 0   ·   ${sum.places} places · ${sum.transitions} transitions · ${sum.arcs} arcs`, { 'font-size': 9.5, fill: theme.MUTED, 'text-anchor': 'end', class: 'cp-t cp-mono', style: `--halo: ${PAPER}` }),
  );
  // Empty feet.
  for (const [side, cx] of [['X', fx - 30], ['Y', fx + fw + 30]]) {
    const g = S('g', {},
      S('line', { x1: cx, y1: fy + 16, x2: cx, y2: fy + fh - 16, stroke: '#b9c0c8', 'stroke-width': 1, 'stroke-dasharray': '1.5 3' }),
      text(cx, fy + 2, side, { 'font-size': 12, 'font-style': 'italic', 'font-family': 'Georgia, serif', 'text-anchor': 'middle', fill: theme.INK, style: `--halo: ${PAPER}` }),
      S('circle', { cx, cy: fy + fh / 2, r: 13, fill: PAPER, stroke: '#c5ccd5' }),
      S('text', { x: cx, y: fy + fh / 2 + 5, 'text-anchor': 'middle', 'font-size': 15, fill: '#7a828c' }, '∅'));
    ctx.hover(g, { title: `${side === 'X' ? 'left' : 'right'} foot: ∅`, definition: 'The fixture declares no ports: every place is interior, so this foot is the empty set.', note: 'A closed net is an open net with empty feet, ∅ → N ← ∅. Gluing along ∅ is only the disjoint union: there is nothing to identify.', cites: [C.fixture, C.cospanRow], bib: ['baez-master'] });
    svg.append(g);
  }
  // Miniature at the fixture's own coordinates.
  const P = net.places, T = net.transitions;
  const all = [...Object.values(P), ...Object.values(T)];
  const minX = Math.min(...all.map((n) => n.x)), maxX = Math.max(...all.map((n) => n.x));
  const minY = Math.min(...all.map((n) => n.y)), maxY = Math.max(...all.map((n) => n.y));
  const padT = 44, padB = 44, padX = 30;
  const s = Math.min((fw - 2 * padX) / (maxX - minX), (fh - padT - padB) / (maxY - minY));
  const ox = fx + (fw - (maxX - minX) * s) / 2, oy = fy + padT;
  const X = (x) => ox + (x - minX) * s, Y = (y) => oy + (y - minY) * s;
  const arcsG = S('g', { class: 'cp-c4-arcs' });
  const pos = (id) => P[id] || T[id];
  for (const a of net.arcs) {
    const f = pos(a.source), t = pos(a.target);
    if (!f || !t) continue;
    arcsG.append(S('line', { x1: X(f.x), y1: Y(f.y), x2: X(t.x), y2: Y(t.y) }));
  }
  arcsG.setAttribute('stroke', '#5b6470'); arcsG.setAttribute('stroke-width', '0.5'); arcsG.setAttribute('opacity', '0.1');
  const inh = net.arcs.filter((a) => a.inhibitTransition).length;
  svg.append(arcsG);
  ctx.hover(arcsG, { title: `${sum.arcs} arcs`, concept: { iri: NS + 'Arc', types: ['ns:Arc'] }, facts: [['arcs', sum.arcs], ['inhibitor arcs', inh]], note: 'Drawn faint, as a texture: every arc of the fixture, between its own coordinates.', cites: [C.fixture, C.arcs] });
  const arcCount = {};
  for (const a of net.arcs) { arcCount[a.source] = (arcCount[a.source] || 0) + 1; arcCount[a.target] = (arcCount[a.target] || 0) + 1; }
  const nodesG = S('g', {});
  for (const [id, t] of Object.entries(T)) {
    const g = S('rect', { x: X(t.x) - 2, y: Y(t.y) - 2, width: 4, height: 4, fill: /_play_/.test(id) ? NODE : '#7f5aa8' });
    ctx.hover(g, { title: `transition ${id}`, concept: { iri: NS + 'Transition', types: ['ns:Transition'] }, facts: [['kind', /_play_/.test(id) ? 'a drop (a move)' : 'a win detector: automatic in pflow-rs\'s test game (fires as soon as it is enabled)'], ['arcs', arcCount[id] || 0], ['fixture x, y', `${t.x}, ${t.y}`]], cites: [C.fixture, ...(/_play_/.test(id) ? [] : [C.autoWin])] });
    nodesG.append(g);
  }
  for (const [id, p] of Object.entries(P)) {
    const init = (p.initial && p.initial[0]) || 0;
    const g = S('circle', { cx: X(p.x), cy: Y(p.y), r: 2.7, fill: init > 0 ? theme.INK : '#fff', stroke: '#4a525c', 'stroke-width': 0.8 });
    ctx.hover(g, { title: `place ${id}`, concept: { iri: NS + 'Place', types: ['ns:Place'] }, facts: [['initial', init], ['arcs', arcCount[id] || 0], ['fixture x, y', `${p.x}, ${p.y}`], ['on a foot', 'no: the net is closed']], cites: [C.fixture] });
    nodesG.append(g);
  }
  svg.append(nodesG);
  // Group labels, by the fixture's own names.
  const groups = [
    { label: 'open_c_r (42)', test: (k) => /^open_\d/.test(k), coll: P },
    { label: 'x_c_r (42)', test: (k) => /^x_\d/.test(k), coll: P },
    { label: 'o_c_r (42)', test: (k) => /^o_\d/.test(k), coll: P },
  ];
  for (const gr of groups) {
    const ns = Object.entries(gr.coll).filter(([k]) => gr.test(k)).map(([, v]) => v);
    if (!ns.length) continue;
    const cx = (X(Math.min(...ns.map((n) => n.x))) + X(Math.max(...ns.map((n) => n.x)))) / 2;
    svg.append(text(cx, Y(Math.min(...ns.map((n) => n.y))) - 9, `${gr.label.split(' ')[0]} · ${ns.length} places`, { 'text-anchor': 'middle', 'font-size': 8.5, fill: theme.MUTED, style: '--halo: #f4f6f8' }));
  }
  for (const id of ['x_turn', 'o_turn', 'game_active', 'win_x', 'win_o']) if (P[id]) svg.append(text(X(P[id].x), Y(P[id].y) - 7, id, { 'text-anchor': 'middle', 'font-size': 8, fill: theme.INK, style: '--halo: #f4f6f8' }));
  const plays = Object.entries(T).filter(([k]) => /_play_/.test(k)).map(([, v]) => v);
  if (plays.length) svg.append(text(X(Math.max(...plays.map((n) => n.x))), Y(Math.min(...plays.map((n) => n.y))) - 9, `x_play_c_r, o_play_c_r: ${plays.length} drops (moves)`, { 'font-size': 8.5, fill: theme.MUTED, style: '--halo: #f4f6f8', 'text-anchor': 'end' }));
  const wins = Object.entries(T).filter(([k]) => !/_play_/.test(k));
  const winKinds = {};
  for (const [k, v] of wins) { const m = k.match(/_win_([a-z0-9]+)_/); const kk = m ? m[1] : 'other'; (winKinds[kk] ||= []).push(v); }
  for (const [kk, vs] of Object.entries(winKinds)) {
    const cx = (X(Math.min(...vs.map((n) => n.x))) + X(Math.max(...vs.map((n) => n.x)))) / 2;
    svg.append(text(cx, Y(Math.max(...vs.map((n) => n.y))) + 14, `win_${kk} (${vs.length})`, { 'text-anchor': 'middle', 'font-size': 8.5, fill: theme.MUTED, style: '--halo: #f4f6f8' }));
  }
  svg.append(text(fx + fw / 2, fy + fh - 9, `x_win_*, o_win_*: ${wins.length} win detectors (the fixture: catalytic, consuming the opponent's turn token and game_active)`, { 'text-anchor': 'middle', 'font-size': 8.5, fill: theme.MUTED, style: '--halo: #f4f6f8' }));

  // The plan, beside the net: it runs over N.
  const plan = ctx.plan.plan;
  const py = 598, ph = 112, px0 = 40, pw = W - 80;
  const ax = fx + fw / 2;
  svg.append(
    S('line', { x1: ax, y1: py - 4, x2: ax, y2: fy + fh + 6, stroke: '#2f6fb3', 'stroke-width': 1.4, 'stroke-dasharray': '5 4', 'marker-end': 'url(#cp-arr-plan)' }),
    S('defs', {}, S('marker', { id: 'cp-arr-plan', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto', markerUnits: 'userSpaceOnUse' }, S('path', { d: 'M0,0.6 L8,4 L0,7.4 z', fill: '#2f6fb3' }))),
    text(ax + 10, fy + fh + 30, 'runs over N: SearchPlan::solver(&Game) builds a solver for a game on this net. Not glued to it: the plan has no places.', { 'font-size': 9.5, fill: '#2f6fb3', 'font-weight': 600, style: `--halo: ${PAPER}` }),
  );
  const isExample = JSON.stringify(ctx.plan.json) === JSON.stringify(toJSON(CONNECT4_EXACT));
  const box = S('rect', { x: px0, y: py, width: pw, height: ph, rx: 9, fill: '#fff', stroke: '#9fb6d3', 'stroke-width': 1.2 });
  ctx.hover(box, { title: 'the search plan', definition: 'A SearchPlan: the pieces of the game search, picked by name. Its slots are filled by pieces; pflow-rs\'s check decides what fits (plan.slot_candidates, through the registry). It composes by chaining, wrapping and filling, which is the operad view\'s subject.', facts: [['plan JSON', JSON.stringify(ctx.plan.json)], ['is plan:connect4-exact', isExample ? 'yes (the plan.rs module-doc example)' : 'no: changed on this page'], ['check', ctx.plan.error ? `refused: ${ctx.plan.error}` : `passes (pflow-rs @${PLAN_RS_REV} SearchPlan::check and solver, by plan.state)`]], note: 'The laws named in the caption (a partial monoid of order pieces, drivers composed around the core) are the ontology ROADMAP\'s reading of plan.rs, not a theorem checked here.', cites: [C.solver, ctx.plan.exampleCite, C.laws] });
  svg.append(box, text(px0 + 12, py + 17, `Solver for ${isExample ? 'plan:connect4-exact' : 'a changed plan (not plan:connect4-exact)'}${ctx.plan.error ? ' (refused)' : ''} · mode: ${plan.mode || 'exact'}`, { 'font-size': 10.5, 'font-weight': 700, fill: theme.INK, style: '--halo: #fff' }),
    text(px0 + pw - 12, py + 17, 'drag a piece from the toolbar into a slot', { 'font-size': 9, fill: theme.MUTED, 'text-anchor': 'end', style: '--halo: #fff' }));
  // Slots.
  const slotEntries = (slot) => {
    if (slot.designed) return null;
    const v = plan[slot.field];
    if (slot.field === 'memo') return v ? [{ name: 'memo', text: `memo entries ${v.entries}` }] : [];
    if (v === undefined) {
      // An absent list stands for pflow-rs's default (read from the registry: model.js PLAN_DEFAULTS).
      const d = fieldOrDefault(plan, slot.field);
      return d.length ? `default: ${d.map((x) => pieceLabel(x).text).join(', ')}` : [];
    }
    return v.map(pieceLabel);
  };
  const chipW = (t) => String(t).length * 9 * 0.62 + 14; // monospace
  const cells = ctx.plan.slots.map((slot) => {
    const e = slotEntries(slot);
    const content = e === null ? 'not built' : typeof e === 'string' ? e : e.length ? null : slot.field === 'order' ? '[] (identity)' : 'empty';
    const nwOff = slot.field === 'drivers' && Array.isArray(plan.drivers) && !plan.drivers.includes('null_window');
    const label = nwOff ? `${slot.label} · null_window off` : slot.label;
    const w = Math.max(tw(label, 8.5) + 18, content ? String(content).length * 8.5 * 0.6 + 20 : e.reduce((a, c) => a + chipW(c.text) + 5, 11));
    return { slot, e, content, w, label };
  });
  const totalW = cells.reduce((a, c) => a + c.w, 0) + 8 * (cells.length - 1);
  // Never wider than the strip: shrink the row of slots uniformly if it would be.
  const fit = Math.min(1, (pw - 24) / totalW);
  const slotsG = S('g', { transform: fit < 1 ? `translate(${px0 + pw / 2},${py + 28}) scale(${fit}) translate(${-(px0 + pw / 2)},${-(py + 28)})` : null });
  svg.append(slotsG);
  let cx = px0 + (pw - totalW) / 2;
  const cy = py + 28, chh = 56;
  const ev = ctx.event;
  for (const c of cells) {
    const g = S('g', { class: 'cp-slot' });
    g.append(S('rect', { x: cx, y: cy, width: c.w, height: chh, rx: 6, fill: c.slot.designed ? '#f6f7f9' : '#f3f7fc', stroke: c.slot.designed ? '#c9cfd6' : '#9fb6d3', 'stroke-width': 1.2, 'stroke-dasharray': c.slot.designed ? '4 3' : null, class: 'cp-slot-box' }),
      text(cx + 8, cy + 13, c.label, { 'font-size': 8.5, fill: theme.MUTED, 'font-weight': 600, style: '--halo: #f3f7fc' }));
    ctx.snap.slot(g, c.slot.id);
    ctx.hover(g, ctx.info.slotInfo(c.slot.id));
    slotsG.append(g);
    if (c.content) slotsG.append(text(cx + 8, cy + 36, c.content, { 'font-size': 8.5, fill: '#8a929c', 'font-style': 'italic', style: '--halo: #f3f7fc' }));
    else {
      let qx = cx + 6;
      c.e.forEach((entry, i) => {
        const piece = ctx.plan.pieceByName[entry.name];
        const col = theme.PIECE_KIND_COLOR[piece?.kind] || '#555';
        const w = chipW(entry.text);
        const chip = S('g', { class: 'cp-chip' }, S('rect', { x: qx, y: cy + 24, width: w, height: 20, rx: 4, fill: '#fff', stroke: col, 'stroke-width': 1.4 }), S('text', { x: qx + w / 2, y: cy + 37.5, 'text-anchor': 'middle', 'font-size': 9, fill: col, class: 'cp-mono' }, entry.text));
        ctx.hover(chip, ctx.info.pieceInfo(entry.name));
        slotsG.append(chip);
        const isNew = ev && ev.type === 'piece-added' && ev.slot === c.slot.id && ev.name === entry.name && (c.slot.field === 'memo' || i === c.e.length - 1);
        if (isNew) animate(chip, [{ transform: 'translate(0px, -46px)', opacity: 0 }, { transform: 'translate(0px, 4px)', opacity: 1, offset: 0.75 }, { transform: 'translate(0px, 0px)', opacity: 1 }], { duration: 780 });
        qx += w + 5;
      });
    }
    c.x = cx;
    cx += c.w + 8;
  }
  svg.append(text(px0 + 12, py + ph - 9, 'Slots take pieces by kind: the order chain is a partial monoid under chaining, drivers wrap the search, the memo fills one slot (ROADMAP). Bounds and engine are designed, not built.', { 'font-size': 8.5, fill: theme.MUTED, style: '--halo: #fff' }));

  // Footer.
  const fy2 = H - 52;
  svg.append(
    text(18, fy2, 'Composite: none. N is closed (∅ → N ← ∅), and a plan is not a net, so there is no pushout to draw here.', { 'font-size': 11.5, 'font-weight': 700, fill: theme.INK, style: `--halo: ${PAPER}` }),
    text(18, fy2 + 17, 'The orders example has open nets; switch to it to see feet, legs and (with a second instance) a pushout. The plan\'s own composition is the operad view (tab 3).', { 'font-size': 10, fill: theme.MUTED, style: `--halo: ${PAPER}` }),
  );
  ctx.root.append(ctx.el('style', {}, STYLE), svg);
}

// --- the view ----------------------------------------------------------------------------

export default {
  id: 'cospan',
  title: 'Open Petri nets as cospans',
  short: 'Cospans',
  consumes: ['assets/connect-4.json', 'bundle.flatten', 'bundle.state', 'plan.open', 'plan.state'],
  convention: {
    summary: 'Baez and Master: an open Petri net is a cospan X → S ← Y of finite sets into its set of places S. The feet X (left) and Y (right) are columns of boundary points; the legs (grey dashed) send each point to the place it names. Two open nets compose by gluing the right foot of one to the left foot of the next: a pushout along boundary places, so the glued places become one place. In go-pflow that is exactly lk:token and lk:data (Flatten fuses the two places into one wire: place). Instances that are not glued sit side by side: the monoidal product ⊗, a disjoint union.',
    examples: {
      orders: 'Each instance (orders: Queue, workers: ResourcePool, payment: Saga) is drawn with its real places (initial marking as dots), transitions and arcs. in ports are on the left foot, out ports on the right, inout ports on both, the queue\'s depth (observe) as a dotted tap on top. Transition ports sit on the bottom edge, outside the cospan. With the default links the cospan composite is only orders ⊗ workers ⊗ payment; the three event idioms fuse transitions on top of it (go-pflow\'s composite is not a disjoint union) and are drawn as ghosts. Add a second instance and token-link two same-schema place ports to see the pushout: the instances meet at a seam and the two places become one, named as Flatten names it.',
      connect4: 'Does not apply: a search plan is not an open net. The Connect-4 game net is drawn as the closed net ∅ → N ← ∅ (no ports, so both feet are empty), as a miniature at the fixture\'s own coordinates, with the plan beside it as a strip of slots. The plan runs over N (SearchPlan::solver takes the game); it does not compose with it. The plan\'s composition is the operad view.',
    },
    honesty: [
      'Only lk:token and lk:data are drawn as cospan composites (pushouts). Event links are transition fusion (Bruni et al., nets with boundaries) and are drawn as faint ghosts; guard links are contextual, outside the free SMC, flagged and drawn as ghosts too.',
      'The glued place\'s name and marking are Flatten\'s (bundle.flatten: pflow-compose, the Rust port of go-pflow\'s FlattenWithMap; wire:<smallest member>, initial markings summed), not this view\'s.',
      'A Baez–Master open net has places, transitions and arcs with multiplicities, and no capacities or markings. go-pflow places carry both (the queue\'s and the pool\'s places are bounded). The cospan reading covers the structure only: summing the markings and keeping the tighter capacity of a glued pair are Flatten\'s choices (compose_flatten.go:291-292), not part of the pushout.',
      'go-pflow keeps every port after a link, and a link may glue any compatible pair of ports, not only a whole foot onto a whole foot as in Baez–Master. The view draws each link as one glued pair of points; the unglued points stay on the composite\'s feet.',
      'Observe ports are drawn as taps in neither foot (the ROADMAP\'s reading). validateLink (go-pflow\'s rule; the registry runs pflow-compose\'s port of it) checks only in/out for a token link, so a token link through an observe port is allowed; the view draws it and says so.',
      'Layout is this view\'s: the positions of places and transitions inside a frame, and which instance goes left of which in a glued pair (the first link\'s from side), are drawing choices.',
      'Connect-4: no cospan applies to the plan. The closed net and the "runs over" arrow are the honest nearest picture.',
    ],
    bib: BIB_ORDERS,
    cites: [C.cospanRow, C.boundariesRow, C.model, C.placeClasses, C.wireName, C.smallest, C.initialSum, C.direction, C.schema, C.cq13, C.linkStyle, C.solver, C.fixture, C.autoWin, C.laws],
  },
  render(ctx) {
    if (ctx.example === 'connect4') renderConnect4(ctx);
    else renderOrders(ctx);
  },
};
