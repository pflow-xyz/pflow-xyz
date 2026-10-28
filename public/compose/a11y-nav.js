// Moving between things with the arrow keys, and the small decisions about how a
// thing is exposed (its role, whether it keeps its own name, whether a key typed at
// it belongs to the person typing). Pure: items are {x, y} centres and elements are
// plain descriptors (the DOM glue, a11y.js, measures and describes them), and each
// function returns an index or a value.

/**
 * The item to move to from `from` when an arrow key is pressed: the nearest in
 * that direction, preferring items that lie straight ahead (a sideways offset
 * costs double). Returns -1 when nothing lies that way.
 */
export function moveSpatial(items, from, key) {
  const a = items[from];
  if (!a) return -1;
  const eps = 1;
  let best = -1, bs = Infinity;
  for (let i = 0; i < items.length; i++) {
    if (i === from) continue;
    const dx = items[i].x - a.x, dy = items[i].y - a.y;
    let main, side;
    if (key === 'ArrowRight') { main = dx; side = Math.abs(dy); }
    else if (key === 'ArrowLeft') { main = -dx; side = Math.abs(dy); }
    else if (key === 'ArrowDown') { main = dy; side = Math.abs(dx); }
    else if (key === 'ArrowUp') { main = -dy; side = Math.abs(dx); }
    else return -1;
    if (main <= eps) continue;
    const score = main + 2 * side;
    if (score < bs) { bs = score; best = i; }
  }
  return best;
}

/**
 * The index a roving group moves to on `key` (arrows by position when `items`
 * carry centres, Home/End by order). -1: the key does not move the group.
 */
export function rovingTarget(items, from, key) {
  if (!items.length) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return items.length - 1;
  if (from < 0) return /^Arrow/.test(key) ? 0 : -1;
  return moveSpatial(items, from, key);
}

/** The next tab of a tablist (wrapping) on Arrow/Home/End; -1 for any other key. */
export function tabTarget(n, from, key) {
  if (!n) return -1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (from + 1) % n;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (from - 1 + n) % n;
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return -1;
}

/** Which of a group's keys is the Tab stop: the remembered one if it is still there, else the first. */
export function tabStop(keys, remembered) {
  if (!keys.length) return -1;
  const i = remembered == null ? -1 : keys.indexOf(remembered);
  return i < 0 ? 0 : i;
}

// --- how a thing is exposed -----------------------------------------------------------------------

/** Elements whose native role must stay: a button, a link, a form control, a list item. */
export const hasNativeRole = (tag) => /^(a|button|summary|input|select|textarea|li)$/i.test(tag || '');

/** Native roles whose name is their visible content (a button, a link). */
const NAMED_BY_CONTENT = /^(a|button|summary)$/i;

/**
 * The role to give a thing that is made keyboard-reachable, or null to leave what it has.
 *   tag             its tag name
 *   hasRole         it already has a role attribute (a view chose one)
 *   svg             it is drawn in an svg
 *   holdsControls   it contains other controls or other labelled things
 *   group           'port' | 'piece' | 'action' | 'item' | 'panel'
 * A role=button makes its children presentational, so it must not wrap controls (nested-interactive)
 * or readable HTML (a card with a table and links would be read as one word): those are groups. A
 * native button, link or list item keeps its own role (a ul whose items are buttons is not a list).
 */
export function roleFor({ tag, hasRole = false, svg = false, holdsControls = false, group = 'item' }) {
  if (hasRole || hasNativeRole(tag)) return null;
  if (holdsControls) return 'group';
  if ((group === 'item' || group === 'panel') && !svg) return 'group';
  return 'button';
}

/** Does the thing keep the name it has? A button or link with visible words is better named by them. */
export function keepsOwnName({ tag, text = '' }) {
  return NAMED_BY_CONTENT.test(tag || '') && String(text).trim() !== '';
}

/** Does the browser click this itself on Enter and Space (so a synthetic click would be a second one)? */
export const clicksItself = (tag) => NAMED_BY_CONTENT.test(tag || '');

/**
 * Is the key typed at someone who is typing? `chain` is the target and its ancestors, nearest first,
 * each {tag, editable, role}. A form field, a contenteditable region or an ARIA text box owns the keys:
 * the page's own shortcuts (number keys switch the view, E the example) stand aside.
 */
export function isTypingTarget(chain) {
  for (const n of chain || []) {
    if (!n) continue;
    if (/^(input|textarea|select)$/i.test(n.tag || '')) return true;
    if (n.editable) return true;
    if (/^(textbox|searchbox|combobox|spinbutton)$/i.test(n.role || '')) return true;
  }
  return false;
}
