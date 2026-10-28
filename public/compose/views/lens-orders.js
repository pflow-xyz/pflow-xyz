// The lens view's orders example (imported by lens.js; not a view of its own).
//
// Two modes, switched by the bar at the top (deep link: &lens=assume):
//  - strict: the lens test on the composition as the registry builds it,
//    three checks from bundle.lens, each with its verdict;
//  - assume: the fallback. Every transition pair with a backward pass, found
//    mechanically (bundle.lens pairs), is drawn as a lens: the saga's
//    steps as a chain of boxes (do_ on the forward lane, undo_ on the backward
//    lane, the residual between them), the other instances' pairs above the
//    step their forward transition is fused with. Fusion lines come from the
//    flat net (Flatten's classes), so a link dragged in here or in any view
//    redraws the picture and re-runs the composition check.
// Nothing here decides a verdict by reading: the registry's bundle.lens does
// (pflow-native crates/core/src/lens.rs, a port of the prototype's lensfind.js),
// on pflow-compose's link rules and Flatten (pflow-rs's Rust port of go-pflow's
// validateLink and Flatten), the same ones every other view draws from.
//
// Scene manifest (parity contract): both modes draw the verdict ("strict":
// holds, glued, legal_token, legal_data), every backward pair bundle.lens
// found ("s/t->u"), the forward steps (composes, split, dead_forward) and the
// one-link repairs ("how:u", holds); the strict mode is the default.

import { lens, flatOf, FLATTEN_CITES } from '../model.js';
import { RULE_CITES } from '../model.js';

let mode = 'strict';
if (typeof location !== 'undefined') {
  // A deep link (#view=lens&ex=orders&lens=assume) is read once, before the shell rewrites the hash.
  if (new URLSearchParams(location.hash.slice(1)).get('lens') === 'assume') mode = 'assume';
}
function setMode(ctx, m) {
  mode = m;
  const h = new URLSearchParams(location.hash.slice(1));
  if (m === 'assume') h.set('lens', 'assume'); else h.delete('lens');
  history.replaceState(null, '', `#${h.toString()}`);
  ctx.rerender();
}

export const ORDERS_CSS = `
.lo-bar { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 12px; color: var(--muted); flex-wrap: wrap; }
.lo-bar button { font: inherit; border: 1.5px solid #2f6fb3; color: #2f6fb3; background: #fff; border-radius: 6px; padding: 3px 12px; cursor: pointer; font-weight: 600; }
.lo-bar button.on { background: #2f6fb3; color: #fff; }
.lo-card { max-width: 900px; margin: 0 auto; font-size: 13px; line-height: 1.5; }
.lo-card h3 { font-size: 15px; margin: 4px 0 8px; }
.lo-card ol { padding-left: 20px; margin: 6px 0 12px; }
.lo-card li { margin: 0 0 10px; }
.lo-card .mono, .lo-verdict .mono { font-family: var(--font-mono); font-size: 11.5px; }
.lo-ok { color: #227744; font-weight: 700; }
.lo-no { color: #c0392b; font-weight: 700; }
.lo-go { font: inherit; font-weight: 600; border: 1.5px solid #2f6fb3; background: #2f6fb3; color: #fff; border-radius: 6px; padding: 6px 14px; cursor: pointer; }
.lo-verdict { font-size: 12.5px; line-height: 1.5; margin: 8px 0 0; }
.lo-verdict table { border-collapse: collapse; margin: 4px 0 10px; }
.lo-verdict td, .lo-verdict th { border-bottom: 1px solid #e3e6ea; padding: 4px 10px 4px 0; text-align: left; vertical-align: top; }
.lo-verdict th { font-weight: 600; color: var(--muted); font-size: 11.5px; }
.lens-svg .lo-t { cursor: grab; }
.lens-svg .lo-t:hover rect { stroke-width: 2.6; }
.lens-svg .lo-sync:hover path { stroke-width: 3.2; }
`;

const EV = '#227744';
const FWD = '#2f6fb3';
const BWD = '#b0413e';
const FAIL = '#886600';

