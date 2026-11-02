// petri-viewspec.js — linkable model views (docs/design/agent-first-analysis.md
// section 14, step L1), with no DOM and no model.
//
// A VIEW SPEC names a net, a view of it and the registry calls that produced
// the view, fully resolved (the engine, horizon, seed and run count a
// recommendation chose are written into the calls, so a later change to the
// recommender does not change what a link shows). Opening a link validates the
// spec, runs its calls on a SANDBOX registry over a copy of the net and
// renders what comes back. No /api/llm request is made: opening costs no
// quota, and nothing in this module can reach a model.
//
//   {"@type": "ViewSpec", "specVersion": 1, "net": "<cid>", "view": "risk",
//    "calls": [{"command": "sim.recommend", "args": {}}, {"command": "sim.ssa", "args": {...}}],
//    "engine": {"registry": "pflow-native 0.8.0", "app": "..."},
//    "expect": {"artifacts": ["sha256:..."], "rounding": 9},
//    "note": {"by": "assistant", "text": "..."}, "parents": ["<cid>"]}
//
// A link is untrusted input that runs commands (design 14.6), so replay is
// fenced four ways, all in this file:
//
//   1. an allowlist: only analysis, sim, opt, game, view and read-only compose
//      commands replay; deny by default, so a command that is not listed does
//      not replay, and anything that edits the net or writes state is refused
//      whatever the list says (replayAllowed);
//   2. bounds, the /mcp ones (BOUNDS, checkBounds), checked before anything runs;
//   3. a sandbox: the caller passes a registry over a copy of the net
//      (sandboxRegistry), and replay compares the net before and after as a
//      tripwire (`mutated`);
//   4. the note is text: it is validated as a string and the footer escapes it.
//
// The URL scheme (14.2): /?cid=<net>#view=<payload>, where the payload is
// base64url(deflate-raw(JSON)) of the spec without its net (the CID travels in
// the query). /?cid= and /?data= alone open the net exactly as they do today;
// #view= only adds. /?data=<permalink>#view= is the unsaved-net form.
import { Registry, createHeadlessHost } from './petri-commands.js';
import { NATIVE_COMMANDS } from './vendor/pflow-native-wasm/commands.js';
import { cloneJson, defaultVersions, normalizeCalls } from './petri-provenance.js';

export const SPEC_VERSION = 1;

/** Significant digits a float artifact is rounded to before it is hashed. */
export const DEFAULT_ROUNDING = 9;

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * What a replayed call may ask for. The ceilings are /mcp's (cmd/webserver),
 * so a link cannot ask the browser for more than a connector may ask the
 * server; the rest are this module's own and say so.
 *
 *   ceilings.runs, realizations, rollouts  200   wbMaxRuns, mcp_workbench_engine.go:48
 *                                                (what_if / sde / sim.evaluate say "≤ 200")
 *   ceilings.t_end, horizon, hours, t_max  10000 wbMaxHorizon, mcp_workbench_engine.go:49;
 *                                                maxMCPTEnd, mcp.go:41
 *   ceilings.depth                         10000 sim.evaluate "depth ≤ 10000" (token-game playouts)
 *   ceilings.points, samples               500   wbMaxSDEPoints, wbMaxWhatIfSamples, wbMaxOptSamples,
 *                                                mcp_workbench.go:38-40; pflow_ssa "points 2..500",
 *                                                mcp_registry.go:713 (the in-browser registry allows more)
 *   ceilings.steps                         50    pflow_rate_scan "steps 2..50", mcp_registry.go:768
 *   ceilings.x_steps, y_steps              40    opt.heatmap "grid (≤ 40 × 40)", its spec in
 *                                                vendor/pflow-native-wasm/commands.js
 *   ceilings.max_states                    20000 maxMCPStates, mcp.go:40
 *   ceilings.nodes                         10_000_000  wbGameMaxNodes, mcp_game.go:49
 *   ceilings.memo                          2_097_152   wbGameMaxMemo (1 << 21), mcp_game.go:50
 *   minTolerance                           1e-12 wbMinTolerance, mcp_workbench.go:47 (below it the
 *                                                adaptive step sits at its minimum and the solve runs out of steps)
 *   maxSDESteps                            50000 wbMaxSDESteps, mcp_workbench_engine.go:52
 *                                                (t_end / dt for an explicit sim.sde step)
 *   callTimeoutMs                          60000 mcpCallTimeoutDefault, mcp_registry.go:47
 *
 * This module's own choices (not /mcp's):
 *   maxCalls     12       a view is a short plan: the largest catalogue goal has 3 calls, a session 4x that
 *   maxArgBytes  16384    JSON size of one call's arguments (/mcp bounds a whole body at 512 KB, maxMCPBody)
 *   maxNesting   12       depth of an argument value
 *   totalSteps   1e6      declared sample steps summed over calls (see workOf): ten calls at the per-call
 *                         ceilings (200 runs x 500 points = 100000 each) fit, eleven do not
 *   maxNote      4000     characters of the assistant's note
 *   maxEncodedChars 65536, maxInflatedBytes 262144   a link's payload, as sent and as inflated
 *
 * A 60 s timeout cannot interrupt synchronous work in the tab: replay abandons
 * a call that has not settled in time (replayViewSpec), but a command that
 * never yields to the event loop is stopped only by these ceilings.
 */
