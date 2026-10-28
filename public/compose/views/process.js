// View 9: runs as processes.
//
// A run of a Petri net is a morphism (a process) in the monoidal category the
// net generates (Meseguer and Montanari, "Petri nets are monoids"; Baez,
// Genovese, Master and Shulman, "Categories of Nets"). Tokens are wires
// labelled by their place, each firing is a box from its preset to its
// postset, time runs left to right, and the initial marking is the domain and
// the final marking the codomain.
//
// Orders: a scenario's firing script (bundle.scenarios) is fired on the flat net
// by the registry (bundle.run: pflow-metamodel's enabled/fire, go-pflow's firing
// rule), step by step through model.js, stopping at the first step it refuses;
// the scenario's predicates are bundle.run {scenario}'s. Connect-4: one fixed
// four-ply opening fired on the fixture net by the registry's token game
// (sim.fire on the c4 engine). No search is run.
//
// The page reads each box's preset and postset off the flat net's arcs to draw
// the token wires; whether a box fires, and the marking it leaves, is the
// registry's.
//
// Scene manifest (parity contract): orders, one `run` per scenario chip drawn
// (fired: the flat ids of the boxes fired, sorted, repeats kept; stopped_step:
// the member bundle.run stopped at, or ""); connect4, `run` "opening" (fired:
// the number of drops fired).
//
// Token identities are assigned first-in first-out per place. That is the
// individual-token reading and it is this view's choice; the page says so.
// The layout tries a few deterministic orderings of the wires and keeps the
// one with the fewest crossings (a crossing is a symmetry, not a fact of the run).

import { cite } from '../sources.js';
import { NS } from '../model.js';
import { initialMarking, whyNotEnabled, fire, flatOf, FLATTEN_CITES, runOf as runOfRegistry, c4Model as onC4Engine } from '../model.js';
import { engines } from '../registry.js';

const W = 1150;
const PAD = 16;
const LANE = 28;
const INK = '#2b2f36';
const MUTED = '#6a717c';
const LEAK = '#c0392b';
const BACK = '#1e7a46';
const PAPER = '#fafafa';

const go = (path, from, to = from, note = '') => cite('goPflow', path, from, to, note);
const rs = (path, from, to = from, note = '') => cite('pflowRs', path, from, to, note);
const ttl = (from, to = from, note = '') => cite('ontology', 'ns/patterns.ttl', from, to, note);

const CITES = {
  arcs: go('metamodel/firing.go', 79, 120, 'Inputs, Outputs, Tests: a box\'s preset, postset and read arcs'),
  enabled: go('metamodel/firing.go', 122, 138, 'Enabled: the four firing rules together'),
  whyNot: go('metamodel/firing.go', 140, 196, 'EnabledWhyNot: the reason quoted where a run stops'),
  capacity: go('metamodel/firing.go', 172, 194, 'capacity: a post-firing bound on the places a firing raises; not part of its preset'),
  fire: go('metamodel/firing.go', 198, 212, 'Fire: the box takes its preset and gives its postset'),
  fifoNot: ttl(201, 201, 'queue caveat: the net does not order items, so FIFO identity is this view\'s choice'),
  anon: ttl(251, 251, 'pool caveat: in_use is an anonymous count'),
  oneCase: ttl(429, 429, 'saga caveat: one saga is one case'),
  noEither: ttl(434, 434, 'saga caveat: no port fires on either outcome'),
  leak: ttl(493, 497, 'pat:idiom-pool-release-saga-commit and its pool-leak caveat (:496)'),
  auto: rs('crates/pflow-metamodel/src/game.rs', 4, 11, 'automatic transitions fire as soon as enabled; every other transition is a move'),
  settle: rs('crates/pflow-metamodel/src/game.rs', 221, 232, 'settle: automatic transitions, lowest index first, until none is enabled'),
  byName: rs('crates/pflow-metamodel/tests/common/mod.rs', 5, 8, 'the fixtures name their parts by convention; the tests declare them'),
  game: rs('crates/pflow-metamodel/tests/common/mod.rs', 17, 35, 'game(): auto = name contains "win", x_ moves are +1, reward win_x - win_o, settled start'),
  inhibit: rs('crates/pflow-parser/src/lib.rs', 84, 88, 'inhibitTransition: input side is an inhibitor arc, output side a read arc'),
  fixture: rs('crates/pflow-metamodel/tests/fixtures/connect-4.json', null, null, 'assets/connect-4.json is a byte-identical copy'),
};

const BIB = ['meseguer-montanari', 'baez-gms', 'selinger', 'joyal-street'];

// --- view-local UI state (scenario, idle toggle) ----------------------------------------
// Kept here, not in the store: it changes the drawing, not the composition.
// A deep link may carry #...&run=<scenario>&idle=1 (read once, at load).

const ui = { scenario: null, idle: false, replay: false };
if (typeof location !== 'undefined') {
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('run')) ui.scenario = h.get('run');
    if (h.get('idle') === '1') ui.idle = true;
  } catch { /* no hash */ }
}
// The shell re-renders on hashchange (app.js main); that is the whole render
// path (resetSnap included), so a view-local change goes through it too.
function rerender() {
  ui.replay = true;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// --- the run: firing with token identities ----------------------------------------------

const wt = (a) => a.weight || 1; // firing.go arcWeight

/** Inputs, Outputs and Tests of one transition (firing.go:79-120), read off the arcs to draw wires; firing is the registry's. */
function arcsOf(model, tid) {
  const tokenPlaces = new Set(model.places.filter((p) => (p.kind || 'token') === 'token').map((p) => p.id));
  const inputs = [], outputs = [], tests = [];
  for (const a of model.arcs) {
    const ro = a.type === 'read' || a.type === 'inhibitor';
    if (a.to === tid && tokenPlaces.has(a.from)) (ro ? tests : inputs).push(a);
    else if (a.from === tid && !ro && tokenPlaces.has(a.to)) outputs.push(a);
  }
  return { inputs, outputs, tests };
}

/**
 * Fire steps [{tid, member, say}] from the initial marking, stopping at the
 * first one the registry refuses (bundle.run). Tokens get identities first-in first-out
 * per place: {id, place, n, born (0 = domain, k = box k), died (k, or null = codomain)}.
 */
export function runProcess(model, steps) {
  const initial = initialMarking(model);
  let mk = { ...initial };
  const tokens = [], fifo = new Map(), serial = new Map();
  const make = (place, at) => {
    const n = (serial.get(place) || 0) + 1;
    serial.set(place, n);
    const t = { id: tokens.length, place, n, born: at, died: null };
    tokens.push(t);
    if (!fifo.has(place)) fifo.set(place, []);
    fifo.get(place).push(t);
    return t;
  };
  for (const p of model.places) for (let i = 0; i < (initial[p.id] || 0); i++) make(p.id, 0);
  const boxes = [];
  let stop = null;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    const why = st.tid ? whyNotEnabled(model, mk, st.tid) : `no flat transition contains ${st.member}`;
    if (why !== null) {
      stop = { index: i, step: st, tid: st.tid, why, needs: st.tid ? needsOf(model, mk, st.tid, fifo) : [] };
      break;
    }
    const k = boxes.length + 1;
    const { inputs, outputs, tests } = arcsOf(model, st.tid);
    const box = { k, tid: st.tid, step: st, ins: [], outs: [], reads: [], readShared: [], inhib: [] };
    for (const a of inputs) for (let w = 0; w < wt(a); w++) { const t = fifo.get(a.from).shift(); t.died = k; box.ins.push(t); }
    for (const a of tests) {
      if (a.type === 'read') {
        // go-pflow tests a read arc on the marking before the firing, so it may be
        // satisfied by a token this same firing takes: then there is no other token to draw
        const q = fifo.get(a.from) || [];
        for (let w = 0; w < wt(a) && w < q.length; w++) if (!box.reads.includes(q[w])) box.reads.push(q[w]);
        if (q.length < wt(a)) box.readShared.push(a.from);
      } else box.inhib.push({ place: a.from, weight: wt(a), have: mk[a.from] ?? 0 });
    }
    mk = fire(model, mk, st.tid);
    for (const a of outputs) for (let w = 0; w < wt(a); w++) box.outs.push(make(a.to, k));
    box.marking = mk;
    boxes.push(box);
  }
  return { initial, final: mk, tokens, boxes, stop, serial };
}

/**
 * What a refused transition needed, place by place, and which tokens it could have used.
 * Besides its preset (take) and its read and inhibitor arcs, go-pflow checks capacity
 * on the places the firing raises (firing.go:172-194): those come back as 'capacity'
 * rows, so a refusal with the whole preset present is drawn as what it is.
 */
function needsOf(model, mk, tid, fifo) {
  const { inputs, outputs, tests } = arcsOf(model, tid);
  const rows = inputs.map((a) => ({ kind: 'take', place: a.from, need: wt(a), have: mk[a.from] ?? 0, tokens: (fifo.get(a.from) || []).slice(0, wt(a)) }));
  for (const a of tests) {
    if (a.type === 'read') rows.push({ kind: 'read', place: a.from, need: wt(a), have: mk[a.from] ?? 0, tokens: (fifo.get(a.from) || []).slice(0, wt(a)) });
    else rows.push({ kind: 'inhibitor', place: a.from, need: wt(a), have: mk[a.from] ?? 0, tokens: [] });
  }
  const out = rows.map((r) => ({ ...r, ok: r.kind === 'inhibitor' ? r.have < r.need : r.have >= r.need }));
  const net = {};
  for (const a of inputs) net[a.from] = (net[a.from] ?? 0) - wt(a);
  for (const a of outputs) net[a.to] = (net[a.to] ?? 0) + wt(a);
  for (const p of model.places) {
    if (!(p.capacity > 0) || (p.kind || 'token') !== 'token') continue;
    const delta = net[p.id];
    if (delta === undefined || delta <= 0) continue;
    const have = mk[p.id] ?? 0;
    out.push({ kind: 'capacity', place: p.id, need: p.capacity, have, delta, after: have + delta, tokens: [], ok: have + delta <= p.capacity });
  }
  return out;
}

/** Why a stop happened, in the drawing's terms: a missing preset token, or a side condition with no wire. */
function stopKind(stop) {
  const failed = stop.needs.filter((n) => !n.ok);
  if (!stop.tid) return { domainOk: false, side: null, failed };
  if (failed.some((n) => n.kind === 'take')) return { domainOk: false, side: null, failed };
  const side = failed.find((n) => n.kind === 'read') ? 'a read arc' : failed.find((n) => n.kind === 'inhibitor') ? 'an inhibitor arc' : failed.find((n) => n.kind === 'capacity') ? 'a capacity bound' : 'a rule this drawing does not model';
  return { domainOk: true, side, failed };
}
/** Tokens on places the run never touches (and a refused step does not name): identity wires. */
function idleTokens(proc) {
  const touched = new Set();
  for (const b of proc.boxes) for (const t of [...b.ins, ...b.outs, ...b.reads]) touched.add(t.place);
  if (proc.stop) for (const row of proc.stop.needs) touched.add(row.place);
  return new Set(proc.tokens.filter((t) => !touched.has(t.place)).map((t) => t.id));
}

/** The idle toggle: a count, and disabled when there is nothing to show. */
function idleToggle(ctx, n, title) {
  return ctx.el('label', { class: `pv-proc-toggle${n ? '' : ' off'}`, title: n ? title : 'This run touches every marked place: there are no idle tokens.' },
    ctx.el('input', { type: 'checkbox', 'data-idle': '1', checked: (ui.idle && n) || null, disabled: n ? null : true, onchange: (e) => { ui.idle = e.target.checked; rerender(); } }),
    `idle tokens as identity wires (${n})`);
}

/** Steps k > 1 that use no token step k-1 gave, and take no token step k-1 read: neighbours on disjoint wires. */
function independentSteps(proc) {
  return proc.boxes.slice(1).filter((b, i) => {
    const prev = proc.boxes[i];
    return ![...b.ins, ...b.reads].some((t) => t.born === prev.k) && !b.ins.some((t) => prev.reads.includes(t));
  }).map((b) => b.k);
}

