// petri-provenance.js — "How this was computed": the record behind every
// result, and its footer (docs/design/agent-first-analysis.md section 6, Step 0).
//
// A provenance RECORD is plain data: the goal that was asked (or none, for a
// palette or Classic run), the registry calls that answered it with every
// argument already resolved, the engine and why, what was assumed, the goal's
// caveat, which net (CID and revision) and which engine versions made it. The
// record is enough to
//
//   - draw the collapsed footer (footerHtml, wireFooter),
//   - copy the MCP call that repeats it (mcpCallText),
//   - run the same calls again (rerun: nothing is re-resolved, so a seeded
//     engine gives the same answer),
//   - become a linkable view (petri-viewspec.js specFromRecord).
//
// Nothing here asks a model for anything. The record says which text is the
// engine's (calls, engine, version) and which is the assistant's (note), and
// the footer labels the assistant's. No DOM: footerHtml returns a string and
// wireFooter takes any element-like root, so deno tests it directly.
import { NATIVE_VERSION } from './vendor/pflow-native-wasm/commands.js';
import { CDN } from './vendor/pflow-native-wasm/cdn.js';

export const UNKNOWN_APP = 'unknown';

/**
 * The first 7 hex characters of the vendored engine's sha256 (cdn.js CDN.sha256,
 * which petri-wasm_test.ts holds to the wasm and to pflow-native-wasm.lock):
 * the build id a browser can read. NATIVE_VERSION alone cannot tell builds
 * apart (it stayed "0.8.0" across many different wasm builds).
 */
export const WASM_BUILD = String(CDN?.sha256 ?? '').slice(0, 7);

/**
 * The engine identity a record or a view spec is made with: pflow-native's
 * command registry (the vendored wasm, pflow-native-wasm.lock) and the app.
 * The browser cannot read the lock, so the registry is named by the version
 * commands.js carries and the id of the wasm build ("pflow-native 0.8.0 wasm
 * 89bce66"): a re-vendor changes the id, so a replay can say its engine
 * differs. Pass `commit` (and `app`, e.g. /health's X-Build-Revision) when
 * they are known.
 * @param {{registry?: string, commit?: string, app?: string}} [o]
 * @returns {{registry: string, app: string}}
 */
export function defaultVersions({ registry, commit, app } = {}) {
    const native = `pflow-native ${NATIVE_VERSION}${commit ? ` ${String(commit).slice(0, 7)}` : ''}${WASM_BUILD ? ` wasm ${WASM_BUILD}` : ''}`;
    return { registry: registry ?? native, app: app ?? UNKNOWN_APP };
}

/** A plain-data copy (what JSON can carry). */
export function cloneJson(v) {
    if (v === undefined) return undefined;
    return JSON.parse(JSON.stringify(v));
}

/**
 * Calls as [{command, args}]. `id` is accepted for `command` (the design doc
 * writes it that way). A call without a command is a programmer error here;
 * untrusted input goes through petri-viewspec.js validateViewSpec instead.
 */
export function normalizeCalls(calls) {
    if (!Array.isArray(calls)) return [];
    return calls.map((c, i) => {
        const command = c && (c.command ?? c.id);
        if (typeof command !== 'string' || !command) throw new TypeError(`call ${i}: no command`);
        return { command, args: cloneJson(c.args ?? c.arguments ?? {}) };
    });
}

const text = (v) => (v === undefined || v === null ? '' : String(v));

/**
 * A provenance record.
 * @param {Object} o
 * @param {{id: string, question: string}|null} [o.goal]
 * @param {Array<{command: string, args: Object}>} [o.calls] fully resolved, in run order
 * @param {{name: string, reason?: string, overridden?: boolean, recommendedOnly?: boolean, warning?: string}|null} [o.engine]
 * @param {Array<{key: string, text: string, change?: string}>} [o.assumed]
 * @param {string} [o.caveat]
 * @param {{cid?: string, revision?: number|string}} [o.net]
 * @param {{registry: string, app: string}} [o.versions]
 * @param {{by?: string, text: string}|string|null} [o.note] the assistant's words, if any
 * @param {string[]} [o.warnings]
 */
