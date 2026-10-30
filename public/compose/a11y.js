// The accessibility pass of the composition page: what is done to the DOM after each
// render, and the keys that work on it. Views are not changed: they draw and
// register what is draggable (snap.js) and inspectable (inspect.js) as before, and
// this pass makes those same elements reachable and named:
//
//   - the view's svg becomes a labelled group (role=group, aria-label, <desc>), its
//     decorative shapes aria-hidden;
//   - every port, palette piece, slot and inspectable thing gets a name, a role and
//     a place in a ROVING tab order: one Tab stop per kind (ports; pieces; the
//     rest), and the arrow keys move within it by position;
//   - ports show their schema as a letter on the dot (colour is not the only carrier);
//   - the view switcher is a tablist, toggles say aria-pressed, the links list says
//     which kind each link is;
//   - focus survives a redraw (the stage is rebuilt after every edit);
//   - a focus ring is drawn for every element the browser will not ring itself (SVG);
//   - what changed is announced once through the live region (a11y-bus.js).
//
// The logic (names, announcements, movement, the pin reducer, the link machine) is in
// the pure modules a11y-text / a11y-nav / a11y-inspect / a11y-link, tested under deno.

import { registered, startKeyboard, kbActive } from './snap.js';
import { infoOf, activate, dismissPinned, isPinned, revealPanel, syncPin } from './inspect.js';
import { rovingTarget, tabTarget, tabStop, roleFor, keepsOwnName, clicksItself } from './a11y-nav.js';
import { portLabel, slotLabel, pieceLabel, viewLabel, eventText, schemaCode, uniqueKeys, distinctDashes, firstDrawing, brokenViewText, viewNews } from './a11y-text.js';
import { state, subnetsById } from './state.js';
import { SLOTS, pieceByName, LINK_STYLE } from './model.js';
import { schemaColor } from './theme.js';
import { VIEW_IDS, INDEX_VIEW, viewKey } from './views-meta.js';
import { announce, initLive, takeFocusRequest } from './a11y-bus.js';
import { installMotionGuard } from './motion.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (s) => document.querySelector(s);
// The roving groups, one Tab stop each: ports, palette pieces, the small buttons drawn in a view,
// the other inspectable things of the stage, and the inspectable things of the side column
// (the link rules, the Links card), which sit elsewhere in the page and so are a stop of their own.
const GROUPS = ['port', 'piece', 'action', 'item', 'panel'];
const HINT = { port: 'a11y-hint-port', piece: 'a11y-hint-piece', action: 'a11y-hint-action', item: 'a11y-hint-item', panel: 'a11y-hint-item' };
// What a role=button must not wrap: it makes its children presentational (nested-interactive).
const INNER = 'button, a[href], input, select, textarea, summary, [tabindex], [role=button], .inspectable, .snap-port, .snap-slot, .snap-piece';
// Click-only buttons the views draw inside their SVG (remove a piece, move it up or down): the page turns a key into the click.
const ACTIONS = '.obtn:not(.off), .lens-x, .sv-x, .sp-chip-x';
const SHAPES = 'path,line,circle,ellipse,rect,polygon,polyline,image,defs,marker,pattern,clipPath,linearGradient,filter';

let ring = null;
let keyboardMode = false;       // was the last thing the person did a key press?
let lastFocusKey = null;        // focus before the render, to give back after
let lastKey = null;             // view|example last drawn (before the first drawing: the one the page started on)
let drawn = false;              // has a view been drawn yet?
const stops = { port: null, piece: null, action: null, item: null, panel: null }; // each roving group's remembered Tab stop

// --- setup ------------------------------------------------------------------------------------

