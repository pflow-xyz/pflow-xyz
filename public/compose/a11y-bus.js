// Two small shared things the accessibility code needs from everywhere, kept
// apart so snap.js, inspect.js and app.js can use them without importing each
// other: the one polite live region (what is announced), and the request that
// focus go back to a named element once the stage has been redrawn.
//
// The live region is #a11y-live in compose.html (role=status, aria-live=polite,
// visually hidden). Everything the page says to a screen reader goes through
// announce(), so there is exactly one place speech comes from.

let live = null;

/** Every announcement, newest last (a test hook: window.__a11yLog). */
export const log = [];

/**
 * The speaker behind announce(): messages that arrive together are all spoken, in order.
 *
 * A live region keeps only what was last written to it, and a screen reader notices a change only
 * after the region was emptied for a moment, so two announce() calls in one event (a link removed,
 * and in the same click the inspector pinned) used to leave the second and lose the first. Now the
 * first message empties the region and opens a short window; whatever arrives in it joins the same
 * utterance, each message ending in a full stop. A message after the window starts the next one
 * (the latest wins over one that was never read, as a polite region does anyway: a fast walk
 * through link targets does not queue up).
 *
 *   speak(text)   writes the region (called with '' to empty it, then with the utterance)
 *   setTimer      injectable for tests; history, when given, gets every message on its own
 * @param {{speak: (text: string) => void, setTimer?: (f: () => void, ms: number) => unknown, settleMs?: number, history?: string[] | null}} o
 */
export function createAnnouncer({ speak, setTimer = (f, ms) => setTimeout(f, ms), settleMs = 50, history = null }) {
  let pending = [];
  let timer = null;
  let last = '';
  let flip = false;
  const stop = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);
  function flush() {
    timer = null;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    const text = batch.length === 1 ? batch[0] : batch.map(stop).join(' ');
    // The same words twice in a row still speak twice: a region whose text did not change is silent.
    flip = text === last ? !flip : false;
    last = text;
    speak(flip ? `${text} ` : text);
  }
  return {
    say(text) {
      if (!text) return;
      if (history) { history.push(text); if (history.length > 200) history.shift(); }
      if (timer === null) { speak(''); timer = setTimer(flush, settleMs); }
      pending.push(text);
    },
    /** How many messages wait for the window to close. */
    waiting: () => pending.length,
  };
}

const speaker = createAnnouncer({ speak: (t) => { if (live) live.textContent = t; }, history: log });

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

/** Say `text` politely. Several in one moment are spoken together, in order; the same text twice speaks twice. */
export function announce(text) { speaker.say(text); }

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
