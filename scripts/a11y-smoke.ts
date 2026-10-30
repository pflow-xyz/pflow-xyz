// Browser smoke test for the composition page's accessibility (public/compose/ACCESSIBILITY.md).
//
//   deno run -A scripts/a11y-smoke.ts http://127.0.0.1:8080/compose.html [--chrome /path/to/chrome]
//
// Drives the page in headless Chrome over the DevTools protocol (scripts/cdp.ts, a small helper, so
// there is nothing to install) and checks, in every view module of both examples:
//
//   - zero console errors, exceptions and failed requests on load;
//   - nothing focusable is aria-hidden; no role=button holds a focusable descendant (nested
//     interactive); no inspectable thing is click-only; list items keep their role; every thing the
//     page made reachable has a name; headings never skip a level; #a11y-live is the only live region;
//   - where a view draws ports (orders) or palette pieces (connect-4): Tab reaches them, Enter lights
//     targets (or says the view draws none), Tab and the arrows walk lit targets only, Enter links, the
//     live region says so, Esc cancels and puts focus back;
//   - regressions found in review: the Laws view's live check ending mid-link does not redraw or speak in another
//     view and waits for a link in progress in Laws; Retry and other controls inside an inspectable pin nothing; a removed link is announced, the second of two equally titled
//     things moves the inspector pin instead of releasing it, skip links leave the address alone.
//
// It is not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure.

import { sleep, startChrome } from "./cdp.ts";
import { VIEWS as ALL_VIEWS } from "../public/compose/views-meta.js";

const args = Deno.args;
const url = args.find((a) => a.startsWith("http"));
if (!url) {
  console.error("usage: deno run -A scripts/a11y-smoke.ts <url of compose.html> [--chrome path]");
  Deno.exit(2);
}
const chromeArg = args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const { newPage, stop } = await startChrome(CHROME, "a11y-smoke-");

// --- the checks -------------------------------------------------------------------------------------

const VIEWS = ALL_VIEWS.filter((v) => v.kind === "module").map((v) => v.id); // a stored file draws nothing to link
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
  for (const e of document.querySelectorAll('[role=status],[role=alert],[role=log],[aria-live]')) if (e.id !== 'a11y-live') out.push('a second live region: ' + d(e)); // one region carries all speech
  let prev = 0; // headings go down one level at a time (the cards of Flat and Laws were h4 under the h2 "Diagram")
  for (const h of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) { const l = +h.tagName[1]; if (prev && l > prev + 1) out.push('heading level jumps from h' + prev + ' to ' + h.tagName.toLowerCase() + ': ' + h.textContent.trim().slice(0, 40)); prev = l; }
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
  const spoken = (await p.eval(LOG)).length;
  await p.press("Enter");
  await sleep(150);
  const lit = await p.eval(LIT);
  if (!lit) {
    // a view that draws no targets must say so and light nothing. Something else may be spoken meanwhile (the Laws
    // view's live check finishing says so while Laws is shown), so look at everything said since Enter, not the last line.
    const said: string[] = (await p.eval(LOG)).slice(spoken);
    ok(said.some((t) => /draws no/.test(t) || /No legal/.test(t)), "no lit target: the view says why", said.join(" / "));
    return;
  }
  ok(await p.eval(`document.body.classList.contains('snap-dragging')`), "Enter lights targets");
  // Said through the live region (every announcement is in __a11yLog); in Laws the live check may finish meanwhile and speak after it.
  const entered: string[] = (await p.eval(LOG)).slice(spoken);
  ok(entered.some((t) => /Linking from/.test(t)), "the live region announces link mode", entered.join(" / "));
  await p.press("Tab"); await sleep(60);
  ok((await p.eval(ACTIVE))?.legal, "Tab lands on a lit target");
  await p.press("ArrowRight"); await sleep(60);
  ok((await p.eval(ACTIVE))?.legal, "an arrow key stays on lit targets");
  await p.press("r"); await sleep(60);
  const refused = await p.eval(ACTIVE);
  const why: string[] = (await p.eval(LOG)).slice(-4);
  ok(refused && !refused.legal && why.some((t) => /refused/.test(t)), "R walks to a refused target and says why", why.join(" / "));
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
    ok(await p.waitFor(`/did not run/.test((document.querySelector('.lw-livetext') || {}).textContent || '')`, 15000), "Laws shows what its live check came to when it is drawn", where);
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
  await stop();
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
Deno.exit(failures ? 1 : 0);
