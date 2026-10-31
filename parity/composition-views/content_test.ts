// content_test.ts — the views read what a model means from its content (public/compose/content.js), on
// the vendored registry, not from text of their own:
//
//  - every entry a view asks for by id exists in the content the page reads for that example, so a
//    typo cannot silently blank a hover;
//  - each of the ten views has its convention-example in both libraries, and no module carries its own;
//  - what the model no longer has is not said: an entry whose element ids do not resolve is dormant,
//    and a composition the content does not attach to is bare and says so;
//  - the honesty rules: a judgment reads as one wherever it is shown, the panel marks a check only from
//    content.check's answer, and an unrun check is not ticked.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EXAMPLES, setup, VIEW_IDS } from "./render.js";
import { engines } from "../../public/compose/registry.js";
import { checkContentEntry, modelLacks, readContent } from "../../public/compose/model.js";
import { claimOf, contentReader, entryText } from "../../public/compose/content.js";
import { renderContentPanel } from "../../public/compose/content-panel.js";

const G = globalThis as any;
const COMPOSE = new URL("../../public/compose/", import.meta.url);
const viewSources = [...Deno.readDirSync(new URL("views/", COMPOSE))]
  .filter((f) => f.name.endsWith(".js"))
  .map((f) => ({ name: f.name, src: Deno.readTextFileSync(new URL(`views/${f.name}`, COMPOSE)) }));
const askedFor = (src: string) => [...src.matchAll(/ctx\.content\.(?:text|entry)\('([^']+)'\)/g)].map((m) => m[1]);
const live = () => engines.live as any;
const reopen = () => live().call("bundle.open", {});

Deno.test("an entry's text: a judgment says it is one, and says so only once", () => {
  assertEquals(entryText({ kind: "judgment", text: "Which unit is the worker is a choice." }), "Judgment: Which unit is the worker is a choice.");
  assertEquals(entryText({ kind: "judgment", text: "Placed by the recursion: the view's judgment." }), "Placed by the recursion: the view's judgment.");
  assertEquals(entryText({ kind: "caveat", text: "A limit." }), "A limit.");
  assertEquals(entryText(null), "");
  assertEquals(claimOf({ check: JSON.stringify({ claim: "it holds", steps: [] }) }), "it holds");
  assertEquals(claimOf({ check: "not json" }), null);
  assertEquals(claimOf({}), null);
});

Deno.test("a bare reader answers nothing, and says it is bare", () => {
  for (const r of [contentReader(null), contentReader({ source: "none", entries: [], total: 0, dormant: 0 })]) {
    assertEquals([r.bare, r.text("anything"), r.entry("anything"), r.example("flat"), r.groups("flat")], [true, "", null, "", []]);
  }
});

Deno.test("every entry a view asks for exists, for the example it draws", async () => {
  await setup();
  reopen();
  const ids = new Set([...readContent("orders").entries, ...readContent("connect4").entries].map((e: any) => e.id));
  const asked = viewSources.flatMap((v) => askedFor(v.src).map((id) => [v.name, id]));
  assert(asked.length >= 24, `only ${asked.length} sites read content`); // a ratchet: moving prose back into a view fails here
  for (const [file, id] of asked) assert(ids.has(id), `${file} asks for ${id}, which the library does not have`);
});

Deno.test("each view has a convention example in both libraries, and no module writes its own", async () => {
  await setup();
  reopen();
  for (const example of EXAMPLES) {
    const r = readContent(example);
    for (const view of VIEW_IDS) assert(r.example(view), `${view} / ${example} has no convention example`);
  }
  for (const v of viewSources) assert(!/\n\s+examples: \{/.test(v.src), `${v.name} still carries convention.examples`);
});

Deno.test("the open model's content: a removed element silences what names it; a bare model says so", async () => {
  await setup();
  reopen();
  const full = readContent("orders");
  assertEquals([full.source, full.dormant, full.bare], ["library:orders", 0, false]);
  assert(full.text("spiders-pool-leak"), "the leak's caveat is there with the link");

  live().call("bundle.clear_links", {});
  const unlinked = readContent("orders");
  assert(unlinked.dormant > 0, "no entry went dormant");
  assertEquals(unlinked.text("spiders-pool-leak"), "", "the caveat on a link that is gone");

  live().call("bundle.open", { instances: ["orders", "workers"] });
  const bare = readContent("orders");
  assertEquals([bare.source, bare.bare], ["none", true]);
  assert(modelLacks("orders").some((m: any) => m.code === "NO_CONTENT"));
  reopen();
});

/** The panel's text, a flat tree of what it drew. */
function panel(reader: any, marks = new Map(), view = "flat", lacks: any[] = [], over: any = {}) {
  const box = G.document.createElement("section");
  renderContentPanel(box, { reader, lacks, view, marks, runCheck: () => ({ ok: true }), rerender: () => {}, ...over });
  return box;
}
const textOf = (n: any): string => n.textContent as string;

Deno.test("the panel: kinds are labelled, a claim is not a result, a mark is the registry's", async () => {
  await setup();
  reopen();
  const reader = readContent("orders");
  const quiet = panel(reader, new Map());
  const before = textOf(quiet);
  assert(before.includes("Findings"), before.slice(0, 200));
  assert(before.includes("Judgment"));
  assert(before.includes("Check, not yet a result:"), "a check's claim must not read as a result");
  assert(!before.includes("check passed"), "an unrun check is ticked");

  const id = reader.groups("flat").flatMap((g: any) => g.entries).find((e: any) => e.check).id;
  const verdict = checkContentEntry("orders", id);
  assertEquals(verdict.id, id);
  const shown = textOf(panel(reader, new Map([[id, { ok: !!verdict.ok }]])));
  assert(shown.includes(verdict.ok ? "check passed" : "check failed"));
  const failed = textOf(panel(reader, new Map([[id, { ok: false }]])));
  assert(failed.includes("check failed"));

  assert(textOf(panel(contentReader(null))).includes("no content attached"));
  const lacking = textOf(panel(reader, new Map(), "flat", [{ code: "NO_LAYOUT", text: "stores no positions" }]));
  assert(lacking.includes("stores no positions"));
});

Deno.test("every library check the panel can run answers on the page's engines", async () => {
  await setup();
  reopen();
  for (const example of EXAMPLES) {
    const r = readContent(example);
    const withCheck = r.entries.filter((e: any) => e.check);
    assert(withCheck.length > 0, example);
    const v = checkContentEntry(example, withCheck[0].id);
    assertEquals(v.id, withCheck[0].id);
    assertEquals(typeof v.ok, "boolean");
  }
});
