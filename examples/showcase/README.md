# The pflow showcase: one café, told once per tool

Every feature the pflow suite has, exercised by a single model family. The
*theme* is a one-barista café; each *variation* re-tells it in the shape one
family of tools needs, so the vocabulary (queue, barista, machine, beans,
served, walked out) is the same in every file while the features differ.
This is the same café as the coffee-shop SSA goldens shared by go-pflow,
pflow-rs, pflow-xyz and pflow-jl, the polyglot coffee machine, and the
colored coffee-shop example this directory's theme names as its parent.

Every claim below was produced by running the real tool on the real file on
2026-09-06 against the live `pilot.pflow.xyz/mcp` server and the local
checkouts. `check.sh` re-runs the offline half.

## Why two JSON shapes

The suite has two model encodings and no tool reads both for every feature:

| shape | files here | places/transitions | arcs | carries |
|---|---|---|---|---|
| **pflow.xyz JSON-LD** (`@context: https://pflow.xyz/schema`) | `cafe.jsonld` | objects keyed by id | `source`/`target`, `weight` vector, `inhibitTransition` | colors, per-color capacity, roles, labels, positions, `parents`, CID |
| **go-pflow metamodel** (flat v1) | every `cafe-*.json` | arrays of `{id}` | `from`/`to`, `type: read\|inhibitor`, `kinetic: false` | `rate`, `schedule`, `stages`, `parameters`, `simulation.objective`, `presentation`, `views`, events, roles, access |

The pilot accepts both, plus the S-expression token-model DSL
(`cafe-loyalty.pflow`), a `PetriNetBundle` (`cafe.bundle.json`) and an
Application spec (`cafe-application.json`).

## The score

| movement | file | features it carries | tools verified on it |
|---|---|---|---|
| **Theme** | `cafe.jsonld` | 4 token colors in one pantry place, vector weights with explicit zeros, per-color capacity, weighted inhibitor, output-side inhibitor as read arc, roles, labels, `parents` provenance, `@id` = CID | pflow.xyz editor, `petri-sim.js` replay, Go/JS/Julia CID parity, `petri_validate`, `petri_simulate`, `petri_verify` (colored, base-name properties), `petri_visualize` |
| **I. Kinetics** | `cafe-kinetics.json` | mass-action rates, weight-2 arc (ODE vs SSA rate law differ by design), no gates | `petri_ode`, `petri_stochastic` (+`record_events`), `petri_fit`, `petri_fit_discrete`, `petri_rate_scan`, `petri_ode_sweep`, `petri_phase_plot`, `petri_ode_sensitivity` (analytic), `petri_param_heatmap`, `petri_optimize`, `petri_sankey`, `petri_heatmap`, `petri_distribution` (ssa), go-pflow portable SSA |
| **II. Service** | `cafe-service.json` | `kinetic:false` pickups, `schedule` day shape, `stages` Erlang-3, read arc, inhibitor pre-emption, `capacity` balking, kinetic patience, declared `parameters`, `simulation.objective`, `simulation.solver.rates` zero, `presentation` (groups, labels, units, disruptions), `views`, outcome `tags`, `resource` places | `petri_validate`, `petri_verify`, `petri_scenario` (5 what-ifs, one seed), `petri_ode` refusal with caveats, `petri_stochastic`, go-pflow `ValidateSchedules`/`ValidateParameters`/`ExpandStages`/`SimulateSchedule`; sim.pflow.xyz `sim_diagnose`, `sim_invariants`, `sim_compare` (with a `params` override), `sim_verify`, `sim_classify`, `sim_publish` |
| **III. Order workflow** | `cafe-order.json` | token-only workflow net, `event` per transition with typed fields, roles with inheritance, access rules, constraint, status, admin, navigation, event sourcing, GraphQL | `petri_verify` (all exhaustive), `petri_conformance`, `petri_migrate`, `petri_extend` + `petri_diff`, `petri_docs`, `petri_preview`, `petri_frontend`, `petri_codegen` × lean / python-interpreter / rust-contract / javascript-lambda / go-core-generated / zk-go |
| **IV. Loyalty ledger** | `cafe-loyalty.pflow` | token-model DSL: map and integer data states, guards, key/value arcs, a constraint | `petri_validate` (t-invariant `{gift}`), pflow-rs `pflow_dsl::parse_schema` |
| **V. Bean market** | `cafe-market.json` | constant-product pool in the `petri_template` dialect | `petri_amm_quote`, `petri_amm_depth`, `petri_amm_il`, `petri_sde`, `petri_risk`, `petri_corr_matrix` |
| **VI. Bundle** | `cafe.bundle.json` | three typed subnets (`WorkflowNet`, two `ResourceNet`), six `event` links, one `guard` link on an `observe` port, `arc_merge`, namespacing | `petri_bundle` → 34 files |
| **VII. Application** | `cafe-application.json` + `fixtures/fusions.json` | entities with fields, states, actions, inputs, effects, access; one cross-entity fusion | `petri_application` → 26 files |
| **VIII. Julia** | `cafe.jl` | colored load, CID recomputed with the URDNA2015 port | `pflow-jl` |

