# LLM workbench: progress log

The running log for [ROADMAP.md](../ROADMAP.md)'s "LLM-assisted workbench"
section, kept while the phases were built in one unattended run starting
2026-10-24. Each phase lands as one PR. Choices made without asking are
marked `REVIEW:` in the code and listed under **Decisions to review** below
and in that phase's PR.

**How it merges.** A push to `main` deploys pflow.xyz: the push webhook in
`cmd/webserver/deploy.go` pulls, verifies the signature, builds and
restarts. So each phase PR merges into the **`workbench`** integration
branch, with signed merges made on valoper, and **`workbench → main` is left
open for review.** Merging that PR is the deploy. Everything that needs a
secret (the Gemini key) ships dark: with no key, the LLM features hide
themselves.

## Status

| Phase | State | PR |
|---|---|---|
| 0 Foundations | ✅ merged into `workbench` | `phase0` |
| 1 Describe it, get a draft | ✅ merged into `workbench` (ships dark) | `phase1` |
| 2 Structural analysis | ✅ merged into `workbench` | `phase2` |
| 3 Simulation workbench | ✅ merged into `workbench` | `phase3` |
| 4 Chat modal + in-page MCP | ✅ merged into `workbench` (ships dark) | `phase4` |
| 5 Goal advisor | ✅ merged into `workbench` | `phase5` |
| 6 Model refinement | ✅ merged into `workbench` | `phase6` |
| 7 App view | ✅ merged into `workbench` | `phase7` |
| 8 MCP outside the page | ✅ `/mcp` merged into `workbench`; "attach to my tab" deferred | `phase8` |

## Phase 0: foundations

What landed:

- **Rates in the document.** Each transition's `rate` (default 1.0). The
  Analysis dialog reads and writes it, and only changed rates are written,
  so an untouched net keeps its CID. The sealing context needed no change
  (its `@vocab` already maps `rate`). Golden: `parity/fixtures/with-rates.jsonld`.
- **Check net** (`public/petri-validate.js`). The strict validator:
  errors for whatever `normalizeModel` would coerce or clamp, warnings for
  defaults and unknown keys, `strict` for the LLM gate, `smokeCheck` for the
  engines. `normalizeModel` moved to `petri-sim.js` unchanged. The editor
  checks what it loads and toasts when it repaired something.
  `scripts/check-nets.mjs` runs it from the command line.
- **The command registry** (`public/petri-commands.js`). 32 commands with
  pflow-native's ids and argument names, JSON Schema arguments, a headless
  host, and artifacts in native's shape. `<petri-view>.execute()` and
  `listCommands()` are public.
- **Typed results** (`public/petri-results.js`) and a **Results** dialog.
  The Analysis dialog's four tabs run through the registry. Every result
  has CSV, JSON and Copy MCP call.

Verified: `make test` (168 JS tests, Go, CID parity), and in a browser
against a local server: every Analysis tab, Results, Check net, the load
toast, and `el.execute` edits with undo.

### Decisions to review (phase 0)

1. **Unknown keys warn, not error.** The slice-1 design said "an unknown
   key is an error". Sim exports and older nets carry `views`, `role`,
   `event`, `tags` and more, so loading them would have failed. They warn,
   and `strict: true` (for LLM drafts) makes them errors.
2. **Arcs place→place or transition→transition warn, not error.** They
   appear in the editor's own stored state-machine net (net-a). go-pflow
   parses them and `normalizeModel` keeps them.
3. **Empty vectors and `token: []` are legal.** The knapsack and
   with-parents goldens use them.
4. **Command-created ids are `p0, p1…` / `t0, t1…`** (deterministic), while
   the canvas tools still mint time-based ids.
5. **CSV exports carry 600 samples**, not every adaptive solver step, and
   the JSON download is the artifact itself (it used to be a
   `{tool: 'petri_ode', …}` object).
