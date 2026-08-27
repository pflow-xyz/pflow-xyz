/**
 * petri-learn.js - Differentiable fitting for Petri-net ODE models.
 *
 * A faithful JS mirror of go-pflow's `learn` package (v0.25.0):
 *
 *   - LearnableProblem / solveWithSensitivities: forward sensitivities as one
 *     augmented ODE (dx/dt = f, dS/dt = J·S + df/dθ) with the analytic
 *     Jacobian and df/dθ, mirroring learn/sensitivity.go — including the
 *     input clamp (any input place <= 0 turns the transition OFF with
 *     subgradient zero), the negative-flux clamp (flux < 0: off, subgradient
 *     zero) and the DELIBERATE one-sided derivative at flux == 0 (k == 0 with
 *     all inputs > 0 keeps its derivative terms, so an optimizer can move a
 *     rate off the k = 0 boundary).
 *   - Tied parameters: install the SAME rate-function object at several
 *     transitions (see SharedScalar) and its θ is packed ONCE; every tied
 *     transition's ∂flux/∂θ accumulates into the shared column.
 *   - mseLossGrad / rmseLossGrad / relativeMseLossGrad: gradient-carrying
 *     losses matching learn/lossgrad.go interpolation semantics exactly.
 *   - adamMinimize / minimizeGradient / descentBacktracking: learn/gradopt.go.
 *   - nelderMead / coordinateDescent / minimize: learn/optimize.go +
 *     learn/minimize.go.
 *   - hingeRankLoss: learn/ranking.go.
 *   - fit / fitGradient / fitRates: learn.Fit's surface.
 *   - LearnableProblem.solveAdjoint / mseLossAdjoint / relativeMseLossAdjoint:
 *     reverse-mode (adjoint) sensitivities, mirroring learn/adjoint.go — one
 *     backward solve yields the full parameter gradient regardless of
 *     parameter count, the tool for a many-parameter rate where forward
 *     mode's n*P augmented states would dominate the cost. Same clamp
 *     conventions as forward mode; deliberately no RMSE adjoint (sqrt after
 *     the sum does not decompose pointwise — fit MSE, report its root).
 *
 * Parity note: the arithmetic here is expression-for-expression identical to
 * the Go code, so results are bit-identical wherever the summation order can
 * be made identical. Go iterates its maps in randomized order; JS iterates
 * insertion order. Floating-point addition is commutative, so any sum of at
 * most two independently-ordered contributions is still bit-exact; a place
 * (or sensitivity row) touched by three or more flux terms from different
 * transitions is where Go's own runs differ from each other in the last bit
 * (see parity/learn).
 *
 * Vanilla ES module, stdlib only. Imports ./petri-solver.js (canonical solver
 * — unchanged by this module) and ./petri-colors.js.
 */

import { solve, Tsit5, ODESolution, setState, setRates } from './petri-solver.js';
import { expandColors, expandState } from './petri-colors.js';

// ============================================================================
// Solver options
// ============================================================================

/**
 * Mirror of go-pflow solver.JSParityOptions(): the stepping options both
 * sides use when results must match bit-for-bit. (The JS solver's built-in
 * defaults differ only in dtmax: 0.1 vs 1.0 here.)
 */
export function jsParityOptions() {
  return {
    dt: 0.01,
    dtmin: 1e-6,
    dtmax: 1.0,
    abstol: 1e-6,
    reltol: 1e-3,
    maxiters: 100000,
    adaptive: true,
  };
}

/** Mirror of solver.DefaultOptions() (identical to the JS solver defaults). */
export function defaultSolverOptions() {
  return {
    dt: 0.01,
    dtmin: 1e-6,
    dtmax: 0.1,
    abstol: 1e-6,
    reltol: 1e-3,
    maxiters: 100000,
    adaptive: true,
  };
}

// ============================================================================
// Bit-exact integer pow (Go math.Pow's integer-exponent path)
// ============================================================================
//
// V8's Math.pow and Go's math.Pow disagree by 1-2 ulp (measured; Go's
// fractional-exponent path even runs CPU-dependent SLEEF assembly on amd64).
// Adam's bias correction pow(β, t) uses an INTEGER exponent, which Go computes
// by pure repeated squaring over frexp/ldexp — fully portable. These are
// faithful ports of Go's math.frexp / math.ldexp / the integer branch of
// math.pow, so adamMinimize below is bit-identical to learn.adamMinimize.

const _f64buf = new DataView(new ArrayBuffer(8));

/** Go math.Frexp for finite non-zero x: frac in ±[0.5, 1), exp. */
function goFrexp(x) {
  _f64buf.setFloat64(0, x);
  let hi = _f64buf.getUint32(0);
  let e = (hi >>> 20) & 0x7ff;
  if (e === 0) {
    // Subnormal: normalize by 2^52 first (Go's normalize).
    _f64buf.setFloat64(0, x * 4503599627370496); // 2^52
    hi = _f64buf.getUint32(0);
    e = ((hi >>> 20) & 0x7ff) - 52;
  }
  const exp = e - 1022; // e - bias + 1
  hi = (hi & 0x800fffff) | (1022 << 20); // exponent field = bias - 1
  _f64buf.setUint32(0, hi);
  return [_f64buf.getFloat64(0), exp];
}

/** Go math.Ldexp: frac × 2^exp with Go's exact overflow/subnormal handling. */
function goLdexp(frac, exp) {
  if (frac === 0 || !Number.isFinite(frac)) return frac;
  if (Math.abs(frac) < 2.2250738585072014e-308) { // < SmallestNormal
    frac *= 4503599627370496; // 2^52
    exp -= 52;
  }
  _f64buf.setFloat64(0, frac);
  let hi = _f64buf.getUint32(0);
  exp += ((hi >>> 20) & 0x7ff) - 1023;
  if (exp < -1075) return frac < 0 || Object.is(frac, -0) ? -0 : 0;
  if (exp > 1023) return frac < 0 ? -Infinity : Infinity;
  let m = 1;
  if (exp < -1022) { // result is subnormal
    exp += 53;
    m = 1.1102230246251565e-16; // 1 / 2^53
  }
  hi = (hi & 0x800fffff) | ((exp + 1023) << 20);
  _f64buf.setUint32(0, hi);
  return m * _f64buf.getFloat64(0);
}

/**
 * Go math.Pow for finite x > 0 and non-negative SAFE-integer y: repeated
 * squaring over frexp/ldexp, bit-identical to Go's pow() on this input
 * domain (the only one Adam needs). Exported for tests.
 */
export function goPowInt(x, y) {
  if (y === 0 || x === 1) return 1;
  if (y === 1) return x;
  if (!(x > 0) || !Number.isFinite(x) || !Number.isSafeInteger(y) || y < 0) {
    throw new Error(`goPowInt: unsupported input (${x}, ${y})`);
  }
  let a1 = 1.0;
  let ae = 0;
  let [x1, xe] = goFrexp(x);
  for (let i = y; i !== 0; i = Math.floor(i / 2)) {
    if (xe < -4096 || 4096 < xe) {
      ae += xe;
      break;
    }
    if (i % 2 === 1) {
      a1 *= x1;
      ae += xe;
    }
    x1 *= x1;
    xe *= 2;
    if (x1 < 0.5) {
      x1 += x1;
      xe--;
    }
  }
  return goLdexp(a1, ae);
}

// ============================================================================
// Rate functions (learn/gradrate.go, learn/tied.go)
// ============================================================================

/**
 * ScalarRateFunc: a learnable constant rate k = θ₀, one parameter.
 * Mirror of learn.ScalarRateFunc.
 */
export class ScalarRateFunc {
  constructor(rate) {
    this.params = [rate];
  }
  eval(_state, _t) { return this.params[0]; }
  getParams() { return this.params; }
  setParams(params) {
    if (params.length !== 1) throw new Error('params length must match numParams()');
    this.params[0] = params[0];
  }
  numParams() { return 1; }
  /** (θ₀, [1], null): unit derivative in its one parameter, no state deps. */
  evalGrad(_state, _t) { return [this.params[0], [1], null]; }
}

/**
 * SharedScalar: a learnable constant rate whose single parameter is SHARED —
 * install the same instance at every transition it drives. getAllParams packs
 * its θ once; each tied transition's ∂flux/∂θ sums into that one slot.
 * Mirror of learn.SharedScalar.
 */
