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
    return arc.weight.map(w => Number(w) || 1);
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
            continue;
        }

        for (let i = 0; i < Math.max(w.length, tokens.length); i++) {
            const wVal = w[i] ?? 0;
            const tVal = tokens[i] ?? 0;
            if (tVal < wVal) return false;
        }
    }

    // Build map of tokens consumed per place by input arcs
    const consumed = {};
    for (const a of inA) {
        if (a.inhibitTransition) continue;
        const w = getArcWeight(a);
        if (!consumed[a.source]) consumed[a.source] = [];
        for (let i = 0; i < w.length; i++) {
            consumed[a.source][i] = (consumed[a.source][i] ?? 0) + (w[i] ?? 0);
        }
    }

    // output arcs (transition -> place)
    const outA = outArcsOf(model, tid);
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

        const cap = capacityOf(model, a.target);
        const cons = consumed[a.target] ?? [];
        for (let i = 0; i < Math.max(w.length, tokens.length, cap.length); i++) {
            const wVal = w[i] ?? 0;
            const tVal = tokens[i] ?? 0;
            const cVal = cons[i] ?? 0;
            const capVal = cap[i] ?? Infinity;
            if (tVal - cVal + wVal > capVal) return false;
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
