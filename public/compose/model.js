// What the views know about the two examples, all of it read from pflow-native's
// registry (registry.js). The prototype (pflow-views-prototype js/model/*) had
// JS ports of go-pflow and pflow-rs here; none of them is carried over. This
// module keeps the prototype's function names and shapes so the views port
// with few changes, and answers every question by command:
//
//   facts         bundle.instances, bundle.scenarios, bundle.ontology, plan.pieces
//   flatten()     bundle.flatten (on the scratch engine for a link set the page
//                 does not show)
//   the token     bundle.run {script}: a marking is the run that reached it; a
//   game          transition's refusal is the registry's reason for the step
//   lens test     bundle.lens
//   plans         plan.check, plan.state (canonical JSON), plan.slot_candidates
//                 (the default an absent list stands for: pflow-rs's, read off
//                 the plan a drop would make)
//   Connect-4     sim.reset / sim.fire / sim.enabled / sim.marking on the net
//                 loaded into the c4 engine
//
// The citations below (which source line a drawing follows) are data, kept
// from the prototype with the revision they cite.

import { engines, Refusal, parseRefusal } from './registry.js';
import { cite, setSources } from './sources.js';

// ---- facts (filled by loadFacts) ----------------------------------------------------

export let NS = 'https://ontology.pflow.xyz/ns#';
export let PAT = 'https://ontology.pflow.xyz/pattern/';
export let LK = 'https://ontology.pflow.xyz/linkkind/';
export const LINK_KINDS = {};
export const LINK_STYLE = {};
export let LINK_STYLE_CITE = null;
export const PATTERNS = {};
export const IDIOMS = [];
export const CQ13 = {};
export const INSTANCE_SPECS = {};   // default instances, by id
export const EXTRA_SPECS = {};      // the extras (payment2, orders2, workers2), by id
export const CATALOG = [];          // bundle.instances, in order
export let DEFAULT_INSTANCES = [];
export const DEFAULT_LINKS = [];
export let PARAMS_NOTE = '';
export const SCENARIOS = [];
export const PIECES = [];
export const pieceByName = {};
export const SLOTS = [];
export let CONNECT4_EXACT = null;
export let PLAN_RS_REV = '';
export const PLAN_DEFAULTS = {};    // field -> the list an absent field stands for
export const FACTS = { ontology: null, instances: null, pieces: null };

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Read the facts every view draws from (once, after registry.init()). */
export function loadFacts() {
  const L = engines.live;
  const onto = L.call('bundle.ontology');
  FACTS.ontology = onto;
  setSources(onto.repos, onto.bib);
  NS = onto.ns.NS; PAT = onto.ns.PAT; LK = onto.ns.LK;
  Object.assign(LINK_KINDS, onto.link_kinds);
  Object.assign(LINK_STYLE, onto.link_style);
  LINK_STYLE_CITE = onto.link_style_cite;
  Object.assign(PATTERNS, onto.patterns);
  IDIOMS.splice(0, IDIOMS.length, ...onto.idioms);
  Object.assign(CQ13, onto.cq13);

  const inst = L.call('bundle.instances');
  FACTS.instances = inst;
  CATALOG.splice(0, CATALOG.length, ...inst.instances);
  for (const s of inst.instances) (s.extra ? EXTRA_SPECS : INSTANCE_SPECS)[s.id] = s;
  DEFAULT_INSTANCES = [...inst.default];
  DEFAULT_LINKS.splice(0, DEFAULT_LINKS.length, ...inst.default_links.map(linkOf));
  PARAMS_NOTE = inst.params_note;

  SCENARIOS.splice(0, SCENARIOS.length, ...L.call('bundle.scenarios').scenarios);

  const pc = L.call('plan.pieces');
  FACTS.pieces = pc;
  PIECES.splice(0, PIECES.length, ...pc.pieces.map((p) => ({ ...p, needsGoals: p.needs_goals, cites: PIECE_CITES[p.name] || [] })));
  for (const p of PIECES) pieceByName[p.name] = p;
  SLOTS.splice(0, SLOTS.length, ...pc.slots.map((s) => ({ ...s, cites: SLOT_CITES[s.id] || [] })));
  CONNECT4_EXACT = pc.default_plan;
  PLAN_RS_REV = pc.plan_rs;
  readPlanDefaults();
}

