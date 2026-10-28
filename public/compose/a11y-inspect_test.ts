// The inspector without hover: what is pinned, and the plain-text description.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describeInfo, initialInspector, reduceInspector, shortIri } from "./a11y-inspect.js";

Deno.test("hover and focus show an info while nothing is pinned", () => {
  const r = reduceInspector(initialInspector(), { type: "show", id: "a" });
  assertEquals(r.effect, "show");
  assertEquals(r.state, { pinned: null, shown: "a" });
});

Deno.test("a click or tap pins; hover and focus then leave the panel alone", () => {
  let r = reduceInspector(initialInspector(), { type: "activate", id: "a", title: "port orders:out" });
  assertEquals(r.effect, "pin");
  assertStringIncludes(r.announce, "Inspector pinned: port orders:out");
  assertStringIncludes(r.announce, "Escape");
  const s = r.state;
  r = reduceInspector(s, { type: "show", id: "b" });
  assertEquals(r.effect, "none");
  assertEquals(r.state, s);
});

Deno.test("a second tap on the same thing dismisses; a tap on another thing moves the pin", () => {
  let r = reduceInspector(initialInspector(), { type: "activate", id: "a", title: "A" });
  r = reduceInspector(r.state, { type: "activate", id: "a", title: "A" });
  assertEquals(r.effect, "unpin");
  assertEquals(r.state, { pinned: null, shown: null });
  r = reduceInspector(reduceInspector(initialInspector(), { type: "activate", id: "a", title: "A" }).state, { type: "activate", id: "b", title: "B" });
  assertEquals(r.effect, "pin");
  assertEquals(r.state.pinned, "b");
});

Deno.test("Escape and the close button dismiss a pin, and do nothing (unhandled) when nothing is pinned", () => {
  const pinned = reduceInspector(initialInspector(), { type: "activate", id: "a", title: "A" }).state;
  for (const type of ["escape", "dismiss"]) {
    const r = reduceInspector(pinned, { type });
    assertEquals(r.effect, "unpin");
    assertEquals(r.handled, true);
  }
  const r = reduceInspector(initialInspector(), { type: "escape" });
  assertEquals(r.handled, false, "Escape is left to the rest of the page");
  assertEquals(r.effect, "none");
});

Deno.test("describeInfo: title, concept, definition and facts as plain text; counts for caveats and sources", () => {
  const text = describeInfo({
    title: "port orders:out",
    concept: { iri: "https://ontology.pflow.xyz/ns#PatternPort", types: ["ns:PatternPort", "ns:OutPort"] },
    definition: "The queue's output.",
    facts: [["kind (ns:portKind)", "out"], ["schema", "queue:items"]],
    caveats: ["one"],
    cites: [{}, {}],
  });
  assertStringIncludes(text, "port orders:out.");
  assertStringIncludes(text, "Concept ns:PatternPort, a ns:PatternPort, ns:OutPort.");
  assertStringIncludes(text, "The queue's output.");
  assertStringIncludes(text, "schema: queue:items.");
  assertStringIncludes(text, "1 caveat in the panel.");
  assertStringIncludes(text, "2 sources in the panel.");
  assertEquals(describeInfo(null), "");
  assertEquals(describeInfo({ title: "x" }), "x.");
});

Deno.test("shortIri", () => {
  assertEquals(shortIri("https://ontology.pflow.xyz/pattern/queue"), "pat:queue");
  assertEquals(shortIri("https://ontology.pflow.xyz/linkkind/token"), "lk:token");
  assertEquals(shortIri("https://elsewhere/x"), "https://elsewhere/x");
});
