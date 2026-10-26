// petri-commands.js — the editor's command registry.
//
// Every action on a net is a named command with a JSON Schema for its
// arguments: the menus and dialogs, the guided-modelling chat and any MCP
// client call the same commands, and nothing else mutates the model. This is
// pflow-native's ground rule ("every action is a registry command"), and the
// ids and argument names are pflow-native's (crates/core/src/commands), so a
// call an agent learned against one app works against the other.
//
// A registry drives a HOST, which owns the document:
//
//   getModel()            the current, normalized model (read only)
//   commit(next, label)   replace the model with `next` as ONE undo step
//   undo() / redo()       step through history; return whether anything moved
//   fire(tid)?            the token game's firing (optional; the editor's own
//                         updates its run counter and events)
//   resetMarking()?       back to the marking the run started from (optional)
//   fit()?                frame the net (only a host with a view)
//   setMarking(m)?        load a marking ({place: [counts]}) as the token
//                         game's, keeping the run baseline (sim.goto)
//   highlight(nodes, weights, label)? / clearHighlight()?
//                         mark nodes on the canvas (a set, a trace step)
//   capabilities          a Set; commands that need e.g. 'view' say so
//   authToken()?          the signed-in user's GitHub token, or null: the
//                         account-file commands (file.save, file.open, …)
//                         refuse without one
//   fetch(url, init)?     their HTTP client (default globalThis.fetch)
//   apiBase?              their server ('' = same origin; an agent names one)
//
// Commands the JS engines lack (structural analysis, the simulation workbench,
// event-log mining, …) are pflow-native's own, run in its wasm build through
// petri-wasm.js. Their specs are a vendored snapshot
// (vendor/pflow-native-wasm/commands.js), so listing them loads no wasm. A
// native id never shares an id with a JS command: the sync script and the
// Registry constructor both refuse it. Which commands are exposed, and which are
// left out and why, is in scripts/sync-native-wasm.mjs.
//
// createHeadlessHost() is a host with no DOM, for tests and agents; the
// <petri-view> element implements the same interface. No DOM here: deno tests
// this module directly, and the editor loads it with a dynamic import, so a
// vendored copy of petri-view.js without it keeps working without the
// registry.
//
// Data-producing commands store an ARTIFACT, in pflow-native's JSON shape
// (crates/core/src/artifact.rs): {id, title, source: {command, args}, data:
// {kind, ...}}. Views render artifacts by kind and export.artifact writes them
// out, so a result has one format whether a dialog, the chat or an agent
// asked for it.
import * as Sim from './petri-sim.js';
import { NATIVE_COMMANDS } from './vendor/pflow-native-wasm/commands.js';

export class CommandError extends Error {
    constructor(message, code = 'invalid') {
        super(message);
        this.name = 'CommandError';
        this.code = code;
    }
}

const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

// ---------------------------------------------------------------------------
// Argument schemas (the JSON Schema subset the specs use)
// ---------------------------------------------------------------------------

const str = (description) => ({ type: 'string', description });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description });
// A per-color vector, or a bare count for a single-color net.
const counts = (description, nullable = false) => ({
    type: nullable ? ['integer', 'null', 'array'] : ['integer', 'array'], items: { type: nullable ? ['integer', 'null'] : 'integer', minimum: 0 }, minimum: 0, description,
});
const args = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}

function checkValue(schema, v, path) {
    const types = [].concat(schema.type || []);
    if (types.length) {
        const t = typeOf(v);
        const ok = types.includes(t) || (t === 'integer' && types.includes('number'));
        if (!ok) throw new CommandError(`${path}: expected ${types.join(' or ')}, got ${t}`);
    }
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new CommandError(`${path}: must be finite`);
        if (schema.minimum !== undefined && v < schema.minimum) throw new CommandError(`${path}: must be ≥ ${schema.minimum}`);
        if (schema.maximum !== undefined && v > schema.maximum) throw new CommandError(`${path}: must be ≤ ${schema.maximum}`);
    }
    if (schema.enum && !schema.enum.includes(v)) throw new CommandError(`${path}: must be one of ${schema.enum.join(', ')}`);
    if (Array.isArray(v) && schema.items) v.forEach((x, i) => checkValue(schema.items, x, `${path}[${i}]`));
}

/** Check `a` against a command's args schema; unknown arguments are refused by name. */
export function checkArgs(spec, a) {
    if (a === undefined || a === null) a = {};
    if (!isObject(a)) throw new CommandError(`${spec.id}: arguments must be an object`);
    const props = spec.args.properties || {};
    for (const k of Object.keys(a)) {
        if (!own(props, k)) {
            const known = Object.keys(props);
            throw new CommandError(`${spec.id}: unknown argument "${k}"${known.length ? ` (it takes ${known.join(', ')})` : ' (it takes none)'}`);
        }
    }
    for (const k of spec.args.required || []) {
        if (!own(a, k)) throw new CommandError(`${spec.id}: missing argument "${k}"`);
    }
    for (const [k, v] of Object.entries(a)) {
        if (k === 'json') continue; // a whole document; file.load_json checks it with validateNet
        checkValue(props[k], v, `${spec.id}.${k}`);
    }
    return a;
}

// ---------------------------------------------------------------------------
// Helpers over the editor's model
// ---------------------------------------------------------------------------

function emptyNet() {
    return {
        '@context': 'https://pflow.xyz/schema', '@type': 'PetriNet', '@version': '1.1',
        token: ['https://pflow.xyz/tokens/black'], places: {}, transitions: {}, arcs: [],
    };
}

const kindOf = (m, id) => (own(m.places, id) ? 'place' : own(m.transitions, id) ? 'transition' : null);

function needNode(m, id, kind) {
    const k = kindOf(m, id);
    if (!k) throw new CommandError(`"${id}" is not a place or transition`, 'not_found');
    if (kind && k !== kind) throw new CommandError(`"${id}" is a ${k}, not a ${kind}`);
    return k === 'place' ? m.places[id] : m.transitions[id];
}

function checkNewId(m, id) {
    if (typeof id !== 'string' || id.trim() === '' || /\s/.test(id)) throw new CommandError(`"${id}" is not a usable id (non-empty, no spaces)`);
    if (id.length > 100) throw new CommandError('an id is at most 100 characters');
    if (RESERVED_IDS.has(id)) throw new CommandError(`"${id}" cannot be an id`);
    if (kindOf(m, id)) throw new CommandError(`"${id}" is already used`, 'conflict');
}

// p0, p1, … / t0, t1, …: the first free one. Deterministic, so the same calls
// give the same net (and the same CID). REVIEW: the editor's own tools mint
// time-based ids (p + Date.now base 36); commands deliberately do not.
function freshId(m, prefix) {
    for (let i = 0; ; i++) {
        const id = `${prefix}${i}`;
        if (!kindOf(m, id)) return id;
    }
}

function vec(v, colors, fill) {
    const out = Array.isArray(v) ? [...v] : [v];
    while (out.length < colors) out.push(fill);
    return out;
}

function checkLabel(label) {
    if (typeof label !== 'string' || label.trim() === '') throw new CommandError('Label cannot be empty');
    if (label.length > 100) throw new CommandError('Label must be 100 characters or fewer');
    if (/[\r\n]/.test(label)) throw new CommandError('Label must be a single line');
}

function checkWithinCapacity(id, p) {
    for (let i = 0; i < p.initial.length; i++) {
        const cap = p.capacity[i];
        if (Number.isFinite(cap) && cap > 0 && p.initial[i] > cap) {
            throw new CommandError(`places.${id}: ${p.initial[i]} tokens exceed capacity ${cap}`);
        }
    }
}

const colorsOf = (m) => Math.max(1, (m.token || []).length);

// ---------------------------------------------------------------------------
// Behaviour checks (sim's pkg/builder/checks.go, in JS on the editor's own
// firing rule): one bounded exploration of the reachable markings. A bound
// hit makes the claims that need the whole space ("never fires", "never
// marked") unavailable rather than guessed; only what a partial search can
// still prove is kept (a deadlock found, a place past the token bound).
// ---------------------------------------------------------------------------

const keyOf = (marks) => JSON.stringify(Object.keys(marks).sort().map((k) => marks[k]));

export function exploreBehaviour(m, { maxStates = 2000, unboundedTokens = 1000 } = {}) {
    const start = Sim.marking(m);
    const seen = new Map([[keyOf(start), { marks: start, parent: null, via: null }]]);
    const queue = [keyOf(start)];
    const fired = new Set();
    const marked = new Set(Object.keys(start).filter((p) => start[p].some((x) => x > 0)));
    let deadlock = null, unbounded = null, exhaustive = true;
    while (queue.length) {
        const k = queue.shift();
        const { marks } = seen.get(k);
        const en = Sim.enabledTransitions(m, marks);
        if (!en.length && !deadlock) deadlock = k;
        for (const t of en) {
            const next = Sim.fire(m, t, marks);
            if (!next) continue;
            fired.add(t);
            for (const [p, v] of Object.entries(next)) {
                if (v.some((x) => x > 0)) marked.add(p);
                if (!unbounded && v.some((x) => x > unboundedTokens)) unbounded = p;
            }
            const nk = keyOf(next);
            if (seen.has(nk)) continue;
            if (seen.size >= maxStates) { exhaustive = false; continue; }
            seen.set(nk, { marks: next, parent: k, via: t });
            queue.push(nk);
        }
        if (unbounded) { exhaustive = false; break; }
    }
    const trace = (k) => {
        const steps = [];
        for (let cur = k; cur; cur = seen.get(cur).parent) steps.unshift({ transition: seen.get(cur).via || '', marking: seen.get(cur).marks });
        return steps;
    };
    return { states: seen.size, exhaustive, fired, marked, deadlock: deadlock ? trace(deadlock) : null, unbounded };
}

