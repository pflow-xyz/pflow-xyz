// SNAP-TOGETHER: the one drag interaction every view shares.
//
// A view registers the elements it drew:
//   snap.port(el, {subnet, port})   a port of the orders composition
//   snap.slot(el, slotId)           a slot of the search plan
//   snap.piece(el, pieceName)       a palette piece of the search plan
// Dragging from a port asks the registry (bundle.candidates) which ports a
// link could reach; only those light up, everything else dims, and the rubber
// band only attaches to a lit one. Dragging a piece asks plan.slot_candidates
// the same question about slots. Hovering a dark target says why it is refused
// (the registry's error code and message). A drop calls the state action, which
// runs bundle.add_link / plan.add_piece: the registry validates again before
// anything changes, so an illegal wire cannot be drawn by any path.

import { actions, linkCandidates, slotCandidates } from './state.js';
import { pieceByName, portKey } from './model.js';
import { LINK_STYLE, PIECE_KIND_COLOR } from './theme.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const SNAP_RADIUS = 30;

let overlay, band, bandEnd, tip;
const reg = { ports: new Map(), slots: new Map(), pieces: new Map() };
let drag = null;

export function initSnap() {
  overlay = document.createElementNS(SVGNS, 'svg');
  overlay.setAttribute('class', 'snap-overlay');
  band = document.createElementNS(SVGNS, 'path');
  band.setAttribute('class', 'snap-band');
  bandEnd = document.createElementNS(SVGNS, 'circle');
  bandEnd.setAttribute('r', '6');
  bandEnd.setAttribute('class', 'snap-band-end');
  bandEnd.setAttribute('cx', '-99');
  bandEnd.setAttribute('cy', '-99');
  overlay.append(band, bandEnd);
  document.body.appendChild(overlay);
  tip = document.createElement('div');
  tip.className = 'snap-tip';
  document.body.appendChild(tip);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(); });
}

/** Forget what the last render registered (the app calls this before each render). */
export function resetSnap() {
  reg.ports.clear(); reg.slots.clear(); reg.pieces.clear();
}

function add(map, key, el) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(el);
}

export const snap = {
  port(el, ref) {
    const key = portKey(ref);
    el.dataset.port = key;
    el.classList.add('snap-port');
    add(reg.ports, key, el);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); startPort(ref, el, e); });
  },
  slot(el, slotId, index = null) {
    el.dataset.slot = slotId;
    if (index !== null) el.dataset.slotIndex = index;
    el.classList.add('snap-slot');
    add(reg.slots, slotId, el);
  },
  piece(el, name) {
    el.dataset.piece = name;
    el.classList.add('snap-piece');
    add(reg.pieces, name, el);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); startPiece(name, el, e); });
  },
};

const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const kindColor = (name) => PIECE_KIND_COLOR[pieceByName[name]?.kind] || '#555';

function startPort(ref, el, e) {
  let cands;
  try { cands = linkCandidates(ref); } catch (err) { status(`bundle.candidates refused: ${err.message}`); return; }
  const verdicts = new Map(cands.map((c) => [c.key, c]));
  for (const [key, els] of reg.ports) {
    if (key === portKey(ref)) { els.forEach((x) => x.classList.add('snap-source')); continue; }
    const v = verdicts.get(key);
    for (const x of els) x.classList.add(v && v.ok ? 'snap-legal' : 'snap-illegal');
    if (v && v.ok) for (const x of els) x.style.setProperty('--snap-color', LINK_STYLE[v.link.kind].color);
  }
  document.body.classList.add('snap-dragging');
  drag = { type: 'port', ref, origin: center(el), verdicts, hover: null };
  showBand(e.clientX, e.clientY, '#888');
  countLegal(cands.filter((c) => c.ok && reg.ports.has(c.key)).length, 'port');
}

function startPiece(name, el, e) {
  let cands;
  try { cands = slotCandidates(name); } catch (err) { status(`plan.slot_candidates refused: ${err.message}`); return; }
  const verdicts = new Map(cands.map((c) => [c.slot, c]));
  for (const [slot, els] of reg.slots) {
    const v = verdicts.get(slot);
    for (const x of els) x.classList.add(v && v.ok ? 'snap-legal' : 'snap-illegal');
    for (const x of els) x.style.setProperty('--snap-color', kindColor(name));
  }
  (reg.pieces.get(name) || []).forEach((x) => x.classList.add('snap-source'));
  document.body.classList.add('snap-dragging');
  drag = { type: 'piece', name, origin: center(el), verdicts, hover: null };
  showBand(e.clientX, e.clientY, kindColor(name));
  countLegal(cands.filter((c) => c.ok && reg.slots.has(c.slot)).length, 'slot');
}

