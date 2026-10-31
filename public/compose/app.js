// The composition views page (public/compose.html): example switch, view tabs,
// toolbar, side panels and the render loop. The views are the view registry's
// (views-meta.js, compose/VIEWS.md: tabs, keys and links come from it) and get a
// ctx (ctx.js). Every rule they show is the registry's (registry.js): the
// page loads pflow-native's wasm, opens the composition and the plan by command
// (bundle.open, plan.open) and re-reads them after every edit.
//
// Load order (docs/compose-load-budget.md): the shell (tabs, a status line) is
// drawn at once; the wasm and the module of the view being shown are fetched
// together; the other views are imported when the page is idle, or at once
// if their tab is pressed first (loadView), and the Laws view's Pyodide is
// fetched only when that view is drawn (laws-live.js). A view reads
// the ontology facts (model.js, filled by loadFacts from the registry) when its
// module is evaluated, so a view is evaluated only after loadFacts(); until then
// its module is only fetched (preloadView). The sequencing is loader.js's (and
// tested there); this file supplies the effects. The page marks performance
// 'compose:shell', 'compose:registry-ready' and 'compose:ready'.

import * as registry from './registry.js';
import { loadFacts, LINK_KINDS, LINK_STYLE, EXTRA_SPECS, PARAMS_NOTE, PIECES, PLAN_RS_REV, FACTS } from './model.js';
import { state, subscribe, actions, subnetsById, orderLinks, flatOrders, planInfo, readHash, writeHash, linkTo, currentLink, startFromLink } from './state.js';
import { initSnap, resetSnap, snap, kbActive, gestureActive } from './snap.js';
import { initInspector, hover, renderInfo } from './inspect.js';
import { el } from './dom.js';
import * as theme from './theme.js';
import * as info from './info.js';
import { citeLabel, citeURL, bibLabel, bibURL } from './sources.js';
import { makeCtx } from './ctx.js';
import { VIEWS, VIEW_IDS, VIEW_META, INDEX_VIEW, viewKey, entryProblems, viewProblems } from './views-meta.js';
import { storedView } from './stored-view.js';
import { makeIndexView } from './index-view.js';
import { makeManifest } from './manifest.js';
import { createViewLoader, createStartup } from './loader.js';
import * as a11y from './a11y.js';
import { isTypingTarget } from './a11y-nav.js';
import { afterGesture } from './a11y-link.js';
import { announce } from './a11y-bus.js';
import { VIEW_KEYS_OFF, registryFailureText, brokenTabLabel, newStatus } from './a11y-text.js';
import { renderLegend } from './legend.js';
import { startModelPanel } from './identity.js';

let connect4 = null;
let lastManifest = null;

// The one dynamic import of a view module, at the path its registry entry gives (a test holds it to this line); loader.js keeps what came of it.
const importView = (id) => (VIEW_META[id].kind === 'module' ? import(`./${VIEW_META[id].src}`) : { default: storedView(VIEW_META[id]) });
const { views, load: loadView } = createViewLoader({ importModule: importView, meta: VIEW_META, entryProblems, problems: viewProblems });
views.set(INDEX_VIEW.id, makeIndexView({ views, load: loadView, linkTo, copy: (hash, button) => copyLink(fullLink(hash), button) }));

const preloaded = new Set();

/** Start fetching a view's module (modulepreload fetches that file, not what it imports) without evaluating it. */
function preloadView(id, priority = 'auto') {
  if (views.has(id) || preloaded.has(id) || VIEW_META[id].kind !== 'module') return;
  preloaded.add(id);
  const link = document.createElement('link');
  link.rel = 'modulepreload';
  link.fetchPriority = priority;
  link.href = new URL(`./${VIEW_META[id].src}`, import.meta.url).href;
  document.head.append(link);
}

async function loadConnect4() {
  try { connect4 = await (await fetch(new URL('assets/connect-4.json', import.meta.url))).json(); } catch { connect4 = null; }
}

// --- rendering --------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const fill = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