// ---- ports, links ---------------------------------------------------------------------

/** "subnet:port", the registry's port key (port ids may hold a colon: do:reserve). */
export const portKey = (ref) => `${ref.subnet}:${ref.port}`;
/** The inverse of portKey: subnet ids hold no colon, so split at the first. */
export const parsePortKey = (k) => { const i = k.indexOf(':'); return { subnet: k.slice(0, i), port: k.slice(i + 1) }; };
/** The registry's link key: "kind:from->to". */
export const linkKey = (l) => `${l.kind}:${portKey(l.from)}->${portKey(l.to)}`;
const endOf = (e) => (typeof e === 'string' ? parsePortKey(e) : { subnet: e.subnet, port: e.port });
export const linkOf = (l) => ({ kind: l.kind, from: endOf(l.from), to: endOf(l.to) });

/** The three idioms on the default instances (bundle.instances default_links). */
export function defaultLinks() {
  return DEFAULT_LINKS.map(clone);
}

/** A registry subnet (bundle.state) in the shape the views draw. */
export function subnetOf(s) {
  return {
    ...s,
    netKind: s.net_type,
    ports: s.ports.map((p) => ({ ...p, patternPort: p.pattern_port, ...(p.target === 'place' ? { transition: undefined } : { place: undefined }) })),
    steps: s.pattern === 'saga' ? (s.params.steps || []).map((x) => x.id) : undefined,
    accounts: s.pattern === 'saga' ? Object.keys(s.params.accounts || {}).sort() : undefined,
    cites: SUBNET_CITES[s.pattern] || [],
  };
}

// ---- Flatten ----------------------------------------------------------------------------

/**
 * bundle.flatten, in the prototype's shape: {ok, errors, model: {places,
 * transitions, arcs, constraints}, map: {place, transition, wires,
 * fusedGroups}, warnings, initialEnablement}. `engine` holds the composition.
 */
export function flattenOn(engine, links) {
  const f = engine.call('bundle.flatten');
  if (!f.ok) return { ok: false, errors: parseRefusal(f.error), error: f.error };
  const model = {
    places: f.places,
    transitions: f.transitions,
    arcs: f.arcs,
    constraints: f.constraints.map((c) => ({ ...c, subnet: c.id.slice(0, c.id.indexOf('/')) })),
  };
  // The token game and the scenario runs on this net go back to the engine
  // and the links it was flattened from (see fire()).
  Object.defineProperty(model, '__links', { value: links ? links.map(linkOf) : null, enumerable: false });
  return {
    ok: true,
    errors: [],
    model,
    map: { place: f.place_map, transition: f.transition_map, wires: f.wires, fusedGroups: f.fused_groups },
    warnings: f.warnings || [],
    initialEnablement: f.initial_enablement || [],
  };
}