export class SharedScalar {
  constructor(rate) {
    this.params = [rate];
  }
  eval(_state, _t) { return this.params[0]; }
  getParams() { return this.params; }
  setParams(params) {
    if (params.length !== 1) throw new Error('params length must match numParams()');
    this.params[0] = params[0];
  }
  numParams() { return 1; }
  evalGrad(_state, _t) { return [this.params[0], [1], null]; }
  value() { return this.params[0]; }
  set(v) { this.params[0] = v; }
}

/**
 * Wrap a solver-style rates map (transition -> number) in learnable scalar
 * rates, one parameter per transition. Mirror of learn.RateFuncsFromRates.
 */
export function rateFuncsFromRates(rates) {
  const out = {};
  for (const [name, rate] of Object.entries(rates)) {
    out[name] = new ScalarRateFunc(rate);
  }
  return out;
}

/**
 * Central finite differences of eval ALONE, for a rate function without
 * evalGrad. Mirror of learn.fdRateGrad: params restored exactly, state
 * perturbed on a copy.
 */
export function fdRateGrad(rf, state, t) {
  const k = rf.eval(state, t);

  const nP = rf.numParams();
  const dParams = new Array(nP).fill(0);
  if (nP > 0) {
    const orig = rf.getParams().slice();
    const work = orig.slice();
    for (let j = 0; j < nP; j++) {
      const h = 1e-6 * (1 + Math.abs(orig[j]));
      work[j] = orig[j] + h;
      rf.setParams(work);
      const kp = rf.eval(state, t);
      work[j] = orig[j] - h;
      rf.setParams(work);
      const km = rf.eval(state, t);
      work[j] = orig[j];
      dParams[j] = (kp - km) / (2 * h);
    }
    rf.setParams(orig);
  }

  let dState = null;
  const labels = Object.keys(state);
  if (labels.length > 0) {
    dState = {};
    const pert = { ...state };
    for (const label of labels) {
      const v = state[label];
      const h = 1e-6 * (1 + Math.abs(v));
      pert[label] = v + h;
      const kp = rf.eval(pert, t);
      pert[label] = v - h;
      const km = rf.eval(pert, t);
      pert[label] = v;
      dState[label] = (kp - km) / (2 * h);
    }
  }

  return [k, dParams, dState];
}

// ============================================================================
// LearnableProblem (learn/problem.go)
// ============================================================================

/** colorMap-aware label lookup: nil map means the label is itself. */
function lookupLabels(colorMap, label) {
  return colorMap ? colorMap.lookup(label) : [label];
}

/**
 * LearnableProblem wraps a Petri net with learnable rate functions.
 * Mirror of learn.LearnableProblem / NewLearnableProblem: multi-color nets
 * are unfolded (expandColors) and the initial state mapped through
 * expandState, so dynamics are per color.
 *
 * @param {PetriNet} net
 * @param {Object<string,number>} initialState
 * @param {[number, number]} tspan
 * @param {Object<string, {eval,getParams,setParams,numParams,evalGrad?}>} rateFuncs
 */
export class LearnableProblem {
  constructor(net, initialState, tspan, rateFuncs) {
    const { net: expanded, colorMap } = expandColors(net);
    if (colorMap !== null) {
      initialState = expandState(net, initialState);
      net = expanded;
    }
    this.net = net;
    this.colorMap = colorMap;
    this.u0 = initialState;
    this.tspan = tspan;
    this.rateFuncs = rateFuncs;
    this.stateLabels = Object.keys(initialState);
  }

  /** Mirror of LearnableProblem.BuildODEFunc: mass action over learnable rates. */
  buildODEFunc() {
    const net = this.net;
    const rateFuncs = this.rateFuncs;
    return (t, u) => {
      const du = {};
      for (const label of net.places.keys()) du[label] = 0.0;

      for (const transLabel of net.transitions.keys()) {
        const rateFunc = rateFuncs[transLabel];
        const rate = rateFunc ? rateFunc.eval(u, t) : 0.0;

        let flux = rate;
        for (const arc of net.arcs) {
          if (arc.target === transLabel && net.places.has(arc.source)) {
            const placeState = u[arc.source];
            if (placeState <= 0) { flux = 0; break; }
            flux *= placeState;
          }
        }

        if (flux > 0) {
          for (const arc of net.arcs) {
            const weight = arc.getWeightSum();
            if (arc.target === transLabel && net.places.has(arc.source)) {
              du[arc.source] -= flux * weight;
            } else if (arc.source === transLabel && net.places.has(arc.target)) {
              du[arc.target] += flux * weight;
            }
          }
        }
      }
      return du;
    };
  }

  /**
   * Plain solve at the current parameter values. Mirror of LearnableProblem.Solve.
   * @param {*} solverMethod - Butcher tableau (null -> Tsit5)
   * @param {*} opts - solver options (null -> defaultSolverOptions)
   */
  solve(solverMethod = null, opts = null) {
    const prob = {
      net: this.net,
      colorMap: this.colorMap,
      u0: this.u0,
      tspan: this.tspan,
      f: this.buildODEFunc(),
    };
    const sol = solve(prob, solverMethod ?? Tsit5(), opts ?? defaultSolverOptions());
    sol.truncated = solveTruncated(sol, this.tspan, opts ?? defaultSolverOptions());
    return sol;
  }

  /**
   * Extract all parameters as one flat vector, plus transition -> [start, end)
   * indices. Tied parameters (the same rate-function OBJECT installed at
   * several transitions) pack once: the lexicographically smallest carrier
   * allocates the block, later carriers alias it. Mirror of
   * LearnableProblem.GetAllParams (object identity replaces Go's interface
   * equality; every JS object is comparable, so dedup always applies).
   * @returns {[Array<number>, Object<string, [number, number]>]}
   */
  getAllParams() {
    const params = [];
    const indices = {};
    const transNames = Object.keys(this.rateFuncs).sort();

    let offset = 0;
    const seen = new Map(); // rateFunc object -> [start, end)
    for (const transName of transNames) {
      const rateFunc = this.rateFuncs[transName];
      if (seen.has(rateFunc)) {
        indices[transName] = seen.get(rateFunc);
        continue;
      }
      const transParams = rateFunc.getParams();
      const start = offset;
      const end = offset + transParams.length;
      indices[transName] = [start, end];
      params.push(...transParams);
      offset = end;
      seen.set(rateFunc, [start, end]);
    }
    return [params, indices];
  }

  /** Mirror of LearnableProblem.SetAllParams: tied blocks written idempotently. */
  setAllParams(params, indices) {
    for (const [transName, idx] of Object.entries(indices)) {
      const rateFunc = this.rateFuncs[transName];
      if (rateFunc) rateFunc.setParams(params.slice(idx[0], idx[1]));
    }
  }

  /** Total learnable parameter count; a tied rate function counts once. */
  numParams() {
    let total = 0;
    const seen = new Set();
    for (const rateFunc of Object.values(this.rateFuncs)) {
      if (seen.has(rateFunc)) continue;
      seen.add(rateFunc);
      total += rateFunc.numParams();
    }
    return total;
  }

  /**
   * Pre-index the mass-action RHS: the missing-place refusal, the
   * learnable-parameter check, and the per-transition arc index. Mirror of
   * LearnableProblem.buildRHSIndex (learn/adjoint.go).
   */
  buildRHSIndex() {
    const labels = this.stateLabels;
    const stateIndex = {};
    labels.forEach((label, i) => { stateIndex[label] = i; });

    // Every net place must be a state variable: a place absent from u0 reads
    // as 0 in the plain solve (clamping its transitions OFF) while this
    // pre-indexed RHS would drop the arc — two different systems. Refuse.
    for (const name of this.net.places.keys()) {
      if (!(name in stateIndex)) {
        throw new Error(`place "${name}" is missing from the initial state: ` +
          'every net place must appear in u0 so the sensitivity RHS matches the plain solve');
      }
    }

    const [params, paramIndex] = this.getAllParams();
    const P = params.length;
    if (P === 0) {
      throw new Error('no learnable parameters: every rate function has numParams() == 0');
    }

    // Pre-index arcs per transition, mirroring solver.buildVecODEFunction:
    // same input clamp, product over arc ENTRIES (a duplicated arc contributes
    // its factor twice), weight enters ONLY stoichiometry.
    const inputMap = {};
    const stoichMap = {};
    for (const arc of this.net.arcs) {
      const w = arc.getWeightSum();
      if (this.net.transitions.has(arc.target) && arc.source in stateIndex) {
        (inputMap[arc.target] ??= []).push(stateIndex[arc.source]);
        (stoichMap[arc.target] ??= []).push({ idx: stateIndex[arc.source], s: -w });
      }
      if (this.net.transitions.has(arc.source) && arc.target in stateIndex) {
        (stoichMap[arc.source] ??= []).push({ idx: stateIndex[arc.target], s: +w });
      }
    }

    // Transitions with no rate function have rate 0 and are skipped entirely,
    // matching buildODEFunc.
    const trs = [];
    for (const name of this.net.transitions.keys()) {
      const rf = this.rateFuncs[name];
      if (!rf) continue;
      const blk = paramIndex[name];
      const grad = typeof rf.evalGrad === 'function'
        ? (state, t) => rf.evalGrad(state, t)
        : (state, t) => fdRateGrad(rf, state, t);
      trs.push({
        inputs: inputMap[name] ?? [],
        stoich: stoichMap[name] ?? [],
        ps: blk[0],
        pe: blk[1],
        grad,
      });
    }

    return { labels, stateIndex, trs, params, paramIndex, P };
  }