6. **`artifact.meta`** (a run's inputs and summary) is a pflow.xyz
   extension to native's artifact shape.
7. **`sim.ode` accepts only `method: tsit5`**, because that is the only
   method in the browser. pflow-native has more.
8. **Not yet commands: canvas gestures** (click to add, drag, token tool,
   layout dialog). They do the same operations directly. Converting them is
   mechanical, and was left out to keep this PR reviewable.
9. **`goals` and `views` are not added yet.** They wait for their
   validators (phases 6 and 7).

### Follow-ups outside this repo

- **pflow-native:** `file.cid` and `file.seal` should hash the session
  rates (`with_rates`). Today they disagree with pflow.xyz on
  `with-rates.jsonld`. Add that golden to
  `crates/core/tests/fixtures/cid/`.

## Phase 1: describe it, get a draft

Slice 1 as designed in `docs/design/guided-modelling-slice1.md`, except where
noted below.

What landed:

- **The proxy** (`cmd/webserver/llm.go`). `GET /api/llm/status` and
  `POST /api/llm/draft`, same-origin only, with the slice-1 status table
  (400/401/403/405/413/429/502/503/504). The prompt is embedded
  (`prompts/draft-net-v1.md`) and the draft `responseSchema` is set at
  decoding time.
- **`internal/llm`.**
  - A provider-neutral `Client`. Messages can carry function calls and
    responses, ready for phase 4.
  - A REST Gemini client: the key goes in `x-goog-api-key`, the timeout is
    45 s, replies are capped at 256 KB, and upstream error bodies are never
    passed on.
  - `Limiter`: a burst bucket, one call in flight per user, per-user and
    global daily counts, and a JSONL usage log replayed at startup. It fails
    closed.
- **`internal/auth/verifier.go`.** A GitHub verifier with a 5 s timeout,
  plus a 10-minute verified-token cache keyed by sha256. Failures are never
  cached.
- **The browser.**
  - `public/petri-draft.js` is the load gate: `validateDraft`, a
    deterministic `draftToNet`, then strict `validateNet` and the engine
    checks.
  - `public/petri-draft-ui.js` holds the Describe dialog (examples, counter,
    quota, the replace warning, cancel), the sign-in round trip that keeps
    the text, the failure view with paths and the raw reply, and the Draft
    notes panel (summary, assumptions, a legend that selects and centres
    nodes, rates, Regenerate).
  - The entry points are a menu item and an empty-canvas prompt. Both appear
    only when the status says enabled.
- **Tests.** Go: the client, limits (including replay and fail-closed) and
  the handlers, with no live calls. JS: 22 draft-gate tests, with one
  negative fixture per rule. `make llm-eval GEMINI_API_KEY=…` is the opt-in
  live eval. Its 20 descriptions go to `testdata/llm/`, which the JS suite
  replays.

Verified: `make test`, `bazel test` on the touched packages, and in a
browser with the LLM routes stubbed in-page. Hidden when disabled; the
empty-canvas prompt; Generate → gate → load → layout; Undo restores the
previous net in one step; the notes legend selects and centres nodes; a bad
draft shows each problem with its path and loads nothing.

**To turn it on**, on pflow.dev, after `workbench` is merged to `main`:
1. Add `GEMINI_API_KEY` (a dedicated key with a budget alert on its Google
   project), and optionally `PFLOW_LLM_ALLOW=stackdump` for a soft launch,
   to the pflow-xyz environment in `~/services`.
2. Run `~/services restart pflow-xyz`.
3. Run `make llm-eval GEMINI_API_KEY=…` once and commit `testdata/llm/`, so
   the replay tests have something to replay.

### Decisions to review (phase 1)

1. **The draft's rates go into the net** (each transition's `rate`). Slice 1
   kept them in the session because the format had no rate term. Phase 0
   added one.
2. **Defaults are the design's proposals:** 30 drafts per user per day,
   burst 3 refilling every 20 s, 500 a day globally. The usage log is JSONL
   (no SQLite), the provider seam is kept, and saved nets carry no
   provenance.
3. **Charging.** A `start` line is written before the upstream call, and
   that line is the charge. A `done` line follows with tokens, status and
   latency. Replay counts the `start` lines.
4. **GitHub answers.** A 401 or 403 from GitHub means signed out (401 to the
   client). Any other failure answers 503, never 401.
5. **The laid-out draft is not its own undo step.** One Undo goes straight
   back to the previous net. Redo returns the grid-placed draft, not the
   laid-out one.
6. **The few-shot example** is a coffee shop modelled on the café showcase,
   not a verbatim showcase net, which is in a different format.
7. **Not done from the design's test plan:**
   - recorded replies, which need the key;
   - the Go test asserting that go-pflow accepts exactly the nets
     `validateNet` accepts (a follow-up).

## Notes from the pflow-native session (2026-10-24)

- **The wasm shim exists:** pflow-native commit `62923ff`, `crates/wasm`
  (`pflow-native-wasm`). It is local on the Mac and not pushed yet.
  - API: `new Engine()`, `listCommands(prefix)`, `execute(id, argsJson)`,
    `batch(stepsJson)`, `load(jsonld)`, `Engine.version()`.
  - Built without services, http, zk, rnn or png, with `make wasm-shim`
    (wasm-bindgen `--target web`) into `target/wasm-shim/`.
- **Spike numbers, under Node:** 175 commands, 16 ms init, 13 ms for the
  first `analysis.invariants` on SIR. The bundle is 1.63 MB gzip, or 1.16 MB
  with `opt-level=z` plus LTO.
- **This settles open decision 2:** the shim lives in pflow-native
  `crates/wasm`.

## Phase 2: structural analysis in the browser

What landed:

