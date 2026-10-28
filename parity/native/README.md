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
rates, `gated` with capacities, an inhibitor arc and rates, `tic-tac-toe.json`
a byte-identical copy of pflow-native's `examples/tic-tac-toe.json` for the
`game.*` cases), then run the steps in
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
5. Pin the CDN copy of the same build: in pflow-native `make wasm-publish`
   (publishes `target/wasm-shim` to cdn.stackdump.com under the .wasm's content
   address and prints the URL), then
   `node scripts/sync-native-wasm.mjs --cdn https://cdn.stackdump.com/ipfs/<cid>/`.
   It refuses a URL whose .wasm or glue is not the vendored build, and writes
   `public/vendor/pflow-native-wasm/cdn.js` and the lock's `cdn` entry. The page
   then loads the engine from the CDN, keeps it only if it hashes to the pinned
   sha256, and otherwise uses the vendored copy (`engineState.source`). A
   re-vendor without `--cdn` deletes the old pin, so a page never fetches
   another build than the one it vendors.

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

## /mcp game tools vs native (`cmd/webserver/mcp_game_parity_test.go`)

`pflow_game_value` and `pflow_game_move` are pflow-native's `game.value` and
`game.move` (an exact alpha-beta search of a net read as a two-sided game) on the
hosted `/mcp` server, which runs Go on go-pflow and cannot reach the wasm. The
search is `internal/gamesearch`, a Go port of pflow-rs' `pflow-metamodel` game
search (transposition table, move-order pieces, filters, `null_window` and
`mtd_f`, `aspiration`, node budget, opening book, root `non_losing` and the root
estimate `ode`) with pflow-native's
command layer (`crates/core/src/commands/game.rs`, `game.rs`): same arguments
(`sides`, `reward`, `auto`, `plan`, `nodes`, `book`, plus the net in the call),
same results, same refusals. go-pflow is used unmodified (its model and parser).

`game_goldens.json` is native's answer to every call in `game_cases.json`, which
`gen-game/make_cases.py` writes: tic-tac-toe, Connect-3, Connect-4 (a table key of
three words), Nim (a pile of more than one token: the counts engine from the
root), a tic-tac-toe with a counter place (the bit engine spills to counts
mid-search), one with 230 more places (no bit engine at all), one whose win
detectors read a cell twice (the bit and counts deficits differ), a bucket with a
capacity, a weight-2 arc and a read arc, prize games with 13 and 9 distinct
rewards (so `null_window` and `mtd_f` take different paths), Nim with a reward of
one place (two distinct rewards) and tic-tac-toe rewarded by its 18 cells (too many
rewards to step through), and three games on nets with two and three token colours
(a place with a count per colour; a reward naming a place or one `place.colour`
copy); random positions of each, under every exact plan piece alone and in
combination, tiny tables (1 to 100 entries, where which entry a full bucket gives
up changes the node count), tiny budgets, play mode, books built from native's own
values, the root estimate `ode` and the `aspiration` driver in a score of
combinations (with `non_losing`, each window driver, no window driver, other
orders and filters, small tables, node budgets and play mode), and the refusals.
The test replays each through the tool's handler and compares exactly: the value,
the move, the node count, the budget, and the words of an error.

```sh
make game-goldens                          # pflow-native at the commit in gen-game/Cargo.toml
make game-goldens PFLOW_RS=../pflow-rs     # ... against a pflow-rs checkout (crates of PFLOW_RS_REV)
go test ./cmd/webserver/ -run TestMCPGameMatchesNative
```

`gen-game/Cargo.toml` pins pflow-native at the commit that has the commands
(`7d3a972`, feat/portable-cr-pow, newer than the wasm in
`pflow-native-wasm.lock`, which has neither), so these goldens are generated
apart from `goldens.json` and `mcp_goldens.json`; the file records both commits
and a test checks them against the generator's pins. pflow-native pins pflow-rs
at `a1c4b55`: main (`aacb7eb`, the search this port follows, with the `mtd_f`
driver, the refusal of a repeated driver, the counts engine's Zobrist key and
`pflow_solver::game::OdeEstimate`) plus `pflow_solver::crmath`, the correctly
rounded pow the ODE step control now calls. (The goldens were first generated
at pflow-native `cc2c63b` / pflow-rs `35be807`, with the platform's `powf`;
regenerated at the new pins every one of the 5,048 cases is byte-identical.)
Native is run as a library (`Session::execute`, as `gen/` does), not through
`pflow-native-cli`: the same code path. Regenerating is deterministic and
platform-independent: the file is byte-identical when generated on macOS /
arm64 and on Linux / x86_64, and the browser's build answers every case the
same (below).

