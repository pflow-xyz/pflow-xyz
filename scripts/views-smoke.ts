// Browser check of the composition page's view registry and links (public/compose/VIEWS.md).
//
//   deno run -A scripts/views-smoke.ts http://127.0.0.1:8080/compose.html [--chrome /path/to/chrome]
//
// In headless Chrome, with nothing but what a visitor has (the URL, clicks, keys):
//
//   - every view's permalink, on each example, opens that view and it draws, with no console problem;
//   - tabs, number keys, [ and ], V, the index and its links, back and forward;
//   - link state: instances, links and a plan in a URL open on the registry and round-trip through a
//     reload; what the registry refuses is said and not drawn;
//   - the copy buttons hand the Clipboard API the real link, and say so when the browser refuses;
//   - then the same page with two views ADDED BY THE REGISTRY ALONE (views-meta.js is rewritten in
//     flight, and the two files are served in flight; no other file changes): a module and a stored
//     file get a tab, a permalink, a place in the index, and are reachable though they have no number.
//
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure.

// deno-lint-ignore-file no-explicit-any
import { Page, sleep, startChrome } from "./cdp.ts";
import { VIEWS } from "../public/compose/views-meta.js";

const args = Deno.args;
const url = args.find((a) => a.startsWith("http"));
if (!url) {
  console.error("usage: deno run -A scripts/views-smoke.ts <url of compose.html> [--chrome path]");
  Deno.exit(2);
}
const chromeArg = args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/usr/bin/google-chrome";
const { newPage, stop } = await startChrome(CHROME, "views-smoke-");

let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};

const EXAMPLES = ["orders", "connect4"];
const READY = `document.body.dataset.ready === '1'`;
const SHOWN = `document.body.dataset.view`;
const STAGE = `document.querySelector('#stage').textContent.length + document.querySelector('#stage').querySelectorAll('svg,img,table').length`;
const shownIs = (p: Page, view: string) => p.waitFor(`${SHOWN} === ${JSON.stringify(view)}`, 15000);