- **pflow-native's engine, vendored.** `public/vendor/pflow-native-wasm/`
  holds the wasm-bindgen glue, the `.wasm` gzip-only, and `commands.js`, a
  snapshot of the specs of the 9 exposed commands. `pflow-native-wasm.lock`
  records the version, commit and sha256s. `scripts/sync-native-wasm.mjs`
  regenerates all of it from a `make wasm-shim` build.
- **The gzip gate.** The webserver serves `X.wasm` from `X.wasm.gz` with
  `Content-Encoding: gzip` (`cmd/webserver/wasm.go`), because nginx on
  pflow.dev compresses only text/html.
- **`public/petri-wasm.js`, the bridge.** It loads the engine on first use,
  loads the current document, runs the command, and moves every artifact the
  result names into the JS registry, rewriting the ids.
- **The registry.**
  - The native commands are `analysis.validate`, `incidence`, `invariants`,
    `siphons`, `verify`, `reach`, `reachability`, `canonical` and
    `classify`.
  - Native's `sim.goto`, `view.highlight`, `view.clear_highlight` and
    `artifact.show_set` are now JS commands.
  - `analysis.validate` (Check net) was renamed `analysis.check`.
- **The UI.** A Structure dialog (`public/petri-analysis-ui.js`) and the
  Results dialog render the new kinds: matrix, sets, trace, a layered
  reachability graph, and a readable generic report. Show highlights a set
  on the canvas, with coefficient badges. Go loads a trace step or a graph
  state as the marking; Reset marking returns.

