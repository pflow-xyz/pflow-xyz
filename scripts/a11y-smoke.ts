// Browser smoke test for the composition page's accessibility (public/compose/ACCESSIBILITY.md).
//
//   deno run -A scripts/a11y-smoke.ts http://127.0.0.1:8080/compose.html [--chrome /path/to/chrome]
//
// Drives the page in headless Chrome over the DevTools protocol (a small helper is inlined below, so
// there is nothing to install) and checks, in all ten views of both examples:
//
//   - zero console errors, exceptions and failed requests on load;
//   - nothing focusable is aria-hidden; no role=button holds a focusable descendant (nested
//     interactive); no inspectable thing is click-only; list items keep their role; every thing the
//     page made reachable has a name;
//   - where a view draws ports (orders) or palette pieces (connect-4): Tab reaches them, Enter lights
//     targets (or says the view draws none), Tab and the arrows walk lit targets only, Enter links, the
//     live region says so, Esc cancels and puts focus back;
//   - regressions found in review: the Laws view's live check ending mid-link does not redraw or speak in another
//     view and waits for a link in progress in Laws; Retry and other controls inside an inspectable pin nothing; a removed link is announced, the second of two equally titled
//     things moves the inspector pin instead of releasing it, skip links leave the address alone.
//
// It is not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure.

const args = Deno.args;
const url = args.find((a) => a.startsWith("http"));
if (!url) {
  console.error("usage: deno run -A scripts/a11y-smoke.ts <url of compose.html> [--chrome path]");
  Deno.exit(2);
}
const chromeArg = args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// --- a minimal CDP driver ---------------------------------------------------------------------------

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Tab: { code: "Tab", vk: 9 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
};

class Page {
  private n = 0;
  private waiting = new Map<number, (v: any) => void>();
  private loaded: (() => void) | null = null;
  problems: string[] = [];
  paused: string[] = []; // requests held by hold() (Fetch.requestPaused)
  failAll = false;       // fail what hold() matches at once (an offline network) instead of holding it
  close: () => Promise<void> = async () => {};
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      if (m.id !== undefined) { this.waiting.get(m.id)?.(m); this.waiting.delete(m.id); return; }
      const p = m.params ?? {};
      if (m.method === "Page.loadEventFired") this.loaded?.();
      else if (m.method === "Fetch.requestPaused") { if (this.failAll) this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "InternetDisconnected" }).catch(() => {}); else this.paused.push(p.requestId); }
      else if (m.method === "Runtime.exceptionThrown") this.problems.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
      else if (m.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "assert")) this.problems.push(`console.${p.type}: ${(p.args ?? []).map((a: any) => a.value ?? a.description).join(" ")}`);
      else if (m.method === "Log.entryAdded" && p.entry?.level === "error") this.problems.push(`log.error: ${p.entry.text} ${p.entry.url ?? ""}`);
      else if (m.method === "Network.loadingFailed" && !p.canceled) this.problems.push(`request failed: ${p.errorText}`);
      else if (m.method === "Network.responseReceived" && p.response?.status >= 400) this.problems.push(`HTTP ${p.response.status}: ${p.response.url}`);
    };
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.n;
    return new Promise((res, rej) => {
      this.waiting.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async init(width = 1280, height = 900) {
    for (const d of ["Page", "Runtime", "Log", "Network"]) await this.send(`${d}.enable`);
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  async goto(u: string) {
    const loaded = new Promise<void>((r) => { this.loaded = r; });
    await this.send("Page.navigate", { url: u });
    await loaded;
  }
  // deno-lint-ignore no-explicit-any
  async eval(expr: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async press(key: string, shift = false) {
    const k = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key };
    const modifiers = shift ? 8 : 0;
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
    await sleep(40);
  }
  async click(x: number, y: number) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
    await sleep(100);
  }
  /** Hold the requests whose URL matches (before navigating); fail() ends them as an offline network would. */
  async hold(patterns: string[]) {
    await this.send("Fetch.enable", { patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  }
  async fail() {
    for (const requestId of this.paused.splice(0)) await this.send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }).catch(() => {});
  }
  async waitFor(expr: string, ms = 20000): Promise<boolean> {
    for (let t = 0; t < ms; t += 100) { if (await this.eval(expr)) return true; await sleep(100); }
    return false;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const port = 9300 + Math.floor(Math.random() * 600);
const profile = await Deno.makeTempDir({ prefix: "a11y-smoke-" });
const chrome = new Deno.Command(CHROME, {
  args: ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--disable-extensions", "about:blank"],
  stdout: "null", stderr: "null",
}).spawn();
// Chrome takes a moment to listen.
for (let i = 0; i < 100; i++) {
  try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); await r.body?.cancel(); if (r.ok) break; } catch { /* not up yet */ }
  await sleep(100);
}
async function newPage(width = 1280, height = 900): Promise<Page> {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const p = new Page(ws);
  p.close = async () => { ws.close(); try { const r = await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); await r.body?.cancel(); } catch { /* gone */ } };
  await p.init(width, height);
  return p;
}

