// The inspector without hover. Pure: a reducer for what is pinned and a plain-text
// description of an info (info.js) for assistive technology. The DOM side is
// inspect.js (panel, hover tip) and a11y.js (keys, aria wiring).
//
// Hover and focus SHOW an info in the panel unless one is pinned. A click or a tap
// PINS it; a second click or tap on the same thing, or Escape, dismisses. If a
// redraw leaves the pinned thing out (a link removed, a piece taken out), the pin goes.
//
// `id` identifies a THING, not a title: two boxes can share a title and say different
// things (the Operad draws "port orders:in" twice), and a tap on the second must move
// the pin, not release it. inspect.js builds the id from the title plus the thing's
// place among the equally titled ones, so it is the same after a redraw.

/** ns:Foo / pat:foo / lk:foo for the ontology IRIs the page names. */
export function shortIri(iri) {
  return String(iri)
    .replace('https://ontology.pflow.xyz/ns#', 'ns:')
    .replace('https://ontology.pflow.xyz/pattern/', 'pat:')
    .replace('https://ontology.pflow.xyz/linkkind/', 'lk:');
}

const stop = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);

/**
 * An info as one paragraph of plain text: what it is, the concept it stands for,
 * the ontology's own definition and the facts. Citations are left to the panel.
 */
export function describeInfo(info) {
  if (!info) return '';
  const parts = [];
  if (info.title) parts.push(stop(info.title));
  if (info.concept) parts.push(stop(`Concept ${shortIri(info.concept.iri)}${info.concept.types && info.concept.types.length ? `, a ${info.concept.types.join(', ')}` : ''}`));
  if (info.definition) parts.push(stop(info.definition));
  for (const f of info.facts || []) parts.push(stop(`${f[0]}: ${f[1]}`));
  if (info.note) parts.push(stop(info.note));
  if (info.caveats && info.caveats.length) parts.push(`${info.caveats.length} caveat${info.caveats.length === 1 ? '' : 's'} in the panel.`);
  if (info.cites && info.cites.length) parts.push(`${info.cites.length} source${info.cites.length === 1 ? '' : 's'} in the panel.`);
  return parts.join(' ');
}

export const initialInspector = () => ({ pinned: null, shown: null });

/**
 * Events: {type: 'show', id}           hover or focus
 *         {type: 'activate', id, title} click, tap, Enter or I on a focused thing
 *         {type: 'escape'}              Escape pressed
 *         {type: 'dismiss'}             the panel's own close button
 *         {type: 'gone'}                a redraw no longer has the pinned thing
 * Returns {state, effect, announce, handled}; effect is 'show' | 'pin' | 'unpin' | 'none'.
 */
export function reduceInspector(state, ev) {
  switch (ev.type) {
    case 'show':
      if (state.pinned !== null) return { state, effect: 'none', announce: '', handled: false };
      return { state: { ...state, shown: ev.id }, effect: 'show', announce: '', handled: false };
    case 'activate':
      if (state.pinned === ev.id) return { state: { pinned: null, shown: null }, effect: 'unpin', announce: 'Inspector dismissed.', handled: true };
      return { state: { pinned: ev.id, shown: ev.id }, effect: 'pin', announce: `Inspector pinned: ${ev.title || ev.id}. Press Escape to dismiss.`, handled: true };
    case 'escape':
    case 'dismiss':
      if (state.pinned === null) return { state, effect: 'none', announce: '', handled: false };
      return { state: { pinned: null, shown: null }, effect: 'unpin', announce: 'Inspector dismissed.', handled: true };
    case 'gone':
      if (state.pinned === null) return { state, effect: 'none', announce: '', handled: false };
      return { state: { pinned: null, shown: null }, effect: 'unpin', announce: 'Inspector released: the pinned thing is no longer in the view.', handled: true };
    default:
      return { state, effect: 'none', announce: '', handled: false };
  }
}

/**
 * Is a click on a control that sits INSIDE an inspectable thing (the Retry button of the Laws status bar, the Lenses
 * view's "Assume a backward pass" button)? Such a click does what the control does and must not also pin the
 * inspector on the thing around it. `chain` is the click's target and its ancestors, nearest first, up to and
 * including the inspectable itself: each {tag, role, href, isNode}. A control is a button, a field, a link with an
 * href, or anything with role=button; the inspectable being one itself (a chip that is a button) does not count.
 */
export function isNestedControl(chain) {
  for (const n of chain || []) {
    if (!n) continue;
    if (n.isNode) return false;
    if (/^(button|input|select|textarea)$/i.test(n.tag || '')) return true;
    if (/^a$/i.test(n.tag || '') && n.href) return true;
    if (/^button$/i.test(n.role || '')) return true;
  }
  return false;
}
