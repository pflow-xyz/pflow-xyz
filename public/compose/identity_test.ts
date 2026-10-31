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

// ---- the panel's render path, on a minimal fake DOM (no browser is involved) ----

class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  className = "";
  hidden = false;
  _text = "";
  constructor(public tag: string) {}
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener() {}
  appendChild(c: FakeNode) { this.children.push(c); return c; }
  replaceChildren(...c: FakeNode[]) { this.children = c; }
  set textContent(t: string) { this._text = t; this.children = []; }
  get textContent(): string { return this._text + this.children.map((c) => c.textContent).join(""); }
  find(pred: (n: FakeNode) => boolean): FakeNode[] {
    return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.find(pred))];
  }
}
// deno-lint-ignore no-explicit-any
(globalThis as any).document = {
  createElement: (t: string) => new FakeNode(t),
  createElementNS: (_: string, t: string) => new FakeNode(t),
  createTextNode: (s: string) => { const n = new FakeNode("#text"); n._text = s; return n; },
};

import { showModel } from "./identity.js";
import { identify } from "../model-cid.mjs";

Deno.test("the panel shows a composition, its parts as editor links, and verifies the CID", async () => {
  const doc = await fixture("compose-handoff.jsonld");
  const cid = (await identify(doc)).cid;
  const box = new FakeNode("section");
  // deno-lint-ignore no-explicit-any
  await showModel(box as any, cid, { fetchModel: async () => doc, verify: identify });
  const text = box.textContent;
  for (const want of ["composition", "handoff", "2 parts, 1 links", "event maker:Handoff → taker:Take", "✓ The CID recomputes in this browser"]) {
    if (!text.includes(want)) throw new Error(`panel lacks ${JSON.stringify(want)}:\n${text}`);
  }
  const hrefs = box.find((n) => n.tag === "a").map((n) => n.attrs.href);
  assertEquals(hrefs, doc.subnets.map((s: { cid: string }) => `/?cid=${s.cid}`));
  const img = box.find((n) => n.tag === "img")[0];
  assertEquals(img.attrs.src, `/img/${cid}.svg`);
});

Deno.test("the panel says when the stored object does not match its CID", async () => {
  const doc = await fixture("compose-handoff.jsonld");
  const box = new FakeNode("section");
  // deno-lint-ignore no-explicit-any
  await showModel(box as any, "z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8", { fetchModel: async () => doc, verify: identify });
  if (!box.textContent.includes("✗ This browser computes")) throw new Error(box.textContent);
});

Deno.test("the panel names a missing object instead of failing", async () => {
  const box = new FakeNode("section");
  // deno-lint-ignore no-explicit-any
  const out = await showModel(box as any, "zNope", { fetchModel: async () => { throw new Error("No object zNope in the store."); } });
  assertEquals(out, null);
  if (!box.textContent.includes("No object zNope in the store.")) throw new Error(box.textContent);
});

Deno.test("a bare wrapper is reported as the net it is", async () => {
  const doc = await fixture("wrap-coffee-shop.jsonld");
  const box = new FakeNode("section");
  // deno-lint-ignore no-explicit-any
  await showModel(box as any, (await identify(doc)).sealed, { fetchModel: async () => doc, verify: identify });
  if (!box.textContent.includes("a bare wrapper")) throw new Error(box.textContent);
});

Deno.test("a composition with no links draws no empty list and no null child", async () => {
  const doc = { ...(await fixture("compose-handoff.jsonld")), links: [] };
  const box = new FakeNode("section");
  // deno-lint-ignore no-explicit-any
  await showModel(box as any, "zNoLinks", { fetchModel: async () => doc, verify: identify, announce: () => {} });
  for (const c of box.children) if (c === null) throw new Error("the panel has a null child");
  // replaceChildren(null) would write the text "null"; only the lists of parts may remain.
  assertEquals(box.find((n) => n.tag === "ul").length, 1, "the parts' list only");
  if (box.textContent.includes("null")) throw new Error(box.textContent);
  if (!box.textContent.includes("0 links")) throw new Error(box.textContent);
});

