// load_budget_test.ts — what the composition page may load at start, held
// statically (docs/compose-load-budget.md has the measured side).
//
//  - The page's entry (compose.html and the static import graph of its
//    scripts) reaches no third-party host and no Pyodide: nothing from
//    cdn.jsdelivr.net or PyPI is requested until the Laws view is drawn
//    (views/laws.js -> laws-live.js, behind a dynamic import).
//  - No view module is in that static graph: app.js imports each on first use.
//  - views-meta.js (the tab labels) says what each view module says.
//  - The URL hash keeps the parameters views write into it, and a view id no
//    view has never becomes the current view.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { installDom } from "./vdom.js";
import { VIEW_IDS, VIEW_META } from "../../public/compose/views-meta.js";
import { VIEW_IDS as CTX_VIEW_IDS } from "../../public/compose/ctx.js";
import { readHash, state, writeHash } from "../../public/compose/state.js";

const PUBLIC = new URL("../../public/", import.meta.url);
const read = (u: URL) => Deno.readTextFileSync(u);
const rel = (u: URL) => u.href.slice(PUBLIC.href.length);

// Things only the Laws view's loader may name: where Pyodide and its packages come from.
const THIRD_PARTY_LOADERS = [/jsdelivr/i, /pypi/i, /pythonhosted/i, /micropip/i, /loadPyodide/, /pyodide\.(m?js|asm)/i];
const LAWS_ONLY = new Set(["compose/views/laws.js", "compose/laws-live.js"]);

