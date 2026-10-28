// compose/identity.js: the model panel behind /compose.html?cid=. Its pure
// functions (what it says about a stored document, which cid the URL names);
// the rule itself is tested in public/model-cid_test.ts.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { summarize, cidFromLocation } from "./identity.js";

const fixture = async (f: string) => JSON.parse(await Deno.readTextFile(new URL(`../../parity/model/fixtures/${f}`, import.meta.url)));

Deno.test("the panel reads a stored document", async () => {
  // deno-lint-ignore no-explicit-any
  const s: any = summarize(await fixture("compose-handoff.jsonld"));
  assertEquals([s.kind, s.name, s.parts.length, s.links.length], ["composition", "handoff", 2, 1]);
  assertEquals(s.links[0].from, "maker:Handoff");
  // deno-lint-ignore no-explicit-any
  const recipe: any = summarize(await fixture("compose-recipe.jsonld"));
  assertEquals(recipe.parts[0].pattern, "resource-pool");
  assertEquals(summarize(await fixture("part-maker.jsonld")).kind, "net");
  assertEquals(cidFromLocation({ search: "?cid=zabc" } as Location), "zabc");
  assertEquals(cidFromLocation({ search: "" } as Location), null);
});
