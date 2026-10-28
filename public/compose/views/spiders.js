// View 2: sync points as spiders (ZX-style).
//
// Only the SHAPE of ZX-calculus spider fusion is borrowed (Coecke-Duncan,
// arXiv 0906.4725). What justifies it is go-pflow's Flatten: transition classes
// (event links) and place classes (token/data links) are computed by two
// separate union-finds whose representative is the smallest member
// (metamodel/unionfind.go; compose_fuse.go:9-20; compose_flatten.go:55-88,
// 201-227). A green spider is one transition class, a red spider one place
// class, labelled with the flat name ctx.orders.flat.map gives it. Nothing here
// decides a class: the classes, members and names are read from ctx.orders.flat.
//
// Connect-4: a plan has no event links, so nothing fuses. The nearest honest
// picture is the plan's two pieces of shared state (transposition table,
// history table) as junctions, hollow dots that are explicitly not spiders,
// with a leg to each part of the plan that game.rs / order.rs show touching them.

import { chainOf, driversOf } from '../model.js';
import { parsePortKey } from '../model.js';
import { cite } from '../sources.js';

const NS = 'http://www.w3.org/2000/svg';
const go = (path, a, b = a, note = '') => cite('goPflow', path, a, b, note);
const rs = (path, a, b = a, note = '') => cite('pflowRs', `crates/pflow-metamodel/src/${path}`, a, b, note);
const ttl = (a, b = a, note = '') => cite('ontology', 'ns/patterns.ttl', a, b, note);
const road = (a, b = a, note = '') => cite('ontologyRoadmap', 'ROADMAP.md', a, b, note);

// Every line below was read at the cited revision (go-pflow 69257b3, identical at
// c802f34; pflow-rs c396d46; ontology bc4a996; ROADMAP f854116).
const C = {
  ufDoc: go('metamodel/unionfind.go', 5, 14, 'the representative is the lexicographically smallest member, so Flatten is associative'),
  ufUnion: go('metamodel/unionfind.go', 44, 55, 'union: the smaller root wins'),
  fuseDoc: go('metamodel/compose_fuse.go', 9, 20, 'fusion over equivalence classes, not pairwise; a cycle a↔b is one two-member class'),
  placeClasses: go('metamodel/compose_flatten.go', 55, 70, 'place classes: token and data links, one union-find'),
  transClasses: go('metamodel/compose_flatten.go', 72, 88, 'transition classes: event links, a second union-find'),
  flatNames: go('metamodel/compose_flatten.go', 201, 227, 'flat names: wire:<smallest member>, fused:<sorted members joined by +>'),
  dot: go('metamodel/composedot.go', 28, 33, 'RenderDOT colours and glyphs per link kind'),
  tokenDir: go('metamodel/compose.go', 676, 683, 'token link direction rule, checked by Validate before Flatten'),
  leak: ttl(493, 497, 'pat:idiom-pool-release-saga-commit and its caveat'),
  roadSpider: road(410, 411, 'lk:event: draw it as a synchronising spider joining two boxes'),
  roadLeak: road(481, 482, 'the pool-leak caveat as a red annotation on the release ⊗ commit spider'),
  roadScenario: road(289, 291, '4.4: the rollback scenario fails with the pool-leak evidence'),
  // pflow-rs @c396d46
  ttShared: rs('game.rs', 23, 28, 'the yes/no searches share one transposition table, which persists across calls'),
  entry: rs('game.rs', 440, 444, 'Entry { lo, hi, best }'),
  fields: rs('game.rs', 454, 455, 'Solver.tt and Solver.history'),
  tableDefault: rs('game.rs', 469, 470, 'TABLE: cleared past 2,000,000 entries by default'),
  histInit: rs('game.rs', 485, 485, 'history: one counter per transition'),
  capDefault: rs('game.rs', 489, 490, 'table: TABLE, cap: usize::MAX (no cap inside a search)'),
  withMemo: rs('game.rs', 495, 505, 'with_memo: sets table and cap'),
  store: rs('game.rs', 514, 519, 'store: remember what a search found, space allowing (checks cap)'),
  clear: rs('game.rs', 529, 531, 'value(): the table is cleared past `table` between calls'),
  solveOne: rs('game.rs', 564, 566, 'solve: one search over the whole reward range when null_window is off'),
  ttRead: rs('game.rs', 601, 611, 'tt.get: bounds lo/hi and the remembered best move (first = e.best)'),
  storeLeaf: rs('game.rs', 616, 623, 'store at a final position'),
  ctxBuild: rs('game.rs', 628, 633, 'Ctx { first, history: &self.history }'),
  cutoff: rs('game.rs', 666, 666, 'chain.cutoff(&mut self.history, t): a cutoff is reported to the pieces'),
  storeAfter: rs('game.rs', 679, 691, 'merge with the old entry, then store'),
  search: rs('game.rs', 590, 693, 'Solver::search: fail-soft alpha-beta'),
  ctxDoc: rs('order.rs', 15, 24, 'Ctx: what a piece may read (first, history)'),
  cutoffDefault: rs('order.rs', 36, 37, 'Orderer::cutoff: a no-op unless a piece overrides it'),
  ttBestKey: rs('order.rs', 52, 58, 'TtBest::key: t == cx.first'),
  histKey: rs('order.rs', 68, 71, 'History::key reads cx.history[t]'),
  histCutoff: rs('order.rs', 73, 75, 'History::cutoff: history[t] += 1, the only writer'),
  chainCutoff: rs('order.rs', 267, 271, 'Chain::cutoff calls every piece\'s cutoff'),
  chainTies: rs('order.rs', 197, 199, 'ties keep the net\'s own order of the moves'),
  chainDefault: rs('order.rs', 205, 216, 'Chain::default: tt_best, immediate_win, history'),
  planFixed: rs('plan.rs', 3, 4, 'the search is fixed; a plan chooses what swaps in'),
  planDrivers: rs('plan.rs', 17, 19, 'null_window on by default, off when drivers is given without it'),
  planMemo: rs('plan.rs', 247, 249, 'solver(): with_memo when the plan has a memo'),
  planCheck: rs('plan.rs', 216, 238, 'check: exact mode refuses filters and heuristics'),
};

const BIB = ['coecke-duncan', 'coecke-kissinger', 'bruni-et-al'];

// Module state: the last orders layout (for animating what a change did), and
// the replay hook the button calls.
let prevLayout = null;
let lastExample = null;
let replay = null;

const reduced = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

// --- small geometry helpers -------------------------------------------------------

const curveX = (x1, y1, x2, y2) => { const mx = (x1 + x2) / 2; return `M${r1(x1)},${r1(y1)} C${r1(mx)},${r1(y1)} ${r1(mx)},${r1(y2)} ${r1(x2)},${r1(y2)}`; };
const curveY = (x1, y1, x2, y2) => { const my = (y1 + y2) / 2; return `M${r1(x1)},${r1(y1)} C${r1(x1)},${r1(my)} ${r1(x2)},${r1(my)} ${r1(x2)},${r1(y2)}`; };
const r1 = (v) => Math.round(v * 10) / 10;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const monoW = (s, size) => String(s).length * size * 0.61;
const sansW = (s, size) => String(s).length * size * 0.54;
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function cubicPoints(x1, y1, x2, y2, n = 18) {
  const mx = (x1 + x2) / 2, pts = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, u = 1 - t;
    pts.push({ x: u * u * u * x1 + 3 * u * u * t * mx + 3 * u * t * t * mx + t * t * t * x2, y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2 });
  }
  return pts;
}

/**
 * Where a w x h block goes near a spider at (sx, sy): the spots beside it first,
 * then rings further out, scored by what it would cover (Obstacles.cost), then
 * by distance; 'side' prefers the outer side, 'below' prefers under the spider.
 * Returns {x, y, w, h, d}; d > 0 means the block needs a leader line.
 */
function placeBlock(obs, sx, sy, w, h, side, band, prefer) {
  const near = prefer === 'below'
    ? [[-w / 2 + 20 * side, 22], [8 * side, 26], [-w / 2, 26]]
    : side > 0
      ? [[19, -h / 2], [19, 9], [19, -h - 9], [-w / 2, 19], [-w / 2, -19 - h]]
      : [[-19 - w, -h / 2], [-w / 2, 19], [-w / 2, -19 - h], [-19 - w, 9], [-19 - w, -h - 9]];
  const cands = near.map(([dx, dy], i) => ({ x: sx + dx, y: sy + dy, w, h, d: 0, i }));
  let i = cands.length;
  for (let rr = 34; rr <= 320; rr += 14) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const px = sx + ca * rr, py = sy + sa * rr;
      const x = Math.abs(ca) < 0.3 ? px - w / 2 : ca > 0 ? px : px - w;
      const y = Math.abs(sa) < 0.3 ? py - h / 2 : sa > 0 ? py : py - h;
      cands.push({ x, y, w, h, d: rr, i: i++ });
    }
  }
  let best = null, bk = Infinity;
  for (const c of cands) {
    if (c.x < band.x0 || c.x + c.w > band.x1) continue;
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let pen = 0;
    if (prefer === 'side' && (cx - sx) * side < -4) pen += 60;
    if (prefer === 'below' && cy < sy) pen += 120;
    const k = obs.cost(c) * 100000 + (c.d + pen) * 10 + c.i * 0.001;
    if (k < bk) { bk = k; best = c; }
  }
  return best || { x: sx + 19 * side, y: sy - h / 2, w, h, d: 0 };
}

/** The point of rect r nearest to (x, y). */
function nearestOn(r, x, y) {
  return { x: Math.max(r.x, Math.min(x, r.x + r.w)), y: Math.max(r.y, Math.min(y, r.y + r.h)) };
}

/** Points along a cubic given as [x0,y0,x1,y1,x2,y2,x3,y3]. */
function cubicAt([x0, y0, x1, y1, x2, y2, x3, y3], n = 30) {
  const pts = [];
  for (let i = 1; i < n; i++) {
    const t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    pts.push({ x: a * x0 + b * x1 + c * x2 + d * x3, y: a * y0 + b * y1 + c * y2 + d * y3 });
  }
  return pts;
}

class Obstacles {
  constructor(bounds) { this.rects = []; this.pts = []; this.bounds = bounds; }
  rect(r) { this.rects.push(r); }
  points(ps) { this.pts.push(...ps); }
  cost(r) {
    const b = this.bounds;
    let n = 0;
    if (r.x < b.x || r.y < b.y || r.x + r.w > b.x + b.w || r.y + r.h > b.y + b.h) n += 1000;
    for (const q of this.rects) if (overlap(r, q)) n += 400;
    for (const p of this.pts) if (p.x >= r.x - 8 && p.x <= r.x + r.w + 8 && p.y >= r.y - 6 && p.y <= r.y + r.h + 6) n += 1;
    return n;
  }
  best(cands) {
    let best = null, bc = Infinity;
    for (const c of cands) { const k = this.cost(c); if (k < bc) { bc = k; best = c; } if (k === 0) break; }
    return best;
  }
}

// --- animation helpers (SMIL for path geometry, Web Animations for the rest) ------

// Path geometry: Web Animations on the CSS `d` property where the browser has it
// (one clock with the spiders' transforms); SMIL <animate attributeName="d">
// otherwise, started when the Web Animations clock is (see run()).
const CSS_D = (() => { try { return CSS.supports('d', 'path("M0,0 L1,1")'); } catch { return false; } })();