export function provenance({ goal = null, calls = [], engine = null, assumed = [], caveat = '', net = {}, versions, note = null, warnings = [] } = {}) {
    const e = engine && typeof engine === 'object'
        ? {
            name: text(engine.name), reason: text(engine.reason),
            ...(engine.overridden ? { overridden: true } : {}),
            ...(engine.recommendedOnly ? { recommendedOnly: true } : {}),
            ...(engine.warning ? { warning: text(engine.warning) } : {}),
        }
        : null;
    const n = typeof note === 'string' ? { by: 'assistant', text: note } : note && typeof note === 'object' ? { by: 'assistant', text: text(note.text) } : null;
    return {
        goal: goal && goal.id ? { id: text(goal.id), question: text(goal.question) } : null,
        calls: normalizeCalls(calls),
        engine: e,
        assumed: (assumed || []).map((a) => ({
            key: text(a.key), text: text(a.text),
            ...(typeof a.change === 'string' && a.change ? { change: a.change } : {}),
        })),
        caveat: text(caveat),
        net: { ...(net?.cid ? { cid: text(net.cid) } : {}), revision: net?.revision ?? 0 },
        versions: { ...defaultVersions(), ...(versions || {}) },
        note: n && n.text ? n : null,
        warnings: (warnings || []).map(text).filter(Boolean),
    };
}

// ---- building records from what ran ----

// Which engine a command runs on, where the command's own help says so. Every
// command a link may replay (petri-viewspec.js REPLAY_ALLOWLIST) is here or in
// ENGINE_FREE, which a test holds to the registry: a command that runs an engine
// and is in neither would let the footer name the recommender's engine as the
// one that ran.
const ENGINE_OF = {
    'sim.ode': 'ODE', 'sim.ssa': 'SSA', 'sim.sde': 'SDE',
    'analysis.diagnose': 'ODE', 'analysis.diagnose_ssa': 'SSA', 'sim.what_if': 'SSA',
    // the mass-action ODE (solveODE), whatever the recommendation says
    'sim.equilibrium': 'ODE', 'opt.rate_scan': 'ODE', 'opt.sweep': 'ODE', 'opt.heatmap': 'ODE', 'opt.optimize': 'ODE', 'opt.fit': 'ODE',
    // seeded SSA rollouts
    'sim.evaluate': 'SSA', 'opt.distill': 'SSA',
    // both, side by side
    'sim.crosscheck': 'ODE+SSA',
};

/** Commands that run no ODE, SSA or SDE: structure, the token game, search, the view, the composition tools. */
export const ENGINE_FREE = Object.freeze([
    'analysis.validate', 'analysis.incidence', 'analysis.invariants', 'analysis.siphons', 'analysis.verify',
    'analysis.reach', 'analysis.reachability', 'analysis.canonical', 'analysis.classify', 'analysis.roles',
    'analysis.behaviour', 'analysis.defects', 'analysis.check',
    'sim.enabled', 'sim.marking', 'sim.recommend',
    'game.value', 'game.move',
    'view.highlight', 'view.clear_highlight', 'view.fit',
    'compose.components', 'compose.diff',
    'plan.pieces', 'plan.check', 'plan.slot_candidates',
    'bundle.ontology', 'bundle.instances', 'bundle.scenarios', 'bundle.example', 'bundle.validate',
    'bundle.candidates', 'bundle.flatten', 'bundle.run', 'bundle.lens', 'bundle.incidence',
]);

const parseObj = (v) => {
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
};

/**
 * The engine a call runs on ('ODE', 'SSA', 'SDE', 'ODE+SSA'), or null when the
 * command runs none (or is not known to). A scenario names its own engine
 * (ssa by default); a comparison of scenarios runs each.
 * @param {string} command
 * @param {Object} [args]
 * @returns {string|null}
 */
export function engineOf(command, args) {
    if (command === 'sim.scenario' || command === 'sim.compare') {
        const list = command === 'sim.scenario' ? [parseObj(args?.scenario)] : (Array.isArray(args?.scenarios) ? args.scenarios.map(parseObj) : []);
        const names = new Set(list.map((sc) => (String(sc?.engine ?? 'ssa').toLowerCase() === 'ode' ? 'ODE' : 'SSA')));
        if (!names.size) names.add('SSA');
        return [...names].sort().join('+');
    }
    return Object.prototype.hasOwnProperty.call(ENGINE_OF, command) ? ENGINE_OF[command] : null;
}

const showValue = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
const stepRan = (s) => !!s && !!s.command && s.args !== undefined && !s.skipped && !s.refused && !s.error;

/**
 * The assumptions behind a goal run's arguments, read from the plan: an
 * argument taken from an earlier step ("horizon from sim.recommend"), an
 * input left blank that fell back to its default, a number the plan fixes
 * ("runs = 20, set by the risk goal"). What the person typed is not assumed.
 */
