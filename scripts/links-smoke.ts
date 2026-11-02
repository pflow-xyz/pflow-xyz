// Browser check of linkable model views (docs/design/agent-first-analysis.md section 14 and 16.3; public/petri-link-open.js,
// public/examples.json, the example cards in public/index.html).
//
//   deno run -A scripts/links-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome]
//
// In headless Chrome: the six example cards open into their recorded views (a real click on each card, so the #view= the
// card carries must survive the navigation) and reproduce with no model call; a tampered digest says it differs, with
// both engine versions; a link that asks for an edit is refused and runs nothing (no Worker is even started, and the net
// is the one a bare ?cid= link opens); a command this app lacks is "not reproducible here" with the note and the calls
// kept; a call that fails is "partial"; a garbage, oversized, too-new or net-less link is one line and the net alone;
// /?cid= and /?data= without a hash are unchanged; Copy link makes a link that reproduces the view in a fresh page (the
// saved form, the unsaved form, "Save to get a link" and "Save and copy link"); the Share dialog, reached through the menu
// once the result's pane is closed (the pane covers the menu), offers "Share this view" for the last result shown, holds
// Copy while the view's link is made, unchecks the box when the view has no link, and always says what a CID grants; a
// /health that never answers delays nothing for long; a ?data= that does not decode is never replayed on another net; and
// editing a net opened from a link takes the #view= out of the address bar.
//
// It never signs in to GitHub and never reaches a model: /o/<cid> is answered in the page from examples/landing (the
// scratch server has none of these nets stored), /api/llm/status says the chat is off, /auth/user and /api/save are
// answered for the signed-in cases, and EVERY request to /api/llm/* that is not that status probe fails the smoke, as
// does any that reaches the network (held by the browser, not only the ones the page's own fetch shows). A link adds no
// such request to the ones a bare /?cid= makes. What is NOT covered: the Worker's own requests (the module graph and
// the engine's .wasm; the page-level hooks cannot see a worker's network), which the unit tests hold to calling no model.
//
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure; scripts/smoke-gate.sh runs it
// (SMOKES="links"). LINKS_SHOTS=<dir> saves a screenshot of each state it checks at 1280x800 and 390x844.
import { sleep, startChrome } from "./cdp.ts";
import { buildViewSpec, decodeView, encodeView, permalinkData } from "../public/petri-viewspec.js";

const url = Deno.args.find((a) => a.startsWith("http"));
if (!url) { console.error("usage: deno run -A scripts/links-smoke.ts <url of /> [--chrome path]"); Deno.exit(2); }
const chromeArg = Deno.args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? Deno.args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = Deno.env.get("LINKS_SHOTS") ?? "";
const { newPage, stop } = await startChrome(CHROME, "links-smoke-");