// --- the checks -------------------------------------------------------------------------------------

const VIEWS = ["cospan", "spiders", "operad", "string", "flat", "boundaries", "lens", "incidence", "process", "laws"];
const EXAMPLES = ["orders", "connect4"];
let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};

/** The DOM invariants, as a list of violations (empty when the page is clean). */
const INVARIANTS = `(() => {
  const FOC = 'button, a[href], input, select, textarea, summary, [tabindex], [role=button]';
  const NATIVE = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|SUMMARY)$/;
  const d = (e) => e.tagName.toLowerCase() + (e.getAttribute('class') ? '.' + e.getAttribute('class').split(' ')[0] : '');
  const out = [];
  for (const e of document.querySelectorAll('[aria-hidden=true]')) if (e.matches(FOC) || e.querySelector(FOC)) out.push('aria-hidden on or around something focusable: ' + d(e));
  for (const e of document.querySelectorAll('[role=button]')) if (e.querySelector(FOC)) out.push('role=button holds a focusable descendant: ' + d(e));
  for (const e of document.querySelectorAll('.inspectable')) if (!e.hasAttribute('tabindex') && !NATIVE.test(e.tagName)) out.push('click-only inspectable: ' + d(e));
  for (const e of document.querySelectorAll('li[role]')) out.push('list item with a role of its own: ' + d(e) + ' role=' + e.getAttribute('role'));
  for (const e of document.querySelectorAll('[data-a11y-group]')) {
    const named = e.getAttribute('aria-label') || (NATIVE.test(e.tagName) && e.textContent.trim());
    if (!named) out.push('reachable but unnamed: ' + d(e));
  }
  return out;
})()`;

const ACTIVE = `(() => { const a = document.activeElement; return a ? { key: a.dataset && a.dataset.a11yKey || null, group: a.dataset && a.dataset.a11yGroup || null, legal: a.classList.contains('snap-legal'), label: a.getAttribute('aria-label') || '' } : null; })()`;
const LOG = `(window.__a11yLog || []).slice()`;
const LIVE = `document.getElementById('a11y-live').textContent`;
const LIT = `document.querySelectorAll('.snap-legal').length`;

async function open(view: string, ex: string, extra = "", width = 1280, height = 900): Promise<Page> {
  const p = await newPage(width, height);
  await p.goto(`${url}#view=${view}&ex=${ex}${extra}`);
  await p.waitFor(`document.body.dataset.ready === '1' && !!document.querySelector('#stage svg, #stage .lw-bar')`);
  if (view === "laws") await p.waitFor(`!!document.querySelector('.lw-tab')`, 30000);
  await sleep(300);
  return p;
}

/** Tab from the top of the page until focus is on a thing of `group`. */
async function tabTo(p: Page, group: string): Promise<boolean> {
  await p.eval(`document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0)`);
  for (let i = 0; i < 80; i++) {
    await p.press("Tab");
    if ((await p.eval(ACTIVE))?.group === group) return true;
  }
  return false;
}

