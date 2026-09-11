// petri-sde.js — Chemical Langevin SDE: the third leg of Petri.jl's
// ODEProblem/JumpProblem/SDEProblem trio (go-pflow ROADMAP.md G6), a port of
// go-pflow's `stochastic/sde.go`. Continuous state, but with the net's own
// intrinsic firing noise rather than SSA's discrete events or the ODE's none
// at all — Euler-Maruyama over the same propensities and stoichiometry
// petri-ssa.js's `compile()` already extracts for SSA.
//
// Refuses a gated model (any read arc, inhibitor or reachable capacity)
// exactly as go-pflow's `Forecast`/`SimulateSDE` do: a firing instant is what
// those need, and continuous diffusion has none.
//
// Part of the byte-exact cross-language contract the way SSA is: `parity/sde/`
// holds the same five models as `parity/ssa/` (chain, sir, dimer, gates,
// coffeeshop), replayed bit-for-bit by `petri-sde_test.ts` — closing the
// pflow-xyz side of a contract go-pflow↔pflow-rs already held. The Gaussian
// sampler is additionally checked bit-for-bit against go-pflow's own
// `stochastic/portable_test.go` `TestPortableNormalVectors` (Go is the
// reference implementation for normal(): no external SDE spec, the same role
// it plays for wait()/uniform() in ssa-spec.md).
//
// No DOM, no dependencies beyond ./petri-ssa.js (PRNG, plog, compile()).

import { combinations, compile, plog, Xoshiro256 } from "./petri-ssa.js";

// ─── 1. Gaussian sampler ────────────────────────────────────────────────────

/**
 * Standard normal via the Marsaglia polar method, exactly go-pflow's
 * `portableSampler.normal()`: needs only `Math.sqrt` (IEEE-754-exact and
 * identical across every conformant runtime, unlike `Math.log`, so it needs
 * no port) and `plog`, both already part of petri-ssa.js's contract —
 * deliberately not Box-Muller, which would need a second ported
 * transcendental (sin/cos) this codebase has no reference implementation for.
 *
 * The spare-value cache is load-bearing, not an optimization: two
 * consecutive `normal()` calls on one accepted (u1, u2) pair must return
 * `u1*mul` then `u2*mul` from that SAME pair, or the stream diverges from
 * go-pflow's from the second value on.
 */
export class GaussianSampler {
    /** @param {bigint|number} seed */
    constructor(seed) {
        this.rng = new Xoshiro256(seed);
        this.hasSpare = false;
        this.spare = 0.0;
    }

    /** @returns {number} */
    normal() {
        if (this.hasSpare) {
            this.hasSpare = false;
            return this.spare;
        }
        for (;;) {
            const u1 = 2 * this.rng.uniform() - 1;
            const u2 = 2 * this.rng.uniform() - 1;
            const sq = u1 * u1 + u2 * u2;
            if (sq > 0 && sq < 1) {
                const mul = Math.sqrt((-2 * plog(sq)) / sq);
                this.spare = u2 * mul;
                this.hasSpare = true;
                return u1 * mul;
            }
        }
    }
}

// ─── 2. Continuous propensity ──────────────────────────────────────────────

/**
 * `combinations(m, w)` (spec-pinned, integer `m`) generalized to continuous
 * state: the same falling-factorial product evaluated at a real `x`, which
 * agrees with `combinations(m, w)` at every non-negative integer `m` — the
 * property that makes this the continuum limit rather than an arbitrary
 * generalization.
 *
 * Below `x = w - 1` the product can go negative (e.g. x=0.5, w=2:
 * 0.5×-0.5/2 = -0.125) — not a bug, the same "wrong near zero" behaviour
 * go-pflow's copy documents; callers clamp the resulting propensity at zero
 * rather than let a negative term flip a sign.
 * @param {number} x
 * @param {number} w
 * @returns {number}
 */
export function combinationsReal(x, w) {
    if (w <= 0) return 1.0;
    let result = 1.0;
    for (let i = 0; i < w; i++) {
        result = result * (x - i);
        result = result / (i + 1);
    }
    return result;
}