export const BOUNDS = Object.freeze({
    maxCalls: 12,
    maxArgBytes: 16384,
    maxNesting: 12,
    totalSteps: 1_000_000,
    maxNote: 4000,
    maxEncodedChars: 64 * 1024,
    maxInflatedBytes: 256 * 1024,
    minTolerance: 1e-12,
    maxSDESteps: 50_000,
    callTimeoutMs: 60_000,
    ceilings: Object.freeze({
        runs: 200, realizations: 200, rollouts: 200,
        t_end: 10_000, horizon: 10_000, hours: 10_000, t_max: 10_000, depth: 10_000,
        points: 500, samples: 500, steps: 50, x_steps: 40, y_steps: 40,
        max_states: 20_000, nodes: 10_000_000, memo: 2_097_152,
    }),
});

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// Arguments that hold a document as JSON text (pflow-native takes either).
function asJson(v) {
    if (typeof v !== 'string' || v.length > BOUNDS.maxArgBytes) return v;
    const t = v.trimStart();
    if (t[0] !== '{' && t[0] !== '[') return v;
    try { return JSON.parse(v); } catch { return v; }
}

/** Declared work of one call: realizations x grid points (a heatmap: cells). Not an engine-time model. */
function workOf(call) {
    const a = isPlain(call?.args) ? call.args : {};
    const n = (k) => (typeof a[k] === 'number' && a[k] > 0 ? a[k] : undefined);
    if (call?.command === 'opt.heatmap') {
        const s = n('steps') ?? 10;
        return (n('x_steps') ?? s) * (n('y_steps') ?? s);
    }
    return (n('runs') ?? n('rollouts') ?? n('samples') ?? 1) * (n('points') ?? n('steps') ?? 1);
}

function walk(v, path, errs, depth) {
    if (depth > BOUNDS.maxNesting) { errs.push(`${path}: nested deeper than ${BOUNDS.maxNesting}`); return; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) errs.push(`${path}: not a finite number`); return; }
    v = asJson(v);
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, errs, depth + 1)); return; }
    if (!isPlain(v)) return;
    for (const [k, x] of Object.entries(v)) {
        const at = `${path}.${k}`;
        if (typeof x === 'number') {
            if (!Number.isFinite(x)) { errs.push(`${at}: not a finite number`); continue; }
            const cap = Object.prototype.hasOwnProperty.call(BOUNDS.ceilings, k) ? BOUNDS.ceilings[k] : undefined;
            if (cap !== undefined && x > cap) errs.push(`${at}: ${x} is over the limit ${cap}`);
            if ((k === 'abstol' || k === 'reltol') && x < BOUNDS.minTolerance) errs.push(`${at}: ${x} is under the minimum tolerance ${BOUNDS.minTolerance}`);
        } else {
            walk(x, at, errs, depth + 1);
        }
    }
}

/**
 * Check calls against BOUNDS before anything runs.
 * @param {Array<{command: string, args: Object}>} calls
 * @returns {{ok: boolean, errors: string[], work: number}}
 */
