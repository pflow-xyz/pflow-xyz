/**
 * petri-colors.js — colored-net unfolding, the JS side of the Go/JS contract.
 *
 * This is a direct port of go-pflow's petri/colors.go. Every rule here has a
 * counterpart there, and parity/ode + parity/sim assert the two agree; if you
 * change one, change both and run `make parity`.
 *
 * A place's `initial` and `capacity` and an arc's `weight` are vectors with one
 * component per token color (named by the model's `token` array). The semantics
 * are component-wise: a red arc weight is satisfied by red tokens only, never
 * by a summed pool. `expandColors` implements that once, as the standard
 * colored-net unfolding — each place becomes one place per color
 * ("pool.red", "pool.blue"), each arc becomes one arc per non-zero weight
 * component, and transitions are shared so a firing still moves every color
 * atomically.
 *
 * Because the unfolding is a plain Petri net, anything that works on a
 * single-color net works on it unchanged and with exact per-color semantics.
 */

/**
 * ColorRef identifies one color component of a base place.
 * @typedef {{place: string, color: number}} ColorRef
 */

/**
 * ColorMap records how a multi-color net was unfolded by expandColors.
 * Mirrors go-pflow's petri.ColorMap.
 */
export class ColorMap {
  /**
   * @param {string[]} colors - color names, index-aligned with the per-color vectors
   * @param {Map<string, string[]>} expanded - base place -> expanded names, in color order
   * @param {Map<string, ColorRef>} base - expanded name -> {place, color}
   */
  constructor(colors, expanded, base) {
    this.colors = colors;
    this.expanded = expanded;
    this.base = base;
  }

  /**
   * Expanded place names for a base place, in color order. A name that is
   * already expanded (or unknown) returns itself as a single-element array, so
   * callers can treat every name uniformly.
   * @param {string} name
   * @returns {string[]}
   */
  lookup(name) {
    return this.expanded.get(name) ?? [name];
  }

  /**
   * Base place and color name for an expanded place. Returns the input
   * unchanged with ok=false when it is not an expanded name.
   * @param {string} expanded
   * @returns {{place: string, color: string, ok: boolean}}
   */
  baseName(expanded) {
    const ref = this.base.get(expanded);
    if (!ref) return { place: expanded, color: "", ok: false };
    return { place: ref.place, color: this.colors[ref.color], ok: true };
  }

  /**
   * Fold a state/marking over expanded places back to per-base-place totals —
   * the scalar projection, useful for reporting. Keys that are not expanded
   * names pass through.
   * @param {Object<string, number>} state
   * @returns {Object<string, number>}
   */
  sumByBase(state) {
    const out = {};
    for (const [name, v] of Object.entries(state)) {
      const ref = this.base.get(name);
      const key = ref ? ref.place : name;
      out[key] = (out[key] ?? 0) + v;
    }
    return out;
  }
}

/**
 * Number of token colors the net uses: the longest vector found across
 * declared token names, place initials/capacities, and arc weights.
 * @param {import('./petri-solver.js').PetriNet} net
 * @returns {number}
 */
export function colorCount(net) {
  let c = net.token ? net.token.length : 0;
  for (const p of net.places.values()) {
    if (p.initial.length > c) c = p.initial.length;
    if (p.capacity.length > c) c = p.capacity.length;
  }
  for (const a of net.arcs) {
    if (a.weight.length > c) c = a.weight.length;
  }
  return c;
}

/**
 * Whether the net uses more than one token color — i.e. any place
 * initial/capacity vector or arc weight vector has more than one component, or
 * more than one token color is declared.
 * @param {import('./petri-solver.js').PetriNet} net
 * @returns {boolean}
 */
export function isMultiColor(net) {
  if (net.token && net.token.length > 1) return true;
  for (const p of net.places.values()) {
    if (p.initial.length > 1 || p.capacity.length > 1) return true;
  }
  for (const a of net.arcs) {
    if (a.weight.length > 1) return true;
  }
  return false;
}

/**
 * Unfold a multi-color net into an equivalent single-color net.
 *
 * The rules reproduced are exactly the component-wise ones petri-sim.js
 * applies natively:
 *
 *   - a color index beyond a place's initial vector holds zero tokens;
 *   - a color index beyond an arc's weight vector imposes no requirement and
 *     moves nothing (the arc is simply not created for that color);
 *   - a color index beyond a place's capacity vector is unbounded, and a
 *     capacity component of zero means unbounded.
 *
 * Color names come from net.token where declared, else "c0", "c1", …. If an
 * expanded name would collide with an existing place, the separator is doubled
 * until unique ("pool.red" -> "pool..red").
 *
 * Single-color nets are returned as-is with a null colorMap: callers can treat
 * "colorMap == null" as "nothing was expanded".
 *
 * @param {import('./petri-solver.js').PetriNet} net
 * @returns {{net: import('./petri-solver.js').PetriNet, colorMap: ColorMap|null}}
 */