function components(m) {
    const ids = [...Object.keys(m.places), ...Object.keys(m.transitions)];
    const adj = new Map(ids.map((id) => [id, new Set()]));
    for (const a of m.arcs) { adj.get(a.source)?.add(a.target); adj.get(a.target)?.add(a.source); }
    const seen = new Set(), parts = [];
    for (const id of ids) {
        if (seen.has(id)) continue;
        const part = [], stack = [id];
        seen.add(id);
        while (stack.length) {
            const x = stack.pop();
            part.push(x);
            for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); stack.push(y); }
        }
        parts.push(part);
    }
    return parts;
}

/** Whether the weighted place sum y is conserved by every transition (yᵀC = 0). */
export function conserves(m, y) {
    for (const p of Object.keys(y)) if (!own(m.places, p)) return false;
    for (const t of Object.keys(m.transitions)) {
        let d = 0;
        for (const a of m.arcs) {
            if (a.inhibitTransition) continue; // inhibitor and read arcs move nothing
            const w = getWeightSum(a);
            if (a.target === t && own(y, a.source)) d -= y[a.source] * w;
            if (a.source === t && own(y, a.target)) d += y[a.target] * w;
        }
        if (Math.abs(d) > 1e-9) return false;
    }
    return true;
}
const getWeightSum = (a) => Sim.getArcWeight(a).reduce((x, y) => x + y, 0);

// ---------------------------------------------------------------------------
// ODE helpers (petri-solver.js is loaded on first use)
// ---------------------------------------------------------------------------

let solverModule = null;
async function solver() {
    solverModule ||= await import('./petri-solver.js');
    return solverModule;
}

// ---------------------------------------------------------------------------
// Stochastic engines (petri-ssa.js, petri-sde.js: byte-exact with go-pflow's
// portable SSA, and so with pflow-native's sim.ssa on the same seed)
// ---------------------------------------------------------------------------

/**
 * What would make the ODE (and the SDE) misread this net: the four firing-
 * instant constraints of docs/engine-selection.md, Rule 1 (guards aside: the
 * editor format has none). Returns plain-language reasons.
 */
export function gatingReasons(m) {
    const reasons = [];
    const reads = m.arcs.filter((a) => a.inhibitTransition && own(m.transitions, a.source));
    const inhib = m.arcs.filter((a) => a.inhibitTransition && own(m.places, a.source));
    if (inhib.length) reasons.push(`inhibitor arc(s) ${inhib.map((a) => `${a.source} → ${a.target}`).join(', ')}`);
    if (reads.length) reasons.push(`read arc(s) ${reads.map((a) => `${a.source} → ${a.target}`).join(', ')}`);
    const capped = Object.entries(m.places).filter(([, p]) => p.capacity.some((c) => Number.isFinite(c) && c > 0)).map(([id]) => id);
    if (capped.length) reasons.push(`capacity on ${capped.join(', ')}`);
    return reasons;
}

function stochasticSeries(out, places, x) {
    return places.map((p) => {
        const s = out.series[p];
        const entry = { name: p, values: s ? s.values : x.map(() => 0) };
        if (s && s.stddev) entry.band = s.stddev;
        return entry;
    });
}

const stochasticArgs = {
    t_end: num('end time (default 10, ≤ 10000)', { minimum: 1e-9, maximum: 10000 }),
    seed: int('RNG seed (default 1); realization r uses seed + r', { minimum: 0 }),
    runs: int('realizations averaged (default 1, ≤ 200)', { minimum: 1, maximum: 200 }),
    points: int('sample points from 0 to t_end (default 101, 2..5000)', { minimum: 2, maximum: 5000 }),
    places: strList('places to keep (default: all)'),
};

const odeOptions = {
    method: str('tsit5 (the only method in the browser; pflow-native also has rk45, rk4, euler, heun, midpoint, bs32)'),
    dt: num('initial step (default 0.01)', { minimum: 1e-12 }),
    abstol: num('absolute tolerance (default 1e-6)', { minimum: 1e-15 }),
    reltol: num('relative tolerance (default 1e-3)', { minimum: 1e-15 }),
    dtmax: num('largest step (default: unbounded)', { minimum: 1e-12 }),
};

async function solveODE(model, rates, tEnd, a) {
    if (a.method !== undefined && a.method.toLowerCase() !== 'tsit5') {
        throw new CommandError(`method "${a.method}": the browser solver has only tsit5`, 'unsupported');
    }
    const m = await solver();
    const net = m.fromJSON(model);
    const initialState = m.setState(net);
    const prob = new m.ODEProblem(net, initialState, [0, tEnd], m.setRates(net, rates));
    const opts = { dt: a.dt ?? 0.01, abstol: a.abstol ?? 1e-6, reltol: a.reltol ?? 1e-3, adaptive: true };
    if (a.dtmax !== undefined) opts.dtmax = a.dtmax;
    const sol = m.solve(prob, m.Tsit5(), opts);
    return { net, sol, initial: initialState };
}

// Keep at most `limit` of the solver's own steps, always the first and last.
function downsampleIdx(n, limit) {
    if (n <= limit) return [...Array(n).keys()];
    const idx = [];
    const stride = (n - 1) / (limit - 1);
    for (let i = 0; i < limit; i++) idx.push(Math.round(i * stride));
    return idx;
}

// Linear interpolation of (ts, ys) onto grid.
function resample(ts, ys, grid) {
    const out = [];
    let j = 0;
    for (const g of grid) {
        while (j < ts.length - 2 && ts[j + 1] < g) j++;
        const t0 = ts[j], t1 = ts[Math.min(j + 1, ts.length - 1)];
        const y0 = ys[j], y1 = ys[Math.min(j + 1, ys.length - 1)];
        out.push(t1 === t0 ? y0 : y0 + (y1 - y0) * (g - t0) / (t1 - t0));
    }
    return out;
}

function placesArg(model, places) {
    const all = Object.keys(model.places || {});
    if (places === undefined) return all;
    for (const p of places) if (!own(model.places, p)) throw new CommandError(`"${p}" is not a place`, 'not_found');
    return places;
}

// Replace the document with `doc` as one undo step, after the strict check
// (file.load_json, file.open): refused on errors unless repair.
async function loadNet(c, doc, repair, label) {
    const { validateNet, formatIssue } = await import('./petri-validate.js');
    const report = validateNet(doc);
    if (!report.ok && !repair) {
        throw new CommandError(`the net has ${report.errors.length} error(s): ${report.errors.slice(0, 5).map(formatIssue).join('; ')}${report.errors.length > 5 ? '; …' : ''}`, 'invalid_net');
    }
    c.host.commit(Sim.normalizeModel(structuredClone(doc)), label);
    return { errors: report.errors, warnings: report.warnings };
}

// ---------------------------------------------------------------------------
// Account files: pflow-native's file-system writes, the web way
// ---------------------------------------------------------------------------
//
// pflow-native writes the user's disk: file.save and file.open take a path,
// and export.* writes one when given. A page has no disk (and this one asks
// for no File System Access), so the same verbs work on the signed-in user's
// own files on the server instead: /api/files (cmd/webserver/files.go,
// docs/account-files.md). A name stands in for the path, and replacing a file
// you have needs overwrite: true, as pflow-native's model.save. The host
// supplies the sign-in; without a token every one of these refuses with
// SIGN_IN_TO_SAVE and sends nothing.

/** Extensions an account file may have (internal/userfiles Kinds). */
export const ACCOUNT_FILE_EXTENSIONS = ['.csv', '.json', '.jsonl', '.jsonld', '.png', '.svg', '.txt'];
const NET_EXTENSIONS = ['.json', '.jsonld'];
const ACCOUNT_MIME = {
    '.json': 'application/json', '.jsonld': 'application/ld+json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.csv': 'text/csv', '.jsonl': 'application/jsonl', '.txt': 'text/plain',
};
export const SIGN_IN_TO_SAVE = 'Sign in to save: your files are kept in your pflow.xyz account, and you are not signed in (sign in with GitHub)';
const ACCOUNT_ERRORS = {
    400: 'invalid', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 405: 'unsupported',
    409: 'conflict', 413: 'too_large', 503: 'unavailable', 507: 'quota',
};

/**
 * Check a file name as the server does (letters, digits, '.', '_', '-', at
 * most 100, a known extension) and return its lower-cased extension.
 */
export function checkAccountName(name, exts = ACCOUNT_FILE_EXTENSIONS) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 100) throw new CommandError('name: 1 to 100 characters');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
        throw new CommandError(`name "${name}": use letters, digits, '.', '_' and '-', starting with a letter or digit`);
    }
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
    if (!exts.includes(ext)) throw new CommandError(`name "${name}": the extension must be one of ${exts.join(' ')}`);
    return ext;
}

// A net's file name: .json is added when the name has no extension.
function netFileName(name) {
    const n = typeof name === 'string' && !name.includes('.') ? `${name}.json` : name;
    checkAccountName(n, NET_EXTENSIONS);
    return n;
}

/** One /api/files request with the host's sign-in. Throws a CommandError for any refusal. */
async function accountFetch(host, method, name = '', opts = {}) {
    const token = typeof host.authToken === 'function' ? host.authToken() : null;
    if (!token) throw new CommandError(SIGN_IN_TO_SAVE, 'unauthenticated');
    const url = `${host.apiBase || ''}/api/files${name ? `/${name}` : ''}${opts.overwrite ? '?overwrite=true' : ''}`;
    const headers = { Authorization: `Bearer ${token}` };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    const init = { method, headers, ...(opts.body !== undefined ? { body: opts.body } : {}) };
    // Called unbound: a browser's fetch refuses to run with a host as `this`.
    const fetchFn = host.fetch || globalThis.fetch;
    let res;
    try {
        res = await fetchFn(url, init);
    } catch (e) {
        throw new CommandError(`cannot reach the server for your files: ${e?.message || e}`, 'unavailable');
    }
    if (!res.ok) {
        let msg = '';
        try { msg = (await res.json()).error || ''; } catch { /* not JSON (a proxy's error page) */ }
        if (res.status === 401) msg = msg || SIGN_IN_TO_SAVE;
        throw new CommandError(msg || `the server answered ${res.status}`, ACCOUNT_ERRORS[res.status] || 'failed');
    }
    return res;
}

