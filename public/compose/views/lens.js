// View 7: open games / lenses. Connect-4: an analogy of SHAPE only, drawn for the
// search plan (Matt's request). Orders: the lens test and its fallback (lens-orders.js).
//
// Every piece of ctx.plan.plan is a lens box: a forward lane on top (left to
// right: positions and move lists going down the tree) and a backward lane
// underneath (right to left: values and bounds coming back up). Drivers nest
// around the alpha-beta core in the order game.rs runs them (budget outermost,
// then null_window), the order chain sits on the core's move-list lane, and the
// memo is a lens inside the core whose get feeds the forward pass and whose
// store is fed by the backward pass. Dashed loops are state carried from a
// backward pass into a later forward pass (the table, history).
//
// What is drawn comes from js/model/plan.js (chainOf, driversOf: ports of
// plan.rs) and every lane label cites the pflow-rs line it paraphrases. No
// search runs in the page; the "play" dot is illustrative.

import { cite, BIB } from '../sources.js';
import { chainOf, driversOf, PLAN_LAWS_CITE, CONNECT4_EXACT_CITE } from '../model.js';
import { renderOrders } from './lens-orders.js';

const rs = (path, from, to = from, note = '') => cite('pflowRs', `crates/pflow-metamodel/src/${path}`, from, to, note);
const road = (from, to, note) => cite('ontologyRoadmap', 'ROADMAP.md', from, to, note);

// Lines checked against pflow-rs c396d46 (crates/pflow-metamodel).
const C = {
  value: rs('game.rs', 526, 554, 'Solver::value: nodes reset to 0 (541, 548), then solve'),
  engine: rs('game.rs', 533, 553, 'value(): the bit engine when the marking fits, else counts'),
  budgetCount: rs('game.rs', 593, 597, 'search: nodes += 1; past the budget, None'),
  upSolve: rs('game.rs', 578, 580, 'solve: a None from a search is returned at once'),
  upSearch: rs('game.rs', 654, 656, 'search: a None from a child is returned at once'),
  budgetDefault: rs('plan.rs', 245, 245, 'no budget: usize::MAX'),
  driversDoc: rs('plan.rs', 17, 19, 'drivers: null_window on by default; budget gives a value up past N nodes'),
  solve: rs('game.rs', 556, 588, 'Solver::solve: yes/no searches, one per gap between adjacent rewards'),
  window: rs('game.rs', 573, 577, 'the value is one of vals[i..=j]; window (vals[k], vals[k+1]), the mover\'s worst gap first'),
  narrow: rs('game.rs', 578, 587, 'v > (a+b)/2: i = k+1, else j = k; returns vals[i]'),
  fullRange: rs('game.rs', 564, 566, 'null_window off (or under 3 rewards): one search over the whole range'),
  nwDefault: rs('plan.rs', 146, 162, 'drivers(): null_window on when drivers is absent, off when drivers is given without it'),
  rewards: rs('game.rs', 105, 122, 'rewards(): the distinct sums of the reward weights'),
  c4reward: cite('pflowRs', 'crates/pflow-metamodel/tests/common/mod.rs', 30, 30, 'Connect-4 rewards: win_x +1, win_o -1'),
  search: rs('game.rs', 590, 693, 'Solver::search: fail-soft alpha-beta'),
  ttGet: rs('game.rs', 599, 611, 'tt.get: a settled entry returns at once; else (a, b) narrowed and first = best'),
  leaf: rs('game.rs', 612, 625, 'no moves: the score, stored as exact'),
  children: rs('game.rs', 626, 643, 'children keyed by the chain, sorted best first'),
  loop: rs('game.rs', 653, 669, 'each child searched with (a, b); max/min; a >= b: chain.cutoff, break'),
  recurse: rs('game.rs', 654, 654, 'self.search(next, a, b): the core again, one level down'),
  cutoff: rs('game.rs', 665, 668, 'a >= b: self.chain.cutoff(&mut self.history, t); break'),
  boundsStore: rs('game.rs', 670, 691, 'the result as [lo, hi], merged with the old entry, stored'),
  store: rs('game.rs', 514, 519, 'store: only while the table holds fewer than cap entries (or has the key)'),
  withMemo: rs('game.rs', 495, 505, 'with_memo: table = cap = entries'),
  tableDefault: rs('game.rs', 469, 470, 'TABLE = 2,000,000 by default'),
  capDefault: rs('game.rs', 489, 490, 'table: TABLE, cap: usize::MAX'),
  clear: rs('game.rs', 529, 531, 'between calls: the table is cleared past `table` entries'),
  orderOnly: rs('order.rs', 1, 7, 'order never changes a value, only how soon a cutoff comes'),
  ctxRead: rs('order.rs', 15, 24, 'Ctx: what a piece may read (first, history)'),
  cutoffNoop: rs('order.rs', 36, 37, 'Orderer::cutoff: a no-op unless a piece overrides it'),
  ttBest: rs('order.rs', 52, 58, 'TtBest: key 1 for cx.first; DECISIVE'),
  immWin: rs('order.rs', 60, 66, 'ImmediateWin: key 1 when next is over and the mover wins; DECISIVE'),
  histKey: rs('order.rs', 68, 71, 'History: key = history[t]'),
  histCut: rs('order.rs', 73, 75, 'History::cutoff: history[t] += 1'),
  centrality: rs('order.rs', 90, 94, 'Centrality: key = centrality[t]'),
  threats: rs('order.rs', 96, 103, 'Threats: goals t feeds one token short after t'),
  chainKey: rs('order.rs', 249, 259, 'Chain::key: piece by piece, stopping at a decisive piece\'s nonzero key'),
  chainBefore: rs('order.rs', 261, 265, 'Chain::before: the first key to differ decides'),
  chainCutoff: rs('order.rs', 267, 271, 'Chain::cutoff: every piece\'s cutoff'),
  chainDefault: rs('order.rs', 205, 216, 'Chain::default: tt_best, immediate_win, history'),
  planChain: rs('plan.rs', 195, 210, 'chain(): no order gives Chain::default'),
  solver: rs('plan.rs', 240, 251, 'solver(): budget, chain, null_window flag, memo; mode is not read'),
  modeCheck: rs('plan.rs', 222, 236, 'filters / heuristics: exact refuses; play: not built'),
  driversFlags: rs('plan.rs', 146, 193, 'drivers(): read into flags, so their JSON order does not change the nesting'),
  spill: rs('game.rs', 544, 553, 'a run the bit engine cannot finish is redone over counts, nodes reset again'),
  valueErr: rs('game.rs', 101, 103, 'an Err, e.g. automatic transitions that never stop'),
  wireTypes: road(436, 436, 'ns:WireType: Position, Value, Value⊥, MoveList (PROPOSED)'),
  coreType: road(428, 430, 'the core as a box Position → Value⊥, drivers as nested boxes around it'),
  monoid: road(420, 423, 'orderers: a monoid under chaining, partial in code'),
};

// A few cites carried by js/model/plan.js (PIECES, SLOTS, SEARCH_CITES) are off
// by a line or more against c396d46 (reported); this view shows the checked
// ranges wherever it passes the model's cites through.
const FIXED = {
  'plan.rs:146-194': [146, 193], // drivers() ends at 193
  'plan.rs:15-18': [17, 19], // the drivers doc lines
  'plan.rs:221-236': [222, 236], // the filters/heuristics loop
  'plan.rs:113-118': [107, 112], // struct Memo (113-118 is Budget)
  'game.rs:556-591': [556, 588], // Solver::solve
  'game.rs:593-690': [590, 693], // Solver::search
  'game.rs:515-520': [514, 519], // Solver::store
  'game.rs:524-555': [526, 554], // Solver::value
  'game.rs:601-612': [599, 611], // the table read
};
const fixCite = (c) => {
  if (!c || c.repo !== 'pflowRs') return c;
  const f = FIXED[`${c.path.split('/').pop()}:${c.from}-${c.to}`];
  return f ? { ...c, from: f[0], to: f[1] } : c;
};
const fixCites = (cs) => (cs || []).map(fixCite);
/** Drops a cite whose file and lines an earlier one already gives. */
const uniqCites = (cs) => {
  const seen = new Set();
  return cs.filter((c) => { const k = `${c.repo}|${c.path}|${c.from}|${c.to}`; if (seen.has(k)) return false; seen.add(k); return true; });
};

const BIBKEYS = ['ghani-hedges', 'cybercat'].filter((k) => BIB[k]);
const ANALOGY = 'Lens reading: an analogy of shape only. No equilibrium is computed or checked, and no game-theoretic claim is made.';