  /**
   * Integrate state and forward sensitivities together as one augmented ODE:
   * dx/dt = f(x, θ, t) alongside dS/dt = J·S + ∂f/∂θ with analytic J and
   * ∂f/∂θ. Mirror of learn.SolveWithSensitivities, clamp conventions
   * included — see the module doc for the one-sided derivative at flux == 0.
   *
   * @param {*} method - Butcher tableau (null -> Tsit5)
   * @param {*} opts - solver options (null -> defaultSolverOptions)
   * @returns {Sensitivities}
   */
  solveWithSensitivities(method = null, opts = null) {
    const idx = this.buildRHSIndex();
    const labels = idx.labels;
    const n = labels.length;
    const stateIndex = idx.stateIndex;
    const trs = idx.trs;
    const paramIndex = idx.paramIndex;
    const P = idx.P;

    // Synthetic labels satisfy the solver plumbing; never exposed.
    const augLabels = new Array(n * (P + 1));
    const y0 = {};
    for (let i = 0; i < n; i++) {
      augLabels[i] = 'x:' + labels[i];
      for (let pi = 0; pi < P; pi++) {
        augLabels[n + i * P + pi] = 's:' + labels[i] + '/' + pi;
      }
    }
    for (let i = 0; i < n; i++) y0[augLabels[i]] = this.u0[labels[i]]; // S(0) = 0
    for (let j = n; j < n * (P + 1); j++) y0[augLabels[j]] = 0;

    // Augmented state y, keyed by augLabels: y[0:n] = x; y[n+i*P+p] = S_{i,p}.
    const f = (t, y) => {
      const du = new Array(n * (P + 1)).fill(0);
      const x = new Array(n);
      const um = {};
      for (let i = 0; i < n; i++) {
        x[i] = y[augLabels[i]];
        um[labels[i]] = x[i];
      }

      for (const tr of trs) {
        // Input clamp: the transition contributes nothing — flux 0,
        // subgradient 0.
        let clamped = false;
        for (const ii of tr.inputs) {
          if (x[ii] <= 0) { clamped = true; break; }
        }
        if (clamped) continue;

        const [k, dkdTheta, dkdState] = tr.grad(um, t);

        // g = product over input entries; pp[q] = product over entries
        // r != q, via prefix/suffix (no division; every factor > 0).
        const m = tr.inputs.length;
        const pp = new Array(m);
        let prefix = 1.0;
        for (let q = 0; q < m; q++) {
          pp[q] = prefix;
          prefix *= x[tr.inputs[q]];
        }
        const g = prefix;
        let suffix = 1.0;
        for (let q = m - 1; q >= 0; q--) {
          pp[q] *= suffix;
          suffix *= x[tr.inputs[q]];
        }

        // Flux clamp: a NEGATIVE flux is the genuine ReLU-off region (flux 0,
        // subgradient 0). Flux exactly 0 (k == 0, all inputs > 0) keeps its
        // derivative terms — the one-sided right derivative matching the
        // active branch as k → 0⁺.
        const flux = k * g;
        if (flux < 0) continue;

        // State part (adds exactly zero when flux == 0).
        for (const st of tr.stoich) {
          du[st.idx] += st.s * flux;
        }

        // Flux Jacobian wrt state, sparse over input indices ∪ rate
        // state-dependencies. Repeated input entries accumulate to the
        // correct multiplicity derivative.
        const b = new Map();
        for (let q = 0; q < m; q++) {
          const ii = tr.inputs[q];
          b.set(ii, (b.get(ii) ?? 0) + k * pp[q]);
        }
        if (dkdState) {
          for (const [label, d] of Object.entries(dkdState)) {
            if (label in stateIndex) {
              const ii = stateIndex[label];
              b.set(ii, (b.get(ii) ?? 0) + g * d);
            }
          }
        }

        // c[p] = ∂flux/∂θ_p total: J·S term plus the direct term (zero
        // outside this transition's parameter block).
        const c = new Array(P).fill(0);
        for (const [midx, bv] of b) {
          const base = n + midx * P;
          for (let pi = 0; pi < P; pi++) {
            c[pi] += bv * y[augLabels[base + pi]];
          }
        }
        for (let pi = tr.ps; pi < tr.pe; pi++) {
          c[pi] += g * dkdTheta[pi - tr.ps];
        }
        for (const st of tr.stoich) {
          const base = n + st.idx * P;
          for (let pi = 0; pi < P; pi++) {
            du[base + pi] += st.s * c[pi];
          }
        }
      }

      const out = {};
      for (let j = 0; j < n * (P + 1); j++) out[augLabels[j]] = du[j];
      return out;
    };

    const solverOpts = opts ?? defaultSolverOptions();
    const aug = { u0: y0, tspan: this.tspan, f, colorMap: null };
    const sol = solve(aug, method ?? Tsit5(), solverOpts);
    const truncated = solveTruncated(sol, this.tspan, solverOpts);

    // Split each stored step: x-part into a real solution, S-part into rows.
    const steps = sol.t.length;
    const stateU = new Array(steps);
    const S = new Array(steps);
    for (let k = 0; k < steps; k++) {
      const st = sol.u[k];
      const row = {};
      const srow = new Array(n * P);
      for (let i = 0; i < n; i++) {
        row[labels[i]] = st[augLabels[i]];
        for (let pi = 0; pi < P; pi++) {
          srow[i * P + pi] = st[augLabels[n + i * P + pi]];
        }
      }
      stateU[k] = row;
      S[k] = srow;
    }

    const stateSol = new ODESolution(sol.t, stateU, labels, this.colorMap);
    stateSol.truncated = truncated;
    return new Sensitivities({
      sol: stateSol,
      t: stateSol.t,
      s: S,
      stateLabels: labels,
      paramIndex,
      numParams: P,
      truncated,
      colorMap: this.colorMap,
      stateIndex,
    });
  }

