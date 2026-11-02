// Browser check of the editor's top bar (public/petri-menu-ui.js, petri-menu.js, docs/design/agent-first-analysis.md
// sections 3, 7, 8 and 9, Steps 4 and 5).
//
//   deno run -A scripts/menu-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome]
//
// In headless Chrome:
//   the bar            its contents and their order at 1280, 390 and 320 px; the three menus fold into one button on a
//                      narrow bar; nothing runs under the canvas toolbar, the run bar or the edge of the screen
//   the menus          File, View and Help open from the keyboard and the mouse; arrow keys, Home, End, type-ahead,
//                      Escape (focus goes back to the button), Tab, a click outside; ArrowRight moves to the next menu; every entry
//                      runs the method it should (signed out, and signed in with the server's files), links open where
//                      they should; the account line follows a sign-out
//   removed entries    each one's replacement: Analysis, Simulate, Structure, Components, Results and the questions
//                      dialog from Tools > Classic tools (each opens the dialog it always opened), the key 9, App view in
//                      View, Check net as the problems chip (its list, its Details button, a re-check after an edit,
//                      and after each command), Describe and the Assistant as the Ask input (Enter calls _openChat with
//                      the words, mode auto; focusing opens nothing; a pane that will not open keeps the words; signed
//                      out, nothing is requested from the model), the empty-canvas prompt opening the Ask pane in build
//   Tools              the button and Cmd-K (also from the Ask input); a run lands in the results pane with its footer,
//                      Open in Tools opens the form with the arguments filled in, a failed run stays in the palette;
//                      all of it with every /api/llm/* answered 503 and nothing requested from the model
//   ?ui=classic        the old hamburger with every entry it had, no bar, no Cmd-K, no chip; Help > Classic menu goes there
//   standalone         a <petri-view> with no data-backend (no page in public/ has one, so one is made) keeps the dropdown
//                      hamburger; removing data-backend from the editor swaps the bar for it
//
// It cannot sign in to GitHub, so a signed-in page has its fetch of /api/llm/status, /api/llm/turn, /auth/user and
// /api/files/status answered in the page (as landing-smoke.ts does): this proves what the bar does with the answers, and
// says nothing about the real sign-in or Gemini.
//
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure; scripts/smoke-gate.sh
// is the way to run it before a push, because it keeps the log and reads that status.
import { type Page, sleep, startChrome } from "./cdp.ts";

const url = Deno.args.find((a) => a.startsWith("http"));
if (!url) { console.error("usage: deno run -A scripts/menu-smoke.ts <url of /> [--chrome path]"); Deno.exit(2); }
const chromeArg = Deno.args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? Deno.args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { newPage, stop } = await startChrome(CHROME, "menu-smoke-");
let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};
const q = (s: string) => JSON.stringify(s);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// SIR with a transition (reset) that is not enabled while nothing has recovered, so a run of it can fail, and a net the
// check has nothing to say about (one black token, something enabled).
const NET = {
  "@context": "https://pflow.xyz/schema", "@type": "PetriNet", token: ["https://pflow.xyz/tokens/black"],
  places: { S: { "@type": "Place", initial: [45], capacity: [0], x: 100, y: 200 }, I: { "@type": "Place", initial: [5], capacity: [0], x: 300, y: 200 }, R: { "@type": "Place", initial: [0], capacity: [0], x: 500, y: 200 } },
  transitions: { infect: { "@type": "Transition", x: 200, y: 200, rate: 0.01 }, recover: { "@type": "Transition", x: 400, y: 200, rate: 0.1 }, reset: { "@type": "Transition", x: 300, y: 320, rate: 0.05 } },
  arcs: [["S", "infect"], ["I", "infect"], ["infect", "I"], ["I", "recover"], ["recover", "R"], ["R", "reset"], ["reset", "S"]].map(([source, target]) => ({ "@type": "Arrow", source, target, weight: [1] })),
};
// An arc to a place that is not there: the editor repairs it on load, and says so.
const BAD_NET = { ...NET, arcs: [...NET.arcs, { "@type": "Arrow", source: "S", target: "nowhere", weight: [1] }] };

/** Before any script: the account, the files and the model's route answered here, and what was asked of them kept. */
const STUB = (o: { signedIn?: boolean; files?: boolean; chat?: boolean; llm503?: boolean; llm401?: boolean } = {}) => `
  window.__reqs = [];
  window.__opened = [];
  window.open = (...a) => { window.__opened.push(a); return null; };
  try { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('pflow_skip_landing', '1'); ${o.signedIn ? "localStorage.setItem('pflow_auth_token', 'smoke-token');" : ""} } catch {}
  const real = window.fetch;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (u, opts) => {
    const path = new URL(String(u?.url ?? u), location.href).pathname;
    const bearer = new Headers(opts?.headers).get('Authorization') === 'Bearer smoke-token';
    if (path.startsWith('/api/llm/') || path === '/auth/user' || path === '/api/files/status') window.__reqs.push({ path, bearer });
    if (path === '/api/files/status') return json({ enabled: ${!!o.files} });
    if (path.startsWith('/api/llm/') && ${!!o.llm503}) return json({ error: 'unavailable' }, 503);
    if (path.startsWith('/api/llm/') && ${!!o.llm401}) return json({ error: 'sign in' }, 401);
    if (path === '/api/llm/status') return json(bearer ? { enabled: true, chat: ${o.chat !== false}, signed_in: true, allowed: true, model: 'smoke', remaining_today: 7 } : { enabled: true, chat: ${o.chat !== false}, signed_in: false });
    if (path === '/auth/user') return bearer ? json({ user: { id: '1', email: 'smoke@example.com', user_name: 'smoke', full_name: 'Smoke' } }) : new Response('{}', { status: 401 });
    if (path === '/api/llm/turn') return bearer ? json({ reply: 'smoke reply', tool_calls: [], message: { role: 'model', parts: [{ text: 'smoke reply' }] }, remaining_today: 6, mode: 'analyse' }) : new Response('{"error":"sign in"}', { status: 401 });
    return real(u, opts);
  };`;

async function open(path: string, o: Parameters<typeof STUB>[0] = {}, width = 1280, height = 800, phone = false, before = ""): Promise<Page> {
  const p = await newPage(width, height);
  if (phone) {
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    await p.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  }
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB(o) + before });
  await p.goto(new URL(path, url).href);
  await p.waitFor("!!document.querySelector('petri-view .pv-root')");
  return p;
}
/** The editor is up with the bar mounted and its first check answered. */
const barUp = (p: Page) => p.waitFor("!!document.querySelector('.pv-appbar .pv-problems-chip') && document.querySelector('.pv-problems-label')?.textContent !== 'Checking…'", 30000);
const setNet = (p: Page, net: unknown) => p.eval(`document.querySelector('petri-view').setModel(${JSON.stringify(net)})`);

async function key(p: Page, k: string, code: string, vk: number, modifiers = 0, text?: string) {
  await p.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, text });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(60);
}
const KEYS = {
  Enter: ["Enter", "Enter", 13, "\r"], Escape: ["Escape", "Escape", 27], Tab: ["Tab", "Tab", 9], Home: ["Home", "Home", 36], End: ["End", "End", 35],
  ArrowDown: ["ArrowDown", "ArrowDown", 40], ArrowUp: ["ArrowUp", "ArrowUp", 38], ArrowRight: ["ArrowRight", "ArrowRight", 39], ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
} as Record<string, [string, string, number, string?]>;
const press = (p: Page, name: string, modifiers = 0) => { const [k, c, v, t] = KEYS[name]; return key(p, k, c, v, modifiers, t); };
const chord = (p: Page) => key(p, "k", "KeyK", 75, 2); // Ctrl-K
const typeText = async (p: Page, t: string) => { await p.send("Input.insertText", { text: t }); await sleep(120); };

