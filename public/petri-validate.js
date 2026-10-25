// petri-validate.js — the editor's strict check of a pflow.xyz net.
//
// The editor's normalizeModel (petri-sim.js) repairs a document quietly: it
// fills defaults, turns bad numbers into 0 or 1 and clamps an initial marking
// that exceeds its capacity. That keeps old and hand-written nets loading, but
// it means "it loaded" says nothing about whether the net was valid. This
// module says it, without changing anything:
//
//   - an ERROR is anything normalizeModel would coerce or clamp (the net you
//     see is not the net you were given), or a reference the engines cannot
//     follow (an arc to an undeclared node, an arc between two places);
//   - a WARNING is a default normalizeModel would fill, a key the editor does
//     not write (kept, and hashed into the CID through the context's @vocab),
//     or a shape that is legal but usually a mistake (an unconnected node, a
//     net with nothing enabled at its initial marking).
//
// Every problem is reported at once, each with a path, as sim's
// modelstore.Validate does. No DOM: deno tests it directly, and the editor
// loads it with a dynamic import only, so a vendored copy of petri-view.js
// without this file simply skips the check.
import { normalizeModel, enabledTransitions } from './petri-sim.js';

// The keys the editor itself writes (and that stored nets carry). Anything
// else is preserved but reported; in strict mode it is an error.
const NET_KEYS = new Set(['@context', '@id', '@type', '@version', 'name', 'description', 'author',
    'token', 'places', 'transitions', 'arcs', 'parents', 'goals', 'views']);

// sim's view roles (pkg/modelstore/store.go viewRoles) and keys.
export const VIEW_ROLES = ['board', 'dashboard', 'controls', 'advisor', 'trust', 'log'];
const VIEW_KEYS = new Set(['id', 'role', 'title', 'prompt', 'places', 'transitions', 'links']);
const IDENT = /^[A-Za-z0-9_]+$/;
const PLACE_KEYS = new Set(['@type', 'label', 'description', 'initial', 'capacity', 'x', 'y', 'offset']);
const TRANSITION_KEYS = new Set(['@type', 'label', 'description', 'x', 'y', 'offset', 'role', 'rate']);
const ARC_KEYS = new Set(['@type', 'source', 'target', 'weight', 'inhibitTransition']);

// Places and transitions become object keys.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * The label rule the editor's label editor enforces.
 * @param {*} text
 * @returns {string|null} what is wrong, or null
 */
export function labelProblem(text) {
    if (typeof text !== 'string' || text.trim().length === 0) return 'Label cannot be empty';
    if (text.length > 100) return 'Label must be 100 characters or fewer';
    if (/[\r\n]/.test(text)) return 'Label must be a single line';
    return null;
}

/**
 * Check a net in the editor's JSON-LD format without changing it.
 *
 * @param {*} doc the document as parsed from JSON
 * @param {{strict?: boolean}} [opts] strict: a key the editor does not write is an error
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>,
 *            warnings: Array<{path: string, message: string}>}}
 */
