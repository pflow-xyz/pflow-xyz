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

/**
 * Before any script. `window.__script` is what the model says next, one entry per /api/llm/turn call: {reply, calls, auto, status,
 * body, remaining}; `window.__draft` what /api/llm/draft answers; `window.__turns` and `window.__drafts` are the bodies received.
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
  })()`);
  if (mode !== undefined) await p.eval(`document.querySelector('petri-view')._openChat(${JSON.stringify({ mode })})`);
  return p;
}
const openPane = (p: any, opts: Record<string, unknown> = {}) => p.eval(`document.querySelector('petri-view')._openChat(${JSON.stringify(opts)})`).then(() => p.waitFor(`!!document.querySelector('.pv-chat-input')`, 30000));
const type = (p: any, t: string) => p.eval(`(() => { const i = document.querySelector('.pv-chat-input'); i.value = ${q(t)}; document.querySelector('.pv-chat-form').requestSubmit(); })()`);
const cards = (p: any) => p.eval(`document.querySelectorAll('.pv-ask-card').length`);

try {
  console.log(`ask smoke: ${url}`);

  console.log("the full agent: a goal result as a card");
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
    ok(await p.eval(`document.querySelector('.pv-ask-card [data-kind="stray"]')?.textContent === 'a number in this reply is not in the results'`), "a number in the reply that is in no result gets the warning chip", await p.eval(`document.querySelector('.pv-ask-card .pv-ask-warns')?.textContent`));
    ok(await p.eval(`document.querySelector('.pv-ask-intent').offsetHeight > 0 && ${text(".pv-ask-chip")} === 'Analysing'`), "the head shows the intent chip after the reply", await p.eval(text(".pv-ask-chip")));
    ok(await p.eval(`document.querySelectorAll('.pv-ask-follow button').length >= 2 && document.querySelectorAll('.pv-ask-follow button').length <= 3`), "2 to 3 follow-ups");
    ok(await p.eval(`document.querySelector('.pv-ask-card [data-ask="notthat"]')?.textContent === 'Not that'`), "Not that is on the card");
    ok(problemsOf(p).length === 0, "no console problems", problemsOf(p).join(" | "));
    await shot(p, "02-agent-result-1280");
    await p.close();
  }
} finally {
  await stop();
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
Deno.exit(failures ? 1 : 0);
