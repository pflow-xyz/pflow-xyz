// The composition views page (public/compose.html): example switch, view tabs,
// toolbar, side panels and the render loop. Views live in views/<id>.js and get
// a ctx (ctx.js). Every rule they show is the registry's (registry.js): the
// page loads pflow-native's wasm, opens the composition and the plan by command
// (bundle.open, plan.open) and re-reads them after every edit.

import * as registry from './registry.js';
import { loadFacts, LINK_KINDS, LINK_STYLE, EXTRA_SPECS, PARAMS_NOTE, PIECES, PLAN_RS_REV, FACTS } from './model.js';
import { state, subscribe, actions, subnetsById, orderLinks, flatOrders, planInfo, readHash, writeHash, start } from './state.js';
import { initSnap, resetSnap, snap, kbActive } from './snap.js';
import { initInspector, hover, renderInfo } from './inspect.js';
import { el } from './dom.js';
import * as theme from './theme.js';
import * as info from './info.js';
import { citeLabel, citeURL, bibLabel, bibURL } from './sources.js';
import { makeCtx, VIEW_IDS } from './ctx.js';
import { makeManifest } from './manifest.js';
import * as a11y from './a11y.js';
import { isTypingTarget } from './a11y-nav.js';
import { announce } from './a11y-bus.js';
import { renderLegend } from './legend.js';

const views = new Map();
let connect4 = null;
let lastManifest = null;

async function loadViews() {
  for (const id of VIEW_IDS) {
    try {
      const m = await import(`./views/${id}.js`);
      views.set(id, m.default);
    } catch (e) {
      views.set(id, { id, title: id, short: id, broken: String(e), convention: { summary: `View ${id} failed to load: ${e}` }, render() {} });
    }
  }
}

async function loadConnect4() {
  try { connect4 = await (await fetch(new URL('assets/connect-4.json', import.meta.url))).json(); } catch { connect4 = null; }
}

// --- rendering --------------------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const fill = (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

function renderTabs() {
  fill($('#tabs'), ...VIEW_IDS.map((id, i) => {
    const v = views.get(id);
    return el('button', { class: `tab${state.view === id ? ' active' : ''}${v.broken ? ' broken' : ''}`, title: v.title, onclick: () => actions.setView(id) }, `${i + 1}. ${v.short || v.title}`);
  }));
  $('#ex-orders').classList.toggle('active', state.example === 'orders');
  $('#ex-connect4').classList.toggle('active', state.example === 'connect4');
}

function renderToolbar() {
  const tb = $('#toolbar');
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
    const groups = [['Order', 'order pieces'], ['Driver', 'drivers'], ['Memo', 'memo'], ['Filter', 'filters'], ['Heuristic', 'heuristics']];
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

function render() {
  a11y.beforeRender();
  writeHash();
  renderTabs();
  const v = views.get(state.view) || views.get(VIEW_IDS[0]);
  renderConvention(v);
  renderRules();
  renderComposition();
  renderSources();
  const stage = $('#stage');
  const scroll = [stage.scrollLeft, stage.scrollTop];
  fill(stage);
  resetSnap();
  renderToolbar(); // after resetSnap, so palette pieces register for this render
  const manifest = makeManifest(state.view, state.example, 'live');
  const ctx = makeCtx(stage, { snap, hover, manifest, connect4 });
  try {
    v.render(ctx);
  } catch (e) {
    console.error(e);
    fill(stage, el('pre', { class: 'warn' }, `render failed: ${e.stack || e}`));
  }
  lastManifest = manifest;
  [stage.scrollLeft, stage.scrollTop] = scroll;
  a11y.afterRender({ view: v, event: state.event });
  flash(state.event);
  state.event = null;
  document.body.dataset.example = state.example;
  document.body.dataset.view = state.view;
  document.body.dataset.ready = '1';
}

/** Is the key typed at someone who is typing (a field, a select, a contenteditable, an ARIA text box)? */
function typingAt(target) {
  const chain = [];
  for (let n = target; n && n.nodeType === 1; n = n.parentElement) chain.push({ tag: n.tagName, editable: n.isContentEditable === true, role: n.getAttribute('role') });
  return isTypingTarget(chain);
}

async function main() {
  readHash();
  initSnap();
  initInspector($('#inspector-body'));
  a11y.initA11y();
  $('#ex-orders').onclick = () => actions.setExample('orders');
  $('#ex-connect4').onclick = () => actions.setExample('connect4');
  window.addEventListener('keydown', (e) => {
    if (typingAt(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (kbActive()) {
      // link mode owns the keys: a number that did nothing, silently, would look like a broken page
      if (/^[0-9e]$/.test(e.key)) announce('Linking is on, so the view keys are off. Escape cancels linking.');
      return;
    }
    const n = e.key === '0' ? 10 : Number(e.key);
    if (n >= 1 && n <= VIEW_IDS.length) actions.setView(VIEW_IDS[n - 1]);
    if (e.key === 'e') actions.setExample(state.example === 'orders' ? 'connect4' : 'orders');
  });
  window.addEventListener('hashchange', () => { readHash(); render(); });
  const stage = $('#stage');
  stage.replaceChildren(el('p', { class: 'muted' }, 'Loading pflow-native\'s registry (wasm)…'));
  try {
    await registry.init();
    loadFacts();
    a11y.applyStyles();
    renderLegend($('#legend'));
    start();
  } catch (e) {
    console.error(e);
    stage.replaceChildren(el('pre', { class: 'warn' }, `The registry did not load: ${e.stack || e}`));
    return;
  }
  await Promise.all([loadViews(), loadConnect4()]);
  if (!views.has(state.view)) state.view = VIEW_IDS[0];
  subscribe(render);
  // Test hook for screenshots: the same actions the UI calls, and what the last render drew.
  window.__pv = { state, actions, render, views, VIEW_IDS, registry, manifest: () => lastManifest?.result() };
  render();
}

main();
export { renderInfo };