async function keyboardLinking(p: Page, view: string, ex: string) {
  const group = ex === "orders" ? "port" : "piece";
  const has = await p.eval(`!!document.querySelector('[data-a11y-group=${group}]')`);
  if (!has) { console.log(`  (no ${group}s in this view: keyboard linking skipped)`); return; }
  ok(await tabTo(p, group), `Tab reaches a ${group}`);
  const origin = await p.eval(ACTIVE);
  await p.press("Enter");
  await sleep(150);
  const lit = await p.eval(LIT);
  if (!lit) {
    // a view that draws no targets must say so and light nothing
    const said = (await p.eval(LOG)).slice(-1)[0] ?? "";
    ok(/draws no/.test(said) || /No legal/.test(said), "no lit target: the view says why", said);
    return;
  }
  ok(await p.eval(`document.body.classList.contains('snap-dragging')`), "Enter lights targets");
  ok(/Linking from/.test(await p.eval(LIVE)), "the live region announces link mode", await p.eval(LIVE));
  await p.press("Tab"); await sleep(60);
  ok((await p.eval(ACTIVE))?.legal, "Tab lands on a lit target");
  await p.press("ArrowRight"); await sleep(60);
  ok((await p.eval(ACTIVE))?.legal, "an arrow key stays on lit targets");
  await p.press("r"); await sleep(60);
  const refused = await p.eval(ACTIVE);
  ok(refused && !refused.legal && /refused/.test(await p.eval(LIVE)), "R walks to a refused target and says why", await p.eval(LIVE));
  // Esc: cancel, nothing left lit, focus on the origin
  await p.press("Escape"); await sleep(120);
  ok((await p.eval(LIT)) === 0, "Esc leaves nothing lit");
  ok((await p.eval(ACTIVE))?.key === origin.key, "Esc returns focus to the origin", `${(await p.eval(ACTIVE))?.key} vs ${origin.key}`);
  ok((await p.eval(LOG)).includes("Linking cancelled."), "Esc is announced");
  // and make a link: Enter, Tab, Enter
  await p.press("Enter"); await sleep(100);
  await p.press("Tab"); await sleep(60);
  await p.press("Enter"); await sleep(500);
  const log: string[] = await p.eval(LOG);
  ok(log.some((s) => /Link created|placed in the/.test(s)), "Enter on a lit target links, and it is announced", log.slice(-2).join(" / "));
  ok((await p.eval(LIT)) === 0, "link mode has ended after the link");
  ok((await p.eval(ACTIVE))?.group === group, `focus is back on a ${group} after the link`, JSON.stringify(await p.eval(ACTIVE)));
}

