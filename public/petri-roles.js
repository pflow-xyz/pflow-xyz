// petri-roles.js — what a console knows about a net before anyone runs it.
//
// The derivation is sim.pflow.xyz's (sim-pflow-xyz web/lib/sim-derive.js at
// ea76b34e, 2026-09-30), copied verbatim from deriveRoles down so the two can
// be diffed: pools, sources, losses, queues, terminals, services, and the
// disruptions a console offers without anyone authoring them, grouped by the
// question they ask. ROADMAP phase 7 (open decision 3) proposes this file as
// the shared copy, pflow-xyz being canonical for shared browser JS; until sim
// vendors it, parity/roles/ pins it to goldens sim's own module produced
// (scripts/gen-roles-goldens.mjs).
//
// Only the adapter is new: rolesOf(net) reads the editor's JSON-LD.
//   - sim's read arc (place → transition, type "read") is the editor's
//     inhibit-flagged transition → place arc; an inhibitor is an
//     inhibit-flagged place → transition arc;
//   - labels come from each node's label;
//   - the rates document is the net's own: each place's initial total and
//     each transition's rate (default 1.0), with no fungible classes (the
//     server-side classifier is sim's).
// compareBumps and previewSupport stay in sim: they need sim's classifier
// and sim's browser engine.

/**
 * The editor's net in sim's model shape, plus the rates document deriveRoles
 * reads.
 */
export function toSim(net) {
    const places = Object.entries(net.places || {}).map(([id, p]) => ({ id, ...(p.label ? { tags: { label: p.label } } : {}) }));
    const transitions = Object.entries(net.transitions || {}).map(([id, t]) => ({ id, ...(t.label ? { tags: { label: t.label } } : {}) }));
    const isPlace = (id) => Object.prototype.hasOwnProperty.call(net.places || {}, id);
    const arcs = (net.arcs || []).map((a) => {
        if (!a.inhibitTransition) return { from: a.source, to: a.target };
        return isPlace(a.source)
            ? { from: a.source, to: a.target, type: 'inhibitor' }
            : { from: a.target, to: a.source, type: 'read' };
    });
    const initial = {}, rates = {};
    for (const [id, p] of Object.entries(net.places || {})) initial[id] = [].concat(p.initial ?? 0).reduce((x, y) => x + (Number(y) || 0), 0);
    for (const [id, t] of Object.entries(net.transitions || {})) rates[id] = typeof t.rate === 'number' && t.rate >= 0 ? t.rate : 1.0;
    return { model: { places, transitions, arcs }, rates: { initial, rates, classes: [] } };
}

/** Roles and derived disruptions of an editor net. */
export function rolesOf(net, horizon = 8) {
    const { model, rates } = toSim(net);
    const roles = deriveRoles(model, rates);
    return { roles, disruptions: deriveDisruptions(roles, horizon) };
}

/** The question each derived disruption kind asks (sim-controls.js's grouping). */
export const DISRUPTION_QUESTIONS = [
    ['down_', 'Something is unavailable'],
    ['wave_', 'A rush arrives'],
    ['backlog_', 'Work is already waiting'],
    ['closed_', 'A service is closed'],
];

/** Derived disruptions grouped by the question they ask, empty groups dropped. */
export function groupDisruptions(disruptions) {
    return DISRUPTION_QUESTIONS.map(([prefix, question]) => ({ question, items: disruptions.filter((d) => d.id.startsWith(prefix)) }))
        .filter((g) => g.items.length);
}

// ---- sim-pflow-xyz web/lib/sim-derive.js, verbatim from here ----

/**
 * Roles derived from the net alone.
 *
 * @returns {{pools: Array, sources: Array, losses: Array, queues: string[],
 *            terminals: string[], services: Array, delayed: string[],
 *            labels: Object, units: Object}}
 */