export function checkBounds(calls) {
    const errors = [];
    if (!Array.isArray(calls)) return { ok: false, errors: ['calls: not a list'], work: 0 };
    if (calls.length > BOUNDS.maxCalls) errors.push(`calls: ${calls.length} calls, at most ${BOUNDS.maxCalls}`);
    let work = 0;
    calls.forEach((c, i) => {
        if (!isPlain(c)) return;
        const at = `call ${i} (${typeof c.command === 'string' ? c.command : '?'})`;
        const args = c.args ?? {};
        if (!isPlain(args)) return; // validateViewSpec says so
        let size = 0;
        try { size = JSON.stringify(args).length; } catch { errors.push(`${at}: arguments are not JSON`); return; }
        if (size > BOUNDS.maxArgBytes) errors.push(`${at}: arguments are ${size} bytes, at most ${BOUNDS.maxArgBytes}`);
        const found = [];
        walk(args, 'args', found, 0);
        errors.push(...found.map((m) => `${at}: ${m}`));
        // An explicit SDE step: t_end / dt integration steps.
        if (c.command === 'sim.sde' && typeof args.dt === 'number' && args.dt > 0) {
            const steps = (typeof args.t_end === 'number' ? args.t_end : 10) / args.dt;
            if (steps > BOUNDS.maxSDESteps) errors.push(`${at}: t_end / dt is ${Math.ceil(steps)} steps, at most ${BOUNDS.maxSDESteps}`);
        }
        work += workOf(c);
    });
    if (work > BOUNDS.totalSteps) errors.push(`calls: ${work} declared steps is over the budget ${BOUNDS.totalSteps}`);
    return { ok: errors.length === 0, errors, work };
}

// ---------------------------------------------------------------------------
// The replay allowlist
// ---------------------------------------------------------------------------

// Commands that change the document, or the token game's marking (which lives
// in it). Re-derived from petri-chat.js (EDITS, isEdit) and from the native
// command flags in vendor/pflow-native-wasm/commands.js, so a link cannot
// reach what the Assistant's explain mode cannot.
const EDITS = new Set(['file.new', 'edit.undo', 'edit.redo', 'edit.delete', 'sim.fire', 'sim.reset', 'sim.set_rate', 'sim.goto']);
const NATIVE_EDITS = new Set(NATIVE_COMMANDS.filter((s) => s.edits || s.setsMarking).map((s) => s.id));
const NATIVE_EDITS_ON_APPLY = new Set(NATIVE_COMMANDS.filter((s) => s.editsOnApply).map((s) => s.id));
const NATIVE_EDITS_ON_CURRENT = new Map(NATIVE_COMMANDS.filter((s) => s.editsOnCurrent).map((s) => [s.id, s.editsOnCurrent]));
const NATIVE_WRITES_STATE = new Set(NATIVE_COMMANDS.filter((s) => s.writesState).map((s) => s.id));

/**
 * Whether a call changes the net or moves its marking: petri-chat.js's
 * isEdit. Commands that edit only when asked to (opt.fit with apply) edit
 * when `args` says so.
 */
export function editsNet(id, args) {
    return EDITS.has(id) || (id.startsWith('net.') && id !== 'net.info') || NATIVE_EDITS.has(id)
        || (NATIVE_EDITS_ON_APPLY.has(id) && !!args?.apply)
        || (NATIVE_EDITS_ON_CURRENT.has(id) && [undefined, 'current'].includes(args?.[NATIVE_EDITS_ON_CURRENT.get(id)]));
}

/** Whether a command writes state: the session (library, systems, notes, macros, the store) or an account file. */
export function writesState(id) {
    return NATIVE_WRITES_STATE.has(id);
}

// Never replayable, listed or not.
const NEVER = ['edit.', 'net.', 'file.', 'store.', 'export.', 'model.', 'note.', 'macro.', 'system.'];

/**
 * The commands a link may run, by name. Deny by default: a command the
 * registry gains tomorrow is not replayable until it is added here, after
 * someone has decided it reads and writes nothing.
 */
export const REPLAY_ALLOWLIST = Object.freeze([
    'analysis.validate', 'analysis.incidence', 'analysis.invariants', 'analysis.siphons', 'analysis.verify',
    'analysis.reach', 'analysis.reachability', 'analysis.canonical', 'analysis.classify', 'analysis.diagnose',
    'analysis.diagnose_ssa', 'analysis.roles', 'analysis.behaviour', 'analysis.defects', 'analysis.check',
    'sim.enabled', 'sim.marking', 'sim.ode', 'sim.ssa', 'sim.sde', 'sim.what_if', 'sim.recommend',
    'sim.equilibrium', 'sim.scenario', 'sim.compare', 'sim.crosscheck', 'sim.evaluate',
    'opt.rate_scan', 'opt.sweep', 'opt.heatmap', 'opt.optimize', 'opt.fit', 'opt.distill',
    'game.value', 'game.move',
    'view.highlight', 'view.clear_highlight', 'view.fit',
    'compose.components', 'compose.diff',
    'plan.pieces', 'plan.check', 'plan.slot_candidates',
    'bundle.ontology', 'bundle.instances', 'bundle.scenarios', 'bundle.example', 'bundle.validate',
    'bundle.candidates', 'bundle.flatten', 'bundle.run', 'bundle.lens', 'bundle.incidence',
]);
const ALLOWED = new Set(REPLAY_ALLOWLIST);

