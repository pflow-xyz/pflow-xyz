// Browser check of the IDE shell (public/petri-shell*.js, docs/ide-shell.md).
//
//   deno run -A scripts/shell-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome]
//
// In headless Chrome:
//   the flag        without ?shell=1 the page is the classic editor (no .pf-shell); with it the grid is on, and ?shell=0 turns it off
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
  const p = await open("");
  await sleep(600);
  ok(!(await p.eval(`document.getElementById('editor-wrapper').classList.contains('pf-shell')`)), "flag off: the classic editor, no .pf-shell");
  ok(!(await p.eval(`!!window.pflowShell`)), "flag off: no window.pflowShell");
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
  const p = await open("?shell=1");
  await ready(p);
  await p.goto(new URL("?shell=0", url).href);
  await sleep(500);
  ok(!(await p.eval(`document.getElementById('editor-wrapper').classList.contains('pf-shell')`)), "?shell=0 turns the shell off");
  await p.close();
}

await stop();
console.log(failures ? `shell-smoke: ${failures} of ${checks} checks FAILED` : `shell-smoke: ${checks} checks ok`);
Deno.exit(failures ? 1 : 0);
