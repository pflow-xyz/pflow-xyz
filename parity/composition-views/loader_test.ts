// loader_test.ts — how the composition page starts (public/compose/loader.js), driven with fakes for
// everything the browser does, on the page's real store (state.js: the hash, the actions, the
// subscriptions).
//
//  - Until the registry is ready nothing renders and no view module is evaluated; hash changes, tabs
//    and keys only move the selection, and when the registry is ready the LAST selection is what is
//    drawn, once. (Without the gate, a hashchange during the wasm load threw a TypeError in render().)
//  - The view is evaluated after the ontology facts are loaded (a view reads them when its module is
//    evaluated), the shell stops repainting once the registry is ready, and a failed registry leaves
//    the page still.
//  - Only the first view's module is fetched at once, at the browser's priority. A selection made while
//    loading fetches its view (low priority) only once it holds still, so pressing 1..9 in a burst fetches
//    the last view, not nine modules (231 KB) in front of the wasm.
//  - A view module that fails, or has no default export, is a broken view that says why, never undefined.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { VIEW_IDS, VIEW_META } from "../../public/compose/views-meta.js";
import { actions, readHash, state, subscribe } from "../../public/compose/state.js";
import { brokenView, createStartup, createViewLoader, keyView } from "../../public/compose/loader.js";

const G = globalThis as any;
G.location = { hash: "" };
G.history = { replaceState(_a: unknown, _b: unknown, h: string) { G.location.hash = h; } };

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY = 40; // preloadDelay of the rig, ms
const key = (k: string, inField = false) => ({ key: k, target: { closest: () => (inField ? {} : null) } });
const [COSPAN, SPIDERS, OPERAD, , , , LENS, , , LAWS] = VIEW_IDS;

/** A start-up whose effects log what they were asked to do; `release` lets the registry finish, `fail` makes it fail. */
function rig({ holdView = false } = {}) {
  const log: string[] = [];
  const offs: Array<() => void> = [];
  let release!: () => void, fail!: (e: Error) => void, releaseView!: () => void;
  const gate = new Promise<void>((res, rej) => { release = res; fail = rej; });
  const viewGate = new Promise<void>((res) => { releaseView = res; });
  const startup = createStartup({
    state, actions, readHash, viewIds: VIEW_IDS,
    subscribe: (fn: () => void) => { const off = subscribe(fn); offs.push(off); return off; },
    initRegistry: () => { log.push("init"); return gate; },
    loadFacts: () => { log.push("facts"); },
    start: () => { log.push("start"); },
    loadView: (id: string) => { log.push(`loadView:${id}`); return holdView ? viewGate.then(() => ({ id })) : Promise.resolve({ id }); },
    preloadView: (id: string, priority: string) => { log.push(`preload:${id}:${priority}`); },
    fetchAlongside: () => { log.push("alongside"); return Promise.resolve(); },
    renderShell: () => { log.push("shell"); },
    render: () => { log.push(`render:${state.view}:${state.example}`); },
    failed: (e: Error) => { log.push(`failed:${e.message}`); },
    mark: (n: string) => { log.push(`mark:${n}`); },
    preloadDelay: DELAY,
    ready: () => { log.push("ready"); },
  });
  return { log, startup, release, fail, releaseView, cleanup: () => offs.forEach((f) => f()) };
}
const count = (log: string[], prefix: string) => log.filter((l) => l === prefix || l.startsWith(`${prefix}:`)).length;

function reset(hash: string) {
  state.view = "cospan"; state.example = "orders";
  G.location.hash = hash;
  readHash();
}

