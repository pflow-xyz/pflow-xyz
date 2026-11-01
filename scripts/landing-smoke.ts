// Browser check of the landing chat (public/petri-landing.js, docs/landing-chat.md).
//
//   deno run -A scripts/landing-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome]
//
// In headless Chrome: what a signed-out visitor sees and where each route goes, and the sessions a signed-in
// one gets. It cannot sign in to GitHub, so a signed-in page has its fetch of /api/llm/status, /api/llm/turn and
// /auth/user answered in the page: this proves the route, the mode and the message reach the Assistant's
// request, and says nothing about Gemini or the real sign-in.
//
// Also the editor's other docked panel, the App view, whose frame on a phone comes from the same place
// (public/petri-panel-frame.js), and the Assistant's Tools section: what it counts, what it lists, where it sits.
// On a desktop: the panels' heads, and the Assistant on top of the editor's slider and toolbar, which stand clear of it.
//
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure; scripts/smoke-gate.sh
// is the way to run it before a push, because it keeps the log and reads that status.
import { sleep, startChrome } from "./cdp.ts";

const url = Deno.args.find((a) => a.startsWith("http"));
if (!url) { console.error("usage: deno run -A scripts/landing-smoke.ts <url of /> [--chrome path]"); Deno.exit(2); }
const chromeArg = Deno.args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? Deno.args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { newPage, stop } = await startChrome(CHROME, "landing-smoke-");

let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};
const q = (s: string) => JSON.stringify(s);
const text = (sel: string) => `(document.querySelector(${q(sel)})?.textContent || '')`;

/** Before any script: a signed-in session, with the model's route answered here and the requests kept. */
const SIGNED_IN = (seed = "", statusDelay = 0) => `
  window.__turns = [];
  try { localStorage.setItem('pflow_auth_token', 'smoke-token'); ${seed} } catch {}
  const real = window.fetch;
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (u, opts) => {
    const path = new URL(String(u?.url ?? u), location.href).pathname;
    // As the server: signed in only with the token, so the page must have it by the time it asks.
    const bearer = new Headers(opts?.headers).get('Authorization') === 'Bearer smoke-token';
    if (path === '/api/llm/status' && ${statusDelay}) await new Promise((r) => setTimeout(r, ${statusDelay}));
    if (path === '/api/llm/status') return json(bearer ? { enabled: true, chat: true, signed_in: true, allowed: true, model: 'smoke', remaining_today: 7 } : { enabled: true, chat: true, signed_in: false });
    if (path === '/auth/user') return bearer ? json({ user: { id: '1', email: '', user_name: 'smoke', full_name: 'Smoke' } }) : new Response('{}', { status: 401 });
    if (path === '/api/llm/turn') {
      if (!bearer) return new Response('{"error":"sign in"}', { status: 401 });
      const body = JSON.parse(opts.body);
      window.__turns.push(body);
      return json({ reply: window.__reply || 'smoke reply', tool_calls: window.__toolCalls?.splice(0) ?? [], message: { role: 'model', parts: [{ text: 'smoke reply' }] }, remaining_today: 6, mode: body.mode === 'auto' ? 'analyse' : body.mode });
    }
    return real(u, opts);
  };`;

// One Chrome profile serves every page here, and showEditor() remembers pflow_skip_landing: each page starts clean.
const CLEAN = `try { localStorage.clear(); sessionStorage.clear(); } catch {}`;
// The example cards' thumbnails are stored nets: a scratch server's empty store answers 404 for them.
const problemsOf = (p: any) => p.problems.filter((x: string) => !/\/img\/z\w+\.svg/.test(x));

async function open(path: string, before?: string, width = 1280, height = 900, phone = false) {
  const p = await newPage(width, height);
  if (phone) {
    // cdp.ts opens a desktop page; this is the layout a phone's browser gives, with touch.
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    await p.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  }
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: CLEAN + (before ?? "") });
  await p.goto(new URL(path, url).href);
  return p;
}
const routed = (p: any) => p.waitFor(`document.querySelector('#landing-chat-hint')?.textContent.length > 0`, 20000);

// iPhone-ish and Android sizes, with the browser's chrome taken off the screen.
const PHONES = [[390, 664], [375, 553], [430, 739], [412, 732]];
const DESKTOPS = [[1024, 768], [1280, 900], [1440, 900], [1920, 1080]];
// Before any script, a keyboard: only the visual viewport shrinks, as on iOS and by default on Android. A real keyboard
// cannot be raised in headless Chrome, so the panel's input (window.visualViewport) is what is faked here.
const FAKE_KEYBOARD = `
  window.__vv = { covered: 0, offsetTop: 0, scale: 1, targets: new Set(),
    get width() { return innerWidth; }, get height() { return innerHeight - this.covered; },
    addEventListener(_t, f) { this.targets.add(f); }, removeEventListener(_t, f) { this.targets.delete(f); } };
  Object.defineProperty(window, 'visualViewport', { get: () => window.__vv });
  window.__cover = (covered, offsetTop = 0) => { Object.assign(window.__vv, { covered, offsetTop }); for (const f of window.__vv.targets) f(); };`;
// Inside what can be seen (the fake visual viewport, when there is one), and actually the top thing there: a rect in
// the viewport can still be painted over, which is how the run bar hid the input row.
const REACHABLE = (sel: string) => `(() => {
  const e = document.querySelector(${q(sel)}); if (!e) return 'missing';
  const r = e.getBoundingClientRect();
  const vv = window.visualViewport, top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
  if (r.left < 0 || r.right > innerWidth || r.top < top || r.bottom > bottom) return 'off screen: ' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ' of ' + innerWidth + ' visible ' + top + '..' + bottom;
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return at === e || e.contains(at) ? 'ok' : 'covered by ' + (at?.className || at?.tagName);
})()`;
const panelIs = async (p: any, label: string) => {
  for (const sel of [".pv-chat-input", ".pv-chat-form button", '.pv-chat [data-act="close"]']) {
    const got = await p.eval(REACHABLE(sel));
    ok(got === "ok", `${label}: ${sel} is reachable`, got);
  }
};