let scratchKey = null;
/** Open (instances, links) on the scratch engine, unless it already holds them. */
export function openScratch(instances, links) {
  const ls = links.map(linkOf);
  const key = JSON.stringify([instances, ls.map(linkKey)]);
  if (key === scratchKey) return { ok: true };
  scratchKey = null;
  try {
    const r = engines.scratch.call('bundle.open', { instances, links: ls });
    scratchKey = key;
    return { ok: true, value: r };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * Flatten `subnets` (the instances, as the views pass them) joined by `links`:
 * on the live engine when that is what it holds, else on the scratch engine.
 * A link set the registry refuses comes back {ok: false, errors}.
 */
export function flatten(subnets, links) {
  const ids = subnets.map((s) => s.id);
  if (liveConfig && JSON.stringify(ids) === JSON.stringify(liveConfig.instances) && sameLinks(links, liveConfig.links)) {
    return flattenOn(engines.live, links);
  }
  const o = openScratch(ids, links);
  if (!o.ok) return { ok: false, errors: o.error.errors || parseRefusal(o.error.message), error: o.error.message };
  return flattenOn(engines.scratch, links);
}

const sameLinks = (a, b) => a.length === b.length && a.every((l, i) => linkKey(l) === linkKey(b[i]));

// The live configuration (state.js sets it after every edit), so flatten() of
// what the page shows asks the live engine.
let liveConfig = null;
export function setLiveConfig(instances, links) { liveConfig = { instances: [...instances], links: links.map(linkOf) }; }

/** The engine holding a flat model's links (live, or the scratch engine re-opened on them). */
function engineFor(model) {
  const links = model.__links;
  if (!links || (liveConfig && sameLinks(links, liveConfig.links))) return engines.live;
  openScratch(liveConfig ? liveConfig.instances : DEFAULT_INSTANCES, links);
  return engines.scratch;
}

// ---- the token game, by bundle.run -------------------------------------------------------
//
// A marking here is the final marking of a bundle.run {script}, carrying the
// script that reached it (non-enumerable __script). whyNotEnabled() runs the
// script plus the transition and reads the registry's reason for that step;
// fire() runs it and returns the new marking. Nothing is fired by the page.

const firstMember = (model, tid) => model.transitions.find((t) => t.id === tid)?.members?.[0] ?? null;

function withScript(marking, script) {
  Object.defineProperty(marking, '__script', { value: script, enumerable: false });
  return marking;
}

/** bundle.run of `script` (members) on the engine holding `model`'s links. */
export function runScript(model, script) {
  return engineFor(model).call('bundle.run', { script });
}

/** The flat net's initial marking (bundle.run of the empty script). */
export function initialMarking(model) {
  if (model.__c4) return c4.initial(model);
  const r = runScript(model, []);
  return withScript({ ...r.final_marking }, []);
}

/** null when `tid` (a flat transition) can fire at `marking`, else the registry's reason. */
export function whyNotEnabled(model, marking, tid) {
  if (model.__c4) return c4.why(model, marking, tid);
  const m = firstMember(model, tid);
  if (!m) return `no transition ${JSON.stringify(tid)} in the flat net`;
  const script = [...(marking.__script || []), m];
  const r = runScript(model, script);
  if (r.completed) return null;
  const st = r.steps[r.stopped_at] || r.steps[r.steps.length - 1];
  return st?.why || `${tid} cannot fire`;
}

export function enabled(model, marking, tid) { return whyNotEnabled(model, marking, tid) === null; }

/** Fire `tid` at `marking`: the registry's run one step further. Throws its reason when it cannot fire. */
export function fire(model, marking, tid) {
  if (model.__c4) return c4.fire(model, marking, tid);
  const m = firstMember(model, tid);
  const script = [...(marking.__script || []), m];
  const r = runScript(model, script);
  if (!r.completed) {
    const st = r.steps[r.stopped_at] || r.steps[r.steps.length - 1];
    throw new Error(st?.why || `${tid} cannot fire`);
  }
  return withScript({ ...r.final_marking }, script);
}

/** The flat transition a member "<subnet>/<transition>" ended up in. */
export function flatOf(map, member) {
  const i = member.indexOf('/');
  return map.transition[member.slice(0, i)]?.[member.slice(i + 1)] ?? null;
}
export function flatPlaceOf(map, member) {
  const i = member.indexOf('/');
  return map.place[member.slice(0, i)]?.[member.slice(i + 1)] ?? null;
}

/** A scenario run (bundle.run {scenario}) in the prototype's runScenario shape. */
export function runOf(r) {
  return {
    id: r.id, title: r.title,
    stoppedAt: r.stopped_at, stoppedStep: r.stopped_step,
    steps: r.steps, completed: r.completed, finalMarking: r.final_marking,
    expect: r.expect.map((e) => ({ ...e, got: e.actual, ok: e.pass })),
  };
}

/**
 * A member on its own: the composition with the event links that fuse it
 * removed (token, data and guard links kept), run one step from the initial
 * marking by bundle.run. null when it can fire, else the registry's reason.
 */
export function memberAlone(instances, links, member) {
  const keep = links.filter((l) => l.kind !== 'event');
  const o = openScratch(instances, keep);
  if (!o.ok) return o.error.message;
  const r = engines.scratch.call('bundle.run', { script: [member] });
  if (r.completed) return null;
  return r.steps[r.stopped_at]?.why || `${member} cannot fire`;
}

// ---- the lens test (bundle.lens) ----------------------------------------------------------

const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
function camelize(x) {
  if (Array.isArray(x)) return x.map(camelize);
  if (!x || typeof x !== 'object') return x;
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [camel(k), camelize(v)]));
}

