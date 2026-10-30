// load_budget_test.ts — what the composition page may load at start, held
// statically (docs/compose-load-budget.md has the measured side).
//
//  - The page's entry (compose.html and the static import graph of its
//    scripts) reaches no third-party host and no Pyodide: nothing from
//    cdn.jsdelivr.net or PyPI is requested until the Laws view is drawn
//    (views/laws.js -> laws-live.js, behind a dynamic import). The html itself
//    names no other host anywhere it could fetch or run something: attributes,
//    inline scripts and styles, not only <script src> and <link>; its own
//    origin, https://pflow.xyz, is allowed.
//  - No view module is in that static graph: app.js imports each on first use.
//  - views-meta.js (the tab labels) says what each view module says.
//  - The URL hash keeps the parameters views write into it, and a view id no
//    view has never becomes the current view.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { installDom } from "./vdom.js";
import { VIEW_IDS, VIEW_META } from "../../public/compose/views-meta.js";
import { VIEW_IDS as CTX_VIEW_IDS } from "../../public/compose/ctx.js";
import { readHash, state, writeHash } from "../../public/compose/state.js";
import { CDN } from "../../public/vendor/pflow-native-wasm/cdn.js";

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

// --- what the html may name ----------------------------------------------------------------------
//
// The page's own origin is the only host compose.html may name where the browser could fetch or run
// something: in a src, href, srcset, poster, data, action or content attribute, in the body of an
// inline <script> or <style>, in a style or on* attribute. Absolute first-party URLs (canonical,
// og:image, a modulepreload) are allowed. Left alone, because the browser fetches nothing for them:
// the href of an <a> and of a <link> whose rel is only me, canonical, author, license, alternate...
// (the page links to the author's profiles), and the text of a data block (<script
// type="application/ld+json">, which may name schema.org or sameAs profiles); a data block still
// may not name Pyodide's hosts.
const FIRST_PARTY = "https://pflow.xyz";
const NO_FETCH_REL = new Set(["me", "canonical", "author", "license", "alternate", "bookmark", "help", "next", "prev", "search", "tag", "nofollow", "noopener", "noreferrer", "external"]);
const URL_ATTRS = new Set(["src", "srcset", "imagesrcset", "href", "poster", "data", "action", "formaction", "ping", "content", "background", "manifest", "codebase", "cite", "longdesc", "xlink:href"]);
const DATA_SCRIPT_TYPES = /^(application\/(ld\+)?json|text\/(plain|template)|application\/x-.*)$/i;
const ABSOLUTE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s,"'`<>)]+|(?<![:\w/.-])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s,"'`<>)]*/gi;

function isFirstParty(u: string): boolean {
  let url: URL;
  try { url = new URL(u.trim(), `${FIRST_PARTY}/`); } catch { return false; }
  if (["data:", "about:", "mailto:", "tel:"].includes(url.protocol)) return true;
  // The pinned engine (vendor/pflow-native-wasm/cdn.js): this one file, not its host.
  if (url.href === CDN.url + CDN.file) return true;
  return url.origin === FIRST_PARTY;
}

function attrsOf(src: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of src.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) out.push([m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? ""]);
  return out;
}

