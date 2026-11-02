// Browser check of the command palette (public/petri-palette-ui.js, docs/design/agent-first-analysis.md section 8).
//
//   deno run -A scripts/palette-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome]
//
// In headless Chrome, on a net it sets itself: Ctrl-K opens the dialog and closes it again; Escape closes it; the
// Tools button opens it; the search ranks a word, a typo and nonsense; Up and Down move the selection; Enter opens the
// form of a command (sim.ssa) whose bad entries are reported beside their fields and whose good ones run through the
// registry; a goal's place input is a select of the net's places with the one the search names preselected; Tab stays
// inside the dialog; onResult gets the outcome and the palette closes; a classic tool opens its own dialog; Ctrl-K in
// a plain text field is left alone. No model, no sign-in: nothing here calls /api/llm.
//
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure; scripts/smoke-gate.sh
// is the way to run it before a push.
import { type Page, sleep, startChrome } from "./cdp.ts";

const url = Deno.args.find((a) => a.startsWith("http"));
if (!url) { console.error("usage: deno run -A scripts/palette-smoke.ts <url of /> [--chrome path]"); Deno.exit(2); }
const chromeArg = Deno.args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? Deno.args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { newPage, stop } = await startChrome(CHROME, "palette-smoke-");
let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};

const SIR = {
  places: { S: { initial: [45], capacity: [0], x: 100, y: 100 }, I: { initial: [5], capacity: [0], x: 300, y: 100 }, R: { initial: [0], capacity: [0], x: 500, y: 100 } },
  transitions: { infect: { x: 200, y: 100, rate: 0.01 }, recover: { x: 400, y: 100, rate: 0.1 } },
  arcs: [
    { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
    { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
    { source: "recover", target: "R", weight: [1] },
  ],
};

async function key(page: Page, k: string, code: string, vk: number, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(60);
}
const typeText = async (page: Page, t: string) => { await page.send("Input.insertText", { text: t }); await sleep(120); };

try {
  const page = await newPage(1280, 900);
  await page.goto(url);
  await page.waitFor("!!customElements.get('petri-view') && !!document.querySelector('petri-view')");
  await page.eval(`(async () => {
    const el = document.querySelector('petri-view');
    el.setModel(${JSON.stringify(SIR)});
    window.__ui = await import('/petri-palette-ui.js');
    window.__unbind = window.__ui.bindPaletteKey(el);
    window.__btn = window.__ui.toolsButton(el);
    window.__btn.id = 'toolsbtn';
    document.body.appendChild(window.__btn);
    window.__results = [];
  })()`);

  console.log("opening");
  await key(page, "k", "KeyK", 75, 2); // Ctrl-K
  ok(await page.waitFor("!!document.querySelector('.pv-palette')"), "Ctrl-K opens the palette");
  const dlg = await page.eval(`(() => { const d = document.querySelector('.pv-palette'); return {role: d.getAttribute('role'), label: d.getAttribute('aria-label'), modal: d.getAttribute('aria-modal'), focused: document.activeElement.className, combo: document.activeElement.getAttribute('role'), rows: d.querySelectorAll('[role=option]').length, groups: d.querySelectorAll('[role=group]').length, heads: [...d.querySelectorAll('.pv-palette-head')].map(h => h.textContent)}; })()`);
  ok(dlg.role === "dialog" && dlg.label === "Tools" && dlg.modal === "true", "role=dialog, aria-label Tools, aria-modal");
  ok(dlg.combo === "combobox", "the search box has focus and is a combobox", dlg.focused);
  ok(dlg.rows >= 150, "all entries listed", String(dlg.rows));
  ok(dlg.heads[0] === "Questions" && dlg.heads.includes("All commands · Simulate") && dlg.heads[dlg.heads.length - 1] === "Classic tools", "groups: Questions, All commands by prefix, Classic tools", dlg.heads.join(" | "));
  ok(await page.eval(`document.activeElement.getAttribute('aria-activedescendant') === document.querySelector('[role=option][aria-selected=true]').id`), "aria-activedescendant names the selected row");

  console.log("Ctrl-K toggles, Escape closes, focus returns");
  await key(page, "k", "KeyK", 75, 2);
  ok(await page.eval(`!document.querySelector('.pv-palette')`), "Ctrl-K again closes it");
  await key(page, "k", "KeyK", 75, 2);
  await page.waitFor("!!document.querySelector('.pv-palette')");
  await key(page, "Escape", "Escape", 27);
  ok(await page.eval(`!document.querySelector('.pv-palette')`), "Escape closes it");
  ok(await page.eval(`document.querySelector('.pv-palette-overlay') === null`), "overlay removed");

  console.log("Tools button");
  ok(await page.eval(`window.__btn.textContent.includes('Tools') && ['Control+K', 'Meta+K'].includes(window.__btn.getAttribute('aria-keyshortcuts'))`), "Tools button with the shortcut hint", await page.eval(`window.__btn.textContent + ' ' + window.__btn.getAttribute('aria-keyshortcuts')`));
  await page.eval(`window.__btn.click()`);
  ok(await page.waitFor("!!document.querySelector('.pv-palette')"), "the button opens it");

  console.log("search");
  await typeText(page, "stoch");
  const s1 = await page.eval(`[...document.querySelectorAll('.pv-palette [role=option]')].slice(0, 6).map(r => r.querySelector('.pv-palette-title').textContent)`);
  ok(s1.some((t: string) => t.startsWith("How bad can it get")) && s1.includes("Run SSA"), "'stoch' lists the risk question and Run SSA");
  ok(await page.eval(`!document.querySelector('.pv-palette-head')`), "a search shows a flat ranked list");
  ok(await page.eval(`document.querySelector('.pv-palette-live').textContent.endsWith('results')`), "the live region counts the results", await page.eval(`document.querySelector('.pv-palette-live').textContent`));
  await key(page, "ArrowDown", "ArrowDown", 40);
  ok(await page.eval(`document.querySelector('[role=option][aria-selected=true]').dataset.i === '1'`), "ArrowDown moves the selection");
  await key(page, "ArrowUp", "ArrowUp", 38);
  await key(page, "ArrowUp", "ArrowUp", 38);
  ok(await page.eval(`+document.querySelector('[role=option][aria-selected=true]').dataset.i === document.querySelectorAll('.pv-palette [role=option]').length - 1`), "ArrowUp wraps to the last row");
  // a typo
  await page.eval(`(() => { const i = document.querySelector('.pv-palette-search'); i.select(); })()`);
  await typeText(page, "recomend");
  ok(await page.eval(`document.querySelector('.pv-palette [role=option] .pv-palette-title').textContent === 'Which engine?'`), "a typo still finds Which engine?");
  await page.eval(`document.querySelector('.pv-palette-search').select()`);
  await typeText(page, "zzzqqq");
  ok(await page.eval(`!!document.querySelector('.pv-palette-empty')`), "no match says so");

  console.log("a command form (sim.ssa): validation, then run");
  await page.eval(`document.querySelector('.pv-palette-search').select()`);
  await typeText(page, "sim.ssa");
  await key(page, "Enter", "Enter", 13);
  ok(await page.waitFor("!document.querySelector('[data-pane=form]').hidden"), "Enter opens the form");
  const f1 = await page.eval(`(() => { const p = document.querySelector('[data-pane=form]'); return {title: p.querySelector('h3').textContent, labels: [...p.querySelectorAll('label')].map(l => l.textContent.trim()), unlabelled: [...p.querySelectorAll('[data-field]')].filter(c => !document.querySelector('label[for="' + c.id + '"]') && !c.closest('label')).length, focus: document.activeElement.dataset.field, runDisabled: p.querySelector('[data-act=run]').disabled}; })()`);
  ok(f1.title === "Run SSA" && f1.labels.includes("t_end") && f1.labels.includes("runs"), "the form has the command's arguments");
  ok(f1.unlabelled === 0, "every control is labelled");
  ok(f1.focus === "t_end", "focus on the first field", f1.focus);
  await page.eval(`(() => { const c = document.querySelector('[data-field=runs]'); c.value = '500'; const t = document.querySelector('[data-field=t_end]'); t.value = 'abc'; })()`);
  await page.eval(`document.querySelector('[data-act=run]').click()`);
  await sleep(200);
  const e1 = await page.eval(`[...document.querySelectorAll('.pv-form-err:not([hidden])')].map(e => e.textContent)`);
  ok(e1.length === 2 && e1.some((m: string) => m.includes("at most 200")) && e1.some((m: string) => m.includes("enter a number")), "range and number errors shown beside the fields");
  ok(await page.eval(`document.activeElement.getAttribute('aria-invalid') === 'true'`), "focus goes to the first invalid field");
  await page.eval(`(() => { document.querySelector('[data-field=runs]').value = '5'; document.querySelector('[data-field=t_end]').value = '20'; })()`);
  await page.eval(`document.querySelector('[data-act=run]').click()`);
  ok(await page.waitFor("!!document.querySelector('[data-pane=form] svg')", 15000), "Run draws the result (a plot)");
  ok(await page.eval(`document.querySelector('.pv-structure-status').textContent === 'Done.'`), "status says Done.", await page.eval(`document.querySelector('.pv-structure-status').textContent`));
  const call = await page.eval(`(async () => { const reg = await document.querySelector('petri-view').commands(); const a = reg.artifacts().at(-1); return a.source; })()`);
  ok(call.command === "sim.ssa" && call.args.runs === 5 && call.args.t_end === 20, "the registry ran sim.ssa with the form's args");

  console.log("back, then a goal with an input");
  await page.eval(`document.querySelector('[data-act=back]').click()`);
  ok(await page.eval(`document.querySelector('[data-pane=list]').hidden === false && document.activeElement.classList.contains('pv-palette-search')`), "Back returns to the list with the search focused");
  await page.eval(`document.querySelector('.pv-palette-search').select()`);
  await typeText(page, "one more recovered");
  await key(page, "Enter", "Enter", 13);
  await page.waitFor("!document.querySelector('[data-pane=form]').hidden");
  const g1 = await page.eval(`(() => { const p = document.querySelector('[data-pane=form]'); const s = p.querySelector('select'); return {title: p.querySelector('h3').textContent, options: s ? [...s.options].map(o => o.textContent) : null, value: s && s.value, help: p.querySelector('.pv-form-help').textContent}; })()`);
  ok(g1.title.startsWith("What if I had one more") && g1.options && g1.options.includes("S") && g1.options.includes("R"), "the goal's place input is a select of the net's places");
  ok(g1.value === "R" && g1.help.includes("from your search"), "the place the question names is preselected", `${g1.value}`);
  await page.eval(`document.querySelector('[data-act=run]').click()`);
  ok(await page.waitFor("document.querySelector('.pv-structure-status').textContent.startsWith('Done. Remember')", 20000), "the goal ran and states its caveat", await page.eval(`document.querySelector('.pv-structure-status').textContent`));
  ok(await page.eval(`document.querySelectorAll('[data-pane=form] section').length >= 2`), "one section per step");

  console.log("focus trap");
  await page.eval(`document.querySelector('[data-act=back]').click()`);
  const trapped: boolean[] = [];
  for (let i = 0; i < 6; i++) { await key(page, "Tab", "Tab", 9); trapped.push(await page.eval(`!!document.activeElement.closest('.pv-palette')`)); }
  ok(trapped.every(Boolean), "Tab stays inside the dialog", JSON.stringify(trapped));
  await key(page, "Tab", "Tab", 9, 8);
  ok(await page.eval(`!!document.activeElement.closest('.pv-palette')`), "Shift-Tab stays inside the dialog");

  console.log("onResult hand-off");
  await key(page, "Escape", "Escape", 27);
  await page.eval(`(async () => { window.__h = await window.__ui.openPalette(document.querySelector('petri-view'), { onResult: (o) => window.__results.push(o), initialQuery: 'sim.marking' }); })()`);
  ok(await page.eval(`document.querySelector('.pv-palette-search').value === 'sim.marking'`), "initialQuery fills the search box");
  await key(page, "Enter", "Enter", 13);
  await page.waitFor("!document.querySelector('[data-pane=form]').hidden");
  await page.eval(`document.querySelector('[data-act=run]').click()`);
  ok(await page.waitFor("window.__results.length === 1 && !document.querySelector('.pv-palette')", 10000), "onResult gets the outcome and the palette closes");
  const o = await page.eval(`(() => { const o = window.__results[0]; return {kind: o.kind, title: o.title, calls: o.calls, error: o.error, goal: o.goal, keys: Object.keys(o)}; })()`);
  ok(o.kind === "command" && o.calls[0].command === "sim.marking" && o.error === null, "outcome shape for a command");

  console.log("classic tool + typing guard");
  await page.eval(`(async () => { await window.__ui.openPalette(document.querySelector('petri-view'), { initialQuery: 'check net' }); })()`);
  await sleep(200);
  ok(await page.eval(`document.querySelector('.pv-palette [role=option] .pv-palette-title').textContent === 'Check net'`), "the classic Check net is found");
  await page.eval(`(() => { const r = [...document.querySelectorAll('.pv-palette [role=option]')].find(x => x.querySelector('.pv-palette-title').textContent === 'Check net' && x.querySelector('.pv-palette-sub').textContent === 'Classic dialog'); r.click(); })()`);
  await sleep(300);
  ok(await page.eval(`!document.querySelector('.pv-palette')`), "a classic tool closes the palette");
  ok(await page.eval(`[...document.querySelectorAll('[role=dialog]')].some(d => /check/i.test(d.getAttribute('aria-label') || d.textContent.slice(0, 60)))`), "and opens its own dialog");
  await page.eval(`document.querySelectorAll('.pv-modal-overlay').forEach(o => o.remove())`);
  // typing in a text field: Ctrl-K is left alone
  await page.eval(`(() => { const t = document.createElement('input'); t.type = 'text'; t.id = 'plain'; document.body.appendChild(t); t.focus(); window.__prevented = null; t.addEventListener('keydown', (e) => setTimeout(() => { window.__prevented = e.defaultPrevented; }, 0)); })()`);
  await key(page, "k", "KeyK", 75, 2);
  await sleep(200);
  ok(await page.eval(`!document.querySelector('.pv-palette') && window.__prevented === false`), "Ctrl-K inside a plain text field does not open the palette and is not prevented", await page.eval(`String(window.__prevented)`));

  // A script error or a failed import of the palette is a failure; a missing thumbnail on the landing page is not.
  const bad = page.problems.filter((p: string) => p.startsWith("exception:") || /palette|schema-form/.test(p));
  ok(bad.length === 0, "no script errors", bad.slice(0, 3).join(" | "));
  await page.close();
} finally {
  await stop();
}
console.log(`\n${checks - failures}/${checks} checks passed`);
Deno.exit(failures ? 1 : 0);