// Lane text per piece: `fwd`/`bwd` for the inspector (full), `key`/`back` for the box (short).
const LENS = {
  budget: {
    fwd: 'counts nodes, passes the position on', bwd: 'the value, or ⊥ (None) past N nodes',
    extra: [['scope', 'nodes is reset only in value(), before each engine run (game.rs:541, 548), and counted in every search() call (game.rs:594): one budget covers every yes/no search of one solve() run, so it is the outermost frame. A run the bit engine cannot finish is redone over counts with the count reset (game.rs:544-553)'],
      ['⊥ goes straight up', 'a None from below is returned at once (game.rs:578-580, 654-656)'],
      ['absent', 'no budget: usize::MAX (plan.rs:245)']],
    cites: [C.value, C.budgetCount, C.upSolve, C.upSearch, C.spill, C.budgetDefault, C.driversDoc],
  },
  null_window: {
    fwd: 'picks the window (a,\u00a0b) for the next gap between adjacent rewards, the mover\'s worst gap first', bwd: 'v narrows (i,\u00a0j), repeat while i < j; returns vals[i]',
    extra: [['Connect-4', 'rewards win_x +1, win_o -1 (tests/common/mod.rs:30), so vals = [-1, 0, 1]: two gaps, at most two yes/no searches (game.rs:105-122, 573-586)'],
      ['off', 'drivers given without it: one search over the whole range, (a, b) = bounds (game.rs:564-566)']],
    cites: [C.solve, C.window, C.narrow, C.fullRange, C.nwDefault, C.driversDoc, C.rewards, C.c4reward],
  },
  memo: {
    fwd: 'get(k): a settled entry returns at once; otherwise [lo, hi] narrows (a, b) and the remembered best move goes to tt_best',
    bwd: 'store(k, lo, hi, best), capped at N entries; past N the table is cleared between calls',
    cites: [C.ttGet, C.store, C.boundsStore, C.withMemo, C.clear],
  },
  tt_best: {
    key: ['t = table best', 'decisive'],
    fwd: 'key 1 for the move the table remembers as best (cx.first), else 0; decisive: a nonzero key settles the rank',
    bwd: 'none of its own (cutoff is a no-op). Its forward reads what the backward pass stored: store (game.rs:514-519), then tt.get, then first (game.rs:601-611)',
    cites: [C.ttBest, C.ctxRead, C.cutoffNoop, C.store, C.ttGet],
  },
  immediate_win: {
    key: ['t wins now', 'decisive'],
    fwd: 'key 1 for a move that ends the game in the mover\'s favour; decisive', bwd: 'none (cutoff is a no-op)',
    cites: [C.immWin, C.cutoffNoop],
  },
  history: {
    key: ['history[t]', 'past cutoffs'],
    fwd: 'key = history[t]: how often t caused a cutoff before', bwd: 'a cutoff increments history[t] (order.rs:73-75, via chain.cutoff at game.rs:666)',
    cites: [C.histKey, C.histCut, C.chainCutoff, C.cutoff],
  },
  centrality: {
    key: ['goals t feeds', 'fixed per t'],
    fwd: 'key = centrality[t]: the mover\'s goals that t\'s output places feed, fixed per transition', bwd: 'none (cutoff is a no-op)',
    cites: [C.centrality, C.cutoffNoop],
  },
  threats: {
    key: ['goals 1 short', 'after t'],
    fwd: 'key = the goals t feeds that are one token short of enabled after t', bwd: 'none (cutoff is a no-op)',
    cites: [C.threats, C.cutoffNoop],
  },
};

// --- geometry -----------------------------------------------------------------

const PW = 86, PG = 8, BAND = 120, NEST = 24, FX0 = 92;
const YF = 220, YB = 384, CORE_TOP = 122;
const MEMO_TOP = YB + 26, YM1 = YB + 60, YM2 = YB + 114, MEMO_BOT = YB + 136;
const CORE_BOT = YB + 154;
const BUS = YF + 112;
const BULGE = 56; // the leaf cap's bulge

function geometry(plan) {
  const d = driversOf(plan), c = chainOf(plan);
  const g = { err: d.err || c.err || null };
  g.budget = d.err ? null : d.budget;
  g.nw = d.err ? false : d.nullWindow;
  g.chain = c.err ? [] : c.pieces;
  g.chainDefault = !c.err && c.isDefault;
  g.memo = plan.memo ? plan.memo.entries : null;
  const depth = (g.budget !== null ? 1 : 0) + (g.nw ? 1 : 0);
  g.frames = [];
  let x = FX0, lvl = depth;
  if (g.budget !== null) { g.frames.push({ id: 'budget', x, top: CORE_TOP - NEST * lvl }); x += BAND; lvl--; }
  if (g.nw) { g.frames.push({ id: 'null_window', x, top: CORE_TOP - NEST * lvl }); x += BAND; lvl--; }
  const cx = x;
  g.core = { x: cx, top: CORE_TOP, bottom: CORE_BOT };
  g.xK = cx + 14; g.xT = cx + 31; g.xW = cx + 48;
  g.expand = { x: cx + 56, w: 60 };
  let px = cx + 124;
  g.pieces = g.chain.map((name, i) => { const p = { name, i, x: px, w: PW }; px += PW + PG; return p; });
  const chainEnd = g.pieces.length ? px - PG : cx + 118;
  g.orderSock = { x: chainEnd + 8, w: 30 };
  g.chainBox = { x: (g.pieces.length ? g.pieces[0].x : g.orderSock.x) - 6, right: g.orderSock.x + g.orderSock.w + 6 };
  g.filtersSock = { x: g.orderSock.x + g.orderSock.w + 12, w: 58 };
  g.memoBox = { x: cx + 6, right: Math.max(g.orderSock.x + g.orderSock.w, cx + 440) };
  g.core.right = Math.max(g.filtersSock.x + g.filtersSock.w + 40, g.memoBox.right + 104);
  g.xCut = g.core.right - 84; g.xMM = g.core.right - 34; g.xStore = g.memoBox.right - 22;
  g.ghost = { x: g.core.right + 12, w: 80 };
  g.capX = g.ghost.x + g.ghost.w;
  g.frames.forEach((f, k) => { const j = depth - 1 - k; f.right = g.capX + 60 + 12 * j; f.bottom = CORE_BOT + 14 * (j + 1); });
  const right = g.frames.length ? g.frames[0].right : g.capX + 56;
  g.W = Math.max(1150, right + 14);
  const bottom = g.frames.length ? g.frames[0].bottom : CORE_BOT;
  g.legendY = bottom + 30;
  g.H = g.legendY + 62;
  g.hist = g.pieces.find((p) => p.name === 'history') || null;
  g.tt = g.pieces.find((p) => p.name === 'tt_best') || null;
  return g;
}

const fmt = (n) => Number(n).toLocaleString('en-US');

