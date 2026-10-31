// VIEW 3: wiring diagrams as an operad (Spivak, arXiv:1305.0297; Fong-Spivak ch. 6).
//
// An outer box with typed holes; each hole is filled by a box whose interface
// matches; filling a hole is operadic composition, and nesting is composition again.
//
//  - connect4: the search plan as one composite, Solver = budget ∘ null_window ∘
//    core[order, filters, heuristics, memo] (ontology ROADMAP Phase 6). Drivers are
//    one-hole boxes nested in the fixed order the code runs them; the core's holes are
//    the SearchPlan fields, plus the two designed holes plan.rs does not have.
//  - orders: the bundle as an outer box with one hole per instance, typed by the
//    pattern's ports. Links are cables: event links are junctions (one per fused
//    class), token / data links are cables between place ports, guard links are
//    flagged taps. Unlinked ports are exposed faintly on the outer boundary.
//
// Everything that changes state goes through ctx.snap or ctx.actions, which
// ask the registry (bundle.candidates / bundle.add_link: pflow-compose's port
// of go-pflow validateLink; plan.slot_candidates / plan.add_piece: pflow-rs's
// SearchPlan check). Layout is deterministic: no randomness, no
// measurement of rendered text.

import { cite } from '../sources.js';
import { chainOf, driversOf, check, fieldOrDefault, PLAN_RS_REV } from '../model.js';
import { RULE_CITES } from '../model.js';
import { LINK_STYLE_CITE, NS } from '../model.js';

const rs = (path, from, to = from, note = '') => cite('pflowRs', `crates/pflow-metamodel/src/${path}`, from, to, note);
const road = (from, to, note = '') => cite('ontologyRoadmap', 'ROADMAP.md', from, to, note);
const go = (path, from, to = from, note = '') => cite('goPflow', path, from, to, note);

// Every line range below was read at the cited revision (pflow-rs c396d46,
// go-pflow 69257b3 = c802f34 for these files, ROADMAP f854116).
const C = {
  planDoc: rs('plan.rs', 6, 11, 'plan:connect4-exact, the module-doc example'),
  driversAbsent: rs('plan.rs', 147, 152, 'drivers absent: null_window on, no budget'),
  driversFlags: rs('plan.rs', 134, 138, 'Drivers: two flags, not a list'),
  drivers: rs('plan.rs', 146, 194, 'drivers(): the list is read into the two flags'),
  chain: rs('plan.rs', 196, 210, 'chain(): absent means Chain::default; a name listed twice is refused'),
  check: rs('plan.rs', 216, 238, 'check(): every name in its place; exact mode refuses filters and heuristics'),
  exactRefuses: rs('plan.rs', 229, 234, 'a filter or heuristic: refused in exact mode, not built in play mode'),
  solver: rs('plan.rs', 240, 251, 'solver(): one Solver with budget (usize::MAX if none), null_window and memo'),
  noBudget: rs('plan.rs', 245, 245, 'd.budget.unwrap_or(usize::MAX)'),
  mode: rs('plan.rs', 36, 45, 'Mode: Exact (default) or Play'),
  orderOnly: rs('order.rs', 1, 7, 'order never changes a value, only how soon a cutoff comes'),
  decisive: rs('order.rs', 26, 31, 'DECISIVE: a nonzero key settles the rank'),
  chainNew: rs('order.rs', 194, 230, 'Chain, Chain::default, Chain::new (at most 8 pieces)'),
  chainDefault: rs('order.rs', 205, 216, 'Chain::default: tt_best, immediate_win, history'),
  chainKey: rs('order.rs', 249, 265, 'keys compared piece by piece; a decisive nonzero key stops the comparison'),
  memo: rs('game.rs', 495, 505, 'with_memo: kept to N entries'),
  nullWin: rs('game.rs', 507, 512, 'with_null_window'),
  value: rs('game.rs', 526, 554, 'value: Option<f64>, nodes reset once per call'),
  run: rs('game.rs', 526, 597, 'value, solve, search: one node count for the whole null-window run'),
  solve: rs('game.rs', 556, 588, 'solve: one yes/no search per gap between adjacent rewards'),
  fullWindow: rs('game.rs', 564, 565, 'without null_window: one search over the whole reward range'),
  core: rs('game.rs', 590, 693, 'Solver::search: fail-soft alpha-beta with the transposition table'),
  budgetCheck: rs('game.rs', 593, 597, 'search: nodes > budget gives up (None)'),
  noBound: road(307, 307, 'plan.rs has no Bound kind and no engine choice'),
  operadRow: road(401, 401, 'operad of wiring diagrams: the best fit for a SearchPlan'),
  monoid: road(420, 423, 'orderers: a partial monoid under chaining, [] the identity, lexicographic'),
  driverOrder: road(426, 427, 'drivers: endomorphisms around the core; order matters in general'),
  composite: road(428, 430, 'Solver = drivers ∘ core[order chain, filters, bounds, memo]; core is Position → Value⊥'),
  sliceB: road(479, 480, 'Slice B: drivers as nested boxes budget(null_window(core))'),
  bundle: go('metamodel/compose.go', 207, 227, 'Bundle: subnets, links, constraints; no ports of its own'),
  fuse: go('metamodel/compose_fuse.go', 9, 20, 'event fusion over equivalence classes, so it is associative'),
  classes: go('metamodel/compose_flatten.go', 55, 88, 'place and transition classes by union-find'),
};

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const sub = (n) => String(n).split('').map((d) => SUB[d]).join('');
const fmtN = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const f1 = (v) => Math.round(v * 10) / 10;
const INK = '#2b2f36', MUTED = '#6a717c', FAINT = '#9aa3ad', PAPER = '#fafafa';

const STYLE = `
.opv .hit { fill: transparent; }
.opv .wire-hit { fill: none; stroke: transparent; stroke-width: 12px; pointer-events: stroke; }
.opv .obtn { cursor: pointer; }
.opv .obtn circle { fill: #fff; stroke: #c9ced6; }
.opv .obtn:hover circle { fill: #eef3fb; stroke: #2f6fb3; }
.opv .obtn.off { opacity: .25; pointer-events: none; }
.opv .halo { paint-order: stroke; stroke: ${PAPER}; stroke-width: 4px; stroke-linejoin: round; }
.opv .halo-w { paint-order: stroke; stroke: #fff; stroke-width: 4px; stroke-linejoin: round; }
.opv .mono { font-family: var(--font-mono); }
.opv .snap-slot.snap-legal .hole-frame { stroke-width: 3px; stroke-dasharray: none; }
.opv .snap-slot.snap-legal .slot-strip { fill-opacity: .22; }
.opv .leader { fill: none; stroke: ${FAINT}; stroke-width: 1px; stroke-dasharray: 2 3; }
.opv .iface { opacity: .75; }
.opv g.snap-port:hover .pmark { stroke: #000; }
`;

// --- small helpers ---------------------------------------------------------------

function mkText(ctx, x, y, str, o = {}) {
  const style = {};
  if (o.mono) style.fontFamily = 'var(--font-mono)';
  return ctx.svg('text', {
    x: f1(x), y: f1(y), 'font-size': o.size || 11, fill: o.fill || INK,
    'text-anchor': o.anchor || 'start', 'font-weight': o.bold ? 600 : null,
    'font-style': o.italic ? 'italic' : null, class: o.cls || null,
    'dominant-baseline': o.baseline || null, opacity: o.opacity ?? null, style,
  }, str);
}

/** Text with subscripts: parts are strings or {sub: '1'}. */
function rich(ctx, x, y, parts, o = {}) {
  const size = o.size || 11;
  const kids = [];
  let shifted = false;
  for (const p of parts) {
    if (typeof p === 'string') { kids.push(shifted ? ctx.svg('tspan', { dy: f1(-size * 0.3) }, p) : p); shifted = false; }
    else { kids.push(ctx.svg('tspan', { dy: f1(size * 0.3), 'font-size': f1(size * 0.74) }, p.sub)); shifted = true; }
  }
  const t = mkText(ctx, x, y, '', o);
  t.textContent = '';
  kids.forEach((k) => t.append(k));
  return t;
}

function wrap(ctx, str, maxW, size) {
  const words = String(str).split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && ctx.textWidth(t, size) > maxW) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function lines(ctx, x, y, arr, dy, o) {
  return arr.map((s, i) => mkText(ctx, x, y + i * dy, s, o));
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const toward = (b, a, r) => { const d = dist(a, b) || 1; return { x: b.x + ((a.x - b.x) * r) / d, y: b.y + ((a.y - b.y) * r) / d }; };

/** Orthogonal polyline with rounded corners; returns {d, pts}. */
function orth(points, r = 7) {
  const p = [];
  for (const q of points) {
    const l = p[p.length - 1];
    if (!l || Math.abs(l.x - q.x) > 0.01 || Math.abs(l.y - q.y) > 0.01) p.push({ x: q.x, y: q.y });
  }
  const s = [p[0]];
  for (let i = 1; i < p.length - 1; i++) {
    const a = s[s.length - 1], b = p[i], c = p[i + 1];
    const col = (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
    if (!col) s.push(b);
  }
  if (p.length > 1) s.push(p[p.length - 1]);
  let d = `M${f1(s[0].x)},${f1(s[0].y)}`;
  for (let i = 1; i < s.length; i++) {
    const b = s[i];
    if (i < s.length - 1) {
      const a = s[i - 1], c = s[i + 1];
      const rr = Math.min(r, dist(a, b) / 2, dist(b, c) / 2);
      const p1 = toward(b, a, rr), p2 = toward(b, c, rr);
      d += ` L${f1(p1.x)},${f1(p1.y)} Q${f1(b.x)},${f1(b.y)} ${f1(p2.x)},${f1(p2.y)}`;
    } else d += ` L${f1(b.x)},${f1(b.y)}`;
  }
  return { d, pts: s };
}

function segsOf(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
  return out;
}
function crosses([a, b], [c, d]) {
  const h1 = Math.abs(a.y - b.y) < 0.01, h2 = Math.abs(c.y - d.y) < 0.01;
  if (h1 === h2) return false;
  const [h, v] = h1 ? [[a, b], [c, d]] : [[c, d], [a, b]];
  const x = v[0].x, y = h[0].y;
  const [hx0, hx1] = [Math.min(h[0].x, h[1].x), Math.max(h[0].x, h[1].x)];
  const [vy0, vy1] = [Math.min(v[0].y, v[1].y), Math.max(v[0].y, v[1].y)];
  return x > hx0 + 0.5 && x < hx1 - 0.5 && y > vy0 + 0.5 && y < vy1 - 0.5;
}

// Two line ranges in the prototype's piece and slot cites (model.js) are off at
// c396d46: SLOTS memo cites plan.rs:113-118, which is Budget (Memo is 107-112), and
// null_window cites game.rs:556-591, but Solver::solve ends at 588.
function fixCite(c) {
  if (c.repo !== 'pflowRs') return c;
  if (c.path.endsWith('/plan.rs') && c.from === 113 && c.to === 118) return { ...c, from: 107, to: 112 };
  if (c.path.endsWith('/game.rs') && c.from === 556 && c.to === 591) return { ...c, to: 588 };
  return c;
}

function extend(base, more) {
  return {
    ...base,
    facts: [...(base.facts || []), ...(more.facts || [])],
    cites: [...(base.cites || []), ...(more.cites || [])].map(fixCite),
    bib: [...(base.bib || []), ...(more.bib || [])],
    note: [base.note, more.note].filter(Boolean).join(' '),
  };
}

const EASE = 'cubic-bezier(.2,.85,.25,1)';
function fb(el) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; }

/** An overlay that draws itself along `d` (pathLength 1), then fades. */
function drawOn(ctx, layer, d, color, width, delay = 0, dur = 750) {
  const p = ctx.svg('path', { d, fill: 'none', stroke: color, 'stroke-width': width, pathLength: 1, 'stroke-linecap': 'round', style: { strokeDasharray: '1', strokeDashoffset: '1', pointerEvents: 'none' } });
  layer.appendChild(p);
  return () => {
    p.animate([{ strokeDashoffset: 1, opacity: 1 }, { strokeDashoffset: 0, opacity: 1, offset: 0.8 }, { strokeDashoffset: 0, opacity: 0 }], { duration: dur, delay, easing: 'ease-out', fill: 'forwards' })
      .finished.then(() => p.remove()).catch(() => {});
  };
}

function button(ctx, x, y, glyph, title, onClick, enabled = true) {
  const g = ctx.svg('g', { class: `obtn${enabled ? '' : ' off'}`, transform: `translate(${f1(x)},${f1(y)})` },
    ctx.svg('title', {}, title),
    ctx.svg('circle', { r: 8, 'stroke-width': 1 }),
    mkText(ctx, 0, 0.5, glyph, { size: 9.5, anchor: 'middle', baseline: 'central', fill: '#3c4656' }));
  if (enabled) g.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); onClick(); });
  return g;
}