Fixtures under `fixtures/` are the inputs the analysis tools need beyond the
model: `properties.json` (verify), `event-log.json` (conformance),
`observations.json` (fit), `sample-path.json` (fit_discrete),
`scenarios.json` (scenario), `extend-operations.json` (extend then diff),
`firing-sequence.json` (simulate/replay), `rates.json` (see rough edge 1),
`ssa-go-seed42.json` (written by `gocheck`).

## Theme: `cafe.jsonld`

Red is people, brown beans, white milk, blue cups. One pantry place holds
three colors with capacity `[0, 24, 12, 20]` (0 = unbounded for the people
component). An espresso draws `[0, 2, 0, 1]`, a latte `[0, 2, 1, 1]`.
Restock is inhibited by `[0, 6, 0, 0]`, so it fires only while beans are below
six and is separately blocked by capacity when milk is already full. Ordering
requires the Open sign through an output-side inhibitor, which the JS and Go
engines both treat as a read arc. Closing is inhibited while a drink is
brewing.

Verified:

- CID `z4EBG9j2LEJJjfnMKd5fHJbdApLuTTomntzkb2E8FqszCS4CEm4` from `cmd/cidprobe`
  (Go), `public/seal-cid.mjs` (JS) and pflow-jl's `compute_cid` (Julia,
  `cafe.jl`), byte-identical; stamping it as `@id` leaves the CID
  unchanged, and `parents` names the colored coffee-shop example.
- `replay.mjs` and `petri_simulate` fire the same sequence with the same
  markings; both block `close` while brewing (`inhibited by: brewing.red`) and
  allow it after `serve`.
- `petri_validate` reports the P-invariant `barista_free.red + brewing.red == 1`
  and the T-invariant `{close, reopen}`.
- `petri_verify` proves `barista_free + brewing == 1` structurally against the
  colored net (base names resolve to per-color sums) and finds `served=2`
  reachable in 20 firings.

## I. Kinetics: `cafe-kinetics.json`

Demand outruns restock, so beans deplete and orders back up. At the declared
rates the ODE ends at t=24 with beans 6.1, cups 0.09 and orders 85.3.

- `petri_fit` (Nelder-Mead, 44 iterations) recovers `arrive` 6.0001 and
  `restock` 0.2000 from `fixtures/observations.json` (loss 4.2e-5).
- `petri_fit_discrete` on the 85-event `fixtures/sample-path.json` returns the
  closed-form MLE `count / exposure` next to Adam's answer (arrive 27 firings in
  3 h → 9.0; serve 2.65; leave 0.77), with the log-likelihood before and after.
- `petri_rate_scan` over restock 0.2 → 2.0 shows orders at t=48 collapse from
  200 to 0.02 once restock ≥ 1.0; `petri_ode_sweep` shows the same regime shift
  as overlaid trajectories; `petri_param_heatmap` maps it over arrive × restock.
- `petri_ode_sensitivity` (analytic forward sensitivities) ranks `leave`
  (−1.02) and `restock` (+0.97) as the only knobs that move `served`.
- `petri_optimize` finds 13 of 30 samples on the Pareto frontier of
  max served / min orders.
- `petri_phase_plot` from three initial bean levels, `petri_sankey` integrated
  flows (beans → brew_espresso 279 vs → brew_latte 36), `petri_heatmap` of
  the t=24 marking, `petri_distribution` of orders at t=8 over 200 SSA paths
  (P5 1, P50 15, P95 28).
- go-pflow's portable SSA at seed 42 writes `fixtures/ssa-go-seed42.json`, the
  hook for a pflow-rs / pflow-xyz / pflow-jl byte-exact comparison.

## II. Service: `cafe-service.json`

- `petri_verify`: `brewing + machine_free == 1` and
  `barista_free + brewing + ready == 2` proved structurally; `bounded` refuted
  with a witness (`vip_arrives` repeats, covering marking grows); `served=1`
  reached in 14 firings; the rest `unknown` at the 20 000-state cap. See rough
  edge 4 for the `queue <= 8` refutation.
- `petri_scenario`, five what-ifs on one seed, 10 realizations, 8 h:

  | scenario | served | walked out |
  |---|---|---|
  | today (2 baristas, 1 machine) | 117.6 | 42.5 |
  | third barista | 121.4 | 42.5 |
  | tour bus (VIPs at 6/h) | 99.3 routine + 47 VIP | 61.4 |
  | long rush (to hour 6) | 139.6 | 52.6 |
  | machine down | 0 | 130.8 |

  A third barista buys almost nothing because the machine binds; that is the
  point of modelling the machine as its own resource.
