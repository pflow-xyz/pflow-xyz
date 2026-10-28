// A polite live region (role="status") that outlives redraws. The stage is
// rebuilt on every render, so a status line a view draws inside it is replaced
// as it changes and a screen reader may never read it; announce(text) puts the
// text in one element of the page that is never rebuilt. It does nothing
// without a browser document (the headless parity test draws views too).

const ID = 'sr-status';

export function announce(text) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function' || !document.body) return;
  let n = document.getElementById(ID);
  if (!n) {
    n = document.createElement('div');
    n.id = ID;
    n.setAttribute('role', 'status');
    n.setAttribute('aria-live', 'polite');
    // visually hidden, still read
    n.setAttribute('style', 'position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap');
    document.body.appendChild(n);
  }
  n.textContent = text;
}