function compileSDE(compiled) {
    const nP = compiled.places.length;
    return compiled.transitions.map((t) => {
        const delta = new Array(nP).fill(0.0);
        const terms = [];
        for (const [p, w, kinetic] of t.inputs) {
            delta[p] -= w;
            if (kinetic) terms.push([p, w]);
        }
        for (const [p, w] of t.outputs) delta[p] += w;
        return { rate: t.rate, terms, delta };
    });
}

function propensity(t, x) {
    let a = t.rate;
    for (const [p, w] of t.terms) {
        a = a * combinationsReal(x[p], w);
        if (a <= 0) return 0.0;
    }
    return a;
}

/**
 * True if the model has anything an SDE (or the ODE) cannot express: a read
 * arc, an inhibitor, a non-kinetic input, or a reachable capacity. Mirrors
 * go-pflow's `Model.Gating()` wording field for field (arc counts, an
 * `[a b c]`-style place list) — ported from pflow-rs's `sde.rs::gating_reasons`,
 * which was itself rewritten to match go-pflow's exact strings so the
 * `diverged` reason/caveats are part of the byte-exact `parity/sde/` contract,
 * not just its "contains" cousin.
 * @returns {string[]}
 */
function gatingReasons(compiled) {
    const reasons = [];

    const reads = compiled.transitions.reduce((n, t) => n + t.reads.length, 0);
    const inhibits = compiled.transitions.reduce((n, t) => n + t.inhibits.length, 0);
    const staticArcs = compiled.transitions.reduce(
        (n, t) => n + t.inputs.filter(([, , kinetic]) => !kinetic).length,
        0,
    );

    if (reads > 0) {
        reasons.push(`${reads} read arc(s) gate a firing without consuming; a continuous solver cannot test them`);
    }
    if (inhibits > 0) {
        reasons.push(`${inhibits} inhibitor arc(s) block a firing above a threshold; a continuous solver cannot test them`);
    }
    if (staticArcs > 0) {
        reasons.push(
            `${staticArcs} non-kinetic input arc(s) gate and consume without scaling the rate; a mass-action solver has no way to omit them from the rate law`,
        );
    }

    // Distinct places a capacity is declared *and* reachable on (some
    // transition's net delta there is positive), in place-declaration
    // order — the same set `compile()` already applied when populating each
    // transition's `caps`.
    const caps = compiled.places.filter((_, p) =>
        compiled.transitions.some((t) => t.caps.some(([cp]) => cp === p))
    );
    if (caps.length > 0) {
        reasons.push(`capacity is declared on [${caps.join(" ")}] but is a post-firing bound, which has no continuous analogue`);
    }

    if (compiled.transitions.some((t) => t.delay > 0)) {
        reasons.push("a delay is a deterministic timer — inputs consumed at start, outputs a fixed time later — which mass action cannot express");
    }
    return reasons;
}

// ─── 3. Euler-Maruyama path ─────────────────────────────────────────────────

// How many substeps run between each reported sample point. Matches
// go-pflow's `sdeInternalSubsteps` exactly — chosen empirically against the
// consistency tests, not derived, and deliberately not a public option for
// the same reason it isn't one there.
const INTERNAL_SUBSTEPS = 20;

function sdePath(trs, x0, times, rng) {
    const n = x0.length;
    const S = times.length;
    const out = [x0.slice()];
    const x = x0.slice();

    const dtOuter = S > 1 ? (times[S - 1] - times[0]) / (S - 1) : 0.0;
    const dt = dtOuter / INTERNAL_SUBSTEPS;
    const sqrtDt = Math.sqrt(dt);

    const drift = new Array(n).fill(0.0);
    for (let gi = 1; gi < S; gi++) {
        if (dt > 0) {
            for (let sub = 0; sub < INTERNAL_SUBSTEPS; sub++) {
                drift.fill(0.0);
                for (const t of trs) {
                    const a = propensity(t, x);
                    if (a === 0) continue;
                    const noise = Math.sqrt(a) * sqrtDt * rng.normal();
                    for (let p = 0; p < n; p++) {
                        const d = t.delta[p];
                        if (d === 0) continue;
                        drift[p] += d * a * dt;
                        x[p] += d * noise;
                    }
                }
                for (let p = 0; p < n; p++) {
                    x[p] += drift[p];
                    if (x[p] < 0) x[p] = 0.0;
                    drift[p] = 0.0;
                }
            }
        }
        out.push(x.slice());
    }
    return out;
}