- `petri_ode` refuses this model (`diverged: true`) and names why: the read
  arc, two inhibitors, six non-kinetic arcs and the queue capacity that a
  continuous solve cannot honour, with the stochastic engine as the answer.
  (On the live server before the `fix/showcase-findings` branch it ran anyway
  and only appended those as caveats; the tool description promised the
  refusal, the code did not keep it.) The Erlang stages are not a reason to
  refuse: the check runs on the stage-expanded net.
- go-pflow: `ValidateSchedules` and `ValidateParameters` clean; `ExpandStages`
  turns 9 transitions into 11 (`finish_brew@1..3`); `SimulateSchedule` at seed
  42 × 10 gives served 119.5, walked out 39.7, agreeing with the pilot.

### The same file on sim.pflow.xyz

`cafe-service.json` is also stored on sim.pflow.xyz as model
`4d74adadd69ef3e6d93992ad` (owner-private; any `sim_*` tool takes the id):

- `sim_diagnose` ranks every derived knob by measured influence on the
  declared objective: patience (`give_up`) 55, the machine pool 53, arrivals
  53, the barista pool 46, and the declared parameter `shot_size` 8.9. The
  parameter is a first-class knob because `parameters` declares it. The
  dormant-source gate names `vip_arrives` at rate 0; three minimal siphons,
  all marked; CTMC lumpability refused (state space over the 4000 cap) and
  constrained lumping refused (the objective is a free expression), each with
  the reason.
- `sim_invariants` derives the same three conservation laws the pilot proves
  (`open == 1`, `brewing + machine_free == 1`,
  `barista_free + brewing + ready == 2`) and names its lossless encodings of
  the capacity, the read arc and the weighted inhibitor.
- `sim_compare` on one server-enforced seed: today 46 served / 82 walked out;
  third barista 102 / 36; `params: {"shot_size": 1}` changes bean draw and
  nothing else (47 / 82); tour bus 42 + 46 VIP / 85; machine down 0 / 106.
  The staged `finish_brew` is reported in its own vocabulary (Erlang-3, lower
  spread) in the assumptions.
- `sim_verify` agrees with the pilot: the two invariants and the mutex proved
  structurally, `bounded` refuted by the VIP source, `queue <= 8` unknown at
  the state cap.
- `sim_classify` refuses place-level lumping and names why: two inhibitors,
  one read arc, six non-kinetic arcs, and a rate schedule that leaves no
  autonomous ODE to ask backward equivalence of.
- `sim_publish` wrote the model to Google Sheets, with a seeded scenario as
  data tabs and trajectory and contention charts:
  https://docs.google.com/spreadsheets/d/1ZrVA9dg16H9yRUFz-Q2Z9Q4Kz0FqxEi4d49iVVvbk2w
  (model `a4a6e849e2d90dea8571a9d3`).

Two things the sim server taught about the format, both now reflected in the
file: a `presentation.groups` member must be a place or a transition, never a
parameter; and the sheet form refuses place `tags`, the `version` field and a
solver `tspan`, so the published copy is `cafe-service.json` with those three
removed and nothing else changed.

## III. Order workflow: `cafe-order.json`

- `petri_verify`, exhaustive over all 7 states: terminating, bounded, live,
  the one-state invariant, `refunded` reachable, `picked_up ∧ refunded`
  unreachable and their mutex all proved; deadlock-free refuted with the
  expected terminal markings.
- `petri_conformance` on `fixtures/event-log.json`: fitness 0.90, precision
  0.80, three of five traces fit; the two deviant traces are named with their
  missing activity (`pick_up` without `finish_brew`, `start_brew` without `pay`).
- `petri_migrate` lifts the flat model to the v2 envelope with roles and access
  under `extensions`; `petri_extend` adds a guarded `tip` transition with a
  binding and `petri_diff` reports exactly that delta with a rendered diff.
- `petri_codegen`: Lean proof form (theorems `state_count = 7`,
  `deadlock_count = 2`, re-derived by `decide`), Python interpreter, Rust
  contract, JavaScript lambda, Go core generated, and four gnark ZK circuit
  files; `petri_frontend` emits a 14-file Vite project; `petri_docs` renders
  the mermaid documentation.

## IV, V, VI, VII

- **Loyalty DSL** validates (T-invariant `{gift}`) and parses in pflow-rs
  (`3 states, 3 actions`). Simulation with bindings does not run; see rough
  edge 5.
- **Market**: a 200-cash buy against reserves 4000/1000 returns 47.48 beans at
  5.03 % price impact; the depth curve and impermanent-loss curve (breakeven at
  r = 0.55 and 1.82 for 20 % fee APY over 90 days) are pure algebra;
  `petri_sde` with σ = 0.4 on cash, `petri_risk` (CVaR₉₅ 1681 on 4000) and
  `petri_corr_matrix` run on the model.