async function accountSave(host, name, body, overwrite, contentType) {
    const res = await accountFetch(host, 'PUT', name, { body, overwrite: !!overwrite, contentType });
    return res.json();
}

function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function linspace(from, to, steps) {
    if (steps === 1) return [from];
    return Array.from({ length: steps }, (_, i) => from + (to - from) * i / (steps - 1));
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} CommandSpec
 * @property {string} id         namespace.verb, as in pflow-native
 * @property {string} label
 * @property {string} help
 * @property {Object} args       JSON Schema for the arguments
 * @property {boolean} journal   recorded in the journal (document edits and runs);
 *                               queries and view commands are not
 * @property {string[]} [requires] host capabilities it needs
 * @property {(ctx: Context, args: Object) => any} run
 */

/** @type {CommandSpec[]} */
export const COMMANDS = [
    // ---- file ----
    {
        id: 'file.new', label: 'New', help: 'Replace the document with an empty net.',
        args: args(), journal: true,
        run: (c) => { c.host.commit(emptyNet(), 'new net'); return {}; },
    },
    {
        id: 'file.load_json', label: 'Load JSON',
        help: 'Replace the document with a pflow.xyz JSON-LD net. Refused when the strict check (analysis.validate) finds errors, unless repair is true, which loads it the way the editor always has (defaults filled, bad values coerced, over-capacity markings clamped).',
        args: args({ json: { type: ['object', 'string'], description: 'the net, as an object or a JSON string' }, repair: bool('load even if the check finds errors (default false)') }, ['json']),
        journal: true,
        run: async (c, a) => {
            let doc = a.json;
            if (typeof doc === 'string') {
                try { doc = JSON.parse(doc); } catch (e) { throw new CommandError(`json: not JSON (${e.message})`); }
            }
            return loadNet(c, doc, a.repair, 'load JSON');
        },
    },
    {
        id: 'file.export_json', label: 'Export JSON', help: 'The document as pflow.xyz JSON-LD (unbounded capacities as null).',
        args: args(), journal: false,
        run: (c) => ({ json: JSON.parse(JSON.stringify(c.model())) }),
    },
    {
        id: 'file.cid', label: 'Compute CID', help: 'The CID the document seals to (the same as /api/save and pflow-native file.cid).',
        args: args(), journal: false,
        run: async (c) => {
            const { computeCid } = await import('./seal-cid.mjs');
            return { cid: await computeCid(JSON.parse(JSON.stringify(c.model()))) };
        },
    },

    // ---- account files (pflow-native's file-system writes, saved to your account) ----
    {
        id: 'file.save', label: 'Save to my account',
        help: 'Save the document as pflow.xyz JSON-LD under `name` in your pflow.xyz account (needs you signed in). pflow-native\'s file.save writes a path on disk; the page saves over HTTPS to your own files instead. A name you already have is refused unless overwrite is true. A name without an extension gets .json.',
        args: args({ name: str('file name in your account, e.g. sir.json (.json or .jsonld)'), overwrite: bool('replace your file of that name (default false)') }, ['name']),
        journal: false,
        run: (c, a) => {
            const name = netFileName(a.name);
            const body = JSON.stringify(JSON.parse(JSON.stringify(c.model())), null, 2) + '\n';
            return accountSave(c.host, name, body, a.overwrite, ACCOUNT_MIME[checkAccountName(name)]);
        },
    },
    {
        id: 'file.open', label: 'Open from my account',
        help: 'Replace the document with a net saved in your account (needs you signed in); pflow-native\'s file.open reads a path. Checked as file.load_json checks: refused when the strict check finds errors, unless repair is true.',
        args: args({ name: str('a .json or .jsonld file in your account (see file.list)'), repair: bool('load even if the check finds errors (default false)') }, ['name']),
        journal: true,
        run: async (c, a) => {
            checkAccountName(a.name, NET_EXTENSIONS);
            const text = await (await accountFetch(c.host, 'GET', a.name)).text();
            let doc;
            try { doc = JSON.parse(text); } catch (e) { throw new CommandError(`${a.name}: not JSON (${e.message})`); }
            return { name: a.name, ...(await loadNet(c, doc, a.repair, `open ${a.name}`)) };
        },
    },
    {
        id: 'file.list', label: 'My files',
        help: 'The files in your account (needs you signed in): name, size, modified and kind of each, with your usage and the limits.',
        args: args(), journal: false,
        run: async (c) => (await accountFetch(c.host, 'GET')).json(),
    },
    {
        id: 'file.get', label: 'Read a file',
        help: 'One file from your account (needs you signed in): text as `content`, a PNG as `content_base64`. Pass a CSV or JSONL log on to data.load_log as its text.',
        args: args({ name: str('file name in your account') }, ['name']),
        journal: false,
        run: async (c, a) => {
            const ext = checkAccountName(a.name);
            const res = await accountFetch(c.host, 'GET', a.name);
            const mime = ACCOUNT_MIME[ext];
            if (ext === '.png') {
                const bytes = new Uint8Array(await res.arrayBuffer());
                return { name: a.name, mime, size: bytes.length, content_base64: base64(bytes) };
            }
            const content = await res.text();
            return { name: a.name, mime, size: new TextEncoder().encode(content).length, content };
        },
    },
    {
        id: 'file.write', label: 'Write a file',
        help: 'Write text to `name` in your account (needs you signed in): an export.svg result as .svg, a table as .csv, a log as .jsonl. pflow-native\'s export commands write a `path`; this is the page\'s way. A name you already have is refused unless overwrite is true, and the server checks the text matches the extension.',
        args: args({
            name: str('file name with its extension: .svg, .csv, .json, .jsonld, .jsonl or .txt'),
            content: str('the text to write'),
            overwrite: bool('replace your file of that name (default false)'),
        }, ['name', 'content']),
        journal: false,
        run: (c, a) => {
            const ext = checkAccountName(a.name);
            if (ext === '.png') throw new CommandError('file.write writes text, and the page renders no PNG (pflow-native\'s export.png does)', 'unsupported');
            return accountSave(c.host, a.name, a.content, a.overwrite, ACCOUNT_MIME[ext]);
        },
    },
    {
        id: 'file.delete', label: 'Delete a file',
        help: 'Delete one file from your account (needs you signed in).',
        args: args({ name: str('file name in your account') }, ['name']),
        journal: false,
        run: async (c, a) => {
            checkAccountName(a.name);
            return (await accountFetch(c.host, 'DELETE', a.name)).json();
        },
    },

    // ---- edit ----
    {
        id: 'edit.undo', label: 'Undo', help: 'Undo the last edit.', args: args(), journal: true,
        run: (c) => ({ changed: !!c.host.undo() }),
    },
    {
        id: 'edit.redo', label: 'Redo', help: 'Redo the last undone edit.', args: args(), journal: true,
        run: (c) => ({ changed: !!c.host.redo() }),
    },
    {
        id: 'edit.delete', label: 'Delete', help: 'Delete places and transitions, with every arc that touches them.',
        args: args({ ids: strList('node ids') }, ['ids']), journal: true,
        run: (c, a) => {
            c.edit(`delete ${a.ids.join(', ')}`, (m) => {
                for (const id of a.ids) needNode(m, id);
                const gone = new Set(a.ids);
                for (const id of gone) { delete m.places[id]; delete m.transitions[id]; }
                m.arcs = m.arcs.filter((x) => !gone.has(x.source) && !gone.has(x.target));
            });
            return { deleted: a.ids };
        },
    },

    // ---- net ----
    {
        id: 'net.info', label: 'Net info', help: 'Counts, ids, labels and rates: a summary of the net.',
        args: args(), journal: false,
        run: (c) => {
            const m = c.model();
            return {
                name: m.name || null,
                description: m.description || null,
                colors: colorsOf(m),
                places: Object.entries(m.places).map(([id, p]) => ({ id, label: p.label || null, initial: p.initial, capacity: p.capacity.map((x) => (Number.isFinite(x) ? x : null)) })),
                transitions: Object.entries(m.transitions).map(([id, t]) => ({ id, label: t.label || null, rate: Sim.rateOf(m, id) })),
                arcs: m.arcs.map((x) => ({ source: x.source, target: x.target, weight: x.weight, inhibit: !!x.inhibitTransition })),
            };
        },
    },
    {
        id: 'net.add_place', label: 'Add place', help: 'Add a place at (x, y).',
        args: args({
            x: num('x'), y: num('y'), id: str('id (default: the first free p0, p1, …)'), label: str('label'),
            initial: counts('initial tokens (default 0)'), capacity: counts('capacity; 0 or null = unbounded (default)', true),
        }, ['x', 'y']),
        journal: true,
        run: (c, a) => {
            let id;
            c.edit('add place', (m) => {
                id = a.id ?? freshId(m, 'p');
                checkNewId(m, id);
                if (a.label !== undefined) checkLabel(a.label);
                const n = colorsOf(m);
                const p = { '@type': 'Place', x: Math.round(a.x), y: Math.round(a.y), offset: 0,
                    initial: vec(a.initial ?? 0, n, 0), capacity: vec(a.capacity ?? null, n, null).map((v) => (v === null || v === 0 ? Infinity : v)) };
                if (a.label !== undefined) p.label = a.label;
                checkWithinCapacity(id, p);
                m.places[id] = p;
            });
            return { id };
        },
    },
    {
        id: 'net.add_transition', label: 'Add transition', help: 'Add a transition at (x, y).',
        args: args({ x: num('x'), y: num('y'), id: str('id (default: the first free t0, t1, …)'), label: str('label'), rate: num('rate (default 1.0)', { minimum: 0 }) }, ['x', 'y']),
        journal: true,
        run: (c, a) => {
            let id;
            c.edit('add transition', (m) => {
                id = a.id ?? freshId(m, 't');
                checkNewId(m, id);
                if (a.label !== undefined) checkLabel(a.label);
                const t = { '@type': 'Transition', x: Math.round(a.x), y: Math.round(a.y) };
                if (a.label !== undefined) t.label = a.label;
                if (a.rate !== undefined && a.rate !== 1.0) t.rate = a.rate;
                m.transitions[id] = t;
            });
            return { id };
        },
    },
    {
        id: 'net.add_arc', label: 'Add arc',
        help: 'Add an arc between a place and a transition. inhibit on place→transition is an inhibitor arc; on transition→place it is a read arc (the editor\'s output-side inhibit).',
        args: args({ source: str('source id'), target: str('target id'), weight: counts('weight (default 1)'), inhibit: bool('inhibitor / read arc (default false)') }, ['source', 'target']),
        journal: true,
        run: (c, a) => {
            c.edit(`add arc ${a.source} → ${a.target}`, (m) => {
                const s = kindOf(m, a.source), t = kindOf(m, a.target);
                needNode(m, a.source); needNode(m, a.target);
                if (s === t) throw new CommandError(`an arc joins a place and a transition; ${a.source} and ${a.target} are both ${s}s`);
                const inhibit = !!a.inhibit;
                if (m.arcs.some((x) => x.source === a.source && x.target === a.target && !!x.inhibitTransition === inhibit)) {
                    throw new CommandError(`there is already an arc ${a.source} → ${a.target}; use net.set_arc`, 'conflict');
                }
                const weight = vec(a.weight ?? 1, colorsOf(m), 0);
                m.arcs.push({ '@type': 'Arrow', source: a.source, target: a.target, weight, inhibitTransition: inhibit });
            });
            return {};
        },
    },
    {
        id: 'net.set_arc', label: 'Set arc', help: 'Change an arc\'s weight or whether it inhibits.',
        args: args({ source: str('source id'), target: str('target id'), weight: counts('weight'), inhibit: bool('inhibitor / read arc') }, ['source', 'target']),
        journal: true,
        run: (c, a) => {
            c.edit(`set arc ${a.source} → ${a.target}`, (m) => {
                const arc = m.arcs.find((x) => x.source === a.source && x.target === a.target);
                if (!arc) throw new CommandError(`no arc ${a.source} → ${a.target}`, 'not_found');
                if (a.weight !== undefined) arc.weight = vec(a.weight, colorsOf(m), 0);
                if (a.inhibit !== undefined) arc.inhibitTransition = a.inhibit;
            });
            return {};
        },
    },
    {
        id: 'net.delete_arc', label: 'Delete arc', help: 'Delete the arc(s) from source to target.',
        args: args({ source: str('source id'), target: str('target id') }, ['source', 'target']), journal: true,
        run: (c, a) => {
            c.edit(`delete arc ${a.source} → ${a.target}`, (m) => {
                const before = m.arcs.length;
                m.arcs = m.arcs.filter((x) => !(x.source === a.source && x.target === a.target));
                if (m.arcs.length === before) throw new CommandError(`no arc ${a.source} → ${a.target}`, 'not_found');
            });
            return {};
        },
    },
    {
        id: 'net.set_place', label: 'Set place', help: 'Set a place\'s initial marking and/or capacity (0 or null = unbounded). An initial marking over capacity is refused, not clamped.',
        args: args({ id: str('place id'), initial: counts('initial tokens'), capacity: counts('capacity; 0 or null = unbounded', true) }, ['id']),
        journal: true,
        run: (c, a) => {
            c.edit(`set place ${a.id}`, (m) => {
                const p = needNode(m, a.id, 'place');
                const n = colorsOf(m);
                if (a.initial !== undefined) p.initial = vec(a.initial, n, 0);
                if (a.capacity !== undefined) p.capacity = vec(a.capacity, n, null).map((v) => (v === null || v === 0 ? Infinity : v));
                checkWithinCapacity(a.id, p);
            });
            return {};
        },
    },
    {
        id: 'net.set_label', label: 'Set label', help: 'Set a node\'s label (≤ 100 characters, one line).',
        args: args({ id: str('node id'), label: str('new label') }, ['id', 'label']), journal: true,
        run: (c, a) => {
            checkLabel(a.label);
            c.edit(`label ${a.id}`, (m) => { needNode(m, a.id).label = a.label; });
            return {};
        },
    },
    {
        id: 'net.add_tokens', label: 'Add tokens', help: 'Add (or with a negative delta, remove) tokens of one color. Refused below zero or over capacity.',
        args: args({ id: str('place id'), delta: int('tokens to add (default 1)'), color: int('color index (default 0)', { minimum: 0 }) }, ['id']),
        journal: true,
        run: (c, a) => {
            let now;
            c.edit(`tokens ${a.id}`, (m) => {
                const p = needNode(m, a.id, 'place');
                const i = a.color ?? 0;
                if (i >= colorsOf(m) && i >= p.initial.length) throw new CommandError(`color ${i}: the net has ${colorsOf(m)} color(s)`);
                while (p.initial.length <= i) p.initial.push(0);
                const next = p.initial[i] + (a.delta ?? 1);
                if (next < 0) throw new CommandError(`${a.id} has ${p.initial[i]} token(s); cannot remove ${-(a.delta ?? 1)}`);
                p.initial[i] = next;
                checkWithinCapacity(a.id, p);
                now = [...p.initial];
            });
            return { initial: now };
        },
    },
    {
        id: 'net.move', label: 'Move node', help: 'Move a node to (x, y).',
        args: args({ id: str('node id'), x: num('x'), y: num('y') }, ['id', 'x', 'y']), journal: true,
        run: (c, a) => {
            c.edit(`move ${a.id}`, (m) => { const n = needNode(m, a.id); n.x = Math.round(a.x); n.y = Math.round(a.y); });
            return {};
        },
    },
    {
        id: 'net.rename', label: 'Rename node', help: 'Change a node\'s id, updating every arc.',
        args: args({ id: str('current id'), new_id: str('new id') }, ['id', 'new_id']), journal: true,
        run: (c, a) => {
            c.edit(`rename ${a.id} → ${a.new_id}`, (m) => {
                const k = kindOf(m, a.id);
                needNode(m, a.id);
                checkNewId(m, a.new_id);
                const coll = k === 'place' ? m.places : m.transitions;
                // Rebuild to keep insertion order (and so the document's bytes) stable.
                const next = {};
                for (const [id, n] of Object.entries(coll)) next[id === a.id ? a.new_id : id] = n;
                if (k === 'place') m.places = next; else m.transitions = next;
                for (const x of m.arcs) {
                    if (x.source === a.id) x.source = a.new_id;
                    if (x.target === a.id) x.target = a.new_id;
                }
            });
            return { id: a.new_id };
        },
    },
    {
        id: 'net.set_details', label: 'Edit details', help: 'Set the net\'s name and description (an empty string removes one).',
        args: args({ name: str('diagram name'), description: str('description') }), journal: true,
        run: (c, a) => {
            c.edit('edit details', (m) => {
                for (const k of ['name', 'description']) {
                    if (a[k] === undefined) continue;
                    if (a[k].trim() === '') delete m[k]; else m[k] = a[k].trim();
                }
            });
            return {};
        },
    },

    // ---- sim ----
    {
        id: 'sim.enabled', label: 'Enabled transitions', help: 'The transitions enabled at the current marking.',
        args: args(), journal: false,
        run: (c) => ({ enabled: Sim.enabledTransitions(c.model()) }),
    },
    {
        id: 'sim.marking', label: 'Marking', help: 'The current marking, per place, per color.',
        args: args(), journal: false,
        run: (c) => ({ marking: Sim.marking(c.model()) }),
    },
    {
        id: 'sim.fire', label: 'Fire', help: 'Fire one transition (the token game). Refused when it is not enabled.',
        args: args({ id: str('transition id') }, ['id']), journal: true,
        run: (c, a) => {
            const m = c.model();
            needNode(m, a.id, 'transition');
            if (!Sim.enabled(m, a.id, Sim.marking(m))) {
                const en = Sim.enabledTransitions(m);
                throw new CommandError(`${a.id} is not enabled (enabled: ${en.length ? en.join(', ') : 'none'})`, 'not_enabled');
            }
            if (c.host.fire) {
                if (!c.host.fire(a.id)) throw new CommandError(`${a.id} did not fire`, 'not_enabled');
            } else {
                c.edit(`fire ${a.id}`, (d) => {
                    const next = Sim.fire(d, a.id, Sim.marking(d));
                    for (const [pid, v] of Object.entries(next)) d.places[pid].initial = [...v];
                });
            }
            return { marking: Sim.marking(c.model()), enabled: Sim.enabledTransitions(c.model()) };
        },
    },
    {
        id: 'sim.reset', label: 'Reset marking', help: 'Back to the marking the run started from.',
        args: args(), journal: true,
        run: (c) => {
            if (!c.host.resetMarking) throw new CommandError('this host keeps no run baseline', 'unsupported');
            c.host.resetMarking();
            return { marking: Sim.marking(c.model()) };
        },
    },
    {
        id: 'sim.set_rate', label: 'Set rate', help: 'Set a transition\'s rate (≥ 0; 0 disables it in the ODE). Rates are part of the document.',
        args: args({ id: str('transition id'), rate: num('rate ≥ 0', { minimum: 0 }) }, ['id', 'rate']), journal: true,
        run: (c, a) => {
            c.edit(`rate ${a.id} = ${a.rate}`, (m) => {
                needNode(m, a.id, 'transition');
                Sim.setTransitionRates(m, { [a.id]: a.rate });
            });
            return {};
        },
    },
    {
        id: 'sim.ode', label: 'Run ODE',
        help: 'Integrate the mass-action ODE from the current marking (Tsit5, the document\'s rates) and store a time-series artifact. The result carries initial, final and delta per place.',
        args: args({
            t_end: num('end time (default 10)', { minimum: 1e-9 }),
            points: int('max points stored (default 200)', { minimum: 2, maximum: 100000 }),
            places: strList('places to keep (default: all)'),
            ...odeOptions,
        }),
        journal: true,
        run: async (c, a) => {
            const m = c.model();
            const tEnd = a.t_end ?? 10;
            const places = placesArg(m, a.places);
            const rates = Sim.transitionRates(m);
            const { sol, initial } = await solveODE(m, rates, tEnd, a);
            const keep = downsampleIdx(sol.t.length, a.points ?? 200);
            const final = sol.getFinalState();
            const summary = {};
            for (const p of Object.keys(final)) {
                summary[p] = { initial: initial[p] ?? 0, final: final[p], delta: final[p] - (initial[p] ?? 0) };
            }
            const art = c.store(`ODE to t=${tEnd}`, {
                kind: 'timeseries', x_label: 'time', x: keep.map((i) => sol.t[i]),
                series: places.map((p) => { const y = sol.getVariable(p); return { name: p, values: keep.map((i) => y[i]) }; }),
            }, { rates, t_end: tEnd, method: 'tsit5', dt: a.dt ?? 0.01, abstol: a.abstol ?? 1e-6, reltol: a.reltol ?? 1e-3, summary });
            return { artifact: art.id, initial: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.initial])),
                final: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.final])),
                delta: Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.delta])) };
        },
    },
    {
        id: 'opt.rate_scan', label: 'Rate scan',
        help: 'Sweep one transition\'s rate and record each place\'s value at t_end (the editor\'s steady-state reading, not a detected equilibrium). Stores a time-series artifact whose x axis is the rate.',
        args: args({
            transition: str('transition whose rate is scanned'), from: num('first rate', { minimum: 0 }), to: num('last rate', { minimum: 0 }),
            steps: int('rates tried (default 9, at most 25)', { minimum: 1, maximum: 25 }), t_end: num('end time of each run (default 50)', { minimum: 1e-9 }),
            places: strList('places to record (default: all)'), ...odeOptions,
        }, ['transition', 'from', 'to']),
        journal: true,
        run: async (c, a) => {
            const m = c.model();
            needNode(m, a.transition, 'transition');
            const places = placesArg(m, a.places);
            const values = linspace(a.from, a.to, a.steps ?? 9);
            const tEnd = a.t_end ?? 50;
            const base = Sim.transitionRates(m);
            const finals = [];
            for (const v of values) {
                const { sol } = await solveODE(m, { ...base, [a.transition]: v }, tEnd, a);
                finals.push(sol.getFinalState());
            }
            const art = c.store(`Value at t=${tEnd} vs rate(${a.transition})`, {
                kind: 'timeseries', x_label: `rate(${a.transition})`, x: values,
                series: places.map((p) => ({ name: p, values: finals.map((f) => f[p] ?? 0) })),
            }, { transition: a.transition, t_end: tEnd, rates: base });
            return { artifact: art.id, rates: values, final: finals };
        },
    },
    {
        id: 'opt.sweep', label: 'Sweep',
        help: 'One place\'s trajectory for each of several rates of one transition, resampled onto one time grid. Stores a time-series artifact with one series per rate (group k=<rate>).',
        args: args({
            transition: str('transition whose rate is swept'), place: str('place observed'),
            from: num('first rate', { minimum: 0 }), to: num('last rate', { minimum: 0 }),
            steps: int('rates tried (default 9, at most 25)', { minimum: 1, maximum: 25 }), t_end: num('end time (default 10)', { minimum: 1e-9 }),
            points: int('grid points (default 200)', { minimum: 2, maximum: 10000 }), ...odeOptions,
        }, ['transition', 'place', 'from', 'to']),
        journal: true,
        run: async (c, a) => {
            const m = c.model();
            needNode(m, a.transition, 'transition');
            placesArg(m, [a.place]);
            const values = linspace(a.from, a.to, a.steps ?? 9);
            const tEnd = a.t_end ?? 10;
            const grid = linspace(0, tEnd, a.points ?? 200);
            const base = Sim.transitionRates(m);
            const series = [];
            const finals = [];
            for (const v of values) {
                const { sol } = await solveODE(m, { ...base, [a.transition]: v }, tEnd, a);
                const y = sol.getVariable(a.place);
                const group = `k=${+v.toPrecision(3)}`;
                series.push({ name: a.place, values: resample(sol.t, y, grid), group });
                finals.push({ rate: v, final: y[y.length - 1] });
            }
            const art = c.store(`${a.place} across rate(${a.transition})`, { kind: 'timeseries', x_label: 'time', x: grid, series },
                { transition: a.transition, place: a.place, t_end: tEnd, rates: base, finals });
            return { artifact: art.id, finals };
        },
    },

    {
        id: 'sim.ssa', label: 'Run SSA',
        help: 'Gillespie stochastic simulation from the current marking with the document\'s rates (petri-ssa.js: go-pflow\'s portable SSA, byte-exact with pflow-native\'s sim.ssa on the same seed). runs > 1 averages realizations and stores the mean with a ±1 sd band. Exact for small token counts and for nets the ODE cannot read (inhibitor or read arcs, capacities).',
        args: args(stochasticArgs), journal: true,
        run: async (c, a) => {
            const m = c.model();
            const places = placesArg(m, a.places);
            const ssa = await import('./petri-ssa.js');
            const opts = { horizon: a.t_end ?? 10, samples: a.points ?? 101, realizations: a.runs ?? 1, seed: a.seed ?? 1 };
            const out = ssa.simulate(JSON.parse(JSON.stringify(m)), opts);
            const art = c.store(`SSA to t=${opts.horizon} (${opts.realizations} run${opts.realizations === 1 ? '' : 's'}, seed ${opts.seed})`, {
                kind: 'timeseries', x_label: 'time', x: out.times, series: stochasticSeries(out, places, out.times),
            }, { engine: 'ssa', ...opts, rates: Sim.transitionRates(m) });
            return { artifact: art.id, final: out.final, seed: opts.seed, runs: opts.realizations };
        },
    },
    {
        id: 'sim.sde', label: 'Run SDE',
        help: 'Chemical Langevin SDE (petri-sde.js) from the current marking: continuous with intrinsic noise, cheap at large populations. Same output shape as sim.ssa. Refuses nets with inhibitor or read arcs or reachable capacities, which a diffusion cannot express (use sim.ssa).',
        args: args({ ...stochasticArgs, dt: num('integration step (default: (t_end / (points-1)) / 20)', { minimum: 1e-12 }) }), journal: true,
        run: async (c, a) => {
            const m = c.model();
            const places = placesArg(m, a.places);
            const sde = await import('./petri-sde.js');
            const opts = { horizon: a.t_end ?? 10, samples: a.points ?? 101, realizations: a.runs ?? 1, seed: a.seed ?? 1 };
            if (a.dt !== undefined) opts.dt = a.dt;
            const out = sde.simulateSDE(JSON.parse(JSON.stringify(m)), opts);
            if (out.diverged) throw new CommandError(out.reason, 'refused');
            const art = c.store(`SDE to t=${opts.horizon} (${opts.realizations} run${opts.realizations === 1 ? '' : 's'}, seed ${opts.seed})`, {
                kind: 'timeseries', x_label: 'time', x: out.times, series: stochasticSeries(out, places, out.times),
            }, { engine: 'sde', ...opts, rates: Sim.transitionRates(m) });
            return { artifact: art.id, final: out.final, seed: opts.seed, runs: opts.realizations };
        },
    },
    {
        id: 'sim.what_if', label: 'What if one more',
        help: 'The same seeded stochastic runs with and without delta more tokens in one place (sim.compare on one shared seed): an overlay of both and a table of final means. The shared seed makes the difference measure the change, not the dice.',
        args: args({
            place: str('the place that gets more tokens'), delta: int('tokens to add (default 1; may be negative)'),
            t_end: num('horizon (default 10)', { minimum: 1e-9 }), runs: int('realizations per arm (default 16, ≤ 200)', { minimum: 1, maximum: 200 }),
            seed: int('shared seed (default 7)', { minimum: 0 }),
        }, ['place']),
        journal: true,
        run: async (c, a) => {
            const m = c.model();
            const p = needNode(m, a.place, 'place');
            const now = p.initial.reduce((x, y) => x + y, 0);
            const delta = a.delta ?? 1;
            if (now + delta < 0) throw new CommandError(`${a.place} has ${now}; cannot remove ${-delta}`);
            const base = { hours: a.t_end ?? 10, realizations: a.runs ?? 16, seed: a.seed ?? 7 };
            const label = `${delta >= 0 ? '+' : ''}${delta} ${a.place}`;
            const out = await c.registry.execute('sim.compare', {
                seed: base.seed,
                scenarios: [{ name: 'as is', ...base }, { name: label, ...base, marking: { [a.place]: now + delta } }],
            });
            return { ...out, place: a.place, from: now, to: now + delta };
        },
    },
    {
        id: 'sim.recommend', label: 'Which engine?',
        help: 'Which engine to run this net with, and why (docs/engine-selection.md): constraints the ODE cannot see (inhibitor or read arcs, capacities) need the SSA; small token counts make the ODE\'s mean misleading and the SSA\'s spread matter; large unconstrained populations suit the ODE (and the SDE for noise). Also proposes a horizon, a seed and a run count.',
        args: args(), journal: false,
        run: (c) => {
            const m = c.model();
            const gating = gatingReasons(m);
            const tokens = Object.values(m.places).reduce((s, p) => s + p.initial.reduce((a, b) => a + b, 0), 0);
            // How fast one token moves through each transition at the initial
            // marking: mass action makes a token on one input wait on the
            // tokens of the others (rate × the other inputs' counts; for SIR's
            // infection, 0.005 × I per susceptible). The horizon is a few time
            // constants of the slowest that can fire now, as a round number.
            // REVIEW: a heuristic; every run states the horizon it used.
            const marks = Sim.marking(m);
            const effective = Object.keys(m.transitions).map((t) => {
                const counts = m.arcs.filter((a) => a.target === t && own(m.places, a.source) && !a.inhibitTransition)
                    .map((a) => (marks[a.source] || [0]).reduce((x, y) => x + y, 0));
                if (counts.some((c) => c === 0)) return 0; // cannot fire now
                const prod = counts.reduce((x, y) => x * y, 1);
                return Sim.rateOf(m, t) * (counts.length ? prod / Math.max(...counts) : 1);
            }).filter((r) => r > 0);
            const slowest = effective.length ? Math.min(...effective) : 1;
            const raw = Math.min(10000, Math.max(1, 5 / slowest));
            const t_end = Number((10 ** Math.floor(Math.log10(raw))) * Math.ceil(raw / 10 ** Math.floor(Math.log10(raw))));
            let engine, why;
            if (gating.length) {
                engine = 'ssa';
                why = `The net has ${gating.join('; ')}. These only make sense at a firing instant, which the ODE and the SDE do not have, so they would silently model an unconstrained system. Use the SSA.`;
            } else if (tokens < 100) {
                engine = 'ssa';
                why = `Only ${tokens} token(s) in all: at counts this small the ODE's mean-field curve can mislead (an outbreak that fizzles, a queue that empties), and the spread between runs is part of the answer. Run the SSA with several runs; compare with the ODE for the average.`;
            } else {
                engine = 'ode';
                why = `No firing-instant constraints and ${tokens} tokens: the ODE's mean is a good guide and costs nothing. Use the SSA (or the SDE, cheaper at this size) when the spread matters.`;
            }
            return { engine, why, gating, tokens, t_end, seed: 1, runs: engine === 'ode' ? 1 : 20,
                call: engine === 'ode' ? { command: 'sim.ode', args: { t_end } } : { command: 'sim.ssa', args: { t_end, runs: 20, seed: 1 } } };
        },
    },

    {
        id: 'net.set_goals', label: 'Set goals',
        help: 'Declare the net\'s reachability goals: markings it should be able to reach, e.g. [{"label": "everyone served", "to": {"served": 10}}]. "to" constrains only the places it names. The refinement gate (analysis.defects) counts a goal analysis.reach answers "no" to. An empty list removes them.',
        args: args({ goals: { type: 'array', items: { type: 'object' }, description: '[{label?, to: {place: count}}]' } }, ['goals']),
        journal: true,
        run: (c, a) => {
            c.edit('set goals', (m) => {
                a.goals.forEach((g, i) => {
                    if (!isObject(g) || !isObject(g.to) || !Object.keys(g.to).length) throw new CommandError(`goals[${i}]: needs a "to" marking`);
                    for (const [pid, n] of Object.entries(g.to)) {
                        needNode(m, pid, 'place');
                        if (!Number.isInteger(n) || n < 0) throw new CommandError(`goals[${i}].to.${pid}: a count ≥ 0`);
                    }
                    if (g.label !== undefined) checkLabel(g.label);
                    for (const k of Object.keys(g)) if (k !== 'label' && k !== 'to') throw new CommandError(`goals[${i}].${k}: a goal has only label and to`);
                });
                if (a.goals.length) m.goals = a.goals.map((g) => ({ ...(g.label ? { label: g.label } : {}), to: { ...g.to } }));
                else delete m.goals;
            });
            return { goals: c.model().goals || [] };
        },
    },
    {
        id: 'net.set_views', label: 'Set views',
        help: 'Declare the net\'s app screens (sim\'s Model.View): each a named projection, the places and transitions one screen presents, a role (board, dashboard, controls, advisor, trust, log), an optional title and prompt, and links to the views it navigates to. Every reference is checked; an empty list removes them.',
        args: args({ views: { type: 'array', items: { type: 'object' }, description: '[{id, role?, title?, prompt?, places?, transitions?, links?}]' } }, ['views']),
        journal: true,
        run: async (c, a) => {
            const { validateNet } = await import('./petri-validate.js');
            const probe = JSON.parse(JSON.stringify(c.model()));
            probe.views = a.views;
            const bad = validateNet(probe).errors.filter((e) => e.path.startsWith('views'));
            if (bad.length) throw new CommandError(bad.map((e) => `${e.path}: ${e.message}`).join('; '));
            c.edit('set views', (m) => { if (a.views.length) m.views = structuredClone(a.views); else delete m.views; });
            return { views: c.model().views || [] };
        },
    },
    {
        id: 'file.export_sim', label: 'Export for sim.pflow.xyz',
        help: 'The net in sim.pflow.xyz\'s model shape (places with initial counts, transitions with rates, arcs as from/to with read and inhibitor types, labels as tags), ready for sim_create_model. Read arcs are written place → transition, as sim expects.',
        args: args(), journal: false,
        run: async (c) => {
            const { toSim } = await import('./petri-roles.js');
            const m = c.model();
            const { model, rates } = toSim(m);
            const out = {
                name: m.name || 'pflow.xyz net',
                ...(m.description ? { description: m.description } : {}),
                places: model.places.map((pl) => ({ ...pl, initial: rates.initial[pl.id] })),
                transitions: model.transitions.map((t) => ({ ...t, rate: rates.rates[t.id] })),
                arcs: model.arcs.map((x) => {
                    const arc = (m.arcs || []).find((y) => (y.source === x.from && y.target === x.to) || (y.source === x.to && y.target === x.from));
                    const w = arc ? Sim.getArcWeight(arc)[0] : 1;
                    return { ...x, ...(w !== 1 ? { weight: w } : {}) };
                }),
                ...(m.views ? { views: m.views } : {}),
            };
            return { model: out };
        },
    },
    {
        id: 'analysis.roles', label: 'Roles',
        help: 'What a console knows about the net before anyone runs it (sim\'s deriveRoles): pools an operator could add to, arrival sources, losses (patience), queues, terminal outcomes and services, and the disruptions those imply, grouped by the question they ask. The App view is built from this.',
        args: args({ horizon: num('hours the derived waves span (default 8)', { minimum: 1 }) }), journal: false,
        run: async (c, a) => {
            const { rolesOf, groupDisruptions } = await import('./petri-roles.js');
            const { roles, disruptions } = rolesOf(c.model(), a.horizon ?? 8);
            return { roles, disruptions, groups: groupDisruptions(disruptions).map((g) => ({ question: g.question, ids: g.items.map((d) => d.id) })) };
        },
    },
    {
        id: 'analysis.behaviour', label: 'Behaviour checks',
        help: 'sim\'s builder checks on the token game: parts of the net not connected to the rest, transitions that never fire, places nothing ever fills, a reachable marking where nothing can fire (with a trace), and a place growing past the token bound. One bounded exploration (max_states markings); when the bound is hit, claims needing the whole space are left out, not guessed.',
        args: args({ max_states: int('markings to explore (default 2000, ≤ 50000)', { minimum: 10, maximum: 50000 }), unbounded_tokens: int('a place past this many tokens counts as unbounded (default 1000)', { minimum: 1 }) }),
        journal: false,
        run: (c, a) => {
            const m = c.model();
            const ex = exploreBehaviour(m, { maxStates: a.max_states ?? 2000, unboundedTokens: a.unbounded_tokens ?? 1000 });
            const findings = [];
            const parts = components(m);
            if (parts.length > 1) {
                const small = parts.slice().sort((x, y) => x.length - y.length).slice(0, -1);
                findings.push({ category: 'disconnected', nodes: small.flat(), message: `${parts.length} separate parts; ${small.map((s) => s.join(', ')).join(' | ')} not connected to the rest` });
            }
            if (ex.exhaustive) {
                const dead = Object.keys(m.transitions).filter((t) => !ex.fired.has(t));
                if (dead.length) findings.push({ category: 'dead_transition', nodes: dead, message: `never fires from this marking: ${dead.join(', ')}` });
                const empty = Object.keys(m.places).filter((p) => !ex.marked.has(p));
                if (empty.length) findings.push({ category: 'unreachable_place', nodes: empty, message: `nothing ever puts a token in: ${empty.join(', ')}` });
            }
            let trace = null;
            if (ex.deadlock) {
                trace = c.store(`Deadlock after ${ex.deadlock.length - 1} firing(s)`, { kind: 'trace', steps: ex.deadlock });
                findings.push({ category: 'deadlock', nodes: [], message: `a reachable marking where nothing can fire (see ${trace.id}; fine if it is the intended end state)` });
            }
            if (ex.unbounded) findings.push({ category: 'unbounded', nodes: [ex.unbounded], message: `${ex.unbounded} grows past ${a.unbounded_tokens ?? 1000} tokens` });
            const report = { findings, states: ex.states, exhaustive: ex.exhaustive,
                note: ex.exhaustive ? 'every reachable marking was explored' : `stopped at ${ex.states} markings: "never fires" and "never filled" are not claimed` };
            const art = c.store('Behaviour checks', { kind: 'report', ...report });
            return { artifact: art.id, ...(trace ? { trace: trace.id } : {}), ...report };
        },
    },
    {
        id: 'analysis.defects', label: 'Defect weight',
        help: 'sim\'s refinement gate, engine-computed: dead transitions + unmarked siphons (that can empty and stop transitions for good) + declared goals analysis.reach answers "no" to + conservation laws of a baseline that no longer hold. 0 is clean. Pass baseline_laws (P-invariant coefficient maps, e.g. from the net before an edit) to count lost laws; leave it out to count none.',
        args: args({ baseline_laws: { type: 'array', items: { type: 'object' }, description: '[{place: coefficient}] from an earlier net' }, max_states: int('budget for the exploration and each goal (default 2000)', { minimum: 10, maximum: 50000 }) }),
        journal: false,
        run: async (c, a) => {
            const m = c.model();
            const notes = [];
            const ex = exploreBehaviour(m, { maxStates: a.max_states ?? 2000 });
            const dead = ex.exhaustive ? Object.keys(m.transitions).filter((t) => !ex.fired.has(t)) : [];
            if (!ex.exhaustive) notes.push('the exploration hit its bound, so dead transitions are not counted');
            let siphons = [];
            try {
                const s = await c.registry.execute('analysis.siphons');
                // unmarked = empty at the current marking: the transitions needing it never fire again
                siphons = (s.minimal_siphons || []).filter((x) => x.marked === false).map((x) => x.places);
            } catch (e) {
                notes.push(`siphons not checked: ${e.message}`);
            }
            const unreachable = [];
            for (const [i, g] of (m.goals || []).entries()) {
                try {
                    const r = await c.registry.execute('analysis.reach', { to: g.to, max_states: a.max_states ?? 2000 });
                    if (r.answer === 'no') unreachable.push(g.label || `goal ${i}`);
                    if (r.answer === 'unknown') notes.push(`${g.label || `goal ${i}`}: unknown within the budget (not counted)`);
                } catch (e) {
                    notes.push(`${g.label || `goal ${i}`} not checked: ${e.message}`);
                }
            }
            const lost = (a.baseline_laws || []).filter((y) => !conserves(m, y)).map((y) => Object.entries(y).map(([p, w]) => (w === 1 ? p : `${w}·${p}`)).join(' + '));
            const weight = dead.length + siphons.length + unreachable.length + lost.length;
            const report = { weight, dead_transitions: dead, unmarked_siphons: siphons, unreachable_goals: unreachable, lost_laws: lost, notes };
            const art = c.store(`Defect weight ${weight}`, { kind: 'report', ...report });
            return { artifact: art.id, ...report };
        },
    },

    // ---- analysis ----
    {
        // REVIEW: named analysis.check, not analysis.validate: pflow-native's
        // analysis.validate is pflow-validation's checks (exposed below from
        // wasm), and one id must mean one thing in both apps.
        id: 'analysis.check', label: 'Check net',
        help: 'The editor\'s strict check: every problem the editor would otherwise repair quietly, with a path, plus warnings. With engines (default true) and no errors, also runs the firing rule, the ODE solver\'s reading and CID sealing. Stores a report artifact.',
        args: args({ strict: bool('a key the editor does not write is an error (default false)'), engines: bool('run the engine checks too (default true)') }),
        journal: false,
        run: async (c, a) => {
            const { validateNet, smokeCheck } = await import('./petri-validate.js');
            const doc = JSON.parse(JSON.stringify(c.model()));
            const r = validateNet(doc, { strict: !!a.strict });
            const smoke = r.ok && a.engines !== false ? await smokeCheck(doc) : null;
            const report = { ok: r.ok && (!smoke || smoke.ok), errors: [...r.errors, ...(smoke ? smoke.errors : [])], warnings: r.warnings, cid: smoke?.cid ?? null };
            const art = c.store('Check net', { kind: 'report', ...report });
            return { artifact: art.id, ...report };
        },
    },

    {
        id: 'sim.goto', label: 'Go to marking',
        help: 'Load a marking from a result onto the net: a step of a trace artifact (step), or a state of a graph artifact (node). The run baseline is kept, so Reset marking returns to where the run started.',
        args: args({ id: str('trace or graph artifact id'), step: int('trace step index', { minimum: 0 }), node: str('graph node id (its data.marking is loaded)') }, ['id']),
        journal: true,
        run: (c, a) => {
            const art = c.registry.artifact(a.id);
            let marking, fired = null;
            if (art.data.kind === 'trace') {
                const steps = art.data.steps || [];
                const i = a.step ?? steps.length - 1;
                if (i >= steps.length) throw new CommandError(`step ${i}: the trace has ${steps.length} step(s)`);
                marking = steps[i].marking;
                fired = steps[i].transition || null;
            } else if (art.data.kind === 'graph') {
                if (a.node === undefined) throw new CommandError('a graph needs node');
                const n = (art.data.nodes || []).find((x) => x.id === a.node);
                if (!n) throw new CommandError(`no node "${a.node}" in ${a.id}`, 'not_found');
                marking = n.data && n.data.marking;
            } else {
                throw new CommandError(`${a.id} is a ${art.data.kind}; sim.goto takes a trace or a graph`);
            }
            if (!marking) throw new CommandError('that step carries no marking');
            const m = c.model();
            const next = {};
            for (const [pid, v] of Object.entries(marking)) {
                if (!own(m.places, pid)) continue;
                // ω (unbounded, from coverability) cannot be a token count.
                if ([].concat(v).some((x) => typeof x !== 'number')) throw new CommandError(`${pid} is ω (unbounded) in that state; it cannot be loaded`);
                next[pid] = [].concat(v);
            }
            if (c.host.setMarking) c.host.setMarking(next);
            else c.edit('go to marking', (d) => { for (const [pid, v] of Object.entries(next)) d.places[pid].initial = [...v]; });
            if (fired && c.host.highlight) c.host.highlight([fired], null, `fired ${fired}`);
            return { marking: Sim.marking(c.model()), fired };
        },
    },
    {
        id: 'view.highlight', label: 'Highlight nodes', help: 'Mark places/transitions on the canvas, optionally with a number badge each (e.g. invariant coefficients).',
        args: args({ nodes: strList('place/transition ids'), label: str('what the highlight means'), weights: { type: 'object', description: '{node: number} badges' } }, ['nodes']),
        journal: false, requires: ['view'],
        run: (c, a) => {
            const m = c.model();
            for (const id of a.nodes) needNode(m, id);
            c.host.highlight(a.nodes, a.weights || null, a.label || '');
            return { highlighted: a.nodes };
        },
    },
    {
        id: 'view.clear_highlight', label: 'Clear highlight', help: 'Remove the canvas highlight.',
        args: args(), journal: false, requires: ['view'],
        run: (c) => { c.host.clearHighlight(); return {}; },
    },
    {
        id: 'artifact.show_set', label: 'Show set', help: 'Highlight one node set of a sets artifact (an invariant\'s support, a siphon, an orbit) on the canvas; without a view, return it.',
        args: args({ id: str('artifact id'), index: int('set index (default 0)', { minimum: 0 }) }, ['id']),
        journal: false,
        run: (c, a) => {
            const art = c.registry.artifact(a.id);
            if (art.data.kind !== 'sets') throw new CommandError(`${a.id} is a ${art.data.kind}, not a sets artifact`);
            const set = (art.data.sets || [])[a.index ?? 0];
            if (!set) throw new CommandError(`set ${a.index ?? 0}: ${a.id} has ${(art.data.sets || []).length}`);
            if (c.host.highlight) c.host.highlight(set.nodes, set.weights || null, set.label || '');
            return { set };
        },
    },

    // ---- artifacts ----
    {
        id: 'artifact.list', label: 'Results', help: 'The stored artifacts, newest last: id, title, kind and the command that made each.',
        args: args(), journal: false,
        run: (c) => ({ artifacts: c.registry.artifacts().map((x) => ({ id: x.id, title: x.title, kind: x.data.kind, source: x.source })) }),
    },
    {
        id: 'artifact.get', label: 'Get result', help: 'One artifact in full.',
        args: args({ id: str('artifact id') }, ['id']), journal: false,
        run: (c, a) => ({ artifact: c.registry.artifact(a.id) }),
    },
    {
        id: 'export.artifact', label: 'Export result',
        help: 'An artifact as CSV or JSON text, with a filename. With `name`, saved to that file in your account instead (needs you signed in), as pflow-native writes its `path`.',
        args: args({
            id: str('artifact id'), format: { type: 'string', enum: ['csv', 'json'], description: 'csv (default) or json' },
            name: str('save to this file in your account (.csv or .json, as the format)'),
            overwrite: bool('with name: replace your file of that name (default false)'),
        }, ['id']),
        journal: false,
        run: async (c, a) => {
            const format = a.format ?? 'csv';
            const out = exportArtifact(c.registry.artifact(a.id), format);
            if (a.name === undefined) {
                if (a.overwrite !== undefined) throw new CommandError('export.artifact: overwrite goes with name');
                return out;
            }
            if (checkAccountName(a.name) !== `.${format}`) throw new CommandError(`name "${a.name}": a ${format} export is saved as .${format}`);
            return { ...(await accountSave(c.host, a.name, out.content, a.overwrite, out.mime)), filename: out.filename };
        },
    },

    // ---- view ----
    {
        id: 'view.fit', label: 'Fit to view', help: 'Frame the whole net.', args: args(), journal: false, requires: ['view'],
        run: (c) => { c.host.fit(); return {}; },
    },
];