function renderTabs(disabled = false) {
  const box = $('#tabs');
  // The shell repaints the tabs while a view's module loads, and a tab may have focus (a key pressed on it):
  // keep focus on the tab at the same place, with its tab semantics, so a keyboard user is not dropped to the page.
  const at = [...box.children].indexOf(document.activeElement);
  const tab = (m, label) => {
    const broken = !!views.get(m.id)?.broken; // the strike-through says it to the eye; the label says it to everyone else
    return el('button', { class: `tab${state.view === m.id ? ' active' : ''}${broken ? ' broken' : ''}`, 'data-view': m.id, title: m.title, 'aria-label': broken ? brokenTabLabel(label) : null, disabled: disabled ? true : null, onclick: () => actions.setView(m.id) }, label);
  };
  fill(box, ...VIEWS.map((m, i) => tab(m, `${i + 1}. ${m.short}`)), tab(INDEX_VIEW, INDEX_VIEW.short));
  $('#ex-orders').classList.toggle('active', state.example === 'orders');
  $('#ex-connect4').classList.toggle('active', state.example === 'connect4');
  a11y.tabsAndToggles();
  if (at >= 0) box.children[at]?.focus();
}

function renderToolbar(v) {
  const tb = $('#toolbar');
  tb.hidden = !!v.noToolbar;
  if (v.noToolbar) { fill(tb); return; }
  if (state.example === 'orders') {
    const kinds = ['auto', 'token', 'data', 'event', 'guard'];
    fill(tb,
      el('span', { class: 'tb-label' }, 'Drag from a port to link. Try first:'),
      ...kinds.map((k) => el('button', { class: `chip${state.orders.prefer === k ? ' active' : ''}`, style: k !== 'auto' ? { '--chip': LINK_STYLE[k].color } : null, onclick: () => actions.setPrefer(k), title: k === 'auto' ? 'transition→transition: event; transition→place: guard; place→place: token, else data (bundle.candidates)' : LINK_KINDS[k].comment }, k === 'auto' ? 'auto' : `${LINK_STYLE[k].glyph} ${k}`)),
      el('span', { class: 'tb-sep' }),
      el('button', { class: 'btn', onclick: () => actions.resetLinks(), title: 'bundle.reset_links: the three event idioms of ROADMAP 4.1' }, 'Reset to the 3 idioms'),
      el('button', { class: 'btn', onclick: () => actions.clearLinks(), title: 'bundle.clear_links' }, 'Clear links'),
      el('span', { class: 'tb-sep' }),
      el('span', { class: 'tb-label' }, 'Second instance:'),
      ...Object.entries(EXTRA_SPECS).map(([id, spec]) => el('button', { class: `chip${state.orders.extras.includes(id) ? ' active' : ''}`, title: `${spec.why}${spec.available ? '' : ` (unavailable: ${spec.reason})`}`, disabled: spec.available ? null : true, onclick: () => actions.toggleExtra(id) }, `${state.orders.extras.includes(id) ? '−' : '+'} ${id}`)),
    );
  } else {
    const groups = [['Order', 'order pieces'], ['Driver', 'drivers'], ['Memo', 'memo'], ['Filter', 'filters'], ['Heuristic', 'heuristics'], ['Estimate', 'root estimates']];
    fill(tb,
      el('span', { class: 'tb-label' }, 'Drag a piece into a slot. Mode:'),
      ...['exact', 'play'].map((m) => el('button', { class: `chip${(planInfo().plan.mode || 'exact') === m ? ' active' : ''}`, onclick: () => actions.setMode(m), title: 'plan.set_mode' }, m)),
      el('button', { class: 'btn', onclick: () => actions.resetPlan(), title: 'plan.open {}: the plan.rs module-doc example' }, 'Reset to plan:connect4-exact'),
      el('div', { class: 'palette' }, groups.map(([kind, label]) => {
        const ps = PIECES.filter((p) => p.kind === kind);
        if (!ps.length) return null;
        return el('div', { class: 'pal-group' }, el('span', { class: 'pal-label' }, label),
          ps.map((p) => {
            const b = el('span', { class: `pal-piece ${p.status}`, style: { '--kc': theme.PIECE_KIND_COLOR[p.kind] } }, p.name, p.status !== 'built' ? el('sup', {}, p.status === 'reserved' ? 'R' : 'P') : null);
            snap.piece(b, p.name);
            hover(b, info.pieceInfo(p.name));
            return b;
          }));
      })),
    );
  }
}

const fullLink = (hash) => `${location.origin}${location.pathname}${location.search}${hash}`;