// A panel's head on a desktop: every control in its row, inside the panel, and on top at its centre. Close keeps its size.
const HEAD_FITS = (panel: string) => `(() => {
  const P = document.querySelector(${q(panel)}), c = P.getBoundingClientRect();
  if (c.left < 0 || c.right > innerWidth) return 'panel off the screen: ' + c.left + '..' + c.right + ' of ' + innerWidth;
  const close = P.querySelector('[data-act="close"]'), x = close.getBoundingClientRect();
  if (x.width < 32 || x.height < 32) return 'close squeezed to ' + x.width + 'x' + x.height;
  const at = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
  if (!close.contains(at)) return 'close covered by ' + (at?.className || at?.tagName);
  for (const b of P.querySelectorAll('.pv-chat-head button')) {
    const r = b.getBoundingClientRect();
    if (r.left < c.left || r.right > c.right) return (b.dataset.act || b.textContent) + ' at ' + r.left + '..' + r.right + ' of panel ' + c.left + '..' + c.right;
  }
  const head = P.querySelector('.pv-chat-head');
  return head.scrollWidth > head.clientWidth ? 'head overflows: ' + head.scrollWidth + ' of ' + head.clientWidth : 'ok';
})()`;
const headFits = async (p: any, label: string, panel: string) => {
  const got = await p.eval(HEAD_FITS(panel));
  ok(got === "ok", `${label}: the head fits, close is inside and on top`, got);
};
// The panel on top of the editor: four corners (inset past the 8px radius, which hit-testing honours), the middle of each
// edge, where the slider and the toolbar would reach in, and the centre and ends of the controls named.
const ON_TOP_OF_THE_EDITOR = (panel: string, controls: string[]) => `(() => {
  const P = document.querySelector(${q(panel)}), c = P.getBoundingClientRect(), i = 9, bad = [];
  const mid = (a, b) => (a + b) / 2;
  const points = [[c.left + i, c.top + i], [c.right - i, c.top + i], [c.left + i, c.bottom - i], [c.right - i, c.bottom - i],
    [c.left + i, mid(c.top, c.bottom)], [c.right - i, mid(c.top, c.bottom)], [mid(c.left, c.right), c.top + i], [mid(c.left, c.right), c.bottom - i]];
  for (const s of ${JSON.stringify(controls)}) {
    const e = document.querySelector(s); if (!e) { bad.push(s + ' missing'); continue; }
    const r = e.getBoundingClientRect(), y = mid(r.top, r.bottom);
    points.push([r.left + 4, y], [mid(r.left, r.right), y], [r.right - 4, y]);
  }
  for (const [x, y] of points) {
    const at = document.elementFromPoint(x, y);
    if (!at || !P.contains(at)) bad.push(Math.round(x) + ',' + Math.round(y) + ' is ' + (at?.className || at?.tagName));
  }
  // And anywhere in between: the slider and the toolbar each have their own rect to compare.
  for (const s of ['.pv-scale-meter', '.pv-mode-menu', '.pv-top-right-btn', '.pv-hamburger-btn']) {
    const e = document.querySelector(s); if (!e) continue;
    const r = e.getBoundingClientRect();
    const [x0, x1, y0, y1] = [Math.max(r.left, c.left + i), Math.min(r.right, c.right - i), Math.max(r.top, c.top + i), Math.min(r.bottom, c.bottom - i)];
    for (let x = x0; x < x1; x += 8) for (let y = y0; y < y1; y += 8) if (e.contains(document.elementFromPoint(x, y))) { bad.push(s + ' over the panel at ' + Math.round(x) + ',' + Math.round(y)); x = x1; break; }
  }
  return bad.length ? bad.join('; ') : 'ok';
})()`;
// On the screen and on top at its centre, for one of the editor's own controls.
const USABLE = (sel: string) => `(() => {
  const e = document.querySelector(${q(sel)}); if (!e) return 'missing';
  const r = e.getBoundingClientRect();
  if (r.width === 0 || r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight) return 'off screen: ' + [r.left, r.top, r.right, r.bottom].map(Math.round);
  for (const x of [r.left + 6, r.left + r.width / 2, r.right - 6]) {
    const at = document.elementFromPoint(x, r.top + r.height / 2);
    if (!e.contains(at)) return 'covered at ' + Math.round(x) + ' by ' + (at?.className || at?.tagName);
  }
  return 'ok';
})()`;