export function renderOrders(ctx, common) {
  ctx.root.appendChild(ctx.el('style', {}, ORDERS_CSS));
  const subnets = ctx.orders.subnets;
  const flat = ctx.orders.flat;
  // The lens test is the registry's (bundle.lens: the analysis, and each
  // one-link repair re-validated, flattened and analysed).
  const lr = lens({ fixes: true });
  const a = lr.analysis;
  a.fixes = lr.fixes;

  ctx.root.appendChild(ctx.el('div', { class: 'lo-bar' },
    ctx.el('span', {}, 'Lens test:'),
    ctx.el('button', { class: mode === 'strict' ? 'on' : '', onclick: () => setMode(ctx, 'strict') }, 'strict (as composed)'),
    ctx.el('button', { class: mode === 'assume' ? 'on' : '', onclick: () => setMode(ctx, 'assume') }, 'assume a backward pass (fallback)'),
    ctx.el('span', {}, mode === 'strict' ? 'the composition as the registry builds it (bundle.lens)' : 'pairs with a backward pass, found mechanically; the composition is still checked')));

  if (!a.ok) {
    ctx.note(`The composition does not flatten: ${a.errors.map((e) => e.message || e.msg || e).join('; ')}`, 'warn');
    return;
  }
  if (mode === 'strict') return renderStrict(ctx, a, common);
  return renderAssumed(ctx, a, common);
}

// --- strict ---------------------------------------------------------------------------

function renderStrict(ctx, a, common) {
  const E = ctx.el;
  const ids = ctx.orders.subnets.map((s) => s.id);
  const ok = (b) => E('span', { class: b ? 'lo-ok' : 'lo-no' }, b ? '✓ ' : '✗ ');
  const bad = a.steps.filter((s) => !s.composes && !(s.noBackward && !s.deadForward));
  const leakRuns = a.runs.filter((r) => r.expect.some((e) => !e.ok));
  const card = E('div', { class: 'lo-card' },
    E('h3', {}, a.holds ? 'The composition is a lens composite.' : `No: ${ids.join(' ⊗ ')} is not a lens composite as composed.`),
    E('p', {}, 'A lens composite needs a boundary to compose along, a backward map in every part, and the parts\' backward maps to fire together the way their forward maps do. Each check below is the registry\'s (bundle.lens), on pflow-compose\'s link rules and its Flatten (pflow-rs\'s port of go-pflow\'s validateLink and Flatten).'),
    E('ol', {},
      E('li', {}, ok(a.glued > 0), E('b', {}, 'A boundary to compose along. '),
        `Lens composition is sequential: one part's output boundary is the next part's input. Among ${ids.join(', ')} the link rules (pflow-compose) allow ${a.legal.token} token and ${a.legal.data} data links (and ${a.legal.event} event, ${a.legal.guard} guard), and the composition uses ${a.glued} place links, so no boundary is glued: the composite is ⊗ plus transition fusion (the cospan view shows no pushout). Event fusion is a rendezvous, not a composition along a boundary.`),
      E('li', {}, ok(a.noBackward.length === 0), E('b', {}, 'A backward map in every part. '),
        a.noBackward.length ? `None found in ${a.noBackward.join(', ')}. ` : '',
        `Found mechanically (a residual place only t produces and only u consumes, and u returns what t moved on resource places): `,
        E('span', { class: 'mono' }, pairList(ctx, a)), '. Only the saga\'s are compensations; the pool\'s and the queue\'s are plain inverses.'),
      E('li', {}, ok(bad.length === 0 && a.roundTrips.length === 0), E('b', {}, 'Backward maps fire together as the forward maps do. '),
        bad.length || a.roundTrips.length ? breakText(a) : 'Every forward rendezvous has one backward rendezvous, and it can fire.'),
    ),
    leakRuns.length ? E('p', {}, E('b', {}, 'The scenario runs (bundle.lens, on the flat net): '),
      leakRuns.map((r) => `${r.id}: ${r.expect.filter((e) => !e.ok).map((e) => `${e.place} = ${e.got}, expected ${e.n}${r.stoppedStep ? ` (stopped at ${r.stoppedStep})` : ''}`).join('; ')}`).join(' · ')) : null,
    E('p', {}, 'The Connect-4 plan is drawn as lenses (an analogy of shape; press e). For this composition, the fallback draws what does have a backward pass and shows where the composite stops being a lens.'),
    E('button', { class: 'lo-go', onclick: () => setMode(ctx, 'assume') }, 'Assume a backward pass →'));
  ctx.hover(card, {
    title: 'the lens test (strict)',
    definition: 'Computed by the registry (bundle.lens: pflow-native lens.rs) from the subnets, pflow-compose\'s link rules (validateLink) and its Flatten.',
    facts: [['legal links', Object.entries(a.legal).map(([k, n]) => `${k} ${n}`).join(', ')], ['place links used', String(a.glued)], ['verdict', a.holds ? 'a lens composite' : 'not a lens composite']],
    cites: [RULE_CITES.legal, RULE_CITES.endpoint, ...FLATTEN_CITES],
    bib: common.bib,
  });
  ctx.emit('verdict', 'strict', { holds: !!a.holds, glued: a.glued, legal_token: a.legal.token, legal_data: a.legal.data });
  ctx.root.appendChild(card);
  renderVerdict(ctx, a);
  ctx.note('Strict test: the composition as composed, no assumption. Switch to the fallback to see the pairs that do have a backward pass drawn as lenses.', 'na');
}

