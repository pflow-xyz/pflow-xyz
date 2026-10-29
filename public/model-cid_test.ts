// model-cid.mjs and compose/identity.js: the page-side half of the model
// identity rule. The cross-language vectors are checked by
// parity/model_check.mjs (node); this runs the same golden file under deno, the
// page's own runtime.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { identify, check, canonicalJson, newPlan, bareWrapper, kindOf, ModelError } from "./model-cid.mjs";
import { computeCid } from "./seal-cid.mjs";

const golden = JSON.parse(await Deno.readTextFile(new URL("../parity/model/golden.json", import.meta.url)));
const canon = JSON.parse(await Deno.readTextFile(new URL("../parity/model/canonical.json", import.meta.url)));
const fixture = async (f: string) => JSON.parse(await Deno.readTextFile(new URL(`../parity/model/${f}`, import.meta.url)));

Deno.test("identify reproduces every golden vector", async () => {
  for (const v of golden.vectors) {
    const id = await identify(await fixture(v.file));
    assertEquals([id.sealed, id.cid, id.reduced], [v.sealed, v.model, v.reduced], v.name);
  }
});

Deno.test("every refusal has its code", () => {
  for (const r of golden.refusals) {
    let code = "";
    try { check(r.doc); } catch (e) { code = (e as ModelError).code; }
    assertEquals(code, r.code, r.name);
  }
});

Deno.test("canonical JSON vectors", () => {
  for (const v of canon.vectors) assertEquals(canonicalJson(v.in), v.out, v.name);
});

Deno.test("a net keeps the CID computeCid gives it", async () => {
  const net = JSON.parse(await Deno.readTextFile(new URL("../parity/fixtures/coffee-shop.jsonld", import.meta.url)));
  assertEquals(kindOf(net), "net");
  assertEquals((await identify(net)).cid, await computeCid(net));
});

Deno.test("a bare wrapper is its net; a name makes it a composition", async () => {
  const wrap = await fixture("fixtures/wrap-coffee-shop.jsonld");
  const part = wrap.subnets[0].cid;
  assertEquals(bareWrapper(wrap), part);
  assertEquals(bareWrapper({ ...wrap, name: "x" }), null);
});

Deno.test("a plan names its model and keeps its order as text", async () => {
  const m = golden.vectors.find((v: { name: string }) => v.name === "wrap-coffee-shop.jsonld").model;
  const a = await identify(newPlan(m, '{"order":["a","b"]}'));
  const b = await identify(newPlan(m, '{"order":["b","a"]}'));
  const same = await identify(newPlan(m, '{ "order": [ "a", "b" ] }'));
  assertEquals(a.kind, "plan");
  assertEquals(a.cid, same.cid);
  assert(a.cid !== b.cid);
  await assertRejects(async () => { await identify({ "@context": "https://pflow.xyz/schema", "@type": "SearchPlan", plan: "{}" }); }, Error, "E_PLAN");
});
