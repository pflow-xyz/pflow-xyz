// views_registry_test.ts — the view registry (public/compose/views-meta.js) says what is so:
//
//  - every entry is one the page can show, and no two claim the same name in a link;
//  - what each view declares it consumes is what it reads while drawing, measured over the parity
//    contract's states on both examples: the commands it issues on any engine, and what it takes
//    from the ctx (which the shell filled from those commands). Page-wide facts every view shares
//    (bundle.ontology and the like, read once by model.js) are not listed per view;
//  - a view that cannot say where it comes from is not shown (stored views too), and a stored view
//    says on the stage that it is a stored file.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { installDom } from "./vdom.js";
import { EXAMPLES, renderManifest, setup, STATES } from "./render.js";
import { engines } from "../../public/compose/registry.js";
import { entryProblems, resolveView, VIEW_KINDS, VIEW_META, viewKey, viewProblems, VIEWS } from "../../public/compose/views-meta.js";
import { createViewLoader, keyView, stepView } from "../../public/compose/loader.js";
import { storedView } from "../../public/compose/stored-view.js";
import { el } from "../../public/compose/dom.js";

const COMPOSE = new URL("../../public/compose/", import.meta.url);
const newRoot = (): any => (globalThis as any).document.createElement("div");

// Which ctx field holds what, and from which command the shell filled it (ctx.js, state.js).
const CTX_FIELDS: Record<string, Record<string, string>> = {
  orders: { subnets: "bundle.state", byId: "bundle.state", links: "bundle.state", extras: "bundle.state", instances: "bundle.state", flat: "bundle.flatten" },
  plan: { plan: "plan.state", json: "plan.state", text: "plan.state", error: "plan.state", step: "plan.state" },
  connect4: { net: "assets/connect-4.json", summary: "assets/connect-4.json" },
};

Deno.test("every registry entry is one the page can show", () => {
  for (const v of VIEWS) assertEquals(entryProblems(v), [], v.id);
  const names = VIEWS.flatMap((v) => [v.id, ...v.aliases]);
  assertEquals(new Set(names).size, names.length, "two views answer to one name in a link");
  assert(!names.includes("index"));
  for (const v of VIEWS) if (v.kind === "module") Deno.statSync(new URL(v.src, COMPOSE));
});

Deno.test("a link's view name: the id, an alias, the index; nothing else", () => {
  assertEquals(resolveView("operad"), "operad");
  assertEquals(resolveView("wiring"), "operad");
  assertEquals(resolveView("runs"), "process");
  assertEquals(resolveView("index"), "index");
  assertEquals(resolveView("nope"), null);
  assertEquals(resolveView(undefined), null);
});