  /**
   * Reverse-mode (adjoint) gradient: one forward solve plus one backward
   * (costate) solve produces the FULL parameter gradient, at a cost that does
   * not scale with parameter count — the tool for a many-parameter rate where
   * forward mode's n*(P+1) augmented states dominate. Mirror of
   * learn.SolveAdjoint (learn/adjoint.go).
   *
   * This is the continuous adjoint: λ̇ = -Jᵀ(x(t))·λ between observation
   * times, a jump λ += ∂ℓ/∂x at each observed point, and G = ∫ λᵀ(∂f/∂θ) dt
   * read off alongside. The backward pass evaluates J on the piecewise-linear
   * reconstruction of the stored forward trajectory (the same interpolation
   * the losses use), so gradient error tracks the density of the forward grid
   * — tightening solver tolerances tightens the gradient by way of the denser
   * grid the controller then takes. Clamp conventions are forward mode's,
   * including the one-sided derivative at flux == 0.
   *
   * @param {*} data - Dataset (see newDataset)
   * @param {(place: string, sim: number, obs: number) => [number, number]|null} [pl] -
   *   point loss+gradient; null selects squared-error terms matching mseLoss
   *   exactly (diff²/N, N = times.length * places.length)
   * @param {*} [method] - Butcher tableau (null -> Tsit5)
   * @param {*} [opts] - solver options (null -> defaultSolverOptions)
   * @returns {{sol, loss?, grad?, paramIndex, numParams, truncated, backwardSteps?}}
   */
  solveAdjoint(data, pl = null, method = null, opts = null) {
    const idx = this.buildRHSIndex();
    method = method ?? Tsit5();
    opts = opts ?? defaultSolverOptions();

    // Forward: a plain solve; the stored dense trajectory is all the
    // backward pass reads (no second augmented forward integration).
    const sol = this.solve(method, opts);
    if (sol.truncated) {
      return { sol, paramIndex: idx.paramIndex, numParams: idx.P, truncated: true };
    }

    const n = idx.labels.length;
    const P = idx.P;

    // Cache the trajectory as dense rows once, indexed like the RHS.
    const steps = sol.t.length;
    const X = new Array(steps);
    for (let k = 0; k < steps; k++) {
      const st = sol.u[k];
      const row = new Array(n);
      for (let i = 0; i < n; i++) row[i] = st[idx.labels[i]];
      X[k] = row;
    }

    if (pl === null) {
      const N = data.times.length * data.places.length || 1;
      pl = (_place, sim, obs) => {
        const diff = sim - obs;
        return [diff * diff / N, 2 * diff / N];
      };
    }

    const [t0, tf] = this.tspan;

    // Jump pass: evaluate every observed point once, accumulating the loss
    // and the per-row costate jumps keyed by clamped observation time. No
    // extra solve happens here — Loss equals the pointwise sum exactly.
    let totalLoss = 0.0;
    const jumps = new Map(); // clamped time -> Map(rowIndex -> accumulated d)
    for (const place of data.places) {
      const obsValues = data.observations[place];
      const expanded = lookupLabels(this.colorMap, place);
      const rows = [];
      for (const l of expanded) {
        const i = idx.stateIndex[l];
        if (i !== undefined) rows.push(i);
      }
      for (let j = 0; j < data.times.length; j++) {
        const tObs = data.times[j];
        const [k, alpha] = locateT(sol.t, tObs);
        let sim = 0.0;
        for (const i of rows) {
          let v = X[k][i];
          if (alpha > 0) v = v * (1 - alpha) + X[k + 1][i] * alpha;
          sim += v;
        }
        const [l, d] = pl(place, sim, obsValues[j]);
        totalLoss += l;
        const tc = Math.min(Math.max(tObs, t0), tf);
        let je = jumps.get(tc);
        if (je === undefined) { je = new Map(); jumps.set(tc, je); }
        for (const i of rows) je.set(i, (je.get(i) ?? 0) + d);
      }
    }

    const jumpTimes = Array.from(jumps.keys()).sort((a, b) => b - a);

    // Backward state y = [λ(n); G(P)], integrated segment-by-segment in
    // reversed time τ = t_hi - t: dλ/dτ = +Jᵀλ, dG/dτ = +λᵀ·∂f/∂θ. Synthetic
    // labels satisfy the solve() plumbing; never exposed.
    const m = n + P;
    const segLabels = new Array(m);
    for (let i = 0; i < m; i++) segLabels[i] = 'adj:' + i;
    const lam = new Array(n).fill(0);
    const G = new Array(P).fill(0);
    let backSteps = 0;
    const xbuf = new Array(n);
    const um = {};

    const integrateSeg = (lo, hi) => {
      if (!(hi > lo)) return;
      const y0 = {};
      for (let i = 0; i < n; i++) y0[segLabels[i]] = lam[i];
      for (let pi = 0; pi < P; pi++) y0[segLabels[n + pi]] = G[pi];

      const rhs = (tau, y) => {
        const t = hi - tau;
        const [k, alpha] = locateT(sol.t, t);
        for (let i = 0; i < n; i++) {
          let v = X[k][i];
          if (alpha > 0) v = v * (1 - alpha) + X[k + 1][i] * alpha;
          xbuf[i] = v;
        }
        for (let i = 0; i < n; i++) um[idx.labels[i]] = xbuf[i];

        const dy = new Array(m).fill(0);
        for (const tr of idx.trs) {
          let clamped = false;
          for (const ii of tr.inputs) {
            if (xbuf[ii] <= 0) { clamped = true; break; }
          }
          if (clamped) continue;

          const [kRate, dkdTheta, dkdState] = tr.grad(um, t);

          const nin = tr.inputs.length;
          const pp = new Array(nin);
          let prefix = 1.0;
          for (let q = 0; q < nin; q++) {
            pp[q] = prefix;
            prefix *= xbuf[tr.inputs[q]];
          }
          const g = prefix;
          let suffix = 1.0;
          for (let q = nin - 1; q >= 0; q--) {
            pp[q] *= suffix;
            suffix *= xbuf[tr.inputs[q]];
          }

          const flux = kRate * g;
          if (flux < 0) continue;

          // a = λᵀ·(stoichiometry column of this transition).
          let a = 0.0;
          for (const st of tr.stoich) a += st.s * y[segLabels[st.idx]];

          // b[j] = ∂flux/∂x_j, sparse over inputs ∪ rate state-dependencies.
          const b = new Map();
          for (let q = 0; q < nin; q++) {
            const ii = tr.inputs[q];
            b.set(ii, (b.get(ii) ?? 0) + kRate * pp[q]);
          }
          if (dkdState) {
            for (const [label, d] of Object.entries(dkdState)) {
              const ii = idx.stateIndex[label];
              if (ii !== undefined) b.set(ii, (b.get(ii) ?? 0) + g * d);
            }
          }
          for (const [j, bv] of b) dy[j] += a * bv;
          for (let pi = tr.ps; pi < tr.pe; pi++) {
            dy[n + pi] += a * g * dkdTheta[pi - tr.ps];
          }
        }

        const out = {};
        for (let j = 0; j < m; j++) out[segLabels[j]] = dy[j];
        return out;
      };

      const segSol = solve({ u0: y0, tspan: [0, hi - lo], f: rhs, colorMap: null }, method, opts);
      if (solveTruncated(segSol, [0, hi - lo], opts)) {
        throw new Error('adjoint backward solve truncated: raise maxIters or loosen tolerances');
      }
      const final = segSol.u[segSol.u.length - 1];
      for (let i = 0; i < n; i++) lam[i] = final[segLabels[i]];
      for (let pi = 0; pi < P; pi++) G[pi] = final[segLabels[n + pi]];
      backSteps += segSol.t.length - 1;
    };

    // λ(tf+) = 0; walk the jump times from tf down, integrating the segment
    // above each jump before applying it. A jump exactly at t0 lands after
    // the last segment and therefore contributes no gradient.
    let tHi = tf;
    for (const jt of jumpTimes) {
      integrateSeg(jt, tHi);
      if (jt < tHi) tHi = jt;
      for (const [i, d] of jumps.get(jt)) lam[i] += d;
    }
    integrateSeg(t0, tHi);

    return {
      sol,
      loss: totalLoss,
      grad: G,
      paramIndex: idx.paramIndex,
      numParams: P,
      truncated: false,
      backwardSteps: backSteps,
    };
  }
}

/** Bracketing index for linear interpolation on a sorted time grid, end-
 * clamped exactly like interpolateAt: t at or before the first node reads the
 * first value, t at or past the last reads the last. Returns [k, alpha] such
 * that x(t) = X[k]*(1-alpha) + X[k+1]*alpha, with k+1 valid whenever alpha >
 * 0. Mirror of learn.locateT (learn/adjoint.go). */
function locateT(times, t) {
  const last = times.length - 1;
  if (last <= 0 || t <= times[0]) return [0, 0];
  if (t >= times[last]) return [last, 0];
  // First index with times[i] >= t (binary search; times is sorted ascending).
  let lo = 0, hi = last;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid] < t) lo = mid + 1; else hi = mid;
  }
  let k = lo;
  if (times[k] === t) return [k, 0];
  k--;
  const dt = times[k + 1] - times[k];
  if (dt === 0) return [k, 0];
  return [k, (t - times[k]) / dt];
}

/**
 * Reverse-mode counterpart of mseLossGrad: the same MSE objective (Loss
 * equals mseLoss of the same trajectory), gradient from one backward solve
 * instead of n*P forward sensitivity states. Mirror of learn.MSELossAdjoint.
 * @param {*} [method]
 * @param {*} [opts]
 */
export function mseLossAdjoint(prob, data, method = null, opts = null) {
  return prob.solveAdjoint(data, null, method, opts);
}

/**
 * Reverse-mode counterpart of relativeMseLossGrad: per-place 1/meanObs²
 * weighting (meanObs == 0 falls back to 1), identical loss value, gradient
 * from one backward solve. Mirror of learn.RelativeMSELossAdjoint.
 * @param {*} [method]
 * @param {*} [opts]
 */
