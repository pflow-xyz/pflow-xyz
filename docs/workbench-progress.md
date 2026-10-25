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
| 3 Simulation workbench | | |
| 4 Chat modal + in-page MCP | | |
| 5 Goal advisor | | |
| 6 Model refinement | | |
| 7 App view | | |
| 8 MCP outside the page | | |

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

1. **The vendored shim was built from pflow-native `62923ff`, which is
   local only, not pushed.** It was built from a separate local clone, so
   pflow-native's working tree was not touched. Push pflow-native, then
   re-run `scripts/sync-native-wasm.mjs` if the commit changes.
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
