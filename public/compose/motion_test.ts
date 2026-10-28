// prefers-reduced-motion for the Web Animations API: every animation ends where it begins.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { calmOptions, installMotionGuard, reducedMotion } from "./motion.js";

Deno.test("calmOptions takes the time out of any options shape", () => {
  assertEquals(calmOptions(760), { duration: 0, delay: 0, endDelay: 0, iterations: 1 });
  assertEquals(calmOptions({ duration: 900, delay: 500, easing: "ease-out", fill: "backwards", iterations: Infinity }), { duration: 0, delay: 0, endDelay: 0, iterations: 1, easing: "ease-out", fill: "backwards" });
  assertEquals(calmOptions(undefined), { duration: 0, delay: 0, endDelay: 0, iterations: 1 });
});

const fakeWin = (reduce: boolean) => {
  const calls: any[] = [];
  class Element { animate(kf: any, opts: any) { calls.push([kf, opts]); return { finished: Promise.resolve() }; } }
  const win: any = { Element, matchMedia: (q: string) => ({ matches: reduce && q.includes("reduce") }) };
  return { win, calls, el: new Element() };
};

Deno.test("reducedMotion reads the media query, and is false without one", () => {
  assertEquals(reducedMotion(fakeWin(true).win), true);
  assertEquals(reducedMotion(fakeWin(false).win), false);
  assertEquals(reducedMotion(null), false);
  assertEquals(reducedMotion({ matchMedia() { throw new Error("no"); } } as any), false);
});

Deno.test("installMotionGuard: with the preference on, animate() gets zero durations; with it off, the options as given", () => {
  const on = fakeWin(true);
  assertEquals(installMotionGuard(on.win), true);
  on.el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 800, easing: "ease" });
  assertEquals(on.calls[0][1], { duration: 0, delay: 0, endDelay: 0, iterations: 1, easing: "ease" });
});

Deno.test("installMotionGuard: preference off leaves the options alone; installing twice wraps once; the preference is read at each call", () => {
  const off = fakeWin(false);
  assertEquals(installMotionGuard(off.win), true);
  assertEquals(installMotionGuard(off.win), false);
  off.el.animate([], { duration: 800 });
  assertEquals(off.calls, [[[], { duration: 800 }]]);
  // Turn the preference on later: no reload needed.
  let reduce = false;
  const live = fakeWin(false);
  live.win.matchMedia = (q: string) => ({ matches: reduce && q.includes("reduce") });
  installMotionGuard(live.win);
  live.el.animate([], 500);
  reduce = true;
  live.el.animate([], 500);
  assertEquals(live.calls[0][1], 500);
  assertEquals(live.calls[1][1], { duration: 0, delay: 0, endDelay: 0, iterations: 1 });
});