export function deriveRoles (model, rates) {
  const places = (model.places || []).filter((p) => !p.kind || p.kind === 'token')
  const placeIds = new Set(places.map((p) => p.id))
  const transIds = new Set((model.transitions || []).map((t) => t.id))
  const arcs = model.arcs || []
  // Only a normal arc consumes; read/inhibitor arcs test and take nothing.
  const consuming = arcs.filter((a) => !a.type && placeIds.has(a.from) && transIds.has(a.to))
  const producing = arcs.filter((a) => transIds.has(a.from) && placeIds.has(a.to))
  // "Fed by something" means fed by a *consuming* arc. A read or inhibitor
  // arc gates a transition without supplying it, so an arrival that is
  // merely gated — the clinic's emergency stream, which only runs when the
  // door is open — is still an arrival process and still deserves a rate
  // slider. Counting the gate as an input hid it.
  const hasInput = new Set(consuming.map((a) => a.to))
  const consumedFrom = new Set(consuming.map((a) => a.from))
  const producedTo = new Set(producing.map((a) => a.to))
  const initial = rates.initial || {}

  // Pools: initially stocked, and both drawn on and returned to by the net —
  // the consumed-and-returned shape of a resource an operator could add to.
  let pools = places
    .filter((p) => (initial[p.id] || 0) > 0 && consumedFrom.has(p.id) && producedTo.has(p.id))
    .map((p) => ({ id: p.id, initial: initial[p.id], max: Math.max(4 * initial[p.id], initial[p.id] + 4) }))

  // Fungible sets become one control, because they are one question. A net
  // with fork_0..fork_4 is asking how many forks, not five separate things,
  // and five sliders that must be dragged together are five ways to ask it
  // wrong. The server decides what is fungible — same structural signature
  // and names differing only in an index — so the rule lives in one place
  // rather than being re-derived here.
  //
  // Only *fungible* collapses. A family (abandon_minor, abandon_moderate)
  // shares a shape and a stem but its members are genuinely distinguishable,
  // and forcing one value across them is a modelling choice the console has
  // no business making.
  const byMember = new Map()
  for (const c of (rates.classes || []).filter((c) => c.kind === 'FungibleSet')) {
    for (const id of c.members) byMember.set(id, c)
  }
  const collapsed = []
  const seenClass = new Set()
  for (const p of pools) {
    const c = byMember.get(p.id)
    if (!c) { collapsed.push(p); continue }
    if (seenClass.has(c.id)) continue
    seenClass.add(c.id)
    collapsed.push({ ...p, id: c.id, members: c.members, label: `${c.id} (${c.members.length})` })
  }
  pools = collapsed

  // Sources: transitions nothing feeds, firing at a declared positive rate —
  // the arrival processes, and the only rates worth a generic slider.
  //
  // A transition that declares a `delay` is a fixed duration, not a rate:
  // /rates still reports it at the default rate of 1, but both engines zero
  // that rate and run the delay instead, so a rate slider on it would move
  // nothing. Such a source or patience is left out of the sliders and named
  // in `delayed`, so the console can say why it has no control rather than
  // offering one that does nothing.
  const isDelayed = (t) => t.delay > 0
  const delayed = []
  const sources = (model.transitions || [])
    .filter((t) => !hasInput.has(t.id) && (rates.rates?.[t.id] || 0) > 0)
    .filter((t) => !isDelayed(t) || (delayed.push(t.id), false))
    .map((t) => ({ id: t.id, rate: rates.rates[t.id] }))

  // Terminals: places nothing consumes from — where the run's outcomes land.
  const terminals = places.filter((p) => !consumedFrom.has(p.id)).map((p) => p.id)

  // Wait-like: starts empty, work flows in and is consumed out, not terminal —
  // where anything queues if it queues at all.
  const queues = places
    .filter((p) => (initial[p.id] || 0) === 0 && producedTo.has(p.id) && consumedFrom.has(p.id))
    .map((p) => p.id)

  // Losses: everything they take comes out of a queue, everything they produce
  // is terminal, and — the part that matters — the queue they drain has another
  // consumer. Giving up is always an *alternative* to being served, so an
  // abandonment competes for its queue while a service completion is its
  // queue's only way out.
  //
  // Without that last clause the café's serve_espresso reads as patience: it
  // consumes a brewing place and produces only a served place, because that
  // model releases its barista in a fused transition elsewhere, so "leaves the
  // queue and lands somewhere terminal" describes it exactly. A slider labelled
  // patience that actually sets the service rate is worse than no slider.
  const terminalSet = new Set(terminals)
  const queueSet = new Set(queues)
  const consumerCount = {}
  for (const a of consuming) {
    (consumerCount[a.from] ||= new Set()).add(a.to)
  }
  const losses = (model.transitions || [])
    .filter((t) => {
      const ins = consuming.filter((a) => a.to === t.id)
      const outs = producing.filter((a) => a.from === t.id)
      return ins.length > 0 && outs.length > 0 &&
        ins.every((a) => queueSet.has(a.from) && (consumerCount[a.from]?.size || 0) > 1) &&
        outs.every((a) => terminalSet.has(a.to)) &&
        (rates.rates?.[t.id] || 0) > 0
    })
    .filter((t) => !isDelayed(t) || (delayed.push(t.id), false))
    .map((t) => ({ id: t.id, rate: rates.rates[t.id] }))

  // Services: consume from a queue and are not a loss — the transitions a
  // "closed today" disruption can shut without also shutting the door.
  const lossIds = new Set(losses.map((l) => l.id))
  const services = (model.transitions || [])
    .filter((t) => !lossIds.has(t.id) && hasInput.has(t.id) &&
      consuming.some((a) => a.to === t.id && queueSet.has(a.from)))
    .map((t) => ({ id: t.id, rate: rates.rates?.[t.id] || 0 }))

  return { pools, sources, losses, queues, terminals, services, delayed, labels: labelsOf(model), units: unitsOf(model) }
}