/** Every place the html names something outside its own origin where the browser could fetch or run it, as text. */
function externalRefs(html: string): string[] {
  const bad: string[] = [];
  const text = html.replace(/<!--[\s\S]*?-->/g, "");
  const code = (where: string, body: string) => {
    for (const m of body.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s,"'`<>)]+|["'`]\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^"'`]*/gi)) {
      const u = m[0].replace(/^["'`]/, "");
      if (!isFirstParty(u)) bad.push(`${where} names ${u}`);
    }
  };
  const loaders = (where: string, body: string) => { for (const re of THIRD_PARTY_LOADERS) if (re.test(body)) bad.push(`${where} matches ${re}`); };
  for (const m of text.matchAll(/<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g)) {
    const tag = m[1].toLowerCase(), attrs = attrsOf(m[2]);
    const rel = (attrs.find(([k]) => k === "rel")?.[1] ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    for (const [k, v] of attrs) {
      const where = `<${tag} ${k}>`;
      loaders(where, v);
      if (k.startsWith("on")) { code(where, v); continue; }
      if (k === "style") { for (const u of v.matchAll(/url\(\s*["']?([^"')]+)/gi)) if (!isFirstParty(u[1])) bad.push(`${where} loads ${u[1]}`); continue; }
      if (!URL_ATTRS.has(k) && !/^data-.*(src|href|url)$/.test(k)) continue;
      if (k === "href" && (tag === "a" || tag === "area")) continue;
      if (k === "href" && tag === "link" && rel.length && rel.every((r) => NO_FETCH_REL.has(r))) continue;
      const urls = k === "srcset" || k === "imagesrcset" ? v.split(",").map((c) => c.trim().split(/\s+/)[0]) : k === "content" ? (v.match(ABSOLUTE_URL) ?? []) : [v];
      for (const u of urls) if (u && !isFirstParty(u)) bad.push(`${where} names ${u}`);
    }
  }
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const type = attrsOf(m[1]).find(([k]) => k === "type")?.[1] ?? "";
    if (m[2].trim() === "") continue;
    loaders("an inline <script>", m[2]);
    if (!DATA_SCRIPT_TYPES.test(type)) code("an inline <script>", m[2]);
  }
  for (const m of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    loaders("an inline <style>", m[1]);
    for (const u of m[1].matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]+)|url\(\s*["']?([^"')]+)/gi)) { const x = u[1] ?? u[2]; if (!isFirstParty(x)) bad.push(`an inline <style> loads ${x}`); }
  }
  return bad;
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
const onDisk = (u: string) => new URL(u.replace(/^https:\/\/pflow\.xyz(?=\/)/, ""), new URL("compose.html", PUBLIC)); // an absolute first-party URL is a file of public/

Deno.test("compose.html fetches only same-origin scripts, styles and preloads", () => {
  assert(scripts.length > 0, "found no <script src> (the parse is wrong)");
  for (const u of [...scripts, ...links]) assert(!/pyodide|jsdelivr|pypi/i.test(u), `compose.html names ${u}`);
  assertEquals(externalRefs(html), []);
});

Deno.test("the scan of the html: first-party names pass, anything else is found (mutations of compose.html)", () => {
  // What a head may carry and still be first-party or fetch nothing.
  const ok = [
    '<link rel="canonical" href="https://pflow.xyz/compose.html">',
    '<meta property="og:image" content="https://pflow.xyz/share-card/x.png">',
    '<meta property="og:url" content="https://pflow.xyz/compose.html">',
    '<link rel="me" href="https://github.com/someone"><link rel="me author" href="https://blog.example.org/">',
    '<link rel="alternate" type="application/rss+xml" href="https://elsewhere.example/feed.xml">',
    '<link rel="modulepreload" href="https://pflow.xyz/compose/app.js"><link rel="preload" as="fetch" crossorigin href="vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm">',
    '<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","url":"https://pflow.xyz/compose.html","sameAs":["https://github.com/someone"]}</script>',
    '<a href="https://github.com/someone/repo">source</a>',
    '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\'/%3E">',
    '<script>const same = "https://pflow.xyz/x"; fetch("/api/y");</script>',
    '<img src="/a.png" srcset="/a.png 1x, https://pflow.xyz/a2.png 2x" alt="https://x.example is only text">',
    '<meta name="description" content="One composition drawn in ten conventions (wasm).">',
    '<!-- <script src="https://cdn.jsdelivr.net/x.js"></script> -->',
  ];
  for (const frag of ok) assertEquals(externalRefs(html.replace("</head>", `${frag}\n</head>`)), [], frag);

  // What must be caught: the review's three, and the other ways a third party gets in.
  const bad = [
    '<script type="module">import("https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs").then((m) => m.loadPyodide())</script>',
    '<script>(function(){var s=document.createElement("script");s.src="https://www.googletagmanager.com/gtag/js?id=G-X";document.head.appendChild(s)})()</script>',
    '<img src="https://pypi.org/x.png" alt="">',
    '<script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>',
    '<script src="//cdn.jsdelivr.net/npm/x/y.js"></script>',
    '<script>fetch("//pypi.org/simple/lark/")</script>',
    '<script type="module">const p = "loadPyodide"; </script>',
    '<script type="application/ld+json">{"@type":"WebPage","x":"cdn.jsdelivr.net/pyodide"}</script>',
    '<script type="importmap">{"imports":{"x":"https://esm.sh/x"}}</script>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=X">',
    '<link rel="preconnect" href="https://fonts.gstatic.com">',
    '<link rel="icon" href="https://cdn.example.com/f.png">',
    '<link rel="me stylesheet" href="https://cdn.example.com/s.css">',
    '<link href="https://cdn.example.com/s.css">',
    '<img srcset="/a.png 1x, https://cdn.example.com/a2.png 2x" src="/a.png" alt="">',
    '<iframe src="https://example.org/"></iframe>',
    '<video poster="https://example.org/p.jpg" src="/v.mp4"></video>',
    '<object data="https://example.org/o.swf"></object>',
    '<base href="https://example.org/">',
    '<meta http-equiv="refresh" content="0; url=https://example.org/">',
    '<meta property="og:image" content="https://example.org/x.png">',
    '<div style="background:url(https://example.org/b.png)"></div>',
    '<style>@import url("https://fonts.googleapis.com/css?family=X"); body { color: red }</style>',
    '<style>body { background: url(//example.org/b.png) }</style>',
    '<body onload="import(\'https://example.org/x.js\')">',
    '<img data-src="https://example.org/lazy.png" alt="">',
    '<script src="http://pflow.xyz/compose/app.js"></script>',
    '<script src="https://www.pflow.xyz/compose/app.js"></script>',
    '<script src="https://pflow.xyz.example.org/app.js"></script>',
  ];
  for (const frag of bad) assert(externalRefs(html.replace("</head>", `${frag}\n</head>`)).length > 0, `not found: ${frag}`);
});

Deno.test("the page's stylesheet imports nothing from another host", () => {
  for (const href of links.filter((l) => l.endsWith(".css"))) {
    const css = read(onDisk(href));
    assert(!/@import\s+(url\()?\s*["']?(https?:)?\/\//i.test(css), `${href} @imports another host`);
    assert(!/url\(\s*["']?(https?:)?\/\//i.test(css), `${href} loads a resource from another host`);
  }
});

Deno.test("the page's static import graph reaches no Pyodide, no jsdelivr, no PyPI", () => {
  const entries = scripts.filter((s) => s.endsWith(".js") || s.endsWith(".mjs")).map((s) => onDisk(s));
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
  // app.js's only dynamic import is the module a registry entry names, and an entry names a path under views/ (entryProblems)
  const dyn = [...read(app).matchAll(/\bimport\(([^)]*)\)/g)].map((m) => m[1]);
  assertEquals(dyn, ["`./${VIEW_META[id].src}`"]);
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
    const m = VIEW_META[id as keyof typeof VIEW_META];
    if (m.kind !== "module") continue;
    const v = (await import(`../../public/compose/${m.src}`)).default;
    assertEquals(v.id, id);
    assertEquals({ title: v.title, short: v.short }, { title: m.title, short: m.short }, `views-meta.js is out of step with ${m.src}`);
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

// --- the Laws view's live layout: a package that does not load is not a layout ---------------------------
//
// Pyodide's loadPackage does not throw when a wheel is blocked: it logs a warning per package and resolves.
// Without a check, Chyp falls back to topology only and the page announced "the live layout is drawn".

Deno.test("laws-live: which of the layout's packages Pyodide did not load", async () => {
  const { missingPackages, LAYOUT_PACKAGES } = await import("../../public/compose/laws-live.js");
  assertEquals(LAYOUT_PACKAGES, ["cvxpy-base", "clarabel"]);
  assertEquals(missingPackages({ numpy: "default", scipy: "default", clarabel: "default", "cvxpy-base": "default" }), []);
  assertEquals(missingPackages({ numpy: "default", scipy: "default" }), ["cvxpy-base", "clarabel"]);
  assertEquals(missingPackages({ "cvxpy-base": "default" }), ["clarabel"]);
  assertEquals(missingPackages({ clarabel: "default" }), ["cvxpy-base"]);
  assertEquals(missingPackages({ cvxpy_base: "default", Clarabel: "default" }), [], "names are compared as PEP 503 does");
  assertEquals(missingPackages(undefined), ["cvxpy-base", "clarabel"]);
  assertEquals(missingPackages({}, ["lark"]), ["lark"]);
});

Deno.test("laws-live: what the page says when the layout cannot be the live one (a pure function)", async () => {
  const { layoutProblem } = await import("../../public/compose/laws-live.js");
  const both = { "cvxpy-base": "default", clarabel: "default" };
  const chyp = (used: string, reason?: string) => ({ diagrams: { layout: { requested: "chyp", used, ...(reason ? { reason } : {}) } } });
  assertEquals(layoutProblem({ loadedPackages: both }), null);
  assertEquals(layoutProblem({ loadedPackages: both, docs: { a: chyp("chyp"), b: chyp("chyp") } }), null);
  assertEquals(layoutProblem({ loadedPackages: { numpy: "default" } }), "cvxpy-base and clarabel did not load: their files could not be fetched from cdn.jsdelivr.net");
  assertEquals(layoutProblem({ loadedPackages: { "cvxpy-base": "default" } }), "clarabel did not load: its file could not be fetched from cdn.jsdelivr.net");
  // the packages loaded but Chyp still exported topology only (could not import cvxpy)
  assertEquals(layoutProblem({ loadedPackages: both, docs: { a: chyp("chyp"), b: chyp("none", "ImportError: no cvxpy") } }), "Chyp drew no coordinates: b ImportError: no cvxpy");
  assertEquals(layoutProblem({ loadedPackages: both, docs: { a: chyp("none") } }), "Chyp drew no coordinates: a (layout used: none)");
  assertEquals(layoutProblem({ loadedPackages: both, docs: { a: {} } }), "Chyp drew no coordinates: a (layout used: unknown)");
  // a missing package is reported before any layout is looked at
  assert(layoutProblem({ loadedPackages: {}, docs: { a: chyp("none") } })!.startsWith("cvxpy-base and clarabel did not load"));
});

Deno.test("laws-live: the layout step fails, and says why, when its packages did not load or Chyp fell back", async () => {
  const { layoutOn } = await import("../../public/compose/laws-live.js");
  const docs = { "orderer-monoid": { diagrams: { layout: { used: "chyp" } } } };
  const fakePy = (loaded: Record<string, string>, exported: unknown) => {
    const ran: string[] = [];
    return {
      ran,
      loadedPackages: loaded,
      loadPackage: async (names: string[]) => { ran.push(`loadPackage ${names.join(",")}`); }, // resolves, as Pyodide does for a blocked wheel
      runPythonAsync: async () => { ran.push("run"); return JSON.stringify(exported); },
    };
  };
  const status: string[] = [];

  // a blocked wheel: loadPackage resolved, the package is not loaded: no layout is run, nothing says "drawn"
  const blocked = fakePy({ numpy: "default", scipy: "default" }, docs);
  let err: Error | null = null;
  try { await layoutOn(blocked, ["orderer-monoid"], (t: string) => status.push(t)); } catch (e) { err = e as Error; }
  assert(err, "a layout whose packages did not load must fail");
  assertEquals(err!.message, "cvxpy-base and clarabel did not load: their files could not be fetched from cdn.jsdelivr.net");
  assertEquals(blocked.ran, ["loadPackage cvxpy-base,clarabel"], "Chyp's layout must not run without its packages");
  assert(!status.some((t) => /laying the diagrams out/.test(t)));

  // everything loaded but Chyp exported topology only
  const fellBack = fakePy({ "cvxpy-base": "default", clarabel: "default" }, { "orderer-monoid": { diagrams: { layout: { used: "none", reason: "ImportError: cvxpy" } } } });
  err = null;
  try { await layoutOn(fellBack, ["orderer-monoid"]); } catch (e) { err = e as Error; }
  assertEquals(err?.message, "Chyp drew no coordinates: orderer-monoid ImportError: cvxpy");

  // the good run
  const good = fakePy({ "cvxpy-base": "default", clarabel: "default" }, docs);
  const r = await layoutOn(good, ["orderer-monoid"], (t: string) => status.push(t));
  assertEquals(r.docs, docs);
  assertEquals(good.ran, ["loadPackage cvxpy-base,clarabel", "run"]);
  assert(typeof r.layoutSeconds === "number");
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

Deno.test("hash: an old or informal name for a view opens it, and is written back as its id", () => {
  G.location.hash = "#view=wiring&ex=orders";
  readHash();
  assertEquals(state.view, "operad");
  writeHash();
  assertEquals(params(G.location.hash), { view: "operad", ex: "orders" });
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
