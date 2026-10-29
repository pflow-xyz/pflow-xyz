// Hover inspector: every drawn piece names the ontology concept it stands for
// and where that fact comes from.
//
// info = {
//   title,                         // what it is, in a few words
//   concept: {iri, types: []},     // ontology term (IRI) and its classes, e.g. ns:PatternPort
//   definition,                    // the ontology's own words, if any
//   facts: [[label, value]],       // kind, schema, net kind, initial marking ...
//   cites: [cite],                 // file:line@rev (sources.js cite())
//   bib: [key],                    // papers (sources.js BIB)
//   caveats: [text],               // ns:caveat, verbatim
//   note,                          // anything the view must add (e.g. "analogy of shape only")
// }

import { el } from './dom.js';
import { citeLabel, citeURL, bibLabel, bibURL } from './sources.js';
import { describeInfo, initialInspector, reduceInspector, shortIri, isNestedControl } from './a11y-inspect.js';
import { uniqueKeys } from './a11y-text.js';
import { announce, linkMode } from './a11y-bus.js';

// Hover is not the only way in. Hover and keyboard focus SHOW an info in the panel (unless one is
// pinned); a click, a tap, Enter or I PINS it; a second click or tap, Escape or the close button
// dismisses it (a11y-inspect.js is the reducer). Focus never gets trapped: the panel is ordinary
// content after the stage, and a pin is released with Escape.

let panel, tip, desc, card;
let inspector = initialInspector();
const infos = new WeakMap();   // node -> its info
const DESC_ID = 'insp-desc';

const HINT = 'Hover or focus any box, port, wire, spider or slot to see the ontology concept it stands for and the source line that says so. Click, tap or press Enter to pin it; Escape, a second tap or the Dismiss button lets go.';

export function initInspector(panelEl) {
  panel = panelEl;
  card = panelEl.closest('#inspector') || panelEl.parentElement;
  desc = document.getElementById(DESC_ID);
  if (!desc) {
    desc = document.createElement('div');
    desc.id = DESC_ID;
    desc.className = 'sr-only';
    document.body.appendChild(desc);
  }
  tip = document.createElement('div');
  tip.className = 'hover-tip';
  tip.setAttribute('aria-hidden', 'true'); // what hover shows, focus says through the panel and aria-describedby
  document.body.appendChild(tip);
  clear();
}

const short = shortIri;
const idOf = (info) => `${info.title || ''}|${info.concept ? info.concept.iri : ''}`;

/**
 * The things drawn now, in page order, with an id each: the title and concept, then `#2`, `#3` for
 * equally titled ones. Two things can share a title and say different things, so a tap on the second
 * must not read as a second tap on the first; and the id is the same after a redraw, so a pin
 * survives the edits that leave its thing in place (and can tell when its thing is gone).
 */
function thingsNow() {
  const nodes = [...document.querySelectorAll('.inspectable')].filter((n) => infos.has(n));
  const ids = uniqueKeys(nodes.map((n) => idOf(infos.get(n))));
  return { nodes, ids };
}
const idOfNode = (node, info) => {
  const { nodes, ids } = thingsNow();
  const i = nodes.indexOf(node);
  return i >= 0 ? ids[i] : `${idOf(info)}#detached`; // a node already out of the page (it cannot be found again)
};

