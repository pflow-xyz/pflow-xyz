// View 6: nets with boundaries.
//
// Sobociński (CONCUR 2010) and Bruni, Melgratti, Montanari and Sobociński
// (LMCS 9(3:16) 2013, arXiv 1307.0204, read 2026-10-27): a net with boundaries
// N : m → n wires each transition to ports on a left boundary m and a right
// boundary n (Def. 3.1, 4.1). Two nets that share a boundary compose by
// synchronisation: the composite's transitions are the minimal synchronisations
// (U, V) with U• = •V, whose pre- and postsets are the sums of the members'
// (Def. 3.2-3.4, 4.3-4.6). A transition wired to no shared port is its own
// minimal synchronisation ({t}, ∅) (p. 12). An ordinary net is N : 0 → 0
// (Remark 3.6), and such a net has no way of being interacted with (Remark 3.11).
//
// That is the semantics of go-pflow's event links (ontology ROADMAP Phase 6),
// which a cospan of places does not express. This view draws each instance as a
// net with boundaries: its left edge is its outer boundary (the transition ports
// no event link uses), its right edge faces one shared boundary. The shared
// boundary has one port per event class (bundle.flatten's fused_groups), and
// beyond each port the composite transition Flatten builds for that class.
// Places and token/data/guard links are drawn faint: they are the Cospans view's
// subject.

import { cite } from '../sources.js';
import { flatten, initialMarking, memberAlone, FLATTEN_CITES, PLAN_RS_REV } from '../model.js';
import { IDIOMS } from '../model.js';
import { CONNECT4_EXACT, toJSON } from '../model.js';

const go = (path, from, to = from, note = '') => cite('goPflow', path, from, to, note);
const ttl = (from, to = from, note = '') => cite('ontology', 'ns/patterns.ttl', from, to, note);
const road = (from, to, note) => cite('ontologyRoadmap', 'ROADMAP.md', from, to, note);

// Every line range below was read at the cited revision (go-pflow 69257b3, where
// git diff --stat 69257b3 c802f34 is empty for these files; patterns.ttl at
// bc4a996; ROADMAP.md at f854116; pflow-rs at c396d46).
const C = {
  rendezvous: go('metamodel/compose_fuse.go', 11, 14, 'an event class becomes one transition: pre/postset is the union, guard the conjunction; a rendezvous, enabled only when every participant is'),
  classes: go('metamodel/compose_fuse.go', 16, 20, 'fusion is over equivalence classes, not pairs, so it is associative'),
  everyMember: go('metamodel/compose_fuse.go', 166, 171, '"A rendezvous is enabled only when every participant is", so an unrepresentable guard on any member marks the fused transition'),
  transClasses: go('metamodel/compose_flatten.go', 72, 88, 'Flatten: transition classes, merged by EventLink (union-find)'),
  unionFind: go('metamodel/unionfind.go', 5, 14, 'the smallest member names a class, so link order does not matter'),
  flatName: go('metamodel/compose_flatten.go', 211, 227, 'flatTransitionName: "fused:" + sorted members joined by "+"'),
  whyNot: go('metamodel/firing.go', 142, 196, 'EnabledWhyNot: why a transition cannot fire at a marking'),
  legal: go('metamodel/compose_matrix.go', 42, 49, 'linkLegal: an event link needs a discrete firing instant (no ComputationNet)'),
  guardLower: go('metamodel/compose_flatten.go', 424, 468, 'applyGuardLinks: a structural guard becomes a read (or inhibitor) arc on the gated flat transition'),
  modelNoPorts: go('metamodel/schema.go', 23, 97, 'Model, what Flatten returns: places, transitions, arcs, constraints, ...; no ports'),
  subnetPorts: go('metamodel/compose.go', 104, 116, 'Subnet: a model plus its boundary (Ports)'),
  lkEvent: ttl(171, 174, 'lk:event: fuses two transitions; no port-direction rule'),
  leak: ttl(493, 498, 'pat:idiom-pool-release-saga-commit: the pool-leak caveat'),
  roadRow: road(400, 400, 'nets with boundaries: the semantics of event links, which a cospan of places does not express'),
  roadEvent: road(410, 411, 'lk:event is transition fusion; its semantics is Bruni et al.\'s, not Baez–Master\'s'),
  roadMonoidal: road(407, 407, 'unlinked subnets: the monoidal product (disjoint union)'),
  roadCospan: road(408, 409, 'lk:token / lk:data: a pushout along a shared place (a cospan composite)'),
  roadGuard: road(412, 413, 'lk:guard: a cross-subnet read arc, outside the free-SMC fragment'),
  fixture: cite('pflowRs', 'crates/pflow-metamodel/tests/fixtures/connect-4.json', 0, 0, 'the Connect-4 net (byte-identical to assets/connect-4.json): no ports'),
};

// Paper locations, as read in arXiv 1307.0204v2 (LMCS version) on 2026-10-27.
const PAPER = {
  def: 'Def. 3.1 / 4.1: a net with boundaries N : m → n wires each transition to ports on the left boundary m and the right boundary n',
  sync: 'Def. 3.2 and 3.4 (C/E), Def. 4.3 and 4.6 (P/T): composing M : l → m with N : m → n, the composite\'s transitions are the minimal synchronisations (U, V) with U• = •V; their pre- and postsets are the sums of the members\' (defined just before Def. 3.4 and Def. 4.6)',
  solo: 'p. 12: a transition wired to no port of the shared boundary is its own minimal synchronisation ({t}, ∅)',
  closed: 'Def. 4.1 with m = n = 0: a P/T net with no ports is a net with boundaries N : 0 → 0 (Remark 3.6 says so for C/E nets, and that composing two of them is their disjoint union)',
  noInteraction: 'Remark 3.11: a net N : 0 → 0 has no boundary, so there is no way of interacting with it',
  contention: 'Def. 3.1 (iii)-(iv): two transitions wired to one port on the same side are in contention (cannot fire together); Def. 4.3: a P/T synchronisation needs U• = •V',
};

// --- geometry (CSS px at a 1600px window; the root svg scales down by viewBox) ---
const W = 1150;
const OUTER_X = 88;             // the composite's outer boundary
const LANE0 = 16, LANE_STEP = 9; // lanes for the faint token/data/guard ghosts
const BOX_X = 114, BOX_W = 350, BOX_R = BOX_X + BOX_W;
const SHARED_X = 648;           // the shared boundary
const CARD_X = 680, CARD_W = W - CARD_X - 10;
const TOP = 64, HEAD = 28, TROW = 22, PROW = 17, CHIP_H = 15, GAP = 26;
const RECT_W = 112, RECT_H = 16;
const BPORT_R = 11;

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const CSS = `
.bnd-svg text { font-family: var(--font-sans); }
.bnd-svg .mono { font-family: var(--font-mono); }
.bnd-svg .hit { fill: transparent; stroke: none; }
.bnd-svg .wire-hit { fill: none; stroke: transparent; stroke-width: 10; }
.bnd-svg .bnd-ghost { opacity: 0.55; transition: opacity 0.15s; }
.bnd-svg .bnd-ghost:hover { opacity: 1; }
.bnd-svg .bnd-wire:hover .wire { stroke-width: 3; }
.bnd-svg .bnd-goto { cursor: pointer; }
.bnd-svg .bnd-goto:hover rect { fill: #eef4fb; }
.bnd-svg .bnd-pport-row { opacity: 0.8; }
.bnd-svg .bnd-pport-row:hover { opacity: 1; }
`;

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