**Wasm gate (the ROADMAP's decision gate): passed.**

| Measure | Value |
|---|---|
| Bundle, gzip (opt-level z + LTO, codegen-units 1) | 1,161,646 B (raw 6.2 MB) |
| Cold load plus the first analysis, browser via local server | about 1.4 s |
| Init and first `analysis.invariants` on SIR (Node, pflow-native's numbers) | 16 ms, 13 ms |
| Commands in the engine / exposed | 175 / 9 |

Splitting per namespace was not needed.

Verified:
- `make test`: 199 JS tests, including 9 that run the real wasm through the
  registry and check the lock.
- `go test`, including the gzip-serving test.
- In a browser: invariants highlight with badges, verify's counterexample
  replays with Go, the graph renders, reach answers, Reset marking returns.

### Decisions to review (phase 2)

1. ~~**The vendored shim was built from pflow-native `62923ff`, which is
   local only, not pushed.**~~ Resolved: the pflow-native session pushed
   `62923ff` to github.com/pflow-xyz/pflow-native `main` on 2026-10-24.
2. **The size profile is set in the environment**
   (`CARGO_PROFILE_RELEASE_OPT_LEVEL=z`, `_LTO=true`, `_CODEGEN_UNITS=1`),
   not in pflow-native's `Cargo.toml`. A plain `make wasm-shim` gives
   1.63 MB gzip.
3. **The engine is reloaded with the whole document on every native call.**
   This is simple and keeps one source of truth, and costs a parse per call.
   Fine at these sizes.
4. **Analyses run from the current marking** (native's semantics). After a
   Go, the next analysis starts from that marking. Reset marking undoes it.
5. **`analysis.check` is the new name** of phase 0's `analysis.validate`, so
   that `analysis.validate` means pflow-validation in both apps.
6. **The `.wasm` is stored gzip-only** in git (1.16 MB), not raw (6.2 MB).
7. **Not done:** pflow-native's FEATURES.md has no "Web" column yet (open
   decision 1). That is another repo, with an active session on it.

## Phase 4: the Assistant (chat) and the in-page MCP

What landed:

- **`POST /api/llm/turn`** (`cmd/webserver/llm_turn.go`, prompt
  `prompts/turn-v1.md`).
  - The server is stateless: the browser sends the mode, a bounded net
    summary and the whole conversation each call.
  - The server adds the fixed system prompt and declares the manifest's
    tools. It refuses any call the manifest does not name, and accepts at
    most 8 calls per reply.
  - It charges one quota unit per model call and returns the model's message
    verbatim, so Gemini's thought signatures go back next turn.
  - The mode and the net travel as user content, never in the system prompt.
  - `/api/llm/status` reports `chat`.
- **The tool manifest** (`public/llm-tools.json`, 43 tools) is generated
  from the registry by `scripts/gen-llm-tools.mjs`. It is cut down to
  Gemini's schema subset, with free-form arguments passed as JSON strings.
  The server reads it from its embedded `public/`, and a test fails on
  drift. `public/petri-tools.js` maps names both ways and compacts results
  for the model.
- **The loop** (`public/petri-chat.js`, no DOM).
  - Edits and analyses run in a sandbox registry, so the model can check its
    own edits.
  - View commands act on the live canvas.
  - Artifacts land in the editor's shared store, so they appear in Results.
  - Apply commits the sandbox as one undo step; Discard drops it.
  - At most 6 model calls per message.
- **The panel** (`public/petri-chat-ui.js`).
  - Docked, not modal, with Build / Analyse / Explain modes.
  - The conversation, a quota line, and a pending-edits diff with Apply /
    Discard.
  - The Tools section lists every call with its arguments, timing and
    errors. Each artifact can be opened inline (Show / Go wired to the
    canvas), and each call can be rerun or copied as an MCP call.
  - Menu: 💬 Assistant, shown only when the status says `chat`.

Verified:
- `make test`: 209 JS tests. Go tests cover the manifest gate, the per-reply
  cap, the thought-signature round trip, validation, and "no manifest means
  off".
- `bazel build //...`.
- In a browser with a scripted model in place of Gemini: 3 model calls, 4
  edits and an invariants run. The live net was untouched until Apply, the
  diff was shown, the artifact rendered inline, and one Undo reverted.

### Decisions to review (phase 4)

1. **The server is stateless.** The conversation lives in the browser and is
   re-sent each call, capped at 256 KiB and 80 messages. "New" starts over.
2. **Limits.** Quota is charged per model call (as sim's `sim_generate`
   does). There are at most 8 tool calls per reply and 6 model calls per
   message; "ask to continue" after that.
3. **Analyses run on the sandbox.** They see pending edits. Moving the
   marking (`sim.fire`, `sim.goto`, `sim.reset`) counts as an edit and needs
   Apply to reach the canvas.
4. **Explain mode refuses edits in the browser**, as well as saying so in
   the prompt.
5. **The chat does not get `file.load_json` or `export.artifact`.**
6. **Tool names:** the command id with its first `.` as `_`. Free-form
   arguments (`to`, `from`, `properties`, `weights`) go as JSON strings.
7. **Every call sends the whole manifest** (about 20 KB, roughly 5k tokens).
   Fine for Flash; trimming by mode is a later option.
8. **Not exercised against live Gemini** (no key in this run). The
   function-calling body follows the API as documented, and thought
   signatures are preserved. The first live session is the real test: see
   "To turn it on" under phase 1.

## Phase 3: the simulation workbench

What landed:

- **JS engines as commands, under pflow-native's ids and argument names.**
  - `sim.ssa` (petri-ssa.js) and `sim.sde` (petri-sde.js).
  - Seeded; realizations are averaged, with a ±1 sd band.
  - `sim.sde` refuses gated nets and says to use the SSA.
- **`sim.recommend`** applies docs/engine-selection.md's two rules:
  - inhibitor or read arcs, or a capacity, mean the SSA;
  - small populations mean the SSA with several runs;
  - otherwise the ODE.

  It explains why, and proposes a horizon, a seed and a run count. The
  horizon is a few per-token time constants at the initial marking.
- **pflow-native, through wasm:** `sim.equilibrium`, `sim.scenario`,
  `sim.compare`, `sim.crosscheck`, `analysis.diagnose`, `opt.heatmap` and
  `opt.optimize` (16 native commands exposed in all).
- **Renderers:** bands, bars (the tornado), heatmap, and scatter (the Pareto
  front).
- **The Simulate dialog** (`public/petri-workbench-ui.js`). Its tabs are
  Stochastic, Which knob matters, What if one more, Two-rate heatmap,
  Optimize, SSA vs ODE, and Equilibrium. Every tab is one command, and the
  dialog shows the suggested engine and why.

**Phase 3's exit check: same seed, same numbers.** A test runs the browser's
`sim.ssa` and pflow-native's wasm `sim.ssa` on the shared coffee-shop golden
(8 time units, 5 runs, seed 42, 60 points) and requires every value to be
equal, not just close.

Verified: `make test` (213 JS tests), and in a browser every Simulate tab
produced and rendered its artifacts.

### Found: pflow-native's SSA visits transitions in sorted-id order

petri-ssa.js and go-pflow's portable goldens use **document order** for
transitions. pflow-native's `sim.ssa` uses **id order** (`sim.rs` builds
from sorted maps).
- On a net whose transitions are listed alphabetically, the two agree to the
  bit.
- Otherwise the seeded paths differ, though they are statistically the same.

Minimal case: two transitions `zeta`, `alpha` racing for one place, seed 5.
The parity test lists transitions in sorted order (marked `REVIEW:`), so
everything else is still pinned. **A pflow-native follow-up:** compile the
SSA in document order, then drop the sort from the test.

### Decisions to review (phase 3)

1. **Bands are drawn as dashed ±1 sd lines.** The plotter has no filled
   bands.
2. **`sim.recommend`'s horizon is a heuristic** (5 × the slowest per-token
   time constant, rounded). Every run states the horizon it used.