/** Every backward pair bundle.lens found, as "s/t->u"; the oriented ones (forward map on the commit run) marked →. */
function pairList(ctx, a) {
  if (!a.pairs.length) return 'none';
  return a.pairs.map((p) => {
    const id = `${p.subnet}/${p.t}->${p.u}`;
    ctx.emit('pair', id, {});
    return id;
  }).join(', ');
}

function orientedPairs(a) {
  const out = [];
  for (const p of a.pairs) {
    const t = `${p.subnet}/${p.t}`, u = `${p.subnet}/${p.u}`;
    if (a.partner[t] && a.partner[t].u === u) out.push(`${t} → ${p.u}`);
  }
  for (const r of a.roundTrips) out.push(`${r.t} → ${r.u.split('/')[1]}`);
  return out;
}

function breakText(a) {
  const parts = [];
  for (const s of a.steps) {
    if (s.deadForward) parts.push(`${s.flat} can never fire: it needs ${s.deadForward.places.join(' and ')}, and ${s.deadForward.constraint} allows one token among them`);
    if (s.split) parts.push(`going forward ${s.flat} fires as one, but its backward maps ${s.back.map((b) => b.u).join(', ')} fire as ${s.backFlat.length} separate transitions (${s.backFlat.join('; ')})`);
    for (const d of s.dead) parts.push(`the backward rendezvous ${d.flat} can never fire (${d.dead.constraint})`);
  }
  for (const r of a.roundTrips) parts.push(`${r.t}'s backward map ${r.u} is fused into the forward pass (${r.uFlat}), so the way back has nothing to fire it`);
  return parts.join('; ') + '.';
}

// --- assumed ----------------------------------------------------------------------------

