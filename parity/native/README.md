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
why); keys named in a step's `ignore` skipped for that step, and so are the
cells of a table artifact's column of that name. Every command in
`NATIVE_COMMANDS` must have at least one successful golden case — the test says
which one is missing.

Each case runs on its own memory store, natively as in wasm (the generator makes
one the thread's store per case, as each wasm `Engine` does), so the `store.*`
cases never touch a data directory. **The wasm build has no clock**
(`store::canon::now_ms` is 0 on wasm32): a stored model's `created` is 0 and an
edge's `at` the zero time, where natively both are the time, and an edge's id
hashes its `at`. The store cases ignore those keys, and no compared listing
holds two clock-stamped edges, whose order (by time, then id) would differ too.
In the browser that means `store.list` cannot order by age and edges sort by id;
a pflow-native follow-up (read the time through `web_time`, as `provenance`
already does).

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
3. Set the `rev` in `gen/Cargo.toml` and the `pflow_native` string in
   `gen/src/main.rs` to `COMMIT`, then `make native-goldens`.
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
| `pflow_sde` | **Exact**, every double. Both sides run go-pflow's portable Euler-Maruyama path (SplitMix64 → xoshiro256**, Marsaglia polar normals over the ported log), which pflow-solver ports byte for byte. They run it on the same model: transitions in id order, and a transition at rate 0 left out with its arcs, as native's `Net::ssa_model` does. A run that overflows comes back with its overflowed values as null on both sides (`overflow-is-null`). |
| `pflow_what_if` | **Exact**. The scenario SSA is go-pflow's `stochastic.Simulate` on the portable path, and pflow-solver's `stochastic` module is its byte-exact port. That covers the time-weighted mean and p95, throughput, depletion, contention, and finals with min/max. |
| `pflow_optimize` | **Exact** where no math library is involved, which is most cases (one per method among them). The server integrates with go-pflow's method tableaux and go-pflow's `Solve` loop (held to it bit for bit by `TestWorkbenchODEIsGoPflowSolve`), but sums each place's flux terms with the transitions in id order, as pflow-solver does; go-pflow's own `Solve` takes them in map order, which rounded differently on every call (and broke exact ties at random, `tie`). A case that samples a rate on a log scale, or whose steps depend on the step controller's x^(1/6), carries a **relative 1e-12**, because 10^x, log10 and pow come from each language's math library and can differ in the last bit. Measured: log-sampled rates within 6e-16, objectives within 3e-13, and 9e-16 on `coffee-colored`. Even then a linearly sampled rate (its table column, its entry in the front's rates, the scatter's x when it is one) is compared exactly. The sampler, the Pareto flags, the front, integers and strings are always exact. A non-finite objective is null on both sides and, comparing as nothing, on the front (`overflow-is-null`). |
| errors | **Exact text.** The tools' messages are ported from native. Three what-if refusals (`a-transition`, `unknown-place`, `remove-too-many`) come from the editor's JavaScript (`sim.what_if` checks its arguments before calling native), so their goldens come from the generator's Rust copy of those checks in `mcp_steps`, not from native. The place list in an SDE refusal's capacity clause is compared as a set (see place order below). |

Numbers are compared by JSON type as well as value: `"3"` is not `3`, and null
is only null.

**Place order.** Native lists places in the document's order. The server cannot:
the JSON-RPC layer decodes the net into an unordered map, and RFC 8259 calls
member order insignificant anyway. So the server lists places in id order, with
colours in declaration order. The test therefore sorts the series by name within
each group of a time series, keeping the groups in order (a what-if's arms);
matches the place columns of the what-if's scenario × place table by header; and
sorts the rows of a finals table by place. Nothing else is reordered. No number
depends on this. The engines draw randomness per transition, and both parsers
sort transition ids.

Fixtures: `sir`, `gated` (where the SDE must refuse but what-if still runs, on the
SSA), `knapsack`, `with-rates` (coloured, gated, a rate of 0), and five made for
this suite. `colored.jsonld` is an ungated two-colour net, so the SDE and a place
with several colour copies are covered. `inert.jsonld` is SIR plus an arc whose
weights are all zero, which native drops (`sim::executable`) and the engines would
otherwise read as weight 1. `tie.jsonld` has an objective no sampled rate can
move, so every sample ties on it exactly and the Pareto front is decided by the
other objective. `explode.jsonld` grows without bound, so the continuous engines
overflow.

Known gaps and deliberate differences, written down here instead of being tested
as passing:

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
- **A seed above 2^53** is refused by the server ("seed must be at most
  9007199254740992"); native takes any integer seed. The JSON-RPC layer decodes
  numbers to float64, where a larger integer can arrive with its low bits gone,
  so the server would silently run a different seed from the one asked for.
- **A solve that runs out of steps is an error.** go-pflow's and pflow-solver's
  ODE solvers stop at 100,000 steps; native's optimizer then reports the state
  where the solve stopped as if it were the state at t_end. The server says
  which sample stopped where instead, and refuses up front a fixed-step method
  (euler, heun, midpoint, rk4) whose dt needs more steps than that over t_end,
  and an abstol or reltol below 1e-12. pflow_simulate and pflow_rate_scan expose
  the same condition as `truncated`.
- **Tighter limits on the server**, none of which change a number: at most 500
  points (SDE) and 500 samples (what-if, optimize) against native's 5000 and
  2000; at most 300 token places (colours unfolded) and 300 transitions; at most
  64 parameters and 16 objectives for the optimizer. Work and memory budgets that
  count places as well as transitions, sized for a second or two of one core:
  the SDE's realizations × sample intervals × (transitions × (places + 50) +
  2 × places) ≤ 100,000,000 and samples × places ≤ 500,000; the what-if SSA's
  realizations × samples × places ≤ 4,000,000 per arm and a step budget per arm
  (go-pflow's `MaxSteps`) of the smaller of 5,000,000 and 45,000,000 / (places +
  6), since every step copies the marking, plus a per-place token cap mid-run;
  the optimizer's solver iterations × stages × (stages × places + arcs +
  transitions + 20) ≤ 2,000,000,000 over every sample, checked before the run
  where the arguments decide it (a fixed step) and as it runs where they cannot.
  Where native would keep running past those, the tool returns an error saying
  what stopped it, never a partial answer.
- **Every answer fits the server's 60 KB result guard whole.** The answer's
  size is bounded before anything runs, every number at its longest (25
  characters) and at its shortest. A count of points or samples the caller chose
  that does not fit is refused, naming one that does; the default is lowered to
  fit and the answer carries a `note` saying so (for the optimizer, the first k
  samples, which is native's answer for k). Native has no such limit, so a case
  in this suite always fits.
- Arguments are type-checked with the tool's own messages. All of the server's
  own limits are tested in `cmd/webserver/mcp_workbench_test.go`, not against
  native.
- **The editor's own `sim.sde` is `petri-sde.js`**, which visits transitions in
  document order (docs/workbench-progress.md, "pflow-native's SSA visits
  transitions in sorted-id order"). Native and the server use id order. On a net
  that lists its transitions in id order, all three agree to the bit.