export function expandColors(net) {
  const colors = colorCount(net);
  if (colors <= 1) return { net, colorMap: null };

  const names = [];
  for (let i = 0; i < colors; i++) {
    const declared = net.token && net.token[i];
    names.push(declared ? declared : `c${i}`);
  }

  // Choose a separator that cannot collide with existing place names.
  let sep = ".";
  for (;;) {
    let collision = false;
    for (const base of net.places.keys()) {
      for (const c of names) {
        if (net.places.has(base + sep + c)) collision = true;
      }
    }
    if (!collision) break;
    sep += ".";
  }

  const expanded = new Map();
  const base = new Map();

  // Build the output with the same class the input uses, so this module needs
  // no import from petri-solver.js and the two cannot form an import cycle.
  const out = new net.constructor();
  out.token = []; // the unfolded net is single-color by construction

  for (const [baseLabel, p] of net.places) {
    const expandedNames = [];
    for (let i = 0; i < colors; i++) {
      const name = baseLabel + sep + names[i];
      expandedNames.push(name);
      base.set(name, { place: baseLabel, color: i });

      const initial = i < p.initial.length ? p.initial[i] : 0;
      // A missing or zero capacity component is unbounded, which this format
      // spells as "no capacity declared".
      const capacity = i < p.capacity.length && p.capacity[i] > 0 ? [p.capacity[i]] : [];
      out.addPlace(name, [initial], capacity, p.x, p.y, p.labelText);
    }
    expanded.set(baseLabel, expandedNames);
  }

  for (const [label, t] of net.transitions) {
    out.addTransition(label, t.role, t.x, t.y, t.labelText);
  }

  for (const a of net.arcs) {
    // Weight defaults to [1] when empty, matching getWeightSum and the
    // getArcWeight helper in petri-sim.js.
    const w = a.weight.length === 0 ? [1] : a.weight;

    const sourceIsPlace = net.places.has(a.source);
    const targetIsPlace = net.places.has(a.target);

    for (let i = 0; i < w.length; i++) {
      const wi = w[i];
      if (wi === 0 || i >= colors) continue;
      const src = sourceIsPlace ? expanded.get(a.source)[i] : a.source;
      const dst = targetIsPlace ? expanded.get(a.target)[i] : a.target;
      out.addArc(src, dst, [wi], a.inhibitTransition);
    }
  }

  return { net: out, colorMap: new ColorMap(names, expanded, base) };
}

/**
 * Map a state vector keyed by this (multi-color) net's place names onto the
 * place names of its expandColors unfolding.
 *
 * Expanded keys ("pool.red") pass through untouched and pin one color. A base
 * key ("pool") carries a TOTAL across colors — the shape setState and
 * Place.getTokenCount produce — and is distributed across that place's colors
 * in the proportions of its declared initial vector. When the declared vector
 * is empty or sums to zero there are no proportions to follow, so the whole
 * total goes to color 0.
 *
 * The rule is chosen so the common call is exact: expandState(net,
 * setState(net)) reproduces each place's declared per-color initial vector
 * componentwise. Scaling a base total scales every color by the same factor.
 *
 * Returns state unchanged on a single-color net, and is idempotent.
 *
 * @param {import('./petri-solver.js').PetriNet} net
 * @param {Object<string, number>} state
 * @returns {Object<string, number>}
 */
export function expandState(net, state) {
  const { colorMap } = expandColors(net);
  if (colorMap === null) return state;

  const out = {};
  for (const [name, total] of Object.entries(state)) {
    const p = net.places.get(name);
    if (!p) {
      // Already expanded, or not a place at all — pass through.
      out[name] = total;
      continue;
    }
    const expandedNames = colorMap.expanded.get(name);

    let declared = 0;
    for (const v of p.initial) declared += v;

    if (declared === 0) {
      expandedNames.forEach((en, i) => {
        out[en] = i === 0 ? total : 0;
      });
      continue;
    }
    expandedNames.forEach((en, i) => {
      const share = i < p.initial.length ? p.initial[i] : 0;
      out[en] = (total * share) / declared;
    });
  }
  return out;
}
