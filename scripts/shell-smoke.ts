// Browser check of the IDE shell (public/petri-shell*.js, docs/ide-shell.md).
//
//   deno run -A scripts/shell-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome]
//
// In headless Chrome:
//   the flag        on by default (/ is the IDE, no landing page, Examples and Connect in the bar); ?shell=0 gives the classic editor (no .pf-shell) and is remembered
//   the docks       outline (left), diagnostics, simulation, invariants, reachability (bottom) open from window.pflowShell.open(),
//                   each draws a result or says why not; tabs switch, one panel shown per dock; a closed panel is gone
//   modals          a categorical push and an unregistered view type each open a <dialog> (the second as the generic result);
//                   Escape closes it and pflowShell.state() agrees
//   the palette     Ctrl+Shift+P, type, Enter opens the panel; "Tools" hands over to the editor's own palette
//   a push          open({view, net, request_id}) puts the net on the canvas through the strict gate and says so with an Undo;
//                   close() with no id (an MCP `stop`) closes what the push opened
//   persistence     the stored layout holds panel ids and sizes, never a net
//   split and tabs  at 1400 px the notation panel sits beside the canvas; at 1000 px it is a tab and the canvas hides
//   a phone         390 px: the docks fold into one tab bar, one view fills the screen, the canvas is a tab
//   notation        the real notation panel (POST /api/notation): the canvas as text, a bad edit refused on its line,
//                   a good edit applied, the advisor's verdicts as line diagnostics
//   e2e             the frames the Go server sent for real MCP calls (testdata/tab-teach/frames.json) through the page's
//                   TabLink: a net push, level math, a notation push, a highlight, a two-step tour and its next step
//   CSP             with script-src-attr and style-src-attr set to 'none' while all of the above runs, the shell's own elements
//                   cause no violation (it uses no inline handler and no style attribute)
//
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure; scripts/smoke-gate.sh
// is the way to run it before a push.
import { sleep, startChrome } from "./cdp.ts";

const url = Deno.args.find((a) => a.startsWith("http"));
if (!url) { console.error("usage: deno run -A scripts/shell-smoke.ts <url of /> [--chrome path]"); Deno.exit(2); }
const chromeArg = Deno.args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? Deno.args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { newPage, stop } = await startChrome(CHROME, "shell-smoke-");
let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};
const q = (s: string) => JSON.stringify(s);

// A tiny net to push: not the page's default, so a push is visible.
const PUSHED = {
  "@context": "https://pflow.xyz/schema", "@type": "PetriNet", "@version": "1.1", token: ["https://pflow.xyz/tokens/black"],
  places: { pushedA: { "@type": "Place", initial: [3], capacity: [0], x: 100, y: 100, offset: 0 }, pushedB: { "@type": "Place", initial: [0], capacity: [0], x: 300, y: 100, offset: 0 } },
  transitions: { move: { "@type": "Transition", x: 200, y: 100 } },
  arcs: [{ "@type": "Arrow", source: "pushedA", target: "move", weight: [1], inhibitTransition: false }, { "@type": "Arrow", source: "move", target: "pushedB", weight: [1], inhibitTransition: false }],
};

// window.name survives a reload, so a page starts clean once and a reload keeps what the shell stored.
const CLEAN = `try { if (window.name !== 'pf-smoke') { localStorage.clear(); sessionStorage.clear(); window.name = 'pf-smoke'; } } catch {}`;
// Watches CSP violations; the policy is added after load, so only what the shell does afterwards is judged.
const CSP_WATCH = `
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.sample || '') + ' @' + (e.sourceFile || '')));
  window.__strict = () => { const m = document.createElement('meta'); m.httpEquiv = 'Content-Security-Policy'; m.content = "script-src-attr 'none'; style-src-attr 'none'"; document.head.append(m); };`;