function status(text) {
  const s = document.querySelector('#snap-status');
  if (s) s.textContent = text;
}

function countLegal(n, what) {
  status(n ? `${n} legal ${what}${n === 1 ? '' : 's'} lit` : `no legal ${what}: the rules refuse every target (hover one to see why)`);
}

function nearest(map, x, y, pred) {
  let best = null, bd = Infinity;
  for (const [key, els] of map) for (const el of els) {
    if (!pred(key)) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const inside = x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4;
    const d = inside ? 0 : Math.hypot(cx - x, cy - y);
    if (d < bd) { bd = d; best = { key, el, cx, cy, d }; }
  }
  return best;
}

const errText = (er) => `${er.code ? `${er.code} ` : ''}${String(er.message || er.msg || '').replace(/^links\[\d+\]: /, '').replace(/^link: /, '')}`;

function onMove(e) {
  if (!drag) return;
  const map = drag.type === 'port' ? reg.ports : reg.slots;
  const legal = nearest(map, e.clientX, e.clientY, (k) => drag.verdicts.get(k)?.ok);
  const any = nearest(map, e.clientX, e.clientY, (k) => k !== (drag.type === 'port' ? portKey(drag.ref) : ''));
  if (legal && legal.d <= SNAP_RADIUS) {
    const v = drag.verdicts.get(legal.key);
    drag.hover = legal.key;
    const color = drag.type === 'port' ? LINK_STYLE[v.link.kind].color : kindColor(drag.name);
    showBand(legal.cx, legal.cy, color, false);
    tipAt(e, drag.type === 'port'
      ? `${LINK_STYLE[v.link.kind].glyph} ${v.link.kind} link: ${v.verdict.passed.map((p) => p.text).join('; ')}`
      : `fits the ${v.slot} slot (pflow-rs accepts the plan: plan.slot_candidates)`, 'ok');
    return;
  }
  drag.hover = null;
  if (any && any.d <= 6) {
    const v = drag.verdicts.get(any.key);
    const why = drag.type === 'port'
      ? (v ? v.tried.map((t) => `${t.link.kind}: ${t.verdict.errors.map(errText).join('; ')}`).join(' | ') : 'not a target')
      : (v ? `${v.why}${v.rule ? ` (${v.rule})` : ''}` : 'not a slot');
    showBand(e.clientX, e.clientY, '#c0392b', true);
    tipAt(e, `refused: ${why}`, 'bad');
    return;
  }
  showBand(e.clientX, e.clientY, '#888', false);
  hideTip();
}

function onUp() {
  if (!drag) return;
  const d = drag;
  cancel();
  if (!d.hover) return;
  const v = d.verdicts.get(d.hover);
  if (!v || !v.ok) return;
  if (d.type === 'port') actions.addLink(v.link);
  else actions.addPiece(d.name, v.slot);
}

function cancel() {
  drag = null;
  document.body.classList.remove('snap-dragging');
  for (const map of [reg.ports, reg.slots, reg.pieces]) for (const els of map.values()) for (const x of els) {
    x.classList.remove('snap-legal', 'snap-illegal', 'snap-source');
    x.style.removeProperty('--snap-color');
  }
  band.setAttribute('d', '');
  bandEnd.setAttribute('cx', '-99');
  hideTip();
  status('');
}

function showBand(x, y, color, refused = false) {
  if (!drag) return;
  const o = drag.origin;
  const mx = (o.x + x) / 2;
  band.setAttribute('d', `M${o.x},${o.y} C${mx},${o.y} ${mx},${y} ${x},${y}`);
  band.setAttribute('stroke', color);
  band.setAttribute('stroke-dasharray', refused ? '4 4' : '');
  bandEnd.setAttribute('cx', x);
  bandEnd.setAttribute('cy', y);
  bandEnd.setAttribute('fill', refused ? '#fff' : color);
  bandEnd.setAttribute('stroke', color);
}

function tipAt(e, text, cls) {
  tip.textContent = text;
  tip.className = `snap-tip show ${cls}`;
  tip.style.left = `${Math.min(e.clientX + 14, window.innerWidth - 380)}px`;
  tip.style.top = `${e.clientY + 14}px`;
}
function hideTip() { tip.className = 'snap-tip'; }