- **Bundle** composes to 34 files once two rules are obeyed: a guard link's
  `from` is the gated transition and its `to` the observed port, and links that
  fuse the same transition share one id (fusion is transitive, so the staff net
  names its acquire/release per drink).
- **Application** composes to 26 files once every declared field is read or
  written by an action; a field is a data place, and an unconnected place fails
  validation.

## Rough edges found while building this, and fixed

Building the showcase surfaced eight behaviours in petri-pilot's tools. All
eight are fixed on the petri-pilot branch `fix/showcase-findings`, each with
a regression test that pins it (`pkg/mcp/showcase_fixes_test.go`) and a
skip-guarded replay of these very files (`pkg/mcp/showcase_files_test.go`).
Until that branch is deployed to pilot.pflow.xyz the live server still shows
the old behaviour, which is why they stay listed here.

1. `petri_ode`, `petri_stochastic`, `petri_sde`, `petri_fit` and every
   ODE-derived tool defaulted every transition to rate 1.0 and ignored both
   the transitions' `rate` fields and `simulation.solver.rates`. Now every
   tool starts from the model's declared rates (the same helper
   `petri_scenario` always used) and the `rates=` argument overrides.
   `fixtures/rates.json` remains for the live server.
2. `petri_analyze` with `full=true` failed on the colored theme with
   `json: unsupported value: +Inf`. Non-finite element impacts are now clamped
   to the largest finite impact and labelled `critical`.
3. Unfolding a colored net named places after the full token URI
   (`queue.https://pflow.xyz/tokens/red`), kept color copies no arc touched
   (sixteen `UNCONNECTED_PLACE` errors on the theme, codegen refused), dropped
   per-color capacity and stacked every copy on one pixel. Unfolded places are
   now `queue.red`, arc-less copies are pruned, capacity is carried and copies
   are fanned out.
4. `petri_verify`'s state exploration ignored place capacity and refuted
   `queue <= 8` on a place declared with capacity 8. The verify and analyze
   nets now carry capacity, so the bound is provable.
5. `petri_simulate` on a DSL model failed guard and constraint evaluation with
   `unknown identifier` for every map state (the shipped ERC-20 too). Data
   states are now bound by name in guards and constraints, `sum`/`count`/
   `minOf`/`maxOf` total a ledger map, and the DSL's `:initial` values reach
   the runtime.
6. `petri_preview` of `permissions` ignored `roles` and `access`. Flat v1
   declarations and the v2 `petri-pilot/roles` / `petri-pilot/access`
   extensions now reach both preview and plain `petri_codegen`.
7. `petri_conformance` replays the whole marking, so a resource net never fits
   a per-case log; the tool description now says to give it the per-case
   workflow (variation III), which is what `fixtures/event-log.json` targets.
8. A DSL file that opens with `;;` comment lines was routed to the JSON parser
   and rejected on the semicolon. Format detection now skips comment lines.
9. `petri_ode` and every ODE-derived tool ran gated and scheduled models and
   only appended caveats, while their descriptions (and `petri_scenario`)
   promised a refusal. They now refuse with the reasons, after stage
   expansion so an Erlang service time is not mistaken for a gate.
10. `petri_verify` built its own analysis net and said nothing about what the
    encoding could not carry. It now converts through go-pflow's metapetri
    bridge and returns its notes as `caveats` (capacity as a post-firing
    bound, read arc as a reversed inhibitor, inhibitor weight as a threshold),
    the way sim.pflow.xyz always did.

The same branch also brings four readings over from sim.pflow.xyz as pilot
tools on an inline model: `petri_invariants` (Farkas laws, T-invariants,
siphons and traps with deadlock witnesses), `petri_canonical` (exact
automorphism orbits and a renaming-invariant id), `petri_lumping` (backward
differential equivalence and constrained lumping) and `petri_dataset` (a
seeded event log in the shape `petri_conformance` replays). And sim gained
what pilot had and it lacked: `sim_conformance`, `sim_extend`, `sim_diff`,
`sim_code_to_flow`, `sim_optimize` and `sim_param_heatmap`, plus the three
shared-package fixes above; a checksum lock (`scripts/shared-pkg.sh`) now
keeps the packages the two repos share byte-identical.

## Running it

```bash
# from the pflow-xyz repo root
examples/showcase/check.sh            # JSON, CID parity, JS replay, go-pflow, Julia, Rust
go run ./examples/showcase/gocheck    # the go-pflow half on its own
```

Against the MCP server, pass a file's contents as `model` and the matching
fixture as the tool's second argument; every call in this README used the
defaults except where a number is quoted above.