function renderAssumed(ctx, a, common) {
  const S = ctx.svg;
  const T = ctx.theme;
  const byId = ctx.orders.byId;
  const flat = ctx.orders.flat;
  const tById = Object.fromEntries(flat.model.transitions.map((t) => [t.id, t]));
  const saga = ctx.orders.subnets.find((s) => s.pattern === 'saga' && !s.extra) || ctx.orders.subnets.find((s) => s.pattern === 'saga');
  if (!saga) { ctx.note('No saga instance: nothing to chain.', 'na'); return; }

  const steps = saga.steps;
  const n = steps.length;
  const X0 = 130, SW = 230, GAP = 96;
  const FY = 330, BY = 490, MY = (FY + BY) / 2;
  const capX = X0 + n * (SW + GAP) - GAP / 2;
  const W = capX + 330, H = BY + 100;
  const svgEl = ctx.svgRoot(W, H, { class: 'view-svg lens-svg' });
  const defs = S('defs', {});
  const mk = (id, color) => S('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, markerUnits: 'userSpaceOnUse', orient: 'auto' }, S('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }));
  defs.append(mk('lo-f', FWD), mk('lo-b', BWD), mk('lo-g', '#8a929c'));
  svgEl.append(defs, S('rect', { x: 0, y: 0, width: W, height: H, fill: T.PAPER }));

  const anchors = {}; // member ("payment/do_reserve") -> {x, y}
  const layer = { boxes: S('g', {}), lanes: S('g', {}), sync: S('g', {}), marks: S('g', {}), top: S('g', {}) };
  svgEl.append(layer.boxes, layer.lanes, layer.sync, layer.top, layer.marks);

  const portFor = (s, tid) => s.ports.find((p) => p.target === 'transition' && p.transition === tid);
  const flatInfo = (m) => { const f = flatOf(flat.map, m); return f ? tById[f] : null; };

  // A transition square: a transition port where the subnet exports one (draggable), otherwise plain.
  const square = (s, tid, x, y, color, role, extraFacts = []) => {
    const g = S('g', { class: 'lo-t' });
    g.append(S('rect', { x: x - 9, y: y - 9, width: 18, height: 18, rx: 2, fill: '#fff', stroke: color, 'stroke-width': 1.8 }),
      S('text', { x, y: y + 22, 'font-size': 10.5, 'text-anchor': 'middle', class: 'mono halo' }, tid));
    const member = `${s.id}/${tid}`;
    anchors[member] = { x, y };
    const f = flatInfo(member);
    const base = ctx.info.transitionInfo(s, tid);
    ctx.hover(g, { ...base, facts: [...base.facts, ['lens role', role], ['flat transition', f ? f.id : '?'], f && f.members.length > 1 ? ['fires with', f.members.filter((x) => x !== member).join(', ')] : null, ...extraFacts].filter(Boolean), cites: [...(base.cites || []), ...FLATTEN_CITES] });
    const port = portFor(s, tid);
    if (port) ctx.snap.port(g, { subnet: s.id, port: port.id });
    return g;
  };
  const circle = (s, pid, x, y, color, role, extraFacts = []) => {
    const p = s.places.find((q) => q.id === pid);
    const g = S('g', {});
    g.append(S('circle', { cx: x, cy: y, r: 8, fill: '#fff', stroke: color, 'stroke-width': 1.6 }),
      p && p.initial ? S('circle', { cx: x, cy: y, r: 2.6, fill: T.INK }) : null,
      S('text', { x, y: y + 21, 'font-size': 10, 'text-anchor': 'middle', class: 'mono muted halo' }, pid));
    const base = ctx.info.placeInfo(s, pid);
    ctx.hover(g, { ...base, facts: [...(base.facts || []), ['lens role', role], ...extraFacts] });
    const port = s.ports.find((q) => q.target === 'place' && q.place === pid);
    if (port) ctx.snap.port(g, { subnet: s.id, port: port.id });
    return g;
  };
  const label = (x, y, text, color, anchor = 'middle') => S('text', { x, y, 'font-size': 10.5, 'text-anchor': anchor, fill: color, class: 'mono halo' }, text);

  // --- the saga chain: one lens box per step, then the turnaround ---
  layer.boxes.append(S('text', { x: X0 - 40, y: FY - 78, 'font-size': 12.5, 'font-weight': 600 }, `${saga.id} (Saga): each step as a lens, chained by the saga's own control places`));
  const pairOf = (tid) => a.pairs.find((p) => p.subnet === saga.id && p.t === tid);
  for (const [i, st] of steps.entries()) {
    const bx = X0 + i * (SW + GAP);
    const cx = bx + SW / 2 + 20;
    const box = S('g', {});
    box.append(S('rect', { x: bx, y: FY - 50, width: SW, height: BY - FY + 100, rx: 10, fill: T.PATTERN_TINT.saga, stroke: '#8a929c', 'stroke-width': 1.3 }),
      S('text', { x: bx + 10, y: FY - 34, 'font-size': 11.5, 'font-weight': 600 }, `step ${st}`));
    ctx.hover(box, { title: `saga step ${st} as a lens`, definition: `Forward: do_${st} takes next_${st} on the forward lane. Backward: undo_${st} takes unwind_${st} on the backward lane. Between them, the residual do_${st} leaves for undo_${st}.`, facts: [['found by', 'bundle.lens pairs: a residual place only do_ produces and only undo_ consumes; undo_ returns what do_ moved on the accounts'], ['assumption', 'this pair is read as a lens; the saga constructor builds it inside one subnet (pflow-compose\'s port of Saga.ToMetaSubnet), so no link rule checks it']], cites: saga.cites });
    layer.boxes.append(box);
    const p = pairOf(`do_${st}`);
    if (p) ctx.emit('pair', `${p.subnet}/${p.t}->${p.u}`, {});
    layer.top.append(square(saga, `do_${st}`, cx, FY, FWD, 'forward map (get)'), square(saga, `undo_${st}`, cx, BY, BWD, 'backward map (put)'));
    (p ? p.residuals : []).forEach((r, k, all) => {
      const rx = cx + (k - (all.length - 1) / 2) * 92;
      layer.lanes.append(S('path', { d: `M${cx},${FY + 10} C${cx},${MY - 20} ${rx},${MY - 30} ${rx},${MY - 9}`, stroke: '#8a929c', 'stroke-dasharray': '3 3', fill: 'none', 'marker-end': 'url(#lo-g)' }),
        S('path', { d: `M${rx},${MY + 9} C${rx},${MY + 30} ${cx},${MY + 20} ${cx},${BY - 10}`, stroke: '#8a929c', 'stroke-dasharray': '3 3', fill: 'none', 'marker-end': 'url(#lo-g)' }));
      layer.top.append(circle(saga, r, rx, MY, '#8a929c', 'residual: what the forward map leaves for the backward map', [['produced only by', `do_${st}`], ['consumed only by', `undo_${st}`]]));
    });
    // fail_<step>: the forward lane turns back here, before the step runs.
    const fx = bx + 26;
    layer.lanes.append(S('path', { d: `M${fx},${FY} V${BY}`, stroke: FAIL, 'stroke-width': 1.4, 'stroke-dasharray': '5 4', fill: 'none' }));
    layer.top.append(square(saga, `fail_${st}`, fx, MY, FAIL, 'turnaround: takes the forward input, gives the backward output (no lens map does this)', [['why it matters', 'a lens\'s forward map always gives a forward output; fail_ turns back instead, so the saga is a lens only on runs where no step fails']]));
    // lane labels between boxes
    const nextLabel = i + 1 < n ? `next_${steps[i + 1]}` : 'committing';
    layer.lanes.append(label(bx + SW + GAP / 2, FY - 8, nextLabel, FWD), label(bx + SW + GAP / 2, BY - 8, `unwind_${st}`, BWD));
  }
  // lanes
  layer.lanes.append(S('path', { d: `M${X0 - 70},${FY} H${capX + 40}`, stroke: FWD, 'stroke-width': 2.2, fill: 'none', 'marker-end': 'url(#lo-f)' }),
    S('path', { d: `M${capX + 40},${BY} H${X0 - 62}`, stroke: BWD, 'stroke-width': 2.2, fill: 'none', 'marker-end': 'url(#lo-b)' }),
    label(X0 - 60, FY - 8, `next_${steps[0]}`, FWD, 'start'),
    S('text', { x: X0 - 70, y: FY + 34, 'font-size': 10.5, fill: FWD, 'font-weight': 600 }, 'forward →'),
    S('text', { x: X0 - 70, y: BY + 34, 'font-size': 10.5, fill: BWD, 'font-weight': 600 }, '← backward'));
  layer.top.append(circle(saga, 'rolled_back', X0 - 78, BY, T.schemaColor('saga:outcome'), 'the backward lane\'s output'));
  // the turnaround: commit leaves forward, fail_commit turns back
  const tx = capX + 80;
  layer.lanes.append(S('path', { d: `M${capX + 40},${FY} H${tx - 10}`, stroke: FWD, 'stroke-width': 2.2, fill: 'none' }),
    S('path', { d: `M${capX + 40},${FY} C${capX + 60},${FY} ${tx - 20},${MY} ${tx - 10},${MY}`, stroke: FAIL, 'stroke-width': 1.6, 'stroke-dasharray': '5 4', fill: 'none' }),
    S('path', { d: `M${tx},${MY + 10} C${tx},${BY} ${capX + 60},${BY} ${capX + 40},${BY}`, stroke: BWD, 'stroke-width': 2.2, fill: 'none' }));
  layer.top.append(square(saga, 'commit', tx, FY, FWD, 'the forward pass ends: final acknowledgement'),
    square(saga, 'fail_commit', tx, MY, FAIL, 'turnaround: the forward pass is sent back (the refund begins)'),
    circle(saga, 'completed', tx + 70, FY, T.schemaColor('saga:outcome'), 'the forward lane\'s output'));
  layer.lanes.append(S('path', { d: `M${tx + 10},${FY} H${tx + 60}`, stroke: FWD, 'stroke-width': 2.2, fill: 'none', 'marker-end': 'url(#lo-f)' }));

  // --- the other instances' pairs, above the step their forward map fires with ---
  const sagaAnchorOf = (member) => {
    const f = flatInfo(member);
    if (!f) return null;
    const m = f.members.find((x) => x.startsWith(`${saga.id}/`) && anchors[x]);
    return m ? { member: m, ...anchors[m] } : null;
  };
  const others = [];
  for (const [t, p] of Object.entries(a.partner)) if (!t.startsWith(`${saga.id}/`)) others.push({ t, u: p.u, p, trip: false });
  for (const r of a.roundTrips) if (!r.t.startsWith(`${saga.id}/`)) others.push({ t: r.t, u: r.u, p: r, trip: true });
  const groups = new Map();
  for (const o of others) {
    const an = sagaAnchorOf(o.t);
    const key = an ? an.member : '_none';
    if (!groups.has(key)) groups.set(key, { an, items: [] });
    groups.get(key).items.push(o);
  }
  const BW = 150, BT = 70, BH = 150;
  let freeX = X0;
  for (const { an, items } of groups.values()) {
    const total = items.length * BW + (items.length - 1) * 16;
    let x = an ? an.x - total / 2 : freeX;
    if (!an) freeX += total + 20;
    for (const o of items) {
      const [sid, tid] = o.t.split('/');
      const uid = o.u.split('/')[1];
      const s = byId[sid];
      const cx = x + BW / 2;
      const g = S('g', {});
      g.append(S('rect', { x, y: BT, width: BW, height: BH, rx: 9, fill: T.PATTERN_TINT[s.pattern] || '#fff', stroke: '#8a929c', 'stroke-width': 1.2 }),
        S('text', { x: x + 8, y: BT + 15, 'font-size': 11, 'font-weight': 600 }, `${sid} (${s.pattern})`));
      ctx.hover(g, ctx.info.subnetInfo(s));
      layer.boxes.append(g);
      const ty = BT + 42, uy = BT + BH - 30, ry = (ty + uy) / 2;
      ctx.emit('pair', `${sid}/${tid}->${uid}`, {});
      layer.top.append(square(s, tid, cx - 30, ty, FWD, 'forward map', [['backward map', uid]]),
        square(s, uid, cx - 30, uy, BWD, o.trip ? 'backward map, but it fires on the forward pass' : 'backward map', [['forward map', tid]]));
      for (const r of o.p.residuals) layer.top.append(circle(s, r, cx + 2, ry, '#8a929c', 'residual', [['produced only by', tid], ['consumed only by', uid]]));
      layer.lanes.append(S('path', { d: `M${cx - 30},${ty + 10} V${uy - 10}`, stroke: '#8a929c', 'stroke-dasharray': '3 3', fill: 'none', 'marker-end': 'url(#lo-g)' }));
      x += BW + 16;
    }
  }

  // --- fusion lines: every flat transition that joins a drawn non-saga transition to the saga ---
  const drawnOther = Object.keys(anchors).filter((m) => !m.startsWith(`${saga.id}/`));
  const linksFor = (f) => ctx.orders.links.filter((l) => {
    const end = (r) => { const s = byId[r.subnet]; const p = s?.ports.find((q) => q.id === r.port); return p && p.transition ? `${r.subnet}/${p.transition}` : null; };
    return l.kind === 'event' && f.members.includes(end(l.from)) && f.members.includes(end(l.to));
  });
  for (const m of drawnOther) {
    const f = flatInfo(m);
    const from = anchors[m];
    const sagaMembers = f ? f.members.filter((x) => x.startsWith(`${saga.id}/`) && anchors[x]) : [];
    if (!sagaMembers.length) {
      const g = S('g', { class: 'lo-sync' });
      g.append(S('path', { d: `M${from.x + 10},${from.y} h22`, stroke: '#9aa3ad', 'stroke-dasharray': '2 3', fill: 'none' }),
        S('text', { x: from.x, y: from.y + 36, 'font-size': 9.5, 'text-anchor': 'middle', class: 'muted halo' }, 'fires alone: no link'));
      ctx.hover(g, { title: `${m} is linked to nothing`, definition: 'No event link fuses it, so nothing in the saga fires it.', facts: [['flat transition', f ? f.id : '?']], cites: FLATTEN_CITES });
      layer.sync.append(g);
      continue;
    }
    for (const sm of sagaMembers) {
      const to = anchors[sm];
      const g = S('g', { class: 'lo-sync' });
      g.append(S('path', { d: `M${from.x + 9},${from.y + 4} C${from.x + 60},${from.y + 60} ${to.x - 40},${to.y - 70} ${to.x},${to.y - 10}`, stroke: EV, 'stroke-width': 1.8, fill: 'none' }),
        S('text', { x: (from.x + to.x) / 2 + 6, y: (from.y + to.y) / 2, 'font-size': 12, fill: EV }, '⊗'));
      g.dataset.loSync = `${m}|${sm}`;
      const info = ctx.info.flatTransitionInfo(f);
      const ls = linksFor(f);
      ctx.hover(g, { ...info, title: `fused: ${m} ⊗ ${sm}`, facts: [...info.facts, ['event links in this class', ls.map((l) => `${l.from.subnet}:${l.from.port} ⊗ ${l.to.subnet}:${l.to.port}`).join(', ') || 'none directly; joined through the class (union-find)']] });
      layer.sync.append(g);
    }
  }

  // --- where the composite stops being a lens ---
  const ring = (x, y, lines, info) => {
    const g = S('g', {});
    g.append(S('circle', { cx: x, cy: y, r: 17, fill: 'none', stroke: T.LEAK, 'stroke-width': 1.8, 'stroke-dasharray': '4 3' }),
      ...lines.map((ln, i) => S('text', { x: x + 22, y: y + 30 + i * 13, 'font-size': 10, fill: T.LEAK, class: 'halo' }, ln)));
    ctx.hover(g, info);
    layer.marks.append(g);
  };
  for (const s of a.steps) {
    const fwdSaga = tById[s.flat].members.find((x) => x.startsWith(`${saga.id}/`) && anchors[x]);
    if (s.deadForward && fwdSaga) {
      const at = anchors[fwdSaga];
      ring(at.x, at.y, [`✗ ${s.flat.length > 40 ? 'this rendezvous' : s.flat} can never fire:`, `needs ${s.deadForward.places.map((p) => p.split('/')[1]).join(' + ')};`, `${s.deadForward.constraint.split('/')[1]} allows one`],
        { title: 'dead rendezvous', definition: `${s.flat} needs a token on each of ${s.deadForward.places.join(', ')}; the declared invariant ${s.deadForward.constraint} keeps exactly one token among them.`, facts: [['decided by', 'bundle.lens (dead_forward) on the flat net; the scenario run stops here too']], cites: [...FLATTEN_CITES, ...saga.cites] });
    }
    const back = [...s.back.map((b) => ({ u: b.u, uFlat: b.uFlat, why: 'fires on its own' })),
      ...s.trips.filter((r) => r.tFlat === s.flat).map((r) => ({ u: r.u, uFlat: r.uFlat, why: `fires on the forward pass (${r.uFlat})` }))];
    const target = back.find((b) => b.u.startsWith(`${saga.id}/`));
    if (!target || back.length < 2) continue;
    const missing = back.filter((b) => b.uFlat !== target.uFlat);
    if (!missing.length) continue;
    const at = anchors[target.u];
    ring(at.x, at.y, [`✗ lens composition needs ${missing.map((b) => b.u.split('/')[1]).join(', ')} here,`, 'firing with ' + target.u.split('/')[1] + ', as their forward maps fire together;', ...missing.map((b) => `${b.u}: ${b.why}`)],
      { title: 'where the composite stops being a lens', definition: `Going forward, ${s.flat} fires ${s.members.join(', ')} as one. A lens composite would fire their backward maps as one on the way back; here they are ${[...new Set(back.map((b) => b.uFlat))].join('; ')}.`, facts: [['decided by', 'bundle.lens on the flat net (Flatten\'s classes)'], ['fix with a link?', 'an event link only adds a rendezvous: fusing release with undo_reserve as well as commit makes one transition that needs both, and saga_control allows one (try it: drag undo:reserve to release)']], cites: FLATTEN_CITES });
  }

  ctx.emit('verdict', 'strict', { holds: !!a.holds, glued: a.glued, legal_token: a.legal.token, legal_data: a.legal.data });
  ctx.root.appendChild(svgEl);
  renderVerdict(ctx, a);
  animateLinks(ctx, svgEl);
  ctx.note('Assumption (fallback): the pairs drawn as lenses were found mechanically (a residual only t produces and only u consumes; u returns what t moved on resource places), and the forward pass is the "commit" scenario\'s run (judgment, frozen). Inside the saga the chain is the saga constructor\'s own (pflow-compose); across instances only the flat net decides what fires together. The red rings are where that fails to be lens composition.', 'honesty');
  if (ctx.orders.subnets.some((s) => s.extra)) ctx.note('Added instances count in the check; only those fused with the first saga are drawn above it.', 'na');
}