function wrap(text, width, size) {
  const max = Math.max(6, Math.floor(width / (size * 0.56)));
  const lines = [];
  let cur = '';
  for (const w of String(text).split(' ')) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

const CSS = `
.lens-bar { display: flex; align-items: center; gap: 10px; margin: 0 0 6px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.lens-play { font: inherit; border: 1.5px solid #2f6fb3; color: #2f6fb3; background: #fff; border-radius: 6px; padding: 3px 12px; cursor: pointer; font-weight: 600; }
.lens-play.on { background: #2f6fb3; color: #fff; }
.lens-bar .lens-ill { font-style: italic; }
.lens-svg text { font-family: var(--font-sans); fill: #2b2f36; }
.lens-svg text.mono, .lens-svg tspan.mono { font-family: var(--font-mono); }
.lens-svg .muted { fill: #6a717c; }
.lens-svg .halo { paint-order: stroke; stroke: var(--halo, #fafafa); stroke-width: 3.5px; stroke-linejoin: round; }
.lens-svg .inspectable:hover > .lens-box { stroke-width: 2.6; }
.lens-svg .lens-wire.inspectable:hover > .lens-stroke { stroke-width: 3.4; }
.lens-svg .lens-passive text { pointer-events: none; }
.lens-svg .lens-x { cursor: pointer; }
.lens-svg .lens-x circle { fill: #fff; stroke: #b9bec6; }
.lens-svg .lens-x text { fill: #6a717c; font-size: 10px; }
.lens-svg .lens-x:hover circle { fill: #c0392b; stroke: #c0392b; }
.lens-svg .lens-x:hover text { fill: #fff; }
.lens-svg .lens-sock { fill: rgba(255,255,255,0.55); stroke: #9aa3ad; stroke-width: 1.3; stroke-dasharray: 4 3; }
.lens-svg .lens-ghost { fill: none; stroke: #9aa3ad; stroke-width: 1.3; stroke-dasharray: 2 3; }
`;

// --- the view ---------------------------------------------------------------------

export default {
  id: 'lens',
  title: 'Open games / lenses (analogy)',
  short: 'Lenses',
  convention: {
    summary: 'In compositional game theory (Ghani, Hedges, Winschel, Zahn) an open game has the shape of a lens: a box with a forward lane (play goes in on the left and out on the right) and a backward lane (utility comes in on the right and out on the left); boxes compose by plugging one box\'s forward output into the next and the next\'s backward output back into the first. This view borrows that shape, and only the shape, for the Connect-4 search plan: positions and move lists go forward, down the tree, on the top lanes; values and bounds come back, up the tree, on the bottom lanes. Read a box by its two lanes; read nesting as "runs around".',
    examples: {
      orders: 'Strict test first: is queue ⊗ pool ⊗ saga, as go-pflow composes it, a lens composite? No: no place boundary is glued (go-pflow allows no token or data link among the three), and the parts\' backward maps do not fire together the way their forward maps do. The fallback ("assume a backward pass") finds every transition pair with a backward pass mechanically, draws the saga\'s steps as a chain of lenses with the pool and queue pairs above the step they fire with, and marks in red where the flat net stops being lens composition. Links dragged here re-run the check.',
      connect4: 'For plan:connect4-exact, budget ∘ null_window ∘ core, as game.rs nests them (the drawing follows the current plan as pieces are dropped or removed): each driver is a frame whose left band carries its two lanes; inside, the alpha-beta core turns a position into children, ranks them with the order chain (small lenses on the move-list lane) and turns child values back into a max/min with cutoffs. The memo is a lens inside the core: its get feeds the forward pass, its store is fed by the backward pass. Dashed loops are state a backward pass leaves for a later forward pass (the table for tt_best, history for history). The recursion and the leaf, where values come from, close the right end.',
    },
    honesty: [
      'Analogy of shape only. Open games characterise equilibria: a best-response condition on strategy profiles. This plan computes a value: minimax with alpha-beta under a node budget (game.rs:526-693). No equilibrium is computed or checked here, and no game-theoretic claim is made.',
      'Not a lens in the strict sense: alpha-beta interleaves the passes (each child\'s value comes back before the next child is tried, and a cutoff stops the forward pass, game.rs:653-668), and the table and history carry state from backward passes into later forward passes (dashed loops). The drawing shows the shape of one round trip, not a schedule.',
      'The nesting is game.rs\'s, not the JSON\'s: drivers are read into flags (plan.rs:146-193). budget counts nodes across every yes/no search of one solve() run (nodes is reset only in value(), before each engine run: game.rs:541, 548), so it is outermost; null_window wraps the root search. The ROADMAP\'s "Solver = drivers ∘ core[...]" is a PROPOSED reading, and it types the core Position → Value⊥ (ROADMAP:428-430): here ⊥ is drawn on the budget frame and passes through the inner lanes unchanged (game.rs:578-580, 654-656).',
      'Lane labels paraphrase the cited lines. Position, Value, Value⊥ and MoveList are the ROADMAP\'s PROPOSED wire types; Window, Table and Cutoff are this page\'s labels. The play dot is illustrative: no search runs in the page.',
      'Orders example: the strict test and the fallback are computed (js/model/lensfind.js) from go-pflow\'s link rules and Flatten as this page ports them; the probe wirings (release fused with undo_reserve, with and without commit) were also run through go-pflow itself and agree. Assumed in the fallback: the pair rule (a residual only t produces and only u consumes, resource places returned) and the forward pass (the commit scenario, judgment). The saga is a lens only on runs where no step fails: fail_ steps turn the forward lane back, which no lens map does.',
      'The CyberCat Institute is linked for context only; no claim on this page is attributed to it.',
    ],
    bib: BIBKEYS,
    cites: [CONNECT4_EXACT_CITE, C.value, C.solve, C.search, C.ttGet, C.loop, C.store, C.orderOnly, C.histCut, C.chainCutoff, C.planChain, C.nwDefault, C.driversFlags, C.solver, C.c4reward, PLAN_LAWS_CITE, C.coreType, C.wireTypes],
  },

  render(ctx) {
    ctx.root.appendChild(ctx.el('style', {}, CSS));
    if (ctx.example !== 'connect4') return renderOrders(ctx, { bib: BIBKEYS });
    return renderPlan(ctx);
  },
};

// --- connect-4: the plan as lenses --------------------------------------------------------

function renderPlan(ctx) {
  const S = ctx.svg;
  const plan = ctx.plan.plan;
  const G = geometry(plan);
  const col = ctx.theme.SEARCH_TYPE_COLOR;
  const KC = ctx.theme.PIECE_KIND_COLOR;
  const INK = ctx.theme.INK, MUTED = ctx.theme.MUTED;
  const TABLE = col.Table, CUT = col.Cutoff, WIN = col.Window, POS = col.Position, MOVES = col.MoveList, VAL = col.Value;

  const svgEl = ctx.svgRoot(G.W, G.H, { class: 'view-svg lens-svg' });
  const defs = S('defs', {});
  svgEl.append(defs, S('rect', { x: 0, y: 0, width: G.W, height: G.H, fill: '#fafafa' }));

  // arrowheads, one per color
  const markers = new Map();
  const arrow = (color) => {
    if (!markers.has(color)) {
      const id = `lens-arr-${markers.size}`;
      markers.set(color, id);
      defs.append(S('marker', { id, viewBox: '0 0 10 10', refX: 8.5, refY: 5, markerWidth: 9, markerHeight: 9, markerUnits: 'userSpaceOnUse', orient: 'auto' },
        S('path', { d: 'M0,0.5 L10,5 L0,9.5 z', fill: color })));
    }
    return `url(#${markers.get(color)})`;
  };
  const grad = S('linearGradient', { id: 'lens-cap', x1: 0, y1: 0, x2: 0, y2: 1 },
    S('stop', { offset: '0%', 'stop-color': POS }), S('stop', { offset: '100%', 'stop-color': VAL }));
  defs.append(grad);

  const T = (x, y, text, a = {}) => S('text', { x, y, 'font-size': 10.5, ...a }, text);
  const lines = (x, y, arr, a = {}, lh = 12.5) => S('text', { x, y, 'font-size': 10, ...a }, arr.map((s, i) => S('tspan', { x, dy: i ? lh : 0 }, s)));
  const info = (title, o = {}) => ({ title, note: ANALOGY, bib: BIBKEYS, ...o });

  /** A wire: optional halo for crossings, the stroke, an invisible fat hit path. */
  const wire = (d, color, o = {}) => {
    const g = S('g', { class: 'lens-wire' });
    if (o.halo) g.append(S('path', { d, fill: 'none', stroke: o.halo, 'stroke-width': (o.w || 2.2) + 5, 'stroke-linecap': 'round' }));
    g.append(S('path', { class: 'lens-stroke', d, fill: 'none', stroke: color, 'stroke-width': o.w || 2.2, 'stroke-dasharray': o.dash || null, 'stroke-linecap': 'round', 'marker-end': o.arrow === false ? null : arrow(color) }));
    g.append(S('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 12 }));
    if (o.info) ctx.hover(g, o.info);
    return g;
  };
  const removeX = (x, y, onClick, what) => {
    const b = S('g', { class: 'lens-x', transform: `translate(${x},${y})` }, S('circle', { r: 6.5 }), S('text', { y: 3.6, 'text-anchor': 'middle' }, '×'));
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onClick(); });
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.append(S('title', {}, `remove ${what} (the plan still passes plan.rs check)`));
    return b;
  };

  const layers = { frames: S('g', {}), core: S('g', {}), wires: S('g', {}), pieces: S('g', {}), over: S('g', {}) };

  // --- formula strip ----------------------------------------------------------
  const chainTxt = G.chain.length ? G.chain.join(' ▹ ') : '[] (identity: the net\'s own move order)';
  const parts = [];
  if (G.budget !== null) parts.push(`budget(${fmt(G.budget)})`);
  if (G.nw) parts.push('null_window');
  parts.push(`core[${G.chainDefault ? 'Chain::default = ' : ''}${chainTxt}; ${G.memo !== null ? `memo(${fmt(G.memo)})` : 'table: default'}]`);
  const formula = S('g', {},
    T(8, 24, 'plan as a composite', { class: 'muted', 'font-size': 10.5 }),
    T(118, 24, parts.join(' ∘ '), { class: 'mono', 'font-size': 12, 'font-weight': 600 }),
    T(G.W - 10, 24, `mode: ${plan.mode || 'exact'}${(plan.mode || 'exact') === 'play' ? ' (the same search: solver() does not read the mode)' : ''}`, { 'text-anchor': 'end', class: 'muted', 'font-size': 10.5 }));
  ctx.hover(formula, info('the plan as a composite', {
    definition: 'Drivers nested around the core, as game.rs runs them; the core holds the order chain and the memo. The ROADMAP (Phase 6) proposes reading this as Solver = drivers ∘ core[order chain, filters, bounds, memo].',
    facts: [['JSON', JSON.stringify(ctx.plan.json)], ['nesting', 'fixed by game.rs; the drivers\' order in the JSON does not change it (plan.rs:146-193)']],
    cites: [PLAN_LAWS_CITE, C.driversFlags, C.solver, CONNECT4_EXACT_CITE],
  }));
  layers.over.append(formula);

  // --- caller ---------------------------------------------------------------
  const caller = S('g', {},
    lines(10, YF - 44, ['Solver::', 'value(mk)'], { class: 'mono', 'font-size': 10.5, 'font-weight': 600 }, 13),
    T(10, YF - 9, 'position', { class: 'muted', 'font-size': 9.5 }),
    T(10, YB + 17, 'Option<f64>', { class: 'mono muted', 'font-size': 9.5 }),
    T(10, YB + 29, 'value or ⊥', { class: 'muted', 'font-size': 9.5 }));
  ctx.hover(caller, info('caller: Solver::value(mk)', {
    definition: 'The exact value (+1 side\'s view) of a settled position with both sides playing perfectly, or None past the budget (game.rs:526-527).',
    facts: [['forward in', 'the marking mk (a position)'], ['backward out', 'Result<Option<f64>>: Some(value), or ⊥ (None) past the budget'], ['not drawn', 'the Err case: e.g. automatic transitions that never stop (game.rs:101-103)']],
    cites: [C.value, C.valueErr],
  }));
  layers.over.append(caller);
  // engine: designed ghost
  {
    const y = (YF + YB) / 2 - 20;
    const r = S('rect', { class: 'lens-sock', x: 8, y, width: 74, height: 40, rx: 6 });
    const g = S('g', {}, r, T(45, y + 17, 'engine', { 'text-anchor': 'middle', 'font-size': 10, class: 'muted', 'font-weight': 600 }), T(45, y + 30, 'designed', { 'text-anchor': 'middle', 'font-size': 9, class: 'muted' }));
    ctx.snap.slot(r, 'engine');
    const base = ctx.info.slotInfo('engine');
    ctx.hover(g, { ...base, facts: [['today', 'game.rs picks the engine itself: the bit engine when the marking fits, else counts (game.rs:533-553)']], cites: [...fixCites(base.cites), C.engine] });
    layers.over.append(g);
  }

  // --- driver frames (outermost first) ------------------------------------------
  const frameFill = { budget: '#f3f6fa', null_window: '#e9eff7' };
  const sockY = 40;
  {
    const r = S('rect', { class: 'lens-sock', x: FX0, y: sockY, width: 116, height: 20, rx: 10 });
    const g = S('g', {}, r, T(FX0 + 58, sockY + 14, '⊕ drivers slot', { 'text-anchor': 'middle', 'font-size': 10, class: 'muted', 'font-weight': 600 }));
    ctx.snap.slot(r, 'drivers');
    const base = ctx.info.slotInfo('drivers');
    ctx.hover(g, { ...base, facts: [['drop', 'budget or null_window; game.rs nests them budget outside null_window whatever their JSON order'], ['now', G.frames.map((f) => f.id).join(' ∘ ') || 'none (drivers given empty: one search over the whole range)']], note: ANALOGY, cites: uniqCites([...fixCites(base.cites), C.driversFlags]) });
    layers.over.append(g);
  }
  for (const f of G.frames) {
    const L = LENS[f.id];
    const isB = f.id === 'budget';
    const fg = S('g', { class: 'lens-passive', 'data-lens-frame': f.id, style: { '--halo': frameFill[f.id] } });
    const box = S('rect', { class: 'lens-box', x: f.x, y: f.top, width: f.right - f.x, height: f.bottom - f.top, rx: 10, fill: frameFill[f.id], stroke: KC.Driver, 'stroke-width': 1.5 });
    fg.append(box);
    // band divider (where the inner box starts) is the inner frame's own edge; label the band
    const bx = f.x + 10, bw = BAND - 18;
    const tabTxt = isB ? `budget {nodes: ${fmt(G.budget)}}` : 'null_window';
    const tab = S('g', {}, S('rect', { x: f.x, y: f.top, width: ctx.textWidth(tabTxt, 10.5) * 1.02 + 54, height: 20, rx: 10, fill: KC.Driver }),
      T(f.x + 10, f.top + 14, tabTxt, { class: 'mono', 'font-size': 10.5, fill: '#fff', style: { fill: '#fff' }, 'font-weight': 600 }),
      T(f.x + ctx.textWidth(tabTxt, 10.5) * 1.02 + 16, f.top + 14, 'driver', { 'font-size': 9.5, style: { fill: '#dbe7f5' } }));
    const tabHit = S('rect', { x: f.x, y: f.top, width: ctx.textWidth(tabTxt, 10.5) * 1.02 + 54, height: 20, rx: 10, fill: 'transparent' });
    tab.append(tabHit);
    ctx.snap.slot(tabHit, 'drivers');
    const fwdL = wrap(`fwd: ${L.fwd.replace(', the mover\'s worst gap first', '')}`, bw, 10);
    const bwdText = isB ? `bwd: the value, or ⊥ (None) past ${fmt(G.budget)} nodes` : `bwd: ${L.bwd.replace(' while i < j', '')}`;
    const bwdL = wrap(bwdText, bw, 10);
    fg.append(tab,
      lines(bx, YF - 14 - (fwdL.length - 1) * 12.5, fwdL, { 'font-size': 10, class: 'halo' }),
      lines(bx, YB + 18, bwdL, { 'font-size': 10, class: 'halo' }));
    if (isB) {
      fg.append(lines(bx, (YF + YB) / 2 - 14, ['nodes += 1 at', 'every search node', 'below; ⊥ goes', 'straight up'], { 'font-size': 9.5, class: 'muted' }, 12));
    } else {
      // the repeat loop: backward feeds the next forward
      const lx = f.x + 16;
      fg.append(wire(`M${lx},${YB - 10} C${lx},${(YF + YB) / 2 + 30} ${lx},${(YF + YB) / 2 - 30} ${lx},${YF + 30}`, WIN, { w: 1.6, dash: '5 3', info: info('null_window: repeat while i < j', {
        definition: 'Each yes/no search narrows the range of possible values; the next search tests the next gap (game.rs:575-586).',
        facts: [['Connect-4', 'vals = [-1, 0, 1]: at most two searches'], ['not a lens law', 'a loop from the backward lane back into the forward lane: state between passes']],
        cites: [C.narrow, C.window, C.rewards, C.c4reward],
      }) }));
      fg.append(lines(lx + 10, (YF + YB) / 2 - 18, ['repeat', 'while i < j'], { 'font-size': 9.5, fill: WIN, style: { fill: WIN }, 'font-weight': 600 }, 12));
      fg.append(lines(lx + 10, (YF + YB) / 2 + 14, ['Connect-4:', 'vals = [-1, 0, 1]', '≤ 2 searches'], { 'font-size': 9.5, class: 'muted' }, 12));
    }
    const removeIdx = isB ? (plan.drivers || []).findIndex((d) => d && typeof d === 'object' && d.budget) : (plan.drivers || []).indexOf('null_window');
    fg.append(removeX(f.x + ctx.textWidth(tabTxt, 10.5) * 1.02 + 54 + 9, f.top + 10, () => ctx.actions.removePiece('drivers', removeIdx), f.id));
    const base = ctx.info.pieceInfo(f.id);
    const frameInfo = { ...base, facts: [...(base.facts || []), ['forward lane (top)', L.fwd], ['backward lane (bottom)', L.bwd], ...(L.extra || [])], note: `${base.note || ''} ${ANALOGY}`, cites: uniqCites([...fixCites(base.cites), ...L.cites]), bib: BIBKEYS };
    ctx.hover(box, frameInfo);
    ctx.hover(tab, frameInfo);
    layers.frames.append(fg);
  }

  // --- core frame -------------------------------------------------------------
  const cx = G.core.x, cr = G.core.right;
  const coreG = S('g', { class: 'lens-passive', style: { '--halo': '#fff' } });
  const coreBox = S('rect', { class: 'lens-box', x: cx, y: G.core.top, width: cr - cx, height: G.core.bottom - G.core.top, rx: 10, fill: '#fff', stroke: INK, 'stroke-width': 1.5 });
  const coreTab = 'core · alpha-beta (Solver::search)';
  coreG.append(coreBox,
    S('rect', { x: cx, y: G.core.top, width: ctx.textWidth(coreTab, 10.5) + 16, height: 20, rx: 10, fill: INK }),
    T(cx + 9, G.core.top + 14, coreTab, { 'font-size': 10.5, 'font-weight': 600, style: { fill: '#fff' } }),
    T(cx + 12, G.core.top + 38, 'fwd: position → children, tried in the chain\'s order', { 'font-size': 10.5 }),
    T(G.xCut - 14, YB - 9, 'bwd: child values → max/min, cutoffs', { 'font-size': 10.5, 'text-anchor': 'end', class: 'halo' }));
  const coreInfo = info('core: alpha-beta (Solver::search)', {
    definition: 'Fail-soft alpha-beta in the +1 side\'s view: inside the bounds every result is a bound on the true value; with the window the whole range, it is the value (game.rs:590-592).',
    facts: [['forward lane (top)', 'position → children, keyed by the chain and tried best first (game.rs:626-643)'],
      ['backward lane (bottom)', 'child values → max/min; a ≥ b is a cutoff: chain.cutoff, and the remaining children are not tried (game.rs:653-669)'],
      ['interleaving', 'each child\'s value comes back before the next child is tried, so forward and backward passes alternate: a lens runs one, then the other'],
      ['wire types', 'Position (+ window) → Value: a fail-soft bound inside (a, b)'],
      ['⊥ inside', 'the budget check is at the top of every search() (game.rs:594-597), and a None from a child is returned at once (game.rs:654-656): the ROADMAP\'s PROPOSED reading types the core Position → Value⊥ (ROADMAP:428-430). This drawing puts ⊥ on the budget frame, where it is decided']],
    cites: [C.search, C.children, C.loop, C.boundsStore, C.orderOnly, C.budgetCount, C.upSearch, C.coreType],
  });
  ctx.hover(coreBox, coreInfo);
  layers.core.append(coreG);

  // bounds: designed ghost
  {
    const x = G.expand.x, y = YF + 50;
    const r = S('rect', { class: 'lens-sock', x, y, width: G.expand.w, height: 40, rx: 6 });
    const g = S('g', {}, r, T(x + G.expand.w / 2, y + 17, 'bounds', { 'text-anchor': 'middle', 'font-size': 10, class: 'muted', 'font-weight': 600 }), T(x + G.expand.w / 2, y + 30, 'designed', { 'text-anchor': 'middle', 'font-size': 9, class: 'muted' }));
    ctx.snap.slot(r, 'bounds');
    const base = ctx.info.slotInfo('bounds');
    ctx.hover(g, { ...base, facts: [['ROADMAP', 'bounds compose by interval meet; not built (ROADMAP:424-425)'], ['placement', 'beside the window (a, b) it would narrow: this page\'s judgment']], cites: [...fixCites(base.cites), road(424, 425, 'Bounds: interval meet. Neither is built.')] });
    layers.core.append(g);
  }

  // expand: position → children
  {
    const x = G.expand.x, w = G.expand.w;
    const g = S('g', {},
      S('rect', { class: 'lens-box', x, y: YF - 32, width: w, height: 60, rx: 6, fill: '#f4f7fb', stroke: POS, 'stroke-width': 1.2 }),
      T(x + w / 2, YF - 15, 'moves(w)', { 'text-anchor': 'middle', class: 'mono', 'font-size': 10, 'font-weight': 600 }),
      T(x + w / 2, YF + 15, 'children', { 'text-anchor': 'middle', 'font-size': 9.5, class: 'muted' }));
    ctx.hover(g, info('position → children', {
      definition: 'The moves enabled at the position; each is played and settled into a child, then keyed by the order chain (game.rs:612-642).',
      facts: [['forward', 'Position → MoveList'], ['leaf', 'no moves: the score comes back at once and is stored as exact (game.rs:612-625)']],
      cites: [C.children, C.leaf],
    }));
    layers.pieces.append(g);
  }

  // --- lanes -------------------------------------------------------------------
  const laneInfo = (type, carries, cites, extra = []) => info(`${type === 'Position' || type === 'MoveList' ? 'forward' : 'backward'} lane: ${type}`, {
    facts: [['carries', carries], ['wire type', `${type} (${['Position', 'MoveList', 'Value', 'Value⊥'].includes(type) ? 'ROADMAP ns:WireType, PROPOSED' : 'this page\'s label'})`], ...extra],
    cites: uniqCites([...cites, C.wireTypes]),
  });
  const fx = [8, ...G.frames.map((f) => f.x), cx];
  for (let i = 0; i < fx.length - 1; i++) {
    layers.wires.append(wire(`M${fx[i]},${YF} H${fx[i + 1] - 1}`, POS, { info: laneInfo('Position', i === 0 ? 'the position mk, into the search' : 'the position, passed on', [C.value]) }));
  }
  layers.wires.append(wire(`M${cx},${YF} H${G.expand.x - 1}`, POS, { info: laneInfo('Position', 'the position (with its window)', [C.ttGet]) }));
  layers.wires.append(wire(`M${G.expand.x + G.expand.w},${YF} H${cr - 1}`, MOVES, { info: laneInfo('MoveList', 'the children, ranked by the chain; filters would drop some (none built)', [C.children, C.orderOnly]) }));
  layers.wires.append(wire(`M${cr},${YF} H${G.ghost.x - 1}`, POS, { info: laneInfo('Position', 'each child, best first, with the window (a, b)', [C.recurse]) }));
  layers.wires.append(wire(`M${G.ghost.x},${YF} H${G.capX}`, POS, { dash: '5 4', arrow: false, info: laneInfo('Position', 'down the tree, level after level', [C.recurse]) }));
  // the leaf cap: forward turns into backward
  {
    const d = `M${G.capX},${YF} C${G.capX + BULGE},${YF} ${G.capX + BULGE},${YB} ${G.capX + 2},${YB}`;
    const g = S('g', {},
      S('path', { d, fill: 'none', stroke: 'url(#lens-cap)', 'stroke-width': 2.4, 'marker-end': arrow(VAL) }),
      S('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 14 }),
      lines(G.capX + 19, (YF + YB) / 2 - 4, ['leaf', 'score'], { 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 600 }, 12));
    g.querySelectorAll('tspan').forEach((t) => t.setAttribute('x', G.capX + 19));
    ctx.hover(g, info('leaf: the forward lane turns back', {
      definition: 'Where values come from: a position with no moves is scored and stored as exact (game.rs:612-625). In an open game, this end is where the utility comes in; here it is the reward of a final marking.',
      facts: [['Connect-4 rewards', 'win_x +1, win_o -1 (tests/common/mod.rs:30)'], ['analogy', 'only the turning-around shape is borrowed']],
      cites: [C.leaf, C.c4reward],
    }));
    layers.pieces.append(g);
  }
  // With a budget, a None decided at the top of some search() passes back through every inner lane.
  const botFact = G.budget !== null ? [['with the budget', 'a ⊥ (None) from below passes through unchanged (game.rs:578-580, 654-656); it is drawn on the budget frame, where it is decided (game.rs:594-597)']] : [];
  const botCites = G.budget !== null ? [C.upSearch, C.upSolve, C.budgetCount] : [];
  layers.wires.append(wire(`M${G.capX},${YB} H${G.ghost.x}`, VAL, { dash: '5 4', arrow: false, info: laneInfo('Value', 'values coming back up, level after level', [C.loop, ...botCites], botFact) }));
  layers.wires.append(wire(`M${G.ghost.x},${YB} H${cr + 1}`, VAL, { info: laneInfo('Value', 'v: one child\'s value, back into the max/min', [C.loop, ...botCites], botFact) }));
  layers.wires.append(wire(`M${cr},${YB} H${cx + 1}`, VAL, { info: laneInfo('Value', 'v: a fail-soft bound inside (a, b), or the value when the window is the whole range', [C.loop, C.boundsStore, ...botCites], botFact) }));
  // backward segments: region 0 is the caller, region k >= 1 the band of frames[k-1]
  for (let i = fx.length - 1; i > 0; i--) {
    const f = i >= 2 ? G.frames[i - 2] : null;
    const type = !f || f.id === 'budget' ? 'Value⊥' : 'Value';
    const carries = !f ? 'Option<f64>: the value, or ⊥ (None)' : f.id === 'budget' ? 'the value, or ⊥ (None) past the budget' : 'vals[i]: the value the yes/no searches settle on';
    const inner = f && f.id !== 'budget';
    layers.wires.append(wire(`M${fx[i]},${YB} H${fx[i - 1] + 1}`, VAL, { info: laneInfo(type, carries, f ? [...LENS[f.id].cites.slice(0, 3), ...(inner ? botCites : [])] : [C.value], inner ? botFact : []) }));
  }
  // window (a, b): from where it is chosen to the core entry
  {
    const nwF = G.frames.find((f) => f.id === 'null_window');
    const x0 = nwF ? nwF.x + 62 : (G.frames.length ? G.frames[G.frames.length - 1].x + 62 : 34);
    const lbl = nwF ? '(a, b)' : '(a, b) = bounds';
    const winInfo = info(`window ${lbl}`, {
      definition: nwF ? 'null_window picks the window for the next gap between adjacent rewards (game.rs:576-577).' : 'Without null_window, solve() runs one search over the whole range: (a, b) = the reward bounds (game.rs:564-566).',
      facts: [['wire type', 'Window (this page\'s label)'], ['carried', 'with the position, into every child\'s search (game.rs:654)']],
      cites: nwF ? [C.window, C.solve] : [C.fullRange],
    });
    layers.wires.append(wire(`M${x0},${YF + 9} H${G.xW - 3}`, WIN, { w: 1.6, arrow: false, info: winInfo }));
    layers.wires.append(S('circle', { cx: x0, cy: YF + 9, r: 2.6, fill: WIN }));
    const winLbl = lines(x0 + 2, YF + 23, nwF ? [lbl] : ['(a, b) =', 'bounds'], { 'font-size': 9.5, 'font-weight': 600, style: { fill: WIN }, class: 'halo' }, 11.5);
    ctx.hover(winLbl, winInfo);
    layers.over.append(winLbl);
  }

  // --- memo (a lens inside the core) --------------------------------------------------
  {
    const mx = G.memoBox.x, mr = G.memoBox.right, present = G.memo !== null;
    const mg = S('g', { class: 'lens-passive', 'data-lens-memo': present ? '1' : '0', style: { '--halo': present ? '#eff7f5' : '#fff' } });
    const box = S('rect', { class: present ? 'lens-box' : 'lens-sock', x: mx, y: MEMO_TOP, width: mr - mx, height: MEMO_BOT - MEMO_TOP, rx: 8, fill: present ? '#eff7f5' : 'rgba(255,255,255,0.6)', stroke: present ? TABLE : '#9aa3ad', 'stroke-width': 1.4 });
    mg.append(box);
    ctx.snap.slot(box, 'memo');
    const tab = present ? `memo {entries: ${fmt(G.memo)}}` : 'memo slot: empty, the core keeps its default table';
    const tabW = ctx.textWidth(tab, present ? 10.5 : 10) * (present ? 1.02 : 0.95) + 20;
    mg.append(S('rect', { x: mx + 8, y: MEMO_BOT - 10, width: tabW, height: 20, rx: 10, fill: present ? TABLE : '#fff', stroke: present ? TABLE : '#9aa3ad', 'stroke-dasharray': present ? null : '4 3', 'pointer-events': 'none' }),
      T(mx + 18, MEMO_BOT + 4, tab, { class: present ? 'mono' : 'muted', 'font-size': present ? 10.5 : 10, 'font-weight': 600, style: { fill: present ? '#fff' : MUTED } }));
    const fwdT = `fwd: get(k): [lo, hi] narrows (a, b); ${G.tt ? 'best move → tt_best' : 'best move: no piece reads it'}`;
    const bwdT = present ? `bwd: store(k, lo, hi, best), capped at ${fmt(G.memo)} entries` : 'bwd: store (default: no cap inside a search)';
    mg.append(T(G.xW + 12, YM1 + 16, fwdT, { 'font-size': 10 }), T(G.xW + 12, YM2 - 7, bwdT, { 'font-size': 10 }));
    // table icon (state)
    const tx = G.xT, ty = (YM1 + YM2) / 2;
    const table = S('g', {},
      S('path', { d: `M${tx - 13},${ty - 9} v18 a13,4 0 0 0 26,0 v-18`, fill: '#fff', stroke: TABLE, 'stroke-width': 1.3 }),
      S('ellipse', { cx: tx, cy: ty - 9, rx: 13, ry: 4, fill: '#d9efea', stroke: TABLE, 'stroke-width': 1.3 }),
      T(tx, ty + 6, 'tt', { 'text-anchor': 'middle', 'font-size': 9, class: 'mono', fill: TABLE, style: { fill: TABLE } }));
    ctx.hover(table, info('the transposition table (state)', {
      definition: 'Solver.tt: what earlier searches found, keyed by a 128-bit hash of the marking. It persists across calls, so the backward pass of one search feeds the forward pass of later ones.',
      facts: [['cap', present ? `${fmt(G.memo)} entries (with_memo)` : 'none inside a search; cleared past 2,000,000 entries between calls (default)'], ['not a lens', 'shared state between passes, drawn as a dashed loop']],
      cites: [C.store, C.withMemo, C.tableDefault, C.capDefault, C.clear],
    }));
    mg.append(table);
    const base = ctx.info.pieceInfo('memo');
    const memoInfo = present
      ? { ...base, facts: [...(base.facts || []), ['forward lane (top)', LENS.memo.fwd], ['backward lane (bottom)', LENS.memo.bwd]], note: `${base.note || ''} ${ANALOGY}`, cites: [...fixCites(base.cites), ...LENS.memo.cites], bib: BIBKEYS }
      : { ...ctx.info.slotInfo('memo'), facts: [['empty', 'no memo in the plan: the core still keeps a table, with no cap inside one search and cleared past 2,000,000 entries between calls'], ['drop', 'memo, to cap it at N entries']], cites: [C.tableDefault, C.capDefault, C.clear, C.withMemo], note: ANALOGY };
    ctx.hover(box, memoInfo);
    if (present) mg.append(removeX(mx + 8 + tabW + 10, MEMO_BOT, () => ctx.actions.removePiece('memo', 0), 'memo'));
    layers.core.append(mg);
    // memo lanes
    const bestX = G.tt ? G.tt.x - 4 : null;
    const fEnd = bestX !== null ? bestX : G.xW;
    layers.wires.append(wire(`M${G.xK},${YM1} H${fEnd}`, TABLE, { w: 1.8, arrow: false, info: laneInfo('Table', 'get(k): the entry for this position, if any', [C.ttGet], [['forward lane of the memo', LENS.memo.fwd]]) }));
    layers.wires.append(wire(`M${G.xStore},${YM2} H${tx + 15}`, TABLE, { w: 1.8, info: laneInfo('Table', 'store(k, lo, hi, best) into the table', [C.store, C.boundsStore], [['backward lane of the memo', LENS.memo.bwd]]) }));
    // get reads the table
    layers.wires.append(wire(`M${tx},${ty - 14} V${YM1 + 4}`, TABLE, { w: 1.4, dash: '3 2', info: info('get reads the table', { cites: [C.ttGet] }) }));
    // k down, window up, best up, store down (crossing wires get a halo)
    const H = present ? '#eff7f5' : '#fff';
    layers.wires.append(wire(`M${G.xK},${YF + 2} V${YM1 - 3}`, TABLE, { w: 1.6, halo: '#fff', info: info('k: the position\'s key, to the table', { definition: 'w.key(): a 128-bit hash of the marking, the table\'s key (game.rs:599).', cites: [C.ttGet] }) }));
    layers.wires.append(wire(`M${G.xW},${YM1} V${YF + 12}`, TABLE, { w: 1.6, halo: '#fff', info: info('[lo, hi] narrows the window', { definition: 'a = max(a, lo), b = min(b, hi); a settled entry (lo = hi, lo ≥ b or hi ≤ a) returns at once without searching (game.rs:601-609).', cites: [C.ttGet] }) }));
    layers.wires.append(S('circle', { cx: G.xW, cy: YF + 9, r: 3.2, fill: '#fff', stroke: WIN, 'stroke-width': 1.6 }));
    if (bestX !== null) {
      layers.over.append(wire(`M${bestX},${YM1} V${YF + 14} H${G.tt.x + 7}`, TABLE, { w: 1.6, dash: '5 3', halo: '#fff', info: info('state: the table\'s best move → tt_best', {
        definition: 'tt_best\'s forward reads what an earlier backward pass stored: store (game.rs:514-519) writes Entry.best, tt.get reads it into first (game.rs:610), and Ctx carries it to the chain (game.rs:628-633, order.rs:20-21).',
        facts: [['not a lens', 'a loop through state: backward pass, table, a later forward pass']],
        cites: [C.store, C.ttGet, C.ctxRead, C.ttBest],
      }) }));
    }
    const storeInfo = info('[lo, hi], best: stored', { definition: 'After the children: the result as [lo, hi] (fail-soft), merged with what the table knew, stored with the best move (game.rs:670-691). A leaf is stored as exact (game.rs:614-623).', cites: [C.boundsStore, C.store, C.leaf] });
    layers.wires.append(wire(`M${G.xStore},${YB + 2} V${YM2 - 3}`, TABLE, { w: 1.6, halo: H, info: storeInfo }));
    const storeLbl = T(G.xStore - 6, YB + 18, 'lo, hi, best', { 'text-anchor': 'end', 'font-size': 9.5, fill: TABLE, style: { fill: TABLE }, class: 'halo' });
    ctx.hover(storeLbl, storeInfo);
    layers.over.append(storeLbl);
  }

  // --- the order chain on the move-list lane -------------------------------------------
  {
    const cb = G.chainBox;
    const under = S('rect', { x: cb.x, y: YF - 50, width: cb.right - cb.x, height: 148, rx: 9, fill: '#fcf7ef', stroke: '#ecd9bb', 'stroke-width': 1 });
    ctx.snap.slot(under, 'order');
    const cap = G.chainDefault ? 'order chain · Chain::default (no "order" in the plan)' : (G.pieces.length ? 'order chain · the first key to differ decides' : 'order chain · [] (identity)');
    const capT = T(cb.x + 7, YF - 37, ctx.textWidth(cap, 9.5) < cb.right - cb.x - 12 ? cap : 'order chain', { 'font-size': 9.5, class: 'muted', 'font-weight': 600 });
    const g = S('g', {}, under, capT);
    const base = ctx.info.slotInfo('order');
    ctx.hover(g, { ...base, title: 'the order chain (pieces drawn as lenses: analogy)', facts: [['now', G.chain.join(', ') || '[] (the net\'s own move order)'], ['composition', 'keys compared piece by piece, the first to differ decides; a decisive piece\'s nonzero key settles the rank (order.rs:249-265)'], ['ROADMAP', 'a monoid under chaining with [] the identity, and a partial one in code: chains over 8 pieces and repeated pieces are refused (ROADMAP:420-423)'], ['law', 'every piece is order-only, so the chain is: no order changes the value (order.rs:1-7)'], ['default', G.chainDefault ? 'yes: no "order" field, so Chain::default (order.rs:205-216); removing a piece spells the rest out as "order"' : 'no: the plan names the chain']], note: ANALOGY, cites: [...fixCites(base.cites), C.chainKey, C.chainBefore, C.orderOnly, C.chainDefault, C.planChain, C.monoid] });
    layers.core.append(g);
    // + socket
    const os = G.orderSock;
    const sr = S('rect', { class: 'lens-sock', x: os.x, y: YF - 32, width: os.w, height: 60, rx: 6 });
    ctx.snap.slot(sr, 'order');
    const sg = S('g', {}, sr, T(os.x + os.w / 2, YF - 9, '+', { 'text-anchor': 'middle', 'font-size': 15, class: 'muted', 'font-weight': 600 }), T(os.x + os.w / 2, YF + 17, 'order', { 'text-anchor': 'middle', 'font-size': 8.5, class: 'muted' }));
    ctx.hover(sg, { ...base, facts: [['drop', 'an order piece: it joins the end of the chain (plan.rs check decides)']], note: ANALOGY });
    layers.pieces.append(sg);
    // filters socket (identity on the lane: none built)
    const fs = G.filtersSock;
    const fr = S('rect', { class: 'lens-sock', x: fs.x, y: YF - 32, width: fs.w, height: 60, rx: 6 });
    ctx.snap.slot(fr, 'filters');
    const fg = S('g', {}, fr, T(fs.x + fs.w / 2, YF - 10, 'filters', { 'text-anchor': 'middle', 'font-size': 10, class: 'muted', 'font-weight': 600 }), T(fs.x + fs.w / 2, YF + 17, 'none built', { 'text-anchor': 'middle', 'font-size': 8.5, class: 'muted' }));
    const fb = ctx.info.slotInfo('filters');
    ctx.hover(fg, { ...fb, facts: [['plan.rs', 'filters and heuristics are names of pieces that can change the value; none is built (plan.rs:21-23)'], ['ROADMAP', 'sound filters (must_win, non_losing) are PROPOSED: a meet-semilattice under intersection (ROADMAP:424)'], ['placement', 'on the move-list lane, after the chain: this page\'s judgment'], ['today', 'none built: exact mode refuses a filter (it can change the value); play mode: not built in this release'], ['empty slot', 'the identity: the lane passes through unchanged']], cites: uniqCites([...fixCites(fb.cites), C.modeCheck, rs('plan.rs', 21, 23, 'filters, heuristics: names of pieces that can change the value; none built'), road(424, 425, 'Sound filters: a meet-semilattice under intersection')]), note: ANALOGY });
    layers.pieces.append(fg);
  }

  // pieces
  // Removing piece i. On Chain::default (no "order" in the plan), js/model/plan.js
  // withoutPiece starts from [] and would leave the identity chain, not the default
  // minus one piece (reported). Work around it here with the same checked actions:
  // "order": [] first, then the kept pieces one by one (each through slotCandidates,
  // the plan.rs check port). The last call replaces the event, so nothing animates
  // as if it had been added.
  const removeFromChain = (i) => {
    if (!G.chainDefault) { ctx.actions.removePiece('order', i); return; }
    const keep = G.chain.filter((_, k) => k !== i);
    ctx.actions.removePiece('order', 0);
    for (const n of keep) ctx.actions.addPiece(n, 'order');
    ctx.actions.setMode(plan.mode || 'exact');
  };
  for (const p of G.pieces) {
    const L = LENS[p.name];
    const isHist = p.name === 'history';
    const pg = S('g', { class: 'lens-passive', 'data-lens-piece': p.name, style: { '--halo': '#fff' } });
    const box = S('rect', { class: 'lens-box', x: p.x, y: YF - 32, width: p.w, height: 122, rx: 7, fill: '#fff', stroke: KC.Order, 'stroke-width': 1.4 });
    pg.append(box,
      S('path', { d: `M${p.x + 1},${YF + 28} H${p.x + p.w - 1} V${YF - 25} a6,6 0 0 0 -6,-6 H${p.x + 7} a6,6 0 0 0 -6,6 Z`, fill: '#fbf1e2', stroke: 'none', 'pointer-events': 'none' }),
      S('line', { x1: p.x, y1: YF + 28, x2: p.x + p.w, y2: YF + 28, stroke: '#e3c79c', 'stroke-dasharray': '3 2', 'pointer-events': 'none' }),
      S('line', { x1: p.x, y1: YF, x2: p.x + p.w, y2: YF, stroke: MOVES, 'stroke-width': 2.2, 'pointer-events': 'none' }),
      T(p.x + p.w / 2, YF - 15, p.name, { 'text-anchor': 'middle', class: 'mono', 'font-size': 10, 'font-weight': 600, fill: KC.Order, style: { fill: KC.Order } }),
      lines(p.x + p.w / 2, YF + 12, L.key, { 'text-anchor': 'middle', 'font-size': 9.5 }, 11));
    pg.querySelectorAll('tspan').forEach((t) => t.setAttribute('x', p.x + p.w / 2));
    // backward lane of the piece
    const by = YF + 56;
    if (isHist) {
      pg.append(wire(`M${p.x + p.w - 12},${YF + 90} V${by} H${p.x + 12}`, CUT, { w: 2, info: info('history: backward lane', { definition: LENS.history.bwd, cites: [C.histCut, C.chainCutoff, C.cutoff] }) }));
      pg.append(wire(`M${p.x + 9},${by - 4} C${p.x + 2},${by - 16} ${p.x + 4},${YF + 30} ${p.x + 10},${YF + 26}`, CUT, { w: 1.4, dash: '3 2', info: info('state: history[t], read by the next forward pass', { definition: 'history[t] += 1 on a cutoff (order.rs:73-75); the key of t is history[t] next time (order.rs:68-71). A loop through state, not a lens law.', cites: [C.histCut, C.histKey] }) }));
      const ht = lines(p.x + p.w / 2 - 5, by + 15, ['history[t]', '+= 1'], { 'text-anchor': 'middle', class: 'mono', 'font-size': 9.5, fill: CUT, style: { fill: CUT } }, 11);
      pg.append(ht);
    } else {
      pg.append(S('line', { x1: p.x + p.w - 12, y1: by, x2: p.x + 12, y2: by, stroke: '#c3c8cf', 'stroke-width': 1.2, 'stroke-dasharray': '1.5 3', 'pointer-events': 'none' }),
        T(p.x + p.w / 2, by + 16, 'no backward', { 'text-anchor': 'middle', 'font-size': 9.5, class: 'muted', 'font-style': 'italic' }));
    }
    pg.append(removeX(p.x + p.w - 2, YF - 31, () => removeFromChain(p.i), p.name));
    const base = ctx.info.pieceInfo(p.name);
    ctx.hover(box, { ...base, title: `${base.title} (a lens on the move-list lane)`, facts: [...(base.facts || []), ['position in the chain', `${p.i + 1} of ${G.pieces.length}`], ['forward lane (top)', L.fwd], ['backward lane (bottom)', L.bwd], ['lane types', 'MoveList → MoveList; order-only, so the value cannot change (order.rs:1-7)']], note: `${base.note || ''} ${ANALOGY}`, cites: uniqCites([...fixCites(base.cites), ...L.cites, C.orderOnly]), bib: BIBKEYS });
    layers.pieces.append(pg);
  }

  // --- max/min, cutoff, the cutoff bus ----------------------------------------------
  {
    const mm = S('g', {},
      S('rect', { class: 'lens-box', x: G.xMM - 24, y: YB - 11, width: 48, height: 22, rx: 11, fill: '#fff', stroke: VAL, 'stroke-width': 1.4 }),
      T(G.xMM, YB + 4, 'max/min', { 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 600, fill: VAL, style: { fill: VAL } }));
    ctx.hover(mm, info('max / min over the children', { definition: 'The mover maximizes (s > 0) or minimizes; a = max(a, v) or b = min(b, v) (game.rs:657-664).', cites: [C.loop] }));
    const dia = S('g', {},
      S('path', { class: 'lens-box', d: `M${G.xCut},${YB - 10} l10,10 l-10,10 l-10,-10 z`, fill: '#fff', stroke: CUT, 'stroke-width': 1.4 }),
      T(G.xCut, YB + 3.5, '≥', { 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: CUT, style: { fill: CUT } }));
    const cutInfo = info('a ≥ b: a cutoff', { definition: 'The window closed: the remaining children are not tried (break), and every chain piece is told (chain.cutoff, game.rs:665-668).', facts: [['forward effect', 'stops the forward pass: alpha-beta interleaves the two passes']], cites: [C.cutoff, C.chainCutoff] });
    ctx.hover(dia, cutInfo);
    layers.pieces.append(mm, dia);
    const cutLbl = T(G.xCut + 8, YB - 26, 'a ≥ b: cutoff', { 'font-size': 9.5, fill: CUT, style: { fill: CUT }, 'font-weight': 600, class: 'halo' });
    ctx.hover(cutLbl, cutInfo);
    layers.over.append(cutLbl);
    if (G.pieces.length) {
      const left = G.pieces[0].x + G.pieces[0].w - 12;
      const busInfo = info('chain.cutoff(t): the cutoff, sent to every piece', { definition: 'Chain::cutoff calls each piece\'s cutoff (order.rs:267-271); only history overrides the no-op (order.rs:36-37, 73-75).', cites: [C.chainCutoff, C.cutoffNoop, C.histCut, C.cutoff] });
      layers.wires.append(wire(`M${G.xCut},${YB - 11} V${BUS} H${left}`, CUT, { w: 1.6, arrow: false, halo: '#fff', info: busInfo }));
      const busLbl = T(G.xCut - 6, BUS + 14, 'chain.cutoff(t)', { 'text-anchor': 'end', 'font-size': 9.5, fill: CUT, style: { fill: CUT }, class: 'halo' });
      ctx.hover(busLbl, busInfo);
      layers.over.append(busLbl);
      for (const p of G.pieces) {
        const tx = p.x + p.w - 12;
        if (p.name === 'history') layers.wires.append(wire(`M${tx},${BUS} V${YF + 92}`, CUT, { w: 1.6, arrow: false, info: info('cutoff → history', { cites: [C.histCut] }) }));
        else {
          const tap = S('g', {}, S('line', { x1: tx, y1: BUS, x2: tx, y2: YF + 92, stroke: CUT, 'stroke-width': 1.2, 'stroke-dasharray': '1.5 2.5', opacity: 0.7 }), S('line', { x1: tx, y1: BUS, x2: tx, y2: YF + 92, stroke: 'transparent', 'stroke-width': 10 }));
          ctx.hover(tap, info(`cutoff → ${p.name}: a no-op`, { definition: 'Chain::cutoff calls this piece\'s cutoff too; it does not override the default, which does nothing (order.rs:36-37).', cites: [C.cutoffNoop, C.chainCutoff] }));
          layers.wires.append(tap);
        }
      }
    }
  }

  // --- the recursion ghost and the heuristics socket ---------------------------------------
  {
    const gx = G.ghost.x, gw = G.ghost.w;
    const g = S('g', {},
      S('rect', { class: 'lens-ghost', x: gx + 4, y: YF - 22, width: gw, height: YB - YF + 48, rx: 9 }),
      S('rect', { class: 'lens-box', x: gx, y: YF - 26, width: gw, height: YB - YF + 52, rx: 9, fill: 'rgba(255,255,255,0.7)', stroke: '#8a929c', 'stroke-width': 1.3, 'stroke-dasharray': '5 3' }),
      T(gx + gw / 2, YF - 9, 'child, (a, b)', { 'text-anchor': 'middle', 'font-size': 9.5, class: 'muted' }),
      lines(gx + gw / 2, YF + 26, ['⟲ search(', 'child, a, b)'], { 'text-anchor': 'middle', class: 'mono', 'font-size': 9.5, 'font-weight': 600 }, 12),
      lines(gx + gw / 2, YF + 56, ['the core', 'again, one', 'level down'], { 'text-anchor': 'middle', 'font-size': 9.5, class: 'muted' }, 11.5),
      T(gx + gw / 2, YB + 18, 'v (child)', { 'text-anchor': 'middle', 'font-size': 9.5, class: 'muted' }));
    g.querySelectorAll('tspan').forEach((t) => t.setAttribute('x', gx + gw / 2));
    ctx.hover(g, info('the recursion: the core again, one level down', {
      definition: 'self.search(next, a, b) for each child, best first (game.rs:654). Budget counts these nodes too (game.rs:594).',
      facts: [['forward', 'child position + window'], ['backward', 'the child\'s value v'], ['bottom', 'a leaf: no moves, the score (game.rs:612-625)']],
      cites: [C.recurse, C.budgetCount, C.leaf],
    }));
    layers.core.append(g);
    const hx = gx + 8, hy = YB - 70;
    const r = S('rect', { class: 'lens-sock', x: hx, y: hy, width: gw - 16, height: 38, rx: 6 });
    const hg = S('g', {}, r, T(gx + gw / 2, hy + 16, 'heuristics', { 'text-anchor': 'middle', 'font-size': 9.5, class: 'muted', 'font-weight': 600 }), T(gx + gw / 2, hy + 29, 'none built', { 'text-anchor': 'middle', 'font-size': 8.5, class: 'muted' }));
    ctx.snap.slot(r, 'heuristics');
    const hb = ctx.info.slotInfo('heuristics');
    ctx.hover(hg, { ...hb, facts: [['plan.rs', 'names of pieces that can change the value; the reserved name static_eval is refused (plan.rs:21-23, 70-71)'], ['placement', 'by the recursion, where a static evaluation would stand in for searching further down: this page\'s judgment'], ['today', 'none built: exact mode refuses a heuristic (it can change the value); play mode: not built in this release']], cites: uniqCites([...fixCites(hb.cites), C.modeCheck, rs('plan.rs', 21, 23, 'filters, heuristics: names of pieces that can change the value; none built'), rs('plan.rs', 70, 71, 'UNSOUND: beam, static_eval')]), note: ANALOGY });
    layers.pieces.append(hg);
  }

  // --- legend -------------------------------------------------------------------
  {
    const y = G.legendY;
    const lg = S('g', {});
    const item = (x, yy, draw, label) => { lg.append(draw(x, yy), T(x + 42, yy + 4, label, { 'font-size': 10.5 })); };
    item(10, y, (x, yy) => S('path', { d: `M${x},${yy} h32`, stroke: POS, 'stroke-width': 2.2, 'marker-end': arrow(POS) }), 'forward lane (top): positions and move lists, down the tree');
    item(380, y, (x, yy) => S('path', { d: `M${x + 32},${yy} h-32`, stroke: VAL, 'stroke-width': 2.2, 'marker-end': arrow(VAL) }), 'backward lane (bottom): values and bounds, up the tree');
    item(740, y, (x, yy) => S('path', { d: `M${x},${yy} h32`, stroke: TABLE, 'stroke-width': 1.6, 'stroke-dasharray': '5 3' }), 'dashed: state left for a later pass (not a lens law)');
    const types = [['Position', POS], ['MoveList', MOVES], ['Value / Value⊥', VAL], ['Window', WIN], ['Table', TABLE], ['Cutoff', CUT]];
    let x = 10;
    for (const [name, c] of types) {
      lg.append(S('rect', { x, y: y + 18, width: 12, height: 12, rx: 3, fill: c }), T(x + 17, y + 28, name, { 'font-size': 10.5 }));
      x += 30 + ctx.textWidth(name, 10.5);
    }
    lg.append(T(x + 6, y + 28, 'Position, MoveList, Value, Value⊥: ROADMAP ns:WireType (PROPOSED). Window, Table, Cutoff: this page\'s labels.', { 'font-size': 10, class: 'muted' }));
    lg.append(S('path', { d: `M10,${y + 44} h24`, stroke: '#9aa3ad', 'stroke-width': 1.3, 'stroke-dasharray': '4 3' }), T(42, y + 48, 'dashed outline: an empty or designed slot (drop target)', { 'font-size': 10, class: 'muted' }),
      S('line', { x1: 380, y1: y + 44, x2: 412, y2: y + 44, stroke: '#c3c8cf', 'stroke-width': 1.2, 'stroke-dasharray': '1.5 3' }), T(422, y + 48, 'dotted: no backward pass (the cutoff is a no-op for that piece)', { 'font-size': 10, class: 'muted' }));
    ctx.hover(lg, info('legend', { facts: [['wire types', 'Position, Value, Value⊥, MoveList are the ROADMAP\'s PROPOSED ns:WireType; the rest are this page\'s labels']], cites: [C.wireTypes] }));
    layers.over.append(lg);
  }

  // the play dot (illustrative)
  const tripD = `M8,${YF} H${G.capX} C${G.capX + BULGE},${YF} ${G.capX + BULGE},${YB} ${G.capX},${YB} H8`;
  const trip = S('path', { id: 'lens-trip', d: tripD, fill: 'none', stroke: 'none' });
  const dot = S('circle', { class: 'lens-dot', r: 6.5, cx: -20, cy: -20, fill: POS, stroke: '#fff', 'stroke-width': 2, 'pointer-events': 'none' });
  const pulse = S('circle', { r: 4.5, cx: -20, cy: -20, fill: CUT, stroke: '#fff', 'stroke-width': 1.5, 'pointer-events': 'none' });
  const pulse2 = S('circle', { r: 4.5, cx: -20, cy: -20, fill: TABLE, stroke: '#fff', 'stroke-width': 1.5, 'pointer-events': 'none' });
  const paths = {
    cut: G.hist ? S('path', { d: `M${G.xCut},${YB - 11} V${BUS} H${G.hist.x + G.hist.w - 12} V${YF + 56} H${G.hist.x + 12}`, fill: 'none', stroke: 'none' }) : null,
    get: S('path', { d: `M${G.xK},${YF} V${YM1} H${G.xW} V${YF + 9}`, fill: 'none', stroke: 'none' }),
    store: S('path', { d: `M${G.xStore},${YB} V${YM2} H${G.xT + 15}`, fill: 'none', stroke: 'none' }),
  };

  svgEl.append(layers.frames, layers.core, layers.wires, layers.pieces, layers.over, trip, ...Object.values(paths).filter(Boolean), pulse, pulse2, dot);

  // --- toolbar (play) + notes ---------------------------------------------------------
  const btn = ctx.el('button', { class: 'lens-play' }, '▶ play');
  const bar = ctx.el('div', { class: 'lens-bar' }, btn,
    ctx.el('span', { class: 'lens-ill' }, 'Illustrative only: a dot runs forward along the top lanes and back along the bottom lanes. No search runs in this page, and alpha-beta really interleaves the passes child by child.'));
  ctx.root.appendChild(bar);
  ctx.root.appendChild(svgEl);
  btn.addEventListener('click', () => play(svgEl, btn, { trip, dot, pulse, pulse2, paths, G, colors: { POS, MOVES, VAL } }));

  if (G.err) ctx.note(`refused: ${G.err}`, 'warn');
  ctx.note('Analogy of shape only. Open games (Ghani, Hedges, Winschel, Zahn) characterise equilibria: a best-response condition on strategy profiles. This plan computes a value: minimax with alpha-beta under a node budget. The lens drawing borrows only the shape (moves flow forward, down the tree; values flow back, up); no equilibrium is computed or checked, and no game-theoretic claim is made.', 'honesty');

  animateEvent(ctx, svgEl);
}

// --- the play dot ---------------------------------------------------------------------------

function runAlong(path, el, dur) {
  if (!path) return;
  const len = path.getTotalLength();
  let t0 = null;
  const step = (ts) => {
    if (!el.isConnected) return;
    if (t0 === null) t0 = ts;
    const p = Math.min(1, (ts - t0) / dur);
    const pt = path.getPointAtLength(p * len);
    el.setAttribute('cx', pt.x); el.setAttribute('cy', pt.y);
    if (p < 1) requestAnimationFrame(step); else { el.setAttribute('cx', -20); el.setAttribute('cy', -20); }
  };
  requestAnimationFrame(step);
}

function play(svgEl, btn, o) {
  // A run token: a stop then a quick play must not leave the old loop driving the dot too.
  const run = (btn.dataset.run = String(Number(btn.dataset.run || 0) + 1));
  if (btn.classList.contains('on')) { btn.classList.remove('on'); btn.textContent = '▶ play'; o.dot.setAttribute('cx', -20); return; }
  btn.classList.add('on'); btn.textContent = '■ stop';
  const { trip, dot, G } = o;
  const len = trip.getTotalLength();
  const dur = 6400;
  const mid = (YF + YB) / 2;
  let t0 = null, gotGet = false, gotCut = false, gotStore = false;
  const step = (ts) => {
    if (btn.dataset.run !== run) return;
    if (!svgEl.isConnected || !btn.classList.contains('on')) { dot.setAttribute('cx', -20); return; }
    if (t0 === null) t0 = ts;
    const p = Math.min(1, (ts - t0) / dur);
    const pt = trip.getPointAtLength(p * len);
    dot.setAttribute('cx', pt.x); dot.setAttribute('cy', pt.y);
    const fwd = pt.y < mid;
    dot.setAttribute('fill', fwd ? (pt.x > G.expand.x && pt.x < G.core.right ? o.colors.MOVES : o.colors.POS) : o.colors.VAL);
    if (fwd && !gotGet && pt.x >= G.xK) { gotGet = true; runAlong(o.paths.get, o.pulse2, 650); }
    if (!fwd && !gotCut && pt.x <= G.xCut) { gotCut = true; runAlong(o.paths.cut, o.pulse, 900); }
    if (!fwd && !gotStore && pt.x <= G.xStore) { gotStore = true; runAlong(o.paths.store, o.pulse2, 650); }
    if (p < 1) requestAnimationFrame(step);
    else { btn.classList.remove('on'); btn.textContent = '▶ play'; dot.setAttribute('cx', -20); }
  };
  requestAnimationFrame(step);
}

// --- merge animation -----------------------------------------------------------------------

function animateEvent(ctx, svgEl) {
  const ev = ctx.event;
  if (!ev || ev.type !== 'piece-added' || typeof svgEl.animate !== 'function') return;
  const opts = { duration: 800, easing: 'cubic-bezier(.2,.8,.2,1)' };
  if (ev.slot === 'order') {
    const g = svgEl.querySelector(`[data-lens-piece="${ev.name}"]`);
    if (!g) return;
    g.animate([{ transform: 'translate(0px,-90px)', opacity: 0 }, { transform: 'translate(0px,5px)', opacity: 1, offset: 0.7 }, { transform: 'translate(0px,0px)', opacity: 1 }], opts);
    const box = g.querySelector('.lens-box');
    if (box) box.animate([{ strokeWidth: '4px' }, { strokeWidth: '4px', offset: 0.7 }, { strokeWidth: '1.4px' }], { duration: 900 });
  } else if (ev.slot === 'drivers') {
    const g = svgEl.querySelector(`[data-lens-frame="${ev.name}"]`);
    if (!g) return;
    g.style.transformBox = 'fill-box';
    g.style.transformOrigin = 'center';
    g.animate([{ transform: 'scale(1.1)', opacity: 0 }, { transform: 'scale(0.985)', opacity: 1, offset: 0.75 }, { transform: 'scale(1)', opacity: 1 }], opts);
  } else if (ev.slot === 'memo') {
    const g = svgEl.querySelector('[data-lens-memo="1"]');
    if (!g) return;
    g.animate([{ transform: 'translate(0px,70px)', opacity: 0 }, { transform: 'translate(0px,-4px)', opacity: 1, offset: 0.7 }, { transform: 'translate(0px,0px)', opacity: 1 }], opts);
  }
}
