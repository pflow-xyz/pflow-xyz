// petri-goals.js — the goal advisor's runner (ROADMAP phase 5), no DOM.
//
// public/goals.json maps what people want to know ("can it get stuck?") to a
// plan of registry commands. This module loads the catalog, resolves a plan's
// references and runs it step by step through a registry, so the picker
// (petri-goals-ui.js), the tests and anything else run a goal the same way.
//
// An input of kind "json" (the game rules: who moves, what pays) is typed
// as JSON text; runGoal parses it before the plan runs, so the picker passes
// the text as is and a caller may pass the value itself.
//
// References in a step's args:
//   "$input.<name>"     a value the person gave (blank optional inputs drop
//                       the argument altogether)
//   "$step<N>.<field>"  a field of an earlier step's result
//
// A reference to a number may be scaled: "$input.max_rate*0.25". An object key
// may be a reference too ({"$input.transition": 0.5}), for a scenario's rates.
//
// A step may carry `when: {ref, equals}` (a "$step<N>.<field>" reference and
// the value it must equal): when it does not hold the step is skipped, not
// failed. The knob, average and best_setting goals use it to pick the ODE or
// the SSA version of their step by what sim.recommend says, so the plan never
// runs an engine the net is wrong for.
//
// Whatever the plan says, the engine guard (petri-engine-guard.js) has the
// last word: a step whose command the recommendation rules out is refused
// before it runs (entry.refused), and a step that runs on an engine the
// recommendation did not pick carries a warning (entry.warning). The guard is
// on unless opts.guard is false.

import { EngineGuard } from './petri-engine-guard.js';

let catalogPromise = null;

/** The catalog (fetched next to this module in the browser; tests pass it). */
export function loadGoals(fetcher = (u) => fetch(u).then((r) => r.json())) {
    catalogPromise ||= fetcher(new URL('./goals.json', import.meta.url));
    return catalogPromise;
}

const DROP = Symbol('drop');

// "$input.max_rate*0.25": a reference to a number times a literal.
const SCALED = /^(\$[^*\s]+)\*(-?\d+(?:\.\d+)?)$/;

