// The announcer behind announce() (a11y-bus.js): what is said when several things are said at once,
// and the focus request that survives a redraw. No DOM: the region and the timer are injected.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createAnnouncer, requestFocus, takeFocusRequest } from "./a11y-bus.js";

/** An announcer on a fake region and a fake clock: tick() closes the window. */
function rig() {
  const writes: string[] = [];
  const history: string[] = [];
  let due: (() => void) | null = null;
  let timers = 0;
  const a = createAnnouncer({
    speak: (t: string) => writes.push(t),
    setTimer: (f: () => void) => { due = f; timers++; return timers; },
    history,
  });
  const tick = () => { const f = due; due = null; if (f) f(); };
  return { a, writes, history, tick, timers: () => timers };
}

Deno.test("one message: the region is emptied, then holds the message when the window closes", () => {
  const { a, writes, tick } = rig();
  a.say("Link created.");
  assertEquals(writes, [""], "emptied at once so the change is noticed");
  tick();
  assertEquals(writes, ["", "Link created."]);
});

Deno.test("two messages in one moment are both spoken, in order (the removed-link announcement is not lost)", () => {
  const { a, writes, tick, timers } = rig();
  a.say("Link removed: event link orders:dequeue to workers:acquire.");
  a.say("Inspector pinned: event link orders:dequeue. Press Escape to dismiss.");
  assertEquals(timers(), 1, "one window for both");
  assertEquals(a.waiting(), 2);
  tick();
  assertEquals(writes.length, 2);
  const spoken = writes[1];
  assert(spoken.indexOf("Link removed") >= 0 && spoken.indexOf("Inspector pinned") > spoken.indexOf("Link removed"), spoken);
});

Deno.test("messages joined get a full stop each, so they are not run together", () => {
  const { a, writes, tick } = rig();
  a.say("Refused: the registry said no");
  a.say("Inspector dismissed.");
  tick();
  assertEquals(writes[1], "Refused: the registry said no. Inspector dismissed.");
});

Deno.test("a message after the window starts the next one; nothing waits behind a spoken one", () => {
  const { a, writes, tick } = rig();
  a.say("one");
  tick();
  a.say("two");
  assertEquals(writes, ["", "one", ""]);
  tick();
  assertEquals(writes, ["", "one", "", "two"]);
  assertEquals(a.waiting(), 0);
});

Deno.test("the same words twice in a row are spoken twice (the region's text must change)", () => {
  const { a, writes, tick } = rig();
  a.say("No legal port.");
  tick();
  a.say("No legal port.");
  tick();
  a.say("No legal port.");
  tick();
  const spoken = writes.filter((w) => w !== "");
  assertEquals(spoken.length, 3);
  assert(spoken[0] !== spoken[1] && spoken[1] !== spoken[2], JSON.stringify(spoken));
  assertEquals(spoken.map((w) => w.trim()), ["No legal port.", "No legal port.", "No legal port."]);
});

Deno.test("an empty message says nothing and opens no window", () => {
  const { a, writes, tick, timers } = rig();
  a.say("");
  a.say(undefined as unknown as string);
  tick();
  assertEquals(writes, []);
  assertEquals(timers(), 0);
});

Deno.test("history keeps every message separately, newest last, and is capped", () => {
  const { a, history, tick } = rig();
  a.say("a");
  a.say("b");
  tick();
  assertEquals(history, ["a", "b"], "the test hook sees both even though they were spoken together");
  for (let i = 0; i < 250; i++) { a.say(`m${i}`); tick(); }
  assertEquals(history.length, 200);
  assertEquals(history[history.length - 1], "m249");
});

Deno.test("a focus request is answered once, and forgotten when no render answers it", () => {
  requestFocus("port:orders:in");
  assertEquals(takeFocusRequest(), "port:orders:in");
  assertEquals(takeFocusRequest(), null, "once");
  const now = Date.now;
  try {
    requestFocus("piece:beam");
    Date.now = () => now() + 5000;
    assertEquals(takeFocusRequest(), null, "a request no render answered within a moment is stale");
  } finally { Date.now = now; }
});
