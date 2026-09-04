// parity/ode/ode_expected_test.ts — public/petri-solver.js replayed against
// go-pflow's recorded Tsit5 trajectories (parity/ode/expected.json, generated
// by parity/ode/gen from fixtures.json). Run via `make test-js`.
//
// ode_parity_test.go compares JS against whatever go-pflow the module pins,
// live; this test compares JS against the trajectories a KNOWN go-pflow
// produced, so it is the gate that holds while go.mod still pins a release
// that predates a solver fix — the goldens are regenerated from the fixed
// checkout and the JS must match them before the Go pin can be bumped.
//
// The bound is relative, not exact: the two integrators are the same tableau,
// controller and defaults, but Go's math.Pow and V8's Math.pow differ by 1-2
// ulp on the controller's fractional exponent, which perturbs an accepted dt
// in its last bit. Step counts must agree exactly; a differing count means a
// step acceptance flipped, which is a real behavioral divergence.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import fixtures from "./fixtures.json" with { type: "json" };
import expected from "./expected.json" with { type: "json" };
import { fromJSON, setState, setRates, ODEProblem, solve, Tsit5 } from "../../public/petri-solver.js";

const REL_TOL = 1e-12;

// deno-lint-ignore no-explicit-any
type Any = any;

function relErr(actual: number, want: number): number {
  const scale = Math.max(Math.abs(actual), Math.abs(want), 1);
  return Math.abs(actual - want) / scale;
}

Deno.test("expected.json was generated from this fixtures.json", async () => {
  const raw = await Deno.readFile(new URL("./fixtures.json", import.meta.url));
  const digest = await crypto.subtle.digest("SHA-256", raw);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  assertEquals(hex, (expected as Any).fixturesSha256, "fixtures.json changed: run `make ode-expected`");
});

const byName = new Map<string, Any>((expected as Any).models.map((m: Any) => [m.name, m]));

for (const entry of (fixtures as Any).models) {
  Deno.test(`ode expected [${entry.name}]: petri-solver.js matches go-pflow trajectory (<= ${REL_TOL} rel)`, () => {
    const want = byName.get(entry.name);
    assert(want, `no expected trajectory for ${entry.name}`);

    const net = fromJSON(JSON.stringify(entry.model));
    const state = setState(net);
    const rates = setRates(net, entry.rates ?? null);
    const sol = solve(new ODEProblem(net, state, entry.tspan, rates), Tsit5(), {});

    assertEquals(sol.t.length - 1, want.steps, "accepted step count");
    let worst = 0;
    for (let i = 0; i < sol.t.length; i++) {
      const e = relErr(sol.t[i], want.t[i]);
      assert(e <= REL_TOL, `t[${i}]: js ${sol.t[i]} vs go ${want.t[i]} (rel ${e})`);
      worst = Math.max(worst, e);
      for (const place of want.places) {
        const v = sol.getState(i)[place];
        assert(v !== undefined, `place ${place} missing from JS state at step ${i}`);
        const eu = relErr(v, want.u[place][i]);
        assert(eu <= REL_TOL, `u[${i}][${place}]: js ${v} vs go ${want.u[place][i]} (rel ${eu})`);
        worst = Math.max(worst, eu);
      }
    }
    const final = sol.getFinalState();
    for (const [place, v] of Object.entries(want.final) as [string, number][]) {
      assert(relErr(final[place], v) <= REL_TOL, `final[${place}]: js ${final[place]} vs go ${v}`);
    }
  });
}