function smilD(path, values, keyTimes, dur) {
  const n = values.length - 1;
  if (CSS_D && path.animate) {
    const frames = values.map((v, i) => ({ offset: keyTimes[i], d: `path("${v}")`, easing: i === n - 1 ? EASE : 'linear' }));
    return () => path.animate(frames, { duration: dur, fill: 'none' });
  }
  const a = document.createElementNS(NS, 'animate');
  a.setAttribute('attributeName', 'd');
  a.setAttribute('values', values.join(';'));
  a.setAttribute('keyTimes', keyTimes.join(';'));
  a.setAttribute('dur', `${dur}ms`);
  a.setAttribute('begin', 'indefinite');
  a.setAttribute('fill', 'remove');
  a.setAttribute('calcMode', 'spline');
  a.setAttribute('keySplines', Array.from({ length: n }, (_, i) => (i === n - 1 ? '0.45 0 0.2 1' : '0 0 1 1')).join(';'));
  path.appendChild(a);
  // Hold the first keyframe until the animation begins, so nothing flickers.
  const final = path.getAttribute('d');
  path.setAttribute('d', values[0]);
  const start = () => {
    try { a.beginElement(); } catch { /* detached */ }
    path.setAttribute('d', final);
    setTimeout(() => a.remove(), dur + 80);
  };
  start.smil = true;
  return start;
}

function waapi(el, frames, dur, after) {
  return () => {
    if (!el.animate) return null;
    const an = el.animate(frames, { duration: dur, fill: 'none' });
    if (after) an.onfinish = after;
    return an;
  };
}

const EASE = 'cubic-bezier(0.45, 0, 0.2, 1)';

// --- the view ---------------------------------------------------------------------

const STYLE = `
.spiders-view { --sp-g: #227744; --sp-r: #aa3333; }
.spiders-view .sp-bar { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; margin: 0 0 6px; font-size: 12px; color: var(--muted); }
.spiders-view .sp-btn { font: inherit; border: 1.5px solid var(--sp-g); color: var(--sp-g); background: #fff; border-radius: 6px; padding: 3px 11px; cursor: pointer; font-weight: 600; }
.spiders-view .sp-btn:hover { background: #eef6f0; }
.spiders-view .sp-btn[disabled] { opacity: 0.4; cursor: default; }
.spiders-view .sp-mono { font-family: var(--font-mono); }
.spiders-view .sp-halo { paint-order: stroke; stroke-width: 4px; stroke-linejoin: round; }
.spiders-view .sp-fx { pointer-events: none; }
.spiders-view .sp-leg-hit { fill: none; stroke: transparent; stroke-width: 12px; pointer-events: stroke; }
.spiders-view .sp-legs path.sp-leg { pointer-events: none; }
.spiders-view .sp-spider .inspectable:hover circle, .spiders-view .sp-junction.inspectable:hover circle { filter: drop-shadow(0 0 3px rgba(0,0,0,0.35)); }
.spiders-view .sp-chip-x { cursor: pointer; }
.spiders-view .sp-chip-x:hover rect { fill: #fbecea; }
`;

export default {
  id: 'spiders',
  title: 'Sync points as spiders (ZX-style)',
  short: 'Spiders',
  convention: {
    summary: 'In ZX-calculus, spiders are dots of two colours whose legs are wires, and two spiders of one colour that share a leg fuse into one (spider fusion). Here a green spider is one transition class of go-pflow\'s Flatten with two or more members (event links: its member transitions fire as one), and a red spider is one place class with two or more members (token and data links: its members become one place); a transition or place no link touches is a class of one and is not drawn. Instances are opaque boxes, stacked (⊗ runs down the page). Their ports are legs: transition ports are squares on the right edge, place ports are smaller circles on the left, coloured by schema. Links that share a member are drawn first as separate spiders joined through the shared leg, then slide together into the one spider Flatten makes, labelled with its flat name.',
    examples: {
      orders: 'Three boxes (orders, workers, payment). The three idioms are three event links, but Flatten makes two classes: dequeue⊗acquire and dequeue⊗do:reserve share orders/dequeue, so they fuse into fused:orders/dequeue+payment/do_reserve+workers/acquire; release⊗commit stays a two-legged spider and carries the pool-leak caveat in red. The ROADMAP sketch draws three sync spiders, one per idiom; after fusion two remain. There is no red spider: no token or data link is legal among these three, because their place ports\' schemas all differ (compose.go:667-674; cq/13 expects no token candidates). Add a second instance to make one.',
      connect4: 'A plan has no event links, so nothing fuses and no spider is drawn. The nearest honest picture: the two pieces of shared state the search keeps, the transposition table and the history table, as junctions (hollow dots, not spiders) with a leg to each part of the plan that reads, writes or caps them. A piece\'s leg is drawn only when that piece is in the plan.',
    },
    honesty: [
      'ZX spiders carry phases and denote linear maps (a quantum semantics). None of that is used: a spider here has no phase and stands for one equivalence class of go-pflow\'s Flatten, nothing more.',
      'No colour-change, copy, π-commutation, bialgebra or Hopf rule applies. The only law used is fusion of same-colour spiders that share a leg, because that is what Flatten\'s union-find does (unionfind.go:5-14, compose_fuse.go:9-20).',
      'Green and red never fuse with each other: Flatten keeps transition classes and place classes in two separate union-finds (compose_flatten.go:55-88). That parallels ZX, where a Z and an X spider do not fuse; it is a parallel of shape, not an identity (in ZX the two colours interact through the bialgebra law; no rule here relates the two union-finds, so a place class and a transition class never merge).',
      'A cycle of event links a↔b is one class (compose_fuse.go:19-20), so it is drawn as one spider, never as a loop.',
      'Legs are undirected because a class is a set: union is symmetric. Event links have no direction rule at all; a token link\'s direction rule (from not an in-port, to not an out-port, compose.go:676-683) is checked before Flatten and leaves no trace in the class. The arrow on a port stub is the port\'s own kind (in / out / inout / observe), not the leg\'s.',
      'What an event spider means is a rendezvous (Bruni et al.): one transition whose pre- and postset is the union of its members\', enabled only when every member is. That is the semantics; the dot is only its picture.',
      'A red spider is red for its union-find, not its link kind: token and data links share one union-find, so each leg keeps its own RenderDOT style (data: dotted blue).',
      'Guard links are not spiders: with the default condition "> 0" they lower to a read arc, and they sit outside the free-SMC fragment (ROADMAP Phase 6). They are drawn as an ochre ⊘ wire and nothing fuses.',
      'Connect-4: the junctions are shared state, not spiders. A plan has no event links, so no spider law applies to it at all.',
    ],
    bib: BIB,
    cites: [C.ufDoc, C.ufUnion, C.fuseDoc, C.placeClasses, C.transClasses, C.flatNames, C.dot, C.tokenDir, C.leak, C.roadSpider, C.roadLeak, C.roadScenario,
      C.ttRead, C.store, C.ttBestKey, C.withMemo, C.histKey, C.histCutoff, C.cutoff, C.chainCutoff],
  },
  render(ctx) {
    const wrap = ctx.el('div', { class: 'spiders-view' }, ctx.el('style', {}, STYLE));
    ctx.root.append(wrap);
    if (ctx.example === 'orders') renderOrders(ctx, wrap);
    else renderPlan(ctx, wrap);
    lastExample = ctx.example;
  },
};

// =====================================================================================
// ORDERS
// =====================================================================================

const BOX_ORDER = ['orders', 'orders2', 'workers', 'workers2', 'payment', 'payment2'];
const BAND = { r: '#fbf3f3', g: '#f2f7f3', mid: '#fafafa' };

function arrange(subnets) {
  const rank = (s) => { const i = BOX_ORDER.indexOf(s.id); return i < 0 ? 100 : i; };
  return [...subnets].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
}