/** The specifiers a module imports STATICALLY (import ... from, import "x", export ... from). */
function staticImports(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

/** The scripts and preloads a page's <head>/<body> load (not links like rel=me or canonical, which fetch nothing). */
function fetchedByHtml(html: string): { scripts: string[]; links: string[] } {
  const scripts = [...html.matchAll(/<script\b[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const links: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const relv = /\srel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? "";
    const href = /\shref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href && /\b(stylesheet|modulepreload|preload|prefetch|preconnect|dns-prefetch)\b/i.test(relv)) links.push(href);
  }
  return { scripts, links };
}

/** Every file reachable from the page by static imports, as paths under public/. */
function staticGraph(entry: URL): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (u: URL) => {
    if (seen.has(u.href)) return;
    const src = read(u);
    seen.set(u.href, src);
    for (const spec of staticImports(src)) {
      assert(spec.startsWith("./") || spec.startsWith("../"), `${rel(u)} imports ${spec}: a static import must be a relative path (no host, no bare specifier)`);
      walk(new URL(spec, u));
    }
  };
  walk(entry);
  return seen;
}

const html = read(new URL("compose.html", PUBLIC));
const { scripts, links } = fetchedByHtml(html);

Deno.test("compose.html fetches only same-origin scripts, styles and preloads", () => {
  assert(scripts.length > 0, "found no <script src> (the parse is wrong)");
  for (const u of [...scripts, ...links]) assert(!/^(https?:)?\/\//i.test(u), `compose.html loads ${u} from another host`);
  for (const u of [...scripts, ...links]) assert(!/pyodide|jsdelivr|pypi/i.test(u), `compose.html names ${u}`);
});

Deno.test("the page's stylesheet imports nothing from another host", () => {
  for (const href of links.filter((l) => l.endsWith(".css"))) {
    const css = read(new URL(href, new URL("compose.html", PUBLIC)));
    assert(!/@import\s+(url\()?\s*["']?(https?:)?\/\//i.test(css), `${href} @imports another host`);
    assert(!/url\(\s*["']?(https?:)?\/\//i.test(css), `${href} loads a resource from another host`);
  }
});

Deno.test("the page's static import graph reaches no Pyodide, no jsdelivr, no PyPI", () => {
  const entries = scripts.filter((s) => s.endsWith(".js") || s.endsWith(".mjs")).map((s) => new URL(s, new URL("compose.html", PUBLIC)));
  assert(entries.some((u) => rel(u) === "compose/app.js"), "compose.html no longer loads compose/app.js");
  const graph = new Map<string, string>();
  for (const e of entries) for (const [k, v] of staticGraph(e)) graph.set(k, v);
  const files = [...graph.keys()].map((k) => k.slice(PUBLIC.href.length));
  // the walk reached the real page, not an empty set
  for (const f of ["compose/app.js", "compose/registry.js", "petri-wasm.js", "compose/state.js", "compose/views-meta.js"]) assert(files.includes(f), `the walk never reached ${f}: ${files.join(", ")}`);
  for (const [k, src] of graph) {
    const f = k.slice(PUBLIC.href.length);
    assert(!LAWS_ONLY.has(f), `${f} is in the page's static graph: Pyodide would load at page start`);
    for (const re of THIRD_PARTY_LOADERS) assert(!re.test(src), `${f} (static graph) matches ${re}`);
    assert(!/\b(?:import|fetch)\(\s*['"`]https?:/.test(src), `${f} fetches or imports an absolute URL`);
  }
});

Deno.test("no view module is in the page's static graph (each is imported on first use)", () => {
  const app = new URL("compose/app.js", PUBLIC);
  const files = [...staticGraph(app).keys()].map((k) => k.slice(PUBLIC.href.length));
  assertEquals(files.filter((f) => f.startsWith("compose/views/")), []);
  // app.js's only dynamic import is the view module of a validated id
  const dyn = [...read(app).matchAll(/\bimport\(([^)]*)\)/g)].map((m) => m[1]);
  assertEquals(dyn, ["`./views/${id}.js`"]);
});

Deno.test("only views/laws.js reaches laws-live.js, and only laws-live.js names Pyodide's hosts", () => {
  const dir = new URL("compose/", PUBLIC);
  const all: URL[] = [];
  const walk = (d: URL) => {
    for (const e of Deno.readDirSync(d)) {
      const u = new URL(e.name + (e.isDirectory ? "/" : ""), d);
      if (e.isDirectory) { if (e.name !== "chyp") walk(u); } else if (e.name.endsWith(".js")) all.push(u);
    }
  };
  walk(dir);
  assert(all.length > 20, "found too few modules under public/compose");
  for (const u of all) {
    const f = rel(u), src = read(u);
    const importsLive = staticImports(src).some((s) => s.endsWith("laws-live.js")) || /import\([^)]*laws-live/.test(src);
    if (f !== "compose/views/laws.js") assert(!importsLive, `${f} imports laws-live.js`);
    if (!LAWS_ONLY.has(f)) for (const re of THIRD_PARTY_LOADERS) assert(!re.test(src), `${f} matches ${re}: Pyodide's hosts belong in laws-live.js`);
  }
  // the lazy boundary exists: laws.js is what reaches the loader, and the loader imports Pyodide dynamically
  assert(staticImports(read(new URL("compose/views/laws.js", PUBLIC))).includes("../laws-live.js"));
  const live = read(new URL("compose/laws-live.js", PUBLIC));
  assert(/await import\([^)]*PYODIDE_URL\)/.test(live), "laws-live.js no longer imports Pyodide dynamically, inside pyodide()");
  assert(!staticImports(live).some((s) => /^https?:/.test(s)), "laws-live.js imports Pyodide statically");
});

Deno.test("views-meta.js: the tab labels are what each view module exports", async () => {
  installDom();
  assertEquals(CTX_VIEW_IDS, VIEW_IDS);
  assertEquals(Object.keys(VIEW_META), VIEW_IDS);
  for (const id of VIEW_IDS) {
    const v = (await import(`../../public/compose/views/${id}.js`)).default;
    assertEquals(v.id, id);
    assertEquals({ title: v.title, short: v.short }, VIEW_META[id as keyof typeof VIEW_META], `views-meta.js is out of step with views/${id}.js`);
  }
});

Deno.test("laws-live: a failure is one readable line, not a traceback", async () => {
  const { explain } = await import("../../public/compose/laws-live.js");
  const tb = "Traceback (most recent call last):\n  File \"/lib/x.py\", line 1, in <module>\n    await y()\nValueError: Can't fetch metadata for 'lark'. Please check.\n";
  assertEquals(explain(new Error(tb)), "ValueError: Can't fetch metadata for 'lark'. Please check.");
  assertEquals(explain(new TypeError("Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/x.mjs")), "Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/x.mjs");
  assertEquals(explain("plain"), "plain");
  assertEquals(explain(""), "unknown error");
  assert(explain(new Error("x".repeat(1000))).length <= 240);
});

// --- the URL hash -----------------------------------------------------------------------------------

const G = globalThis as any;
G.location = { hash: "" };
G.history = { replaceState(_a: unknown, _b: unknown, h: string) { G.location.hash = h; } };
const params = (h: string) => Object.fromEntries(new URLSearchParams(h.replace(/^#/, "")));

Deno.test("hash: a view's own parameters survive read + write; the shell's win", () => {
  // level: string.js, lens: lens-orders.js, run/idle: process.js, law/rw/rule: laws.js; foo: nobody's
  G.location.hash = "#view=string&ex=connect4&level=transition&lens=assume&run=pay&idle=1&law=orderer-monoid&rw=doc_chain_bracketing&rule=r1&foo=bar";
  readHash();
  assertEquals([state.view, state.example], ["string", "connect4"]);
  state.view = "laws";
  writeHash();
  assertEquals(params(G.location.hash), {
    view: "laws", ex: "connect4", level: "transition", lens: "assume", run: "pay", idle: "1",
    law: "orderer-monoid", rw: "doc_chain_bracketing", rule: "r1", foo: "bar",
  });
});

Deno.test("hash: every view id is accepted", () => {
  for (const id of VIEW_IDS) {
    state.view = "cospan";
    G.location.hash = `#view=${id}&ex=orders`;
    readHash();
    assertEquals(state.view, id);
  }
});

Deno.test("hash: an unknown view or example changes nothing, and is written back as the real one", () => {
  state.view = "flat"; state.example = "orders";
  G.location.hash = "#view=nope&ex=chess&level=pattern";
  readHash();
  assertEquals([state.view, state.example], ["flat", "orders"]);
  writeHash();
  assertEquals(params(G.location.hash), { view: "flat", ex: "orders", level: "pattern" });
  G.location.hash = "";
  readHash(); // no hash at all
  assertEquals(state.view, "flat");
});