// ---- what is on the page ----
const rect = (p: Page, sel: string) => p.eval(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return r.width && r.height ? { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } : null; })()`);
const menuItems = (p: Page) => p.eval(`[...document.querySelectorAll('.pv-appmenu-pop [role=menuitem]')].map((e) => e.dataset.label)`);
const popOpen = (p: Page) => p.eval(`!!document.querySelector('.pv-appmenu-pop')`);
const focusLabel = (p: Page) => p.eval(`document.activeElement?.dataset?.label ?? (document.activeElement?.dataset?.menu ? 'button:' + document.activeElement.dataset.menu : document.activeElement?.tagName)`);
const expanded = (p: Page, id: string) => p.eval(`document.querySelector('[data-menu=${id}]').getAttribute('aria-expanded')`);
const openMenu = async (p: Page, id: string) => { await p.eval(`document.querySelector('[data-menu=${id}]').click()`); await p.waitFor("!!document.querySelector('.pv-appmenu-pop')", 3000); };
const clickItem = async (p: Page, menu: string, label: string) => {
  await openMenu(p, menu);
  await p.eval(`[...document.querySelectorAll('.pv-appmenu-pop [role=menuitem]')].find((e) => e.dataset.label === ${q(label)}).click()`);
  await sleep(120);
};
const closeDialogs = (p: Page) => p.eval(`(() => { document.querySelectorAll('.pv-modal-overlay').forEach((o) => o.remove()); const v = document.querySelector('petri-view'); v._simulationDialog = null; })()`);
const dialogLabel = (p: Page, sel: string) => p.waitFor(`!!document.querySelector(${q(sel)})`, 15000);

try {
  // =========================================================================================================
  console.log("the bar at 1280x800, signed out");
  {
    const p = await open("/", { files: false });
    ok(await barUp(p), "the bar mounts and the problems chip answers");
    ok(await p.eval(`document.querySelector('petri-view').dataset.ui === 'bar'`), "the view says it is in bar mode (data-ui=bar)");
    ok(await p.eval(`!document.querySelector('.pv-hamburger-btn') && !document.querySelector('.pv-hamburger-overlay')`), "no hamburger button and no hamburger panel");
    ok(await p.eval(`document.querySelector('.pv-ask-input').placeholder === 'Ask about this net, or say what to change...'`), "the Ask input has the placeholder", await p.eval(`document.querySelector('.pv-ask-input').placeholder`));
    ok(await p.eval(`!!document.querySelector('.pv-ask[role=search]') && document.querySelector('.pv-ask-input').getAttribute('aria-label').startsWith('Ask')`), "the Ask form is a search landmark and the input is labelled");
    const order = [".pv-ask", "[data-menu=file]", "[data-menu=view]", "[data-menu=help]", ".pv-appbar-tools", ".pv-appbar-problems .pv-problems-chip", ".pv-appbar > .pv-top-right-btn"];
    const rects = [];
    for (const s of order) rects.push(await rect(p, s));
    ok(rects.every(Boolean), "Ask, File, View, Help, Tools, the chip and the account button are all showing", order.filter((_, i) => !rects[i]).join());
    if (rects.every(Boolean)) {
      for (let i = 1; i < rects.length; i++) ok(rects[i]!.l >= rects[i - 1]!.r - 0.5, `${order[i]} is to the right of ${order[i - 1]}`, `${rects[i]!.l} < ${rects[i - 1]!.r}`);
      ok(rects.every((r) => Math.abs((r!.t + r!.b) / 2 - 30) < 4), "all on one row");
      ok(rects[6]!.r <= 1280 && rects[0]!.l >= 130, "inside the window, clear of the logo", `${rects[0]!.l}..${rects[6]!.r}`);
    }
    ok(await p.eval(`document.querySelector('[data-menu=file]').getAttribute('aria-haspopup') === 'menu' && ['file','view','help'].every((m) => document.querySelector('[data-menu=' + m + ']').getAttribute('aria-expanded') === 'false')`), "File, View and Help are menu buttons, closed");
    ok(await p.eval(`document.querySelector('.pv-appbar-tools').textContent.includes('Tools') && ['Control+K', 'Meta+K'].includes(document.querySelector('.pv-appbar-tools').getAttribute('aria-keyshortcuts'))`), "Tools shows the shortcut");
    ok(await p.eval(`document.querySelector('.pv-problems-label').textContent === 'No problems'`), "the chip says No problems for a net with none", await p.eval(`document.querySelector('.pv-problems-label').textContent`));
    ok(await p.eval(`document.querySelector('.pv-appbar > .pv-top-right-btn').textContent.includes('Login')`), "the account button offers Login");
    const bar = await rect(p, ".pv-appbar"), tb = await rect(p, ".pv-mode-menu"), scale = await rect(p, ".pv-scale-meter");
    ok(bar && tb && bar.b < tb.t, "the bar is above the canvas toolbar", `${bar?.b} vs ${tb?.t}`);
    ok(bar && scale && bar.b <= scale.t, "and above the zoom slider");
    ok(await p.eval(`document.documentElement.scrollWidth <= innerWidth`), "no sideways scroll");
    ok(await p.eval(`!document.querySelector('.pv-appmenu-more') || getComputedStyle(document.querySelector('.pv-appmenu-more')).display === 'none'`), "the overflow button is not showing: there is room for three menus");
    ok(await p.eval(`getComputedStyle(document.querySelector('.pv-appbar')).pointerEvents === 'none'`), "the gaps between controls are the canvas's (pointer-events)");
    const probs = p.problems.filter((x: string) => !/\/img\/z\w+\.svg/.test(x));
    ok(probs.length === 0, "no script errors, no failed requests", probs.slice(0, 3).join(" | "));
    await p.close();
  }

  // =========================================================================================================
  for (const [w, h] of [[390, 844], [320, 568], [430, 739]]) {
    console.log(`the bar on a phone, ${w}x${h}`);
    const p = await open("/", {}, w, h, true);
    ok(await barUp(p), `${w}: the bar mounts`);
    const rs: Record<string, any> = {};
    for (const [n, s] of Object.entries({ ask: ".pv-ask", input: ".pv-ask-input", go: ".pv-ask-go", more: "[data-menu=more]", file: "[data-menu=file]", tools: ".pv-appbar-tools", chip: ".pv-appbar-problems .pv-problems-chip", login: ".pv-appbar > .pv-top-right-btn", bar: ".pv-appbar", run: ".pv-run-bar" })) rs[n] = await rect(p, s);
    ok(rs.file === null, `${w}: the three menu buttons are folded away`);
    ok(rs.more && rs.ask && rs.tools && rs.chip && rs.login, `${w}: Ask, the overflow button, Tools, the chip and the account button are showing`, Object.keys(rs).filter((k) => !rs[k]).join());
    if (rs.more && rs.ask && rs.tools && rs.chip) {
      ok(rs.ask.r <= rs.more.l && rs.more.r <= rs.tools.l && rs.tools.r <= rs.chip.l + 0.5, `${w}: in order, none on another`, JSON.stringify([rs.ask.r, rs.more.l, rs.more.r, rs.tools.l, rs.tools.r, rs.chip.l].map(Math.round)));
      ok(rs.input.w >= 90, `${w}: the Ask input keeps a usable width`, String(Math.round(rs.input.w)));
      ok(rs.chip.r <= w - 4 && rs.ask.l >= 4, `${w}: inside the screen`, `${rs.ask.l}..${rs.chip.r} of ${w}`);
      ok(rs.go.w >= 28 && rs.go.h >= 28, `${w}: the Ask button is still a target`, `${rs.go.w}x${rs.go.h}`);
      ok(Math.abs(rs.ask.t - rs.more.t) < 4 || Math.abs((rs.ask.t + rs.ask.b) / 2 - (rs.more.t + rs.more.b) / 2) < 4, `${w}: Ask and the buttons share a row`);
    }
    ok(rs.login && rs.bar && rs.login.b <= rs.bar.t + 1, `${w}: the account button is on the row above the bar (the logo's row)`, `${rs.login?.b} vs ${rs.bar?.t}`);
    ok(rs.login && rs.login.r <= w - 4, `${w}: and inside the screen`);
    ok(rs.bar && rs.run && rs.bar.b <= rs.run.t, `${w}: the bar is clear of the run bar`, `${rs.bar?.b} vs ${rs.run?.t}`);
    ok(await p.eval(`document.documentElement.scrollWidth <= innerWidth`), `${w}: no sideways scroll`);
    ok(await p.eval(`!document.querySelector('.pv-appbar .pv-tools-kbd') || getComputedStyle(document.querySelector('.pv-appbar .pv-tools-kbd')).display === 'none'`), `${w}: no shortcut hint on a phone`);
    ok(await p.eval(`document.querySelector('.pv-problems-chip').getAttribute('aria-label').includes('problems')`), `${w}: the chip keeps its name though its label is hidden`);
    // the overflow menu: all three menus in one sheet, inside the screen
    await p.eval(`document.querySelector('[data-menu=more]').click()`);
    ok(await p.waitFor("!!document.querySelector('.pv-appmenu-pop')", 3000), `${w}: the overflow button opens the menu`);
    const pop = await rect(p, ".pv-appmenu-pop");
    ok(pop && pop.l >= 0 && pop.r <= w && pop.b <= h, `${w}: the menu is inside the screen`, JSON.stringify(pop));
    ok(await p.eval(`[...document.querySelectorAll('.pv-appmenu-head')].map((e) => e.textContent).join() === 'File,View,Help'`), `${w}: File, View and Help sections`);
    const items = await menuItems(p);
    ok(items.includes("Save Permalink") && items.includes("Layout Algorithms") && items.includes("Help") && items.includes("Classic menu (this release)"), `${w}: it holds the three menus' entries`, items.join());
    ok(await p.eval(`document.querySelector('.pv-appmenu-pop').getAttribute('role') === 'menu' && document.querySelector('[data-menu=more]').getAttribute('aria-expanded') === 'true'`), `${w}: a menu, and the button says it is open`);
    await press(p, "Escape");
    ok(!(await popOpen(p)) && (await focusLabel(p)) === "button:more", `${w}: Escape closes it and gives focus back to the button`, await focusLabel(p));
    await p.close();
  }

  // =========================================================================================================
  console.log("the menus: keyboard and mouse (signed out)");
  {
    const p = await open("/", { files: false });
    await barUp(p);
    await p.eval(`document.querySelector('[data-menu=file]').focus()`);
    await press(p, "Enter");
    ok(await popOpen(p) && (await expanded(p, "file")) === "true", "Enter on File opens it, aria-expanded true");
    ok(await p.eval(`document.querySelector('[data-menu=file]').getAttribute('aria-controls') === document.querySelector('.pv-appmenu-pop').id`), "aria-controls names the menu");
    ok(same(await menuItems(p), ["Save Permalink", "Delete", "Download JSON", "Login with GitHub"]), "File, signed out and with no server files, lists four entries", (await menuItems(p)).join());
    ok(await p.eval(`document.querySelector('.pv-appmenu-pop').getAttribute('aria-label') === 'File'`), "the menu is named File");
    ok(await focusLabel(p) === "Save Permalink", "focus is on the first row", await focusLabel(p));
    await press(p, "ArrowDown");
    ok(await focusLabel(p) === "Delete", "ArrowDown moves down");
    await press(p, "End");
    ok(await focusLabel(p) === "Login with GitHub", "End goes to the last row");
    await press(p, "ArrowDown");
    ok(await focusLabel(p) === "Save Permalink", "ArrowDown wraps");
    await press(p, "ArrowUp");
    ok(await focusLabel(p) === "Login with GitHub", "ArrowUp wraps");
    await press(p, "Home");
    ok(await focusLabel(p) === "Save Permalink", "Home goes to the first row");
    await key(p, "d", "KeyD", 68, 0, "d");
    ok(await focusLabel(p) === "Delete", "type-ahead: d goes to Delete", await focusLabel(p));
    await key(p, "d", "KeyD", 68, 0, "d");
    ok(await focusLabel(p) === "Download JSON", "type-ahead: d again goes to Download JSON", await focusLabel(p));
    await press(p, "ArrowRight");
    ok((await expanded(p, "view")) === "true" && (await expanded(p, "file")) === "false", "ArrowRight opens the next menu (View) and closes File");
    ok(same(await menuItems(p), ["Layout Algorithms", "Display Settings", "Toggle JSON editor", "Open as app", "Compose"]), "View lists its five entries", (await menuItems(p)).join());
    await press(p, "ArrowRight");
    ok((await expanded(p, "help")) === "true", "and again: Help");
    ok(same(await menuItems(p), ["Help", "Sim — Run & Check", "Book", "Native App", "GitHub", "Classic menu (this release)", `v${await p.eval(`document.querySelector('petri-view').constructor.VERSION`)}`]), "Help lists its entries and the version", (await menuItems(p)).join());
    await press(p, "ArrowRight");
    ok((await expanded(p, "file")) === "true", "ArrowRight wraps round to File");
    await press(p, "ArrowLeft");
    ok((await expanded(p, "help")) === "true", "ArrowLeft goes back");
    await press(p, "Escape");
    ok(!(await popOpen(p)) && (await focusLabel(p)) === "button:help", "Escape closes it and focus is back on the button that opened it", await focusLabel(p));
    ok((await expanded(p, "help")) === "false", "aria-expanded is false again");
    // ArrowDown on the button opens it on the first row; ArrowUp on the last
    await p.eval(`document.querySelector('[data-menu=view]').focus()`);
    await press(p, "ArrowUp");
    ok(await focusLabel(p) === "Compose", "ArrowUp on the button opens the menu on its last row", await focusLabel(p));
    await press(p, "Tab");
    ok(!(await popOpen(p)), "Tab closes the menu");
    await p.eval(`document.querySelector('[data-menu=view]').focus()`);
    await press(p, "ArrowDown");
    ok(await focusLabel(p) === "Layout Algorithms", "ArrowDown on the button opens the menu on its first row");
    // the editor's own keys stay out of an open menu
    const mode0 = await p.eval(`document.querySelector('petri-view')._mode`);
    await key(p, "3", "Digit3", 51, 0, "3");
    await key(p, "x", "KeyX", 88, 0, "x");
    ok((await p.eval(`document.querySelector('petri-view')._mode`)) === mode0, "the digit keys do not change the editor's mode while a menu has focus", `${mode0} -> ${await p.eval(`document.querySelector('petri-view')._mode`)}`);
    ok(await p.eval(`!document.querySelector('petri-view')._simRunning`), "and x does not start the simulation");
    // a click outside closes
    await p.click(640, 300);
    ok(!(await popOpen(p)), "a click outside closes it");
    ok(await p.eval(`document.querySelector('[data-menu=view]').getAttribute('aria-expanded') === 'false'`), "and the button says closed");
    // a second click on the button closes it
    await p.eval(`document.querySelector('[data-menu=help]').click()`);
    ok(await popOpen(p), "a click on Help opens it");
    await p.eval(`document.querySelector('[data-menu=help]').click()`);
    ok(!(await popOpen(p)), "a second click on it closes it");
    // one menu at a time
    await p.eval(`document.querySelector('[data-menu=file]').click()`);
    await p.eval(`document.querySelector('[data-menu=view]').click()`);
    ok((await p.eval(`document.querySelectorAll('.pv-appmenu-pop').length`)) === 1, "opening View closes File: one menu at a time");
    // a menu is above everything the editor stacks
    const pop = await rect(p, ".pv-appmenu-pop");
    const hit = await p.eval(`(() => { const r = document.querySelector('.pv-appmenu-pop').getBoundingClientRect(); const e = document.elementFromPoint(r.left + 20, r.top + 20); return !!e.closest('.pv-appmenu-pop'); })()`);
    ok(pop && hit, "a menu is on top where it is drawn");
    await press(p, "Escape");
    await p.close();
  }

  // =========================================================================================================
  console.log("the menus: every entry runs what it should");
  {
    const p = await open("/", { files: true, signedIn: true });
    await barUp(p);
    ok(await p.waitFor(`document.querySelector('.pv-appbar > .pv-top-right-btn')?.textContent.includes('smoke')`, 10000), "signed in: the account button shows the name", await p.eval(`document.querySelector('.pv-appbar > .pv-top-right-btn')?.textContent`));
    await openMenu(p, "file");
    const signedIn = await menuItems(p);
    ok(same(signedIn, ["Save to Server", "Delete", "Save to my account…", "Open from my account…", "Share", "Save As Gist", "My Diagrams", "Edit Details", "Download JSON", "Logout"]), "File, signed in and with server files: all ten entries, in the hamburger's order", signedIn.join());
    ok(await p.eval(`document.querySelector('.pv-appmenu-pop .pv-hamburger-user-info')?.textContent === 'Logged in as: smoke@example.com'`), "the user line says who is signed in", await p.eval(`document.querySelector('.pv-appmenu-pop .pv-hamburger-user-info')?.textContent`));
    await press(p, "Escape");
    // spy on every method an entry runs
    await p.eval(`(() => { const v = document.querySelector('petri-view'); window.__called = []; for (const m of ['_saveToPermalink','_deleteData','_showAccountSaveDialog','_showAccountFilesDialog','_showShareDialog','_saveAsGist','_showMyDiagramsDialog','_showEditDetailsDialog','downloadJSON','_showLayoutAlgorithmsDialog','_showDisplaySettingsDialog','_openAppView','_showHelpDialog','_loginWithGitHub']) v[m] = (...a) => { window.__called.push(m); }; })()`);
    const EXPECT: [string, string, string][] = [
      ["file", "Save to Server", "_saveToPermalink"], ["file", "Delete", "_deleteData"], ["file", "Save to my account…", "_showAccountSaveDialog"],
      ["file", "Open from my account…", "_showAccountFilesDialog"], ["file", "Share", "_showShareDialog"], ["file", "Save As Gist", "_saveAsGist"],
      ["file", "My Diagrams", "_showMyDiagramsDialog"], ["file", "Edit Details", "_showEditDetailsDialog"], ["file", "Download JSON", "downloadJSON"],
      ["view", "Layout Algorithms", "_showLayoutAlgorithmsDialog"], ["view", "Display Settings", "_showDisplaySettingsDialog"], ["view", "Open as app", "_openAppView"],
      ["help", "Help", "_showHelpDialog"],
    ];
    for (const [menu, label, method] of EXPECT) {
      await p.eval(`window.__called.length = 0`);
      await clickItem(p, menu, label);
      ok(same(await p.eval(`window.__called`), [method]), `${menu} > ${label} runs ${method}`, JSON.stringify(await p.eval(`window.__called`)));
      ok(!(await popOpen(p)), `${menu} > ${label} closes the menu`);
    }
    // the JSON editor toggles
    const had = await p.eval(`document.querySelector('petri-view').hasAttribute('data-json-editor')`);
    await clickItem(p, "view", "Toggle JSON editor");
    const flipped = await p.eval(`document.querySelector('petri-view').hasAttribute('data-json-editor')`);
    await clickItem(p, "view", "Toggle JSON editor");
    ok(had !== flipped && (await p.eval(`document.querySelector('petri-view').hasAttribute('data-json-editor')`)) === had, "View > Toggle JSON editor turns the editor off and on", `${had} ${flipped}`);
    // links
    for (const [menu, label, href, features] of [
      ["help", "Sim — Run & Check", "https://sim.pflow.xyz", "noopener,noreferrer"], ["help", "Book", "https://book.pflow.xyz", "noopener,noreferrer"],
      ["help", "Native App", "https://github.com/pflow-xyz/pflow-native", "noopener,noreferrer"], ["help", "GitHub", "https://github.com/pflow-xyz/pflow-xyz", "noopener,noreferrer"],
      ["view", "Compose", "/compose.html", "noopener"],
    ]) {
      await p.eval(`window.__opened.length = 0`);
      await clickItem(p, menu, label);
      ok(same(await p.eval(`window.__opened`), [[href, "_blank", features]]), `${menu} > ${label} opens ${href} in a new tab`, JSON.stringify(await p.eval(`window.__opened`)));
    }
    ok(await p.eval(`(async () => { await document.querySelector('[data-menu=help]').click(); const a = document.querySelector('.pv-appmenu-pop a.pv-menu-version'); const ok = !!a && a.href.endsWith('/releases/tag/v' + document.querySelector('petri-view').constructor.VERSION) && a.target === '_blank' && a.rel.includes('noopener'); document.querySelector('[data-menu=help]').click(); return ok; })()`), "the version at the foot of Help links to its release");
    // a long account name is cut with an ellipsis and stays inside the bar
    await p.eval(`(() => { const v = document.querySelector('petri-view'); v._user = { id: '1', email: '', user_metadata: { user_name: 'a-really-rather-long-github-login-name-1234567890' } }; v._topRightButton.remove(); v._topRightButton = null; v._createTopRightButton(); })()`);
    const acct = await rect(p, ".pv-appbar > .pv-top-right-btn"), barR = await rect(p, ".pv-appbar"), toolsR = await rect(p, ".pv-appbar-tools");
    ok(acct && barR && acct.r <= barR.r + 0.5 && acct.w <= 181 && toolsR && toolsR.r <= acct.l, "a long account name does not run under the menus or out of the bar", JSON.stringify([acct, barR]));
    ok(await p.eval(`getComputedStyle(document.querySelector('.pv-appbar > .pv-top-right-btn')).textOverflow === 'ellipsis'`), "and ends in an ellipsis");
    await p.eval(`(() => { const v = document.querySelector('petri-view'); v._user = { id: '1', email: 'smoke@example.com', user_metadata: { user_name: 'smoke' } }; v._topRightButton.remove(); v._topRightButton = null; v._createTopRightButton(); })()`);
    // sign out: the account line goes, Login comes
    await clickItem(p, "file", "Logout");
    ok(await p.waitFor(`document.querySelector('.pv-appbar > .pv-top-right-btn')?.textContent.includes('Login')`, 5000), "Logout: the account button offers Login again");
    await openMenu(p, "file");
    const out = await menuItems(p);
    ok(out.includes("Login with GitHub") && !out.includes("Logout") && !out.includes("Share") && out.includes("Save Permalink") && out.includes("Save to my account…"), "and File follows: Login, no Share, a permalink, the account files still offered", out.join());
    await press(p, "Escape");
    await p.eval(`window.__called.length = 0`);
    await clickItem(p, "file", "Login with GitHub");
    ok(same(await p.eval(`window.__called`), ["_loginWithGitHub"]), "File > Login with GitHub runs the sign-in");
    const probs = p.problems.filter((x: string) => !/\/img\/z\w+\.svg/.test(x));
    ok(probs.length === 0, "no script errors", probs.slice(0, 3).join(" | "));
    await p.close();
  }

  // =========================================================================================================
  console.log("the empty states of the menus");
  {
    // signed in, but the server keeps no files: the account files stay out
    const p = await open("/", { files: false, signedIn: true });
    await barUp(p);
    await p.waitFor(`document.querySelector('.pv-appbar > .pv-top-right-btn')?.textContent.includes('smoke')`, 10000);
    await openMenu(p, "file");
    ok(same(await menuItems(p), ["Save to Server", "Delete", "Share", "Save As Gist", "My Diagrams", "Edit Details", "Download JSON", "Logout"]), "signed in with no server files: no Save to / Open from my account", (await menuItems(p)).join());
    await p.close();
  }

  // =========================================================================================================
  console.log("Tools: the button, Cmd-K, and what a run does (every /api/llm/* answered 503)");
  {
    const p = await open("/", { llm503: true });
    await barUp(p);
    await setNet(p, NET);
    ok(await p.eval(`!!document.querySelector('petri-view')._unbindPaletteKey`), "the chord is bound once, by the bar");
    await p.eval(`document.querySelector('.pv-appbar-tools').click()`);
    ok(await p.waitFor("!!document.querySelector('.pv-palette')", 10000), "the Tools button opens the palette");
    await press(p, "Escape");
    ok(await p.eval(`!document.querySelector('.pv-palette')`), "Escape closes it");
    await chord(p);
    ok(await p.waitFor("!!document.querySelector('.pv-palette')", 10000), "Ctrl-K opens it");
    await chord(p);
    ok(await p.eval(`!document.querySelector('.pv-palette')`), "Ctrl-K again closes it, once (the chord is not bound twice)");
    // from the Ask input too, but not from some other text field
    await p.eval(`document.querySelector('.pv-ask-input').focus()`);
    await chord(p);
    ok(await p.waitFor("!!document.querySelector('.pv-palette')", 10000), "Ctrl-K in the Ask input opens it");
    await press(p, "Escape");
    ok(await p.eval(`document.activeElement === document.querySelector('.pv-ask-input')`), "and focus goes back to the Ask input when it closes", await p.eval(`document.activeElement.className`));
    await p.eval(`(() => { const t = document.createElement('input'); t.type = 'text'; t.id = 'plain'; document.body.appendChild(t); t.focus(); })()`);
    await chord(p);
    await sleep(300);
    ok(await p.eval(`!document.querySelector('.pv-palette')`), "Ctrl-K in another text field is left alone");
    await p.eval(`document.getElementById('plain').remove(); document.activeElement.blur()`);

    // run a command: it lands in the results pane, with the footer
    await chord(p);
    await p.waitFor("!!document.querySelector('.pv-palette')");
    await typeText(p, "sim.ssa");
    await press(p, "Enter");
    await p.waitFor("!document.querySelector('[data-pane=form]').hidden");
    await p.eval(`(() => { document.querySelector('[data-field=t_end]').value = '12'; document.querySelector('[data-field=runs]').value = '4'; document.querySelector('[data-act=run]').click(); })()`);
    ok(await p.waitFor("!!document.querySelector('.pv-result-dialog .pv-prov')", 20000), "the run lands in the results pane, with the How this was computed footer");
    ok(await p.eval(`!document.querySelector('.pv-palette')`), "and the palette is gone");
    ok(await p.eval(`document.querySelector('.pv-result-dialog .pv-prov').textContent.includes('sim.ssa') && document.querySelector('.pv-result-dialog .pv-prov').textContent.includes('"runs":4')`), "the footer names the call and its arguments");
    ok(await p.eval(`!!document.querySelector('.pv-result-dialog svg')`), "the evidence is drawn (a plot)");
    ok(await p.eval(`[...document.querySelectorAll('.pv-result-dialog .pv-prov-acts button')].map((b) => b.dataset.act).join() === 'rerun,edit,mcp,link,tools'`), "the footer has its five actions");
    // Open in Tools: the form, filled in
    await p.eval(`document.querySelector('.pv-result-dialog [data-act=tools]').click()`);
    ok(await p.waitFor("!!document.querySelector('.pv-palette') && !document.querySelector('[data-pane=form]').hidden", 10000), "Open in Tools opens the palette on a form");
    const f = await p.eval(`(() => { const pane = document.querySelector('[data-pane=form]'); return { title: pane.querySelector('h3').textContent, t_end: pane.querySelector('[data-field=t_end]').value, runs: pane.querySelector('[data-field=runs]').value, code: pane.querySelector('.pv-palette-form-sub code')?.textContent }; })()`);
    ok(f.code === "sim.ssa" && f.title === "Run SSA", "the form is the command's", JSON.stringify(f));
    ok(f.t_end === "12" && f.runs === "4", "with the arguments it was run with filled in", JSON.stringify(f));
    await p.eval(`document.querySelectorAll('.pv-result-dialog').forEach((d) => d.closest('.pv-modal-overlay').remove())`);
    await p.eval(`document.querySelector('[data-act=run]').click()`);
    ok(await p.waitFor("document.querySelectorAll('.pv-result-dialog .pv-prov').length === 1 && !document.querySelector('.pv-palette')", 20000), "Run on the filled-in form lands a second result");
    ok(await p.eval(`document.querySelector('.pv-result-dialog .pv-prov').textContent.includes('"runs":4')`), "with the same arguments");
    await p.eval(`document.querySelectorAll('.pv-modal-overlay').forEach((o) => o.remove())`);

    // a run that fails outright stays in the palette, error beside the form
    await chord(p);
    await p.waitFor("!!document.querySelector('.pv-palette')");
    await typeText(p, "sim.fire");
    await press(p, "Enter");
    await p.waitFor("!document.querySelector('[data-pane=form]').hidden");
    await p.eval(`(() => { document.querySelector('[data-field=id]').value = 'reset'; document.querySelector('[data-act=run]').click(); })()`);
    ok(await p.waitFor("document.querySelector('.pv-structure-status')?.textContent.startsWith('Stopped')", 15000), "a command that fails says so in the palette", await p.eval(`document.querySelector('.pv-structure-status')?.textContent`));
    ok(await p.eval(`!!document.querySelector('.pv-palette') && !document.querySelector('.pv-result-dialog')`), "it is not handed to the results pane: there is no answer to show, and the form is where it gets fixed");
    ok(await p.eval(`document.querySelector('[data-pane=form]').textContent.includes('not enabled')`), "the reason is on the page");
    await press(p, "Escape");
    await p.eval(`document.querySelectorAll('.pv-modal-overlay').forEach((o) => o.remove())`);

    // a question runs from the palette and lands in the same place
    await chord(p);
    await p.waitFor("!!document.querySelector('.pv-palette')");
    await typeText(p, "which engine");
    await press(p, "Enter");
    await p.waitFor("!document.querySelector('[data-pane=form]').hidden");
    await p.eval(`document.querySelector('[data-act=run]').click()`);
    ok(await p.waitFor("!!document.querySelector('.pv-result-dialog .pv-prov')", 20000), "a question (Which engine?) lands in the results pane too");
    ok(await p.eval(`document.querySelector('.pv-result-dialog .pv-prov').textContent.includes('sim.recommend')`), "its footer lists the calls the question made");
    await p.eval(`document.querySelectorAll('.pv-modal-overlay').forEach((o) => o.remove())`);

    const reqs = await p.eval(`window.__reqs`);
    ok(reqs.filter((r: any) => r.path === "/api/llm/turn").length === 0, "nothing was requested from the model (/api/llm/turn)", JSON.stringify(reqs));
    const probs = p.problems.filter((x: string) => !/\/img\/z\w+\.svg/.test(x));
    ok(probs.length === 0, "no script errors", probs.slice(0, 3).join(" | "));
    await p.close();
  }

  console.log("Tools with every /api/llm/* answered 401");
  {
    const p = await open("/", { llm401: true });
    await barUp(p);
    await setNet(p, NET);
    await chord(p);
    ok(await p.waitFor("!!document.querySelector('.pv-palette')", 10000), "the palette opens");
    await typeText(p, "sim.marking");
    await press(p, "Enter");
    await p.waitFor("!document.querySelector('[data-pane=form]').hidden");
    await p.eval(`document.querySelector('[data-act=run]').click()`);
    ok(await p.waitFor("!!document.querySelector('.pv-result-dialog .pv-prov')", 15000), "a run lands in the results pane with its footer");
    ok(await p.eval(`document.querySelector('.pv-result-dialog .pv-prov').textContent.includes('sim.marking')`), "naming its call");
    ok(await p.eval(`!window.__reqs.some((r) => r.path === '/api/llm/turn')`), "and nothing was requested from the model");
    await p.close();
  }

  // =========================================================================================================
  console.log("Classic tools: the dialogs the menu used to open, from the palette");
  {
    const p = await open("/", { llm503: true });
    await barUp(p);
    await setNet(p, NET);
    const CLASSIC: [string, string, string][] = [
      ["Analysis (ODE, scans, phase)", ".pv-analysis-main", "Analysis"],
      ["Simulate (stochastic, influence, what-if)", "[role=dialog][aria-label='Simulate']", "Simulate"],
      ["Structure (invariants, verify, reach)", "[role=dialog][aria-label='Structure']", "Structure"],
      ["Components", "[role=dialog][aria-label='Components']", "Components"],
      ["Results", "[role=dialog][aria-label='Results']", "Results"],
      ["What do you want to know?", "[role=dialog][aria-label='What do you want to know?']", "Goals"],
      ["Check net details", "[role=dialog][aria-label='Check net']", "Check net details"],
    ];
    for (const [title, dialog, what] of CLASSIC) {
      await chord(p);
      await p.waitFor("!!document.querySelector('.pv-palette')");
      await p.eval(`document.querySelector('.pv-palette-search').focus()`);
      await typeText(p, title.split(" (")[0]);
      const found = await p.eval(`(() => { const r = [...document.querySelectorAll('.pv-palette [role=option]')].find((x) => x.querySelector('.pv-palette-title').textContent === ${q(title)} && x.querySelector('.pv-palette-sub')?.textContent === 'Classic dialog'); if (!r) return false; r.click(); return true; })()`);
      ok(found, `${what}: Tools > Classic tools has an entry titled "${title}"`);
      ok(await dialogLabel(p, dialog), `${what}: it opens the dialog the menu entry opened (${dialog})`);
      ok(await p.eval(`!document.querySelector('.pv-palette')`), `${what}: the palette closes behind it`);
      await closeDialogs(p);
    }
    // the key 9 still opens Analysis
    await p.eval(`document.activeElement.blur()`);
    await key(p, "9", "Digit9", 57, 0, "9");
    ok(await dialogLabel(p, ".pv-analysis-main"), "the key 9 still opens Analysis");
    await closeDialogs(p);
    // App view is in View
    await clickItem(p, "view", "Open as app");
    ok(await p.waitFor("!!document.querySelector('.pv-appview')", 15000), "View > Open as app opens the App view");
    ok(await p.eval(`!document.querySelector('[data-menu=view]') || true`), "(the App view is no longer a menu entry of its own)");
    await p.close();
  }

  // =========================================================================================================
  console.log("Check net: the problems chip");
  {
    const p = await open("/", { llm503: true });
    await barUp(p);
    await setNet(p, NET);
    ok(await p.waitFor(`document.querySelector('.pv-problems-label').textContent === 'No problems'`, 10000), "a clean net: No problems");
    // a load that had to repair something: the chip counts it, the toast points at the chip
    await setNet(p, BAD_NET);
    ok(await p.waitFor(`/^\\d+ problems?$/.test(document.querySelector('.pv-problems-label').textContent)`, 15000), "a net the editor repaired on load: the chip counts the problems", await p.eval(`document.querySelector('.pv-problems-label').textContent`));
    ok(await p.eval(`document.querySelector('.pv-problems-chip').dataset.level !== 'ok'`), "and is no longer green");
    ok(await p.eval(`[...document.querySelectorAll('.pv-toast')].some((t) => /problems? the editor repaired on load\\. The problems chip lists them\\./.test(t.textContent))`), "the toast says where the list is: the problems chip", await p.eval(`[...document.querySelectorAll('.pv-toast')].map((t) => t.textContent).join(' | ')`));
    ok(await p.eval(`![...document.querySelectorAll('.pv-toast')].some((t) => /Menu/.test(t.textContent))`), "and no longer points at a menu entry");
    await p.eval(`document.querySelector('.pv-problems-chip').click()`);
    ok(await p.waitFor("!!document.querySelector('[role=dialog][aria-label=Problems] .pv-problems-list')", 10000), "clicking the chip opens the list");
    ok(await p.eval(`document.querySelectorAll('.pv-problem').length >= 1 && document.querySelector('.pv-problem-where').textContent.length > 0`), "one row per problem, with where it is");
    ok(await p.eval(`[...document.querySelectorAll('[role=dialog][aria-label=Problems] .pv-btn')].map((b) => b.textContent.trim()).join() === 'Copy MCP call,Details,Close'`), "with Copy MCP call, Details and Close");
    await p.eval(`window.__copied = []; const v = document.querySelector('petri-view'); v._copyToClipboard = (t) => window.__copied.push(t); document.querySelector('[data-act=mcp]').click()`);
    ok(await p.eval(`window.__copied.length === 1 && JSON.parse(window.__copied[0]).name === 'analysis.check'`), "Copy MCP call copies the analysis.check call", await p.eval(`window.__copied.join()`));
    await p.eval(`document.querySelector('[role=dialog][aria-label=Problems] [data-act=details]').click()`);
    ok(await dialogLabel(p, "[role=dialog][aria-label='Check net']"), "Details opens the classic Check net dialog");
    ok(await p.eval(`!document.querySelector('[role=dialog][aria-label=Problems]')`), "and the list closes");
    await closeDialogs(p);
    // Escape closes the list and focus goes back to the chip
    await p.eval(`document.querySelector('.pv-problems-chip').focus(); document.querySelector('.pv-problems-chip').click()`);
    await p.waitFor("!!document.querySelector('[role=dialog][aria-label=Problems]')");
    await press(p, "Escape");
    ok(await p.eval(`!document.querySelector('[role=dialog][aria-label=Problems]') && document.activeElement === document.querySelector('.pv-problems-chip')`), "Escape closes the list and focus is back on the chip");

    // every change of the document is a re-check (the one choke point, _syncLD)
    await setNet(p, NET);
    await p.waitFor(`document.querySelector('.pv-problems-label').textContent === 'No problems'`, 15000);
    await p.eval(`(() => { const m = window.__monitor = document.querySelector('petri-view')._problemsMonitor; window.__checks = 0; const c = m._check; m._check = (...a) => { window.__checks++; return c(...a); }; })()`);
    await p.eval(`document.querySelector('petri-view').execute('net.add_place', { x: 50, y: 50 })`);
    ok(await p.waitFor("window.__checks >= 1", 5000), "a command that changes the net re-checks it", await p.eval(`String(window.__checks)`));
    const n1 = await p.eval(`window.__checks`);
    await p.eval(`document.querySelector('petri-view')._undoAction()`);
    ok(await p.waitFor(`window.__checks > ${n1}`, 5000), "an undo re-checks it");
    const n2 = await p.eval(`window.__checks`);
    await p.eval(`(() => { const v = document.querySelector('petri-view'); v._model.places.S.initial = [-5]; v._syncLD(); })()`);
    ok(await p.waitFor(`window.__checks > ${n2} && document.querySelector('.pv-problems-chip').dataset.level !== 'ok'`, 10000), "an edit that breaks the net turns the chip", await p.eval(`document.querySelector('.pv-problems-label').textContent`));
    await p.eval(`(() => { const m = document.querySelector('petri-view')._problemsMonitor; window.__gens = 0; })()`);
    // a burst of edits is one check
    await setNet(p, NET);
    await p.waitFor(`document.querySelector('.pv-problems-label').textContent === 'No problems'`, 15000);
    await sleep(600);
    const n3 = await p.eval(`window.__checks`);
    await p.eval(`(() => { const v = document.querySelector('petri-view'); for (let i = 0; i < 20; i++) { v._model.places.S.x += 1; v._syncLD(); } })()`);
    await sleep(1500);
    ok((await p.eval(`window.__checks`)) - n3 <= 2, "a burst of twenty edits runs one check (two at most)", String((await p.eval(`window.__checks`)) - n3));
    // the Apply gate the Ask pane calls
    const gate = await p.eval(`document.querySelector('petri-view')._problemsGate(${JSON.stringify(BAD_NET)}).then((g) => g)`);
    ok(gate && gate.block === false && gate.warn === true && /error/.test(gate.message), "_problemsGate(net) warns about a net with errors and never blocks", JSON.stringify(gate));
    const gate2 = await p.eval(`document.querySelector('petri-view')._problemsGate(${JSON.stringify(NET)})`);
    ok(gate2 && gate2.block === false && gate2.warn === false, "and says nothing about a clean one", JSON.stringify(gate2));
    // gone with the view
    await p.eval(`(() => { const v = document.querySelector('petri-view'); window.__v = v; v.remove(); })()`);
    ok(await p.eval(`!document.querySelector('.pv-appbar') && !document.querySelector('.pv-appmenu-pop') && !window.__v._problemsMonitor && !window.__v._unbindPaletteKey`), "disconnecting takes the bar, the chip's monitor and the Cmd-K chord down");
    await p.close();
  }

  // =========================================================================================================
  console.log("Describe, Draft notes and the Assistant: the Ask input");
  {
    const p = await open("/", { signedIn: true });
    await barUp(p);
    await p.eval(`window.__chat = []; document.querySelector('petri-view')._openChat = async (o) => { window.__chat.push(o); };`);
    await p.eval(`document.querySelector('.pv-ask-input').focus()`);
    await sleep(300);
    ok(await p.eval(`window.__chat.length === 0 && !document.querySelector('.pv-chat')`), "focusing the Ask input opens nothing");
    await typeText(p, "can it get stuck?");
    await sleep(200);
    ok(await p.eval(`window.__chat.length === 0`), "typing opens nothing either");
    await press(p, "Enter");
    ok(await p.waitFor("window.__chat.length === 1", 5000), "Enter calls _openChat");
    ok(same(await p.eval(`window.__chat[0]`), { mode: "auto", message: "can it get stuck?" }), "with mode auto (the server labels the intent) and the words", JSON.stringify(await p.eval(`window.__chat[0]`)));
    ok(await p.eval(`document.querySelector('.pv-ask-input').value === ''`), "the words go to the pane: the input is empty again");
    await typeText(p, "  make the queue bounded  ");
    await p.eval(`document.querySelector('.pv-ask-go').click()`);
    ok(await p.waitFor("window.__chat.length === 2", 5000) && same(await p.eval(`window.__chat[1]`), { mode: "auto", message: "make the queue bounded" }), "the Ask button does the same, trimmed", JSON.stringify(await p.eval(`window.__chat[1]`)));
    await p.eval(`document.querySelector('.pv-ask-input').focus()`);
    await press(p, "Enter");
    ok(await p.waitFor("window.__chat.length === 3", 5000) && same(await p.eval(`window.__chat[2]`), { mode: "auto" }), "Enter with nothing typed still opens the pane: never a dead input", JSON.stringify(await p.eval(`window.__chat[2]`)));
    // a pane that would not open keeps the words
    await p.eval(`document.querySelector('petri-view')._openChat = async () => false`);
    await typeText(p, "keep me");
    await press(p, "Enter");
    await sleep(300);
    ok(await p.eval(`document.querySelector('.pv-ask-input').value === 'keep me'`), "a pane that could not open leaves the words in the input");
    await p.eval(`document.querySelector('.pv-ask-input').value = ''`);
    // the empty-canvas prompt opens the Ask pane in build mode
    await p.eval(`document.querySelector('petri-view')._openChat = async (o) => { window.__chat.push(o); }; window.__draft = 0; document.querySelector('petri-view')._openDraftDialog = () => { window.__draft++; };`);
    await p.eval(`document.querySelector('petri-view').setModel({})`);
    ok(await p.waitFor("document.querySelector('.pv-draft-prompt') && document.querySelector('.pv-draft-prompt').style.display !== 'none'", 10000), "an empty canvas offers the prompt");
    ok(await p.eval(`document.querySelector('.pv-draft-prompt').textContent.includes('Describe a process in words')`), "its words are kept");
    const n = await p.eval(`window.__chat.length`);
    await p.eval(`document.querySelector('.pv-draft-prompt').click()`);
    ok(await p.waitFor(`window.__chat.length === ${n + 1}`, 5000) && same(await p.eval(`window.__chat[${n}]`), { mode: "build" }), "its button opens the Ask pane in build mode", JSON.stringify(await p.eval(`window.__chat[${n}]`)));
    ok(await p.eval(`window.__draft === 0`), "and not the Describe dialog");
    await p.close();
  }
  {
    // signed out: Enter opens the pane (the real _openChat), and nothing is asked of the model from here
    const p = await open("/", {});
    await barUp(p);
    await p.eval(`document.querySelector('.pv-ask-input').focus()`);
    await typeText(p, "how bad can it get");
    await press(p, "Enter");
    ok(await p.waitFor("!!document.querySelector('.pv-chat')", 15000), "signed out, Enter still opens the pane");
    await sleep(500);
    const reqs = await p.eval(`window.__reqs`);
    ok(reqs.filter((r: any) => r.path === "/api/llm/turn").length === 0, "and no request goes to /api/llm/turn (so none is refused with a 401)", JSON.stringify(reqs));
    ok(await p.eval(`document.querySelector('.pv-chat').getBoundingClientRect().top >= 60`), "the pane docks below the bar (64px), not over it");
    await p.close();
  }
  {
    // no chat on this server at all
    const p = await open("/", { chat: false });
    await barUp(p);
    await p.eval(`window.__chat = []; document.querySelector('petri-view')._openChat = async (o) => { window.__chat.push(o); }; document.querySelector('.pv-ask-input').focus()`);
    await typeText(p, "anything");
    await press(p, "Enter");
    ok(await p.waitFor("window.__chat.length === 1", 5000), "with no chat on the server, the input still hands the words to the pane (which routes them to cards)");
    await p.close();
  }

  // =========================================================================================================
  console.log("Help > Classic menu, and ?ui=classic");
  {
    const p = await open("/", {});
    await barUp(p);
    await openMenu(p, "help");
    await p.eval(`[...document.querySelectorAll('.pv-appmenu-pop [role=menuitem]')].find((e) => e.dataset.label === 'Classic menu (this release)').click()`);
    ok(await p.waitFor("location.search.includes('ui=classic')", 15000), "Help > Classic menu goes to ?ui=classic");
    ok(await p.waitFor("!!document.querySelector('.pv-hamburger-btn')", 15000), "and the page comes back with the old hamburger");
    ok(await p.eval(`!document.querySelector('.pv-appbar')`), "no bar");
    await p.close();
  }
  {
    const p = await open("/?ui=classic", { llm503: false, files: true, signedIn: false });
    await p.waitFor("!!document.querySelector('.pv-hamburger-btn')", 15000);
    await p.waitFor(`document.querySelector('.pv-hamburger-content .pv-menu-item')`, 10000);
    await sleep(500);
    ok(await p.eval(`!document.querySelector('.pv-appbar') && !document.querySelector('[data-menu]') && document.querySelector('petri-view').dataset.ui === undefined`), "no bar, no menu buttons, no data-ui");
    ok(await p.eval(`!document.querySelector('.pv-problems') && !document.querySelector('petri-view')._problemsMonitor`), "no problems chip: Check net is a menu entry here");
    ok(await p.eval(`!document.querySelector('petri-view')._unbindPaletteKey`), "and no Cmd-K chord: it is exactly the old editor");
    await chord(p);
    await sleep(300);
    ok(await p.eval(`!document.querySelector('.pv-palette')`), "Ctrl-K opens nothing");
    ok(await p.eval(`document.querySelector('.pv-top-right-btn').parentElement.classList.contains('pv-root')`), "the Login button is on the canvas where it was");
    await p.eval(`document.querySelector('.pv-hamburger-btn').click()`);
    ok(await p.eval(`getComputedStyle(document.querySelector('.pv-hamburger-overlay')).display !== 'none'`), "the hamburger opens its left-hand panel");
    const all = await p.eval(`[...document.querySelectorAll('.pv-hamburger-content .pv-menu-item')].filter((e) => e.style.display !== 'none').map((e) => e.textContent.trim())`);
    const want = [
      "💾 Save Permalink", "🗑️ Delete", "☁️ Save to my account…", "🗂️ Open from my account…", "✨ Describe a process…", "💬 Assistant",
      "🧮 Analysis (ODE, scans, phase)", "📱 App view", "🧩 Components", "❓ What do you want to know?", "🎲 Simulate (stochastic, influence, what-if)",
      "🔬 Structure (invariants, verify, reach)", "✅ Check net", "📊 Results", "🎨 Layout Algorithms", "📝 Toggle Editor", "⚙ Display Settings",
      "📥 Download JSON", "❓ Help", "📊 Sim — Run & Check", "📖 Book", "🖥 Native App", "🧩 Composition Views", "GitHub",
    ];
    for (const w of want) ok(all.includes(w), `the old hamburger still has "${w}"`, all.join(" | "));
    ok(await p.eval(`!!document.querySelector('.pv-hamburger-content .pv-menu-version')`), "and its version footer");
    ok(await p.eval(`document.querySelector('.pv-hamburger-content').textContent.includes('Classic menu') === false`), "the Classic menu link is not in the classic menu");
    // the old entries still open what they opened (Results first: a check stores a result)
    await p.eval(`[...document.querySelectorAll('.pv-hamburger-content .pv-menu-item')].find((e) => e.textContent.includes('Results')).click()`);
    ok(await dialogLabel(p, "[role=dialog][aria-label='Results']"), "📊 Results still opens Results");
    ok(await p.eval(`document.querySelector('[role=dialog][aria-label=Results]').textContent.includes('Run an analysis (🧮) or a check (✅)')`), "with its classic wording");
    await closeDialogs(p);
    await p.eval(`document.querySelector('.pv-hamburger-btn').click(); [...document.querySelectorAll('.pv-hamburger-content .pv-menu-item')].find((e) => e.textContent.includes('Check net')).click()`);
    ok(await dialogLabel(p, "[role=dialog][aria-label='Check net']"), "✅ Check net still opens the Check net dialog");
    await closeDialogs(p);
    // the empty-canvas prompt keeps its old dialog here
    await p.eval(`window.__draft = 0; window.__chat = []; const v = document.querySelector('petri-view'); v._openDraftDialog = () => { window.__draft++; }; v._openChat = async (o) => { window.__chat.push(o); };`);
    await p.eval(`document.querySelector('petri-view').setModel({})`);
    await p.waitFor("document.querySelector('.pv-draft-prompt') && document.querySelector('.pv-draft-prompt').style.display !== 'none'", 10000);
    await p.eval(`document.querySelector('.pv-draft-prompt').click()`);
    ok(await p.eval(`window.__draft === 1 && window.__chat.length === 0`), "?ui=classic: the empty-canvas prompt still opens the Describe dialog");
    await p.eval(`document.querySelector('petri-view').setModel(${JSON.stringify(BAD_NET)})`);
    ok(await p.waitFor(`[...document.querySelectorAll('.pv-toast')].some((t) => t.textContent.includes('Menu → Check net shows them.'))`, 10000), "?ui=classic: the load toast still says Menu → Check net");
    ok(await p.eval(`!window.__reqs.some((r) => r.path === '/api/llm/turn')`), "(nothing asked of the model)");
    await p.close();
  }

  // =========================================================================================================
  console.log("the standalone component (no data-backend)");
  {
    const p = await open("/", {});
    await barUp(p);
    // the editor page has the attribute: take it away, and the bar gives way to the dropdown hamburger
    await p.eval(`document.querySelector('petri-view').removeAttribute('data-backend')`);
    ok(await p.waitFor("!!document.querySelector('.pv-hamburger-dropdown')", 10000), "removing data-backend swaps the bar for the dropdown hamburger");
    ok(await p.eval(`!document.querySelector('.pv-appbar') && !document.querySelector('petri-view')._problemsMonitor && !document.querySelector('petri-view')._unbindPaletteKey && document.querySelector('petri-view').dataset.ui === undefined`), "the bar, the chip and the chord are gone");
    // and a component made without it from the start (no page in public/ embeds one, so make one)
    await p.eval(`(() => { document.querySelector('petri-view').remove(); const host = document.createElement('div'); host.id = 'standalone'; host.style.cssText = 'position:fixed;inset:0;z-index:5000;background:#fff'; const el = document.createElement('petri-view'); el.id = 'solo'; host.appendChild(el); document.body.appendChild(host); })()`);
    ok(await p.waitFor("!!document.querySelector('#solo .pv-hamburger-btn')", 10000), "a petri-view with no data-backend has the hamburger button");
    await sleep(500);
    ok(await p.eval(`!document.querySelector('#solo .pv-appbar') && !document.querySelector('#solo').dataset.ui && !document.querySelector('#solo')._problemsMonitor`), "and no bar, no chip");
    await p.eval(`document.querySelector('#solo .pv-hamburger-btn').click()`);
    const dd = await p.eval(`(() => { const d = document.querySelector('#solo .pv-hamburger-dropdown'); return d && getComputedStyle(d).display !== 'none' ? [...d.querySelectorAll('.pv-menu-item')].map((e) => e.textContent.trim()) : null; })()`);
    ok(dd, "it opens a dropdown (not the left-hand panel)");
    if (dd) {
      for (const w of ["🧮 Analysis (ODE, scans, phase)", "📱 App view", "🧩 Components", "❓ What do you want to know?", "🎲 Simulate (stochastic, influence, what-if)", "🔬 Structure (invariants, verify, reach)", "✅ Check net", "📊 Results", "🎨 Layout Algorithms", "📝 Toggle Editor", "⚙ Display Settings", "📥 Download JSON", "❓ Help", "📊 Sim — Run & Check", "📖 Book", "🖥 Native App", "GitHub"]) ok(dd.includes(w), `standalone: "${w}"`, dd.join(" | "));
      ok(!dd.some((t: string) => /Save Permalink|Login|Composition Views/.test(t)), "and none of the server's entries (no account, no Compose)");
    }
    await p.eval(`[...document.querySelectorAll('#solo .pv-menu-item')].find((e) => e.textContent.includes('Help')).click()`);
    ok(await p.waitFor("!!document.querySelector('.pv-help-content')", 10000), "its Help opens");
    ok(await p.eval(`document.querySelector('.pv-help-content').textContent.includes('Open it from the hamburger menu') && !document.querySelector('.pv-help-content').textContent.includes('Finding your way around')`), "with the hamburger wording: it does not point at a bar it does not have");
    await chord(p);
    await sleep(300);
    ok(await p.eval(`!document.querySelector('.pv-palette')`), "and Ctrl-K does nothing");
    await p.close();
  }

  // =========================================================================================================
  console.log("a copy of the component served without some of the modules");
  {
    // no bar module (a vendored copy of petri-view.js on a page that has data-backend): the old hamburger, no error
    const p = await newPage(1280, 800);
    p.failAll = true;
    await p.hold(["*petri-menu-ui.js*"]);
    await p.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB() });
    await p.goto(new URL("/", url).href);
    ok(await p.waitFor("!!document.querySelector('.pv-hamburger-btn')", 15000), "without petri-menu-ui.js the editor falls back to the hamburger");
    ok(await p.eval(`!document.querySelector('.pv-appbar') && document.querySelector('petri-view').dataset.ui === undefined`), "and says so: no bar, no data-ui (the logo goes back to where it was)");
    ok(await p.eval(`getComputedStyle(document.querySelector('.fixed-title')).left === '60px'`), "the page's logo is back at 60px", await p.eval(`getComputedStyle(document.querySelector('.fixed-title')).left`));
    ok(await p.eval(`document.querySelector('.pv-top-right-btn').parentElement.classList.contains('pv-root')`), "with the Login button on the canvas");
    await p.close();
  }
  {
    // no problems module: the bar works, there is just no chip
    const p = await newPage(1280, 800);
    p.failAll = true;
    await p.hold(["*petri-problems.js*"]);
    await p.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB() });
    await p.goto(new URL("/", url).href);
    ok(await p.waitFor("!!document.querySelector('.pv-appbar .pv-ask-input')", 15000), "without petri-problems.js the bar still mounts");
    await sleep(800);
    ok(await p.eval(`!document.querySelector('.pv-problems-chip') && !document.querySelector('petri-view')._problemsMonitor`), "and there is no chip, and no monitor");
    await openMenu(p, "file");
    ok(await popOpen(p), "the menus work");
    await press(p, "Escape");
    await p.eval(`document.querySelector('petri-view').setModel(${JSON.stringify(NET)})`);
    await sleep(500);
    const thrown = p.problems.filter((x: string) => x.startsWith("exception:"));
    ok(thrown.length === 0, "an edit throws nothing", thrown.slice(0, 3).join(" | "));
    await p.close();
  }

  // =========================================================================================================
  console.log("the Help dialog and the other texts say where things are now");
  {
    const p = await open("/", {});
    await barUp(p);
    await clickItem(p, "help", "Help");
    ok(await p.waitFor("!!document.querySelector('.pv-help-content')", 10000), "Help opens");
    const t = await p.eval(`document.querySelector('.pv-help-content').textContent`);
    ok(t.includes("Finding your way around") && t.includes("Tools") && t.includes("problems chip") && t.includes("Classic tools"), "it has the section on Ask, Tools, the chip and Classic tools");
    ok(t.includes("Tools (Ctrl K, or ⌘K) under Classic tools → Analysis, or press 9"), "Analysis is named where it is now", t.slice(t.indexOf("Analysis Workbench"), t.indexOf("Analysis Workbench") + 200));
    ok(t.includes("View → Layout Algorithms"), "Layout Algorithms is named in View");
    ok(!t.includes("hamburger menu") && !t.includes("🧮 Analysis"), "and nothing sends the reader to the hamburger");
    ok(t.includes("Ctrl/Cmd + K"), "Ctrl/Cmd + K is in the shortcuts");
    await closeDialogs(p);
    await clickItem(p, "view", "Open as app");
    await p.waitFor("!!document.querySelector('.pv-appview')", 10000).catch(() => {});
    await p.eval(`document.querySelectorAll('.pv-appview [data-act=close]').forEach((b) => b.click())`);
    await p.eval(`(async () => { await document.querySelector('petri-view')._showResultsDialog(); })()`);
    ok(await dialogLabel(p, "[role=dialog][aria-label='Results']"), "(Results, reached from code, opens)");
    ok(await p.eval(`document.querySelector('[role=dialog][aria-label=Results]').textContent.includes('Ask a question in the Ask box, run something from Tools')`), "and its empty state points at Ask and Tools, not at 🧮 and ✅");
    await p.close();
  }
} finally {
  await stop();
}
console.log(`\n${checks - failures}/${checks} checks passed`);
Deno.exit(failures ? 1 : 0);
