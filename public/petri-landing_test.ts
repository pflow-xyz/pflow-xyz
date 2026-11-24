// petri-landing_test.ts — the names a chat session starts under, and the words kept across a sign-in. The landing page
// and its hero chat are gone (/ opens straight into the IDE: docs/ide-shell.md section 9); what is left of
// petri-landing.js is what the Ask pane still imports.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { keepPending, routeById, ROUTES, routeFromSearch, takePending } from "./petri-landing.js";

Deno.test("the old name of Build still works: design is an alias, and what is kept is the new name", () => {
  assertEquals(routeById("design")?.id, "build");
  assertEquals(routeById("design")?.mode, "build");
  assertEquals(ROUTES.find((r) => r.id === "design")?.alias, "build", "the alias is in the table");
});

Deno.test("the user-facing set is Build, Analyse, Explain; Explore and Compose are not modes", () => {
  const named = ROUTES.filter((r) => !r.alias && r.id !== "auto").map((r) => r.label);
  assertEquals(named, ["Build", "Analyse", "Explain"]);
  for (const r of ROUTES) if (/design|explore|decide/i.test(r.label || "")) throw new Error(`${r.id} still says ${r.label}`);
  assertEquals(routeById("explore"), null);
  assertEquals(routeById("compose"), null);
});

Deno.test("every route is usable", () => {
  assertEquals(ROUTES[0].id, "auto");
  for (const r of ROUTES) {
    if (r.alias) { if (!routeById(r.alias)) throw new Error(`${r.id} names a missing route`); continue; }
    if (!r.label || !r.mode) throw new Error(`${r.id} is not a usable route`);
  }
});

Deno.test("a URL names a session: a mode, never another page or something unknown", () => {
  assertEquals(routeFromSearch("?route=build")?.mode, "build");
  assertEquals(routeFromSearch("?route=design")?.mode, "build", "the old name");
  assertEquals(routeFromSearch("?cid=zabc&route=analyse")?.mode, "analyse");
  assertEquals(routeFromSearch("?route=explain")?.mode, "explain");
  assertEquals(routeFromSearch("?route=auto")?.mode, "auto");
  assertEquals(routeFromSearch("?route=explore"), null);
  assertEquals(routeFromSearch("?route=compose"), null);
  assertEquals(routeFromSearch("?route=nope"), null);
  assertEquals(routeFromSearch(""), null);
});

function memoryStore(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as unknown as Storage;
}

Deno.test("what was typed survives the sign-in once, and bad storage loses it quietly", () => {
  const s = memoryStore();
  assertEquals(takePending(s), null);
  assertEquals(keepPending(s, { route: "build", message: "a queue" }), true);
  assertEquals(takePending(s), { route: "build", message: "a queue" });
  assertEquals(takePending(s), null, "read once");

  // Words kept by the page before the rename (route "design") are still sent, as Build.
  s.setItem("pflow_landing_pending", JSON.stringify({ route: "design", message: "an older tab" }));
  assertEquals(takePending(s), { route: "build", message: "an older tab" });

  s.setItem("pflow_landing_pending", "{not json");
  assertEquals(takePending(s), null);
  s.setItem("pflow_landing_pending", JSON.stringify({ route: "explore", message: "x" }));
  assertEquals(takePending(s), null, "only a route that opens the Assistant");

  const blocked = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } } as unknown as Storage;
  assertEquals(takePending(blocked), null);
  assertEquals(keepPending(blocked, { route: "auto", message: "x" }), false);
});

Deno.test("the page is the IDE: no landing hero, no Ask box, no quota line, no sim links, and the guide links are there", async () => {
  const html = await Deno.readTextFile(new URL("./index.html", import.meta.url));
  assertFalse(/id="landing"|landing-chat|petri-landing\.js|pflow_skip_landing/.test(html), "the landing page is gone");
  assertFalse(/gemini|model calls left|sim\.pflow\.xyz|Calibrated what-if/i.test(html), "no Gemini, quota or sim copy on the page");
  assert(html.includes('id="editor-wrapper"') && !/id="editor-wrapper"[^>]*display:\s*none/.test(html), "the editor is on screen from the first paint");
  assert(html.includes('petri-shell-boot.js'), "the shell boots");
  const guide = await Deno.readTextFile(new URL("./petri-shell-guide.js", import.meta.url));
  for (const href of ["https://book.pflow.xyz", "https://blog.stackdump.com", "https://ontology.pflow.xyz", "https://github.com/pflow-xyz/pflow-xyz", "https://pflow.xyz/mcp", "/mcp.html"]) {
    assert(guide.includes(href), `the Connect window links ${href}`);
  }
  assertFalse(/sim\.pflow\.xyz/.test(guide), "and nothing goes to sim");
});