export function relativeMseLossAdjoint(prob, data, method = null, opts = null) {
  const means = {};
  for (const place of data.places) {
    const obsValues = data.observations[place];
    let meanObs = 0.0;
    for (const v of obsValues) meanObs += v;
    if (obsValues.length > 0) meanObs /= obsValues.length;
    if (meanObs === 0) meanObs = 1.0;
    means[place] = meanObs;
  }
  const N = data.times.length * data.places.length || 1;
  const pl = (place, sim, obs) => {
    const mo = means[place];
    const diff = (sim - obs) / mo;
    return [diff * diff / N, 2 * diff / (mo * N)];
  };
  return prob.solveAdjoint(data, pl, method, opts);
}

/** Truncation flag, mirroring solver.Solution.Truncated: the solve exhausted
 * maxiters before reaching tspan[1]. (The JS solver stores accepted steps as
 * sol.t entries, one per step plus the initial point.) */
function solveTruncated(sol, tspan, opts) {
  const nsteps = sol.t.length - 1;
  const maxiters = opts.maxiters ?? 100000;
  return nsteps >= maxiters && sol.t[sol.t.length - 1] < tspan[1];
}

/**
 * A solved trajectory plus forward sensitivities dx/dθ.
 * s[k][i*numParams+p] = ∂x_i/∂θ_p at t[k]; i indexes stateLabels.
 * Mirror of learn.Sensitivities.
 */
export class Sensitivities {
  /** @param {*} fields */
  constructor(fields) {
    this.sol = fields.sol;
    this.t = fields.t;
    this.s = fields.s;
    this.stateLabels = fields.stateLabels;
    this.paramIndex = fields.paramIndex;
    this.numParams = fields.numParams;
    this.truncated = fields.truncated;
    this.colorMap = fields.colorMap;
    this.stateIndex = fields.stateIndex;
  }

  /** ∂x_place/∂θ_param at time index k; null for an unknown label/index. */
  at(k, place, param) {
    if (k < 0 || k >= this.s.length || param < 0 || param >= this.numParams) return null;
    const i = this.stateIndex[place];
    if (i === undefined) return null;
    return this.s[k][i * this.numParams + param];
  }
}

// ============================================================================
// Dataset and losses (learn/dataset.go, learn/lossgrad.go)
// ============================================================================

/**
 * Observed trajectories for training. `places` fixes iteration order (and so
 * floating-point accumulation order); it defaults to the observations'
 * insertion order. Mirror of learn.Dataset / NewDataset.
 */
export function newDataset(times, observations, places = null) {
  if (!times || times.length === 0) throw new Error('times cannot be empty');
  for (const [place, values] of Object.entries(observations)) {
    if (values.length !== times.length) {
      throw new Error(`observation length for place ${place} (${values.length}) ` +
        `does not match times length (${times.length})`);
    }
  }
  return {
    times,
    observations,
    places: places ?? Object.keys(observations),
  };
}

/** Linear interpolation at a single time point. Mirror of learn.interpolateAt. */
export function interpolateAt(times, values, t) {
  if (t <= times[0]) return values[0];
  if (t >= times[times.length - 1]) return values[values.length - 1];
  for (let i = 0; i < times.length - 1; i++) {
    if (times[i] <= t && t <= times[i + 1]) {
      const dt = times[i + 1] - times[i];
      if (dt === 0) return values[i];
      const alpha = (t - times[i]) / dt;
      return values[i] * (1 - alpha) + values[i + 1] * alpha;
    }
  }
  return values[values.length - 1];
}

/** Interpolate a solution at given time points. Mirror of learn.InterpolateSolution. */
export function interpolateSolution(sol, times, place) {
  const solTimes = sol.t;
  const solValues = sol.getVariable(place);
  return times.map((t) => interpolateAt(solTimes, solValues, t));
}

/** Mean squared error between simulated and observed trajectories. */
export function mseLoss(sol, data) {
  let totalError = 0.0;
  let numPoints = 0;
  for (const place of data.places) {
    const obsValues = data.observations[place];
    const simValues = interpolateSolution(sol, data.times, place);
    for (let i = 0; i < data.times.length; i++) {
      const diff = simValues[i] - obsValues[i];
      totalError += diff * diff;
      numPoints++;
    }
  }
  if (numPoints === 0) return 0.0;
  return totalError / numPoints;
}

/** Root mean squared error. */
export function rmseLoss(sol, data) {
  return Math.sqrt(mseLoss(sol, data));
}

/** MSE normalized per place by the mean observed value. */
export function relativeMseLoss(sol, data) {
  let totalError = 0.0;
  for (const place of data.places) {
    const obsValues = data.observations[place];
    const simValues = interpolateSolution(sol, data.times, place);
    let meanObs = 0.0;
    for (const v of obsValues) meanObs += v;
    meanObs /= obsValues.length;
    if (meanObs === 0) meanObs = 1.0;
    for (let i = 0; i < data.times.length; i++) {
      const diff = (simValues[i] - obsValues[i]) / meanObs;
      totalError += diff * diff;
    }
  }
  const numPoints = data.times.length * data.places.length;
  if (numPoints === 0) return 0.0;
  return totalError / numPoints;
}

/** Σ_i s[k][i*P+p] over the given state rows — the sensitivity of a
 * (possibly color-summed) observable to θ_p. Mirror of learn.sensSeries. */
function sensSeries(sens, rows, p) {
  const P = sens.numParams;
  const series = new Array(sens.t.length);
  for (let k = 0; k < sens.t.length; k++) {
    let sum = 0.0;
    for (const i of rows) sum += sens.s[k][i * P + p];
    series[k] = sum;
  }
  return series;
}

/** Dataset place name -> state-row indices (base names sum their expanded
 * labels). Mirror of learn.sensRows. */
function sensRows(sens, place) {
  const labels = lookupLabels(sens.colorMap, place);
  const rows = [];
  for (const l of labels) {
    const i = sens.stateIndex[l];
    if (i !== undefined) rows.push(i);
  }
  return rows;
}

/**
 * Gradient-carrying companion of mseLoss: identical loss value (same
 * interpolation, same base-name color summing), plus ∂loss/∂θ.
 * Mirror of learn.MSELossGrad.
 * @returns {[number, Array<number>]}
 */
export function mseLossGrad(sens, data) {
  const P = sens.numParams;
  const grad = new Array(P).fill(0);
  let totalError = 0.0;
  let numPoints = 0;

  for (const place of data.places) {
    const obsValues = data.observations[place];
    const simValues = interpolateSolution(sens.sol, data.times, place);
    const rows = sensRows(sens, place);

    for (let i = 0; i < data.times.length; i++) {
      const diff = simValues[i] - obsValues[i];
      totalError += diff * diff;
      numPoints++;
    }
    for (let p = 0; p < P; p++) {
      const series = sensSeries(sens, rows, p);
      for (let i = 0; i < data.times.length; i++) {
        const t = data.times[i];
        const diff = simValues[i] - obsValues[i];
        grad[p] += 2 * diff * interpolateAt(sens.t, series, t);
      }
    }
  }

  if (numPoints === 0) return [0.0, grad];
  for (let p = 0; p < P; p++) grad[p] /= numPoints;
  return [totalError / numPoints, grad];
}

/** Gradient-carrying companion of rmseLoss: (sqrt(L), gradL/(2*sqrt(L))).
 * @returns {[number, Array<number>]} */
export function rmseLossGrad(sens, data) {
  const [loss, grad] = mseLossGrad(sens, data);
  if (loss === 0) return [0.0, grad.map(() => 0)];
  const root = Math.sqrt(loss);
  for (let p = 0; p < grad.length; p++) grad[p] /= 2 * root;
  return [root, grad];
}

/**
 * Gradient-carrying companion of relativeMseLoss: per-place 1/meanObs²
 * weighting (meanObs == 0 falls back to 1). Mirror of learn.RelativeMSELossGrad.
 * @returns {[number, Array<number>]}
 */
export function relativeMseLossGrad(sens, data) {
  const P = sens.numParams;
  const grad = new Array(P).fill(0);
  let totalError = 0.0;

  for (const place of data.places) {
    const obsValues = data.observations[place];
    const simValues = interpolateSolution(sens.sol, data.times, place);
    const rows = sensRows(sens, place);

    let meanObs = 0.0;
    for (const v of obsValues) meanObs += v;
    meanObs /= obsValues.length;
    if (meanObs === 0) meanObs = 1.0;

    for (let i = 0; i < data.times.length; i++) {
      const diff = (simValues[i] - obsValues[i]) / meanObs;
      totalError += diff * diff;
    }
    for (let p = 0; p < P; p++) {
      const series = sensSeries(sens, rows, p);
      for (let i = 0; i < data.times.length; i++) {
        const t = data.times[i];
        const diff = (simValues[i] - obsValues[i]) / meanObs;
        grad[p] += 2 * diff * interpolateAt(sens.t, series, t) / meanObs;
      }
    }
  }

  const numPoints = data.times.length * data.places.length;
  if (numPoints === 0) return [0.0, grad];
  for (let p = 0; p < P; p++) grad[p] /= numPoints;
  return [totalError / numPoints, grad];
}