/** Copy a link, and say so. If the browser refuses, the link is left selected in the bar for the person to copy. */
async function copyLink(url, button) {
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch { /* not allowed here: the bar below */ }
  const field = $('#view-link');
  if (!copied) { field.value = url; field.focus(); field.select(); }
  button.dataset.word ??= button.textContent; // a second press within the two seconds finds "Copied" there
  button.textContent = copied ? 'Copied' : 'Select and copy';
  setTimeout(() => { button.textContent = button.dataset.word; }, 2000);
  announce(copied ? 'Link copied.' : 'The browser did not allow copying. The link is selected in the link field.');
}

/** The bar above the stage: this view's link, always current, and the way to the index. It is updated in place, so it keeps focus. */
function renderLinkBar() {
  const field = $('#view-link');
  field.value = fullLink(currentLink());
  const warn = $('#view-link-warning');
  warn.hidden = !state.linkWarning;
  warn.textContent = state.linkWarning || '';
}

/** The view keys, in words: the numbered ones and the rest come from the registry. */
function renderKeyHelp() {
  const named = (i) => `${viewKey(i)} ${VIEWS[i].short}`;
  const last = Math.min(VIEWS.length, 10) - 1;
  fill($('#keys-views'), el('kbd', {}, '1'), last > 0 ? ['–', el('kbd', {}, viewKey(Math.min(last, 8)))] : null, last === 9 ? [', ', el('kbd', {}, '0')] : null,
    ` switch view (${named(0)}${last > 0 ? ` … ${named(last)}` : ''})${VIEWS.length > 10 ? '; later views have no number' : ''}. `,
    el('kbd', {}, '['), ' ', el('kbd', {}, ']'), ' go to the previous or next view, whichever it is. ',
    el('kbd', {}, 'V'), ' lists all views with their links. ',
    el('kbd', {}, 'E'), ' switches the example. In the view tabs, ', el('kbd', {}, '←'), ' ', el('kbd', {}, '→'), ' move and ', el('kbd', {}, 'Enter'), ' opens.');
}

function renderConvention(v) {
  const c = v.convention || {};
  const ex = c.examples && c.examples[state.example];
  fill($('#convention'),
    el('h3', {}, v.title),
    c.summary ? el('p', {}, c.summary) : null,
    ex ? el('p', { class: 'conv-ex' }, ex) : null,
    c.honesty && c.honesty.length ? el('ul', { class: 'honesty' }, c.honesty.map((h) => el('li', {}, h))) : null,
    c.bib && c.bib.length ? el('ul', { class: 'bib' }, c.bib.map((k) => { const u = bibURL(k); return el('li', {}, u ? el('a', { href: u, target: '_blank', rel: 'noopener' }, bibLabel(k)) : bibLabel(k)); })) : null,
    c.cites && c.cites.length ? el('ul', { class: 'insp-cites' }, c.cites.map((ct) => { const u = citeURL(ct); return el('li', {}, u ? el('a', { href: u, target: '_blank', rel: 'noopener' }, citeLabel(ct)) : citeLabel(ct), ct.note ? ` — ${ct.note}` : ''); })) : null,
  );
}

function ruleRow(kind) {
  const s = LINK_STYLE[kind];
  const text = {
    token: 'place → place; from not an in-port, to not an out-port; schemas agree; both nets ResourceNet or GameNet',
    data: 'place → place; schemas agree; the observer moves nothing on the observed place; any net kinds',
    event: 'transition → transition; no direction rule; neither net a ComputationNet',
    guard: 'gated transition → observed place; any net kinds; restrictive (W_RESTRICTIVE_LINK); outside the free SMC',
  }[kind];
  const row = el('div', { class: 'rule-row', id: `rule-${kind}`, style: { '--rc': s.color } }, el('span', { class: 'rule-glyph' }, s.glyph), el('b', {}, kind), ' ', text);
  hover(row, info.linkKindInfo(kind));
  return row;
}

// What pflow-rs's SearchPlan::check and solver() refuse, in words; the verdict
// on any plan is plan.check's, never the page's.
const PLAN_RULES = [
  ['known', 'every name is known and in its place'],
  ['twice', 'no order piece is listed twice'],
  ['budget', 'budget takes {"nodes": N}, N ≥ 1'],
  ['memo', 'memo entries ≥ 1'],
  ['exact', 'exact mode refuses pieces that can change the value; play mode builds none of them yet'],
  ['goals', 'centrality and threats need the net\'s goals; Connect-4 declares them'],
];

