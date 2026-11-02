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
// A step may carry `when: {ref, equals}` (a "$step<N>.<field>" reference and
// the value it must equal): when it does not hold the step is skipped, not
// failed. The knob goal uses it to pick the ODE or the SSA diagnosis by what
// sim.recommend says, so the plan never ranks knobs on an engine the net is
// wrong for.

let catalogPromise = null;

/** The catalog (fetched next to this module in the browser; tests pass it). */
export function loadGoals(fetcher = (u) => fetch(u).then((r) => r.json())) {
    catalogPromise ||= fetcher(new URL('./goals.json', import.meta.url));
    return catalogPromise;
}

const DROP = Symbol('drop');

function resolve(v, ctx) {
    if (typeof v === 'string' && v.startsWith('$')) {
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
            const r = resolve(x, ctx);
            if (r !== DROP) out[k] = r;
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
 * Run a goal's plan. onStep({index, command, args, result | error, artifacts})
 * is called after each step; a failing step stops the plan.
 * @param {Object} registry
 * @param {Object} goal
 * @param {Object} [inputs]
 * @param {(step: Object) => void} [onStep]
 * @returns {Promise<{ok: boolean, steps: Array}>}
 */
export async function runGoal(registry, goal, inputs = {}, onStep = () => {}) {
    if (goal.available === false) throw new Error(goal.caveat || 'not available here');
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
            entry.result = await registry.execute(step.command, entry.args);
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