/** Once, at load (after the DOM exists): the live region, the motion guard, the ring and the keys. */
export function initA11y() {
  initLive();
  installMotionGuard();
  ring = document.createElement('div');
  ring.className = 'a11y-ring';
  ring.setAttribute('aria-hidden', 'true');
  document.body.appendChild(ring);
  document.addEventListener('keydown', (e) => { keyboardMode = true; onKey(e); });
  document.addEventListener('keydown', () => { keyboardMode = true; }, true);
  document.addEventListener('pointerdown', () => { keyboardMode = false; hideRing(); }, true);
  // The skip links move focus; they must not change the address. The page keeps its view, example and
  // view parameters (level=...) in the hash, and a bare #stage would rewrite it and add a history entry.
  // The href stays for a browser without script.
  for (const a of document.querySelectorAll('a.skip[href^="#"]')) {
    a.addEventListener('click', (e) => {
      const to = document.getElementById(a.getAttribute('href').slice(1));
      if (!to) return;
      e.preventDefault();
      if (!to.hasAttribute('tabindex')) to.setAttribute('tabindex', '-1');
      to.focus();
      if (to.scrollIntoView) to.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
  }
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', () => hideRing());
  document.addEventListener('scroll', () => place(), true);
  window.addEventListener('resize', () => place());
}

/** The view and example the page starts on (the hash, read before anything loads): a different one at the first drawing was chosen while loading, and is said. */
export function startedOn(view, example) { lastKey = `${view}|${example}`; }

/** The registry's dash for a guard link is token's; make the four kinds four patterns (after loadFacts). */
export function applyStyles() { distinctDashes(LINK_STYLE); }

// --- the focus ring -----------------------------------------------------------------------------

let ringTarget = null;
function showRing(el) {
  ringTarget = el;
  place();
}
function hideRing() {
  ringTarget = null;
  if (ring) ring.classList.remove('show');
}
function place() {
  if (!ring) return;
  const el = ringTarget;
  if (!el || !el.isConnected) { ring.classList.remove('show'); return; }
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) { ring.classList.remove('show'); return; }
  ring.style.left = `${r.left - 4}px`;
  ring.style.top = `${r.top - 4}px`;
  ring.style.width = `${r.width + 8}px`;
  ring.style.height = `${r.height + 8}px`;
  ring.classList.add('show');
}

function onFocusIn(e) {
  const t = e.target;
  const g = t.dataset && t.dataset.a11yGroup;
  if (g) {
    // roving: the focused one is now the group's Tab stop
    for (const x of document.querySelectorAll(`[data-a11y-group="${g}"][tabindex="0"]`)) if (x !== t) x.setAttribute('tabindex', '-1');
    t.setAttribute('tabindex', '0');
    stops[g] = t.dataset.a11yKey;
  }
  // The browser rings HTML itself (:focus-visible); SVG things get the page's ring, for the keyboard.
  if ((keyboardMode || kbActive()) && t instanceof SVGElement) showRing(t); else hideRing();
}

// --- keys -----------------------------------------------------------------------------------------

function onKey(e) {
  if (kbActive()) return; // link mode owns the keys (snap.js)
  if (e.key === 'Escape') { if (dismissPinned()) e.preventDefault(); return; }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  const g = t && t.dataset && t.dataset.a11yGroup;
  if (g) {
    if (/^Arrow|^(Home|End)$/.test(e.key)) { moveWithin(t, g, e.key); e.preventDefault(); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      if ((g === 'item' || g === 'panel') && clicksItself(t.tagName)) {
        // A real button or link clicks itself on Enter and Space. A second, synthetic click would
        // press it twice in the browsers that click on key-up (the pin would be set and released).
        if (e.key === 'Enter') setTimeout(() => { if (isPinned()) revealPanel(); }, 0);
        return;
      }
      e.preventDefault();
      if (g === 'port' || g === 'piece') startKeyboard(t);
      else {
        // The same click a pointer would make: a view's own handler (fire an enabled transition,
        // remove a piece, go to another view) takes it, else it pins the inspector.
        t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if ((g === 'item' || g === 'panel') && isPinned()) revealPanel();
      }
      return;
    }
    if (e.key === 'i' || e.key === 'I') { e.preventDefault(); activate(t, { reveal: true }); return; }
    return;
  }
  if (t && t.getAttribute && t.getAttribute('role') === 'tab') {
    const tabs = [...document.querySelectorAll('#tabs [role=tab]')];
    const to = tabTarget(tabs.length, tabs.indexOf(t), e.key);
    if (to >= 0) { e.preventDefault(); tabs[to].focus(); }
  }
}

function members(g) { return [...document.querySelectorAll(`[data-a11y-group="${g}"]`)]; }

function moveWithin(t, g, key) {
  const els = members(g);
  const items = els.map((n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const to = rovingTarget(items, els.indexOf(t), key);
  if (to >= 0 && els[to]) els[to].focus();
}

// --- the pass after each render -----------------------------------------------------------------------

const keyOf = (el) => (el && el.dataset && el.dataset.a11yKey) || null;

function containerKey(el) {
  // Buttons the page rebuilds on every render: the toolbar, the tabs, the link list's remove buttons.
  for (const sel of ['#toolbar', '#tabs', '#composition']) {
    const box = $(sel);
    if (box && box.contains(el)) {
      const bs = [...box.querySelectorAll('button')];
      const i = bs.indexOf(el);
      if (i >= 0) return `${sel.slice(1)}#${i}`;
    }
  }
  return null;
}
function byContainerKey(key) {
  const m = /^(toolbar|tabs|composition)#(\d+)$/.exec(key || '');
  if (!m) return null;
  const box = $(`#${m[1]}`);
  const bs = box ? [...box.querySelectorAll('button')] : [];
  return bs[Math.min(Number(m[2]), bs.length - 1)] || null;
}

/** Call just before the stage is rebuilt: remember where focus is. */
export function beforeRender() {
  const a = document.activeElement;
  lastFocusKey = !a || a === document.body ? null : (keyOf(a) || containerKey(a));
}

/**
 * Call after a render has drawn the view. `view` is the view module (title, convention);
 * `event` is what just changed (state.event, before it is cleared).
 */
export function afterRender({ view, event }) {
  const stage = $('#stage');
  const subnets = subnetsById();
  // Label first: semantics() hides decorative shapes and must leave alone whatever got a name and a Tab stop.
  labelThings(stage, subnets);
  semantics(stage, view);
  schemaBadges(stage, subnets);
  tabsAndToggles();
  linkList();
  syncPin(); // a pin on a thing this redraw dropped (a link removed) is released, and said so
  restoreFocus(stage);
  const idx = VIEW_IDS.indexOf(state.view) + 1;
  const key = `${state.view}|${state.example}`;
  // A broken view says what is wrong where a working one would say its name: "View 7 of 10: ..." would be a lie.
  if (viewNews({ lastKey, drawn, key, broken: !!view.broken })) announce(view.broken ? brokenViewText(view) : viewLabel(view, state.example, idx, VIEW_IDS.length));
  lastKey = key; drawn = true;
  announce(eventText(event));
}

/** The stage is the panel of the selected tab: also while the shell stands in for a view that is still loading. */
export function labelStage() {
  const stage = $('#stage');
  if (!stage) return;
  stage.setAttribute('role', 'tabpanel');
  stage.setAttribute('aria-labelledby', `tab-${state.view}`);
}

function semantics(stage, view) {
  const idx = VIEW_IDS.indexOf(state.view);
  labelStage();
  const svgs = [...stage.querySelectorAll('svg.view-svg')];
  svgs.forEach((root, i) => {
    const own = root.getAttribute('aria-label');
    const base = viewLabel(view, state.example, idx + 1, VIEW_IDS.length);
    const part = svgs.length > 1 ? ` (drawing ${i + 1} of ${svgs.length})` : '';
    // role=img would hide the ports and parts inside it from assistive technology: this is a group.
    root.setAttribute('role', 'group');
    root.setAttribute('aria-roledescription', 'diagram');
    const named = own && own.toLowerCase().startsWith(String(view.title).toLowerCase());
    root.setAttribute('aria-label', own ? `${named ? own : `${view.title}: ${own}`}${part}` : `${base}${part}`);
    const summary = view.convention && view.convention.summary;
    if (summary && !root.querySelector(':scope > desc')) {
      const d = document.createElementNS(SVGNS, 'desc');
      d.id = `diagram-desc-${i}`;
      d.textContent = summary;
      root.prepend(d);
      root.setAttribute('aria-describedby', d.id);
    }
    for (const n of root.querySelectorAll(SHAPES)) {
      if (n.classList.contains('inspectable') || n.hasAttribute('tabindex') || n.hasAttribute('aria-label')) continue;
      n.setAttribute('aria-hidden', 'true');
    }
  });
}

function labelThings(stage, subnets) {
  const { meta } = registered();
  // Every inspectable thing of the page, not only the stage's: the side column has them too.
  const all = [...new Set([...document.querySelectorAll(`.inspectable, .snap-port, .snap-slot, .snap-piece, #stage :is(${ACTIONS})`)])];
  const rows = [];
  for (const el of all) {
    const m = meta.get(el);
    const isAction = !m && !infoOf(el) && el.matches(ACTIONS);
    const group = m && m.type === 'port' ? 'port' : m && m.type === 'piece' ? 'piece' : isAction ? 'action' : stage.contains(el) ? 'item' : 'panel';
    let name = null;
    if (m && m.type === 'port') {
      const { subnet, port } = m.ref;
      const p = subnets[subnet] && subnets[subnet].ports.find((q) => q.id === port);
      name = p ? portLabel(subnet, p) : `port ${m.key}`;
    } else if (m && m.type === 'piece') {
      name = pieceLabel(pieceByName[m.name] || { name: m.name, kind: '' });
    } else if (m && m.type === 'slot') {
      name = (infoOf(el) && infoOf(el).title) || slotLabel(SLOTS.find((s) => s.id === m.key), m.key);
    } else if (infoOf(el)) {
      name = infoOf(el).title;
    } else if (isAction) {
      const t = el.querySelector(':scope > title');
      name = t && t.textContent ? t.textContent : null;
    }
    if (!name) continue;
    rows.push({ el, group, name, titleKey: m ? `${m.type}:${m.key}` : `item:${name}` });
  }
  const keys = uniqueKeys(rows.map((r) => r.titleKey));
  rows.forEach((r, i) => { r.key = keys[i]; });

  for (const g of GROUPS) {
    const mine = rows.filter((r) => r.group === g);
    const stopIdx = tabStop(mine.map((r) => r.key), stops[g]);
    mine.forEach((r, i) => {
      const { el } = r;
      el.dataset.a11yKey = r.key;
      el.dataset.a11yGroup = g;
      const role = roleFor({ tag: el.tagName, hasRole: el.hasAttribute('role'), svg: el instanceof SVGElement, holdsControls: !!el.querySelector(INNER), group: g });
      if (role) el.setAttribute('role', role);
      // A button or link that already says what it is in visible words keeps those words.
      if (!keepsOwnName({ tag: el.tagName, text: el.textContent })) el.setAttribute('aria-label', r.name);
      // A thing with a name and a Tab stop is not decoration, whatever hid it before.
      el.removeAttribute('aria-hidden');
      el.setAttribute('tabindex', i === stopIdx ? '0' : '-1');
      const ids = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (!ids.includes(HINT[g])) ids.push(HINT[g]);
      el.setAttribute('aria-describedby', ids.join(' '));
    });
  }
}

// A letter on each place port's dot: its schema, in a form that does not depend on colour.
function schemaBadges(stage, subnets) {
  const { meta } = registered();
  for (const el of stage.querySelectorAll('.snap-port')) {
    const m = meta.get(el);
    if (!m || el.querySelector('.a11y-badge')) continue;
    const s = subnets[m.ref.subnet];
    const p = s && s.ports.find((q) => q.id === m.ref.port);
    if (!p || p.target === 'transition' || !p.schema) continue;
    const code = schemaCode(p.schema);
    const color = schemaColor(p.schema).toLowerCase();
    let mk = null, mb = null;
    for (const n of el.querySelectorAll('circle,rect,path,polygon')) {
      if (n.classList.contains('hit') || /(^|\s)(cp-hit|sv-hit)(\s|$)/.test(n.getAttribute('class') || '')) continue;
      if ((n.getAttribute('fill') || '').toLowerCase() !== color) continue;
      let b;
      try { b = n.getBBox(); } catch { continue; }
      if (b.width > 0 && b.width <= 18 && b.height <= 18 && (!mb || b.width > mb.width)) { mk = n; mb = b; }
    }
    if (!mk) continue;
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('class', 'a11y-badge');
    t.setAttribute('aria-hidden', 'true');
    t.setAttribute('pointer-events', 'none');
    t.setAttribute('text-anchor', 'middle');
    t.textContent = code;
    let badge = t;
    if (mb.width >= 9) {
      // inside the dot, white on the schema colour
      t.setAttribute('x', mb.x + mb.width / 2);
      t.setAttribute('y', mb.y + mb.height / 2 + mb.width * 0.27);
      t.setAttribute('font-size', Math.max(6.5, mb.width * 0.72));
      t.setAttribute('fill', '#fff');
    } else {
      // Too small to hold a letter: a boxed letter above the arrow, off the leader line. A bare "I" at
      // this size is a 1.5 px bar that reads as a tick on the dashed leader, so it gets a frame.
      const S = 10, gx = mb.x + mb.width + 3, gy = mb.y - S - 1;
      badge = document.createElementNS(SVGNS, 'g');
      badge.setAttribute('class', 'a11y-badge a11y-badge-out');
      badge.setAttribute('aria-hidden', 'true');
      badge.setAttribute('pointer-events', 'none');
      const box = document.createElementNS(SVGNS, 'rect');
      for (const [k, v] of Object.entries({ x: gx, y: gy, width: S, height: S, rx: 2, fill: '#fff', stroke: color, 'stroke-width': 1 })) box.setAttribute(k, v);
      t.setAttribute('x', gx + S / 2);
      t.setAttribute('y', gy + S - 2.4);
      t.setAttribute('font-size', 8);
      t.setAttribute('fill', color);
      badge.append(box, t);
    }
    const tf = mk.getAttribute('transform');
    if (tf) badge.setAttribute('transform', tf);
    mk.after(badge);
  }
}

/** Tab roles, aria-selected, roving tabindex and the toggles' aria-pressed: after every repaint of the tabs (also the shell's). */
export function tabsAndToggles() {
  const tabs = [...document.querySelectorAll('#tabs .tab')];
  const tl = $('#tabs');
  if (tl) { tl.setAttribute('role', 'tablist'); tl.setAttribute('aria-label', 'Composition views'); }
  tabs.forEach((b) => {
    const id = b.dataset.view;
    const on = id === state.view;
    b.setAttribute('role', 'tab');
    b.id = `tab-${id}`;
    b.setAttribute('aria-selected', String(on));
    b.setAttribute('aria-controls', 'stage');
    const key = id === INDEX_VIEW.id ? 'v' : viewKey(VIEW_IDS.indexOf(id));
    if (key) b.setAttribute('aria-keyshortcuts', key); else b.removeAttribute('aria-keyshortcuts');
    b.setAttribute('tabindex', on ? '0' : '-1');
  });
  // The Laws view's own buttons mark the one shown by a class only: the tabs (theories) and chips (rules, rewrites).
  for (const b of document.querySelectorAll('.examples .seg, #toolbar .chip, #stage button.lw-tab, #stage button.lw-chip')) b.setAttribute('aria-pressed', String(b.classList.contains('active')));
  for (const b of document.querySelectorAll('.examples .seg')) b.setAttribute('aria-keyshortcuts', 'e');
  for (const g of document.querySelectorAll('.rule-glyph, .tb-sep')) g.setAttribute('aria-hidden', 'true');
}

// The links card: each link says its kind in words, the remove button says which link it removes.
function linkList() {
  const lis = [...document.querySelectorAll('#composition .links li')];
  lis.forEach((li, i) => {
    const l = state.orders.links[i];
    if (!l) return;
    const glyph = li.querySelector('.glyph');
    if (glyph && !glyph.hasAttribute('aria-hidden')) {
      glyph.setAttribute('aria-hidden', 'true');
      const w = document.createElement('span');
      w.className = 'sr-only';
      w.textContent = `${l.kind} link `;
      glyph.before(w);
    }
    const x = li.querySelector('button.x');
    if (x) x.setAttribute('aria-label', `Remove ${l.kind} link ${l.from.subnet}:${l.from.port} to ${l.to.subnet}:${l.to.port}`);
  });
}

function restoreFocus(stage) {
  const asked = takeFocusRequest();
  const a = document.activeElement;
  // A render that rebuilt the element focus was on leaves focus on <body>; one that did not touch it
  // (the static example buttons, say) leaves it where it was.
  const lost = !a || a === document.body || !a.isConnected;
  const wanted = asked || (lost ? lastFocusKey : null);
  lastFocusKey = null;
  if (!wanted) return;
  const byKey = (k) => document.querySelector(`[data-a11y-key="${CSS.escape(k)}"]`);
  // the thing itself; else, if it was a second drawing the redraw dropped, its first drawing; else a rebuilt button
  const found = byKey(wanted) || (firstDrawing(wanted) !== wanted ? byKey(firstDrawing(wanted)) : null) || byContainerKey(wanted);
  if (found) { found.focus(); return; }
  // The thing is gone (another view): keep the person in the diagram, not back at the top of the page.
  if (/^(port|piece|slot|item|action)/.test(wanted)) stage.focus();
}