// ============================================================================
// Ranking loss (learn/ranking.go)
// ============================================================================

/**
 * Sum, per decision, of the worst violation of "some preferred option must
 * outscore every non-preferred option by margin". Decisions with no preferred
 * or no non-preferred options contribute zero. Mirror of learn.HingeRankLoss.
 *
 * @param {Array<{scores: Array<number>, preferred: Array<boolean>}>} decisions
 * @param {number} margin
 */
export function hingeRankLoss(decisions, margin) {
  let loss = 0.0;
  for (const d of decisions) {
    let bestPref = -Infinity;
    let bestNon = -Infinity;
    let n = d.scores.length;
    if (d.preferred.length < n) n = d.preferred.length;
    for (let i = 0; i < n; i++) {
      if (d.preferred[i]) {
        if (d.scores[i] > bestPref) bestPref = d.scores[i];
      } else if (d.scores[i] > bestNon) {
        bestNon = d.scores[i];
      }
    }
    if (bestPref === -Infinity || bestNon === -Infinity) continue;
    const v = margin + bestNon - bestPref;
    if (v > 0) loss += v;
  }
  return loss;
}

// ============================================================================
// Fit options / result (learn/optimize.go)
// ============================================================================

/** Mirror of learn.DefaultFitOptions. */
export function defaultFitOptions() {
  return {
    maxIters: 1000,
    tolerance: 1e-4,
    method: 'nelder-mead',
    stepSize: 0.01,
    verbose: false,
    solverMethod: null, // null -> Tsit5
    solverOptions: null, // null -> defaultSolverOptions
    learnRate: 0,
    gradTol: 0,
    gradLoss: null,
    sensitivity: '',
  };
}

function withDefaults(opts) {
  return { ...defaultFitOptions(), ...(opts ?? {}) };
}

/** max |v| over the vector. */
function maxAbs(v) {
  let m = 0.0;
  for (const x of v) {
    const a = Math.abs(x);
    if (a > m) m = a;
  }
  return m;
}

// ============================================================================
// Gradient optimizers (learn/gradopt.go)
// ============================================================================

/**
 * Adam (Kingma & Ba) with bias correction over a (value, gradient) closure.
 * β₁ = 0.9, β₂ = 0.999, ε = 1e-8; step size opts.learnRate (0 -> 0.05).
 * A +Inf evaluation halves an internal step scale and retries from the
 * pre-step point (at most 10 halvings, then stop). Tracks and returns the
 * best-seen point. Converges when max|∇| < gradTol (0 -> 1e-6) or the
 * per-iteration loss change drops below opts.tolerance.
 * Mirror of learn.adamMinimize.
 *
 * @param {(x: Array<number>) => [number, Array<number>|null]} fg
 * @returns {[Array<number>, number, number, boolean]} [params, loss, iters, converged]
 */
export function adamMinimize(fg, x0, opts) {
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  // Go folds the untyped-constant expressions (1-beta1) and (1-beta2) in
  // EXACT precision at compile time — 0.1 and 0.001 — not the runtime float64
  // differences 1-0.9 = 0.09999999999999998 and 1-0.999 =
  // 0.0009999999999999998. Use the folded values for bit-parity.
  const oneMinusBeta1 = 0.1;
  const oneMinusBeta2 = 0.001;

  opts = withDefaults(opts);
  let lr = opts.learnRate;
  if (lr === 0) lr = 0.05;
  let gradTol = opts.gradTol;
  if (gradTol === 0) gradTol = 1e-6;

  const n = x0.length;
  let x = x0.slice();
  let [loss, g] = fg(x);
  if (g === null || loss === Infinity) {
    return [x, Infinity, 0, false];
  }
  let best = x.slice();
  let bestLoss = loss;

  const m = new Array(n).fill(0);
  const v = new Array(n).fill(0);
  const step = new Array(n).fill(0);
  let tStep = 0;

  for (let iter = 1; iter <= opts.maxIters; iter++) {
    if (maxAbs(g) < gradTol) {
      return [best, bestLoss, iter - 1, true];
    }

    tStep++;
    // goPowInt, not Math.pow: bit-parity with Go's math.Pow (see above).
    const bc1 = 1 - goPowInt(beta1, tStep);
    const bc2 = 1 - goPowInt(beta2, tStep);
    for (let i = 0; i < n; i++) {
      m[i] = beta1 * m[i] + oneMinusBeta1 * g[i];
      v[i] = beta2 * v[i] + oneMinusBeta2 * g[i] * g[i];
      step[i] = lr * (m[i] / bc1) / (Math.sqrt(v[i] / bc2) + eps);
    }

    // Take the step; a rejected (+Inf) point halves the scale and retries
    // from the pre-step x.
    let scale = 1.0;
    let accepted = false;
    let cand = null;
    let candLoss = 0;
    let candGrad = null;
    for (let retry = 0; retry <= 10; retry++) {
      cand = new Array(n);
      for (let i = 0; i < n; i++) cand[i] = x[i] - scale * step[i];
      [candLoss, candGrad] = fg(cand);
      if (candGrad !== null && candLoss !== Infinity) {
        accepted = true;
        break;
      }
      scale *= 0.5;
    }
    if (!accepted) {
      return [best, bestLoss, iter, false];
    }

    const prevLoss = loss;
    x = cand;
    loss = candLoss;
    g = candGrad;
    if (loss < bestLoss) {
      bestLoss = loss;
      best = x.slice();
    }

    if (opts.verbose && iter % 100 === 0) {
      console.log(`Iter ${iter}: loss = ${loss.toFixed(6)}`);
    }

    if (Math.abs(prevLoss - loss) < opts.tolerance) {
      return [best, bestLoss, iter, true];
    }
  }
  return [best, bestLoss, opts.maxIters, false];
}

/**
 * Steepest descent with Armijo backtracking. Initial step opts.learnRate
 * (0 -> 1.0); accept f(x − αg) ≤ f(x) − 1e-4·α·‖g‖², else halve α (at most
 * 30 halvings, then converged at the best point). Mirror of
 * learn.descentBacktracking.
 */
export function descentBacktracking(fg, fVal, x0, opts) {
  opts = withDefaults(opts);
  let lr = opts.learnRate;
  if (lr === 0) lr = 1.0;
  let gradTol = opts.gradTol;
  if (gradTol === 0) gradTol = 1e-6;

  const n = x0.length;
  let x = x0.slice();
  let [f0, g] = fg(x);
  if (g === null || f0 === Infinity) {
    return [x, Infinity, 0, false];
  }
  let best = x.slice();
  let bestLoss = f0;

  for (let iter = 1; iter <= opts.maxIters; iter++) {
    if (maxAbs(g) < gradTol) {
      return [best, bestLoss, iter - 1, true];
    }

    let gnorm2 = 0.0;
    for (const gi of g) gnorm2 += gi * gi;

    let alpha = lr;
    let accepted = false;
    const cand = new Array(n);
    let fc = 0;
    for (let h = 0; h <= 30; h++) {
      for (let i = 0; i < n; i++) cand[i] = x[i] - alpha * g[i];
      fc = fVal(cand);
      if (fc !== Infinity && fc <= f0 - 1e-4 * alpha * gnorm2) {
        accepted = true;
        break;
      }
      alpha *= 0.5;
    }
    if (!accepted) {
      // No descent step exists at any tried scale: converged.
      return [best, bestLoss, iter, true];
    }

    const prev = f0;
    x = cand.slice();
    [f0, g] = fg(x);
    if (g === null || f0 === Infinity) {
      return [best, bestLoss, iter, false];
    }
    if (f0 < bestLoss) {
      bestLoss = f0;
      best = x.slice();
    }

    if (opts.verbose && iter % 100 === 0) {
      console.log(`Iter ${iter}: loss = ${f0.toFixed(6)}`);
    }

    if (Math.abs(prev - f0) < opts.tolerance) {
      return [best, bestLoss, iter, true];
    }
  }
  return [best, bestLoss, opts.maxIters, false];
}

/**
 * Gradient counterpart of minimize: fg returns [value, gradient] for
 * arbitrary objectives. Only maxIters, tolerance, method
 * ("adam"/"gradient-descent"), learnRate, gradTol and verbose are consulted.
 * Mirror of learn.MinimizeGradient. evals counts fg calls.
 * @param {*} fg
 * @param {Array<number>} x0
 * @param {*} opts
 */