// ---------------------------------------------------------------------------
// pflow-native commands, run in wasm
// ---------------------------------------------------------------------------

/**
 * pflow-native's commands the editor exposes, as registry specs. Each runs in
 * the wasm engine (petri-wasm.js) against the current document; the artifacts
 * it makes land in this registry.
 */
export function nativeCommands(specs = NATIVE_COMMANDS) {
    return specs.map((s) => ({
        id: s.id, label: s.label, help: s.help, journal: s.journal, native: true,
        // Writes the session state the page keeps in browser storage (the
        // model library, systems, notes, macros, the store): petri-wasm.js.
        ...(s.writesState ? { writesState: true } : {}),
        args: { ...s.args, type: 'object', properties: s.args.properties || {}, required: s.args.required || [] },
        run: async (c, a) => {
            const { runNative } = await import('./petri-wasm.js');
            // JSON round trip: unbounded capacities (Infinity) become null, as saved.
            const before = JSON.parse(JSON.stringify(c.model()));
            // compose.*, file.open_example, net.layout… always edit; fit,
            // distill and calibrate edit (the rates) when called with apply;
            // system.set_port edits the open net only when its `model` names
            // it (absent or "current"), the library otherwise.
            const onCurrent = s.editsOnCurrent && (a[s.editsOnCurrent] === undefined || a[s.editsOnCurrent] === 'current');
            const editing = !!s.edits || !!(s.editsOnApply && a.apply) || !!onCurrent;
            const out = await runNative(before, s.id, a, c.store, {
                edits: editing, full: true, artifactArgs: s.artifactArgs,
                lookup: (id) => c.registry.artifact(id),
            });
            if (editing && out.doc) {
                // The engine edited the net: its export becomes the document,
                // as one undo step. A replacing command (file.open_example,
                // data.discover) brings a whole new net; the others keep the
                // editor's token list, name, description, parents and goals,
                // which the engine does not carry.
                const doc = out.doc;
                if (s.edits !== 'replace') {
                    if (!(doc.token || []).length) doc.token = s.id === 'net.set_colors' ? ['https://pflow.xyz/tokens/black'] : before.token;
                    if (before.goals) doc.goals = before.goals;
                    for (const k of ['name', 'description', 'parents']) if (before[k] !== undefined && doc[k] === undefined) doc[k] = before[k];
                }
                c.host.commit(Sim.normalizeModel(doc), s.id);
            }
            if (s.setsMarking && out.result?.marking && c.host.setMarking) c.host.setMarking(out.result.marking);
            if (s.textResult && typeof out.result === 'string') return { [s.textResult]: out.result };
            return out.result;
        },
    }));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'result';

/** An artifact as {filename, mime, content}. CSV for the tabular kinds; JSON for all. */
export function exportArtifact(art, format = 'csv') {
    const base = `${slug(art.title)}-${art.id}`;
    if (format === 'json') {
        return { filename: `${base}.json`, mime: 'application/json', content: JSON.stringify(art, null, 2) };
    }
    const d = art.data;
    let rows;
    if (d.kind === 'timeseries') {
        const names = d.series.map((s) => (s.group ? `${s.name} (${s.group})` : s.name));
        rows = [[d.x_label, ...names], ...d.x.map((x, i) => [x, ...d.series.map((s) => s.values[i])])];
    } else if (d.kind === 'table') {
        rows = [d.columns, ...d.rows];
    } else if (d.kind === 'report' && Array.isArray(d.errors)) {
        rows = [['severity', 'path', 'message'],
            ...d.errors.map((e) => ['error', e.path, e.message]), ...d.warnings.map((w) => ['warning', w.path, w.message])];
    } else {
        throw new CommandError(`a ${d.kind} artifact exports as json only`, 'unsupported');
    }
    return { filename: `${base}.csv`, mime: 'text/csv', content: rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n' };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const MAX_ARTIFACTS = 50;

export class Registry {
    /**
     * @param {Object} host see the header
     * @param {CommandSpec[]} [commands]
     */
    /**
     * @param {Object} [opts]
     * @param {{items: Array, next: number}} [opts.store] an artifact store to
     *   share with another registry (the chat's sandbox shares the editor's,
     *   so its results show up in Results too)
     */
    constructor(host, commands = [...COMMANDS, ...nativeCommands()], opts = {}) {
        this.host = host;
        // A command id is registered once. The Map would otherwise let a later
        // spec (a native one) silently replace an earlier one (a JS one).
        const seen = new Set();
        for (const s of commands) {
            if (seen.has(s.id)) throw new Error(`command id registered twice: ${s.id} (a native command must not share an id with a JS command)`);
            seen.add(s.id);
        }
        this._specs = new Map(commands.map((s) => [s.id, s]));
        this._store = opts.store || { items: [], next: 1 };
        this._listeners = new Set();
        /** Steps of journalled commands that succeeded, oldest first. */
        this.journal = [];
    }

    /** The command specs as plain data: id, label, help, args (JSON Schema), journal, available, native, writesState. */
    list() {
        const caps = this.host.capabilities || new Set();
        return [...this._specs.values()].map((s) => ({
            id: s.id, label: s.label, help: s.help, args: s.args, journal: s.journal,
            available: (s.requires || []).every((r) => caps.has(r)),
            native: !!s.native,
            ...(s.writesState ? { writesState: true } : {}),
        }));
    }

    describe(id) {
        const s = this._specs.get(id);
        if (!s) throw new CommandError(`unknown command "${id}"`, 'unknown_command');
        return this.list().find((x) => x.id === id);
    }

    artifacts() { return [...this._store.items]; }

    artifact(id) {
        const a = this._store.items.find((x) => x.id === id);
        if (!a) throw new CommandError(`no artifact "${id}"${this._store.items.length ? ` (have ${this._store.items.map((x) => x.id).join(', ')})` : ''}`, 'not_found');
        return a;
    }

    /** Called with {id, args, ok, result | error, ms} after every execute. Returns an unsubscribe. */
    onExecute(fn) {
        this._listeners.add(fn);
        return () => this._listeners.delete(fn);
    }

    /**
     * Run one command. Resolves to its result object; rejects with a
     * CommandError (code + message) when the arguments or the net refuse it.
     * An edit that throws leaves the document untouched.
     */
    async execute(id, a = {}) {
        const t0 = Date.now();
        const spec = this._specs.get(id);
        const step = { command: id, args: a ?? {} };
        try {
            if (!spec) {
                const near = [...this._specs.keys()].filter((k) => k.split('.')[1] === String(id).split('.').pop());
                throw new CommandError(`unknown command "${id}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}`, 'unknown_command');
            }
            const caps = this.host.capabilities || new Set();
            for (const r of spec.requires || []) {
                if (!caps.has(r)) throw new CommandError(`${id} needs a host with a ${r}`, 'unsupported');
            }
            const checked = checkArgs(spec, a);
            const result = await spec.run(this._context(step), checked);
            if (spec.journal) this.journal.push(step);
            this._emit({ id, args: step.args, ok: true, result, ms: Date.now() - t0 });
            return result;
        } catch (e) {
            const err = e instanceof CommandError ? e : new CommandError(e?.message || String(e), 'failed');
            this._emit({ id, args: step.args, ok: false, error: { code: err.code, message: err.message }, ms: Date.now() - t0 });
            throw err;
        }
    }

    /** Run several commands in order; stops at the first failure. */
    async batch(steps) {
        const results = [];
        for (const s of steps) results.push(await this.execute(s.command, s.args));
        return results;
    }

    _context(step) {
        const host = this.host;
        return {
            host,
            registry: this,
            model: () => host.getModel(),
            // Apply fn to a copy, normalize it, and commit it as one undo step.
            // If fn throws, the document is untouched.
            edit: (label, fn) => {
                const draft = structuredClone(host.getModel());
                fn(draft);
                host.commit(Sim.normalizeModel(draft), label);
            },
            store: (title, data, meta) => {
                const art = { id: `a${this._store.next++}`, title, source: step, data };
                // REVIEW: `meta` (the run's inputs and summary) is a pflow.xyz
                // extension; pflow-native's Artifact has no such field.
                if (meta) art.meta = meta;
                this._store.items.push(art);
                if (this._store.items.length > MAX_ARTIFACTS) this._store.items.shift();
                return art;
            },
        };
    }

    _emit(ev) {
        for (const fn of this._listeners) {
            try { fn(ev); } catch { /* a listener never breaks a command */ }
        }
    }
}

// ---------------------------------------------------------------------------
// A host with no DOM
// ---------------------------------------------------------------------------

/**
 * A host that keeps the document, its history and a run baseline in memory.
 * opts.token, opts.fetch and opts.apiBase sign the account-file commands in
 * (an agent's GitHub token and server; tests pass a fake fetch). Without a
 * token they refuse, as the page does signed out.
 */
export function createHeadlessHost(model, opts = {}) {
    let doc = Sim.normalizeModel(structuredClone(model ?? emptyNet()));
    const snap = () => JSON.stringify(doc);
    const history = [snap()];
    const redo = [];
    let baseline = null;
    return {
        capabilities: new Set(),
        authToken: () => opts.token || null,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        apiBase: opts.apiBase || '',
        getModel: () => doc,
        commit(next) {
            doc = next;
            const s = snap();
            if (s !== history[history.length - 1]) { history.push(s); redo.length = 0; }
        },
        undo() {
            if (history.length < 2) return false;
            redo.push(history.pop());
            doc = Sim.normalizeModel(JSON.parse(history[history.length - 1]));
            return true;
        },
        redo() {
            if (!redo.length) return false;
            const s = redo.pop();
            history.push(s);
            doc = Sim.normalizeModel(JSON.parse(s));
            return true;
        },
        fire(tid) {
            const next = Sim.fire(doc, tid, Sim.marking(doc));
            if (!next) return false;
            if (!baseline) baseline = Sim.marking(doc);
            const d = structuredClone(doc);
            for (const [pid, v] of Object.entries(next)) d.places[pid].initial = [...v];
            this.commit(d);
            return true;
        },
        setMarking(marks) {
            if (!baseline) baseline = Sim.marking(doc);
            const d = structuredClone(doc);
            for (const [pid, v] of Object.entries(marks)) if (d.places[pid]) d.places[pid].initial = [...v];
            this.commit(d);
        },
        resetMarking() {
            if (!baseline) return;
            const d = structuredClone(doc);
            for (const [pid, v] of Object.entries(baseline)) if (d.places[pid]) d.places[pid].initial = [...v];
            baseline = null;
            this.commit(d);
        },
    };
}
