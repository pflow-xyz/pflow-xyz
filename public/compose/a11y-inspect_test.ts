// The inspector without hover: what is pinned, and the plain-text description.
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describeInfo, initialInspector, isNestedControl, reduceInspector, shortIri } from "./a11y-inspect.js";

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

Deno.test("the dismissal is said in words, from a second tap, Escape and the close button alike", () => {
  const pinned = reduceInspector(initialInspector(), { type: "activate", id: "a", title: "A" }).state;
  assertEquals(reduceInspector(pinned, { type: "activate", id: "a", title: "A" }).announce, "Inspector dismissed.");
  assertEquals(reduceInspector(pinned, { type: "escape" }).announce, "Inspector dismissed.");
  assertEquals(reduceInspector(pinned, { type: "dismiss" }).announce, "Inspector dismissed.");
  assertEquals(reduceInspector(initialInspector(), { type: "escape" }).announce, "", "nothing pinned, nothing said");
});

Deno.test("two different things with the same title: a tap on the second moves the pin, it does not release it", () => {
  // inspect.js gives each thing its own id (the title, then #2 for the second of the same title), so
  // the Operad's two "port orders:in" differ here although their titles are equal.
  const first = reduceInspector(initialInspector(), { type: "activate", id: "port orders:in|ns:Port", title: "port orders:in" });
  assertEquals(first.effect, "pin");
  const second = reduceInspector(first.state, { type: "activate", id: "port orders:in|ns:Port#2", title: "port orders:in" });
  assertEquals(second.effect, "pin", "moved, not dismissed");
  assertEquals(second.state.pinned, "port orders:in|ns:Port#2");
  assertStringIncludes(second.announce, "Inspector pinned: port orders:in");
  // and a tap on that same second thing again does release it
  const third = reduceInspector(second.state, { type: "activate", id: "port orders:in|ns:Port#2", title: "port orders:in" });
  assertEquals(third.effect, "unpin");
  assertEquals(third.announce, "Inspector dismissed.");
});

Deno.test("a redraw that drops the pinned thing releases the pin and says so; one that keeps it does nothing", () => {
  const pinned = reduceInspector(initialInspector(), { type: "activate", id: "a", title: "A" }).state;
  const r = reduceInspector(pinned, { type: "gone" });
  assertEquals(r.effect, "unpin");
  assertEquals(r.handled, true);
  assertEquals(r.state, { pinned: null, shown: null });
  assertEquals(r.announce, "Inspector released: the pinned thing is no longer in the view.");
  const none = reduceInspector(initialInspector(), { type: "gone" });
  assertEquals(none.effect, "none");
  assertEquals(none.announce, "");
  assertEquals(none.handled, false);
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

// A control inside an inspectable does its own work and does not pin the thing around it (Retry in the Laws status
// bar; "Assume a backward pass" in the Lenses card). `chain`: the click's target up to the inspectable, nearest first.
const link = (tag: string, extra: Record<string, unknown> = {}) => ({ tag, role: null, href: false, isNode: false, ...extra });
const node = (tag: string, extra: Record<string, unknown> = {}) => link(tag, { isNode: true, ...extra });

Deno.test("isNestedControl: a button, field or link inside the thing is a control of its own", () => {
  assertEquals(isNestedControl([link("BUTTON"), node("DIV")]), true, "Retry");
  assertEquals(isNestedControl([link("SPAN"), link("BUTTON"), node("DIV")]), true, "text inside the button");
  assertEquals(isNestedControl([link("INPUT"), node("LABEL")]), true);
  assertEquals(isNestedControl([link("SELECT"), node("DIV")]), true);
  assertEquals(isNestedControl([link("TEXTAREA"), node("DIV")]), true);
  assertEquals(isNestedControl([link("A", { href: true }), node("DIV")]), true, "a link with an href");
  assertEquals(isNestedControl([link("g", { role: "button" }), node("g")]), true, "an svg thing with role=button (the page gives its click-only buttons one)");
});

Deno.test("isNestedControl: the thing itself, plain content and an anchor without href are not", () => {
  assertEquals(isNestedControl([node("BUTTON")]), false, "the inspectable is itself a button (a chip): the click is on the thing");
  assertEquals(isNestedControl([node("g", { role: "button" })]), false, "or has role=button (a port)");
  assertEquals(isNestedControl([link("SPAN"), node("DIV")]), false, "text in the bar");
  assertEquals(isNestedControl([link("rect"), link("g"), node("g")]), false);
  assertEquals(isNestedControl([link("A"), node("DIV")]), false, "an anchor with no href is not a link");
  assertEquals(isNestedControl([]), false);
  assertEquals(isNestedControl(undefined), false);
});

Deno.test("isNestedControl: a control ABOVE the thing does not count (the chain stops at the thing)", () => {
  // chainTo (inspect.js) stops at the node, so ancestors beyond it are never in the chain; a chain that ends at the
  // thing whose own handler runs is what the predicate is given
  assertEquals(isNestedControl([link("SPAN"), node("DIV"), link("BUTTON")]), false, "the node comes first: nothing nested before it");
});