/** bundle.lens's analysis in the prototype's lensfind.analyse() shape. */
export function lensAnalysisOf(a) {
  const c = camelize(a);
  if (!c.ok) return { ...c, errors: (a.errors || []).map((e) => (typeof e === 'string' ? parseRefusal(e)[0] : e)) };
  const partner = {};
  for (const p of c.partner || []) partner[p.t] = p;
  return {
    ...c,
    partner,
    steps: (c.steps || []).map((s) => ({ ...s, dead: s.dead || [], deadForward: s.deadForward ?? null })),
    runs: (a.runs || []).map(runOf),
  };
}

/** bundle.lens on the live composition: {analysis, fixes}, both in the prototype's shapes. */
export function lens({ fixes = true } = {}) {
  const r = engines.live.call('bundle.lens', { fixes });
  return {
    analysis: lensAnalysisOf(r.analysis),
    fixes: (r.fixes || []).map((f) => ({ ...camelize(f), link: linkOf(f.link), removed: (f.removed || []).map(linkOf), result: f.result ? lensAnalysisOf(f.result) : null })),
  };
}

// ---- plans ---------------------------------------------------------------------------------

/** plan.check: null when pflow-rs accepts `plan` for Connect-4, else its message. */
export function check(plan) {
  const r = engines.scratch.call('plan.check', { plan });
  return r.ok ? null : r.error;
}
export const solverCheck = check;

/** The canonical plan (keys in plan.rs order), as plan.open/plan.state make it. */
export function toJSON(plan) {
  engines.scratch.call('plan.open', { plan });
  return engines.scratch.call('plan.state').plan;
}

// The list an absent field stands for, pflow-rs's (the registry adds a dropped
// piece to it: plan.slot_candidates on a plan without the field shows the list).
function readPlanDefaults() {
  engines.scratch.call('plan.open', { plan: { mode: 'exact' } });
  const c = engines.scratch.call('plan.slot_candidates', { piece: 'beam' });
  for (const s of c.slots) {
    const slot = SLOTS.find((x) => x.id === s.slot);
    if (!slot || !slot.field || !s.plan || !Array.isArray(s.plan[slot.field])) continue;
    PLAN_DEFAULTS[slot.field] = s.plan[slot.field].slice(0, -1);
  }
}

/** A list field as the solver reads it: explicit, or the default an absent field stands for. */
export function fieldOrDefault(plan, field) {
  if (Array.isArray(plan[field])) return clone(plan[field]);
  return clone(PLAN_DEFAULTS[field] || []);
}

/** The order chain the plan configures: {pieces, isDefault}. Legality is plan.check's. */
export function chainOf(plan) {
  if (!Array.isArray(plan.order)) return { pieces: [...(PLAN_DEFAULTS.order || [])], isDefault: true };
  return { pieces: plan.order.filter((x) => typeof x === 'string'), isDefault: false };
}

/**
 * The drivers the plan configures, as plan.rs reads the list into flags (its
 * order does not change the nesting; a second budget replaces the first):
 * {nullWindow, budget}. Legality is plan.check's.
 */
export function driversOf(plan) {
  const list = fieldOrDefault(plan, 'drivers');
  const d = { nullWindow: false, budget: null };
  for (const v of list) {
    if (v === 'null_window') d.nullWindow = true;
    else if (v && typeof v === 'object' && v.budget && Number.isInteger(v.budget.nodes)) d.budget = v.budget.nodes;
  }
  return d;
}

// ---- Connect-4, through the c4 engine's token game ------------------------------------------
//
// The net is loaded once; a marking carries the transitions fired from the
// initial marking (__fired), and the engine is replayed to it when asked about
// another one. Enabled sets come from sim.enabled, refusals from sim.fire's own
// message (a refused fire changes nothing).