function assumptionsFor(goal, steps, inputs) {
    const out = [];
    const seen = new Set();
    const push = (key, t) => {
        if (seen.has(`${key}|${t}`)) return;
        seen.add(`${key}|${t}`);
        out.push({ key, text: t });
    };
    for (const s of steps) {
        const planStep = goal?.plan?.[s.index];
        if (!stepRan(s) || !planStep) continue;
        for (const [k, v] of Object.entries(planStep.args || {})) {
            const val = s.args?.[k];
            if (val === undefined) continue;
            const ref = typeof v === 'string' ? /^\$(step(\d+)|input)\.([\w.]+)$/.exec(v) : null;
            if (ref && ref[2] !== undefined) {
                push(k, `${k} = ${showValue(val)} from ${steps[+ref[2]]?.command || `step ${ref[2]}`}`);
            } else if (ref) {
                const name = ref[3].split('.')[0];
                const decl = (goal.inputs || []).find((i) => i.name === name);
                const given = inputs?.[name];
                if ((given === undefined || given === '') && decl && decl.default !== undefined) push(k, `${k} = ${showValue(val)} (default for ${goal.id})`);
            } else if (typeof v === 'number') {
                push(k, `${k} = ${v} (set by the ${goal.id} goal)`);
            }
        }
    }
    return out;
}

/**
 * The record of one goal run (petri-goals.js runGoal's output). Skipped steps
 * (a `when` that did not hold) and refused ones (the engine guard) are not
 * calls: they did not run. A step that failed is not a call either; it is
 * listed under warnings so the footer does not claim a result it did not make.
 * @param {Object} goal a catalog goal ({id, question, caveat, plan, inputs})
 * @param {{ok: boolean, steps: Array}} run
 * @param {Object} [o]
 * @param {Object} [o.recommendation] sim.recommend's result (default: the run's own step)
 * @param {Object} [o.inputs] what the person gave the goal
 * @param {{cid?: string, revision?: number|string}} [o.net]
 * @param {{registry: string, app: string}} [o.versions]
 * @param {{text: string}|string|null} [o.note]
 */
export function recordFromGoalRun(goal, run, { recommendation, inputs = {}, net, versions, note = null } = {}) {
    const steps = run?.steps || [];
    const calls = steps.filter(stepRan).map((s) => ({ command: s.command, args: s.args }));
    const rec = recommendation || steps.find((s) => s.command === 'sim.recommend' && s.result)?.result || null;
    const used = calls.map((c) => engineOf(c.command, c.args)).find(Boolean) || null;
    const recName = rec?.engine ? String(rec.engine).toUpperCase() : null;
    const stepWarnings = steps.map((s) => s.warning).filter(Boolean);
    let engine = null;
    if (used) {
        const differs = !!recName && !used.split('+').includes(recName);
        const overridden = differs || !!inputs?.engine_override || steps.some((s) => s.overridden);
        // the reason is the recommender's: say so when it advised another engine
        engine = { name: used, reason: differs && rec?.why ? `sim.recommend advised ${recName}: ${rec.why}` : (rec?.why || '') };
        if (overridden) engine.overridden = true;
        const warning = stepWarnings[0] || (differs ? `ran ${used} although sim.recommend says ${recName}` : '');
        if (warning) engine.warning = warning;
    } else if (recName) {
        // No call that ran names an engine: the recommendation is advice, not what ran.
        engine = { name: recName, reason: rec?.why || '', recommendedOnly: true };
        if (stepWarnings[0]) engine.warning = stepWarnings[0];
    }
    const failed = steps.filter((s) => s.error).map((s) => `${s.command}: ${s.error}`);
    return provenance({
        goal, calls, engine,
        assumed: assumptionsFor(goal, steps, inputs),
        caveat: goal?.caveat || '',
        net, versions, note,
        warnings: [...stepWarnings.slice(engine?.warning ? 1 : 0), ...failed],
    });
}

/**
 * The record of one call made by hand or by the Assistant (a palette form, a
 * Classic dialog, a chat tool call): no goal, no engine reason unless given.
 * @param {{command?: string, id?: string, args?: Object}} entry
 * @param {Object} [o] {goal, engine, assumed, caveat, net, versions, note}
 */