export function validateNet(doc, opts = {}) {
    const errors = [];
    const warnings = [];
    const err = (path, message) => errors.push({ path, message });
    const warn = (path, message) => warnings.push({ path, message });
    const unknownKeys = (path, obj, known) => {
        for (const k of Object.keys(obj)) {
            if (known.has(k)) continue;
            (opts.strict ? err : warn)(`${path}${path ? '.' : ''}${k}`, 'not a term the editor writes; kept as is');
        }
    };

    if (!isObject(doc)) {
        err('', 'a net is a JSON object');
        return { ok: false, errors, warnings };
    }

    // ---- the net ----
    if (!('@context' in doc)) warn('@context', 'missing; read as https://pflow.xyz/schema');
    if (!('@type' in doc)) warn('@type', 'missing; read as PetriNet');
    else if (doc['@type'] !== 'PetriNet') err('@type', `is ${JSON.stringify(doc['@type'])}, not "PetriNet"`);
    for (const k of ['name', 'description']) {
        if (k in doc && typeof doc[k] !== 'string') err(k, 'must be a string');
    }
    // The server writes author as a schema.org Person; older nets carry a string.
    if ('author' in doc && typeof doc.author !== 'string' && !isObject(doc.author)) {
        err('author', 'must be a string or a Person object');
    }
    if ('parents' in doc && !(Array.isArray(doc.parents) && doc.parents.every((c) => typeof c === 'string'))) {
        err('parents', 'must be a list of CIDs (strings)');
    }
    unknownKeys('', doc, NET_KEYS);

    let colors = 1;
    if (!('token' in doc)) {
        warn('token', 'missing; read as one black token');
    } else if (!Array.isArray(doc.token) || !doc.token.every((t) => typeof t === 'string')) {
        err('token', 'must be a list of token type IRIs');
    } else {
        // An empty list is a stored shape (the knapsack golden): plain, uncolored tokens.
        colors = Math.max(1, doc.token.length);
    }

    const places = readNodes(doc, 'places', err, warn);
    const transitions = readNodes(doc, 'transitions', err, warn);

    // ---- ids ----
    for (const [kind, nodes] of [['places', places], ['transitions', transitions]]) {
        for (const id of Object.keys(nodes)) {
            if (id.trim() === '') err(`${kind}[""]`, 'an id cannot be empty');
            if (RESERVED_IDS.has(id)) err(`${kind}.${id}`, `"${id}" cannot be an id`);
        }
    }
    for (const id of Object.keys(places)) {
        if (Object.prototype.hasOwnProperty.call(transitions, id)) {
            err(`transitions.${id}`, `"${id}" is also a place; ids are shared by places and transitions`);
        }
    }

    // ---- places ----
    for (const [id, p] of Object.entries(places)) {
        const path = `places.${id}`;
        if (!isObject(p)) { err(path, 'must be an object'); continue; }
        if ('@type' in p && p['@type'] !== 'Place') err(`${path}.@type`, `is ${JSON.stringify(p['@type'])}, not "Place"`);
        checkText(path, p, err);
        checkCoords(path, p, err, warn);
        const initial = checkVector(`${path}.initial`, p.initial, 'initial', colors, err, warn);
        const capacity = checkVector(`${path}.capacity`, p.capacity, 'capacity', colors, err, warn);
        if (initial && capacity) {
            for (let i = 0; i < Math.min(initial.length, capacity.length); i++) {
                const cap = capacity[i];
                if (typeof cap === 'number' && cap > 0 && typeof initial[i] === 'number' && initial[i] > cap) {
                    err(`${path}.initial[${i}]`, `${initial[i]} exceeds capacity ${cap}; the editor would clamp it to ${cap}`);
                }
            }
        }
        unknownKeys(path, p, PLACE_KEYS);
    }

    // ---- transitions ----
    for (const [id, t] of Object.entries(transitions)) {
        const path = `transitions.${id}`;
        if (!isObject(t)) { err(path, 'must be an object'); continue; }
        if ('@type' in t && t['@type'] !== 'Transition') err(`${path}.@type`, `is ${JSON.stringify(t['@type'])}, not "Transition"`);
        checkText(path, t, err);
        checkCoords(path, t, err, warn);
        if ('rate' in t && !(typeof t.rate === 'number' && Number.isFinite(t.rate) && t.rate >= 0)) {
            err(`${path}.rate`, `${JSON.stringify(t.rate)} is not a non-negative number; the engines would use 1.0`);
        }
        if ('role' in t && typeof t.role !== 'string') err(`${path}.role`, 'must be a string');
        unknownKeys(path, t, TRANSITION_KEYS);
    }

    // ---- arcs ----
    const touched = new Set();
    const seen = new Map();
    let arcs = [];
    if (!('arcs' in doc)) warn('arcs', 'missing; read as no arcs');
    else if (!Array.isArray(doc.arcs)) err('arcs', 'must be a list');
    else arcs = doc.arcs;
    arcs.forEach((a, i) => {
        const path = `arcs[${i}]`;
        if (!isObject(a)) { err(path, 'must be an object'); return; }
        if ('@type' in a && a['@type'] !== 'Arrow') err(`${path}.@type`, `is ${JSON.stringify(a['@type'])}, not "Arrow"`);
        const kindOf = (id) => (Object.prototype.hasOwnProperty.call(places, id) ? 'place'
            : Object.prototype.hasOwnProperty.call(transitions, id) ? 'transition' : null);
        let ends = true;
        for (const end of ['source', 'target']) {
            if (typeof a[end] !== 'string') {
                err(`${path}.${end}`, 'must be a place or transition id');
                ends = false;
            } else if (!kindOf(a[end])) {
                err(`${path}.${end}`, `"${a[end]}" is not a declared place or transition`);
                ends = false;
            }
        }
        if (ends) {
            const s = kindOf(a.source), t = kindOf(a.target);
            // Stored nets carry these (the editor's own state machine, net-a), go-pflow
            // parses them and normalizeModel keeps them, so this is a warning: no engine
            // fires along such an arc.
            if (s === t) warn(path, `joins two ${s}s (${a.source} → ${a.target}); no engine fires along it`);
            touched.add(a.source);
            touched.add(a.target);
            const key = `${a.source}\u0000${a.target}\u0000${!!a.inhibitTransition}`;
            if (seen.has(key)) warn(path, `repeats arcs[${seen.get(key)}] (${a.source} → ${a.target})`);
            else seen.set(key, i);
        }
        if ('inhibitTransition' in a && typeof a.inhibitTransition !== 'boolean') {
            err(`${path}.inhibitTransition`, 'must be true or false');
        }
        const weight = checkVector(`${path}.weight`, a.weight, 'weight', colors, err, warn);
        if (weight && weight.length > 0 && weight.every((w) => w === 0)) {
            // pflow-native FEATURES.md §D 8: the JS engines read an explicit 0 as
            // "this color is not involved", go-pflow and pflow-rs as weight 1.
            warn(`${path}.weight`, 'is all zeros: "no requirement" here, but weight 1 in go-pflow and pflow-rs');
        }
        unknownKeys(path, a, ARC_KEYS);
    });

    // ---- goals: declared reachability targets (net.set_goals) ----
    if ('goals' in doc) {
        if (!Array.isArray(doc.goals)) {
            err('goals', 'must be a list of {label?, to}');
        } else {
            doc.goals.forEach((g, i) => {
                const path = `goals[${i}]`;
                if (!isObject(g) || !isObject(g.to)) { err(path, 'needs a "to" marking {place: count}'); return; }
                for (const k of Object.keys(g)) if (k !== 'label' && k !== 'to') err(`${path}.${k}`, 'a goal has only label and to');
                if ('label' in g) { const pr = labelProblem(g.label); if (pr) err(`${path}.label`, pr); }
                for (const [pid, n] of Object.entries(g.to)) {
                    if (!Object.prototype.hasOwnProperty.call(places, pid)) err(`${path}.to.${pid}`, `"${pid}" is not a declared place`);
                    else if (!isCount(n)) err(`${path}.to.${pid}`, `${JSON.stringify(n)} is not a count`);
                }
            });
        }
    }

    // ---- views: validated projections (sim's Model.View) ----
    if ('views' in doc) {
        if (!Array.isArray(doc.views)) {
            err('views', 'must be a list of {id, role, places, transitions, links}');
        } else {
            const ids = new Set();
            doc.views.forEach((vw, i) => {
                if (isObject(vw) && typeof vw.id === 'string') {
                    if (ids.has(vw.id)) err(`views[${i}].id`, `"${vw.id}" is used twice`);
                    ids.add(vw.id);
                }
            });
            doc.views.forEach((vw, i) => {
                const path = `views[${i}]`;
                if (!isObject(vw)) { err(path, 'must be an object'); return; }
                if (typeof vw.id !== 'string' || !IDENT.test(vw.id)) err(`${path}.id`, 'a bare identifier (letters, digits, underscore)');
                for (const k of Object.keys(vw)) if (!VIEW_KEYS.has(k)) err(`${path}.${k}`, 'not a view field (id, role, title, prompt, places, transitions, links)');
                if (vw.role !== undefined && vw.role !== '' && !VIEW_ROLES.includes(vw.role)) err(`${path}.role`, `"${vw.role}"; known roles are ${VIEW_ROLES.join(', ')}`);
                for (const k of ['title', 'prompt']) if (k in vw && typeof vw[k] !== 'string') err(`${path}.${k}`, 'must be a string');
                for (const [k, coll, what] of [['places', places, 'place'], ['transitions', transitions, 'transition'], ['links', null, 'view']]) {
                    if (!(k in vw)) continue;
                    if (!Array.isArray(vw[k])) { err(`${path}.${k}`, 'must be a list of ids'); continue; }
                    for (const id of vw[k]) {
                        const ok = coll ? Object.prototype.hasOwnProperty.call(coll, id) : ids.has(id);
                        if (!ok) err(`${path}.${k}`, `"${id}" is not a ${what}`);
                    }
                }
            });
        }
    }

    // ---- shape (only when the references above hold) ----
    if (errors.length === 0) {
        for (const id of Object.keys(places)) {
            if (!touched.has(id)) warn(`places.${id}`, 'no arc touches this place');
        }
        for (const id of Object.keys(transitions)) {
            if (!touched.has(id)) warn(`transitions.${id}`, 'no arc touches this transition; it is always enabled and does nothing');
        }
        if (Object.keys(transitions).length > 0) {
            const net = normalizeModel(structuredClone(doc));
            if (enabledTransitions(net).length === 0) warn('', 'nothing is enabled at the initial marking');
        }
    }

    return { ok: errors.length === 0, errors, warnings };
}