function renderRules() {
  const box = $('#rules');
  if (state.example === 'orders') {
    fill(box, el('h3', {}, 'Link rules (pflow-compose Bundle::validate)'), ...['token', 'data', 'event', 'guard'].map(ruleRow),
      el('p', { class: 'muted small' }, 'Plus two page rules, labelled rule "page" in every verdict: a link joins two different subnets (PAGE_SAME_SUBNET), and is not there already (PAGE_DUPLICATE). ', el('span', { id: 'cq13' }, 'cq/13 expects event candidates and no token candidates among queue, pool and saga.')));
  } else {
    fill(box, el('h3', {}, `Plan rules (pflow-rs SearchPlan::check @${PLAN_RS_REV})`), ...PLAN_RULES.map(([id, t]) => el('div', { class: 'rule-row', id: `prule-${id}`, style: { '--rc': '#2f6fb3' } }, t)),
      el('p', { class: 'muted small' }, 'In words only: every verdict on this page is plan.check / plan.slot_candidates, with pflow-rs\'s own message.'));
  }
}

function renderComposition() {
  const box = $('#composition');
  if (state.example === 'orders') {
    const byId = subnetsById();
    const links = orderLinks();
    const flat = flatOrders();
    fill(box,
      el('h3', {}, `Links (${links.length})`),
      links.length ? el('ul', { class: 'links' }, links.map((l) => {
        const li = el('li', { class: l.leak ? 'leak' : '' },
          el('span', { class: 'glyph', style: { color: LINK_STYLE[l.kind].color } }, LINK_STYLE[l.kind].glyph), ' ',
          `${l.from.subnet}:${l.from.port} — ${l.to.subnet}:${l.to.port}`,
          l.idiom ? el('span', { class: 'idiom' }, ` pat:${l.idiom}`) : null,
          l.leak ? el('div', { class: 'leak-note' }, 'pool leaks a worker on rollback (idiom caveat)') : null,
          el('button', { class: 'x', title: 'bundle.remove_link', onclick: (e) => { e.stopPropagation(); actions.removeLink(l.index); } }, '×')); // not a click on the row: it would pin a link that is going
        hover(li, info.linkInfo(l, byId));
        return li;
      })) : el('p', { class: 'muted' }, 'No links: the composite is the monoidal product (disjoint union) of the instances.'),
      flat.ok ? el('p', { class: 'small' }, `Flat net (bundle.flatten): ${flat.model.places.length} places, ${flat.model.transitions.length} transitions, ${Object.keys(flat.map.fusedGroups).length} fused, ${Object.keys(flat.map.wires).length} wires.`) : el('p', { class: 'warn' }, flat.error || flat.errors.map((e) => e.code).join(', ')),
      state.orders.unavailable.length ? el('p', { class: 'warn small' }, `Unavailable: ${state.orders.unavailable.map((u) => `${u.instance || u.id}: ${u.reason}`).join('; ')}`) : null,
      el('p', { class: 'muted small' }, PARAMS_NOTE),
    );
  } else {
    const p = planInfo();
    fill(box,
      el('h3', {}, 'Plan JSON'),
      el('pre', { class: 'plan-json' }, JSON.stringify(p.json, null, 1)),
      el('p', { class: p.error ? 'warn' : 'ok' }, p.error ? `refused (${p.step}): ${p.error}` : `pflow-rs @${PLAN_RS_REV}: SearchPlan::from_json, check() and solver(connect-4) accept it (plan.state)`),
    );
  }
}

function renderSources() {
  const box = $('#receipts');
  const prov = FACTS.ontology?.provenance;
  fill(box, el('h3', {}, 'Where the rules come from'),
    el('ul', { class: 'small' },
      el('li', {}, `pflow-native-wasm ${registry.engines.version} (vendored in public/vendor/pflow-native-wasm/, lock pflow-native-wasm.lock): every link verdict, drag candidate, Flatten, scenario run and the lens test (bundle.*), and every plan verdict (plan.*).`),
      el('li', {}, `pflow-rs @${PLAN_RS_REV}: SearchPlan::from_json / check / solver, through the registry.`),
      prov ? el('li', {}, `Ontology facts: ${prov.source}; ${prov.judgment}`) : null,
      el('li', {}, 'Composition laws: Chyp 3d28483 (the Laws view runs its checker live under Pyodide, see there).'),
    ));
}

