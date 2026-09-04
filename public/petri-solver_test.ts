// public/petri-solver_test.ts — guards on the Tsit5 embedded error estimate
// (run via `make test-js`, i.e. deno test). Mirrors go-pflow's
// solver/tsit5_test.go: the same three properties, same thresholds.
//
// The bhat vector is the DIFFERENCE between the 5th-order weights b and the
// embedded 4th-order weights (OrdinaryDiffEq's btilde). A difference of two
// consistent quadrature rules sums to zero; the last entry is b[6] - 1/66 =
// -1/66. It shipped as +1/66 for a long time, which made the vector sum to
// 2/66 and turned the error estimate into ~(2/66)·dt·f — first order — so the
// controller stepped ~10x more per decade of reltol instead of ~10^(1/5)x.
import { assert, assertAlmostEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { solve, Tsit5 } from "./petri-solver.js";

/** A bare problem for solve(): it reads only tspan, u0, f (and colorMap). */
function problem(
    f: (t: number, u: Record<string, number>) => Record<string, number>,
    u0: Record<string, number>,
    tspan: [number, number],
) {
    return { f, u0, tspan, colorMap: null };
}

Deno.test("Tsit5 bhat is b - b4 and sums to zero", () => {
    const s = Tsit5();
    assert(s.b.length === 7 && s.bhat.length === 7, "7-stage tableau");
    let sumB = 0, sumBhat = 0;
    for (let i = 0; i < 7; i++) { sumB += s.b[i]; sumBhat += s.bhat[i]; }
    assertAlmostEquals(sumB, 1, 1e-12, "5th-order weights are a quadrature rule");
    assertAlmostEquals(sumBhat, 0, 1e-12, "error weights are a difference of two rules");
    assertAlmostEquals(s.bhat[6], -1 / 66, 1e-15, "last entry is b[6] - 1/66 = -1/66");
});

Deno.test("Tsit5 error estimate vanishes on constant f", () => {
    // u' = c: every stage derivative is identical, so a consistent
    // difference-of-rules estimate is exactly dt*c*sum(bhat) ~ 0. With the
    // sign bug it was dt*c*2/66 — visible as a step-size clamp on a problem
    // that any RK method integrates exactly.
    const c = 3.0;
    const f = (_t: number, _u: Record<string, number>) => ({ x: c });
    const sol = solve(problem(f, { x: 0 }, [0, 10]), Tsit5(), {
        dt: 0.01, dtmax: 10, reltol: 1e-8, abstol: 1e-10,
    });
    // Exact answer regardless of stepping; the interesting assertion is the
    // step count: a zero estimate lets the controller grow dt by 5x per step
    // up to dtmax, so a handful of steps cover the interval.
    assertAlmostEquals(sol.u[sol.u.length - 1].x, c * 10, 1e-9);
    const steps = sol.t.length - 1;
    assert(steps < 20, `constant-f solve took ${steps} steps; estimate is not ~0`);
    // And the estimate itself, evaluated the way solve() does it.
    const s = Tsit5();
    let errest = 0;
    for (let j = 0; j < s.bhat.length; j++) errest += 0.5 * s.bhat[j] * c;
    assert(Math.abs(errest) < 1e-14, `errest on constant f = ${errest}`);
});

Deno.test("Tsit5 step count grows less than 3x per decade of reltol", () => {
    // Exponential decay u' = -u on [0, 10]. For a 5th-order controller the
    // accepted-step count scales like reltol^(-1/5) ≈ 1.58x per decade; a
    // first-order estimate scales like reltol^-1, 10x per decade.
    const f = (_t: number, u: Record<string, number>) => ({ x: -u.x });
    const count = (reltol: number) => {
        const sol = solve(problem(f, { x: 1 }, [0, 10]), Tsit5(), {
            dt: 0.01, dtmax: 10, reltol, abstol: reltol * 1e-3, maxiters: 10_000_000,
        });
        assertAlmostEquals(sol.u[sol.u.length - 1].x, Math.exp(-10), 100 * reltol);
        return sol.t.length - 1;
    };
    const tols = [1e-3, 1e-4, 1e-5, 1e-6, 1e-7];
    const counts = tols.map(count);
    for (let i = 1; i < counts.length; i++) {
        const ratio = counts[i] / counts[i - 1];
        assert(ratio < 3, `reltol ${tols[i - 1]} -> ${tols[i]}: steps ${counts[i - 1]} -> ${counts[i]} (x${ratio.toFixed(2)})`);
    }
});
