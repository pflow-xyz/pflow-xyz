// petri-goals.js — the goal advisor's runner (ROADMAP phase 5), no DOM.
//
// public/goals.json maps what people want to know ("can it get stuck?") to a
// plan of registry commands. This module loads the catalog, resolves a plan's
// references and runs it step by step through a registry, so the picker
// (petri-goals-ui.js), the tests and anything else run a goal the same way.
//
// References in a step's args:
//   "$input.<name>"     a value the person gave (blank optional inputs drop
//                       the argument altogether)
//   "$step<N>.<field>"  a field of an earlier step's result

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
 * @returns {Promise<{ok: boolean, steps: Array}>}
 */
export async function runGoal(registry, goal, inputs = {}, onStep = () => {}) {
    if (goal.available === false) throw new Error(goal.caveat || 'not available here');
    const filled = { ...inputs };
    for (const i of goal.inputs || []) if ((filled[i.name] === undefined || filled[i.name] === '') && i.default !== undefined) filled[i.name] = i.default;
    const missing = missingInputs(goal, filled);
    if (missing.length) throw new Error(`needs ${missing.map((i) => i.label || i.name).join(', ')}`);
    const ctx = { inputs: filled, results: [] };
    const steps = [];
    for (let index = 0; index < goal.plan.length; index++) {
        const step = goal.plan[index];
        const entry = { index, command: step.command };
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
