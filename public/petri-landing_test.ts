// petri-landing_test.ts — what the landing chat offers and where a submit goes: pure functions of
// /api/llm/status, the forced route (if any) and the text. The hero is one input and one Ask, forcing nothing;
// the vocabulary is Build, Analyse, Explain (docs/design/agent-first-analysis.md section 16.1). The page itself:
// scripts/landing-smoke.ts in Chrome.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { initLanding, keepPending, landingState, planSubmit, routeById, ROUTES, routeFromSearch, stateWords, takePending } from "./petri-landing.js";

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

Deno.test("the hero forces nothing: chat signed in, sign-in first signed out with the words kept, the editor when there is no chat", () => {
  const text = "  a coffee shop  ";
  for (const route of [undefined, "auto", "nope"]) {
    assertEquals(planSubmit(route, text, SIGNED_IN), { do: "chat", mode: "auto", message: "a coffee shop" });
    assertEquals(planSubmit(route, text, SIGNED_OUT), { do: "login", pending: { route: "auto", message: "a coffee shop" } });
    assertEquals(planSubmit(route, text, { ...SIGNED_IN, allowed: false }), { do: "editor" });
    assertEquals(planSubmit(route, text, { enabled: false }), { do: "editor" });
    assertEquals(planSubmit(route, text, null), { do: "editor" });
  }
  assertEquals(planSubmit("auto", "", SIGNED_IN), { do: "chat", mode: "auto", message: "" }, "an empty ask still opens the session");
});