// Each failure the panel can show is also spoken through the page's live region.
Deno.test("the panel's failures go to the live region; a good CID says nothing", async () => {
  const said: string[] = [];
  const announce = (t: string) => said.push(t);
  const doc = await fixture("compose-handoff.jsonld");
  const box = () => new FakeNode("section") as any; // deno-lint-ignore no-explicit-any

  await showModel(box(), "zNope", { announce, fetchModel: async () => { throw new Error("No object zNope in the store."); } });
  assertEquals(said, ["Model panel: No object zNope in the store."]);

  said.length = 0;
  await showModel(box(), "z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8", { announce, fetchModel: async () => doc, verify: identify });
  assertEquals(said.length, 1);
  if (!said[0].startsWith("Model panel: ✗ This browser computes")) throw new Error(said[0]);

  said.length = 0;
  await showModel(box(), "zAny", { announce, fetchModel: async () => doc, verify: async () => { throw new Error("no jsonld"); } });
  assertEquals(said, ["Model panel: Could not check the CID here: no jsonld"]);

  said.length = 0;
  await showModel(box(), (await identify(doc)).cid, { announce, fetchModel: async () => doc, verify: identify });
  assertEquals(said, []);
});

// ---- ?cid= beside the page's start-up (loader.js) ----

import { createStartup } from "./loader.js";
import { startModelPanel } from "./identity.js";
import { actions, readHash, state, subscribe } from "./state.js";
import { VIEW_IDS } from "./views-meta.js";

// deno-lint-ignore no-explicit-any
const G = globalThis as any;
G.location = { hash: "", search: "" };
G.history = { replaceState(_a: unknown, _b: unknown, h: string) { G.location.hash = h; } };

function startupRig() {
  const log: string[] = [];
  let release!: () => void, fail!: (e: Error) => void;
  const gate = new Promise<void>((res, rej) => { release = res; fail = rej; });
  const startup = createStartup({
    state, actions, readHash, subscribe, viewIds: VIEW_IDS,
    initRegistry: () => gate,
    loadFacts: () => log.push("facts"), start: () => log.push("start"),
    loadView: async () => { log.push("view"); }, preloadView: () => {}, fetchAlongside: async () => {},
    renderShell: () => {}, render: () => log.push("render"), ready: () => {},
    failed: () => log.push("failed"), mark: () => {},
  });
  return { startup, log, release: () => release(), fail: (e: Error) => fail(e) };
}

Deno.test("?cid=: the panel fills while the registry loads, and draws no view by itself", async () => {
  const { startup, log, release } = startupRig();
  const running = startup.run();
  const box = new FakeNode("section");
  box.hidden = true;
  const doc = await fixture("compose-handoff.jsonld");
  // deno-lint-ignore no-explicit-any
  const panel = startModelPanel(box as any, { search: `?cid=${(await identify(doc)).cid}` } as Location, { fetchModel: async () => doc, verify: identify, announce: () => {} });
  await panel;
  assertEquals([box.hidden, startup.phase(), log], [false, "loading", []], "the panel is done before the registry is");
  if (!box.textContent.includes("✓ The CID recomputes")) throw new Error(box.textContent);
  release();
  assertEquals(await running, true);
  assertEquals(log, ["facts", "start", "view", "render"]);
  if (!box.textContent.includes("handoff")) throw new Error("the first render replaced the panel");
});

Deno.test("?cid=: a registry that fails leaves the panel standing; no cid, no panel", async () => {
  const { startup, log, fail } = startupRig();
  const running = startup.run();
  const box = new FakeNode("section");
  box.hidden = true;
  const doc = await fixture("compose-handoff.jsonld");
  // deno-lint-ignore no-explicit-any
  const panel = startModelPanel(box as any, { search: `?cid=${(await identify(doc)).cid}` } as Location, { fetchModel: async () => doc, verify: identify, announce: () => {} });
  fail(new Error("the wasm did not load"));
  assertEquals(await running, false);
  assertEquals(log, ["failed"]);
  await panel;
  if (!box.textContent.includes("✓ The CID recomputes")) throw new Error(box.textContent);

  const untouched = new FakeNode("section");
  untouched.hidden = true;
  // deno-lint-ignore no-explicit-any
  assertEquals(startModelPanel(untouched as any, { search: "" } as Location), null);
  assertEquals(untouched.hidden, true);
});