3. **Optimize** offers one maximise objective and one optional minimise
   objective in the dialog. The command takes any list.
4. **"What if one more" is `sim.compare`** with two scenarios on one seed.
   Its default engine is sim's: the SSA.
5. **`opt.fit` (rate fitting) is not exposed yet.** It reads observed data
   from an artifact in native's own session, which the bridge does not
   share. The JS fitter (petri-learn.js) needs a data-import UI first. A
   follow-up.

## Phase 5: the goal advisor ("what do you want to know?")

What landed:

- **`public/goals.json`**, the catalog, as data. It has 11 goals: stuck,
  can_happen, unbounded, conserved, average, risk, knob, one_more,
  best_setting, data_match and same_net. Each pairs the question in plain
  words with phrases, the inputs it needs, a plan of registry commands
  (with `$input.x` / `$stepN.field` references), what the answer looks like,
  and the caveat the answer must carry. `data_match` is marked unavailable:
  conformance needs an event-log import.
- **`public/petri-goals.js`.** Load the catalog, resolve references, run a
  plan step by step through any registry, and rank goals by the person's
  words (the no-LLM router).
- **`public/petri-goals-ui.js`, the "❓ What do you want to know?" picker.**
  It works signed out.
  - Type a question, or pick a goal.
  - See its inputs, its plan (as commands), the answer's shape and the
    caveat.
  - Run it: each step's artifacts render, and Show / Go point at the
    canvas.
  - "Ask the Assistant instead" hands the question to the chat's analyse
    mode.
- **A new command, `sim.what_if {place, delta, t_end, runs, seed}`:** the
  "one more X" comparison on one shared seed. The chat can call it too.
- **The server.** `/api/llm/turn`'s analyse mode gets a routing brief built
  from the same `goals.json`, through `cmd/webserver/llm_goals.go`. The
  brief: map the person's words to one goal, state the plan and ask before
  running it unless they already said to, then answer with the evidence and
  the caveat.

Verified:
- `make test`: 237 JS tests. Every available goal runs end to end on an SIR
  fixture; every plan names a registry command; 11 paraphrases route to the
  right goal.
- Go: the catalog reaches analyse mode only.
- `bazel test //cmd/webserver:webserver_test`.
- In a browser, signed out: "what if I had one more nurse" routed to
  one_more and ran; "can it get stuck" ran verify and siphons, with Go
  buttons on the counterexample.

### Decisions to review (phase 5)

1. **Routing without the LLM is phrase matching** (`matchGoals`). The 11
   paraphrase tests stand in for the slice-1 `llm-eval` routing check until
   a key is available.
2. **Two goals are narrower than the roadmap's table.**
   - best_setting scans one rate (`opt.rate_scan`); Optimize in the Simulate
     dialog covers several rates.
   - same_net gives the canonical id, to compare by hand; a two-net diff is
     not in the browser.
3. **Plans state their inputs.** One_more asks for the place, can_happen for
   the target counts, best_setting for the transition and its range.
4. **The analyse brief asks before running** unless the person already said
   "run it". That is the roadmap's "a plan the user approves before it runs",
   enforced by the prompt, not by the UI.

## Phase 6: model refinement, adopted from sim

What landed:

- **`analysis.behaviour`**, sim's builder checks (`pkg/builder/checks.go`)
  in JS on the editor's own firing rule: disconnected parts, dead
  transitions, places nothing fills, a reachable marking where nothing fires
  (with a replayable trace), and unbounded growth. One bounded exploration:
  when the bound is hit, "never fires" and "never filled" are not claimed.
- **`analysis.defects`**, sim's refinement gate as a number: dead
  transitions + unmarked siphons (empty at the current marking) + declared
  goals that `analysis.reach` answers "no" to + conservation laws of a
  baseline that no longer hold. 0 is clean.
- **Goals in the net.** `net.set_goals {goals: [{label?, to}]}`, a validated
  `goals` term (Check net checks it), carried through native edits.
- **sim's components** (arrivals, service, hazard, inventory, decision,
  mailbox, datastore) and pflow-compose's templates, through native
  `compose.components`, `compose.fuse` and `compose.extend`. The bridge now
  commits a native edit's exported net as one undo step, keeping the
  editor's token list, goals, name and description.
- **Build mode is sim's interview.**
  - The steps are describe → structure → rates → validate → preview → done.
    Each call sends its `step`, and the server adds sim's step guidance,
    adapted to the editor's tools and components (`stepGuidance` in
    `llm_turn.go`).
  - The model ends a reply with "Next: <step>". The browser takes forward
    moves only, from that closed vocabulary.
  - After any round with edits, the engine's behaviour checks go back to the
    model with the tool results.
  - Step chips are shown in the panel; click one to move by hand.