/** The text after the place name in a refused step's row. */
function rowTail(r) {
  if (r.kind === 'inhibitor') return `needs < ${r.need}, has ${r.have}`;
  if (r.kind === 'read') return `reads ${r.need}, has ${r.have}`;
  if (r.kind === 'capacity') return `gives ${r.delta}: ${r.have}→${r.after}, cap ${r.need}`;
  return `takes ${r.need}, has ${r.have}`;
}
const SIDE_WHY = {
  'a read arc': 'a read arc tests a place without moving it, and read arcs are outside the free-SMC fragment (ROADMAP Phase 6)',
  'an inhibitor arc': 'an inhibitor arc tests for absence, which no wire can show, and is outside the free-SMC fragment (ROADMAP Phase 6)',
  'a capacity bound': 'capacity is go-pflow\'s post-firing bound on the places a firing raises (firing.go:172-194), not part of the box\'s domain',
};

// --- lane layout ------------------------------------------------------------------------
// The wires alive between two events form an ordered list. Before a box, the
// list is permuted so the box's inputs are contiguous (the wires between them
// move out to the nearer side); the box then replaces them with its outputs.
// Several deterministic starting orders and output orders are tried and the
// one with the fewest crossings wins (ties: least movement, then the first tried).

function inversions(a, b) {
  const pos = new Map(b.map((id, i) => [id, i]));
  const seq = a.map((id) => pos.get(id));
  let n = 0;
  for (let i = 0; i < seq.length; i++) for (let j = i + 1; j < seq.length; j++) if (seq[i] > seq[j]) n++;
  return n;
}
function movement(a, b) {
  const pos = new Map(b.map((id, i) => [id, i]));
  return a.reduce((s, id, i) => s + Math.abs(pos.get(id) - i), 0);
}
function gather(cur, I) {
  const idx = [];
  cur.forEach((id, i) => { if (I.has(id)) idx.push(i); });
  if (!idx.length) return { list: cur.slice(), p: cur.length };
  const lo = idx[0], hi = idx[idx.length - 1], med = idx[(idx.length - 1) >> 1];
  const up = [], ins = [], down = [];
  for (let i = lo; i <= hi; i++) { const id = cur[i]; if (I.has(id)) ins.push(id); else (i < med ? up : down).push(id); }
  return { list: [...cur.slice(0, lo), ...up, ...ins, ...down, ...cur.slice(hi + 1)], p: lo + up.length };
}
function orderOutputs(proc, outs, list, p, k, policy) {
  const pos = new Map(list.map((id, i) => [id, i]));
  const mid = p + (k - 1) / 2;
  const key = (t) => {
    if (t.died === null) return policy === 'top' ? -1e9 : policy === 'bottom' ? 1e9 : mid;
    const box = proc.boxes[t.died - 1];
    const others = [...box.ins, ...box.reads].filter((u) => u !== t && pos.has(u.id));
    if (!others.length) return mid;
    return others.reduce((s, u) => s + pos.get(u.id), 0) / others.length;
  };
  return outs.map((t, i) => ({ t, key: key(t), i }))
    .sort((a, b) => a.key - b.key || (a.t.died ?? 1e9) - (b.t.died ?? 1e9) || a.i - b.i)
    .map((x) => x.t);
}
function simulate(proc, vis, init, policies, minLanes, ghostIds) {
  const N = proc.boxes.length;
  const A = [init], B = [], blocks = [null];
  let cur = init, cross = 0, move = 0;
  for (let e = 1; e <= N; e++) {
    const box = proc.boxes[e - 1];
    const I = new Set([...box.ins, ...box.reads].filter((t) => vis.has(t.id)).map((t) => t.id));
    const { list, p } = gather(cur, I);
    cross += inversions(cur, list); move += movement(cur, list);
    B[e - 1] = list;
    const inBlock = list.slice(p, p + I.size);
    const readIds = new Set(box.reads.map((t) => t.id));
    const outs = orderOutputs(proc, box.outs.filter((t) => vis.has(t.id)), list, p, I.size, policies[(e - 1) % policies.length]);
    // a read token keeps its place in the block, so it passes the box on one lane
    const outBlock = outs.map((t) => t.id);
    inBlock.forEach((id, i) => { if (readIds.has(id)) outBlock.splice(Math.min(i, outBlock.length), 0, id); });
    const H = Math.max(inBlock.length, outBlock.length, minLanes[e] || 1, 1);
    blocks[e] = { p, H, inBlock, outBlock };
    cur = [...list.slice(0, p), ...outBlock, ...list.slice(p + I.size)];
    A[e] = cur;
  }
  let ghost = null;
  if (ghostIds && ghostIds.size) {
    const { list, p } = gather(cur, ghostIds);
    cross += inversions(cur, list); move += movement(cur, list);
    B[N] = list;
    ghost = { p, size: [...ghostIds].filter((id) => list.includes(id)).length };
  } else B[N] = cur;
  return { A, B, blocks, cross, move, ghost };
}

/** Lane y positions of a list with (optionally) one block that takes H lanes. */
function laneYs(list, block, top) {
  const y = new Map();
  let lane = 0, i = 0;
  while (i < list.length) {
    if (block && i === block.p && block.size > 0) {
      const off = (block.H - block.size) / 2;
      for (let j = 0; j < block.size; j++) y.set(list[i + j], top + (lane + off + j) * LANE + LANE / 2);
      lane += block.H; i += block.size;
      continue;
    }
    if (block && i === block.p && block.size === 0) lane += block.H;
    y.set(list[i], top + lane * LANE + LANE / 2);
    lane++; i++;
  }
  if (block && block.p >= list.length && block.size === 0) lane += block.H;
  return { y, lanes: lane };
}

export function chooseLayout(proc, vis, idleIds, groupOf, placeIx, minLanes, ghostIds) {
  const touched = proc.tokens.filter((t) => t.born === 0 && vis.has(t.id) && !idleIds.has(t.id));
  const idle = proc.tokens.filter((t) => t.born === 0 && vis.has(t.id) && idleIds.has(t.id)).sort((a, b) => placeIx(a) - placeIx(b) || a.n - b.n);
  const first = (t) => t.died ?? 1e9;
  const inits = [
    (a, b) => first(a) - first(b) || placeIx(a) - placeIx(b) || a.n - b.n,
    (a, b) => (a.died ?? -1) - (b.died ?? -1) || placeIx(a) - placeIx(b) || a.n - b.n,
    (a, b) => groupOf(a) - groupOf(b) || first(a) - first(b) || placeIx(a) - placeIx(b) || a.n - b.n,
    (a, b) => placeIx(a) - placeIx(b) || a.n - b.n,
  ];
  // Where a box puts the outputs that survive to the codomain: per box when
  // there are few boxes (3^N combinations), else one rule for all.
  const N = proc.boxes.length;
  const P = ['top', 'bottom', 'mid'];
  let combos = [[]];
  if (N <= 5) for (let i = 0; i < N; i++) combos = combos.flatMap((c) => P.map((x) => [...c, x]));
  else combos = P.map((x) => [x]);
  if (!N) combos = [['mid']];
  let best = null;
  for (const cmp of inits) {
    const init = [...touched].sort(cmp).concat(idle).map((t) => t.id);
    for (const policies of combos) {
      const r = simulate(proc, vis, init, policies, minLanes, ghostIds);
      const score = r.cross * 100 + r.move;
      if (!best || score < best.score) best = { ...r, score };
    }
  }
  return best;
}

// --- small drawing helpers ---------------------------------------------------------------

const tw = (s, size) => String(s).length * size * 0.58; // dom.js textWidth: safe for spacing
const twFit = (s, size) => String(s).length * size * 0.56; // closer to the rendered sans, for fitting labels into gaps
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function splitPlace(id) {
  const i = id.lastIndexOf('/');
  return i < 0 ? { pre: '', local: id } : { pre: id.slice(0, i + 1), local: id.slice(i + 1) };
}

/** A polyline with rounded corners (radius r, shortened where segments are short). */
function roundedPath(pts, r) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [x, y] = pts[i], [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(x - px, y - py), l2 = Math.hypot(nx - x, ny - y);
    if (!l1 || !l2) continue;
    const k = Math.min(r, l1 / 2, l2 / 2);
    d += ` L${x - ((x - px) / l1) * k},${y - ((y - py) / l1) * k} Q${x},${y} ${x + ((nx - x) / l2) * k},${y + ((ny - y) / l2) * k}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L${lx},${ly}`;
}

function wrap(text, maxChars) {
  // break long tokens (flat names) after '+' or '/', never inside a word
  const words = String(text).split(/\s+/).filter(Boolean).flatMap((w) => {
    if (w.length <= maxChars) return [w];
    const parts = w.split(/(?<=[+/])/);
    const out = [];
    let cur = '';
    for (const p of parts) { if (cur && (cur + p).length > maxChars) { out.push(cur); cur = p; } else cur += p; }
    if (cur) out.push(cur);
    return out;
  });
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.flatMap((l) => (l.length <= maxChars ? [l] : l.match(new RegExp(`.{1,${maxChars}}`, 'g'))));
}

const STYLE = `
.pv-proc-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 6px; }
.pv-proc-bar .lbl { color: var(--muted); font-size: 12px; margin-right: 2px; }
.pv-proc-chip { font: inherit; font-size: 12px; border: 1px solid var(--line); background: #fff; border-radius: 999px; padding: 3px 10px 3px 8px; cursor: pointer; display: inline-flex; gap: 6px; align-items: center; color: var(--ink); }
.pv-proc-chip:hover { border-color: #b9c0c9; }
.pv-proc-chip.active { background: var(--ink); color: #fff; border-color: var(--ink); }
.pv-proc-chip b { font-weight: 600; }
.pv-proc-chip .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dc); flex: none; }
.pv-proc-chip .res { font-size: 10.5px; opacity: 0.75; }
.pv-proc-toggle { margin-left: auto; font-size: 12px; color: var(--muted); display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.pv-proc-toggle.off { opacity: 0.55; cursor: default; }
.pv-proc-sub { font-size: 11.5px; color: var(--muted); margin: 0 0 8px; }
.pv-proc-sub b { color: var(--ink); font-weight: 600; }
.view-svg .pv-halo { paint-order: stroke; stroke: ${PAPER}; stroke-width: 3.5px; stroke-linejoin: round; }
.view-svg .pv-wire .hit { stroke: transparent; fill: none; stroke-width: 12; pointer-events: stroke; }
.view-svg .pv-wire:hover .line { stroke-width: 3.6; }
.view-svg .pv-wire:hover .case { stroke-width: 6; }
.view-svg .pv-box { transform-box: fill-box; transform-origin: center; }
.view-svg .pv-box:hover .outer { stroke-width: 2.4; }
.view-svg .pv-ghost:hover .outer { stroke-width: 2; }
.view-svg .pv-port .hit { fill: transparent; }
.view-svg .pv-port:hover .glyph { stroke-width: 2.4; }
.view-svg .pv-port { transform-box: fill-box; transform-origin: center; }
.view-svg .pv-arc:hover .line { stroke-width: 3.4; }
.view-svg .pv-arc .hit { stroke: transparent; fill: none; stroke-width: 12; pointer-events: stroke; }
.view-svg .pv-pred:hover text { text-decoration: underline; }
.view-svg .pv-boundary:hover line { stroke-width: 2.4; }
`;

// --- the shared process drawing -----------------------------------------------------------
//
// spec = {
//   model, proc, steps, vis (Set of token ids drawn), idle (Set: identity wires),
//   colorOf(place), fusedPlace(place) -> bool, groupOf(token) -> number,
//   boxLines(box) -> [{text, color}], header(box) -> [[{text, color, size, weight}]],
//   fused(box) -> bool, boxInfo(box), wireInfo(token), ghostInfo(stop),
//   marks: Map tokenId -> {color, under, note} (leak / return highlights),
//   rightExtra: width reserved right of the codomain labels (connect-4 board),
//   captionR: text under "codomain",
// }
// Returns { g, bottom, anim, boxesByTid, wiresByPlace, xL, xR, lanesTop, gapCenter(e), rightEdge }.

