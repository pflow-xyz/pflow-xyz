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
//
// The same thing without a pointer (a11y-link.js): Enter or Space on a focused
// port or piece lights the same targets from the same verdicts; Tab or the arrow
// keys walk the lit ones, R walks the refused ones and says why, Enter links,
// Escape cancels. The lighting, the band and the verdict text are shared with
// the pointer path; only the way a target is chosen differs.

import { actions, linkCandidates, slotCandidates, subnetsById } from './state.js';
import { pieceByName, portKey, parsePortKey, SLOTS } from './model.js';
import { LINK_STYLE, PIECE_KIND_COLOR } from './theme.js';
import { portLegalReason, portRefusal, slotLegalReason, slotRefusal, portTargets, slotTargets } from './verdicts.js';
import * as linkKeys from './a11y-link.js';
import { portLabel, slotLabel, pieceLabel } from './a11y-text.js';
import { announce, requestFocus, linkMode } from './a11y-bus.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const SNAP_RADIUS = 30;

let overlay, band, bandEnd, tip;
const reg = { ports: new Map(), slots: new Map(), pieces: new Map() };
const meta = new WeakMap(); // element -> {type, key, ...}: what the page registered it as
let drag = null;
let kb = null;              // keyboard link mode: {type, originEl, originKey, name?, verdicts, machine}

export function initSnap() {
  overlay = document.createElementNS(SVGNS, 'svg');
  overlay.setAttribute('class', 'snap-overlay');
  overlay.setAttribute('aria-hidden', 'true');
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
  tip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tip);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  // In link mode the keys belong to the machine: it runs first (capture) and, for the keys it
  // takes, keeps them from the page's own shortcuts (number keys, e).
  window.addEventListener('keydown', onKbKey, true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancel(); });
  // Leaving the ports (a click elsewhere, Tab out of the stage) ends link mode.
  window.addEventListener('focusin', (e) => { if (kb && !kbOwns(e.target)) { announce('Linking cancelled.'); cancel(); } });
  // A click on something that takes no focus (plain text, the page background) moves no focus and so
  // would leave the mode on, lit, with the number keys swallowed: a press outside the ports ends it too.
  window.addEventListener('pointerdown', (e) => { if (kb && !kbOwns(e.target)) { announce('Linking cancelled.'); cancel(); } }, true);
}

/** Forget what the last render registered (the app calls this before each render). */
export function resetSnap() {
  if (kb) { announce('Linking cancelled: the view was redrawn.'); cancel(); } // its elements are about to be replaced
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
    meta.set(el, { type: 'port', key, ref });
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); startPort(ref, el, e); });
  },
  slot(el, slotId, index = null) {
    el.dataset.slot = slotId;
    if (index !== null) el.dataset.slotIndex = index;
    el.classList.add('snap-slot');
    add(reg.slots, slotId, el);
    meta.set(el, { type: 'slot', key: slotId });
  },
  piece(el, name) {
    el.dataset.piece = name;
    el.classList.add('snap-piece');
    add(reg.pieces, name, el);
    meta.set(el, { type: 'piece', key: name, name });
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); startPiece(name, el, e); });
  },
};

/** What the last render registered, for the accessibility pass (a11y.js). */
export function registered() { return { ports: reg.ports, slots: reg.slots, pieces: reg.pieces, meta }; }

/** Is keyboard link mode on? (the page's own key shortcuts stand aside while it is) */
export const kbActive = () => kb !== null;

/** Is a link or a drop in progress, by pointer or by keyboard? A redraw would cut it (resetSnap), so a view's background redraw waits (app.js). */
export const gestureActive = () => drag !== null || kb !== null;

const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
const kindColor = (name) => PIECE_KIND_COLOR[pieceByName[name]?.kind] || '#555';

// --- the lighting, shared by the pointer and the keyboard ----------------------------------------

function lightPorts(ref, cands) {
  const verdicts = new Map(cands.map((c) => [c.key, c]));
  for (const [key, els] of reg.ports) {
    if (key === portKey(ref)) { els.forEach((x) => x.classList.add('snap-source')); continue; }
    const v = verdicts.get(key);
    for (const x of els) x.classList.add(v && v.ok ? 'snap-legal' : 'snap-illegal');
    if (v && v.ok) for (const x of els) x.style.setProperty('--snap-color', LINK_STYLE[v.link.kind].color);
  }
  document.body.classList.add('snap-dragging');
  return verdicts;
}

function lightSlots(name, cands) {
  const verdicts = new Map(cands.map((c) => [c.slot, c]));
  for (const [slot, els] of reg.slots) {
    const v = verdicts.get(slot);
    for (const x of els) x.classList.add(v && v.ok ? 'snap-legal' : 'snap-illegal');
    for (const x of els) x.style.setProperty('--snap-color', kindColor(name));
  }
  (reg.pieces.get(name) || []).forEach((x) => x.classList.add('snap-source'));
  document.body.classList.add('snap-dragging');
  return verdicts;
}

function startPort(ref, el, e) {
  if (kb) cancel();
  let cands;
  try { cands = linkCandidates(ref); } catch (err) { status(`bundle.candidates refused: ${err.message}`); return; }
  const verdicts = lightPorts(ref, cands);
  drag = { type: 'port', ref, origin: center(el), verdicts, hover: null };
  showBand(e.clientX, e.clientY, '#888');
  countLegal(cands.filter((c) => c.ok && reg.ports.has(c.key)).length, 'port');
}

