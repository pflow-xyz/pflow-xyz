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
| 1 Describe it, get a draft | | |
| 2 Structural analysis | | |
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