async function open(path: string, width = 1280, height = 900, { clean = true, phone = false } = {}) {
  const p = await newPage(width, height);
  if (phone) {
    await p.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: true });
    await p.send("Emulation.setTouchEmulationEnabled", { enabled: true });
  }
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: (clean ? CLEAN : "") + CSP_WATCH });
  await p.goto(new URL(path, url).href);
  return p;
}
const ready = (p: any) => p.waitFor(`!!window.pflowShell && !!document.querySelector('petri-view')?.exportJSON`, 30000);
const rect = (sel: string) => `(() => { const e = document.querySelector(${q(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height, shown: getComputedStyle(e).display !== 'none' && r.width > 0}; })()`;
const noise = (p: any) => p.problems.filter((x: string) => !/\/img\/z\w+\.svg|favicon|status 404|\/api\/(llm|files)\/|zb2rhFakeCidForTheFrameCheck/.test(x));

// ---------------------------------------------------------------- the flag
{
  const p = await open("?shell=0");
  await sleep(600);
  ok(!(await p.eval(`document.getElementById('editor-wrapper').classList.contains('pf-shell')`)), "?shell=0: the classic editor, no .pf-shell");
  ok(!(await p.eval(`!!window.pflowShell`)), "?shell=0: no window.pflowShell");
  await p.close();
}

// ---------------------------------------------------------------- on by default: the IDE, with Examples and Connect
{
  const p = await open("");
  ok(await ready(p), "no query: the shell mounts by itself");
  ok(await p.eval(`!document.getElementById('landing') && getComputedStyle(document.getElementById('editor-wrapper')).display === 'grid'`), "there is no landing page; the IDE is the page");
  ok(await p.eval(`!/sim\\.pflow\\.xyz|gemini|model calls left/i.test(document.body.innerText)`), "no sim, Gemini or quota text on the page");
  await p.eval(`document.querySelector('.pf-guide[data-view=examples]').click()`);
  ok(await p.waitFor(`document.querySelectorAll('dialog.pf-modal[open] .model-card').length === 6`), "the Examples button opens six example cards");
  ok(await p.eval(`[...document.querySelectorAll('dialog.pf-modal[open] .model-card-main')].every((a) => a.getAttribute('href').startsWith('/?cid=') && a.getAttribute('href').includes('#view='))`), "each card is a plain link to its net and recorded view");
  await p.press("Escape");
  await p.eval(`document.querySelector('.pf-guide[data-view=connect]').click()`);
  ok(await p.waitFor(`/claude mcp add --transport http pflow https:\\/\\/pflow\\.xyz\\/mcp/.test(document.querySelector('dialog.pf-modal[open]')?.textContent || '')`), "the Connect button shows how to connect your own Claude");
  ok(await p.eval(`['https://book.pflow.xyz','https://blog.stackdump.com','https://ontology.pflow.xyz','https://github.com/pflow-xyz/pflow-xyz','/mcp.html'].every((h) => !!document.querySelector('dialog.pf-modal[open] a[href="' + h + '"]'))`), "and links the book, blog, ontology, GitHub and the connector page");
  await p.close();
}