Deno.test("a forced route (a link, or words kept across the sign-in) keeps its mode in every state", () => {
  const modes: Record<string, string> = { build: "build", analyse: "analyse", explain: "explain" };
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

Deno.test("an unknown route is the default, not a failure; every route is usable", () => {
  assertEquals(ROUTES[0].id, "auto");
  assertEquals(planSubmit("nope", "x", SIGNED_IN), { do: "chat", mode: "auto", message: "x" });
  for (const r of ROUTES) {
    if (r.alias) { if (!routeById(r.alias)) throw new Error(`${r.id} names a missing route`); continue; }
    if (!r.label || !r.mode) throw new Error(`${r.id} is not a usable route`);
  }
});

Deno.test("the words: the quota, who answers, and the connector when there is no chat", () => {
  const chat = stateWords("chat", SIGNED_IN);
  assertEquals(chat.connector, false);
  if (!chat.text.includes("12 model calls left today") || !chat.text.includes("Replies are Gemini's")) throw new Error(chat.text);
  assertEquals(stateWords("sign-in", SIGNED_OUT).connector, true);
  assertEquals(stateWords("not-allowed", SIGNED_IN).connector, true);
  assertEquals(stateWords("off", null).connector, true);
});

Deno.test("the button says what a press does, per state", () => {
  assertEquals(stateWords("chat", SIGNED_IN).send, "Ask");
  assertEquals(stateWords("sign-in", SIGNED_OUT).send, "Sign in with GitHub and ask");
  assertEquals(stateWords("not-allowed", SIGNED_IN).send, "Open the editor");
  assertEquals(stateWords("off", null).send, "Open the editor");
  assertEquals(stateWords("checking", null).send, "Ask", "before the status answers it is the Ask, not a refusal");
  // Whatever the state, the words never name a mode to pick: the hero forces nothing.
  for (const state of ["chat", "sign-in", "not-allowed", "off", "checking"]) {
    const w = stateWords(state, SIGNED_IN);
    if (/let it decide|design|explore|start/i.test(`${w.text} ${w.send}`)) throw new Error(`${state}: ${w.text} / ${w.send}`);
  }
});

Deno.test("no input that would answer 401: the box is offered only where Ask can work", () => {
  for (const [state, status] of [["chat", SIGNED_IN], ["sign-in", SIGNED_OUT], ["checking", null]] as const) assertEquals(stateWords(state, status).input, true, state);
  for (const [state, status] of [["not-allowed", { ...SIGNED_IN, allowed: false }], ["off", null]] as const) {
    assertEquals(stateWords(state, status).input, false, state);
    if (!stateWords(state, status).text) throw new Error(`${state} must say why there is no box`);
  }
  // And the states line up with the status, so a hidden box is always a reasoned one.
  assertEquals(stateWords(landingState({ ...SIGNED_IN, allowed: false }), SIGNED_IN).input, false);
  assertEquals(stateWords(landingState(SIGNED_OUT), SIGNED_OUT).input, true);
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

// The wiring, against a stand-in page: just enough of the DOM for initLanding. It shows what the hero does in each state
// (the part scripts/landing-smoke.ts proves in Chrome, which needs a display); the browser is still the proof of layout.
// deno-lint-ignore no-explicit-any
type Fake = any;
function fakeEl(extra: Fake = {}): Fake {
  const on: Record<string, Array<(e: Fake) => unknown>> = {};
  return {
    hidden: false, textContent: "", value: "", dataset: {}, style: {},
    addEventListener(type: string, f: (e: Fake) => unknown) { (on[type] ||= []).push(f); },
    async fire(type: string, ev: Fake = {}) { for (const f of on[type] || []) await f({ preventDefault() {}, ...ev }); },
    closest() { return { style: {} }; },
    requestSubmit() { return this.fire("submit"); },
    listeners: on,
    ...extra,
  };
}
function stage(opts: { status?: Fake; search?: string; pending?: { route: string; message: string }; fail?: boolean } = {}) {
  const els: Record<string, Fake> = {};
  for (const id of ["landing-chat", "landing-chat-input", "landing-chat-ask", "landing-chat-state", "landing-chat-send", "landing-chat-connector"]) els[id] = fakeEl();
  els["landing-chat-connector"].hidden = true; // as the page ships it
  const calls = { chat: [] as Fake[], login: 0, editor: 0 };
  let release: (s: Fake) => void = () => {};
  const answer = new Promise<Fake>((r) => { release = r; });
  const view = {
    _llmStatus: () => opts.fail ? Promise.reject(new Error("offline")) : (opts.status === undefined ? answer : Promise.resolve(opts.status)),
    _openChat: (o: Fake) => { calls.chat.push(o); return Promise.resolve(); },
    _loginWithGitHub: () => { calls.login++; },
  };
  const store = memoryStore();
  if (opts.pending) keepPending(store, opts.pending);
  const doc = { querySelector: (s: string) => (s === "petri-view" ? view : null), getElementById: (id: string) => els[id] ?? null };
  const win = { customElements: { whenDefined: () => Promise.resolve() }, sessionStorage: store, location: { search: opts.search || "" }, pflowShowEditor: () => { calls.editor++; } };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { els, calls, store, release, tick, start: () => initLanding({ doc, win } as Fake) };
}

Deno.test("the hero before the status answers is an Ask, not a refusal", async () => {
  const t = stage();
  await t.start();
  assertEquals(t.els["landing-chat"].dataset.state, "checking");
  assertEquals(t.els["landing-chat-send"].textContent, "Ask");
  assertEquals(t.els["landing-chat-input"].hidden, false);
  assertEquals(t.els["landing-chat-state"].textContent, "", "nothing announced yet");
  assertEquals(t.els["landing-chat-connector"].hidden, true);
  t.release(SIGNED_IN);
  await t.tick();
  assertEquals(t.els["landing-chat"].dataset.state, "chat");
});

Deno.test("signed in: one Ask, and the session starts with nothing forced", async () => {
  const t = stage({ status: SIGNED_IN });
  await t.start();
  await t.tick();
  assertEquals(t.els["landing-chat-send"].textContent, "Ask");
  assertEquals(t.els["landing-chat-input"].hidden, false);
  if (!t.els["landing-chat-state"].textContent.includes("12 model calls left today")) throw new Error(t.els["landing-chat-state"].textContent);
  t.els["landing-chat-input"].value = "  where does it jam?  ";
  await t.els["landing-chat"].fire("submit");
  assertEquals(t.calls.chat, [{ mode: "auto", message: "where does it jam?" }]);
  assertEquals(t.calls.editor, 1);
  assertEquals(t.calls.login, 0);
});

Deno.test("signed out: the words wait in the tab and the sign-in starts; no chat opens", async () => {
  const t = stage({ status: SIGNED_OUT });
  await t.start();
  await t.tick();
  assertEquals(t.els["landing-chat-send"].textContent, "Sign in with GitHub and ask");
  assertEquals(t.els["landing-chat-connector"].hidden, false);
  assertEquals(t.els["landing-chat-input"].hidden, false, "the box stays: what is typed is kept, not refused");
  t.els["landing-chat-input"].value = "a queue";
  await t.els["landing-chat"].fire("submit");
  assertEquals(t.calls.login, 1);
  assertEquals(t.calls.chat, []);
  assertEquals(t.calls.editor, 0);
  assertEquals(takePending(t.store), { route: "auto", message: "a queue" });
});

Deno.test("not allowed, or no chat, or an unreadable status: no box, the reason, the connector and the editor", async () => {
  for (const [name, opts] of [["not allowed", { status: { ...SIGNED_IN, allowed: false } }], ["off", { status: { enabled: false } }], ["unreadable", { fail: true }]] as const) {
    const t = stage(opts);
    await t.start();
    await t.tick();
    assertEquals(t.els["landing-chat-input"].hidden, true, `${name}: no box that goes nowhere`);
    assertEquals(t.els["landing-chat-ask"].hidden, true, `${name}: and no question for it`);
    assertEquals(t.els["landing-chat-send"].textContent, "Open the editor", name);
    assertEquals(t.els["landing-chat-connector"].hidden, false, name);
    if (!t.els["landing-chat-state"].textContent.includes("editor")) throw new Error(`${name}: ${t.els["landing-chat-state"].textContent}`);
    t.els["landing-chat-input"].value = "typed anyway";
    await t.els["landing-chat"].fire("submit");
    assertEquals(t.calls.editor, 1, name);
    assertEquals([t.calls.chat, t.calls.login], [[], 0], `${name}: nothing is sent`);
  }
});

Deno.test("a submit before the status answers waits for it, and then goes where the status says", async () => {
  const t = stage();
  await t.start();
  t.els["landing-chat-input"].value = "too quick";
  const submitted = t.els["landing-chat"].fire("submit");
  await t.tick();
  assertEquals(t.calls.chat, [], "nothing yet");
  t.release(SIGNED_IN);
  await submitted;
  assertEquals(t.calls.chat, [{ mode: "auto", message: "too quick" }]);
});

Deno.test("Enter asks and Shift+Enter is a new line", async () => {
  const t = stage({ status: SIGNED_IN });
  await t.start();
  await t.tick();
  t.els["landing-chat-input"].value = "enter";
  let prevented = 0;
  await t.els["landing-chat-input"].fire("keydown", { key: "Enter", shiftKey: true, preventDefault() { prevented++; } });
  assertEquals([prevented, t.calls.chat.length], [0, 0]);
  await t.els["landing-chat-input"].fire("keydown", { key: "Enter", shiftKey: false, preventDefault() { prevented++; } });
  await t.tick();
  assertEquals(prevented, 1);
  assertEquals(t.calls.chat, [{ mode: "auto", message: "enter" }]);
});

Deno.test("a link that names a session forces it, sends nothing, and leaves the hero unwired", async () => {
  for (const [search, mode] of [["?route=build", "build"], ["?route=design", "build"], ["?cid=zabc&route=analyse", "analyse"], ["?route=explain", "explain"], ["?route=auto", "auto"]]) {
    const t = stage({ status: SIGNED_IN, search });
    await t.start();
    assertEquals(t.calls.chat, [{ mode, message: "" }], search);
    assertEquals(t.calls.editor, 1, search);
    assertEquals(Object.keys(t.els["landing-chat"].listeners), [], `${search}: the hero is not wired when the editor opens`);
  }
  // Not a mode: the landing is shown as usual.
  for (const search of ["?route=explore", "?route=compose", "?route=nope"]) {
    const t = stage({ status: SIGNED_IN, search });
    await t.start();
    assertEquals([t.calls.chat, t.calls.editor], [[], 0], search);
    assertEquals(Object.keys(t.els["landing-chat"].listeners).includes("submit"), true, search);
  }
});

Deno.test("back from the sign-in: the kept words go out in the route kept, once", async () => {
  for (const [route, mode] of [["auto", "auto"], ["build", "build"], ["design", "build"]]) {
    const t = stage({ status: SIGNED_IN, pending: { route, message: "a queue" } });
    await t.start();
    assertEquals(t.calls.chat, [{ mode, message: "a queue" }], route);
    assertEquals(takePending(t.store), null, `${route}: read once`);
  }
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

Deno.test("the hero is one input and one Ask: no mode radios, nothing advertises a mode", () => {
  const hero = section('<section class="landing-hero">');
  assertEquals(/type="radio"/.test(hero), false, "no radios");
  assertEquals(/<fieldset|<legend|landing-chat-hint|name="route"/.test(hero), false, "nothing is left of the mode picker");
  assertEquals((hero.match(/<textarea/g) || []).length, 1, "one input");
  assertEquals((hero.match(/type="submit"/g) || []).length, 1, "one submit");
  assertEquals(/<button[^>]*type="submit"[^>]*id="landing-chat-send"[^>]*>\s*Ask\s*<\/button>/.test(hero), true, "and it says Ask");
  const words = textOf(hero);
  for (const gone of ["Let it decide", "Design", "Explore", "Start", "Build", "Analyse", "Explain"]) assertEquals(words.includes(gone), false, `the hero still says ${gone}`);
  assertEquals(words.includes("Open the editor"), true);
  assertEquals(/<a[^>]*href="\/compose\.html"[^>]*>\s*Compose\s*<\/a>/.test(hero), true, "Compose is a link, in the hero");
  assertEquals(/\?route=/.test(hero), false, "the hero does not link to a forced route");
});

Deno.test("a deep link that names a session skips the landing: the page knows every route the module does", () => {
  const listed = HTML.match(/\[((?:'[a-z]+',?\s*)+)\]\.includes\(params\.get\('route'\)\)/);
  if (!listed) throw new Error("index.html has no list of session routes");
  const inPage = [...listed[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
  const inModule = ROUTES.map((r) => r.id).sort();
  assertEquals(inPage, inModule);
});