export function recordFromCall(entry, o = {}) {
    const command = entry?.command ?? entry?.id;
    if (typeof command !== 'string' || !command) throw new TypeError('recordFromCall: the entry has no command');
    return provenance({
        goal: o.goal ?? null, calls: [{ command, args: entry.args ?? {} }], engine: o.engine ?? null,
        assumed: o.assumed ?? [], caveat: o.caveat ?? '', net: o.net, versions: o.versions, note: o.note ?? null, warnings: o.warnings ?? [],
    });
}

// ---- repeating a record ----

/**
 * Run a record's calls again, in order, on `registry` (pass a sandbox over a
 * copy of the net to leave the canvas alone). Nothing is re-resolved: the
 * arguments are the ones recorded, a seed included, so a seeded engine gives
 * the same answer. Stops at the first call that fails; that entry carries
 * `error`.
 * @param {Object} registry
 * @param {{calls: Array<{command: string, args: Object}>}} record
 * @param {{onStep?: (entry: Object) => void}} [o]
 * @returns {Promise<Array<{index: number, command: string, args: Object, result?: any, artifacts: string[], error?: string}>>}
 */
export async function rerun(registry, record, { onStep = () => {} } = {}) {
    const out = [];
    for (const [index, call] of (record?.calls || []).entries()) {
        const entry = { index, command: call.command, args: cloneJson(call.args ?? {}), artifacts: [] };
        const before = new Set(registry.artifacts().map((a) => a.id));
        try {
            entry.result = await registry.execute(call.command, entry.args);
            entry.artifacts = registry.artifacts().filter((a) => !before.has(a.id)).map((a) => a.id);
        } catch (e) {
            entry.error = e?.message || String(e);
        }
        out.push(entry);
        onStep(entry);
        if (entry.error) break;
    }
    return out;
}

/** Whether the net has changed since the record was made (its revision differs). */
export function isStale(record, revision) {
    return record?.net?.revision !== revision;
}

/**
 * The MCP tools/call params that repeat the record, as the editor's Copy MCP
 * call writes them ({name: <registry command id>, arguments}): one call as an
 * object, several as an array.
 */
export function mcpCallText(record) {
    const one = (c) => ({ name: c.command, arguments: c.args || {} });
    const calls = record?.calls || [];
    return JSON.stringify(calls.length === 1 ? one(calls[0]) : calls.map(one), null, 2);
}

// ---- the footer ----

// The same five characters the neighbours escape (petri-results.js escHtml).
const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A CID short enough for a line: "zb2rh…k3". */
export function shortCid(cid) {
    const c = String(cid ?? '');
    return c.length > 12 ? `${c.slice(0, 5)}…${c.slice(-2)}` : c;
}

const ARGS_SHOWN = 240;

function callHtml(call) {
    const args = JSON.stringify(call?.args ?? {}) ?? '{}';
    const shown = args.length > ARGS_SHOWN ? `${args.slice(0, ARGS_SHOWN - 1)}…` : args;
    return `<li class="pv-prov-call"><code>${esc(call?.command)}</code> <code class="pv-prov-args" title="${esc(args)}">${esc(shown)}</code></li>`;
}

function engineHtml(e) {
    const bits = [`<b>${esc(e.name)}</b>`];
    if (e.reason) bits.push(` — ${esc(e.reason)}`);
    if (e.recommendedOnly) bits.push(' <span class="pv-prov-chip">recommended, not run</span>');
    if (e.overridden) bits.push(' <span class="pv-prov-chip">overridden</span>');
    if (e.warning) bits.push(` <span class="pv-prov-chip pv-prov-warn">${esc(e.warning)}</span>`);
    return bits.join('');
}

function assumedHtml(list) {
    return `<ul class="pv-prov-assumed">${list.map((a) => `<li>${esc(a.text || a.key)}${
        a.change ? ` <button type="button" class="pv-prov-link" data-act="edit" data-field="${esc(a.change)}">Change</button>` : ''}</li>`).join('')}</ul>`;
}

function versionHtml(r) {
    const parts = [`net ${r.net?.cid ? esc(shortCid(r.net.cid)) : 'unsaved'}${r.net?.revision !== undefined ? ` (revision ${esc(r.net.revision)})` : ''}`];
    if (r.versions?.registry) parts.push(`engine ${esc(r.versions.registry)}`);
    if (r.versions?.app) parts.push(`app ${esc(r.versions.app)}`);
    return parts.join(' · ');
}

export const FOOTER_ACTS = [['rerun', 'Rerun'], ['edit', 'Edit settings'], ['mcp', 'Copy MCP call'], ['link', 'Copy link'], ['tools', 'Open in Tools']];