- **The pending-edits bar shows the gate:** "Defect weight 1 → 0", with what
  counts. An increase is flagged, and Apply becomes "Apply anyway".
- **🧩 Components**, a palette dialog: pick a part, fuse its ports onto
  existing places, set its parameters.

**Phase 6's exit check** (`public/petri-refine_test.ts`): a scripted
interview starts from "we run a help desk".
- It goes through all six steps.
- It fuses arrivals and service through `compose_fuse` and adds patience
  and goals.
- The engine's checks come back after each edit round.
- It ends with `analysis.check` clean, a defect weight of 0, and no failing
  behaviour check.
- It is applied as one undo step.

Verified: `make test` (246 JS tests), Go tests (step guidance and its
validation), and in a browser: the palette fused arrivals and service onto a
queue, the checks were clean, the weight was 0, and the chips showed.

### Decisions to review (phase 6)

1. **The step marker is in the reply text** ("Next: rates"), parsed against
   a closed list, instead of sim's `step_done` JSON field. Our protocol is
   tool calls, not a JSON envelope.
2. **The gate allows edits that leave the weight unchanged**, which
   interactive editing needs. sim's gate requires a strict decrease.
   Increases are flagged and need "Apply anyway"; nothing is ever applied
   automatically.
3. **"Unmarked siphon" means empty at the current marking** (`marked:
   false`), as sim counts it. Asserted classes (sim's fourth term) do not
   exist in the editor, so they count 0.
4. **Native edits replace the document with the engine's export.** It
   renumbers place `offset`s and writes capacity 0 where the editor had
   null; both mean the same, but the bytes, and so the CID, differ from a
   hand edit.
5. **A deadlock finding is advice:** "fine if it is the intended end
   state". It does not count in the weight; sim's gate does not count it
   either.
6. **sim's rehearsal option** (the model plays its draft forward and the
   engine replays it) is **not adopted**. The behaviour checks after every
   edit round cover the same failure (a net that does not do what the model
   thinks) with the engine's own answer.

## Phase 7: the app view and question-shaped controls

What landed:

- **`public/petri-roles.js`.** sim's derivation (`web/lib/sim-derive.js` at
  `ea76b34e`), copied verbatim from `deriveRoles` down: pools, sources,
  losses, queues, terminals, services, and the derived disruptions with
  `applyDisruptions`. A small adapter reads the editor's format (read and
  inhibitor arc directions, labels, the net's own rates document), and
  `groupDisruptions` groups them by the question they ask.