console.log(`a11y smoke: ${url}`);
try {
  for (const ex of EXAMPLES) {
    for (const view of VIEWS) {
      console.log(`${ex} / ${view}`);
      const p = await open(view, ex);
      for (const v of await p.eval(INVARIANTS)) ok(false, "invariant", v);
      ok(p.problems.length === 0, "no console problems on load", p.problems.join(" | "));
      ok(await p.eval(`document.querySelectorAll('[data-a11y-group]').length > 0`), "the page made things reachable");
      await keyboardLinking(p, view, ex);
      ok(p.problems.length === 0, "no console problems after the keys", p.problems.join(" | "));
      await p.close();
    }
  }

  console.log("regressions found in review");
  {
    // a removed link is announced (the click used to reach the row and pin it, and that was what was said)
    const p = await open("cospan", "orders");
    await p.eval(`document.querySelector('#composition button.x').focus()`);
    await p.press("Enter"); await sleep(400);
    const live = await p.eval(LIVE);
    ok(/Link removed/.test(live), "a removed link is announced", live);
    ok(!(await p.eval(`!!document.querySelector('#inspector-body .pinned')`)), "and no inspector is pinned on it");
  }
  {
    // two equally titled things: the second moves the pin
    const p = await open("operad", "orders");
    const title = () => p.eval(`(document.querySelector('#inspector-body .pinned .insp-title') || {}).textContent || null`);
    const two = await p.eval(`document.querySelectorAll('[data-port="orders:in"]').length`);
    ok(two === 2, "operad draws orders:in twice", String(two));
    await p.eval(`document.querySelectorAll('[data-port="orders:in"]')[0].focus()`); await p.press("i"); await sleep(100);
    const first = await title();
    await p.eval(`document.querySelectorAll('[data-port="orders:in"]')[1].focus()`); await p.press("i"); await sleep(100);
    ok(first && (await title()) === first, "I on the second equally titled thing moves the pin", String(await title()));
    await p.press("i"); await sleep(100);
    ok((await title()) === null, "I again releases it");
  }
  {
    // after a link from the second drawing of a port, focus is on that drawing (it used to go to the first)
    const p = await open("cospan", "orders");
    const twin = await p.eval(`(document.querySelector('[data-a11y-group=port][data-a11y-key*="#2"]') || {dataset: {}}).dataset.a11yKey || null`);
    ok(twin, "cospan draws a port twice", String(twin));
    if (twin) {
      await p.eval(`document.querySelector('[data-a11y-key="${twin}"]').focus()`);
      await p.press("Enter"); await sleep(100); await p.press("Tab"); await sleep(60); await p.press("Enter"); await sleep(500);
      ok((await p.eval(ACTIVE))?.key === twin, "focus returns to the drawing the link started from", `${(await p.eval(ACTIVE))?.key} vs ${twin}`);
    }
  }
  {
    // a click on plain text ends link mode (it moves no focus, so it used to leave it on)
    const p = await open("cospan", "orders");
    await p.eval(`document.querySelector('[data-a11y-group=port]').focus()`); await p.press("Enter"); await sleep(100);
    ok((await p.eval(LIT)) > 0, "link mode is on");
    const at = await p.eval(`(() => { const h = document.querySelector('#keys h3'); h.scrollIntoView({ block: 'center' }); const r = h.getBoundingClientRect(); return { x: r.x + 10, y: r.y + r.height / 2 }; })()`);
    await p.click(at.x, at.y);
    ok((await p.eval(LIT)) === 0, "a click on plain text ends link mode");
    ok((await p.eval(LOG)).includes("Linking cancelled."), "and says so");
  }
  {
    // the reason a target is refused is on screen on a short laptop display
    const p = await open("spiders", "connect4", "", 1366, 768);
    await p.eval(`document.querySelector('[data-piece="threats"]').focus()`); await p.press("Enter"); await sleep(100); await p.press("r"); await sleep(150);
    const r = await p.eval(`(() => { const b = document.querySelector('#snap-status').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, text: document.querySelector('#snap-status').textContent }; })()`);
    ok(r.text.includes("refused") && r.top >= 0 && r.bottom <= 768, "the refusal in the status line is inside a 1366 x 768 window", JSON.stringify(r));
  }
  for (const [where, ex] of [["another view is shown", "orders"], ["Laws itself is shown", "connect4"]]) {
    // the Laws view's live check ends while the person is linking: it must not redraw (and cancel the link) or speak
    // about Laws in another view, and in Laws it waits for the link to end. Pyodide's CDN requests are held, then failed.
    const p = await newPage(1280, 900);
    await p.hold(["*cdn.jsdelivr.net*", "*pypi.org*", "*pythonhosted.org*"]);
    await p.goto(`${url}#view=laws&ex=${ex}`);
    await p.waitFor(`document.body.dataset.ready === '1' && !!document.querySelector('.lw-tab')`, 30000);
    await sleep(500);
    ok(p.paused.length > 0, `Laws' live check is waiting on the network (${where})`, String(p.paused.length));
    const group = ex === "orders" ? "port" : "piece";
    if (where === "another view is shown") {
      await p.press("1"); await sleep(400);
      ok(await p.eval(`document.body.dataset.view === 'cospan'`), "the Cospans view is shown");
    }
    if (ex === "orders") ok(await tabTo(p, group), `Tab reaches a ${group}`);
    else await p.eval(`document.querySelector('[data-piece="threats"]').focus()`); // a piece with a legal slot
    await p.press("Enter"); await sleep(200);
    const linking = `document.body.classList.contains('snap-dragging')`;
    ok(await p.eval(linking), "link mode is on");
    const before = (await p.eval(LOG)).length;
    await p.fail(); await sleep(2500);
    const said: string[] = (await p.eval(LOG)).slice(before);
    ok(await p.eval(linking), `link mode survives Laws' live check ending (${where})`, said.join(" / "));
    ok(!said.some((t) => /Linking cancelled/.test(t)), "no 'Linking cancelled: the view was redrawn.'");
    if (where === "another view is shown") ok(!said.some((t) => /^Laws:/.test(t)), "nothing about Laws is spoken in Cospans", said.join(" / "));
    await p.press("Escape"); await sleep(150);
    await p.eval(`document.activeElement && document.activeElement.blur()`);
    if (where === "another view is shown") {
      await p.press("0"); await sleep(1200);
    } else await sleep(1200);
    ok(/did not run/.test(await p.eval(`(document.querySelector('.lw-livetext') || {}).textContent || ''`)), "Laws shows what its live check came to when it is drawn", where);
    if (where === "another view is shown") ok((await p.eval(LOG)).slice(before).some((t: string) => /^Laws: the live check did not run/.test(t)), "and says so once, on arrival");
    await p.close();
  }
  {
    // Retry in the Laws status bar, and "Assume a backward pass" in the Lenses card, are controls inside an inspectable:
    // they do their own work and pin nothing. Retry leaves focus on the status line and one Laws message.
    const p = await newPage(1280, 900);
    p.failAll = true;
    await p.hold(["*cdn.jsdelivr.net*", "*pypi.org*", "*pythonhosted.org*"]);
    await p.goto(`${url}#view=laws&ex=orders`);
    ok(await p.waitFor(`!!document.querySelector('.lw-retry')`, 30000), "the live check failed offline and Retry is offered");
    const pinned = `!!document.querySelector('#inspector-body .pinned')`;
    for (const how of ["Enter", "click"]) {
      const before = (await p.eval(LOG)).length;
      await p.eval(`document.querySelector('.lw-retry').focus()`);
      if (how === "Enter") await p.press("Enter"); else { const r = await p.eval(`(() => { const r = document.querySelector('.lw-retry').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`); await p.click(r.x, r.y); }
      await p.waitFor(`!!document.querySelector('.lw-retry')`, 10000); await sleep(400);
      const said: string[] = (await p.eval(LOG)).slice(before);
      ok(!said.some((t) => /Inspector/.test(t)), `Retry (${how}) pins and releases nothing`, said.join(" / "));
      ok(!(await p.eval(pinned)), `Retry (${how}): no inspector pinned`);
      if (how === "Enter") ok(await p.eval(`document.activeElement.classList.contains('lw-livetext')`), "Retry leaves focus on the status line, which says the result", await p.eval(`document.activeElement.className || document.activeElement.tagName`));
    }
    await p.close();
    const q = await open("lens", "orders");
    const before = (await q.eval(LOG)).length;
    await q.eval(`document.querySelector('.lo-go').focus()`); await q.press("Enter"); await sleep(400);
    ok(await q.eval(`new URLSearchParams(location.hash.slice(1)).get('lens') === 'assume'`), "Enter on \"Assume a backward pass\" does its work");
    ok(!(await q.eval(LOG)).slice(before).some((t: string) => /Inspector pinned/.test(t)), "and pins nothing");
    await q.close();
  }
  {
    // skip links leave the address alone
    const p = await open("string", "orders", "&level=transition");
    const before = await p.eval(`[location.hash, history.length]`);
    await p.eval(`document.activeElement && document.activeElement.blur()`);
    await p.press("Tab"); await p.press("Enter"); await sleep(300);
    const after = await p.eval(`[location.hash, history.length]`);
    ok(before[0] === after[0] && before[1] === after[1], "a skip link keeps the hash and the history", `${before} -> ${after}`);
    ok((await p.eval(`document.activeElement.id`)) === "stage", "and moves focus to the diagram");
  }
} finally {
  try { chrome.kill("SIGTERM"); } catch { /* gone */ }
  try { await chrome.status; } catch { /* ignore */ }
  try { await Deno.remove(profile, { recursive: true }); } catch { /* ignore */ }
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
Deno.exit(failures ? 1 : 0);