Deno.test("start-up: nothing renders before the registry is ready, the last event wins, the view is evaluated after the facts", async () => {
  reset("#view=cospan&ex=orders");
  const r = rig();
  const done = r.startup.run();
  await tick();
  assertEquals(r.log.slice(0, 3), ["shell", "preload:cospan:auto", "mark:compose:shell"]);

  // during the wasm load: a hash change, two keys, another hash change, a key, a key in a text field
  G.location.hash = "#view=lens&ex=orders"; r.startup.onHashChange(); await tick();
  r.startup.onKey(key("7")); await tick();           // lens
  r.startup.onKey(key("0")); await tick();           // laws
  G.location.hash = "#view=spiders&ex=connect4"; r.startup.onHashChange(); await tick();
  r.startup.onKey(key("3")); await tick();           // operad
  r.startup.onKey(key("5", true)); await tick();     // typing in a field is not a command
  assertEquals([state.view, state.example], [OPERAD, "connect4"]);
  assertEquals(r.startup.phase(), "loading");
  assertEquals(count(r.log, "render"), 0, `rendered before the registry was ready: ${r.log}`);
  assertEquals(count(r.log, "loadView"), 0, `a view was evaluated before the registry was ready: ${r.log}`);
  assert(count(r.log, "shell") >= 5, "each event repaints the shell");
  // a burst fetches nothing yet; when it has held still, the last view, at low priority: not lens, laws, spiders too
  assertEquals(r.log.filter((l) => l.startsWith("preload:")), [`preload:${COSPAN}:auto`]);
  await sleep(DELAY * 3);
  assertEquals(r.log.filter((l) => l.startsWith("preload:")), [`preload:${COSPAN}:auto`, `preload:${OPERAD}:low`]);
  // a selection that holds still is fetched; one that is replaced at once, and one pending when the registry is ready, are not
  r.startup.onKey(key("2")); await sleep(DELAY * 3);
  assertEquals(r.log.filter((l) => l.startsWith("preload:")).at(-1), `preload:${SPIDERS}:low`);
  r.startup.onKey(key("6")); await tick(); r.startup.onKey(key("3")); await tick();
  const fetched = r.log.filter((l) => l.startsWith("preload:")).length;
  assertEquals([state.view, state.example], [OPERAD, "connect4"]);

  r.release();
  assertEquals(await done, true);
  const i = (l: string) => r.log.indexOf(l);
  assert(i("init") < i("facts") && i("facts") < i("start") && i("start") < i(`loadView:${OPERAD}`), `order: ${r.log}`);
  assert(i(`loadView:${OPERAD}`) < i("ready") && i("ready") < i(`render:${OPERAD}:connect4`), `order: ${r.log}`);
  assertEquals(count(r.log, "render"), 1, "the last selection is drawn once");
  assertEquals(count(r.log, "loadView"), 1, "only the view being shown is evaluated");
  assertEquals(r.startup.phase(), "ready");
  await sleep(DELAY * 3);
  assertEquals(r.log.filter((l) => l.startsWith("preload:")).length, fetched, "a fetch that was waiting when the registry became ready must not fire after it");

  // after that: the shell is gone, every change renders, and a hash change renders
  const shells = count(r.log, "shell");
  actions.setView(VIEW_IDS[4]); await tick();
  assertEquals(count(r.log, "shell"), shells, "the loading shell must stop repainting once the registry is ready");
  assertEquals(r.log.filter((l) => l.startsWith("render:")).at(-1), `render:${VIEW_IDS[4]}:connect4`);
  G.location.hash = `#view=${VIEW_IDS[5]}&ex=orders`; r.startup.onHashChange();
  assertEquals(r.log.at(-1), `render:${VIEW_IDS[5]}:orders`);
  r.startup.onKey(key("1")); await tick();
  assertEquals(r.log.filter((l) => l.startsWith("render:")).at(-1), `render:${COSPAN}:orders`);
  assertEquals(count(r.log, "shell"), shells);
  r.cleanup();
});

Deno.test("start-up: a selection made after the registry is ready, while the view is being evaluated, is the one drawn", async () => {
  reset("#view=cospan&ex=orders");
  const r = rig({ holdView: true });
  const done = r.startup.run();
  await tick();
  r.release();
  await tick();
  assertEquals(count(r.log, "loadView"), 1);
  assertEquals(count(r.log, "render"), 0);
  // the registry is ready, the shown view's module is still arriving: the user moves on
  actions.setView(SPIDERS); r.startup.onKey(key("3")); await tick();
  assertEquals(count(r.log, "render"), 0, "nothing renders until the first view is evaluated");
  r.releaseView();
  assertEquals(await done, true);
  assertEquals(r.log.filter((l) => l.startsWith("render:")), [`render:${OPERAD}:orders`]);
  r.cleanup();
});

Deno.test("start-up: a registry that fails leaves the page still", async () => {
  reset(`#view=${LENS}&ex=orders`);
  const r = rig();
  const done = r.startup.run();
  await tick();
  actions.setView(SPIDERS); await tick(); // a fetch is waiting for the selection to hold still...
  r.fail(new Error("no wasm"));           // ...when the registry fails
  assertEquals(await done, false);
  assertEquals(r.startup.phase(), "failed");
  assert(r.log.includes("failed:no wasm"));
  assert(!r.log.includes("facts") && !r.log.includes("start") && count(r.log, "loadView") === 0);
  const n = r.log.length;
  // nothing a tab, a key or a link does changes the page: no shell, no render, no fetch
  actions.setView(OPERAD); await tick();
  r.startup.onKey(key("5")); r.startup.onKey(key("e")); await tick();
  G.location.hash = `#view=${COSPAN}`; r.startup.onHashChange(); await tick();
  await sleep(DELAY * 3);
  assertEquals(r.log.slice(n), [], "something happened after the registry failed");
  assertEquals(state.example, "orders", "the e key must not move the example of a page that cannot show it");
  r.cleanup();
});