function greedyWrap(text, maxChars) {
  const out = [];
  let cur = '';
  for (const w of String(text).split(/\s+/)) {
    if (cur && (cur.length + 1 + w.length) > maxChars) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

/** Wrap to at most maxChars per line, balanced: the narrowest width that needs no more lines (no orphans). */
function wrap(text, maxChars) {
  const n = greedyWrap(text, maxChars).length;
  let w = maxChars;
  while (n > 1 && w > 12 && greedyWrap(text, w - 1).length === n) w--;
  return greedyWrap(text, w);
}

function roundedPath(pts, r = 6) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1);
    if (!d1 || !d2) { d += ` L${x1},${y1}`; continue; }
    const rr = Math.min(r, d1 / 2, d2 / 2);
    d += ` L${x1 - ((x1 - x0) / d1) * rr},${y1 - ((y1 - y0) / d1) * rr} Q${x1},${y1} ${x1 + ((x2 - x1) / d2) * rr},${y1 + ((y2 - y1) / d2) * rr}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

/** Extend an inspector info object (rule 3): more facts, cites, bib, a note. */
function ext(info, more = {}) {
  return {
    ...info,
    ...(more.title ? { title: more.title } : {}),
    ...(more.definition ? { definition: more.definition } : {}),
    facts: [...(info.facts || []), ...(more.facts || [])],
    cites: [...(info.cites || []), ...(more.cites || [])],
    bib: [...(info.bib || []), ...(more.bib || [])],
    caveats: [...(info.caveats || []), ...(more.caveats || [])],
    note: more.note ? (info.note ? `${info.note} ${more.note}` : more.note) : info.note,
  };
}

// --- layout: a pure function of (subnets, links, flat) -----------------------------

function layoutOrders(subnets, links, flat, tw) {
  const byId = Object.fromEntries(subnets.map((s) => [s.id, s]));
  const pk = (r) => `${r.subnet}:${r.port}`;
  const eventPorts = new Set();
  for (const l of links) if (l.kind === 'event') { eventPorts.add(pk(l.from)); eventPorts.add(pk(l.to)); }
  const fused = flat.ok ? flat.map.fusedGroups : {};
  const classOfMember = new Map();
  for (const [name, members] of Object.entries(fused)) for (const m of members) classOfMember.set(m, name);
  const memberOfRef = (r) => { const s = byId[r.subnet]; const p = s && s.ports.find((q) => q.id === r.port); return p && p.transition ? `${s.id}/${p.transition}` : null; };

  const boxes = [], ports = new Map(), rows = new Map();
  let y = TOP;
  for (const s of subnets) {
    const box = { s, x: BOX_X, y, w: BOX_W, rows: [], pports: [], chips: [] };
    let ry = y + HEAD + 4;
    for (const t of s.transitions) {
      const cy = ry + TROW / 2;
      const member = `${s.id}/${t.id}`;
      const cls = classOfMember.get(member) || null;
      const row = { s, t, cy, member, cls, linked: !!cls, rx: cls ? BOX_R - 26 - RECT_W : BOX_X + 26, ports: [] };
      for (const p of s.ports.filter((q) => q.target === 'transition' && q.transition === t.id)) {
        const key = `${s.id}:${p.id}`;
        const side = eventPorts.has(key) ? 'R' : 'L';
        const pos = { key, s, p, side, x: side === 'R' ? BOX_R : BOX_X, y: cy, row };
        row.ports.push(pos);
        ports.set(key, pos);
      }
      box.rows.push(row);
      rows.set(member, row);
      ry += TROW;
    }
    ry += 4;
    for (const p of s.ports.filter((q) => q.target === 'place')) {
      const key = `${s.id}:${p.id}`;
      const pos = { key, s, p, side: 'L', x: BOX_X, y: ry + PROW / 2 };
      box.pports.push(pos);
      ports.set(key, pos);
      ry += PROW;
    }
    ry += 5;
    let cx = BOX_X + 14, cyc = ry + CHIP_H / 2;
    for (const p of s.places) {
      const w = 15 + tw(p.id, 9) + 12;
      if (cx + w > BOX_R - 8) { cx = BOX_X + 14; cyc += CHIP_H; }
      box.chips.push({ p, x: cx, y: cyc });
      cx += w;
    }
    ry = cyc + CHIP_H / 2 + 8;
    box.h = ry - y;
    boxes.push(box);
    y = ry + GAP;
  }
  const boxesBottom = y - GAP;

  // Event classes: one boundary port each, cards in order of their members' mean height.
  const model = flat.ok ? flat.model : { places: [], transitions: [], arcs: [] };
  const marking = flat.ok ? initialMarking(model) : {};
  const placeById = Object.fromEntries(model.places.map((p) => [p.id, p]));
  const isRead = (a) => a.type === 'read' || a.type === 'inhibitor';
  const enablement = new Map((flat.ok ? flat.initialEnablement : []).map((r) => [r.transition, r]));
  const classes = Object.entries(fused).map(([name, members]) => {
    const mports = members.map((m) => { const row = rows.get(m); return { m, row, port: row.ports.find((q) => q.side === 'R') || row.ports[0] }; });
    const clinks = links.filter((l) => l.kind === 'event' && members.includes(memberOfRef(l.from)));
    const pre = model.arcs.filter((a) => a.to === name && !isRead(a));
    const reads = model.arcs.filter((a) => a.to === name && isRead(a));
    const post = model.arcs.filter((a) => a.from === name && !isRead(a));
    // At the initial marking, the composite's enablement is the registry's
    // (bundle.flatten's initial_enablement, pflow-metamodel's reason).
    const ie = enablement.get(name);
    const why = ie ? (ie.enabled ? null : ie.why) : 'not in bundle.flatten\'s initial enablement';
    // Each member on its own: the same composition with the event links removed
    // (token, data and guard links kept), run one step from its initial marking
    // by the registry (model.memberAlone: bundle.run). So capacity and guard
    // read arcs count, as they do for the composite.
    const alone = members.map((m) => {
      const why = memberAlone(subnets.map((x) => x.id), links, m);
      return why === null ? { m, ok: true } : { m, ok: false, why: why.startsWith(`${m} `) ? why.slice(m.length + 1) : why };
    });
    const leakLink = clinks.find((l) => l.leak) || null;
    const leakIdiom = leakLink ? IDIOMS.find((i) => i.key === leakLink.idiom) : null;
    const leakLines = leakIdiom ? wrap(leakIdiom.caveat, 82) : [];
    const nrows = Math.max(pre.length + reads.length, post.length, 1);
    // each member's status sits right of the longest member name; a long
    // registry reason wraps onto further lines instead of running off the card
    const statusX = CARD_X + 24 + Math.max(...members.map((m) => (m.length + 6) * 10.5 * 0.6)) + 14;
    const statusChars = Math.max(16, Math.floor((CARD_X + CARD_W - 8 - statusX) / (9.5 * 0.52)));
    for (const a of alone) a.lines = wrap(a.ok ? 'enabled on its own' : `alone: ${a.why}`, statusChars);
    const memberLines = alone.reduce((n, a) => n + a.lines.length, 0);
    const whyLines = why ? wrap(`EnabledWhyNot: ${why.replace(name, '@')}`, Math.floor((CARD_W - 36) / (9.5 * 0.52))) : [];
    const h = 24 + memberLines * 13 + 4 + whyLines.length * 13 + 16 + 13 + 13 + clinks.length * 12 + 6 + 14 + nrows * 18 + 8 + (leakIdiom ? 22 + leakLines.length * 12 : 0) + 6;
    return { name, members, mports, clinks, pre, reads, post, why, whyLines, alone, statusX, leakLink, leakIdiom, leakLines, nrows, h, meanY: avg(mports.map((x) => x.port.y)), flatT: model.transitions.find((t) => t.id === name) };
  }).sort((a, b) => a.meanY - b.meanY || (a.name < b.name ? -1 : 1));

  let bottom = TOP - 14;
  classes.forEach((c, i) => {
    c.letter = LETTERS[i % 26];
    c.top = Math.max(c.meanY - 14, bottom + 14, TOP);
    c.by = c.top + 14;
    bottom = c.top + c.h;
  });

  const ghosts = links.filter((l) => l.kind !== 'event').map((l, i) => {
    const lane = LANE0 + (i % 7) * LANE_STEP;
    // A place end meets its port circle; a transition end leaves the transition's
    // bottom edge and runs left in the gap between rows, so it never crosses the
    // row's port label or the port squares on the box edge.
    const end = (r) => {
      const pos = ports.get(pk(r));
      if (!pos) return null;
      if (pos.p.target === 'place') return [[pos.x - 6, pos.y]];
      const x = pos.row.rx + 8, y = pos.row.cy + TROW / 2;
      return [[x, pos.row.cy + RECT_H / 2], [x, y]];
    };
    const a = end(l.from), b = end(l.to);
    if (!a || !b) return null;
    const ay = a[a.length - 1][1], by = b[b.length - 1][1];
    return { l, lane, a: a[0], b: b[0], my: (ay + by) / 2, pts: [...a, [lane, ay], [lane, by], ...[...b].reverse()] };
  }).filter(Boolean);

  const height = Math.max(boxesBottom, bottom) + 54;
  return { byId, ports, rows, boxes, classes, ghosts, classOfMember, boxesBottom, height, model, marking, placeById };
}

// --- shapes --------------------------------------------------------------------------

function tportShape(S, x, y, side, kind, color) {
  const g = S('g', { class: 'bnd-port' });
  g.append(S('rect', { class: 'hit', x: x - 10, y: y - 10, width: 20, height: 20 }));
  g.append(S('rect', { x: x - 5.5, y: y - 5.5, width: 11, height: 11, rx: 1.5, fill: color, stroke: '#fff', 'stroke-width': 1 }));
  // the chevron points into the box for an in-port and out of it for an out-port
  const inward = side === 'L' ? 1 : -1;
  const dir = kind === 'in' ? inward : kind === 'out' ? -inward : 0;
  if (dir) g.append(S('path', { d: `M${x - 2.2 * dir},${y - 3.2} L${x + 2.6 * dir},${y} L${x - 2.2 * dir},${y + 3.2} Z`, fill: '#fff' }));
  else g.append(S('circle', { cx: x, cy: y, r: 1.8, fill: '#fff' }));
  return g;
}

function pportShape(S, x, y, kind, color) {
  const g = S('g', { class: 'bnd-port' });
  g.append(S('circle', { class: 'hit', cx: x, cy: y, r: 10 }));
  g.append(S('circle', { cx: x, cy: y, r: 5, fill: kind === 'observe' ? '#fff' : color, stroke: color, 'stroke-width': 1.6 }));
  // direction tick outside the box: ▸ in, ◂ out, both for inout; observe is the hollow circle
  const tri = (dir) => S('path', { d: `M${x - 11 - 2.4 * dir},${y - 3} L${x - 11 + 2.6 * dir},${y} L${x - 11 - 2.4 * dir},${y + 3} Z`, fill: color });
  if (kind === 'in') g.append(tri(1));
  if (kind === 'out') g.append(tri(-1));
  if (kind === 'inout') { g.append(S('path', { d: `M${x - 17},${y} L${x - 12},${y - 3} L${x - 12},${y + 3} Z M${x - 8},${y} L${x - 13},${y - 3} L${x - 13},${y + 3} Z`, fill: color })); }
  return g;
}

function tokenDots(S, cx, cy, n, color = '#2b2f36') {
  if (!n) return [];
  if (n === 1) return [S('circle', { cx, cy, r: 1.9, fill: color })];
  if (n === 2) return [S('circle', { cx: cx - 2, cy, r: 1.6, fill: color }), S('circle', { cx: cx + 2, cy, r: 1.6, fill: color })];
  if (n === 3) return [S('circle', { cx, cy: cy - 2, r: 1.5, fill: color }), S('circle', { cx: cx - 2.1, cy: cy + 1.5, r: 1.5, fill: color }), S('circle', { cx: cx + 2.1, cy: cy + 1.5, r: 1.5, fill: color })];
  return [S('text', { x: cx, y: cy + 2.8, 'text-anchor': 'middle', 'font-size': 7.5, fill: color, 'font-weight': 600 }, String(n))];
}

// --- the orders drawing --------------------------------------------------------------

function renderOrders(ctx) {
  const S = ctx.svg, T = ctx.theme, info = ctx.info;
  const EV = T.LINK_STYLE.event.color, INK = T.INK, MUTED = T.MUTED, LEAK = T.LEAK;
  const subnets = ctx.orders.subnets, links = ctx.orders.links, flat = ctx.orders.flat;
  const pk = ctx.orders.portKey;

  if (!flat.ok) {
    ctx.note(`bundle.flatten refused the links (${flat.error || flat.errors.map((e) => e.code).join(', ')}); nothing to synchronise.`, 'warn');
    return;
  }

  const L = layoutOrders(subnets, links, flat, ctx.textWidth);
  const byId = L.byId;
  const reg = new Map(); // animation keys -> elements
  const svg = ctx.svgRoot(W, L.height, { class: 'view-svg bnd-svg', role: 'img', 'aria-label': 'Nets with boundaries: instances, the shared boundary and the composite transitions' });
  svg.append(S('style', {}, CSS));
  svg.append(S('defs', {},
    S('marker', { id: 'bnd-arrow', markerWidth: 7, markerHeight: 6, refX: 6.5, refY: 3, orient: 'auto' }, S('polygon', { points: '0 0,7 3,0 6', fill: '#6b7280' })),
    S('marker', { id: 'bnd-arrow-read', markerWidth: 7, markerHeight: 6, refX: 6.5, refY: 3, orient: 'auto' }, S('polygon', { points: '0 0,7 3,0 6', fill: T.LINK_STYLE.guard.color })),
  ));
  svg.append(S('rect', { x: 0, y: 0, width: W, height: L.height, fill: T.PAPER, rx: 4 }));

  // ---- legend and column headers
  const legend = S('g', { 'font-size': 10.5, fill: MUTED });
  let lx = 12;
  const lg = (shape, text, w) => { legend.append(shape(lx), S('text', { x: lx + 16, y: 22 }, text)); lx += w; };
  lg((x) => tportShape(S, x + 6, 18, 'L', 'in', T.TRANSITION_PORT_COLOR), 'transition port (▸ in / ◂ out)', 190);
  lg((x) => S('g', {}, S('circle', { cx: x + 6, cy: 18, r: 4.5, fill: T.schemaColor('resource') })), 'place port (by schema; not this view\'s subject)', 270);
  lg((x) => S('g', {}, S('circle', { cx: x + 6, cy: 18, r: 7, fill: '#fff', stroke: EV, 'stroke-width': 1.6 }), S('text', { x: x + 6, y: 22, 'text-anchor': 'middle', 'font-size': 11, fill: EV }, '⊗')), 'boundary port = one event class', 210);
  lg((x) => S('line', { x1: x, y1: 18, x2: x + 12, y2: 18, stroke: EV, 'stroke-width': 2 }), 'event wire (RenderDOT green)', 180);
  lg((x) => S('line', { x1: x, y1: 18, x2: x + 12, y2: 18, stroke: T.LINK_STYLE.token.color, 'stroke-width': 1.4, 'stroke-dasharray': '3 3', opacity: 0.6 }), 'token / data / guard: Cospans view', 200);
  ctx.hover(legend, { title: 'Legend: nets with boundaries', definition: 'Transitions are wired to ports on a boundary; nets that share a boundary compose by synchronising the transitions wired to the same port.', facts: [['paper', PAPER.def], ['composition', PAPER.sync], ['colors', 'transition ports in the transition color, place ports by schema (theme.js); event wires use RenderDOT\'s event color']], bib: ['bruni-et-al', 'sobocinski-2010'], cites: [C.lkEvent] });
  svg.append(legend);

  const hdr = S('g', { 'font-size': 10.5, fill: MUTED, 'font-weight': 600, 'letter-spacing': '0.02em' });
  hdr.append(
    S('text', { x: 8, y: 50 }, 'outer boundary'),
    S('text', { x: BOX_X + 6, y: 50, 'font-weight': 600 }, 'instances: nets with boundaries N : k → l'),
    S('text', { x: SHARED_X, y: 50, 'text-anchor': 'middle' }, 'shared boundary'),
    S('text', { x: CARD_X + 26, y: 50 }, 'composite transitions (Flatten\'s fused groups)'),
  );
  svg.append(hdr);

  // ---- boundaries (dashed verticals)
  const outer = S('g', {});
  outer.append(S('line', { x1: OUTER_X, y1: TOP - 6, x2: OUTER_X, y2: L.boxesBottom + 6, stroke: '#9aa1aa', 'stroke-width': 1.4, 'stroke-dasharray': '5 4' }),
    S('line', { class: 'wire-hit', x1: OUTER_X, y1: TOP - 6, x2: OUTER_X, y2: L.boxesBottom + 6 }));
  const nOuter = [...L.ports.values()].filter((q) => q.p.target === 'transition' && q.side === 'L').length;
  ctx.hover(outer, { title: `outer boundary of the composite: ${nOuter} transition ports`, definition: 'The transition ports no event link uses. Each such transition is its own minimal synchronisation ({t}, ∅); read as a net with boundaries, it stays on the composite\'s outer boundary.', facts: [['paper', PAPER.solo], ['flat name', 'a singleton class keeps its qualified id, e.g. orders/enqueue (compose_flatten.go:211-215)'], ['go-pflow', 'Flatten returns a Model, which has no ports: the boundary belongs to a Subnet. This edge is the paper\'s reading, not something Flatten emits.']], cites: [C.flatName, C.transClasses, C.modelNoPorts, C.subnetPorts], bib: ['bruni-et-al'] });
  svg.append(outer);

  const shared = S('g', {});
  const sharedBottom = Math.max(L.boxesBottom, ...L.classes.map((c) => c.top + c.h)) + 6;
  shared.append(S('line', { x1: SHARED_X, y1: TOP - 6, x2: SHARED_X, y2: sharedBottom, stroke: EV, 'stroke-width': 1.4, 'stroke-dasharray': '5 4', opacity: 0.7 }),
    S('line', { class: 'wire-hit', x1: SHARED_X, y1: TOP - 6, x2: SHARED_X, y2: sharedBottom }));
  ctx.hover(shared, ext(info.linkKindInfo('event'), { title: `shared boundary: ${L.classes.length} port${L.classes.length === 1 ? '' : 's'}, one per event class`, note: 'In the paper the shared boundary lies between two nets, one on each side, and is hidden in their composite. go-pflow fuses n subnets at once, so every instance faces it from one side here.', facts: [['paper', PAPER.sync]], cites: [C.roadRow, C.roadEvent, C.transClasses], bib: ['bruni-et-al', 'sobocinski-2010'] }));
  svg.append(shared);
  if (!L.classes.length) {
    const t = S('g', {});
    t.append(S('rect', { x: SHARED_X - 120, y: TOP + 80, width: 240, height: 54, rx: 6, fill: '#fff', stroke: '#cfd5dc' }),
      S('text', { x: SHARED_X, y: TOP + 101, 'text-anchor': 'middle', 'font-size': 11.5, fill: INK, 'font-weight': 600 }, 'no event links: nothing synchronises'),
      S('text', { x: SHARED_X, y: TOP + 118, 'text-anchor': 'middle', 'font-size': 10, fill: MUTED }, 'every transition is its own ({t}, ∅): disjoint union'));
    ctx.hover(t, { title: 'an empty shared boundary', definition: 'With no event links every transition is a minimal synchronisation on its own, and the composite is the disjoint union of the instances.', facts: [['paper', PAPER.solo], ['ROADMAP', 'unlinked subnets: the monoidal product (disjoint union)']], cites: [C.roadMonoidal], bib: ['bruni-et-al'] });
    svg.append(t);
  }

  // ---- instance boxes
  for (const box of L.boxes) {
    const s = box.s;
    const g = S('g', { class: 'bnd-box' });
    reg.set(`box:${s.id}`, g);
    const frame = S('g', {});
    const x = box.x, y = box.y, w = box.w, h = box.h;
    frame.append(S('rect', { x, y, width: w, height: h, rx: 6, fill: '#fff', stroke: '#333', 'stroke-width': 1.3 }),
      S('path', { d: `M${x + 6},${y} H${x + w - 6} Q${x + w},${y} ${x + w},${y + 6} V${y + HEAD} H${x} V${y + 6} Q${x},${y} ${x + 6},${y} Z`, fill: T.PATTERN_TINT[s.pattern] || '#f0f2f5', stroke: 'none' }),
      S('line', { x1: x, y1: y + HEAD, x2: x + w, y2: y + HEAD, stroke: '#d5d9df' }));
    const k = box.rows.reduce((n, r) => n + r.ports.filter((q) => q.side === 'L').length, 0);
    const l = box.rows.reduce((n, r) => n + r.ports.filter((q) => q.side === 'R').length, 0);
    const title = S('text', { x: x + 10, y: y + 18.5, 'font-size': 12.5, fill: INK },
      S('tspan', { 'font-weight': 700 }, s.id), S('tspan', { fill: MUTED, 'font-size': 11 }, `  ${ctx.orders.patterns[s.pattern].prefLabel}${s.extra ? ' · added' : ''}`));
    const type = S('text', { x: x + w - 10, y: y + 18.5, 'text-anchor': 'end', 'font-size': 11.5, fill: INK, class: 'mono' }, `${s.id} : ${k} → ${l}`);
    frame.append(title, type);
    ctx.hover(frame, ext(info.subnetInfo(s), {
      facts: [['as a net with boundaries', `${s.id} : ${k} → ${l}: ${k} outer (unsynchronised) and ${l} shared (synchronised) transition ports`]],
      note: 'Which ports face the shared boundary is this drawing\'s choice (the event links decide it); the pattern fixes the ports, not their sides.',
      bib: ['bruni-et-al'],
    }));
    g.append(frame);

    // transitions: one row each, wired to the outer (left) or shared (right) edge
    for (const row of box.rows) {
      const rg = S('g', {});
      for (const q of row.ports) {
        const x1 = q.side === 'L' ? BOX_X + 6 : row.rx + RECT_W, x2 = q.side === 'L' ? row.rx : BOX_R - 6;
        rg.append(S('line', { x1, y1: row.cy, x2, y2: row.cy, stroke: row.linked ? EV : '#9aa1aa', 'stroke-width': row.linked ? 1.3 : 1, 'stroke-dasharray': '3 2.5', opacity: row.linked ? 0.8 : 1 }));
        const lbl = q.p.id === row.t.id ? q.p.kind : `${q.p.id} · ${q.p.kind}`;
        rg.append(q.side === 'L'
          ? S('text', { x: row.rx + RECT_W + 8, y: row.cy + 3.5, 'font-size': 9.5, fill: MUTED, class: 'mono' }, lbl)
          : S('text', { x: row.rx - 8, y: row.cy + 3.5, 'font-size': 9.5, fill: MUTED, class: 'mono', 'text-anchor': 'end' }, lbl));
      }
      const rect = S('g', {});
      rect.append(S('rect', { x: row.rx, y: row.cy - RECT_H / 2, width: RECT_W, height: RECT_H, rx: 2, fill: row.linked ? '#e8f3ec' : '#fff', stroke: row.linked ? EV : INK, 'stroke-width': 1.2 }),
        S('text', { x: row.rx + RECT_W / 2, y: row.cy + 3.6, 'text-anchor': 'middle', 'font-size': 10.5, fill: INK, class: 'mono' }, row.t.id));
      const preL = s.arcs.filter((a) => a.to === row.t.id).map((a) => `${a.from}${a.weight > 1 ? `×${a.weight}` : ''}`);
      const postL = s.arcs.filter((a) => a.from === row.t.id).map((a) => `${a.to}${a.weight > 1 ? `×${a.weight}` : ''}`);
      ctx.hover(rect, ext(info.transitionInfo(s, row.t.id), {
        facts: [['preset (in this instance)', preL.join(', ') || '∅'], ['postset (in this instance)', postL.join(', ') || '∅'],
          ['synchronised', row.cls ? `yes: in ${row.cls}` : 'no: its own minimal synchronisation ({t}, ∅) on the outer boundary']],
        note: 'Arcs inside an instance are not drawn in this view; the Flat view draws them.',
        cites: row.cls ? [C.transClasses] : [],
      }));
      reg.set(`rect:${row.member}`, rect);
      rg.append(rect);
      g.append(rg);
    }

    // place ports (faint rows) and the places with their marking
    for (const q of box.pports) {
      const rowg = S('g', { class: 'bnd-pport-row' });
      rowg.append(S('text', { x: BOX_X + 12, y: q.y + 3.5, 'font-size': 9.5, fill: INK, class: 'mono' }, q.p.id,
        S('tspan', { fill: MUTED }, ` (${q.p.kind}) → ${q.p.place} · ${q.p.schema}`)));
      ctx.hover(rowg, ext(info.portInfo(s, q.p), { note: 'Place ports are not this convention\'s subject: token and data links glue places (a cospan; see the Cospans view).', cites: [C.roadCospan], bib: ['baez-master'] }));
      g.append(rowg);
    }
    if (box.pports.length) g.append(S('line', { x1: BOX_X + 10, y1: box.pports[0].y - PROW / 2 - 2, x2: BOX_R - 10, y2: box.pports[0].y - PROW / 2 - 2, stroke: '#eceef1' }));
    for (const c of box.chips) {
      const cg = S('g', {});
      const exported = !!c.p.exported;
      cg.append(S('circle', { cx: c.x + 5.5, cy: c.y, r: 5.5, fill: '#fff', stroke: exported ? INK : '#a3a9b1', 'stroke-width': exported ? 1.2 : 0.9 }),
        ...tokenDots(S, c.x + 5.5, c.y, c.p.initial),
        S('text', { x: c.x + 14, y: c.y + 3.2, 'font-size': 9, fill: exported ? INK : MUTED, class: 'mono' }, c.p.id));
      ctx.hover(cg, ext(info.placeInfo(s, c.p.id), { note: 'Places are listed with their initial marking; this convention is about how transitions meet a boundary.' }));
      g.append(cg);
    }
    svg.append(g);
  }

  // ---- ghosts: token / data / guard links (faint pointers to the cospan view)
  for (const gh of L.ghosts) {
    const st = T.LINK_STYLE[gh.l.kind];
    const g = S('g', { class: 'bnd-ghost' });
    const d = roundedPath(gh.pts, 5);
    g.append(S('path', { class: 'wire-hit', d }), S('path', { class: 'ghost-path', d, fill: 'none', stroke: st.color, 'stroke-width': 1.4, 'stroke-dasharray': gh.l.kind === 'data' ? '1.5 3' : '5 3' }));
    const my = gh.my;
    g.append(S('circle', { cx: gh.lane, cy: my, r: 6.5, fill: '#fff', stroke: st.color, 'stroke-width': 1.2 }),
      S('text', { x: gh.lane, y: my + 3.3, 'text-anchor': 'middle', 'font-size': 8.5, fill: st.color }, st.glyph));
    const why = gh.l.kind === 'guard'
      ? 'A guard link lowers to a read arc on the gated transition: restrictive, outside the free-SMC fragment, and no synchronisation. Not this convention\'s subject; see the Cospans and Flat views.'
      : `A ${gh.l.kind} link glues two places (a pushout of open nets, Baez–Master), not transitions. Not this convention's subject: see the Cospans view.`;
    ctx.hover(g, ext(info.linkInfo(gh.l, byId), { note: why, cites: [gh.l.kind === 'guard' ? C.roadGuard : C.roadCospan], bib: gh.l.kind === 'guard' ? [] : ['baez-master'] }));
    reg.set(`ghost:${gh.l.key}`, g);
    svg.append(g);
  }

  // ---- stubs to the outer boundary, and the transition / place ports themselves
  for (const q of L.ports.values()) {
    if (q.p.target === 'transition' && q.side === 'L') {
      svg.append(S('line', { x1: OUTER_X, y1: q.y, x2: BOX_X - 6, y2: q.y, stroke: '#b5bbc3', 'stroke-width': 1 }), S('circle', { cx: OUTER_X, cy: q.y, r: 2.2, fill: '#9aa1aa' }));
    }
  }
  for (const q of L.ports.values()) {
    const el = q.p.target === 'transition'
      ? tportShape(S, q.x, q.y, q.side, q.p.kind, T.portColor(q.p))
      : pportShape(S, q.x, q.y, q.p.kind, T.portColor(q.p));
    const cls = q.row ? q.row.cls : null;
    ctx.hover(el, ext(info.portInfo(q.s, q.p), {
      facts: [['boundary (this drawing)', q.p.target === 'place' ? 'a place port: the cospan views\' subject' : cls ? `shared: wired to the boundary port of ${cls}` : 'outer: no event link uses it; unsynchronised']],
      note: q.p.target === 'place' ? 'Drag to another place port for a token or data link (drawn faint here), or to a transition port for a guard link.' : 'Drag to another transition port: go-pflow\'s validateLink decides; an event link puts both transitions in one class.',
      cites: q.p.target === 'transition' ? [C.lkEvent] : [C.roadCospan],
    }));
    ctx.snap.port(el, { subnet: q.s.id, port: q.p.id });
    reg.set(`port:${q.key}`, el);
    svg.append(el);
  }

  // ---- event wires, boundary ports and composite cards
  for (const c of L.classes) {
    const flatT = c.flatT;
    for (const mp of c.mports) {
      const q = mp.port;
      const g = S('g', { class: 'bnd-wire' });
      const d = ctx.curve(BOX_R + 6, q.y, SHARED_X - BPORT_R - 1, c.by, 'x');
      g.append(S('path', { class: 'wire-hit', d }), S('path', { class: 'wire', d, fill: 'none', stroke: EV, 'stroke-width': 1.8, pathLength: 1 }));
      const via = c.clinks.filter((l) => [l.from, l.to].some((r) => `${r.subnet}/${byId[r.subnet].ports.find((p) => p.id === r.port).transition}` === mp.m));
      ctx.hover(g, ext(info.linkKindInfo('event'), {
        title: `${mp.m} is wired to boundary port ${c.letter}`,
        definition: 'A member of the event class: it fires only together with every other transition wired to this port.',
        facts: [['via links', via.map((l) => `${l.from.subnet}:${l.from.port} ⊗ ${l.to.subnet}:${l.to.port}${l.idiom ? ` (pat:${l.idiom})` : ''}`).join('; ')]],
        cites: [C.transClasses], bib: ['bruni-et-al'],
      }));
      reg.set(`wire:${mp.m}`, g);
      svg.append(g);
    }

    // boundary port
    const bp = S('g', { class: 'bnd-bport' });
    bp.append(S('circle', { cx: SHARED_X, cy: c.by, r: BPORT_R + 4, class: 'hit' }),
      S('circle', { cx: SHARED_X, cy: c.by, r: BPORT_R, fill: '#fff', stroke: EV, 'stroke-width': 2 }),
      S('text', { x: SHARED_X, y: c.by + 5.2, 'text-anchor': 'middle', 'font-size': 15, fill: EV }, '⊗'),
      S('text', { x: SHARED_X - BPORT_R - 5, y: c.by - BPORT_R - 2, 'text-anchor': 'end', 'font-size': 10.5, 'font-weight': 700, fill: EV }, c.letter));
    ctx.emit('boundary', c.name, { legs: c.members });
    bp.style.transformBox = 'fill-box';
    bp.style.transformOrigin = 'center';
    ctx.hover(bp, ext(info.flatTransitionInfo(flatT), {
      title: `boundary port ${c.letter}: one event class, ${c.members.length} members`,
      facts: [['links (binary)', `${c.clinks.length}, joined by union-find into one class`]],
      note: `One port of the shared boundary per go-pflow event class. In the paper, transitions wired to one port from the same side are alternatives (${PAPER.contention}); this port stands for go-pflow's n-ary rendezvous.`,
      cites: [C.transClasses, C.unionFind, C.rendezvous], bib: ['bruni-et-al', 'sobocinski-2010'],
    }));
    reg.set(`bport:${c.name}`, bp);

    // card
    const card = S('g', { class: 'bnd-card' });
    ctx.emit('composite', c.name, { members: c.members });
    const cx = CARD_X, top = c.top;
    card.append(S('line', { x1: SHARED_X + BPORT_R, y1: c.by, x2: cx, y2: c.by, stroke: EV, 'stroke-width': 1.4 }));
    const bg = S('rect', { x: cx, y: top, width: CARD_W, height: c.h, rx: 6, fill: '#fff', stroke: '#b9d8c4', 'stroke-width': 1.3 });
    card.append(bg);
    reg.set(`cardbg:${c.name}`, bg);
    const head = S('g', {});
    head.append(S('text', { x: cx + 12, y: top + 18, 'font-size': 11.5, fill: INK }, S('tspan', { 'font-weight': 700, fill: EV }, `${c.letter} `), S('tspan', { 'font-weight': 600 }, 'composite transition'), S('tspan', { fill: MUTED, 'font-size': 10 }, `  · ${c.members.length} members, one firing`)),
      S('text', { x: cx + CARD_W - 12, y: top + 18, 'text-anchor': 'end', 'font-size': 10, fill: c.why ? MUTED : T.LINK_STYLE.event.color, 'font-weight': 600 }, c.why ? '✗ not enabled at the initial marking' : '✓ enabled at the initial marking'));
    ctx.hover(head, ext(info.flatTransitionInfo(flatT), { facts: [['at the initial marking', c.why ? `not enabled: ${c.why}` : 'enabled'], ['computed by', 'the registry: bundle.flatten\'s initial_enablement (pflow-metamodel\'s enabled check on pflow-compose\'s flat net; go-pflow\'s EnabledWhyNot is where the rule comes from)']], cites: [C.whyNot] }));
    card.append(head);

    // flat name, one member per line, each with its own enabledness
    let yy = top + 24;
    c.members.forEach((m, i) => {
      yy += 13;
      const a = c.alone[i];
      const lg2 = S('g', {});
      lg2.append(S('circle', { cx: cx + 15, cy: yy - 3.5, r: 3.2, fill: a.ok ? EV : '#fff', stroke: a.ok ? EV : '#9aa1aa', 'stroke-width': 1.2 }),
        S('text', { x: cx + 24, y: yy, 'font-size': 10.5, fill: INK, class: 'mono' }, i === 0 ? 'fused:' : '     +', m),
        S('text', { x: c.statusX, y: yy, 'font-size': 9.5, fill: MUTED }, ...a.lines.map((ln, k) => S('tspan', { x: c.statusX, dy: k ? 13 : 0 }, ln))));
      yy += (a.lines.length - 1) * 13;
      const i0 = m.indexOf('/');
      ctx.hover(lg2, ext(info.transitionInfo(byId[m.slice(0, i0)], m.slice(i0 + 1)), { facts: [['on its own, at the initial marking', a.ok ? 'enabled' : `not enabled: ${a.why}`], ['computed by', 'the registry: the same composition with its event links removed (token, data and guard links kept), this member run one step from the initial marking by bundle.run'], ['in the composite', 'fires only with every other member']], note: 'The flat name is Flatten\'s (bundle.flatten, as go-pflow names it): "fused:" + the sorted members joined by "+" (there is no explicit link ID on this page).', cites: [C.flatName, C.whyNot] }));
      card.append(lg2);
    });
    yy += 4;
    if (c.why) {
      yy += 13;
      const wt = S('text', { x: cx + 24, y: yy, 'font-size': 9.5, fill: MUTED }, ...c.whyLines.map((ln, k) => S('tspan', { x: cx + 24, dy: k ? 13 : 0 }, ln.replace('@', c.letter))));
      yy += (c.whyLines.length - 1) * 13;
      ctx.hover(wt, { title: 'why the composite cannot fire yet', definition: c.why, facts: [['marking', 'the flat net\'s initial marking'], ['shown as', `the flat name is shortened to ${c.letter} on the card`]], cites: [C.whyNot] });
      card.append(wt);
    }
    // the rendezvous rule
    yy += 16;
    const rule = S('g', {});
    rule.append(S('text', { x: cx + 12, y: yy, 'font-size': 9, fill: MUTED, 'font-weight': 700, 'letter-spacing': '0.06em' }, 'RENDEZVOUS', S('tspan', { 'font-weight': 400, 'letter-spacing': '0', class: 'mono' }, '  go-pflow compose_fuse.go:11-14')));
    yy += 13;
    rule.append(S('text', { x: cx + 12, y: yy, 'font-size': 10.5, fill: INK, 'font-style': 'italic' }, 'fires only when every member is enabled; pre/postset = union'));
    ctx.hover(rule, { title: 'the rendezvous rule (go-pflow)', definition: 'The transitions in an EventLink class become one transition whose pre/postset is the union of theirs and whose guard is their conjunction: a rendezvous, so it is enabled only when every participant is.', facts: [['paper', PAPER.sync]], cites: [C.rendezvous, C.classes, C.everyMember], bib: ['bruni-et-al'] });
    card.append(rule);
    // the binary links behind the class
    yy += 13;
    card.append(S('text', { x: cx + 12, y: yy, 'font-size': 9.5, fill: MUTED }, `from ${c.clinks.length} binary event link${c.clinks.length === 1 ? '' : 's'}, joined by union-find (link order does not matter):`));
    for (const l of c.clinks) {
      yy += 12;
      const lt = S('text', { x: cx + 24, y: yy, 'font-size': 9.5, fill: INK, class: 'mono' }, `${T.LINK_STYLE.event.glyph} ${l.from.subnet}:${l.from.port} — ${l.to.subnet}:${l.to.port}`, l.idiom ? S('tspan', { fill: MUTED }, `  pat:${l.idiom}`) : null);
      ctx.hover(lt, ext(info.linkInfo(l, byId), { cites: [C.unionFind] }));
      card.append(lt);
    }
    yy += 6;
    // pre/post diagram: union of the members' arcs into one bar
    const barX = cx + CARD_W / 2 - 6;
    const preX = barX - 52, postX = barX + 12 + 52;
    yy += 14;
    card.append(S('text', { x: preX + 6, y: yy - 2, 'text-anchor': 'end', 'font-size': 9.5, fill: MUTED, 'font-weight': 600 }, 'preset ∪'),
      S('text', { x: postX - 6, y: yy - 2, 'font-size': 9.5, fill: MUTED, 'font-weight': 600 }, '∪ postset'));
    const rowsTop = yy + 4, barH = c.nrows * 18;
    const left = [...c.pre.map((a) => ({ a, read: false })), ...c.reads.map((a) => ({ a, read: true }))];
    const placeCircle = (px, py, pid, anchor, arc, read) => {
      const p = L.placeById[pid];
      const g = S('g', {});
      g.append(S('circle', { cx: px, cy: py, r: 6, fill: '#fff', stroke: read ? T.LINK_STYLE.guard.color : INK, 'stroke-width': 1.2 }), ...tokenDots(S, px, py, L.marking[pid] ?? 0),
        S('text', { x: anchor === 'end' ? px - 10 : px + 10, y: py + 3.4, 'text-anchor': anchor, 'font-size': 10, fill: INK, class: 'mono' }, pid));
      if (p) ctx.hover(g, ext(info.flatPlaceInfo(p), { facts: [['arc', `${arc.from} → ${arc.to}, weight ${arc.weight || 1}${read ? ` (${arc.guard ? 'read arc from a guard link' : `${arc.type} arc`}: moves nothing)` : ''}`]] }));
      return g;
    };
    const off = (n) => ((c.nrows - n) * 18) / 2;
    left.forEach(({ a, read }, i) => {
      const py = rowsTop + off(left.length) + i * 18 + 9;
      const arcEl = S('g', {});
      arcEl.append(S('line', { x1: preX + 6, y1: py, x2: barX - 1, y2: py, stroke: read ? T.LINK_STYLE.guard.color : '#6b7280', 'stroke-width': 1.2, 'stroke-dasharray': read ? '4 3' : null, 'marker-end': read ? 'url(#bnd-arrow-read)' : 'url(#bnd-arrow)' }));
      if ((a.weight || 1) > 1) arcEl.append(S('text', { x: (preX + barX) / 2, y: py - 3, 'text-anchor': 'middle', 'font-size': 9, fill: INK }, `×${a.weight}`));
      ctx.hover(arcEl, { title: `${read ? 'read arc' : 'input arc'} ${a.from} → ${a.to}`, facts: [['weight', a.weight || 1], read ? ['from', a.guard ? 'a guard link with the default condition "> 0", lowered to a read arc of weight 1 on the gated flat transition: it tests, moves nothing' : `a ${a.type} arc of a member: it tests, moves nothing`] : ['merge', 'duplicate arcs are summed (MergeSum)']], cites: read && a.guard ? [C.guardLower] : FLATTEN_CITES.slice(4, 5) });
      card.append(arcEl, placeCircle(preX, py, a.from, 'end', a, read));
    });
    c.post.forEach((a, i) => {
      const py = rowsTop + off(c.post.length) + i * 18 + 9;
      const arcEl = S('g', {});
      arcEl.append(S('line', { x1: barX + 12, y1: py, x2: postX - 7, y2: py, stroke: '#6b7280', 'stroke-width': 1.2, 'marker-end': 'url(#bnd-arrow)' }));
      if ((a.weight || 1) > 1) arcEl.append(S('text', { x: (postX + barX + 12) / 2, y: py - 3, 'text-anchor': 'middle', 'font-size': 9, fill: INK }, `×${a.weight}`));
      ctx.hover(arcEl, { title: `output arc ${a.from} → ${a.to}`, facts: [['weight', a.weight || 1]], cites: FLATTEN_CITES.slice(4, 5) });
      card.append(arcEl, placeCircle(postX, py, a.to, 'start', a, false));
    });
    const bar = S('g', {});
    bar.append(S('rect', { x: barX, y: rowsTop, width: 12, height: barH, rx: 2, fill: c.why ? '#f4f5f7' : '#e8f3ec', stroke: EV, 'stroke-width': 1.6 }));
    ctx.hover(bar, ext(info.flatTransitionInfo(flatT), { facts: [['preset (union)', left.map(({ a }) => a.from).join(', ') || '∅'], ['postset (union)', c.post.map((a) => a.to).join(', ') || '∅']], note: 'Its pre- and postsets are the members\' together; in the paper the composite transition\'s are the sums of the synchronised transitions\' (Def. 4.6).', cites: [C.rendezvous], bib: ['bruni-et-al'] }));
    card.append(bar);
    yy = rowsTop + barH + 8;
    // the pool-leak caveat, on the class whose link carries it
    if (c.leakIdiom) {
      const lk = S('g', {});
      const hh = 18 + c.leakLines.length * 12;
      lk.append(S('rect', { x: cx + 10, y: yy, width: CARD_W - 20, height: hh, rx: 4, fill: '#fdf0ee', stroke: LEAK, 'stroke-width': 0.9 }),
        S('text', { x: cx + 18, y: yy + 13, 'font-size': 10, fill: LEAK, 'font-weight': 700 }, '⚠ pool leak: release fires only with commit', S('tspan', { 'font-weight': 400, fill: MUTED, 'font-size': 9.5 }, '  (idiom caveat, patterns.ttl:496)')));
      c.leakLines.forEach((t, i) => lk.append(S('text', { x: cx + 18, y: yy + 26 + i * 12, 'font-size': 9.5, fill: '#8a2d22' }, t)));
      ctx.hover(lk, ext(info.linkInfo(c.leakLink, byId), { title: 'the pool-leak caveat (idiom, assistant judgment)', note: 'A rendezvous with commit only: on the rollback path no port fires, so workers/in_use keeps the unit. The page\'s refund scenario (orders.js SCENARIOS) is expected to fail on exactly this.', cites: [C.leak] }));
      card.append(lk);
    }
    reg.set(`card:${c.name}`, card);
    svg.append(card, bp);
  }

  // ---- bottom summary
  const nSync = L.classes.reduce((n, c) => n + c.members.length, 0);
  const nAll = subnets.reduce((n, s) => n + s.transitions.length, 0);
  // Unsynchronised transitions: the ones with a transition port sit on the outer
  // boundary; one with no port is internal (on no boundary at all).
  const nPorted = [...L.rows.values()].filter((r) => !r.cls && r.ports.length).length;
  const nInternal = nAll - nSync - nPorted;
  const sum = S('text', { x: 12, y: L.height - 18, 'font-size': 11, fill: MUTED },
    S('tspan', { fill: INK, 'font-weight': 600 }, 'composite: '),
    `${nAll} transitions in ${subnets.length} instances → ${L.model.transitions.length} flat transitions: ${nSync} synchronised into ${L.classes.length} composite${L.classes.length === 1 ? '' : 's'}; ${nAll - nSync} unsynchronised, ${nPorted} of them on the outer boundary (${nOuter} port${nOuter === 1 ? '' : 's'})${nInternal ? `, ${nInternal} internal (no port)` : ''}.`);
  ctx.hover(sum, { title: 'the composite', definition: 'Flatten\'s transitions: one per event class, plus every unsynchronised transition under its qualified id.', facts: [['flat net', `${L.model.places.length} places, ${L.model.transitions.length} transitions`], ['paper', PAPER.solo]], cites: [C.transClasses, C.flatName], bib: ['bruni-et-al'] });
  svg.append(sum);

  ctx.root.append(svg);
  animate(ctx, L, reg, svg);
}

