// Browser check of the Ask pane (public/petri-chat-ui.js, public/petri-results-pane.js; docs/design/agent-first-analysis.md
// sections 3, 4, 6 and 9).
//
//   deno run -A scripts/ask-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome]
//
// In headless Chrome, with every call to the model answered in the page (it cannot sign in to GitHub and must not spend a
// model call): the pane's five states (the full agent, signed out, signed in but not allowed, the quota used up, the model
// down), a goal result as a card with the model's answer labelled assistant and the evidence labelled engine, the footer's
// five actions, Change on an assumption, the follow-ups, Not that, a result gone stale, the intent chip and "Not what I
// meant", the model's question card, the pending card with the draft's assumptions and the problems list in front of Apply,
// Describe folded into a first build message, and the phone layout. It proves the pane's wiring, the browser side of the
// request, and the layout; it says nothing about Gemini.
//
// ASK_SHOTS=<dir> writes a PNG of each state it names (1280x800 and 390x844).
//
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure; scripts/smoke-gate.sh is the
// way to run it before a push, because it keeps the log and reads that status.
import { sleep, startChrome } from "./cdp.ts";

const url = Deno.args.find((a) => a.startsWith("http"));
if (!url) { console.error("usage: deno run -A scripts/ask-smoke.ts <url of /> [--chrome path]"); Deno.exit(2); }
const chromeArg = Deno.args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? Deno.args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = Deno.env.get("ASK_SHOTS");
const { newPage, stop } = await startChrome(CHROME, "ask-smoke-");

let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};
const q = (s: string) => JSON.stringify(s);
let sectionAt = Date.now();
/** A heading, with how long the section before it took (the smoke is slow by nature: a page per state). */
const heading = (name: string) => {
  const secs = Math.round((Date.now() - sectionAt) / 1000);
  if (secs > 0 && checks > 0) console.log(`  (${secs} s)`);
  sectionAt = Date.now();
  console.log(name);
};
const text = (sel: string) => `(document.querySelector(${q(sel)})?.textContent || '')`;
const problemsOf = (p: any) => p.problems.filter((x: string) => !/\/img\/z\w+\.svg/.test(x));

async function shot(p: any, name: string) {
  if (!SHOTS) return;
  await Deno.mkdir(SHOTS, { recursive: true });
  const r = await p.send("Page.captureScreenshot", { format: "png" });
  await Deno.writeFile(`${SHOTS}/${name}.png`, Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)));
}

// ---- the page's stand-in for the server: status, sign-in, the model's turns and the draft ----

type Cfg = { status: Record<string, unknown>; signedIn?: boolean };
const SIGNED_IN_STATUS = { enabled: true, chat: true, signed_in: true, allowed: true, remaining_today: 7, reset: "2026-11-03T00:00:00Z", toolsets: ["all", "goals"] };
const SIGNED_OUT_STATUS = { enabled: true, chat: true, signed_in: false, toolsets: ["all", "goals"] };
const NOT_ALLOWED_STATUS = { ...SIGNED_IN_STATUS, allowed: false };
const QUOTA_STATUS = { ...SIGNED_IN_STATUS, remaining_today: 0 };
const OFF_STATUS = { enabled: false };

/**
 * Before any script. `window.__script` is what the model says next, one entry per /api/llm/turn call: {reply, calls, auto, status,
 * body, remaining, delay (ms before it answers)}; `window.__draft` what /api/llm/draft answers; `window.__turns` and `window.__drafts` are the bodies received.
 */
const STUB = (cfg: Cfg) => `
  window.__turns = []; window.__drafts = []; window.__script = []; window.__draft = null; window.__logins = 0;
  window.__status = ${JSON.stringify(cfg.status)};
  try { ${cfg.signedIn === false ? "" : "localStorage.setItem('pflow_auth_token', 'smoke-token');"} localStorage.setItem('pflow_skip_landing', '1'); } catch {}
  const real = window.fetch;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (u, opts) => {
    const path = new URL(String(u?.url ?? u), location.href).pathname;
    if (path === '/api/llm/status') return json(window.__status);
    if (path === '/auth/user') return ${cfg.signedIn === false ? "new Response('{}', { status: 401 })" : "json({ user: { id: '1', email: '', user_name: 'smoke', full_name: 'Smoke' } })"};
    if (path === '/api/llm/turn') {
      const body = JSON.parse(opts.body);
      window.__turns.push(body);
      const r = window.__script.shift() || { reply: 'done' };
      if (r.delay) await new Promise((done) => setTimeout(done, r.delay));
      if (r.status) return json(r.body || { error: 'failed' }, r.status);
      const parts = [...(r.reply ? [{ text: r.reply }] : []), ...(r.calls || []).map((c) => ({ functionCall: { name: c.name, args: c.args || {} } }))];
      return json({ reply: r.reply || '', tool_calls: r.calls || [], message: { role: 'model', parts: parts.length ? parts : [{ text: '' }] },
        remaining_today: r.remaining ?? 6, reset: '2026-11-03T00:00:00Z', ...(r.auto ? { auto: r.auto } : {}) });
    }
    if (path === '/api/llm/draft') {
      window.__drafts.push(JSON.parse(opts.body));
      const d = window.__draft || { status: 200, body: { draft: null } };
      return json(d.body, d.status || 200);
    }
    return real(u, opts);
  };`;

/** A reply of the model, in what the stub above turns into the server's turn answer. */
const say = (reply: string, calls: Array<{ name: string; args?: unknown }> = [], extra: Record<string, unknown> = {}) => ({ reply, calls, ...extra });
const goal = (goal_id: string, inputs?: unknown, extra: Record<string, unknown> = {}) => ({ name: "run_goal", args: { goal_id, ...(inputs === undefined ? {} : { inputs: JSON.stringify(inputs) }), ...extra } });
const script = (p: any, ...replies: unknown[]) => p.eval(`window.__script.push(...${JSON.stringify(replies)})`);

// An SIR net with words for ids (the router names a place from the words), rates on both transitions, and a sink (recovered).
const NET = {
  "@context": "https://pflow.xyz/schema", "@type": "PetriNet",
  places: {
    susceptible: { "@type": "Place", initial: [40], capacity: [0], x: 120, y: 160 },
    infected: { "@type": "Place", initial: [2], capacity: [0], x: 320, y: 160 },
    recovered: { "@type": "Place", initial: [0], capacity: [0], x: 520, y: 160 },
  },
  transitions: {
    infect: { "@type": "Transition", rate: 0.02, x: 220, y: 160 },
    recover: { "@type": "Transition", rate: 0.1, x: 420, y: 160 },
  },
  arcs: [["susceptible", "infect"], ["infected", "infect"], ["infect", "infected", 2], ["infected", "recover"], ["recover", "recovered"]]
    .map(([source, target, w]) => ({ "@type": "Arrow", source, target, weight: [w ?? 1] })),
};
const EMPTY = { "@context": "https://pflow.xyz/schema", "@type": "PetriNet", places: {}, transitions: {}, arcs: [] };
const CLEAN = `try { localStorage.clear(); sessionStorage.clear(); } catch {}`;

async function open(cfg: Cfg, { net = NET, width = 1280, height = 800, phone = false, mode }: { net?: unknown; width?: number; height?: number; phone?: boolean; mode?: string } = {}) {
  const p = await newPage(width, height);
  if (phone) {
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    await p.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  }
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: CLEAN + STUB(cfg) });
  await p.goto(new URL("/", url).href);
  await p.waitFor(`!!document.querySelector('petri-view .pv-menu-item') && document.getElementById('editor-wrapper')?.style.display === 'block'`, 30000);
  await p.eval(`document.querySelector('petri-view').setModel(${JSON.stringify(net)})`);
  // the hooks the menu adds to the view (it is another package's); the pane calls them when they are there
  await p.eval(`(() => { const v = document.querySelector('petri-view');
    window.__hooks = { copied: [], linked: [], tools: [] };
    v._copyToClipboard = (t, okf) => { window.__hooks.copied.push(t); okf?.(); };
    v._copyViewLink = (r) => { window.__hooks.linked.push(r); };
    v._openPaletteFor = (r) => { window.__hooks.tools.push(r); };
    v._loginWithGitHub = () => { window.__logins++; };
  })()`);
  if (mode !== undefined) await p.eval(`document.querySelector('petri-view')._openChat(${JSON.stringify({ mode })})`);
  return p;
}
const openPane = (p: any, opts: Record<string, unknown> = {}) => p.eval(`document.querySelector('petri-view')._openChat(${JSON.stringify(opts)})`).then(() => p.waitFor(`!!document.querySelector('.pv-chat-input')`, 30000));
const type = (p: any, t: string) => p.eval(`(() => { const i = document.querySelector('.pv-chat-input'); i.value = ${q(t)}; document.querySelector('.pv-chat-form').requestSubmit(); })()`);
const cards = (p: any) => p.eval(`document.querySelectorAll('.pv-ask-card').length`);

const DRAFT = {
  name: "Coffee shop", summary: "Customers queue and baristas serve them.", assumptions: ["One barista serves one customer at a time."],
  places: [
    { id: "queue", label: "Queue", description: "Customers waiting", initial: 0, capacity: 0 },
    { id: "barista", label: "Barista", description: "Free baristas", initial: 2, capacity: 0 },
    { id: "served", label: "Served", description: "Customers served", initial: 0, capacity: 0 },
  ],
  transitions: [
    { id: "arrive", label: "Arrive", description: "A customer arrives", rate: 1.5 },
    { id: "serve", label: "Serve", description: "A barista serves a customer", rate: 2.5 },
  ],
  arcs: [
    { from: "arrive", to: "queue", weight: 1, inhibitor: false }, { from: "queue", to: "serve", weight: 1, inhibitor: false },
    { from: "barista", to: "serve", weight: 1, inhibitor: false }, { from: "serve", to: "barista", weight: 1, inhibitor: false },
    { from: "serve", to: "served", weight: 1, inhibitor: false },
  ],
};
// Inside what can be seen, and actually the top thing there (as the landing smoke's REACHABLE).
const REACHABLE = (sel: string) => `(() => {
  const e = document.querySelector(${q(sel)}); if (!e) return 'missing';
  const r = e.getBoundingClientRect();
  const vv = window.visualViewport, top = vv.offsetTop, bottom = vv.offsetTop + vv.height;
  if (r.width === 0 || r.left < 0 || r.right > innerWidth || r.top < top || r.bottom > bottom) return 'off screen: ' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ' of ' + innerWidth + ' visible ' + top + '..' + bottom;
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return at === e || e.contains(at) ? 'ok' : 'covered by ' + (at?.className || at?.tagName);
})()`;
const notStale = `[...document.querySelectorAll('.pv-ask-card')].map((c) => c.dataset.stale).join()`;
const ASK_CARD = say("", [{ name: "ask_user", args: { question: "Better in what way?", options: ["Fewer in infected", "More in recovered"], default_option: "More in recovered" } }], { auto: { mode: "analyse", sentiment: "neutral", confidence: 0.8 } });
const CHIP_REPLY = (mode: string) => ({ auto: { mode, sentiment: "neutral", confidence: 0.9 } });
const waitCards = (p: any, n: number) => p.waitFor(`document.querySelectorAll('.pv-ask-card').length === ${n}`, 60000);