const c4 = {
  doc: null, at: null, enabledAt: null,
  load(net) {
    if (this.doc === net) return;
    engines.c4.load(net);
    this.doc = net; this.at = null; this.enabledAt = null;
  },
  goto(model, fired) {
    this.load(model.__c4);
    const key = fired.join(' ');
    if (this.at === key) return;
    engines.c4.call('sim.reset');
    for (const t of fired) engines.c4.call('sim.fire', { id: t });
    this.at = key; this.enabledAt = null;
  },
  markingNow() {
    const m = engines.c4.call('sim.marking');
    const flat = m.marking || m.tokens || m;
    const out = {};
    for (const [k, v] of Object.entries(flat)) out[k] = Array.isArray(v) ? v.reduce((a, b) => a + b, 0) : (typeof v === 'object' && v ? Object.values(v).reduce((a, b) => a + b, 0) : v);
    return out;
  },
  initial(model) {
    this.goto(model, []);
    const m = this.markingNow();
    Object.defineProperty(m, '__fired', { value: [], enumerable: false });
    return m;
  },
  enabledSet(model, marking) {
    this.goto(model, marking.__fired || []);
    if (!this.enabledAt) {
      const e = engines.c4.call('sim.enabled');
      this.enabledAt = new Set(Array.isArray(e) ? e : e.enabled || []);
    }
    return this.enabledAt;
  },
  why(model, marking, tid) {
    if (this.enabledSet(model, marking).has(tid)) return null;
    try {
      engines.c4.call('sim.fire', { id: tid });
    } catch (e) {
      return e.message;
    }
    // it fired after all: put the engine back
    this.at = null;
    this.goto(model, marking.__fired || []);
    return null;
  },
  fire(model, marking, tid) {
    const fired = [...(marking.__fired || []), tid];
    this.goto(model, marking.__fired || []);
    engines.c4.call('sim.fire', { id: tid });
    this.at = fired.join(' '); this.enabledAt = null;
    const m = this.markingNow();
    Object.defineProperty(m, '__fired', { value: fired, enumerable: false });
    return m;
  },
};

/** Mark a model built from the Connect-4 net so the token game goes to the c4 engine. */
export function c4Model(model, net) {
  Object.defineProperty(model, '__c4', { value: net, enumerable: false });
  return model;
}

/** analysis.incidence of the Connect-4 net (the c4 engine's document). */
export function c4Incidence(net) {
  c4.load(net);
  return engines.c4.call('analysis.incidence');
}

// ---- citations (data: which source line a drawing follows) -------------------------------

const go = (path, from, to = from, note = '') => cite('goPflow', path, from, to, note);
const rs = (path, from, to = from, note = '') => cite('pflowRs', `crates/pflow-metamodel/src/${path}`, from, to, note);
const road = (from, to, note) => cite('ontologyRoadmap', 'ROADMAP.md', from, to, note);

export const FLATTEN_CITES = [
  go('metamodel/compose_flatten.go', 15, 27, 'Flatten pipeline'),
  go('metamodel/unionfind.go', 1, 60, 'the smallest member names the class'),
  go('metamodel/compose_flatten.go', 201, 227, 'flat names: wire:… and fused:…'),
  go('metamodel/compose_flatten.go', 252, 333, 'mergePlaces: initial sums, capacity is the tightest'),
  go('metamodel/compose_flatten.go', 335, 412, 'mergeArcs: MergeSum'),
  go('metamodel/compose_fuse.go', 84, 192, 'fuseClass'),
];

export const RULE_CITES = {
  endpoint: go('metamodel/compose.go', 635, 659, 'endpoint kinds must match the link kind'),
  legal: go('metamodel/compose_matrix.go', 16, 57, 'linkLegal: the net-type x link-kind matrix'),
  schema: go('metamodel/compose.go', 667, 674, 'port schema tags must agree when both are set'),
  placePair: go('metamodel/compose.go', 709, 732, 'validatePlacePair: kind and type of the fused places'),
  direction: go('metamodel/compose.go', 676, 683, 'token link: from not an in-port, to not an out-port'),
  observer: go('metamodel/compose.go', 734, 748, 'validateDataLinkObserver: the observer moves nothing on the place'),
  guard: go('metamodel/compose.go', 687, 706, 'guard link: condition, lowering, W_RESTRICTIVE_LINK'),
  twoSubnets: go('metamodel/compose.go', 175, 176, 'Link connects two subnets (page rule PAGE_SAME_SUBNET; Validate does not check it)'),
};