// A model names its own elements in its presentation block; a `label` tag is
// honoured as the older spelling. Falling back to the id is what keeps every
// model renderable with no theming at all — which is the property that makes
// this a generic console rather than a template someone has to fill in.
function labelsOf (model) {
  const out = {}
  for (const p of model.places || []) if (p.tags?.label) out[p.id] = p.tags.label
  for (const t of model.transitions || []) if (t.tags?.label) out[t.id] = t.tags.label
  Object.assign(out, model.presentation?.labels || {})
  return out
}

function unitsOf (model) {
  const out = {}
  for (const p of model.places || []) if (p.tags?.unit) out[p.id] = p.tags.unit
  for (const t of model.transitions || []) if (t.tags?.unit) out[t.id] = t.tags.unit
  Object.assign(out, model.presentation?.units || {})
  return out
}

/** The name to show for an element: the model's label, else its id. */
export function labelFor (roles, id) {
  return roles.labels?.[id] || id
}

/**
 * Disruptions the console can offer without anyone authoring them.
 *
 * The bespoke vet-clinic console had four checkboxes — emergencies at the
 * door, an emergency wave, no surgery today, x-ray down — and every one of
 * them is one of these four shapes. That is the whole argument for deriving
 * them: they were never domain knowledge, they were the net's own roles with
 * a clinic's nouns on top, and the nouns come from the label tags.
 *
 * A model may name its own in `presentation.disruptions`; those come first
 * and these stay available underneath. Presentation overrides a derived
 * default and never replaces the derivation, or a model could hide the
 * hypothetical its operator most needed to ask.
 */
export function deriveDisruptions (roles, horizon = 8) {
  const out = []
  const name = (id) => labelFor(roles, id)

  for (const p of roles.pools) {
    out.push({
      id: `down_${p.id}`,
      label: `${name(p.id)} unavailable`,
      description: `Starts the run with no ${name(p.id)} at all — the equipment-down or nobody-rostered case.`,
      derived: true,
      marking: Object.fromEntries((p.members || [p.id]).map((m) => [m, 0]))
    })
  }

  for (const s of roles.sources) {
    const until = Math.max(1, Math.round(horizon / 4))
    out.push({
      id: `wave_${s.id}`,
      label: `${name(s.id)} wave`,
      description: `Triples ${name(s.id)} for the first ${until} hour${until === 1 ? '' : 's'}, then back to normal — a rush, not a busier average.`,
      derived: true,
      schedule: { [s.id]: [{ until, value: +(s.rate * 3).toFixed(3) }, { until: horizon, value: s.rate }] }
    })
  }

  for (const q of roles.queues) {
    out.push({
      id: `backlog_${q}`,
      label: `${name(q)} backlog at open`,
      description: `Starts the run with work already waiting in ${name(q)}.`,
      derived: true,
      amount: { place: q, default: 3, max: 20 }
    })
  }

  for (const s of roles.services) {
    out.push({
      id: `closed_${s.id}`,
      label: `${name(s.id)} closed`,
      description: `Shuts ${name(s.id)} for the whole run by setting its rate to zero.`,
      derived: true,
      rates: { [s.id]: 0 }
    })
  }

  return out
}

/**
 * Merge a set of active disruptions into a scenario.
 *
 * Every disruption is expressed in the vocabulary the scenario API already
 * speaks — a marking, a rate, a schedule — so applying one is a merge and
 * never a special case, and no preset can express a run a hand-built request
 * could not.
 */
export function applyDisruptions (scenario, active) {
  const out = { ...scenario }
  for (const d of active) {
    if (d.marking) out.marking = { ...(out.marking || {}), ...d.marking }
    if (d.rates) out.rates = { ...(out.rates || {}), ...d.rates }
    if (d.amount) out.marking = { ...(out.marking || {}), [d.amount.place]: d.amount.value ?? d.amount.default }
    if (d.schedule) out.schedule = { ...(out.schedule || {}), ...d.schedule }
  }
  return out
}