export function renderInfo(info, { pinned = false } = {}) {
  const c = info.concept;
  return el('div', { class: 'insp' },
    pinned ? el('button', { class: 'insp-close', type: 'button', onclick: (e) => dismiss({ byKey: e.detail === 0 }), title: 'Dismiss the pinned inspector (Escape)' }, 'Dismiss ✕') : null,
    el('div', { class: 'insp-title' }, info.title || ''),
    c && el('div', { class: 'insp-concept' },
      el('code', { title: c.iri }, short(c.iri)),
      c.types && c.types.length ? el('span', { class: 'insp-types' }, ' a ', c.types.join(', ')) : null,
      c.iri.includes('/pattern/') || c.iri.includes('/linkkind/') ? el('span', { class: 'insp-unserved', title: 'Pattern and link-kind IRIs are minted in ns/patterns.ttl but not yet served at ontology.pflow.xyz' }, ' (IRI not yet served)') : null),
    info.definition && el('p', { class: 'insp-def' }, info.definition),
    info.facts && info.facts.length ? el('dl', { class: 'insp-facts' }, info.facts.map(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])) : null,
    info.note && el('p', { class: 'insp-note' }, info.note),
    info.caveats && info.caveats.length ? el('details', { class: 'insp-caveats' }, el('summary', {}, `caveats (${info.caveats.length}, ns:caveat)`), el('ul', {}, info.caveats.map((t) => el('li', {}, t)))) : null,
    info.cites && info.cites.length ? el('ul', { class: 'insp-cites' }, info.cites.map((ct) => {
      const url = citeURL(ct);
      const label = citeLabel(ct);
      return el('li', {}, url ? el('a', { href: url, target: '_blank', rel: 'noopener' }, label) : el('span', { title: 'private repo: file and line only' }, label), ct.note ? el('span', { class: 'insp-cite-note' }, ` — ${ct.note}`) : null);
    })) : null,
    info.bib && info.bib.length ? el('ul', { class: 'insp-bib' }, info.bib.map((k) => {
      const url = bibURL(k);
      return el('li', {}, url ? el('a', { href: url, target: '_blank', rel: 'noopener' }, bibLabel(k)) : bibLabel(k));
    })) : null,
  );
}