function resolve(v, ctx) {
    if (typeof v === 'string' && v.startsWith('$')) {
        const scaled = SCALED.exec(v);
        if (scaled) {
            const base = resolve(scaled[1], ctx);
            if (base === DROP) return DROP;
            const n = typeof base === 'string' && base.trim() !== '' ? Number(base) : base; // a number typed into a field
            if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${v}: ${scaled[1]} is not a number`);
            return n * Number(scaled[2]);
        }
        const [head, ...path] = v.slice(1).split('.');
        let cur;
        if (head === 'input') {
            cur = ctx.inputs;
        } else if (/^step\d+$/.test(head)) {
            cur = ctx.results[+head.slice(4)];
            if (cur === undefined) throw new Error(`${v}: step ${head.slice(4)} has not run`);
        } else {
            throw new Error(`${v}: unknown reference`);
        }
        for (const k of path) cur = cur == null ? undefined : cur[k];
        if (cur === undefined || cur === '' || cur === null) {
            if (head === 'input') return DROP; // an optional input left blank
            throw new Error(`${v} is missing`);
        }
        return cur;
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, ctx)).filter((x) => x !== DROP);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            const key = k.startsWith('$') ? resolve(k, ctx) : k;
            if (key === DROP) continue;
            if (typeof key !== 'string' && typeof key !== 'number') throw new Error(`${k}: a key must resolve to a name`);
            const r = resolve(x, ctx);
            if (r !== DROP) out[key] = r;
        }
        return out;
    }
    return v;
}

/** A plan step's args with every reference filled in. */
export function resolveArgs(args, ctx) {
    return resolve(args || {}, ctx);
}

/** Inputs the goal needs that the person has not given. */
export function missingInputs(goal, inputs) {
    return (goal.inputs || []).filter((i) => !i.optional && i.default === undefined && (inputs[i.name] === undefined || inputs[i.name] === ''));
}

/**
 * Run a goal's plan. onStep({index, command, args, result | error | refused,
 * warning, artifacts}) is called after each step; a failing or refused step
 * stops the plan.
 *
 * The engine guard checks every step before it runs. A step it refuses gets
 * `refused: {rule, message, recommended}` (and the message as `error`, for
 * callers that only read errors); nothing ran, and the plan stops with ok:
 * false. A step it lets through with a caution runs and carries `warning`.
 * @param {Object} registry
 * @param {Object} goal
 * @param {Object} [inputs]
 * @param {(step: Object) => void} [onStep]
 * @param {Object} [opts]
 * @param {Object|false} [opts.guard]  an EngineGuard-like ({check, prime?}) to use; false turns the guard off (tests)
 * @param {string} [opts.override]     the engine the caller asks for against the recommendation ('ode'); honoured only when userText names it
 * @param {string} [opts.userText]     the person's own words, which decide whether the override counts
 * @returns {Promise<{ok: boolean, steps: Array}>}
 */
export async function runGoal(registry, goal, inputs = {}, onStep = () => {}, opts = {}) {
    if (goal.available === false) throw new Error(goal.caveat || 'not available here');
    const guard = opts.guard === false ? null : (opts.guard || new EngineGuard(registry));
    const filled = { ...inputs };
    for (const i of goal.inputs || []) if (i.kind === 'json' && typeof filled[i.name] === 'string' && !filled[i.name].trim()) filled[i.name] = ''; // blank text
    for (const i of goal.inputs || []) if ((filled[i.name] === undefined || filled[i.name] === '') && i.default !== undefined) filled[i.name] = i.default;
    const missing = missingInputs(goal, filled);
    if (missing.length) throw new Error(`needs ${missing.map((i) => i.label || i.name).join(', ')}`);
    for (const i of goal.inputs || []) {
        if (i.kind !== 'json' || typeof filled[i.name] !== 'string' || filled[i.name] === '') continue;
        try { filled[i.name] = JSON.parse(filled[i.name]); } catch (e) { throw new Error(`${i.label || i.name}: not valid JSON (${e.message})`); }
    }
    const ctx = { inputs: filled, results: [] };
    const steps = [];
    for (let index = 0; index < goal.plan.length; index++) {
        const step = goal.plan[index];
        const entry = { index, command: step.command };
        if (step.when) {
            let got;
            try { got = resolveArgs({ v: step.when.ref }, ctx).v; } catch { got = undefined; }
            if (got !== step.when.equals) {
                entry.skipped = `only when ${step.when.ref} is ${JSON.stringify(step.when.equals)} (it is ${JSON.stringify(got)})`;
                steps.push(entry);
                onStep(entry);
                continue;
            }
        }
        const before = new Set(registry.artifacts().map((a) => a.id));
        try {
            entry.args = resolveArgs(step.args, ctx);
            if (guard) {
                const v = await guard.check(step.command, entry.args, { override: opts.override, userText: opts.userText });
                if (v.verdict === 'refuse') {
                    entry.refused = { rule: v.rule, message: v.message, recommended: v.recommended };
                    entry.error = `refused: ${v.message}`;
                    steps.push(entry);
                    onStep(entry);
                    return { ok: false, steps };
                }
                if (v.verdict === 'warn') entry.warning = v.message;
            }
            entry.result = await registry.execute(step.command, entry.args);
            // The plan ran sim.recommend itself: the guard need not run it again for this net.
            if (step.command === 'sim.recommend') guard?.prime?.(entry.result);
            entry.artifacts = registry.artifacts().filter((a) => !before.has(a.id)).map((a) => a.id);
            ctx.results[index] = entry.result;
        } catch (e) {
            entry.error = e.message || String(e);
            steps.push(entry);
            onStep(entry);
            return { ok: false, steps };
        }
        steps.push(entry);
        onStep(entry);
    }
    return { ok: true, steps };
}

/**
 * Goals ranked by how well their phrases match the person's words (no LLM:
 * the picker's search box). Ties keep catalog order.
 */
export function matchGoals(catalog, text) {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return catalog.goals;
    const score = (g) => [g.question, ...(g.phrases || [])].reduce((s, p) => s + (t.includes(p.toLowerCase()) ? p.length : 0), 0)
        + t.split(/\W+/).filter((w) => w.length > 3 && g.question.toLowerCase().includes(w)).length;
    return catalog.goals.map((g, i) => [g, score(g), i]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(([g]) => g);
}

// ---- reading the outcome off the question ----

const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '');

/**
 * The place a question is about, or '' (no LLM). A word of the question that
 * names a place picks it; one that names a transition ("walkouts" → walk_out)
 * picks the sink that transition produces ("abandoned"). A model's own words
 * decide, so there is no word list to go stale.
 * @param {{places: Object, transitions: Object, arcs: Array}} model
 * @param {string} text
 * @returns {string}
 */
export function inferPlace(model, text) {
    const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4)
        .filter((w) => !['which', 'knob', 'knobs', 'matters', 'matter', 'what', 'does', 'most', 'when', 'with', 'that', 'this', 'about', 'much', 'more', 'have', 'should', 'would', 'could'].includes(w));
    const hits = (names) => {
        for (const w of words) {
            const st = stem(w);
            if (st.length < 3) continue;
            const found = names.find((n) => { const k = norm(n); return k === norm(w) || k.includes(st) || (k.length >= 4 && st.includes(stem(k))); });
            if (found) return found;
        }
        return '';
    };
    const places = Object.keys(model.places || {});
    const direct = hits(places);
    if (direct) return direct;
    const t = hits(Object.keys(model.transitions || {}));
    if (!t) return '';
    const outs = (model.arcs || []).filter((a) => a.source === t && model.places?.[a.target]).map((a) => a.target);
    const consumed = new Set((model.arcs || []).filter((a) => model.places?.[a.source] && !a.inhibitTransition).map((a) => a.source));
    return outs.find((p) => !consumed.has(p)) || outs[0] || '';
}