/** "Can one link fix it?": every repair bundle.lens tries, with what the flat net then does. */
function fixTable(ctx, a) {
  const E = ctx.el;
  const fixes = a.fixes || [];
  if (!fixes.length) return null;
  const rows = fixes.map((x) => {
    const r = x.result;
    const what = `${x.how === 'add' ? 'add' : 'move to'} ${x.link.from.subnet}:${x.link.from.port} ⊗ ${x.link.to.subnet}:${x.link.to.port}${x.removed.length ? ` (drop ${x.removed.map((l) => `${l.from.port} ⊗ ${l.to.port}`).join(', ')})` : ''}`;
    ctx.emit('fix', `${x.how}:${x.u}`, { holds: !!(r && r.holds) });
    const runs = !x.legal ? E('span', { class: 'lo-no' }, `refused by the link rules${x.verdict && x.verdict.errors ? ` (${x.verdict.errors.map((e) => e.code).join(', ')})` : ''}`)
      : !r ? E('span', { class: 'lo-no' }, 'does not flatten')
      : E('span', {}, ...r.runs.map((run, i) => {
        const bad = run.expect.filter((e) => !e.ok);
        return E('span', {}, i ? ' · ' : '', `${run.id} `, bad.length ? E('span', { class: 'lo-no' }, `✗ ${run.stoppedStep ? `stops at ${run.stoppedStep}` : bad.map((e) => e.says).join('; ')}`) : E('span', { class: 'lo-ok' }, '✓'));
      }));
    const dead = r && r.steps.find((s) => s.deadForward);
    return E('tr', {}, E('td', { class: 'mono' }, what), E('td', {}, runs, dead ? E('div', { class: 'lo-no' }, `${dead.flat} is dead: ${dead.deadForward.constraint} allows one of ${dead.deadForward.places.join(', ')}`) : null),
      E('td', {}, r && r.holds ? E('span', { class: 'lo-ok' }, '✓ a lens') : E('span', { class: 'lo-no' }, '✗')));
  });
  return E('div', { class: 'lo-verdict' },
    E('b', {}, 'Can one link fix it? '), 'Each repair below is validated by the registry\'s link rules, flattened, and the scenarios re-run (bundle.lens). An event link only adds a rendezvous (all members fire as one); a lens needs the pool released on either outcome, which is a choice no link kind expresses.',
    E('table', {}, E('tr', {}, E('th', {}, 'repair'), E('th', {}, 'scenarios after it'), E('th', {}, 'lens?')), ...rows));
}