export function minimizeGradient(fg, x0, opts = null) {
  opts = withDefaults(opts);
  if (x0.length === 0) throw new Error('no parameters to optimize');
  let evals = 0;
  const cfg = (x) => { evals++; return fg(x); };
  const fVal = (x) => { evals++; const [v] = fg(x); return v; };
  const [initialLoss] = cfg(x0);
  if (opts.verbose) {
    console.log(`Initial loss: ${initialLoss.toFixed(6)}`);
    console.log(`Initial params: ${x0}`);
  }
  let params, loss, iters, converged;
  switch (opts.method) {
    case '':
    case 'nelder-mead':
    case 'coordinate-descent':
    case 'adam':
      [params, loss, iters, converged] = adamMinimize(cfg, x0, opts);
      break;
    case 'gradient-descent':
      [params, loss, iters, converged] = descentBacktracking(cfg, fVal, x0, opts);
      break;
    default:
      throw new Error(`unknown gradient optimization method: ${opts.method}`);
  }
  if (opts.verbose) {
    console.log(`Final loss: ${loss.toFixed(6)} after ${iters} iterations (converged=${converged})`);
  }
  return {
    params,
    initialLoss,
    finalLoss: loss,
    iterations: iters,
    converged,
    evals,
  };
}

// ============================================================================
// Gradient-free optimizers (learn/optimize.go, learn/minimize.go)
// ============================================================================

/** Nelder-Mead simplex. Mirror of learn.nelderMead (same coefficients,
 * simplex construction, and convergence rule values[n]-values[0] < tolerance). */
export function nelderMead(f, x0, opts) {
  opts = withDefaults(opts);
  const n = x0.length;

  const alpha = 1.0; // reflection
  const gamma = 2.0; // expansion
  const rho = 0.5; // contraction
  const sigma = 0.5; // shrink

  const simplex = new Array(n + 1);
  const values = new Array(n + 1);

  simplex[0] = x0.slice();
  values[0] = f(simplex[0]);

  for (let i = 0; i < n; i++) {
    simplex[i + 1] = x0.slice();
    simplex[i + 1][i] += 0.05 * (1.0 + Math.abs(x0[i]));
    values[i + 1] = f(simplex[i + 1]);
  }

  for (let iter = 0; iter < opts.maxIters; iter++) {
    sortSimplex(simplex, values);

    if (opts.verbose && iter % 100 === 0) {
      console.log(`Iter ${iter}: best = ${values[0].toFixed(6)}, worst = ${values[n].toFixed(6)}`);
    }

    if (values[n] - values[0] < opts.tolerance) {
      return [simplex[0], values[0], iter, true];
    }

    // Centroid of best n points
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      let sum = 0.0;
      for (let j = 0; j < n; j++) sum += simplex[j][i];
      centroid[i] = sum / n;
    }

    // Reflection
    const reflected = new Array(n);
    for (let i = 0; i < n; i++) {
      reflected[i] = centroid[i] + alpha * (centroid[i] - simplex[n][i]);
    }
    const reflectedVal = f(reflected);

    if (values[0] <= reflectedVal && reflectedVal < values[n - 1]) {
      simplex[n] = reflected;
      values[n] = reflectedVal;
      continue;
    }

    // Expansion
    if (reflectedVal < values[0]) {
      const expanded = new Array(n);
      for (let i = 0; i < n; i++) {
        expanded[i] = centroid[i] + gamma * (reflected[i] - centroid[i]);
      }
      const expandedVal = f(expanded);
      if (expandedVal < reflectedVal) {
        simplex[n] = expanded;
        values[n] = expandedVal;
      } else {
        simplex[n] = reflected;
        values[n] = reflectedVal;
      }
      continue;
    }

    // Contraction
    const contracted = new Array(n);
    if (reflectedVal < values[n]) {
      for (let i = 0; i < n; i++) {
        contracted[i] = centroid[i] + rho * (reflected[i] - centroid[i]);
      }
    } else {
      for (let i = 0; i < n; i++) {
        contracted[i] = centroid[i] + rho * (simplex[n][i] - centroid[i]);
      }
    }
    const contractedVal = f(contracted);

    if (contractedVal < Math.min(reflectedVal, values[n])) {
      simplex[n] = contracted;
      values[n] = contractedVal;
      continue;
    }

    // Shrink
    for (let i = 1; i <= n; i++) {
      for (let j = 0; j < n; j++) {
        simplex[i][j] = simplex[0][j] + sigma * (simplex[i][j] - simplex[0][j]);
      }
      values[i] = f(simplex[i]);
    }
  }

  sortSimplex(simplex, values);
  return [simplex[0], values[0], opts.maxIters, false];
}

/** Insertion sort of simplex points by value. Mirror of learn.sortSimplex. */
function sortSimplex(simplex, values) {
  const n = values.length;
  for (let i = 1; i < n; i++) {
    const val = values[i];
    const point = simplex[i];
    let j = i - 1;
    while (j >= 0 && values[j] > val) {
      values[j + 1] = values[j];
      simplex[j + 1] = simplex[j];
      j--;
    }
    values[j + 1] = val;
    simplex[j + 1] = point;
  }
}

/** Simple coordinate descent. Mirror of learn.coordinateDescent. */
export function coordinateDescent(f, x0, opts) {
  opts = withDefaults(opts);
  const x = x0.slice();

  let bestLoss = f(x);
  let stepSize = opts.stepSize;

  for (let iter = 0; iter < opts.maxIters; iter++) {
    let improved = false;

    for (let i = 0; i < x.length; i++) {
      const oldVal = x[i];

      x[i] = oldVal + stepSize;
      const posLoss = f(x);

      x[i] = oldVal - stepSize;
      const negLoss = f(x);

      if (posLoss < bestLoss) {
        x[i] = oldVal + stepSize;
        bestLoss = posLoss;
        improved = true;
      } else if (negLoss < bestLoss) {
        x[i] = oldVal - stepSize;
        bestLoss = negLoss;
        improved = true;
      } else {
        x[i] = oldVal;
      }
    }

    if (opts.verbose && iter % 100 === 0) {
      console.log(`Iter ${iter}: loss = ${bestLoss.toFixed(6)}`);
    }

    if (!improved) {
      stepSize *= 0.5;
      if (stepSize < 1e-10) {
        return [x, bestLoss, iter, true];
      }
    }

    if (bestLoss < opts.tolerance) {
      return [x, bestLoss, iter, true];
    }
  }

  return [x, bestLoss, opts.maxIters, false];
}

/**
 * Run the gradient-free optimizers over an arbitrary objective.
 * Mirror of learn.Minimize: "adam"/"gradient-descent" are refused (they need
 * minimizeGradient); "coordinate-descent" selects coordinateDescent; anything
 * else selects nelderMead.
 * @param {*} f
 * @param {Array<number>} x0
 * @param {*} opts
 */
export function minimize(f, x0, opts = null) {
  opts = withDefaults(opts);
  if (x0.length === 0) throw new Error('no parameters to optimize');
  if (opts.method === 'adam' || opts.method === 'gradient-descent') {
    throw new Error(`gradient method "${opts.method}" requires minimizeGradient`);
  }
  const initialLoss = f(x0);
  if (opts.verbose) {
    console.log(`Initial loss: ${initialLoss.toFixed(6)}`);
    console.log(`Initial params: ${x0}`);
  }
  let params, loss, iters, converged;
  if (opts.method === 'coordinate-descent') {
    [params, loss, iters, converged] = coordinateDescent(f, x0, opts);
  } else {
    [params, loss, iters, converged] = nelderMead(f, x0, opts);
  }
  if (opts.verbose) {
    console.log(`Final loss: ${loss.toFixed(6)} after ${iters} iterations (converged=${converged})`);
  }
  return {
    params,
    initialLoss,
    finalLoss: loss,
    iterations: iters,
    converged,
    evals: 0,
  };
}

// ============================================================================
// Fit (learn/optimize.go Fit, learn/gradopt.go FitGradient)
// ============================================================================

/**
 * Shared engine behind fitGradient and fit's "adam"/"gradient-descent"
 * cases. `report`, when non-null, is the plain loss used for
 * initialLoss/finalLoss so results stay comparable across methods.
 * Mirror of learn.fitGradientCore (forward mode only; "adjoint" is refused).
 */