let flashTimer = null;
function flash(event) {
  const f = $('#flash');
  if (!event) return;
  if (event.type === 'link-added') {
    const l = event.link, s = LINK_STYLE[l.kind];
    fill(f, el('b', { style: { color: s.color } }, `${s.glyph} lk:${l.kind}`), ` allowed ${l.from.subnet}:${l.from.port} → ${l.to.subnet}:${l.to.port}: `,
      event.rule.passed.map((p) => p.text).join(' · '),
      event.rule.warnings.length ? el('span', { class: 'warn' }, ` · ${event.rule.warnings.map((w) => w.code).join(', ')}`) : null,
      event.idiom ? el('span', { class: 'idiom' }, ` · this is pat:${event.idiom.key}`) : null);
    f.style.setProperty('--fc', s.color);
    const row = $(`#rule-${l.kind}`);
    if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  } else if (event.type === 'piece-added') {
    fill(f, el('b', {}, `✓ ${event.name}`), ` into ${event.slot}: pflow-rs accepts the plan (${event.piece?.kind}, contract ${event.piece?.contract})`);
    f.style.setProperty('--fc', theme.PIECE_KIND_COLOR[event.piece?.kind] || '#2f6fb3');
    const id = event.slot === 'memo' ? 'memo' : event.slot === 'drivers' ? 'budget' : 'known';
    const row = $(`#prule-${id}`);
    if (row) { row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash'); }
  } else if (event.type === 'refused') {
    fill(f, el('b', { class: 'warn' }, '✗ refused'), ` ${event.error.message}`);
    f.style.setProperty('--fc', '#c0392b');
  } else return;
  f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.remove('show'), 4200);
}

/**
 * What the page shows before the registry is ready, and while a view's module loads: the tabs and a status line.
 * The line is plain text; it is spoken through the page's one live region (announce), once per change of text, so the
 * repaints a selection made meanwhile causes do not repeat it. The stage is labelled by the tab that is selected now.
 */
let shellSaid = null;
function renderShell(what) {
  renderTabs();
  renderLinkBar();
  a11y.labelStage();
  fill($('#stage'), el('p', { class: 'muted' }, what));
  const say = newStatus(shellSaid, what);
  if (say) { shellSaid = say; announce(say); }
}

const NOT_A_PLACE = new Set(['view-local', 'prefer', 'refused']);

function render() {
  a11y.beforeRender();
  // A view, example or composition the person chose is a place to come back to; a redraw is not, and neither is
  // arriving by a link or by back and forward (the hash already says it).
  writeHash({ push: !!state.event && !NOT_A_PLACE.has(state.event.type) });
  const v = views.get(state.view);
  if (!v) { // first use of this view: import it, then draw whatever view is current by then
    const id = state.view;
    renderShell(`Loading the ${VIEW_META[id].short} view…`);
    loadView(id).then(() => { if (state.view === id) render(); });
    return;
  }
  renderTabs();
  renderConvention(v);
  renderRules();
  renderComposition();
  renderSources();
  const stage = $('#stage');
  const scroll = [stage.scrollLeft, stage.scrollTop];
  fill(stage);
  resetSnap();
  renderToolbar(v); // after resetSnap, so palette pieces register for this render
  const manifest = makeManifest(state.view, state.example, 'live');
  const shownId = state.view;
  const ctx = makeCtx(stage, {
    snap, hover, manifest, connect4,
    shown: () => state.view === shownId,
    // A view's own redraw (its background work finishing, a toggle) never cuts a drag or keyboard linking, and is
    // dropped if the view was left meanwhile: it would redraw the view that is now shown, which has not changed.
    rerender: () => afterGesture(gestureActive, () => { if (state.view === shownId) actions.rerender(); }),
  });
  try {
    v.render(ctx);
  } catch (e) {
    console.error(e);
    fill(stage, el('pre', { class: 'warn' }, `render failed: ${e.stack || e}`));
  }
  lastManifest = manifest;
  shellSaid = null; // a later shell (another view's first use) is news again
  [stage.scrollLeft, stage.scrollTop] = scroll;
  renderLinkBar(); // after the view, which may have written its own parameters into the hash
  a11y.afterRender({ view: v, event: state.event });
  flash(state.event);
  state.event = null;
  document.body.dataset.example = state.example;
  document.body.dataset.view = state.view;
  if (!document.body.dataset.ready) performance.mark('compose:ready');
  document.body.dataset.ready = '1';
}

