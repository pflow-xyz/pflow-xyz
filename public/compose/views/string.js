// VIEW 4: string diagrams, in the visual conventions of pflow-xyz
// public/diagram-viewer.js (this repo's own module, imported unmodified).
//
// Two levels, switched by the toggle above the drawing:
//  - pattern level: this view's own drawing. Orders: pattern instances are
//    boxes side by side (⊗), place ports are typed wires (in/inout on the top
//    edge, out/inout on the bottom, observe as a side tap), transition ports are
//    squares on the left (in) and right (out) edges, and the links are exactly
//    ctx.orders.links. Connect-4: the ROADMAP Slice B picture of the plan, the
//    alpha-beta core with the order chain on its parameter wire, the memo as a
//    side wire and the drivers as nested frames, every piece from ctx.plan.
//  - transition level: diagram-viewer.js's own translatePetriNet + generateSVG,
//    run unmodified on the flat orders net or on the Connect-4 net.
//
// Layout is deterministic. The only module state is the toggle, the last box
// positions (to animate a merge from where things were) and a cache of the
// Connect-4 layout, none of which changes what a state draws.

import { translatePetriNet, generateSVG } from '../../diagram-viewer.js';
import { cite } from '../sources.js';
import { NS, LINK_STYLE_CITE } from '../model.js';
import { SEARCH_CITES, PLAN_LAWS_CITE, chainOf, driversOf, fieldOrDefault, PLAN_DEFAULTS, PLAN_RS_REV } from '../model.js';
import { FLATTEN_CITES } from '../model.js';

// --- sources ------------------------------------------------------------------------

const dv = (from, to, note) => cite('pflowXyz', 'public/diagram-viewer.js', from, to, note);
const rs = (path, from, to, note) => cite('pflowRs', `crates/pflow-metamodel/src/${path}`, from, to, note);
const road = (from, to, note) => cite('ontologyRoadmap', 'ROADMAP.md', from, to, note);
const ttl = (from, to, note) => cite('ontology', 'ns/patterns.ttl', from, to, note);
const goc = (path, from, to, note) => cite('goPflow', path, from, to, note);

const DVC = {
  header: dv(1, 5, 'transitions → boxes (morphisms), places → wire types (objects), arcs → typed ports and wires'),
  consts: dv(8, 16, 'BOX_HEIGHT 40, PORT_RADIUS 4, LABEL_FONT_SIZE 10'),
  boxes: dv(20, 60, 'buildBoxes: an arc P→T is an input port, T→P an output port; nothing else'),
  cycles: dv(108, 128, 'DFS cycle breaking: the back edges'),
  layers: dv(130, 169, 'longest-path layering'),
  sides: dv(279, 303, 'outputs on the bottom of a box, inputs on top'),
  markers: dv(433, 436, 'arrowhead markers, #666 and #c44'),
  paper: dv(438, 439, 'background #fafafa'),
  boundaryIn: dv(441, 468, 'boundary inputs enter from the top'),
  wires: dv(470, 481, 'wires: #888, 1.5px, vertical cubics; 10px #666 label at the midpoint'),
  inhibit: dv(474, 475, 'inhibitor wires dashed #c44'),
  back: dv(490, 501, 'back edges: dashed #c44 (6,3), routed around the right side, arrowhead'),
  box: dv(503, 526, 'boxes: rx 6, white, #333 1.5; port dots r 4 #666; inhibitor ports hollow #c44'),
  boundaryOut: dv(528, 543, 'boundary outputs exit at the bottom'),
};
const FIXTURE = cite('pflowRs', 'crates/pflow-metamodel/tests/fixtures/connect-4.json', null, null, 'the Connect-4 net (assets/connect-4.json is byte-identical)');
const ROAD = {
  survey: road(396, 396, 'string diagrams in an SMC: boxes are morphisms, wires are objects, ⊗ side by side, ∘ stacking'),
  reading: road(405, 413, 'what the categorical reading is: ⊗ exact for unlinked subnets; token = pushout; event = fusion; guard outside the free SMC'),
  wires: road(415, 416, 'wire types are port schemas; direction gives dom/cod; observe = side tap; inout on both sides'),
  search: road(418, 430, 'search composition: orderer monoid, drivers around the core, Solver = drivers ∘ core[…], core Position → Value⊥'),
  sliceB: road(476, 482, 'Slice B: diagram-viewer.js conventions; event fusion drawn with RenderDOT\'s ⊗; the two artefacts'),
  noBound: road(307, 307, 'no Bound kind, no engine choice in plan.rs'),
  orders41: road(240, 242, '4.1: the pool-leak caveat shows up on the rollback path, the expected result'),
  worked: road(276, 278, 'worked expectation: the rollback scenario fails, the worker never returns'),
};
// game.rs / order.rs ranges checked line by line at c396d46 (used instead of the
// model's SEARCH_CITES where those are a few lines off: solve ends at 588, search
// at 693, the tt.get block at 611, and Chain is at order.rs:195-272).
const GR = {
  value: rs('game.rs', 526, 554, 'Solver::value: nodes reset, then solve (by bits, or again by counts)'),
  solve: rs('game.rs', 556, 588, 'Solver::solve: yes/no searches, one per gap between adjacent rewards'),
  search: rs('game.rs', 590, 693, 'Solver::search: fail-soft alpha-beta with the transposition table'),
  ttRead: rs('game.rs', 601, 611, 'tt.get: an exact entry or a bound outside the window returns; else the window narrows'),
  chain: rs('order.rs', 249, 265, 'Chain::key and before: keys compared piece by piece, the first to differ decides'),
  decisive: rs('order.rs', 26, 31, 'DECISIVE: a nonzero key settles the rank, a top tier of its own'),
};

// diagram-viewer.js's visual constants (lines 8-16, 433-526), used for this view's own drawing.
const DV = { BOX_H: 40, RX: 6, STROKE: '#333', SW: 1.5, PORT_R: 4, PORT: '#666', WIRE: '#888', LABEL: 10, LABEL_FILL: '#666', BACK: '#c44', BACK_DASH: '6,3', PAPER: '#fafafa' };

// --- module state ---------------------------------------------------------------------

let level = 'pattern';
try {
  // A deep link (#view=string&ex=orders&level=transition) is read once, before the shell rewrites the hash.
  const h = new URLSearchParams(location.hash.slice(1)).get('level');
  if (h === 'pattern' || h === 'transition') level = h;
  else { const s = localStorage.getItem('pv-string-level'); if (s === 'pattern' || s === 'transition') level = s; }
} catch { /* storage blocked: default */ }
const memory = {}; // last drawn positions, for merge animations only
let c4 = null; // Connect-4 transition-level cache (diagram-viewer.js output, timings, lens)
let lensDrag = false;
if (typeof window !== 'undefined') window.addEventListener('pointerup', () => { lensDrag = false; });

// --- small helpers --------------------------------------------------------------------

const sum = (xs) => xs.reduce((a, x) => a + x, 0);
const max0 = (xs) => (xs.length ? Math.max(...xs) : 0);
const splitId = (id) => { const i = id.indexOf(':'); return i > 0 ? [id.slice(0, i + 1), id.slice(i + 1)] : [null, id]; };
const NORM = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };
const fmt = (n) => Number(n).toLocaleString('en-US');

function anim(el, frames, opts) {
  try { return el && el.animate ? el.animate(frames, opts) : null; } catch { return null; }
}

