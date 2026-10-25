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

/**
 * The rate a transition carries in the document: its `rate` field when that is
 * a finite, non-negative number, otherwise 1.0 (the mass-action default every
 * engine here uses). `rate` is a plain per-transition term; under the sealing
 * context's @vocab it is https://pflow.xyz/schema#rate, so a net that carries
 * no rates seals to the same CID it always did.
 * @param {Object} model
 * @param {string} tid
 * @returns {number}
 */
export function rateOf(model, tid) {
    const r = model.transitions?.[tid]?.rate;
    return typeof r === 'number' && Number.isFinite(r) && r >= 0 ? r : 1.0;
}

/**
 * Every transition's rate (see rateOf), keyed by transition id.
 * @param {Object} model
 * @returns {Object.<string, number>}
 */
export function transitionRates(model) {
    const out = {};
    for (const tid of Object.keys(model.transitions || {})) out[tid] = rateOf(model, tid);
    return out;
}

/**
 * Write rates into the model's transitions, in place. A transition gains a
 * `rate` field only when its rate changes, so a net whose rates were never
 * touched stays byte-identical (and keeps its CID). Unknown ids, and values
 * that are not finite and non-negative, are ignored.
 * @param {Object} model
 * @param {Object.<string, number>} rates
 * @returns {string[]} the ids whose rate changed
 */
export function setTransitionRates(model, rates) {
    const changed = [];
    for (const [tid, v] of Object.entries(rates || {})) {
        const t = model.transitions?.[tid];
        if (!t || typeof v !== 'number' || !Number.isFinite(v) || v < 0) continue;
        if (rateOf(model, tid) === v) continue;
        t.rate = v;
        changed.push(tid);
    }
    return changed;
}

/**
 * Fill a net's defaults and repair what the editor can read, in place, and
 * return it. This is the editor's tolerant reading: a missing vector gets its
 * default, a bad number becomes 0 (or weight 1), capacity 0/null becomes
 * unbounded (Infinity) and an initial marking over capacity is clamped.
 * petri-validate.js reports each of those repairs instead of making them.
 * @param {Object} [m]
 * @returns {Object} m
 */
export function normalizeModel(m) {
    m = m || {};
    m['@context'] ||= 'https://pflow.xyz/schema';
    m['@type'] ||= 'PetriNet';
    m['@version'] ||= '1.1'; // <-- added default version
    m.token ||= ['https://pflow.xyz/tokens/black'];
    m.places ||= {};
    m.transitions ||= {};
    m.arcs ||= [];

    for (const [id, p] of Object.entries(m.places)) {
        p['@type'] ||= 'Place';

        // offsets/coords
        p.offset = Number.isFinite(p.offset) ? Number(p.offset) : Number(p.offset ?? 0);
        p.x = Number.isFinite(p.x) ? Number(p.x) : Number(p.x || 0);
        p.y = Number.isFinite(p.y) ? Number(p.y) : Number(p.y || 0);

        // initial: allow 0, coerce safely
        if (!Array.isArray(p.initial)) p.initial = [p.initial];
        p.initial = p.initial.map(v => {
            const n = (typeof v === 'string' && v.trim() === '') ? 0 : Number(v);
            return Number.isFinite(n) ? n : 0;
        });

        // capacity: null/undefined/0 => Infinity (unbounded).
        // capacity=0 means unbounded per standard Petri net convention.
        if (!Array.isArray(p.capacity)) p.capacity = [p.capacity];
        p.capacity = p.capacity.map(v => {
            if (v === null || v === undefined) return Infinity;
            const n = Number(v);
            if (!Number.isFinite(n) || n === 0) return Infinity;
            return n;
        });

        // Validate: initial tokens should not exceed capacity for each color
        // Clamp initial tokens to capacity to fix invalid states
        const maxLen = Math.max(p.initial.length, p.capacity.length);
        while (p.initial.length < maxLen) p.initial.push(0);
        while (p.capacity.length < maxLen) p.capacity.push(Infinity);

        for (let i = 0; i < maxLen; i++) {
            const cap = p.capacity[i];
            if (Number.isFinite(cap) && p.initial[i] > cap) {
                console.warn(`Place ${id}: initial[${i}]=${p.initial[i]} exceeds capacity[${i}]=${cap}. Clamping to capacity.`);
                p.initial[i] = cap;
            }
        }
    }


    for (const [id, t] of Object.entries(m.transitions)) {
        t['@type'] ||= 'Transition';
        t.x = Number(t.x || 0);
        t.y = Number(t.y || 0);
    }
    for (const a of m.arcs) {
        a['@type'] ||= 'Arrow';
        if (a.weight == null) a.weight = [1];
        if (!Array.isArray(a.weight)) a.weight = [Number(a.weight) || 1];
        // Vector components preserve explicit 0 ("this color is not
        // involved") — the engine contract petri-sim.js:getArcWeight and
        // the parity suite rely on; only a scalar weight of 0 defaults to 1
        // (handled above).
        a.weight = a.weight.map(w => {
            const n = Number(w);
            return Number.isFinite(n) && n >= 0 ? n : 1;
        });
        a.inhibitTransition = !!a.inhibitTransition;
    }
    return m;
}