/**
 * Check that the engines a user runs next accept the net: the firing rule, the
 * ODE solver's reading of it, and CID sealing (so /api/save will take it).
 * Run it after validateNet passes; it normalizes a copy, never the net itself.
 *
 * @param {*} doc
 * @returns {Promise<{ok: boolean, errors: Array<{path: string, message: string}>, cid?: string}>}
 */
export async function smokeCheck(doc) {
    const errors = [];
    const net = normalizeModel(structuredClone(doc));
    try {
        enabledTransitions(net);
    } catch (e) {
        errors.push({ path: '', message: `the firing rule failed: ${e.message}` });
    }
    try {
        const solver = await import('./petri-solver.js');
        const { transitionRates } = await import('./petri-sim.js');
        const pn = solver.fromJSON(net);
        solver.setState(pn);
        solver.setRates(pn, transitionRates(net));
    } catch (e) {
        errors.push({ path: '', message: `the ODE solver cannot read it: ${e.message}` });
    }
    let cid;
    try {
        const { computeCid } = await import('./seal-cid.mjs');
        cid = await computeCid(JSON.parse(JSON.stringify(net)));
    } catch (e) {
        errors.push({ path: '', message: `it does not seal to a CID: ${e.message}` });
    }
    return { ok: errors.length === 0, errors, cid };
}