async function open(hash: string, intercept?: (p: Page) => Promise<void>): Promise<Page> {
  const p = await newPage(1280, 900);
  if (intercept) await intercept(p);
  await p.goto(`${url}${hash}`);
  ok(await p.waitFor(READY, 45000), `the page is ready at ${hash}`, p.problems.join(" | "));
  return p;
}
const hashIs = (p: Page) => p.eval(`location.hash`);
const params = (h: string) => Object.fromEntries(new URLSearchParams(h.replace(/^#/, "")));

try {
  console.log(`views smoke: ${url}`);

  console.log("every permalink opens its view, and the view draws");
  for (const { id } of VIEWS) {
    for (const ex of EXAMPLES) {
      const p = await open(`#view=${id}&ex=${ex}`);
      ok((await p.eval(SHOWN)) === id, `#view=${id}&ex=${ex} shows ${id}`, await p.eval(SHOWN));
      ok((await p.eval(`document.body.dataset.example`)) === ex, `#view=${id}&ex=${ex} is on ${ex}`);
      ok((await p.eval(`document.querySelector('#tab-${id}').getAttribute('aria-selected')`)) === "true", `${id}: its tab is selected`);
      ok((await p.eval(STAGE)) > 0, `${id}/${ex}: the stage has a drawing`);
      ok(!(await p.eval(`/render failed|failed to load/.test(document.querySelector('#stage').textContent)`)), `${id}/${ex}: it drew`, (await p.eval(`document.querySelector('#stage').textContent`)).slice(0, 200));
      ok(params(await p.eval(`document.querySelector('#view-link').value.split('#')[1]`)).view === id, `${id}/${ex}: the link bar names it`);
      ok(p.problems.length === 0, `${id}/${ex}: no console problems`, p.problems.join(" | "));
      await p.close();
    }
  }

  console.log("tabs, keys and history");
  {
    const p = await open("");
    ok((await p.eval(`document.querySelectorAll('#tabs .tab').length`)) === VIEWS.length + 1, "one tab per view, and the index");
    for (let i = 0; i < Math.min(VIEWS.length, 10); i++) {
      await p.press(i === 9 ? "0" : String(i + 1));
      ok(await shownIs(p, VIEWS[i].id), `key ${i === 9 ? 0 : i + 1} opens ${VIEWS[i].id}`);
    }
    const n = VIEWS.length;
    await p.press("1"); await shownIs(p, VIEWS[0].id);
    await p.press("]");
    ok(await shownIs(p, VIEWS[1].id), "] goes to the next view");
    await p.press("[");
    await p.press("[");
    ok(await shownIs(p, VIEWS[n - 1].id), "[ wraps to the last view");
    await p.press("v");
    ok(await shownIs(p, "index"), "V opens the index");
    await p.eval(`document.querySelector('#view-index').click()`);
    ok((await hashIs(p)).includes("view=index"), "the index has a link");
    // history: every place visited comes back, in order
    const before = await p.eval(`history.length`);
    await p.press("1"); await shownIs(p, VIEWS[0].id);
    await p.press("3"); await shownIs(p, VIEWS[2].id);
    await p.press("e"); await p.waitFor(`document.body.dataset.example === 'connect4'`, 5000);
    ok((await p.eval(`history.length`)) === before + 3, "each choice is a history entry", `${before} -> ${await p.eval(`history.length`)}`);
    await p.eval(`history.back()`);
    ok(await p.waitFor(`document.body.dataset.example === 'orders'`, 5000), "back undoes the example");
    await p.eval(`history.back()`);
    ok(await shownIs(p, VIEWS[0].id), "back again returns to the view before");
    await p.eval(`history.forward()`);
    ok(await shownIs(p, VIEWS[2].id), "forward goes forward");
    ok(p.problems.length === 0, "no console problems", p.problems.join(" | "));
    await p.close();
  }

  console.log("the index");
  {
    const p = await open("#view=index&ex=orders");
    ok(await p.waitFor(`document.querySelectorAll('.view-index tbody tr').length === ${VIEWS.length}`, 5000), "a row per view");
    ok(await p.waitFor(`![...document.querySelectorAll('.view-index tbody th p')].some((n) => n.textContent === 'Loading…')`, 30000), "all the views' own words arrive");
    const row = (id: string) => `document.querySelector('#index-${id}')`;
    for (const { id } of VIEWS) {
      ok(await p.eval(`[...${row(id)}.querySelectorAll('.links a')].map((a) => a.getAttribute('href')).join(' ') === '#view=${id}&ex=orders #view=${id}&ex=connect4'`), `${id}: links on both examples`, await p.eval(`[...${row(id)}.querySelectorAll('.links a')].map((a) => a.getAttribute('href')).join(' ')`));
      ok(await p.eval(`${row(id)}.querySelectorAll('.reads code').length > 0`), `${id}: what it reads`);
      ok(await p.eval(`/Judgment and caveats/.test(${row(id)}.querySelector('.prov').textContent)`), `${id}: its judgment is marked`);
      ok(await p.eval(`/Sources/.test(${row(id)}.querySelector('.prov').textContent)`), `${id}: its sources`);
    }
    await p.eval(`document.querySelector('#index-lens .links a').click()`);
    ok(await shownIs(p, "lens"), "an index link opens its view");
    await p.eval(`history.back()`);
    ok(await shownIs(p, "index"), "and back returns to the index");
    ok(p.problems.length === 0, "no console problems", p.problems.join(" | "));
    await p.close();
  }

  console.log("link state");
  {
    const p = await open("#view=flat&ex=orders");
    ok(!(await hashIs(p)).match(/inst=|links=|plan=/), "the default composition adds nothing to the link", await hashIs(p));
    // Add an instance by the page's own control; the link says so; reload opens it.
    await p.eval(`[...document.querySelectorAll('#toolbar .chip')].find((b) => b.textContent.includes('payment2')).click()`);
    ok(await p.waitFor(`location.hash.includes('inst=orders,workers,payment,payment2')`, 3000), "an added instance is in the link", await hashIs(p));
    await p.eval(`document.querySelector('#composition button.x').click()`);
    ok(await p.waitFor(`location.hash.includes('links=')`, 3000), "a removed link changes the link", await hashIs(p));
    const hash = await hashIs(p);
    const state = `JSON.stringify([__pv.state.orders.instances, __pv.state.orders.links.map((l) => l.key)])`;
    const was = await p.eval(state);
    await p.eval(`location.reload()`);
    await sleep(500);
    ok(await p.waitFor(READY, 45000), "reload");
    ok((await p.eval(state)) === was, "a reload opens the same composition", `${await p.eval(state)} vs ${was}`);
    ok((await hashIs(p)) === hash, "and the link does not move", await hashIs(p));
    // Back through the edits to the default composition, which is opened again by the registry.
    await p.eval(`history.back()`);
    ok(await p.waitFor(`!location.hash.includes('links=')`, 3000), "back undoes the edit", await hashIs(p));
    ok(await p.waitFor(`__pv.state.orders.links.length === 3`, 3000), "and the registry holds the composition before it", await p.eval(state));
    // A fresh page with links:
    await p.close();
    const q = await open(`${hash.replace("view=flat", "view=string")}`);
    ok((await q.eval(state)) === was, "a link opens its composition in a new page", await q.eval(state));
    ok((await q.eval(SHOWN)) === "string", "on the view it names");
    ok(q.problems.length === 0, "no console problems", q.problems.join(" | "));
    await q.close();
  }
  {
    // no links at all is a composition a link can name
    const p = await open("#view=cospan&ex=orders&links=");
    ok((await p.eval(`__pv.state.orders.links.length`)) === 0, "links= opens no links");
    ok((await hashIs(p)).includes("links="), "and stays in the link", await hashIs(p));
    await p.close();
  }
  {
    // a plan the page reached by its own edit round-trips
    const p = await open("#view=lens&ex=connect4");
    await p.eval(`__pv.actions.setMode('play')`);
    ok(await p.waitFor(`location.hash.includes('plan=')`, 3000), "an edited plan is in the link", await hashIs(p));
    const hash = await hashIs(p);
    await p.close();
    const q = await open(hash);
    ok((await q.eval(`__pv.state.plan.plan.mode`)) === "play", "the link opens that plan");
    ok((await hashIs(q)) === hash, "and the link does not move", await hashIs(q));
    await q.close();
  }
  for (const [what, hash, word] of [
    ["an unknown instance", "#view=flat&ex=orders&inst=orders,nope", "no instance"],
    ["a port no net has", "#view=flat&ex=orders&links=event~orders:nope~workers:acquire", "no port"],
    ["a link naming a missing instance", "#view=flat&ex=orders&inst=orders,workers", "not in the composition"],
    ["text that is not links", "#view=flat&ex=orders&links=hello", "not kind~from~to"],
    ["a plan pflow-rs refuses", "#view=lens&ex=connect4&plan=eyJvcmRlciI6WyJub3BlIl19", "unknown order piece"],
    ["text that is not a plan", "#view=lens&ex=connect4&plan=!!!", "plan was not opened"],
  ] as const) {
    const p = await open(hash);
    const warn = await p.eval(`document.querySelector('#view-link-warning').textContent`);
    ok(warn.includes(word), `${what}: the page says what the registry said`, warn);
    ok(!(await p.eval(`document.querySelector('#view-link-warning').hidden`)), `${what}: visibly`);
    ok((await p.eval(`__pv.state.orders.links.length`)) === 3, `${what}: and draws the default composition`);
    ok(!/inst=|links=|plan=/.test(await hashIs(p)), `${what}: the link says what is drawn`, await hashIs(p));
    await p.close();
  }
  {
    // an unknown view
    const p = await open("#view=nope&ex=orders");
    ok((await p.eval(SHOWN)) === "cospan", "an unknown view leaves the default");
    ok(params(await hashIs(p)).view === "cospan", "and is written back");
    // an old or informal name
    await p.eval(`location.hash = '#view=runs&ex=orders'`);
    ok(await shownIs(p, "process"), "#view=runs opens Processes");
    ok(params(await hashIs(p)).view === "process", "and is written back as its id", await hashIs(p));
    await p.close();
  }
  {
    // a view's own parameters survive, and travel in its link
    const p = await open("#view=string&ex=orders&level=transition");
    ok((await p.eval(`document.querySelector('#view-link').value`)).includes("level=transition"), "a view's own parameter is in its link");
    await p.close();
  }

  console.log("copy link");
  {
    const p = await open("#view=boundaries&ex=orders");
    // the clipboard answers only a focused page, which a headless page is not unless told so
    await p.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await p.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"], origin: new URL(url).origin });
    const b = `document.querySelector('#view-link-copy')`;
    // What the page hands the browser: headless Chrome's readText answers "" even on a page with none of this code.
    await p.eval(`(() => { const real = navigator.clipboard.writeText.bind(navigator.clipboard); window.__copied = []; navigator.clipboard.writeText = (t) => { window.__copied.push(t); return real(t); }; })()`);
    const lastCopied = () => p.eval(`window.__copied.at(-1)`);
    ok((await p.eval(`${b}.textContent`)) === "Copy link", "the button says what it does");
    ok(await p.eval(`(() => { const r = ${b}.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight; })()`), "it is on screen");
    await p.eval(`${b}.click()`);
    await sleep(200);
    ok((await p.eval(`${b}.textContent`)) === "Copied", "the button says it copied", await p.eval(`${b}.textContent`));
    const got = await lastCopied();
    ok(got === `${url}#view=boundaries&ex=orders`, "the link is what is copied", got);
    ok((await p.eval(`document.querySelector('#a11y-live').textContent`)).includes("Link copied"), "and it is announced");
    await sleep(2100);
    ok((await p.eval(`${b}.textContent`)) === "Copy link", "the button goes back");
    // an index row's button copies that row's link
    await p.press("v"); await shownIs(p, "index");
    await p.eval(`document.querySelector('#index-laws .links button').click()`);
    await sleep(200);
    const row = await lastCopied();
    ok(row === `${url}#view=laws&ex=orders`, "the index copies a row's link", row);
    // where the browser refuses, the link is left selected for the person
    await p.eval(`navigator.clipboard.writeText = () => Promise.reject(new Error('no'))`);
    await p.eval(`${b}.click()`);
    await sleep(200);
    ok(await p.eval(`document.activeElement.id === 'view-link' && document.activeElement.selectionEnd > 0`), "if copying is refused, the link is selected in its field");
    ok((await p.eval(`document.querySelector('#a11y-live').textContent`)).includes("did not allow"), "and it says so");
    await p.close();
  }

  console.log("two views added by the registry alone");
  {
    const META = await Deno.readTextFile(new URL("../public/compose/views-meta.js", import.meta.url));
    const added = `
  { id: 'smoke-module', short: 'Smoke module', title: 'A module added for this check', src: 'views/smoke-module.js', aliases: ['smoke'] },
  { id: 'smoke-image', short: 'Smoke image', title: 'A stored image added for this check', kind: 'image', src: 'views/stored/smoke.svg', alt: 'a circle', examples: ['orders'], source: 'views-smoke.ts, in flight', consumes: [], convention: { summary: 'A circle.', honesty: ['Written by the check: judgment.'] } },
];`;
    const patched = META.replace(/\n\];\n\n\/\*\* How a stored view/, `${added}\n\n/** How a stored view`);
    ok(patched !== META, "the registry's list can be extended");
    const MODULE = `export default { id: 'smoke-module', title: 'A module added for this check', short: 'Smoke module', consumes: ['bundle.state'],
      convention: { summary: 'Counts the links.', honesty: ['Written by the check.'], bib: ['baez-master'] },
      render(ctx) { ctx.root.append(ctx.el('p', { id: 'smoke-out' }, 'links: ' + ctx.orders.links.length)); } };`;
    const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18"/></svg>`;
    const serve: Record<string, [string, string]> = {
      "*compose/views-meta.js*": [patched, "text/javascript"],
      "*compose/views/smoke-module.js*": [MODULE, "text/javascript"],
      "*compose/views/stored/smoke.svg*": [SVG, "image/svg+xml"],
    };
    const intercept = async (p: Page) => {
      await p.send("Fetch.enable", { patterns: Object.keys(serve).map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
      p.onPaused = (r: any) => {
        const hit = Object.entries(serve).find(([k]) => r.request.url.includes(k.replaceAll("*", "")));
        if (hit) p.send("Fetch.fulfillRequest", { requestId: r.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: hit[1][1] }], body: btoa(hit[1][0]) }).catch(() => {});
      };
    };
    const n = VIEWS.length + 2;
    const p = await open("#view=smoke-module&ex=orders", intercept);
    ok((await p.eval(`document.querySelectorAll('#tabs .tab').length`)) === n + 1, "a tab each, generated", String(await p.eval(`document.querySelectorAll('#tabs .tab').length`)));
    ok((await p.eval(SHOWN)) === "smoke-module", "the new module's permalink opens it");
    ok((await p.eval(`document.querySelector('#smoke-out').textContent`)) === "links: 3", "it draws from the registry's data", await p.eval(`document.querySelector('#stage').textContent`));
    ok((await p.eval(`document.querySelector('#tab-smoke-module').textContent`)) === `${VIEWS.length + 1}. Smoke module`, "its tab is numbered in order");
    ok(!(await p.eval(`document.querySelector('#tab-smoke-module').hasAttribute('aria-keyshortcuts')`)), "and claims no key it does not have");
    ok((await p.eval(`document.querySelector('#convention').textContent`)).includes("Counts the links"), "its own words are in the side panel");
    await p.press("]");
    ok(await shownIs(p, "smoke-image"), "] reaches a view past the tenth");
    ok(await p.eval(`!!document.querySelector('#stage img.stored')`), "the stored image is drawn");
    ok(await p.waitFor(`document.querySelector('#stage img.stored').naturalWidth === 40`, 5000), "from its stored file");
    ok((await p.eval(`document.querySelector('#stage').textContent`)).includes("A stored file, not drawn by the registry"), "and says what it is");
    ok(params(await hashIs(p)).view === "smoke-image", "it has a link", await hashIs(p));
    await p.press("e");
    ok((await p.eval(`document.querySelector('#stage').textContent`)).includes("not the example selected") || await p.waitFor(`document.querySelector('#stage').textContent.includes('not the example selected')`, 3000), "and says when it is not about the example shown");
    await p.press("e");
    await p.press("]");
    ok(await shownIs(p, VIEWS[0].id), "] wraps to the first view");
    await p.press("v");
    await shownIs(p, "index");
    ok(await p.waitFor(`document.querySelectorAll('.view-index tbody tr').length === ${n}`, 5000), "the index lists them");
    ok(await p.eval(`document.querySelector('#index-smoke-image .links').querySelectorAll('a').length === 1`), "with links only on the examples a stored file is about");
    ok((await p.eval(`document.querySelector('#keys-views').textContent`)).includes("later views have no number"), "the key help says so");
    await p.eval(`location.hash = '#view=smoke&ex=orders'`);
    ok(await shownIs(p, "smoke-module"), "an alias from the entry opens its view");
    ok(p.problems.length === 0, "no console problems", p.problems.join(" | "));
    await p.close();
  }
} finally {
  await stop();
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
Deno.exit(failures ? 1 : 0);
