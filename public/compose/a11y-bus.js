// Two small shared things the accessibility code needs from everywhere, kept
// apart so snap.js, inspect.js and app.js can use them without importing each
// other: the one polite live region (what is announced), and the request that
// focus go back to a named element once the stage has been redrawn.
//
// The live region is #a11y-live in compose.html (role=status, aria-live=polite,
// visually hidden). Everything the page says to a screen reader goes through
// announce(), so there is exactly one place speech comes from.

let live = null;
let last = '';
let flip = false;
let timer = null;

/** Every announcement, newest last (a test hook: window.__a11yLog). */
export const log = [];

export function initLive(root = document) {
  live = root.getElementById ? root.getElementById('a11y-live') : null;
  if (!live) {
    live = root.createElement('div');
    live.id = 'a11y-live';
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    root.body.appendChild(live);
  }
  if (typeof window !== 'undefined') window.__a11yLog = log;
}

/** Say `text` politely. Saying the same words twice in a row still speaks twice. */
export function announce(text) {
  if (!text) return;
  log.push(text);
  if (log.length > 200) log.shift();
  if (!live) return;
  flip = text === last ? !flip : false;
  last = text;
  const out = flip ? `${text} ` : text;
  clearTimeout(timer);
  live.textContent = '';
  // A pause between clearing and filling is what makes a screen reader notice the change.
  timer = setTimeout(() => { live.textContent = out; }, 30);
}

/** Keyboard link mode is on: the live region speaks for the targets, so their static descriptions stand down. */
export const linkMode = { on: false };

// --- focus that survives a redraw ---------------------------------------------------------------

let wanted = null;
const FRESH_MS = 1500;

/** Ask for focus on the element with this key (data-a11y-key) after the next render. */
export function requestFocus(key) { wanted = { key, at: Date.now() }; }
/** The key requested, once; a request that no render answered within a moment is forgotten. */
export function takeFocusRequest() {
  const w = wanted;
  wanted = null;
  return w && Date.now() - w.at < FRESH_MS ? w.key : null;
}