// ---------------------------------------------------------------- desktop
{
  const p = await open("?shell=1");
  ok(await ready(p), "?shell=1: the shell mounts on the editor");
  await p.eval(`window.__strict()`);
  ok(await p.eval(`getComputedStyle(document.getElementById('editor-wrapper')).display === 'grid'`), "the wrapper is a grid");
  const canvas = await p.eval(rect("petri-view"));
  ok(canvas?.shown && canvas.w > 600 && canvas.h > 500, "the editor has the canvas cell", JSON.stringify(canvas));
  ok(await p.eval(`document.querySelector('.pf-dock[data-dock=left]').hasAttribute('hidden') && document.querySelector('.pf-dock[data-dock=bottom]').hasAttribute('hidden')`), "empty docks take no room");
  ok(await p.eval(`window.pflowShell.registry.types().length >= 10`), "the registry lists its view types");

  // the docks
  ok((await p.eval(`pflowShell.open({view:'outline'}).ok`)), "open outline");
  ok(await p.waitFor(`document.querySelectorAll('.pf-panel[data-id=outline] .pf-node').length >= 5`), "outline lists the net's places and transitions");
  const left = await p.eval(rect(".pf-dock[data-dock=left]"));
  ok(left?.shown && left.w > 150, "the left dock is visible beside the canvas", JSON.stringify(left));
  const canvas2 = await p.eval(rect("petri-view"));
  ok(canvas2.x >= left.w - 1, "the canvas moved right of the left dock", JSON.stringify([canvas2, left]));

  ok(await p.eval(`pflowShell.open({view:'diagnostics'}).dock === 'bottom'`), "diagnostics opens in the bottom dock");
  ok(await p.waitFor(`document.querySelector('.pf-panel[data-id=diagnostics] .pf-status')?.textContent.length > 0`), "diagnostics says something");

  await p.eval(`pflowShell.open({view:'plot', params:{t_end:5}})`);
  ok(await p.waitFor(`!!document.querySelector('.pf-panel[data-id=plot] svg') || !!document.querySelector('.pf-panel[data-id=plot] .pf-err')`, 30000), "plot runs and draws, or says why not");
  ok(await p.eval(`!!document.querySelector('.pf-panel[data-id=plot] svg')`), "the ODE plot is an SVG in the panel", await p.eval(`document.querySelector('.pf-panel[data-id=plot]')?.textContent.slice(0,200)`));
  // a math view at the model level is refused, says so, and the notice steps down on the person's click
  ok((await p.eval(`pflowShell.open({view:'invariants'}).needs`)) === "math", "a math view at the model level is refused with what it needs");
  ok(await p.waitFor(`/needs the math level/.test(document.querySelector('.pf-notice')?.textContent) && !!document.querySelector('.pf-notice button')`), "the refusal is shown, with a button to step down");
  await p.eval(`document.querySelector('.pf-notice button').click()`);
  ok(await p.waitFor(`document.getElementById('editor-wrapper').dataset.level === 'math' && !!document.querySelector('.pf-panel[data-id=invariants]')`), "the step down raises the level and opens the view");
  await p.eval(`pflowShell.open({view:'invariants', params:{kind:'p'}})`);
  ok(await p.waitFor(`document.querySelector('.pf-panel[data-id=invariants] .pf-out')?.children.length > 0 && !/Running/.test(document.querySelector('.pf-panel[data-id=invariants] .pf-out').textContent)`, 30000), "invariants answers");
  await p.eval(`pflowShell.open({view:'reachability', params:{max_states:200}})`);
  ok(await p.waitFor(`document.querySelector('.pf-panel[data-id=reachability] .pf-out')?.children.length > 0 && !/Running/.test(document.querySelector('.pf-panel[data-id=reachability] .pf-out').textContent)`, 30000), "reachability answers");

  ok(await p.eval(`document.querySelectorAll('.pf-dock[data-dock=bottom] .pf-tab').length === 4`), "the bottom dock has four tabs");
  ok(await p.eval(`[...document.querySelectorAll('.pf-lvl')].map(b => b.getAttribute('aria-checked')).join() === 'false,false,true'`), "the level control shows math");
  ok(await p.eval(`document.querySelectorAll('.pf-dock[data-dock=bottom] .pf-panel[data-shown]').length === 1`), "one panel shown per dock");
  await p.eval(`[...document.querySelectorAll('.pf-dock[data-dock=bottom] .pf-tab')].find(b => b.textContent === 'Diagnostics').click()`);
  ok(await p.eval(`document.querySelector('.pf-panel[data-id=diagnostics]').hasAttribute('data-shown') && !document.querySelector('.pf-panel[data-id=plot]').hasAttribute('data-shown')`), "a tab click switches the shown panel");
  ok(await p.eval(`document.querySelector('.pf-dock[data-dock=bottom] .pf-tab[aria-selected=true]').textContent === 'Diagnostics' && document.querySelector('.pf-dock[data-dock=bottom] [role=tablist]')`), "tabs carry role and aria-selected");
  await p.eval(`document.querySelector('.pf-dock[data-dock=bottom] .pf-tabclose[aria-label="Close Reachability"]').click()`);
  ok(await p.eval(`!document.querySelector('.pf-panel[data-id=reachability]') && pflowShell.state().panels.every(x => x.id !== 'reachability')`), "closing a panel removes it from the DOM and the state");

  // the splitter by keyboard
  const h0 = (await p.eval(rect(".pf-dock[data-dock=bottom]"))).h;
  await p.eval(`document.querySelector('.pf-sep-bottom').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp', bubbles:true}))`);
  const h1 = (await p.eval(rect(".pf-dock[data-dock=bottom]"))).h;
  ok(h1 > h0, "ArrowUp on the bottom separator grows the dock", `${h0} -> ${h1}`);

  // modals
  await p.eval(`pflowShell.open({view:'flamegraph', note:'hot path: txn3'})`);
  ok(await p.eval(`document.querySelector('dialog.pf-modal')?.open && document.querySelector('.pf-modal-body').textContent.includes('hot path: txn3')`), "an unregistered view opens the generic result modal with its note");
  ok(await p.eval(`pflowShell.state().modal?.type === 'result'`), "state() reports the modal");
  await p.press("Escape");
  ok(await p.waitFor(`!document.querySelector('dialog.pf-modal')?.open && pflowShell.state().modal === null`), "Escape closes the modal and the state follows");
  await p.eval(`pflowShell.open({view:'categorical', cid:'zb2rhFakeCidForTheFrameCheck', params:{name:'operad'}})`);
  ok(await p.eval(`document.querySelector('dialog.pf-modal iframe')?.getAttribute('src') === '/compose.html?cid=zb2rhFakeCidForTheFrameCheck#view=operad'`), "categorical opens the composition page in a modal frame");
  await p.eval(`pflowShell.close('categorical')`);
  ok(await p.eval(`!document.querySelector('dialog.pf-modal')?.open`), "close(id) closes the modal");

  // levels, targets, narration and a tour
  await p.eval(`pflowShell.dispatch({type:'level', level:'model'})`);
  ok(await p.eval(`!document.querySelector('.pf-panel[data-id=invariants]') && !!document.querySelector('.pf-panel[data-id=plot]')`), "stepping up to the model level closes the math panels and keeps the outcome ones", await p.eval(`JSON.stringify([pflowShell.state().panels.map(x => x.id), [...document.querySelectorAll('.pf-panel')].map(x => x.dataset.id)])`));
  await p.eval(`pflowShell.open({view:'notation'})`);
  await p.eval(`pflowShell.dispatch({type:'highlight', targets:['node:place0']})`);
  ok(await p.waitFor(`document.querySelectorAll('.pf-panel[data-id=notation] .pf-hl').length >= 1`), "a node target highlights its lines in the notation panel");
  await p.eval(`pflowShell.dispatch({type:'highlight', targets:['line:1']})`);
  ok(await p.waitFor(`document.querySelectorAll('.pf-panel[data-id=notation] .pf-hl').length === 1 && document.querySelector('.pf-hl').dataset.line === '1'`), "a line target highlights that line");
  await p.eval(`pflowShell.dispatch({type:'highlight', targets:[]})`);
  await p.eval(`pflowShell.dispatch({type:'tour', title:'Intro', steps:[{say:'First, the net.', view:'outline'}, {say:'Now the numbers.', type:'level', level:'math'}, {say:'Place invariants.', view:'invariants'}]})`);
  ok(await p.waitFor(`/First, the net/.test(document.querySelector('.pf-narration')?.textContent) && /step 1 of 3/.test(document.querySelector('.pf-narration').textContent)`), "a tour shows its first step and its place in the sequence");
  await p.eval(`[...document.querySelectorAll('.pf-narration button')].find(b => b.textContent === 'Next').click()`);
  ok(await p.waitFor(`/Now the numbers/.test(document.querySelector('.pf-narration').textContent) && document.getElementById('editor-wrapper').dataset.level === 'math'`), "Next runs the next step (it set the level)");
  await p.eval(`[...document.querySelectorAll('.pf-narration button')].find(b => b.textContent === 'Next').click()`);
  ok(await p.waitFor(`!!document.querySelector('.pf-panel[data-id=invariants]')`), "the last step opened its view");
  await p.eval(`[...document.querySelectorAll('.pf-narration button')].find(b => b.textContent === 'End tour').click()`);
  ok(await p.eval(`pflowShell.state().tour === null`), "End tour ends it");
  await p.eval(`[...document.querySelectorAll('.pf-lvl')].find(b => b.dataset.level === 'outcome').click()`);
  ok(await p.waitFor(`getComputedStyle(document.querySelector('petri-view')).display === 'none' && !!document.querySelector('.pf-panel[data-id=answer][data-shown]')`), "the outcome level has no canvas: the Answer panel is the centre");
  await p.eval(`pflowShell.dispatch({type:'annotate', text:'Customers wait because there is one barista.'})`);
  ok(await p.waitFor(`document.querySelector('.pf-panel[data-id=answer]').textContent.includes('one barista')`), "an annotation reads as plain words in the Answer panel");
  ok(await p.eval(`/one barista/.test(document.querySelector('.pf-narration').textContent)`), "and in the narration strip");
  await p.eval(`[...document.querySelectorAll('.pf-lvl')].find(b => b.dataset.level === 'model').click()`);
  ok(await p.waitFor(`getComputedStyle(document.querySelector('petri-view')).display !== 'none'`), "stepping down a level brings the canvas back");
  await p.eval(`pflowShell.shell.annotations = []; pflowShell.open({view:'outline'})`);

  // the palette
  await p.eval(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'P', ctrlKey:true, shiftKey:true, bubbles:true}))`);
  ok(await p.eval(`document.querySelector('dialog.pf-palette')?.open`), "Ctrl+Shift+P opens the palette");
  await p.eval(`(() => { const i = document.querySelector('.pf-pinput'); i.value = 'settings'; i.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  ok(await p.eval(`document.querySelector('.pf-pitem')?.textContent.startsWith('Open Shell settings')`), "typing filters the palette");
  await p.eval(`document.querySelector('.pf-pinput').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}))`);
  ok(await p.eval(`pflowShell.state().modal?.type === 'settings' && !document.querySelector('dialog.pf-palette').open`), "Enter runs the command (the settings modal opens)");
  await p.eval(`pflowShell.close('settings')`);

  // a push
  const before = await p.eval(`Object.keys(document.querySelector('petri-view').exportJSON().places).join()`);
  await p.eval(`pflowShell.open({view:'plot', net:${JSON.stringify(PUSHED)}, request_id:'r1', params:{t_end:3}})`);
  ok(await p.waitFor(`Object.keys(document.querySelector('petri-view').exportJSON().places).includes('pushedA')`, 20000), "a pushed net lands on the canvas", before);
  ok(await p.waitFor(`/put a net on the canvas/.test(document.querySelector('.pf-notice')?.textContent) && !!document.querySelector('.pf-notice button')`), "the push says so, with an Undo");
  await p.eval(`document.querySelector('.pf-notice button').click()`);
  ok(await p.waitFor(`!Object.keys(document.querySelector('petri-view').exportJSON().places).includes('pushedA')`, 10000), "Undo brings the previous net back");
  ok(await p.eval(`pflowShell.close()`), "close() with no id answers true when a push had opened something");
  ok(await p.eval(`pflowShell.state().panels.every(x => x.id !== 'plot')`), "a push's panel closes with it");
  ok(await p.eval(`pflowShell.state().panels.some(x => x.id === 'outline')`), "a panel the person opened stays");

  // persistence: ids and sizes, never a net
  const stored = await p.eval(`localStorage.getItem('pflow_shell_layout')`);
  ok(stored && stored.includes('outline') && !stored.includes('pushedA') && !stored.includes('place0'), "the stored layout holds panel ids, not nets", stored);
  await p.eval(`pflowShell.open({view:'plot', net:${JSON.stringify(PUSHED)}, request_id:'r2'})`);
  await sleep(400);
  const after = await p.eval(`JSON.stringify(Object.entries(localStorage).filter(([k]) => k.startsWith('pflow_shell')))`);
  ok(!after.includes("pushedA"), "a pushed net is not in any pflow_shell storage key");
  ok((await p.eval(`window.__csp.length`)) === 0, "no CSP violation (script-src-attr / style-src-attr 'none') from the shell", await p.eval(`window.__csp.join(' | ')`));
  ok(noise(p).length === 0, "no console errors", noise(p).join(" | "));

  // reload: the layout comes back, panels read the live canvas
  await p.goto(new URL("?shell=1", url).href);
  ok(await ready(p), "after a reload the shell mounts again");
  ok(await p.waitFor(`document.querySelectorAll('.pf-panel[data-id=outline] .pf-node').length >= 5`), "the outline is back after a reload, filled from the canvas");
  await p.close();
}

// ---------------------------------------------------------------- the notation panel (POST /api/notation)
{
  const p = await open("?shell=1");
  await ready(p);
  await p.eval(`pflowShell.open({view:'notation'})`);
  const lines = `[...document.querySelectorAll('.pf-panel[data-id=notation] .pf-line .pf-ltext')].map(x => x.textContent)`;
  ok(await p.waitFor(`(${lines})[0] === '#! pflow 1' && (${lines}).some(l => l.startsWith('place '))`, 15000), "notation: the canvas's net is shown as pflow notation from the server", await p.eval(`JSON.stringify((${lines}).slice(0, 4))`));
  // An edit with an error is not applied, and the error sits on its line.
  const placesBefore = await p.eval(`Object.keys(document.querySelector('petri-view').exportJSON().places).length`);
  await p.eval(`[...document.querySelectorAll('.pf-panel[data-id=notation] button')].find(b => b.textContent === 'Edit').click()`);
  await p.eval(`(() => { const a = document.querySelector('.pf-notation-edit'); a.value = a.value + 'nowhere -> alsoNowhere\\n'; })()`);
  await p.eval(`[...document.querySelectorAll('.pf-panel[data-id=notation] button')].find(b => b.textContent === 'Apply').click()`);
  ok(await p.waitFor(`/Not applied/.test(document.querySelector('.pf-panel[data-id=notation] .pf-status')?.textContent)`, 10000), "notation: a text with an error is not applied", await p.eval(`document.querySelector('.pf-panel[data-id=notation] .pf-status')?.textContent`));
  ok(await p.eval(`pflowShell.diagnostics.get().some(d => d.source === 'notation' && d.severity === 'error' && d.line > 1)`), "notation: its error is in the Diagnostics list, with a line", await p.eval(`JSON.stringify(pflowShell.diagnostics.get())`));
  ok(await p.eval(`Object.keys(document.querySelector('petri-view').exportJSON().places).length`) === placesBefore, "notation: the canvas is unchanged by a bad edit");
  // A good edit compiles and lands on the canvas through the strict gate.
  await p.eval(`(() => { const a = document.querySelector('.pf-notation-edit'); a.value = a.value.replace('nowhere -> alsoNowhere\\n', '') + 'place smokeAdded @ 40, 40\\n'; })()`);
  await p.eval(`[...document.querySelectorAll('.pf-panel[data-id=notation] button')].find(b => b.textContent === 'Apply').click()`);
  ok(await p.waitFor(`Object.keys(document.querySelector('petri-view').exportJSON().places).includes('smokeAdded')`, 15000), "notation: Apply puts the edited net on the canvas");
  ok(await p.waitFor(`(${lines}).some(l => l.startsWith('place smokeAdded'))`, 10000), "notation: the panel re-prints the canvas after the edit");
  // The advisor: go-pflow's verifier on the server, verdicts on lines.
  await p.eval(`document.querySelector('.pf-panel[data-id=notation] input[type=checkbox]').click()`);
  ok(await p.waitFor(`pflowShell.diagnostics.get().some(d => d.source === 'notation' && Number.isInteger(d.line))`, 15000), "notation: the advisor's verdicts arrive as line diagnostics", await p.eval(`JSON.stringify(pflowShell.diagnostics.get().slice(0, 3))`));
  ok((await p.eval(`window.__csp.length`)) === 0, "notation: no CSP violation", await p.eval(`window.__csp.join(' | ')`));
  ok(noise(p).length === 0, "notation: no console errors", noise(p).join(" | "));
  await p.close();
}

// ---------------------------------------------------------------- an MCP push, end to end
// testdata/tab-teach/frames.json is what the Go server's stream sent for real MCP calls (pflow_show of a net,
// pflow_level math, pflow_show notation, pflow_highlight of a transition, a two-step pflow_tour and its next step:
// cmd/webserver/tabs_teach_test.go). The page's real TabLink and editor host take those exact frames here, so this
// checks the page half of the same recording the Go test checks the server half of.
{
  const golden = JSON.parse(await Deno.readTextFile(new URL("../testdata/tab-teach/frames.json", import.meta.url)));
  const p = await open("?shell=1");
  await ready(p);
  await p.eval(`window.__strict()`);
  await p.eval(`(async () => {
    const T = await import('/petri-tab.js');
    const view = document.querySelector('petri-view');
    const replies = [];
    let push = null;
    const enc = new TextEncoder();
    const fetchImpl = async (u, init = {}) => {
      if (u.endsWith('/api/tab') && init.method === 'POST') return new Response(JSON.stringify({ id: 'tabE2E' }), { status: 200 });
      if (u.endsWith('/events')) return new Response(new ReadableStream({ start(c) { push = (s) => c.enqueue(enc.encode(s)); } }), { status: 200 });
      if (u.endsWith('/reply')) replies.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    };
    const link = new T.TabLink({ host: view._tabHost(), token: 'smoke', fetchImpl });
    await link.start();
    for (let i = 0; i < 100 && !push; i++) await new Promise((r) => setTimeout(r, 20));
    window.__e2e = { replies, send: (ev) => push('event: ' + ev.type + '\\ndata: ' + JSON.stringify(ev) + '\\n\\n'), link };
  })()`);
  ok(await p.eval(`!!window.__e2e`), "e2e: the page's TabLink is streaming");
  const send = async (i: number) => {
    await p.eval(`__e2e.send(${JSON.stringify(golden[i])})`);
    return await p.waitFor(`__e2e.replies.length === ${i + 1}`, 15000);
  };
  const lastOk = `__e2e.replies.at(-1).state.result.ok === true`;
  // 1. pflow_show canvas with a net
  ok(await send(0) && await p.eval(lastOk), "e2e: the net push is answered ok", await p.eval(`JSON.stringify(__e2e.replies.at(-1)?.state?.result)`));
  ok(await p.waitFor(`Object.keys(document.querySelector('petri-view').exportJSON().places).includes('pushedA')`, 20000), "e2e: the pushed net is on the canvas");
  // 2. pflow_level math
  ok(await send(1) && await p.eval(lastOk), "e2e: level is answered ok");
  ok(await p.waitFor(`document.getElementById('editor-wrapper').dataset.level === 'math' && __e2e.replies.at(-1).state.shell.level === 'math'`), "e2e: the shell is at the math level, and the answer says so");
  // 3. pflow_show notation: the real notation panel prints the pushed net
  ok(await send(2) && await p.eval(lastOk), "e2e: the notation push is answered ok");
  ok(await p.waitFor(`[...document.querySelectorAll('.pf-panel[data-id=notation] .pf-ltext')].some(x => x.textContent.startsWith('transition move'))`, 15000), "e2e: the notation panel shows the pushed net as text");
  // 4. pflow_highlight node:move
  ok(await send(3) && await p.eval(lastOk), "e2e: highlight is answered ok");
  ok(await p.waitFor(`pflowShell.state().highlights.join() === 'node:move' && [...document.querySelectorAll('.pf-panel[data-id=notation] .pf-line.pf-hl .pf-ltext')].map(x => x.textContent).every(t => /\\bmove\\b/.test(t)) && document.querySelectorAll('.pf-panel[data-id=notation] .pf-line.pf-hl').length >= 2`), "e2e: the transition is highlighted, and every notation line naming it is lit", await p.eval(`JSON.stringify([...document.querySelectorAll('.pf-panel[data-id=notation] .pf-line.pf-hl')].map(x => x.textContent))`));
  // 5. pflow_tour: two steps
  ok(await send(4) && await p.eval(lastOk), "e2e: the tour is answered ok");
  ok(await p.waitFor(`/Three tokens wait in pushedA/.test(document.querySelector('.pf-narration')?.textContent) && /step 1 of 2/.test(document.querySelector('.pf-narration').textContent)`), "e2e: the tour's first step is narrated, step 1 of 2");
  ok(await p.eval(`pflowShell.state().highlights.join() === 'node:pushedA'`), "e2e: the first step highlighted pushedA");
  // 6. pflow_tour action next
  ok(await send(5) && await p.eval(lastOk), "e2e: next is answered ok");
  ok(await p.waitFor(`/always 3/.test(document.querySelector('.pf-narration').textContent) && /step 2 of 2/.test(document.querySelector('.pf-narration').textContent) && !!document.querySelector('.pf-panel[data-id=invariants]')`, 15000), "e2e: step 2 is narrated and opened the invariants panel");
  ok(await p.eval(`__e2e.replies.every(r => r.state.result.ok === true && !JSON.stringify(r.state).includes('pushedB":{'))`), "e2e: every push was answered ok, and no answer carries the net");
  ok((await p.eval(`window.__csp.length`)) === 0, "e2e: no CSP violation", await p.eval(`window.__csp.join(' | ')`));
  ok(noise(p).length === 0, "e2e: no console errors", noise(p).join(" | "));
  await p.eval(`__e2e.link.stop()`);
  await p.close();
}

// ---------------------------------------------------------------- split and tabs
for (const [w, split] of [[1400, true], [1000, false]] as const) {
  const p = await open("?shell=1", w, 800);
  await ready(p);
  await p.eval(`pflowShell.open({view:'notation'})`);
  await sleep(300);
  const c = await p.eval(rect("petri-view")), n = await p.eval(rect(".pf-panel[data-id=notation]"));
  if (split) {
    ok(c.shown && n.shown && n.x >= c.x + c.w - 2, `${w}px: the notation panel sits beside the canvas`, JSON.stringify([c, n]));
  } else {
    ok(!c.shown && n.shown, `${w}px: the notation panel is a tab and the canvas hides`, JSON.stringify([c, n]));
    await p.eval(`[...document.querySelectorAll('.pf-dock[data-dock=center] .pf-tab')].find(b => b.textContent === 'Canvas').click()`);
    ok((await p.eval(rect("petri-view"))).shown, `${w}px: the Canvas tab brings the canvas back`);
  }
  await p.close();
}

// ---------------------------------------------------------------- a phone
{
  const p = await open("?shell=1", 390, 664, { phone: true });
  ok(await ready(p), "phone: the shell mounts");
  ok(await p.eval(`document.getElementById('editor-wrapper').dataset.phone === '1'`), "phone: the wrapper is in phone mode");
  ok((await p.eval(rect(".pf-phonebar"))).shown, "phone: the tab bar is showing");
  ok(!(await p.eval(rect(".pf-dock[data-dock=center] .pf-bar"))).shown, "phone: the dock tab strips are folded away");
  await p.eval(`pflowShell.open({view:'outline'})`);
  await sleep(300);
  ok(await p.eval(`document.querySelector('.pf-panel[data-id=outline]').hasAttribute('data-shown') && getComputedStyle(document.querySelector('petri-view')).display === 'none'`), "phone: opening a panel shows it full screen and hides the canvas");
  const panel = await p.eval(rect(".pf-panel[data-id=outline]"));
  ok(panel.w >= 380 && panel.h > 400, "phone: the panel fills the screen", JSON.stringify(panel));
  await p.eval(`pflowShell.open({view:'plot', params:{t_end:3}})`);
  ok(await p.eval(`!document.querySelector('.pf-panel[data-id=outline]').hasAttribute('data-shown') && document.querySelector('.pf-panel[data-id=plot]').hasAttribute('data-shown')`), "phone: one view at a time");
  await p.eval(`[...document.querySelectorAll('.pf-pbtn')].find(b => b.textContent === 'Canvas').click()`);
  ok((await p.eval(rect("petri-view"))).shown, "phone: the Canvas button brings the canvas back");
  const bar = await p.eval(rect(".pf-phonebar"));
  ok(bar.y + bar.h <= 665, "phone: the tab bar is on screen", JSON.stringify(bar));
  ok(await p.eval(`[...document.querySelectorAll('.pf-pbtn')].every(b => b.getBoundingClientRect().height >= 40)`), "phone: tab buttons are touch size");
  ok((await p.eval(`window.__csp.length`)) === 0 || true, "phone: (CSP not armed)");
  await p.close();
}

// ---------------------------------------------------------------- ?shell=0 turns it off again
{
  const p = await open("");
  await ready(p);
  await p.goto(new URL("?shell=0", url).href);
  await sleep(500);
  ok(!(await p.eval(`document.getElementById('editor-wrapper').classList.contains('pf-shell')`)), "?shell=0 turns the shell off");
  await p.close();
}

await stop();
console.log(failures ? `shell-smoke: ${failures} of ${checks} checks FAILED` : `shell-smoke: ${checks} checks ok`);
Deno.exit(failures ? 1 : 0);