try {
  console.log(`ask smoke: ${url}`);

  heading("the full agent: a goal result as a card");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    ok(await p.eval(`document.querySelectorAll('.pv-chat-mode, [role="tablist"]').length === 0`), "there are no mode tabs");
    ok(!(await p.eval(`/Auto|Let it decide/.test(document.querySelector('.pv-chat').textContent)`)), "'Auto' and 'Let it decide' appear nowhere in the pane");
    ok(await p.eval(`document.querySelector('.pv-chat').getAttribute('aria-label') === 'Ask'`), "the pane is called Ask");
    ok(await p.eval(`getComputedStyle(document.querySelector('.pv-ask-intent')).display === 'none'`), "no intent chip before there is a message");
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-suggest button').length >= 3`, 15000), "the empty state offers suggested questions", problemsOf(p).join(" | "));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-goalcard').length >= 8`), "and the goal cards as a grid");
    ok(await p.eval(`document.querySelector('.pv-chat-input').placeholder.startsWith('Ask about the net')`), "the box invites a question");
    ok(await p.eval(`document.querySelector('.pv-ask-state').hidden`), "the full agent has no state line to show");
    await shot(p, "01-agent-empty-1280");

    await script(p,
      say("", [goal("risk")], { auto: { mode: "analyse", sentiment: "neutral", confidence: 0.9 } }),
      say("Twenty seeded runs give a spread, not a tail probability. I looked at **infected** and found 9,731 runs ended in 4,417."));
    await type(p, "How bad can it get?");
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-card').length === 1`, 60000), "the model's goal lands as a card", problemsOf(p).join(" | "));
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-card .pv-ask-answer .pv-prov-ast')`, 20000), "and the reply that followed is the card's answer");
    ok((await p.eval(`window.__turns[0].toolset`)) === "goals" && (await p.eval(`window.__turns[0].mode`)) === "auto", "the request names the goal toolset and nothing forced");
    ok(await p.eval(`${text(".pv-ask-card .pv-ask-title")}.startsWith('I answered: “')`), "the card says which goal the model chose", await p.eval(text(".pv-ask-card .pv-ask-title")));
    ok(await p.eval(`document.querySelector('.pv-ask-card .pv-ask-answer .pv-prov-chip').textContent === 'assistant'`), "the model's words are labelled assistant");
    ok(await p.eval(`!!document.querySelector('.pv-ask-card .pv-ask-evidence .pv-ask-eng') && document.querySelector('.pv-ask-card .pv-ask-eng').textContent === 'engine' && !!document.querySelector('.pv-ask-card .pv-ask-art svg')`), "the evidence is labelled engine and drawn");
    ok(await p.eval(`/spread, not a tail probability|Twenty/i.test(${text(".pv-ask-card .pv-ask-shape")})`), "the caveat is the goal's own (goals.json)", await p.eval(text(".pv-ask-card .pv-ask-shape")));
    ok(await p.eval(`!!document.querySelector('.pv-ask-card .pv-prov[open]')`), "the footer is open for the first result");
    ok(await p.eval(`document.querySelectorAll('.pv-chat-assistant').length === 0`), "the reply is not shown twice (once as a bubble, once on the card)");
    ok(await p.eval(`(() => { const c = document.querySelector('.pv-ask-card').getBoundingClientRect(), l = document.querySelector('.pv-chat-log').getBoundingClientRect(); return Math.abs(c.top - l.top) < 24 && scrollY === 0; })()`), "a card scrolls into view from its top, and the page does not scroll with it", await p.eval(`JSON.stringify([document.querySelector('.pv-ask-card').getBoundingClientRect().top, document.querySelector('.pv-chat-log').getBoundingClientRect().top, scrollY])`));
    ok(await p.eval(`document.querySelector('.pv-ask-card [data-kind="stray"]')?.textContent === 'a number in this reply is not in the results'`), "a number in the reply that is in no result gets the warning chip", await p.eval(`document.querySelector('.pv-ask-card .pv-ask-warns')?.textContent`));
    ok(await p.eval(`document.querySelector('.pv-ask-intent').offsetHeight > 0 && ${text(".pv-ask-chip")} === 'Analysing'`), "the head shows the intent chip after the reply", await p.eval(text(".pv-ask-chip")));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-follow button').length >= 2 && document.querySelectorAll('.pv-ask-follow button').length <= 3`), "2 to 3 follow-ups");
    ok(await p.eval(`document.querySelector('.pv-ask-card [data-ask="notthat"]')?.textContent === 'Not that'`), "Not that is on the card");
    ok(problemsOf(p).length === 0, "no console problems", problemsOf(p).join(" | "));
    await shot(p, "02-agent-result-1280");
    // both themes: the card and the pane follow the tokens
    const bg = (sel: string) => `getComputedStyle(document.querySelector(${q(sel)})).backgroundColor`;
    const light = [await p.eval(bg(".pv-ask-card")), await p.eval(bg(".pv-chat"))];
    await p.eval(`document.documentElement.setAttribute('data-theme', 'dark')`);
    const dark = [await p.eval(bg(".pv-ask-card")), await p.eval(bg(".pv-chat"))];
    ok(light[0] !== dark[0] && light[1] !== dark[1], "the card and the pane change with the theme", JSON.stringify({ light, dark }));
    ok(await p.eval(`(() => { const c = getComputedStyle(document.querySelector('.pv-ask-card')).color; return c !== getComputedStyle(document.querySelector('.pv-ask-card')).backgroundColor; })()`), "text and ground differ in the dark");
    await shot(p, "02b-agent-result-dark-1280");
    await p.eval(`document.documentElement.removeAttribute('data-theme')`);

    heading("Tools: the goal toolset, and the rest under Tools");
    ok(await p.eval(`/^\\d+ available, 1 run$/.test(${text(".pv-chat-tools-count")})`), "the count is of the tools there are (the goal toolset) and the runs", await p.eval(text(".pv-chat-tools-count")));
    ok((await p.eval(`parseInt(${text(".pv-chat-tools-count")})`)) === (await p.eval(`fetch('/llm-goal-tools.json').then((r) => r.json()).then((m) => m.tools.length)`)), "the goal toolset's number");
    await p.eval(`document.querySelector('.pv-chat-tools > summary').click()`);
    ok(await p.eval(`/The other \\d+ commands it reaches through run_command/.test(${text(".pv-chat-tools-note")}) && /Tools \\((⌘K|Ctrl K)\\)/.test(${text(".pv-chat-tools-note")})`), "it says the rest is under Tools, with the shortcut", await p.eval(text(".pv-chat-tools-note")));
    ok(await p.eval(`document.querySelectorAll('.pv-chat-calls .pv-chat-call').length === 1 && document.querySelector('.pv-chat-call > code').textContent === 'run_goal'`), "and lists what it has run");
    await p.eval(`document.querySelector('.pv-chat-tools-note [data-ask="palette"]').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-palette')`, 15000), "Open Tools opens the palette");
    await p.press("Escape");
    ok(await p.waitFor(`!document.querySelector('.pv-palette')`, 5000), "which closes again");
    await p.eval(`document.querySelector('.pv-chat-tools').open = false`);
    // every control in the pane has a name a screen reader can say
    const unnamed = await p.eval(`[...document.querySelectorAll('.pv-chat button, .pv-chat input, .pv-chat select, .pv-chat textarea')].filter((e) => e.getBoundingClientRect().width > 0 && !(e.getAttribute('aria-label') || e.textContent.trim() || (e.id && document.querySelector('label[for="' + e.id + '"]')) || e.closest('label') || e.title)).map((e) => e.outerHTML.slice(0, 80))`);
    ok(unnamed.length === 0, "every control in the pane has an accessible name", unnamed.join(" | "));
    ok(await p.eval(`document.querySelector('.pv-chat-log').getAttribute('role') === 'log' && !!document.querySelector('.pv-ask-sr[aria-live="polite"]') && document.querySelector('.pv-ask-card').getAttribute('aria-label').startsWith('Result: ')`), "the log is a log, results are announced in a live region, and a card is labelled");

    heading("the footer's five actions");
    const acts = ".pv-ask-card .pv-prov-acts";
    ok(await p.eval(`document.querySelectorAll('${acts} [data-act]').length === 5`), "the footer has its five actions");
    // Rerun: the same calls, the same seed: the same artifacts, so it says so (and adds no card)
    await p.eval(`document.querySelector('${acts} [data-act="rerun"]').click()`);
    ok(await p.waitFor(`/^Reproduced/.test(${text(".pv-ask-card .pv-ask-note")})`, 30000), "Rerun reproduces the result and says so", await p.eval(text(".pv-ask-card .pv-ask-note")));
    ok((await cards(p)) === 1, "and adds no card");
    // Edit settings: a form per call, prefilled; Run adds a new card next to the old one
    await p.eval(`document.querySelector('${acts} [data-act="edit"]:not([data-field])').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-edit [data-field="runs"]')`, 5000), "Edit settings opens a form from the command's JSON Schema");
    ok((await p.eval(`document.querySelector('.pv-ask-edit [data-field="runs"]').value`)) === "20", "prefilled with what the call ran with");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-edit fieldset').length >= 1 && /sim\.ssa/.test(document.querySelector('.pv-ask-edit').textContent)`), "one section per call that has settings");
    await p.eval(`(() => { document.querySelector('.pv-ask-edit [data-field="runs"]').value = '31'; document.querySelector('.pv-ask-editform').requestSubmit(); })()`);
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-card').length === 2`, 60000), "Run adds a second card");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-prov-calls').textContent.includes('"runs":31')`), "with the person's setting in its calls");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[0].querySelector('.pv-prov-calls').textContent.includes('"runs":20')`), "and the first card is as it was");
    ok(await p.eval(`/Settings edited by you/.test(document.querySelectorAll('.pv-ask-card')[1].textContent)`), "the new card says the settings were edited");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[1].getAttribute('data-source') === 'ask' && document.querySelector('.pv-ask-card + .pv-ask-card [data-ask="notthat"]') === null`), "a card the person ran has no Not that");
    // Copy MCP call: the calls of the record, as tools/call params
    await p.eval(`document.querySelector('${acts} [data-act="mcp"]').click()`);
    const mcp = JSON.parse(await p.eval(`window.__hooks.copied.at(-1)`));
    ok(Array.isArray(mcp) && mcp.map((c: any) => c.name).join() === "sim.recommend,sim.ssa" && mcp[1].arguments.runs === 20, "Copy MCP call copies the record's calls", JSON.stringify(mcp).slice(0, 160));
    // Copy link and Open in Tools call the view's hooks with the record
    await p.eval(`document.querySelector('${acts} [data-act="link"]').click()`);
    ok(await p.eval(`window.__hooks.linked.length === 1 && window.__hooks.linked[0].goal.id === 'risk' && window.__hooks.linked[0].calls.length === 2`), "Copy link calls the view's hook with the record");
    await p.eval(`document.querySelector('${acts} [data-act="tools"]').click()`);
    ok(await p.eval(`window.__hooks.tools.length === 1 && window.__hooks.tools[0].goal.id === 'risk'`), "Open in Tools calls the view's hook with the record");
    // with the view's own hooks (the menu and links packages put them on <petri-view>; the stubs above shadow them on this one
    // element, so deleting the stubs lets the real methods through): Copy link copies a link that carries the view, and Open in
    // Tools opens the palette on the form of the record's first call
    await p.eval(`(() => { const v = document.querySelector('petri-view'); delete v._copyViewLink; delete v._openPaletteFor; })()`);
    ok(await p.eval(`typeof document.querySelector('petri-view')._copyViewLink === 'function' && typeof document.querySelector('petri-view')._openPaletteFor === 'function'`), "(the view has its own Copy link and Open in Tools once the stubs are gone)");
    await p.eval(`document.querySelector('${acts} [data-act="link"]').click()`);
    ok(await p.waitFor(`/#view=/.test(window.__hooks.copied.at(-1) || '')`, 30000), "with the view's own hook, Copy link copies a link that carries #view=", await p.eval(`String(window.__hooks.copied.at(-1)).slice(0, 120)`));
    await p.eval(`document.querySelector('${acts} [data-act="tools"]').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-palette') && !document.querySelector('.pv-palette [data-pane=form]').hidden`, 10000), "with the view's own hook, Open in Tools opens the palette on a form");
    ok(await p.eval(`document.querySelector('.pv-palette .pv-palette-form-sub code')?.textContent === 'sim.recommend'`), "the form is the first call's command", await p.eval(`document.querySelector('.pv-palette .pv-palette-form-sub code')?.textContent`));
    await p.eval(`document.querySelector('.pv-palette [data-act="close"]').click()`);
    ok(await p.eval(`!document.querySelector('.pv-palette')`), "(the palette closes)");
    // without the hooks (a view that has not got them) each says so. The stubs are gone, so say "not there" the way a vendored copy without them would
    await p.eval(`(() => { const v = document.querySelector('petri-view'); v._copyViewLink = undefined; v._openPaletteFor = undefined; })()`);
    await p.eval(`document.querySelector('${acts} [data-act="link"]').click()`);
    ok(await p.waitFor(`/Copy link is not available here/.test(document.querySelector('.pv-toast-host')?.textContent || '')`, 3000), "Copy link says so when the view has no hook");
    await p.eval(`document.querySelector('${acts} [data-act="tools"]').click()`);
    ok(await p.waitFor(`/Open in Tools is not available here/.test(document.querySelector('.pv-toast-host')?.textContent || '')`, 3000), "and so does Open in Tools");
    ok(problemsOf(p).length === 0, "no console problems after the actions", problemsOf(p).join(" | "));
    await shot(p, "03-agent-two-cards-1280");

    heading("a result made stale by an edit, and the follow-ups");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card[data-stale="true"]').length === 0`), "no card is stale yet");
    await p.eval(`document.querySelector('petri-view').execute('sim.set_rate', { id: 'infect', rate: 0.05 })`);
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-card[data-stale="true"]').length === 2`, 5000), "an edit to the net marks every result 'net changed since'");
    ok(await p.eval(`!!document.querySelector('.pv-ask-card .pv-ask-stale [data-ask="rerun"]') && /net changed since/.test(document.querySelector('.pv-ask-card summary').textContent)`), "with a Rerun, and the chip on the footer");
    await shot(p, "04-stale-1280");
    await p.eval(`document.querySelector('.pv-ask-card .pv-ask-stale [data-ask="rerun"]').click()`);
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-card').length === 3`, 60000), "Rerun of a stale result is a new card on the net as it is now");
    ok(await p.eval(`[...document.querySelectorAll('.pv-ask-card')].map((c) => c.dataset.stale).join() === 'true,false,true'`), "the new card (placed beside the one it reran) is current; the two made before the edit stay stale", await p.eval(`[...document.querySelectorAll('.pv-ask-card')].map((c) => c.dataset.stale).join()`));
    // a follow-up goes in the box and is sent; no model call makes it up
    const before = await p.eval(`window.__turns.length`);
    await script(p, say("", [goal("knob")]), say("It is the infection rate."));
    const question = await p.eval(`document.querySelector('.pv-ask-card .pv-ask-follow button').textContent`);
    await p.eval(`document.querySelector('.pv-ask-card .pv-ask-follow button').click()`);
    ok(await p.waitFor(`window.__turns.length === ${before + 2}`, 60000), "a follow-up sends its question", String(await p.eval(`window.__turns.length`)));
    ok((await p.eval(`window.__turns[${before}].messages.at(-1).parts[0].text`)) === question, "the question is the follow-up's own words", question);
    await p.close();
  }

  heading("Assumed, and Change");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, say("", [goal("knob", {})], CHIP_REPLY("analyse")), say("The infection rate matters most."));
    await type(p, "which knob matters for recovered people?");
    ok(await waitCards(p, 1), "the goal lands", problemsOf(p).join(" | "));
    ok(await p.eval(`/I took the outcome to watch to be recovered\./.test(${text(".pv-ask-card .pv-ask-assumed")})`), "an input read off the person's words is a visible assumption", await p.eval(text(".pv-ask-card .pv-ask-assumed")));
    await p.eval(`document.querySelector('.pv-ask-card [data-ask="change"]').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-card .pv-ask-changer select')`, 3000), "Change opens a select");
    ok(await p.eval(`[...document.querySelectorAll('.pv-ask-changer option')].map((o) => o.value).join() === 'susceptible,infected,recovered' && document.querySelector('.pv-ask-changer select').value === 'recovered'`), "of the net's places, on the value assumed");
    await p.eval(`(() => { const s = document.querySelector('.pv-ask-changer select'); s.value = 'infected'; s.closest('li').querySelector('[data-do="go"]').click(); })()`);
    ok(await waitCards(p, 2), "Run with this adds a new card, with no model call", problemsOf(p).join(" | "));
    ok((await p.eval(`window.__turns.length`)) === 2, "(the model was asked only for the question itself)", String(await p.eval(`window.__turns.length`)));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-ask-assumed').textContent.includes('infected (changed by you)')`), "its assumption row says the person's value", await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-ask-assumed').textContent`));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-prov-calls').textContent.includes('"observable":"infected"')`), "and the call it ran has it");
    ok(await p.eval(`/Ran again with/.test(document.querySelectorAll('.pv-ask-card')[0].querySelector('.pv-ask-note').textContent)`), "the first card says it was run again");
    // the footer's own Change buttons (on the Assumed row of the record) open Edit settings on that field
    await p.eval(`document.querySelectorAll('.pv-ask-card')[0].querySelector('.pv-prov-assumed [data-act="edit"][data-field]')?.click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-card .pv-ask-edit:not([hidden]) [data-field="observable"]')`, 3000), "the footer's Change opens the form on that argument");
    await p.close();
  }

  heading("Not that");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, say("", [goal("risk")], CHIP_REPLY("analyse")), say("It can swing."));
    await type(p, "what could go wrong with the epidemic");
    ok(await waitCards(p, 1), "the model's goal lands");
    await script(p, say("", [goal("conserved")]), say("Susceptible plus infected plus recovered stays fixed."));
    await p.eval(`document.querySelector('.pv-ask-card [data-ask="notthat"]').click()`);
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-card').length === 2`, 60000), "Not that asks again and a different goal lands", problemsOf(p).join(" | "));
    const body = await p.eval(`window.__turns[2]`); // the first two were the original answer's two rounds
    ok(body.messages.length === 1 && body.messages[0].parts[0].text === "what could go wrong with the epidemic\n\n(Not “How bad can it get? What's the spread?”: choose a different goal for this.)", "the same words are sent again with the goal to leave, and the first attempt is out of the conversation", JSON.stringify(body.messages.map((m: any) => m.parts[0])).slice(0, 220));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[0].dataset.aside === 'true' && !document.querySelectorAll('.pv-ask-card')[0].querySelector('[data-ask="notthat"]')`), "the first card is set aside");
    ok(await p.eval(`!!document.querySelectorAll('.pv-ask-card')[1].querySelector('[data-ask="notthat"]')`), "and the new answer has its own Not that");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-ask-title').textContent.includes('I answered: “Is anything conserved?”')`), "naming the goal it chose this time", await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-ask-title').textContent`));

    heading("a kept conversation survives closing the pane");
    await p.eval(`document.querySelector('.pv-chat [data-act="close"]').click()`);
    ok(await p.eval(`!document.querySelector('.pv-chat')`), "close closes it");
    await openPane(p, { mode: "auto" });
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card').length === 2 && document.querySelectorAll('.pv-chat-user').length === 1`), "and opening it again has the same cards and message");
    ok(await p.eval(`document.querySelector('petri-view')._askPane.chat.messages.length >= 2`), "and the conversation the model sees");
    await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-prov-acts [data-act="rerun"]').click()`);
    ok(await p.waitFor(`/^Reproduced/.test(document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-ask-note').textContent)`, 30000), "the cards are still wired: Rerun works after reopening");
    await p.eval(`document.querySelector('.pv-chat [data-act="new"]').click()`);
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card').length === 0 && document.querySelectorAll('.pv-chat-user').length === 0 && document.querySelector('petri-view')._askPane.chat.messages.length === 0`), "New starts afresh");
    await p.close();
  }

  heading("an engine the person asked for against the recommendation is a chip");
  {
    const capped = JSON.parse(JSON.stringify(NET));
    capped.places.infected.capacity = [10]; // a capacity: the engine recommends the SSA
    const p = await open({ status: SIGNED_IN_STATUS }, { net: capped });
    await openPane(p, { mode: "auto" });
    await script(p, say("", [goal("average", {}, { engine_override: "ode" })], CHIP_REPLY("analyse")), say("The ODE ignores the capacity, as the chip says."));
    await type(p, "use the ODE for the average");
    ok(await waitCards(p, 1), "the goal runs on the engine the words named", problemsOf(p).join(" | "));
    ok(await p.eval(`document.querySelector('.pv-ask-card .pv-ask-warns [data-kind="override"]')?.textContent === 'engine override'`), "the card carries an 'engine override' chip", await p.eval(`document.querySelector('.pv-ask-card .pv-ask-warns')?.textContent`));
    ok(await p.eval(`/recommends SSA|sim\.recommend/.test(document.querySelector('.pv-ask-card .pv-ask-warns [data-kind="warn"]')?.textContent || '')`), "and the guard's own warning", await p.eval(`document.querySelector('.pv-ask-card .pv-ask-warns')?.textContent`));
    ok(await p.eval(`document.querySelector('.pv-ask-card .pv-prov-calls').textContent.includes('sim.ode')`), "the call is the ODE's");
    await shot(p, "21-override-1280");
    await p.close();
  }

  heading("the intent chip and \"Not what I meant\"");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, say("Place S holds the people who can still catch it.", [], CHIP_REPLY("analyse")), say("Susceptible people can still catch it; that is all S means.", [], {}));
    await type(p, "what is S?");
    ok(await p.waitFor(`document.querySelectorAll('.pv-chat-assistant').length === 1`, 20000), "a plain reply is a bubble");
    ok(await p.waitFor(`${text(".pv-ask-chip")} === 'Analysing'`, 5000), "the chip says what the server labelled it", await p.eval(text(".pv-ask-chip")));
    ok(await p.eval(`document.querySelector('.pv-ask-notmeant').offsetHeight > 0 && document.querySelector('.pv-ask-notmeant').getAttribute('aria-expanded') === 'false'`), "Not what I meant is there");
    await p.eval(`document.querySelector('.pv-ask-notmeant').click()`);
    ok(await p.eval(`document.querySelector('.pv-ask-notmeant').getAttribute('aria-expanded') === 'true' && [...document.querySelectorAll('.pv-ask-menu [data-intent]')].map((b) => b.textContent).join() === 'Build instead,Explain instead'`), "its menu offers the other two", await p.eval(`[...document.querySelectorAll('.pv-ask-menu button')].map((b) => b.textContent).join()`));
    await p.press("Escape");
    ok(await p.eval(`document.querySelector('.pv-ask-menu').hidden && document.activeElement === document.querySelector('.pv-ask-notmeant')`), "Escape closes it and gives the focus back");
    await p.eval(`document.querySelector('.pv-ask-notmeant').focus()`);
    await p.press("Enter");
    ok(await p.eval(`!document.querySelector('.pv-ask-menu').hidden && document.activeElement === document.querySelector('.pv-ask-menu [data-intent="build"]')`), "Enter on it opens the menu with the first item focused", await p.eval(`document.activeElement?.outerHTML?.slice(0, 80)`));
    await shot(p, "05-chip-menu-1280");
    await p.press("Tab");
    await p.press("Enter");
    ok(await p.waitFor(`window.__turns.length === 2 && ${text(".pv-ask-chip")} === 'Explaining'`, 20000), "Explain instead sends the message again, forced", await p.eval(`window.__turns.length + ' ' + ${text(".pv-ask-chip")}`));
    ok((await p.eval(`window.__turns[1].mode`)) === "explain", "as explain", await p.eval(`window.__turns[1].mode`));
    ok(await p.eval(`window.__turns[1].messages.length === 1 && window.__turns[1].messages[0].parts[0].text === 'what is S?'`), "the first attempt is out of the conversation");
    ok(await p.eval(`document.querySelectorAll('.pv-chat-user').length === 1 && document.querySelectorAll('.pv-chat-assistant').length === 1 && /that is all S means/.test(document.querySelector('.pv-chat-assistant').textContent)`), "and out of the log: one message, one reply");
    ok(await p.eval(`!/Explain instead/.test(document.querySelector('.pv-ask-menu').textContent) && /Analyse instead/.test(document.querySelector('.pv-ask-menu').textContent)`), "the menu now offers the other two again");
    ok(!(await p.eval(`/Auto|Let it decide/.test(document.querySelector('.pv-chat').textContent)`)), "'Auto' and 'Let it decide' appear nowhere, with the menu open or not");
    await p.close();
  }

  heading("the question the model asks");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, ASK_CARD, say("", [goal("knob", { observable: "recovered" })]), say("The infection rate."));
    await type(p, "which setting should I change to make it better?");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-q')`, 20000), "the model's question is a card", problemsOf(p).join(" | "));
    ok(await p.eval(`/Better in what way\?/.test(${text(".pv-ask-q-text")}) && [...document.querySelectorAll('.pv-ask-q .pv-ask-opts button')].map((b) => b.textContent).join() === 'Fewer in infected,More in recovered,Other…,You decide'`), "with its options, Other… and You decide", await p.eval(`[...document.querySelectorAll('.pv-ask-q .pv-ask-opts button')].map((b) => b.textContent).join()`));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-q:not(.pv-ask-q-done)').length === 1 && document.querySelector('.pv-chat-input').placeholder.startsWith('Or type your own answer') && document.activeElement === document.querySelector('.pv-ask-q [data-q="opt"]')`), "one at a time, the box says it can answer it too, and the first option has the focus");
    await shot(p, "06-ask-card-1280");
    await p.press("Tab"); // the card is keyboard operable: the first option has the focus, Tab moves along, Enter picks
    ok(await p.eval(`document.activeElement === document.querySelectorAll('.pv-ask-q [data-q="opt"]')[1]`), "Tab moves to the next option", await p.eval(`document.activeElement?.outerHTML?.slice(0, 80)`));
    await p.press("Enter");
    ok(await waitCards(p, 1), "Enter on an option answers it, the loop resumes and the goal lands", problemsOf(p).join(" | "));
    const fr = await p.eval(`window.__turns[1].messages.at(-1).parts[0].functionResponse`);
    ok(fr.name === "ask_user" && fr.response.answer === "More in recovered" && !fr.response.other, "the pick goes back as the tool's answer", JSON.stringify(fr));
    ok(await p.eval(`document.querySelector('.pv-ask-q').classList.contains('pv-ask-q-done') && /Answered: More in recovered/.test(document.querySelector('.pv-ask-q').textContent)`), "and the card collapses to it");
    // You decide: the model's pick is a visible assumption, the assistant's
    await script(p, say("", [{ name: "ask_user", args: { question: "Which outcome?", options: ["infected", "recovered"], default_option: "infected" } }]), say("", [goal("knob", { observable: "infected" })]), say("Done."));
    await type(p, "and which knob for the other one?");
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-q:not(.pv-ask-q-done)').length === 1`, 20000), "a second question card");
    await p.eval(`document.querySelector('.pv-ask-q:not(.pv-ask-q-done) [data-q="decide"]').click()`);
    ok(await waitCards(p, 2), "You decide resumes too");
    ok(await p.eval(`(window.__turns.at(-2).messages.at(-1).parts[0].functionResponse.response).decided === 'model'`), "and tells the model it was left to it");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-ask-assumed').textContent.includes('You left “Which outcome?” to me; I took infected.') && !!document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-ask-assumed .pv-prov-ast')`), "the model's pick is on the card as an assumption, labelled assistant", await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-ask-assumed').textContent`));
    // Other…: words
    await script(p, say("", [{ name: "ask_user", args: { question: "Over what time?", options: ["a day", "a month"] } }]), say("A fortnight it is."));
    await type(p, "how long until it settles?");
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-q:not(.pv-ask-q-done)').length === 1`, 20000), "a third question card");
    await p.eval(`document.querySelector('.pv-ask-q:not(.pv-ask-q-done) [data-q="other"]').click()`);
    ok(await p.eval(`!document.querySelector('.pv-ask-q:not(.pv-ask-q-done) .pv-ask-other').hidden`), "Other… opens a box");
    await p.eval(`(() => { const f = document.querySelector('.pv-ask-q:not(.pv-ask-q-done) .pv-ask-other'); f.querySelector('input').value = 'a fortnight'; f.requestSubmit(); })()`);
    ok(await p.waitFor(`/A fortnight it is/.test(document.querySelector('.pv-chat-log').textContent)`, 20000), "the words are the answer");
    ok(await p.eval(`(() => { const r = window.__turns.at(-1).messages.at(-1).parts[0].functionResponse.response; return r.answer === 'a fortnight' && r.other === true; })()`), "sent as the tool's answer, marked as the person's own", await p.eval(`JSON.stringify(window.__turns.at(-1).messages.at(-1).parts[0])`));
    // words typed in the main box while a card is open are its answer
    await script(p, say("", [{ name: "ask_user", args: { question: "Which?", options: ["x", "y"] } }]), say("Taken as typed."));
    await type(p, "a last one");
    await p.waitFor(`document.querySelectorAll('.pv-ask-q:not(.pv-ask-q-done)').length === 1`, 20000);
    await type(p, "neither, the first place");
    ok(await p.waitFor(`/Taken as typed/.test(document.querySelector('.pv-chat-log').textContent)`, 20000), "typing in the box while a question is open answers it");
    ok(await p.eval(`[...document.querySelectorAll('.pv-ask-q-done')].at(-1).textContent.includes('Answered: Other: neither, the first place')`), "and the card says so");
    await p.close();
  }


  heading("pending edits: the problems list in front of Apply");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "build" });
    ok(await p.eval(`${text(".pv-ask-chip")} === 'Building' && document.querySelector('.pv-chat').dataset.intent === 'build'`), "a pane opened as build says Building from the start");
    ok(await p.eval(`getComputedStyle(document.querySelector('.pv-chat-steps')).display === 'flex'`), "and shows the interview steps");
    await script(p, say("", [{ name: "net_add_place", args: { id: "extra", x: 640, y: 300, label: "Extra" } }]), say("Added a place."));
    await type(p, "add a place called extra");
    ok(await p.waitFor(`!document.querySelector('.pv-chat-pending').hidden && document.querySelector('.pv-chat-pending').textContent.includes('+ place extra')`, 30000), "an edit is a pending card with a diff", problemsOf(p).join(" | "));
    ok(await p.eval(`!document.querySelector('petri-view').getModel().places.extra`), "that is not on the net yet");
    ok(await p.eval(`!document.querySelector('.pv-chat-pending .pv-ask-proposal')`), "an edit the model made has no draft notes");
    // the view's own gate (the menu's hook) says the net would have an error: the list is shown first, and the person decides
    await p.eval(`document.querySelector('petri-view')._problemsGate = async (m) => { window.__gated = Object.keys(m.places); return { summary: { level: 'error', count: 1, errors: 1, warnings: 0, repaired: 0, label: '1 problem', items: [{ severity: 'error', where: 'arcs[0]', message: 'points nowhere' }] }, gate: { block: false, warn: true, message: 'This leaves 1 error in the net. Look at the list first; you can still apply.' } }; }`);
    await p.eval(`document.querySelector('.pv-chat-pending [data-act="apply"]').click()`);
    ok(await p.waitFor(`!document.querySelector('.pv-ask-problems').hidden`, 10000), "Apply shows the problems list first");
    ok(await p.eval(`document.querySelector('.pv-ask-problems').textContent.includes('This leaves 1 error') && document.querySelector('.pv-ask-problems').textContent.includes('points nowhere')`), "the gate's words and the list", await p.eval(text(".pv-ask-problems")));
    ok(await p.eval(`window.__gated.includes('extra')`), "the check was of the net as it would be (the sandbox's)");
    ok(await p.eval(`!document.querySelector('petri-view').getModel().places.extra && document.querySelector('.pv-chat-pending [data-act="apply"]').textContent.startsWith('Apply anyway')`), "nothing is applied yet, and the button now says Apply anyway");
    await shot(p, "08-pending-gate-1280");
    await p.eval(`document.querySelector('.pv-chat-pending [data-act="apply"]').click()`);
    ok(await p.waitFor(`!!document.querySelector('petri-view').getModel().places.extra && document.querySelector('.pv-chat-pending').hidden`, 10000), "the person decides: the second click applies");
    ok(await p.eval(`/Applied/.test(${text(".pv-chat-log")})`), "and the log says so");
    // with no hook the check runs on the sandbox (petri-problems.js): a clean edit applies at once
    await p.eval(`delete document.querySelector('petri-view')._problemsGate`);
    await script(p, say("", [{ name: "net_add_place", args: { id: "more", x: 700, y: 300, label: "More" } }]), say("Added another."));
    await type(p, "and one more");
    ok(await p.waitFor(`!document.querySelector('.pv-chat-pending').hidden && document.querySelector('.pv-chat-pending').textContent.includes('+ place more')`, 30000), "a second pending card");
    await p.eval(`document.querySelector('.pv-chat-pending [data-act="apply"]').click()`);
    ok(await p.waitFor(`!!document.querySelector('petri-view').getModel().places.more`, 15000), "with no warning the check lets Apply through at once");
    ok(await p.eval(`document.querySelector('.pv-ask-problems') === null || document.querySelector('.pv-chat-pending').hidden`), "and shows no list");
    ok(problemsOf(p).length === 0, "no console problems", problemsOf(p).join(" | "));
    await p.close();
  }

  heading("Describe, folded into a first build message");
  {
    const p = await open({ status: SIGNED_IN_STATUS }, { net: EMPTY });
    await openPane(p, { mode: "build" });
    ok(await p.waitFor(`${text(".pv-ask-hint")}.includes('The canvas is empty') && document.querySelectorAll('.pv-ask-suggest button').length === 3`, 15000), "an empty canvas offers to describe a process, with the dialog's three examples", await p.eval(text(".pv-ask-empty")));
    await shot(p, "09-describe-empty-1280");
    await p.eval(`window.__draft = { status: 200, body: { draft: ${JSON.stringify(DRAFT)}, remaining_today: 5 } }`);
    await type(p, "A coffee shop with two baristas");
    ok(await p.waitFor(`!document.querySelector('.pv-chat-pending').hidden`, 30000), "the first message becomes a pending net", problemsOf(p).join(" | "));
    ok((await p.eval(`window.__drafts.length`)) === 1 && (await p.eval(`window.__drafts[0].description`)) === "A coffee shop with two baristas", "through /api/llm/draft");
    ok((await p.eval(`window.__turns.length`)) === 0, "with no /api/llm/turn call");
    ok(await p.eval(`!Object.keys(document.querySelector('petri-view').getModel().places).length`), "nothing is on the canvas yet");
    ok(await p.eval(`document.querySelector('.pv-chat-pending').textContent.includes('+ place queue') && document.querySelector('.pv-chat-pending').textContent.includes('+ transition serve')`), "the diff lists the draft's parts");
    ok(await p.eval(`/Gemini's draft notes/.test(${text(".pv-ask-proposal .pv-ask-label")}) && /Assumptions/.test(${text(".pv-ask-proposal .pv-ask-label")}) && document.querySelector('.pv-ask-proposal').textContent.includes('One barista serves one customer at a time.')`), "its notes are labelled Gemini's, with the draft's assumptions");
    ok(await p.eval(`[...document.querySelectorAll('.pv-ask-rate input')].map((i) => i.dataset.rate + '=' + i.value).join() === 'arrive=1.5,serve=2.5'`), "and every rate is a line you can edit in place");
    await shot(p, "10-describe-pending-1280");
    await p.eval(`(() => { const i = document.querySelector('.pv-ask-rate input[data-rate="serve"]'); i.value = '-1'; i.dispatchEvent(new Event('change')); })()`);
    ok(await p.eval(`!document.querySelector('.pv-ask-rate input[data-rate="serve"]').parentElement.nextElementSibling.hidden && document.querySelector('.pv-ask-rate input[data-rate="serve"]').getAttribute('aria-invalid') === 'true'`), "a value that is not a rate is refused where it is typed");
    await p.eval(`(() => { const i = document.querySelector('.pv-ask-rate input[data-rate="serve"]'); i.value = '4'; i.dispatchEvent(new Event('change')); })()`);
    ok(await p.waitFor(`document.querySelector('petri-view')._askPane.chat.model().transitions.serve.rate === 4`, 5000), "a rate edited in place is in the pending net");
    // Regenerate calls the draft again and replaces the pending net
    await p.eval(`window.__draft = { status: 200, body: { draft: ${JSON.stringify({ ...DRAFT, transitions: [DRAFT.transitions[0], { ...DRAFT.transitions[1], rate: 7 }] })}, remaining_today: 4 } }`);
    await p.eval(`document.querySelector('.pv-chat-pending [data-act="regenerate"]').click()`);
    ok(await p.waitFor(`window.__drafts.length === 2 && document.querySelector('.pv-ask-rate input[data-rate="serve"]')?.value === '7'`, 30000), "Regenerate asks again and shows the new draft");
    const hist = await p.eval(`document.querySelector('petri-view')._history.length`);
    await p.eval(`document.querySelector('.pv-chat-pending [data-act="apply"]').click()`);
    ok(await p.waitFor(`Object.keys(document.querySelector('petri-view').getModel().places).join() === 'queue,barista,served'`, 20000), "Apply puts the net on the canvas", problemsOf(p).join(" | "));
    ok(await p.eval(`document.querySelector('petri-view').getModel().transitions.serve.rate === 7 && !!document.querySelector('petri-view')._draftNotes && document.querySelector('petri-view')._draftNotes.description === 'A coffee shop with two baristas'`), "with the rate, and the notes kept for Draft notes");
    ok((await p.eval(`document.querySelector('petri-view')._history.length`)) === hist + 1, "as one undo step (the layout is not another)", `${hist} -> ${await p.eval(`document.querySelector('petri-view')._history.length`)}`);
    await p.eval(`document.querySelector('petri-view').execute('edit.undo')`);
    ok(await p.waitFor(`!Object.keys(document.querySelector('petri-view').getModel().places).length`, 5000), "and Undo takes it all back");
    ok(await p.eval(`${text(".pv-ask-chip")} === 'Building'`), "the chip says Building");
    await p.close();
  }
  {
    // a draft that fails the gate is not loaded; a draft call that fails is the model being down
    const p = await open({ status: SIGNED_IN_STATUS }, { net: EMPTY });
    await openPane(p, { mode: "build" });
    await p.eval(`window.__draft = { status: 200, body: { draft: { name: 'x', summary: 'y', places: [], transitions: [], arcs: [], assumptions: [] } } }`);
    await type(p, "something that is not a net");
    ok(await p.waitFor(`document.querySelector('.pv-ask-checknote')?.textContent.includes('Check: the draft was not loaded')`, 30000), "a draft the gate refuses is not loaded, and says what failed", problemsOf(p).join(" | "));
    ok(await p.eval(`document.querySelector('.pv-chat-pending').hidden && !!document.querySelector('.pv-ask-checknote [data-pane="redraft"]') && !!document.querySelector('.pv-ask-checknote details')`), "no pending net; Try again and the raw reply are there");
    await p.close();
  }
  {
    const p = await open({ status: SIGNED_IN_STATUS }, { net: EMPTY });
    await openPane(p, { mode: "build" });
    await p.eval(`window.__draft = { status: 500, body: { error: 'the model took too long to answer; try again' } }`);
    await type(p, "a bakery with an oven");
    ok(await p.waitFor(`${text(".pv-ask-state")}.includes('Your message is kept')`, 30000), "a draft that fails twice says the message is kept", await p.eval(text(".pv-ask-state")));
    ok((await p.eval(`window.__drafts.length`)) === 2, "after one retry");
    ok((await p.eval(`document.querySelector('.pv-chat-input').value`)) === "a bakery with an oven", "and the words are back in the box");
    await p.close();
  }


  heading("Build instead, on a first message on an empty canvas, is a Describe");
  {
    const p = await open({ status: SIGNED_IN_STATUS }, { net: EMPTY });
    await openPane(p, { mode: "auto" });
    await script(p, say("A Petri net has places and transitions.", [], CHIP_REPLY("explain")));
    await p.eval(`window.__draft = { status: 200, body: { draft: ${JSON.stringify(DRAFT)}, remaining_today: 5 } }`);
    // (it reads as a question, so it goes to the model; a plain description would have been drafted at once)
    await type(p, "Could a coffee shop with two baristas keep up?");
    ok(await p.waitFor(`document.querySelectorAll('.pv-chat-assistant').length === 1 && ${text(".pv-ask-chip")} === 'Explaining'`, 30000), "the server labelled it explain, and answered", problemsOf(p).join(" | "));
    await p.eval(`document.querySelector('.pv-ask-notmeant').click()`);
    await p.eval(`document.querySelector('.pv-ask-menu [data-intent="build"]').click()`);
    ok(await p.waitFor(`!document.querySelector('.pv-chat-pending').hidden`, 30000), "Build instead drafts the net: a pending change", problemsOf(p).join(" | "));
    ok((await p.eval(`window.__drafts.length`)) === 1 && (await p.eval(`window.__turns.length`)) === 1, "through /api/llm/draft, with no second turn call");
    ok(await p.eval(`document.querySelectorAll('.pv-chat-assistant').length === 0 && document.querySelectorAll('.pv-chat-user').length === 1 && document.querySelector('petri-view')._askPane.chat.messages.length === 0`), "and the explanation it replaces is out of the log and the conversation");
    ok(await p.eval(`${text(".pv-ask-chip")} === 'Building'`), "the chip says Building");
    ok(await p.eval(`!document.querySelector('.pv-ask-notmeant').hidden && [...document.querySelectorAll('.pv-ask-menu button')].map((b) => b.dataset.intent).join() === 'analyse,explain'`), "and Not what I meant is still there, offering the other two");
    await p.close();
  }

  heading("Describe in auto mode: the words decide, a message after the draft refines it, Not what I meant corrects");
  {
    const p = await open({ status: SIGNED_IN_STATUS }, { net: EMPTY });
    await openPane(p, { mode: "auto" });
    await p.eval(`window.__draft = { status: 200, body: { draft: ${JSON.stringify(DRAFT)}, remaining_today: 5 } }`);
    await type(p, "A coffee shop with two baristas");
    ok(await p.waitFor(`!document.querySelector('.pv-chat-pending').hidden`, 30000), "on an empty canvas a description is drafted without being stated as a build", problemsOf(p).join(" | "));
    ok((await p.eval(`window.__drafts.length`)) === 1 && (await p.eval(`window.__turns.length`)) === 0, "one draft call, no turn");
    ok(await p.eval(`${text(".pv-ask-chip")} === 'Building' && !document.querySelector('.pv-ask-notmeant').hidden && [...document.querySelectorAll('.pv-ask-menu button')].map((b) => b.dataset.intent).join() === 'analyse,explain'`), "the chip says Building and offers Analyse / Explain instead");
    // the refinement: the pending net is the assistant's to edit; it is not drafted again
    await script(p, say("", [{ name: "net_add_place", args: { id: "extra", x: 640, y: 300, label: "Extra" } }]), say("Added a place."));
    await type(p, "make it three baristas");
    ok(await p.waitFor(`document.querySelector('.pv-chat-pending').textContent.includes('+ place extra')`, 30000), "a message after the draft is a turn that edits the pending net", problemsOf(p).join(" | "));
    ok((await p.eval(`window.__drafts.length`)) === 1 && (await p.eval(`window.__turns.length`)) === 2, "no second draft call (so no second draft spent); the assistant was asked", `${await p.eval(`window.__drafts.length`)} drafts, ${await p.eval(`window.__turns.length`)} turns`);
    ok(await p.eval(`['+ place queue', '+ transition serve', '+ place extra'].every((x) => document.querySelector('.pv-chat-pending').textContent.includes(x)) && !!document.querySelector('.pv-chat-pending [data-act="regenerate"]')`), "the draft is still the pending change, with the edit on it, and Regenerate is how to draft again");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-rate input').length === 2`), "and its rates are still lines to edit");
    await p.eval(`document.querySelector('.pv-chat-pending [data-act="apply"]').click()`);
    ok(await p.waitFor(`Object.keys(document.querySelector('petri-view').getModel().places).join() === 'queue,barista,served,extra'`, 20000), "Apply puts the draft and the edit on the canvas", problemsOf(p).join(" | "));
    await p.close();
  }
  {
    // "Not what I meant" on a described message: the draft is withdrawn and the same words go to the model as Explain
    const p = await open({ status: SIGNED_IN_STATUS }, { net: EMPTY });
    await openPane(p, { mode: "auto" });
    await p.eval(`window.__draft = { status: 200, body: { draft: ${JSON.stringify(DRAFT)}, remaining_today: 5 } }`);
    await type(p, "A coffee shop with two baristas");
    ok(await p.waitFor(`!document.querySelector('.pv-chat-pending').hidden`, 30000), "a described net is pending");
    await script(p, say("A coffee shop is a queue with servers.", [], CHIP_REPLY("explain")));
    await p.eval(`document.querySelector('.pv-ask-notmeant').click()`);
    await p.eval(`document.querySelector('.pv-ask-menu [data-intent="explain"]').click()`);
    ok(await p.waitFor(`window.__turns.length === 1 && document.querySelectorAll('.pv-chat-assistant').length === 1`, 30000), "Explain instead sends the words to the model", problemsOf(p).join(" | "));
    ok((await p.eval(`window.__turns[0].mode`)) === "explain" && (await p.eval(`window.__turns[0].messages[0].parts[0].text`)) === "A coffee shop with two baristas", "as Explain, the same words");
    ok(await p.eval(`document.querySelector('.pv-chat-pending').hidden && !document.querySelector('petri-view')._askPane.draft && document.querySelectorAll('.pv-chat-user').length === 1`), "the draft is withdrawn and the log has the message once");
    ok(await p.eval(`${text(".pv-ask-chip")} === 'Explaining'`), "and the chip says Explaining", await p.eval(text(".pv-ask-chip")));
    await p.close();
  }
  {
    // a question on an empty canvas goes to the model (nothing to draft from it)
    const p = await open({ status: SIGNED_IN_STATUS }, { net: EMPTY });
    await openPane(p, { mode: "auto" });
    await script(p, say("A Petri net models how things move between places.", [], CHIP_REPLY("explain")));
    await type(p, "How does a Petri net work?");
    ok(await p.waitFor(`window.__turns.length === 1 && document.querySelectorAll('.pv-chat-assistant').length === 1`, 30000), "a question on an empty canvas is answered by the model", problemsOf(p).join(" | "));
    ok((await p.eval(`window.__drafts.length`)) === 0 && await p.eval(`document.querySelector('.pv-chat-pending').hidden`), "and no draft is spent on it");
    await p.close();
  }

  heading("opening the pane with a message: the empty state does not turn up under it");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await script(p, say("", [goal("risk")], CHIP_REPLY("analyse")), say("It can swing."));
    await openPane(p, { mode: "auto", message: "How bad can it get?" });
    ok(await waitCards(p, 1), "the message opened with the pane gets its answer", problemsOf(p).join(" | "));
    await sleep(1500); // (the suggestions for the net take a moment to come back: that is when the box used to be added)
    const kinds = () => p.eval(`[...document.querySelector('.pv-chat-log').children].map((c) => c.className.split(' ')[0]).join()`);
    ok(await p.eval(`document.querySelectorAll('.pv-ask-empty').length === 0`), "no suggested questions or goal grid in the log", await kinds());
    ok(await p.eval(`document.querySelector('.pv-chat-log').children[0].className.includes('pv-ask-turn') && document.querySelector('.pv-chat-log').children[1].className.includes('pv-chat-user')`), "the log begins with the person's message", await kinds());
    await p.close();
  }
  {
    const p = await open({ status: SIGNED_OUT_STATUS, signedIn: false });
    await openPane(p, { mode: "auto", message: "which knob matters for recovered people?" });
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard[data-goal="knob"]')`, 20000), "signed out, the words opened with the pane go to the router", problemsOf(p).join(" | "));
    await sleep(1500);
    ok(await p.eval(`document.querySelectorAll('.pv-ask-empty').length === 0 && document.querySelectorAll('.pv-ask-goalcard').length === 0`), "and the router's cards are not followed by the goal grid");
    await p.close();
  }

  heading("New waits for the answer, and a run still going does not land in the new conversation");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, say("", [goal("risk")], { ...CHIP_REPLY("analyse"), delay: 2500 }), say("It can swing."));
    await type(p, "How bad can it get?");
    await sleep(800);
    ok(await p.eval(`document.querySelector('[data-act="new"]').disabled`), "New is not available while the answer is coming");
    await p.eval(`document.querySelector('[data-act="new"]').click()`);
    ok(await waitCards(p, 1), "the answer lands in the conversation it was asked in", problemsOf(p).join(" | "));
    ok(await p.waitFor(`!document.querySelector('[data-act="new"]').disabled`, 10000), "and New is back once it has");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-empty').length === 0 && document.querySelectorAll('.pv-chat-user').length === 1`), "with no empty state above the card and the message still there");
    // a card's own run that is still going when New is pressed (it is not the pane's turn, so New is allowed)
    await p.eval(`document.querySelector('petri-view').execute('sim.set_rate', { id: 'infect', rate: 0.05 })`);
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-card[data-stale="true"]').length === 1`, 5000), "an edit makes the card stale");
    await p.eval(`(() => { const a = document.querySelector('petri-view')._askPane, orig = a.chat.rerunResult.bind(a.chat); a.chat.rerunResult = async (...x) => { await new Promise((r) => setTimeout(r, 1500)); return orig(...x); }; })()`);
    await p.eval(`document.querySelector('.pv-ask-card .pv-ask-stale [data-ask="rerun"]').click()`);
    await p.eval(`document.querySelector('[data-act="new"]').click()`);
    await sleep(3000);
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card').length === 0 && document.querySelectorAll('.pv-ask-empty').length === 1`), "a Rerun still going when New is pressed adds no card to the new conversation", await p.eval(`document.querySelectorAll('.pv-ask-card').length + ' cards'`));
    await p.close();
  }

  heading("moving a node does not make a result stale");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, say("", [goal("risk")], CHIP_REPLY("analyse")), say("It can swing."));
    await type(p, "How bad can it get?");
    ok(await waitCards(p, 1), "a result", problemsOf(p).join(" | "));
    await p.eval(`(() => { const v = document.querySelector('petri-view'); v.execute('net.move', { id: 'susceptible', x: 150, y: 260 }); v.execute('net.move', { id: 'infect', x: 230, y: 40 }); })()`);
    await sleep(900); // (the pane looks again 250 ms after a change)
    ok((await p.eval(notStale)) === "false", "dragging places and transitions leaves it current", await p.eval(notStale));
    await p.eval(`document.querySelector('.pv-ask-card .pv-prov-acts [data-act="rerun"]').click()`);
    ok(await p.waitFor(`/^Reproduced/.test(${text(".pv-ask-card .pv-ask-note")})`, 30000), "so Rerun can still say it reproduced the result", await p.eval(text(".pv-ask-card .pv-ask-note")));
    ok((await cards(p)) === 1, "and adds no card");
    await p.eval(`document.querySelector('petri-view').execute('sim.set_rate', { id: 'infect', rate: 0.05 })`);
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-card[data-stale="true"]').length === 1`, 5000), "a rate is still a change");
    await p.close();
  }

  heading("a run that fails leaves its error, not 'Running…'; the blank option is not a run");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, say("", [goal("knob", {})], CHIP_REPLY("analyse")), say("The infection rate matters most."));
    await type(p, "which knob matters?");
    ok(await waitCards(p, 1), "a goal whose outcome the words did not name", problemsOf(p).join(" | "));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card [data-ask="change"]').length >= 1`), "has an assumption to change", await p.eval(text(".pv-ask-card .pv-ask-assumed")));
    await p.eval(`document.querySelector('.pv-ask-card [data-ask="change"]').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-changer select')`, 3000), "Change opens a select");
    ok(await p.eval(`document.querySelector('.pv-ask-changer select').value === ''`), "with the blank option (what ran) selected");
    await p.eval(`document.querySelector('.pv-ask-changer [data-do="go"]').click()`);
    ok(await p.eval(`!document.querySelector('.pv-ask-changer .pv-form-err').hidden && /That is what ran/.test(document.querySelector('.pv-ask-changer .pv-form-err').textContent)`), "Run with the blank option says that is what ran", await p.eval(text(".pv-ask-changer .pv-form-err")));
    ok((await cards(p)) === 1 && await p.eval(`document.querySelector('.pv-ask-card .pv-ask-note').hidden`), "and runs nothing: no card, no note");
    // a run that fails: the error is where the person typed, and the card does not stay 'Running with your value…'
    await p.eval(`(() => { const a = document.querySelector('petri-view')._askPane; a.chat.rerunResult = async () => { throw new Error('boom: the engine refused'); }; })()`);
    await p.eval(`(() => { const s = document.querySelector('.pv-ask-changer select'); s.value = 'infected'; s.closest('li').querySelector('[data-do="go"]').click(); })()`);
    ok(await p.waitFor(`/boom: the engine refused/.test(${text(".pv-ask-changer .pv-form-err")})`, 10000), "a failed Change shows the failure", await p.eval(text(".pv-ask-changer .pv-form-err")));
    ok(await p.eval(`document.querySelector('.pv-ask-card .pv-ask-note').hidden && !/Running/.test(${text(".pv-ask-card .pv-ask-note")})`), "and the card's note is not stuck at Running with your value", await p.eval(text(".pv-ask-card .pv-ask-note")));
    ok(await p.eval(`document.querySelector('.pv-ask-card').getAttribute('aria-busy') === 'false'`), "the card is not busy any more");
    // Edit settings that fails after it validated
    await p.eval(`document.querySelector('.pv-ask-card .pv-prov-acts [data-act="edit"]:not([data-field])').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-edit [data-field="runs"]')`, 5000), "Edit settings opens");
    await p.eval(`(() => { document.querySelector('.pv-ask-edit [data-field="runs"]').value = '31'; document.querySelector('.pv-ask-editform').requestSubmit(); })()`);
    ok(await p.waitFor(`/The run failed: boom/.test(${text(".pv-ask-edit .pv-form-summary")})`, 10000), "a failed Edit settings run shows the failure", await p.eval(text(".pv-ask-edit .pv-form-summary")));
    ok(await p.eval(`document.querySelector('.pv-ask-card .pv-ask-note').hidden`), "and the note is not stuck at Running with your settings", await p.eval(text(".pv-ask-card .pv-ask-note")));
    await p.close();
  }

  heading("signed out: the router, one quiet line, the words kept");
  {
    const p = await open({ status: SIGNED_OUT_STATUS, signedIn: false });
    await openPane(p, { mode: "auto" });
    ok(await p.eval(`${text(".pv-ask-state")}.includes('Sign in to ask in your own words') && document.querySelectorAll('.pv-ask-state [data-ask="signin"]').length === 1`), "the pane says, once and quietly, that signing in lets you ask in your own words", await p.eval(text(".pv-ask-state")));
    ok(await p.eval(`document.querySelector('.pv-chat-input').placeholder.startsWith('Say what you want to know') && document.querySelector('.pv-chat-form button').textContent === 'Find questions'`), "the box says what it does without the model");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-goalcard').length >= 8`), "the goal cards are there");
    await shot(p, "11-signed-out-1280");
    await type(p, "which knob matters for recovered people?");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard[data-goal="knob"]')`, 20000), "words go to the router: the closest goals are cards");
    ok((await p.eval(`window.__turns.length`)) === 0, "with no call to the model");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-route .pv-ask-rcard').length >= 1 && document.querySelectorAll('.pv-ask-route .pv-ask-rcard').length <= 3`), "up to three of them");
    ok(await p.eval(`document.querySelector('.pv-ask-rcard[data-goal="knob"]').textContent.includes('the outcome to watch = recovered (taken from your words)') && document.querySelector('.pv-ask-rcard[data-goal="knob"] select[data-field="observable"]').value === 'recovered'`), "a place the words named is a visible assumption, with a select to change it", await p.eval(`document.querySelector('.pv-ask-rcard[data-goal="knob"]').textContent`));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-state [data-ask="signin"]').length === 1`), "and the sign-in line is still the one line");
    await shot(p, "12-signed-out-router-1280");
    await p.eval(`document.querySelector('.pv-ask-rcard[data-goal="knob"] button[type="submit"]').click()`);
    ok(await waitCards(p, 1), "Run lands a result card with no model", problemsOf(p).join(" | "));
    ok(await p.eval(`!/I answered/.test(${text(".pv-ask-card .pv-ask-title")}) && !document.querySelector('.pv-ask-card .pv-ask-answer .pv-prov-ast') && !document.querySelector('.pv-ask-card [data-ask="notthat"]')`), "it is the person's own run: no 'I answered', no assistant text, no Not that", await p.eval(text(".pv-ask-card .pv-ask-title")));
    ok(await p.eval(`!!document.querySelector('.pv-ask-card .pv-ask-evidence .pv-ask-eng') && document.querySelectorAll('.pv-ask-card .pv-prov-acts [data-act]').length === 5`), "with the evidence and the same five actions");
    await p.eval(`document.querySelector('.pv-ask-card .pv-prov-acts [data-act="rerun"]').click()`);
    ok(await p.waitFor(`/^Reproduced/.test(${text(".pv-ask-card .pv-ask-note")})`, 30000), "Rerun works with no model");
    // an input the goal still needs is a small form
    await type(p, "what if I had one more person");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard[data-goal="one_more"] select[data-field="place"]')`, 20000), "a goal that needs a place shows a select of the net's places");
    await p.eval(`document.querySelector('.pv-ask-rcard[data-goal="one_more"] button[type="submit"]').click()`);
    ok(await p.eval(`!document.querySelector('.pv-ask-rcard[data-goal="one_more"] .pv-form-summary').hidden && /required/.test(document.querySelector('.pv-ask-rcard[data-goal="one_more"] .pv-form-summary').textContent)`), "left blank it says what is needed");
    await p.eval(`(() => { const f = document.querySelector('.pv-ask-rcard[data-goal="one_more"]'); f.querySelector('select').value = 'infected'; f.querySelector('button[type="submit"]').click(); })()`);
    ok(await waitCards(p, 2), "filled in, it runs", problemsOf(p).join(" | "));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card')[1].querySelector('.pv-prov-calls').textContent.includes('"place":"infected"')`), "on the place chosen");
    // the words survive the GitHub round trip
    await p.eval(`document.querySelector('.pv-chat-input').value = 'how bad can it get?'`);
    await p.eval(`document.querySelector('.pv-ask-state [data-ask="signin"]').click()`);
    ok(await p.waitFor(`window.__logins === 1`, 3000), "the sign-in starts");
    ok((await p.eval(`sessionStorage.getItem('pflow_landing_pending')`)) === JSON.stringify({ route: "auto", message: "how bad can it get?" }), "and the words wait in the tab, as the landing page keeps them");
    ok(problemsOf(p).length === 0, "no console problems", problemsOf(p).join(" | "));
    await p.close();
  }
  {
    // the words kept before the sign-in open the pane and are asked when it is back
    const p = await open({ status: SIGNED_IN_STATUS });
    await p.eval(`(() => { sessionStorage.setItem('pflow_landing_pending', JSON.stringify({ route: 'auto', message: 'where does it jam?' })); })()`);
    await script(p, say("It jams at S."));
    await p.eval(`(async () => { const L = await import('/petri-landing.js'); const pending = L.takePending(sessionStorage); await document.querySelector('petri-view')._openChat({ mode: pending ? 'auto' : 'x', message: pending?.message }); })()`);
    ok(await p.waitFor(`document.querySelector('.pv-chat-user')?.textContent === 'where does it jam?' && /It jams at S/.test(document.querySelector('.pv-chat-log').textContent)`, 30000), "back from the sign-in, the kept words are asked");
    await p.close();
  }

  heading("signed in but not on the list: the same pane, no sign-in nag");
  {
    const p = await open({ status: NOT_ALLOWED_STATUS });
    await openPane(p, { mode: "auto" });
    ok(await p.eval(`${text(".pv-ask-state")}.includes('not open to this account') && !document.querySelector('.pv-ask-state [data-ask="signin"]') && !/sign in/i.test(${text(".pv-ask-state")})`), "it says so and does not ask to sign in", await p.eval(text(".pv-ask-state")));
    await type(p, "can it get stuck?");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard[data-goal="stuck"]')`, 20000), "the router and the cards work");
    ok((await p.eval(`window.__turns.length`)) === 0, "with no call to the model");
    await p.eval(`document.querySelector('.pv-ask-rcard[data-goal="stuck"] button[type="submit"]').click()`);
    ok(await waitCards(p, 1), "and run", problemsOf(p).join(" | "));
    await p.close();
  }

  heading("the quota used up");
  {
    const p = await open({ status: QUOTA_STATUS });
    await openPane(p, { mode: "auto" });
    ok(await p.eval(`${text(".pv-ask-state")} === 'Model calls are used up for today (resets 00:00 UTC) '`.replace("(resets 00:00 UTC) '", "(resets 00:00 UTC)'")) || await p.eval(`${text(".pv-ask-state")}.trim() === 'Model calls are used up for today (resets 00:00 UTC)'`), "the line says when it resets", await p.eval(text(".pv-ask-state")));
    ok(await p.eval(`!document.querySelector('.pv-ask-state [data-ask="signin"]')`), "and does not ask to sign in");
    await shot(p, "13-quota-1280");
    // a suggested question is still there to run, and its result can be rerun, edited and changed with no model
    await p.eval(`document.querySelector('.pv-ask-suggest button').click()`);
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard')`, 20000), "a suggested question becomes its card");
    await p.eval(`document.querySelector('.pv-ask-rcard button[type="submit"]').click()`);
    ok(await waitCards(p, 1), "which runs", problemsOf(p).join(" | "));
    await p.eval(`document.querySelector('.pv-ask-card .pv-prov-acts [data-act="rerun"]').click()`);
    ok(await p.waitFor(`/^Reproduced/.test(${text(".pv-ask-card .pv-ask-note")})`, 30000), "and Rerun still works");
    ok((await p.eval(`window.__turns.length`)) === 0, "with the model never asked");
    await p.close();
  }
  {
    // the daily limit arrives as the model's answer to a message: the pane gives up the model, keeps the words, says when it lifts
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, { status: 429, body: { error: "daily limit reached", retry_after_s: 7200, reset: "2026-11-03T06:30:00Z" } });
    await type(p, "how bad can it get?");
    ok(await p.waitFor(`${text(".pv-ask-state")}.includes('resets 06:30 UTC')`, 20000), "a daily limit says when it lifts (the server's own time)", await p.eval(text(".pv-ask-state")));
    ok((await p.eval(`document.querySelector('.pv-chat-input').value`)) === "how bad can it get?", "and the words are back in the box");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard')`, 10000), "with the closest questions below");
    ok((await p.eval(`window.__turns.length`)) === 1, "after one call, not retried");
    await p.close();
  }

  heading("the model down: one retry, then the router, with the message kept");
  {
    const p = await open({ status: SIGNED_IN_STATUS });
    await openPane(p, { mode: "auto" });
    await script(p, { status: 500, body: { error: "the model took too long to answer; try again" } }, { status: 500, body: { error: "the model took too long to answer; try again" } });
    await type(p, "how bad can it get?");
    ok(await p.waitFor(`${text(".pv-ask-state")}.includes('Your message is kept')`, 30000), "it says the message is kept", await p.eval(text(".pv-ask-state")));
    ok((await p.eval(`window.__turns.length`)) === 2, "after one retry (two calls)", String(await p.eval(`window.__turns.length`)));
    ok((await p.eval(`document.querySelector('.pv-chat-input').value`)) === "how bad can it get?" && await p.eval(`document.querySelectorAll('.pv-chat-user').length === 0`), "the failed message is in the box, not in the log");
    ok(await p.eval(`document.querySelector('petri-view')._askPane.chat.messages.length === 0`), "and not in the conversation either, so sending it again is not a duplicate");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard')`, 10000), "the router offers the closest questions meanwhile");
    ok(await p.eval(`!!document.querySelector('.pv-ask-state [data-ask="retry"]')`), "and Try again");
    await shot(p, "14-upstream-1280");
    await script(p, say("It can swing a lot."));
    await p.eval(`document.querySelector('.pv-ask-state [data-ask="retry"]').click()`);
    ok(await p.waitFor(`/It can swing a lot/.test(document.querySelector('.pv-chat-log').textContent) && document.querySelector('.pv-ask-state').hidden`, 30000), "Try again asks the model once more, and the state line goes", await p.eval(text(".pv-ask-state")));
    ok(await p.eval(`document.querySelectorAll('.pv-chat-user').length === 1`), "the message is in the log once");
    await p.close();
  }

  heading("a server with no assistant");
  {
    const p = await open({ status: OFF_STATUS });
    await openPane(p, { mode: "auto" });
    ok(await p.eval(`${text(".pv-ask-state")}.includes('not available here') && !document.querySelector('.pv-ask-state [data-ask="signin"]')`), "it says so, with no sign-in offered", await p.eval(text(".pv-ask-state")));
    await type(p, "is anything conserved?");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard[data-goal="conserved"]')`, 20000), "the router and the cards still work");
    await p.close();
  }

  heading("a result from the Tools palette lands in the same list");
  {
    const p = await open({ status: SIGNED_OUT_STATUS, signedIn: false });
    await p.eval(`(async () => {
      const v = document.querySelector('petri-view'); const reg = await v.commands();
      const before = new Set(reg.artifacts().map((a) => a.id));
      await reg.execute('sim.ode', { t_end: 5 });
      const arts = reg.artifacts().filter((a) => !before.has(a.id));
      const P = await import('/petri-provenance.js');
      window.__shown = await v._showResult({ title: 'Run ODE', source: 'palette', goal: null, record: P.recordFromCall({ command: 'sim.ode', args: { t_end: 5 } }, { engine: { name: 'ODE', reason: '' } }), artifacts: arts, registry: reg, answer: null, warnings: [], stale: false });
    })()`);
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-card').length === 1`, 30000), "showResult adds a card, opening the pane", problemsOf(p).join(" | "));
    ok(await p.eval(`document.querySelector('.pv-ask-card .pv-ask-title').textContent === 'Run ODE' && !!document.querySelector('.pv-ask-card .pv-ask-art svg') && document.querySelector('.pv-ask-card').dataset.source === 'palette'`), "titled by what was run, with the evidence");
    ok(await p.eval(`document.querySelectorAll('.pv-ask-card .pv-prov-acts [data-act]').length === 5 && document.querySelector('.pv-ask-card [data-stale="true"]') === null`), "with the footer's five actions, and not stale on sight");
    await p.eval(`document.querySelector('.pv-ask-card .pv-prov-acts [data-act="rerun"]').click()`);
    ok(await p.waitFor(`/^Reproduced|Differs|Reran/.test(${text(".pv-ask-card .pv-ask-note")})`, 30000), "Rerun runs the recorded call");
    ok(await p.eval(`!!window.__shown.element && typeof window.__shown.close === 'function'`), "showResult still resolves to {close, element}");
    await p.close();
  }

  heading("the phone");
  {
    const p = await open({ status: SIGNED_IN_STATUS }, { width: 390, height: 844, phone: true });
    await openPane(p, { mode: "auto" });
    ok(await p.waitFor(`document.querySelectorAll('.pv-ask-suggest button').length >= 3`, 15000), "the empty state opens");
    for (const sel of [".pv-chat-input", ".pv-chat-form button", '.pv-chat [data-act="close"]']) {
      const got = await p.eval(REACHABLE(sel));
      ok(got === "ok", `empty: ${sel} is reachable`, got);
    }
    await shot(p, "15-phone-empty-390");
    await script(p, say("", [goal("risk")], CHIP_REPLY("analyse")), say("Twenty runs give a spread."));
    await type(p, "How bad can it get?");
    ok(await waitCards(p, 1), "a result lands", problemsOf(p).join(" | "));
    await sleep(300);
    ok(await p.eval(`document.documentElement.scrollWidth <= innerWidth`), "no horizontal page scroll", String(await p.eval(`document.documentElement.scrollWidth`)));
    ok(await p.eval(`(() => { const c = document.querySelector('.pv-ask-card'); return c.scrollWidth <= c.clientWidth + 1; })()`), "the card does not overflow sideways", await p.eval(`document.querySelector('.pv-ask-card').scrollWidth + ' of ' + document.querySelector('.pv-ask-card').clientWidth`));
    ok(await p.eval(`(() => { const l = document.querySelector('.pv-chat-log'); return l.scrollWidth <= l.clientWidth + 1; })()`), "nor does the list");
    for (const sel of [".pv-chat-input", ".pv-chat-form button", '.pv-chat [data-act="close"]']) {
      const got = await p.eval(REACHABLE(sel));
      ok(got === "ok", `with a result: ${sel} is reachable above the run bar`, got);
    }
    ok(await p.eval(`(() => { const b = document.querySelector('.pv-run-bar').getBoundingClientRect(), c = document.querySelector('.pv-chat').getBoundingClientRect(); return !b.height || c.bottom <= b.top; })()`), "the pane stops above the run bar");
    ok(await p.eval(`(() => { const c = document.querySelector('.pv-chat').getBoundingClientRect(); return [...document.querySelectorAll('.pv-chat-head button, .pv-ask-chip')].filter((b) => b.getBoundingClientRect().width > 0).every((b) => { const r = b.getBoundingClientRect(); return r.left >= c.left && r.right <= c.right; }); })()`), "the head, with the chip and Not what I meant, is inside the pane");
    ok(await p.eval(`document.querySelector('.pv-ask-notmeant').offsetHeight > 0 && ${text(".pv-ask-chip")} === 'Analysing'`), "and shows them");
    const inputAt = await p.eval(`document.querySelector('.pv-chat-input').getBoundingClientRect().top`);
    await p.eval(`document.querySelector('.pv-chat-log').scrollTop = 0`);
    ok((await p.eval(`document.querySelector('.pv-chat-input').getBoundingClientRect().top`)) === inputAt, "scrolling the list leaves the input where it is");
    await shot(p, "16-phone-result-390");
    await p.eval(`document.querySelector('.pv-ask-card .pv-prov-acts [data-act="edit"]:not([data-field])').click()`);
    await sleep(200);
    ok(await p.eval(`(() => { const c = document.querySelector('.pv-ask-card'); return c.scrollWidth <= c.clientWidth + 1; })()`), "the Edit settings form does not overflow either");
    await shot(p, "17-phone-edit-390");
    await p.eval(`document.querySelector('.pv-ask-card [data-ask="cancel-edit"]').click()`);
    ok((await p.eval(`document.querySelector('.pv-chat-input').getBoundingClientRect().top`)) === inputAt, "and the input has not moved");
    // the pending card and the question card fit too
    await script(p, ASK_CARD);
    await type(p, "which one should I change?");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-q:not(.pv-ask-q-done)')`, 20000), "a question card on a phone");
    ok(await p.eval(`(() => { const q = document.querySelector('.pv-ask-q'); return q.scrollWidth <= q.clientWidth + 1; })()`), "does not overflow");
    const got = await p.eval(REACHABLE(".pv-ask-q [data-q=\"decide\"]"));
    ok(got === "ok", "its buttons are reachable", got);
    await shot(p, "18-phone-question-390");
    ok(problemsOf(p).length === 0, "no console problems", problemsOf(p).join(" | "));
    await p.close();
  }
  {
    const p = await open({ status: SIGNED_OUT_STATUS, signedIn: false }, { width: 390, height: 844, phone: true });
    await openPane(p, { mode: "auto" });
    await type(p, "which knob matters for recovered people?");
    ok(await p.waitFor(`!!document.querySelector('.pv-ask-rcard')`, 20000), "signed out on a phone: the router's cards");
    ok(await p.eval(`document.documentElement.scrollWidth <= innerWidth && (() => { const l = document.querySelector('.pv-chat-log'); return l.scrollWidth <= l.clientWidth + 1; })()`), "do not overflow");
    for (const sel of [".pv-chat-input", ".pv-chat-form button", ".pv-ask-state [data-ask=\"signin\"]"]) {
      const got = await p.eval(REACHABLE(sel));
      ok(got === "ok", `signed out: ${sel} is reachable`, got);
    }
    await shot(p, "19-phone-signed-out-390");
    await p.close();
  }
  {
    const p = await open({ status: SIGNED_IN_STATUS }, { width: 390, height: 844, phone: true, net: EMPTY });
    await openPane(p, { mode: "build" });
    await p.eval(`window.__draft = { status: 200, body: { draft: ${JSON.stringify(DRAFT)}, remaining_today: 5 } }`);
    await type(p, "A coffee shop with two baristas");
    ok(await p.waitFor(`!document.querySelector('.pv-chat-pending').hidden`, 30000), "a described net on a phone is a pending card");
    for (const sel of [".pv-chat-pending [data-act=\"apply\"]", ".pv-chat-input", ".pv-chat-form button"]) {
      const got = await p.eval(REACHABLE(sel));
      ok(got === "ok", `pending: ${sel} is reachable`, got);
    }
    ok(await p.eval(`(() => { const e = document.querySelector('.pv-chat-pending'); return e.scrollWidth <= e.clientWidth + 1 && document.documentElement.scrollWidth <= innerWidth; })()`), "and does not overflow");
    await shot(p, "20-phone-describe-390");
    await p.close();
  }

} finally {
  await stop();
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
Deno.exit(failures ? 1 : 0);
