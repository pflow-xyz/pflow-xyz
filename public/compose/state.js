// One store for the page: which example and view, and what the registry holds
// open on the live engine (the orders composition and the search plan). Views
// never mutate it; they call actions, which run the registry's own edit
// commands (bundle.add_link, plan.add_piece, …). An edit the registry refuses
// changes nothing and comes back with its "[CODE] message". After every edit
// the store re-reads bundle.state / plan.state, so what the views draw is what
// the registry holds.
//
// Neither the composition nor the plan is in the engine's saved session state
// (session.dump_state), so start() opens both by command on every load.

import { resolveView } from './views-meta.js';
import { readLink, writeLink, encodeLinks, decodeLinks, encodePlan, decodePlan } from './links.js';
import { IDIOMS, pieceByName, linkOf, linkKey, subnetOf, flattenLive, liveCommand, setLiveConfig, portKey, EXTRA_SPECS } from './model.js';

const listeners = new Set();
let bumping = false;

export const state = {
  example: 'orders',
  view: 'cospan',
  orders: {
    instances: [],   // instance ids, bundle.state order
    subnets: [],     // bundle.state subnets, in the views' shape (model.js subnetOf)
    links: [],       // bundle.state links: {kind, from, to, index, key, idiom, leak}
    extras: [],      // the extras that are in the composition
    prefer: 'auto',  // link kind a drag tries first (bundle.candidates prefer)
    unavailable: [],
    dropped: [],
  },
  plan: null,        // plan.state: {plan, json, check}
  version: 0,        // bumped after every edit; derived values are cached per version
  event: null,       // what just changed, for a view's merge animation; cleared after one render
  error: null,       // the last refusal, for the page to show
  linkWarning: null, // what a link asked for that the registry would not open, until the next link or edit
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function notify(event) {
  state.event = event;
  if (bumping) return;
  bumping = true;
  queueMicrotask(() => { bumping = false; for (const fn of listeners) fn(state.event); });
}

const L = liveCommand;

/** Re-read the composition (bundle.state) into the store. */
function readComposition() {
  const st = L('bundle.state');
  state.orders.instances = [...st.instances];
  state.orders.subnets = st.subnets.map(subnetOf);
  state.orders.links = st.links.map((l) => ({ ...linkOf(l), index: l.index, key: l.key, idiom: l.idiom ?? null, leak: !!l.leak }));
  state.orders.extras = st.subnets.filter((s) => s.extra).map((s) => s.id);
  state.orders.unavailable = st.unavailable || [];
  state.orders.dropped = st.dropped_links || [];
  setLiveConfig(state.orders.instances, state.orders.links);
  state.version++;
}

function readPlan() {
  state.plan = L('plan.state');
  state.version++;
}

/**
 * Open the composition and the plan: by default bundle.open {} and
 * plan.open {} (the three idioms on orders, workers, payment; the Connect-4
 * exact plan). Then each step of `steps` ([id, args]) on the live engine, as a
 * state of the parity contract is reached.
 */
export function start({ instances, links, plan, steps = [] } = {}) {
  L('bundle.open', { ...(instances ? { instances } : {}), ...(links ? { links } : {}) });
  L('plan.open', plan ? { plan } : {});
  for (const [id, args] of steps) L(id, args);
  readComposition();
  readPlan();
  state.event = null;
}

// --- derived (cached per state.version) ------------------------------------------------

const cache = { version: -1 };
function cached(key, fn) {
  if (cache.version !== state.version) { for (const k of Object.keys(cache)) delete cache[k]; cache.version = state.version; }
  if (cache[key] == null) cache[key] = fn();
  return cache[key];
}

export function activeSubnets() { return state.orders.subnets; }
export function subnetsById() { return Object.fromEntries(state.orders.subnets.map((s) => [s.id, s])); }
export function orderLinks() { return state.orders.links; }
/** bundle.flatten of the live composition. */
export function flatOrders() { return cached('flat', () => flattenLive(state.orders.links)); }

/** The live plan: {plan, json (canonical object), text, error (pflow-rs's message or null), candidates(name)}. */
export function planInfo() {
  return cached('planInfo', () => {
    const p = state.plan;
    return {
      plan: p.plan,
      json: p.plan,
      text: p.json,
      error: p.check.ok ? null : p.check.error,
      step: p.check.step,
      candidates: (name) => slotCandidates(name),
    };
  });
}

/** bundle.candidates: every other port judged as the far end of a link dragged from `ref`. */
export function linkCandidates(ref, prefer = state.orders.prefer) {
  return L('bundle.candidates', { from: { subnet: ref.subnet, port: ref.port }, prefer }).candidates;
}

/** plan.slot_candidates: per slot, ok and why, and the plan the drop would make. */
export function slotCandidates(name) {
  return L('plan.slot_candidates', { piece: name }).slots;
}

// --- actions ----------------------------------------------------------------------------

function refused(e) {
  state.error = { message: e.message, errors: e.errors || [] };
  notify({ type: 'refused', error: state.error });
}

export const actions = {
  setExample(ex) { if (state.example !== ex) { state.example = ex; notify({ type: 'example' }); } },
  setView(v) { if (state.view !== v) { state.view = v; notify({ type: 'view' }); } },
  setPrefer(kind) { state.orders.prefer = kind; notify({ type: 'prefer' }); },

  /** bundle.add_link: added if the registry's rules allow it; returns {ok, verdict} either way. */
  addLink(link) {
    const l = linkOf(link);
    let r;
    try {
      r = L('bundle.add_link', { kind: l.kind, from: l.from, to: l.to });
    } catch (e) {
      refused(e);
      return { ok: false, verdict: { ok: false, kind: l.kind, errors: e.errors, warnings: [], passed: [] } };
    }
    readComposition();
    const idiom = r.idiom ? IDIOMS.find((i) => i.key === r.idiom) || null : null;
    notify({ type: 'link-added', link: { ...l, index: r.index, key: r.key }, rule: r.rule, verdict: r.verdict, idiom });
    return { ok: true, verdict: r.verdict };
  },
  removeLink(index) {
    const link = state.orders.links[index];
    try { L('bundle.remove_link', { index }); } catch (e) { refused(e); return; }
    readComposition();
    notify({ type: 'link-removed', link });
  },
  resetLinks() { try { L('bundle.reset_links'); } catch (e) { refused(e); return; } readComposition(); notify({ type: 'links-reset' }); },
  clearLinks() { L('bundle.clear_links'); readComposition(); notify({ type: 'links-cleared' }); },
  toggleExtra(id) {
    const on = state.orders.instances.includes(id);
    try { L(on ? 'bundle.remove_instance' : 'bundle.add_instance', { id }); } catch (e) { refused(e); return; }
    readComposition();
    notify({ type: on ? 'instance-removed' : 'instance-added', id });
  },

  /** plan.add_piece: put a piece in a slot if pflow-rs accepts the plan it makes. */
  addPiece(name, slotId, index = null) {
    try {
      L('plan.add_piece', { piece: name, slot: slotId, ...(index === null ? {} : { index }) });
    } catch (e) {
      refused(e);
      return { ok: false, why: e.message };
    }
    readPlan();
    notify({ type: 'piece-added', name, slot: slotId, piece: pieceByName[name] });
    return { ok: true };
  },
  removePiece(slotId, index) {
    try { L('plan.remove_piece', { slot: slotId, index }); } catch (e) { refused(e); return; }
    readPlan();
    notify({ type: 'piece-removed', slot: slotId, index });
  },
  /** plan.move_piece (order changes nodes, never the value). */
  movePiece(slotId, from, to) {
    try { L('plan.move_piece', { slot: slotId, from, to }); } catch (e) { refused(e); return; }
    readPlan();
    notify({ type: 'piece-moved', slot: slotId, from, to });
  },
  /** A view's own controls changed: redraw without changing the model. */
  rerender() { notify({ type: 'view-local' }); },
  setMode(mode) { try { L('plan.set_mode', { mode }); } catch (e) { refused(e); return; } readPlan(); notify({ type: 'mode', mode }); },
  resetPlan() { L('plan.open', {}); readPlan(); notify({ type: 'plan-reset' }); },
};

/** The extras the catalog offers (bundle.instances: payment2, orders2, workers2). */
export function extraSpecs() { return EXTRA_SPECS; }
export { linkKey, portKey };

// URL hash (links.js has the format). Back and forward land here too: a hash that names another composition
// or plan opens it on the live engine, and whatever the registry refuses is said and not drawn.
let linked = {};      // the inst, links and plan the hash last asked for
let defaults = null;  // what bundle.open {} and plan.open {} hold; set by startFromLink, when there is an engine

export function readHash() {
  const l = readLink(location.hash);
  if (l.ex === 'orders' || l.ex === 'connect4') state.example = l.ex;
  // An id no view has (a stale or mistyped link) leaves the view as it is: the next write puts the real one back.
  const view = resolveView(l.view);
  if (view) state.view = view;
  linked = l;
  if (defaults) openLinked();
}

/** Open what the page has on load, then what its link asks for. The link is read first (readHash). */
export function startFromLink() {
  start();
  defaults = { instances: state.orders.instances.join(','), links: encodeLinks(state.orders.links), plan: state.plan.json };
  openLinked();
}

function linkRefused(what, e) {
  state.linkWarning = `This link's ${what} was not opened: ${e.message || e}`;
  state.error = { message: state.linkWarning, errors: e.errors || [] };
  state.event = { type: 'refused', error: state.error };
}

function openLinked() {
  state.linkWarning = null;
  const instances = linked.inst ?? defaults.instances, links = linked.links ?? defaults.links;
  if (instances !== state.orders.instances.join(',') || links !== encodeLinks(state.orders.links)) {
    try {
      L('bundle.open', { instances: instances.split(','), links: decodeLinks(links) });
      const dropped = L('bundle.state').dropped_links;
      if (dropped.length) throw new Error(dropped.map((d) => d.reason).join('; '));
      readComposition();
    } catch (e) {
      linkRefused('composition', e);
      L('bundle.open', {});
      readComposition();
    }
  }
  const plan = linked.plan ?? encodePlan(defaults.plan);
  if (plan !== encodePlan(state.plan.json)) {
    try {
      L('plan.open', { plan: decodePlan(plan) });
      const check = L('plan.state').check;
      if (!check.ok) throw new Error(check.error);
      readPlan();
    } catch (e) {
      linkRefused('plan', e);
      L('plan.open', {});
      readPlan();
    }
  }
}

/** The composition and plan as a link says them: nothing, where they are the default ones. */
function linkedState() {
  if (!defaults) return { inst: linked.inst, links: linked.links, plan: linked.plan };
  const inst = state.orders.instances.join(','), links = encodeLinks(state.orders.links), plan = state.plan.json;
  return {
    inst: inst === defaults.instances ? undefined : inst,
    links: links === defaults.links ? undefined : links,
    plan: plan === defaults.plan ? undefined : encodePlan(plan),
  };
}

/** The hash that opens a view on an example with this composition and plan. */
export function linkTo(view, ex) { return writeLink({ view, ex, ...linkedState() }); }

/** The hash of what is shown, with the parameters a view keeps there. */
export function currentLink() { return writeLink({ view: state.view, ex: state.example, ...linkedState(), own: readLink(location.hash).own }); }

/** Put what is shown in the address: as a new history entry when asked, so back returns to what was there. */
export function writeHash({ push = false } = {}) {
  if (push) state.linkWarning = null; // the person has moved on from the link that said it
  const h = currentLink();
  linked = readLink(h);
  if (location.hash === h) return;
  if (push) history.pushState(null, '', h); else history.replaceState(null, '', h);
}