function renderOrders(ctx, wrap) {
  const T = ctx.theme, LS = T.LINK_STYLE;
  const { byId, links, flat } = ctx.orders;
  const portKey = ctx.orders.portKey;
  const subnets = arrange(ctx.orders.subnets);
  const ev = ctx.event;
  const GREEN = LS.event.color, RED = LS.token.color;
  ctx.note('Analogy of shape only: ZX spiders without phases or any quantum semantics. The one law used, fusion of same-colour spiders that share a leg, is what go-pflow\'s Flatten does with its union-finds (compose_fuse.go:9-20); green never fuses with red because Flatten keeps transition classes and place classes apart.', 'honesty');

  // ---- boxes and port anchors ----
  const BOX_X = 300, BOX_W = 252, HEAD = 42, TOP = 78;
  const PITCH = subnets.length > 4 ? 21 : subnets.length > 3 ? 23 : 26, GAP = subnets.length > 3 ? 24 : 30;
  const boxes = [], anchors = {};
  let y = TOP;
  for (const s of subnets) {
    const tp = s.ports.filter((p) => p.target === 'transition');
    const pp = s.ports.filter((p) => p.target === 'place');
    const n = Math.max(tp.length, pp.length);
    const h = HEAD + n * PITCH + 8;
    const box = { s, x: BOX_X, y, w: BOX_W, h, tp, pp };
    const y0 = y + HEAD + 4;
    tp.forEach((p, i) => { anchors[portKey({ subnet: s.id, port: p.id })] = { x: BOX_X + BOX_W + 17, y: y0 + PITCH * (i + 0.5 + (n - tp.length) / 2), side: 1, edge: BOX_X + BOX_W, port: p, s }; });
    pp.forEach((p, i) => { anchors[portKey({ subnet: s.id, port: p.id })] = { x: BOX_X - 15, y: y0 + PITCH * (i + 0.5 + (n - pp.length) / 2), side: -1, edge: BOX_X, port: p, s }; });
    boxes.push(box);
    y += h + GAP;
  }
  const colBottom = y - GAP;

  // ---- classes, read from Flatten (never computed here) ----
  const memberOf = (ref, which) => {
    const s = byId[ref.subnet]; const p = s && s.ports.find((q) => q.id === ref.port);
    return p ? `${s.id}/${which === 'event' ? p.transition : p.place}` : null;
  };
  const mkClass = (kind, name, members, ls) => {
    const terminals = [], seen = new Set();
    for (const l of ls) for (const end of [l.from, l.to]) { const k = portKey(end); if (!seen.has(k) && anchors[k]) { seen.add(k); terminals.push(k); } }
    const sorted = [...members].sort();
    return { kind, name, members: sorted, key: `${kind}:${sorted.join(',')}`, links: ls, terminals, memberOfTerm: Object.fromEntries(terminals.map((k) => [k, memberOf(parsePortKey(k), kind)])) };
  };
  let tClasses = [], pClasses = [];
  if (flat.ok) {
    const evLinks = links.filter((l) => l.kind === 'event');
    const plLinks = links.filter((l) => l.kind === 'token' || l.kind === 'data');
    tClasses = Object.entries(flat.map.fusedGroups).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, members]) => mkClass('event', name, members, evLinks.filter((l) => members.includes(memberOf(l.from, 'event')))));
    pClasses = Object.entries(flat.map.wires).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, members]) => mkClass('place', name, members, plLinks.filter((l) => members.includes(memberOf(l.from, 'place')))));
  } else {
    ctx.note(`Flatten refused this composition (${(flat.errors || []).map((e) => e.code).join(', ')}): no classes to draw.`, 'warn');
  }
  const guards = links.filter((l) => l.kind === 'guard');

  // ---- spider lanes ----
  const anchorR = BOX_X + BOX_W + 17, anchorL = BOX_X - 15;
  const labelLines = (c) => (c.kind === 'event' ? splitFused(c.name) : [c.name]);
  const assignLanes = (classes) => {
    const items = classes.map((c) => {
      const ys = c.terminals.map((k) => anchors[k].y);
      const yc = mean(ys);
      const lh = labelLines(c).length * 13;
      return { c, yc, lo: Math.min(Math.min(...ys), yc - lh / 2) - 12, hi: Math.max(Math.max(...ys), yc + lh / 2) + 12, span: Math.max(...ys) - Math.min(...ys) };
    });
    items.sort((a, b) => a.span - b.span || a.yc - b.yc || (a.c.name < b.c.name ? -1 : 1));
    const placed = [];
    for (const it of items) {
      let lane = 0;
      for (const p of placed) if (p.lo < it.hi && it.lo < p.hi) lane = Math.max(lane, p.lane + 1);
      it.lane = lane; placed.push(it);
    }
    return placed;
  };
  const tl = assignLanes(tClasses), pl = assignLanes(pClasses);
  const LANE_G = 190, LANE_R = 120;
  for (const it of tl) { it.c.pos = { x: anchorR + 118 + it.lane * LANE_G, y: it.yc }; it.c.side = 1; }
  for (const it of pl) { it.c.pos = { x: anchorL - 92 - it.lane * LANE_R, y: it.yc }; it.c.side = -1; }
  // A leg that grazes another spider reads as joined to it. Each spider, in lane
  // order, moves to the nearest spot (a fixed list of offsets, so the layout stays
  // deterministic) that is clear of the other classes' legs and spiders.
  const legSamples = (c, pos) => c.terminals.flatMap((k) => { const a = anchors[k]; return cubicPoints(a.x, a.y, pos.x, pos.y, 40); });
  const clearance = (c, pos, group) => {
    let d = Infinity;
    const mine = legSamples(c, pos);
    for (const o of group) {
      if (o === c) continue;
      d = Math.min(d, Math.hypot(o.pos.x - pos.x, o.pos.y - pos.y) - 14);
      for (const q of legSamples(o, o.pos)) d = Math.min(d, Math.hypot(q.x - pos.x, q.y - pos.y));
      for (const q of mine) d = Math.min(d, Math.hypot(q.x - o.pos.x, q.y - o.pos.y));
    }
    return d;
  };
  const OFFS = [];
  for (const dx of [0, -16, 16, -32, 32, -48, 48, -64, 64]) for (const dy of [0, -12, 12, -24, 24]) OFFS.push([dx, dy]);
  OFFS.sort((a, b) => (Math.abs(a[0]) + 1.5 * Math.abs(a[1])) - (Math.abs(b[0]) + 1.5 * Math.abs(b[1])));
  const nudge = (items, side) => {
    const group = items.map((it) => it.c);
    for (const c of group) {
      let best = null, bs = -Infinity;
      for (const [dx, dy] of OFFS) {
        const p = { x: c.pos.x + dx, y: c.pos.y + dy };
        if (side > 0 ? p.x < anchorR + 70 : p.x > anchorL - 60) continue;
        const sc = clearance(c, p, group);
        if (sc >= 26) { best = p; break; }
        if (sc > bs) { bs = sc; best = p; }
      }
      if (best) c.pos = best;
    }
  };
  nudge(tl, 1);
  nudge(pl, -1);
  const maxLaneX = Math.max(0, ...tClasses.map((c) => c.pos.x));
  const W = Math.max(1150, maxLaneX + 200);

  // guard routing: around the box column, through whichever gutter (above or
  // below it) is shorter; one fits above, under the band headings
  let nTop = 0, nBot = 0;
  const guardRoutes = guards.map((l, gi) => {
    const a = anchors[portKey(l.from)], b = anchors[portKey(l.to)];
    const top = nTop < 1 && (a.y - TOP) + (b.y - TOP) <= (colBottom - a.y) + (colBottom - b.y);
    const gy = top ? TOP - 14 - (nTop++) * 18 : colBottom + 24 + (nBot++) * 20;
    return { l, a, b, gy, top, ch: 24 + gi * 7 }; // ch: each guard its own vertical channel
  });
  const afterGuards = nBot ? colBottom + 24 + nBot * 20 + 10 : colBottom + 10;

  // ---- label placement against obstacles (boxes, spiders, legs, guards) ----
  // Labels never sit on a leg or another label: each tries the spots next to its
  // spider first, then rings further out (with a leader line back to the spider).
  const obs = new Obstacles({ x: 8, y: 54, w: W - 16, h: 4000 });
  for (const b of boxes) obs.rect({ x: b.x - 24, y: b.y - 4, w: b.w + 48, h: b.h + 8 });
  const allClasses = [...tClasses, ...pClasses];
  for (const c of allClasses) {
    obs.rect({ x: c.pos.x - 15, y: c.pos.y - 15, w: 30, h: 30 });
    for (const k of c.terminals) { const a = anchors[k]; obs.points(cubicPoints(a.x, a.y, c.pos.x, c.pos.y, 64)); }
  }
  for (const r of guardRoutes) {
    obs.rect({ x: Math.min(r.a.x, r.b.x) - 26, y: r.gy - 8, w: Math.abs(r.a.x - r.b.x) + 52, h: 16 });
    const lw = sansW(`⊘ guard ${r.l.from.subnet}:${r.l.from.port} → ${r.l.to.subnet}:${r.l.to.port}: a read arc, not a spider`, 11) + 24;
    obs.rect({ x: (r.a.x + r.b.x) / 2 - lw / 2, y: r.gy - 10, w: lw, h: 20 });
    obs.rect({ x: r.a.x + r.ch - 4, y: Math.min(r.a.y, r.gy), w: 8, h: Math.abs(r.a.y - r.gy) });
    obs.rect({ x: r.b.x - r.ch - 4, y: Math.min(r.b.y, r.gy), w: 8, h: Math.abs(r.b.y - r.gy) });
  }
  const bandG = { x0: BOX_X + BOX_W + 34, x1: W - 10 }, bandR = { x0: 10, x1: BOX_X - 34 };
  for (const c of allClasses) {
    const lines = labelLines(c);
    const w = Math.max(...lines.map((t) => monoW(t, 11))) + 6, h = lines.length * 13 + 3;
    const r = placeBlock(obs, c.pos.x, c.pos.y, w, h, c.side, c.side > 0 ? bandG : bandR, 'side');
    c.label = { ...r, lines };
    obs.rect(r);
  }
  // the pool-leak annotation on every class holding a link that instantiates
  // pat:idiom-pool-release-saga-commit (the idiom's caveat, verbatim in the hover)
  const leaks = [];
  for (const c of tClasses) {
    const link = c.links.find((l) => l.leak);
    if (!link) continue;
    const lines = ['fires only on commit: on rollback the', 'worker stays in in_use', '(pat:idiom-pool-release-saga-commit caveat)'];
    const w = Math.max(...lines.map((t) => sansW(t, 11))) + 14, h = lines.length * 14 + 8;
    const r = placeBlock(obs, c.pos.x, c.pos.y, w, h, 1, bandG, 'below');
    leaks.push({ c, link, box: { ...r, lines } });
    obs.rect(r);
  }
  const spBottom = Math.max(0, ...allClasses.map((c) => c.label.y + c.label.h), ...leaks.map((x) => x.box.y + x.box.h));
  const legendY = Math.max(afterGuards, spBottom, colBottom) + 26;
  const H = legendY + 84;

  // ---- DOM ----
  const s = ctx.svg;
  const root = ctx.svgRoot(W, H);
  const defs = s('defs', {});
  root.append(defs);
  const bg = s('g', {});
  bg.append(
    s('rect', { x: 0, y: 0, width: W, height: H, fill: T.PAPER || '#fafafa' }),
    s('rect', { x: 0, y: 0, width: BOX_X - 30, height: H, fill: BAND.r }),
    s('rect', { x: BOX_X + BOX_W + 30, y: 0, width: W - (BOX_X + BOX_W + 30), height: H, fill: BAND.g }),
  );
  const head = (x, y, anchor, t1, t2, color) => s('g', {},
    s('text', { x, y, 'text-anchor': anchor, 'font-size': 11, 'font-weight': 700, fill: color, 'letter-spacing': '0.06em' }, t1),
    s('text', { x, y: y + 14, 'text-anchor': anchor, 'font-size': 10.5, fill: T.MUTED }, t2));
  const hR = head(16, 24, 'start', 'PLACE CLASSES · red', 'token and data links: one union-find', RED);
  const hM = head(BOX_X + BOX_W / 2, 24, 'middle', 'INSTANCES', 'opaque boxes, ⊗ down the page', T.INK);
  const hG = head(BOX_X + BOX_W + 44, 24, 'start', 'TRANSITION CLASSES · green', 'event links: a second union-find (compose_flatten.go:72-88)', GREEN);
  ctx.hover(hR, { title: 'place classes: token and data links', facts: [['union-find', 'one, over every place (compose_flatten.go:55-70)'], ['flat name', 'wire:<smallest member> (compose_flatten.go:201-209)']], note: 'Red is ZX\'s other colour, borrowed for shape only.', cites: [C.placeClasses, C.ufDoc, C.flatNames], bib: ['coecke-duncan'] });
  ctx.hover(hG, { title: 'transition classes: event links', facts: [['union-find', 'a second one, over every transition (compose_flatten.go:72-88)'], ['flat name', 'fused:<sorted members joined by +> (compose_flatten.go:211-227)'], ['fires', 'as one rendezvous: enabled only when every member is (compose_fuse.go:9-14)']], note: 'Green is ZX\'s Z colour, borrowed for shape only. Green never fuses with red: two separate union-finds.', cites: [C.transClasses, C.fuseDoc, C.ufDoc, C.flatNames], bib: ['coecke-duncan', 'bruni-et-al'] });
  bg.append(hR, hM, hG);
  if (!pClasses.length) {
    const lines = subnets.some((x) => x.extra)
      ? ['No place classes yet: no token or data', 'link. Drag from a round port to a port', 'of the same schema on another instance;', 'go-pflow\'s rules decide (compose.go:', '667-674 for schemas).']
      : ['No place classes. Token and data links', 'need agreeing port schemas, and these', 'patterns\' place ports all differ', '(cq/13; compose.go:667-674). Add a', 'second instance in the toolbar to', 'link one (a red spider).'];
    const t = s('text', { x: 16, y: TOP + 18, 'font-size': 11, fill: T.MUTED }, lines.map((ln, i) => s('tspan', { x: 16, dy: i ? 15 : 0 }, ln)));
    bg.append(t);
  }
  if (!tClasses.length && flat.ok) {
    const lines = ['No transition classes: no event links.', 'Drag from a square port to a square', 'port of another instance.'];
    bg.append(s('text', { x: BOX_X + BOX_W + 44, y: TOP + 18, 'font-size': 11, fill: T.MUTED }, lines.map((ln, i) => s('tspan', { x: BOX_X + BOX_W + 44, dy: i ? 15 : 0 }, ln))));
  }

  const gLegs = s('g', { class: 'sp-legs' });
  const gGuards = s('g', {});
  const gBoxes = s('g', {});
  const gPorts = s('g', {});
  const gSpiders = s('g', {});
  const gNotes = s('g', {});
  const gFx = s('g', { class: 'sp-fx' });
  root.append(bg, gGuards, gLegs, gBoxes, gPorts, gSpiders, gNotes, gFx);

  // boxes
  for (const b of boxes) {
    const sub = b.s, pat = ctx.orders.patterns[sub.pattern];
    const g = s('g', {});
    g.append(
      s('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 7, fill: '#fff', stroke: '#c3c9d2', 'stroke-width': 1.2 }),
      s('path', { d: `M${b.x + 0.6},${b.y + HEAD} V${b.y + 7} Q${b.x + 0.6},${b.y + 0.6} ${b.x + 7},${b.y + 0.6} H${b.x + b.w - 7} Q${b.x + b.w - 0.6},${b.y + 0.6} ${b.x + b.w - 0.6},${b.y + 7} V${b.y + HEAD} Z`, fill: T.PATTERN_TINT[sub.pattern] || '#eef0f3' }),
      s('line', { x1: b.x, y1: b.y + HEAD, x2: b.x + b.w, y2: b.y + HEAD, stroke: '#dde1e6' }),
      s('text', { x: b.x + 12, y: b.y + 18, 'font-size': 13.5, 'font-weight': 700, fill: T.INK }, sub.id),
      s('text', { x: b.x + 12, y: b.y + 33, 'font-size': 10.5, fill: T.MUTED }, `pat:${sub.pattern} · ${sub.netKind}`),
      s('text', { x: b.x + b.w - 10, y: b.y + 18, 'text-anchor': 'end', 'font-size': 10.5, fill: T.MUTED }, `${sub.places.length} places · ${sub.transitions.length} transitions`),
    );
    for (const p of b.pp) { const a = anchors[portKey({ subnet: sub.id, port: p.id })]; g.append(s('text', { x: b.x + 10, y: a.y + 3.8, 'font-size': 10.5, class: 'sp-mono', fill: T.INK }, p.id)); }
    for (const p of b.tp) { const a = anchors[portKey({ subnet: sub.id, port: p.id })]; g.append(s('text', { x: b.x + b.w - 10, y: a.y + 3.8, 'text-anchor': 'end', 'font-size': 10.5, class: 'sp-mono', fill: T.INK }, p.id)); }
    if (sub.extra) g.append(s('text', { x: b.x + b.w - 10, y: b.y + 33, 'text-anchor': 'end', 'font-size': 10, fill: T.MUTED, 'font-style': 'italic' }, 'second instance'));
    ctx.hover(g, { ...ctx.info.subnetInfo(sub), note: `${pat.prefLabel} drawn as an opaque box: its internal net is hidden; only its ports (the legs) take part in fusion.` });
    gBoxes.append(g);
  }

  // ports: stub, direction chevron, shape, a hit area >= 20px
  for (const [k, a] of Object.entries(anchors)) {
    const p = a.port, isT = p.target === 'transition';
    const color = T.portColor(p);
    const g = s('g', {});
    const x0 = Math.min(a.edge, a.x) - (a.side < 0 ? 10 : 0), x1 = Math.max(a.edge, a.x) + (a.side > 0 ? 10 : 0);
    g.append(s('rect', { x: x0, y: a.y - 10, width: x1 - x0, height: 20, fill: 'transparent' }));
    g.append(s('line', { x1: a.edge, y1: a.y, x2: a.x, y2: a.y, stroke: color, 'stroke-width': 1.6, 'stroke-dasharray': p.kind === 'observe' ? '2 2' : null }));
    g.append(chevron(s, (a.edge + a.x) / 2, a.y, p.kind, a.side, color));
    if (isT) g.append(s('rect', { x: a.x - 5, y: a.y - 5, width: 10, height: 10, fill: color, stroke: '#fff', 'stroke-width': 1 }));
    else g.append(s('circle', { cx: a.x, cy: a.y, r: 4.2, fill: p.kind === 'observe' ? '#fff' : color, stroke: color, 'stroke-width': 1.6 }));
    const info = ctx.info.portInfo(a.s, p);
    info.facts = [...(info.facts || []), ['in this view', isT ? 'a leg on the right edge: an event link joins it to a green spider (a guard link starts here, as a wire)' : 'a leg on the left edge: a token or data link joins it to a red spider (a guard link ends here, as a wire)']];
    ctx.hover(g, info);
    ctx.snap.port(g, { subnet: a.s.id, port: p.id });
    gPorts.append(g);
  }

  // legs and spiders (final state)
  const legEls = {}, bodyEls = {};
  const legStyle = (l) => ({ stroke: LS[l.kind].color, 'stroke-width': l.kind === 'event' ? 2.2 : 2, 'stroke-dasharray': l.kind === 'event' ? null : (l.kind === 'data' ? '1.5 4' : '6 4'), 'stroke-linecap': 'round' });
  for (const c of allClasses) {
    legEls[c.key] = {};
    for (const k of c.terminals) {
      const a = anchors[k];
      const via = c.links.filter((l) => portKey(l.from) === k || portKey(l.to) === k);
      const d = curveX(a.x, a.y, c.pos.x, c.pos.y);
      const path = s('path', { d, fill: 'none', class: 'sp-leg', ...legStyle(via[0]) });
      const hit = s('path', { d, class: 'sp-leg-hit' });
      const base = ctx.info.linkInfo(via[0], byId);
      ctx.hover(hit, {
        ...base,
        title: `leg ${k.replace('|', ':')} of a ${c.kind === 'event' ? 'green' : 'red'} spider`, // the spider's flat name is in the facts (long names overflow the hover tip)
        facts: [...base.facts, ['member', c.memberOfTerm[k]], ['links through this leg', via.map(linkText).join('; ')], ['spider', c.name]],
        note: c.kind === 'event' ? 'An undirected leg: event links have no direction rule.' : 'A leg into the place class; its style is its link kind\'s (RenderDOT).',
      });
      gLegs.append(path, hit);
      legEls[c.key][k] = path;
    }
  }
  for (const c of allClasses) {
    const isE = c.kind === 'event';
    const color = isE ? GREEN : RED;
    const glyph = isE ? LS.event.glyph : (c.links.some((l) => l.kind === 'token') ? LS.token.glyph : LS.data.glyph);
    const outer = s('g', { transform: `translate(${r1(c.pos.x)},${r1(c.pos.y)})`, class: 'sp-spider' });
    const body = s('g', {});
    body.append(spiderGlyph(s, color, glyph));
    const L = c.label;
    const halo = isE ? BAND.g : BAND.r;
    if (L.d > 0) {
      const q = nearestOn(L, c.pos.x, c.pos.y), dd = Math.hypot(q.x - c.pos.x, q.y - c.pos.y) || 1;
      body.append(s('line', { x1: r1((q.x - c.pos.x) * 14 / dd), y1: r1((q.y - c.pos.y) * 14 / dd), x2: r1(q.x - c.pos.x), y2: r1(q.y - c.pos.y), stroke: color, 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.8 }));
    }
    const lt = s('text', { 'font-size': 11, class: 'sp-mono sp-halo', fill: isE ? '#1b5e36' : '#8a2a2a', stroke: halo });
    L.lines.forEach((ln, i) => lt.append(s('tspan', { x: r1(L.x - c.pos.x + 2), y: r1(L.y - c.pos.y + 10.5 + i * 13) }, ln)));
    body.append(lt);
    outer.append(body);
    gSpiders.append(outer);
    bodyEls[c.key] = body;
    ctx.hover(body, spiderInfo(ctx, c, byId));
  }

  // the leak annotations
  for (const { c: leakClass, link: leakLink, box: leakBox } of leaks) {
    const g = s('g', {});
    const sp = leakClass.pos, lb = leakBox;
    const q = nearestOn(lb, sp.x, sp.y), dd = Math.hypot(q.x - sp.x, q.y - sp.y) || 1;
    g.append(s('line', { x1: r1(sp.x + (q.x - sp.x) * 14 / dd), y1: r1(sp.y + (q.y - sp.y) * 14 / dd), x2: q.x, y2: q.y, stroke: T.LEAK, 'stroke-width': 1.3, 'stroke-dasharray': '3 3' }));
    g.append(s('rect', { x: lb.x, y: lb.y, width: lb.w, height: lb.h, rx: 5, fill: '#fdf0ee', stroke: T.LEAK, 'stroke-width': 1.1 }));
    lb.lines.forEach((ln, i) => g.append(s('text', { x: lb.x + 7, y: lb.y + 16 + i * 14, 'font-size': 11, fill: T.LEAK, 'font-weight': i === 0 ? 600 : null }, ln)));
    const base = ctx.info.linkInfo(leakLink, byId);
    ctx.hover(g, { ...base, title: 'pool-leak caveat on release ⊗ commit', note: 'Fusion only says release and commit fire as one. Nothing fires release on the rollback path, so a worker taken by acquire stays in in_use: the expected failure ROADMAP 4.4 records.', cites: [C.leak, C.roadLeak, C.roadScenario, ...base.cites] });
    gNotes.append(g);
  }

  // guards: not spiders
  const guardEls = {};
  const fitPills = []; // [rect, text, cx]: widths set from the rendered text once mounted
  for (const r of guardRoutes) {
    const { a, b, gy, l, ch } = r;
    const v = r.top ? -1 : 1; // the gutter is above (-1) or below (+1)
    const ax = a.x + ch, bx = b.x - ch;
    const d = `M${a.x},${a.y} H${ax - 10} Q${ax},${a.y} ${ax},${a.y + 10 * v} V${gy - 10 * v} Q${ax},${gy} ${ax - 10},${gy} H${bx + 10} Q${bx},${gy} ${bx},${gy - 10 * v} V${b.y + 10 * v} Q${bx},${b.y} ${bx + 10},${b.y} H${b.x}`;
    const g = s('g', {});
    g.append(s('path', { d, fill: 'none', stroke: LS.guard.color, 'stroke-width': 1.8, 'stroke-dasharray': LS.guard.dash }));
    g.append(s('path', { d, class: 'sp-leg-hit' }));
    // the label sits in a pill on the wire, so the dashes never run through it
    const mx = (a.x + b.x) / 2;
    const text = `${LS.guard.glyph} guard ${l.from.subnet}:${l.from.port} → ${l.to.subnet}:${l.to.port}: a read arc, not a spider`;
    const lw = sansW(text, 11) + 16;
    const pill = s('rect', { x: r1(mx - lw / 2), y: gy - 8.5, width: r1(lw), height: 17, rx: 8.5, fill: '#fffaf0', stroke: LS.guard.color, 'stroke-width': 1 });
    const lt = s('text', { x: mx, y: gy + 4, 'text-anchor': 'middle', 'font-size': 11, fill: LS.guard.color }, text);
    g.append(pill, lt);
    fitPills.push([pill, lt, mx]);
    const base = ctx.info.linkInfo(l, byId);
    ctx.hover(g, { ...base, note: 'Not a spider: a guard lowers to a read arc on the gated transition, nothing fuses, and it sits outside the free-SMC fragment (ROADMAP Phase 6). W_RESTRICTIVE_LINK.' });
    gGuards.append(g);
    guardEls[l.index] = g;
  }

  // legend
  root.append(legend(ctx, s, 16, legendY, W, GREEN, RED, new Set(subnets.flatMap((x) => x.ports.map((q) => q.schema)).filter(Boolean))));

  // ---- the HTML bar above the svg: replay ----
  const multi = allClasses.filter((c) => c.links.length > 1);
  const btn = ctx.el('button', { class: 'sp-btn', title: multi.length ? 'draw the links as separate spiders again, then fuse them' : 'no two links share a member: nothing to fuse', onclick: () => replay && replay() }, '↻ replay fusion');
  if (!multi.length) btn.disabled = true;
  const caption = multi.length
    ? `${multi.map((c) => `${c.links.length} links share members → one spider ${c.name}`).join(' · ')}`
    : allClasses.length
      ? 'no two links share a member, so every spider has two legs'
      : links.length ? 'no event, token or data link: no spiders (a guard never forms one)' : 'no links: no spiders';
  wrap.append(ctx.el('div', { class: 'sp-bar' }, btn, ctx.el('span', {}, caption)));
  wrap.append(root);
  for (const [pill, t, cx] of fitPills) {
    try { const w = t.getComputedTextLength() + 16; if (w > 16) { pill.setAttribute('x', r1(cx - w / 2)); pill.setAttribute('width', r1(w)); } } catch { /* not rendered */ }
  }

  // ---- motion ----
  const layout = { classes: allClasses.map((c) => ({ kind: c.kind, key: c.key, name: c.name, members: c.members, terminals: [...c.terminals], pos: { ...c.pos }, side: c.side, memberOfTerm: c.memberOfTerm, linkCount: c.links.length })), anchors: Object.fromEntries(Object.entries(anchors).map(([k, a]) => [k, { x: a.x, y: a.y, side: a.side }])) };
  const env = { ctx, s, gFx, anchors, legEls, bodyEls, guardEls, GREEN, RED, LS };
  const intro = () => run(allClasses.filter((c) => c.links.length > 1).map((c) => fusion(env, c, perLinkGroups(env, c, 62), { dur: 1500, hold: 0.45 })));
  replay = intro;
  const linkEvent = ev && /^(link-added|link-removed|links-reset|links-cleared|instance-added|instance-removed)$/.test(ev.type);
  const fresh = lastExample !== 'orders' || (ev && (ev.type === 'view' || ev.type === 'example'));
  if (!reduced()) {
    if (fresh || (!ev && !prevLayout)) intro();
    else if (linkEvent && prevLayout) run(diff(env, prevLayout, allClasses, ev));
  }
  prevLayout = layout;
}