// Each footer drawn carries an id (data-prov-id), so one listener on a pane
// that holds several footers (a session's stack of results) answers only for
// the footer a click came from. The id belongs to the record object: the same
// record gives the same id to footerHtml and to wireFooter. A copy of a
// record is another record; pass `id` to both to tie them by hand.
const footerIds = new WeakMap();
let footerSeq = 0;
function footerId(record) {
    if (record === null || typeof record !== 'object') return `pv-prov-${++footerSeq}`;
    let id = footerIds.get(record);
    if (!id) { id = `pv-prov-${++footerSeq}`; footerIds.set(record, id); }
    return id;
}

/**
 * The "How this was computed" footer for a record, collapsed unless `open`
 * (the first result of a session). Every string in the record is escaped. The
 * assistant's note is labelled as the assistant's; everything else is the
 * engine's. `stale` adds the "net changed since" chip.
 * @param {Object} record
 * @param {{open?: boolean, stale?: boolean, id?: string}} [o] `id`: this footer's id (default: the record's own, see footerId)
 * @returns {string}
 */
export function footerHtml(record, { open = false, stale = false, id } = {}) {
    const r = record || {};
    const rows = [];
    const row = (label, html) => rows.push(`<dt>${label}</dt><dd>${html}</dd>`);
    if (r.goal) row('Goal', `<b>${esc(r.goal.id)}</b> — “${esc(r.goal.question)}”`);
    if (r.engine) row('Engine', engineHtml(r.engine));
    row('Calls', `<ol class="pv-prov-calls">${(r.calls || []).map(callHtml).join('')}</ol>`);
    if (r.assumed?.length) row('Assumed', assumedHtml(r.assumed));
    if (r.caveat) row('Caveat', esc(r.caveat));
    if (r.warnings?.length) row('Warnings', r.warnings.map((w) => `<div>${esc(w)}</div>`).join(''));
    if (r.note?.text) row('Note', `<span class="pv-prov-chip pv-prov-ast">assistant</span> ${esc(r.note.text)}`);
    row('Version', versionHtml(r));
    return `<details class="pv-prov" data-prov data-prov-id="${esc(id ?? footerId(record))}"${open ? ' open' : ''}>
    <summary>How this was computed${stale ? ' <span class="pv-prov-chip pv-prov-warn">net changed since</span>' : ''}</summary>
    <dl class="pv-prov-rows">${rows.join('')}</dl>
    <div class="pv-prov-acts">${FOOTER_ACTS.map(([act, label]) => `<button type="button" class="pv-btn pv-btn-sm" data-act="${act}">${label}</button>`).join('')}</div>
</details>`;
}

/**
 * Bind a footer's buttons to `handlers.{rerun, edit, mcp, link, tools}(record,
 * {field, button})`; an absent handler is a no-op. One click listener on
 * `root` (delegation), and only buttons inside an element marked data-prov
 * count, so a root that holds other [data-act] buttons (the chat's own Rerun)
 * is not double-handled. `root` may hold several footers: a footer made by
 * footerHtml carries the id of its record (or the `id` given to both), and a
 * click answers only for the record whose footer it came from, so wiring each
 * result of a stack with its own record runs one handler per click, not one
 * per wired record. (A footer with no id, drawn by other code, is answered by
 * every binding on the root: pass the footer element itself as `root` then.)
 * Returns a function that unbinds.
 * @param {{addEventListener: Function, removeEventListener?: Function, contains?: Function}} root
 * @param {Object} record
 * @param {Object} [handlers]
 * @param {{id?: string}} [o]
 * @returns {() => void}
 */
export function wireFooter(root, record, handlers = {}, { id } = {}) {
    const acts = FOOTER_ACTS.map(([a]) => a);
    const mine = id ?? (record !== null && typeof record === 'object' ? footerId(record) : null);
    const onClick = (ev) => {
        const btn = ev?.target?.closest?.('[data-act]');
        const act = btn?.dataset?.act;
        if (!act || !acts.includes(act)) return;
        const box = btn.closest('[data-prov]');
        if (!box || (typeof root.contains === 'function' && !root.contains(box))) return;
        const boxId = box.dataset?.provId ?? box.getAttribute?.('data-prov-id');
        if (mine !== null && boxId !== undefined && boxId !== null && boxId !== mine) return; // another footer's button
        const fn = handlers?.[act];
        if (typeof fn === 'function') fn(record, { field: btn.dataset.field ?? null, button: btn });
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener?.('click', onClick);
}