// ===================================================================================
// CONNECT-4: the search plan as one operadic composite
// ===================================================================================

const PW = 1150, PH = 800;
const NEST = {
  budget: { x: 64, y: 80, x1: 1086, y1: 640 },
  null_window: { x: 100, y: 128, x1: 1050, y1: 610 },
  core: { x: 136, y: 176, x1: 1014, y1: 580 },
};
const WIRE_Y = NEST.core.y + 46 + 160 + 7; // the gap between the order hole and the second row of holes

function pieceFacts(p, i, n, decisiveRun) {
  return {
    facts: [
      ['position', `${i + 1} of ${n} (highest priority first)`],
      ['tier', p.decisive ? (decisiveRun ? 'top tier: a nonzero key settles the rank, later pieces are not consulted' : 'decisive: a nonzero key stops the comparison for the pieces after it') : 'consulted only when every piece before it ties'],
      ['operad reading', 'a sub-box of the chain box; the chain fills the core\'s order hole'],
    ],
    cites: [C.chainKey, C.orderOnly],
  };
}

function renderPlan(ctx) {
  const S = ctx.svg, TH = ctx.theme, I = ctx.info;
  const plan = ctx.plan.plan;
  const mode = plan.mode || 'exact';
  const ch = chainOf(plan);
  const dr = driversOf(plan);
  const err = ctx.plan.error;
  const ev = ctx.event;
  const KC = TH.PIECE_KIND_COLOR;
  const posC = TH.SEARCH_TYPE_COLOR.Position, valC = TH.SEARCH_TYPE_COLOR['Value⊥'];
  const anims = [];

  const root = ctx.svgRoot(PW, PH, { class: 'view-svg opv' });
  root.appendChild(S('rect', { x: 0, y: 0, width: PW, height: PH, fill: PAPER }));
  const L = { frames: S('g'), wires: S('g'), holes: S('g'), top: S('g'), fx: S('g') };
  Object.values(L).forEach((g) => root.appendChild(g));

  // ---- header: the composite as a formula, and the mode badge ----
  const drvOK = !dr.err;
  const drvParts = drvOK ? [dr.budget != null ? `budget{${fmtN(dr.budget)}}` : null, dr.nullWindow ? 'null_window' : null].filter(Boolean) : ['drivers?'];
  const listTxt = (f) => { const l = fieldOrDefault(plan, f); return l.length ? `${l.join(' · ')}${Array.isArray(plan[f]) ? '' : ' (default)'}` : '∅'; };
  const f1line = `Solver = ${drvParts.length ? `${drvParts.join(' ∘ ')} ∘ ` : ''}core[order, filters, heuristics, memo]`;
  const orderTxt = ch.err ? 'refused' : ch.pieces.length ? ch.pieces.join(' · ') : '[]';
  const f2line = `core[ order = ${orderTxt}${ch.isDefault ? ' (default)' : ''},  filters = ${listTxt('filters')},  heuristics = ${listTxt('heuristics')},  memo = ${plan.memo ? `{entries: ${fmtN(plan.memo.entries)}}` : '∅'} ]`;
  const head = S('g', {},
    mkText(ctx, 14, 24, f1line, { size: 15, bold: true }),
    mkText(ctx, 14, 44, f2line, { size: 11.5, mono: true, fill: '#3c4656' }),
    mkText(ctx, 14, 62, 'One operadic composite (ROADMAP:428): each driver is a one-hole box around the search it wraps; the core\'s holes are typed by piece kind, and SearchPlan::check is the typing (plan.rs:216-238).', { size: 10.5, fill: MUTED }));
  ctx.hover(head, {
    title: 'the plan as one operadic composite',
    concept: { iri: 'https://ontology.pflow.xyz/ns#Composite', types: ['ns:Composite with op:wrap and op:fill (PROPOSED vocabulary, ROADMAP Phase 6)'] },
    definition: 'A whole plan is one operadic composite: Solver = drivers ∘ core[order chain, filters, bounds, memo].',
    facts: [['plan JSON', JSON.stringify(ctx.plan.json)], ['check', err ? `refused: ${err}` : `pflow-rs @${PLAN_RS_REV}: SearchPlan::check and solver(connect-4) accept it (plan.state)`]],
    cites: [C.composite, C.operadRow, C.check, C.planDoc],
    bib: ['spivak-wd', 'fong-spivak'],
  });
  L.top.appendChild(head);

  const badgeColor = mode === 'exact' ? '#1e7a46' : '#7b4cc2';
  const badge = S('g', {},
    S('rect', { x: 1008, y: 10, width: 132, height: 26, rx: 13, fill: badgeColor }),
    mkText(ctx, 1074, 27.5, `mode: ${mode}`, { size: 12, bold: true, anchor: 'middle', fill: '#fff' }));
  ctx.hover(badge, {
    title: `mode: ${mode}`,
    concept: { iri: 'https://ontology.pflow.xyz/ns#ModeAdmits', types: ['mode (plan.rs Mode; ns:ModeAdmits is PROPOSED, ROADMAP Phase 5)'] },
    definition: mode === 'exact' ? '"exact" (the default) holds every piece to returning the value: a piece that can change it (a value-changing filter or heuristic) is refused; sound filters are allowed.' : '"play" would allow pieces that trade the value for speed; which of them pflow-rs builds is its answer (plan.slot_candidates), not this view\'s.',
    facts: [['switch', 'the toolbar chips: exact / play']],
    cites: [C.mode, C.exactRefuses],
  });
  L.top.appendChild(badge);
  if (err) {
    const rb = S('g', {}, S('rect', { x: 1008, y: 42, width: 132, height: 22, rx: 11, fill: '#fff', stroke: TH.LEAK, 'stroke-width': 1.5 }),
      mkText(ctx, 1074, 57, 'refused by pflow-rs', { size: 11, bold: true, anchor: 'middle', fill: TH.LEAK }));
    ctx.hover(rb, { title: 'refused', definition: err, cites: [C.check, C.solver] });
    L.top.appendChild(rb);
  }

  // ---- the two driver frames (fixed nesting) and the core ----
  const budgetIdx = (plan.drivers || []).map((d, i) => [d, i]).filter(([d]) => d && typeof d === 'object' && d.budget).map(([, i]) => i).pop();
  const nwIdx = (plan.drivers || []).indexOf('null_window');
  const drvColor = KC.Driver;

  function driverFrame(id) {
    const r = NEST[id];
    const present = drvOK && (id === 'budget' ? dr.budget != null : dr.nullWindow);
    const isDefault = id === 'null_window' && present && !plan.drivers;
    const g = S('g', { 'data-frame': id });
    if (present) ctx.emit('frame', id, {});
    g.appendChild(S('rect', { x: r.x, y: r.y, width: r.x1 - r.x, height: r.y1 - r.y, rx: 14, fill: present ? '#fff' : 'none', 'fill-opacity': present ? 0.6 : null, stroke: present ? drvColor : '#a9b0b9', 'stroke-width': present ? 1.8 : 1.2, 'stroke-dasharray': present ? null : '7 5' }));
    // the header strip is the drivers slot (drop a driver here)
    const strip = S('g', {}, S('rect', { class: 'slot-strip', x: r.x + 1, y: r.y + 1, width: r.x1 - r.x - 2, height: 44, rx: 13, fill: drvColor, 'fill-opacity': present ? 0.07 : 0.025 }));
    let x = r.x + 16;
    const yb = r.y + 28;
    const nameT = mkText(ctx, x, yb, id, { size: 13.5, bold: true, mono: true, fill: present ? drvColor : '#8a929c' });
    strip.appendChild(nameT);
    x += ctx.textWidth(id, 13.5) * 1.03 + 8;
    if (present && id === 'budget') {
      strip.appendChild(mkText(ctx, x, yb, `{nodes: ${fmtN(dr.budget)}}`, { size: 12, mono: true }));
      x += ctx.textWidth(`{nodes: ${fmtN(dr.budget)}}`, 12) * 1.03 + 12;
    }
    if (isDefault) {
      strip.appendChild(S('rect', { x, y: yb - 13, width: 56, height: 17, rx: 8.5, fill: '#fff', stroke: drvColor, 'stroke-dasharray': '3 2' }));
      strip.appendChild(mkText(ctx, x + 28, yb - 1, 'default', { size: 10.5, anchor: 'middle', fill: drvColor, italic: true }));
      x += 66;
    }
    if (present) {
      const contract = id === 'budget' ? 'ct:partial' : 'ct:value-preserving';
      const cw = ctx.textWidth(contract, 10.5) + 14;
      strip.appendChild(S('rect', { x, y: yb - 13, width: cw, height: 17, rx: 4, fill: '#eef3fb', stroke: '#c6d6ea' }));
      strip.appendChild(mkText(ctx, x + cw / 2, yb - 1, contract, { size: 10.5, anchor: 'middle', mono: true, fill: '#2f6fb3' }));
      x += cw + 10;
    }
    const desc = !drvOK ? `drivers refused: ${dr.err}`
      : id === 'budget'
        ? (present ? 'the exact value, or None past N nodes (plan.rs:18-19, game.rs:593-597)' : 'off: no budget, so plan.rs passes usize::MAX nodes (plan.rs:245). Drop budget here.')
        : (present ? `one yes/no search per gap between adjacent rewards (game.rs:556-588)${isDefault ? '; on because drivers is absent (plan.rs:147-152)' : ''}` : 'off: drivers is given without it, so one search over the whole reward range (game.rs:564-565). Drop null_window here.');
    strip.appendChild(mkText(ctx, x, yb, desc, { size: 10.5, fill: drvOK ? MUTED : TH.LEAK, italic: !present }));
    ctx.snap.slot(strip, 'drivers');
    const base = I.pieceInfo(id);
    const frameInfo = extend(present ? base : I.slotInfo('drivers'), {
      facts: [
        ['state', present ? (isDefault ? 'on by default (drivers absent)' : `on (drivers[${id === 'budget' ? budgetIdx : nwIdx}])`) : 'off'],
        ['operad reading', 'a one-hole box: Search → Search, filled by everything inside it'],
        ['nesting', id === 'budget' ? 'always the outer box: game.rs counts nodes across the whole null-window run' : 'always inside budget, around the core'],
      ],
      cites: [C.drivers, C.run, id === 'budget' ? C.budgetCheck : C.solve],
      note: present ? '' : 'The dashed frame is where this driver would sit: the nesting is fixed by the code, not by the JSON order.',
    });
    ctx.hover(strip, frameInfo);
    ctx.hover(g.firstChild, frameInfo); // the frame's body, between it and the box it wraps
    g.appendChild(strip);
    if (present && !isDefault) {
      const idx = id === 'budget' ? budgetIdx : nwIdx;
      g.appendChild(button(ctx, r.x1 - 20, r.y + 22, '×', `remove ${id} from drivers`, () => ctx.actions.removePiece('drivers', idx)));
    } else if (isDefault) {
      g.appendChild(button(ctx, r.x1 - 20, r.y + 22, '×', 'turn the default null_window off (drivers: [])', () => ctx.actions.removePiece('drivers', 0)));
    }
    if (ev && ev.type === 'piece-added' && ev.slot === 'drivers' && ev.name === id) {
      fb(g);
      anims.push(() => g.animate([{ transform: 'scale(1.08)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 850, easing: EASE }));
    }
    return { g, present };
  }
  const fB = driverFrame('budget');
  const fN = driverFrame('null_window');
  L.frames.append(fB.g, fN.g);

  // core box
  const K = NEST.core;
  const core = S('g', {},
    S('rect', { x: K.x, y: K.y, width: K.x1 - K.x, height: K.y1 - K.y, rx: 10, fill: '#fff', stroke: INK, 'stroke-width': 1.8 }),
    mkText(ctx, K.x + 16, K.y + 25, 'core', { size: 13.5, bold: true }),
    mkText(ctx, K.x + 56, K.y + 25, 'alpha-beta search over the net (Solver::search, game.rs:590-693)', { size: 10.5, fill: MUTED }),
    mkText(ctx, K.x1 - 16, K.y + 25, 'Position → Value⊥', { size: 12, mono: true, anchor: 'end', fill: '#3c4656' }));
  ctx.hover(core, {
    title: 'core: the alpha-beta search',
    concept: { iri: 'https://ontology.pflow.xyz/ns#Box', types: ['ns:Box (PROPOSED vocabulary, ROADMAP Phase 6)'] },
    definition: 'The search is fixed (alpha-beta over Game); a plan chooses what swaps in. As a box it is Position → Value⊥, and it has one typed hole per SearchPlan field.',
    facts: [
      ['holes', 'order, filters, heuristics, root, memo (SearchPlan fields); bounds, engine (designed, never fillable)'],
      ['operad reading', 'an operation core(order, filters, heuristics, root, memo) → Search; filling the holes is composition'],
      ['wires', 'Position in, Value⊥ out; the holes are parameters, not wires (no piece has wires of its own)'],
    ],
    cites: [C.core, C.composite, rs('plan.rs', 1, 4, 'the search is fixed; a plan chooses what swaps in')],
  });
  L.frames.appendChild(core);

  // ---- typed wires: Position in, Value⊥ out, crossing every boundary ----
  const wireInfo = (t) => ({
    title: `wire type ${t}`,
    concept: { iri: 'https://ontology.pflow.xyz/ns#WireType', types: ['ns:WireType (PROPOSED, ROADMAP Phase 6)'] },
    definition: t === 'Position' ? 'A marking of the net: what the search is asked about. Every box on the way in has the same input.' : ctx.content.text('c4-wire-value'),
    facts: t === 'Position' ? [['enters', 'budget → null_window → core (each boundary passes it inward)']] : [
      ['leaves', 'core → null_window → budget'],
      ['⊥', ctx.content.text('c4-caveat-value-bottom')],
    ],
    cites: t === 'Position' ? [C.composite] : [C.composite, C.value, C.noBudget],
  });
  const xs = [NEST.budget.x, NEST.null_window.x, K.x];
  const present = [fB.present, fN.present, true];
  const pw = S('g', {},
    S('path', { d: `M8,${WIRE_Y} L${K.x},${WIRE_Y}`, stroke: posC, 'stroke-width': 2.4, fill: 'none' }),
    S('path', { d: `M${K.x - 7},${WIRE_Y - 4.5} L${K.x},${WIRE_Y} L${K.x - 7},${WIRE_Y + 4.5}`, stroke: posC, 'stroke-width': 2, fill: 'none' }),
    mkText(ctx, 8, WIRE_Y - 8, 'Position', { size: 11.5, fill: posC, bold: true }),
    ...xs.map((x, i) => S('circle', { cx: x, cy: WIRE_Y, r: 4.5, fill: present[i] ? posC : '#fff', stroke: posC, 'stroke-width': 1.5 })),
    S('path', { class: 'wire-hit', d: `M8,${WIRE_Y} L${K.x},${WIRE_Y}` }));
  ctx.hover(pw, wireInfo('Position'));
  const xr = [K.x1, NEST.null_window.x1, NEST.budget.x1];
  const presentR = [true, fN.present, fB.present];
  const vw = S('g', {},
    S('path', { d: `M${K.x1},${WIRE_Y} L${PW - 8},${WIRE_Y}`, stroke: valC, 'stroke-width': 2.4, fill: 'none' }),
    S('path', { d: `M${PW - 15},${WIRE_Y - 4.5} L${PW - 8},${WIRE_Y} L${PW - 15},${WIRE_Y + 4.5}`, stroke: valC, 'stroke-width': 2, fill: 'none' }),
    mkText(ctx, PW - 8, WIRE_Y - 8, 'Value⊥', { size: 11.5, fill: valC, bold: true, anchor: 'end' }),
    ...xr.map((x, i) => S('circle', { cx: x, cy: WIRE_Y, r: 4.5, fill: presentR[i] ? valC : '#fff', stroke: valC, 'stroke-width': 1.5 })),
    S('path', { class: 'wire-hit', d: `M${K.x1},${WIRE_Y} L${PW - 8},${WIRE_Y}` }));
  ctx.hover(vw, wireInfo('Value⊥'));
  L.wires.append(pw, vw);

  // ---- holes ----
  const IX0 = K.x + 20, IX1 = K.x1 - 20, IW = IX1 - IX0;

  function holeFrame(g, slotId, x, y, w, h, color, label, designed = false) {
    ctx.emit('hole', slotId, { accepts: ctx.plan.slots.find((q) => q.id === slotId)?.accepts || '' });
    g.appendChild(S('rect', { class: 'hole-frame', x, y, width: w, height: h, rx: 8, fill: designed ? 'url(#opv-hatch)' : '#fdfdfd', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': designed ? '4 4' : '6 4' }));
    const tw = ctx.textWidth(label, 10.5) + 14;
    g.appendChild(S('rect', { x: x + 10, y: y - 9, width: tw, height: 18, rx: 4, fill: '#fff', stroke: color, 'stroke-width': 1.1, 'stroke-dasharray': designed ? '3 3' : null }));
    g.appendChild(mkText(ctx, x + 10 + tw / 2, y + 4, label, { size: 10.5, anchor: 'middle', fill: color, bold: !designed, mono: true }));
  }
  root.insertBefore(S('defs', {}, S('pattern', { id: 'opv-hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    S('rect', { width: 8, height: 8, fill: '#f7f7f8' }), S('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#e3e5e9', 'stroke-width': 3 }))), root.firstChild);

  // order hole: the chain box with its pieces as sub-boxes
  const OY = K.y + 46, OH = 160;
  const og = S('g', { 'data-hole': 'order' });
  holeFrame(og, 'order', IX0, OY, IW, OH, KC.Order, 'order : Order chain');
  const cb = { x: IX0 + 8, y: OY + 12, w: IW - 16, h: OH - 20 };
  if (ch.err) {
    og.appendChild(S('rect', { x: cb.x, y: cb.y, width: cb.w, height: cb.h, rx: 7, fill: '#fdf0ee', stroke: TH.LEAK, 'stroke-width': 1.5 }));
    og.append(...lines(ctx, cb.x + 16, cb.y + 30, wrap(ctx, `refused: ${ch.err}`, cb.w - 32, 12), 17, { size: 12, fill: TH.LEAK }));
  } else {
    og.appendChild(S('rect', { x: cb.x, y: cb.y, width: cb.w, height: cb.h, rx: 7, fill: '#fffaf2', stroke: KC.Order, 'stroke-width': 1.4 }));
    const hl = ch.isDefault ? 'chain · default: order is absent, so Chain::default (order.rs:205-216)' : 'chain · a monoid under ++, [] the identity';
    og.appendChild(mkText(ctx, cb.x + 14, cb.y + 19, hl, { size: 11, fill: '#7a4a08', bold: false }));
    og.appendChild(mkText(ctx, cb.x + cb.w - 14, cb.y + 19, ch.isDefault ? 'naming any piece replaces the default' : 'reorder with ◀ ▶: node counts change, never the value (order.rs:1-7)', { size: 10.5, anchor: 'end', fill: MUTED, italic: true }));
    const n = ch.pieces.length;
    const PY = cb.y + 32, PH2 = 70, GAP = 16;
    const innerX0 = cb.x + 16, innerW = cb.w - 32;
    const pwid = n ? Math.min(178, (innerW - (n - 1) * GAP) / n) : 0;
    const total = n * pwid + (n - 1) * GAP;
    const px0 = innerX0 + (innerW - total) / 2;
    const xOf = (i) => px0 + i * (pwid + GAP);
    // decisive runs
    const runs = [];
    ch.pieces.forEach((name, i) => {
      const d = ctx.plan.pieceByName[name]?.decisive;
      if (d && runs.length && runs[runs.length - 1].end === i - 1) runs[runs.length - 1].end = i;
      else if (d) runs.push({ start: i, end: i });
    });
    const inLeadRun = (i) => runs.length && runs[0].start === 0 && i <= runs[0].end;
    if (!n) {
      const ex = S('g', {},
        S('rect', { x: innerX0 + innerW / 2 - 230, y: PY, width: 460, height: PH2, rx: 6, fill: '#fff', stroke: KC.Order, 'stroke-dasharray': '5 4' }),
        mkText(ctx, innerX0 + innerW / 2, PY + 30, '[ ]', { size: 18, mono: true, anchor: 'middle', fill: KC.Order, bold: true }),
        mkText(ctx, innerX0 + innerW / 2, PY + 52, 'the empty chain: the identity; moves keep the net\'s own order (order.rs:197-199)', { size: 10.5, anchor: 'middle', fill: MUTED }));
      ctx.hover(ex, { title: 'the empty chain []', concept: { iri: 'https://ontology.pflow.xyz/ns#SearchPiece', types: ['op:chain identity (PROPOSED, ROADMAP Phase 6)'] }, definition: 'An order chain with no pieces: every key ties, and ties keep the net\'s own order of the moves. It is the monoid\'s identity, not the default chain.', cites: [C.chainNew, C.chainKey, C.monoid] });
      og.appendChild(ex);
    }
    ch.pieces.forEach((name, i) => {
      const p = ctx.plan.pieceByName[name] || { name, kind: 'Order' };
      const x = xOf(i);
      const pg = S('g', { 'data-piece-box': name });
      ctx.emit('piece', `order/${name}`, {});
      pg.appendChild(S('rect', { x, y: PY, width: pwid, height: PH2, rx: 6, fill: '#fff', stroke: KC.Order, 'stroke-width': p.decisive ? 2.2 : 1.3, 'stroke-dasharray': ch.isDefault ? '5 3' : null }));
      pg.appendChild(S('circle', { cx: x + 13, cy: PY + 13, r: 8, fill: KC.Order }));
      pg.appendChild(mkText(ctx, x + 13, PY + 13.5, String(i + 1), { size: 9.5, anchor: 'middle', baseline: 'central', fill: '#fff', bold: true }));
      pg.appendChild(mkText(ctx, x + pwid / 2 + 6, PY + 25, name, { size: pwid < 150 ? 12 : 13, mono: true, anchor: 'middle', bold: true }));
      const sub2 = [p.decisive ? 'decisive' : null, p.needsGoals ? 'reads goals' : null, 'order-only'].filter(Boolean).join(' · ');
      pg.appendChild(mkText(ctx, x + pwid / 2, PY + 42, sub2, { size: 10, anchor: 'middle', fill: MUTED }));
      ctx.hover(pg, extend(I.pieceInfo(name), pieceFacts(p, i, n, inLeadRun(i))));
      if (!ch.isDefault) {
        pg.appendChild(button(ctx, x + 16, PY + PH2 - 13, '◀', `move ${name} up (sooner)`, () => ctx.actions.movePiece('order', i, i - 1), i > 0));
        pg.appendChild(button(ctx, x + 38, PY + PH2 - 13, '▶', `move ${name} down (later)`, () => ctx.actions.movePiece('order', i, i + 1), i < n - 1));
        pg.appendChild(button(ctx, x + pwid - 16, PY + PH2 - 13, '×', `remove ${name} from the chain`, () => ctx.actions.removePiece('order', i)));
      }
      if (i < n - 1) og.appendChild(mkText(ctx, x + pwid + GAP / 2, PY + PH2 / 2 + 4, '·', { size: 18, anchor: 'middle', fill: KC.Order, bold: true }));
      og.appendChild(pg);
      if (ev && ev.type === 'piece-added' && ev.slot === 'order' && ev.name === name) {
        fb(pg);
        anims.push(() => pg.animate([{ transform: 'translate(0px,-250px) scale(0.55)', opacity: 0 }, { transform: 'translate(0px,8px) scale(1.04)', opacity: 1, offset: 0.75 }, { transform: 'translate(0px,0px) scale(1)', opacity: 1 }], { duration: 850, easing: EASE }));
      }
      if (ev && ev.type === 'piece-moved' && ev.slot === 'order') {
        const prev = [...ch.pieces];
        const [m] = prev.splice(ev.to, 1);
        prev.splice(ev.from, 0, m);
        const oi = prev.indexOf(name);
        if (oi !== -1 && oi !== i) anims.push(() => pg.animate([{ transform: `translate(${f1(xOf(oi) - x)}px,0px)` }, { transform: 'translate(0px,0px)' }], { duration: 520, easing: EASE }));
      }
    });
    // decisive brackets
    runs.forEach((r, k) => {
      const x0 = xOf(r.start) + 4, x1 = xOf(r.end) + pwid - 4, y = PY + PH2 + 8;
      const lead = k === 0 && r.start === 0;
      // A lead run gets the long label, kept inside the chain box; a later run
      // (after a non-decisive piece) gets a short one, so two labels never meet.
      const label = lead ? 'decisive: the top tier (a nonzero key settles the rank)' : 'decisive';
      const half = ctx.textWidth(label, 10.5) / 2;
      const lxc = Math.max(cb.x + 12 + half, Math.min(cb.x + cb.w - 12 - half, (x0 + x1) / 2));
      const br = S('g', {},
        S('path', { d: `M${f1(x0)},${y} L${f1(x0)},${y + 6} L${f1(x1)},${y + 6} L${f1(x1)},${y}`, fill: 'none', stroke: KC.Order, 'stroke-width': 1.3 }),
        mkText(ctx, lxc, y + 20, label, { size: 10.5, anchor: 'middle', fill: '#7a4a08' }));
      ctx.hover(br, { title: 'decisive pieces', concept: { iri: 'https://ontology.pflow.xyz/ns#SearchPiece', types: ['ns:decisive (PROPOSED, ROADMAP Slice A)'] }, definition: 'Whether a nonzero key settles the move\'s rank: the pieces after this one do not sort it further (it sits in a top tier of its own, as when the table names it, or when it wins).', cites: [C.decisive, C.chainKey] });
      og.appendChild(br);
    });
  }
  ctx.snap.slot(og, 'order');
  ctx.hover(og.firstChild, extend(I.slotInfo('order'), { facts: [['type', 'Order pieces, chained (≤ 8, none twice)'], ['filled by', ch.err ? 'refused' : ch.isDefault ? 'Chain::default (order absent)' : `[${ch.pieces.join(', ')}]`]], cites: [C.chain, C.chainNew], bib: ['spivak-wd'] }));
  L.holes.appendChild(og);

  // row 2: filters, heuristics, root, memo. `root` is pflow-rs's plan field {"order": [...]}, a hole of
  // the solver template (pflow-native spec D19, D31): run once at the position searched.
  const R2Y = OY + OH + 14, R2H = 88, R2W = (IW - 42) / 4;
  [['filters', 'Filter'], ['heuristics', 'Heuristic'], ['root', 'Root']].forEach(([slot, kind], k) => {
    const x = IX0 + k * (R2W + 14);
    const hg = S('g', { 'data-hole': slot });
    holeFrame(hg, slot, x, R2Y, R2W, R2H, KC[kind], `${slot} : ${kind}*`);
    // The list the solver reads: explicit, or the default pflow-rs reads for an
    // absent field (model.js PLAN_DEFAULTS, from plan.slot_candidates).
    const explicit = Array.isArray(slot === 'root' ? plan.root?.order : plan[slot]);
    const list = fieldOrDefault(plan, slot);
    // check() stops at the first error, which may be in another hole: this hole
    // shows what pflow-rs (plan.check) says about its own field alone.
    const own = explicit && list.length ? check({ mode, [slot]: plan[slot] }) : null;
    if (list.length) {
      for (const name of list) ctx.emit('piece', `${slot}/${name}`, {});
      hg.appendChild(mkText(ctx, x + 16, R2Y + 30, list.join(' · '), { size: 12, mono: true, fill: own ? TH.LEAK : KC[kind], bold: true, italic: !explicit }));
      const why = own ? `refused on its own: ${own}` : explicit ? `pflow-rs @${PLAN_RS_REV} accepts this list (plan.check)` : `default: an absent "${slot}" is [${list.join(', ')}] in pflow-rs @${PLAN_RS_REV}`;
      hg.append(...lines(ctx, x + 16, R2Y + 46, wrap(ctx, why, R2W - 32, 10), 13, { size: 10, fill: own ? TH.LEAK : MUTED }).slice(0, 3));
    } else {
      hg.appendChild(mkText(ctx, x + 16, R2Y + 31, '∅  empty', { size: 12.5, mono: true, fill: '#8a929c' }));
      const why = `drag a ${kind.toLowerCase()} here: pflow-rs @${PLAN_RS_REV} decides what fits in ${mode} mode (plan.slot_candidates)`;
      hg.append(...lines(ctx, x + 16, R2Y + 49, wrap(ctx, why, R2W - 30, 10.5), 14, { size: 10.5, fill: MUTED }));
    }
    ctx.snap.slot(hg, slot);
    ctx.hover(hg, extend(I.slotInfo(slot), { facts: [['type', `${kind} pieces`], ['filled by', list.length ? `${list.join(', ')}${explicit ? '' : ' (default)'}` : 'nothing'], ['decided by', `pflow-rs @${PLAN_RS_REV} (plan.slot_candidates on a drag, plan.check on the plan)`], ...(own === null && err && explicit && list.length ? [['pflow-rs reports', `${err} (check stops at the first error it meets, in another hole; this hole shows what check says about its own field)`]] : [])], cites: [C.check, C.exactRefuses] }));
    L.holes.appendChild(hg);
    if (ev && ev.type === 'piece-removed' && ev.slot === slot) anims.push(() => hg.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 600 }));
  });
  {
    const x = IX0 + 3 * (R2W + 14);
    const hg = S('g', { 'data-hole': 'memo' });
    holeFrame(hg, 'memo', x, R2Y, R2W, R2H, KC.Memo, 'memo : Memo');
    if (plan.memo) {
      ctx.emit('piece', 'memo/memo', {});
      const mg = S('g', {},
        S('rect', { x: x + 8, y: R2Y + 14, width: R2W - 16, height: R2H - 22, rx: 6, fill: '#f1faf8', stroke: KC.Memo, 'stroke-width': 1.5 }),
        mkText(ctx, x + 20, R2Y + 34, `memo {entries: ${fmtN(plan.memo.entries)}}`, { size: 12, mono: true, bold: true, fill: '#0f5f54' }),
        ...lines(ctx, x + 20, R2Y + 51, wrap(ctx, 'ct:value-preserving: the table is kept to N entries (game.rs:495-505)', R2W - 64, 10), 13, { size: 10, fill: MUTED }));
      mg.appendChild(button(ctx, x + R2W - 22, R2Y + 30, '×', 'remove the memo', () => ctx.actions.removePiece('memo', 0)));
      ctx.hover(mg, extend(I.pieceInfo('memo'), { facts: [['entries', fmtN(plan.memo.entries)], ['operad reading', 'fills the core\'s memo hole']], cites: [C.memo] }));
      hg.appendChild(mg);
      if (ev && ev.type === 'piece-added' && ev.slot === 'memo') {
        fb(mg);
        anims.push(() => mg.animate([{ transform: 'translate(0px,-320px) scale(0.6)', opacity: 0 }, { transform: 'translate(0px,6px) scale(1.03)', opacity: 1, offset: 0.75 }, { transform: 'translate(0px,0px) scale(1)', opacity: 1 }], { duration: 850, easing: EASE }));
      }
    } else {
      hg.appendChild(mkText(ctx, x + 16, R2Y + 31, '∅  no memo', { size: 12.5, mono: true, fill: '#8a929c' }));
      hg.append(...lines(ctx, x + 16, R2Y + 49, wrap(ctx, 'the default table is cleared past 2M entries between calls and is unbounded inside one search (game.rs:495-500)', R2W - 30, 10.5), 13, { size: 10.5, fill: MUTED }));
    }
    ctx.snap.slot(hg, 'memo');
    ctx.hover(hg.firstChild, extend(I.slotInfo('memo'), { facts: [['type', 'Memo {entries: N}, N ≥ 1'], ['filled by', plan.memo ? `memo {entries: ${plan.memo.entries}}` : 'nothing']], cites: [C.memo] }));
    L.holes.appendChild(hg);
  }

  // row 3: the designed holes, never fillable
  const R3Y = R2Y + R2H + 14, R3H = K.y1 - 14 - R3Y, R3W = (IW - 14) / 2;
  [['bounds', 'Bound', 'designed, not built: plan.rs has no Bound kind, so nothing can fill this hole (ROADMAP:307)'],
    ['engine', 'Engine', 'designed, not built: no engine choice; game.rs picks BitModel or IndexedModel itself (ROADMAP:307)']].forEach(([slot, kind, why], k) => {
    const x = IX0 + k * (R3W + 14);
    const hg = S('g', { 'data-hole': slot });
    holeFrame(hg, slot, x, R3Y, R3W, R3H, '#9aa1aa', `${slot} : ${kind}`, true);
    hg.append(...lines(ctx, x + 16, R3Y + 30, wrap(ctx, why, R3W - 32, 10.5), 14, { size: 10.5, fill: '#7d848e', italic: true }));
    ctx.snap.slot(hg, slot);
    ctx.hover(hg, extend(I.slotInfo(slot), { facts: [['fillable', `never: every drop is refused (designed in the ROADMAP, not a field of SearchPlan at pflow-rs @${PLAN_RS_REV})`]], cites: [C.noBound] }));
    L.holes.appendChild(hg);
  });

  // ---- captions and legend ----
  const capY = 664;
  const cap = S('g', {},
    mkText(ctx, 14, capY, 'Nesting is composition, and the code fixes the nesting: plan.rs reads drivers into two flags (plan.rs:146-194) and game.rs counts nodes across the whole', { size: 11.5 }),
    mkText(ctx, 14, capY + 16, 'null-window run (game.rs:526-597), so budget is always the outer box. The JSON order of drivers does not change the nesting.', { size: 11.5 }),
    mkText(ctx, 14, capY + 36, 'A chain is a monoid under concatenation, [] the identity, and the composite is lexicographic (ROADMAP:420-423; order.rs:194-265). A decisive piece\'s', { size: 11.5, fill: '#7a4a08' }),
    mkText(ctx, 14, capY + 52, 'nonzero key settles the rank, so decisive pieces that lead the chain form a top tier (order.rs:26-31). Partial in code: at most 8 pieces (order.rs:13), none twice (plan.rs:204-206).', { size: 11.5, fill: '#7a4a08' }));
  ctx.hover(cap, { title: 'the laws behind the nesting', definition: 'Drivers are endomorphisms on search composed around the core; in general their order matters, but in plan.rs (read at c396d46) the two drivers are flags and the nesting is fixed.', cites: [C.drivers, C.run, C.driverOrder, C.monoid, C.chainNew, C.chainKey] });
  L.top.appendChild(cap);

  const lg = S('g', {});
  let lx = 14;
  const ly = 752;
  const sw = (color, label, dashed, kind = 'rect') => {
    if (kind === 'wire') lg.appendChild(S('path', { d: `M${lx},${ly - 4} L${lx + 26},${ly - 4}`, stroke: color, 'stroke-width': 2.4 }));
    else lg.appendChild(S('rect', { x: lx, y: ly - 11, width: 22, height: 13, rx: 3, fill: '#fff', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': dashed ? '4 3' : null }));
    lx += kind === 'wire' ? 32 : 28;
    lg.appendChild(mkText(ctx, lx, ly, label, { size: 11, fill: '#3c4656' }));
    lx += ctx.textWidth(label, 11) + 18;
  };
  sw(posC, 'Position', false, 'wire');
  sw(valC, 'Value⊥', false, 'wire');
  sw(KC.Driver, 'driver: a one-hole box');
  sw(KC.Order, 'order piece');
  sw(KC.Memo, 'memo');
  sw(KC.Filter, 'filter hole');
  sw(KC.Heuristic, 'heuristic hole');
  sw('#9aa1aa', 'designed hole / driver off', true);
  lg.appendChild(mkText(ctx, 14, ly + 22, 'Drag a piece from the toolbar onto a hole: only the holes pflow-rs accepts light up (plan.slot_candidates); hover a dark one for its refusal. Hover anything for its source line.', { size: 10.5, fill: MUTED, italic: true }));
  L.top.appendChild(lg);

  ctx.root.appendChild(root);
  for (const a of anims) a();

  // notes, top to bottom (each prepends)
  ctx.note('Holes are typed by piece kind, not by wires: a piece has no wires of its own, so this is read as an operad in the sense of Fong-Spivak (Rough Def. 6.91: types, operations, substitution), not as Spivak\'s cospan operad of wires. The reading is partial: SearchPlan::check refuses some fillings of the right kind (an order piece listed twice, plan.rs:204-206; in exact mode every piece that can change the value), as the ROADMAP\'s "partial monoid" says (ROADMAP:420-423). Only the search\'s interface, Position → Value⊥ (ROADMAP:428-430), is drawn as wires.', 'honesty');
  if (err) ctx.note(`Refused by SearchPlan::check / solver: ${err}`, 'warn');
}

// ===================================================================================
// ORDERS: the bundle as an outer box with one typed hole per instance
// ===================================================================================

const OW = 1150;
const COL_OF = { queue: 0, 'resource-pool': 1, saga: 2 };
const DY = 26, HEAD = 62, PADB = 12, LBL = 10.5;
const LINK_CH = 1; // links run in the channel below row 0 (the mid channel when there are two rows)

function sidesOf(s) {
  const L = [], R = [], T = [];
  const ordered = [...s.ports.filter((p) => p.target === 'place'), ...s.ports.filter((p) => p.target === 'transition')];
  for (const p of ordered) {
    if (p.kind === 'in') L.push(p);
    else if (p.kind === 'out') R.push(p);
    else if (p.kind === 'inout') { L.push(p); R.push(p); } else T.push(p);
  }
  return { L, R, T };
}

function headerOf(ctx, s) {
  const pat = ctx.orders.patterns[s.pattern];
  const title = `${s.id} : ${pat.prefLabel}`;
  let a = '', b = '';
  if (s.pattern === 'queue') {
    const it = s.places.find((p) => p.id === 'items');
    a = it.capacity ? `capacity ${it.capacity} · initial ${it.initial}` : `unbounded · initial ${it.initial}`;
    b = s.ports.some((p) => p.patternPort === 'queue-port-payload') ? 'with payload' : 'no payload';
  } else if (s.pattern === 'resource-pool') {
    const av = s.places.find((p) => p.id === 'available');
    a = `capacity ${av.capacity}`;
    b = 'units: available ⇄ in_use';
  } else if (s.pattern === 'saga') {
    a = `steps: ${(s.steps || []).join(' → ')}`;
    const shared = (s.accounts || []).some((acc) => /shared/.test(s.places.find((p) => p.id === acc)?.description || ''));
    b = `accounts: ${(s.accounts || []).join(', ')}${shared ? ' (shared)' : ''}`;
  }
  return { title, a, b };
}

function renderOrders(ctx) {
  const S = ctx.svg, TH = ctx.theme, I = ctx.info;
  const subs = ctx.orders.subnets, byId = ctx.orders.byId, links = ctx.orders.links;
  const ev = ctx.event;
  const LS = TH.LINK_STYLE;
  const anims = [];
  const tw = (s, z) => ctx.textWidth(s, z);

  // ---- grid: column by pattern, row by instance number ----
  const seen = {};
  const cells = subs.map((s, idx) => {
    const c = COL_OF[s.pattern] ?? 0;
    seen[c] = (seen[c] ?? -1) + 1;
    return { s, c, r: seen[c], idx, sides: sidesOf(s), head: headerOf(ctx, s) };
  });
  const NC = 3, NR = Math.max(...cells.map((x) => x.r)) + 1;
  for (const cell of cells) {
    const { sides, head } = cell;
    const tapBottom = cell.r > 0 && sides.T.length;
    const n = Math.max(sides.L.length, sides.R.length);
    const lw = Math.max(0, ...sides.L.map((p) => tw(p.id, LBL)));
    const rw = Math.max(0, ...sides.R.map((p) => tw(p.id, LBL)));
    cell.w = Math.ceil(Math.max(206, 18 * 2 + 12 + lw + rw + 36, tw(head.title, 12.5) + 34 + (sides.T.length && !tapBottom ? 64 : 0), tw(head.a, 10.5) + 34, tw(head.b, 10.5) + 34));
    cell.h = HEAD + n * DY + PADB + (tapBottom ? 20 : 0);
  }
  const colW = [0, 1, 2].map((c) => Math.max(0, ...cells.filter((x) => x.c === c).map((x) => x.w)));
  const rowH = [...Array(NR)].map((_, r) => Math.max(...cells.filter((x) => x.r === r).map((x) => x.h)));
  const X0 = 22, X1 = OW - 22;
  const rest = X1 - X0 - colW.reduce((a, b) => a + b, 0);
  const unit = rest / (2 * 0.55 + (NC - 1));
  const outerG = unit * 0.55;
  const colX0 = [], colX1 = [];
  let cx = X0 + outerG;
  for (let c = 0; c < NC; c++) { colX0.push(cx); colX1.push(cx + colW[c]); cx += colW[c] + unit; }
  const gx0 = (g) => (g === 0 ? X0 : colX1[g - 1]);
  const gx1 = (g) => (g === NC ? X1 : colX0[g]);
  const gcx = (g) => (gx0(g) + gx1(g)) / 2;
  const Y0 = 78, CH_TOP = 50, CH_MID = 124, CH_BOT = NR === 1 ? 96 : 50;
  const rowY = [];
  let cy = Y0 + CH_TOP;
  for (let r = 0; r < NR; r++) { rowY.push(cy); cy += rowH[r] + (r < NR - 1 ? CH_MID : 0); }
  const Y1 = cy + CH_BOT;
  const hy0 = (h) => (h === 0 ? Y0 : rowY[h - 1] + rowH[h - 1]);
  const hy1 = (h) => (h === NR ? Y1 : rowY[h]);
  const hcy = (h) => (hy0(h) + hy1(h)) / 2;
  const OH2 = Y1 + 108;

  for (const cell of cells) {
    cell.x = colX0[cell.c] + (colW[cell.c] - cell.w) / 2;
    cell.y = rowY[cell.r];
  }
  const cellOf = Object.fromEntries(cells.map((x) => [x.s.id, x]));

  // ---- port anchors (a port may have two: inout ports sit on both sides) ----
  const anchors = new Map(); // key -> {L:{x,y}, R:{x,y}, T|B:{x,y}}
  const keyOf = (sid, pid) => `${sid}|${pid}`;
  for (const cell of cells) {
    const { s, sides } = cell;
    const put = (p, side, pt) => { const k = keyOf(s.id, p.id); if (!anchors.has(k)) anchors.set(k, { cell, port: p }); anchors.get(k)[side] = pt; };
    sides.L.forEach((p, i) => put(p, 'L', { x: cell.x, y: cell.y + HEAD + DY * (i + 0.5), side: 'L' }));
    sides.R.forEach((p, i) => put(p, 'R', { x: cell.x + cell.w, y: cell.y + HEAD + DY * (i + 0.5), side: 'R' }));
    const tapSide = cell.r === 0 ? 'T' : 'B';
    sides.T.forEach((p, i) => put(p, tapSide, { x: cell.x + cell.w - 36 - i * 54, y: tapSide === 'T' ? cell.y : cell.y + cell.h, side: tapSide }));
  }
  const laneOf = (cell, pt) => (pt.side === 'L' ? { t: 'g', i: cell.c } : pt.side === 'R' ? { t: 'g', i: cell.c + 1 } : pt.side === 'T' ? { t: 'h', i: cell.r } : { t: 'h', i: cell.r + 1 });

  /** Which copy of a port a cable uses, given the other end's cell. */
  function endFor(ref, otherRef) {
    const a = anchors.get(keyOf(ref.subnet, ref.port));
    if (!a) return null;
    const cell = a.cell;
    let pt = a.T || a.B;
    if (!pt) {
      if (a.L && a.R) {
        const oc = otherRef ? cellOf[otherRef.subnet] : null;
        if (oc && oc.c > cell.c) pt = a.R; else if (oc && oc.c < cell.c) pt = a.L; else pt = cell.c === 0 ? a.L : a.R;
      } else pt = a.L || a.R;
    }
    return { ...pt, lane: laneOf(cell, pt), cell, port: a.port, key: keyOf(ref.subnet, ref.port) };
  }

  // ---- track allocation ----
  const gUse = new Map(), hUse = new Map();
  const GOFF = [0, -12, 12, -24, 24, -36, 36, -48, 48];
  const HOFF = [0, -14, 14, -28, 28, -42, 42, -56, 56];
  const allocG = (g) => { const k = gUse.get(g) || 0; gUse.set(g, k + 1); const half = (gx1(g) - gx0(g)) / 2 - 8; return gcx(g) + Math.max(-half, Math.min(half, GOFF[k % GOFF.length])); };
  const allocH = (h) => { const k = hUse.get(h) || 0; hUse.set(h, k + 1); const half = (hy1(h) - hy0(h)) / 2 - 8; return hcy(h) + Math.max(-half, Math.min(half, HOFF[k % HOFF.length])); };

  function route(a, b) {
    const A = { x: a.x, y: a.y }, B = { x: b.x, y: b.y };
    if (a.lane.t === 'g' && b.lane.t === 'g') {
      if (a.lane.i === b.lane.i) { const t = allocG(a.lane.i); return [A, { x: t, y: a.y }, { x: t, y: b.y }, B]; }
      const ty = allocH(LINK_CH), ta = allocG(a.lane.i), tb = allocG(b.lane.i);
      return [A, { x: ta, y: a.y }, { x: ta, y: ty }, { x: tb, y: ty }, { x: tb, y: b.y }, B];
    }
    if (a.lane.t === 'g' && b.lane.t === 'h') { const ta = allocG(a.lane.i), ty = allocH(b.lane.i); return [A, { x: ta, y: a.y }, { x: ta, y: ty }, { x: b.x, y: ty }, B]; }
    if (a.lane.t === 'h' && b.lane.t === 'g') return route(b, a).reverse();
    if (a.lane.i === b.lane.i) { const ty = allocH(a.lane.i); return [A, { x: a.x, y: ty }, { x: b.x, y: ty }, B]; }
    // two taps in different channels: through the nearest gutter
    let g = 0, best = Infinity;
    for (let k = 0; k <= NC; k++) { const d = Math.abs(gcx(k) - (a.x + b.x) / 2); if (d < best) { best = d; g = k; } }
    const tg = allocG(g), ya = allocH(a.lane.i), yb = allocH(b.lane.i);
    return [A, { x: a.x, y: ya }, { x: tg, y: ya }, { x: tg, y: yb }, { x: b.x, y: yb }, B];
  }

  // ---- event classes: one junction per fused class (union-find on port keys) ----
  const parent = new Map();
  const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) x = parent.get(x); return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };
  const evLinks = links.filter((l) => l.kind === 'event');
  evLinks.forEach((l) => union(keyOf(l.from.subnet, l.from.port), keyOf(l.to.subnet, l.to.port)));
  const classes = new Map();
  for (const l of evLinks) {
    const root = find(keyOf(l.from.subnet, l.from.port));
    if (!classes.has(root)) classes.set(root, { members: [], links: [] });
    const c = classes.get(root);
    c.links.push(l);
    for (const ref of [l.from, l.to]) if (!c.members.some((m) => m.subnet === ref.subnet && m.port === ref.port)) c.members.push(ref);
  }

  const linkSegs = [];
  const junctions = [];
  for (const [root, cl] of classes) {
    const ends = cl.members.map((m) => endFor(m, null)).filter(Boolean);
    const byG = new Map();
    ends.forEach((e) => { const g = e.lane.i; if (!byG.has(g)) byG.set(g, []); byG.get(g).push(e); });
    let gj = null, cnt = 0;
    for (const [g, es] of [...byG.entries()].sort((a, b) => a[0] - b[0])) if (es.length > cnt) { cnt = es.length; gj = g; }
    let jx, jy;
    const spokes = [];
    if (cnt >= 2) {
      jx = allocG(gj);
      const local = byG.get(gj);
      jy = local.reduce((s, e) => s + e.y, 0) / local.length;
      let ty = null;
      for (const e of ends) {
        if (e.lane.i === gj) spokes.push({ e, pts: [{ x: e.x, y: e.y }, { x: jx, y: e.y }, { x: jx, y: jy }] });
        else {
          if (ty === null) ty = allocH(LINK_CH);
          const t = allocG(e.lane.i);
          spokes.push({ e, pts: [{ x: e.x, y: e.y }, { x: t, y: e.y }, { x: t, y: ty }, { x: jx, y: ty }, { x: jx, y: jy }] });
        }
      }
    } else {
      jy = allocH(LINK_CH);
      const ts = ends.map((e) => ({ e, t: allocG(e.lane.i) }));
      jx = ts.reduce((s, x) => s + x.t, 0) / ts.length;
      for (const { e, t } of ts) spokes.push({ e, pts: [{ x: e.x, y: e.y }, { x: t, y: e.y }, { x: t, y: jy }, { x: jx, y: jy }] });
    }
    spokes.forEach((sp) => { sp.path = orth(sp.pts); linkSegs.push(...segsOf(sp.path.pts)); });
    junctions.push({ root, cl, jx, jy, spokes, leak: cl.links.some((l) => l.leak) });
  }

  const wires = links.filter((l) => l.kind !== 'event').map((l) => {
    const a = endFor(l.from, l.to), b = endFor(l.to, l.from);
    if (!a || !b) return null;
    const path = orth(route(a, b));
    linkSegs.push(...segsOf(path.pts));
    return { l, a, b, path };
  }).filter(Boolean);

  // ---- exposure leaders for unlinked ports ----
  const linked = new Set();
  links.forEach((l) => { linked.add(keyOf(l.from.subnet, l.from.port)); linked.add(keyOf(l.to.subnet, l.to.port)); });
  const leaders = [];
  const pending = []; // inner-gutter leaders, tracks assigned after directions are chosen
  for (const [key, a] of anchors) {
    if (linked.has(key)) continue;
    const cell = a.cell;
    let pt;
    if (a.T || a.B) pt = a.T || a.B;
    else if (a.L && a.R) pt = cell.c === 0 ? a.L : cell.c === NC - 1 ? a.R : a.L;
    else pt = a.L || a.R;
    const base = { key, port: a.port, cell, pt };
    if (pt.side === 'T') leaders.push({ ...base, pts: [{ x: pt.x, y: pt.y }, { x: pt.x, y: Y0 }], mark: { x: pt.x, y: Y0 } });
    else if (pt.side === 'B') leaders.push({ ...base, pts: [{ x: pt.x, y: pt.y }, { x: pt.x, y: Y1 }], mark: { x: pt.x, y: Y1 } });
    else if (pt.side === 'L' && cell.c === 0) leaders.push({ ...base, pts: [{ x: pt.x, y: pt.y }, { x: X0, y: pt.y }], mark: { x: X0, y: pt.y } });
    else if (pt.side === 'R' && cell.c === NC - 1) leaders.push({ ...base, pts: [{ x: pt.x, y: pt.y }, { x: X1, y: pt.y }], mark: { x: X1, y: pt.y } });
    else {
      const sgn = pt.side === 'L' ? -1 : 1;
      const probe = pt.x + sgn * 10;
      const count = (yEnd) => segsOf([{ x: pt.x, y: pt.y }, { x: probe, y: pt.y }, { x: probe, y: yEnd }]).reduce((n, sg) => n + linkSegs.filter((ls) => crosses(sg, ls)).length, 0);
      // a leader that has to run past another row of holes costs more than a crossing
      const up = count(Y0) + (cell.r > 0 ? 2 * cell.r : 0), down = count(Y1) + (NR - 1 - cell.r) * 2;
      const dir = up < down ? 'up' : down < up ? 'down' : (cell.r === 0 ? 'up' : 'down');
      pending.push({ ...base, dir, sgn, edgeKey: `${pt.side === 'L' ? cell.c : cell.c + 1}:${pt.side}` });
    }
  }
  const byEdge = new Map();
  pending.forEach((p) => { if (!byEdge.has(p.edgeKey)) byEdge.set(p.edgeKey, []); byEdge.get(p.edgeKey).push(p); });
  const LEAD_GAP = 16; // = the exposed mark's hit diameter, so neighbouring marks never share a hit area
  for (const group of byEdge.values()) {
    const ups = group.filter((p) => p.dir === 'up').sort((a, b) => a.pt.y - b.pt.y); // lower port, farther track
    const downs = group.filter((p) => p.dir === 'down').sort((a, b) => b.pt.y - a.pt.y); // higher port, farther track
    const g = Number(group[0].edgeKey.split(':')[0]);
    const room = (gx1(g) - gx0(g)) / 2 - 18;
    const n = group.length; // ups and downs share the tracks' numbering, so they never overlap
    const gap = n > 1 ? Math.max(10, Math.min(LEAD_GAP, room / (n - 1))) : LEAD_GAP;
    // When the gutter squeezes the tracks below LEAD_GAP, the marks still keep LEAD_GAP
    // apart: just before the boundary each leader fans back over its own hole (a free
    // stretch of the channel). The leader nearest the hole turns first and lands
    // farthest over it, so no two leaders cross.
    const fan = gap < LEAD_GAP - 0.01;
    const place = (list, k0) => list.forEach((p, i) => {
      const lx = p.pt.x + p.sgn * (10 + gap * (k0 + i));
      const yEnd = p.dir === 'up' ? Y0 : Y1;
      if (!fan) { leaders.push({ ...p, pts: [{ x: p.pt.x, y: p.pt.y }, { x: lx, y: p.pt.y }, { x: lx, y: yEnd }], mark: { x: lx, y: yEnd } }); return; }
      const j = list.length - 1 - i;
      const mx = p.pt.x - p.sgn * (4 + LEAD_GAP * j);
      const jy = yEnd + (p.dir === 'up' ? 1 : -1) * Math.min(31, 6 + 5 * j);
      leaders.push({ ...p, pts: [{ x: p.pt.x, y: p.pt.y }, { x: lx, y: p.pt.y }, { x: lx, y: jy }, { x: mx, y: jy }, { x: mx, y: yEnd }], mark: { x: mx, y: yEnd } });
    });
    place(ups, 0);
    place(downs, ups.length);
  }

  // ---- draw ----
  const root = ctx.svgRoot(OW, OH2, { class: 'view-svg opv' });
  root.appendChild(S('rect', { x: 0, y: 0, width: OW, height: OH2, fill: PAPER }));
  const Ly = { outer: S('g'), leaders: S('g'), wires: S('g'), holes: S('g'), junc: S('g'), iface: S('g', { class: 'iface' }), top: S('g'), fx: S('g') };
  Object.values(Ly).forEach((g) => root.appendChild(g));

  const ids = subs.map((s) => s.id);
  const nEv = evLinks.length, nTok = links.filter((l) => l.kind === 'token').length, nData = links.filter((l) => l.kind === 'data').length, nGuard = links.filter((l) => l.kind === 'guard').length;
  const cableTxt = [nEv && `${nEv} event link${nEv > 1 ? 's' : ''} in ${classes.size} junction${classes.size > 1 ? 's' : ''}`, nTok && `${nTok} token`, nData && `${nData} data`, nGuard && `${nGuard} guard (flagged)`].filter(Boolean).join(', ') || 'no cables: the composite is the monoidal product of the instances';
  Ly.top.append(
    rich(ctx, 14, 24, ['Φ(', ...cells.flatMap((c, i) => [i ? ', x' : 'x', { sub: String(c.idx + 1) }]), `): one wiring diagram with ${cells.length} typed holes, filled by ${ids.join(', ')}`], { size: 15, bold: true }),
    mkText(ctx, 14, 43, `Filling a hole with a box whose ports match its interface is operadic composition. ${links.length ? `Cables: ${cableTxt}; every one is a link the registry's bundle.add_link allowed (pflow-compose's port of go-pflow validateLink).` : 'No cables: the composite is the monoidal product (disjoint union) of the instances.'}`, { size: 11, fill: MUTED }));

  // outer box
  const outerLabel = `outer box: ${ids.join(' ⊗ ')}`;
  const olw = tw(outerLabel, 12) + 20;
  const outer = S('g', {},
    S('rect', { x: X0, y: Y0, width: X1 - X0, height: Y1 - Y0, rx: 16, fill: '#fff', stroke: INK, 'stroke-width': 1.8 }),
    S('rect', { x: X0 + 14, y: Y0 - 24, width: olw, height: 19, rx: 5, fill: INK }),
    mkText(ctx, X0 + 14 + olw / 2, Y0 - 10.5, outerLabel, { size: 12, bold: true, anchor: 'middle', fill: '#fff' }));
  const flat = ctx.orders.flat;
  ctx.hover(outer, {
    title: `outer box: ${ids.join(' ⊗ ')}`,
    concept: { iri: `${NS}Composition`, types: ['ns:Composition (PROPOSED, ROADMAP Phase 4)'] },
    definition: 'One operation of the wiring-diagram operad: its arguments are the holes x₁…xₙ (typed by pattern interfaces), its cables are the links, and its own ports are the exposed ones on the boundary.',
    facts: [
      ['holes', cells.map((c) => `x${sub(c.idx + 1)} = ${c.s.id}`).join(', ')],
      ['cables', cableTxt],
      ['exposed ports', `${leaders.length} (every port no link uses)`],
      ['flat net', flat.ok ? `${flat.model.places.length} places, ${flat.model.transitions.length} transitions` : 'flatten refused'],
    ],
    note: 'Which ports the outer box exposes is this view\'s choice: a go-pflow Bundle declares no ports of its own.',
    cites: [C.bundle, C.classes],
    bib: ['spivak-wd', 'fong-spivak'],
  });
  Ly.outer.appendChild(outer);

  // leaders (faint) and the outer boundary's exposed ports
  for (const ld of leaders) {
    const p = orth(ld.pts, 5);
    Ly.leaders.appendChild(S('path', { class: 'leader', d: p.d }));
    const port = ld.port;
    ctx.emit('exposed', `${ld.cell.s.id}:${port.id}`, {});
    const color = TH.portColor(port);
    const isT = port.target === 'transition';
    const mg = S('g', { transform: `translate(${f1(ld.mark.x)},${f1(ld.mark.y)})` },
      S('circle', { class: 'hit', r: 8 }),
      isT ? S('rect', { class: 'pmark', x: -3.5, y: -3.5, width: 7, height: 7, fill: '#fff', stroke: color, 'stroke-width': 1.4 })
        : S('circle', { class: 'pmark', r: 3.5, fill: '#fff', stroke: color, 'stroke-width': 1.4 }));
    ctx.snap.port(mg, { subnet: ld.cell.s.id, port: port.id });
    ctx.hover(mg, extend(I.portInfo(ld.cell.s, port), { facts: [['on the outer box', 'exposed: no link uses this port, so it stays on the composite\'s interface']], note: 'Exposure is this view\'s reading; a go-pflow Bundle declares no outer ports (compose.go:207-227).', cites: [C.bundle] }));
    Ly.iface.appendChild(mg);
  }

  // non-event cables: token / data as wires between place ports, guard as a flagged tap
  const wireByKey = new Map();
  for (const w of wires) {
    const st = LS[w.l.kind];
    const g = S('g', { 'data-link': w.l.key });
    ctx.emit('junction', w.l.key, { kind: w.l.kind });
    const width = w.l.kind === 'guard' ? 1.8 : 2.2;
    g.appendChild(S('path', { d: w.path.d, fill: 'none', stroke: st.color, 'stroke-width': width, 'stroke-dasharray': st.dash || null, 'stroke-linecap': 'round' }));
    g.appendChild(S('path', { class: 'wire-hit', d: w.path.d }));
    // glyph on the longest segment
    let best = null, bl = -1;
    segsOf(w.path.pts).forEach(([p, q]) => { const l = dist(p, q); if (l > bl) { bl = l; best = [p, q]; } });
    const mx = (best[0].x + best[1].x) / 2, my = (best[0].y + best[1].y) / 2;
    if (w.l.kind === 'token') g.appendChild(S('path', { d: `M${f1(mx)},${f1(my - 6)} L${f1(mx + 6)},${f1(my)} L${f1(mx)},${f1(my + 6)} L${f1(mx - 6)},${f1(my)} Z`, fill: st.color, stroke: '#fff', 'stroke-width': 1.2 }));
    else if (w.l.kind === 'data') {
      const ang = Math.atan2(best[1].y - best[0].y, best[1].x - best[0].x) * 180 / Math.PI;
      g.appendChild(S('path', { d: 'M-5,-6 L7,0 L-5,6 Z', fill: '#fff', stroke: st.color, 'stroke-width': 1.6, transform: `translate(${f1(mx)},${f1(my)}) rotate(${f1(ang)})` }));
    } else {
      g.appendChild(S('circle', { cx: f1(mx), cy: f1(my), r: 7, fill: '#fff', stroke: st.color, 'stroke-width': 1.6 }));
      g.appendChild(S('path', { d: `M${f1(mx - 4.5)},${f1(my + 4.5)} L${f1(mx + 4.5)},${f1(my - 4.5)}`, stroke: st.color, 'stroke-width': 1.6 }));
    }
    // the guard's label sits above its glyph, in a layer over the holes, so no hole hides it
    const tag = w.l.kind === 'guard' ? mkText(ctx, mx, my - 11, 'contextual', { size: 9.5, anchor: 'middle', fill: st.color, italic: true, cls: 'halo' }) : null;
    const li = I.linkInfo(w.l, byId);
    const wInfo = extend(li, w.l.kind === 'guard'
      ? { note: 'A guard is not a cable: it restricts one subnet (W_RESTRICTIVE_LINK) and sits outside the free-SMC fragment. Drawn and flagged; no operadic composite is claimed for it.', cites: [RULE_CITES.guard] }
      : { facts: [['operad reading', w.l.kind === 'token' ? 'a cable joining two place ports. What it means, place gluing, is a pushout of open nets (Baez-Master); the operad\'s own substitution is a different pushout, of cable sets (Spivak Ex. 2.1.7)' : 'a cable for read-only observation: the observer moves nothing on the observed place']], cites: [RULE_CITES.schema, C.classes], bib: ['baez-master', 'spivak-wd'] });
    ctx.hover(g, wInfo);
    if (tag) { ctx.hover(tag, wInfo); Ly.junc.appendChild(tag); }
    Ly.wires.appendChild(g);
    wireByKey.set(w.l.key, { g, w });
  }

  // event junctions
  const spokeByKey = new Map();
  const juncByRoot = new Map();
  const EV = LS.event.color;
  for (const j of junctions) {
    const members = j.cl.members.map((m) => `${m.subnet}:${m.port}`);
    const flatName = (() => {
      const fg = flat.ok ? flat.map.fusedGroups : {};
      const m0 = j.cl.members[0];
      const t = byId[m0.subnet]?.ports.find((p) => p.id === m0.port)?.transition;
      return Object.entries(fg).find(([, ms]) => ms.includes(`${m0.subnet}/${t}`))?.[0] || null;
    })();
    const jInfo = {
      title: `junction: ${members.join(' = ')}`,
      concept: { iri: 'https://ontology.pflow.xyz/linkkind/event', types: ['ns:EventPatternLink class', 'op:sync (PROPOSED, ROADMAP Phase 6)'] },
      definition: ctx.content.text('operad-junction-rendezvous'),
      facts: [
        ['links', j.cl.links.map((l) => `${l.from.subnet}:${l.from.port} — ${l.to.subnet}:${l.to.port}${l.idiom ? ` (pat:${l.idiom})` : ''}`).join('; ')],
        ['members', `${members.length} ports, one junction (fusion is over equivalence classes)`],
        ['flat transition', flatName || '(see the flat view)'],
        ['semantics', 'synchronisation (Bruni et al.), not place gluing'],
      ],
      caveats: j.cl.links.map((l) => (l.idiom ? ctx.orders.idioms.find((x) => x.key === l.idiom)?.caveat : null)).filter(Boolean),
      cites: [C.fuse, C.classes, ...ctx.orders.linkKinds.event.cites.slice(0, 2), LINK_STYLE_CITE],
      bib: ['spivak-wd', 'bruni-et-al'],
    };
    const jg = S('g', { 'data-junction': j.root });
    for (const l of j.cl.links) ctx.emit('junction', l.key, { kind: l.kind });
    for (const sp of j.spokes) {
      const pg = S('g', {},
        S('path', { d: sp.path.d, fill: 'none', stroke: EV, 'stroke-width': 2.6, 'stroke-linecap': 'round' }),
        S('path', { class: 'wire-hit', d: sp.path.d }));
      ctx.hover(pg, jInfo);
      Ly.wires.appendChild(pg);
      spokeByKey.set(sp.e.key, { pg, sp });
    }
    const dot = S('g', { transform: `translate(${f1(j.jx)},${f1(j.jy)})` },
      S('circle', { r: 11, class: 'hit' }),
      S('circle', { r: 7.5, fill: EV, stroke: '#fff', 'stroke-width': 1.5 }),
      S('path', { d: 'M-3.6,-3.6 L3.6,3.6 M3.6,-3.6 L-3.6,3.6', stroke: '#fff', 'stroke-width': 1.7, 'stroke-linecap': 'round' }));
    fb(dot.children[1]);
    jg.appendChild(dot);
    if (j.leak) {
      jg.appendChild(S('circle', { cx: f1(j.jx), cy: f1(j.jy), r: 11.5, fill: 'none', stroke: TH.LEAK, 'stroke-width': 1.6, 'stroke-dasharray': '3 2' }));
      // a plate behind the label, so a cable passing behind it does not run through the words
      jg.appendChild(S('rect', { x: f1(j.jx - 42), y: f1(j.jy - 55), width: 84, height: 40, rx: 5, fill: '#fff', 'fill-opacity': 0.9, stroke: TH.LEAK, 'stroke-opacity': 0.25 }));
      jg.append(
        mkText(ctx, j.jx, j.jy - 44, 'pool leak:', { size: 10.5, anchor: 'middle', fill: TH.LEAK, bold: true, cls: 'halo-w' }),
        mkText(ctx, j.jx, j.jy - 31, 'on rollback', { size: 10, anchor: 'middle', fill: TH.LEAK, cls: 'halo-w' }),
        mkText(ctx, j.jx, j.jy - 19, 'no port fires', { size: 10, anchor: 'middle', fill: TH.LEAK, cls: 'halo-w' }));
    }
    ctx.hover(jg, jInfo);
    Ly.junc.appendChild(jg);
    juncByRoot.set(j.root, { jg, dot, j });
  }

  // holes, instance boxes and their ports
  for (const cell of cells) {
    const { s, sides, head } = cell;
    const pat = ctx.orders.patterns[s.pattern];
    const tint = TH.PATTERN_TINT[s.pattern] || '#f4f5f7';
    const hg = S('g', { 'data-hole': s.id });
    ctx.emit('hole', s.id, {});
    // the hole (dashed) and its type tab
    hg.appendChild(S('rect', { x: cell.x, y: cell.y, width: cell.w, height: cell.h, rx: 9, fill: '#fff', stroke: '#8e96a1', 'stroke-width': 1.2, 'stroke-dasharray': '6 4' }));
    const tab = S('g', {}, rich(ctx, cell.x + 4, cell.y - 8, ['hole x', { sub: String(cell.idx + 1) }, ` : ${pat.prefLabel} interface`], { size: 10.5, italic: true, fill: MUTED, cls: 'halo' }));
    ctx.hover(tab, {
      title: `hole x${sub(cell.idx + 1)}: the ${pat.prefLabel} interface`,
      concept: { iri: pat.iri, types: ['ns:NetPattern: its ports are the hole\'s type'] },
      definition: 'A hole of the outer box, typed by a pattern\'s ports (ns:PatternPort): their kinds, targets and schemas. Any box with exactly these ports can fill it.',
      facts: s.ports.map((p) => [p.id, `${p.kind} ${p.target}${p.schema ? ` · ${p.schema}` : ''}`]),
      bib: ['spivak-wd'],
    });
    hg.appendChild(tab);
    // the instance box that fills it
    const bx = cell.x + 5, by = cell.y + 5, bw = cell.w - 10, bh = cell.h - 10;
    const box = S('g', {},
      S('rect', { x: bx, y: by, width: bw, height: bh, rx: 6, fill: '#fff', stroke: INK, 'stroke-width': 1.5 }),
      S('path', { d: `M${bx},${by + 6} Q${bx},${by} ${bx + 6},${by} L${bx + bw - 6},${by} Q${bx + bw},${by} ${bx + bw},${by + 6} L${bx + bw},${by + HEAD - 8} L${bx},${by + HEAD - 8} Z`, fill: tint }),
      S('line', { x1: bx, y1: by + HEAD - 8, x2: bx + bw, y2: by + HEAD - 8, stroke: '#d5d9df' }),
      mkText(ctx, bx + 12, by + 18, head.title, { size: 12.5, bold: true }),
      mkText(ctx, bx + 12, by + 32, head.a, { size: 10.5, fill: '#3c4656' }),
      mkText(ctx, bx + 12, by + 44.5, head.b, { size: 10.5, fill: MUTED }));
    ctx.hover(box, extend(I.subnetInfo(s), {
      facts: [['fills', `hole x${sub(cell.idx + 1)}: its ports are the hole's ports, one for one`]],
      note: 'Filling a hole with this box is operadic composition (Spivak 2013, Ex. 2.1.7: substitution is a pushout of cables).',
      bib: ['spivak-wd'],
    }));
    hg.appendChild(box);

    // ports on the hole's edge
    const drawPort = (p, pt) => {
      const color = TH.portColor(p);
      const isT = p.target === 'transition';
      const g = S('g', { transform: `translate(${f1(pt.x)},${f1(pt.y)})` });
      g.appendChild(S('circle', { class: 'hit', r: 9 }));
      if (pt.side === 'L' || pt.side === 'R') g.appendChild(S('line', { x1: 0, y1: 0, x2: pt.side === 'L' ? 5 : -5, y2: 0, stroke: color, 'stroke-width': 1.5 }));
      else g.appendChild(S('line', { x1: 0, y1: 0, x2: 0, y2: pt.side === 'T' ? 5 : -5, stroke: color, 'stroke-width': 1.5 }));
      const observe = p.kind === 'observe';
      g.appendChild(isT ? S('rect', { class: 'pmark', x: -5, y: -5, width: 10, height: 10, rx: 1.5, fill: color, stroke: '#fff', 'stroke-width': 1.2 })
        : S('circle', { class: 'pmark', r: 5.5, fill: observe ? '#fff' : color, stroke: observe ? color : '#fff', 'stroke-width': observe ? 2 : 1.2 }));
      ctx.snap.port(g, { subnet: s.id, port: p.id });
      const k = keyOf(s.id, p.id);
      const cables = links.filter((l) => keyOf(l.from.subnet, l.from.port) === k || keyOf(l.to.subnet, l.to.port) === k);
      ctx.hover(g, extend(I.portInfo(s, p), {
        facts: [
          ['side', { in: 'left: an in-port', out: 'right: an out-port', inout: 'both sides: an inout port (drawn twice, one port)', observe: 'a side tap: observe' }[p.kind]],
          ['cables', cables.length ? cables.map((l) => `${LS[l.kind].glyph} ${l.kind} ${l.from.subnet}:${l.from.port} — ${l.to.subnet}:${l.to.port}`).join('; ') : 'none: exposed on the outer box'],
        ],
        note: 'The side is go-pflow\'s port kind, kept for reading; Spivak\'s operad treats a box\'s ports as a set.',
      }));
      hg.appendChild(g);
      // direction chevron and label inside the box
      const lblC = isT ? '#3c4656' : INK;
      if (pt.side === 'L' || pt.side === 'R') {
        const cxv = pt.side === 'L' ? bx + 9 : bx + bw - 9;
        const chev = p.kind === 'inout' ? `M${cxv - 4},${pt.y} L${cxv - 1},${pt.y - 3} L${cxv - 1},${pt.y + 3} Z M${cxv + 4},${pt.y} L${cxv + 1},${pt.y - 3} L${cxv + 1},${pt.y + 3} Z`
          : `M${cxv - 2.5},${pt.y - 3.5} L${cxv + 2.5},${pt.y} L${cxv - 2.5},${pt.y + 3.5} Z`;
        hg.appendChild(S('path', { d: chev, fill: color, opacity: 0.85 }));
        hg.appendChild(mkText(ctx, pt.side === 'L' ? bx + 17 : bx + bw - 17, pt.y + 3.6, p.id, { size: LBL, anchor: pt.side === 'L' ? 'start' : 'end', mono: true, fill: lblC }));
      } else {
        hg.appendChild(mkText(ctx, pt.x, pt.side === 'T' ? by + 20 : by + bh - 8, p.id, { size: LBL, anchor: 'middle', mono: true, fill: lblC }));
      }
      return g;
    };
    const portEls = new Map();
    for (const [side, list] of [['L', sides.L], ['R', sides.R]]) list.forEach((p) => portEls.set(`${p.id}@${side}`, drawPort(p, anchors.get(keyOf(s.id, p.id))[side])));
    sides.T.forEach((p) => { const a = anchors.get(keyOf(s.id, p.id)); portEls.set(`${p.id}@T`, drawPort(p, a.T || a.B)); });
    cell.portEls = portEls;
    Ly.holes.appendChild(hg);
    if (ev && ev.type === 'instance-added' && ev.id === s.id) {
      fb(hg);
      anims.push(() => hg.animate([{ transform: 'translate(0px,30px) scale(.94)', opacity: 0 }, { transform: 'translate(0px,0px) scale(1)', opacity: 1 }], { duration: 750, easing: EASE }));
    }
  }

  // ---- legend ----
  const lg = S('g', {});
  const ly = Y1 + 30;
  let lx = 14;
  const item = (draw, label) => { lg.appendChild(draw(lx)); lx += 20; lg.appendChild(mkText(ctx, lx, ly + 4, label, { size: 11, fill: '#3c4656' })); lx += tw(label, 11) + 18; };
  const schemas = [...new Set(subs.flatMap((s) => s.ports.filter((p) => p.target === 'place').map((p) => p.schema)))];
  for (const sc of schemas) item((x) => S('circle', { cx: x + 6, cy: ly, r: 5.5, fill: TH.schemaColor(sc) }), sc);
  item((x) => S('rect', { x: x + 1, y: ly - 5, width: 10, height: 10, rx: 1.5, fill: TH.TRANSITION_PORT_COLOR }), 'transition port (no schema)');
  item((x) => S('circle', { cx: x + 6, cy: ly, r: 5, fill: '#fff', stroke: TH.schemaColor('queue:items'), 'stroke-width': 2 }), 'observe tap');
  lx = 14;
  const ly2 = ly + 24;
  const item2 = (draw, label, w = 20) => { lg.appendChild(draw(lx, ly2)); lx += w + 6; lg.appendChild(mkText(ctx, lx, ly2 + 4, label, { size: 11, fill: '#3c4656' })); lx += tw(label, 11) + 18; };
  item2((x, y) => S('g', {}, S('path', { d: `M${x},${y} L${x + 22},${y}`, stroke: EV, 'stroke-width': 2.6 }), S('circle', { cx: x + 11, cy: y, r: 6, fill: EV }), S('path', { d: `M${x + 8.2},${y - 2.8} L${x + 13.8},${y + 2.8} M${x + 13.8},${y - 2.8} L${x + 8.2},${y + 2.8}`, stroke: '#fff', 'stroke-width': 1.5 })), 'event junction (one per fused class)', 22);
  item2((x, y) => S('g', {}, S('path', { d: `M${x},${y} L${x + 22},${y}`, stroke: LS.token.color, 'stroke-width': 2.2, 'stroke-dasharray': LS.token.dash }), S('path', { d: `M${x + 11},${y - 5} L${x + 16},${y} L${x + 11},${y + 5} L${x + 6},${y} Z`, fill: LS.token.color })), 'token cable', 22);
  item2((x, y) => S('path', { d: `M${x},${y} L${x + 22},${y}`, stroke: LS.data.color, 'stroke-width': 2.2, 'stroke-dasharray': LS.data.dash }), 'data cable', 22);
  item2((x, y) => S('path', { d: `M${x},${y} L${x + 22},${y}`, stroke: LS.guard.color, 'stroke-width': 1.8, 'stroke-dasharray': LS.guard.dash }), 'guard (flagged, not a cable)', 22);
  item2((x, y) => S('g', {}, S('path', { d: `M${x},${y} L${x + 14},${y}`, class: 'leader' }), S('circle', { cx: x + 17, cy: y, r: 3.8, fill: '#fff', stroke: FAINT, 'stroke-width': 1.4 })), 'exposed on the outer box', 22);
  item2((x, y) => S('g', {}, S('path', { d: `M${x + 1},${y - 3.5} L${x + 6},${y} L${x + 1},${y + 3.5} Z`, fill: '#3c4656' }), S('path', { d: `M${x + 10},${y} L${x + 13},${y - 3} L${x + 13},${y + 3} Z M${x + 18},${y} L${x + 15},${y - 3} L${x + 15},${y + 3} Z`, fill: '#3c4656' })), 'in (left) · out (right) · inout (both sides)', 20);
  lg.appendChild(mkText(ctx, 14, ly2 + 28, 'Drag from any port, in a hole or on the outer box: only the ports the registry accepts light up (bundle.candidates: pflow-compose\'s port of go-pflow validateLink). Colors and glyphs are go-pflow RenderDOT\'s (composedot.go:28-33).', { size: 10.5, fill: MUTED, italic: true }));
  Ly.top.appendChild(lg);

  // ---- merge animation: cables meeting at the junction / the wire drawing on ----
  if (ev && ev.type === 'link-added') {
    const l = ev.link;
    const ends = [keyOf(l.from.subnet, l.from.port), keyOf(l.to.subnet, l.to.port)];
    const pulsePorts = () => {
      for (const k of ends) for (const el of root.querySelectorAll(`[data-port="${CSS.escape(k)}"] .pmark`)) {
        fb(el);
        el.animate([{ transform: 'scale(1)' }, { transform: 'scale(2.1)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 800, easing: 'ease-out' });
      }
    };
    if (l.kind === 'event') {
      const rootKey = find(ends[0]);
      const J = juncByRoot.get(rootKey);
      if (J) {
        for (const k of ends) {
          const sp = spokeByKey.get(k);
          if (!sp) continue;
          sp.pg.style.opacity = '0';
          anims.push(drawOn(ctx, Ly.fx, sp.sp.path.d, EV, 3.4, 0, 760));
          anims.push(() => sp.pg.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], { duration: 760, fill: 'forwards' }).finished.then(() => { sp.pg.style.opacity = ''; }).catch(() => {}));
        }
        const ring = S('circle', { cx: f1(J.j.jx), cy: f1(J.j.jy), r: 8, fill: 'none', stroke: EV, 'stroke-width': 2.5, style: { pointerEvents: 'none' } });
        Ly.fx.appendChild(ring);
        anims.push(() => ring.animate([{ r: 8, opacity: 0 }, { r: 8, opacity: 0.9, offset: 0.55 }, { r: 30, opacity: 0 }], { duration: 900, easing: 'ease-out', fill: 'forwards' }).finished.then(() => ring.remove()).catch(() => {}));
        const core = J.dot.children[1];
        anims.push(() => core.animate([{ transform: 'scale(0.2)', opacity: 0.2 }, { transform: 'scale(0.2)', opacity: 0.2, offset: 0.5 }, { transform: 'scale(1.6)', opacity: 1, offset: 0.75 }, { transform: 'scale(1)', opacity: 1 }], { duration: 880, easing: 'ease-out' }));
      }
    } else {
      const W = wireByKey.get(l.key);
      if (W) {
        W.g.style.opacity = '0';
        anims.push(drawOn(ctx, Ly.fx, W.w.path.d, LS[l.kind].color, 3.2, 0, 800));
        anims.push(() => W.g.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: 800, fill: 'forwards' }).finished.then(() => { W.g.style.opacity = ''; }).catch(() => {}));
      }
    }
    anims.push(pulsePorts);
  }

  ctx.root.appendChild(root);
  for (const a of anims) a();

  // notes, top to bottom (each prepends)
  ctx.note(ctx.content.text('operad-outer-interface'), 'honesty');
  if (nGuard) ctx.note('Guard links are not cables: a guard restricts one subnet on another\'s place (W_RESTRICTIVE_LINK) and sits outside the free-SMC fragment (ROADMAP Phase 6). It is drawn and flagged; no operadic composite is claimed for it.', 'warn');
  ctx.note('Spivak\'s operad of wiring diagrams (arXiv:1305.0297, Ex. 2.1.7) is undirected: a wiring diagram is a cospan, every port is soldered onto a cable, and filling a hole is a pushout. A directed version appears there only in §6.3 (Future work), as the subject of a paper then in preparation (Spivak-Stapleton). So an event link is drawn as a junction (⊗) on one cable, not as a wire from an output to an input: it is a synchronisation (Bruni et al.), as in the cospan operad of Fong-Spivak §6.5 (Ex. 6.94), whose wiring diagrams have ports but no left and right. In / out sides are go-pflow port kinds, kept for reading; the operad does not see them.', 'na');
}

// ===================================================================================

export default {
  id: 'operad',
  title: 'Wiring diagrams (operad nesting)',
  short: 'Operad',
  consumes: ['bundle.flatten', 'bundle.state', 'content.get', 'plan.state'],
  convention: {
    summary: 'Spivak\'s operad of wiring diagrams: an outer box with typed holes, each hole filled by a box whose interface matches. Filling a hole is operadic composition, and nesting is composition again, so a drawing is read from the outside in: the outer box is one operation, its holes are its arguments, and whatever fills them is the operand. In Spivak\'s operad a wiring diagram is a cospan of ports onto cables (no inputs or outputs); in the typed version, ports soldered to one cable must carry the same type.',
    honesty: [
      'Spivak\'s operad (arXiv:1305.0297) is undirected: a wiring diagram is a cospan of ports onto cables. A directed version appears there only in §6.3 (Future work), as the subject of a paper then in preparation. The in / out sides drawn here are go-pflow port kinds (ns:portKind), kept for reading.',
      'One junction per fused class: event links are binary, but fusion is over equivalence classes (compose_fuse.go:9-20), so links a—b and b—c draw one junction with three legs.',
      'A token cable and an event cable look alike here and mean different things: place gluing (Baez-Master) versus synchronisation (Bruni et al.). The operad records connectivity; the link kind is the registry\'s (bundle.state).',
      'The outer box\'s interface (the faint exposed ports) is this view\'s reading: a go-pflow Bundle declares no ports of its own (compose.go:207-227). Guard links are not cables; they are drawn and flagged, with no operadic composite claimed.',
      'bounds and engine are designed holes (ROADMAP:307), drawn dashed; every drop on them is refused. Proposed pieces (status "proposed" in plan.pieces: mtd_f, forced_moves, …) are unknown to pflow-rs and fill nothing.',
    ],
    bib: ['spivak-wd', 'fong-spivak', 'baez-master', 'bruni-et-al'],
    cites: [
      C.composite, C.operadRow, C.sliceB, C.monoid, C.driverOrder, C.noBound,
      C.planDoc, C.driversFlags, C.drivers, C.chain, C.check, C.solver,
      C.orderOnly, C.decisive, C.chainNew, C.chainKey,
      C.memo, C.nullWin, C.run, C.solve, C.core,
      C.bundle, C.fuse, C.classes, RULE_CITES.schema, LINK_STYLE_CITE,
    ],
  },
  render(ctx) {
    ctx.root.appendChild(ctx.el('style', {}, STYLE));
    if (ctx.example === 'connect4') renderPlan(ctx);
    else renderOrders(ctx);
  },
};