// --- merge animation -----------------------------------------------------------------

const EASE = 'cubic-bezier(.22,.8,.24,1)';
function slide(el, dx, dy, opts = {}) {
  if (!el || (!dx && !dy) || !el.animate) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }], { duration: 760, easing: EASE, fill: 'backwards', ...opts });
}
function fadeIn(el, opts = {}) {
  if (el && el.animate) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: 'ease-out', fill: 'backwards', ...opts });
}
function drawIn(path, opts = {}) {
  if (!path || !path.animate) return;
  path.setAttribute('pathLength', '1');
  path.style.strokeDasharray = '1';
  path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 520, easing: 'ease-in-out', fill: 'backwards', ...opts });
}

function animate(ctx, L, reg, svg) {
  const ev = ctx.event;
  if (!ev) return;
  if (ev.type === 'instance-added') {
    // the box and its ports (drawn outside the box group) arrive together
    for (const el of [reg.get(`box:${ev.id}`), ...[...L.ports.values()].filter((q) => q.s.id === ev.id).map((q) => reg.get(`port:${q.key}`))]) {
      slide(el, -40, 0, { duration: 700 });
      fadeIn(el, { duration: 700 });
    }
    return;
  }
  if (ev.type !== 'link-added') return;
  const l = ev.link;
  if (l.kind !== 'event') {
    const g = reg.get(`ghost:${l.key}`);
    if (g) { drawIn(g.querySelector('.ghost-path'), { duration: 750 }); fadeIn(g, { duration: 300 }); }
    return;
  }
  // The state just before this link: the same instances, the links without it.
  const prevLinks = ctx.orders.links.filter((x) => x.index !== l.index);
  const prevFlat = flatten(ctx.orders.subnets, prevLinks);
  if (!prevFlat.ok) return;
  const P = layoutOrders(ctx.orders.subnets, prevLinks, prevFlat, ctx.textWidth);
  const S = ctx.svg;
  const EV = ctx.theme.LINK_STYLE.event.color;

  // 1. the ends that just joined slide from the outer edge to the shared edge
  for (const ref of [l.from, l.to]) {
    const key = ctx.orders.portKey(ref);
    const now = L.ports.get(key), was = P.ports.get(key);
    if (now && was) slide(reg.get(`port:${key}`), was.x - now.x, was.y - now.y);
    const m = now && now.row && now.row.member;
    const rn = m && L.rows.get(m), rp = m && P.rows.get(m);
    if (rn && rp && rn.rx !== rp.rx) slide(reg.get(`rect:${m}`), rp.rx - rn.rx, 0);
  }
  // 2. the class that holds the link, and the classes it swallowed
  const m0 = L.ports.get(ctx.orders.portKey(l.from))?.row?.member;
  const cNow = L.classes.find((c) => c.members.includes(m0));
  if (!cNow) return;
  const absorbed = P.classes.filter((pc) => pc.members.every((m) => cNow.members.includes(m)));
  const bp = reg.get(`bport:${cNow.name}`);
  if (!absorbed.length) {
    // a new class: its boundary port appears
    bp?.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.35)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], { duration: 760, easing: EASE, delay: 380, fill: 'backwards' });
  } else {
    // the old boundary ports travel to the new one and fuse into it
    for (const pc of absorbed) {
      const ghost = S('g', { 'pointer-events': 'none' },
        S('circle', { cx: SHARED_X, cy: pc.by, r: BPORT_R, fill: '#fff', stroke: EV, 'stroke-width': 2 }),
        S('text', { x: SHARED_X, y: pc.by + 5.2, 'text-anchor': 'middle', 'font-size': 15, fill: EV }, '⊗'));
      svg.append(ghost);
      const a = ghost.animate([{ transform: 'translate(0px, 0px)', opacity: 1 }, { transform: `translate(0px, ${cNow.by - pc.by}px)`, opacity: 0.9, offset: 0.85 }, { transform: `translate(0px, ${cNow.by - pc.by}px)`, opacity: 0 }], { duration: 860, easing: 'cubic-bezier(.45,0,.3,1)' });
      a.onfinish = () => ghost.remove();
    }
    bp?.animate([{ transform: 'scale(1)' }, { transform: 'scale(1)', offset: 0.6 }, { transform: 'scale(1.4)', offset: 0.8 }, { transform: 'scale(1)' }], { duration: 900, easing: 'ease-out' });
  }
  // 3. wires: a new member's wire runs to the port; re-routed ones fade back in
  const prevMembers = new Set(absorbed.flatMap((pc) => pc.members));
  for (const mp of cNow.mports) {
    const w = reg.get(`wire:${mp.m}`);
    if (!w) continue;
    if (!prevMembers.has(mp.m)) drawIn(w.querySelector('.wire'), { delay: 330, duration: 520 });
    else if (absorbed.length > 1 || absorbed[0].by !== cNow.by) fadeIn(w, { delay: 450, duration: 400 });
  }
  // 4. cards: the merged one slides in from the biggest card it absorbed; others follow their class
  const card = reg.get(`card:${cNow.name}`);
  if (absorbed.length) {
    const big = [...absorbed].sort((a, b) => b.members.length - a.members.length)[0];
    slide(card, 0, big.top - cNow.top, { duration: 820 });
  } else {
    slide(card, -28, 0, { duration: 700, delay: 300 });
    fadeIn(card, { duration: 600, delay: 300 });
  }
  reg.get(`cardbg:${cNow.name}`)?.animate([{ fill: '#d9efe1' }, { fill: '#ffffff' }], { duration: 1400, delay: 500, easing: 'ease-out', fill: 'backwards' });
  for (const c of L.classes) {
    if (c === cNow) continue;
    const pc = P.classes.find((x) => x.name === c.name);
    if (pc && pc.top !== c.top) {
      slide(reg.get(`card:${c.name}`), 0, pc.top - c.top);
      slide(reg.get(`bport:${c.name}`), 0, pc.by - c.by);
      for (const mp of c.mports) fadeIn(reg.get(`wire:${mp.m}`), { delay: 500, duration: 300 });
    }
  }
}