/**
 * Whether a link may run this command. `args` matters for the commands that
 * edit only with apply (opt.fit, opt.distill): without it they read.
 * @param {string} commandId
 * @param {Object} [args]
 */
export function replayAllowed(commandId, args) {
    if (typeof commandId !== 'string' || !ALLOWED.has(commandId)) return false;
    if (NEVER.some((p) => commandId.startsWith(p))) return false;
    if (editsNet(commandId, args) || writesState(commandId)) return false;
    return true;
}

// ---------------------------------------------------------------------------
// Building and validating a spec
// ---------------------------------------------------------------------------

const CALL_ID = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * A view spec.
 * @param {Object} o
 * @param {string|null} [o.net] the net's CID (null: the page's own, as for an unsaved net)
 * @param {string} [o.view] a goal id or a view id
 * @param {Array<{command: string, args: Object}>} o.calls fully resolved
 * @param {{registry: string, app: string}} [o.engine] default: this build
 * @param {{artifacts: string[], rounding: number}} [o.expect] see expectFor
 * @param {{text: string}|string|null} [o.note] the assistant's note
 * @param {string[]} [o.parents]
 */
export function buildViewSpec({ net = null, view, calls, engine, expect, note, parents } = {}) {
    const raw = typeof note === 'string' ? note : note && typeof note === 'object' ? String(note.text ?? '') : '';
    // a note longer than the limit is cut, so a long answer does not make the link invalid
    const n = raw ? { by: 'assistant', text: raw.length > BOUNDS.maxNote ? `${raw.slice(0, BOUNDS.maxNote - 1)}…` : raw } : null;
    return {
        '@type': 'ViewSpec',
        specVersion: SPEC_VERSION,
        net: net ?? null,
        view: view || 'custom',
        calls: normalizeCalls(calls),
        engine: engine ? { registry: String(engine.registry ?? ''), app: String(engine.app ?? '') } : defaultVersions(),
        expect: expect ? { artifacts: [...(expect.artifacts || [])], rounding: expect.rounding ?? DEFAULT_ROUNDING } : { artifacts: [], rounding: DEFAULT_ROUNDING },
        note: n,
        parents: [...(parents || [])],
    };
}

/**
 * The spec behind a provenance record (petri-provenance.js): its calls, the
 * versions that made it, its net and the assistant's note. `view` defaults
 * to the goal's id.
 * @param {Object} record
 * @param {{view?: string, expect?: Object, parents?: string[]}} [o]
 */
export function specFromRecord(record, { view, expect, parents } = {}) {
    return buildViewSpec({
        net: record?.net?.cid ?? null, view: view || record?.goal?.id || 'custom', calls: record?.calls || [],
        engine: record?.versions, expect, note: record?.note ?? null, parents,
    });
}

const short = (s) => (String(s).length > 60 ? `${String(s).slice(0, 57)}…` : String(s));

/**
 * Check a spec, from a link or a saved object, before anything runs: its
 * shape, the spec version, the replay allowlist and the bounds. A command the
 * registry does not have is not an error: it is "not reproducible here" and
 * is listed under `unknown`. A command that may not replay is listed under
 * `refused` (and does not run), whether or not the registry has it.
 * `ok` means: well formed, within bounds, and every call replayable.
 * @param {*} spec
 * @param {Object} [registry] a Registry, to tell commands it has from those it lacks
 * @returns {{ok: boolean, errors: string[], refused: string[], unknown: string[]}}
 */
