# parity/native — pflow-native vs the browser

The editor runs part of pflow-native's command registry in the browser, as wasm
(`public/vendor/pflow-native-wasm/`, locked by `pflow-native-wasm.lock`). Two
suites keep that honest. Both run in `make test-js` and in CI, headless, from
vendored files only. A third holds the hosted `/mcp` server's workbench tools
(Go) to the same native build; it runs in `go test ./...` (`make test`, CI).

## native vs wasm (`native_parity_test.ts`)

`goldens.json` is the output of pflow-native run **natively** (Rust, not wasm) on
the cases in `cases.json`; the test replays the same inputs through the vendored
wasm and compares. Comparison: strings, structure and integers exact; any number
with a fraction to a relative 1e-9 (a case may set another `tolerance` and say
why); keys named in a step's `ignore` skipped for that step. Every command in
`NATIVE_COMMANDS` must have at least one successful golden case — the test says
which one is missing.

`cases.json` — one **session** per case: load a fixture (paths relative to
`parity/`: the shared `parity/fixtures/` nets and `native/fixtures/`: `sir` with
rates, `gated` with capacities, an inhibitor arc and rates), then run the steps in
order, so a command that needs an artifact follows the one that makes it
(`data.generate` → `data.conformance {log: "a1"}`). A step with `generate_only` is
run by both sides (so artifact ids line up) but compared on neither; a later
step takes its output as input with `{"$result": [step, key…]}` (a receipt signed
by one engine, verified by the other).

### Regenerating the goldens

```sh
make native-goldens        # cargo run --release --manifest-path parity/native/gen/Cargo.toml
make test-js
go test ./cmd/webserver/ -run TestMCPWorkbenchMatchesNative
```

One run writes both `goldens.json` and `mcp_goldens.json` (`--only registry` or
`--only mcp` writes one). Needs `cargo` and network access to github.com (cargo
fetches with the git CLI, so your credentials apply). `gen/Cargo.toml` pins
`pflow-native-core` to the **same commit the wasm was built from**
(`pflow-native-wasm.lock` → `commit`); both tests fail when their goldens were
generated from a different one. The generator
is a standalone Cargo project: not in the Go build, not in Bazel. The receipt
case embeds a freshly signed receipt, so that one case's golden changes on every
run; the rest is deterministic.

### Re-vendoring the wasm

1. In pflow-native: `make wasm-shim` (size-optimised wasm-bindgen build).
2. `make sync-native-wasm FROM=../pflow-native/target/wasm-shim COMMIT=<sha>` —
   copies the glue, gzips the wasm, snapshots the specs of `EXPOSED` into
   `commands.js` and rewrites the lock. It fails when an exposed id collides with
   a JS command, or when the engine has a command that is neither exposed, a JS
   id, nor listed in `NOT_EXPOSED` (a new command needs a decision).
3. Set the `rev` in `gen/Cargo.toml` to `COMMIT`, then `make native-goldens`.
4. `node scripts/gen-llm-tools.mjs` (the chat's tool manifest) and `make test-js`.

## JS vs wasm (`js_vs_wasm_test.ts`)

For the ids both engines have, the page's JS implementation (which wins in the
registry; the native id is not exposed) against the wasm one, on the same
(normalised) model: `file.cid` exact, `sim.enabled` and a lockstep
`sim.fire` + `sim.marking` walk exact, `sim.ode` final state to a relative 1e-9
**with the same solver options passed to both**, `net.info` ids, counts, markings,
rates and arcs.

Known gap (an ignored test, one per fixture): with **default** options `sim.ode`
differs, because the page leaves `dtmax` to `petri-solver.js` (0.1) while
pflow-native defaults it to `min(0.1, t_end/50)`. For `t_end < 5` the final states
then differ at the 1e-7 to 1e-3 level (relative; on a place near zero). With the
same `dtmax` they agree to the last bits.

## /mcp workbench tools vs native (`cmd/webserver/mcp_workbench_parity_test.go`)

The hosted `/mcp` server serves `pflow_sde`, `pflow_what_if` and
`pflow_optimize`: the editor's `sim.sde`, `sim.what_if` and `opt.optimize`
without a browser. The engines are go-pflow's. Everything around them is ported
from pflow-native-core at the pinned commit (`cmd/webserver/mcp_workbench_engine.go`):
defaults, caps, validation and its messages, realization seeding, aggregation and
the shape of the answer.

`mcp_cases.json` holds one tool call per case: a fixture, a tool and its
arguments. The generator (`mcp_steps` in `gen/src/main.rs`) turns each call into
the native commands the editor runs for it, in a fresh session on the fixture:

