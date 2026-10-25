// petri-draft.js — turn an LLM's draft into a net the editor will load.
//
// The server's /api/llm/draft returns a compact DRAFT (names, ids, counts,
// rates, arcs as from/to, assumptions), never JSON-LD: the model is used
// where judgment is needed, and code writes the format, the coordinates and
// the boilerplate, where an LLM is least reliable. This module is that code:
//
//   validateDraft(draft)  the draft contract: closed keys, types, ids, bounds,
//                         arcs, legal state; every problem at once, with paths
//   draftToNet(draft)     deterministic conversion to the editor's JSON-LD
//                         (same draft → same bytes → same CID)
//   checkDraftNet(net)    the editor's own strict check (validateNet, strict)
//                         and the engine smoke checks on the converted net
//
// Loading happens only if all three pass (docs/design/guided-modelling-slice1.md,
// "Output validation: the load gate"). No DOM; deno tests it directly and the
// editor loads it with a dynamic import.
import { labelProblem, smokeCheck, validateNet } from './petri-validate.js';

export const LIMITS = {
    places: 50, transitions: 50, arcs: 200,
    initial: 1000, totalTokens: 5000,
    description: 300, summary: 500, assumptions: 12, assumption: 300, name: 100,
    rate: 1e6,
};

const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const KEYS = {
    draft: ['name', 'summary', 'places', 'transitions', 'arcs', 'assumptions'],
    place: ['id', 'label', 'description', 'initial', 'capacity'],
    transition: ['id', 'label', 'description', 'rate'],
    arc: ['from', 'to', 'weight', 'inhibitor'],
};

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/**
 * Check a draft against the v1 contract.
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>, warnings: Array<{path: string, message: string}>}}
 */
export function validateDraft(draft) {
    const errors = [];
    const warnings = [];
    const err = (path, message) => errors.push({ path, message });
    const warn = (path, message) => warnings.push({ path, message });
    const closed = (path, obj, keys) => {
        for (const k of Object.keys(obj)) if (!keys.includes(k)) err(`${path}${path ? '.' : ''}${k}`, 'is not part of the draft format');
        for (const k of keys) if (!(k in obj)) err(`${path}${path ? '.' : ''}${k}`, 'is missing');
    };
    const text = (path, v, max, { required = true } = {}) => {
        if (typeof v !== 'string') { if (required || v !== undefined) err(path, 'must be a string'); return; }
        if (v.length > max) err(path, `is over ${max} characters`);
    };

    if (!isObject(draft)) {
        err('', 'the draft is not a JSON object');
        return { ok: false, errors, warnings };
    }
    closed('', draft, KEYS.draft);
    text('name', draft.name, LIMITS.name);
    text('summary', draft.summary, LIMITS.summary);

    const kinds = new Map(); // id -> 'place' | 'transition'
    const list = (key, kind, max) => {
        const v = draft[key];
        if (!Array.isArray(v)) { if (key in draft) err(key, 'must be a list'); return []; }
        if (v.length < 1) err(key, `needs at least one ${kind}`);
        if (v.length > max) err(key, `has ${v.length}; at most ${max}`);
        return v;
    };
    const places = list('places', 'place', LIMITS.places);
    const transitions = list('transitions', 'transition', LIMITS.transitions);

    const checkNode = (path, node, kind) => {
        if (!isObject(node)) { err(path, 'must be an object'); return; }
        closed(path, node, KEYS[kind]);
        // One error per cause: a malformed id still counts as declared, so the
        // arcs that name it are not reported as dangling too.
        const id = node.id;
        if (typeof id === 'string' && kinds.has(id)) {
            err(`${path}.id`, kinds.get(id) === kind ? `"${id}" is used twice` : `"${id}" is already a ${kinds.get(id)}; ids are shared by places and transitions`);
        } else {
            if (typeof id !== 'string' || !ID_RE.test(id)) {
                if ('id' in node) err(`${path}.id`, `${JSON.stringify(id)} is not a snake_case id (a lower-case letter, then a-z, 0-9 or _, at most 40)`);
            } else if (RESERVED.has(id)) {
                err(`${path}.id`, `"${id}" cannot be an id`);
            }
            if (typeof id === 'string') kinds.set(id, kind);
        }
        if ('label' in node) {
            const p = labelProblem(node.label);
            if (p) err(`${path}.label`, p);
        }
        if ('description' in node) text(`${path}.description`, node.description, LIMITS.description);
    };

    let total = 0;
    places.forEach((p, i) => {
        const path = `places[${i}]`;
        checkNode(path, p, 'place');
        if (!isObject(p)) return;
        if (!('initial' in p)) { /* reported as missing */ } else if (!isInt(p.initial) || p.initial < 0) err(`${path}.initial`, 'must be a whole number ≥ 0');
        else if (p.initial > LIMITS.initial) err(`${path}.initial`, `is over ${LIMITS.initial}`);
        else total += p.initial;
        if (!('capacity' in p)) { /* reported as missing */ } else if (!isInt(p.capacity) || p.capacity < 0) err(`${path}.capacity`, 'must be a whole number ≥ 0 (0 = unbounded)');
        else if (isInt(p.initial) && p.capacity > 0 && p.initial > p.capacity) {
            err(`${path}.initial`, `${p.initial} exceeds capacity ${p.capacity}`);
        }
    });
    if (total > LIMITS.totalTokens) err('places', `hold ${total} tokens in all; at most ${LIMITS.totalTokens}`);

    transitions.forEach((t, i) => {
        const path = `transitions[${i}]`;
        checkNode(path, t, 'transition');
        if (!isObject(t)) return;
        if (!('rate' in t)) { /* reported as missing */ } else if (typeof t.rate !== 'number' || !Number.isFinite(t.rate) || t.rate <= 0) err(`${path}.rate`, 'must be a number > 0');
        else if (t.rate > LIMITS.rate) err(`${path}.rate`, `is over ${LIMITS.rate}`);
    });

    const arcs = Array.isArray(draft.arcs) ? draft.arcs : [];
    if ('arcs' in draft && !Array.isArray(draft.arcs)) err('arcs', 'must be a list');
    if (arcs.length > LIMITS.arcs) err('arcs', `has ${arcs.length}; at most ${LIMITS.arcs}`);
    const pairs = new Map();
    const touched = new Set();
    arcs.forEach((a, i) => {
        const path = `arcs[${i}]`;
        if (!isObject(a)) { err(path, 'must be an object'); return; }
        closed(path, a, KEYS.arc);
        let ok = true;
        for (const end of ['from', 'to']) {
            if (typeof a[end] !== 'string' || !kinds.has(a[end])) {
                err(`${path}.${end}`, `${JSON.stringify(a[end])} is not a declared place or transition`);
                ok = false;
            }
        }
        if ('weight' in a && (!isInt(a.weight) || a.weight < 1)) err(`${path}.weight`, 'must be a whole number ≥ 1');
        if ('inhibitor' in a && typeof a.inhibitor !== 'boolean') err(`${path}.inhibitor`, 'must be true or false');
        if (!ok) return;
        const fk = kinds.get(a.from), tk = kinds.get(a.to);
        if (fk === tk) err(path, `joins two ${fk}s (${a.from} → ${a.to}); an arc joins a place and a transition`);
        if (a.inhibitor === true && fk !== 'place') err(`${path}.inhibitor`, 'an inhibitor runs from a place to a transition');
        const key = `${a.from}\u0000${a.to}`;
        if (pairs.has(key)) err(path, `repeats arcs[${pairs.get(key)}] (${a.from} → ${a.to})`);
        else pairs.set(key, i);
        touched.add(a.from);
        touched.add(a.to);
    });

    if (Array.isArray(draft.assumptions)) {
        if (draft.assumptions.length > LIMITS.assumptions) err('assumptions', `has ${draft.assumptions.length}; at most ${LIMITS.assumptions}`);
        draft.assumptions.forEach((s, i) => text(`assumptions[${i}]`, s, LIMITS.assumption));
    } else if ('assumptions' in draft) {
        err('assumptions', 'must be a list of strings');
    }

    if (errors.length === 0) {
        for (const [id, kind] of kinds) {
            if (!touched.has(id)) warn(`${kind}s.${id}`, `no arc touches this ${kind}`);
        }
    }
    return { ok: errors.length === 0, errors, warnings };
}