Deno.test("keyView: 1..9 and 0, nothing else", () => {
  assertEquals(VIEW_IDS.length, 10);
  for (let i = 1; i <= 9; i++) assertEquals(keyView(String(i), VIEW_IDS), VIEW_IDS[i - 1]);
  assertEquals(keyView("0", VIEW_IDS), VIEW_IDS[9]);
  for (const k of ["e", "Enter", "", " ", "1.5", "-1", "10", "ArrowLeft"]) assertEquals(keyView(k, VIEW_IDS), null, k);
});

Deno.test("view loader: a module is imported once, and what cannot be used is a broken view that says why", async () => {
  const calls: string[] = [];
  const good = { id: COSPAN, render() {} };
  const mods: Record<string, unknown> = { [COSPAN]: { default: good }, [SPIDERS]: {}, [OPERAD]: { default: null }, [LENS]: undefined };
  const loader = createViewLoader({
    meta: VIEW_META,
    importModule: (id: string) => {
      calls.push(id);
      if (id === LAWS) return Promise.reject(new TypeError("Failed to fetch dynamically imported module"));
      if (id === VIEW_IDS[3]) throw new Error("synchronous");
      return Promise.resolve(mods[id]);
    },
  });
  assert((await loader.load(COSPAN)) === good);
  assert(loader.views.get(COSPAN) === good);

  // two asks while it is in flight are one import, and the same view
  const [a, b] = await Promise.all([loader.load(SPIDERS), loader.load(SPIDERS)]);
  assert(a === b);
  assertEquals(calls.filter((c) => c === SPIDERS).length, 1);
  await loader.load(SPIDERS);
  assertEquals(calls.filter((c) => c === SPIDERS).length, 1, "a loaded view is not imported again");

  // no default export (missing, null, or the module itself missing): a view, with a render, a title and a reason
  for (const id of [SPIDERS, OPERAD, LENS]) {
    const v = await loader.load(id);
    assert(v && typeof v.render === "function", `${id}: not a view`);
    assert(String(v.broken).includes("no default export"), `${id}: ${v.broken}`);
    assertEquals([v.id, v.title, v.short], [id, VIEW_META[id as keyof typeof VIEW_META].title, VIEW_META[id as keyof typeof VIEW_META].short]);
    assert(v.convention.summary.startsWith(`View ${id} failed to load`));
    // what render() waits on: once loaded, the map has a view, not undefined (an undefined entry made render() retry for ever)
    assert(loader.views.get(id) === v, `${id}: views.get is ${loader.views.get(id)}`);
  }

  // the stage says it (a broken view drew nothing, and the side card is out of the way): ctx.note with level warn
  {
    const v = await loader.load(OPERAD);
    const notes: Array<[string, string]> = [];
    v.render({ note: (text: string, level: string) => notes.push([text, level]) });
    assertEquals(notes, [["The Operad view failed to load: its module has no default export.", "warn"]]);
  }

  // a failed import, and an import that throws at once
  for (const [id, why] of [[LAWS, "Failed to fetch"], [VIEW_IDS[3], "synchronous"]]) {
    const v = await loader.load(id);
    assert(String(v.broken).includes(why), `${id}: ${v.broken}`);
    assert(loader.views.get(id) === v);
  }

  // the render loop of app.js, in miniature: it ends for every kind of module
  for (const id of [SPIDERS, OPERAD, LENS, LAWS, VIEW_IDS[3], COSPAN]) {
    const fresh = createViewLoader({ meta: VIEW_META, importModule: (i: string) => (i === LAWS ? Promise.reject(new Error("x")) : Promise.resolve(mods[i])) });
    let renders = 0;
    const render = () => {
      if (++renders > 20) throw new Error(`render() for ${id} did not end`);
      if (!fresh.views.get(id)) fresh.load(id).then(render);
    };
    render();
    await tick();
    assert(renders <= 2, `${id}: ${renders} renders`);
  }
  assertEquals(brokenView("x", { title: "T", short: "S" }, new Error("boom")).broken, "Error: boom");
});
