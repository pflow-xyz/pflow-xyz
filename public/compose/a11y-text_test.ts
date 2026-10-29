// The words of the composition page: accessible names, announcements, schema codes, dashes.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { brokenTabLabel, brokenViewText, distinctDashes, eventText, firstDrawing, firstLine, newStatus, pieceLabel, portLabel, registryFailureText, schemaCode, SCHEMA_CODE, slotLabel, uniqueKeys, viewLabel, viewNews } from "./a11y-text.js";

Deno.test("schema codes: one letter each, all distinct, never empty for a schema", () => {
  const codes = Object.values(SCHEMA_CODE);
  assertEquals(new Set(codes).size, codes.length);
  assertEquals(schemaCode("queue:items"), "I");
  assertEquals(schemaCode("resource"), "R");
  assertEquals(schemaCode("something:new"), "N"); // an unknown schema still gets a letter
  assertEquals(schemaCode(""), "");
  assertEquals(schemaCode(undefined), "");
});

Deno.test("portLabel names the subnet, port, direction, target and schema", () => {
  assertEquals(portLabel("orders", { id: "out", kind: "out", target: "place", schema: "queue:items" }), "orders:out, out port on a place, schema queue:items");
  assertEquals(portLabel("workers", { id: "available", kind: "inout", target: "place", schema: "resource" }), "workers:available, in/out port on a place, schema resource");
  assertEquals(portLabel("orders", { id: "enqueue", kind: "in", target: "transition" }), "orders:enqueue, in port on a transition, no schema");
  assertStringIncludes(portLabel("orders", { id: "depth", kind: "observe", target: "place", schema: "queue:items" }), "observe port");
});

Deno.test("slot and piece labels", () => {
  assertEquals(slotLabel({ id: "order", label: "order chain" }), "order chain slot");
  assertEquals(slotLabel({ id: "bounds", label: "bounds", designed: true }), "bounds slot (designed, not built)");
  assertEquals(slotLabel(undefined, "memo"), "memo slot");
  assertEquals(pieceLabel({ name: "beam", kind: "Filter", status: "built" }), "beam, filter piece");
  assertEquals(pieceLabel({ name: "x", kind: "Order", status: "reserved" }), "x, order piece, reserved");
});

Deno.test("viewLabel", () => {
  assertEquals(viewLabel({ title: "Wiring diagrams (operad nesting)" }, "orders", 3, 10), "View 3 of 10: Wiring diagrams (operad nesting), orders, workers and payment composition");
  assertStringIncludes(viewLabel({ id: "x" }, "connect4"), "Connect-4");
});

Deno.test("eventText: a created link says its kind, ends and the rules it passed", () => {
  const t = eventText({ type: "link-added", link: { kind: "token", from: { subnet: "orders", port: "out" }, to: { subnet: "workers", port: "available" } }, rule: { passed: [{ text: "schemas agree" }, { text: "place to place" }], warnings: [{ code: "W_X" }] }, idiom: { key: "dispatch" } });
  assertStringIncludes(t, "Link created: token link orders:out to workers:available.");
  assertStringIncludes(t, "schemas agree; place to place.");
  assertStringIncludes(t, "Warnings: W_X.");
  assertStringIncludes(t, "dispatch idiom");
});

Deno.test("eventText: the other state changes, and silence for the ones that are not news", () => {
  assertEquals(eventText({ type: "links-cleared" }), "All links cleared.");
  assertStringIncludes(eventText({ type: "refused", error: { message: "[E_X] no" } }), "Refused: [E_X] no");
  assertStringIncludes(eventText({ type: "piece-added", name: "beam", slot: "filters" }), "beam placed in the filters slot");
  assertStringIncludes(eventText({ type: "link-removed", link: { kind: "event", from: { subnet: "a", port: "x" }, to: { subnet: "b", port: "y" } } }), "event link a:x to b:y");
  assertEquals(eventText({ type: "view" }), "");
  assertEquals(eventText({ type: "view-local" }), "");
  assertEquals(eventText(null), "");
});

Deno.test("distinctDashes: guard no longer shares token's dash; the others are left alone", () => {
  const s = { token: { dash: "6 4" }, data: { dash: "1 4" }, event: { dash: "" }, guard: { dash: "6 4" } };
  distinctDashes(s);
  assertNotEquals(s.guard.dash, s.token.dash);
  assertEquals(s.token.dash, "6 4");
  assertEquals(s.data.dash, "1 4");
  const dashes = [s.token.dash, s.data.dash, s.event.dash, s.guard.dash];
  assertEquals(new Set(dashes).size, 4, "four kinds, four patterns");
  // A registry that already separates them is not touched.
  const t = { token: { dash: "6 4" }, guard: { dash: "2 2" } };
  distinctDashes(t);
  assertEquals(t.guard.dash, "2 2");
  assert(distinctDashes(undefined) === undefined);
});

