// The words the registry's verdicts carry, in one place. The pointer path
// (snap.js: the tip that follows a drag) and the keyboard path (a11y-link.js: what
// is announced as a target is focused) both build their text from these, so the
// two say what bundle.candidates / plan.slot_candidates said and nothing else.
// Pure: no DOM, no state. Nothing here decides legality; it only reads a verdict.
//
// Shapes (see state.js linkCandidates / slotCandidates):
//   port candidate  {key, ok, link: {kind, from, to}, verdict: {passed: [{text}], errors}, tried: [{link, verdict}]}
//   slot candidate  {slot, ok, why, rule, plan}

/** One verdict error, as a phrase: "CODE message" with the link index prefix trimmed. */
export const errText = (er) => `${er.code ? `${er.code} ` : ''}${String(er.message || er.msg || '').replace(/^links\[\d+\]: /, '').replace(/^link: /, '')}`;

/** Why a legal port target is legal: the rules it passed, in the registry's words. */
export const portLegalReason = (v) => v.verdict.passed.map((p) => p.text).join('; ');

/** Why a refused port is refused: every kind the registry tried, and what it said. */
export const portRefusal = (v) => (v ? v.tried.map((t) => `${t.link.kind}: ${t.verdict.errors.map(errText).join('; ')}`).join(' | ') : 'not a target');

/** Why a slot accepts the piece. */
export const slotLegalReason = (v) => `fits the ${v.slot} slot (pflow-rs accepts the plan: plan.slot_candidates)`;

/** Why a slot refuses the piece: pflow-rs's message and the rule that spoke. */
export const slotRefusal = (v) => (v ? `${v.why}${v.rule ? ` (${v.rule})` : ''}` : 'not a slot');

/**
 * bundle.candidates -> the targets a keyboard walk visits.
 *   has(key)    is the port drawn in this view? (a view draws some ports only)
 *   label(key)  its spoken name
 * Candidates the view does not draw are dropped, as the pointer path's "N legal
 * ports lit" count drops them.
 * @param {any[]} cands
 * @param {{has?: (key: string) => boolean, label?: (key: string) => string}} [o]
 */
export function portTargets(cands, { has = () => true, label = (k) => k } = {}) {
  return cands.filter((c) => has(c.key)).map((c) => ({
    key: c.key,
    label: label(c.key),
    ok: !!c.ok,
    kind: c.ok ? c.link.kind : null,
    reason: c.ok ? portLegalReason(c) : portRefusal(c),
  }));
}

/**
 * plan.slot_candidates -> the targets a keyboard walk visits (the slots this view draws).
 * @param {any[]} cands
 * @param {{has?: (key: string) => boolean, label?: (key: string) => string}} [o]
 */
export function slotTargets(cands, { has = () => true, label = (k) => k } = {}) {
  return cands.filter((c) => has(c.slot)).map((c) => ({
    key: c.slot,
    label: label(c.slot),
    ok: !!c.ok,
    kind: null,
    reason: c.ok ? slotLegalReason(c) : slotRefusal(c),
  }));
}