function fitGradientCore(prob, data, opts, report) {
  opts = withDefaults(opts);
  switch (opts.sensitivity) {
    case '':
    case 'forward':
      break;
    case 'adjoint':
      throw new Error('sensitivity "adjoint" is not ported to petri-learn.js: ' +
        'use go-pflow learn.SolveAdjoint, or forward mode here');
    default:
      throw new Error(`unknown sensitivity "${opts.sensitivity}": want "" or "forward"`);
  }
  const [params0, indices] = prob.getAllParams();
  if (params0.length === 0) throw new Error('no learnable parameters found');
  const gl = opts.gradLoss ?? mseLossGrad;
  const P = params0.length;
  let evals = 0;

  // One gradient evaluation: a forward sensitivity solve costs (1 + P)
  // plain-solve equivalents. Truncation, solver error, or a non-finite
  // loss/gradient rejects the point with +Inf rather than erroring the fit.
  const valueGrad = (theta) => {
    prob.setAllParams(theta, indices);
    evals += 1 + P;
    let sens;
    try {
      sens = prob.solveWithSensitivities(opts.solverMethod, opts.solverOptions);
    } catch (_e) {
      return [Infinity, null];
    }
    if (sens.truncated) return [Infinity, null];
    const [loss, grad] = gl(sens, data);
    if (!Number.isFinite(loss)) return [Infinity, null];
    for (const g of grad) {
      if (!Number.isFinite(g)) return [Infinity, null];
    }
    return [loss, grad];
  };

  // Cheap objective for line-search trial points: one plain solve when the
  // gradient objective is the MSE default; with a custom gradLoss the value
  // derives from valueGrad so the two objectives agree.
  let value;
  if (opts.gradLoss == null) {
    value = (theta) => {
      prob.setAllParams(theta, indices);
      evals++;
      const sol = prob.solve(opts.solverMethod, opts.solverOptions);
      if (sol.truncated) return Infinity;
      const l = mseLoss(sol, data);
      if (!Number.isFinite(l)) return Infinity;
      return l;
    };
  } else {
    value = (theta) => valueGrad(theta)[0];
  }

  // Initial loss, reported with the plain loss when one is given.
  let initialLoss;
  if (report != null) {
    prob.setAllParams(params0, indices);
    evals++;
    const sol = prob.solve(opts.solverMethod, opts.solverOptions);
    initialLoss = report(sol, data);
  } else {
    [initialLoss] = valueGrad(params0);
  }

  if (opts.verbose) {
    console.log(`Initial loss: ${initialLoss.toFixed(6)}`);
    console.log(`Initial params: ${params0}`);
  }

  let finalParams, finalLoss, iters, converged;
  switch (opts.method) {
    case '':
    case 'nelder-mead':
    case 'coordinate-descent':
    case 'adam':
      [finalParams, finalLoss, iters, converged] = adamMinimize(valueGrad, params0, opts);
      break;
    case 'gradient-descent':
      [finalParams, finalLoss, iters, converged] = descentBacktracking(valueGrad, value, params0, opts);
      break;
    default:
      throw new Error(`unknown gradient optimization method: ${opts.method}`);
  }

  prob.setAllParams(finalParams, indices);
  if (report != null) {
    evals++;
    const sol = prob.solve(opts.solverMethod, opts.solverOptions);
    finalLoss = report(sol, data);
  }

  if (opts.verbose) {
    console.log(`Final loss: ${finalLoss.toFixed(6)}`);
    console.log(`Final params: ${finalParams}`);
    console.log(`Iterations: ${iters}, Converged: ${converged}`);
  }

  return {
    params: finalParams,
    initialLoss,
    finalLoss,
    iterations: iters,
    converged,
    evals,
  };
}

/**
 * Fit by forward-sensitivity gradients: "adam" (default for empty or
 * gradient-free method names) or "gradient-descent". Mirror of
 * learn.FitGradient.
 * @param {*} opts
 */
export function fitGradient(prob, data, opts = null) {
  opts = withDefaults(opts);
  const report = opts.gradLoss == null ? mseLoss : null;
  return fitGradientCore(prob, data, opts, report);
}

/**
 * Optimize the parameters of a LearnableProblem against a dataset.
 * Gradient methods ("adam"/"gradient-descent") minimize opts.gradLoss
 * (null -> mseLossGrad) while lossFunc only REPORTS initial/final loss;
 * "nelder-mead" (the default) and "coordinate-descent" minimize lossFunc
 * directly. Mirror of learn.Fit, including the evals accounting.
 * @param {*} opts
 * @returns {*}
 */
export function fit(prob, data, lossFunc, opts = null) {
  opts = withDefaults(opts);

  if (opts.method === 'adam' || opts.method === 'gradient-descent') {
    return fitGradientCore(prob, data, opts, lossFunc);
  }

  const [initialParams, indices] = prob.getAllParams();
  if (initialParams.length === 0) throw new Error('no learnable parameters found');

  let evals = 0;

  evals++;
  let sol = prob.solve(opts.solverMethod, opts.solverOptions);
  const initialLoss = lossFunc(sol, data);

  if (opts.verbose) {
    console.log(`Initial loss: ${initialLoss.toFixed(6)}`);
    console.log(`Initial params: ${initialParams}`);
  }

  const objective = (params) => {
    evals++;
    prob.setAllParams(params, indices);
    const s = prob.solve(opts.solverMethod, opts.solverOptions);
    return lossFunc(s, data);
  };

  let finalParams, finalLoss, iters, converged;
  switch (opts.method) {
    case 'nelder-mead':
      [finalParams, finalLoss, iters, converged] = nelderMead(objective, initialParams, opts);
      break;
    case 'coordinate-descent':
      [finalParams, finalLoss, iters, converged] = coordinateDescent(objective, initialParams, opts);
      break;
    default:
      throw new Error(`unknown optimization method: ${opts.method}`);
  }

  prob.setAllParams(finalParams, indices);

  if (opts.verbose) {
    console.log(`Final loss: ${finalLoss.toFixed(6)}`);
    console.log(`Final params: ${finalParams}`);
    console.log(`Iterations: ${iters}, Converged: ${converged}`);
  }

  return {
    params: finalParams,
    initialLoss,
    finalLoss,
    iterations: iters,
    converged,
    evals,
  };
}

/**
 * Convenience: fit per-transition scalar rates of `net` to observed
 * trajectories, analogous to learn.Fit's surface without hand-building the
 * LearnableProblem.
 *
 * opts (all optional):
 *   initialState — defaults to setState(net) (declared markings)
 *   tspan        — defaults to [data.times[0], data.times[last]]
 *   rates        — starting rates per transition; defaults to setRates(net) (1.0)
 *   rateFuncs    — full rate-function map (overrides `rates`; use for tied
 *                  parameters via SharedScalar)
 *   lossFunc     — reporting loss, defaults to mseLoss
 *   plus every fitOptions field (method "adam" or "nelder-mead", maxIters, …)
 *
 * @returns fit result plus `rates` (fitted transition -> rate for scalar
 * rate functions) and `problem` (the LearnableProblem, parameters set).
 * @returns {*}
 */
export function fitRates(net, data, opts = {}) {
  const initialState = opts.initialState ?? setState(net);
  const tspan = opts.tspan ?? [data.times[0], data.times[data.times.length - 1]];
  const rateFuncs = opts.rateFuncs ?? rateFuncsFromRates(opts.rates ?? setRates(net));
  const prob = new LearnableProblem(net, initialState, tspan, rateFuncs);
  const result = fit(prob, data, opts.lossFunc ?? mseLoss, opts);
  const rates = {};
  for (const [name, rf] of Object.entries(rateFuncs)) {
    if (rf.numParams() === 1) rates[name] = rf.getParams()[0];
  }
  result.rates = rates;
  result.problem = prob;
  return result;
}

// ============================================================================
// Exports
// ============================================================================

export default {
  jsParityOptions,
  defaultSolverOptions,
  ScalarRateFunc,
  SharedScalar,
  rateFuncsFromRates,
  fdRateGrad,
  LearnableProblem,
  Sensitivities,
  newDataset,
  interpolateAt,
  interpolateSolution,
  mseLoss,
  rmseLoss,
  relativeMseLoss,
  mseLossGrad,
  rmseLossGrad,
  relativeMseLossGrad,
  hingeRankLoss,
  defaultFitOptions,
  adamMinimize,
  descentBacktracking,
  minimizeGradient,
  nelderMead,
  coordinateDescent,
  minimize,
  fitGradient,
  fit,
  fitRates,
  mseLossAdjoint,
  relativeMseLossAdjoint,
};