const SUBNET_CITES = {
  queue: [go('metamodel/queue.go', 71, 174, 'NewQueue')],
  'resource-pool': [go('metamodel/patterns.go', 268, 300, 'NewResourcePool'), go('metamodel/patterns_compose.go', 81, 103, 'ToSubnet')],
  saga: [go('saga/metasubnet.go', 73, 119, 'ToMetaSubnet'), go('saga/metasubnet.go', 146, 255, 'places and transitions')],
};

export const CONNECT4_EXACT_CITE = rs('plan.rs', 6, 11, 'module doc example');

const PIECE_CITES = {
  tt_best: [rs('order.rs', 40, 58, 'TtBest')],
  immediate_win: [rs('order.rs', 44, 66, 'ImmediateWin')],
  history: [rs('order.rs', 48, 76, 'History')],
  centrality: [rs('order.rs', 78, 93, 'Centrality')],
  threats: [rs('order.rs', 83, 104, 'Threats')],
  null_window: [rs('plan.rs', 17, 19), rs('game.rs', 556, 588, 'Solver::solve')],
  budget: [rs('plan.rs', 18, 19), rs('game.rs', 593, 597, 'search: nodes > budget')],
  memo: [rs('plan.rs', 20, 20), rs('game.rs', 495, 505, 'Solver::with_memo')],
  beam: [rs('plan.rs', 70, 71, 'UNSOUND')],
  static_eval: [rs('plan.rs', 70, 71, 'UNSOUND')],
  mtd_f: [road(350, 350, 'approved candidate pieces')],
  forced_moves: [road(353, 353, 'approved candidate pieces')],
  lmr: [road(354, 354, 'approved candidate pieces')],
  futility: [road(355, 355, 'approved candidate pieces')],
};

const SLOT_CITES = {
  drivers: [rs('plan.rs', 146, 193, 'drivers()')],
  order: [rs('plan.rs', 196, 210, 'chain()'), rs('order.rs', 1, 13, 'a chain of pieces, compared one after the other')],
  filters: [rs('plan.rs', 222, 236)],
  heuristics: [rs('plan.rs', 222, 236)],
  memo: [rs('plan.rs', 107, 112, 'Memo'), rs('plan.rs', 219, 221)],
  bounds: [road(307, 307, 'No Bound kind')],
  engine: [road(307, 307, 'No engine choice: game.rs picks BitModel or IndexedModel itself')],
};

export const SEARCH_CITES = {
  value: rs('game.rs', 526, 554, 'Solver::value: nodes reset, then solve'),
  solve: rs('game.rs', 556, 588, 'Solver::solve: yes/no searches, one per gap between rewards'),
  search: rs('game.rs', 590, 693, 'Solver::search: fail-soft alpha-beta with the transposition table'),
  budget: rs('game.rs', 594, 597, 'nodes > budget: give up (None)'),
  ttRead: rs('game.rs', 599, 611, 'tt.get: bounds and the remembered best move'),
  cutoff: rs('game.rs', 666, 666, 'chain.cutoff: a cutoff is reported back to the pieces'),
  store: rs('game.rs', 514, 519, 'store: remember what a search found, space allowing'),
  chainKey: rs('order.rs', 197, 272, 'Chain: keys compared piece by piece, decisive pieces form a top tier'),
  orderOnly: rs('order.rs', 1, 7, 'Order never changes a value, only how soon a cutoff comes'),
  driversFlags: rs('plan.rs', 146, 193, 'drivers are read into flags: their order in the JSON does not change the nesting'),
};
export const PLAN_LAWS_CITE = road(418, 430, 'Search composition: orderer monoid, drivers as endomorphisms, Solver = drivers ∘ core[…]');

export { Refusal };