let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};
const same = (a: unknown, b: unknown, what: string) => ok(JSON.stringify(a) === JSON.stringify(b), what, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const q = (s: string) => JSON.stringify(s);

// ---- the examples and their nets -----------------------------------------------------------------------------------------

const read = (p: string) => Deno.readTextFile(new URL(`../${p}`, import.meta.url));
const examples: any[] = JSON.parse(await read("public/examples.json")).examples;
const nets: Record<string, any> = {};
for (const e of examples) nets[e.cid] = JSON.parse(await read(e.file));
const coffee = examples[0];
const placeIds = (m: any) => Object.keys(m.places).sort();

// A one-place-per-letter net small enough to carry in a link, and a big one that is not.
const small = () => ({ "@context": "https://pflow.xyz/schema", "@type": "PetriNet", "@version": "1.1", token: ["https://pflow.xyz/tokens/black"],
  places: { S: { "@type": "Place", initial: [20], capacity: [null], x: 60, y: 80 }, I: { "@type": "Place", initial: [2], capacity: [null], x: 200, y: 80 }, R: { "@type": "Place", initial: [0], capacity: [null], x: 340, y: 80 } },
  transitions: { infect: { "@type": "Transition", x: 130, y: 80, rate: 0.05 }, recover: { "@type": "Transition", x: 270, y: 80, rate: 0.1 } },
  arcs: [{ "@type": "Arrow", source: "S", target: "infect", weight: [1] }, { "@type": "Arrow", source: "I", target: "infect", weight: [1] }, { "@type": "Arrow", source: "infect", target: "I", weight: [2] }, { "@type": "Arrow", source: "I", target: "recover", weight: [1] }, { "@type": "Arrow", source: "recover", target: "R", weight: [1] }] });
const big = () => { const m: any = small(); for (let i = 0; i < 300; i++) m.places[`p${i}`] = { "@type": "Place", initial: [0], capacity: [null], x: i * 3, y: 200 + (i % 7) * 20 }; return m; };

const base = new URL(url);
const hrefTo = (search: string, hash = "") => new URL(`/${search}${hash}`, base).href;
const spec = (over: any = {}) => ({ ...structuredClone(coffee.spec), ...over });
const linkTo = async (s: any, cid = coffee.cid) => hrefTo(`?cid=${cid}`, `#view=${await encodeView(s)}`);

// ---- the page's hooks -----------------------------------------------------------------------------------------------------

const CLEAN = `try { localStorage.clear(); sessionStorage.clear(); } catch {}`;
// Before any script: the nets the scratch server lacks, no chat, a clipboard that keeps what it is given, a record of every
// request the page makes and every Worker it starts, and (signed in) the account the save needs.
const BEFORE = (o: { signedIn?: boolean } = {}) => `
  window.__fx = []; window.__workers = []; window.__clip = []; window.__saved = [];
  try { ${o.signedIn ? "localStorage.setItem('pflow_auth_token', 'smoke-token');" : ""} } catch {}
  const NETS = ${JSON.stringify(nets)};
  const real = window.fetch;
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (u, opts) => {
    const url = new URL(String(u?.url ?? u), location.href);
    window.__fx.push(url.pathname);
    const bearer = new Headers(opts?.headers).get('Authorization') === 'Bearer smoke-token';
    if (url.pathname === '/api/llm/status') return json({ enabled: false });
    if (url.pathname === '/auth/user') return bearer ? json({ user: { id: '1', email: '', user_name: 'smoke', full_name: 'Smoke' } }) : new Response('{}', { status: 401 });
    if (url.pathname === '/api/save' && opts?.method === 'POST') {
      if (!bearer) return json({ error: 'sign in' }, 401);
      const body = JSON.parse(opts.body); const cid = 'zSmokeSaved' + window.__saved.length;
      window.__saved.push(cid); NETS[cid] = body; return json({ cid });
    }
    const m = /^\\/o\\/(.+)$/.exec(url.pathname);
    if (m && NETS[m[1]]) return json(NETS[m[1]]);
    return real(u, opts);
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__clip.push(String(t)); } } });
  const W = window.Worker;
  window.Worker = class extends W { constructor(...a) { window.__workers.push(String(a[0])); super(...a); } };`;

// The scratch server has none of these nets stored: it 404s the decorated shell for /?cid= and the card thumbnails, which
// changes nothing the page does with them. Everything else the browser reports is a problem.
const problemsOf = (p: any) => p.problems.filter((x: string) => !/\/img\/z\w+\.svg/.test(x) && !/\/\?cid=/.test(x));

// Hold every model route at the browser: nothing may reach the network (the page's own fetch answers /api/llm/status).
async function open(href: string, o: { width?: number; height?: number; signedIn?: boolean; phone?: boolean; stallHealth?: boolean } = {}) {
  const { width = 1280, height = 800, signedIn = false, phone = false, stallHealth = false } = o;
  const p: any = await newPage(width, height);
  if (phone) {
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    await p.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  }
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: CLEAN + BEFORE({ signedIn }) });
  p.stalled = [];
  if (stallHealth) {
    // a server that takes the connection and never answers /health: those requests are held for good, the model routes as ever
    p.onPaused = (r: any) => { if (/\/health(\?|$)/.test(r.request.url)) p.stalled.push(r.requestId); else p.paused.push(r.requestId); };
    await p.hold(["*/api/llm/*", "*/health"]);
  } else await p.hold(["*/api/llm/*"]);
  await p.goto(href);
  return p;
}
const settled = (p: any, ms = 60000) => p.waitFor(`!!document.querySelector('[data-link-status]') || !!document.querySelector('[data-link-notice="info"]')`, ms);
const editorUp = (p: any) => p.waitFor(`!!document.querySelector('petri-view')?._root && !!document.querySelector('#editor-wrapper') && getComputedStyle(document.querySelector('#editor-wrapper')).display !== 'none'`, 30000);
const shot = async (p: any, name: string) => {
  if (!SHOTS) return;
  await sleep(250);
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${SHOTS}/${name}.png`, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
};

const model = (p: any) => p.eval(`JSON.stringify(document.querySelector('petri-view').getModel())`);
const viewWorkers = (p: any) => p.eval(`window.__workers.filter((w) => w.endsWith('/petri-viewspec.js')).length`);
const llm = (p: any) => p.eval(`window.__fx.filter((x) => x.startsWith('/api/llm/'))`);
// What the result pane shows.
const pane = (p: any) => p.eval(`(() => {
  const d = document.querySelector('.pv-result-dialog'); if (!d) return null;
  const s = d.querySelector('[data-link-status]');
  const rows = {}; for (const dt of d.querySelectorAll('.pv-prov-rows dt')) rows[dt.textContent.trim()] = dt.nextElementSibling.textContent.trim().replace(/\\s+/g, ' ');
  const r = d.getBoundingClientRect();
  return {
    title: d.querySelector('.pv-dialog-header-title')?.textContent ?? '',
    status: s?.dataset.status ?? null,
    chips: s ? [...s.querySelectorAll('[data-status]')].map((c) => c.textContent.trim()) : [],
    note: s?.querySelector('[data-link-note]')?.textContent ?? null,
    noteLabel: s?.querySelector('[data-link-note-label]')?.textContent ?? null,
    netLine: s?.querySelector('.pv-link-net')?.textContent ?? '',
    netAlone: !!s?.querySelector('[data-act="net-alone"]'),
    warnings: [...d.querySelectorAll('.pv-engine-warn')].map((w) => w.textContent.trim()),
    calls: [...d.querySelectorAll('.pv-prov-call > code:first-child')].map((c) => c.textContent),
    rows,
    evidence: d.querySelectorAll('.pv-result-evidence > div').length,
    svgs: d.querySelectorAll('.pv-result-evidence svg').length,
    fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
  };
})()`);
const notice = (p: any) => p.eval(`(() => { const n = document.querySelector('[data-link-notice="info"]'); return n ? n.textContent.replace('×', '').trim() : null; })()`);
const noOverflow = (p: any) => p.eval(`document.documentElement.scrollWidth <= innerWidth + 1`);

// A page that must not have made a model request, whatever else it did.
async function noModel(p: any, label: string, baseline: string[]) {
  const seen = await llm(p);
  ok(seen.every((x: string) => x === "/api/llm/status"), `${label}: the only /api/llm/* the page asks is the status probe`, JSON.stringify(seen));
  same(seen, baseline, `${label}: it asks no more than a bare ?cid= link does`);
  ok(p.paused.length === 0, `${label}: nothing under /api/llm/ reached the network`, String(p.paused.length));
}

// ---- 0. the cards, as a crawler (no scripts) reads them ------------------------------------------------------------------

{
  const html = await (await fetch(url)).text();
  const cards = [...html.matchAll(/<div class="model-card" data-example="([^"]+)"[\s\S]*?<\/div>\s*<\/a>\s*<a class="model-card-canvas"[^>]*>Open the canvas<\/a>\s*<\/div>/g)];
  same(cards.map((m) => m[1]), examples.map((e) => e.id), "the static HTML has the six cards, each with its view link and 'Open the canvas'");
  for (const e of examples) {
    const card = cards.find((m) => m[1] === e.id)?.[0] ?? "";
    ok(card.includes(`Opens to: ${e.opensTo.replaceAll("&", "&amp;")}`), `${e.id}: 'Opens to' is in the HTML, not drawn by a script`);
    ok(/<a class="model-card-main" href="\/\?cid=[^"]*#view=[A-Za-z0-9_-]+"/.test(card), `${e.id}: the card is a plain link carrying #view=`);
    ok(/<img alt="[^"]+" src="\/img\/z\w+\.svg"/.test(card), `${e.id}: the thumbnail is kept`);
  }
}

// ---- 1. a bare /?cid= link is what it always was --------------------------------------------------------------------------

let bareModel = "";
let baseline: string[] = [];
{
  const p = await open(hrefTo(`?cid=${coffee.cid}`));
  await editorUp(p);
  await sleep(2500); // a link would have shown its pane by now
  bareModel = await model(p);
  same(placeIds(JSON.parse(bareModel)), placeIds(nets[coffee.cid]), "/?cid= alone: the net loads");
  ok(!(await p.eval(`!!document.querySelector('.pv-result-dialog, [data-link-status], [data-link-notice]')`)), "/?cid= alone: no pane, no notice");
  same(await viewWorkers(p), 0, "/?cid= alone: no replay worker is started");
  baseline = await llm(p);
  ok(baseline.every((x: string) => x === "/api/llm/status"), "/?cid= alone: the page's own /api/llm/* is the status probe", JSON.stringify(baseline));
  ok(p.paused.length === 0, "/?cid= alone: nothing under /api/llm/ reached the network");
  same(problemsOf(p), [], "/?cid= alone: no page errors");
  await p.close();
}
{
  const p = await open(hrefTo(`?data=${encodeURIComponent(permalinkData(small()))}`));
  await editorUp(p);
  await sleep(1500);
  same(placeIds(JSON.parse(await model(p))), ["I", "R", "S"], "/?data= alone: the net loads from the permalink");
  ok(!(await p.eval(`!!document.querySelector('.pv-result-dialog, [data-link-status], [data-link-notice]')`)), "/?data= alone: no pane, no notice");
  await p.close();
}

// A compose-page hash is not a view link: the editor leaves it alone (no notice, not even a flash of one).
{
  const p = await open(hrefTo(`?cid=${coffee.cid}`, "#view=cospan&ex=orders"));
  await editorUp(p);
  await sleep(2000);
  ok(!(await p.eval(`!!document.querySelector('.pv-result-dialog, [data-link-status], [data-link-notice]')`)), "#view=cospan&ex=orders: no pane, no notice");
  same(await viewWorkers(p), 0, "#view=cospan&ex=orders: nothing was replayed");
  same(await model(p), bareModel, "#view=cospan&ex=orders: the net alone");
  await p.close();
}

// ---- 2. each card opens its view, from a click ----------------------------------------------------------------------------

for (const e of examples) {
  const label = `card ${e.id}`;
  const p = await open(hrefTo(""), { width: 1280, height: 800 });
  await p.waitFor(`!!document.querySelector('.model-card[data-example=${q(e.id)}] .model-card-main')`, 20000);
  ok(await p.eval(`getComputedStyle(document.getElementById('landing')).display !== 'none'`), `${label}: the landing page shows`);
  if (e.id === coffee.id) { await p.eval(`document.querySelector('.model-grid').scrollIntoView({ block: 'start' })`); await shot(p, "cards-1280"); }
  const href = await p.eval(`document.querySelector('.model-card[data-example=${q(e.id)}] .model-card-main').href`);
  ok(href.includes(`#view=${e.payload}`), `${label}: its link carries the recorded view`);
  const xy = await p.eval(`(() => { const a = document.querySelector('.model-card[data-example=${q(e.id)}] .model-card-main'); a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return [r.left + r.width / 2, r.top + 20]; })()`);
  await sleep(150);
  await p.click(xy[0], xy[1]);
  const got = await settled(p);
  ok(got, `${label}: a result opens`);
  ok((await p.eval(`location.hash`)).startsWith("#view="), `${label}: the click kept the #view= in the URL`);
  ok(await p.eval(`getComputedStyle(document.getElementById('landing')).display === 'none'`), `${label}: the landing hero is skipped for a ?cid= link`);
  const r = await pane(p);
  ok(r, `${label}: a result pane`);
  if (r) {
    same(r.chips, ["Saved version of the net", "reproduced - no model call"], `${label}: saved version, reproduced with no model call`);
    same(r.calls, e.spec.calls.map((c: any) => c.command), `${label}: the footer lists the spec's calls, in order`);
    const eng = e.spec.calls.some((c: any) => c.command === "sim.ode") ? "ODE" : null;
    ok(eng ? r.rows["Engine"]?.startsWith(eng) : !r.rows["Engine"], `${label}: the footer's engine is ${eng ?? "absent (the calls run none)"}`, r.rows["Engine"]);
    ok(r.rows["Version"]?.includes(e.spec.engine.registry), `${label}: the footer's version is the spec's engine`, r.rows["Version"]);
    ok(r.rows["Version"]?.includes(`net ${e.cid.slice(0, 5)}`), `${label}: the footer names the net`, r.rows["Version"]);
    ok(r.evidence >= e.spec.expect.artifacts.length, `${label}: every recorded result is drawn`, `${r.evidence} of ${e.spec.expect.artifacts.length}`);
    ok(r.warnings.some((w: string) => w.startsWith("engine caution: ODE on a net where the engine recommends SSA")) === (eng === "ODE"), `${label}: the engine guard's caution appears exactly for the ODE views`, JSON.stringify(r.warnings));
    ok(!r.warnings.some((w: string) => /differs|refused|partial|not reproducible/.test(w)), `${label}: no drift, refusal or partial notice`, JSON.stringify(r.warnings));
    ok(r.netLine.includes("saved version of the net") && r.netLine.includes("Edit from here"), `${label}: says it is a saved version, and where to edit from`);
    ok(!r.netAlone, `${label}: no 'open the net alone' offered for a view that reproduced`);
    ok(r.fits, `${label}: the pane fits the window`, JSON.stringify(r.box));
    if (e.spec.calls.some((c: any) => c.command === "sim.ode")) ok(r.svgs >= 1, `${label}: the curve is drawn`);
  }
  same(placeIds(JSON.parse(await model(p))), placeIds(nets[e.cid]), `${label}: the net is open in the editor`);
  same(await viewWorkers(p), 1, `${label}: one replay worker, off the page's thread`);
  await noModel(p, label, baseline);
  same(problemsOf(p), [], `${label}: no page errors`);
  if (e.id === "coffee-shop" || e.id === "enzyme-kinetics") await shot(p, `result-${e.id}-1280`);
  await p.close();
}

// 'Open the canvas' is the old behaviour: the net alone.
{
  const p = await open(hrefTo(""));
  await p.waitFor(`!!document.querySelector('.model-card[data-example="usdc-bridge"] .model-card-canvas')`, 20000);
  const xy = await p.eval(`(() => { const a = document.querySelector('.model-card[data-example="usdc-bridge"] .model-card-canvas'); a.scrollIntoView({ block: 'center' }); const r = a.getBoundingClientRect(); return [r.left + 20, r.top + r.height / 2]; })()`);
  await sleep(150);
  await p.click(xy[0], xy[1]);
  await editorUp(p);
  await sleep(2000);
  ok(!(await p.eval(`location.hash`)), "'Open the canvas': no hash, the net alone");
  ok((await p.eval(`location.search`)).startsWith("?cid=z4EBG9jC6H"), "'Open the canvas': /?cid=<net> as before");
  ok(!(await p.eval(`!!document.querySelector('.pv-result-dialog, [data-link-status], [data-link-notice]')`)), "'Open the canvas': no result");
  await p.close();
}

// ---- 3. what a link must say when it is not the plain case ---------------------------------------------------------------

// A different engine made it, and a digest has changed.
{
  const s = spec({ engine: { registry: "pflow-native 0.7.0 wasm aaaaaaa", app: "rev-old" } });
  const d = s.expect.artifacts[0];
  s.expect.artifacts[0] = d.replace(/.$/, d.endsWith("0") ? "1" : "0");
  const p = await open(await linkTo(s));
  ok(await settled(p), "tampered digest: a result opens");
  const r = await pane(p);
  same(r?.status, "differs", "tampered digest: the status is 'differs'");
  ok(r?.chips.includes("This differs from when the link was made"), "tampered digest: the chip says so", JSON.stringify(r?.chips));
  const w = (r?.warnings ?? []).join(" ");
  ok(w.includes("pflow-native 0.7.0 wasm aaaaaaa") && w.includes("rev-old"), "tampered digest: the engine that made it is named", w);
  ok(/pflow-native 0\.\d+\.\d+/.test(w.replace("pflow-native 0.7.0 wasm aaaaaaa", "")), "tampered digest: and the engine this app runs", w);
  ok(w.includes("saved sha256:") && w.includes("now sha256:"), "tampered digest: both digests are shown", w);
  ok(!r?.chips.includes("reproduced - no model call"), "tampered digest: never claims to have reproduced");
  ok((r?.evidence ?? 0) >= 1, "tampered digest: the new result is shown, not hidden");
  await shot(p, "differs-1280");
  await p.close();
}

// A note rides the link, labelled; a command this app does not have is not reproducible here.
{
  const note = { by: "assistant", text: "Look at the <b>siphons</b>.\nThen the traps." };
  const s = spec({ note, calls: [{ command: "analysis.teleport", args: { to: "mars" } }, ...coffee.spec.calls], expect: { artifacts: [], rounding: 9 } });
  const p = await open(await linkTo(s));
  ok(await settled(p), "unknown command: a result opens");
  const r = await pane(p);
  same(r?.status, "unreproducible", "unknown command: the status");
  ok(r?.chips.includes("not reproducible here"), "unknown command: the chip says 'not reproducible here'", JSON.stringify(r?.chips));
  ok((r?.warnings ?? []).join(" ").includes('"analysis.teleport"'), "unknown command: the missing command is named");
  same(r?.noteLabel, "assistant's note, saved with the link", "the note carries its label");
  same(r?.note, note.text, "the note is shown as text (its markup is not markup)");
  ok(!(await p.eval(`!!document.querySelector('[data-link-note] b')`)), "the note's <b> is escaped, not a tag");
  same(r?.calls, ["analysis.teleport", ...coffee.spec.calls.map((c: any) => c.command)], "unknown command: every call is still listed");
  ok(r?.netAlone, "unknown command: the net can be opened alone");
  ok((r?.evidence ?? 0) >= 1, "unknown command: the calls this app has still ran");
  await shot(p, "unreproducible-1280");
  await p.eval(`document.querySelector('[data-act="net-alone"]').click()`);
  await sleep(200);
  ok(!(await p.eval(`!!document.querySelector('.pv-result-dialog')`)), "'Open the net alone' closes the pane and leaves the net");
  same(placeIds(JSON.parse(await model(p))), placeIds(nets[coffee.cid]), "the net is still open");
  await p.close();
}

// A call that fails is partial.
{
  const s = spec({ view: "one_more", calls: [{ command: "sim.what_if", args: { place: "queue", delta: 1, t_end: 5, runs: 2, seed: 1 } }], expect: { artifacts: [], rounding: 9 } });
  const p = await open(await linkTo(s));
  ok(await settled(p), "failing call: a result opens");
  const r = await pane(p);
  same(r?.status, "partial", "failing call: the status is 'partial'");
  ok((r?.warnings ?? []).join(" ").includes("queue"), "failing call: the engine's error names the place", JSON.stringify(r?.warnings));
  await p.close();
}

// A link that asks for an edit is refused, whole, and nothing runs.
for (const bad of [{ command: "edit.delete", args: { id: "CoffeeBeans" } }, { command: "net.add_place", args: { x: 10, y: 20 } }]) {
  const s = spec({ note: { by: "assistant", text: "Trust me." }, calls: [coffee.spec.calls[0], bad] });
  const label = `refused ${bad.command}`;
  const p = await open(await linkTo(s));
  ok(await settled(p), `${label}: a result opens`);
  const r = await pane(p);
  same(r?.status, "refused", `${label}: the status is 'refused'`);
  ok(r?.chips.includes("refused"), `${label}: the chip says 'refused'`, JSON.stringify(r?.chips));
  ok((r?.warnings ?? []).join(" ").includes("Nothing was run"), `${label}: it says nothing was run`);
  same(r?.evidence, 0, `${label}: no result is drawn`);
  same(await viewWorkers(p), 0, `${label}: no replay worker was even started`);
  same(r?.note, null, `${label}: the untrusted note is not shown`);
  same(r?.calls, [coffee.spec.calls[0].command, bad.command], `${label}: what the link asked for is listed`);
  same(await model(p), bareModel, `${label}: the net is the one a bare ?cid= link opens, untouched`);
  same(await p.eval(`document.querySelector('petri-view')._history.length`), 1, `${label}: no edit reached the undo history`);
  await noModel(p, label, baseline);
  if (bad.command === "edit.delete") await shot(p, "refused-1280");
  await p.close();
}

// Not a usable link: one line, and the net alone.
const garbage: [string, string, RegExp][] = [
  ["garbage payload", "#view=not-a-payload", /damaged|could not be opened/],
  ["oversized payload", `#view=${"A".repeat(70000)}`, /characters|too large|could not be opened/],
  ["percent junk", "#view=%%%", /could not be opened/],
];
for (const [label, hash, expect] of garbage) {
  const p = await open(hrefTo(`?cid=${coffee.cid}`, hash));
  ok(await settled(p), `${label}: the page says something`);
  const n = await notice(p);
  ok(n && expect.test(n) && !n.includes("\n"), `${label}: one line saying why`, String(n));
  ok(n?.includes("the net is open on its own"), `${label}: and that the net is open`, String(n));
  ok(!(await p.eval(`!!document.querySelector('.pv-result-dialog')`)), `${label}: no result pane`);
  same(await model(p), bareModel, `${label}: the net alone`);
  same(await viewWorkers(p), 0, `${label}: nothing was replayed`);
  await noModel(p, label, baseline);
  if (label === "garbage payload") await shot(p, "garbage-1280");
  await p.close();
}
{
  const p = await open(await linkTo(spec({ specVersion: 99 })));
  ok(await settled(p), "a newer spec: the page says something");
  ok(/newer/.test((await notice(p)) ?? ""), "a newer spec: says this app reads an older one", String(await notice(p)));
  await p.close();
}
{
  const p = await open(await linkTo(spec(), "zNotStoredAnywhere"));
  ok(await settled(p), "a net that did not load: the page says something");
  const n = (await notice(p)) ?? "";
  ok(/could not be loaded/.test(n) && /removed by its author/.test(n), "a net that did not load: says so, and why it may be", n);
  same(await viewWorkers(p), 0, "a net that did not load: the view is not replayed on whatever the editor holds instead");
  await p.close();
}

// The standalone component (no data-backend) keeps working as it did: a hash does nothing to it.
{
  const p = await open(await linkTo(spec()));
  ok(await settled(p), "standalone: the page's own backend editor opened the link");
  const out = await p.eval(`(async () => {
    const el = document.createElement('petri-view');
    document.body.appendChild(el);
    await new Promise((r) => setTimeout(r, 1500));
    return { opened: !!el._lastResult, notice: !!el._linkNotice, workers: window.__workers.filter((w) => w.endsWith('/petri-viewspec.js')).length, backend: el.hasAttribute('data-backend') };
  })()`);
  same([out.backend, out.opened, out.notice], [false, false, false], "standalone: with no data-backend the component never opens a link");
  same(out.workers, 1, "standalone: and starts no replay of its own (only the backend editor's)");
  await p.close();
}

// ---- 4. Copy link ---------------------------------------------------------------------------------------------------------

const clickFooter = (p: any, act: string) => p.eval(`document.querySelector('.pv-result-dialog [data-prov] [data-act=${q(act)}]').click()`);
const clip = (p: any) => p.waitFor(`window.__clip.length > 0`, 60000).then(() => p.eval(`window.__clip.at(-1)`));

// The saved net: the link names it, and opens to the same view in a fresh page.
{
  const p = await open(await linkTo(coffee.spec));
  ok(await settled(p), "copy link: the view opens");
  await clickFooter(p, "link");
  const copied: string = await clip(p);
  ok(copied.startsWith(hrefTo(`?cid=${coffee.cid}`, "#view=")), "copy link, saved net: /?cid=<net>#view=<payload>", copied.slice(0, 120));
  const parts = new URL(copied);
  const d: any = await decodeView(decodeURIComponent(parts.hash.slice(6)), { net: coffee.cid });
  ok(d.ok, "copy link: the payload decodes");
  same(d.spec.calls, coffee.spec.calls, "copy link: it carries the calls");
  same(d.spec.expect.artifacts, coffee.spec.expect.artifacts, "copy link: and the digests (the same engine makes them)");
  ok(await p.eval(`[...document.querySelectorAll('.pv-toast')].some((t) => t.textContent.includes('View link copied'))`), "copy link: a toast says it was copied");
  const fresh = await open(copied);
  ok(await settled(fresh), "copy link: the copied link opens in a fresh page");
  const r = await pane(fresh);
  same(r?.chips, ["Saved version of the net", "reproduced - no model call"], "copy link: and reproduces the view");
  same(r?.calls, coffee.spec.calls.map((c: any) => c.command), "copy link: with the same calls");
  await fresh.close();
  await p.close();
}

// An unsaved net small enough to travel: ?data=<permalink>#view=...
const unsavedResult = `(async () => {
  const el = document.querySelector('petri-view');
  const P = await import('/petri-provenance.js');
  const rec = P.recordFromCall({ command: 'analysis.invariants', args: { kind: 'p' } }, { net: { revision: 0 } });
  await el._showResult({ title: 'Palette run', source: 'palette', goal: null, record: rec, artifacts: [], registry: await el.commands(), warnings: [] });
  return true;
})()`;
{
  const p = await open(hrefTo(`?data=${encodeURIComponent(permalinkData(small()))}`));
  await editorUp(p);
  await p.eval(unsavedResult);
  await clickFooter(p, "link");
  const copied: string = await clip(p);
  ok(copied.startsWith(hrefTo("?data=")) && copied.includes("#view="), "copy link, unsaved small net: /?data=<permalink>#view=", copied.slice(0, 80));
  ok(copied.length <= 8192, "copy link, unsaved: within the length that survives being shared", String(copied.length));
  ok(await p.eval(`[...document.querySelectorAll('.pv-toast')].some((t) => t.textContent.includes('travels inside'))`), "copy link, unsaved: the toast says the net travels in the link");
  const fresh = await open(copied);
  ok(await settled(fresh), "copy link, unsaved: opens in a fresh page");
  const r = await pane(fresh);
  same(r?.chips, ["Net carried in the link", "reproduced - no model call"], "copy link, unsaved: reproduces the view from the carried net");
  same(placeIds(JSON.parse(await model(fresh))), ["I", "R", "S"], "copy link, unsaved: with the carried net open");
  await fresh.close();
  await p.close();
}

// Too big to carry: 'Save to get a link'; signed out there is no save to offer, signed in it is one step.
{
  const p = await open(hrefTo(`?data=${encodeURIComponent(permalinkData(big()))}`));
  await editorUp(p);
  await p.eval(unsavedResult);
  await clickFooter(p, "link");
  ok(await p.waitFor(`!!document.querySelector('.pv-modal-title') && document.querySelector('.pv-modal-title').textContent === 'Save to get a link'`, 60000), "copy link, unsaved big net signed out: says 'Save to get a link'");
  ok(!(await p.eval(`!!document.querySelector('[data-act="save-and-copy"]')`)), "signed out: there is no save to offer in one step");
  ok((await p.eval(`document.querySelector('.pv-modal-title').closest('.pv-modal-dialog').textContent`)).includes("Sign in"), "signed out: it says to sign in");
  same(await p.eval(`window.__clip.length`), 0, "nothing was copied: there is no link to give");
  await shot(p, "save-to-get-a-link-1280");
  await p.close();
}
{
  const p = await open(hrefTo(`?data=${encodeURIComponent(permalinkData(big()))}`), { signedIn: true });
  await editorUp(p);
  await p.waitFor(`!!document.querySelector('petri-view')._user`, 15000);
  await p.eval(unsavedResult);
  await clickFooter(p, "link");
  ok(await p.waitFor(`!!document.querySelector('[data-act="save-and-copy"]')`, 60000), "copy link, unsaved big net signed in: offers 'Save and copy link'");
  await p.eval(`document.querySelector('[data-act="save-and-copy"]').click()`);
  const copied: string = await clip(p);
  ok(copied.startsWith(hrefTo("?cid=zSmokeSaved0#view=")), "'Save and copy link': one step saves through the editor's own save and copies the link naming the saved net", copied.slice(0, 80));
  same(await p.eval(`window.__saved`), ["zSmokeSaved0"], "'Save and copy link': the net was saved once");
  ok((await p.eval(`location.search`)).startsWith("?cid=zSmokeSaved0"), "'Save and copy link': the editor is now on the saved net");
  ok(!(await p.eval(`!!document.querySelector('.pv-modal-title')`)), "'Save and copy link': the dialog is gone");
  await p.close();
}

// ---- 5. the Share dialog --------------------------------------------------------------------------------------------------

const centre = (p: any, sel: string) => p.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
const topmost = (p: any, x: number, y: number) => p.eval(`(() => { const e = document.elementFromPoint(${x}, ${y}); return e ? (e.className || e.tagName) : null; })()`);

// The way a person gets there. The result's pane is a full-screen overlay that covers the menu, so the Share dialog is reached
// once the pane is closed, and it still offers the view of the result that was just closed.
{
  const p = await open(await linkTo(coffee.spec), { signedIn: true });
  ok(await settled(p), "share: a view is open");
  ok(await p.waitFor(`!!document.querySelector('petri-view')._user`, 15000), "share: signed in (the menu offers Share to a signed-in person)");
  const pt = await centre(p, ".pv-hamburger-btn");
  ok(pt, "share: the menu button is there");
  ok(String(await topmost(p, pt[0], pt[1])).includes("pv-modal-overlay"), "share: while the result is open its pane covers the menu button (so it is reached after the pane is closed)", String(await topmost(p, pt[0], pt[1])));
  await p.eval(`document.querySelector('.pv-result-dialog [data-act="close"]').click()`);
  ok(!(await p.eval(`!!document.querySelector('.pv-result-dialog')`)), "share: the result is closed");
  same(await topmost(p, pt[0], pt[1]) === "pv-modal-overlay", false, "share: and the menu button can be clicked");
  await p.click(pt[0], pt[1]);
  ok(await p.waitFor(`getComputedStyle(document.querySelector('.pv-hamburger-overlay')).display !== 'none'`, 5000), "share: the menu opens");
  const item = await p.eval(`(() => { const e = [...document.querySelectorAll('.pv-hamburger-overlay .pv-menu-item')].find((x) => /Share/.test(x.textContent)); if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  ok(item, "share: the menu has a Share item");
  // the first state the dialog is drawn in, before the view's link is ready (a MutationObserver sees it before any later work runs)
  await p.eval(`(() => {
    window.__shareFirst = null;
    new MutationObserver(() => {
      const c = document.querySelector('[data-share-copy]');
      if (c && !window.__shareFirst) window.__shareFirst = { disabled: c.disabled, text: c.textContent, state: document.querySelector('[data-share-view-state]')?.dataset.shareViewState ?? null, checked: document.querySelector('[data-share-view-check]')?.checked, checkDisabled: document.querySelector('[data-share-view-check]')?.disabled, md: document.querySelector('.pv-share-textarea').value };
    }).observe(document.body, { childList: true, subtree: true });
  })()`);
  await p.click(item[0], item[1]);
  ok(await p.waitFor(`!!document.querySelector('[data-share-view-check]')`, 10000), "share, via the menu after the result was closed: 'Share this view' is offered");
  const first = await p.eval(`window.__shareFirst`);
  same([first?.state, first?.disabled, first?.checkDisabled], ["preparing", true, true], "share: while the view's link is made, the box is held and Copy waits (it would hand out the net's link as the view's)");
  ok(first?.text?.includes("Preparing"), "share: and Copy says why", String(first?.text));
  ok(first && !first.md.includes("#view="), "share: and the snippet is the net's link meanwhile", String(first?.md));
  ok(await p.waitFor(`document.querySelector('[data-share-view-link]')?.value.includes('#view=')`, 60000), "share: the view link is filled in");
  same(await p.eval(`[document.querySelector('[data-share-view-state]').dataset.shareViewState, document.querySelector('[data-share-copy]').disabled, document.querySelector('[data-share-copy]').textContent, document.querySelector('[data-share-view-check]').disabled]`), ["ready", false, "Copy to Clipboard", false], "share: ready: the box and Copy are released");
  ok(await p.eval(`document.querySelector('[data-share-view-check]').checked`), "share: the box is on by default (the net has not changed)");
  const links = await p.eval(`({ view: document.querySelector('[data-share-view-link]').value, net: document.querySelector('[data-share-net-link]').value, md: document.querySelector('.pv-share-textarea').value })`);
  ok(links.net.endsWith(`/?cid=${coffee.cid}`) && !links.net.includes("#"), "share: the net-only link sits beside it", links.net);
  ok(links.view.startsWith(links.net) && links.view.includes("#view="), "share: the view link is the net's link plus the view", links.view.slice(0, 100));
  ok(links.md.includes("#view="), "share: the markdown snippet points at the view while the box is on");
  await p.eval(`document.querySelector('[data-share-copy]').click()`);
  ok(await p.waitFor(`window.__clip.length > 0`, 5000) && (await p.eval(`window.__clip.at(-1)`)).includes("#view="), "share: Copy copies the snippet with the view's link");
  const privacy = await p.eval(`document.querySelector('[data-share-privacy]').textContent`);
  ok(/possessing the net.s ID/.test(privacy) && /only check/.test(privacy) && /deleting the net breaks the link/.test(privacy), "share: it says possession of the ID is the only check, and implies no more", privacy);
  ok(!/secure|protected|access control|permission/i.test(privacy), "share: and claims no protection it does not have", privacy);
  await shot(p, "share-1280");
  await p.eval(`(() => { const c = document.querySelector('[data-share-view-check]'); c.checked = false; c.dispatchEvent(new Event('change')); })()`);
  const md = await p.eval(`document.querySelector('.pv-share-textarea').value`);
  ok(!md.includes("#view=") && md.includes(`/?cid=${coffee.cid})`), "share: with the box off the snippet points at the net alone", md);
  same(await p.eval(`document.querySelector('[data-share-copy]').disabled`), false, "share: and Copy is not held (the net's link is what was asked for)");
  same(problemsOf(p), [], "share: no page errors");
  await p.close();
}
// A view that has no link (it asks for an edit): the box cannot be on, the snippet is the net's and says so, nothing is held.
{
  const p = await open(hrefTo(`?cid=${coffee.cid}`));
  await editorUp(p);
  await p.eval(`(async () => {
    const el = document.querySelector('petri-view');
    const P = await import('/petri-provenance.js');
    const rec = P.recordFromCall({ command: 'edit.delete', args: { id: 'CoffeeBeans' } }, { net: { revision: 0 } });
    await el._showResult({ title: 'An edit', source: 'palette', goal: null, record: rec, artifacts: [], registry: await el.commands(), warnings: [] });
    document.querySelector('.pv-result-dialog [data-act="close"]').click();
    await el._showShareDialog();
  })()`);
  ok(await p.waitFor(`document.querySelector('[data-share-view-state]')?.dataset.shareViewState === 'unavailable'`, 60000), "share, a view with no link: the dialog says there is none");
  same(await p.eval(`[document.querySelector('[data-share-view-check]').checked, document.querySelector('[data-share-view-check]').disabled, document.querySelector('[data-share-copy]').disabled]`), [false, true, false], "share, no link: the box is off and cannot be turned on; Copy gives the net's link");
  const st = await p.eval(`document.querySelector('[data-share-view-state]').textContent`);
  ok(/no link/i.test(st) && /net alone/.test(st), "share, no link: it says why, and that the snippet is the net alone", st);
  ok(!(await p.eval(`document.querySelector('.pv-share-textarea').value`)).includes("#view="), "share, no link: the snippet has no view in it");
  await p.close();
}
// The net is not the net the result was made on: the box starts off, and says what the link would show.
{
  const p = await open(await linkTo(coffee.spec));
  ok(await settled(p), "share, after an edit: a view is open");
  await p.eval(`document.querySelector('.pv-result-dialog [data-act="close"]').click()`);
  await p.eval(`document.querySelector('petri-view').execute('net.add_place', { x: 10, y: 20 })`);
  await p.eval(`document.querySelector('petri-view')._showShareDialog()`);
  ok(await p.waitFor(`!!document.querySelector('[data-share-view-check]')`, 10000), "share, after an edit: 'Share this view' is still offered");
  same(await p.eval(`document.querySelector('[data-share-view-check]').checked`), false, "share, after an edit: but the box starts off");
  ok((await p.eval(`document.querySelector('[data-share-view-check]').closest('[data-share-view]').textContent`)).includes("net has changed since this result was made"), "share, after an edit: and says the link shows the view on the net as it is now");
  await p.close();
}
{
  const p = await open(hrefTo(`?cid=${coffee.cid}`));
  await editorUp(p);
  await p.eval(`document.querySelector('petri-view')._showShareDialog()`);
  ok(await p.waitFor(`!!document.querySelector('[data-share-privacy]')`, 10000), "share, no result shown yet: the dialog opens");
  ok(!(await p.eval(`!!document.querySelector('[data-share-view-check]')`)), "share, no result shown yet: no 'Share this view'");
  ok(await p.waitFor(`document.querySelector('[data-share-privacy]').textContent.includes('only check')`, 10000), "share, no result shown yet: the privacy line is still there");
  await p.close();
}

// ---- 5b. a /health that never answers, a ?data= that does not decode, an edit after opening ----------------------------------

{
  const t0 = Date.now();
  const p = await open(await linkTo(coffee.spec), { stallHealth: true });
  ok(await settled(p, 25000), "stalled /health: the view still opens");
  ok(Date.now() - t0 < 25000, "stalled /health: within a few seconds of the engine starting, not after it", `${Date.now() - t0} ms`);
  const r = await pane(p);
  same(r?.chips, ["Saved version of the net", "reproduced - no model call"], "stalled /health: and reproduces (the digests do not depend on the app revision)");
  ok(p.stalled.length >= 1, "stalled /health: the request really was held", String(p.stalled.length));
  // Copy link waits for the revision only as long as the probe does, and the link it makes names the app as unknown
  await clickFooter(p, "link");
  const copied: string = await clip(p);
  ok(copied.startsWith(hrefTo(`?cid=${coffee.cid}`, "#view=")), "stalled /health: Copy link still copies a view link", copied.slice(0, 100));
  const d: any = await decodeView(decodeURIComponent(new URL(copied).hash.slice(6)), { net: coffee.cid });
  ok(d.ok && d.spec.engine?.app === "unknown", "stalled /health: with the app revision unknown", JSON.stringify(d.spec?.engine));
  await noModel(p, "stalled /health", baseline);
  await p.close();
}
{
  const hash = `#view=${await encodeView(coffee.spec)}`;
  // nothing the editor could read: it opens its own net, and a view must not be replayed on that
  const p = await open(hrefTo("?data=%7B%22data%22%3A%7B%22places%22%3A%7B%22A%22%3A", hash));
  ok(await settled(p), "undecodable ?data=: the page says something");
  const n = (await notice(p)) ?? "";
  ok(/could not be read/.test(n) && n.includes("the net is open on its own") && !n.includes("\n"), "undecodable ?data=: one line saying the net could not be read", n);
  ok(!(await p.eval(`!!document.querySelector('.pv-result-dialog')`)), "undecodable ?data=: no result pane, so no 'Net carried in the link'");
  same(await viewWorkers(p), 0, "undecodable ?data=: nothing was replayed");
  await p.close();
  // ?cid=X&data=<garbage>: the editor loaded X, which is not the net the link carried
  const c = await open(hrefTo(`?cid=${coffee.cid}&data=%7Bbroken`, hash));
  ok(await settled(c), "?cid= with an undecodable ?data=: the page says something");
  ok(/could not be read/.test((await notice(c)) ?? ""), "?cid= with an undecodable ?data=: the same line", String(await notice(c)));
  same(await viewWorkers(c), 0, "?cid= with an undecodable ?data=: nothing was replayed");
  same(placeIds(JSON.parse(await model(c))), placeIds(nets[coffee.cid]), "?cid= with an undecodable ?data=: the net the cid names is open, alone");
  await c.close();
}
{
  const p = await open(await linkTo(coffee.spec));
  ok(await settled(p), "edit after opening: a view is open");
  await p.eval(`document.querySelector('.pv-result-dialog [data-act="close"]').click()`);
  await p.eval(`document.querySelector('petri-view')._syncLD()`);
  ok((await p.eval(`location.hash`)).startsWith("#view="), "edit after opening: a sync that changes nothing keeps the #view= in the address bar");
  await p.eval(`document.querySelector('petri-view').execute('net.add_place', { x: 10, y: 20 })`);
  same(await p.eval(`location.hash`), "", "edit after opening: the first edit takes the #view= out of the address bar");
  ok((await p.eval(`location.search`)).includes("data="), "edit after opening: the edited net is in it, as ever");
  const href = await p.eval(`location.href`);
  const fresh = await open(href);
  await editorUp(fresh);
  await sleep(2000);
  ok(!(await fresh.eval(`!!document.querySelector('.pv-result-dialog, [data-link-status], [data-link-notice]')`)), "edit after opening: the address, shared, opens the edited net alone: no view, no 'differs'");
  same(placeIds(JSON.parse(await model(fresh))).length, placeIds(nets[coffee.cid]).length + 1, "edit after opening: and it is the edited net");
  await fresh.close();
  await p.close();
}

// ---- 6. a phone ----------------------------------------------------------------------------------------------------------

{
  const p = await open(hrefTo(""), { width: 390, height: 844, phone: true });
  await p.waitFor(`!!document.querySelector('.model-card[data-example]')`, 20000);
  ok(await noOverflow(p), "phone: the landing page does not scroll sideways");
  const cards = await p.eval(`[...document.querySelectorAll('.model-card')].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })`);
  ok(cards.every(([l, r]: number[]) => l >= 0 && r <= 390), "phone: every card is inside the screen", JSON.stringify(cards));
  await p.eval(`document.querySelector('.model-card[data-example]').scrollIntoView({ block: 'start' })`);
  await shot(p, "cards-390");
  await p.close();
}
for (const [id, name] of [["coffee-shop", "result-coffee-shop-390"], ["predator-prey", "result-predator-prey-390"]]) {
  const e = examples.find((x) => x.id === id)!;
  const p = await open(await linkTo(e.spec, e.cid), { width: 390, height: 844, phone: true });
  ok(await settled(p), `phone ${id}: a result opens`);
  const r = await pane(p);
  ok(r?.fits, `phone ${id}: the pane fits a 390 px screen`, JSON.stringify(r?.box));
  same(r?.chips, ["Saved version of the net", "reproduced - no model call"], `phone ${id}: the same statuses`);
  ok(await noOverflow(p), `phone ${id}: no sideways scroll`);
  await shot(p, name);
  await p.close();
}
{
  const p = await open(hrefTo(`?cid=${coffee.cid}`, "#view=not-a-payload"), { width: 390, height: 844, phone: true });
  ok(await settled(p), "phone: a damaged link says so");
  const box = await p.eval(`(() => { const r = document.querySelector('[data-link-notice]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })()`);
  ok(box[0] >= 0 && box[1] <= 390, "phone: the one-line notice is inside the screen", JSON.stringify(box));
  await shot(p, "garbage-390");
  await p.close();
}
{
  const p = await open(await linkTo(spec({ calls: [coffee.spec.calls[0], { command: "edit.delete", args: { id: "CoffeeBeans" } }] })), { width: 390, height: 844, phone: true });
  ok(await settled(p), "phone: a refused link says so");
  ok((await pane(p))?.fits, "phone: the refusal fits");
  await shot(p, "refused-390");
  await p.close();
}

await stop();
console.log(`links-smoke: ${checks} checks, ${failures} failed`);
Deno.exit(failures ? 1 : 0);