/**
 * The registry did not load: say why, and leave nothing that looks like it works (the tabs and example buttons are drawn,
 * disabled). The one-line message comes first, is spoken through the live region and is where focus goes (the disabled
 * tab that had it cannot keep it); the stack is behind "Technical details", not the first thing read. No role=alert: that
 * would be a second region speaking the same words.
 */
function renderFailure(e) {
  console.error(e);
  renderTabs(true);
  $('#ex-orders').disabled = $('#ex-connect4').disabled = true;
  const text = registryFailureText(e);
  const box = el('div', { class: 'stage-note warn', id: 'stage-failure', tabindex: '-1', role: 'group', 'aria-label': 'The page did not load' },
    el('p', {}, text),
    el('details', {}, el('summary', {}, 'Technical details'), el('pre', {}, String((e && e.stack) || e))));
  $('#stage').replaceChildren(box);
  announce(text);
  box.focus();
}

/** Is the key typed at someone who is typing (a field, a select, a contenteditable, an ARIA text box)? */
function typingAt(target) {
  const chain = [];
  for (let n = target; n && n.nodeType === 1; n = n.parentElement) chain.push({ tag: n.tagName, editable: n.isContentEditable === true, role: n.getAttribute('role') });
  return isTypingTarget(chain);
}

async function main() {
  // /compose.html?cid=<cid>: the stored model this link names (identity.js).
  // Shown first and on its own, so it appears even if the registry is slow.
  startModelPanel($('#model'));
  readHash();
  a11y.startedOn(state.view, state.example); // a different view at the first drawing was chosen while loading: say which
  initSnap();
  initInspector($('#inspector-body'));
  a11y.initA11y();
  $('#ex-orders').onclick = () => actions.setExample('orders');
  $('#ex-connect4').onclick = () => actions.setExample('connect4');
  $('#view-link-copy').onclick = (e) => copyLink(fullLink(currentLink()), e.currentTarget);
  $('#view-link').onfocus = (e) => e.target.select();
  $('#view-index').onclick = () => actions.setView(INDEX_VIEW.id);
  renderKeyHelp();
  // The start-up sequence (loader.js): until the registry is ready a tab, a key or a link only moves the
  // selection; nothing renders before the registry and the view exist.
  const startup = createStartup({
    state, subscribe, actions, readHash, viewIds: VIEW_IDS,
    initRegistry: () => registry.init(),
    // the facts are in: the a11y styles (distinct dashes) and the legend read them
    loadFacts: () => { loadFacts(); a11y.applyStyles(); renderLegend($('#legend')); },
    start: startFromLink, loadView, preloadView, indexView: INDEX_VIEW.id,
    // The wasm, the shown view's module (fetched, not yet evaluated) and the Connect-4 data are fetched together, not one after another.
    fetchAlongside: loadConnect4,
    renderShell: (what) => renderShell(what),
    render, failed: renderFailure,
    mark: (name) => performance.mark(name),
    // Test hook for screenshots: the same actions the UI calls, and what the last render drew.
    ready: () => { window.__pv = { state, actions, render, views, loadView, VIEW_IDS, VIEWS, registry, manifest: () => lastManifest?.result() }; },
  });
  window.addEventListener('keydown', (e) => {
    if (typingAt(e.target) || e.ctrlKey || e.metaKey || e.altKey) return; // not the browser's shortcuts, not someone typing
    if (kbActive()) {
      // link mode owns the keys; say so rather than ignore them in silence
      if (/^[0-9ev[\]]$/.test(e.key)) announce(VIEW_KEYS_OFF);
      return;
    }
    startup.onKey(e);
  });
  window.addEventListener('hashchange', () => startup.onHashChange());
  if (await startup.run()) loadRest();
}

/**
 * The other views, once the first is drawn: their modules are fetched together at low priority, then imported one by one
 * when the browser is idle, so a switch does not wait for the network, keeps working if the network goes, and none of it stands
 * between the page and its first view. A tab pressed sooner imports its view at once (render).
 */
function loadRest() {
  const idle = (f) => (window.requestIdleCallback ? window.requestIdleCallback(f, { timeout: 3000 }) : setTimeout(f, 200));
  const todo = VIEW_IDS.filter((id) => !views.has(id));
  todo.forEach((id) => preloadView(id, 'low'));
  const next = () => {
    const id = todo.shift();
    if (id) loadView(id).then(() => idle(next));
  };
  idle(next);
}

main();
export { renderInfo };