function renderVerdict(ctx, a) {
  const E = ctx.el;
  const rows = a.steps.map((s) => {
    const back = [...s.back.map((b) => `${b.u} (${b.uFlat === b.u ? 'alone' : b.uFlat})`), ...s.trips.filter((r) => r.tFlat === s.flat).map((r) => `${r.u} (forward: ${r.uFlat})`)];
    const verdict = s.deadForward ? E('span', { class: 'lo-no' }, `✗ dead (${s.deadForward.constraint})`)
      : s.composes && !s.trips.some((r) => r.tFlat === s.flat) ? E('span', { class: 'lo-ok' }, '✓ composes')
      : s.noBackward && !s.trips.some((r) => r.tFlat === s.flat) ? E('span', {}, '— no backward map (the turnaround)')
      : E('span', { class: 'lo-no' }, '✗ backward maps do not fire together');
    ctx.emit('step', s.flat, { composes: !!s.composes, split: !!s.split, dead_forward: s.deadForward ? s.deadForward.constraint : '' });
    return E('tr', {}, E('td', { class: 'mono' }, s.flat), E('td', { class: 'mono' }, back.join(', ') || '—'), E('td', {}, verdict));
  });
  const runs = a.runs.map((r) => E('tr', {}, E('td', {}, r.title), E('td', { class: 'mono' }, r.expect.map((e) => `${e.place}=${e.got}`).join(', ')),
    E('td', {}, r.expect.every((e) => e.ok) ? E('span', { class: 'lo-ok' }, '✓') : E('span', { class: 'lo-no' }, `✗ ${r.expect.filter((e) => !e.ok).map((e) => e.says).join('; ')}${r.stoppedStep ? ` (stopped at ${r.stoppedStep})` : ''}`))));
  const box = E('div', { class: 'lo-verdict' },
    E('b', {}, mode === 'strict' ? 'Step by step, on the commit run (bundle.lens):' : a.holds ? 'The assumed lenses compose.' : 'The assumed lenses do not compose into one lens.'),
    E('table', {}, E('tr', {}, E('th', {}, 'forward rendezvous (commit run)'), E('th', {}, 'its backward maps, and where they fire'), E('th', {}, 'lens composition')), ...rows),
    E('table', {}, E('tr', {}, E('th', {}, 'scenario'), E('th', {}, 'end marking'), E('th', {}, 'predicates')), ...runs));
  ctx.root.appendChild(box);
  const fx = fixTable(ctx, a);
  if (fx) ctx.root.appendChild(fx);
}

function animateLinks(ctx, svgEl) {
  const ev = ctx.event;
  if (!ev || ev.type !== 'link-added' || typeof svgEl.animate !== 'function') return;
  for (const g of svgEl.querySelectorAll('.lo-sync')) {
    g.animate([{ opacity: 0 }, { opacity: 1, offset: 0.5 }, { opacity: 0.4, offset: 0.75 }, { opacity: 1 }], { duration: 900 });
  }
}