- `pflow_sde` runs `sim.sde` with the same arguments (`places` only filters the
  returned series).
- `pflow_what_if` does what `sim.what_if` in `public/petri-commands.js` does:
  `sim.compare` of `{name: "as is", hours, realizations, seed}` and
  `{name: "+δ place", …, marking: {place: now + δ}}` on the shared seed. It then
  runs `sim.scenario` of each arm with `summary: true`, which is the same run on
  the same seed, for its finals table (mean, sd, min, max).
- `pflow_optimize` runs `opt.optimize` with the same arguments.

It writes `mcp_goldens.json`. Each case has the commands (`native`) and either
their answer in the tool's shape (`expect`, with each artifact inlined as its
data) or the refusal (`error`). The Go test replays every call through the tool's
own handler. Every tool must have at least one successful case.

| what | compared |
|---|---|
| `pflow_sde` | **Exact**, every double. Both sides run go-pflow's portable Euler-Maruyama path (SplitMix64 → xoshiro256**, Marsaglia polar normals over the ported log), which pflow-solver ports byte for byte. They run it on the same model: transitions in id order, and a transition at rate 0 left out with its arcs, as native's `Net::ssa_model` does. |
| `pflow_what_if` | **Exact**. The scenario SSA is go-pflow's `stochastic.Simulate` on the portable path, and pflow-solver's `stochastic` module is its byte-exact port. That covers the time-weighted mean and p95, throughput, depletion, contention, and finals with min/max. |
| `pflow_optimize` | **Relative 1e-9** on numbers with a fraction, the suite's ODE tolerance. The sampler (native's splitmix64), integers, strings and the Pareto flags are exact. There are two reasons for the tolerance. First, both sides run the same Tsit5 with the same step control, but go-pflow builds its state vector and transition list by map iteration, so its derivative sums round differently; they differ even between two identical Go calls, by about 1e-15 relative. Second, log sampling takes 10^x and log10 from each language's math library. |
| errors | **Exact text**, since native's messages are ported. The one exception is the place list in an SDE refusal's capacity clause, which is compared as a set (see place order below). |

**Place order.** Native lists places in the document's order. The server cannot:
the JSON-RPC layer decodes the net into an unordered map, and RFC 8259 calls
member order insignificant anyway. So the server lists places in id order, with
colours in declaration order. The test therefore matches series by (group, name),
table columns by header and finals rows by place. No number depends on this. The
engines draw randomness per transition, and both parsers sort transition ids.

Fixtures: `sir`, `gated` (where the SDE must refuse but what-if still runs, on the
SSA), `knapsack`, `with-rates` (coloured, gated, a rate of 0), and three made for
this suite. `colored.jsonld` is an ungated two-colour net, so the SDE and a place
with several colour copies are covered. `inert.jsonld` is SIR plus an arc whose
weights are all zero, which native drops (`sim::executable`) and the engines would
otherwise read as weight 1.

Known gaps, written down here instead of being tested as passing:

- **Stiff nets, for the optimizer.** On `with-rates` with RestockBeans at its
  declared 720 against abstol 1e-4, the finals are limited by the solver
  tolerance. ServedCoffee comes out as noise of about ±3e-4 whatever rate is
  sampled. The two solvers' adaptive step sequences part, the finals differ at
  the tolerance's scale (up to 7e-5 relative measured), and Pareto flags between
  near-ties can flip. The suite's case on that net samples RestockBeans in a
  non-stiff range instead.
- **sim's `{transition: [min, max]}` parameters** are read in the object's key
  order by native, and in id order by the server, for the same reason as place
  order. The case lists its keys in id order.
- **Tighter caps on the server.** At most 500 points (SDE) and 500 samples
  (what-if, optimize), against native's 5000 and 2000. There is also a work
  budget on the SDE (runs × sample intervals × transitions ≤ 4,000,000), and for
  the what-if SSA a step budget (go-pflow's `MaxSteps`, 5,000,000 per arm) and a
  per-place token cap mid-run. Where native would keep running past those, the
  tool returns an error saying what stopped it, never a partial answer.
  Arguments are type-checked with the tool's own messages. All of this is tested
  in `cmd/webserver/mcp_workbench_test.go`, not against native.
- **The editor's own `sim.sde` is `petri-sde.js`**, which visits transitions in
  document order (docs/workbench-progress.md, "pflow-native's SSA visits
  transitions in sorted-id order"). Native and the server use id order. On a net
  that lists its transitions in id order, all three agree to the bit.
