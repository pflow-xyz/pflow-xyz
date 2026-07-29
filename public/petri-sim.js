// petri-sim.js — Pure discrete-event Petri net simulation logic
// No DOM, no side effects. All functions take a model as argument.

/**
 * Get the weight vector for an arc.
 * @param {Object} arc
 * @returns {number[]}
 */
export function getArcWeight(arc) {
    if (arc.weight == null) return [1];
    if (!Array.isArray(arc.weight)) return [Number(arc.weight) || 1];
    // Vector weights preserve explicit zeros: a per-color vector is a
    // deliberate specification, and [0,2] means "color 0 not involved" —
    // the previous `|| 1` silently turned it into [1,2], making a
    // zero-weight color impossible to express. (Scalar 0 still defaults to
    // 1 above: a bare weight of 0 is a degenerate "unspecified".)
    return arc.weight.map(w => {
        const n = Number(w);
        return Number.isFinite(n) ? n : 1;
    });
}

/**
 * Return input arcs (place → transition) for a given transition.
 * @param {Object} model
 * @param {string} tid - transition id
 * @returns {Object[]}
 */
export function inArcsOf(model, tid) {
    return (model.arcs || []).filter(a => a.target === tid);
}

/**
 * Return output arcs (transition → place) for a given transition.
 * @param {Object} model
 * @param {string} tid - transition id
 * @returns {Object[]}
 */
export function outArcsOf(model, tid) {
    return (model.arcs || []).filter(a => a.source === tid);
}

/**
 * Return the capacity vector for a place.
 * capacity=0 is treated as unbounded (Infinity), consistent with
 * standard Petri net convention.
 * @param {Object} model
 * @param {string} pid - place id
 * @returns {number[]}
 */
export function capacityOf(model, pid) {
    const p = model.places[pid];
    if (!p) return [Infinity];
    const arr = Array.isArray(p.capacity) ? p.capacity : [Number(p.capacity ?? Infinity)];
    return arr.map(cap => {
        const c = Number(cap);
        if (!Number.isFinite(c) || c === 0) return Infinity;
        return c;
    });
}

/**
 * Return scalar capacity (first element) for UI display.
 * @param {Object} model
 * @param {string} pid
 * @returns {number}
 */
export function scalarCapacityOf(model, pid) {
    return capacityOf(model, pid)[0];
}

/**
 * Compute the current marking (token state) of the model.
 * @param {Object} model
 * @returns {Object.<string, number[]>}
 */
export function marking(model) {
    const marks = {};
    for (const [pid, p] of Object.entries(model.places)) {
        marks[pid] = Array.isArray(p.initial)
            ? p.initial.map(v => Number(v) || 0)
            : [Number(p.initial || 0)];
    }
    return marks;
}

/**
 * Check whether a transition is enabled under the given marking.
 * @param {Object} model
 * @param {string} tid - transition id
 * @param {Object.<string, number[]>} marks - current marking
 * @returns {boolean}
 */
