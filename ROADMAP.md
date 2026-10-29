# Roadmap

## Models first: re-centring pflow.xyz (proposed, 2026-10-28)

**Status: proposal, awaiting Matt's approval. Nothing here is built.** The design is
[docs/design/models-first.md](docs/design/models-first.md).

Direction: pflow.xyz centres on **models** (a composition of subnets and typed links, its
flat net, its search plans, its checks and its CID), not on Petri nets alone. The ten
composition views of `/compose.html` become the model page, and the Petri-net editor is
its flat-net view. The audience is people who want to get technical with models.
[sim.pflow.xyz](https://sim.pflow.xyz) is the utility that answers questions, and the two
hand a model to each other.

If approved, this **supersedes the newcomer framing** of the next section (its problem and
goal, and the "newcomer" exit of phase 6). Phases 0-8 stay as built. Phases 1, 5 and 7 are
frozen, not removed (their question-shaped surfaces; shared code such as `goals.json` and
`petri-roles.js` is still maintained); "start from a question", sensible defaults and
plain-language results are sim's. First work is a decision on the model's format (a bare
Bundle cannot carry the pattern and port data the views draw) and two commands in
pflow-native (`bundle.load`, `bundle.export`), because the registry cannot open a Bundle
today; the first pflow.xyz slice is copy and navigation only. The decisions only Matt can
make are D1-D14 in the design's section 5.3. The design was revised after an adversarial
review; it says how its cites are numbered (this section shifts the ROADMAP's line numbers).
Pending item 17 below ("a push to `main` is a deploy") holds only for a commit signed
with a key pflow.dev trusts; the design's section 5.1 has the details.

## Guided modelling and simulation in the browser

**Problem.** The editor can simulate, but only if you already know what you
are doing. Choosing an engine (ODE, SSA, SDE), setting rates, picking a time
span and reading the plots all assume you know the formalism. For someone who
arrives with a question rather than a net, simulation is barely usable.

**Goal.** Provide in the editor the kind of service
[sim.pflow.xyz](https://sim.pflow.xyz) provides: help developing a model and
running it, so the result is something a newcomer can act on and trust.

Directions to consider:

- **Start from a question, not a canvas.** Describe the process in words and
  get a first net to edit, as sim does from a description.
- **Sensible defaults.** Pick the engine, rates, horizon and seed for the
  model, and say what was chosen and why. Hide the solver options until asked.
- **Seeded, repeatable scenarios.** One click to run a what-if and get the same
  answer next time, with the spread shown rather than a single trajectory.
- **Say which knobs matter.** Rank parameters by measured effect on an outcome,
  and flag the ones that do nothing.
- **Check the model before running it.** Surface structural problems (deadlock,
  unbounded places, unconnected nodes) in plain language.
- **Plain-language results.** Answer the question asked, with the evidence
  behind it, before showing plots.
- **Share with sim.** Open the same net on sim.pflow.xyz, or store it there,
  without re-entering it.

**Decided (2026-10-15).** Mostly client-side: the browser engines (byte-exact to go-pflow) run the simulation and analysis, with calls to a Gemini LLM to help design the net and build the analysis, the way sim does. Unlike sim, which leads with outcomes and keeps Petri nets as the engine, the goal here is to show users the Petri net design itself: the guided flow should end with a net they can see, read and edit.

**LLM access.** A thin proxy on the pflow.xyz webserver holds the Gemini key; the browser never sees it. Only authenticated users may call it, using the existing GitHub sign-in (internal/auth, GitHub token verified server-side), with per-user rate limits. sim-pflow-xyz already calls Gemini (pkg/simmcp) and is the reference for prompts.

Open questions: how the guided flow coexists with the current expert-facing Analysis dialog. (Proposed answer below, in the LLM workbench section: both call the same command registry, so the dialog is one view of it and the chat is another.)

The first slice is designed in [docs/design/guided-modelling-slice1.md](docs/design/guided-modelling-slice1.md). The section below is the plan that slice belongs to.

## LLM-assisted workbench: parity with pflow-native

Written 2026-10-24.

**Problem.** [pflow-native](https://github.com/pflow-xyz/pflow-native) has
moved well past the web editor:

- It has structural analysis (incidence, P/T invariants, siphons and traps,
  verify, reach with replayable traces, reachability and coverability
  graphs, canonical ids and classes).
- It has the whole simulation workbench (seeded SSA/SDE scenarios, compare,
  crosscheck, diagnose, heatmap, optimize, fit).
- It has data commands (conformance, replay, calibrate, discovery),
  composition (components, fuse, extend, diff, systems) and an MCP server
  over the same command registry the UI uses.

The web editor has the token game, the ODE, rate scan, sweep and phase
plots. SSA, SDE and rate fitting exist only as libraries
(`petri-ssa.js`, `petri-sde.js`, `petri-learn.js`) with no UI.
`pflow-native/FEATURES.md` is the parity matrix. Its §A rows are the
editor's features, which native has reached. This section is about the
reverse direction: bringing native's §B and §C rows to the web.

**Goal.** In pflow.xyz, someone who arrives with a goal rather than a
formalism can:

1. Build a net with an LLM's help.
2. Be told which analysis answers their question.
3. Run it, and read the answer with its evidence.
4. Refine the net until the answer holds.

All of this happens in the browser. The net stays on screen throughout, as
the guided-modelling decision requires. The LLM experience is MCP-shaped:
the assistant acts only through named tools with schemas, every call is
visible, and the same tools can be driven by hand, replayed, or called by
an outside agent.

### Principles

1. **Every action is a command.** This copies pflow-native's ground rule. A
   command registry in the editor holds each action's id, its arguments as
   JSON Schema, whether it edits the document, and the artifact it returns.
   Menus, the Analysis dialog, the chat and any MCP client call it; nothing
   else mutates the model. This answers the open question above: the expert
   dialog and the guided chat are two views of one registry.
2. **The LLM proposes; the engines decide.** This is the discipline from
   slice 1 and from sim's `pkg/builder`:
   - The model acts through a closed vocabulary.
   - Every number it reports comes from an engine run that the user can see.
   - Malformed output becomes a plain reply, never a crash.
   - It explains results. It never computes them.
3. **One answer everywhere.** Go (go-pflow), JS (`public/`) and Rust
   (pflow-rs) must agree on the parity fixtures before an engine is served.
   A divergence the goldens don't cover is a bug in the goldens.
4. **Light core, heavy parts loaded lazily.** `petri-view.js` is vendored by
   bitwrap-io and pinned by sim's `/build/` page. New features go in sibling
   modules (`petri-commands.js`, `petri-chat.js`, `petri-analysis.js`, the
   wasm bundle) that are dynamically imported, and each one is off when its
   backing is absent. This is the same pattern as `/api/llm/status` with
   `enabled: false`.
5. **The proxy stays task-shaped.** The server holds the system prompt, the
   tool manifest and the quota. It never forwards arbitrary prompts.

### Architecture

```
browser                                                   pflow.xyz server            Gemini
───────────────────────────────────────────               ────────────────            ──────
chat modal ──▶ POST /api/llm/turn {messages, net summary} ─▶ auth + quota
                                                           fixed system prompt
                                                           tool manifest (vN) ──────────▶ generateContent
           ◀── {reply, tool_calls[]} ◀──────────────────── refuse unknown tools ◀────────
tool loop: for each call
  registry.execute(id, args)  ── JS engines (ODE/SSA/SDE/token game, byte-exact go-pflow)
                              └─ wasm (pflow-native-core: analysis, verify, reach, diagnose, …)
  → artifact (shown in Results) → bounded summary sent back on the next turn
Tools panel: every call, its args, its artifact; rerun; undo; "copy as MCP call"
```

- **The browser executes tools; the server does not.** The server only
  relays the conversation and checks that every tool name in a reply is in
  its manifest. Nothing heavy runs on pflow.dev. This keeps the decision
  that the work is "mostly client-side".
- **The tool manifest is generated from the registry**, checked in
  (`cmd/webserver/prompts/tools-vN.json`) and versioned like the prompts. A
  test fails when the registry and the manifest drift.
- **Edits are previews until applied.** An editing tool returns a diff
  (`compose.diff`-shaped). The user applies it, and it lands as one undo
  step. This mirrors native's "previews unless `send`".
- **Context is data.** Net labels, descriptions and tool results go back to
  the model as user-role content, truncated and size-capped, never into the
  system prompt. A label like "ignore previous instructions" is a label.
- **Cost.** A turn can involve several model calls, so the quota counts
  model calls, as sim's `sim_generate` does, not turns. Tool calls per turn
  are capped (proposed: 8), and the response reports the allowance left.

### WASM: what moves to Rust, and how

The question is which engine runs each analysis in the browser.

| Option | Gets | Costs |
|---|---|---|
| **A. pflow-native-core as wasm** (recommended) | The whole registry at once: analysis, verify, reach, siphons, symmetry, diagnose, stochastic scenarios, conformance, calibrate, discovery, compose, systems. It already builds for `wasm32-unknown-unknown` (`make wasm-check`), its commands already carry `ArgSpec`s, and it already speaks MCP (`list_commands` / `execute` / `batch`). | Bundle size, measured in phase 2. Needs a thin `wasm-bindgen` shim crate. The core's `Session` holds a second copy of the document, kept in sync through JSON-LD. |
| B. Selected pflow-rs crates (pflow-verify, pflow-reachability, pflow-mining) as small wasm modules | Smaller bundles | Re-does pflow-native's integration work. Siphons, symmetry, systems, layout and CID live in pflow-native-core, not pflow-rs (FEATURES.md §D 2–6) |
| C. Port to JS | No new toolchain | Third implementations drift. This is how §D 8 (weight-0 arcs) happened |

**Recommendation: A, with the JS engines kept as the engine of record for
what they already do.** The JS token game, ODE, SSA and SDE are small,
byte-exact with go-pflow, and used by everything that vendors `public/`.
Wasm adds what JS lacks and is loaded only when one of those commands runs.

- **Where it lives.** A `crates/wasm` shim in pflow-native, built without
  the `services`, `zk` and `rnn` features. It exposes `list_commands()`,
  `execute(id, argsJson)` and `load(jsonld)`.
- **How it ships.** It is published to cdn.stackdump.com as a versioned
  artifact and vendored into `public/vendor/` with a hash lock, the same
  pattern as `docs.lock`. It is served same-origin as `application/wasm`
  and listed in `files.bzl`.
- **Upstreaming.** The ports FEATURES.md §D marks "worth upstreaming"
  (siphons, symmetry, systems, layout, CID) can move to pflow-rs later
  without changing the browser contract.
- **What must be settled before wasm fires a net in the editor:**
  - **Weight-0 arcs** (FEATURES.md §D 8). JS reads `[0]` as "no
    requirement", and pflow-metamodel reads it as weight 1. Settle it in a
    parity fixture first.
  - **Capacity.** Upstream mining replay ignores it (§D 10). Use native's
    gate-aware local replay.

### Phases

Each phase ends with an exit criterion. Progress, and every choice made
without asking, is logged in [docs/workbench-progress.md](docs/workbench-progress.md).
Status lives in the parity matrix
(see open decision 1), not here.

#### Phase 0: Foundations (no LLM) ✅

- **Rates, goals and views in the model.** This resolves slice 1's open
  decision 1 now, because every later phase needs rates that survive a
  reload.
  - Add the optional schema terms `rate` (transition), `goals` and
    `views`. **An absent term must leave the canonical form unchanged**, so
    every existing CID still verifies.
  - **Found (2026-10-24): the sealing context needs no change.** Its
    `@vocab` (`https://pflow.xyz/schema#`) already maps any key, so `rate`,
    `goals` and `views` hash as `schema#rate` and so on. Only a key that is
    present enters the N-Quads. `internal/seal` and `seal-cid.mjs` stay as
    they are. The work is in the editor, the published `public/schema` and
    the parity goldens.
  - ✅ **`rate`.** The Analysis dialog reads each transition's `rate`
    (default 1.0) and writes back only the rates the user changes, as one
    undo step, so an untouched net keeps its bytes and its CID. Helpers are
    `rateOf`, `transitionRates` and `setTransitionRates` in `petri-sim.js`.
    The `with-rates.jsonld` golden pins Go and JS on rates of 0, 0.001,
    0.25 and 720.
  - **pflow-native follow-up.** `file.load_json` moves `rate` out of the
    document into session rates (`take_rates`), so `file.cid` hashes a net
    with rates without them and disagrees with pflow.xyz on that golden.
    `file.cid` and `file.seal` should seal `with_rates`, and the fixture
    should join `crates/core/tests/fixtures/cid/`.
  - `goals` and `views` wait for their validators (phases 6 and 7). A term
    with no checks would be stored unchecked, which is what sim's views
    rule against.
- ✅ **The command registry** in `petri-commands.js`. Wrap every existing
  menu action and Analysis-dialog run. Undo stays whole-snapshot. Queries
  are not journalled.
- ✅ **Typed results.** A Results panel renders artifacts by kind: TimeSeries,
  Table, Report, Trace, Sets, Matrix, Graph, Bars, Heatmap, Scatter. These
  are pflow-native's kinds, so exports match. Every result exports to CSV
  and JSON, and "copy as MCP call" is on every result.
- ✅ **The strict validator** from slice 1 (`validateNet`), shared by load,
  paste, the LLM gate and `/api/save`.
- **Done when** a deno test drives the editor headless through the registry
  alone (load, edit, run the ODE, export), and the Analysis dialog contains
  no logic of its own.

#### Phase 1: Describe it, get a draft (slice 1, as designed) ✅ (ships dark until `GEMINI_API_KEY` is set)

Ship [guided-modelling-slice1.md](docs/design/guided-modelling-slice1.md)
unchanged: the proxy, auth, quota, the draft contract and the load gate.
It is the proxy's first consumer and proves the cost and abuse controls
before the tool loop raises the stakes.

#### Phase 2: Structural analysis in the browser ✅

- **Wasm spike, which is a decision gate.** Measure bundle size (gzip),
  cold load and first `execute` on the gallery nets, and run the parity
  fixtures through it. If it is too large, split it per namespace (option B
  inside option A) before going on.
- **Commands:**
  - `analysis.validate`, `incidence` and `invariants` (P/T, with coverage).
  - `siphons` (with Commoner's property).
  - `verify` (deadlock-free, bounded, live, reachable, mutex, with
    counterexample traces).
  - `reach` (the shortest trace, or a P-invariant certificate).
  - `reachability` (graph, with ω).
  - `canonical` and `classify`.
- **Results on the canvas.** Highlight a siphon or an invariant's support.
  Step through a trace with the fired transition highlighted (native's
  `sim.goto`). Click a reachability-graph state to load its marking.
- **Done when** native's phase-4 rows (FEATURES.md §B: invariants, verify,
  reach, validate, canonical/classify; §C: Matrix, Graph, Trace) have a web
  status of ✅, with parity tests on the shared fixtures.

#### Phase 3: Simulation workbench parity ✅

- **UI for engines that already exist in JS:**
  - SSA and SDE, with mean ± sd bands over seeded runs.
  - Crosscheck (SSA against ODE against conservation).
  - Rate fitting (`petri-learn.js`).
- **From wasm:**
  - Seeded `sim.scenario` and `sim.compare`, including contention,
    depletion and schedules (`pflow_solver::stochastic`).
  - `sim.equilibrium`.
  - `analysis.diagnose`: influence ranked against a measured noise floor,
    drawn as a tornado chart.
  - `opt.heatmap` and `opt.optimize` (Pareto).
- **Engine defaults** come from `docs/engine-selection.md`. Each run says
  which engine, horizon and seed it chose, and why. This is the existing
  section's "sensible defaults".
- **Done when** native's phase-3 rows have a web status of ✅, and the
  same seed gives the same numbers in the browser, pflow-native and sim on
  the coffee-shop fixture.

#### Phase 4: The chat modal and the in-page MCP ✅ (ships dark)

- **`POST /api/llm/turn`.**
  - It reuses slice 1's auth, quota, usage log and error table.
  - The request carries the conversation and a bounded summary of the net:
    ids, labels, counts, the last results.
  - The response carries `reply`, `tool_calls[]` and the quota.
  - Unknown tools, and arguments that fail the manifest's schema, are
    refused server-side and shown to the model as a tool error.
- **The chat modal** is a dockable panel, not a blocking dialog, so the net
  stays visible. It has three modes, which select the step guidance in the
  system prompt: **Build** (phase 6), **Analyse** (phase 5) and **Explain**
  ("what does this place mean?", "why is t3 dead?").
- **The Tools panel** shows every call the assistant made: its arguments,
  its result artifact, rerun, undo and "copy as MCP call". A user can do by
  hand anything the assistant did.
- **Done when** a signed-in user can ask "is this net deadlock-free, and if
  not, show me how it gets stuck". The answer is a `verify` call and a trace
  replayed on the canvas, each step visible in the Tools panel, and a
  quota-exhausted user gets the 429 path from slice 1.

#### Phase 5: The goal advisor ("what should I run?") ✅

People know their goal, not the analysis that answers it. The advisor maps
one to the other. **The map is data, not prompt:** a checked-in goal catalog
(`public/goals.json`), with entries that are also readable without any LLM.

| Goal (in the user's words) | Analysis | What the answer looks like | Caveat it must carry |
|---|---|---|---|
| "Can it get stuck?" | `analysis.verify {deadlock}`, then `siphons` | yes + trace / no + proof | bounded search: "no deadlock within N states" is not a proof |
| "Can X ever happen?" | `analysis.reach {to}` | trace, invariant certificate, or unknown | unknown ≠ no |
| "Does anything grow without limit?" | `verify {bounded}`, coverability | the unbounded places | — |
| "Is anything conserved?" | `invariants {kind: P}` | the weighted sums that never change | — |
| "What happens on average?" | ODE (`sim.ode`) | trajectories, final values | mean-field: wrong at small counts |
| "How bad can it get?" / "what's the risk?" | seeded SSA scenario, realizations | bands, percentiles | seed and run count stated |
| "Which knob matters?" | `analysis.diagnose` | ranked influence vs. noise floor | a knob under the noise floor is "no measured effect", not "no effect" |
| "What if I had one more …?" | `sim.compare` (baseline vs +1) | the difference, with its spread | same seed for both |
| "What's the best setting?" | `opt.optimize` / `opt.heatmap` | Pareto front / grid | the objective is stated, not inferred silently |
| "Does my data match the model?" | `data.conformance`, then `data.calibrate` | fitness, worst traces, learned rates | rates on a net that can't replay the log are not evidence |
| "Are these two nets the same?" | `analysis.canonical`, `compose.diff` | same id / structural diff | — |
| "Who wins with best play, and with which move?" (added later, `best_play`) | `game.move {sides, reward, auto, plan?, nodes?}` (pflow-native, wasm) | the exact value and a best move, or none past the node budget (a guessed move, `exact: false`, when the plan's mode is `"play"`) | exact and deterministic for a plan and node budget, except a plan naming the `ode` estimate can count nodes differently on another platform; "a best move", not "the best move" |

- **With the LLM**, the user's words are routed to one or more catalog goals
  (a closed set), with at most one clarifying question per turn (sim's
  interview discipline). The advisor proposes a plan, an ordered list of
  commands, which the user approves before it runs. It then answers in plain
  language, citing the result artifacts, before showing any plot. This is
  the existing section's "plain-language results".
- **Without the LLM**, a "What do you want to know?" picker lists the same
  goals and runs the same plans. The advisor must work signed out.
- **Done when** every catalog goal has a fixture net whose plan runs end to
  end in a browser test, and the opt-in prompt eval (`llm-eval`, from slice
  1) routes a set of paraphrased goals to the right catalog entries.

#### Phase 6: Model refinement, adopted from sim ✅

sim's builder (`pkg/builder`) and `sim_refine` hold most of what this
needs. Adopt them as ideas and data, not as imported code (sim is private).

- **The interview steps.** describe → structure → rates → validate →
  preview, each with its step guidance. There is one focused question per
  turn, with concrete numbers preferred, and the draft grows every turn
  through a closed operation vocabulary. Those operations are sim's: add or
  remove places, transitions and arcs; `set_rate`; `set_initial`;
  `set_capacity`. Here each one maps to a registry command. This is the
  multi-turn refinement slice 1 put out of scope.
- **Behavioural feedback every turn.** These are sim's `checks.go`
  categories: disconnected parts, dead transitions, places nothing fills,
  deadlocks and unbounded growth. Each is one bounded exploration through
  the real firing rule, and a check that hits its bound is dropped, not
  guessed. Findings go back to the model as the next turn's context. sim's
  *rehearsal* option is an optional extra: the model plays its draft forward
  and the engine replays that play.
- **Calibration discipline as components.** sim's seven components are
  arrivals, service, hazard, inventory, decision, mailbox and datastore.
  They carry the wiring rules in their arcs: a pool held across two
  firings, non-kinetic pickup, patience to a loss sink. pflow-native ported
  them as `compose.fuse`. Offer them as palette items and as Build-mode
  tools, so a composed net starts out following the rules.
- **Refinement with a gate.** sim's defect weight is dead transitions +
  unmarked siphons + unreachable goals + unverified asserted classes + lost
  conservation laws, all engine-computed. A proposed refinement shows the
  weight before and after. In Build mode, an edit that raises it is flagged
  and not auto-applied. sim's gate needs a strict decrease, but interactive
  editing needs neutral steps too, so here the rule is no increase. The
  declared reachability goals (phase 0's `goals` term) feed the weight.
- **Done when** a newcomer can go from a description, through the
  interview, to a net with no checks failing and a defect weight of 0. The
  path is replayable from the Tools panel, and every edit can be undone.

#### Phase 7: The app view and question-shaped controls, adopted from sim ✅

sim presents a model as an app: a console whose controls are the questions
an operator asks. Adopt that, while keeping the net visible beside the
console.

- **Views as validated projections.** This is sim's `views[]` (MODELING.md,
  "Views"). Each screen names its places and transitions and has a role:
  `board`, `dashboard`, `controls`, `advisor`, `trust` or `log`. A dangling
  reference is a load error, and links between views form a navigation
  graph that can itself be checked. Stored in phase 0's `views` term.
- **Role derivation.** sim's `web/lib/sim-derive.js` `deriveRoles` reads
  pools, sources, losses, queues and services from the structure alone. It
  is what keeps a slider labelled "patience" from setting a service rate.
  From the roles come the question-shaped controls:
  - "What if I had one more <pool>?"
  - Disruptions grouped by the question they ask: *something is
    unavailable*, *a rush arrives*, *work is already waiting*, *a service is
    closed*.
- **An App view mode in the editor.** It shows the console for the current
  net next to the net. Each control shows which places and transitions it
  touches, so the console teaches the design rather than hiding it, which is
  this site's difference from sim. The `advisor` view runs the phase 5
  catalog. The `trust` view shows the invariants and the caveats.
- **Share with sim.** "Open in sim" stores the net there, and an app can be
  published through sim's `/lib/app-template.html` and `sim_publish_app`.
  Those need a sim (Google) sign-in, so pflow.xyz links out to them rather
  than proxying.
- **Done when** the coffee-shop and vet-clinic fixtures derive the same
  roles and controls here as in sim's `/whatif/` console. A parity test
  runs both derivations on the same nets.

#### Phase 8: MCP outside the page (optional) ✅ `/mcp`; attach-to-tab deferred

- **A remote `/mcp` on pflow.xyz.** Stateless tools over a posted net or a
  CID: validate, analyze, simulate, save and get. It uses GitHub OAuth, so
  Claude or another client gets the same tools as the chat. The engines are
  the Go ones, which already back `/api/save` and the SVG renderer, or
  pflow-rs through the CLI.
- **"Attach to my tab."** This is the web version of native's control port:
  a signed-in user's open editor accepts registry calls from their own MCP
  client through a relay keyed to their GitHub id. It is deferred until
  phases 4–7 show what people actually do.

### Out of scope

- Learned policies (`rnn.*`) and zero-knowledge proofs (`zk.*`), which
  native already keeps off its web build.
- Google Sheets publishing.
- sim's knowledge graph (collections, licenses, migrations, map store).
  Those stay sim's, and pflow.xyz links to them.
- A second LLM provider. The proxy keeps slice 1's `Complete(ctx, Request)`
  seam, but only the Gemini client is built.

### Risks

- **`petri-view.js` is about 8,000 lines.** Growing it further makes
  vendoring (bitwrap-io) and pinning (sim `/build/`) worse. Principle 4
  makes sibling modules the default, and a size check in `make test` (on
  `petri-view.js` alone) would enforce it.
- **Tool loops cost more than drafts.** Phase 4 has to re-measure slice 1's
  global cap with real conversations, behind `PFLOW_LLM_ALLOW`, before it
  opens to everyone.
- **Engine disagreement.** A browser that shows wasm numbers for one
  analysis and JS numbers for another can contradict itself. Principle 3,
  the engine-of-record table and the parity fixtures are the guard. Add a
  fixture before adding an engine.
- **Prompt injection through the net.** Shared nets are untrusted input.
  Labels and descriptions travel as data, tool results are capped, and
  edits are previews.

### Open decisions

1. ⏳ *Pending.* **One parity matrix or two.** The proposal: add a **Web** status column
   to `pflow-native/FEATURES.md` rather than keep a second matrix here,
   because a copy drifts and then lies. The cost is that pflow.xyz status
   lives in another repo.
2. ✅ *Decided: pflow-native `crates/wasm` (commit `62923ff`).* **Where the wasm shim lives.** pflow-native `crates/wasm` (proposed,
   since the registry is there), or a `pflow-wasm` crate in pflow-rs after
   §D's ports move upstream.
3. ⏳ *Half done: copied into `public/petri-roles.js`, pinned by `parity/roles/`; sim does not vendor it yet.* **Where shared app-view JS lives.** `deriveRoles` and the disruption
   grouping are sim's today. The ecosystem rule makes `pflow-xyz/public`
   canonical for shared browser JS, so the proposal is to move the
   derivation here and have sim vendor it (sim already keeps a
   `pflow-js.lock`). The sim-specific panels stay in sim.
4. ✅ *Built as proposed: optional terms in the net.* **The schema terms.** Whether `goals` and `views` belong in the
   content-addressed net (sim puts views in the hash, because their
   references are validated) or in a sidecar keyed by CID. Proposed: in the
   net, as optional terms, for the same reason sim gives.
5. ✅ *Built as proposed, plus at most 6 model calls per message.* **The tool-call cap and quota unit.** Proposed: 8 tool calls per turn,
   with the quota charged per model call.

### Order

0 → 1 → 2 (with its wasm gate) → 4 → 3 and 5 in parallel → 6 → 7 → 8.

The chat (phase 4) comes before the full workbench (phase 3) on purpose.
Once the structural analyses exist, it has something worth calling, and the
advisor's catalog fills in as phase 3's commands land.

### Status (2026-10-25)

Phases 0–8 are built and deployed (PRs #96–#104, merged to `main` as #105).
"Attach to my tab" (phase 8) is deferred, as planned. The phase-by-phase
log, with every choice made without asking, is
[docs/workbench-progress.md](docs/workbench-progress.md);
`git grep -n "REVIEW:"` finds the same choices in the code. The nginx vhost
on pflow.dev was updated on 2026-10-25 to proxy `/mcp` to the server and to
serve `.wasm`.

**The LLM features soft-launched on 2026-10-26.** Drafting (phase 1) and the
Assistant (phase 4) are on in production, limited to the `stackdump` login
(`PFLOW_LLM_ALLOW=stackdump`). `GEMINI_API_KEY` and the allowlist live in
`~/.env-services/pflow-xyz` on pflow.dev (mode 600). They have been tested
only against a scripted model, never live Gemini.

### Pending choices

Each item below shipped with a default, so nothing is blocked. Each still
wants an owner's decision.

**To turn on the LLM features**
1. ✅ *Decided: key `pflow-xyz-llm` in pflow-dev-486219, restricted to the
   Generative Language API, $20/mo budget alert at 50/90/100%.* **The Gemini
   key.** (slice-1 open decision 2)
2. ✅ *Decided: soft launch with PFLOW_LLM_ALLOW=stackdump, 2026-10-26.*
   **Launch audience.** (slice-1 decision 4)
3. **Limits.** The defaults are 30 per user per day, burst 3, 500 a day
   globally (`PFLOW_LLM_*`). The Assistant spends one unit per model call,
   up to 6 per message, so is 30 a day enough for chat?
4. ✅ **First live run.** *Done 2026-10-26* on `gemini-3.8-flash`: first run
   17/20 (85%); after capping thinking (`thinkingBudget` 1024 for drafts) and
   rejecting `MAX_TOKENS` replies, rerun **20/20 (100%)** pass the gate first
   time, ~6.4 s per call (was ~17 s). `testdata/llm/` is the regression net.
   The 3 first-run failures (01, 04, 08) were thinking tokens eating the
   4096 `maxOutputTokens` (measured: 3930 thought + 159 visible, `MAX_TOKENS`).

**Behaviour that shipped with a default**

5. **Unknown keys in a net are warnings, not errors** (Check net).
   Otherwise sim exports and older nets would not load. Strict mode, used
   only for drafts, makes them errors.
6. **Check net is `analysis.check`.** `analysis.validate` is pflow-native's
   pflow-validation, so the id means the same in both apps.
7. **Native edits replace the document with the engine's export**
   (`compose.fuse`). Offsets renumber and capacity reads 0 instead of null:
   the same net, but different bytes and a different CID from a hand edit.
8. **The refinement gate allows edits that leave the defect weight
   unchanged.** sim's gate requires a strict decrease. An increase is
   flagged and needs "Apply anyway".
9. **Interview steps advance on a "Next: <step>" marker** in the reply,
   not on a structured field.
10. **No fungible classes in the App view.** Each member of a set like
    `fork_0..fork_4` gets its own control. sim's server classifier, or native
    `analysis.classify`, could collapse them.
11. **`/mcp`.** `pflow_save` needs a GitHub bearer token (`/api/save` does
    not); there is no OAuth server for MCP clients and no rate limit beyond
    the per-call bounds.
12. **Not yet exposed:** rate fitting (it needs an event-log import), data
    conformance (the "data_match" goal is listed as unavailable), and a
    two-net structural diff.
    **The game tools in the browser.** `game.value` and `game.move`
    (pflow-native `cdd3816`, pflow-metamodel's alpha-beta search run as a
    `SearchPlan`) are in the editor's registry, the Assistant's tools
    (`game_value`, `game_move`) and the `best_play` goal. `/mcp` has its own
    Go port, `pflow_game_value` and `pflow_game_move` (`internal/gamesearch`),
    which runs the `ode` estimate, `aspiration` and coloured nets as native does.
    In the browser they run synchronously on the page's
    thread (natively they are a background job), so a node budget past
    about 10,000,000 freezes the tab for tens of seconds; a worker for them
    is a follow-up.

**Follow-ups in other repos**

13. **pflow-native:** `file.cid` and `file.seal` should hash the session
    rates (they disagree with pflow.xyz on `with-rates.jsonld`).
14. **pflow-native:** compile the SSA in document order, then drop the sort
    from `public/petri-wasm_test.ts`'s parity test.
15. **pflow-native:** a Web column in FEATURES.md (open decision 1).
16. **sim-pflow-xyz:** vendor `public/petri-roles.js` with a lock (open
    decision 3); regenerate `parity/roles/` when sim's derivation changes.
17. **Workspace CLAUDE.md:** it says there is no auto-deploy on pflow.dev,
    but pflow-xyz has a push webhook (`cmd/webserver/deploy.go`). A push to
    `main` deploys only when the tip's signature verifies on the box (a
    merge-button commit needs GitHub's web-flow key imported there) and its
    `test` check run is green; see `docs/deploy.md`.
