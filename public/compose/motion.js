// prefers-reduced-motion, everywhere. CSS animations and transitions are switched
// off by the media query in compose.css; the views' own animations run through the
// Web Animations API (element.animate), which that query does not reach. Under
// reduced motion every such animation here jumps to its end at once, so one
// guard covers all ten views and any later one. A view that draws its own timing
// (an rAF loop, SMIL) asks reducedMotion() itself.

export const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

/** Does the person ask for less motion? (false where there is no matchMedia, e.g. the headless parity run) */
export function reducedMotion(win = typeof window === 'undefined' ? null : window) {
  try { return !!(win && win.matchMedia && win.matchMedia(REDUCED_QUERY).matches); } catch { return false; }
}

/** Web Animations options with every duration taken out: the animation ends where it begins. */
export function calmOptions(opts) {
  const o = typeof opts === 'number' ? { duration: opts } : { ...(opts || {}) };
  return { ...o, duration: 0, delay: 0, endDelay: 0, iterations: 1 };
}

const patched = new WeakSet();

/**
 * Wrap Element.prototype.animate so that, while the preference is on, no
 * animation takes time. The preference is read at each call, so changing it in
 * the system settings takes effect without a reload.
 */
export function installMotionGuard(win = typeof window === 'undefined' ? null : window) {
  if (!win || !win.Element || !win.Element.prototype.animate || patched.has(win.Element.prototype)) return false;
  const orig = win.Element.prototype.animate;
  win.Element.prototype.animate = function animate(keyframes, options) {
    return orig.call(this, keyframes, reducedMotion(win) ? calmOptions(options) : options);
  };
  patched.add(win.Element.prototype);
  return true;
}