- **Parity with sim's own module.** `scripts/gen-roles-goldens.mjs --sim
  ../sim-pflow-xyz` runs sim's `sim-derive.js` on seven sim-format models
  (the vet clinic, the coffee shop, five fidelity models with inhibitor and
  read arcs) and writes `parity/roles/*.json`. `public/petri-roles_test.ts`
  converts each model to the editor's format and requires identical roles
  and disruptions. All seven match.
- **Views.** A validated `views` term with sim's rules: bare-identifier
  ids, unique; roles from board, dashboard, controls, advisor, trust, log;
  every place, transition and link must exist. Set with `net.set_views`;
  Check net checks it.
- **New commands.** `analysis.roles` returns the roles and the grouped
  what-ifs. `file.export_sim` exports the net in sim's model shape (read
  arcs place → transition, rates, labels as tags), for `sim_create_model`.
- **📱 App view** (`public/petri-appview-ui.js`), docked on the left, with
  the net still visible.
  - Controls are phrased as questions: "What if I had more…" (pools), "How
    fast work arrives", "How soon people give up", "How fast each step is
    done".
  - The derived "What if…" disruptions are grouped by question.
  - Every control says which nodes it touches and highlights them on the
    canvas on hover.
  - "Run the day" runs a seeded `sim.scenario` with the overrides and
    disruptions merged. It reports outcomes (terminal places, mean ± sd),
    the busiest resource, and the engine's assumptions and caveats verbatim
    (the trust screen).
  - A net with views gets one tab per view.
  - "Copy for sim" puts the sim-shaped net on the clipboard.

**Phase 7's exit check:** the coffee-shop and vet-clinic fixtures (and five
more) derive the same roles and disruptions here as sim's own module does.

Verified: `make test` (261 JS tests) and `bazel test`. In a browser: the
controls derive from a café net, hover highlights the canvas, three baristas
run to served 22.75 ± 4.1 with the busiest resource named, and view tabs
filter controls and survive a reload.

### Decisions to review (phase 7)

1. **The derivation is copied, not shared, for now.** pflow-xyz should be
   canonical (open decision 3). Until sim vendors `petri-roles.js` with a
   lock, the goldens are what keep the two from drifting.
   `compareBumps` and `previewSupport` stay in sim: they need sim's
   classifier and sim's browser engine.
2. **The rates document is the net's own:** initial totals and `rate`
   (default 1.0), with **no fungible classes**. sim's server classifier
   collapses fork_0..fork_4 into one control; here each is its own. A
   follow-up could use native `analysis.classify`.
3. **"Share with sim" is copy and paste** ("Copy for sim" →
   `sim_create_model`). sim's publish needs its own Google sign-in, so
   pflow.xyz does not proxy it; `sim_publish_app` with
   `/lib/app-template.html` remains the route to a hosted app.
4. **"Run the day" uses native `sim.scenario`**, sim's engine semantics:
   SSA, an hours horizon (capped at 168), 16 runs, seed 7.
5. **View tabs filter controls** to the view's places and transitions. A
   view with neither shows everything.

## Phase 8: MCP outside the page

What landed:

- **`POST /mcp`** (`cmd/webserver/mcp.go`). pflow.xyz is an MCP server
  using Streamable HTTP in its stateless form: one JSON-RPC message (or a
  batch) per POST, a JSON reply, `initialize` / `ping` / `tools/list` /
  `tools/call`, and 202 for notifications. GET answers 405, since there is
  no event stream.
- **Tools, on the server's own Go engines:**
  - `pflow_check`: a go-pflow parse, plus the JSON-LD checks `/api/save`
    applies;
  - `pflow_cid`: the same sealer as `/api/save`;
  - `pflow_get`;
  - `pflow_simulate`: go-pflow Tsit5, with each transition's rate,
    overridable, and a sampled trajectory;
  - `pflow_reachability`: go-pflow's analyzer. A search stopped by its
    budget reports bounded and live as unknown, rather than what go-pflow
    saw so far;
  - `pflow_links`: the editor, SVG and JSON-LD URLs;
  - `pflow_save`: needs `Authorization: Bearer <GitHub token>` on the
    connection.
- **Bounds:** a 512 KiB body, horizon ≤ 10000, ≤ 20000 states, ≤ 200
  samples.

To try it: `claude mcp add --transport http pflow https://pflow.xyz/mcp`
(after the merge to `main`). Add `--header "Authorization: Bearer <token>"`
to save.

Verified: Go tests (handshake, list, every tool, errors as tool errors, save
needing and checking a token, no overclaiming on an incomplete search),
`bazel test`, and a live `curl` against a local server.

### Decisions to review (phase 8)

1. **"Attach to my tab" is not built**, as the roadmap says: deferred until
   phases 4–7 show what people do.
2. **`/mcp` uses the Go engines, not the browser registry**, so its tool set
   is smaller than the Assistant's. The rich analyses stay in the editor,
   and `pflow_links` sends a person there.
3. **`pflow_save` needs a token**, unlike `/api/save`. There is no OAuth
   server for MCP clients (sim has one); a client passes the GitHub token as
   a header.
4. **No rate limit on `/mcp`** beyond the per-call bounds. The tools are
   cheap and bounded; add a per-IP bucket if it is abused.
5. **The protocol version echoes what the client asks for.** The tools do
   not depend on it.

### Follow-up: SDE, what-if and optimize on `/mcp`

PR #107 left `sim_sde`, `sim_what_if` and `opt_optimize` off `/mcp` until
they had parity tests. They are on it now, as `pflow_sde`, `pflow_what_if` and
`pflow_optimize`, and `/mcp` lists 20 tools.

- **The engines are go-pflow's.** `pflow_sde` runs `SimulateSDE` on the
  portable path. `pflow_what_if` runs the scenario SSA, `stochastic.Simulate`
  on the portable path, for both arms on one seed. `pflow_optimize` runs Tsit5,
  configured as native's `OdeOptions::grid`. Defaults, caps, messages, seeding
  and aggregation are ported from pflow-native
  (`cmd/webserver/mcp_workbench_engine.go`).
- **Parity:** `parity/native/mcp_goldens.json` is generated from native
  (`make native-goldens`), and `cmd/webserver/mcp_workbench_parity_test.go`
  replays it. The SDE and the what-if match to the bit. So does the optimizer
  on most cases: it integrates with go-pflow's tableaux and `Solve` loop but
  sums the derivative in id order, as pflow-solver does (go-pflow's `Solve`
  sums in map order, which differed between identical calls and broke exact
  ties at random). Cases that go through a math library's 10^x, log10 or pow
  carry 1e-12. The suite's README section lists the known gaps and deliberate
  differences: place order, stiff nets for the optimizer, seeds above 2^53, a
  solve that runs out of steps (an error here), and the server's limits.
- **Every answer fits the 60 KB result guard whole.** Its size is bounded
  before the run; a count the caller chose that does not fit is refused, naming
  one that does, and a default is lowered with a `note`. Work and memory budgets
  count places as well as transitions.
- **Bazel:** `cmd/webserver/BUILD.bazel` lists the new sources, tests and
  their data (`//parity:native_mcp`, `//:pflow-native-wasm.lock`). An earlier version
  of this note said main's BUILD was already stale; it was not (#111 brought it
  up to date before this branch).

### Follow-up: game search on `/mcp`

`/mcp` runs Go on go-pflow and cannot reach pflow-native's wasm, so pflow-native's
`game.value` and `game.move` (pflow-rs' exact alpha-beta search of a net read as
a two-sided game, slice 5 of its search-pieces roadmap) are a Go port:
`internal/gamesearch`, the tools `pflow_game_value` and `pflow_game_move`
(`cmd/webserver/mcp_game.go`). go-pflow is a dependency, unmodified.

- **Ported**: the transposition table (line for line: node counts depend on its
  layout and replacement), the bit engine's behaviour (a 0/1 marking's key, the
  spill to counts, its deficit) and the counts engine (Zobrist keys), the order
  pieces (`tt_best`, `immediate_win`, `history`, `centrality`, `threats`), the
  filters (`must_win`, `non_losing`), the drivers (`null_window`, `mtd_f`,
  `budget`), `memo`, `mode` (play), the root's `non_losing`, and the opening
  book. Refused with the same words as native: a time budget, repeated pieces,
  unknown names, bad arguments.
- **Not ported, refused**: the root estimate `ode` and the `aspiration` driver.
  Native solves the mass-action ODE for them.
- **Parity**: `parity/native/game_goldens.json`, native's answer to ~1,500 calls
  (`make game-goldens`), replayed by `mcp_game_parity_test.go`: identical values,
  moves and node counts, identical refusals. `parity/native/README.md` has the
  list of deliberate differences (caps, one colour, names, no artifact).

### Follow-up: the game tools in the browser

pflow-native `cdd3816` adds `game.value` and `game.move`: a net read as a
two-sided game (`sides` who owns each transition, `reward` what the final
marking pays, `auto` transitions nobody chooses), searched exactly by
pflow-metamodel's alpha-beta over its firing rule, run as a `SearchPlan`
names it.

- **Vendored** (179 commands, 88 exposed). Both are exposed and in no side
  list: read-only (the move is not fired, the marking is not set), no
  artifact arguments (`book` is the label cache's text inline), and each
  result is also filed as a Report. Native caps what a browser tab can
  afford: a node budget of 1,000,000 by default and at most 100,000,000,
  a table of 2^20 entries by default and at most 2^23, and no time budget
  (`budget.ms` is refused: the wasm build has no clock).
- **The Assistant** gets `game_value` and `game_move`; `sides`, `reward`
  and `plan` travel as JSON strings (`json_args`).
- **The `best_play` goal**, "Who wins with best play, and with which move?",
  runs `game.move`. Its rules are a new input kind, `json`: a text box whose
  text `runGoal` parses before the plan runs. `petri-goals_test.ts` runs it
  on a per-goal fixture, pflow-native's tic-tac-toe (a draw, and a best move
  for X), where every other goal still runs on SIR.
- **Parity:** six cases on a byte-identical copy of pflow-native's
  `examples/tic-tac-toe.json` (`parity/native/fixtures/tic-tac-toe.json`):
  the value and a move with the default plan, a plan given as an object and
  as a JSON string, a mid-game position, past the budget in exact and play
  mode, and the refusals (a time budget, too many nodes, too big a table, a
  move no side owns). None names the `ode` root estimate, whose node count
  can differ between the native and wasm builds.

---

## How to review all of this

1. **Read this file's "Decisions to review" sections.** Every `REVIEW:`
   comment in the code is one of them: `git grep -n "REVIEW:"`.
2. **The PRs, in merge order:** #96 (phase 0), #97 (1), #98 (2), #99 (4),
   #100 (3), #101 (5), #102 (6), #103 (7), and phase 8. Each is merged into
   `workbench`.
3. **Run it locally:** `make build && ./bin/webserver -port 18080`.
   Everything except the Assistant and drafting works signed out with no
   key. To exercise those, set `GEMINI_API_KEY` (and optionally
   `PFLOW_LLM_ALLOW=stackdump`).
4. **The `workbench → main` PR is the deploy.** Merging it pushes `main`,
   and the webhook rebuilds pflow.xyz. Merge it locally with a signed merge,
   as `deploy.go` runs `git verify-commit`. The LLM features stay dark until
   the key is in `~/services` on pflow.dev.
5. **Follow-ups outside this repo:**
   - **pflow-native:** `file.cid` should hash the session rates (phase 0).
   - **pflow-native:** compile the SSA in document order (phase 3).
   - **pflow-native:** a Web column in FEATURES.md (open decision 1).
   - **sim-pflow-xyz:** vendor `public/petri-roles.js` with a lock (phase
     7, open decision 3).
