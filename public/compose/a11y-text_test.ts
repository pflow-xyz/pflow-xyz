// The words of the composition page: accessible names, announcements, schema codes, dashes.
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { distinctDashes, eventText, pieceLabel, portLabel, schemaCode, SCHEMA_CODE, slotLabel, uniqueKeys, viewLabel } from "./a11y-text.js";

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