// ─── 4. Ensemble ────────────────────────────────────────────────────────────

/** go-pflow's `ChemicalLangevinAssumption`, word for word. */
export const CHEMICAL_LANGEVIN_ASSUMPTION =
    "this engine approximates the discrete firing process as continuous diffusion (the chemical Langevin equation), which is accurate when populations are large enough that the gap between SSA and this engine's mean is small (see the model's own consistency margin) and breaks down near zero, where a place's state is clamped rather than allowed to go negative.";

const M64 = 0xFFFFFFFFFFFFFFFFn;

/**
 * Simulate an ensemble of SDE sample paths and return the grid statistics —
 * the same shape petri-ssa.js's `simulate()` returns, plus `diverged`,
 * `reason` and `caveats` for a refused (gated) model.
 *
 * @param {Object} model - metamodel-shaped (see petri-ssa.js's compile())
 * @param {{horizon: number, samples: number, realizations: number, seed: number|bigint}} options
 * @returns {{places: string[], times: number[], series: Object.<string,{values:number[], stddev?:number[]}>, final: Object.<string,number>, diverged: boolean, reason?: string, caveats?: string[]}}
 */
export function simulateSDE(model, options) {
    const compiled = compile(model);
    const horizon = Number(options.horizon);
    const S = Number(options.samples);
    const R = Number(options.realizations);
    if (!(S >= 2)) throw new Error("petri-sde: samples must be >= 2");
    if (!(R >= 1)) throw new Error("petri-sde: realizations must be >= 1");

    const step = horizon / (S - 1);
    const times = new Array(S);
    for (let i = 0; i < S; i++) times[i] = i * step;

    const caveats = gatingReasons(compiled);
    if (caveats.length > 0) {
        return {
            places: compiled.places.slice(),
            times,
            series: {},
            final: {},
            diverged: true,
            reason: `this model constrains firing in ways continuous diffusion cannot express, so the SDE would silently model an unconstrained system. Use the discrete engine (Simulate). Specifically: ${caveats.join("; ")}`,
            caveats,
        };
    }

    const trs = compileSDE(compiled);
    const nP = compiled.places.length;
    const x0 = compiled.initial.map(Number);

    let base = BigInt(options.seed ?? 0) & M64;
    if (base === 0n) base = 1n;

    const sums = [];
    const sumsq = [];
    for (let p = 0; p < nP; p++) {
        sums.push(new Array(S).fill(0.0));
        sumsq.push(new Array(S).fill(0.0));
    }

    for (let r = 0; r < R; r++) {
        const rng = new GaussianSampler((base + BigInt(r)) & M64);
        const path = sdePath(trs, x0, times, rng);
        for (let gi = 0; gi < S; gi++) {
            const x = path[gi];
            for (let p = 0; p < nP; p++) {
                sums[p][gi] += x[p];
                sumsq[p][gi] += x[p] * x[p];
            }
        }
    }

    const n = R;
    const series = {};
    const final = {};
    for (let p = 0; p < nP; p++) {
        const values = new Array(S);
        for (let i = 0; i < S; i++) values[i] = sums[p][i] / n;
        const entry = { values };
        if (R > 1) {
            const stddev = new Array(S);
            for (let i = 0; i < S; i++) {
                let variance = sumsq[p][i] / n - values[i] * values[i];
                if (variance < 0) variance = 0.0;
                stddev[i] = Math.sqrt(variance);
            }
            entry.stddev = stddev;
        }
        series[compiled.places[p]] = entry;
        final[compiled.places[p]] = values[S - 1];
    }

    return { places: compiled.places.slice(), times, series, final, diverged: false };
}

export default { GaussianSampler, combinationsReal, simulateSDE, CHEMICAL_LANGEVIN_ASSUMPTION };