Deno.test("uniqueKeys: repeats get a counter, first stays plain", () => {
  assertEquals(uniqueKeys(["a", "b", "a", "a", "b"]), ["a", "b", "a#2", "a#3", "b#2"]);
  assertEquals(uniqueKeys([]), []);
});

Deno.test("firstDrawing: the key of a thing's first drawing, for when a redraw drops the second", () => {
  assertEquals(firstDrawing("port:orders:in#2"), "port:orders:in");
  assertEquals(firstDrawing("port:orders:in#12"), "port:orders:in");
  assertEquals(firstDrawing("port:orders:in"), "port:orders:in");
  assertEquals(firstDrawing("item:junction #3: x"), "item:junction #3: x", "only a trailing counter counts");
  // and it undoes uniqueKeys
  assertEquals(uniqueKeys(["p", "p", "p"]).map(firstDrawing), ["p", "p", "p"]);
});

// --- failures are said, not only shown ------------------------------------------------------------------------

Deno.test("firstLine: the message's first line, never the stack", () => {
  const e = new Error("wasm streaming compile failed\n  at instantiate (pflow_native_wasm.js:1:1)\n  at init");
  assertEquals(firstLine(e), "wasm streaming compile failed");
  assertEquals(firstLine("  \n\nsecond line is the first non-empty  \nthird"), "second line is the first non-empty");
  assertEquals(firstLine(new Error("")), "Error", "no message: the name");
  assertEquals(firstLine(undefined), "unknown error");
  assertEquals(firstLine(null), "unknown error");
  assertEquals(firstLine(404), "404");
});

Deno.test("registryFailureText: one sentence, the reason first, no stack", () => {
  const e = new Error("Failed to fetch\n  at fetch (x.js:1:1)");
  assertEquals(registryFailureText(e), "The registry did not load: Failed to fetch.");
  assertEquals(registryFailureText(new Error("bad magic number.")), "The registry did not load: bad magic number.");
  assert(!registryFailureText(e).includes("\n"));
});

Deno.test("brokenViewText and brokenTabLabel: what is wrong where a working view would say its name", () => {
  const v = { id: "lens", short: "Lenses", title: "Open games / lenses (analogy)", broken: "TypeError: Failed to fetch dynamically imported module: http://x/views/lens.js" };
  assertEquals(brokenViewText(v), "The Lenses view failed to load: TypeError: Failed to fetch dynamically imported module: http://x/views/lens.js.");
  assertEquals(brokenViewText({ id: "x", broken: "its module has no default export" }), "The x view failed to load: its module has no default export.");
  assertEquals(brokenTabLabel("7. Lenses"), "7. Lenses (failed to load)");
  assert(brokenTabLabel("7. Lenses").startsWith("7. Lenses"), "the visible words come first (label in name)");
});

Deno.test("viewNews: the person moving is news, also while loading; a redraw of the same view is not; a broken first view is", () => {
  const start = "cospan|orders";
  // the first drawing, on the view the page started on: silent (the page load says itself)
  assertEquals(viewNews({ lastKey: start, drawn: false, key: start }), false);
  // keys 3, 7, e, 5 during the load, or Right Right Enter on the tabs: the first drawing is a different view and example
  assertEquals(viewNews({ lastKey: start, drawn: false, key: "flat|connect4" }), true);
  // later: a move is news, a redraw of the same view and example is not
  assertEquals(viewNews({ lastKey: "flat|connect4", drawn: true, key: "lens|connect4" }), true);
  assertEquals(viewNews({ lastKey: "flat|connect4", drawn: true, key: "flat|orders" }), true);
  assertEquals(viewNews({ lastKey: "flat|connect4", drawn: true, key: "flat|connect4" }), false);
  // a page that opens on a broken view must not be silent about it; once told, a redraw is not news again
  assertEquals(viewNews({ lastKey: "lens|orders", drawn: false, key: "lens|orders", broken: true }), true);
  assertEquals(viewNews({ lastKey: "lens|orders", drawn: true, key: "lens|orders", broken: true }), false);
});

Deno.test("newStatus: a status line is said once, not at every repaint", () => {
  assertEquals(newStatus(null, "Loading the Laws view…"), "Loading the Laws view…");
  assertEquals(newStatus("Loading the Laws view…", "Loading the Laws view…"), "");
  assertEquals(newStatus("Loading the Laws view…", "Loading the Lenses view…"), "Loading the Lenses view…");
  assertEquals(newStatus(null, ""), "");
});