function show(info, e) {
  const r = reduceInspector(inspector, { type: 'show', id: idOf(info) });
  inspector = r.state;
  if (r.effect === 'show') panel.replaceChildren(renderInfo(info));
  // A finger does not hover: the tip would be left on screen after the tap, over the pinned sheet's title.
  if (e.pointerType === 'touch') return;
  tip.replaceChildren(el('b', {}, info.title || ''), el('code', {}, info.concept ? ` ${short(info.concept.iri)}` : ''));
  tip.className = 'hover-tip show';
  move(e);
}
function move(e) {
  tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 320)}px`;
  tip.style.top = `${e.clientY + 16}px`;
}
function hide() { tip.className = 'hover-tip'; }

export function clear() {
  inspector = initialInspector();
  panel.replaceChildren(el('p', { class: 'muted' }, HINT));
  card && card.classList.remove('has-pin');
}

function applyEffect(r, info) {
  inspector = r.state;
  if (r.effect === 'pin') {
    hide(); // the panel (or, on a narrow screen, the sheet) says it now; the short tip would only sit on top of it
    panel.replaceChildren(renderInfo(info, { pinned: true }));
    panel.querySelector('.insp')?.classList.add('pinned');
    card && card.classList.add('has-pin');
  } else if (r.effect === 'unpin') clear();
  announce(r.announce);
}

/**
 * The panel's own Dismiss button. The button goes with the pin, so a keyboard user would be dropped on
 * <body>: focus returns to the thing that was pinned (`byKey`: a key pressed it, not a pointer).
 */
function dismiss({ byKey = false } = {}) {
  const back = byKey ? pinnedNode() : null;
  const r = reduceInspector(inspector, { type: 'dismiss' });
  if (r.handled) applyEffect(r, null);
  if (back && back.isConnected) back.focus();
  return r.handled;
}

/** The node the pin is on, if it is still drawn. */
function pinnedNode() {
  if (inspector.pinned === null) return null;
  const { nodes, ids } = thingsNow();
  const i = ids.indexOf(inspector.pinned);
  return i >= 0 ? nodes[i] : null;
}

/**
 * After a redraw: a pin whose thing is no longer drawn (the link it described was removed, the piece
 * was taken out) is released, so the panel does not describe something that is gone. A pin on a thing
 * that is still there stays. Returns whether it released.
 */
export function syncPin() {
  if (inspector.pinned === null || pinnedNode()) return false;
  const r = reduceInspector(inspector, { type: 'gone' });
  if (r.handled) applyEffect(r, null);
  return r.handled;
}

/** Escape: let go of a pinned inspector. False when nothing was pinned (the key is not ours). */
export function dismissPinned() {
  const r = reduceInspector(inspector, { type: 'escape' });
  if (r.handled) applyEffect(r, null);
  return r.handled;
}

/** The info a node was given (a11y.js reads it to name the node). */
export const infoOf = (node) => infos.get(node) || null;

/**
 * Pin the node's info, or let go of it when it is the one pinned: click, tap, Enter, I.
 * `reveal`: scroll the panel into view (the keyboard has no pointer to show where it went).
 */
export function activate(node, { reveal = false } = {}) {
  const info = infos.get(node);
  if (!info) return;
  const r = reduceInspector(inspector, { type: 'activate', id: idOfNode(node, info), title: info.title });
  applyEffect(r, info);
  if (reveal && r.effect === 'pin' && card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Keyboard focus: the panel shows it (unless pinned) and a screen reader hears it described.
function focused(node, info) {
  const r = reduceInspector(inspector, { type: 'show', id: idOf(info) });
  inspector = r.state;
  if (r.effect === 'show') panel.replaceChildren(renderInfo(info));
  // The panel may be below the fold of the side column: the same short tip hover shows, at the element.
  const b = node.getBoundingClientRect();
  tip.replaceChildren(el('b', {}, info.title || ''), el('code', {}, info.concept ? ` ${short(info.concept.iri)}` : ''));
  tip.className = 'hover-tip show';
  tip.style.left = `${Math.max(4, Math.min(b.left, window.innerWidth - 320))}px`;
  tip.style.top = `${Math.min(b.bottom + 8, window.innerHeight - 40)}px`;
  if (linkMode.on) return; // link mode: the live region speaks (snap.js)
  desc.textContent = describeInfo(info);
  const ids = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== DESC_ID);
  node.setAttribute('aria-describedby', [DESC_ID, ...ids].join(' '));
}
function blurred(node) {
  hide();
  const ids = (node.getAttribute('aria-describedby') || '').split(/\s+/).filter((x) => x && x !== DESC_ID);
  if (ids.length) node.setAttribute('aria-describedby', ids.join(' ')); else node.removeAttribute('aria-describedby');
}

/** Attach inspector info to an element (SVG or HTML). */
export function hover(node, info) {
  node.classList.add('inspectable');
  infos.set(node, info);
  node.addEventListener('pointerenter', (e) => show(info, e));
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', hide);
  node.addEventListener('focus', () => focused(node, info));
  node.addEventListener('blur', () => blurred(node));
  node.addEventListener('click', (e) => {
    if (e.defaultPrevented || handled.has(e)) return;
    // A button or link inside the thing (Retry in the Laws status bar, "Assume a backward pass") does its own work:
    // it is not a click on the thing, and the inspector must not pin it as well.
    if (isNestedControl(chainTo(e.target, node))) return;
    // Nested inspectable things all see the same click as it bubbles: the innermost one (the thing
    // that was clicked, and the one hover showed) takes it.
    handled.add(e);
    activate(node);
  });
}

const handled = new WeakSet();

/** The click's target and its ancestors up to `node`, as a11y-inspect.js isNestedControl reads them. */
function chainTo(target, node) {
  const chain = [];
  for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
    chain.push({ tag: n.tagName, role: n.getAttribute('role'), href: n.hasAttribute('href'), isNode: n === node });
    if (n === node) break;
  }
  return chain;
}

/** Is an info pinned? */
export const isPinned = () => inspector.pinned !== null;

/** Bring the panel into view (after a key pinned something: the keyboard has no pointer to show where it went). */
export function revealPanel() {
  if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
