# parity/native — pflow-native vs the browser

The editor runs part of pflow-native's command registry in the browser, as wasm
(`public/vendor/pflow-native-wasm/`, locked by `pflow-native-wasm.lock`). Two
suites keep that honest. Both run in `make test-js` and in CI, headless, from
vendored files only.

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
```

Needs `cargo` and network access to github.com (cargo fetches with the git CLI,
so your credentials apply). `gen/Cargo.toml` pins `pflow-native-core` to the
**same commit the wasm was built from** (`pflow-native-wasm.lock` → `commit`); the
test fails when `goldens.json` was generated from a different one. The generator
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