Deno.test("keys: ten by number, and [ ] reach every view however many there are", () => {
  assertEquals(VIEWS.slice(0, 10).map((_, i) => viewKey(i)), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
  assertEquals(viewKey(10), null);
  const many = Array.from({ length: 25 }, (_, i) => `v${i}`);
  assertEquals(keyView("0", many), "v9");
  assertEquals(keyView("5", ["a", "b"]), null);
  const seen = new Set<string>();
  let at = many[0];
  for (let i = 0; i < many.length; i++) { seen.add(at); at = stepView("]", many, at)!; }
  assertEquals(seen.size, many.length);
  assertEquals(at, many[0]);
  assertEquals(stepView("[", many, many[0]), many[24]);
  assertEquals(stepView("]", many, "index"), many[0]);
  assertEquals(stepView("[", many, "index"), many[24]);
  assertEquals(stepView("x", many, many[0]), null);
});

Deno.test("what each view says it consumes is what it reads while drawing", async () => {
  await setup();
  let reads: Set<string> | null = null;
  for (const k of ["live", "scratch", "c4"] as const) {
    const e = (engines as any)[k], call = e.call;
    e.call = function (id: string, args: unknown) { reads?.add(id); return call.call(e, id, args); };
  }
  const watched = (group: string, target: any) => new Proxy(target, {
    get(t, f) { const c = CTX_FIELDS[group][String(f)]; if (c) reads?.add(c); return t[f]; },
  });
  for (const v of VIEWS.filter((m) => m.kind === "module")) {
    const seen = new Set<string>();
    for (const example of EXAMPLES) {
      for (const stateId of Object.keys(STATES)) {
        await renderManifest(v.id, example, stateId, {
          // from here on: reaching the state is the contract's doing, not the view's
          watch: (ctx: any) => { reads = seen; return { ...ctx, orders: watched("orders", ctx.orders), plan: watched("plan", ctx.plan), connect4: watched("connect4", ctx.connect4) }; },
        });
        reads = null;
      }
    }
    const view = (await import(new URL(v.src, COMPOSE).href)).default;
    const declared = [...view.consumes];
    const files = declared.filter((d: string) => d.startsWith("assets/"));
    for (const f of files) Deno.statSync(new URL(f, COMPOSE));
    assertEquals(
      declared.filter((d: string) => !d.startsWith("assets/chyp/")).sort(), // Laws fetches these itself, before it draws
      [...seen].sort(),
      `${v.src}: consumes is out of step with what the view reads`,
    );
  }
});

Deno.test("every module view has a summary, marked judgment and provenance", async () => {
  await setup();
  for (const v of VIEWS.filter((m) => m.kind === "module")) {
    const view = (await import(new URL(v.src, COMPOSE).href)).default;
    assertEquals(viewProblems(view), [], v.id);
    assertEquals(view.id, v.id);
  }
});

// --- stored views --------------------------------------------------------------------------------

const STORED = {
  id: "sketch", short: "Sketch", title: "A sketch", kind: "image", src: "views/stored/sketch.svg", aliases: [], parity: false,
  source: "drawn by hand, 2026-10-30",
  consumes: [],
  convention: { summary: "A sketch of a pushout.", honesty: ["Drawn by hand: judgment, not the registry's output."], bib: ["baez-master"] },
};

function ctxFor(root: any, example = "orders") {
  return { root, example, el, note(text: string, level = "honesty") { root.append(el("div", { class: `stage-note ${level}` }, text)); } };
}
const texts = (n: any): string => (n.nodeType === 3 ? n.data ?? n.textContent : (n.childNodes || []).map(texts).join(" "));

Deno.test("a stored entry needs a source, a summary, marked judgment, and a place it may be stored", () => {
  assertEquals(entryProblems(STORED), []);
  assert(entryProblems({ ...STORED, source: "" }).some((p) => p.includes("came from")));
  assert(entryProblems({ ...STORED, convention: { summary: "x" } }).some((p) => p.includes("judgment")));
  assert(entryProblems({ ...STORED, convention: { honesty: ["x"] } }).some((p) => p.includes("what it shows")));
  assert(entryProblems({ ...STORED, consumes: undefined }).some((p) => p.includes("consumes")));
  assert(entryProblems({ ...STORED, kind: "nope" }).length > 0);
  for (const src of ["https://evil.example/x.svg", "../../secret", "/etc/passwd", "http://cdn.stackdump.com/ipfs/a"]) assert(entryProblems({ ...STORED, src }).length > 0, src);
  assertEquals(entryProblems({ ...STORED, src: "https://cdn.stackdump.com/ipfs/bafy/sketch.svg" }), []);
  assert(entryProblems({ ...STORED, id: "Bad Id" }).length > 0);
  assert(entryProblems({ ...STORED, id: "index" }).length > 0);
  assert(entryProblems({ ...VIEW_META.cospan, src: "https://cdn.stackdump.com/ipfs/bafy/x.js" }).length > 0, "a module runs in the page, so it comes from this repository");
});

Deno.test("a view with something missing comes back broken, saying what", async () => {
  const modules: Record<string, unknown> = {
    nosrc: { id: "nosrc", consumes: [], convention: { summary: "s", honesty: ["h"] } },
    unmarked: { id: "unmarked", consumes: [], convention: { summary: "s", bib: ["b"] } },
    silent: { id: "silent", convention: { summary: "s", honesty: ["h"], bib: ["b"] } },
    whole: { id: "whole", consumes: [], convention: { summary: "s", honesty: ["h"], bib: ["b"] } },
  };
  const meta = (id: string) => ({ ...VIEW_META.cospan, id, src: `views/${id}.js` });
  const { load } = createViewLoader({
    meta: { bad: { ...STORED, id: "bad", source: "" }, nosrc: meta("nosrc"), unmarked: meta("unmarked"), silent: meta("silent"), whole: meta("whole") },
    entryProblems,
    problems: viewProblems,
    importModule: (id: string) => Promise.resolve({ default: modules[id] }),
  } as any);
  for (const [id, why] of [["bad", /came from/], ["nosrc", /provenance/], ["unmarked", /judgment/], ["silent", /consumes/]] as const) {
    const v = await load(id);
    assert(why.test(v.broken), `${id}: ${v.broken}`);
    let drawn = "";
    v.render({ note(t: string) { drawn = t; } });
    assert(why.test(drawn), `${id}: says so on the stage, ${drawn}`);
  }
  assertEquals((await load("whole")).broken, undefined);
});

Deno.test("each stored kind draws, and says it is a stored file", async () => {
  installDom();
  for (const kind of VIEW_KINDS.filter((k) => k !== "module")) {
    const entry = { ...STORED, kind };
    const v = storedView(entry);
    assertEquals(viewProblems(v), [], kind);
    const root = newRoot();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(kind === "json" ? '{"a":1}' : "plain words"))) as typeof fetch;
    try {
      v.render(ctxFor(root));
      await new Promise((r) => setTimeout(r, 0));
    } finally { globalThis.fetch = realFetch; }
    const all = texts(root);
    assert(all.includes("A stored file, not drawn by the registry"), `${kind}: ${all}`);
    assert(all.includes(STORED.source), `${kind}: the source is on the stage`);
    if (kind === "json") assert(all.includes('"a": 1'), all);
    if (kind === "text") assert(all.includes("plain words"), all);
  }
  const html = newRoot();
  storedView({ ...STORED, kind: "html" }).render(ctxFor(html));
  const frame = html.children.find((c: any) => c.tagName?.toLowerCase() === "iframe");
  assertEquals(frame.getAttribute("sandbox"), "allow-scripts", "what is inside cannot reach the page");
});

Deno.test("a stored file about one example says so on the other, and one that cannot be read says why", async () => {
  installDom();
  const root = newRoot();
  storedView({ ...STORED, examples: ["orders"] }).render(ctxFor(root, "connect4"));
  assert(texts(root).includes("not the example selected"));
  const r2 = newRoot();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;
  try {
    storedView({ ...STORED, kind: "text" }).render(ctxFor(r2));
    await new Promise((r) => setTimeout(r, 0));
  } finally { globalThis.fetch = realFetch; }
  assert(texts(r2).includes("Could not read the stored file: HTTP 404"), texts(r2));
});