function linkText(l) { return `${l.from.subnet}:${l.from.port} ${l.kind === 'event' ? '⊗' : l.kind === 'data' ? '▷' : '◆'} ${l.to.subnet}:${l.to.port}`; }

/** "fused:a+b+c" -> ["fused:a+", "b+", "c"]: the exact flat name, broken only after '+'. */
function splitFused(name) {
  const parts = name.split('+');
  return parts.map((p, i) => (i < parts.length - 1 ? `${p}+` : p));
}

function spiderGlyph(s, color, glyph, r = 12.5) {
  const dark = color === '#227744' ? '#15502c' : '#7a2020';
  return s('g', {},
    s('circle', { r, fill: color, stroke: dark, 'stroke-width': 1.5 }),
    s('text', { y: 5, 'text-anchor': 'middle', 'font-size': 14.5, 'font-weight': 700, fill: '#fff' }, glyph));
}

function chevron(s, x, y, kind, side, color) {
  // side: +1 right edge (outward = +x), -1 left edge (outward = -x).
  const tri = (dir) => s('path', { d: `M${x - 3 * dir},${y - 3.6} L${x + 3 * dir},${y} L${x - 3 * dir},${y + 3.6} Z`, fill: color });
  if (kind === 'in') return tri(-side);
  if (kind === 'out') return tri(side);
  if (kind === 'inout') return s('path', { d: `M${x},${y - 3.6} L${x + 4},${y} L${x},${y + 3.6} L${x - 4},${y} Z`, fill: '#fff', stroke: color, 'stroke-width': 1.3 });
  return s('circle', { cx: x, cy: y, r: 2.6, fill: '#fff', stroke: color, 'stroke-width': 1.3 }); // observe
}

