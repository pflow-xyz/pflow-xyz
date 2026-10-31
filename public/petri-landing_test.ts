// petri-landing_test.ts — what the landing chat offers and where a submit goes: pure functions of
// /api/llm/status, the chosen route and the text. The page itself: scripts/landing-smoke.ts in Chrome.
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
  const modes: Record<string, string> = { auto: "auto", design: "build", analyse: "analyse", explain: "explain" };
  for (const [id, mode] of Object.entries(modes)) {
    assertEquals(planSubmit(id, "  a coffee shop  ", SIGNED_IN), { do: "chat", mode, message: "a coffee shop" });
    assertEquals(planSubmit(id, "  a coffee shop  ", SIGNED_OUT), { do: "login", pending: { route: id, message: "a coffee shop" } });
    assertEquals(planSubmit(id, "a coffee shop", { enabled: false }), { do: "editor" });
    assertEquals(planSubmit(id, "a coffee shop", { ...SIGNED_IN, allowed: false }), { do: "editor" });
  }
});

Deno.test("Explore leaves for the composition page whoever you are, and carries nothing to a model", () => {
  for (const status of [SIGNED_IN, SIGNED_OUT, { enabled: false }, null]) {
    assertEquals(planSubmit("explore", "anything at all", status), { do: "navigate", href: "/compose.html" });
  }
});

Deno.test("an unknown route is the default, not a failure; every route says what it does", () => {
  assertEquals(planSubmit("nope", "x", SIGNED_IN), { do: "chat", mode: "auto", message: "x" });
  assertEquals(ROUTES[0].id, "auto");
  for (const r of ROUTES) if (!r.hint || !r.label || !(r.mode || r.href)) throw new Error(`${r.id} is not a usable route`);
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
  assertEquals(routeFromSearch("?route=design")?.mode, "build");
  assertEquals(routeFromSearch("?cid=zabc&route=analyse")?.mode, "analyse");
  assertEquals(routeFromSearch("?route=explore"), null);
  assertEquals(routeFromSearch("?route=nope"), null);
  assertEquals(routeFromSearch(""), null);
  assertEquals(routeById("explore")?.href, "/compose.html");
});

function memoryStore(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as unknown as Storage;
}

Deno.test("what was typed survives the sign-in once, and bad storage loses it quietly", () => {
  const s = memoryStore();
  assertEquals(takePending(s), null);
  assertEquals(keepPending(s, { route: "design", message: "a queue" }), true);
  assertEquals(takePending(s), { route: "design", message: "a queue" });
  assertEquals(takePending(s), null, "read once");

  s.setItem("pflow_landing_pending", "{not json");
  assertEquals(takePending(s), null);
  s.setItem("pflow_landing_pending", JSON.stringify({ route: "explore", message: "x" }));
  assertEquals(takePending(s), null, "only a route that opens the Assistant");

  const blocked = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } } as unknown as Storage;
  assertEquals(takePending(blocked), null);
  assertEquals(keepPending(blocked, { route: "auto", message: "x" }), false);
});