/** One line per problem, "path: message". */
export function formatIssue({ path, message }) {
    return path ? `${path}: ${message}` : message;
}

// ---- helpers ----

function readNodes(doc, key, err, warn) {
    if (!(key in doc)) {
        warn(key, 'missing; read as none');
        return {};
    }
    const v = doc[key];
    if (Array.isArray(v)) {
        err(key, 'is a list; this editor reads an object keyed by id (a sim.pflow.xyz model has to be converted first)');
        return {};
    }
    if (!isObject(v)) {
        err(key, 'must be an object keyed by id');
        return {};
    }
    return v;
}

function checkText(path, node, err) {
    if ('label' in node) {
        const problem = labelProblem(node.label);
        if (problem) err(`${path}.label`, problem);
    }
    if ('description' in node && typeof node.description !== 'string') err(`${path}.description`, 'must be a string');
}

function checkCoords(path, node, err, warn) {
    for (const k of ['x', 'y']) {
        if (!(k in node)) warn(`${path}.${k}`, 'missing; read as 0');
        else if (typeof node[k] !== 'number' || !Number.isFinite(node[k])) err(`${path}.${k}`, `${JSON.stringify(node[k])} is not a number`);
    }
    if ('offset' in node && (typeof node.offset !== 'number' || !Number.isFinite(node.offset))) {
        err(`${path}.offset`, `${JSON.stringify(node.offset)} is not a number`);
    }
}

// initial, capacity and weight are per-color vectors of non-negative integers.
// capacity also allows null (unbounded), as does 0. Returns the vector when it
// is one (possibly with bad components, already reported), else null.
function checkVector(path, v, kind, colors, err, warn) {
    const fallback = { initial: '[0]', capacity: 'unbounded', weight: '[1]' }[kind];
    if (v === undefined) {
        warn(path, `missing; read as ${fallback}`);
        return null;
    }
    if (!Array.isArray(v)) {
        if (kind === 'weight' && v === 0) {
            err(path, 'a bare 0 is read as weight [1]');
        } else if (isCount(v) || (kind === 'capacity' && v === null)) {
            warn(path, `a bare value; read as [${v}]`);
        } else {
            err(path, `${JSON.stringify(v)} is not a list of counts`);
        }
        return null;
    }
    if (v.length === 0) {
        // [] is a stored shape: no tokens / unbounded. An empty weight requires nothing.
        if (kind === 'weight') warn(path, 'is empty; the arc requires and moves nothing');
        return v;
    }
    v.forEach((c, i) => {
        if (kind === 'capacity' && c === null) return;
        if (!isCount(c)) {
            const repair = kind === 'weight' ? '; the editor would use weight 1' : '';
            err(`${path}[${i}]`, `${JSON.stringify(c)} is not a non-negative integer${repair}`);
        }
    });
    if (v.length > colors) warn(path, `has ${v.length} components but the net declares ${colors} token color${colors === 1 ? '' : 's'}`);
    return v;
}