function spiderInfo(ctx, c, byId) {
  const flat = ctx.orders.flat;
  if (c.kind === 'event') {
    const ft = flat.model.transitions.find((t) => t.id === c.name) || { id: c.name, members: c.members };
    const base = ctx.info.flatTransitionInfo(ft);
    return {
      ...base,
      title: `green spider: one transition class of ${c.members.length}`,
      facts: [
        ['flat name', c.name],
        ...base.facts,
        ['links fused', c.links.map(linkText).join('; ')],
        ['legs', c.terminals.map((k) => k.replace('|', ':')).join(', ')],
        ['representative', `${c.members[0]} (the union-find root, the smallest member; the flat name lists every member, sorted)`],
      ],
      note: `Analogy of shape: a ZX spider with no phase. ${c.links.length > 1 ? `${c.links.length} links share members, so Flatten's union-find puts them in one class; the drawing fuses their spiders, which is the only ZX law borrowed.` : 'One link: a two-legged spider.'} It fires as one rendezvous (Bruni et al.), not as a linear map.`,
      cites: [C.transClasses, C.fuseDoc, C.ufDoc, C.ufUnion, C.flatNames, ...base.cites],
      bib: ['coecke-duncan', 'bruni-et-al'],
    };
  }
  const fp = flat.model.places.find((p) => p.id === c.name) || { id: c.name, members: c.members, initial: '?' };
  const base = ctx.info.flatPlaceInfo(fp);
  return {
    ...base,
    title: `red spider: one place class of ${c.members.length}`,
    facts: [
      ['flat name', c.name],
      ...base.facts,
      ['links fused', c.links.map(linkText).join('; ')],
      ['legs', c.terminals.map((k) => k.replace('|', ':')).join(', ')],
      ['representative', `${c.members[0]} (the union-find root, the smallest member; the wire is named after it)`],
    ],
    note: 'Analogy of shape: ZX\'s other colour. Red is the place-class union-find, which token and data links share; each leg keeps its link kind\'s RenderDOT style. A red spider never fuses with a green one.',
    cites: [C.placeClasses, C.ufDoc, C.flatNames, ...base.cites],
    bib: ['coecke-duncan', 'baez-master'],
  };
}

function legend(ctx, s, x, y, W, GREEN, RED, schemas) {
  const T = ctx.theme, LS = T.LINK_STYLE;
  const g = s('g', {});
  g.append(s('rect', { x: 0, y: y - 16, width: W, height: 100, fill: '#fafafa' }), s('line', { x1: x, y1: y - 16, x2: W - x, y2: y - 16, stroke: '#dde1e6' }));
  let cx = x, cy = y;
  const put = (draw, text, opts = {}) => {
    const it = s('g', { transform: `translate(${cx + 8},${cy})` });
    const tx = opts.tx ?? 14;
    it.append(draw, s('text', { x: tx, y: 4, 'font-size': 11, fill: opts.muted ? T.MUTED : T.INK, class: opts.mono ? 'sp-mono' : null, 'font-style': opts.italic ? 'italic' : null }, text));
    g.append(it);
    cx += 8 + tx + (opts.mono ? monoW(text, 11) : sansW(text, 11)) + (opts.gap ?? 18);
  };
  // row 1: ports
  put(s('rect', { x: -5, y: -5, width: 10, height: 10, fill: T.TRANSITION_PORT_COLOR }), 'transition port');
  put(s('circle', { r: 4.2, fill: '#fff', stroke: '#888', 'stroke-width': 1.4 }), 'place port, coloured by its schema:', { gap: 8 });
  for (const [sch, col] of Object.entries(T.SCHEMA_COLOR).filter(([k]) => schemas.has(k))) put(s('circle', { r: 4.2, fill: col }), sch, { mono: true, tx: 9, gap: 6 });
  // row 2: port kinds
  cx = x; cy = y + 21;
  g.append(s('text', { x: cx + 8, y: cy + 4, 'font-size': 11, fill: T.MUTED }, 'arrow on a stub = the port\'s kind:'));
  cx += 8 + sansW('arrow on a stub = the port\'s kind:', 11) + 14;
  for (const [kind, text] of [['in', 'in (into the box)'], ['out', 'out (away from it)'], ['inout', 'inout'], ['observe', 'observe (a tap)']]) {
    put(s('g', {}, s('line', { x1: -9, y1: 0, x2: 9, y2: 0, stroke: '#555', 'stroke-width': 1.5, 'stroke-dasharray': kind === 'observe' ? '2 2' : null }), s('rect', { x: -12, y: -3, width: 3, height: 6, fill: '#555' }), chevron(s, 0, 0, kind, 1, '#555')), text, { tx: 16 });
  }
  // row 3: spiders
  cx = x; cy = y + 44;
  put(spiderGlyph(s, GREEN, LS.event.glyph, 8.5), 'transition class: event links fuse transitions', { tx: 14 });
  put(spiderGlyph(s, RED, LS.token.glyph, 8.5), 'place class: token / data links fuse places', { tx: 14 });
  put(s('path', { d: 'M-9,0 H9', stroke: LS.guard.color, 'stroke-width': 2, 'stroke-dasharray': '4 3' }), `${LS.guard.glyph} guard: a read arc, never a spider`, { tx: 14 });
  cx = x; cy = y + 64;
  put(s('g', {}), 'Green fuses only with green and red only with red: Flatten keeps two union-finds. A parallel to ZX\'s two colours, not an identity.', { tx: 0, muted: true, italic: true });
  ctx.hover(g, { title: 'legend', facts: [['link colours and glyphs', 'go-pflow RenderDOT (composedot.go:28-33)'], ['port colour', 'the port schema (ROADMAP Phase 6: wire types are port schemas)'], ['two colours', 'two union-finds in Flatten: places by token/data links, transitions by event links']], cites: [C.dot, C.placeClasses, C.transClasses] });
  return g;
}

// ---- motion builders ---------------------------------------------------------------

/**
 * Start a batch of animations on one clock: the Web Animations first; the SMIL
 * ones when the first of those is ready (its start time is the frame it first
 * paints), so legs and spiders move together even after a slow render.
 */
function run(starters) {
  const all = starters.flat(Infinity).filter(Boolean);
  const smil = all.filter((f) => f.smil), rest = all.filter((f) => !f.smil);
  const anims = rest.map((f) => f()).filter(Boolean);
  const go = () => smil.forEach((f) => f());
  if (anims.length && anims[0].ready) anims[0].ready.then(go, go);
  else go();
}

/** One pre-spider per link of the class, offset in x around the final spot (the intro). */
function perLinkGroups(env, c, spread) {
  const pk = env.ctx.orders.portKey;
  const n = c.links.length;
  return c.links.map((l, i) => {
    const terms = [pk(l.from), pk(l.to)].filter((k) => env.anchors[k]);
    return {
      terminals: terms,
      members: new Set(terms.map((k) => c.memberOfTerm[k])),
      pos: { x: c.pos.x + (i - (n - 1) / 2) * spread, y: mean(terms.map((k) => env.anchors[k].y)) },
      label: `${l.from.port} ${env.LS[l.kind].glyph} ${l.to.port}`,
    };
  });
}

