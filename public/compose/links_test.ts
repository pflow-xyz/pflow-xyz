// links_test.ts — the link format round-trips, what a hash names is what is written back.
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decodeLinks, decodePlan, encodeLinks, encodePlan, readLink, writeLink as write } from "./links.js";

const writeLink = write as (l: unknown) => string;

const LINKS = [
  { kind: "event", from: { subnet: "orders", port: "dequeue" }, to: { subnet: "workers", port: "acquire" } },
  { kind: "event", from: { subnet: "orders", port: "dequeue" }, to: { subnet: "payment", port: "do:reserve" } }, // a colon in a port id
  { kind: "token", from: { subnet: "payment", port: "account:customer" }, to: { subnet: "payment2", port: "account:customer" } },
];

Deno.test("links round-trip, and read as words", () => {
  const text = encodeLinks(LINKS);
  assertEquals(decodeLinks(text), LINKS);
  assertEquals(text.split(",")[1], "event~orders:dequeue~payment:do:reserve");
  assertEquals(decodeLinks(""), []);
  assertEquals(encodeLinks([]), "");
});

Deno.test("text that is not a link list throws, for the page to say so", () => {
  for (const bad of ["event", "event~a", "event~a~b", "event~a:b~c:d~e:f", "event~:b~c:d", "event~a:~c:d"]) assertThrows(() => decodeLinks(bad), Error, undefined, bad);
});

Deno.test("a plan round-trips, url-safe", () => {
  const plan = { mode: "exact", order: ["tt_best", "centrality"], drivers: [{ budget: { nodes: 1000000 } }], memo: { entries: 500000 }, note: "é>>??" };
  const text = encodePlan(JSON.stringify(plan));
  assertEquals(/^[A-Za-z0-9_-]+$/.test(text), true, text);
  assertEquals(decodePlan(text), plan);
  assertThrows(() => decodePlan("not a plan!"));
});

Deno.test("a hash reads and writes back the same, keeping a view's own parameters", () => {
  const hash = "#view=string&ex=connect4&inst=orders,workers&links=event~orders:dequeue~workers:acquire&plan=e30&level=transition&foo=a+b";
  const l = readLink(hash);
  assertEquals([l.view, l.ex, l.inst, l.plan], ["string", "connect4", "orders,workers", "e30"]);
  assertEquals(decodeLinks(l.links!), [LINKS[0]]);
  assertEquals(l.own, [["level", "transition"], ["foo", "a b"]]);
  assertEquals(writeLink(l), hash);
});

Deno.test("absent is not empty: no links is a state a link can name", () => {
  assertEquals(readLink("#view=flat").links, undefined);
  assertEquals(readLink("#view=flat&links=").links, "");
  assertEquals(writeLink({ view: "flat", links: "" }), "#view=flat&links=");
  assertEquals(writeLink({ view: "flat" }), "#view=flat");
  assertEquals(readLink("").view, undefined);
  // a view's own rewrite percent-encodes through URLSearchParams; it reads the same
  assertEquals(readLink("#links=event%7Eorders%3Adequeue%7Eworkers%3Aacquire").links, "event~orders:dequeue~workers:acquire");
});