function wrap(tw, text, maxW, size) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && tw(t, size) > maxW) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** A path through axis-aligned points with rounded corners. */
function ortho(points, r = 10) {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 0.01);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0), l2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x1 - ((x1 - x0) / l1) * rr, ay = y1 - ((y1 - y0) / l1) * rr;
    const bx = x1 + ((x2 - x1) / l2) * rr, by = y1 + ((y2 - y1) / l2) * rr;
    d += ` L${ax},${ay} Q${x1},${y1} ${bx},${by}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

function cubicBetween(P, Q, kmin = 40) {
  const dist = Math.hypot(Q.x - P.x, Q.y - P.y);
  const k = Math.max(kmin, Math.min(150, dist / 2.2));
  const [ax, ay] = NORM[P.side], [bx, by] = NORM[Q.side];
  return [[P.x, P.y], [P.x + ax * k, P.y + ay * k], [Q.x + bx * k, Q.y + by * k], [Q.x, Q.y]];
}
const cubicD = (c) => `M${c[0][0]},${c[0][1]} C${c[1][0]},${c[1][1]} ${c[2][0]},${c[2][1]} ${c[3][0]},${c[3][1]}`;
function bez(c, t) {
  const u = 1 - t;
  const f = (i) => u * u * u * c[0][i] + 3 * u * u * t * c[1][i] + 3 * u * t * t * c[2][i] + t * t * t * c[3][i];
  return [f(0), f(1)];
}

const CSS = `
.sv-toggle { display: flex; align-items: center; gap: 0; margin: 0 0 8px; font-size: 12px; flex-wrap: wrap; }
.sv-toggle button { font: inherit; border: 1px solid #cfd4da; background: #fff; color: #2b2f36; padding: 4px 11px; cursor: pointer; }
.sv-toggle button:first-of-type { border-radius: 6px 0 0 6px; }
.sv-toggle button:nth-of-type(2) { border-radius: 0 6px 6px 0; border-left: 0; }
.sv-toggle button.on { background: #2b2f36; color: #fff; border-color: #2b2f36; }
.sv-toggle .sv-hint { margin-left: 12px; color: #6a717c; }
svg.sv { font-family: ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; width: 100%; height: auto; }
svg.sv .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
svg.sv text { pointer-events: none; }
svg.sv .sv-hit, svg.sv .sv-hitline { pointer-events: all; }
svg.sv .sv-body.inspectable:hover > rect.sv-rect { stroke: #000; stroke-width: 2; }
svg.sv .sv-link.inspectable:hover .sv-stroke { stroke-width: 3.2; }
svg.sv .sv-wire.inspectable:hover .sv-stroke { stroke: #555; stroke-width: 2.2; }
svg.sv .sv-back.inspectable:hover .sv-stroke { stroke-width: 2.4; }
svg.sv .sv-pop, svg.sv .sv-pulse { transform-box: fill-box; transform-origin: center; }
svg.sv .sv-x { cursor: pointer; pointer-events: all; }
svg.sv .sv-x:hover text { fill: #c0392b; }
svg.sv .sv-x text { pointer-events: none; }
svg.sv .snap-slot.sv-slotbox { cursor: copy; }
svg.sv .sv-ov { cursor: crosshair; }
svg.sv .sv-lens-rect { pointer-events: none; }
`;

// --- the view ---------------------------------------------------------------------------

export default {
  id: 'string',
  title: 'String diagram',
  short: 'String',
  convention: {
    summary: 'String diagrams in a symmetric monoidal category: boxes are morphisms, wires are objects, side by side is the tensor ⊗ and stacking (top to bottom) is composition ∘. Drawn in the conventions of pflow-xyz diagram-viewer.js: flow runs top to bottom, inputs sit on a box\'s top edge and outputs on its bottom, wires are grey cubics labelled by their type, back edges are dashed red and go round the right side. The toggle switches between the pattern level (this view\'s drawing of the instances and their links) and the transition level (the flat net, drawn by diagram-viewer.js itself, unmodified).',
    examples: {
      orders: 'Pattern level: orders (Queue), workers (ResourcePool) and payment (Saga) side by side (⊗). Place ports are wires typed by their schema (in and inout on top, out and inout below, observe as a tap on the right edge); transition ports are squares on the left (in) and right (out) edges. The three event idioms are green connectors with RenderDOT\'s ⊗ glyph, and the pool-leak caveat is the red note on release ⊗ commit. Transition level: Flatten\'s net (the registry\'s bundle.flatten) through diagram-viewer.js, where each fused transition is one box.',
      connect4: 'Pattern level (ROADMAP Slice B): the alpha-beta core Position → Value⊥, the order chain as MoveList → MoveList boxes on its parameter wire, the memo as a side wire (Table), and the drivers as nested frames budget ⊃ null_window. Back edges, each read from game.rs: the null-window loop, the recursion, the transposition-table feedback and cutoff → history. Transition level: the Connect-4 net through diagram-viewer.js, which is too large to read on one stage, so it is shown as a scaled overview with a 1:1 lens.',
    },
    honesty: [
      'Reading a pattern instance as a box dom → cod is the ROADMAP Phase 6 proposal (wire types are port schemas, port direction gives the domain and codomain). It is not a theorem: an inout port is in both, and an observe port is a tap outside both.',
      'Only the unlinked product is exactly ⊗ (disjoint union). A token link is a pushout along the shared place (Baez–Master), drawn as a wire from an out port into an in port. An event link is transition fusion (Bruni et al.), drawn as a connector between transition ports, not as a wire. The green ⊗ is RenderDOT\'s event glyph, not the tensor.',
      'Guard links are outside the free-SMC fragment. They are drawn dashed with ⊘ and flagged, and no functorial meaning is claimed for them.',
      'Putting transition ports on the left (in) and right (out) edges is this view\'s choice, after the left and right boundaries of nets with boundaries. diagram-viewer.js has no transition ports, and this view\'s pattern-level boxes are taller than its BOX_HEIGHT 40 so they can hold the ports.',
      'Connect-4: the core box, the chain as MoveList → MoveList boxes, the drivers as frames and the memo as a side wire are the ROADMAP design. In code the chain is one comparator over a key per piece (order.rs:249-265), and the drivers are flags (plan.rs:146-194). The nesting budget(null_window(core)) is fixed by game.rs, whatever order the JSON lists them in.',
      'A back edge is feedback, which a symmetric monoidal category does not have on its own (it needs a trace). Each one is drawn because game.rs does it, and each is cited to its lines.',
      'Transition level: the drawing is diagram-viewer.js\'s output. Read arcs (lowered guard links) have no counterpart there and are left out, and the port squares on top of its boxes are this view\'s addition.',
    ],
    bib: ['selinger', 'joyal-street', 'baez-master', 'bruni-et-al'],
    cites: [
      DVC.header, DVC.sides, DVC.wires, DVC.back, DVC.box, DVC.paper, DVC.consts,
      LINK_STYLE_CITE,
      ROAD.survey, ROAD.reading, ROAD.wires, ROAD.search, ROAD.sliceB,
      GR.solve, GR.search, SEARCH_CITES.store, GR.ttRead, SEARCH_CITES.cutoff, GR.chain,
    ],
  },

  render(ctx) {
    try { // the hash (&level=…) wins over the remembered toggle, so a link or a hash edit decides
      const h = new URLSearchParams(location.hash.slice(1)).get('level');
      if (h === 'pattern' || h === 'transition') level = h;
    } catch { /* no location */ }
    ctx.root.append(ctx.el('style', { text: CSS }));
    ctx.root.append(toggle(ctx));
    if (ctx.example === 'orders') {
      if (level === 'pattern') ordersPattern(ctx); else ordersTransition(ctx);
    } else if (level === 'pattern') c4Pattern(ctx); else c4Transition(ctx);
  },
};

function toggle(ctx) {
  const pick = (id) => () => {
    if (level === id) return;
    level = id;
    try { localStorage.setItem('pv-string-level', id); } catch { /* per-viewer convenience only */ }
    // Kept in the hash too (&level=…), so a link to this view opens at the same level.
    try { const h = new URLSearchParams(location.hash.slice(1)); h.set('level', id); history.replaceState(null, '', `#${h}`); } catch { /* no history */ }
    if (ctx.actions.rerender) ctx.actions.rerender(); else ctx.actions.setPrefer(ctx.orders.prefer); // older shells: a no-op that notifies
  };
  const hint = level === 'pattern'
    ? (ctx.example === 'orders' ? 'drag from any port: only the links the registry allows light up (bundle.candidates)' : 'drag a palette piece onto a slot: pflow-rs decides (plan.slot_candidates)')
    : (ctx.example === 'orders' ? 'drawn by diagram-viewer.js, unmodified; the squares are transition ports you can drag' : 'drawn by diagram-viewer.js, unmodified; click the overview to move the lens');
  return ctx.el('div', { class: 'sv-toggle' },
    ctx.el('button', { class: level === 'pattern' ? 'on' : '', 'data-level': 'pattern', onclick: pick('pattern') }, 'pattern level'),
    ctx.el('button', { class: level === 'transition' ? 'on' : '', 'data-level': 'transition', onclick: pick('transition') }, 'transition level (diagram-viewer.js)'),
    ctx.el('span', { class: 'sv-hint' }, hint));
}

function defs(ctx) {
  const { svg } = ctx;
  return svg('defs', {},
    svg('marker', { id: 'sv-arrow-back', markerWidth: 8, markerHeight: 6, refX: 8, refY: 3, orient: 'auto' }, svg('polygon', { points: '0 0,8 3,0 6', fill: DV.BACK })),
    svg('marker', { id: 'sv-arrow', markerWidth: 8, markerHeight: 6, refX: 8, refY: 3, orient: 'auto' }, svg('polygon', { points: '0 0,8 3,0 6', fill: DV.PORT })));
}

/** RenderDOT's glyph for a link kind, drawn as geometry in a small circle (composedot.go:28-33). */
function glyph(ctx, kind, x, y, r = 8.5) {
  const { svg } = ctx;
  const c = ctx.theme.LINK_STYLE[kind].color;
  const k = r * 0.7;
  const inner = svg('g', { class: 'sv-pop' }, svg('circle', { r, fill: '#fff', stroke: c, 'stroke-width': 1.8 }));
  const ln = (x1, y1, x2, y2) => svg('line', { x1, y1, x2, y2, stroke: c, 'stroke-width': 1.6, 'stroke-linecap': 'round' });
  if (kind === 'event') inner.append(ln(-k, -k, k, k), ln(-k, k, k, -k));
  else if (kind === 'guard') inner.append(ln(-k, k, k, -k));
  else if (kind === 'token') inner.append(svg('polygon', { points: `0,${-r * 0.55} ${r * 0.55},0 0,${r * 0.55} ${-r * 0.55},0`, fill: c }));
  else inner.append(svg('polygon', { points: `${-r * 0.35},${-r * 0.5} ${r * 0.55},0 ${-r * 0.35},${r * 0.5}`, fill: c }));
  return svg('g', { transform: `translate(${x},${y})` }, inner);
}

// =====================================================================================
// ORDERS, pattern level
// =====================================================================================

const ROW = 24;
const LANE_OUT = 32; // how far a lane leaves a box edge before it turns (clear of an observe tap)

function measureBox(ctx, s) {
  const tw = ctx.textWidth;
  const pl = s.ports.filter((p) => p.target === 'place');
  const tr = s.ports.filter((p) => p.target === 'transition');
  const top = pl.filter((p) => p.kind === 'in' || p.kind === 'inout');
  const bot = pl.filter((p) => p.kind === 'out' || p.kind === 'inout');
  const obs = pl.filter((p) => p.kind === 'observe');
  const left = tr.filter((p) => p.kind === 'in');
  const right = tr.filter((p) => p.kind !== 'in');
  const slotW = (p) => { const [a, b] = splitId(p.id); return Math.ceil(Math.max(48, tw(b, 9.5) + 14, a ? tw(a, 8.5) + 14 : 0, tw(p.schema || '', 10) + 18)); };
  const pat = ctx.orders.patterns[s.pattern];
  const sub = `${pat.prefLabel} · ${s.netKind}`;
  const lw = max0(left.map((p) => tw(p.id, 10)));
  const rw = max0([...right.map((p) => tw(p.id, 10)), ...obs.map((p) => tw(`${p.id} observe`, 10))]);
  const w = Math.ceil(Math.max(150, sum(top.map(slotW)) + 24, sum(bot.map(slotW)) + 24, lw + rw + 52, tw(s.id, 13) + 40, tw(sub, 10) + 28));
  const two = (list) => list.some((p) => splitId(p.id)[0]);
  const topLab = top.length ? (two(top) ? 27 : 17) : 4;
  const titleY = topLab + 15, subY = titleY + 13, rowsY = subY + 9;
  const nRows = Math.max(1, left.length, right.length + obs.length);
  const botLab = bot.length ? (two(bot) ? 27 : 17) : 6;
  const h = rowsY + nRows * ROW + botLab + 4;
  return { s, pat, sub, top, bot, obs, left, right, slotW, w, h, titleY, subY, rowsY, twoTop: two(top), twoBot: two(bot), x: 0, y: 0, pos: {} };
}

function placeBox(b, x0, y0) {
  b.x = x0; b.y = y0;
  const pos = {};
  const add = (id, p) => { (pos[id] ||= []).push(p); };
  const lay = (list, y, side) => {
    let x = x0 + (b.w - sum(list.map(b.slotW))) / 2;
    for (const p of list) { const sw = b.slotW(p); add(p.id, { x: x + sw / 2, y, side, port: p }); x += sw; }
  };
  lay(b.top, y0, 'top');
  lay(b.bot, y0 + b.h, 'bottom');
  b.left.forEach((p, i) => add(p.id, { x: x0, y: y0 + b.rowsY + i * ROW + ROW / 2, side: 'left', port: p }));
  [...b.right, ...b.obs].forEach((p, i) => add(p.id, { x: x0 + b.w, y: y0 + b.rowsY + i * ROW + ROW / 2, side: 'right', port: p }));
  b.pos = pos;
}

const posOf = (b, portId, prefer) => {
  const all = b.pos[portId] || [];
  return all.find((p) => p.side === prefer) || all[0] || null;
};
/** The drawn copy a link leaves from: the bottom stub of an out/inout port, the tap of an observe port. */
const fromCopy = (b, port) => posOf(b, port.id, port.kind === 'observe' ? 'right' : 'bottom');
/** The drawn copy a link arrives at: the top stub of an in/inout port, the tap of an observe port. */
const toCopy = (b, port) => posOf(b, port.id, port.kind === 'observe' ? 'right' : 'top');
/** Where a link meets a drawn copy: an observe tap is met at its circle, 13px out from the edge. */
const attach = (c) => (c && c.side === 'right' && c.port.target === 'place' ? { ...c, x: c.x + 13 } : c);
/** The key of one drawn copy of a port (an inout port has two: top and bottom). */
const copyKey = (subnet, portId, side) => `${subnet}|${portId}|${side}`;

const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** The first candidate ({rects, ...}) whose rects all clear every obstacle, or null. Deterministic. */
const firstClear = (cands, obstacles) => cands.find((c) => c.rects.every((r) => !obstacles.some((o) => hits(r, o)))) || null;

function ordersPattern(ctx) {
  const { svg, theme } = ctx;
  const tw = ctx.textWidth;
  const subs = ctx.orders.subnets, byId = ctx.orders.byId, links = ctx.orders.links;
  const portOf = (ref) => byId[ref.subnet]?.ports.find((p) => p.id === ref.port) || null;
  const boxes = subs.map((s) => measureBox(ctx, s));
  const B = Object.fromEntries(boxes.map((b) => [b.s.id, b]));
  const ok = (l) => B[l.from.subnet] && B[l.to.subnet] && portOf(l.from) && portOf(l.to);
  const live = links.filter(ok);
  // Links that leave and reach a box by its side: events (transition ports, left and
  // right edges) and guards whose observed place is an observe tap (right edge).
  const sideLink = (l) => l.kind === 'event' || (l.kind === 'guard' && portOf(l.to)?.kind === 'observe');

  // Rows: longest-path layering over token links, with DFS cycle breaking, as
  // diagram-viewer.js layers transitions (lines 108-169). A token link into a
  // lower row is a plain wire; one that cannot point down is a back edge.
  const ids = subs.map((s) => s.id);
  const outE = Object.fromEntries(ids.map((id) => [id, []]));
  for (const l of live) if (l.kind === 'token' && l.from.subnet !== l.to.subnet) outE[l.from.subnet].push(l.to.subnet);
  const visited = new Set(), onStack = new Set(), backPairs = new Set();
  const dfs = (id) => {
    visited.add(id); onStack.add(id);
    for (const t of outE[id]) { if (!visited.has(t)) dfs(t); else if (onStack.has(t)) backPairs.add(`${id}->${t}`); }
    onStack.delete(id);
  };
  ids.forEach((id) => { if (!visited.has(id)) dfs(id); });
  const layer = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let pass = 0, changed = true; changed && pass < 64; pass++) {
    changed = false;
    for (const id of ids) for (const t of outE[id]) {
      if (backPairs.has(`${id}->${t}`)) continue;
      if (layer[id] + 1 > layer[t]) { layer[t] = layer[id] + 1; changed = true; }
    }
  }
  const nRows = max0(ids.map((id) => layer[id])) + 1;
  const rows = Array.from({ length: nRows }, (_, r) => ids.filter((id) => layer[id] === r));
  const isBackToken = (l) => l.kind === 'token' && !(layer[l.to.subnet] > layer[l.from.subnet]);
  const nBack = live.filter(isBackToken).length;

  const MARGIN = 44;
  const G = Math.max(84, 124 - 12 * Math.max(0, max0(rows.map((r) => r.length)) - 3)); // narrower gutters for wide rows
  const backMargin = 36 + 14 * nBack;
  const rowW = (r) => sum(rows[r].map((id) => B[id].w)) + G * (rows[r].length - 1);
  let W = Math.max(960, rowW(0) + 2 * MARGIN + backMargin);
  const rowTop = [186];
  const laneOf = new Map(); // link key -> lane y
  const chanOf = new Map(); // link key -> channel y (event links between rows)
  let bottomY = 0;

  for (let r = 0; r < nRows; r++) {
    const y0 = rowTop[r];
    if (r === 0) {
      let x = Math.max(MARGIN, (W - backMargin - rowW(0)) / 2);
      for (const id of rows[0]) { placeBox(B[id], x, y0); x += B[id].w + G; }
    } else {
      // Under the box the token wire comes from, so the wire runs straight down.
      const want = rows[r].map((id, i) => {
        const b = B[id];
        placeBox(b, 0, y0);
        const l = live.find((k) => k.kind === 'token' && k.to.subnet === id && layer[k.from.subnet] < r);
        if (!l) return { id, x: -Infinity, i };
        const a = fromCopy(B[l.from.subnet], portOf(l.from));
        const t = toCopy(b, portOf(l.to));
        return { id, x: a && t ? a.x - t.x : -Infinity, i };
      }).sort((p, q) => p.x - q.x || p.i - q.i);
      let cursor = MARGIN;
      for (const w of want) { const x = Math.max(cursor, w.x); placeBox(B[w.id], x, y0); cursor = x + B[w.id].w + G; }
    }
    // Lanes: side-to-side links (events, and guards onto an observe tap) inside this row
    // whose ports do not face each other across one gutter.
    const rowIdx = Object.fromEntries(rows[r].map((id, i) => [id, i]));
    let k = 0, laneMax = 0;
    for (const l of live) {
      if (!sideLink(l) || layer[l.from.subnet] !== r || layer[l.to.subnet] !== r) continue;
      const P = posOf(B[l.from.subnet], l.from.port), Q = posOf(B[l.to.subnet], l.to.port);
      if (!P || !Q) continue;
      const ia = rowIdx[l.from.subnet], ib = rowIdx[l.to.subnet];
      const direct = Math.abs(ia - ib) === 1 && ((ia < ib && P.side === 'right' && Q.side === 'left') || (ia > ib && P.side === 'left' && Q.side === 'right'));
      if (direct) continue;
      const ex1 = P.x + (P.side === 'right' ? LANE_OUT : -LANE_OUT), ex2 = Q.x + (Q.side === 'right' ? LANE_OUT : -LANE_OUT);
      const lo = Math.min(ex1, ex2), hi = Math.max(ex1, ex2);
      const under = rows[r].map((id) => B[id]).filter((b) => b.x < hi && b.x + b.w > lo);
      const base = max0((under.length ? under : [B[l.from.subnet], B[l.to.subnet]]).map((b) => b.y + b.h));
      const y = base + 30 + 13 * k++;
      laneOf.set(l.key, y);
      laneMax = Math.max(laneMax, y);
    }
    const rowBottom = max0(rows[r].map((id) => B[id].y + B[id].h));
    // Channels: side-to-side links between this row and a lower one run along a corridor
    // below this row's boundary stubs (which end 40px under a box) and above the
    // next row's, so they never cross a box.
    let kc = 0, chanMax = 0;
    for (const l of live) {
      if (!sideLink(l)) continue;
      const la = layer[l.from.subnet], lb = layer[l.to.subnet];
      if (la === lb || Math.min(la, lb) !== r) continue;
      const y = Math.max(rowBottom + 60, laneMax + 20) + 13 * kc++;
      chanOf.set(l.key, y);
      chanMax = Math.max(chanMax, y);
    }
    bottomY = Math.max(rowBottom + 44, laneMax + 16);
    if (r + 1 < nRows) rowTop.push(Math.max(rowBottom + 120, laneMax + 90, chanMax ? chanMax + 58 : 0));
  }
  W = Math.max(W, max0(boxes.map((b) => b.x + b.w)) + backMargin + MARGIN);

  // Which drawn copies a token/data link replaces with its wire (they stop being
  // boundary stubs): the copy it leaves from and the copy it arrives at, nothing
  // else. An inout port is in both dom and cod, so wiring its bottom copy into
  // the next box leaves its top copy on the composite's dom, as composing two
  // boxes along one wire leaves the first box's inputs and the second's outputs.
  const wired = new Set();
  for (const l of live) {
    if (l.kind !== 'token' && l.kind !== 'data') continue;
    const P = fromCopy(B[l.from.subnet], portOf(l.from)), Q = toCopy(B[l.to.subnet], portOf(l.to));
    if (P) wired.add(copyKey(l.from.subnet, l.from.port, P.side));
    if (Q) wired.add(copyKey(l.to.subnet, l.to.port, Q.side));
  }
  // What a label or glyph must not land on: boxes, boundary stubs with their labels, taps, the head.
  const obstacles = [{ x: 0, y: 0, w: W, h: 60 }, { x: -1e4, y: -1e4, w: 1e4 + 6, h: 3e4 }, { x: W - 6, y: -1e4, w: 1e4, h: 3e4 }];
  if (live.some((l) => l.leak)) obstacles.push({ x: 0, y: 0, w: W, h: rowTop[0] - 66 }); // the leak note's band (its box ends at rowTop - 68)
  for (const b of boxes) {
    obstacles.push({ x: b.x - 3, y: b.y - 3, w: b.w + 6, h: b.h + 6 });
    for (const [pid, copies] of Object.entries(b.pos)) for (const c of copies) {
      if (c.port.target !== 'place') continue;
      if (c.side === 'right') { obstacles.push({ x: c.x, y: c.y - 9, w: 24, h: 18 }); continue; }
      if (wired.has(copyKey(b.s.id, pid, c.side))) continue;
      const lw = Math.max(30, ctx.textWidth(c.port.schema || '', DV.LABEL)) + 6;
      obstacles.push(c.side === 'top' ? { x: c.x - lw / 2, y: c.y - 42, w: lw, h: 42 } : { x: c.x - lw / 2, y: c.y, w: lw, h: 42 });
    }
  }

  // The composite's boundary (the ROADMAP Phase 6 reading): every copy no link wires.
  const dom = [], cod = [], taps = [];
  for (const r of rows) for (const id of r) {
    const b = B[id];
    for (const p of b.top) if (!wired.has(copyKey(id, p.id, 'top'))) dom.push(p.schema);
    for (const p of b.bot) if (!wired.has(copyKey(id, p.id, 'bottom'))) cod.push(p.schema);
    for (const p of b.obs) if (!wired.has(copyKey(id, p.id, 'right'))) taps.push(`${p.schema} (${id}:${p.id})`);
  }
  // cod (and the taps) wrap to the drawing's width instead of running off its edge.
  const monoW = (t) => String(t).length * 11 * 0.62;
  const codLines = [];
  {
    const room = W - 2 * MARGIN - monoW('cod ');
    let cur = '';
    for (const t of (cod.length ? cod : ['I (nothing)'])) {
      const next = cur ? `${cur} ⊗ ${t}` : t;
      if (cur && monoW(next) > room) { codLines.push(`${cur} ⊗`); cur = t; } else cur = next;
    }
    codLines.push(cur);
  }
  const tapsText = taps.length ? `taps: ${taps.join(', ')}` : '';
  const tapsOwnLine = tapsText && monoW(`cod ${codLines[codLines.length - 1]}`) + 14 + tw(tapsText, 11) > W - 2 * MARGIN;
  const codY = bottomY + 22;
  const legendY = codY + 34 + 15 * (codLines.length - 1 + (tapsOwnLine ? 1 : 0));
  const H = legendY + 62;
  const root = ctx.svgRoot(W, H, { class: 'view-svg sv' });
  root.append(defs(ctx), svg('rect', { width: W, height: H, fill: DV.PAPER, rx: 4 }));

  // Head: the composite and its boundary.
  const counts = ['event', 'token', 'data', 'guard'].map((k) => [k, live.filter((l) => l.kind === k).length]).filter(([, n]) => n);
  const head = svg('g', {});
  head.append(svg('text', { x: MARGIN, y: 28, fill: '#2b2f36' },
    svg('tspan', { 'font-size': 15, 'font-weight': 600 }, subs.map((s) => s.id).join(' ⊗ ')),
    svg('tspan', { 'font-size': 11, fill: '#6a717c', dx: 14 },
      counts.length ? `side by side (⊗), with ${counts.map(([k, n]) => `${n} ${k} link${n === 1 ? '' : 's'}`).join(', ')}` : 'side by side (⊗), no links: the composite is exactly the monoidal product')));
  const domText = dom.join(' ⊗ ') || 'I (nothing)';
  const domHint = 'top-edge wires: in and inout ports (ROADMAP Phase 6 reading)';
  head.append(svg('text', { x: MARGIN, y: 50, 'font-size': 11, fill: '#444' },
    svg('tspan', { 'font-weight': 600 }, 'dom '), svg('tspan', { class: 'mono' }, domText),
    monoW(`dom ${domText}`) + 10 + tw(domHint, 11) < W - 2 * MARGIN ? svg('tspan', { fill: '#888', dx: 10 }, domHint) : null));
  root.append(head);

  // --- token, data and guard wires (under the boxes) ---
  const wiresG = svg('g', { class: 'sv-wires' });
  const linksG = svg('g', { class: 'sv-links' });
  const notesG = svg('g', {});
  let backI = 0;
  const glyphAt = new Map();
  const guards = [];
  const glyphBox = (x, y, r = 10) => ({ x: x - r, y: y - r, w: 2 * r, h: 2 * r });
  // Leads: where a routed connector leaves a box side. Two ports on one side get
  // leads 10px apart, so their vertical runs never lie on top of each other; one
  // port keeps one lead (its links fan out from it). Runs that go up take the
  // inner leads top port first, runs that go down bottom port first, so leads
  // on one side do not cross each other at the ports.
  const leadReq = new Map(); // `${subnet}|${side}` -> Map(portId -> {y, dir})
  const reqLead = (subnet, c, dir) => {
    const k = `${subnet}|${c.side}`;
    if (!leadReq.has(k)) leadReq.set(k, new Map());
    if (!leadReq.get(k).has(c.port.id)) leadReq.get(k).set(c.port.id, { y: c.y, dir });
  };
  for (const l of live) {
    if (!sideLink(l)) continue;
    const lane = laneOf.get(l.key), chan = chanOf.get(l.key);
    if (lane === undefined && chan === undefined) continue;
    const P = posOf(B[l.from.subnet], l.from.port), Q = posOf(B[l.to.subnet], l.to.port);
    if (!P || !Q) continue;
    const up = Math.min(layer[l.from.subnet], layer[l.to.subnet]);
    reqLead(l.from.subnet, P, lane !== undefined || layer[l.from.subnet] === up ? 'down' : 'up');
    reqLead(l.to.subnet, Q, lane !== undefined || layer[l.to.subnet] === up ? 'down' : 'up');
  }
  const leadIdx = new Map();
  for (const [k, m] of leadReq) {
    const es = [...m.entries()];
    const ups = es.filter(([, v]) => v.dir === 'up').sort((a, b) => a[1].y - b[1].y || (a[0] < b[0] ? -1 : 1));
    const downs = es.filter(([, v]) => v.dir === 'down').sort((a, b) => b[1].y - a[1].y || (a[0] < b[0] ? -1 : 1));
    [...ups, ...downs].forEach(([pid], i) => leadIdx.set(`${k}|${pid}`, i));
  }
  const leadX = (subnet, c) => {
    const k = `${subnet}|${c.side}|${c.port.id}`;
    if (!leadIdx.has(k)) { // a lead the pre-pass did not plan (a guard routed round a box): the next free one
      const side = `${subnet}|${c.side}|`;
      leadIdx.set(k, [...leadIdx.keys()].filter((x) => x.startsWith(side)).length);
    }
    const off = LANE_OUT + 10 * Math.min(leadIdx.get(k), 3);
    return c.x + (c.side === 'right' ? off : -off);
  };
  /** Points along an orthogonal route to try a glyph at: longest run first, from its middle outwards. */
  const runSamples = (pts) => pts.slice(1).map((q, i) => [pts[i], q])
    .map(([a, b2]) => ({ a, b: b2, len: Math.hypot(b2[0] - a[0], b2[1] - a[1]) }))
    .filter((sg) => sg.len > 24).sort((p, q) => q.len - p.len)
    .flatMap(({ a, b: b2 }) => [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].map((t) => [a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t]));
  /**
   * The route of a side-to-side link (P and Q on box edges): along its channel
   * between rows, along its lane under the row, straight across one gutter, or a
   * cubic between facing ports. Returns the path, a glyph point and the
   * orthogonal runs (null for a curve), plus a sampler for label placement.
   */
  const sideRoute = (l, P, Q) => {
    const laneY = laneOf.get(l.key), chanY = chanOf.get(l.key);
    if (chanY !== undefined || laneY !== undefined) {
      const y = chanY !== undefined ? chanY : laneY;
      const ex1 = leadX(l.from.subnet, P), ex2 = leadX(l.to.subnet, Q);
      const pts = [[P.x, P.y], [ex1, P.y], [ex1, y], [ex2, y], [ex2, Q.y], [Q.x, Q.y]];
      let gx;
      if (chanY !== undefined) {
        // In a gutter of the upper row (clear of its stubs), nearest the middle; else where the upper port's lead meets the channel.
        const up = Math.min(layer[l.from.subnet], layer[l.to.subnet]);
        gx = glyphOnRun(up, ex1, ex2, y, (ex1 + ex2) / 2, layer[l.from.subnet] === up ? ex1 : ex2);
      } else {
        // In a gutter (between two boxes, clear of every stub), the one nearest the far end.
        gx = glyphOnRun(layer[l.to.subnet], ex1, ex2, y, ex2, (ex1 + ex2) / 2);
      }
      return { d: ortho(pts, 9), gx, gy: y, runs: pts, samples: [[gx, y], ...runSamples(pts)] };
    }
    if (layer[l.from.subnet] === layer[l.to.subnet] && P.y === Q.y) {
      return { d: `M${P.x},${P.y} L${Q.x},${Q.y}`, gx: (P.x + Q.x) / 2, gy: P.y, runs: null, samples: [[(P.x + Q.x) / 2, P.y]] };
    }
    const c = cubicBetween(P, Q, 50);
    const [gx, gy] = bez(c, 0.5);
    return { d: cubicD(c), gx, gy, runs: null, samples: [0.5, 0.42, 0.58, 0.34, 0.66].map((t) => bez(c, t)) };
  };
  const verticals = []; // vertical runs of routed connectors, for the leak leader to avoid
  const runObstacles = (pts) => {
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
      if (Math.abs(x1 - x2) < 0.5 && Math.abs(y1 - y2) > 0.5) verticals.push({ x: x1, y1: Math.min(y1, y2), y2: Math.max(y1, y2) });
      obstacles.push({ x: Math.min(x1, x2) - 2, y: Math.min(y1, y2) - 2, w: Math.abs(x2 - x1) + 4, h: Math.abs(y2 - y1) + 4 });
    }
  };
  // Where a glyph sits on a horizontal run from x1 to x2 at y: in a gutter of row r
  // nearest prefer, nudged along the run if a glyph is already there; else at fallback.
  const glyphOnRun = (r, x1, x2, y, prefer, fallback) => {
    const lo = Math.min(x1, x2) + 10, hi = Math.max(x1, x2) - 10;
    const rb = rows[r].map((id) => B[id]).sort((p, q) => p.x - q.x);
    const gutters = rb.slice(1).map((bx, i) => (rb[i].x + rb[i].w + bx.x) / 2).filter((x) => x > lo && x < hi)
      .sort((a, b) => Math.abs(a - prefer) - Math.abs(b - prefer) || a - b);
    const xs = [];
    for (const x of [...gutters, fallback]) for (const dx of [0, 24, -24, 48, -48]) if (x + dx >= lo - 10 && x + dx <= hi + 10) xs.push(x + dx);
    return xs.find((x) => !obstacles.some((o) => hits(glyphBox(x, y), o))) ?? (gutters[0] ?? fallback);
  };
  for (const l of live) {
    const fb = B[l.from.subnet], tb = B[l.to.subnet];
    const fp = portOf(l.from), tp = portOf(l.to);
    const style = theme.LINK_STYLE[l.kind];
    const info = ctx.info.linkInfo(l, byId);
    const flatName = l.kind === 'event' ? ctx.orders.flat.ok && ctx.orders.flat.map.transition[l.from.subnet]?.[fp.transition] : null;
    const g = svg('g', { class: `sv-link sv-${l.kind}`, 'data-link-key': l.key });
    if (l.kind === 'token' || l.kind === 'data') {
      const P = attach(fromCopy(fb, fp)), Q = attach(toCopy(tb, tp));
      if (!P || !Q) continue;
      const opFact = l.kind === 'token' ? ['ROADMAP op', 'op:glue: a pushout of open nets along the shared place (cospan composite)'] : ['ROADMAP op', 'op:tap: a read-only observation of the place'];
      if (l.kind === 'token' && isBackToken(l)) {
        const i = backI++;
        const rightX = W - 22 - 14 * i;
        const below = P.side === 'bottom' ? P.y + 18 + 6 * i : P.y;
        const above = Q.side === 'top' ? rowTop[layer[l.to.subnet]] - 52 - 8 * i : Q.y;
        const my = (below + above) / 2;
        const d = ortho([[P.x, P.y], [P.x, below], [rightX, below], [rightX, above], [Q.x, above], [Q.x, Q.y]], 14);
        g.setAttribute('class', 'sv-link sv-back');
        g.append(svg('path', { d, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 12, fill: 'none' }),
          svg('path', { d, stroke: DV.PAPER, 'stroke-width': 5, fill: 'none', class: 'sv-halo' }),
          svg('path', { d, class: 'sv-stroke', stroke: DV.BACK, 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': DV.BACK_DASH, 'marker-end': 'url(#sv-arrow-back)' }),
          svg('text', { x: rightX - 5, y: my, 'text-anchor': 'end', 'font-size': DV.LABEL, fill: DV.BACK, dy: -3, 'paint-order': 'stroke', stroke: DV.PAPER, 'stroke-width': 3 }, `◆ ${fp.schema}`));
        ctx.hover(g, { ...info, facts: [...info.facts, opFact, ['drawn as', 'a back edge: the target is not below the source, so the wire goes round the right side, dashed red (diagram-viewer.js:490-501)']], cites: [...info.cites, DVC.back] });
      } else {
        const c = P.side === 'bottom' && Q.side === 'top'
          ? [[P.x, P.y], [P.x, (P.y + Q.y) / 2], [Q.x, (P.y + Q.y) / 2], [Q.x, Q.y]]
          : cubicBetween(P, Q, 50);
        const [mx, my] = bez(c, 0.5);
        const d = cubicD(c);
        const stroke = l.kind === 'token' ? DV.WIRE : style.color;
        g.append(svg('path', { d, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 12, fill: 'none' }),
          svg('path', { d, class: 'sv-stroke', stroke, 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': l.kind === 'data' ? style.dash : null }),
          svg('text', { x: mx + 12, y: my, 'font-size': DV.LABEL, fill: DV.LABEL_FILL, dy: 3.5 }, fp.schema || tp.schema),
          glyph(ctx, l.kind, mx, my, 6.5));
        ctx.hover(g, { ...info, facts: [...info.facts, opFact, ['drawn as', l.kind === 'token' ? 'a wire from the out port\'s bottom stub into the in port\'s top stub, labelled by the shared schema (the place is the object it carries)' : 'a dotted read-only tap, RenderDOT\'s ▷']], cites: [...info.cites, DVC.wires] });
      }
      ctx.emit('fusion', l.key, {}); // spec D10: one fusion entry per link drawn, every kind
      wiresG.append(g);
      continue;
    }
    if (l.kind === 'guard') { guards.push(l); continue; } // drawn after the event glyphs, so its label can avoid them
    // event: a bold green connector between two transition ports, RenderDOT's ⊗ in a circle.
    const P = posOf(fb, fp.id), Q = posOf(tb, tp.id);
    if (!P || !Q) continue;
    const chanY = chanOf.get(l.key);
    const { d, gx, gy, runs } = sideRoute(l, P, Q);
    g.append(svg('path', { d, stroke: DV.PAPER, 'stroke-width': 7, fill: 'none', class: 'sv-halo' }),
      svg('path', { d, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 12, fill: 'none' }),
      svg('path', { d, class: 'sv-stroke', stroke: style.color, 'stroke-width': 2.6, fill: 'none', 'stroke-linecap': 'round' }),
      glyph(ctx, 'event', gx, gy));
    ctx.emit('fusion', l.key, {});
    ctx.hover(g, { ...info, facts: [...info.facts, ['ROADMAP op', 'op:sync: transition fusion (Bruni et al.), not a wire'], ['flat transition', flatName || '(flatten refused)'], ['drawn as', `a bold green connector with RenderDOT's ⊗ (composedot.go:31), ROADMAP Slice B${chanY !== undefined ? '; between rows it runs along the channel between them' : ''}`]], cites: [...info.cites, LINK_STYLE_CITE, ROAD.sliceB], bib: ['bruni-et-al'] });
    linksG.append(g);
    glyphAt.set(l.key, [gx, gy]);
    obstacles.push(glyphBox(gx, gy));
    if (runs) runObstacles(runs);
  }

  // Guard links: dashed, RenderDOT's ⊘, flagged. The glyph and its label go where
  // they clear every box, stub and glyph (first fit along the curve, deterministic).
  const GUARD_LABEL = 'guard: contextual (flagged)';
  for (const l of guards) {
    const fb = B[l.from.subnet], tb = B[l.to.subnet];
    const fp = portOf(l.from), tp = portOf(l.to);
    const style = theme.LINK_STYLE.guard;
    const info = ctx.info.linkInfo(l, byId);
    const P = posOf(fb, fp.id), Q = attach(posOf(tb, tp.id, tp.kind === 'observe' ? 'right' : 'top'));
    if (!P || !Q) continue;
    ctx.emit('fusion', l.key, {}); // spec D10: every kind
    let d, samples, runs = null;
    if (sideLink(l)) {
      // Onto an observe tap: routed like an event (lane, channel or across one gutter).
      ({ d, samples, runs } = sideRoute(l, P, Q));
    } else {
      const c = cubicBetween(P, Q, 60);
      if (Q.side === 'top' || Q.side === 'bottom') c[2][0] += Math.sign(P.x - Q.x || 1) * Math.min(70, Math.abs(P.x - Q.x) / 2); // arrive at an angle, not along the stub
      const inside = (x, y) => boxes.some((b) => x > b.x + 2 && x < b.x + b.w - 2 && y > b.y + 2 && y < b.y + b.h - 2);
      const crosses = Array.from({ length: 17 }, (_, i) => 0.1 + i * 0.05).some((t) => inside(...bez(c, t)));
      if (!crosses) {
        d = cubicD(c);
        samples = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8].map((t) => bez(c, t));
      } else {
        // The curve would cut through a box: out into the port's gutter, then along
        // a run above (top port) or below (bottom port) the target's stubs, and in at an angle.
        const ex = leadX(l.from.subnet, P);
        const top = Q.side === 'top';
        const yR = top ? Q.y - 54 : Q.y + 54;
        const sg = Math.sign(ex - Q.x) || 1;
        // Come down (or up) between Q's stub label and its neighbour's, then in under the label.
        const nb = Object.values(tb.pos).flat().filter((c2) => c2.side === Q.side && Math.sign(c2.x - Q.x) === sg)
          .sort((a, b2) => Math.abs(a.x - Q.x) - Math.abs(b2.x - Q.x))[0];
        const qx = nb ? (Q.x + nb.x) / 2 : Q.x + sg * 34;
        const yIn = Q.y + (top ? -12 : 12);
        const pts = [[P.x, P.y], [ex, P.y], [ex, yR], [qx, yR], [qx, yIn]];
        d = `${ortho(pts, 9)} Q${Q.x + sg * 4},${yIn} ${Q.x},${Q.y}`;
        runs = pts;
        samples = runSamples(pts);
      }
    }
    // One line where it fits; else three short lines (for a narrow gutter); else the glyph alone
    // (the hover still says it is flagged).
    const TS = 9.5;
    const ts = ['guard', 'contextual', '(flagged)'];
    const one = { lines: [GUARD_LABEL], w: tw(GUARD_LABEL, TS) * 1.08, h: 12 };
    const three = { lines: ts, w: max0(ts.map((t) => tw(t, TS))) * 1.08, h: 34 };
    const cands = [];
    for (const L of [one, three]) for (const [x, y] of samples) {
      const gb = glyphBox(x, y);
      const mk = (lx, ly, anchor) => ({ rects: [gb, { x: anchor === 'start' ? lx : anchor === 'end' ? lx - L.w : lx - L.w / 2, y: ly, w: L.w, h: L.h }], x, y, L, tx: lx, ty: ly + 9, anchor });
      cands.push(mk(x + 12, y - L.h / 2, 'start'), mk(x - 12, y - L.h / 2, 'end'), mk(x, y + 11, 'middle'), mk(x, y - 11 - L.h, 'middle'));
    }
    const [x0, y0] = samples[0];
    // The label also keeps off this guard's own path (the glyph sits on it).
    const own = runs
      ? runs.slice(1).map((q, i) => ({ x: Math.min(q[0], runs[i][0]) - 2, y: Math.min(q[1], runs[i][1]) - 2, w: Math.abs(q[0] - runs[i][0]) + 4, h: Math.abs(q[1] - runs[i][1]) + 4 }))
      : samples.map(([x, y]) => ({ x: x - 3, y: y - 3, w: 6, h: 6 }));
    const pick = cands.find((cd) => !obstacles.some((o) => hits(cd.rects[0], o)) && !cd.rects.slice(1).some((r) => [...obstacles, ...own].some((o) => hits(r, o))))
      || { rects: [glyphBox(x0, y0)], x: x0, y: y0, L: null };
    const g = svg('g', { class: 'sv-link sv-guard', 'data-link-key': l.key });
    g.append(svg('path', { d, stroke: DV.PAPER, 'stroke-width': 6, fill: 'none', class: 'sv-halo' }),
      svg('path', { d, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 12, fill: 'none' }),
      svg('path', { d, class: 'sv-stroke', stroke: style.color, 'stroke-width': 1.8, fill: 'none', 'stroke-dasharray': style.dash }),
      glyph(ctx, 'guard', pick.x, pick.y),
      pick.L ? svg('text', { x: pick.tx, y: pick.ty, 'text-anchor': pick.anchor, 'font-size': TS, fill: style.color, 'font-weight': 600, 'paint-order': 'stroke', stroke: DV.PAPER, 'stroke-width': 3 },
        pick.L.lines.map((t, i) => svg('tspan', { x: pick.tx, dy: i ? 11 : 0 }, t))) : null);
    ctx.hover(g, { ...info, facts: [...info.facts, ['ROADMAP op', 'op:gate (flagged contextual)'], ['drawn as', 'dashed, RenderDOT\'s ⊘, from the gated transition to the observed place']], note: 'A guard link is outside the free-SMC fragment (ROADMAP Phase 6, which cites the book\'s Appendix E and pflow-jl\'s ContextualArcError): it is drawn and flagged, and no functorial semantics is claimed for it.', cites: [...info.cites, ROAD.reading] });
    linksG.append(g);
    glyphAt.set(l.key, [pick.x, pick.y]);
    for (const r of pick.rects) obstacles.push(r);
    if (runs) runObstacles(runs);
  }

  // Leak notes: the idiom caveat, verbatim, in red on its spider (ROADMAP Slice B).
  // The first is spelled out in the band reserved above the top row, with a leader
  // down to its glyph; every later instance gets a small tag beside its glyph.
  let leakN = 0;
  for (const l of live) {
    if (!l.leak || !glyphAt.has(l.key)) continue;
    const [gx, gy] = glyphAt.get(l.key);
    const idiom = ctx.orders.idioms.find((i) => i.key === l.idiom);
    const g = svg('g', { class: 'sv-leak' });
    if (leakN === 0) {
      const lines = wrap(tw, `pool leak: ${idiom.caveat}`, 500, 10);
      const ny = rowTop[0] - 100 - (lines.length - 3) * 12;
      const nx = Math.min(Math.max(gx, MARGIN + 262), W - backMargin - 262);
      const ly1 = ny + lines.length * 12 - 4;
      // The leader leaves the note where it does not run along a connector's vertical lead.
      const lx = [0, 26, -26, 52, -52].map((dx) => gx + dx).find((x) => x > nx - 250 && x < nx + 250
        && !verticals.some((v) => Math.abs(v.x - x) < 6 && v.y2 > ly1 && v.y1 < gy - 10)) ?? gx;
      g.append(svg('line', { x1: lx, y1: ly1, x2: gx, y2: gy - 10, stroke: theme.LEAK, 'stroke-width': 1, 'stroke-dasharray': '2,2' }),
        svg('rect', { x: nx - 260, y: ny - 12, width: 520, height: lines.length * 12 + 8, rx: 4, fill: '#fdf0ee', stroke: theme.LEAK, 'stroke-width': 0.8, class: 'sv-hit' }),
        svg('text', { x: nx, y: ny, 'font-size': 10, fill: theme.LEAK, 'text-anchor': 'middle' }, lines.map((t, i) => svg('tspan', { x: nx, dy: i ? 12 : 0 }, t))),
        svg('text', { x: nx + 260, y: ny - 16, 'font-size': 8.5, fill: theme.LEAK, 'text-anchor': 'end' }, `pat:${l.idiom} · patterns.ttl:493-498`));
    } else {
      // The long tag where it fits beside the glyph, else a short one (the hover has the caveat verbatim).
      const h = 15;
      const cands = ['pool leak: the same caveat', 'pool leak'].flatMap((text) => {
        const w = tw(text, 9) + 12;
        return [[gx + 8, gy - 26], [gx - 8 - w, gy - 26], [gx + 8, gy + 11], [gx - 8 - w, gy + 11], [gx - w / 2, gy - 28], [gx - w / 2, gy + 13], [gx + 13, gy - h / 2], [gx - 13 - w, gy - h / 2]]
          .map(([x, y]) => ({ rects: [{ x, y, w, h }], x, y, w, text }));
      });
      const pick = firstClear(cands, obstacles) || cands.find((c) => c.text === 'pool leak');
      g.append(svg('rect', { x: pick.x, y: pick.y, width: pick.w, height: h, rx: 7.5, fill: '#fdf0ee', stroke: theme.LEAK, 'stroke-width': 0.8, class: 'sv-hit' }),
        svg('text', { x: pick.x + pick.w / 2, y: pick.y + 10.5, 'font-size': 9, fill: theme.LEAK, 'text-anchor': 'middle' }, pick.text));
      obstacles.push(pick.rects[0]);
    }
    const info = ctx.info.linkInfo(l, byId);
    ctx.hover(g, { ...info, title: `caveat on ${info.title}`, note: 'The refund scenario (bundle.scenarios, judgment) expects this: the worker never returns to the pool. ROADMAP Phase 4 names it as the expected failure of the rollback scenario.', cites: [ttl(493, 498, 'pat:idiom-pool-release-saga-commit and its caveat'), ROAD.orders41, ROAD.worked, ...info.cites] });
    notesG.append(g);
    leakN++;
  }

  // --- boxes, stubs and ports ---
  const boxesG = svg('g', {});
  const portsG = svg('g', { class: 'sv-ports' }); // above the links, so a connector never covers a port
  const flipItems = [];
  const portEls = new Map();
  for (const b of boxes) {
    const s = b.s;
    const g = svg('g', { class: 'sv-box', 'data-box': s.id });
    // Boundary stubs: a port no token/data link wires is a wire of the composite's boundary.
    for (const [pid, copies] of Object.entries(b.pos)) {
      const port = copies[0].port;
      if (port.target !== 'place') continue;
      for (const c of copies) {
        if (c.side === 'right') continue; // the observe tap is drawn with its port
        if (wired.has(copyKey(s.id, pid, c.side))) continue; // this copy is a link's wire now
        const inn = c.side === 'top';
        const y1 = inn ? c.y - 40 : c.y, y2 = inn ? c.y : c.y + 40;
        const wg = svg('g', { class: 'sv-wire' },
          svg('path', { d: `M${c.x},${y1} C${c.x},${y1 + 15} ${c.x},${y2 - 15} ${c.x},${y2}`, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 10, fill: 'none' }),
          svg('path', { d: `M${c.x},${y1} C${c.x},${y1 + 15} ${c.x},${y2 - 15} ${c.x},${y2}`, class: 'sv-stroke', stroke: DV.WIRE, 'stroke-width': 1.5, fill: 'none' }),
          svg('text', { x: c.x, y: y1 + (y2 - y1) / 2, 'text-anchor': 'middle', 'font-size': DV.LABEL, fill: DV.LABEL_FILL, dy: -3, 'paint-order': 'stroke', stroke: DV.PAPER, 'stroke-width': 3 }, port.schema));
        const pi = ctx.info.portInfo(s, port);
        ctx.hover(wg, { ...pi, title: `wire ${port.schema}: ${s.id}:${pid}`, facts: [...pi.facts, ['drawn as', `a boundary wire ${inn ? 'entering the top edge (an input: part of dom)' : 'leaving the bottom edge (an output: part of cod)'}; its label is the port schema (ROADMAP: wire types are port schemas)`]], cites: [...pi.cites, ROAD.wires, inn ? DVC.boundaryIn : DVC.boundaryOut] });
        g.append(wg);
      }
    }
    // The box: a morphism, diagram-viewer.js style.
    const body = svg('g', { class: 'sv-body' },
      svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: DV.RX, fill: '#fff', stroke: DV.STROKE, 'stroke-width': DV.SW, class: 'sv-rect' }),
      svg('rect', { x: b.x + 1, y: b.y + b.titleY - 14, width: b.w - 2, height: 31, fill: theme.PATTERN_TINT[s.pattern] || '#f3f4f6', opacity: 0.7 }),
      svg('text', { x: b.x + b.w / 2, y: b.y + b.titleY, 'text-anchor': 'middle', 'font-size': 12.5, 'font-weight': 600, fill: '#333' }, s.id),
      svg('text', { x: b.x + b.w / 2, y: b.y + b.subY, 'text-anchor': 'middle', 'font-size': 10, fill: '#666' }, b.sub));
    const domS = b.top.map((p) => p.schema).join(' ⊗ ') || 'I', codS = b.bot.map((p) => p.schema).join(' ⊗ ') || 'I';
    const si = ctx.info.subnetInfo(s);
    ctx.hover(body, { ...si, facts: [...si.facts, ['as a morphism (ROADMAP Phase 6)', `${domS} → ${codS}`], b.obs.length ? ['side taps', b.obs.map((p) => `${p.id}: ${p.schema}`).join(', ')] : null, ['sync boundary', `${b.left.length} in (left), ${b.right.length} out (right) transition ports`]].filter(Boolean), cites: [...si.cites, ROAD.wires, DVC.box] });
    g.append(body);
    ctx.emit('box', s.id, {});
    // Port labels inside the box.
    for (const [pid, copies] of Object.entries(b.pos)) {
      for (const c of copies) {
        const p = c.port;
        if (p.target === 'place' && (c.side === 'top' || c.side === 'bottom')) {
          const [pre, rest] = splitId(pid);
          const yA = c.side === 'top' ? b.y + 12 : b.y + b.h - (pre ? 17 : 6);
          const t = svg('text', { x: c.x, y: pre ? yA : (c.side === 'top' ? b.y + 14 : yA), 'text-anchor': 'middle', 'font-size': 9.5, fill: '#444' });
          if (pre) t.append(svg('tspan', { x: c.x, 'font-size': 8.5, fill: '#888' }, pre), svg('tspan', { x: c.x, dy: 11 }, rest));
          else t.append(svg('tspan', {}, rest));
          g.append(t);
        } else if (c.side === 'left') {
          g.append(svg('text', { x: b.x + 11, y: c.y + 3.5, 'font-size': 10, fill: '#333' }, pid));
        } else {
          const t = svg('text', { x: b.x + b.w - 11, y: c.y + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: '#333' }, pid);
          if (p.kind === 'observe') t.append(svg('tspan', { 'font-size': 8.5, fill: '#888' }, ' observe'));
          g.append(t);
        }
      }
    }
    // Ports: in the top layer so they sit on the edge above every connector; each copy is a snap target.
    const pgBox = svg('g', { 'data-box-ports': s.id });
    for (const [pid, copies] of Object.entries(b.pos)) {
      for (const c of copies) {
        const p = c.port;
        const pg = svg('g', { class: 'sv-port' });
        if (p.target === 'transition') {
          pg.append(svg('rect', { x: c.x - 9, y: c.y - 9, width: 18, height: 18, fill: 'transparent', class: 'sv-hit' }),
            svg('rect', { x: c.x - 4.5, y: c.y - 4.5, width: 9, height: 9, fill: theme.portColor(p), stroke: '#fff', 'stroke-width': 1, class: 'sv-pulse' }));
        } else if (c.side === 'right') {
          const col = theme.portColor(p);
          pg.append(svg('line', { x1: c.x, y1: c.y, x2: c.x + 10, y2: c.y, stroke: col, 'stroke-width': 1.5 }),
            svg('circle', { cx: c.x + 13, cy: c.y, r: 9, fill: 'transparent', class: 'sv-hit' }),
            svg('circle', { cx: c.x + 13, cy: c.y, r: 3.6, fill: '#fff', stroke: col, 'stroke-width': 1.6, class: 'sv-pulse' }),
            svg('circle', { cx: c.x, cy: c.y, r: 2.4, fill: col }));
        } else {
          const col = theme.portColor(p);
          pg.append(svg('circle', { cx: c.x, cy: c.y, r: 9, fill: 'transparent', class: 'sv-hit' }),
            svg('circle', { cx: c.x, cy: c.y, r: 4.6, fill: col, stroke: '#fff', 'stroke-width': 1, class: 'sv-pulse' }));
          if (p.kind === 'inout') pg.append(svg('circle', { cx: c.x, cy: c.y, r: 1.6, fill: '#fff' }));
        }
        ctx.snap.port(pg, { subnet: s.id, port: pid });
        if (p.target === 'place') ctx.emit('wire', `${s.id}:${pid}`, { schema: p.schema });
        const pi = ctx.info.portInfo(s, p);
        const where = { top: 'top edge: an input (dom)', bottom: 'bottom edge: an output (cod)', left: 'left edge: an in transition port (sync boundary)', right: p.target === 'transition' ? 'right edge: an out transition port (sync boundary)' : 'right edge: a side tap (observe), outside dom and cod' }[c.side];
        ctx.hover(pg, { ...pi, facts: [...pi.facts, ['drawn on', p.kind === 'inout' ? `${where}; inout ports are drawn on both edges (ROADMAP)` : where], ['drag', 'from here to link: the lit ports are the ones the registry allows (bundle.candidates: pflow-compose\'s port of go-pflow validateLink)']], cites: [...pi.cites, ROAD.wires] });
        pgBox.append(pg);
        if (!portEls.has(`${s.id}|${pid}`)) portEls.set(`${s.id}|${pid}`, []);
        portEls.get(`${s.id}|${pid}`).push(pg);
      }
    }
    boxesG.append(g);
    portsG.append(pgBox);
    flipItems.push({ id: s.id, el: g, x: b.x, y: b.y }, { id: `${s.id}:ports`, el: pgBox, x: b.x, y: b.y });
  }

  root.append(wiresG, boxesG, linksG, notesG, portsG);

  // Codomain and legend.
  const codX = MARGIN + monoW('cod ');
  root.append(svg('text', { x: MARGIN, y: codY, 'font-size': 11, fill: '#444' },
    svg('tspan', { 'font-weight': 600 }, 'cod '),
    codLines.map((t, i) => svg('tspan', { class: 'mono', x: i ? codX : null, dy: i ? 15 : null }, t)),
    tapsText ? svg('tspan', { fill: '#888', ...(tapsOwnLine ? { x: codX, dy: 15 } : { dx: 14 }) }, tapsText) : null));
  root.append(legendOrders(ctx, MARGIN, legendY, W - 2 * MARGIN));

  ctx.root.append(root);
  if (ctx.orders.flat && !ctx.orders.flat.ok) ctx.note(`bundle.flatten refuses this composition: ${ctx.orders.flat.error || ctx.orders.flat.errors.map((e) => e.code).join(', ')}`, 'warn');

  // --- merge animation ---
  const ev = ctx.event;
  const moving = ev && ['link-added', 'link-removed', 'instance-added', 'instance-removed', 'links-reset', 'links-cleared'].includes(ev.type);
  const moved = flip('orders-pattern', flipItems, moving);
  if (moved) for (const layerG of [wiresG, linksG, notesG]) anim(layerG, [{ opacity: 0 }, { opacity: 0 , offset: 0.45 }, { opacity: 1 }], { duration: 800 });
  if (ev && ev.type === 'link-added') {
    const g = [...root.querySelectorAll('[data-link-key]')].find((e) => e.dataset.linkKey === ev.link.key);
    if (g) {
      const color = theme.LINK_STYLE[ev.link.kind].color;
      const both = ev.link.kind === 'event';
      for (const p of g.querySelectorAll('path.sv-stroke, path.sv-halo')) {
        const L = p.getTotalLength ? p.getTotalLength() : 0;
        if (!L) continue;
        anim(p, both
          ? [{ strokeDasharray: `0 ${L} 0` }, { strokeDasharray: `${L / 2} 0 ${L / 2}` }]
          : [{ strokeDasharray: `0 ${L}` }, { strokeDasharray: `${L} 0` }], { duration: 560, easing: 'ease-in-out', delay: moved ? 300 : 0 });
      }
      for (const p of g.querySelectorAll('.sv-pop')) anim(p, [{ transform: 'scale(0)' }, { transform: 'scale(1.45)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 420, delay: (moved ? 300 : 0) + 380, fill: 'backwards', easing: 'ease-out' });
      for (const ref of [ev.link.from, ev.link.to]) {
        for (const pg of portEls.get(`${ref.subnet}|${ref.port}`) || []) for (const sh of pg.querySelectorAll('.sv-pulse')) anim(sh, [{ transform: 'scale(1)' }, { transform: 'scale(2)' }, { transform: 'scale(1)' }], { duration: 520, delay: (moved ? 300 : 0) + 420 });
        const rect = root.querySelector(`[data-box="${ref.subnet}"] rect.sv-rect`);
        anim(rect, [{ stroke: DV.STROKE, strokeWidth: 1.5 }, { stroke: color, strokeWidth: 3 }, { stroke: DV.STROKE, strokeWidth: 1.5 }], { duration: 850, delay: moved ? 300 : 0 });
      }
    }
  }
}

/** FLIP: animate each item from where the last render drew it. Returns whether anything moved. */
function flip(key, items, animate) {
  const prev = memory[key];
  memory[key] = Object.fromEntries(items.map((i) => [i.id, { x: i.x, y: i.y }]));
  if (!prev || !animate) return false;
  let moved = false;
  for (const it of items) {
    const p = prev[it.id];
    if (!p) {
      anim(it.el, [{ opacity: 0, transform: 'translate(0px,-18px)' }, { opacity: 1, transform: 'translate(0px,0px)' }], { duration: 650, easing: 'ease-out' });
      moved = true;
      continue;
    }
    const dx = p.x - it.x, dy = p.y - it.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
    moved = true;
    anim(it.el, [{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'translate(0px,0px)' }], { duration: 760, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  return moved;
}

function legendOrders(ctx, x0, y0, width) {
  const { svg, theme } = ctx;
  const g = svg('g', { class: 'sv-legend', 'font-size': 10, fill: '#444' });
  g.append(svg('line', { x1: x0, y1: y0 - 16, x2: x0 + width, y2: y0 - 16, stroke: '#e3e6ea' }));
  const colW = width / 4;
  const item = (i, draw, lines) => {
    const x = x0 + (i % 4) * colW, y = y0 + Math.floor(i / 4) * 34;
    g.append(svg('g', {}, draw(x, y), svg('text', { x: x + 34, y: y + (lines.length > 1 ? -2 : 3.5) }, lines.map((t, k) => svg('tspan', { x: x + 34, dy: k ? 12 : 0 }, t)))));
  };
  item(0, (x, y) => svg('rect', { x, y: y - 8, width: 26, height: 16, rx: DV.RX, fill: '#fff', stroke: DV.STROKE, 'stroke-width': DV.SW }), ['box: a pattern instance,', 'a morphism dom → cod']);
  item(1, (x, y) => svg('g', {}, svg('path', { d: `M${x + 13},${y - 12} L${x + 13},${y + 12}`, stroke: DV.WIRE, 'stroke-width': 1.5 }), svg('circle', { cx: x + 13, cy: y + 2, r: 4.6, fill: theme.schemaColor('resource') })), ['wire: a place port,', 'labelled by its schema']);
  item(2, (x, y) => svg('g', {}, svg('rect', { x: x + 4, y: y - 4.5, width: 9, height: 9, fill: theme.TRANSITION_PORT_COLOR }), svg('rect', { x: x + 16, y: y - 4.5, width: 9, height: 9, fill: theme.TRANSITION_PORT_COLOR })), ['transition port: in on the', 'left edge, out on the right']);
  item(3, (x, y) => svg('g', {}, svg('circle', { cx: x + 7, cy: y, r: 4.6, fill: theme.schemaColor('account') }), svg('circle', { cx: x + 7, cy: y, r: 1.6, fill: '#fff' }), svg('circle', { cx: x + 21, cy: y, r: 3.6, fill: '#fff', stroke: theme.schemaColor('queue:items'), 'stroke-width': 1.6 })), ['inout port (on both edges);', 'observe tap (right edge)']);
  item(4, (x, y) => svg('g', {}, svg('line', { x1: x, y1: y, x2: x + 26, y2: y, stroke: theme.LINK_STYLE.event.color, 'stroke-width': 2.6 }), glyph(ctx, 'event', x + 13, y, 7)), ['event link: the transitions', 'fuse (RenderDOT\'s ⊗)']);
  item(5, (x, y) => svg('g', {}, svg('line', { x1: x + 13, y1: y - 12, x2: x + 13, y2: y + 12, stroke: DV.WIRE, 'stroke-width': 1.5 }), glyph(ctx, 'token', x + 13, y, 6)), ['token link: one shared', 'place, wired out → in']);
  item(6, (x, y) => svg('g', {}, svg('line', { x1: x, y1: y, x2: x + 26, y2: y, stroke: theme.LINK_STYLE.guard.color, 'stroke-width': 1.8, 'stroke-dasharray': '6 4' }), glyph(ctx, 'guard', x + 13, y, 7)), ['guard link: flagged,', 'outside the free SMC']);
  item(7, (x, y) => svg('path', { d: `M${x},${y + 7} C${x + 18},${y + 7} ${x + 22},${y - 6} ${x + 26},${y - 6}`, stroke: DV.BACK, 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': DV.BACK_DASH, 'marker-end': 'url(#sv-arrow-back)' }), ['back edge: feedback,', 'round the right side']);
  ctx.hover(g, { title: 'legend: diagram-viewer.js conventions, extended', definition: 'Boxes, wires, port dots and back edges follow diagram-viewer.js; the link glyphs and colours are go-pflow RenderDOT\'s; transition ports and taps are this view\'s.', cites: [DVC.box, DVC.wires, DVC.back, LINK_STYLE_CITE], bib: ['selinger'] });
  return g;
}

// =====================================================================================
// ORDERS, transition level: diagram-viewer.js on the flat net, unmodified
// =====================================================================================

function dvModel(flatModel) {
  return {
    places: Object.fromEntries(flatModel.places.map((p) => [p.id, {}])),
    transitions: Object.fromEntries(flatModel.transitions.map((t) => [t.id, {}])),
    arcs: flatModel.arcs.filter((a) => a.type !== 'read').map((a) => ({ source: a.from, target: a.to, weight: [a.weight || 1], inhibitTransition: a.type === 'inhibitor' })),
  };
}

function parseSVG(str) {
  const doc = new DOMParser().parseFromString(str, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

function ordersTransition(ctx) {
  const { svg, theme } = ctx;
  const tw = ctx.textWidth;
  const flat = ctx.orders.flat;
  if (!flat.ok) {
    ctx.note(`bundle.flatten refuses this composition (${flat.error || flat.errors.map((e) => e.code).join(', ')}), so there is no flat net to draw.`, 'warn');
    return;
  }
  const m = flat.model;
  const reads = m.arcs.filter((a) => a.type === 'read');
  const diagram = translatePetriNet(dvModel(m));
  const str = generateSVG(diagram);
  const dvW = Math.max(diagram.width, 200), dvH = Math.max(diagram.height, 100);
  const OX = 24, OY = 64;
  const side = dvW <= 640;
  const capX = side ? OX + dvW + 36 : OX, capY = side ? OY : OY + dvH + 30, capW = side ? 1150 - capX - 24 : Math.max(1100, dvW) - 24;
  const byT = Object.fromEntries(m.transitions.map((t) => [t.id, t]));
  const byP = Object.fromEntries(m.places.map((p) => [p.id, p]));

  // Caption lines (built first so the root's height can fit them).
  const fused = m.transitions.filter((t) => t.members.length > 1);
  const wires = m.places.filter((p) => p.members.length > 1);
  const backN = diagram.wires.filter((w) => w.isBack).length;
  const para = [];
  const P = (text, opts = {}) => para.push({ text, ...opts });
  P('drawn by diagram-viewer.js, unmodified', { bold: true, size: 13 });
  P('pflow-xyz public/diagram-viewer.js (MIT), this repo\'s own module, imported unmodified. This view calls its translatePetriNet and generateSVG and inserts the SVG string as it comes.', { muted: true });
  P('Its convention, from its header comment (lines 1-5): transitions are boxes (morphisms), places are wire types (objects), arcs are typed ports and wires. Inputs sit on top, outputs below; a cycle is broken by DFS and its back edges go round the right side, dashed red.');
  P(`Input: ctx.orders.flat.model, the flat net the registry builds (bundle.flatten: pflow-compose's flatten_with_map, pflow-rs's port of go-pflow's FlattenWithMap): ${m.places.length} places, ${m.transitions.length} transitions, ${m.arcs.length - reads.length} arcs drawn.`);
  if (fused.length) P(`Fused boxes (${fused.length}): each is one event-link class, named fused:<sorted members> (compose_flatten.go:201-227): ${fused.map((t) => t.members.join(' ⊗ ')).join('; ')}.`, { color: theme.LINK_STYLE.event.color });
  else P('No event links, so no box is fused: every box is one subnet\'s transition.');
  if (wires.length) P(`Shared places (${wires.length}): wire:<representative>, from token or data links: ${wires.map((p) => p.members.join(' = ')).join('; ')}.`, { color: theme.LINK_STYLE.token.color });
  if (reads.length) P(`Left out: ${reads.length} read arc${reads.length === 1 ? '' : 's'} (guard links lowered to "> 0" by applyGuardLinks, compose_flatten.go:424-482): ${reads.map((a) => `${a.from} → ${a.to}`).join(', ')}. diagram-viewer.js knows only input and output arcs (buildBoxes, lines 20-60): it would draw a read arc as a consuming input, which it is not.`, { color: theme.LINK_STYLE.guard.color });
  else P('No guard links, so there are no read arcs to leave out (diagram-viewer.js has no read arcs: lines 20-60).', { muted: true });
  P(`${diagram.boxes.length} boxes in ${max0(diagram.boxes.map((b) => b.layer)) + 1} layers, ${diagram.wires.length} wires (${backN} back edges); boundary in: ${diagram.boundaryInputs.join(', ') || 'none'}; boundary out: ${diagram.boundaryOutputs.join(', ') || 'none'}.`, { muted: true });
  P('Where labels overlap (several boundary wires on one box edge), that is its output too: nothing is moved or redrawn.', { muted: true });
  P('Overlaid by this view, not part of its output: the small squares on the box edges are the pattern\'s transition ports (in on the left, out on the right), so event links can be dragged here as well. Place ports are not overlaid: here a place is a wire label, not a port, so token, data and guard links are made at the pattern level.', { muted: true });
  const capLines = [];
  for (const p of para) {
    const size = p.size || 11;
    for (const [i, t] of wrap(tw, p.text, capW, size).entries()) capLines.push({ t, size, bold: p.bold && i === 0 ? true : p.bold, muted: p.muted, color: p.color });
    capLines.push({ gap: true });
  }
  const capH = sum(capLines.map((l) => (l.gap ? 7 : (l.size || 11) + 4)));
  const W = Math.max(1150, OX + dvW + 24);
  const H = Math.max(OY + dvH + 24, capY + capH + 24, side ? 0 : OY + dvH + 30 + capH + 24);

  const root = ctx.svgRoot(W, H, { class: 'view-svg sv' });
  root.append(svg('rect', { width: W, height: H, fill: DV.PAPER }));
  root.append(svg('text', { x: OX, y: 28, 'font-size': 15, 'font-weight': 600, fill: '#2b2f36' }, `flat net of ${ctx.orders.subnets.map((s) => s.id).join(' ⊗ ')}`),
    svg('text', { x: OX, y: 48, 'font-size': 11, fill: '#6a717c' }, 'transition level: every transition a box, every place a wire type; what fusion does to the boxes is visible here'));
  const nested = parseSVG(str);
  nested.setAttribute('x', OX);
  nested.setAttribute('y', OY);
  const frame = svg('rect', { x: OX - 0.5, y: OY - 0.5, width: dvW + 1, height: dvH + 1, fill: 'none', stroke: '#dde1e6', rx: 4 });
  root.append(nested, frame);

  // Hover info on diagram-viewer.js's own elements, matched by their label text.
  const texts = [...nested.querySelectorAll('text')];
  for (const t of texts) {
    const label = t.textContent;
    const prev = t.previousElementSibling;
    if (byT[label] && prev && prev.tagName === 'rect') {
      const info = ctx.info.flatTransitionInfo(byT[label]);
      const full = { ...info, facts: [...info.facts, ['drawn by', 'diagram-viewer.js: a box (rx 6, white, #333), inputs on top, outputs below']], cites: [...info.cites, DVC.header, DVC.box] };
      ctx.hover(prev, full);
    } else if (byP[label]) {
      const info = ctx.info.flatPlaceInfo(byP[label]);
      const full = { ...info, title: `wire ${label}`, facts: [...info.facts, ['drawn by', 'diagram-viewer.js: a place is a wire type, the label of every wire it carries']], cites: [...info.cites, DVC.header, DVC.wires] };
      if (prev && prev.tagName === 'path') { prev.setAttribute('pointer-events', 'stroke'); prev.setAttribute('stroke-width', prev.getAttribute('stroke-width') || 1.5); ctx.hover(prev, full); }
      t.style.pointerEvents = 'all';
      ctx.hover(t, full);
    }
  }

  // Overlay: the pattern's transition ports on each box, so the snap works here too.
  const overlay = svg('g', { class: 'sv-overlay' });
  const boxRects = {};
  for (const b of diagram.boxes) {
    const t = byT[b.id];
    if (!t) continue;
    boxRects[b.id] = { x: OX + b.x, y: OY + b.y, w: b.width };
    const ports = [];
    for (const mem of t.members) {
      const i = mem.indexOf('/');
      const s = ctx.orders.byId[mem.slice(0, i)];
      const tid = mem.slice(i + 1);
      if (!s) continue;
      for (const p of s.ports) if (p.target === 'transition' && p.transition === tid) ports.push({ s, p });
    }
    for (const sideName of ['left', 'right']) {
      const list = ports.filter(({ p }) => (sideName === 'left') === (p.kind === 'in'));
      list.forEach(({ s, p }, i) => {
        const x = OX + b.x + (sideName === 'left' ? 0 : b.width);
        const y = OY + b.y + (DV.BOX_H * (i + 1)) / (list.length + 1);
        const pg = svg('g', { class: 'sv-port' },
          svg('rect', { x: x - 7, y: y - 6.5, width: 14, height: 13, fill: 'transparent', class: 'sv-hit' }),
          svg('rect', { x: x - 3.5, y: y - 3.5, width: 7, height: 7, fill: theme.portColor(p), stroke: '#fff', 'stroke-width': 1, class: 'sv-pulse' }));
        ctx.snap.port(pg, { subnet: s.id, port: p.id });
        const pi = ctx.info.portInfo(s, p);
        ctx.hover(pg, { ...pi, facts: [...pi.facts, ['on box', b.id], ['overlay', 'drawn by this view on top of diagram-viewer.js\'s box; not part of its output']] });
        overlay.append(pg);
      });
    }
  }
  root.append(overlay);

  // Caption.
  const cap = svg('g', { class: 'sv-caption' });
  let y = capY + 12;
  for (const l of capLines) {
    if (l.gap) { y += 7; continue; }
    cap.append(svg('text', { x: capX, y, 'font-size': l.size, 'font-weight': l.bold ? 600 : 400, fill: l.color || (l.muted ? '#6a717c' : '#2b2f36') }, l.t));
    y += l.size + 4;
  }
  ctx.hover(cap, { title: 'diagram-viewer.js (pflow-xyz, MIT), imported unmodified', definition: 'Petri net → string diagram: transitions are boxes, places are wire types, arcs are typed ports and wires.', cites: [DVC.header, DVC.boxes, DVC.cycles, DVC.layers, DVC.back, ...FLATTEN_CITES.slice(0, 3), goc('metamodel/compose_flatten.go', 424, 482, 'applyGuardLinks: a guard link becomes a read arc (or inhibitor, or guard conjunct)')], bib: ['selinger'] });
  root.append(cap);
  ctx.root.append(root);
  if (reads.length) ctx.note(`${reads.length} read arc${reads.length === 1 ? '' : 's'} from guard links ${reads.length === 1 ? 'is' : 'are'} left out: diagram-viewer.js draws only input and output arcs, and would show a read as a consuming input.`, 'na');

  // Merge animation: the boxes that fused slide from where they were into the fused box.
  const prev = memory['orders-transition'];
  const now = {};
  for (const t of m.transitions) if (boxRects[t.id]) for (const mem of t.members) now[mem] = boxRects[t.id];
  memory['orders-transition'] = now;
  const ev = ctx.event;
  if (prev && ev && ev.type === 'link-added') {
    const l = ev.link;
    const color = theme.LINK_STYLE[l.kind].color;
    const fs = ctx.orders.byId[l.from.subnet];
    const fp = fs?.ports.find((p) => p.id === l.from.port);
    if (l.kind === 'event' && fp) {
      const flatId = flat.map.transition[l.from.subnet]?.[fp.transition];
      const target = boxRects[flatId];
      const t = byT[flatId];
      if (target && t) {
        for (const mem of t.members) {
          const p = prev[mem];
          if (!p) continue;
          const ghost = svg('rect', { x: p.x, y: p.y, width: p.w, height: DV.BOX_H, rx: DV.RX, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '5,3' });
          overlay.append(ghost);
          const a = anim(ghost, [{ transform: 'translate(0px,0px)', opacity: 1 }, { transform: `translate(${target.x - p.x}px,${target.y - p.y}px)`, opacity: 0.9, offset: 0.8 }, { transform: `translate(${target.x - p.x}px,${target.y - p.y}px)`, opacity: 0 }], { duration: 820, easing: 'cubic-bezier(.3,.7,.2,1)' });
          if (a) a.onfinish = () => ghost.remove(); else ghost.remove();
        }
        const rect = [...nested.querySelectorAll('rect')].find((r) => r.nextElementSibling && r.nextElementSibling.textContent === flatId);
        anim(rect, [{ stroke: DV.STROKE, strokeWidth: 1.5 }, { stroke: color, strokeWidth: 3.5, offset: 0.75 }, { stroke: DV.STROKE, strokeWidth: 1.5 }], { duration: 900 });
      }
    } else {
      for (const t of texts) if (t.textContent.startsWith('wire:')) anim(t, [{ fill: DV.LABEL_FILL }, { fill: color, offset: 0.5 }, { fill: DV.LABEL_FILL }], { duration: 900 });
    }
  }
}

// =====================================================================================
// CONNECT-4, pattern level: the plan as ROADMAP Slice B draws it
// =====================================================================================

const C4 = {
  W: 1150, H: 778,
  memo: { x: 636, y: 56, w: 196, h: 44 },
  budget: { x: 40, y: 118, w: 888, h: 620 },
  nw: { x: 70, y: 160, w: 828, h: 548 },
  core: { x: 400, y: 272, w: 256, h: 262 },
  col: { x: 130, w: 160, top: 244, bh: 25, gap: 24 },
};

function c4Pattern(ctx) {
  const { svg, theme } = ctx;
  const tw = ctx.textWidth;
  const plan = ctx.plan.plan;
  const err = ctx.plan.error;
  const chain = chainOf(plan);
  const drv = driversOf(plan);
  const pieces = chain.err ? [] : chain.pieces;
  const nullWindow = !drv.err && drv.nullWindow;
  const budget = !drv.err ? drv.budget : null;
  const T = theme.SEARCH_TYPE_COLOR;
  const K = theme.PIECE_KIND_COLOR;
  const { W, H, core, col } = C4;
  const root = ctx.svgRoot(W, H, { class: 'view-svg sv' });
  root.append(defs(ctx), svg('rect', { width: W, height: H, fill: DV.PAPER, rx: 4 }));
  if (err) ctx.note(`pflow-rs refuses this plan (plan.state): ${err}`, 'warn');

  // Head: the composite, as the ROADMAP writes it (Solver = drivers ∘ core[order chain, filters, bounds, memo]).
  let expr = `alpha-beta[${pieces.length ? pieces.join(' · ') : '[]'}${plan.memo ? `, memo ${fmt(plan.memo.entries)}` : ''}]`;
  if (nullWindow) expr = `null_window(${expr})`;
  if (budget) expr = `budget(${expr})`;
  root.append(svg('text', { x: 40, y: 28, 'font-size': 15, 'font-weight': 600, fill: '#2b2f36' }, svg('tspan', {}, 'Solver = '), svg('tspan', { class: 'mono', 'font-size': 13.5 }, expr)),
    svg('text', { x: 40, y: 48, 'font-size': 11, fill: '#6a717c' }, `mode ${plan.mode || 'exact'} · ${err ? `refused by pflow-rs @${PLAN_RS_REV}` : `pflow-rs @${PLAN_RS_REV} SearchPlan::check and solver(connect-4) accept it (plan.state)`} · ${plan.mode === 'play' ? 'play parses, but solver() never reads the mode: it builds the same search as exact mode (plan.rs:242-251)' : 'drivers ∘ core[order chain, filters, bounds, memo] (ROADMAP Phase 6)'}`));

  const backG = svg('g', {}), wireG = svg('g', {}), frameG = svg('g', {}), boxG = svg('g', {}), slotG = svg('g', {}), labG = svg('g', {});
  const flipItems = [];
  const port = (x, y, color, r = DV.PORT_R) => svg('circle', { cx: x, cy: y, r, fill: color });
  const wireLabel = (x, y, text, anchor = 'start', color = DV.LABEL_FILL) => svg('text', { x, y, 'font-size': DV.LABEL, fill: color, 'text-anchor': anchor, 'paint-order': 'stroke', stroke: DV.PAPER, 'stroke-width': 3 }, text);
  const wireInfo = (type, definition, cites, extra = []) => ({ title: `wire ${type}`, concept: { iri: `${NS}WireType`, types: ['ns:WireType (PROPOSED, ROADMAP Phase 6)'] }, definition, facts: [['type', type], ...extra], cites: [...cites, ROAD.search] });
  const removeX = (x, y, onclick, label) => {
    const g = svg('g', { class: 'sv-x', onclick: (e) => { e.stopPropagation(); onclick(); } },
      svg('circle', { cx: x, cy: y, r: 7, fill: '#fff', stroke: '#d4d8dd' }),
      svg('text', { x, y: y + 3.5, 'text-anchor': 'middle', 'font-size': 11, fill: '#8a9099' }, '×'));
    g.append(svg('title', {}, label));
    return g;
  };

  // --- drivers: nested functor frames, outermost first. Read into flags (plan.rs:146-194);
  // the nesting is game.rs's: the node count is reset once per value() (541, 548) and
  // checked at every node (594-597), so budget wraps every yes/no search.
  const frame = (r, name, sub, kind, empty, onRemove, pieceName) => {
    const g = svg('g', { class: 'sv-frame', 'data-piece-el': pieceName || '' });
    if (pieceName) ctx.emit('frame', pieceName, {});
    g.append(svg('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 12, fill: empty ? 'none' : (kind === 'budget' ? 'rgba(47,111,179,0.035)' : 'rgba(47,111,179,0.05)'), stroke: K.Driver, 'stroke-width': empty ? 1.2 : 1.5, 'stroke-dasharray': empty ? '6,4' : null }));
    const label = `${name}${sub ? ' ' : ''}`;
    const tabW = tw(label, 11.5) + (sub ? tw(sub, 10) * 1.05 : 0) + 22 + (onRemove ? 18 : 0);
    const tab = svg('g', { class: 'sv-slotbox' },
      svg('rect', { x: r.x + 12, y: r.y - 11, width: tabW, height: 22, rx: 11, fill: '#fff', stroke: K.Driver, 'stroke-width': 1.2, 'stroke-dasharray': empty ? '4,3' : null }),
      svg('text', { x: r.x + 23, y: r.y + 4, 'font-size': 11.5, 'font-weight': 600, fill: K.Driver }, svg('tspan', { class: 'mono' }, name), sub ? svg('tspan', { class: 'mono', 'font-size': 10, 'font-weight': 400, fill: '#4a6f99' }, ` ${sub}`) : null));
    ctx.snap.slot(tab, 'drivers');
    const pi = pieceName ? ctx.info.pieceInfo(pieceName) : ctx.info.slotInfo('drivers');
    ctx.hover(tab, { ...pi, facts: [...(pi.facts || []), ['drawn as', empty ? 'an empty frame: no driver here' : 'a functor box (frame) around the search (ROADMAP: drivers are endomorphisms on search)'], ['ROADMAP op', 'op:wrap'], ['nesting', 'fixed by game.rs: budget counts the nodes of every yes/no search (value() resets the count, search() checks it)']], cites: [...(pi.cites || []), SEARCH_CITES.driversFlags, rs('game.rs', 541, 548, 'value(): nodes = 0 at the start, and again before the retry by counts'), SEARCH_CITES.budget, GR.solve, ROAD.search] });
    g.append(tab);
    if (onRemove) g.append(removeX(r.x + 12 + tabW - 12, r.y, onRemove, `remove ${name}`));
    if (empty) g.append(svg('text', { x: r.x + 24 + tabW, y: r.y + 18, 'font-size': 10, fill: '#6a717c' }, empty));
    frameG.append(g);
    return g;
  };
  const dIndex = (name) => (plan.drivers || []).findIndex((d) => (typeof d === 'string' ? d === name : d && d[name]));
  if (budget) frame(C4.budget, 'budget', `{"nodes": ${budget}}`, 'budget', null, () => ctx.actions.removePiece('drivers', dIndex('budget')), 'budget');
  // An absent drivers field stands for ["null_window"] (plan.rs:146-152); the model removes from that default too.
  if (nullWindow) frame(C4.nw, 'null_window', plan.drivers ? '' : '(default: on when drivers is not given)', 'nw', null, () => ctx.actions.removePiece('drivers', plan.drivers ? dIndex('null_window') : 0), 'null_window');
  else frame(C4.nw, 'drivers', '', 'nw', budget ? 'null_window off: drivers given without it, so one full-window search (plan.rs:17-18, game.rs:564-565)' : 'none: one full-window search, no budget (game.rs:564-565)', null, null);

  // --- the core: alpha-beta, Position → Value⊥ ---
  const cx = core.x, cy = core.y, cw = core.w, ch = core.h, cr = cx + cw, cb = cy + ch;
  const P = {
    pos: [cx + 50, cy], tt: [cx + 180, cy], store: [cx + 230, cy],
    ranked: [cx, cb - 16], cutoff: [cx, cb - 50],
    window: [cr, cy + 40], childIn: [cr, cy + 102],
    value: [cx + 100, cb], childOut: [cx + 220, cb],
  };
  const coreG = svg('g', { class: 'sv-body' },
    svg('rect', { x: cx, y: cy, width: cw, height: ch, rx: DV.RX, fill: '#fff', stroke: DV.STROKE, 'stroke-width': DV.SW, class: 'sv-rect' }),
    svg('text', { x: cx + cw / 2, y: cy + 118, 'text-anchor': 'middle', 'font-size': 15, 'font-weight': 600, fill: '#333' }, 'alpha-beta'),
    svg('text', { x: cx + cw / 2, y: cy + 136, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#333' }, svg('tspan', { fill: T.Position }, 'Position'), ' → ', svg('tspan', { fill: T['Value⊥'] }, 'Value⊥')),
    svg('text', { x: cx + cw / 2, y: cy + 154, 'text-anchor': 'middle', 'font-size': 10, fill: '#666', class: 'mono' }, 'Solver::search (game.rs:593-693)'),
    svg('text', { x: cx + cw / 2, y: cy + 168, 'text-anchor': 'middle', 'font-size': 9.5, fill: '#888' }, 'fail-soft, with the transposition table'));
  const inLab = (x, y, t, anchor = 'middle') => svg('text', { x, y, 'font-size': 9, fill: '#777', 'text-anchor': anchor }, t);
  coreG.append(inLab(P.pos[0], cy + 14, 'Position'), inLab(P.tt[0], cy + 14, 'tt.get'), inLab(P.store[0] + 4, cy + 26, 'store'),
    inLab(cx + 9, P.ranked[1] + 3, 'kids, best first', 'start'), inLab(cx + 9, P.cutoff[1] + 3, 'cutoff', 'start'),
    inLab(cr - 9, P.window[1] + 3, 'window (a, b)', 'end'), inLab(cr - 9, P.childIn[1] + 3, 'child values', 'end'),
    inLab(P.value[0], cb - 8, 'Value⊥'), inLab(P.childOut[0], cb - 8, 'v'));
  coreG.append(port(...P.pos, T.Position), port(...P.tt, T.Table), port(...P.store, T.Table), port(...P.ranked, T.MoveList), port(...P.cutoff, T.Cutoff),
    port(...P.window, T.Window), port(...P.childIn, T['Value⊥']), port(...P.value, T['Value⊥']), port(...P.childOut, T['Value⊥']));
  ctx.hover(coreG, {
    title: 'core: alpha-beta (Solver::search)', concept: { iri: `${NS}Box`, types: ['ns:Box (PROPOSED, ROADMAP Phase 6)'] },
    definition: 'Fail-soft alpha-beta in the +1 side\'s view. Inside the bounds every result is a bound on the true value; with the window the whole range, it is the value. (game.rs:590-592)',
    facts: [['dom → cod', 'Position → Value⊥ (ROADMAP Phase 6)'], ['⊥', 'None: past the budget (game.rs:594-597), or the bit engine spilled (637-639) and value() retries by counts (544-553)'], ['parameters', 'the order chain (MoveList), the memo (Table)'], ['ROADMAP op', 'op:fill: core[order chain, filters, bounds, memo]']],
    cites: [GR.search, GR.value, ROAD.search],
  });
  boxG.append(coreG);
  ctx.emit('box', 'core', {});

  // Position in (from the top boundary), Value⊥ out (to the bottom boundary).
  const vTap = [P.value[0], cb + 50];
  const posW = svg('g', { class: 'sv-wire' }, svg('path', { d: `M${P.pos[0]},60 C${P.pos[0]},120 ${P.pos[0]},${cy - 60} ${P.pos[0]},${cy}`, class: 'sv-stroke', stroke: DV.WIRE, 'stroke-width': 1.5, fill: 'none' }), svg('path', { d: `M${P.pos[0]},60 L${P.pos[0]},${cy}`, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 10 }), wireLabel(P.pos[0] + 6, 92, 'Position', 'start'));
  ctx.hover(posW, wireInfo('Position', 'A settled marking of the game net: the position whose value is asked for (Solver::value).', [GR.value]));
  const valW = svg('g', { class: 'sv-wire' }, svg('path', { d: `M${P.value[0]},${cb} L${P.value[0]},${H - 6}`, class: 'sv-stroke', stroke: DV.WIRE, 'stroke-width': 1.5, fill: 'none' }), svg('path', { d: `M${P.value[0]},${cb} L${P.value[0]},${H - 6}`, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 10 }), wireLabel(P.value[0] + 6, H - 22, 'Value⊥', 'start'), nullWindow ? svg('circle', { cx: vTap[0], cy: vTap[1], r: 3, fill: DV.STROKE }) : null);
  ctx.hover(valW, wireInfo('Value⊥', 'The exact value (+1 side\'s view) of a settled position with both sides playing perfectly, or None past budget nodes (game.rs:526-528).', [GR.value, SEARCH_CITES.budget], nullWindow ? [['the dot', 'each yes/no search\'s v also feeds the null-window loop (the dashed red back edge)']] : [['one search', 'no null_window: one search over the whole reward range gives the value (game.rs:564-565)']]));
  wireG.append(posW, valW);

  // --- the order chain on the core's parameter wire (MoveList → MoveList boxes) ---
  const colX = col.x + col.w / 2;
  const tops = pieces.map((_, i) => col.top + i * (col.bh + col.gap));
  const chainEnd = pieces.length ? tops[pieces.length - 1] + col.bh : col.top;
  const filtersY = chainEnd + col.gap, filtersB = filtersY + col.bh;
  const region = svg('g', { class: 'sv-slotbox' },
    svg('rect', { x: col.x - 22, y: col.top - 52, width: col.w + 44, height: chainEnd + 14 - (col.top - 52), rx: 10, fill: 'rgba(196,122,18,0.045)', stroke: K.Order, 'stroke-width': 1, 'stroke-dasharray': '3,3' }),
    svg('text', { x: col.x - 12, y: col.top - 38, 'font-size': 10.5, 'font-weight': 600, fill: K.Order }, chain.isDefault ? 'order chain (default)' : 'order chain'),
    svg('text', { x: col.x - 12, y: col.top - 26, 'font-size': 9, fill: '#8a6d3b' }, 'a monoid: [] is the identity'));
  ctx.snap.slot(region, 'order');
  const si = ctx.info.slotInfo('order');
  ctx.hover(region, { ...si, facts: [['pieces', pieces.length ? pieces.join(', ') : '[] (the identity)'], ['law (ROADMAP)', 'a monoid under chaining: [] is the identity, concatenation is associative, every composite stays ct:order-only'], ['partial in code (ROADMAP)', 'a repeated piece is refused (plan.rs:204-206) and a chain holds at most 8 pieces (order.rs:221-226)'], ['in code', 'one comparator over a key per piece, compared first-to-differ; decisive pieces form a top tier (order.rs:249-265)'], chain.isDefault ? ['default', `no "order" field: Chain::default, ${(PLAN_DEFAULTS.order || []).join(' · ')} (pflow-rs's default, read from plan.slot_candidates)`] : null, ['ROADMAP op', 'op:chain']].filter(Boolean), cites: [...si.cites, GR.chain, GR.decisive, SEARCH_CITES.orderOnly, rs('plan.rs', 204, 206, 'a piece listed twice is refused'), rs('order.rs', 220, 230, 'Chain::new: at most 8 pieces'), ROAD.search, PLAN_LAWS_CITE] });
  slotG.append(region);
  // The wire: from the top boundary of the chain, through every box, into the core's left edge.
  const chainW = svg('g', { class: 'sv-wire' });
  const segs = [[col.top - 16, pieces.length ? tops[0] : filtersY]];
  for (let i = 0; i + 1 < pieces.length; i++) segs.push([tops[i] + col.bh, tops[i + 1]]);
  if (pieces.length) segs.push([chainEnd, filtersY]);
  // The chain → filters segment crosses the chain region's border: it is labelled only when it is the wire's one segment.
  segs.forEach(([a, b], i) => chainW.append(svg('path', { d: `M${colX},${a} L${colX},${b}`, class: 'sv-stroke', stroke: DV.WIRE, 'stroke-width': 1.5 }), pieces.length && i === segs.length - 1 ? null : wireLabel(colX + 7, (a + b) / 2 + 3.5, 'MoveList')));
  const pd = `M${colX},${filtersB} C${colX},${P.ranked[1]} ${(colX + cx) / 2},${P.ranked[1]} ${cx},${P.ranked[1]}`;
  chainW.append(svg('path', { d: pd, class: 'sv-stroke', stroke: DV.WIRE, 'stroke-width': 1.5, fill: 'none' }), svg('path', { d: pd, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 10, fill: 'none' }));
  ctx.hover(chainW, wireInfo('MoveList', 'A node\'s moves (w.moves, game.rs:612-613), ranked by the chain\'s keys and tried best first (game.rs:634-643). Drawn as the core\'s parameter wire (ROADMAP Phase 6), not as a loop.', [rs('game.rs', 612, 643, 'moves, keyed by the chain, sorted')]));
  wireG.append(chainW);
  pieces.forEach((name, i) => {
    const y = tops[i];
    const p = ctx.plan.pieceByName[name];
    const g = svg('g', { class: 'sv-body sv-piece', 'data-piece-el': name });
    g.append(svg('rect', { x: col.x, y, width: col.w, height: col.bh, rx: DV.RX, fill: '#fff', stroke: DV.STROKE, 'stroke-width': DV.SW, class: 'sv-rect' }),
      svg('rect', { x: col.x + 1, y: y + 4, width: 3.5, height: col.bh - 8, rx: 1.5, fill: K.Order }),
      svg('text', { x: col.x + 12, y: y + col.bh / 2 + 4, 'font-size': 11.5, fill: '#333', class: 'mono' }, name),
      p && p.decisive ? svg('text', { x: col.x + col.w - 8, y: y + col.bh / 2 + 3, 'font-size': 8.5, fill: '#999', 'text-anchor': 'end' }, 'decisive') : null,
      port(colX, y, T.MoveList), port(colX, y + col.bh, T.MoveList));
    ctx.emit('chain', name, { index: i });
    const pi = ctx.info.pieceInfo(name);
    ctx.hover(g, { ...pi, facts: [...pi.facts, ['place in the chain', `${i + 1} of ${pieces.length}: compared ${i === 0 ? 'first' : 'after the ones above'} (highest priority first, plan.rs:15-16)`], ['drawn as', 'a box MoveList → MoveList on the core\'s parameter wire (ROADMAP Slice B)']], cites: [...pi.cites, GR.chain] });
    g.append(removeX(col.x - 12, y + col.bh / 2, () => ctx.actions.removePiece('order', i), `remove ${name} from the chain`));
    boxG.append(g);
    flipItems.push({ id: `piece:${name}`, el: g, x: col.x, y });
  });

  // Filters: an empty position on the same wire; heuristics beside it (none built).
  const emptySlot = (id, x, y, w, h, label, sub, onWire) => {
    // An absent list stands for pflow-rs's default (must_win for filters at this pin): the registry's, not the page's.
    const list = fieldOrDefault(plan, id);
    const isDefault = !Array.isArray(plan[id]) && list.length > 0;
    if (list.length) sub = isDefault ? 'default' : '';
    const g = svg('g', { class: 'sv-slotbox' },
      svg('rect', { x, y, width: w, height: h, rx: DV.RX, fill: '#fff', stroke: K[id === 'filters' ? 'Filter' : 'Heuristic'], 'stroke-width': 1.2, 'stroke-dasharray': '5,3' }),
      svg('text', { x: x + 10, y: y + h / 2 + 3.5, 'font-size': 10.5, fill: K[id === 'filters' ? 'Filter' : 'Heuristic'], class: 'mono' }, list.length ? list.join(', ') : label),
      svg('text', { x: x + w - 8, y: y + h / 2 + 3, 'font-size': 8.5, fill: '#999', 'text-anchor': 'end' }, sub),
      onWire ? [port(colX, y, T.MoveList), port(colX, y + h, T.MoveList)] : null);
    ctx.snap.slot(g, id);
    const s = ctx.info.slotInfo(id);
    ctx.hover(g, { ...s, facts: [['now', list.length ? `${list.join(', ')}${isDefault ? ` (the default an absent "${id}" stands for, pflow-rs @${PLAN_RS_REV})` : ''}` : 'empty'], ['which pieces fit', 'pflow-rs decides (plan.slot_candidates): a piece whose contract can change the value is refused in exact mode; drag one to see its verdict'], onWire ? ['drawn as', list.length ? 'a position on the MoveList wire holding the filters' : 'an empty position on the MoveList wire: an empty slot is the identity'] : ['drawn as', 'an empty position, wired to nothing: the ROADMAP gives heuristics no type']], cites: [...s.cites, ROAD.search] });
    slotG.append(g);
    return g;
  };
  emptySlot('filters', col.x, filtersY, col.w, col.bh, 'filters', 'empty', true);
  emptySlot('heuristics', col.x, cb + 22, col.w, col.bh, 'heuristics', 'empty', false);

  // Designed, never fillable: bounds (interval meet) and the engine (game.rs picks it).
  const ghost = (id, x, y, w, h, l1, l2, cites) => {
    const g = svg('g', { class: 'sv-slotbox', opacity: 0.75 },
      svg('rect', { x, y, width: w, height: h, rx: DV.RX, fill: 'rgba(255,255,255,0.6)', stroke: '#aab0b8', 'stroke-width': 1, 'stroke-dasharray': '1.5,3' }),
      svg('text', { x: x + 9, y: y + 15, 'font-size': 10.5, fill: '#7a828c', class: 'mono' }, l1),
      svg('text', { x: x + 9, y: y + 28, 'font-size': 8.5, fill: '#9aa1aa' }, l2));
    ctx.snap.slot(g, id);
    const s = ctx.info.slotInfo(id);
    ctx.hover(g, { ...s, facts: [['status', `designed in the ROADMAP; not a field of SearchPlan at ${PLAN_RS_REV}`], ['drawn as', 'a ghost: shown, never fillable']], cites: [...s.cites, ...cites] });
    slotG.append(g);
  };
  ghost('bounds', 712, cy - 44, 132, 36, 'bounds', 'designed: interval meet', [ROAD.search]);
  ghost('engine', col.x, cb + 74, col.w, 36, 'engine', 'designed: game.rs picks it itself', [rs('game.rs', 13, 21, 'BitModel or IndexedModel, chosen by value()'), rs('game.rs', 533, 553, 'value(): bits when the marking fits, else counts')]);
  slotG.append(svg('path', { d: `M${col.x + col.w},${cb + 92} C${cx - 30},${cb + 92} ${cx - 10},${cb + 10} ${cx + 8},${cb}`, stroke: '#aab0b8', 'stroke-width': 1, 'stroke-dasharray': '1.5,3', fill: 'none' }));
  // bounds would be a parameter of the core (ROADMAP: core[order chain, filters, bounds, memo]): a dotted lead to its top edge.
  slotG.append(svg('path', { d: `M712,${cy - 20} C${cr + 20},${cy - 20} ${cr - 12},${cy - 14} ${cr - 12},${cy}`, stroke: '#aab0b8', 'stroke-width': 1, 'stroke-dasharray': '1.5,3', fill: 'none' }));

  // --- memo: a side wire (Table) into the core, outside every frame: the table persists across calls ---
  const mm = C4.memo;
  const memoG = svg('g', { class: plan.memo ? 'sv-body' : 'sv-slotbox', 'data-piece-el': 'memo' });
  if (plan.memo) {
    memoG.append(svg('rect', { x: mm.x, y: mm.y, width: mm.w, height: mm.h, rx: DV.RX, fill: '#fff', stroke: DV.STROKE, 'stroke-width': DV.SW, class: 'sv-rect' }),
      svg('rect', { x: mm.x + 1, y: mm.y + 4, width: 3.5, height: mm.h - 8, rx: 1.5, fill: K.Memo }),
      svg('text', { x: mm.x + 14, y: mm.y + 18, 'font-size': 12, 'font-weight': 600, fill: '#333', class: 'mono' }, 'memo'),
      svg('text', { x: mm.x + 14, y: mm.y + 33, 'font-size': 10, fill: '#555', class: 'mono' }, `{"entries": ${plan.memo.entries}}`),
      removeX(mm.x + mm.w + 12, mm.y + mm.h / 2, () => ctx.actions.removePiece('memo', 0), 'remove the memo'));
  } else {
    memoG.append(svg('rect', { x: mm.x, y: mm.y, width: mm.w, height: mm.h, rx: DV.RX, fill: '#fff', stroke: K.Memo, 'stroke-width': 1.2, 'stroke-dasharray': '5,3' }),
      svg('text', { x: mm.x + 12, y: mm.y + 18, 'font-size': 11, fill: K.Memo, class: 'mono' }, 'memo: empty'),
      svg('text', { x: mm.x + 12, y: mm.y + 32, 'font-size': 8.5, fill: '#888' }, 'default table: cleared past 2M between calls'));
  }
  memoG.append(port(mm.x + 40, mm.y + mm.h, T.Table), port(mm.x + mm.w - 40, mm.y + mm.h, T.Table));
  ctx.snap.slot(memoG, 'memo');
  const mi = plan.memo ? ctx.info.pieceInfo('memo') : ctx.info.slotInfo('memo');
  ctx.hover(memoG, { ...mi, facts: [...(mi.facts || []), ['drawn as', 'a side wire (Table) into the core, outside both frames: the table persists across calls and is shared by every yes/no search (game.rs:23-28, 448-450)'], plan.memo ? ['bound', `${fmt(plan.memo.entries)} entries: cleared between calls past that, never grown past it inside one search (game.rs:495-505)`] : ['without a memo', 'the solver still has its table: cleared past 2,000,000 entries between calls, but one search may grow it without limit (game.rs:469-470, 495-500)']], cites: [...(mi.cites || []), rs('game.rs', 448, 466, 'Solver: tt, table, cap'), rs('game.rs', 469, 470, 'TABLE = 2_000_000'), rs('game.rs', 495, 505, 'with_memo')] });
  boxG.append(memoG);
  flipItems.push({ id: 'memo', el: memoG, x: mm.x, y: plan.memo ? mm.y : mm.y - 1 });
  const tableD = `M${mm.x + 40},${mm.y + mm.h} C${mm.x + 40},${mm.y + mm.h + 80} ${P.tt[0]},${cy - 90} ${P.tt[0]},${cy}`;
  const tableW = svg('g', { class: 'sv-wire' }, svg('path', { d: tableD, class: 'sv-stroke', stroke: DV.WIRE, 'stroke-width': 1.5, fill: 'none' }), svg('path', { d: tableD, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 10, fill: 'none' }), wireLabel(P.tt[0] + 34, cy - 70, 'Table', 'start'));
  ctx.hover(tableW, wireInfo('Table', 'The transposition table read at every node: an exact entry or a bound outside the window returns at once, otherwise the window narrows and the remembered best move goes first (game.rs:599-611).', [GR.ttRead], [['side wire', 'the memo is a parameter of the core, not inside the drivers (ROADMAP Slice B)']]));
  wireG.append(tableW);

  // --- back edges (dashed red, diagram-viewer.js style, each read from game.rs) ---
  const back = (d, label, lx, ly, anchor, info, key) => {
    const g = svg('g', { class: 'sv-back', 'data-back': key },
      svg('path', { d, class: 'sv-hitline', stroke: 'transparent', 'stroke-width': 12, fill: 'none' }),
      svg('path', { d, class: 'sv-stroke', stroke: DV.BACK, 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': DV.BACK_DASH, 'marker-end': 'url(#sv-arrow-back)' }));
    for (const [i, t] of label.entries()) g.append(svg('text', { x: lx, y: ly + i * 12, 'font-size': 9.5, fill: DV.BACK, 'text-anchor': anchor, 'paint-order': 'stroke', stroke: DV.PAPER, 'stroke-width': 3 }, t));
    ctx.hover(g, { ...info, facts: [...(info.facts || []), ['drawn as', 'a back edge: dashed #c44 (6,3) with an arrowhead, round the right side (diagram-viewer.js:490-501)']], cites: [...info.cites, DVC.back] });
    backG.append(g);
    ctx.emit('backedge', key === 'window' ? 'nullwindow' : key, {});
  };
  // the null-window loop: the value of each yes/no search moves i or j, and the next window is (vals[k], vals[k+1]).
  if (nullWindow) {
    back(ortho([[vTap[0], vTap[1]], [850, vTap[1]], [850, P.window[1]], [P.window[0] + 2, P.window[1]]], 14), ['null-window loop: each yes/no search', 'narrows the window (game.rs:561-588)'], vTap[0] + 14, vTap[1] + 16, 'start',
      { title: 'back edge: the null-window loop', definition: 'The value as a run of yes/no searches, one per gap between adjacent rewards: if v > (a + b) / 2 then i = k + 1 else j = k, and the next search gets the window (vals[k], vals[k+1]) (game.rs:573-587).', facts: [['driver', 'null_window'], ['carries', 'Window (a, b), from this search\'s v']], cites: [GR.solve] }, 'window');
  } else {
    labG.append(svg('text', { x: cr + 12, y: P.window[1] - 2, 'font-size': 9.5, fill: '#888' }, svg('tspan', { x: cr + 12 }, 'window: the whole reward range,'), svg('tspan', { x: cr + 12, dy: 12 }, 'once (game.rs:564-565)')));
  }
  // alpha-beta recursion: each child's value comes back into the search.
  back(ortho([[P.childOut[0], P.childOut[1]], [P.childOut[0], cb + 24], [692, cb + 24], [692, P.childIn[1]], [P.childIn[0] + 2, P.childIn[1]]], 12), ['recursion: each child\'s', 'value comes back', '(game.rs:653-669)'], 700, P.childIn[1] + 40, 'start',
    { title: 'back edge: alpha-beta recursion', definition: 'For each child, best first: v = search(next, a, b); the mover\'s bound moves to v, and a ≥ b is a cutoff (game.rs:653-669).', facts: [['carries', 'Value⊥ of a child position']], cites: [GR.search, rs('game.rs', 653, 669, 'the child loop')] }, 'recursion');
  // TT feedback: store (game.rs:515-519, called at 616-623 and 691) → the table → tt.get (601-611).
  back(`M${P.store[0]},${P.store[1]} C${P.store[0]},${cy - 110} ${mm.x + mm.w - 40},${mm.y + mm.h + 70} ${mm.x + mm.w - 40},${mm.y + mm.h + 3}`, ['store (game.rs:515-519)'], P.store[0] + 50, cy - 60, 'start',
    { title: 'back edge: the transposition-table feedback', definition: 'What a search finds is stored (space allowing) and read back by tt.get at the next visit of the position, in this search or a later one (store: game.rs:515-519, called at 616-623 and 691; read: 601-611).', facts: [['carries', 'Entry {lo, hi, best}']], cites: [SEARCH_CITES.store, GR.ttRead, rs('game.rs', 678, 691, 'merge with what was known, then store')] }, 'tt');
  // cutoff → history: chain.cutoff reports every cutoff to the pieces; only History records it.
  const hi = pieces.indexOf('history');
  if (hi >= 0) {
    const hy = tops[hi] + col.bh / 2;
    back(`M${P.cutoff[0]},${P.cutoff[1]} C${cx - 50},${P.cutoff[1]} ${col.x + col.w + 44},${hy} ${col.x + col.w + 3},${hy}`, ['game.rs:666'], cx - 6, P.cutoff[1] - 7, 'end',
      { title: 'back edge: cutoff → history', definition: 'A ≥ b: chain.cutoff(history, t) tells every piece; History adds one to the move\'s count (order.rs:73-75), which its key reads next time (order.rs:69-71).', facts: [['carries', 'the move that caused the cutoff']], cites: [SEARCH_CITES.cutoff, rs('order.rs', 267, 271, 'Chain::cutoff'), rs('order.rs', 68, 76, 'History')] }, 'cutoff');
  } else {
    labG.append(svg('text', { x: cx - 8, y: P.cutoff[1] - 8, 'font-size': 9, fill: '#888', 'text-anchor': 'end' }, 'cutoffs: no piece records them'));
  }

  // Legend (right column).
  const lg = svg('g', { 'font-size': 10, fill: '#444' });
  const LX = 948;
  let ly = 146;
  const li = (draw, lines) => { lg.append(draw(LX, ly)); lines.forEach((t, i) => lg.append(svg('text', { x: LX + 34, y: ly + 4 + i * 12 }, t))); ly += 16 + lines.length * 12; };
  lg.append(svg('text', { x: LX, y: ly - 18, 'font-size': 10.5, 'font-weight': 600, fill: '#2b2f36' }, 'reading the drawing'));
  li((x, y) => svg('rect', { x, y: y - 8, width: 26, height: 16, rx: DV.RX, fill: '#fff', stroke: DV.STROKE, 'stroke-width': DV.SW }), ['box: a morphism,', 'dom on top, cod below']);
  li((x, y) => svg('rect', { x, y: y - 9, width: 26, height: 18, rx: 7, fill: 'rgba(47,111,179,0.06)', stroke: K.Driver, 'stroke-width': 1.4 }), ['frame: a driver, a functor', 'box around the search']);
  li((x, y) => svg('rect', { x, y: y - 8, width: 26, height: 16, rx: DV.RX, fill: '#fff', stroke: K.Filter, 'stroke-width': 1.2, 'stroke-dasharray': '5,3' }), ['dashed: an empty slot', '(the identity)']);
  li((x, y) => svg('rect', { x, y: y - 8, width: 26, height: 16, rx: DV.RX, fill: '#fff', stroke: '#aab0b8', 'stroke-dasharray': '1.5,3' }), ['dotted ghost: designed,', 'not in plan.rs']);
  li((x, y) => svg('path', { d: `M${x},${y + 6} C${x + 18},${y + 6} ${x + 22},${y - 6} ${x + 26},${y - 6}`, stroke: DV.BACK, 'stroke-width': 1.5, fill: 'none', 'stroke-dasharray': DV.BACK_DASH, 'marker-end': 'url(#sv-arrow-back)' }), ['back edge: feedback', 'read from game.rs']);
  li((x, y) => svg('g', {}, svg('path', { d: `M${x + 13},${y - 10} L${x + 13},${y + 10}`, stroke: DV.WIRE, 'stroke-width': 1.5 }), port(x + 13, y, T.MoveList)), ['wire: its type is', 'the label (ns:WireType)']);
  const types = ['Position', 'Value⊥', 'MoveList', 'Table', 'Window', 'Cutoff'];
  types.forEach((t, i) => { lg.append(port(LX + 6, ly + i * 15, T[t]), svg('text', { x: LX + 16, y: ly + 3.5 + i * 15, 'font-size': 9.5, fill: '#555', class: 'mono' }, t)); });
  ly += types.length * 15 + 8;
  lg.append(svg('text', { x: LX, y: ly + 8, 'font-size': 9, fill: '#888' }, 'port dots: by type; × removes a piece'));
  ctx.hover(lg, { title: 'legend', definition: 'diagram-viewer.js boxes, wires and back edges; frames, slots and ghosts for the ROADMAP\'s plan drawing.', cites: [DVC.box, DVC.back, ROAD.search, ROAD.sliceB], bib: ['selinger'] });

  root.append(frameG, wireG, slotG, backG, boxG, labG, lg);
  ctx.root.append(root);

  // --- animation: a piece slides into its slot; the chain re-flows ---
  const ev = ctx.event;
  const moved = flip('c4-pattern', flipItems, ev && ['piece-added', 'piece-removed', 'piece-moved', 'plan-reset'].includes(ev.type));
  if (ev && ev.type === 'piece-added') {
    const el = root.querySelector(`[data-piece-el="${ev.name}"]`);
    const color = K[ev.piece?.kind] || '#555';
    if (ev.slot === 'order' && el) anim(el, [{ transform: 'translate(-90px,0px)', opacity: 0 }, { transform: 'translate(8px,0px)', opacity: 1, offset: 0.75 }, { transform: 'translate(0px,0px)', opacity: 1 }], { duration: 760, easing: 'cubic-bezier(.2,.8,.2,1)' });
    else if (ev.slot === 'memo' && el) anim(el, [{ transform: 'translate(0px,-40px)', opacity: 0 }, { transform: 'translate(0px,4px)', opacity: 1, offset: 0.75 }, { transform: 'translate(0px,0px)' }], { duration: 760, easing: 'cubic-bezier(.2,.8,.2,1)' });
    else if (ev.slot === 'drivers' && el) {
      const r = el.querySelector('rect');
      if (r) { r.classList.add('sv-pop'); anim(r, [{ transform: 'scale(0.9)', opacity: 0 }, { transform: 'scale(1.01)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)' }], { duration: 800, easing: 'cubic-bezier(.2,.8,.2,1)' }); }
    }
    const rect = el && el.querySelector('rect.sv-rect');
    if (rect) anim(rect, [{ stroke: DV.STROKE }, { stroke: color, strokeWidth: 3, offset: 0.6 }, { stroke: DV.STROKE, strokeWidth: 1.5 }], { duration: 900 });
  }
  if (moved) anim(backG, [{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], { duration: 760 });
}

// =====================================================================================
// CONNECT-4, transition level: diagram-viewer.js on the whole net, with an overview and a lens
// =====================================================================================

function c4Compute(net) {
  if (c4 && c4.net === net) return c4;
  const t0 = performance.now();
  const diagram = translatePetriNet(net);
  const t1 = performance.now();
  const str = generateSVG(diagram);
  const t2 = performance.now();
  const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml' }));
  const arcsIn = {}, arcsOut = {};
  for (const a of net.arcs) {
    if (net.transitions[a.target]) (arcsIn[a.target] ||= []).push(a);
    if (net.transitions[a.source]) (arcsOut[a.source] ||= []).push(a);
  }
  c4 = { net, diagram, str, url, arcsIn, arcsOut, msTranslate: t1 - t0, msSvg: t2 - t1, inline: null, msInline: null, lensY: 0 };
  return c4;
}

function c4TransitionInfo(ctx, cc, id) {
  const t = cc.net.transitions[id] || {};
  const ins = cc.arcsIn[id] || [], outs = cc.arcsOut[id] || [];
  return {
    title: `transition ${id} (Connect-4 net)`,
    concept: { iri: `${NS}Transition`, types: ['ns:Transition'] },
    facts: [
      ['role', t.role || 'default'],
      ['inputs (top ports)', ins.map((a) => `${a.source}${a.inhibitTransition ? ' (inhibitor)' : ''}`).join(', ') || 'none'],
      ['outputs (bottom ports)', outs.map((a) => a.target).join(', ') || 'none'],
      ['drawn by', 'diagram-viewer.js, unmodified: a box; places are the labels of its wires'],
    ],
    cites: [FIXTURE, DVC.header, DVC.box],
  };
}

function c4Transition(ctx) {
  const { svg } = ctx;
  const net = ctx.connect4.net;
  if (!net) { ctx.note('assets/connect-4.json did not load, so there is no net to draw.', 'warn'); return; }
  const cc = c4Compute(net);
  const d = cc.diagram;
  const dW = Math.max(d.width, 200), dH = Math.max(d.height, 100);
  const W = 1150, OY = 78, OX = 24;
  const nCols = 5, gap = 10, ovW = 520, ovH = 690;
  const k = Math.min((ovW - (nCols - 1) * gap) / (nCols * dW), (ovH * nCols) / dH);
  const sliceH = dH / nCols, colW = dW * k, colH = sliceH * k;
  const LX = OX + nCols * colW + (nCols - 1) * gap + 30;
  const lensW = Math.min(dW, W - LX - 20), lensH = Math.round(colH);
  const H = OY + Math.max(colH, lensH) + 34;
  const back = d.wires.filter((w) => w.isBack).length, cross = d.wires.filter((w) => w.isCrossing).length;
  const layers = max0(d.boxes.map((b) => b.layer)) + 1;
  const mb = (cc.str.length / 1e6).toFixed(1);

  const root = ctx.svgRoot(W, H, { class: 'view-svg sv' });
  root.append(svg('rect', { width: W, height: H, fill: DV.PAPER }));
  root.append(svg('text', { x: OX, y: 26, 'font-size': 15, 'font-weight': 600, fill: '#2b2f36' }, `diagram-viewer.js on the Connect-4 net, unmodified`),
    svg('text', { x: OX, y: 46, 'font-size': 11, fill: '#555' }, `${Object.keys(net.places).length} places, ${Object.keys(net.transitions).length} transitions, ${net.arcs.length} arcs → ${d.boxes.length} boxes in ${layers} layers, ${fmt(d.wires.length)} wires (${fmt(back)} back edges, ${fmt(cross)} marked crossing), ${fmt(Math.round(dW))} × ${fmt(Math.round(dH))} px, ${mb} MB of SVG`),
    svg('text', { x: OX, y: 66, 'font-size': 10.5, fill: '#6a717c' }, `overview: the whole output in ${nCols} columns at ${(k * 100).toFixed(1)}% (top to bottom, then left to right)`),
    svg('text', { x: LX, y: 66, 'font-size': 10.5, fill: '#6a717c' }, 'lens: the same output at 1:1 (scroll here, or click / drag the overview)'));

  // Overview: the same SVG, as an image, cut into columns.
  const ov = svg('g', { class: 'sv-ov' });
  for (let i = 0; i < nCols; i++) {
    const x = OX + i * (colW + gap);
    ov.append(svg('rect', { x: x - 0.5, y: OY - 0.5, width: colW + 1, height: colH + 1, fill: '#fff', stroke: '#d4d8dd' }),
      svg('svg', { x, y: OY, width: colW, height: colH, viewBox: `0 ${i * sliceH} ${dW} ${sliceH}`, preserveAspectRatio: 'none' }, svg('image', { href: cc.url, x: 0, y: 0, width: dW, height: dH })),
      svg('text', { x: x + colW / 2, y: OY + colH + 14, 'font-size': 9, fill: '#888', 'text-anchor': 'middle' }, `layers ${layerRange(d, i * sliceH, (i + 1) * sliceH)}`));
  }
  const lensRects = svg('g', {});
  ov.append(lensRects);
  ctx.hover(ov, { title: 'diagram-viewer.js output for the Connect-4 net, scaled', definition: `Its own translatePetriNet + generateSVG, unmodified, drawn as an image at ${(k * 100).toFixed(1)}% in ${nCols} columns. At this size its 12px box labels are about ${(12 * k).toFixed(1)}px: the overview shows the shape (a ${layers}-layer column with back edges down its right side), not the boxes.`, facts: [['translate', `${cc.msTranslate.toFixed(0)} ms`], ['generateSVG', `${cc.msSvg.toFixed(0)} ms`], ['size', `${fmt(Math.round(dW))} × ${fmt(Math.round(dH))} px, ${mb} MB`]], cites: [FIXTURE, DVC.header, DVC.layers, DVC.back] });

  // Lens: the real SVG elements (parsed once, reused), seen through a 1:1 viewport.
  let msInline = cc.msInline;
  if (!cc.inline) {
    const t0 = performance.now();
    cc.inline = parseSVG(cc.str);
    for (const t of cc.inline.querySelectorAll('text')) {
      const prev = t.previousElementSibling;
      if (prev && prev.tagName === 'rect' && net.transitions[t.textContent]) ctx.hover(prev, c4TransitionInfo(ctx, cc, t.textContent));
    }
    msInline = cc.msInline = performance.now() - t0;
  }
  const lens = svg('svg', { x: LX, y: OY, width: lensW, height: lensH, viewBox: `0 ${cc.lensY} ${lensW} ${lensH}` });
  lens.append(cc.inline);
  const lensFrame = svg('rect', { x: LX - 0.5, y: OY - 0.5, width: lensW + 1, height: lensH + 1, fill: 'none', stroke: '#9aa1aa', rx: 3 });
  const lensInfo = svg('text', { x: LX + lensW, y: OY + lensH + 16, 'font-size': 9.5, fill: '#888', 'text-anchor': 'end' });
  root.append(ov, lens, lensFrame, lensInfo);

  const setLens = (y) => {
    cc.lensY = Math.max(0, Math.min(dH - lensH, y));
    lens.setAttribute('viewBox', `0 ${cc.lensY} ${lensW} ${lensH}`);
    lensRects.replaceChildren();
    for (let i = 0; i < nCols; i++) {
      const a = Math.max(cc.lensY, i * sliceH), b = Math.min(cc.lensY + lensH, (i + 1) * sliceH);
      if (b <= a) continue;
      const x = OX + i * (colW + gap);
      lensRects.append(svg('rect', { x: x - 2, y: OY + (a - i * sliceH) * k, width: colW + 4, height: Math.max(3, (b - a) * k), fill: 'rgba(47,111,179,0.16)', stroke: '#2f6fb3', 'stroke-width': 1.2, class: 'sv-lens-rect' }));
    }
    lensInfo.textContent = `y ${fmt(Math.round(cc.lensY))}–${fmt(Math.round(cc.lensY + lensH))} of ${fmt(Math.round(dH))} · layers ${layerRange(d, cc.lensY, cc.lensY + lensH)}`;
  };
  setLens(cc.lensY);
  const toDiagramY = (e) => {
    const m = root.getScreenCTM();
    if (!m) return null;
    const pt = root.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const p = pt.matrixTransform(m.inverse());
    const i = Math.max(0, Math.min(nCols - 1, Math.floor((p.x - OX + gap / 2) / (colW + gap))));
    return i * sliceH + Math.max(0, Math.min(colH, p.y - OY)) / k;
  };
  ov.addEventListener('pointerdown', (e) => { lensDrag = true; const y = toDiagramY(e); if (y !== null) setLens(y - lensH / 2); e.preventDefault(); });
  ov.addEventListener('pointermove', (e) => { if (!lensDrag) return; const y = toDiagramY(e); if (y !== null) setLens(y - lensH / 2); });
  lens.addEventListener('wheel', (e) => { e.preventDefault(); setLens(cc.lensY + e.deltaY); }, { passive: false });

  ctx.root.append(root);
  const total = cc.msTranslate + cc.msSvg + (msInline || 0);
  ctx.note(`Unreadable at stage size, so this is a scaled overview with a 1:1 lens, not a fit-to-width drawing. diagram-viewer.js lays the Connect-4 net out as one column of ${layers} layers, ${fmt(Math.round(dW))} × ${fmt(Math.round(dH))} px, with ${fmt(d.wires.length)} wires; fitted to this stage its labels would be under 2 px. Layout ${cc.msTranslate.toFixed(0)} ms, SVG ${cc.msSvg.toFixed(0)} ms, parsing into the page ${msInline ? `${msInline.toFixed(0)} ms` : '(cached)'}${total > 2000 ? ': over 2 s, slow' : ''}. Both panes show its output as it comes, nothing redrawn. This level is the net the plan searches, not the plan, so it has no slots: drop pieces at the pattern level.`, 'na');
}

function layerRange(d, y0, y1) {
  let lo = Infinity, hi = -Infinity;
  for (const b of d.boxes) if (b.y + DV.BOX_H >= y0 && b.y <= y1) { lo = Math.min(lo, b.layer); hi = Math.max(hi, b.layer); }
  return lo === Infinity ? '–' : (lo === hi ? `${lo}` : `${lo}–${hi}`);
}
