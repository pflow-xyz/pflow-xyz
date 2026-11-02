// petri-landing_test.ts — what the landing chat offers and where a submit goes: pure functions of
// /api/llm/status, the forced route (if any) and the text. The vocabulary is Build, Analyse, Explain
// (docs/design/agent-first-analysis.md section 16.1). The page itself: scripts/landing-smoke.ts in Chrome.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { keepPending, landingState, planSubmit, routeById, ROUTES, routeFromSearch, stateWords, takePending } from "./petri-landing.js";

const SIGNED_OUT = { enabled: true, chat: true, signed_in: false };
const SIGNED_IN = { enabled: true, chat: true, signed_in: true, remaining_today: 12 };

Deno.test("the state comes from the status; nothing offers a chat that would answer 401 or 403", () => {
  assertEquals(landingState(SIGNED_OUT), "sign-in");
  assertEquals(landingState(SIGNED_IN), "chat");
  assertEquals(landingState({ ...SIGNED_IN, allowed: true }), "chat");
  assertEquals(landingState({ ...SIGNED_IN, allowed: false }), "not-allowed");
  assertEquals(landingState({ enabled: false, signed_in: false }), "off");
  assertEquals(landingState({ enabled: true, chat: false, signed_in: true }), "off"); // drafting on, no tool manifest
  assertEquals(landingState(null), "off"); // the status could not be read
});

Deno.test("each route: chat signed in, sign-in first signed out with the words kept, the editor when there is no chat", () => {
  const modes: Record<string, string> = { auto: "auto", build: "build", analyse: "analyse", explain: "explain" };
  for (const [id, mode] of Object.entries(modes)) {
    assertEquals(planSubmit(id, "  a coffee shop  ", SIGNED_IN), { do: "chat", mode, message: "a coffee shop" });
    assertEquals(planSubmit(id, "  a coffee shop  ", SIGNED_OUT), { do: "login", pending: { route: id, message: "a coffee shop" } });
    assertEquals(planSubmit(id, "a coffee shop", { enabled: false }), { do: "editor" });
    assertEquals(planSubmit(id, "a coffee shop", { ...SIGNED_IN, allowed: false }), { do: "editor" });
  }
});

Deno.test("the old name of Build still works: design is an alias, and what is kept is the new name", () => {
  assertEquals(routeById("design")?.id, "build");
  assertEquals(routeById("design")?.mode, "build");
  assertEquals(ROUTES.find((r) => r.id === "design")?.alias, "build", "the alias is in the table");
  assertEquals(planSubmit("design", "a queue", SIGNED_IN), { do: "chat", mode: "build", message: "a queue" });
  assertEquals(planSubmit("design", "a queue", SIGNED_OUT), { do: "login", pending: { route: "build", message: "a queue" } });
});

Deno.test("the user-facing set is Build, Analyse, Explain; Explore and Compose are not modes", () => {
  const named = ROUTES.filter((r) => !r.alias && r.id !== "auto").map((r) => r.label);
  assertEquals(named, ["Build", "Analyse", "Explain"]);
  for (const r of ROUTES) if (/design|explore|decide/i.test(r.label || "")) throw new Error(`${r.id} still says ${r.label}`);
  assertEquals(routeById("explore"), null);
  assertEquals(routeById("compose"), null);
  // A destination is not a session, so it plans as the default and never navigates from the Ask.
  assertEquals(planSubmit("explore", "x", SIGNED_IN), { do: "chat", mode: "auto", message: "x" });
});

Deno.test("an unknown route is the default, not a failure; every route says what it does", () => {
  assertEquals(planSubmit("nope", "x", SIGNED_IN), { do: "chat", mode: "auto", message: "x" });
  assertEquals(planSubmit(undefined, "x", SIGNED_IN), { do: "chat", mode: "auto", message: "x" });
  assertEquals(ROUTES[0].id, "auto");
  for (const r of ROUTES) {
    if (r.alias) { if (!routeById(r.alias)) throw new Error(`${r.id} names a missing route`); continue; }
    if (!r.hint || !r.label || !r.mode) throw new Error(`${r.id} is not a usable route`);
  }
});

Deno.test("the words: the quota, who answers, and the connector when there is no chat", () => {
  const chat = stateWords("chat", SIGNED_IN);
  assertEquals(chat.connector, false);
  if (!chat.text.includes("12 model calls left today") || !chat.text.includes("Replies are Gemini's")) throw new Error(chat.text);
  assertEquals(stateWords("sign-in", SIGNED_OUT).connector, true);
  assertEquals(stateWords("not-allowed", SIGNED_IN).send, "Open the editor");
  assertEquals(stateWords("off", null).send, "Open the editor");
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

// The static page: what a crawler and a visitor without the script read. Text-level on purpose (a regexp over the
// source, no DOM): it holds the vocabulary of docs/design/agent-first-analysis.md section 16 to the markup.
const HTML = await Deno.readTextFile(new URL("./index.html", import.meta.url));
const section = (open: string): string => {
  const start = HTML.indexOf(open);
  if (start < 0) throw new Error(`index.html has no ${open}`);
  return HTML.slice(start, HTML.indexOf("</section>", start));
};
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, " ").replace(/&rarr;/g, "->").replace(/\s+/g, " ");

Deno.test("the hero uses one vocabulary: Build, Analyse, Explain, and Compose as a plain link", () => {
  const hero = section('<section class="landing-hero">');
  const radios = [...hero.matchAll(/<input[^>]*type="radio"[^>]*value="([^"]+)"/g)].map((m) => m[1]);
  assertEquals(radios, ["build", "analyse", "explain"]);
  assertEquals(/<input[^>]*\schecked/.test(hero), false, "nothing is forced by default");
  const words = textOf(hero);
  for (const gone of ["Let it decide", "Design", "Explore"]) assertEquals(words.includes(gone), false, `the hero still says ${gone}`);
  for (const kept of ["Build", "Analyse", "Explain", "Open the editor"]) assertEquals(words.includes(kept), true, `the hero lost ${kept}`);
  assertEquals(/<a[^>]*href="\/compose\.html"[^>]*>\s*Compose\s*<\/a>/.test(hero), true, "Compose is a link, in the hero");
});

Deno.test("a deep link that names a session skips the landing: the page knows every route the module does", () => {
  const listed = HTML.match(/\[((?:'[a-z]+',?\s*)+)\]\.includes\(params\.get\('route'\)\)/);
  if (!listed) throw new Error("index.html has no list of session routes");
  const inPage = [...listed[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  const inModule = ROUTES.map((r) => r.id).sort();
  assertEquals(inPage, inModule);
});