export function validateViewSpec(spec, registry) {
    const out = { ok: false, errors: [], refused: [], unknown: [] };
    const err = (m) => out.errors.push(m);
    if (!isPlain(spec)) { err('a view spec is a JSON object'); return out; }
    if (spec['@type'] !== undefined && spec['@type'] !== 'ViewSpec') err('@type must be "ViewSpec"');
    if (!Number.isInteger(spec.specVersion) || spec.specVersion < 1) err('specVersion must be a positive integer');
    else if (spec.specVersion > SPEC_VERSION) err(`specVersion ${spec.specVersion} is newer than this app reads (${SPEC_VERSION}); the net can still be opened alone`);
    if (spec.net !== undefined && spec.net !== null && (typeof spec.net !== 'string' || !spec.net || spec.net.length > 200)) err('net must be a CID string or null');
    if (typeof spec.view !== 'string' || !spec.view || spec.view.length > 80) err('view must be a name of 1 to 80 characters');

    let callsOk = false;
    if (!Array.isArray(spec.calls)) err('calls must be a list');
    else if (!spec.calls.length) err('calls is empty: a view needs at least one call');
    else if (spec.calls.length > BOUNDS.maxCalls) err(`calls: ${spec.calls.length} calls, at most ${BOUNDS.maxCalls}`);
    else callsOk = true;

    if (callsOk) {
        const known = registry && typeof registry.list === 'function' ? new Set(registry.list().map((s) => s.id)) : null;
        let shapeOk = true;
        spec.calls.forEach((c, i) => {
            if (!isPlain(c)) { err(`call ${i}: not an object`); shapeOk = false; return; }
            const id = c.command ?? c.id;
            if (typeof id !== 'string' || !CALL_ID.test(id) || id.length > 80) { err(`call ${i}: "${short(id)}" is not a command id`); shapeOk = false; return; }
            if (c.args !== undefined && !isPlain(c.args)) { err(`call ${i} (${id}): arguments must be an object`); shapeOk = false; return; }
            if (!replayAllowed(id, c.args)) {
                if (!out.refused.includes(id)) out.refused.push(id);
            } else if (known && !known.has(id) && !out.unknown.includes(id)) {
                out.unknown.push(id);
            }
        });
        if (shapeOk) {
            const b = checkBounds(spec.calls.map((c) => ({ command: c.command ?? c.id, args: c.args ?? {} })));
            out.errors.push(...b.errors);
        }
    }

    const e = spec.engine;
    if (e !== undefined && e !== null && !(isPlain(e) && typeof e.registry === 'string' && typeof e.app === 'string' && e.registry.length <= 80 && e.app.length <= 80)) err('engine must be {registry, app} (text of at most 80 characters)');
    const x = spec.expect;
    if (x !== undefined && x !== null) {
        if (!isPlain(x) || !Array.isArray(x.artifacts) || x.artifacts.length > 64 || !x.artifacts.every((d) => typeof d === 'string' && DIGEST.test(d))) err('expect.artifacts must be a list of at most 64 sha256:<hex> digests');
        if (isPlain(x) && x.rounding !== undefined && !(Number.isInteger(x.rounding) && x.rounding >= 1 && x.rounding <= 17)) err('expect.rounding must be an integer from 1 to 17');
    }
    const n = spec.note;
    if (n !== undefined && n !== null) {
        if (!isPlain(n) || n.by !== 'assistant' || typeof n.text !== 'string') err('note must be {by: "assistant", text} with text as a string');
        else if (n.text.length > BOUNDS.maxNote) err(`note is ${n.text.length} characters, at most ${BOUNDS.maxNote}`);
    }
    const p = spec.parents;
    if (p !== undefined && p !== null && !(Array.isArray(p) && p.length <= 16 && p.every((c) => typeof c === 'string' && c.length > 0 && c.length <= 200))) err('parents must be a list of at most 16 CIDs');

    out.ok = out.errors.length === 0 && out.refused.length === 0;
    return out;
}

// ---------------------------------------------------------------------------
// Encoding a spec into a link
// ---------------------------------------------------------------------------

const toB64url = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