```sh
make game-wasm-check WASM=../pflow-native/target/wasm-shim   # every case through the wasm shim, under Node
```

### The root estimate, and what parity means for it

The `ode` estimate guesses the value after each of the root's moves by solving
the net's mass-action ODE (every transition at rate 1) and reading the reward off
the end; the guess orders the root's moves, and `aspiration` starts the run of
yes/no searches at it. A guess never changes a value, but it decides the order
in which equally good moves are tried, so the node count and which of several
best moves comes back. On a symmetric position the guesses of mirror moves
differ only by rounding noise, so the Go estimate must be bit-identical to
Rust's: `internal/gamesearch/ode.go` repeats `integrate_vec`'s arithmetic
operation for operation (no fused multiply-add, Rust's `min`/`max`/`sum`
semantics), and the step controller's pow is not the language's own on either
side: pflow-solver calls `crmath::pow` and this port go-pflow's `crmath.Pow`,
the same correctly rounded function, written with IEEE `+ - * /` only and held
to one corpus (`parity/crmath/pow.txt`, which `crPow` in `petri-solver.js` is
held to as well). Before that, Rust called the platform libm's `powf` (wrong on
0.135% of controller-sized inputs on macOS 15, 0.063% on glibc, more in wasm32)
and Go a double-double pow seeded by `math.Log`.

- **Required, and held by every golden**: identical values and moves.
- **Node counts: exact, no tolerance**, on every golden. Among 5,048 calls, 2,747
  name `ode`, and the file is byte-identical whether native generates it on
  macOS (arm64) or Linux (x86_64); the Go tool on darwin/arm64 and Linux/amd64
  matches it, and so does the browser's wasm build:
  `parity/native/wasm_game_check.mjs` runs every case through a pflow-native
  wasm shim under Node and compares exactly. Built from pflow-native main (the
  platform `powf`), the shim differed on 30 cases (tic-tac-toe `ode` positions,
  a node or two apart); built from `7d3a972`, on none.
- Nothing platform-dependent is left on this path: no libm call, and no
  multiply-add a compiler may fuse (go-pflow's `scripts/fma-check.sh` shows
  none in its solver; `internal/gamesearch/ode.go` wraps each product).

Known differences, all deliberate and tested in `mcp_game_test.go`:

- **Tighter caps**: at most 10,000,000 nodes (native 100,000,000) and 2^21 table
  entries (native 2^23), so a call fits the 60 s timeout and the memory of eight
  at once; native's words, with the cap. A call whose context ends stops the
  search and is an error, never a value. The search runs at about two
  microseconds a node here.
- **Names**: `pflow_game_value` / `pflow_game_move` (the repo's convention, as
  `pflow_sde` is `sim.sde`), and `tools/call` also takes `game.value` and
  `game.move`. A dotted name is not one every MCP client accepts in a tool list.
- **No Report artifact** (native stores each result as one; the tool is
  stateless).
- **Order of a JSON object's members**: they arrive sorted, not as written, so
  `sides`, `reward` and a plan are read in id order. That changes which of two
  mistakes is reported first, and the order a reward's weights are summed in
  (not their value, for the weights a game has). Places and transitions are in
  id order on both sides (both parsers sort), so moves tie-break the same way.
- **Coloured nets**: the unfolded places are in id order, a document place's
  colours in declaration order; native lists them in document order, so a
  reward naming a place (all its copies) sums its weights in another order, which
  changes nothing for the weights a game has. A colour copy nothing marks or
  touches is refused as native refuses it, but the parser drops such copies, so a
  net cannot reach it (a unit test builds the model by hand).
- Parse errors of a JSON string argument are worded as serde_json words the
  common ones ("expected value", "EOF while parsing a value"), without its
  " at line 1 column 7".