export function enabled(model, tid, marks) {
    marks = marks || marking(model);

    // input arcs (place -> transition)
    const inA = inArcsOf(model, tid);
    for (const a of inA) {
        const fromPlace = model.places[a.source];
        if (!fromPlace) continue;
        const w = getArcWeight(a);
        const tokens = marks[a.source] ?? [0];

        if (a.inhibitTransition) {
            for (let i = 0; i < Math.max(w.length, tokens.length); i++) {
                const wVal = w[i] ?? 0;
                const tVal = tokens[i] ?? 0;
                if (wVal > 0 && tVal >= wVal) return false;
            }
        }
    }

    // Build map of tokens consumed per place by input arcs
    const consumed = {};
    for (const a of inA) {
        if (a.inhibitTransition) continue;
        if (!model.places[a.source]) continue;
        const w = getArcWeight(a);
        if (!consumed[a.source]) consumed[a.source] = [];
        for (let i = 0; i < w.length; i++) {
            consumed[a.source][i] = (consumed[a.source][i] ?? 0) + (w[i] ?? 0);
        }
    }

    // Token sufficiency is checked against the TOTAL consumed per place, not
    // per arc. Checking arcs independently (the previous behavior) enabled a
    // transition with two weight-2 arcs from a 3-token place; firing then
    // clamped at zero and consumed only 3 — a marking-dependent, nonlinear
    // effect that contradicts the incidence matrix every invariant and
    // analysis result is computed from. Standard Petri net semantics sums
    // the requirement, and firing never needs its clamp. Found by the Go/JS
    // differential test in parity/sim.
    for (const [pid, need] of Object.entries(consumed)) {
        const tokens = marks[pid] ?? [0];
        for (let i = 0; i < Math.max(need.length, tokens.length); i++) {
            if ((tokens[i] ?? 0) < (need[i] ?? 0)) return false;
        }
    }

    // output arcs (transition -> place)
    const outA = outArcsOf(model, tid);
    // Aggregate production per place before the capacity check: two weight-2
    // arcs into a capacity-3 place add 4 tokens, not two independent 2s.
    // Checking each arc alone (the previous behavior) let a single firing
    // push a place past its declared capacity — found by the Go/JS
    // differential test in parity/sim.
    const producedTotal = {};
    for (const a of outA) {
        const toPlace = model.places[a.target];
        if (!toPlace) continue;
        const w = getArcWeight(a);
        const tokens = marks[a.target] ?? [0];

        if (a.inhibitTransition) {
            for (let i = 0; i < Math.max(w.length, tokens.length); i++) {
                const wVal = w[i] ?? 0;
                const tVal = tokens[i] ?? 0;
                if (wVal > 0 && tVal < wVal) return false;
            }
            continue;
        }

        if (!producedTotal[a.target]) producedTotal[a.target] = [];
        for (let i = 0; i < w.length; i++) {
            producedTotal[a.target][i] = (producedTotal[a.target][i] ?? 0) + (w[i] ?? 0);
        }
    }

    for (const [pid, prod] of Object.entries(producedTotal)) {
        const cap = capacityOf(model, pid);
        const tokens = marks[pid] ?? [0];
        const cons = consumed[pid] ?? [];
        for (let i = 0; i < Math.max(prod.length, tokens.length, cap.length); i++) {
            const pVal = prod[i] ?? 0;
            const tVal = tokens[i] ?? 0;
            const cVal = cons[i] ?? 0;
            const capVal = cap[i] ?? Infinity;
            if (tVal - cVal + pVal > capVal) return false;
        }
    }

    return true;
}

/**
 * Fire a transition, returning the new marking or null if not enabled.
 * Pure function — no DOM side effects.
 * @param {Object} model
 * @param {string} tid - transition id
 * @param {Object.<string, number[]>} marks - current marking
 * @returns {Object.<string, number[]>|null} new marking, or null if blocked
 */
export function fire(model, tid, marks) {
    marks = marks || marking(model);
    // Deep-copy marking so caller's object is not mutated
    const m = {};
    for (const k of Object.keys(marks)) {
        m[k] = marks[k].slice();
    }

    if (!enabled(model, tid, m)) return null;

    // Consume tokens from input arcs
    for (const a of inArcsOf(model, tid)) {
        const isPlace = !!model.places[a.source];
        if (!isPlace || a.inhibitTransition) continue;
        const w = getArcWeight(a);
        const tokens = m[a.source] ?? [0];
        m[a.source] = tokens.map((t, i) => Math.max(0, t - (w[i] ?? 0)));
    }

    // Produce tokens on output arcs
    for (const a of outArcsOf(model, tid)) {
        const isPlace = !!model.places[a.target];
        if (!isPlace || a.inhibitTransition) continue;
        const w = getArcWeight(a);
        const tokens = m[a.target] ?? [0];
        const maxLen = Math.max(tokens.length, w.length);
        m[a.target] = Array.from({length: maxLen}, (_, i) =>
            (tokens[i] ?? 0) + (w[i] ?? 0)
        );
    }

    return m;
}

/**
 * Return array of transition IDs that are enabled under the given marking.
 * @param {Object} model
 * @param {Object.<string, number[]>} [marks]
 * @returns {string[]}
 */
export function enabledTransitions(model, marks) {
    marks = marks || marking(model);
    return Object.keys(model.transitions || {}).filter(tid => enabled(model, tid, marks));
}