/**
 * Spider fusion: pre-spiders (groups) joined through shared legs slide into the
 * class's one spider. Each terminal's leg starts on the first group that uses it;
 * a group holding a member another group owns is wired to it ("shared leg").
 */
function fusion(env, c, groups, { dur, hold }) {
  const { s, gFx, anchors, legEls, bodyEls } = env;
  const color = c.kind === 'event' ? env.GREEN : env.RED;
  const glyph = c.kind === 'event' ? env.LS.event.glyph : env.LS.token.glyph;
  const F = c.pos, out = [];
  const ownerOfTerm = (k) => groups.find((g) => g.terminals.includes(k)) || groups.find((g) => g.members.has(c.memberOfTerm[k])) || groups[0];
  const ownerOfMember = (m) => groups.find((g) => g.members.has(m));
  // legs
  for (const k of c.terminals) {
    const a = anchors[k], path = legEls[c.key][k];
    const o = ownerOfTerm(k);
    const pre = curveX(a.x, a.y, o.pos.x, o.pos.y), fin = curveX(a.x, a.y, F.x, F.y);
    out.push(smilD(path, [pre, pre, fin], [0, hold, 1], dur));
  }
  // shared legs between pre-spiders
  const seen = new Set();
  groups.forEach((g, gi) => {
    for (const m of g.members) {
      const o = ownerOfMember(m);
      if (!o || o === g) continue;
      const key = `${groups.indexOf(o)}-${gi}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pre = curveY(g.pos.x, g.pos.y, o.pos.x, o.pos.y), fin = curveY(F.x, F.y, F.x, F.y);
      const p = s('path', { d: fin, fill: 'none', stroke: color, 'stroke-width': 2.2, opacity: 0 });
      const lbl = s('text', { x: (g.pos.x + o.pos.x) / 2 + 8 * c.side, y: (g.pos.y + o.pos.y) / 2 + 4, 'text-anchor': c.side > 0 ? 'start' : 'end', 'font-size': 10, 'font-style': 'italic', class: 'sp-mono sp-halo', fill: color, stroke: c.kind === 'event' ? BAND.g : BAND.r, opacity: 0 }, `shared leg: ${m}`);
      gFx.append(p, lbl);
      out.push(smilD(p, [pre, pre, fin], [0, hold, 1], dur));
      out.push(waapi(p, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: hold + (1 - hold) * 0.6 }, { opacity: 0, offset: 1 }], dur, () => p.remove()));
      out.push(waapi(lbl, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: hold }, { opacity: 0, offset: hold + (1 - hold) * 0.35 }, { opacity: 0, offset: 1 }], dur, () => lbl.remove()));
    }
  });
  // pre-spiders sliding into F
  for (const g of groups) {
    const outer = s('g', { transform: `translate(${r1(g.pos.x)},${r1(g.pos.y)})` });
    const inner = s('g', { opacity: 0 });
    inner.append(spiderGlyph(s, color, glyph));
    if (g.label) {
      const pl = s('text', { x: 17 * c.side, y: 4, 'text-anchor': c.side > 0 ? 'start' : 'end', 'font-size': 10.5, class: 'sp-mono sp-halo', fill: color, stroke: c.kind === 'event' ? BAND.g : BAND.r }, g.label);
      inner.append(pl);
      out.push(waapi(pl, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: hold }, { opacity: 0, offset: hold + (1 - hold) * 0.3 }, { opacity: 0, offset: 1 }], dur));
    }
    outer.append(inner);
    gFx.append(outer);
    const dx = F.x - g.pos.x, dy = F.y - g.pos.y;
    out.push(waapi(inner, [
      { offset: 0, transform: 'translate(0px, 0px)', opacity: 1 },
      { offset: hold, transform: 'translate(0px, 0px)', opacity: 1, easing: EASE },
      { offset: 1, transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
    ], dur, () => outer.remove()));
    out.push(waapi(outer, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.93 }, { opacity: 0, offset: 1 }], dur));
  }
  // the fused spider appears as they meet
  out.push(waapi(bodyEls[c.key], [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.9 }, { opacity: 1, offset: 1 }], dur));
  return out;
}

function slide(env, c, from, dur) {
  const out = [], F = c.pos;
  for (const k of c.terminals) {
    const a = env.anchors[k];
    out.push(smilD(env.legEls[c.key][k], [curveX(a.x, a.y, from.x, from.y), curveX(a.x, a.y, F.x, F.y)], [0, 1], dur));
  }
  const dx = from.x - F.x, dy = from.y - F.y;
  out.push(waapi(env.bodyEls[c.key], [{ transform: `translate(${dx}px, ${dy}px)`, easing: EASE }, { transform: 'translate(0px, 0px)' }], dur));
  return out;
}

function grow(env, c, dur) {
  const out = [], F = c.pos;
  for (const k of c.terminals) {
    const a = env.anchors[k];
    out.push(smilD(env.legEls[c.key][k], [curveX(a.x, a.y, a.x + 6 * a.side, a.y), curveX(a.x, a.y, F.x, F.y)], [0, 1], dur));
  }
  out.push(waapi(env.bodyEls[c.key], [
    { offset: 0, opacity: 0, transform: 'scale(0.2)' },
    { offset: 0.55, opacity: 0, transform: 'scale(0.2)', easing: 'cubic-bezier(0.3, 1.6, 0.5, 1)' },
    { offset: 1, opacity: 1, transform: 'scale(1)' },
  ], dur));
  return out;
}

/** Legs retracting into their ports, and the old spider fading, for what a change removed. */
function ghost(env, old, terms, withSpider, dur) {
  const { s, gFx } = env, out = [];
  const color = old.kind === 'event' ? env.GREEN : env.RED;
  for (const k of terms) {
    const a = env.anchors[k];
    if (!a) continue;
    const pre = curveX(a.x, a.y, old.pos.x, old.pos.y), fin = curveX(a.x, a.y, a.x + 6 * a.side, a.y);
    const p = s('path', { d: fin, fill: 'none', stroke: color, 'stroke-width': 2, opacity: 0 });
    gFx.append(p);
    out.push(smilD(p, [pre, fin], [0, 1], dur));
    out.push(waapi(p, [{ opacity: 0.9 }, { opacity: 0 }], dur, () => p.remove()));
  }
  if (withSpider) {
    const outer = s('g', { transform: `translate(${r1(old.pos.x)},${r1(old.pos.y)})` });
    const inner = s('g', { opacity: 0 });
    inner.append(spiderGlyph(s, color, old.kind === 'event' ? env.LS.event.glyph : env.LS.token.glyph));
    outer.append(inner); gFx.append(outer);
    out.push(waapi(inner, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.3)' }], dur, () => outer.remove()));
  }
  return out;
}

/** What a link change did, class by class, compared by member sets with the last drawing. */
function diff(env, prev, classes, ev) {
  const out = [];
  const pk = env.ctx.orders.portKey;
  const prevBy = new Map(prev.classes.map((p) => [p.key, p]));
  const covered = new Set();
  for (const c of classes) {
    const same = prevBy.get(c.key);
    if (same) {
      covered.add(same.key);
      if (Math.hypot(same.pos.x - c.pos.x, same.pos.y - c.pos.y) > 1) out.push(slide(env, c, same.pos, 700));
      continue;
    }
    const subs = prev.classes.filter((p) => p.kind === c.kind && p.members.every((m) => c.members.includes(m)));
    const sup = prev.classes.find((p) => p.kind === c.kind && c.members.every((m) => p.members.includes(m)));
    if (subs.length) {
      // a link joined existing classes: those spiders (where they were) plus one per new link
      subs.forEach((p) => covered.add(p.key));
      const inSub = (l) => subs.some((p) => p.members.includes(c.memberOfTerm[pk(l.from)]) && p.members.includes(c.memberOfTerm[pk(l.to)]));
      const groups = subs.map((p) => ({ terminals: p.terminals.filter((k) => c.terminals.includes(k)), members: new Set(p.members), pos: p.pos, label: null }));
      for (const l of c.links.filter((x) => !inSub(x))) {
        const terms = [pk(l.from), pk(l.to)];
        groups.push({ terminals: terms, members: new Set(terms.map((k) => c.memberOfTerm[k])), pos: { x: c.pos.x + 46 * c.side, y: mean(terms.map((k) => env.anchors[k].y)) }, label: `${l.from.port} ${env.LS[l.kind].glyph} ${l.to.port}` });
      }
      out.push(fusion(env, c, groups, { dur: 900, hold: 0.2 }));
    } else if (sup) {
      covered.add(sup.key);
      out.push(slide(env, c, sup.pos, 700)); // a split: the part slides out of the old spider
    } else if (c.links.length > 1) {
      out.push(fusion(env, c, perLinkGroups(env, c, 62), { dur: 1400, hold: 0.4 }));
    } else {
      out.push(grow(env, c, 800));
    }
  }
  // what disappeared
  const nowTerms = new Set(classes.flatMap((c) => c.terminals));
  for (const p of prev.classes) {
    const gone = p.terminals.filter((k) => !nowTerms.has(k));
    const stillThere = classes.some((c) => c.kind === p.kind && c.members.some((m) => p.members.includes(m)));
    if (gone.length || !stillThere) out.push(ghost(env, p, gone, !stillThere && !covered.has(p.key), 650));
  }
  // a new guard: no spider forms; the read arc is drawn in
  if (ev && ev.type === 'link-added' && ev.link.kind === 'guard') {
    const g = env.guardEls[ev.link.index];
    if (g) out.push(waapi(g, [{ opacity: 0, offset: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0.35, offset: 0.7 }, { opacity: 1, offset: 1 }], 800));
  }
  return out;
}

// =====================================================================================
// CONNECT-4: shared tables as junctions (not spiders)
// =====================================================================================

function renderPlan(ctx, wrap) {
  const T = ctx.theme;
  const s = ctx.svg;
  const plan = ctx.plan.plan;
  const ev = ctx.event;
  const PAPER = T.PAPER || '#fafafa';
  ctx.note('A search plan has no event links, so there are no transition classes and nothing fuses: no spider is drawn here. The nearest honest picture is the plan\'s two pieces of shared state, drawn as junctions (hollow dots, not ZX spiders) with a leg to each part of the plan that game.rs and order.rs show reading, writing or capping them.', 'na');
  if (ctx.plan.error) ctx.note(`plan refused: ${ctx.plan.error}`, 'warn');

  const W = 1150, H = 700;
  const root = ctx.svgRoot(W, H);
  const TABLE = T.SEARCH_TYPE_COLOR.Table || '#178f7f';
  const KC = T.PIECE_KIND_COLOR;
  root.append(
    s('defs', {},
      s('marker', { id: 'sp-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,0 L10,5 L0,10 z', fill: TABLE })),
      s('marker', { id: 'sp-bar', viewBox: '0 0 10 10', refX: 5, refY: 5, markerWidth: 10, markerHeight: 10, orient: 'auto' }, s('path', { d: 'M5,0 V10', stroke: KC.Memo, 'stroke-width': 2.6 }))),
    s('rect', { x: 0, y: 0, width: W, height: H, fill: PAPER }),
    s('rect', { x: 262, y: 0, width: 528, height: H, fill: '#f1f7f6' }),
  );
  const gSlots = s('g', {}), gLegs = s('g', {}), gNodes = s('g', {}), gChips = s('g', {}), gText = s('g', {});
  root.append(gSlots, gLegs, gNodes, gChips, gText);

  // column headings
  const heading = (x, anchor, t1, t2, color) => gText.append(
    s('text', { x, y: 22, 'text-anchor': anchor, 'font-size': 11, 'font-weight': 700, fill: color, 'letter-spacing': '0.06em' }, t1),
    s('text', { x, y: 36, 'text-anchor': anchor, 'font-size': 10.5, fill: T.MUTED }, t2));
  heading(28, 'start', 'THE FIXED SEARCH', 'and the slots that wrap it', T.INK);
  heading(526, 'middle', 'SHARED TABLES · junctions, not spiders', 'hollow dots: state several parts read or write; nothing fuses', TABLE);
  heading(806, 'start', 'PIECES THAT TOUCH THEM', 'a leg only while the piece is in the plan', T.INK);

  const SL = {
    drivers: { x: 28, y: 52, w: 220, h: 112 },
    memo: { x: 806, y: 52, w: 316, h: 82 },
    order: { x: 806, y: 166, w: 316, h: 262 },
    filters: { x: 28, y: 460, w: 220, h: 96 },
    heuristics: { x: 28, y: 572, w: 220, h: 96 },
    bounds: { x: 806, y: 460, w: 316, h: 96 },
    engine: { x: 806, y: 572, w: 316, h: 96 },
  };
  const CORE = { x: 28, y: 196, w: 220, h: 232 };
  const TT = { x: 606, y: 236 }, HI = { x: 606, y: 382 };

  const wrapText = (x, y, text, maxW, size = 11, fill = T.MUTED, lh = 14) => {
    const words = text.split(' '), lines = [];
    let cur = '';
    for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (sansW(t, size) > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur);
    const t = s('text', { x, y, 'font-size': size, fill });
    lines.forEach((ln, i) => t.append(s('tspan', { x, dy: i ? lh : 0 }, ln)));
    gText.append(t);
    return lines.length;
  };

  const slotRect = (id, title, sub) => {
    const r = SL[id], slot = ctx.plan.slots.find((x) => x.id === id);
    const designed = !!slot.designed;
    const rect = s('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, fill: designed ? '#f4f5f7' : '#fff', stroke: designed ? '#b9bfc8' : '#aab2bd', 'stroke-width': 1.3, 'stroke-dasharray': designed ? '5 4' : null });
    gSlots.append(rect,
      s('text', { x: r.x + 12, y: r.y + 19, 'font-size': 12, 'font-weight': 700, fill: designed ? T.MUTED : T.INK }, title),
      sub ? s('text', { x: r.x + r.w - 12, y: r.y + 19, 'text-anchor': 'end', 'font-size': 10.5, fill: T.MUTED }, sub) : null);
    ctx.snap.slot(rect, id);
    ctx.hover(rect, ctx.info.slotInfo(id));
    return r;
  };

  const chips = {}; // `${slot}:${name}` -> {x,y,w,h,inner}
  const chip = (slotId, name, label, x, y, { ghost = false, index = null, tag = null } = {}) => {
    const p = ctx.plan.pieceByName[name];
    const kc = KC[p?.kind] || '#555';
    const w = monoW(label, 11.5) + (index !== null ? 40 : 22), h = 26;
    const outer = s('g', { transform: `translate(${x},${y})` });
    const inner = s('g', {});
    const face = s('g', {});
    face.append(s('rect', { x: 0, y: -h / 2, width: w, height: h, rx: 5, fill: ghost ? '#fbfbfc' : '#fff', stroke: kc, 'stroke-width': 1.6, 'stroke-dasharray': ghost ? '4 3' : null }),
      s('text', { x: 10, y: 4.2, 'font-size': 11.5, class: 'sp-mono', fill: kc }, label));
    ctx.hover(face, ctx.info.pieceInfo(name));
    inner.append(face);
    if (index !== null) {
      const xb = s('g', { class: 'sp-chip-x', transform: `translate(${w - 22},${-h / 2 + 3})` });
      xb.append(s('rect', { x: 0, y: 0, width: 18, height: h - 6, rx: 3, fill: 'transparent' }), s('text', { x: 9, y: 14, 'text-anchor': 'middle', 'font-size': 13, fill: T.LEAK }, '×'), s('title', {}, `remove ${name} from ${slotId}`));
      xb.addEventListener('pointerdown', (e) => e.stopPropagation());
      xb.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); ctx.actions.removePiece(slotId, index); });
      inner.append(xb);
    }
    outer.append(inner);
    if (tag) outer.append(s('text', { x: w + 10, y: 4, 'font-size': 10.5, fill: T.MUTED }, tag));
    gChips.append(outer);
    const c = { x, y, w, h, inner, name, slot: slotId };
    chips[`${slotId}:${name}`] = c;
    return c;
  };

  // drivers
  const drv = driversOf(plan);
  slotRect('drivers', 'drivers', 'touch neither table');
  if (!plan.drivers) {
    chip('drivers', 'null_window', 'null_window', SL.drivers.x + 12, SL.drivers.y + 46, { ghost: true });
    gText.append(s('text', { x: SL.drivers.x + 12, y: SL.drivers.y + 76, 'font-size': 10.5, fill: T.MUTED }, 'default: on (plan.rs:17-19)'));
  } else if (!plan.drivers.length) {
    wrapText(SL.drivers.x + 12, SL.drivers.y + 46, 'none, so null_window is off: one search over the whole reward range (plan.rs:17-19, game.rs:564-566)', SL.drivers.w - 24);
  } else {
    plan.drivers.forEach((d, i) => {
      const name = typeof d === 'string' ? d : Object.keys(d)[0];
      const label = name === 'budget' ? `budget {nodes: ${d.budget.nodes}}` : name;
      chip('drivers', name, label, SL.drivers.x + 12, SL.drivers.y + 46 + i * 32, { index: i });
    });
  }
  if (!drv.err && plan.drivers && plan.drivers.length === 1) {
    wrapText(SL.drivers.x + 12, SL.drivers.y + 78, drv.nullWindow
      ? 'its yes/no searches share the core\'s table (game.rs:23-28)'
      : 'null_window off: one search over the whole range (plan.rs:17-19; game.rs:564-566)', SL.drivers.w - 24, 10.5, T.MUTED, 13);
  }

  // memo
  slotRect('memo', 'memo', 'caps the transposition table');
  if (plan.memo) chip('memo', 'memo', `memo {entries: ${plan.memo.entries}}`, SL.memo.x + 12, SL.memo.y + 50, { index: 0 });
  else wrapText(SL.memo.x + 12, SL.memo.y + 42, 'none: the table is cleared past 2,000,000 entries between calls, and one search may grow it without limit (game.rs:469-470, 489-490)', SL.memo.w - 24, 10.5);

  // order chain
  const ch = chainOf(plan);
  slotRect('order', 'order chain', ch.isDefault ? 'not given: the default chain' : 'compared top first');
  const rowY = (i) => SL.order.y + 50 + i * 44;
  if (!ch.err) {
    if (!ch.pieces.length) wrapText(SL.order.x + 12, SL.order.y + 46, 'empty: ties keep the net\'s own move order (order.rs:197-199)', SL.order.w - 24);
    ch.pieces.forEach((name, i) => {
      const p = ctx.plan.pieceByName[name];
      chip('order', name, name, SL.order.x + 16, rowY(i), { ghost: ch.isDefault, index: ch.isDefault ? null : i, tag: `${i + 1}${['st', 'nd', 'rd'][i] || 'th'} · ${p?.decisive ? 'decisive · ' : ''}${p?.contract || ''}` });
    });
    if (ch.isDefault) gText.append(s('text', { x: SL.order.x + 12, y: SL.order.y + SL.order.h - 12, 'font-size': 10.5, fill: T.MUTED }, 'Chain::default (order.rs:205-216)'));
  }

  // filters, heuristics, designed slots
  const mode = plan.mode || 'exact';
  const why = mode === 'exact' ? 'exact mode refuses every one: it can change the value (plan.rs:221-236)' : 'play mode: none is built in this release (plan.rs:221-236)';
  slotRect('filters', 'filters', null);
  slotRect('heuristics', 'heuristics', null);
  for (const id of ['filters', 'heuristics']) wrapText(SL[id].x + 12, SL[id].y + 42, `empty. ${why}`, SL[id].w - 24, 10.5);
  slotRect('bounds', 'bounds', 'designed, not built');
  slotRect('engine', 'engine', 'designed, not built');
  wrapText(SL.bounds.x + 12, SL.bounds.y + 42, 'In the ROADMAP\'s design; not a SearchPlan field at c396d46, so nothing can be dropped here.', SL.bounds.w - 24, 10.5);
  wrapText(SL.engine.x + 12, SL.engine.y + 42, 'game.rs picks BitModel or IndexedModel itself; no plan field chooses it.', SL.engine.w - 24, 10.5);

  // core
  const core = s('g', {});
  core.append(s('rect', { x: CORE.x, y: CORE.y, width: CORE.w, height: CORE.h, rx: 8, fill: '#eef1f5', stroke: '#8d96a3', 'stroke-width': 1.4 }),
    s('text', { x: CORE.x + 12, y: CORE.y + 22, 'font-size': 13, 'font-weight': 700, fill: T.INK }, 'core'),
    s('text', { x: CORE.x + 50, y: CORE.y + 22, 'font-size': 11.5, class: 'sp-mono', fill: T.INK }, 'Solver::search'));
  gNodes.append(core);
  wrapText(CORE.x + 12, CORE.y + 44, 'Fail-soft alpha-beta (game.rs:590-693). Not a piece: the search is fixed and a plan chooses what swaps in (plan.rs:3-4).', CORE.w - 24, 11, T.MUTED);
  const sum = ctx.connect4.summary;
  if (sum) wrapText(CORE.x + 12, CORE.y + CORE.h - 30, `net: ${sum.name || 'connect-4'}, ${sum.places} places, ${sum.transitions} transitions`, CORE.w - 24, 10.5);
  ctx.hover(core, { title: 'the core search (fixed, not a piece)', facts: [['what', 'fail-soft alpha-beta in the +1 side\'s view'], ['tables', 'reads and writes the transposition table; lends the history table to the chain'], ['in the plan', 'no field: plan.rs fixes the search and a plan picks what swaps in']], cites: [C.search, C.planFixed, C.ttRead, C.store, C.ctxBuild, C.cutoff] });

  // junctions
  const inChain = (n) => !ch.err && ch.pieces.includes(n);
  const hasHistory = inChain('history');
  const junction = (pos, title, sub, info) => {
    const g = s('g', { class: 'sp-junction' });
    g.append(s('circle', { cx: pos.x, cy: pos.y, r: 18, fill: 'transparent' }),
      s('circle', { cx: pos.x, cy: pos.y, r: 9.5, fill: PAPER, stroke: TABLE, 'stroke-width': 3 }),
      s('text', { x: pos.x - 14, y: pos.y - 34, 'text-anchor': 'end', 'font-size': 12.5, 'font-weight': 700, fill: TABLE, class: 'sp-halo', stroke: '#f1f7f6' }, title),
      s('text', { x: pos.x - 14, y: pos.y - 20, 'text-anchor': 'end', 'font-size': 10.5, class: 'sp-mono sp-halo', fill: T.MUTED, stroke: '#f1f7f6' }, sub));
    ctx.hover(g, info);
    gNodes.append(g);
  };
  junction(TT, 'transposition table', 'Solver.tt · game.rs:454', {
    title: 'junction: the transposition table (shared state, not a spider)',
    facts: [
      ['entries', 'Entry { lo, hi, best } per position key (game.rs:440-444)'],
      ['read by', `the core (bounds and best move)${inChain('tt_best') ? '; tt_best, through Ctx.first' : ''}`],
      ['written by', 'the core, through store'],
      ['capped by', plan.memo ? `memo: ${plan.memo.entries} entries (with_memo)` : 'nothing: cleared past 2,000,000 entries between calls, unbounded inside one search'],
      ['shared', drv.err ? 'it persists across calls' : drv.nullWindow ? 'the yes/no searches null_window runs share it, and it persists across calls' : 'null_window is off, so one search over the whole range uses it; it persists across calls'],
    ],
    note: 'A junction, not a ZX spider: shared state that several parts read or write. Nothing fuses and no spider law applies.',
    cites: [C.entry, C.fields, C.ttShared, C.ttRead, C.store, C.withMemo, C.tableDefault, C.capDefault, C.clear, ...(drv.err || drv.nullWindow ? [] : [C.solveOne, C.planDrivers])],
  });
  junction(HI, 'history table', 'Solver.history · game.rs:455', {
    title: 'junction: the history table (shared state, not a spider)',
    facts: [
      ['entries', 'one u32 counter per transition (game.rs:485)'],
      ['read by', hasHistory ? 'History, through Ctx.history' : 'no piece in this chain'],
      ['written by', hasHistory ? 'History::cutoff only (history[t] += 1)' : 'nothing: every other piece\'s cutoff is a no-op'],
      ['lent by', 'the core: &history in Ctx, &mut history to chain.cutoff on a cutoff'],
    ],
    note: 'A junction, not a ZX spider. Without History in the chain the table is still allocated and lent, but nothing reads or writes it.',
    cites: [C.fields, C.histInit, C.ctxBuild, C.cutoff, C.chainCutoff, C.histKey, C.histCutoff, C.cutoffDefault, C.ctxDoc],
  });
  if (!hasHistory) gText.append(s('text', { x: HI.x, y: HI.y + 30, 'text-anchor': 'middle', 'font-size': 10.5, fill: T.MUTED, 'font-style': 'italic' },
    s('tspan', { x: HI.x }, 'nothing in this chain reads'), s('tspan', { x: HI.x, dy: 13 }, 'or writes it (order.rs:36-37)')));

  // legs: a two-line label (what, where) at a fixed spot beside each
  const legs = [];
  const leg = (d, opts, info, key) => {
    const g = s('g', {});
    const p = s('path', { d, fill: 'none', stroke: opts.color || TABLE, 'stroke-width': 2, 'stroke-dasharray': opts.dash || null, 'marker-end': opts.end || null, 'marker-start': opts.start || null });
    g.append(p, s('path', { d, class: 'sp-leg-hit' }));
    const [lx, ly, anchor] = opts.at;
    const t = s('text', { x: lx, y: ly, 'text-anchor': anchor || 'start', 'font-size': 11, class: 'sp-halo', stroke: '#f1f7f6' });
    t.append(s('tspan', { x: lx, fill: T.INK }, opts.label[0]), s('tspan', { x: lx, dy: 13, class: 'sp-mono', 'font-size': 10, fill: T.MUTED }, opts.label[1]));
    g.append(t);
    ctx.hover(g, info);
    gLegs.append(g);
    legs.push({ p, d, key });
  };
  const cx = CORE.x + CORE.w;
  leg(curveX(cx, CORE.y + 30, TT.x - 11, TT.y - 3), { start: 'url(#sp-arrow)', label: ['reads lo, hi, best', 'game.rs:601-611'], at: [cx + 14, CORE.y + 6] },
    { title: 'the core reads the table', facts: [['reads', 'lo and hi narrow the window or settle the node; best becomes Ctx.first']], cites: [C.ttRead, C.entry] }, 'core-tt-r');
  leg(curveX(cx, CORE.y + 76, TT.x - 11, TT.y + 4), { end: 'url(#sp-arrow)', label: ['writes it through store', 'game.rs:514-519, 616-623, 679-691'], at: [cx + 14, CORE.y + 100] },
    { title: 'the core writes the table', facts: [['writes', 'store: a final position\'s score, then each search\'s bounds merged with the old entry'], ['space', 'store checks cap (game.rs:516)']], cites: [C.store, C.storeLeaf, C.storeAfter] }, 'core-tt-w');
  leg(curveX(cx, CORE.y + 166, HI.x - 11, HI.y - 3), { start: 'url(#sp-arrow)', label: ['lends &history in Ctx', 'game.rs:628-633'], at: [cx + 14, CORE.y + 140] },
    { title: 'the core lends the history table to the pieces', facts: [['how', 'Ctx { first, history: &self.history } is built per node']], cites: [C.ctxBuild, C.ctxDoc] }, 'core-hi-r');
  leg(curveX(cx, CORE.y + 210, HI.x - 11, HI.y + 4), { end: 'url(#sp-arrow)', dash: hasHistory ? null : '4 4', label: ['reports a cutoff: chain.cutoff', 'game.rs:666 → order.rs:267-271'], at: [cx + 14, CORE.y + 232] },
    { title: 'the core reports a cutoff to the chain', facts: [['how', 'chain.cutoff(&mut self.history, t) calls every piece\'s cutoff'], ['who writes', hasHistory ? 'History::cutoff (history[t] += 1)' : 'nobody in this chain: Orderer::cutoff is a no-op by default']], cites: [C.cutoff, C.chainCutoff, C.histCutoff, C.cutoffDefault] }, 'core-hi-w');
  // piece legs: each label goes where it covers no other label, dot or leg
  const pobs = new Obstacles({ x: 262, y: 44, w: 540, h: H - 60 });
  for (const j of [TT, HI]) pobs.rect({ x: j.x - 150, y: j.y - 48, w: 172, h: 64 }); // dot and its title
  for (const l of legs) { const m = /^M([\d.-]+),([\d.-]+) C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/.exec(l.d); if (m) pobs.points(cubicAt(m.slice(1).map(Number), 40)); }
  for (const t of gLegs.querySelectorAll('text')) { const x = +t.getAttribute('x'), y = +t.getAttribute('y'); pobs.rect({ x, y: y - 11, w: 215, h: 28 }); }
  const legPts = (d) => { const m = /^M([\d.-]+),([\d.-]+) C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/.exec(d); return m ? cubicAt(m.slice(1).map(Number), 40) : []; };
  const pending = [];
  const pieceLeg = (...args) => { pending.push(args); pobs.points(legPts(args[2])); };
  const placePieceLeg = (chipC, J, d, label, opts, info, key) => {
    const w = Math.max(sansW(label[0], 11), monoW(label[1], 10)) + 6, h = 28;
    const xr = (chipC.slot === 'memo' ? SL.memo.x : SL.order.x) - 10;
    const cands = [
      { x: xr - w, y: chipC.y + 12, anchor: 'end' }, { x: xr - w, y: chipC.y - 12 - h, anchor: 'end' },
      { x: J.x + 18, y: J.y + 14, anchor: 'start' }, { x: J.x + 18, y: J.y - 14 - h, anchor: 'start' },
    ];
    for (let k = 1; k <= 8; k++) cands.push({ x: xr - w, y: chipC.y + 12 + k * 22, anchor: 'end' }, { x: xr - w, y: chipC.y - 12 - h - k * 22, anchor: 'end' }, { x: J.x + 18, y: J.y + 14 + k * 22, anchor: 'start' });
    for (const c of cands) { c.w = w; c.h = h; }
    const r = pobs.best(cands);
    pobs.rect(r);
    leg(d, { ...opts, label, at: [r.anchor === 'end' ? r.x + r.w : r.x, r.y + 11, r.anchor] }, info, key);
  };
  const ttb = chips['order:tt_best'];
  if (ttb) pieceLeg(ttb, TT, curveX(ttb.x, ttb.y, TT.x + 11, TT.y + 2), ['tt_best reads Ctx.first = e.best', 'game.rs:610 · order.rs:52-58'], { end: 'url(#sp-arrow)' },
    { title: 'tt_best reads the remembered best move', facts: [['key', 'the move equal to Ctx.first ranks first (decisive)'], ['set from', 'first = e.best when the table holds the position']], cites: [C.ttBestKey, C.ttRead, C.ctxDoc] }, 'ttbest');
  const hist = chips['order:history'];
  if (hist) pieceLeg(hist, HI, curveX(hist.x, hist.y, HI.x + 11, HI.y), ['History reads history[t]; its cutoff adds 1', 'order.rs:68-71, 73-75'], { start: 'url(#sp-arrow)', end: 'url(#sp-arrow)' },
    { title: 'History reads and writes the history table', facts: [['reads', 'key = cx.history[t]'], ['writes', 'cutoff: history[t] += 1, the only piece that writes it']], cites: [C.histKey, C.histCutoff, C.chainCutoff] }, 'history');
  const memo = chips['memo:memo'];
  if (memo) pieceLeg({ ...memo, y: memo.y - 16 }, TT, curveY(memo.x + 20, memo.y + 13, TT.x + 4, TT.y - 12), ['memo caps it: with_memo', 'game.rs:495-505 · plan.rs:247-249'], { end: 'url(#sp-bar)', color: KC.Memo, dash: '5 3' },
    { title: 'memo caps the transposition table', facts: [['how', 'with_memo sets table and cap: cleared past N between calls, never grown past N inside one search'], ['contract', 'value-preserving (ROADMAP: tested by a_memo_bounds_the_table_not_the_value)']], cites: [C.withMemo, C.planMemo, C.store, C.clear] }, 'memo');
  for (const args of pending) placePieceLeg(...args);

  wrap.append(root);

  // piece-added: the chip slides into its slot, its leg (if any) reaches the table
  if (ev && ev.type === 'piece-added' && !reduced()) {
    const c = chips[`${ev.slot}:${ev.name}`] || Object.values(chips).filter((x) => x.slot === ev.slot).pop();
    if (c) {
      const steps = [waapi(c.inner, [{ transform: 'translate(0px, -46px)', opacity: 0, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }, { offset: 0.6, transform: 'translate(0px, 4px)', opacity: 1 }, { transform: 'translate(0px, 0px)', opacity: 1 }], 760)];
      const key = { tt_best: 'ttbest', history: 'history', memo: 'memo' }[ev.name];
      const l = legs.find((x) => x.key === key);
      if (l) {
        const m = /^M([\d.-]+),([\d.-]+)/.exec(l.d);
        const x0 = +m[1], y0 = +m[2];
        const pre = curveX(x0, y0, x0 - 4, y0);
        steps.push(smilD(l.p, [pre, pre, l.d], [0, 0.35, 1], 900));
      }
      run(steps);
    }
  }
}