function fromB64url(text) {
    if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('not base64url');
    const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Pipe bytes through a (de)compression stream, giving up past `cap` output bytes. */
async function through(bytes, stream, cap = Infinity) {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > cap) { await reader.cancel().catch(() => {}); throw new RangeError(`inflates past ${cap} bytes`); }
        chunks.push(value);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

/**
 * The link payload of a spec: base64url(deflate-raw(JSON)) of everything but
 * the net (the CID travels in the query) and the @type. Empty fields are
 * left out and decodeView puts them back.
 * @param {Object} spec
 * @returns {Promise<string>}
 */
export async function encodeView(spec) {
    const body = { specVersion: spec.specVersion ?? SPEC_VERSION, view: spec.view, calls: spec.calls };
    if (spec.engine) body.engine = spec.engine;
    if (spec.expect?.artifacts?.length) body.expect = spec.expect;
    if (spec.note) body.note = spec.note;
    if (spec.parents?.length) body.parents = spec.parents;
    const json = new TextEncoder().encode(JSON.stringify(body));
    return toB64url(await through(json, new CompressionStream('deflate-raw')));
}

/**
 * The spec a link payload holds. Never throws: oversized, damaged or
 * non-spec input is `{ok: false, error}`. The result still needs
 * validateViewSpec; decoding checks only that it is text, inflates under
 * BOUNDS.maxInflatedBytes and is a JSON object.
 * @param {string} text
 * @param {{net?: string|null}} [o] the net the link names (its CID, from the query)
 * @returns {Promise<{ok: true, spec: Object}|{ok: false, error: string}>}
 */
export async function decodeView(text, { net = null } = {}) {
    try {
        if (typeof text !== 'string' || !text) return { ok: false, error: 'the link has no view in it' };
        if (text.length > BOUNDS.maxEncodedChars) return { ok: false, error: `the view is ${text.length} characters, at most ${BOUNDS.maxEncodedChars}` };
        const raw = await through(fromB64url(text), new DecompressionStream('deflate-raw'), BOUNDS.maxInflatedBytes);
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (!isPlain(body)) return { ok: false, error: 'the view is not a JSON object' };
        return {
            ok: true,
            spec: {
                '@type': 'ViewSpec',
                specVersion: body.specVersion,
                net: net ?? null,
                view: body.view,
                calls: body.calls,
                engine: body.engine ?? null,
                expect: body.expect ?? { artifacts: [], rounding: DEFAULT_ROUNDING },
                note: body.note ?? null,
                parents: body.parents ?? [],
            },
        };
    } catch (e) {
        return { ok: false, error: e instanceof RangeError ? `the view is too large (${e.message})` : 'the view link is damaged' };
    }
}

// ---------------------------------------------------------------------------
// Link URLs
// ---------------------------------------------------------------------------

/** The longest link worth handing out; beyond it, "save to get a stable link" (design 14.2). */
export const MAX_LINK_CHARS = 8192;

/**
 * The ?data= permalink value for an unsaved net, as the editor writes it
 * (petri-view.js _updatePermalinkURL): the net's JSON, percent-encoded.
 */
export function permalinkData(model) {
    return encodeURIComponent(JSON.stringify(model));
}

/**
 * The net out of a ?data= value, as the editor reads it (petri-view.js
 * _decodePermalinkData: up to 1 MB, decoded until it is JSON). Unlike that
 * loop it cannot spin: text with a stray percent sign stops the decoding.
 * @returns {Object|null}
 */
export function decodePermalinkData(encoded) {
    if (typeof encoded !== 'string' || !encoded || encoded.length > 1024 * 1024) return null;
    let s = encoded;
    for (let i = 0; i < 10; i++) {
        let next;
        try { next = decodeURIComponent(s); } catch { break; }
        if (next === s) break;
        s = next;
        try { JSON.parse(s); break; } catch { /* decode once more */ }
    }
    try {
        const data = JSON.parse(s);
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch { return null; }
}

/**
 * The link to a view: origin/?cid=<net>#view=<payload>, or, for an unsaved
 * net, origin/?data=<permalink>#view=<payload> (`data` as parseLocation
 * returns it, or permalinkData makes it). Without a payload it is the net's
 * own link, which opens the net alone as it always has.
 * @param {{origin?: string, cid?: string, data?: string, payload?: string}} o
 */
export function linkFor({ origin = '', cid, data, payload } = {}) {
    const base = String(origin).replace(/\/+$/, '');
    let url;
    if (cid) url = `${base}/?cid=${encodeURIComponent(cid)}`;
    else if (data) url = `${base}/?data=${encodeURIComponent(data)}`;
    else throw new TypeError('linkFor needs a net: a cid, or a data permalink');
    return payload ? `${url}#view=${encodeURIComponent(payload)}` : url;
}

/** Whether a link is short enough to hand out. */
export function linkFits(url) {
    return String(url).length <= MAX_LINK_CHARS;
}

const COMPOSE_KEYS = ['ex', 'inst', 'links', 'plan'];

/**
 * What a location asks for. `cid` (?cid=) and `data` (?data=, as the editor's
 * loader sees it: one percent-decoding done) name the net and mean what they
 * always have: the editor loads data first, then the cid. `route` (?route=)
 * and `specCid` (?v=, a saved spec) are read here and not interpreted.
 * `viewPayload` is #view= when the hash is ours: a compose-page hash
 * (#view=cospan&ex=orders) is not, and gives null.
 * @param {{search?: string, hash?: string}} loc
 * @returns {{cid: string|null, data: string|null, viewPayload: string|null, route: string|null, specCid: string|null}}
 */
export function parseLocation({ search = '', hash = '' } = {}) {
    let q;
    let h;
    try { q = new URLSearchParams(String(search)); } catch { q = new URLSearchParams(); }
    try { h = new URLSearchParams(String(hash).replace(/^#/, '')); } catch { h = new URLSearchParams(); }
    const composeHash = COMPOSE_KEYS.some((k) => h.has(k));
    return {
        cid: q.get('cid') || null,
        data: q.get('data') || null,
        viewPayload: !composeHash && h.get('view') ? h.get('view') : null,
        route: q.get('route') || null,
        specCid: q.get('v') || null,
    };
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

// Keys whose string values name another artifact (petri-wasm.js ARTIFACT_KEYS).
// pflow-native files an artifact's companions under its own session ids
// ("trace": "a5"), runNative leaves those ids in the stored data, and the
// engine's counter keeps running between runs, so the same analysis names
// "a1" in one session and "a5" in the next. A digest must not depend on that:
// such a reference is hashed as "@artifact".
const REF_KEYS = new Set(['artifact', 'artifacts', 'sets', 'report', 'trace', 'traces', 'graph', 'matrices', 'p_basis', 't_basis', 'table', 'bars', 'heatmap', 'scatter', 'series', 'log', 'data', 'timeseries', 'overlay']);
const REF = /^a\d+$/;
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// Canonical JSON: keys sorted by code point (an object literal would put
// integer-like keys first), floats rounded to `digits` significant digits.
// `ref` is true under a key in REF_KEYS, through arrays ("traces": ["a1"]); it
// does not reach into objects (a series named "a1" is a name), except the map
// under "artifacts" ({"verdict": "a3"}), which is all references.
function canonical(v, digits, ref = false) {
    const map = ref === 'map';
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') {
        if (Number.isNaN(v)) return '"NaN"';
        if (!Number.isFinite(v)) return v > 0 ? '"Infinity"' : '"-Infinity"';
        if (Number.isInteger(v)) return String(v === 0 ? 0 : v);
        return String(Number(v.toPrecision(digits)));
    }
    if (typeof v === 'string') return ref && REF.test(v) ? '"@artifact"' : JSON.stringify(v);
    if (typeof v === 'boolean') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map((x) => canonical(x, digits, ref)).join(',')}]`;
    if (typeof v === 'object') {
        const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k], digits, map || (k === 'artifacts' && isObj(v[k]) ? 'map' : REF_KEYS.has(k)))}`).join(',')}}`;
    }
    return 'null';
}

/**
 * 'sha256:<hex>' of an artifact's data, in canonical JSON with floats rounded
 * to `rounding` significant digits (state it in expect.rounding). The seeded
 * stochastic engines are byte-exact by contract; the ODE is reproduced to the
 * rounding, which is why the rounding is part of the spec.
 * @param {{data: any}} art
 * @param {{rounding?: number}} [o]
 */
export async function artifactDigest(art, { rounding = DEFAULT_ROUNDING } = {}) {
    const digits = Math.min(17, Math.max(1, Math.trunc(rounding) || DEFAULT_ROUNDING));
    const bytes = new TextEncoder().encode(canonical(art?.data, digits));
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return `sha256:${[...hash].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The `expect` of a spec made from these artifacts (in the order the calls
 * produced them).
 * @param {Array<{data: any}>} artifacts
 * @param {{rounding?: number}} [o]
 */
export async function expectFor(artifacts, { rounding = DEFAULT_ROUNDING } = {}) {
    const digests = [];
    for (const a of artifacts) digests.push(await artifactDigest(a, { rounding }));
    return { artifacts: digests, rounding };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * A registry over a copy of `model`: replay's sandbox. The live net is never
 * touched; Apply is the only way to change the canvas.
 */
export function sandboxRegistry(model) {
    return new Registry(createHeadlessHost(structuredClone(model)));
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish in ${Math.round(ms / 1000)} s; given up`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const snapshot = (registry) => {
    try { return JSON.stringify(registry.host.getModel()); } catch { return null; }
};

/**
 * Replay a spec's calls, in order, on `registry`, which must be a sandbox
 * (sandboxRegistry): nothing here asks it to edit, and `mutated` says if its
 * net changed anyway. It never calls a model and never fetches.
 *
 * The spec is validated first. A malformed spec or one over the bounds runs
 * nothing (`errors`). A call that may not replay is refused, one the registry
 * does not have is "not reproducible here", and a view command the sandbox
 * has no canvas for is `deferred` (run it on the live registry); each is
 * reported and skipped, and the rest runs. A call that fails (a place that no
 * longer exists, named in the error) marks the replay `partial`, not wrong.
 *
 * `drift` compares each artifact's digest with `expect`: `matched`,
 * `differed` (the view changed since the link was made) and `unchecked` (no
 * expectation, or the artifact follows a call that did not run, so it cannot
 * be told which expectation is its own).
 *
 * @param {Object} spec
 * @param {Object} registry a sandbox registry
 * @param {Object} [o]
 * @param {(step: Object) => void} [o.onStep]
 * @param {number} [o.timeoutMs] per call (default BOUNDS.callTimeoutMs)
 * @param {{registry: string, app: string}} [o.versions] this build's, for the engine comparison
 */
export async function replayViewSpec(spec, registry, { onStep = () => {}, timeoutMs = BOUNDS.callTimeoutMs, versions } = {}) {
    const now = versions || defaultVersions();
    const check = validateViewSpec(spec, registry);
    const result = {
        ok: false, errors: check.errors, steps: [], artifacts: [],
        drift: { matched: [], differed: [], unchecked: [] },
        notReproducible: [], refused: [], deferred: [], partial: false, mutated: false,
        engine: { made: spec?.engine ?? null, now, same: !spec?.engine || spec.engine.registry === now.registry },
    };
    if (check.errors.length) return result;

    const specs = new Map(registry.list().map((s) => [s.id, s]));
    const before = snapshot(registry);
    const rounding = spec.expect?.rounding ?? DEFAULT_ROUNDING;
    const calls = spec.calls.map((c) => ({ command: c.command ?? c.id, args: cloneJson(c.args ?? {}) }));
    const made = []; // the artifacts the calls filed, in order (held here: the registry's store drops its oldest past 50)
    let broken = false;
    let aligned = 0;

    for (const [index, call] of calls.entries()) {
        const step = { index, command: call.command, args: call.args, artifacts: [] };
        const s = specs.get(call.command);
        if (!replayAllowed(call.command, call.args)) {
            step.refused = 'a link may not run this command; replay is read-only';
            if (!result.refused.includes(call.command)) result.refused.push(call.command);
        } else if (!s) {
            step.skipped = 'not reproducible here: this app has no such command';
            if (!result.notReproducible.includes(call.command)) result.notReproducible.push(call.command);
        } else if (!s.available) {
            step.deferred = 'needs the canvas: run it on the live view';
            result.deferred.push({ command: call.command, args: call.args });
        } else {
            const seen = new Set(registry.artifacts().map((a) => a.id));
            try {
                step.result = await withTimeout(registry.execute(call.command, call.args), timeoutMs, call.command);
                const fresh = registry.artifacts().filter((a) => !seen.has(a.id));
                step.artifacts = fresh.map((a) => a.id);
                made.push(...fresh);
            } catch (e) {
                step.error = e?.message || String(e);
            }
        }
        if (!step.deferred) {
            if (step.error || step.refused || step.skipped) broken = true;
            else if (!broken) aligned += step.artifacts.length;
        }
        result.steps.push(step);
        onStep(step);
    }
    result.partial = broken;

    for (const art of made) result.artifacts.push({ id: art.id, title: art.title, digest: await artifactDigest(art, { rounding }) });

    const expected = Array.isArray(spec.expect?.artifacts) ? spec.expect.artifacts : [];
    result.artifacts.forEach((a, index) => {
        const want = expected[index];
        const row = { index, id: a.id, title: a.title, actual: a.digest };
        if (index >= aligned || want === undefined) result.drift.unchecked.push(row);
        else if (want === a.digest) result.drift.matched.push({ ...row, expected: want });
        else result.drift.differed.push({ ...row, expected: want });
    });
    for (let index = result.artifacts.length; index < expected.length; index++) {
        const row = { index, id: null, title: null, expected: expected[index], actual: null };
        (broken ? result.drift.unchecked : result.drift.differed).push(row);
    }

    const after = snapshot(registry);
    result.mutated = before !== null && after !== null && before !== after;
    result.ok = !result.partial && !result.mutated;
    return result;
}
