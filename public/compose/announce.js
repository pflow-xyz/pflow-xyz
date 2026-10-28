// The page's one polite live region is a11y-bus.js's (#a11y-live): this is the entry the views
// import. The stage is rebuilt on every render, so a status line a view draws inside it is replaced
// as it changes and a screen reader may never read it; announce(text) says it in the region that
// is never rebuilt. It does nothing without a browser document (the headless parity test draws
// views too, and the speaker's short timer must not outlive such a test).

import { announce as say } from './a11y-bus.js';

export function announce(text) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function' || !document.body) return;
  say(text);
}