// Grid spacing before the editor's Sugiyama layout places the nodes properly.
const GRID = { x0: 80, y0: 80, dx: 160, dy: 120, cols: 6 };

/**
 * Convert a valid draft to the editor's JSON-LD, deterministically: the order
 * follows the draft's arrays, coordinates start on a grid, and the draft's
 * rates go onto the transitions (rates are part of the document; ROADMAP
 * phase 0). REVIEW: the slice-1 design kept rates out of the net because the
 * format had no rate term; it has one now.
 */
export function draftToNet(draft) {
    const net = {
        '@context': 'https://pflow.xyz/schema',
        '@type': 'PetriNet',
        '@version': '1.1',
        name: draft.name,
        description: draft.summary,
        token: ['https://pflow.xyz/tokens/black'],
        places: {},
        transitions: {},
        arcs: [],
    };
    let i = 0;
    const at = () => {
        const n = i++;
        return { x: GRID.x0 + (n % GRID.cols) * GRID.dx, y: GRID.y0 + Math.floor(n / GRID.cols) * GRID.dy };
    };
    for (const p of draft.places) {
        net.places[p.id] = {
            '@type': 'Place', label: p.label, description: p.description,
            initial: [p.initial], capacity: [p.capacity === 0 ? null : p.capacity], ...at(), offset: 0,
        };
    }
    for (const t of draft.transitions) {
        net.transitions[t.id] = { '@type': 'Transition', label: t.label, description: t.description, ...at(), rate: t.rate };
    }
    for (const a of draft.arcs) {
        net.arcs.push({ '@type': 'Arrow', source: a.from, target: a.to, weight: [a.weight], inhibitTransition: a.inhibitor });
    }
    return net;
}

/**
 * The converted net through the editor's strict check (unknown keys are
 * errors) and the engine smoke checks.
 * @returns {Promise<{ok: boolean, errors: Array, warnings: Array, cid?: string}>}
 */
export async function checkDraftNet(net) {
    const r = validateNet(net, { strict: true });
    if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings };
    const smoke = await smokeCheck(net);
    return { ok: smoke.ok, errors: smoke.errors, warnings: r.warnings, cid: smoke.cid };
}

/**
 * The whole gate: draft contract → conversion → editor check → engines.
 * @returns {Promise<{ok: boolean, stage: string, errors: Array, warnings: Array, net?: Object, cid?: string}>}
 */
export async function gateDraft(draft) {
    const d = validateDraft(draft);
    if (!d.ok) return { ok: false, stage: 'draft', errors: d.errors, warnings: d.warnings };
    const net = draftToNet(draft);
    const c = await checkDraftNet(net);
    if (!c.ok) return { ok: false, stage: 'net', errors: c.errors, warnings: [...d.warnings, ...c.warnings], net };
    return { ok: true, stage: 'ok', errors: [], warnings: [...d.warnings, ...c.warnings], net, cid: c.cid };
}