function drawProcess(ctx, spec, top) {
  const S = ctx.svg;
  const { proc, vis, idle, model } = spec;
  const N = proc.boxes.length;
  const tok = (id) => proc.tokens[id];
  const placeIndex = new Map(model.places.map((p, i) => [p.id, i]));
  const pix = (t) => placeIndex.get(t.place) ?? 0;
  const many = (t) => (proc.serial.get(t.place) || 0) > 1;

  // ghost: the refused next box, drawn past the codomain
  const stop = proc.stop;
  const ghostIds = new Set(stop ? stop.needs.flatMap((r) => r.tokens.filter((t) => vis.has(t.id)).map((t) => t.id)) : []);

  const minLanes = [0, ...proc.boxes.map((b) => Math.ceil((spec.boxLines(b).length * 12 + 10) / LANE))];
  const lay = chooseLayout(proc, vis, idle, spec.groupOf, pix, minLanes, ghostIds);

  // --- horizontal
  const labelW = (t, size = 10.5) => { const { pre, local } = splitPlace(t.place); return twFit(pre, size - 1.5) + twFit(local, size) + (many(t) ? twFit(` #${t.n}`, size - 1.5) : 0); };
  const initials = lay.A[0].map(tok);
  const finals = lay.B[N].map(tok);
  const markW = (t) => { const m = spec.marks.get(t.id); return m && m.tag ? tw(m.tag, 9) : 0; };
  const leftW = Math.max(70, ...initials.map((t) => labelW(t))) + 16;
  const rightW = Math.max(70, ...finals.map((t) => Math.max(labelW(t), markW(t)))) + 16;
  const ghostW = stop ? clamp(Math.max(0, ...stop.needs.map((r) => { const { pre, local } = splitPlace(r.place); return 22 + twFit('✓ ', 10) + twFit(pre, 8.5) + twFit(local, 10) + twFit(`  ${rowTail(r)}`, 10) + 10; })), 258, 330) : 0;
  const extraW = spec.rightExtra || 0;
  const reserved = (ghostW ? ghostW + 36 : 0) + (extraW ? extraW + 20 : 0);
  const avail = W - 2 * PAD - leftW - rightW - reserved;
  // each box as wide as its own longest member name
  const bw = [0, ...proc.boxes.map((b) => clamp(Math.max(0, ...spec.boxLines(b).map((l) => tw(l.text, 9.5))) + 12, 56, 170))];
  // each gap is as wide as the labels of the wires born at its left edge need,
  // then the room left over is shared out (up to a comfortable width)
  const midLabelW = (t) => twFit(splitPlace(t.place).local + (many(t) ? ` #${t.n}` : ''), 9);
  const need = [];
  for (let e = 0; e <= N; e++) {
    const born = proc.tokens.filter((t) => vis.has(t.id) && t.born === e && e > 0 && t.died !== null);
    need.push(Math.max(e === 0 || e === N ? 44 : 56, ...born.map((t) => midLabelW(t) + 14)));
  }
  let gaps = need.slice();
  const fixed = bw.reduce((a, b) => a + b, 0);
  const sumNeed = gaps.reduce((a, b) => a + b, 0);
  if (!N) gaps = [clamp(avail, 120, 220)];
  else if (fixed + sumNeed > avail) gaps = gaps.map((x) => (x * (avail - fixed)) / sumNeed);
  else {
    const target = Math.min(avail, fixed + (N + 1) * 150);
    let extra = target - fixed - sumNeed;
    // raise the narrowest gaps first, so the columns even out
    while (extra > 0.5) {
      const lo = Math.min(...gaps);
      const at = gaps.map((x, i) => (x <= lo + 0.01 ? i : -1)).filter((i) => i >= 0);
      const next = Math.min(...gaps.filter((x) => x > lo + 0.01), Infinity);
      const step = Math.min(extra / at.length, next - lo);
      for (const i of at) gaps[i] += step;
      extra -= step * at.length;
    }
  }
  const span = fixed + gaps.reduce((a, b) => a + b, 0);
  const slack = Math.max(0, avail - span);
  const xL = PAD + leftW + slack / 2;
  const xs = [xL];
  for (let e = 1; e <= N; e++) xs.push(xs[e - 1] + bw[e - 1] + gaps[e - 1]);
  const xR = N ? xs[N] + bw[N] + gaps[N] : xL + gaps[0];
  const cx = (e) => xs[e] + bw[e] / 2;
  const xLeft = (e) => (e === N + 1 ? xR : xs[e]);
  const xRight = (e) => (e === 0 ? xL : xs[e] + bw[e]);

  // --- vertical
  const headers = proc.boxes.map((b) => spec.header(b));
  const headerH = Math.max(28, ...headers.map((h) => 14 + h.length * 12));
  const headerTop = top;
  const lanesTop = headerTop + headerH + 16;
  const ysA = lay.A.map((list, e) => laneYs(list, e >= 1 ? { p: lay.blocks[e].p, H: lay.blocks[e].H, size: lay.blocks[e].outBlock.length } : null, lanesTop));
  const ysB = lay.B.map((list, e) => laneYs(list, e + 1 <= N ? { p: lay.blocks[e + 1].p, H: lay.blocks[e + 1].H, size: lay.blocks[e + 1].inBlock.length } : null, lanesTop));
  let lanes = Math.max(1, ...ysA.map((r) => r.lanes), ...ysB.map((r) => r.lanes));

  const g = S('g', { class: 'pv-process' });
  const gGuide = S('g', {}), gUnder = S('g', {}), gWires = S('g', {}), gBoxes = S('g', {}), gLabels = S('g', {}), gTop = S('g', {});
  g.append(gGuide, gUnder, gWires, gBoxes, gLabels, gTop);
  const anim = { wires: [], boxes: [], xL, xR };
  const boxesByTid = new Map(), wiresByPlace = new Map();

  // --- ghost geometry first (it may need more height than the lanes)
  let ghost = null;
  if (stop) {
    const gx = xR + rightW + 28;
    const chars = Math.floor((ghostW - 20) / (10 * 0.58));
    const nameLines = spec.ghostHeader(stop);
    const whyLines = wrap(stop.why, chars);
    const rows = stop.needs;
    const rowsAt = 30 + nameLines.length * 12 + 6 + 12 + whyLines.length * 12 + 8 + 14; // first row, from the top
    const h = rowsAt + (rows.length - 1) * 16 + 14;
    const present = [...ghostIds].map((id) => ysB[N].y.get(id)).filter((y) => y !== undefined);
    const mid = present.length ? present.reduce((s, y) => s + y, 0) / present.length : lanesTop + (lanes * LANE) / 2;
    // the input rows face the wires they plug into; the text sits above them
    const gy = Math.max(lanesTop - 24, mid - rowsAt - ((rows.length - 1) * 16) / 2);
    lanes = Math.max(lanes, Math.ceil((gy + h - lanesTop) / LANE));
    ghost = { gx, gy, h, nameLines, whyLines, rows };
  }
  const lanesBottom = lanesTop + lanes * LANE;

  // --- boundaries
  const boundary = (x, caption, sub, info, anchor) => {
    const bg = S('g', { class: 'pv-boundary' },
      S('line', { x1: x, y1: lanesTop - 6, x2: x, y2: lanesBottom + 2, stroke: INK, 'stroke-width': 1.5 }),
      S('line', { x1: x, y1: lanesTop - 6, x2: x, y2: lanesBottom + 2, stroke: 'transparent', 'stroke-width': 12 }),
      S('text', { x: anchor === 'end' ? x + 4 : x - 4, y: lanesTop - 26, 'text-anchor': anchor, 'font-size': 11, 'font-weight': 600, fill: INK }, caption),
      S('text', { x: anchor === 'end' ? x + 4 : x - 4, y: lanesTop - 13, 'text-anchor': anchor, 'font-size': 10, fill: MUTED }, sub));
    ctx.hover(bg, info);
    gTop.append(bg);
  };
  boundary(xL, 'domain', 'initial marking', spec.boundaryInfo('domain', proc.initial, initials), 'end');
  boundary(xR, 'codomain', spec.captionR || 'final marking', spec.boundaryInfo('codomain', proc.final, finals), 'start');

  // --- step headers and guides
  proc.boxes.forEach((b, i) => {
    const e = i + 1, x = cx(e);
    const hg = S('g', {});
    hg.append(S('text', { x, y: headerTop + 10, 'text-anchor': 'middle', 'font-size': 10, fill: MUTED, 'letter-spacing': '0.04em' }, `STEP ${b.k}`));
    headers[i].forEach((line, j) => hg.append(S('text', { x, y: headerTop + 24 + j * 12, 'text-anchor': 'middle', 'font-size': 10 }, ...line.map((sp) => S('tspan', { fill: sp.color || INK, 'font-weight': sp.weight || 400, 'font-size': sp.size || 10 }, sp.text)))));
    ctx.hover(hg, spec.boxInfo(b));
    gLabels.append(hg);
    const blk = lay.blocks[e];
    gGuide.append(S('line', { x1: x, y1: headerTop + headerH + 2, x2: x, y2: lanesTop + blk.p * LANE - 6, stroke: '#d5dae0', 'stroke-width': 1, 'stroke-dasharray': '2 3' }));
  });

  // --- wires
  const yA = (e, id) => ysA[e].y.get(id);
  const yB = (e, id) => ysB[e].y.get(id);
  const wirePath = (t) => {
    const a = t.born, b = t.died ?? N + 1;
    let d = `M${xRight(a)},${yA(a, t.id)}`;
    for (let gI = a; gI < b; gI++) {
      const x0 = xRight(gI), y0 = yA(gI, t.id), x1 = xLeft(gI + 1), y1 = yB(gI, t.id);
      if (Math.abs(y0 - y1) < 0.5) d += ` L${x1},${y1}`;
      else {
        const s0 = x0 + 6, s1 = x1 - 6, m = (s1 - s0) / 2;
        d += ` L${s0},${y0} C${s0 + m},${y0} ${s1 - m},${y1} ${s1},${y1} L${x1},${y1}`;
      }
      if (gI + 1 < b) {
        const y2 = yA(gI + 1, t.id);
        // beside the box: the same lane; through it (a read arc): behind the box
        d += Math.abs(y2 - y1) < 0.5 ? ` L${xRight(gI + 1)},${y1}` : ` L${cx(gI + 1)},${y1} L${cx(gI + 1)},${y2} L${xRight(gI + 1)},${y2}`;
      }
    }
    return d;
  };
  const drawn = proc.tokens.filter((t) => vis.has(t.id));
  for (const t of drawn) {
    const d = wirePath(t);
    const color = spec.colorOf(t.place);
    const isIdle = idle.has(t.id);
    const mark = spec.marks.get(t.id);
    const wg = S('g', { class: 'pv-wire', 'data-token': `${t.place}#${t.n}` });
    if (mark && mark.under) {
      const u = S('path', { d, fill: 'none', stroke: mark.color, 'stroke-width': 10, 'stroke-opacity': 0.16, 'stroke-linecap': 'round' });
      gUnder.append(u);
      anim.wires.push({ el: u, x0: xRight(t.born), x1: xLeft(t.died ?? N + 1) });
    }
    const stroke = mark && mark.color ? mark.color : color;
    if (spec.fusedPlace(t.place)) {
      const c = S('path', { class: 'case', d, fill: 'none', stroke, 'stroke-width': 4.6 });
      const l = S('path', { class: 'line', d, fill: 'none', stroke: PAPER, 'stroke-width': 1.5 });
      wg.append(c, l);
      anim.wires.push({ el: c, x0: xRight(t.born), x1: xLeft(t.died ?? N + 1) });
    } else {
      const l = S('path', { class: 'line', d, fill: 'none', stroke, 'stroke-width': isIdle ? 1.3 : mark ? 2.6 : 2, 'stroke-dasharray': isIdle ? '4 3' : null, 'stroke-opacity': isIdle ? 0.75 : 1 });
      wg.append(l);
      anim.wires.push({ el: l, x0: xRight(t.born), x1: xLeft(t.died ?? N + 1) });
    }
    wg.append(S('path', { class: 'hit', d }));
    ctx.hover(wg, spec.wireInfo(t));
    gWires.append(wg);
    if (!wiresByPlace.has(t.place)) wiresByPlace.set(t.place, []);
    wiresByPlace.get(t.place).push(wg);
  }

  // --- wire labels: domain, codomain, and in between for wires born and consumed inside
  const label = (x, y, t, anchor, size = 10.5, maxW = Infinity, local0 = false) => {
    const { pre: pre0, local } = splitPlace(t.place);
    const pre = local0 ? '' : pre0;
    const mark = spec.marks.get(t.id);
    const color = mark && mark.color ? mark.color : spec.colorOf(t.place);
    let shownLocal = local, shownPre = pre;
    if (twFit(pre, size - 1.5) + twFit(local, size) > maxW) { shownPre = ''; if (twFit(local, size) > maxW) shownLocal = local.slice(0, Math.max(3, Math.floor(maxW / (size * 0.56)) - 1)) + '…'; }
    const txt = S('text', { x, y, 'text-anchor': anchor, 'font-size': size, class: 'pv-halo', 'dominant-baseline': 'middle' },
      shownPre ? S('tspan', { fill: MUTED, 'font-size': size - 1.5 }, shownPre) : null,
      S('tspan', { fill: color, 'font-weight': mark ? 700 : 500 }, shownLocal),
      many(t) ? S('tspan', { fill: MUTED, 'font-size': size - 1.5 }, ` #${t.n}`) : null);
    gLabels.append(txt);
    return txt;
  };
  for (const t of initials) label(xL - 8, yA(0, t.id), t, 'end');
  const rLabelEnd = new Map();
  for (const t of finals) {
    const y = yB(N, t.id);
    label(xR + 8, y, t, 'start');
    rLabelEnd.set(t.id, xR + 8 + labelW(t) + 4);
    const mark = spec.marks.get(t.id);
    if (mark && mark.tag) gLabels.append(S('text', { x: xR + 8, y: y + 11, 'font-size': 9, 'font-style': 'italic', fill: mark.tagColor || mark.color, class: 'pv-halo', 'dominant-baseline': 'middle' }, mark.tag));
  }
  for (const t of drawn) {
    if (t.born === 0 || t.died === null) continue;
    const gapW = xLeft(t.born + 1) - xRight(t.born);
    label(xRight(t.born) + 5, yA(t.born, t.id) - 7, t, 'start', 9, gapW - 8, true);
  }

  // --- boxes
  proc.boxes.forEach((b, i) => {
    const e = i + 1, blk = lay.blocks[e];
    const BW = bw[e];
    const x = cx(e) - BW / 2, y = lanesTop + blk.p * LANE + 3, h = blk.H * LANE - 6;
    const fused = spec.fused(b);
    const bg = S('g', { class: 'pv-box', 'data-box': b.tid, 'data-step': b.k });
    bg.append(S('rect', { class: 'outer', x, y, width: BW, height: h, rx: 6, fill: '#fff', stroke: INK, 'stroke-width': 1.5 }));
    if (fused) bg.append(S('rect', { class: 'inner', x: x + 3, y: y + 3, width: BW - 6, height: h - 6, rx: 4, fill: 'none', stroke: INK, 'stroke-width': 1 }));
    const lines = spec.boxLines(b);
    const ly0 = y + h / 2 - ((lines.length - 1) * 12) / 2;
    const textEls = lines.map((ln, j) => {
      const tEl = S('text', { x: x + BW / 2, y: ly0 + j * 12, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 9.5, 'font-weight': 600, fill: ln.color || INK }, ln.text);
      bg.append(tEl);
      return tEl;
    });
    // step tab: centred on the top edge, or on the corner when the box is one lane (clear of its label)
    const tabX = h < 30 ? x + 1 : x + BW / 2;
    bg.append(S('circle', { cx: tabX, cy: y, r: 7.5, fill: INK }), S('text', { x: tabX, y: y + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#fff' }, b.k));
    // contact dots
    for (const id of blk.inBlock) { const t = tok(id); if (vis.has(id)) bg.append(S('circle', { cx: xLeft(e), cy: yB(e - 1, id), r: 2.4, fill: (spec.marks.get(id) || {}).color || spec.colorOf(t.place) })); }
    for (const id of blk.outBlock) { const t = tok(id); bg.append(S('circle', { cx: xRight(e), cy: yA(e, id), r: 2.4, fill: (spec.marks.get(id) || {}).color || spec.colorOf(t.place) })); }
    for (const t of b.reads.filter((r) => vis.has(r.id))) {
      for (const [xx, yy] of [[xLeft(e), yB(e - 1, t.id)], [xRight(e), yA(e, t.id)]]) bg.append(S('path', { d: `M${xx - 4.5},${yy} l4.5,-4.5 l4.5,4.5 l-4.5,4.5 z`, fill: '#fff', stroke: spec.colorOf(t.place), 'stroke-width': 1.3 }));
    }
    ctx.hover(bg, spec.boxInfo(b));
    gBoxes.append(bg);
    anim.boxes.push({ el: bg, x: cx(e) });
    boxesByTid.set(b.tid, { g: bg, inner: bg.querySelector('.inner'), lines: textEls, x: cx(e), y: y + h / 2 });
  });

  // --- the refused next box, past the codomain: its domain is not in the codomain
  if (ghost) {
    const { gx, gy, h, nameLines, whyLines, rows } = ghost;
    const gg = S('g', { class: 'pv-ghost', 'data-ghost': stop.tid || stop.step.member });
    gg.append(S('rect', { class: 'outer', x: gx, y: gy, width: ghostW, height: h, rx: 6, fill: '#fff7f6', stroke: LEAK, 'stroke-width': 1.4, 'stroke-dasharray': '5 3' }));
    let y = gy + 16;
    gg.append(S('text', { x: gx + 10, y, 'font-size': 10.5, 'font-weight': 700, fill: LEAK }, `✗ step ${stop.index + 1} does not fire`));
    y += 14;
    for (const line of nameLines) { gg.append(S('text', { x: gx + 10, y, 'font-size': 10 }, ...line.map((sp) => S('tspan', { fill: sp.color || INK, 'font-weight': sp.weight || 400, 'font-size': sp.size || 10 }, sp.text)))); y += 12; }
    y += 6;
    gg.append(S('text', { x: gx + 10, y, 'font-size': 9.5, fill: MUTED }, 'go-pflow EnabledWhyNot:')); y += 12;
    for (const line of whyLines) { gg.append(S('text', { x: gx + 10, y, 'font-size': 10, fill: INK, 'font-style': 'italic' }, line)); y += 12; }
    y += 8;
    gg.append(S('text', { x: gx + 10, y, 'font-size': 9.5, fill: MUTED }, rows.some((r) => r.kind === 'capacity') ? 'its domain and bounds, against the codomain:' : 'its domain, against the codomain:')); y += 14;
    for (const r of rows) {
      const { pre, local } = splitPlace(r.place);
      const ok = r.ok;
      const verb = rowTail(r);
      gg.append(S('text', { x: gx + 22, y, 'font-size': 10, 'dominant-baseline': 'middle' },
        S('tspan', { fill: ok ? BACK : LEAK, 'font-weight': 700 }, ok ? '✓ ' : '✗ '),
        S('tspan', { fill: MUTED, 'font-size': 8.5 }, pre),
        S('tspan', { fill: spec.colorOf(r.place), 'font-weight': 600 }, local),
        S('tspan', { fill: MUTED }, `  ${verb}`)));
      // the stub on the box edge (a bound on a place it gives to: the right edge), and a dashed plug back to the wire at the codomain
      gg.append(S('circle', { cx: r.kind === 'capacity' ? gx + ghostW : gx, cy: y, r: 3.5, fill: ok ? spec.colorOf(r.place) : '#fff', stroke: ok ? spec.colorOf(r.place) : LEAK, 'stroke-width': 1.5 }));
      for (const t of r.tokens) {
        if (!vis.has(t.id)) continue;
        const y0 = yB(N, t.id), x0 = rLabelEnd.get(t.id);
        if (y0 === undefined || x0 === undefined) continue;
        const m = (gx - x0) / 2;
        gUnder.append(S('path', { d: `M${x0},${y0} C${x0 + m},${y0} ${gx - m},${y} ${gx - 4},${y}`, fill: 'none', stroke: spec.colorOf(t.place), 'stroke-width': 1.2, 'stroke-dasharray': '3 3', 'stroke-opacity': 0.8 }));
      }
      y += 16;
    }
    ctx.hover(gg, spec.ghostInfo(stop));
    gTop.append(gg);
  }

  // --- time axis
  const ay = lanesBottom + 14;
  gGuide.append(S('line', { x1: xL, y1: ay, x2: xR - 6, y2: ay, stroke: '#b9c0c9', 'stroke-width': 1 }),
    S('path', { d: `M${xR - 7},${ay - 3.5} L${xR},${ay} L${xR - 7},${ay + 3.5} z`, fill: '#b9c0c9' }),
    S('text', { x: (xL + xR) / 2, y: ay + 13, 'text-anchor': 'middle', 'font-size': 9.5, fill: MUTED }, N ? `time →   ${N} firing${N === 1 ? '' : 's'}, composed in sequence (∘); wires side by side are the tensor (⊗)` : 'no firing: the identity on the initial marking'));

  return { g, bottom: ay + 22, anim, boxesByTid, wiresByPlace, xL, xR, lanesTop, gapCenter: (e) => (xRight(e) + xLeft(e + 1)) / 2, rightEdge: xR + rightW };
}

// --- animations (Web Animations API) --------------------------------------------------------

function playReplay(anim, skip = new Set()) {
  const D = 850, span = Math.max(1, anim.xR - anim.xL);
  for (const w of anim.wires) {
    let len = 0;
    try { len = w.el.getTotalLength(); } catch { continue; }
    if (!len) continue;
    const delay = D * clamp((w.x0 - anim.xL) / span, 0, 1);
    const dur = Math.max(140, (D * (Math.min(w.x1, anim.xR) - w.x0)) / span);
    w.el.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }], { duration: dur, delay, easing: 'linear', fill: 'backwards' });
  }
  for (const b of anim.boxes) {
    if (skip.has(b.el)) continue;
    const delay = Math.max(0, (D * (b.x - anim.xL)) / span - 80);
    b.el.animate([{ opacity: 0, transform: 'scale(0.8)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 280, delay, easing: 'cubic-bezier(.2,.9,.3,1.3)', fill: 'backwards' });
  }
}

function playFuse(drawnBox, color) {
  if (!drawnBox) return;
  const { g, inner, lines } = drawnBox;
  const n = lines.length;
  // the members start apart (each where its own subnet would draw it) and meet in one box
  lines.forEach((t, j) => {
    const dy = (j - (n - 1) / 2) * 26;
    t.animate([{ transform: `translateY(${dy}px)`, opacity: 0.4 }, { transform: `translateY(${dy}px)`, opacity: 0.6, offset: 0.15 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 850, easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' });
  });
  if (inner) {
    let len = 0;
    try { len = inner.getTotalLength(); } catch { len = 0; }
    if (len) inner.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len, stroke: color, strokeWidth: 2.2 }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0, stroke: INK, strokeWidth: 1 }], { duration: 850, easing: 'ease-in-out', fill: 'backwards' });
  }
  const outer = g.querySelector('.outer');
  if (outer) outer.animate([{ stroke: color, strokeWidth: 4 }, { stroke: INK, strokeWidth: 1.5 }], { duration: 900, easing: 'ease-out' });
}

// --- orders -------------------------------------------------------------------------------

const HUES = { queue: ['#2f6fb3', '#1d4f86', '#5a8fca'], 'resource-pool': ['#c47a12', '#8f5a0c', '#d9963a'], saga: ['#7b4cc2', '#56338f', '#9b72d8'] };

function subnetColors(subnets) {
  const out = {};
  const seen = {};
  for (const s of subnets) {
    const i = seen[s.pattern] = (seen[s.pattern] ?? -1) + 1;
    out[s.id] = (HUES[s.pattern] || ['#555'])[i % 3];
  }
  return out;
}

function memberSubnet(m) { return m.slice(0, m.indexOf('/')); }


function renderOrders(ctx) {
  const S = ctx.svg;
  const { subnets, byId, links, flat, scenarios } = ctx.orders;
  const colors = subnetColors(subnets);
  const notes = [];

  const sc = scenarios.find((s) => s.id === ui.scenario) || scenarios.find((s) => s.id === 'refund') || scenarios[0];
  ui.scenario = sc.id;

  // every scenario's outcome on the current composite, for the chips
  const runOf = (s) => {
    if (!flat.ok) return null;
    const steps = s.script.map((member) => ({ member, tid: flatOf(flat.map, member) }));
    const proc = runProcess(flat.model, steps);
    // The predicates, and where the run stops, are bundle.run {scenario}'s.
    const reg = runOfRegistry(engines.live.call('bundle.run', { scenario: s.id }));
    const expect = reg.expect.map((e) => ({ ...e, flat: e.flat || null, have: e.actual, pass: e.pass }));
    return { steps, proc, expect, reg };
  };
  const runs = Object.fromEntries(scenarios.map((s) => [s.id, runOf(s)]));

  // --- controls (HTML, above the drawing)
  const bar = ctx.el('div', { class: 'pv-proc-bar' },
    ctx.el('span', { class: 'lbl' }, 'Run a scenario (bundle.scenarios, judgment):'),
    scenarios.map((s) => {
      const r = runs[s.id];
      if (r) ctx.emit('run', s.id, { fired: r.proc.boxes.map((b) => b.tid), stopped_step: r.reg.stoppedStep ?? '' });
      const ran = r && !r.proc.stop;
      const fails = r ? r.expect.filter((e) => !e.pass).length : 0;
      const dc = !r ? '#999' : !ran ? '#c47a12' : fails ? LEAK : BACK;
      const res = !r ? 'no flat net' : !ran ? `stops at ${r.proc.stop.index + 1}/${s.script.length}` : `${s.script.length} firings · ${r.expect.length - fails}/${r.expect.length} expected`;
      return ctx.el('button', { class: `pv-proc-chip${s.id === sc.id ? ' active' : ''}`, 'data-scenario': s.id, title: s.title, style: { '--dc': dc }, onclick: () => { ui.scenario = s.id; rerender(); } },
        ctx.el('span', { class: 'dot' }), ctx.el('b', {}, s.id), ctx.el('span', { class: 'res' }, res));
    }),
    idleToggle(ctx, runs[sc.id] ? idleTokens(runs[sc.id].proc).size : 0, 'Tokens on places the run never touches are identity wires tensored on; hidden by default.'));
  const sub = ctx.el('p', { class: 'pv-proc-sub' }, ctx.el('b', {}, sc.title), ` — script: ${sc.script.join(' → ')}`, sc.note ? `. Scenario note: ${sc.note}` : '');

  const root = ctx.svgRoot(W, 600);
  root.append(S('rect', { x: 0, y: 0, width: W, height: '100%', fill: PAPER, rx: 4 }));

  // --- legend (subnet colors)
  let lx = PAD;
  const legend = S('g', {});
  legend.append(S('text', { x: lx, y: 16, 'font-size': 10, fill: MUTED }, 'wires colored by subnet:'));
  lx += 124;
  for (const s of subnets) {
    const lg = S('g', {}, S('line', { x1: lx, y1: 13, x2: lx + 18, y2: 13, stroke: colors[s.id], 'stroke-width': 2.5 }),
      S('text', { x: lx + 23, y: 16, 'font-size': 10.5, fill: INK }, s.id), S('text', { x: lx + 23 + tw(s.id, 10.5) + 4, y: 16, 'font-size': 9.5, fill: MUTED }, ctx.orders.patterns[s.pattern].prefLabel));
    ctx.hover(lg, ctx.info.subnetInfo(s));
    legend.append(lg);
    lx += 23 + tw(s.id, 10.5) + 8 + tw(ctx.orders.patterns[s.pattern].prefLabel, 9.5) + 18;
  }
  legend.append(S('g', {}, S('line', { x1: lx, y1: 10.5, x2: lx + 18, y2: 10.5, stroke: INK, 'stroke-width': 1.4 }), S('line', { x1: lx, y1: 15.5, x2: lx + 18, y2: 15.5, stroke: INK, 'stroke-width': 1.4 }),
    S('text', { x: lx + 23, y: 16, 'font-size': 10, fill: MUTED }, 'double: fused')));
  root.append(legend);

  let bottom = 34;
  let drawing = null;
  const r = runs[sc.id];
  if (!r) {
    notes.push(['warn', `The links do not flatten: ${(flat.errors || []).map((e) => e.code).join(', ')}. There is no net to run.`]);
  } else {
    const { proc, expect } = r;
    const model = flat.model;
    const placeById = new Map(model.places.map((p) => [p.id, p]));
    const transById = new Map(model.transitions.map((t) => [t.id, t]));
    const idle = idleTokens(proc);
    const vis = new Set(proc.tokens.filter((t) => !idle.has(t.id) || ui.idle).map((t) => t.id));

    const placeSubnets = (pid) => [...new Set((placeById.get(pid)?.members || [pid]).map(memberSubnet))];
    const colorOf = (pid) => { const ss = placeSubnets(pid); return ss.length === 1 ? (colors[ss[0]] || INK) : INK; };
    const subnetOrder = new Map(subnets.map((s, i) => [s.id, i]));
    const groupOf = (t) => subnetOrder.get(placeSubnets(t.place)[0]) ?? 99;

    // the worker's wire: available -> (acquire) -> in_use -> (release) -> available
    const marks = new Map();
    const workerNotes = [];
    // a saga's outcome at the codomain, and what release is fused with: the leak
    // is the idiom's caveat only when release fires with a commit and that saga rolled back
    const sagaOutcome = (sid) => {
      const at = (p) => proc.final[flat.map.place[sid]?.[p]] ?? 0;
      return at('completed') > 0 ? 'completed' : at('rolled_back') > 0 ? 'rolled back' : 'not finished';
    };
    const sagaIds = subnets.filter((x) => x.pattern === 'saga').map((x) => x.id);
    const outcomes = sagaIds.map((sid) => `${sid} ${sagaOutcome(sid)}`).join(', ');
    const whyNoRelease = (s) => {
      const rel = transById.get(flat.map.transition[s.id]?.release);
      const others = (rel?.members || []).filter((m) => m !== `${s.id}/release`);
      const commits = others.filter((m) => byId[memberSubnet(m)]?.pattern === 'saga' && /\/commit$/.test(m));
      const idiom = commits.some((m) => sagaOutcome(memberSubnet(m)) === 'rolled back');
      const why = !others.length
        ? `${s.id}/release is not linked to anything, so no step of this script fires it`
        : idiom
          ? `${s.id}/release fires only with ${others.join(' + ')}, the saga rolled back, and no port fires on either outcome (pat:idiom-pool-release-saga-commit; patterns.ttl:434, :496)`
          : `${s.id}/release fires only with ${others.join(' + ')}, which this script does not fire`;
      return { idiom, why };
    };
    for (const s of subnets.filter((x) => x.pattern === 'resource-pool')) {
      const av = flat.map.place[s.id]?.available, iu = flat.map.place[s.id]?.in_use;
      const pred = expect.find((e) => e.place === `${s.id}/available`);
      for (const b of proc.boxes) {
        const took = b.ins.filter((t) => t.place === av), gave = b.outs.filter((t) => t.place === iu);
        took.forEach((t0, i) => {
          const t1 = gave[i];
          if (!t1) return;
          if (t1.died === null) {
            if (!proc.stop && pred && !pred.pass) {
              const { idiom, why } = whyNoRelease(s);
              marks.set(t0.id, { color: LEAK, under: true, why, idiom });
              marks.set(t1.id, { color: LEAK, under: true, why, idiom, tag: idiom ? 'never comes back: the leak' : 'never comes back' });
              workerNotes.push({ s, t0, t1, b, pred, why, idiom });
            }
            return;
          }
          const nb = proc.boxes[t1.died - 1];
          const back = nb.outs.filter((u) => u.place === av)[nb.ins.filter((u) => u.place === iu).indexOf(t1)];
          if (back) {
            marks.set(t0.id, { color: colors[s.id], under: true });
            marks.set(t1.id, { color: colors[s.id], under: true });
            marks.set(back.id, { color: colors[s.id], under: true, tag: back.died === null ? `returns to the pool at step ${nb.k}` : null, tagColor: BACK });
          }
        });
      }
    }

    const nameLines = (tid) => {
      const t = transById.get(tid);
      if (!t || !t.fused) { const { pre, local } = splitPlace(tid || ''); return [[{ text: pre, color: MUTED }, { text: local, weight: 600 }]]; }
      return [[{ text: 'fused:', color: MUTED, size: 9 }], ...t.members.map((m, j) => { const { pre, local } = splitPlace(m); return [{ text: j ? '+' : '', color: MUTED }, { text: pre, color: MUTED }, { text: local, weight: 600, color: colors[memberSubnet(m)] }]; })];
    };
    const tokName = (t) => `${t.place}${(proc.serial.get(t.place) || 0) > 1 ? ` #${t.n}` : ''}`;

    const spec = {
      model, proc, vis, idle, marks,
      colorOf, groupOf,
      fusedPlace: (pid) => (placeById.get(pid)?.members || []).length > 1,
      fused: (b) => !!transById.get(b.tid)?.fused,
      boxLines: (b) => {
        const ms = transById.get(b.tid)?.members || [b.tid];
        const locals = ms.map((m) => splitPlace(m).local);
        // a local name two members share (two sagas' do_reserve) keeps its subnet
        return ms.map((m, i) => ({ text: locals.indexOf(locals[i]) !== locals.lastIndexOf(locals[i]) ? m : locals[i], color: colors[memberSubnet(m)] }));
      },
      header: (b) => nameLines(b.tid),
      ghostHeader: (stop) => (stop.tid ? nameLines(stop.tid) : [[{ text: stop.step.member }]]),
      captionR: proc.stop ? `marking after step ${proc.boxes.length}` : 'final marking',
      boxInfo: (b) => {
        const t = transById.get(b.tid);
        const base = ctx.info.flatTransitionInfo(t);
        return {
          ...base,
          title: `step ${b.k}: ${b.tid}`,
          facts: [...(base.facts || []),
            ['script step', `${b.k}. ${b.step.member}`],
            ['takes (preset)', b.ins.map(tokName).join(', ') || 'nothing'],
            ['gives (postset)', b.outs.map(tokName).join(', ') || 'nothing'],
            b.reads.length ? ['reads, moves nothing', b.reads.map(tokName).join(', ')] : null,
            b.readShared.length ? ['reads the place it takes from', `${b.readShared.join(', ')}: go-pflow tests the read on the marking before the firing, so the token it takes satisfies it`] : null,
            b.inhib.length ? ['inhibited by', b.inhib.map((x) => `${x.place} (< ${x.weight}, has ${x.have})`).join(', ')] : null,
          ].filter(Boolean),
          note: 'One firing is one box: a morphism from its preset to its postset, in the category the net generates. Which token (#n) it took is this view\'s first-in first-out choice.',
          cites: [...(base.cites || []), CITES.fire, CITES.arcs],
          bib: ['baez-gms', 'meseguer-montanari'],
        };
      },
      wireInfo: (t) => {
        const p = placeById.get(t.place);
        const base = ctx.info.flatPlaceInfo(p);
        const mark = marks.get(t.id);
        const leak = mark && mark.color === LEAK;
        const fromBox = t.born ? proc.boxes[t.born - 1] : null, toBox = t.died ? proc.boxes[t.died - 1] : null;
        return {
          ...base,
          title: `token ${tokName(t)}`,
          facts: [...(base.facts || []),
            ['token', `#${t.n} on this place, counted first-in first-out (this view's choice)`],
            ['from', fromBox ? `step ${fromBox.k}: ${fromBox.tid}` : 'the domain (initial marking)'],
            ['to', toBox ? `step ${toBox.k}: ${toBox.tid}` : idle.has(t.id) ? 'the codomain: an identity wire, the run never touches this place' : 'the codomain (still there when the run ends)'],
          ],
          note: leak ? `${mark.idiom ? 'The leak is a wire that never comes back' : 'A wire that never comes back'}: the worker taken here is still on in_use at the codomain (${outcomes}), because ${mark.why}. Which unit counts as "the worker" is this view's pairing (first taken, first given back); the pool itself only counts (patterns.ttl:251).`
            : mark ? 'Highlighted: the worker\'s path, available → in_use → available. Which unit counts as "the worker" is this view\'s pairing; the pool itself only counts (patterns.ttl:251).' : (base.note || null),
          caveats: leak ? [mark.idiom ? ctx.orders.idioms.find((i) => i.leak)?.caveat : null, ctx.orders.patterns['resource-pool'].caveats[0]].filter(Boolean) : base.caveats,
          cites: [...(base.cites || []), ...(leak ? [...(mark.idiom ? [CITES.leak, CITES.noEither] : []), CITES.anon] : []), ...(t.place.endsWith('/items') ? [CITES.fifoNot] : [])],
        };
      },
      boundaryInfo: (which, marking, toks) => ({
        title: which === 'domain' ? 'domain: the initial marking' : `codomain: ${proc.stop ? `the marking after step ${proc.boxes.length}` : 'the final marking'}`,
        definition: 'A marking is a multiset of places: an element of the free commutative monoid on the places (Meseguer and Montanari). Drawn as a list of wires, in an order the layout picks.',
        facts: [
          ['drawn wires', toks.map(tokName).join(', ') || 'none'],
          ['whole marking', Object.entries(marking).filter(([, n]) => n).map(([p, n]) => `${p}: ${n}`).join(', ')],
          ['not drawn', ui.idle ? 'nothing' : 'tokens on places the run never touches (identity wires; toggle above)'],
        ],
        bib: ['meseguer-montanari'],
      }),
      ghostInfo: (stop) => {
        const sk = stopKind(stop);
        const spent = sk.failed.some((n) => n.kind === 'take' && /\/next_[^/]*$/.test(n.place));
        return {
          title: `step ${stop.index + 1} refused: ${stop.tid || stop.step.member}`,
          definition: sk.domainOk
            ? `Its domain is in the codomain, so as a box it would compose; the registry (bundle.run) refuses the firing on ${sk.side}: ${SIDE_WHY[sk.side] || 'see the reason below'}. The string diagram has no wire for that, so the refusal is drawn as this box outside the morphism.`
            : 'The next box does not compose: its domain is not contained in the codomain of the run so far.',
          facts: [
            ['script step', `${stop.index + 1}. ${stop.step.member}`],
            ['go-pflow EnabledWhyNot', stop.why],
            ...stop.needs.map((n) => [`${n.ok ? '✓' : '✗'} ${n.place}`, n.kind === 'capacity' ? `capacity ${n.need}: holds ${n.have}, this firing gives ${n.delta}` : `${{ take: 'takes', read: 'reads', inhibitor: 'needs fewer than' }[n.kind]} ${n.need}, has ${n.have}`]),
          ],
          caveats: spent ? [ctx.orders.patterns.saga.caveats[1]] : [],
          cites: [CITES.whyNot, ...(sk.side === 'a capacity bound' ? [CITES.capacity] : []), ...(spent ? [CITES.oneCase] : [])],
        };
      },
    };

    drawing = drawProcess(ctx, spec, 34);
    root.append(drawing.g);
    bottom = drawing.bottom;

    // expected predicates (bundle.scenarios), evaluated on the codomain by bundle.run
    const ey = bottom + 6;
    const eg = S('g', {});
    let ex = drawing.xL;
    eg.append(S('text', { x: ex - 8, y: ey, 'text-anchor': 'end', 'font-size': 10, fill: MUTED }, proc.stop ? 'expected, at the stop:' : 'expected (judgment):'));
    for (const e of expect) {
      const txt = `${e.pass ? '✓' : '✗'} ${e.place} ${e.op} ${e.n}${e.pass ? '' : ` (has ${e.have ?? '—'})`}`;
      const pg = S('g', { class: 'pv-pred' }, S('text', { x: ex, y: ey, 'font-size': 10.5, fill: e.pass ? BACK : LEAK, 'font-weight': e.pass ? 500 : 700 }, txt));
      ctx.hover(pg, { title: `expected: ${e.place} ${e.op} ${e.n}`, definition: e.says, facts: [['flat place', e.flat || '(not in the flat net)'], ['at the codomain', e.have ?? '—'], ['holds', e.pass ? 'yes' : 'no']], note: 'Scenario predicates are judgment (bundle.scenarios), frozen as ROADMAP 4.4 says scenarios are; whether one holds is bundle.run {scenario}\'s verdict on the flat net.' });
      eg.append(pg);
      ex += tw(txt, 10.5) + 22;
    }
    root.append(eg);
    bottom = ey + 18;

    if (workerNotes.length) {
      const w = workerNotes[0];
      notes.push(['warn', `Pool leak: worker ${tokName(w.t0)} goes into ${tokName(w.t1)} at step ${w.b.k} and is still there at the codomain (${outcomes}). ${w.idiom ? 'The leak is a wire that never comes back' : 'It is a wire that never comes back'}: ${w.why}. Expected ${w.pred.place} ${w.pred.op} ${w.pred.n}, has ${w.pred.have}.`]);
    }
    if (proc.stop) {
      const sk = stopKind(proc.stop);
      const missing = sk.failed.filter((n) => n.kind === 'take').map((n) => n.place);
      const what = sk.domainOk
        ? `Nothing it takes is missing from the codomain: the registry (bundle.run) refuses it on ${sk.side} (${sk.failed.map((n) => n.place).join(', ')}); ${SIDE_WHY[sk.side] || ''}, so no wire shows it.`
        : `Missing from the codomain: ${missing.join(', ')}.`;
      notes.push(['warn', `The run stops at step ${proc.stop.index + 1} of ${sc.script.length} (${proc.stop.step.member}). go-pflow: "${proc.stop.why}". ${what} Steps after it are not drawn; the codomain is the marking where it stopped.`]);
    }
    // read arcs (guard links lowered by flatten) are drawn, flagged, and given no semantics
    const readIn = proc.boxes.filter((b) => b.reads.length || b.readShared.length);
    if (readIn.length) {
      notes.push(['na', `Step${readIn.length > 1 ? 's' : ''} ${readIn.map((b) => b.k).join(', ')} read${readIn.length > 1 ? '' : 's'} a place without moving it: a guard link, lowered to a read arc as go-pflow does. The read token is drawn passing its box (◇), the nearest thing a string diagram has. Read arcs are outside the free-SMC fragment (ROADMAP Phase 6), so no functorial semantics is claimed for those boxes.${readIn.some((b) => b.readShared.length) ? ' Where the only token is one the same firing takes, go-pflow\'s test (on the marking before the firing) passes and there is no other token to draw.' : ''}`]);
    }
    // one column per firing is one interleaving; say when two neighbours are independent
    const indep = independentSteps(proc);
    if (indep.length) notes.push(['honesty', `Step${indep.length > 1 ? 's' : ''} ${indep.join(', ')} take${indep.length > 1 ? '' : 's'} nothing the step before produced or read: as boxes, each could be drawn before its left neighbour (interchange law). The columns follow the script.`]);
    notes.push(['honesty', 'Individual tokens are a choice here: each token is its own wire, told apart first-in first-out on its place (#1, #2); the net itself does not order tokens (patterns.ttl:201, :251). The collective-token reading (Petri nets generate commutative monoidal categories) identifies runs that differ only in which token was used, and makes the crossings identities; Baez, Genovese, Master and Shulman treat both readings (Σ-nets).']);
  }

  // --- the interface: every port of every instance, as snap targets
  const iface = drawInterface(ctx, subnets, byId, links, colors, bottom + 14);
  root.append(iface.g);
  bottom = iface.bottom;

  const H = Math.ceil(bottom + 12);
  root.setAttribute('viewBox', `0 0 ${W} ${H}`);
  root.setAttribute('height', H);

  ctx.root.append(ctx.el('style', {}, STYLE), bar, sub, root);
  for (const [level, text] of notes.reverse()) ctx.note(text, level);

  // --- merge animations
  const ev = ctx.event;
  // the box an event link just fused animates on its own (members converging), so the replay skips it
  const fusedNow = new Set();
  let fuseBox = null;
  if (ev && ev.type === 'link-added' && ev.link.kind === 'event' && drawing && flat.ok) {
    const fp = byId[ev.link.from.subnet]?.ports.find((p) => p.id === ev.link.from.port);
    fuseBox = fp ? drawing.boxesByTid.get(flatOf(flat.map, `${ev.link.from.subnet}/${fp.transition}`)) : null;
    if (fuseBox) fusedNow.add(fuseBox.g);
  }
  if (drawing && (ui.replay || (ev && ['link-added', 'link-removed', 'links-reset', 'links-cleared', 'instance-added', 'instance-removed', 'example', 'view'].includes(ev.type)))) playReplay(drawing.anim, fusedNow);
  ui.replay = false;
  if (ev && ev.type === 'link-added') {
    const l = ev.link;
    const color = ctx.theme.LINK_STYLE[l.kind]?.color || INK;
    const fs = byId[l.from.subnet], ts = byId[l.to.subnet];
    const fp = fs?.ports.find((p) => p.id === l.from.port), tp = ts?.ports.find((p) => p.id === l.to.port);
    if (drawing && fp && tp && flat.ok) {
      if (l.kind === 'event') {
        playFuse(fuseBox, color);
      } else if (l.kind === 'token' || l.kind === 'data') {
        const pid = flatPlaceOf(flat.map, `${l.from.subnet}/${fp.place}`);
        for (const wg of drawing.wiresByPlace.get(pid) || []) {
          const line = wg.querySelector('.case') || wg.querySelector('.line');
          line?.animate([{ stroke: color, strokeWidth: 9 }, { strokeWidth: 4.6 }], { duration: 850, easing: 'ease-out' });
        }
      }
    }
    iface.playLink(l);
  }
}

// --- the interface strip (orders) -------------------------------------------------------------
// One card per instance: transition ports on top (event links arc above the
// cards), place ports below (token and data links arc below), the instance in
// the band between. Every port is a snap target.

function drawInterface(ctx, subnets, byId, links, colors, top) {
  const S = ctx.svg;
  const g = S('g', { class: 'pv-interface' });
  g.append(S('line', { x1: PAD, y1: top, x2: W - PAD, y2: top, stroke: '#e1e5ea', 'stroke-width': 1 }));
  g.append(S('text', { x: PAD, y: top + 17, 'font-size': 11, 'font-weight': 600, fill: INK }, 'The composite\'s interface'),
    S('text', { x: PAD + 160, y: top + 17, 'font-size': 10.5, fill: MUTED }, 'every port of every instance. Drag one onto another to link them (the registry\'s link rules decide: bundle.add_link); the run above replays on the new flat net.'));
  const ABOVE = 46, BELOW = 40, CARD_H = 118, GAP = 20;
  const portW = (p) => Math.max(34, tw(p.id, 9.5) + 14, tw(p.kind, 8.5) + 14);
  const rowW = (ps) => ps.reduce((a, p) => a + portW(p), 0);
  const cards = subnets.map((s) => {
    const tp = s.ports.filter((p) => p.target === 'transition'), pp = s.ports.filter((p) => p.target === 'place');
    const label = `${s.id} · ${ctx.orders.patterns[s.pattern].prefLabel}`;
    return { s, tp, pp, w: Math.max(tw(label, 10.5) + 34, rowW(tp), rowW(pp)) + 16 };
  });
  const rows = [];
  let row = [], rw = 0;
  for (const c of cards) {
    if (row.length && rw + GAP + c.w > W - 2 * PAD) { rows.push(row); row = []; rw = 0; }
    rw += (row.length ? GAP : 0) + c.w;
    row.push(c);
  }
  if (row.length) rows.push(row);
  const portPos = new Map(), portEls = new Map();
  let y = top + 24 + ABOVE;
  for (const [rowIx, r] of rows.entries()) {
    const total = r.reduce((a, c) => a + c.w, 0) + GAP * (r.length - 1);
    let x = PAD + Math.max(0, (W - 2 * PAD - total) / 2);
    for (const c of r) {
      const { s } = c;
      const card = S('g', { class: 'pv-card', 'data-card': s.id });
      card.append(S('rect', { x, y, width: c.w, height: CARD_H, rx: 7, fill: '#fff', stroke: '#d5dae0', 'stroke-width': 1 }));
      card.append(S('rect', { x: x + 0.5, y: y + 50, width: c.w - 1, height: 18, fill: ctx.theme.PATTERN_TINT[s.pattern] || '#f1f3f5' }));
      const head = S('g', {}, S('rect', { x: x + 10, y: y + 57.5, width: 14, height: 3, rx: 1.5, fill: colors[s.id] }),
        S('text', { x: x + 30, y: y + 63, 'font-size': 10.5, 'font-weight': 600, fill: INK }, s.id),
        S('text', { x: x + 30 + tw(s.id, 10.5) + 4, y: y + 63, 'font-size': 9.5, fill: MUTED }, `· ${ctx.orders.patterns[s.pattern].prefLabel}`));
      ctx.hover(head, ctx.info.subnetInfo(s));
      card.append(head);
      const drawRow = (ports, gy, capY) => {
        let px = x + (c.w - rowW(ports)) / 2;
        for (const p of ports) {
          const pw = portW(p);
          const gx = px + pw / 2;
          const color = ctx.theme.portColor(p);
          const pg = S('g', { class: 'pv-port' });
          pg.append(S('rect', { class: 'hit', x: gx - 11, y: gy - 11, width: 22, height: 22 }));
          if (p.kind === 'in' || p.kind === 'inout') pg.append(S('path', { d: `M${gx - 15},${gy - 3.5} L${gx - 10},${gy} L${gx - 15},${gy + 3.5} z`, fill: color }));
          if (p.kind === 'out' || p.kind === 'inout') pg.append(S('path', { d: `M${gx + 10},${gy - 3.5} L${gx + 15},${gy} L${gx + 10},${gy + 3.5} z`, fill: color }));
          const hollow = p.kind === 'observe';
          if (p.target === 'place') pg.append(S('circle', { class: 'glyph', cx: gx, cy: gy, r: 6.5, fill: hollow ? '#fff' : color, stroke: color, 'stroke-width': 1.6, 'stroke-dasharray': hollow ? '2.2 1.6' : null }));
          else pg.append(S('rect', { class: 'glyph', x: gx - 6, y: gy - 6, width: 12, height: 12, rx: 1.5, fill: color, stroke: color, 'stroke-width': 1.6 }));
          ctx.snap.port(pg, { subnet: s.id, port: p.id });
          ctx.hover(pg, ctx.info.portInfo(s, p));
          card.append(pg);
          // captions on the side away from the links: below a transition port, above a place port
          card.append(S('text', { x: gx, y: capY, 'text-anchor': 'middle', 'font-size': 9.5, fill: INK }, p.id),
            S('text', { x: gx, y: capY + 10, 'text-anchor': 'middle', 'font-size': 8.5, fill: MUTED }, p.kind));
          portPos.set(`${s.id}|${p.id}`, { x: gx, y: gy, side: p.target === 'transition' ? -1 : 1, rowTop: y, rowBottom: y + CARD_H, row: rowIx, cardX: x, cardW: c.w });
          portEls.set(`${s.id}|${p.id}`, pg);
          px += pw;
        }
      };
      drawRow(c.tp, y + 15, y + 33);
      drawRow(c.pp, y + 103, y + 81);
      g.append(card);
      x += c.w + GAP;
    }
    y += CARD_H + BELOW + ABOVE;
  }
  // links as arcs (RenderDOT colors and glyphs): transitions above, places below
  const arcEls = new Map();
  // links between rows each get their own track (horizontal offset and a slot in the
  // gap beside the card), so two links never share a segment and read as one joint
  let crossIx = 0;
  const gArcs = S('g', {});
  for (const l of links) {
    const a = portPos.get(`${l.from.subnet}|${l.from.port}`), b = portPos.get(`${l.to.subnet}|${l.to.port}`);
    if (!a || !b) continue;
    const st = ctx.theme.LINK_STYLE[l.kind];
    const lift = 10 + Math.min(26, Math.abs(b.x - a.x) * 0.065);
    let d, mx, my;
    if (a.side === b.side && a.row !== b.row) {
      // across rows: leave on the port's own side, pass beside the card, arrive on the same side
      const [up, lo] = a.row < b.row ? [a, b] : [b, a];
      const sgn = a.side;
      const k = crossIx++, off = (k % 4) * 7;
      const yUp = sgn < 0 ? up.rowTop - 12 - off : up.rowBottom + 12 + off;
      const yLo = sgn < 0 ? lo.rowTop - 12 - off : lo.rowBottom + 12 + off;
      const beside = sgn < 0 ? up : lo; // the card to pass beside
      const other = beside === up ? lo : up;
      const gapLeft = other.x < beside.cardX + beside.cardW / 2 ? beside.cardX - GAP : beside.cardX + beside.cardW;
      const xs = gapLeft + 4 + (k % 3) * 6;
      const pts = [[up.x, up.y + sgn * 8], [up.x, yUp], [xs, yUp], [xs, yLo], [lo.x, yLo], [lo.x, lo.y + sgn * 8]];
      d = roundedPath(pts, 8);
      const segs = [[pts[1], pts[2]], [pts[3], pts[4]]].sort((u, v) => Math.abs(v[1][0] - v[0][0]) - Math.abs(u[1][0] - u[0][0]));
      mx = (segs[0][0][0] + segs[0][1][0]) / 2; my = segs[0][0][1];
    } else if (a.side === b.side) {
      const sgn = a.side;
      const yEdge = sgn < 0 ? Math.min(a.rowTop, b.rowTop) - lift : Math.max(a.rowBottom, b.rowBottom) + lift;
      d = `M${a.x},${a.y + sgn * 8} C${a.x},${yEdge} ${b.x},${yEdge} ${b.x},${b.y + sgn * 8}`;
      mx = (a.x + b.x) / 2; my = 0.25 * (a.y + sgn * 8) + 0.75 * yEdge;
    } else {
      // a guard: from a transition port (top row) over the cards, down beside the
      // observed place's card, and into its place port from below
      const [tp, pp] = a.side < 0 ? [a, b] : [b, a];
      const yTop = tp.rowTop - 42, yBot = pp.rowBottom + 26; // above the event arcs, below the token routes
      const xs = tp.x < pp.cardX + pp.cardW / 2 ? pp.cardX - 7 : pp.cardX + pp.cardW + 7;
      const pts = [[tp.x, tp.y - 8], [tp.x, yTop], [xs, yTop], [xs, yBot], [pp.x, yBot], [pp.x, pp.y + 8]];
      d = roundedPath(pts, 8);
      mx = (tp.x + xs) / 2; my = yTop;
    }
    const ag = S('g', { class: 'pv-arc', 'data-link': l.key });
    const line = S('path', { class: 'line', d, fill: 'none', stroke: st.color, 'stroke-width': 2, 'stroke-dasharray': st.dash || null });
    ag.append(line, S('path', { class: 'hit', d }),
      S('circle', { cx: mx, cy: my, r: 7, fill: PAPER }),
      S('text', { x: mx, y: my + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'middle', 'font-size': 11, fill: st.color }, st.glyph));
    if (l.leak) ag.append(S('text', { x: mx + 8, y: my + 0.5, 'dominant-baseline': 'middle', 'font-size': 9, 'font-weight': 700, fill: LEAK, class: 'pv-halo' }, 'leaks on rollback'));
    ctx.hover(ag, ctx.info.linkInfo(l, byId));
    gArcs.append(ag);
    arcEls.set(l.key, line);
  }
  g.append(gArcs);
  const playLink = (l) => {
    const line = arcEls.get(l.key);
    if (line) {
      let len = 0;
      try { len = line.getTotalLength(); } catch { len = 0; }
      if (len) line.animate([{ strokeDasharray: `${len} ${len}`, strokeDashoffset: len }, { strokeDasharray: `${len} ${len}`, strokeDashoffset: 0 }], { duration: 700, easing: 'ease-in-out' });
    }
    for (const ref of [l.from, l.to]) {
      const pe = portEls.get(`${ref.subnet}|${ref.port}`);
      pe?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.7)' }, { transform: 'scale(1)' }], { duration: 650, delay: 450, easing: 'ease-in-out' });
    }
  };
  return { g, bottom: y - ABOVE, playLink };
}

// --- connect-4 --------------------------------------------------------------------------------

// pflow-parser model_from_json (lib.rs:84-88): an input-side inhibitTransition is an
// inhibitor arc; an output-side one is the editor's read arc (place -> transition).
// The fixture has none of either; capacities are null (unbounded).
function c4Model(net) {
  const isPlace = new Set(Object.keys(net.places));
  return {
    name: net.name,
    places: Object.entries(net.places).map(([id, p]) => ({ id, kind: 'token', initial: (p.initial && p.initial[0]) || 0, capacity: (p.capacity && p.capacity[0]) || 0 })),
    transitions: Object.keys(net.transitions).map((id) => ({ id })),
    arcs: net.arcs.map((a) => {
      const w = (a.weight && a.weight[0]) || 1;
      if (!a.inhibitTransition) return { from: a.source, to: a.target, weight: w };
      return isPlace.has(a.source) ? { from: a.source, to: a.target, weight: w, type: 'inhibitor' } : { from: a.target, to: a.source, weight: w, type: 'read' };
    }),
  };
}

// Both sides into the centre column, then its neighbours (x_play_<column>_<row>:
// the drop consumes open_<c>_<r> and passes the slot up to open_<c>_<r+1>).
const OPENING = [
  { tid: 'x_play_3_0', say: 'X into column 3, row 0' },
  { tid: 'o_play_3_1', say: 'O into column 3, row 1' },
  { tid: 'x_play_2_0', say: 'X into column 2, row 0' },
  { tid: 'o_play_4_0', say: 'O into column 4, row 0' },
];

const C4 = { x: '#b0413e', o: '#2f6fb3', open: '#8a93a0', turn: '#3c4656', active: '#178f7f', win: '#7b4cc2' };
function c4Family(pid) {
  if (/^open_/.test(pid)) return 'open';
  if (/^x_turn$|^o_turn$/.test(pid)) return 'turn';
  if (pid === 'game_active') return 'active';
  if (/^win_/.test(pid)) return 'win';
  if (/^x_/.test(pid)) return 'x';
  if (/^o_/.test(pid)) return 'o';
  return 'turn';
}
const C4_GROUP = { turn: 0, open: 1, x: 2, o: 3, active: 4, win: 5 };

let c4Cache = null;
function c4Run(net) {
  if (c4Cache && c4Cache.net === net) return c4Cache;
  // The token game runs on the registry's c4 engine (sim.reset / sim.fire / sim.enabled).
  const model = onC4Engine(c4Model(net), net);
  const proc = runProcess(model, OPENING.map((o) => ({ ...o, member: o.tid })));
  const isAuto = (tid) => tid.includes('win'); // the pflow-rs tests' reading: tests/common/mod.rs:23
  const markings = [proc.initial, ...proc.boxes.map((b) => b.marking)];
  const enabledAt = markings.map((mk) => {
    const en = model.transitions.filter((t) => whyNotEnabled(model, mk, t.id) === null).map((t) => t.id);
    const moves = en.filter((t) => !isAuto(t)), autos = en.filter(isAuto);
    const sides = [...new Set(moves.map((t) => t[0].toUpperCase()))]; // x_play_* / o_play_*
    return { moves, autos, sides };
  });
  const autoCount = model.transitions.filter((t) => isAuto(t.id)).length;
  c4Cache = { net, model, proc, enabledAt, autoCount };
  return c4Cache;
}

function renderConnect4(ctx) {
  const S = ctx.svg;
  const net = ctx.connect4.net;
  if (!net) { ctx.note('The Connect-4 fixture (assets/connect-4.json) did not load, so there is no net to fire.', 'warn'); return; }
  const { model, proc, enabledAt, autoCount } = c4Run(net);
  ctx.emit('run', 'opening', { fired: proc.boxes.length });
  const notes = [];
  const idle = idleTokens(proc);
  const vis = new Set(proc.tokens.filter((t) => !idle.has(t.id) || ui.idle).map((t) => t.id));
  const colorOf = (pid) => C4[c4Family(pid)];
  const many = (t) => (proc.serial.get(t.place) || 0) > 1;
  const tokName = (t) => `${t.place}${many(t) ? ` #${t.n}` : ''}`;
  const side = (tid) => (tid.startsWith('x_') ? 'X (+1, maximizes the reward)' : 'O (-1)');
  const placeDesc = (pid) => {
    const m = pid.match(/^(open|x|o)_(\d+)_(\d+)$/);
    if (m) return m[1] === 'open' ? `the open slot of column ${m[2]}, row ${m[3]}: the next drop there lands in row ${m[3]}` : `a ${m[1].toUpperCase()} disc in column ${m[2]}, row ${m[3]} (row 0 is the bottom)`;
    return { x_turn: 'X to move', o_turn: 'O to move', game_active: 'the game is on; every win detector consumes it', win_x: 'reward place: X won (+1)', win_o: 'reward place: O won (-1)' }[pid] || '';
  };

  const bar = ctx.el('div', { class: 'pv-proc-bar' },
    ctx.el('span', { class: 'lbl' }, 'One play: a fixed opening, both sides into the centre column, then its neighbours'),
    idleToggle(ctx, idle.size, 'The other open slots and game_active: identity wires the play never touches.'));

  const root = ctx.svgRoot(W, 600);
  root.append(S('rect', { x: 0, y: 0, width: W, height: '100%', fill: PAPER, rx: 4 }));

  // legend: place families, by the fixture's naming convention
  let lx = PAD;
  root.append(S('text', { x: lx, y: 16, 'font-size': 10, fill: MUTED }, 'wires colored by place name (the fixture\'s convention):'));
  lx += 262;
  for (const [fam, label] of [['x', 'x_c_r  X disc'], ['o', 'o_c_r  O disc'], ['open', 'open_c_r  open slot'], ['turn', 'x_turn / o_turn'], ['active', 'game_active']]) {
    root.append(S('line', { x1: lx, y1: 13, x2: lx + 18, y2: 13, stroke: C4[fam], 'stroke-width': 2.5 }), S('text', { x: lx + 23, y: 16, 'font-size': 10, fill: INK }, label));
    lx += 23 + tw(label, 10) + 18;
  }

  const placeById = new Map(model.places.map((p) => [p.id, p]));
  const BOARD_W = 150;
  const spec = {
    model, proc, vis, idle, marks: new Map(),
    colorOf,
    groupOf: (t) => C4_GROUP[c4Family(t.place)] ?? 9,
    fusedPlace: () => false,
    fused: () => false,
    boxLines: (b) => [{ text: b.tid, color: C4[b.tid[0]] }],
    header: (b) => [[{ text: b.tid, weight: 600, color: C4[b.tid[0]] }], [{ text: b.step.say, color: MUTED, size: 9.5 }]],
    ghostHeader: (stop) => [[{ text: stop.tid }]],
    rightExtra: BOARD_W,
    boxInfo: (b) => ({
      title: `step ${b.k}: ${b.tid}`,
      concept: { iri: NS + 'Transition', types: ['ns:Transition'] },
      definition: b.step.say,
      facts: [
        ['side', side(b.tid)],
        ['automatic', 'no: the name has no "win" (tests/common/mod.rs:23)'],
        ['takes (preset)', b.ins.map(tokName).join(', ')],
        ['gives (postset)', b.outs.map(tokName).join(', ')],
        ['then enabled', `${enabledAt[b.k].moves.length} moves (${enabledAt[b.k].sides.join(', ')}), ${enabledAt[b.k].autos.length} of ${autoCount} automatic`],
      ],
      note: `One drop is one box, fired by the registry's token game (sim.fire: pflow-metamodel's firing rule); pflow-rs would also settle automatic transitions after it, and ${enabledAt[b.k].autos.length ? `${enabledAt[b.k].autos.length} is enabled here, which this drawing omits` : 'none is enabled here'}.`,
      cites: [CITES.fire, CITES.game, CITES.fixture],
      bib: ['baez-gms'],
    }),
    wireInfo: (t) => ({
      title: `token ${tokName(t)}`,
      concept: { iri: NS + 'Place', types: ['ns:Place'] },
      definition: placeDesc(t.place),
      facts: [
        ['initial', placeById.get(t.place)?.initial ?? 0],
        ['token', `#${t.n} on this place, first-in first-out (this view's choice)`],
        ['from', t.born ? `step ${t.born}: ${proc.boxes[t.born - 1].tid}` : 'the domain (initial marking)'],
        ['to', t.died ? `step ${t.died}: ${proc.boxes[t.died - 1].tid}` : idle.has(t.id) ? 'the codomain: an identity wire' : 'the codomain'],
      ],
      cites: [CITES.fixture],
    }),
    boundaryInfo: (which, marking, toks) => ({
      title: which === 'domain' ? 'domain: the initial marking' : 'codomain: the marking after four drops',
      definition: 'A marking is a multiset of places (Meseguer and Montanari), drawn as a list of wires.',
      facts: [['drawn wires', toks.map(tokName).join(', ')], ['whole marking', Object.entries(marking).filter(([, n]) => n).map(([p, n]) => `${p}: ${n}`).join(', ')]],
      bib: ['meseguer-montanari'],
    }),
    ghostInfo: (stop) => ({ title: `refused: ${stop.tid}`, facts: [['go-pflow EnabledWhyNot', stop.why]], cites: [CITES.whyNot] }),
  };
  const drawing = drawProcess(ctx, spec, 34);
  root.append(drawing.g);

  // what is enabled at each marking along the play
  const ey = drawing.bottom + 4;
  const eg = S('g', {});
  eg.append(S('text', { x: drawing.xL - 8, y: ey, 'text-anchor': 'end', 'font-size': 10, fill: MUTED }, 'enabled here:'));
  for (let e = 0; e <= proc.boxes.length; e++) {
    const en = enabledAt[e];
    const x = drawing.gapCenter(e);
    const t1 = `${en.moves.length} ${en.sides.join('/')} drops`;
    const t2 = `${en.autos.length} of ${autoCount} automatic`;
    const cg = S('g', {}, S('text', { x, y: ey, 'text-anchor': 'middle', 'font-size': 10, fill: INK }, t1), S('text', { x, y: ey + 12, 'text-anchor': 'middle', 'font-size': 9.5, fill: en.autos.length ? LEAK : MUTED }, t2));
    ctx.hover(cg, { title: e ? `enabled after step ${e}` : 'enabled at the initial marking', facts: [['moves', en.moves.join(', ')], ['automatic (name contains "win")', en.autos.join(', ') || `none of ${autoCount}`]], note: 'Checked with the firing rule on every transition of the fixture. Automatic transitions would be fired at once by pflow-rs\'s settle; none is enabled, so the play needs no extra boxes.', cites: [CITES.auto, CITES.settle, CITES.game] });
    eg.append(cg);
  }
  root.append(eg);

  // the codomain read as a board
  const bx = drawing.rightEdge + 24, by = drawing.lanesTop - 4, cell = 17;
  const board = S('g', { class: 'pv-board' });
  board.append(S('text', { x: bx, y: by - 8, 'font-size': 10, 'font-weight': 600, fill: INK }, 'the codomain as a board'));
  board.append(S('rect', { x: bx, y: by, width: cell * 7 + 6, height: cell * 6 + 6, rx: 5, fill: '#eef1f5', stroke: '#c9d0d8' }));
  for (let c = 0; c < 7; c++) for (let r = 0; r < 6; r++) {
    const x = bx + 3 + c * cell + cell / 2, y = by + 3 + (5 - r) * cell + cell / 2;
    const fx = proc.final[`x_${c}_${r}`], fo = proc.final[`o_${c}_${r}`], op = proc.final[`open_${c}_${r}`];
    board.append(S('circle', { cx: x, cy: y, r: cell / 2 - 2, fill: fx ? C4.x : fo ? C4.o : '#fff', stroke: op ? C4.open : '#d5dae0', 'stroke-width': op ? 1.6 : 1, 'stroke-dasharray': op ? '2 1.5' : null }));
  }
  for (let c = 0; c < 7; c++) board.append(S('text', { x: bx + 3 + c * cell + cell / 2, y: by + cell * 6 + 17, 'text-anchor': 'middle', 'font-size': 8.5, fill: MUTED }, c));
  board.append(S('text', { x: bx, y: by + cell * 6 + 30, 'font-size': 9, fill: MUTED }, 'dashed ring: open_c_r marked'));
  ctx.hover(board, {
    title: 'the final marking, read as a board',
    definition: 'x_<c>_<r> and o_<c>_<r> marked are discs; open_<c>_<r> marked is the next free slot of column c. Row 0 is the bottom (fixture description). A reading of the codomain, not a separate model.',
    facts: [['X discs', Object.keys(proc.final).filter((p) => /^x_\d/.test(p) && proc.final[p]).join(', ')], ['O discs', Object.keys(proc.final).filter((p) => /^o_\d/.test(p) && proc.final[p]).join(', ')], ['to move', proc.final.x_turn ? 'X' : proc.final.o_turn ? 'O' : 'nobody']],
    cites: [CITES.fixture],
  });
  root.append(board);

  const H = Math.ceil(Math.max(ey + 24, by + cell * 6 + 40) + 10);
  root.setAttribute('viewBox', `0 0 ${W} ${H}`);
  root.setAttribute('height', H);
  ctx.root.append(ctx.el('style', {}, STYLE), bar, root);

  const autosSeen = enabledAt.some((x) => x.autos.length);
  notes.push(['na', 'No search is run and the search plan is not drawn here, so the toolbar\'s plan pieces have no slot to snap into in this view. The plan (plan.rs) computes one value over all plays from a position; one play is one process. This is a fixed four-drop opening, each drop checked enabled by the firing rule.']);
  const indep = independentSteps(proc);
  if (indep.length) notes.push(['honesty', `Step${indep.length > 1 ? 's' : ''} ${indep.join(', ')} take${indep.length > 1 ? '' : 's'} nothing the step before produced: as boxes, each could be drawn before its left neighbour (interchange law). The columns follow the play.`]);
  notes.push([autosSeen ? 'warn' : 'honesty', `Automatic transitions: the tests read every transition whose name contains "win" as automatic (${autoCount} here; tests/common/mod.rs:23) and pflow-rs fires them as soon as they are enabled, lowest index first (game.rs settle). ${autosSeen ? 'One is enabled on this play: the drawing omits it and is incomplete.' : 'None is enabled after any of the four drops (checked on every transition), so the play has no automatic boxes.'} Token identities are first-in first-out per place, this view's choice.`]);
  for (const [level, text] of notes.reverse()) ctx.note(text, level);

  if (ui.replay || (ctx.event && ['example', 'view'].includes(ctx.event.type))) playReplay(drawing.anim);
  ui.replay = false;
}

// --- the view ------------------------------------------------------------------------------

export default {
  id: 'process',
  title: 'Runs as processes',
  short: 'Processes',
  convention: {
    summary: 'A run of a Petri net is a morphism, a process, in the monoidal category the net generates. Each token is a wire labelled by its place; each firing is a box from its preset to its postset; time runs left to right. The left edge (the domain) is the initial marking and the right edge (the codomain) the final one. Boxes in sequence compose (∘); wires side by side are the tensor (⊗).',
    examples: {
      orders: 'A scenario\'s firing script (bundle.scenarios) fired on the flat net by the registry (bundle.run), stopping at the first step it refuses. Fused transitions are double-bordered boxes, fused places double wires, wires colored by subnet. In refund and charge-fails the worker taken at step 1 is still on in_use at the codomain: the leak is a wire that never comes back. The strip below holds every port; a new link replays the run.',
      connect4: 'One play is one process: a fixed four-drop opening fired on the fixture net. The search plan computes a value over all plays; no search is run here and the plan is not drawn.',
    },
    honesty: [
      'Individual tokens are a choice: tokens on one place are told apart first-in first-out (#1, #2). The net does not order them (queue caveat, patterns.ttl:201; in_use is an anonymous count, :251). Under the collective-token reading (Petri nets generate commutative monoidal categories), runs that differ only in which token was used are one morphism; Baez, Genovese, Master and Shulman relate both readings through Σ-nets.',
      'Crossings and the order of wires on the boundaries are layout: symmetries of the symmetric monoidal category, and identities under the collective reading. The layout keeps the ordering with the fewest crossings.',
      'One column per firing, in script order: a firing sequence is one interleaving. Firings on disjoint wires could slide past each other (interchange law). Each run is checked: a stage note says when a step takes nothing its left neighbour produced (on the default links, in the four scenarios and the Connect-4 opening, every step does).',
      'Only places the run touches get wires; the other tokens are identity wires tensored on (toggle). A refused next step is drawn past the codomain, outside the morphism. Either its domain is not in the codomain, so it does not compose, or the registry refuses it on a side condition no wire shows (a capacity bound, a read or inhibitor arc), and the box and the note say which.',
      'A guard link lowers to a read arc; a read token is drawn passing the box (◇). Read arcs are outside the free-SMC fragment (ROADMAP Phase 6): drawn, with no functorial semantics claimed.',
      'Scenario scripts and predicates are judgment, frozen from the prototype (bundle.scenarios); whether a step fires, where a run stops and whether a predicate holds are the registry\'s (bundle.run: pflow-metamodel\'s enabled/fire, go-pflow\'s firing rule). The preset/postset rows under a refused step are this page\'s reading of the arcs; the reason quoted is the registry\'s.',
      'Connect-4: the drops are read by the fixture\'s naming convention, as the pflow-rs tests do (x_ moves are +1, names containing "win" are automatic). The board is a reading of the codomain.',
    ],
    bib: BIB,
    cites: [CITES.arcs, CITES.enabled, CITES.whyNot, CITES.capacity, CITES.fire, FLATTEN_CITES[0], CITES.fifoNot, CITES.anon, CITES.oneCase, CITES.noEither, CITES.leak, CITES.auto, CITES.settle, CITES.byName, CITES.game, CITES.inhibit, CITES.fixture],
  },
  render(ctx) {
    if (ctx.example === 'orders') renderOrders(ctx);
    else renderConnect4(ctx);
  },
};