// The App view's frame, against what can be seen and the run bar. A rect check first (the panel has to fit), then the
// close button through REACHABLE (the panel can fit and still be painted over).
const APP_FITS = `(() => {
  const a = document.querySelector('.pv-appview').getBoundingClientRect();
  const b = document.querySelector('.pv-run-bar')?.getBoundingClientRect();
  const vv = window.visualViewport, top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
  const at = [a.left, a.top, a.right, a.bottom].map(Math.round).join() + ' visible ' + top + '..' + bottom + ' of ' + innerWidth;
  if (a.left < 0 || a.right > innerWidth) return 'off the sides: ' + at;
  if (a.top < top || a.bottom > bottom) return 'off the visible area: ' + at;
  if (b?.height && a.bottom > b.top) return 'behind the run bar at ' + Math.round(b.top) + ': ' + at;
  return a.height > 0 ? 'ok' : 'no height: ' + at;
})()`;
const appViewIs = async (p: any, label: string) => {
  const fits = await p.eval(APP_FITS);
  ok(fits === "ok", `${label}: the App view is inside what can be seen, above the run bar`, fits);
  const close = await p.eval(REACHABLE('.pv-appview [data-act="close"]'));
  ok(close === "ok", `${label}: its close button is reachable`, close);
};
// The Assistant's Tools section, open: inside the panel, wide enough for what it holds, with its summary (how it closes)
// and the panel's own controls on top where they are.
const TOOLS_FIT = `(() => {
  const t = document.querySelector('.pv-chat-tools'), r = t.getBoundingClientRect(), c = document.querySelector('.pv-chat').getBoundingClientRect();
  const b = document.querySelector('.pv-run-bar')?.getBoundingClientRect();
  const vv = window.visualViewport, top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
  const at = [r.left, r.top, r.right, r.bottom].map(Math.round).join() + ' panel ' + [c.left, c.top, c.right, c.bottom].map(Math.round).join() + ' visible ' + top + '..' + bottom + ' of ' + innerWidth;
  if (r.left < c.left || r.right > c.right || r.top < c.top || r.bottom > c.bottom) return 'out of the panel: ' + at;
  if (c.left < 0 || c.right > innerWidth || c.top < top || c.bottom > bottom) return 'panel off what can be seen: ' + at;
  if (b?.height && c.bottom > b.top) return 'panel behind the run bar at ' + Math.round(b.top) + ': ' + at;
  if (t.scrollWidth > t.clientWidth) return 'scrolls sideways: ' + t.scrollWidth + ' of ' + t.clientWidth;
  return 'ok';
})()`;
const toolsAre = async (p: any, label: string) => {
  const fits = await p.eval(TOOLS_FIT);
  ok(fits === "ok", `${label}: Tools is inside the panel, inside what can be seen`, fits);
  for (const sel of [".pv-chat-tools > summary", ".pv-chat-input", '.pv-chat [data-act="close"]']) {
    const got = await p.eval(REACHABLE(sel));
    ok(got === "ok", `${label}: ${sel} is reachable`, got);
  }
};
const toolCount = (p: any) => p.eval(`document.querySelector('.pv-chat-tools-count').textContent`);
const TOOLS_IN_MANIFEST = `fetch('/llm-tools.json').then((r) => r.json()).then((m) => m.tools.length)`;
const LISTED = `[...document.querySelectorAll('.pv-chat-avail li code')].map((c) => c.textContent)`;
/** The section's contents against the manifest: the number on it, the groups, and the tools in them. */
const toolsListed = async (p: any, label: string, wants: RegExp) => {
  const n = await p.eval(TOOLS_IN_MANIFEST);
  ok(n > 0, `${label}: the manifest has tools`, String(n));
  const count = await toolCount(p);
  ok(wants.test(count) && parseInt(count) === n, `${label}: the count is of the tools there are`, `${count}, manifest ${n}`);
  ok(!/^\(?0\b/.test(count), `${label}: it does not read 0`, count);
  const listed = await p.eval(LISTED);
  ok(listed.length === n, `${label}: every tool is listed`, `${listed.length} of ${n}`);
  ok(listed.includes("net.add_place") && listed.includes("analysis.check") && listed.includes("sim.ode"), `${label}: by the names they have`, listed.slice(0, 5).join());
  ok((await p.eval(`document.querySelectorAll('.pv-chat-avail-group').length`)) > 3, `${label}: in groups`);
  ok(await p.eval(`[...document.querySelectorAll('.pv-chat-avail li')].every((li) => li.textContent.length > li.querySelector('code').textContent.length + 3)`), `${label}: each says what it does`);
};
/** One finger up the element by a distance, event by event. */
const swipe = async (p: any, sel: string, dy: number) => {
  const box = await p.eval(`(() => { const r = document.querySelector(${q(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
  for (let i = 1; i <= 6; i++) { await p.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x, y: box.y + i * dy / 6 }] }); await sleep(16); }
  await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(500);
};
/** A finger on the element's centre, which has to be what is there. */
const tap = async (p: any, sel: string) => {
  const box = await p.eval(`(() => { const r = document.querySelector(${q(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [box] });
  await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(300);
};
// What a model asks for in one reply: no arguments, one that fails and has an unbroken 300 characters in it, one that makes a plot.
const THREE_CALLS = `window.__toolCalls = [{ name: 'net_info', args: {} }, { name: 'view_highlight', args: { nodes: ['${"a".repeat(300)}'] } }, { name: 'sim_ode', args: { t_end: 5 } }];`;

// Enough of a net to have every kind of control the panel draws, so that it is taller than a phone.
const APP_NET = {
  "@context": "https://pflow.xyz/schema", "@type": "PetriNet",
  places: {
    queue: { "@type": "Place", initial: [0], x: 200, y: 100 }, baristas: { "@type": "Place", initial: [2], x: 300, y: 200 },
    serving: { "@type": "Place", initial: [0], x: 400, y: 100 }, served: { "@type": "Place", initial: [0], x: 600, y: 100 },
    gone: { "@type": "Place", initial: [0], x: 300, y: 300 },
  },
  transitions: {
    arrive: { "@type": "Transition", rate: 2, x: 100, y: 100 }, start: { "@type": "Transition", rate: 4, x: 300, y: 100 },
    finish: { "@type": "Transition", rate: 1, x: 500, y: 100 }, give_up: { "@type": "Transition", rate: 0.2, x: 200, y: 200 },
  },
  arcs: [["arrive", "queue"], ["queue", "start"], ["baristas", "start"], ["start", "serving"], ["serving", "finish"], ["finish", "served"], ["finish", "baristas"], ["queue", "give_up"], ["give_up", "gone"]]
    .map(([source, target]) => ({ "@type": "Arrow", source, target, weight: [1] })),
};
const SKIP_LANDING = `try { localStorage.setItem('pflow_skip_landing', '1'); } catch {}`;
/** The editor with APP_NET, and the App view opened the way a visitor does: the menu's item. */
const openAppView = async (p: any) => {
  await p.waitFor(`!!document.querySelector('petri-view .pv-menu-item')`, 20000);
  await p.eval(`document.querySelector('petri-view').setModel(${JSON.stringify(APP_NET)})`);
  await p.eval(`[...document.querySelectorAll('.pv-menu-item')].find((m) => m.textContent.includes('App view')).click()`);
  return p.waitFor(`!!document.querySelector('.pv-appview [data-act="run"]')`, 20000);
};

try {
  console.log(`landing smoke: ${url}`);

  console.log("signed out");
  {
    const p = await open("/");
    ok(await routed(p), "the page opens on the prompt", problemsOf(p).join(" | "));
    ok(await p.eval(`document.getElementById('landing').style.display !== 'none' && document.getElementById('editor-wrapper').style.display === 'none'`), "the landing is shown, the editor is not");
    ok(await p.eval(`document.getElementById('landing-chat-q').tagName === 'H1' && document.querySelector('#landing-chat-input').getAttribute('aria-labelledby') === 'landing-chat-q'`), "the prompt is the page's heading and names the box");
    ok(await p.waitFor(`${text("#landing-chat-state")}.includes('GitHub sign-in')`, 15000), "it says the chat needs a sign-in, before anyone types");
    ok(await p.eval(`${text("#landing-chat-send")} === 'Sign in with GitHub and start'`), "the button says what it does");
    ok(await p.eval(`!document.getElementById('landing-chat-connector').hidden && !!document.querySelector('#landing-chat-connector a[href="/mcp.html"]')`), "the connector is offered");
    ok(problemsOf(p).length === 0, "no console problems", problemsOf(p).join(" | "));

    // what is typed waits in the tab; the redirect itself is GitHub's
    await p.eval(`document.querySelector('petri-view')._loginWithGitHub = () => { window.__login = true; }`);
    await p.eval(`document.querySelector('#landing-chat-input').value = 'a coffee shop'`);
    await p.eval(`document.querySelector('input[value="design"]').click()`);
    await p.eval(`document.querySelector('#landing-chat-send').click()`);
    ok(await p.waitFor(`window.__login === true`, 5000), "submitting starts the sign-in");
    ok((await p.eval(`sessionStorage.getItem('pflow_landing_pending')`)) === JSON.stringify({ route: "design", message: "a coffee shop" }), "the words and the route wait in the tab");
    await p.close();
  }
  {
    const p = await open("/");
    await routed(p);
    await p.eval(`document.querySelector('input[value="explore"]').click()`);
    ok(await p.waitFor(`${text("#landing-chat-send")} === 'Explore'`, 5000), "Explore needs no sign-in");
    await p.eval(`document.querySelector('#landing-chat-send').click()`);
    ok(await p.waitFor(`location.pathname === '/compose.html'`, 15000), "Explore opens the composition page");
    ok(await p.waitFor(`!!document.querySelector('a[href="/?route=design"]')`, 45000), "and it links back to a design session");
    await p.close();
  }
  {
    const p = await open("/");
    await routed(p);
    await p.eval(`document.getElementById('open-editor-btn').click()`);
    ok(await p.waitFor(`document.getElementById('editor-wrapper').style.display === 'block'`, 5000), "the editor is one click away");
    ok(!(await p.eval(`!!document.querySelector('.pv-chat')`)), "and opens with no chat nobody asked for");
    await p.close();
  }

  console.log("signed in, on the page");
  for (const [route, mode] of [["auto", "auto"], ["design", "build"], ["analyse", "analyse"], ["explain", "explain"]]) {
    const p = await open("/", SIGNED_IN());
    await routed(p);
    ok(await p.waitFor(`${text("#landing-chat-state")}.includes('7 model calls left today')`, 15000), `${route}: the quota line`);
    await p.eval(`document.querySelector('input[value=${q(route)}]').click()`);
    await p.eval(`document.querySelector('#landing-chat-input').value = 'where does it jam?'`);
    await p.eval(`document.querySelector('#landing-chat-send').click()`);
    ok(await p.waitFor(`document.querySelector('.pv-chat-user')?.textContent === 'where does it jam?'`, 20000), `${route}: the message opens the session`, problemsOf(p).join(" | "));
    ok(await p.waitFor(`window.__turns.length > 0`, 20000), `${route}: the Assistant asks the proxy`);
    ok((await p.eval(`window.__turns[0].mode`)) === mode, `${route}: in mode ${mode}`, await p.eval(`window.__turns[0].mode`));
    ok(await p.eval(`JSON.stringify(window.__turns[0].messages).includes('where does it jam?')`), `${route}: with the words`);
    ok(await p.waitFor(`document.querySelector('.pv-chat-assistant')?.textContent === 'smoke reply'`, 10000), `${route}: the reply shows beside the canvas`);
    ok(await p.eval(`document.getElementById('editor-wrapper').style.display === 'block' && document.getElementById('landing').style.display === 'none'`), `${route}: the canvas is there`);
    ok(problemsOf(p).length === 0, `${route}: no console problems`, problemsOf(p).join(" | "));
    await p.close();
  }

  console.log("a submit before the status answers");
  {
    const p = await open("/", SIGNED_IN("", 2500));
    await p.waitFor(`document.querySelector('#landing-chat-hint')?.textContent.length > 0`, 20000);
    await p.eval(`document.querySelector('#landing-chat-input').value = 'too quick'`);
    await p.eval(`document.querySelector('input[value="design"]').click()`);
    await p.eval(`document.querySelector('#landing-chat-send').click()`);
    ok(await p.waitFor(`document.querySelector('.pv-chat-user')?.textContent === 'too quick'`, 20000), "it waits, and then opens the session");
    ok((await p.eval(`window.__turns[0]?.mode`)) === "build", "in the route chosen");
    ok((await p.eval(`location.search`)) === "", "and what was typed never reaches the URL", await p.eval(`location.search`));
    await p.close();
  }

  console.log("back from the sign-in, and links");
  {
    const seed = `sessionStorage.setItem('pflow_landing_pending', ${q(JSON.stringify({ route: "design", message: "a queue" }))});`;
    const p = await open("/", SIGNED_IN(seed));
    ok(await p.waitFor(`document.querySelector('.pv-chat-user')?.textContent === 'a queue'`, 20000), "what was typed before the sign-in is sent after it");
    ok((await p.eval(`window.__turns[0]?.mode`)) === "build", "in the route that was chosen");
    ok((await p.eval(`sessionStorage.getItem('pflow_landing_pending')`)) === null, "once");
    await p.close();
  }
  {
    const p = await open("/?route=analyse", SIGNED_IN());
    ok(await p.waitFor(`document.querySelector('.pv-chat-mode.pv-active')?.dataset.mode === 'analyse'`, 20000), "?route= opens the Assistant in that mode");
    ok((await p.eval(`window.__turns.length`)) === 0, "and sends nothing by itself");
    await p.close();
  }
  {
    const p = await open("/?route=design");
    ok(await p.waitFor(`document.querySelector('.pv-chat-log')?.textContent.includes('GitHub sign-in')`, 20000), "?route= signed out: the panel asks for the sign-in");
    await p.close();
  }
  {
    const p = await open("/", `try { localStorage.setItem('pflow_skip_landing', '1'); } catch {}`);
    ok(await p.waitFor(`document.getElementById('editor-wrapper').style.display === 'block'`, 15000), "a returning visitor still lands in the editor");
    await sleep(500);
    ok(!(await p.eval(`!!document.querySelector('.pv-chat')`)), "with no chat opened");
    await p.close();
  }

  console.log("a phone");
  {
    const p = await open("/", undefined, 390, 780);
    await routed(p);
    ok(await p.eval(`document.documentElement.scrollWidth <= window.innerWidth`), "no sideways scroll", String(await p.eval(`document.documentElement.scrollWidth`)));
    ok(await p.eval(`(() => { const r = document.querySelector('#landing-chat-input').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0; })()`), "the prompt fits");
    ok(await p.eval(`document.querySelector('#landing-chat-send').getBoundingClientRect().bottom <= document.documentElement.scrollHeight`), "the button is on the page");
    ok(await p.eval(`document.querySelector('#landing-chat-q').getBoundingClientRect().top >= document.querySelector('.landing-nav').getBoundingClientRect().bottom`), "the heading clears the nav");
    ok(await p.eval(`document.querySelector('.landing-hero-buttons').getBoundingClientRect().bottom <= document.querySelector('.landing-hero').getBoundingClientRect().bottom`), "the hero holds its buttons");
    await p.close();
  }

  console.log("the Assistant on a phone");
  const LONG = `window.__reply = 'a long reply '.repeat(120);`;
  for (const [w, h] of [...PHONES, [390, 380]]) {
    const label = `${w}x${h}`;
    const p = await open("/", SIGNED_IN(FAKE_KEYBOARD + LONG), w, h, true);
    await routed(p);
    ok(await p.eval(`document.documentElement.scrollWidth <= innerWidth`), `${label}: the landing has no sideways scroll`);
    ok((await p.eval(`parseFloat(getComputedStyle(document.querySelector('#landing-chat-input')).fontSize)`)) >= 16, `${label}: the prompt is 16px or more (iOS zooms in on a smaller one)`);
    for (const s of ["#landing-chat-input", "#landing-chat-send"]) {
      await p.eval(`document.querySelector(${q(s)}).scrollIntoView({ block: 'center' })`);
      ok((await p.eval(`(() => { const r = document.querySelector(${q(s)}).getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()`)), `${label}: ${s} scrolls into view`);
    }
    await p.eval(`document.querySelector('input[value="design"]').click()`);
    await p.eval(`document.querySelector('#landing-chat-input').value = 'a coffee shop'`);
    await p.eval(`document.querySelector('#landing-chat-send').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-chat-assistant')`, 20000), `${label}: the session opens`, problemsOf(p).join(" | "));
    await sleep(300);

    await panelIs(p, label);
    ok((await p.eval(`document.documentElement.scrollWidth <= innerWidth && scrollY === 0`)), `${label}: the page itself does not scroll`);
    ok((await p.eval(`parseFloat(getComputedStyle(document.querySelector('.pv-chat-input')).fontSize)`)) >= 16, `${label}: the box is 16px or more`);
    ok(await p.eval(`(() => { const b = document.querySelector('.pv-run-bar').getBoundingClientRect(), c = document.querySelector('.pv-chat').getBoundingClientRect(); return !b.height || c.bottom <= b.top; })()`), `${label}: the panel stops above the run bar`);
    ok(await p.eval(`(() => { const c = document.querySelector('.pv-chat').getBoundingClientRect(); return [...document.querySelectorAll('.pv-chat-head button')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right; }); })()`), `${label}: the head's buttons are inside the panel`);

    // The message list scrolls by itself, by touch; the input row does not move with it.
    const scrolls = await p.eval(`(() => { const l = document.querySelector('.pv-chat-log'); return l.scrollHeight > l.clientHeight; })()`);
    ok(scrolls, `${label}: a long reply is taller than the list`);
    ok(await p.eval(`(() => { const l = document.querySelector('.pv-chat-log'); return l.scrollTop + l.clientHeight >= l.scrollHeight - 2; })()`), `${label}: it opens on the newest message`);
    const box = await p.eval(`(() => { const r = document.querySelector('.pv-chat-log').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const inputAt = await p.eval(`document.querySelector('.pv-chat-input').getBoundingClientRect().top`);
    const before = await p.eval(`document.querySelector('.pv-chat-log').scrollTop`);
    // A finger, event by event: Input.synthesizeScrollGesture does nothing in headless Chrome.
    await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
    for (let i = 1; i <= 6; i++) { await p.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x, y: box.y + i * 12 }] }); await sleep(16); }
    await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(500);
    ok((await p.eval(`document.querySelector('.pv-chat-log').scrollTop`)) < before, `${label}: touch scrolls the list`);
    ok((await p.eval(`document.querySelector('.pv-chat-input').getBoundingClientRect().top`)) === inputAt, `${label}: the input row stays put`);
    await p.eval(`(() => { const l = document.querySelector('.pv-chat-log'); l.scrollTop = l.scrollHeight; })()`);

    // The browser's toolbars showing over a layout viewport that does not shrink for them.
    await p.eval(`window.__cover(56)`);
    await panelIs(p, `${label} toolbars`);

    // A keyboard over the bottom of the screen, then the browser panning to the box, as iOS does.
    const keyboard = Math.max(100, h - 380);
    await p.eval(`window.__cover(${keyboard})`);
    await panelIs(p, `${label} keyboard`);
    ok(await p.eval(`(() => { const l = document.querySelector('.pv-chat-log'); return l.clientHeight > 40 && l.scrollTop + l.clientHeight >= l.scrollHeight - 2; })()`), `${label} keyboard: the newest message stays in sight`);
    await p.eval(`window.__cover(${keyboard + 60}, 60)`);
    await panelIs(p, `${label} keyboard, panned`);

    // Everything that takes room at once, on a keyboard: the input row keeps its place, the rest scrolls.
    await p.eval(`(() => { const t = document.querySelector('.pv-chat-tools'); t.open = true; t.querySelector('ol').innerHTML = '<li>call</li>'.repeat(60); const e = document.querySelector('.pv-chat-pending'); e.hidden = false; e.innerHTML = '<p>pending</p>'.repeat(40); window.__cover(${keyboard}); })()`);
    await panelIs(p, `${label} keyboard, tools and pending open`);

    await p.eval(`window.__cover(0)`);
    await panelIs(p, `${label} keyboard gone`);
    ok(problemsOf(p).length === 0, `${label}: no console problems`, problemsOf(p).join(" | "));
    await p.close();
  }
  console.log("the Assistant's Tools section");
  for (const [w, h] of [...PHONES, [390, 380]]) {
    const label = `tools ${w}x${h}`;
    const p = await open("/?route=analyse", SIGNED_IN(FAKE_KEYBOARD), w, h, true);
    ok(await p.waitFor(`!!document.querySelector('.pv-chat-input')`, 20000), `${label}: the panel opens`, problemsOf(p).join(" | "));
    await sleep(300);
    await toolsListed(p, label, /^\d+ available, none run yet$/);
    const sum = await p.eval(`document.querySelector('.pv-chat-tools > summary').getBoundingClientRect().height`);
    ok(sum >= 36, `${label}: the summary is big enough to tap`, String(sum));
    const closed = await p.eval(REACHABLE(".pv-chat-tools > summary"));
    ok(closed === "ok", `${label}: closed, the summary is reachable`, closed);
    const logHeight = await p.eval(`document.querySelector('.pv-chat-log').clientHeight`);
    ok(logHeight > 40, `${label}: closed, the log has the room`, String(logHeight));

    // A finger opens it, and what it holds has the panel's room rather than a sliver of it.
    await tap(p, ".pv-chat-tools > summary");
    ok(await p.eval(`document.querySelector('.pv-chat-tools').open`), `${label}: a tap opens it`);
    await toolsAre(p, label);
    ok(await p.eval(`(() => { const e = document.querySelector('.pv-chat-calls-empty'); return e.getBoundingClientRect().height > 0 && e.textContent.includes('None yet'); })()`), `${label}: it says why none have run`);
    const room = await p.eval(`document.querySelector('.pv-chat-tools').clientHeight`);
    ok(room >= logHeight, `${label}: it takes the log's room`, `${room} of ${logHeight}`);

    // It scrolls by itself, by touch, and the way to close it stays on top.
    await p.eval(`document.querySelectorAll('.pv-chat-avail-group').forEach((g) => { g.open = true; })`);
    ok(await p.eval(`(() => { const t = document.querySelector('.pv-chat-tools'); return t.scrollHeight > t.clientHeight; })()`), `${label}: the list is taller than the section`);
    const inputAt = await p.eval(`document.querySelector('.pv-chat-input').getBoundingClientRect().top`);
    await swipe(p, ".pv-chat-tools", -72);
    ok((await p.eval(`document.querySelector('.pv-chat-tools').scrollTop`)) > 0, `${label}: touch scrolls the section`);
    ok((await p.eval(`scrollY`)) === 0, `${label}: and not the page`);
    ok((await p.eval(`document.querySelector('.pv-chat-input').getBoundingClientRect().top`)) === inputAt, `${label}: the input row stays put`);
    await toolsAre(p, `${label} scrolled`);
    await p.eval(`document.querySelector('.pv-chat-tools').scrollTop = 1e6`);
    await toolsAre(p, `${label} at the end of the list`);
    await p.eval(`document.querySelectorAll('.pv-chat-avail-group').forEach((g) => { g.open = false; })`);

    // Explain does not edit, so the section does not offer it.
    const all = await p.eval(`parseInt(document.querySelector('.pv-chat-tools-count').textContent)`);
    await p.eval(`document.querySelector('.pv-chat-mode[data-mode="explain"]').click()`);
    const fewer = await p.eval(`parseInt(document.querySelector('.pv-chat-tools-count').textContent)`);
    ok(fewer > 0 && fewer < all, `${label}: explain has fewer`, `${fewer} of ${all}`);
    ok(!(await p.eval(`${LISTED}.includes('net.add_place')`)) && await p.eval(`${LISTED}.includes('net.info')`), `${label}: explain lists the ones that read`);
    ok(await p.eval(`${text(".pv-chat-tools-note")}.includes('Explain mode does not edit')`), `${label}: and says why the rest are not there`);
    await p.eval(`document.querySelector('.pv-chat-mode[data-mode="analyse"]').click()`);
    ok((await p.eval(`parseInt(document.querySelector('.pv-chat-tools-count').textContent)`)) === all, `${label}: leaving explain brings them back`);
    ok(await p.eval(`getComputedStyle(document.querySelector('.pv-chat-tools-note')).display === 'none'`), `${label}: and the note goes`);

    // Sending with it open closes it, or the answer would be out of sight.
    await p.eval(`document.querySelector('petri-view').setModel(${JSON.stringify(APP_NET)})`);
    await p.eval(THREE_CALLS);
    await p.eval(`(() => { document.querySelector('.pv-chat-input').value = 'what is it doing?'; document.querySelector('.pv-chat-form').requestSubmit(); })()`);
    ok(await p.waitFor(`document.querySelectorAll('.pv-chat-call').length === 3 && !!document.querySelector('.pv-chat-assistant')`, 20000), `${label}: the calls run`, problemsOf(p).join(" | "));
    await sleep(300);
    ok(!(await p.eval(`document.querySelector('.pv-chat-tools').open`)), `${label}: sending closes it`);
    ok((await p.eval(`document.querySelector('.pv-chat-log').clientHeight`)) > 40, `${label}: the answer is in sight`);
    ok(/^\d+ available, 3 run$/.test(await toolCount(p)), `${label}: the count has the calls`, await toolCount(p));

    // The calls: a long argument wraps, an artifact fits.
    await tap(p, ".pv-chat-tools > summary");
    ok((await p.eval(`[...document.querySelectorAll('.pv-chat-call > code')].map((c) => c.textContent).join()`)) === "net.info,view.highlight,sim.ode", `${label}: the calls are listed`, await p.eval(`document.querySelector('.pv-chat-calls').textContent`));
    ok(await p.eval(`document.querySelector('.pv-chat-calls-empty').getBoundingClientRect().height === 0`), `${label}: no "none yet" beside them`);
    ok(await p.eval(`document.querySelector('.pv-chat-call-err .pv-chat-err').textContent.length > 300`), `${label}: the failure is shown`);
    await toolsAre(p, `${label} with calls`);
    await p.eval(`document.querySelector('.pv-chat-call [data-show]').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-chat-art svg')`, 5000), `${label}: an artifact opens`, problemsOf(p).join(" | "));
    await toolsAre(p, `${label} with an artifact`);
    const rerun = '.pv-chat-call [data-act="rerun"]';
    await p.eval(`document.querySelector(${q(rerun)}).scrollIntoView({ block: 'center' })`);
    await sleep(100);
    const rerunAt = await p.eval(REACHABLE(rerun));
    ok(rerunAt === "ok", `${label}: Rerun can be reached`, rerunAt);

    // Toolbars, a keyboard, the browser panning to the box: as for the rest of the panel.
    await p.eval(`window.__cover(56)`);
    await toolsAre(p, `${label} toolbars`);
    const keyboard = Math.max(100, h - 380);
    await p.eval(`window.__cover(${keyboard})`);
    await toolsAre(p, `${label} keyboard`);
    await p.eval(`window.__cover(${keyboard + 60}, 60)`);
    await toolsAre(p, `${label} keyboard, panned`);
    await p.eval(`(() => { const e = document.querySelector('.pv-chat-pending'); e.hidden = false; e.innerHTML = '<p>pending</p>'.repeat(40); })()`);
    await toolsAre(p, `${label} keyboard, pending edits too`);
    await p.eval(`(() => { const e = document.querySelector('.pv-chat-pending'); e.hidden = true; e.innerHTML = ''; })()`);
    await p.eval(`window.__cover(0)`);
    await toolsAre(p, `${label} keyboard gone`);

    // A finger closes it again, with the summary kept in sight however far the list had gone.
    await p.eval(`document.querySelector('.pv-chat-tools').scrollTop = 1e6`);
    await tap(p, ".pv-chat-tools > summary");
    ok(!(await p.eval(`document.querySelector('.pv-chat-tools').open`)), `${label}: a tap closes it`);
    ok((await p.eval(`document.querySelector('.pv-chat-log').clientHeight`)) > 40, `${label}: the log comes back`);
    await p.eval(`document.querySelector('[data-act="new"]').click()`);
    ok(/^\d+ available, none run yet$/.test(await toolCount(p)), `${label}: New clears the runs and not the tools`, await toolCount(p));
    ok((await p.eval(`document.querySelectorAll('.pv-chat-call').length`)) === 0, `${label}: and the list of them`);
    ok(problemsOf(p).length === 0, `${label}: no console problems`, problemsOf(p).join(" | "));
    await p.close();
  }
  for (const [w, h, phone] of [[1280, 900, false], [390, 664, true], [390, 380, true]] as const) {
    // Signed out the tools exist and cannot run yet, so that is what it says.
    const label = `tools signed out ${w}x${h}`;
    const p = await open("/?route=design", undefined, w, h, phone);
    ok(await p.waitFor(`document.querySelector('.pv-chat-log')?.textContent.includes('GitHub sign-in')`, 20000), `${label}: the panel asks for the sign-in`);
    await toolsListed(p, label, /^\d+ after sign-in$/);
    ok(await p.eval(`${text(".pv-chat-tools-note")}.includes('Sign in')`), `${label}: it says what they wait for`);
    await p.eval(`document.querySelector('.pv-chat-tools > summary').click()`);
    await sleep(200);
    ok(await p.eval(`document.querySelector('.pv-chat-tools-note').getBoundingClientRect().height > 0`), `${label}: and that shows`);
    ok(await p.eval(`document.querySelector('.pv-chat-tools-runs').getBoundingClientRect().height === 0`), `${label}: with no list of runs that cannot happen`);
    ok(await p.eval(`(() => { const t = document.querySelector('.pv-chat-tools'); return t.scrollWidth <= t.clientWidth; })()`), `${label}: it does not scroll sideways`);
    const got = await p.eval(REACHABLE(".pv-chat-tools > summary"));
    ok(got === "ok", `${label}: its summary is reachable`, got);
    const close = await p.eval(REACHABLE('.pv-chat [data-act="close"]'));
    ok(close === "ok", `${label}: the panel's close is reachable`, close);
    ok(problemsOf(p).length === 0, `${label}: no console problems`, problemsOf(p).join(" | "));
    await p.close();
  }
  {
    // A desktop window keeps the small section beside the log, which keeps its room and its answer.
    const p = await open("/?route=analyse", SIGNED_IN());
    ok(await p.waitFor(`!!document.querySelector('.pv-chat-input')`, 20000), "tools desktop: the panel opens");
    await toolsListed(p, "tools desktop", /^\d+ available, none run yet$/);
    await p.eval(`document.querySelector('.pv-chat-tools > summary').click()`);
    await sleep(200);
    const r = await p.eval(`document.querySelector('.pv-chat-tools').getBoundingClientRect().height`);
    ok(r > 0 && r <= 270, "tools desktop: it is at most 30vh", String(r));
    ok((await p.eval(`document.querySelector('.pv-chat-log').clientHeight`)) > 200, "tools desktop: the log keeps the rest");
    await p.close();
  }
  {
    // A pinch zoom is the reader's: the frame does not follow it, whatever the real viewport does (no fake here).
    const p = await open("/?route=design", SIGNED_IN(), 390, 664, true);
    ok(await p.waitFor(`!!document.querySelector('.pv-chat')`, 20000), "pinch: the panel opens");
    const frame = `JSON.stringify(document.querySelector('.pv-chat').getBoundingClientRect())`;
    await sleep(200);
    const at1 = await p.eval(frame);
    await p.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await sleep(300);
    ok((await p.eval(`visualViewport.scale`)) > 1.5, "pinch: the page is zoomed");
    ok((await p.eval(frame)) === at1, "pinch: the panel keeps its frame", await p.eval(frame));
    await p.close();
  }
  {
    const p = await open("/?route=design", undefined, 375, 553, true);
    ok(await p.waitFor(`document.querySelector('.pv-chat-log')?.textContent.includes('GitHub sign-in')`, 20000), "signed out on a phone: the panel asks for the sign-in");
    ok((await p.eval(REACHABLE('.pv-chat-log [data-act="login"]'))) === "ok", "and the button can be reached", await p.eval(REACHABLE('.pv-chat-log [data-act="login"]')));
    ok(await p.eval(`document.querySelector('.pv-chat-form').getBoundingClientRect().height === 0`), "and there is no box to type in yet");
    await p.close();
  }
  {
    // [hidden] wins over the form's display:flex on a desktop too: nothing to type into until there is a sign-in.
    const p = await open("/?route=design");
    ok(await p.waitFor(`document.querySelector('.pv-chat-log')?.textContent.includes('GitHub sign-in')`, 20000), "signed out on a desktop: the panel asks for the sign-in");
    ok(await p.eval(`(() => { const f = document.querySelector('.pv-chat-form'), i = document.querySelector('.pv-chat-input'); return f.hidden && getComputedStyle(f).display === 'none' && i.getBoundingClientRect().height === 0; })()`), "and there is no box to type in yet", await p.eval(`getComputedStyle(document.querySelector('.pv-chat-form')).display`));
    ok((await p.eval(REACHABLE('.pv-chat-log [data-act="login"]'))) === "ok", "and the button can be reached", await p.eval(REACHABLE('.pv-chat-log [data-act="login"]')));
    await p.close();
  }
  // The steps row is build mode's, now that [hidden] means it everywhere: it has to follow the mode as soon as it changes.
  for (const [w, h, phone] of [[1280, 900, false], [390, 664, true]] as const) {
    const label = phone ? "phone" : "desktop";
    const p = await open("/?route=analyse", SIGNED_IN(), w, h, phone);
    ok(await p.waitFor(`!!document.querySelector('.pv-chat-input')`, 20000), `${label} steps: the panel opens`);
    const steps = `getComputedStyle(document.querySelector('.pv-chat-steps')).display`;
    ok((await p.eval(steps)) === "none", `${label} steps: not in Analyse`, await p.eval(steps));
    await p.eval(`document.querySelector('.pv-chat-mode[data-mode="build"]').click()`);
    ok((await p.eval(steps)) === "flex", `${label} steps: choosing Build shows them`, await p.eval(steps));
    await p.eval(`document.querySelector('.pv-chat-mode[data-mode="explain"]').click()`);
    ok((await p.eval(steps)) === "none", `${label} steps: leaving Build hides them`, await p.eval(steps));
    await p.close();
  }
  {
    // A desktop window keeps the docked panel it had.
    const p = await open("/?route=design", SIGNED_IN());
    ok(await p.waitFor(`!!document.querySelector('.pv-chat-input')`, 20000), "desktop: the panel opens");
    const r = JSON.parse(await p.eval(`JSON.stringify(document.querySelector('.pv-chat').getBoundingClientRect())`));
    ok(r.top === 64 && r.right === 1264 && r.bottom === 884 && r.width === 444, "desktop: the frame is unchanged", JSON.stringify(r));
    ok((await p.eval(`getComputedStyle(document.querySelector('.pv-chat-input')).fontSize`)) === "14.4px", "desktop: the box's size is unchanged");
    await p.close();
  }

  console.log("the panels on a desktop");
  for (const [w, h] of DESKTOPS) {
    const label = `desktop ${w}x${h}`;
    const p = await open("/?route=design", undefined, w, h);
    ok(await p.waitFor(`!!document.querySelector('.pv-chat-log [data-act="login"]')`, 20000), `${label}: the panel opens`, problemsOf(p).join(" | "));
    await sleep(300);
    await headFits(p, label, ".pv-chat");
    const clear = await p.eval(ON_TOP_OF_THE_EDITOR(".pv-chat", ['.pv-chat-log [data-act="login"]']));
    ok(clear === "ok", `${label}: nothing from the editor is over the panel`, clear);
    ok(await p.eval(`document.querySelector('.pv-chat-head strong').scrollWidth <= document.querySelector('.pv-chat-head strong').clientWidth`), `${label}: the title has its room`);

    // Whatever the font: a much wider one takes it out of the labels, and close stays.
    await p.eval(`document.querySelector('.pv-chat-head').style.letterSpacing = '3px'`);
    await headFits(p, `${label} wide font`, ".pv-chat");
    await p.eval(`document.querySelector('.pv-chat-head').style.letterSpacing = ''`);

    // The slider and the toolbar stand clear of the panel, and are still there to use.
    for (const sel of [".pv-scale-meter", ".pv-mode-menu"]) {
      const usable = await p.eval(USABLE(sel));
      ok(usable === "ok", `${label}, open: ${sel} is on screen and on top`, usable);
    }
    await p.eval(`document.querySelector('.pv-chat [data-act="close"]').click()`);
    ok(await p.waitFor(`!document.querySelector('.pv-chat')`, 5000), `${label}: close closes it`);
    for (const sel of [".pv-scale-meter", ".pv-mode-menu"]) {
      const usable = await p.eval(USABLE(sel));
      ok(usable === "ok", `${label}, closed: ${sel} is on screen and on top`, usable);
    }
    const right = await p.eval(`innerWidth - document.querySelector('.pv-scale-meter').getBoundingClientRect().right`);
    ok(Math.abs(right - 11) <= 1, `${label}, closed: the slider is back at the edge`, String(right));
    ok(problemsOf(p).length === 0, `${label}: no console problems`, problemsOf(p).join(" | "));
    await p.close();

    // Signed in, the same head with the form and the quota below it.
    const q2 = await open("/?route=design", SIGNED_IN(), w, h);
    ok(await q2.waitFor(`!!document.querySelector('.pv-chat-input')`, 20000), `${label} signed in: the panel opens`);
    await sleep(300);
    await headFits(q2, `${label} signed in`, ".pv-chat");
    const clear2 = await q2.eval(ON_TOP_OF_THE_EDITOR(".pv-chat", [".pv-chat-input", ".pv-chat-form button"]));
    ok(clear2 === "ok", `${label} signed in: nothing from the editor is over the panel`, clear2);
    await q2.close();

    // The App view shares the head.
    const a = await open("/", SKIP_LANDING, w, h);
    ok(await openAppView(a), `${label}: the App view opens`, problemsOf(a).join(" | "));
    await sleep(300);
    await headFits(a, `${label} App view`, ".pv-appview");
    await a.eval(`document.querySelector('.pv-appview .pv-chat-head').style.letterSpacing = '3px'`);
    await headFits(a, `${label} App view wide font`, ".pv-appview");
    await a.close();
  }
  {
    // A window this wide has room for all of it, so the toolbar and the slider's height do not move for the panel.
    const p = await open("/?route=design", undefined, 1920, 1080);
    await p.waitFor(`!!document.querySelector('.pv-chat-log [data-act="login"]')`, 20000);
    await sleep(300);
    const at = await p.eval(`(() => { const r = document.querySelector('.pv-mode-menu').getBoundingClientRect(); return r.left + r.width / 2; })()`);
    ok(Math.abs(at - 960) <= 1, "desktop 1920x1080: the toolbar stays centred", String(at));
    await p.close();
  }

  console.log("the App view on a phone");
  for (const [w, h] of [...PHONES, [390, 380]]) {
    const label = `app ${w}x${h}`;
    const p = await open("/", SKIP_LANDING + FAKE_KEYBOARD, w, h, true);
    ok(await openAppView(p), `${label}: it opens`, problemsOf(p).join(" | "));
    await sleep(300);
    await appViewIs(p, label);
    ok((await p.eval(`document.documentElement.scrollWidth <= ${w} && scrollY === 0`)), `${label}: the page itself does not scroll`);
    ok(await p.eval(`(() => { const a = document.querySelector('.pv-appview').getBoundingClientRect(); return [...document.querySelectorAll('.pv-appview .pv-chat-head button')].every((b) => { const r = b.getBoundingClientRect(); return r.left >= a.left && r.right <= a.right; }); })()`), `${label}: the head's buttons are inside the panel`);
    ok((await p.eval(`document.querySelector('.pv-appview .pv-chat-head strong').getBoundingClientRect().width`)) > 0, `${label}: it says what it is`);
    ok(await p.eval(`[...document.querySelectorAll('.pv-appview input[type="number"]')].every((i) => parseFloat(getComputedStyle(i).fontSize) >= 16)`), `${label}: its number boxes are 16px or more (iOS zooms in on a smaller one)`);

    // The panel is its own scroller, by touch, and everything in it can be brought into view.
    ok(await p.eval(`(() => { const a = document.querySelector('.pv-appview'); return a.scrollHeight > a.clientHeight; })()`), `${label}: the controls are taller than the panel`);
    await p.eval(`document.querySelector('.pv-appview [data-act="run"]').scrollIntoView({ block: 'center' })`);
    await sleep(100);
    const run = await p.eval(REACHABLE('.pv-appview [data-act="run"]'));
    ok(run === "ok", `${label}: the Run button scrolls into view and is reachable`, run);
    ok((await p.eval(`scrollY`)) === 0, `${label}: the panel scrolled, not the page`);
    const box = await p.eval(`(() => { const r = document.querySelector('.pv-appview').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const before = await p.eval(`document.querySelector('.pv-appview').scrollTop`);
    await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x, y: box.y }] });
    for (let i = 1; i <= 6; i++) { await p.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x, y: box.y + i * 12 }] }); await sleep(16); }
    await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(500);
    ok((await p.eval(`document.querySelector('.pv-appview').scrollTop`)) < before, `${label}: touch scrolls the panel`);
    await p.eval(`document.querySelector('.pv-appview').scrollTop = 0`);

    // Toolbars, a keyboard, the browser panning to a focused box: as for the Assistant.
    await p.eval(`window.__cover(56)`);
    await appViewIs(p, `${label} toolbars`);
    const keyboard = Math.max(100, h - 380);
    await p.eval(`window.__cover(${keyboard})`);
    await appViewIs(p, `${label} keyboard`);
    await p.eval(`window.__cover(${keyboard + 60}, 60)`);
    await appViewIs(p, `${label} keyboard, panned`);
    await p.eval(`window.__cover(0)`);
    await appViewIs(p, `${label} keyboard gone`);

    // What a run draws stays inside the panel's width: the plot is asked for at 380, wider than a phone's panel (the solver's SVG scales down).
    await p.eval(`document.querySelector('.pv-appview [data-act="run"]').click()`);
    ok(await p.waitFor(`!document.querySelector('.pv-appview [data-act="run"]').disabled && document.querySelector('.pv-appview-results').textContent.length > 0`, 30000), `${label}: Run the day answers`, await p.eval(`document.querySelector('.pv-appview .pv-structure-status').textContent`));
    ok(await p.eval(`(() => { const a = document.querySelector('.pv-appview'); return a.scrollWidth <= a.clientWidth; })()`), `${label}: its results fit the panel's width`, await p.eval(`document.querySelector('.pv-appview').scrollWidth + ' of ' + document.querySelector('.pv-appview').clientWidth`));
    await appViewIs(p, `${label} after a run`);
    ok(problemsOf(p).length === 0, `${label}: no console problems`, problemsOf(p).join(" | "));
    await p.close();
  }
  {
    // A desktop window keeps the docked panel it had.
    const p = await open("/", SKIP_LANDING);
    ok(await openAppView(p), "app desktop: it opens", problemsOf(p).join(" | "));
    const r = JSON.parse(await p.eval(`JSON.stringify(document.querySelector('.pv-appview').getBoundingClientRect())`));
    ok(r.top === 64 && r.left === 16 && r.bottom === 884 && r.width === 424, "app desktop: the frame is unchanged", JSON.stringify(r));
    await p.close();
  }

  // The narrowest phones still sold. Against the literal 320: on a mobile layout an overflowing page can widen innerWidth with it.
  console.log("320 wide");
  for (const phone of [false, true]) {
    const label = `320x568${phone ? " mobile" : ""}`;
    const p = await open("/", undefined, 320, 568, phone);
    await routed(p);
    const widest = `Math.max(document.documentElement.scrollWidth, document.body.scrollWidth)`;
    ok((await p.eval(widest)) <= 320, `${label}: no sideways scroll`, String(await p.eval(widest)));
    await p.eval(`window.scrollTo(100, 0)`);
    ok((await p.eval(`window.scrollX`)) === 0, `${label}: the page will not pan sideways`, String(await p.eval(`window.scrollX`)));
    ok((await p.eval(`document.querySelector('.landing-nav-links').getBoundingClientRect().right`)) <= 320, `${label}: the nav's links fit`, String(await p.eval(`document.querySelector('.landing-nav-links').getBoundingClientRect().right`)));
    ok(await p.eval(`[...document.querySelectorAll('.landing-nav-links a')].every((a) => { const r = a.getBoundingClientRect(); return r.left >= 0 && r.right <= 320; })`), `${label}: every link is on the screen`);
    ok(await p.eval(`document.querySelector('.landing-nav img').getBoundingClientRect().right <= document.querySelector('.landing-nav-links').getBoundingClientRect().left || document.querySelector('.landing-nav img').getBoundingClientRect().bottom <= document.querySelector('.landing-nav-links').getBoundingClientRect().top`), `${label}: the logo and the links do not overlap`);
    ok(await p.eval(`document.querySelector('#landing-chat-q').getBoundingClientRect().top >= document.querySelector('.landing-nav').getBoundingClientRect().bottom`), `${label}: the heading clears the nav`);
    await p.close();
  }
} finally {
  await stop();
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
Deno.exit(failures ? 1 : 0);