function startPiece(name, el, e) {
  if (kb) cancel();
  let cands;
  try { cands = slotCandidates(name); } catch (err) { status(`plan.slot_candidates refused: ${err.message}`); return; }
  const verdicts = lightSlots(name, cands);
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
      ? `${LINK_STYLE[v.link.kind].glyph} ${v.link.kind} link: ${portLegalReason(v)}`
      : slotLegalReason(v), 'ok');
    return;
  }
  drag.hover = null;
  if (any && any.d <= 6) {
    const v = drag.verdicts.get(any.key);
    const why = drag.type === 'port' ? portRefusal(v) : slotRefusal(v);
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

/**
 * In link mode the live region says what each target is; the hint ("Enter starts linking") and the
 * inspector description that elements carry would contradict or repeat it, so they are set aside.
 */
function quiet(on) {
  linkMode.on = on;
  const els = [...reg.ports.values(), ...reg.slots.values(), ...reg.pieces.values()].flat();
  for (const el of els) {
    if (on) {
      const d = el.getAttribute('aria-describedby');
      if (d) { el.dataset.descBy = d; el.removeAttribute('aria-describedby'); }
    } else if (el.dataset.descBy) {
      el.setAttribute('aria-describedby', el.dataset.descBy);
      delete el.dataset.descBy;
    }
  }
}

function cancel() {
  if (kb) quiet(false);
  drag = null;
  kb = null;
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
  const a = drag || kb;
  if (!a) return;
  const o = drag ? drag.origin : center(kb.originEl);
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

// --- the keyboard path --------------------------------------------------------------------------

function portName(key) {
  const { subnet, port } = parsePortKey(key);
  const s = subnetsById()[subnet];
  const p = s && s.ports.find((q) => q.id === port);
  return p ? portLabel(subnet, p) : key;
}
const slotName = (id) => slotLabel(SLOTS.find((s) => s.id === id), id);

/**
 * Enter or Space on a focused port or palette piece: light its targets (the same
 * verdicts a drag uses) and hand the keys to the link machine. Returns whether
 * link mode started.
 */
export function startKeyboard(el) {
  const m = meta.get(el);
  if (!m || (m.type !== 'port' && m.type !== 'piece')) return false;
  if (drag || kb) cancel();
  let cands, targets, originLabel, noun;
  if (m.type === 'port') {
    try { cands = linkCandidates(m.ref); } catch (err) { status(`bundle.candidates refused: ${err.message}`); announce(`Cannot link from ${m.key}: ${err.message}`); return false; }
    targets = portTargets(cands, { has: (k) => reg.ports.has(k), label: portName });
    originLabel = portName(m.key);
    noun = 'port';
  } else {
    try { cands = slotCandidates(m.name); } catch (err) { status(`plan.slot_candidates refused: ${err.message}`); announce(`Cannot place ${m.name}: ${err.message}`); return false; }
    targets = slotTargets(cands, { has: (k) => reg.slots.has(k), label: slotName });
    originLabel = pieceLabel(pieceByName[m.name] || { name: m.name, kind: '' });
    noun = 'slot';
  }
  // The key the origin is found by after a redraw: the one the accessibility pass gave it (an element
  // drawn twice has key#2), else its registered key.
  const originKey = el.dataset.a11yKey || `${m.type}:${m.key}`;
  const r = linkKeys.begin({ noun, originKey, originLabel, targets });
  if (r.state.phase !== 'linking') { announce(r.announce); return false; } // nothing drawn to link to: light nothing
  const verdicts = m.type === 'port' ? lightPorts(m.ref, cands) : lightSlots(m.name, cands);
  kb = { type: m.type, originEl: el, name: m.name, verdicts, machine: r.state, ref: m.ref };
  quiet(true);
  const first = center(el);
  showBand(first.x, first.y, m.type === 'port' ? '#888' : kindColor(m.name));
  say(r.announce);
  return true;
}

function say(text) { if (text) { status(text); announce(text); } }

/** The element(s) a target key stands for in the current render. */
const targetEls = (key) => (kb.type === 'port' ? reg.ports : reg.slots).get(key) || [];

/** Does focus on `el` belong to link mode (the origin or one of its targets)? */
function kbOwns(el) {
  if (!kb) return false;
  // the thing itself or, for a press, something drawn inside it
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    if (n === kb.originEl) return true;
    const m = meta.get(n);
    if (m) return kb.type === 'port' ? m.type === 'port' : m.type === 'slot';
  }
  return false;
}

function onKbKey(e) {
  if (!kb) return;
  const r = linkKeys.press(kb.machine, e);
  if (!r.handled) return;
  e.preventDefault();
  e.stopPropagation();
  kb.machine = r.state;
  say(r.announce);
  for (const fx of r.effects) {
    if (fx.type === 'focus') focusTarget(fx.key);
    else if (fx.type === 'commit') commit(fx.key);
    else if (fx.type === 'end') end();
  }
}

function focusTarget(key) {
  const els = targetEls(key);
  const t = els[0];
  if (!t) return;
  const v = kb.verdicts.get(key);
  const ok = !!(v && v.ok);
  t.focus(); // may scroll the stage, so measure after
  const c = center(t);
  showBand(c.x, c.y, !ok ? '#c0392b' : kb.type === 'port' ? LINK_STYLE[v.link.kind].color : kindColor(kb.name), !ok);
}

function commit(key) {
  const v = kb.verdicts.get(key);
  if (!v || !v.ok) return;
  // The commit redraws the stage in a microtask; ask for focus back on the origin by key.
  requestFocus(kb.machine.originKey);
  // The registry validates again inside the action; the announcement of the result comes from the
  // state event (app.js -> a11y.afterRender), the same for a drag and a key.
  if (kb.type === 'port') actions.addLink(v.link);
  else actions.addPiece(kb.name, v.slot);
}

function end() {
  const el = kb && kb.originEl;
  cancel();
  // Back to the origin: still in the page after a cancel, redrawn (and found again by key) after a commit.
  if (el && el.isConnected) el.focus();
}