// --- connect-4: a closed net, N : 0 → 0 -----------------------------------------------

function renderConnect4(ctx) {
  const S = ctx.svg, T = ctx.theme;
  ctx.emit('na', 'boundaries');
  ctx.note('Does not apply: a search plan composes pieces into slots (pflow-rs\'s SearchPlan::check decides, through plan.check); nothing synchronises transitions across a boundary. And the Connect-4 net is closed: it has no ports, so as a net with boundaries it is N : 0 → 0 (Bruni et al. Def. 4.1 with m = n = 0; Remark 3.6 for C/E nets), with nothing to compose along. The honest nearest drawing is that closed box; the plan is drawn in the Operad and Lens views.', 'na');
  const sm = ctx.connect4.summary;
  const H = 430;
  const svg = ctx.svgRoot(W, H, { class: 'view-svg bnd-svg', role: 'img', 'aria-label': 'The Connect-4 net as a closed net with boundaries 0 → 0' });
  svg.append(S('style', {}, CSS));
  svg.append(S('rect', { x: 0, y: 0, width: W, height: H, fill: T.PAPER, rx: 4 }));
  if (!sm) {
    svg.append(S('text', { x: W / 2, y: 120, 'text-anchor': 'middle', 'font-size': 13, fill: T.MUTED }, 'assets/connect-4.json did not load.'));
    ctx.root.append(svg);
    return;
  }
  const bx = 395, by = 70, bw = 360, bh = 165;
  // the two empty boundaries
  for (const [x, side] of [[bx - 110, 'left'], [bx + bw + 110, 'right']]) {
    const g = S('g', {});
    g.append(S('line', { x1: x, y1: by + 10, x2: x, y2: by + bh - 10, stroke: '#9aa1aa', 'stroke-width': 1.4, 'stroke-dasharray': '5 4' }),
      S('line', { class: 'wire-hit', x1: x, y1: by + 10, x2: x, y2: by + bh - 10 }),
      S('text', { x, y: by + bh / 2 + 6, 'text-anchor': 'middle', 'font-size': 22, fill: T.INK, class: 'mono' }, '0'),
      S('text', { x, y: by + bh + 8, 'text-anchor': 'middle', 'font-size': 10.5, fill: T.MUTED }, `${side} boundary: no ports`));
    // cover the line behind the 0
    g.insertBefore(S('rect', { x: x - 12, y: by + bh / 2 - 14, width: 24, height: 26, fill: T.PAPER }), g.childNodes[2]);
    ctx.hover(g, { title: `the ${side} boundary: 0 ports`, definition: 'The Connect-4 net declares no ports, so neither boundary has a port to synchronise on.', facts: [['paper', PAPER.closed], ['consequence', PAPER.noInteraction]], cites: [C.fixture], bib: ['bruni-et-al'] });
    svg.append(g);
  }
  const box = S('g', {});
  box.append(S('rect', { x: bx, y: by, width: bw, height: bh, rx: 6, fill: '#fff', stroke: '#333', 'stroke-width': 1.3 }),
    S('path', { d: `M${bx + 6},${by} H${bx + bw - 6} Q${bx + bw},${by} ${bx + bw},${by + 6} V${by + 30} H${bx} V${by + 6} Q${bx},${by} ${bx + 6},${by} Z`, fill: '#eef0f3' }),
    S('line', { x1: bx, y1: by + 30, x2: bx + bw, y2: by + 30, stroke: '#d5d9df' }),
    S('text', { x: bx + 12, y: by + 20, 'font-size': 13, 'font-weight': 700, fill: T.INK }, sm.name),
    S('text', { x: bx + bw - 12, y: by + 20, 'text-anchor': 'end', 'font-size': 12, fill: T.INK, class: 'mono' }, 'N : 0 → 0'));
  const rowsTxt = [
    [`${sm.places}`, 'places'],
    [`${sm.transitions}`, `transitions: ${sm.drops} drops (x_/o_play_*), ${sm.other} others`],
    [`${sm.arcs}`, 'arcs'],
    ['0', 'ports: nothing is exposed to a boundary'],
  ];
  rowsTxt.forEach(([n, t], i) => {
    box.append(S('text', { x: bx + 70, y: by + 62 + i * 26, 'text-anchor': 'end', 'font-size': 17, fill: T.INK, 'font-weight': 600, class: 'mono' }, n),
      S('text', { x: bx + 80, y: by + 62 + i * 26, 'font-size': 11.5, fill: T.MUTED }, t));
  });
  // the fixture's source, under the box (it is wider than the box)
  svg.append(S('text', { x: bx + bw / 2, y: by + bh + 22, 'text-anchor': 'middle', 'font-size': 9.5, fill: T.MUTED, class: 'mono' }, 'pflow-rs crates/pflow-metamodel/tests/fixtures/connect-4.json (MIT; vendored as compose/assets/connect-4.json)'));
  ctx.hover(box, {
    title: `${sm.name}: a closed net`,
    definition: sm.description,
    facts: [['places / transitions / arcs', `${sm.places} / ${sm.transitions} / ${sm.arcs}`], ['drops (names with _play_)', sm.drops], ['other transitions', `${sm.other} (the fixture's description: catalytic win detectors)`], ['ports', '0: the fixture declares none'], ['as a net with boundaries', 'N : 0 → 0 (Def. 4.1, m = n = 0)']],
    note: 'Composing it with another closed net would only be their disjoint union (Remark 3.6, for C/E nets): there is no transition synchronisation to draw. The fixture is a plain P/T net (no inhibitor arcs, no capacities), so Def. 4.1 applies as stated.',
    cites: [C.fixture], bib: ['bruni-et-al'],
  });
  svg.append(box);

  // what the plan is, and where it is drawn
  const ty = by + bh + 58;
  const expl = S('g', {});
  const planStr = JSON.stringify(ctx.plan.json);
  const isExample = planStr === JSON.stringify(toJSON(CONNECT4_EXACT));
  // the plan JSON on one line, or split at a comma when it would run past the drawing
  const second = ctx.plan.error ? `The current plan is refused: ${ctx.plan.error}` : `Current plan: ${planStr}`;
  const maxChars = Math.floor((W - 40) / (10.5 * 0.56));
  let planLines = [second];
  if (second.length > maxChars) {
    const cut = second.lastIndexOf(',', maxChars);
    planLines = cut > 0 ? [second.slice(0, cut + 1), second.slice(cut + 1)] : wrap(second, maxChars);
  }
  expl.append(S('text', { x: W / 2, y: ty, 'text-anchor': 'middle', 'font-size': 12, fill: T.INK }, 'The search plan ', isExample ? S('tspan', { class: 'mono', 'font-size': 11 }, 'plan:connect4-exact ') : '(edited from plan:connect4-exact) ', 'fills slots with pieces; it has no transitions to synchronise.'),
    ...planLines.map((ln, i) => S('text', { x: W / 2, y: ty + 18 + i * 14, 'text-anchor': 'middle', 'font-size': 10.5, fill: T.MUTED }, ln)));
  ctx.hover(expl, { title: 'the search plan (not a net with boundaries)', definition: `SearchPlan JSON, checked by pflow-rs @${PLAN_RS_REV} SearchPlan::check (plan.check): order pieces, drivers, filters, heuristics and memo go into slots. No piece is a transition, and no slot is a boundary port.`, facts: [['plan', planStr], ['check', ctx.plan.error || 'accepted']], cites: [ctx.plan.exampleCite] });
  svg.append(expl);
  const goto = (x, view, label, sub) => {
    const g = S('g', { class: 'bnd-goto', role: 'link', tabindex: 0 });
    g.append(S('rect', { x, y: ty + 40, width: 250, height: 46, rx: 8, fill: '#fff', stroke: T.LINK_STYLE.data.color, 'stroke-width': 1.3 }),
      S('text', { x: x + 16, y: ty + 59, 'font-size': 12.5, 'font-weight': 600, fill: T.LINK_STYLE.data.color }, `${label} →`),
      S('text', { x: x + 16, y: ty + 76, 'font-size': 10.5, fill: T.MUTED }, sub));
    g.addEventListener('click', (e) => { e.preventDefault(); ctx.actions.setView(view); });
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter') ctx.actions.setView(view); });
    ctx.hover(g, { title: `go to the ${label}`, definition: sub, facts: [['why there', view === 'operad' ? 'a plan is an outer box with typed slots filled by pieces (operadic composition; ROADMAP Phase 6)' : 'drivers wrap the core, play forward and value back (an analogy, labelled there)']], bib: view === 'operad' ? ['spivak-wd'] : ['ghani-hedges'] });
    return g;
  };
  svg.append(goto(W / 2 - 262, 'operad', 'Operad view', 'pieces filling a solver template\'s slots'),
    goto(W / 2 + 12, 'lens', 'Lens view', 'drivers around the search core'));
  ctx.root.append(svg);
}

export default {
  id: 'boundaries',
  title: 'Nets with boundaries',
  short: 'Boundaries',
  consumes: ['assets/connect-4.json', 'bundle.flatten', 'bundle.open', 'bundle.run', 'bundle.state', 'plan.open', 'plan.state'],
  convention: {
    summary: 'Nets with boundaries (Sobociński 2010; Bruni, Melgratti, Montanari and Sobociński 2013): a net N : m → n wires each transition to ports on a left and a right boundary. Two nets that share a boundary compose by synchronisation: the composite\'s transitions are the minimal sets of transitions that agree on the shared ports, and their pre- and postsets are the members\' together. That is the semantics of go-pflow\'s event links, which a cospan of places does not express (ROADMAP Phase 6). Read left to right: an instance\'s left edge is its outer boundary (transition ports no event link uses), its right edge faces the shared boundary; each ⊗ on the shared boundary is one event class, and the card beyond it is the composite transition Flatten builds for that class.',
    examples: {
      orders: 'orders, workers and payment, each a net with boundaries. With the three idioms there are two event classes: A = {orders/dequeue, workers/acquire, payment/do_reserve} and B = {payment/commit, workers/release}, each one boundary port and one composite transition (fused:… is Flatten\'s name). B carries the pool-leak caveat. Drag between transition ports to add an event link: the transition moves to the shared edge and its wire runs to a boundary port, or two classes\' ports fuse.',
      connect4: 'Does not apply. A search plan has no transition synchronisation, and the Connect-4 net is closed (no ports): as a net with boundaries it is N : 0 → 0 (Def. 4.1 with m = n = 0; Remark 3.6 for C/E nets). It is drawn as that closed box with the fixture\'s counts, with pointers to the Operad and Lens views.',
    },
    honesty: [
      'The paper composes two nets, one on each side of a shared boundary (M : l → m ; N : m → n). go-pflow fuses n subnets at once, by union-find over binary event links. Here every instance faces one shared boundary from the same side, each n-ary class is drawn as one boundary port, and the card beyond it is the composite transition (exactly Flatten\'s fused group), not a second net.',
      'In the paper, two transitions wired to one port from the same side are alternatives, not partners: in contention for C/E nets (Def. 3.1 (iii)-(iv)), and a P/T synchronisation needs U• = •V (Def. 4.3). So the single port per class is go-pflow\'s rendezvous written in the paper\'s notation, not the paper\'s port semantics. Read by Def. 4.3 (the page\'s reading), with the default links the paper would give orders/dequeue one port per partner (workers/acquire, payment/do_reserve on the other side); the minimal synchronisation would again be the whole class.',
      '"Enabled on its own" on a card is the registry\'s answer for the same composition with its event links removed (token, data and guard links kept): bundle.run fires that member one step from the initial marking, so capacity and guard read arcs count as they do for the composite. It says why the rendezvous waits, not how the paper would compose.',
      'Which edge a transition port sits on is this drawing\'s choice, made by the event links; the pattern fixes the ports, not their sides. An instance\'s type k → l counts its outer and shared transition ports.',
      'Arcs inside an instance are not drawn (places are listed with their initial marking; hover a transition for its pre/postset). The cards show each composite\'s full pre/postset from the flat net.',
      'Place ports and token/data/guard links are not this convention\'s subject. They are drawn faint, as pointers to the Cospans view: token and data links glue places (Baez–Master); a guard link is a read arc outside the free-SMC fragment.',
      '"Enabled at the initial marking" is the registry\'s (bundle.flatten\'s initial_enablement for a composite; bundle.run of one step for a member on its own, with its event links removed): a check at one marking, not a proof of anything about other markings.',
    ],
    bib: ['bruni-et-al', 'sobocinski-2010', 'baez-master'],
    cites: [C.rendezvous, C.classes, C.transClasses, C.unionFind, C.flatName, C.everyMember, C.whyNot, C.legal, C.guardLower, C.modelNoPorts, C.lkEvent, C.leak, C.roadRow, C.roadEvent, C.fixture],
  },
  render(ctx) {
    ctx.root.append(ctx.el('style', {}, '.stage .bnd-svg { margin: 0 auto; }'));
    if (ctx.example === 'connect4') { renderConnect4(ctx); return; }
    ctx.note('Honesty: Bruni et al. compose two nets along one boundary; go-pflow\'s event classes are n-ary (union-find over binary links). Each class is drawn as one boundary port, and the composite transitions are exactly Flatten\'s fused groups. Unlinked transition ports sit on the outer boundary, unsynchronised. Places and token/data/guard links are drawn faint: they belong to the Cospans view.', 'honesty');
    renderOrders(ctx);
  },
};
