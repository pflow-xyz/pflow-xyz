# Agent-first analysis: one Ask, views the agent opens

Status: design, not implemented. No app code changes. Mockup: [agent-first-analysis-mockup.html](agent-first-analysis-mockup.html) (static, open it in a browser).

Written against `main` at 8d30d96. A second run is fixing bugs on `fix/gemini-agentic-feedback` (landing chat, Assistant panel on phones). Its `docs/landing-chat.md` was read for overlap; see [Sequencing](#sequencing-with-the-landing-chat).

Sources: this repo's code and docs only (`public/petri-view.js`, `petri-chat*.js`, `petri-goals*.js`, `goals.json`, `llm-tools.json`, `docs/engine-selection.md`, `docs/workbench-progress.md`). Nothing external or proprietary.

## 1. Problem

The analysis UI is a set of engine front-ends: five dialogs with about 20 tabs, each exposing the engine's knobs (outcome, horizon, runs, seed, rate ranges). The person has to know which engine answers their question before they can ask it. Three agentic features sit beside them, and each covers part of the same job:

| Today | What it does | Failure seen in the live test |
|---|---|---|
| Describe a process | Gemini drafts a net, with notes and rates | Fine, but it is a separate door from the Assistant |
| Assistant (Auto/Build/Analyse/Explain, 109 tools) | Tool loop over the registry, sandbox edits, Apply/Discard | Handled questions the matcher missed |
| What do you want to know? (12 goal cards) | Keyword match to a plan of commands | Missed obvious questions |

Failures that came from exposing knobs or from unguarded plans:

1. The user had to pick the "outcome" dropdown by hand.
2. `analysis.diagnose` ran the ODE although `sim.recommend` said SSA (the net has capacities). The ranking was confident and wrong.
3. The keyword matcher missed questions the Assistant answered.

Failure 2 is the important one. It was not a missing menu item. It was a plan that could run a command the net's own analysis said was invalid. A better prompt does not fix that; a refusing mechanism does (see [Guards](#5-guards-the-mechanism-decides-the-model-proposes)).

## 2. Principles

1. The user states intent. The agent picks the goal, the inputs, and the view.
2. The model picks what needs judgment: which goal, which place or transition the words refer to, how to phrase the answer. Deterministic code picks everything with a rule: engine (`sim.recommend`), horizon, seed, validity of a command on this net.
3. Nothing is hidden, only folded. Every result carries the call that made it, rerunnable and editable.
4. The deterministic path never goes away. Everything the agent can do is a registry command a person can run from a palette with no model.
5. Say "assistant's judgment" when it is. The engine's output is labelled as the engine's; the model's reading of it is labelled as the model's.

## 3. Menu: before and after

### Before (main menu, as of today)

```
Save to Server · Delete · Save/Open my account · Share · Save As Gist · My Diagrams · Edit Details · Logout
Describe a process… · Draft notes · Assistant
Analysis (ODE, scans, phase) · App view · Components · What do you want to know?
Simulate (stochastic, influence, what-if) · Structure (invariants, verify, reach)
Check net · Results
Layout Algorithms · Toggle Editor · Display Settings
Download JSON · Help · Sim — Run & Check
```

About 25 entries; 8 of them open an analysis surface, and 3 of those start an agent.

### After

```
[ Ask… ]   File ▾   View ▾   Help ▾            ⌘K  Tools
```

| Group | Entries | Notes |
|---|---|---|
| **Ask** (primary button + input, not a menu list) | One input: "What do you want to know or change?" Suggested prompts below it. | Merges Describe, Assistant, goal cards. Always visible; the input is on the canvas chrome, not behind a hamburger. |
| **File** | Save, Open, My Diagrams, Save as Gist, Share, Download JSON, Edit Details, Delete, Account (sign in/out, Save/Open my account) | The existing persistence entries, regrouped. No behaviour change. |
| **View** | Layout algorithms, Display settings, Toggle JSON editor, Open as app (App view) | Plain UI, no model. Answer to the open question: yes, these stay deterministic. |
| **Help** | Help, Sim — Run & Check | Unchanged. |
| **⌘K / Tools** | The command palette | Escape hatch; see [Palette](#8-the-deterministic-escape-hatch). |

Removed as menu items: Analysis, Simulate, Structure, Check net, Results, Components, What do you want to know?, Describe a process, Draft notes, Assistant. Each survives as a view or an automatic behaviour; see [Inventory](#7-inventory-kept-merged-hidden-deleted).

## 4. The Ask flow end to end

```
 words ─► (1) intent ─► (2) goal + inputs ─► (3) guards ─► (4) run ─► (5) view + provenance
            │               │                    │                          │
        server label     model fills         deterministic              follow-ups
        (free, small)   a typed goal call    refuses/overrides          reuse the session
```

### 4.1 Intent (build / analyse / explain)

Today the server labels intent with a small classifier model that is not charged to the quota. Keep that. Drop the Auto/Build/Analyse/Explain tabs from the UI; show the label as a small chip on the reply ("Analysing") with "Not what I meant" which resends the message with the intent forced. The intent still gates side effects as today: explain never edits (enforced in the browser), build edits go to a sandbox and wait for Apply.

### 4.2 Goal and inputs: the model gets goals, not 109 tools

Today the model sees the whole 109-tool manifest on every call (about 20 KB, roughly 5k tokens per the phase-4 notes) and has to compose engine-level calls. That is where knob mistakes come from, and it is the largest repeated cost.

Proposal: the model's primary tool surface becomes the goal catalogue, `public/goals.json`, already 12 entries with typed inputs, a plan of registry commands, an answer shape and a caveat. The model gets:

- `run_goal(goal_id, inputs)`: inputs are the goal's declared kinds (`place`, `transition`, `number`, `marking`, `json`). The plan runner resolves `$input.x` / `$stepN.field`, runs the plan on the sandbox registry, and returns compact results. The model never types `t_end`, `runs`, `seed`.
- A small edit set for build intent: `edit`, `net.*` basics (about 10 tools).
- `ask_user(question, options)`: the clarifying-question tool (4.4).
- `run_command(id, args)`: the long tail (about 88 exposed commands). Listed by name and one-line help only; schemas are fetched on demand (`command_schema(id)`), so the manifest is not paid on every call. Calls are still validated by the registry's JSON Schema and by the guards.

Expected effect: a manifest of roughly 25 entries instead of 109, and most analysis questions answered in one `run_goal` call plus one summarising reply, i.e. 2 model calls where 3 to 6 are possible now. This is an estimate to be measured by Step 2 below, not a claim.

When no goal fits, the model uses `run_command` for what the question needs, and the reply says "no standard goal matched; I composed this". Those compositions are logged (command sequence, no text) and are the input to adding new goals. That is how the catalogue grows without the model being trusted with new plans.

### 4.3 Engine and outcome selection

The model does not choose the engine. `sim.recommend` does, by the two rules in `docs/engine-selection.md` (inhibitors, read arcs or capacities mean SSA; small populations mean SSA with several runs; otherwise ODE). Goal plans already begin with `sim.recommend` for the stochastic-sensitive goals.

- The recommended engine, the reason, the horizon, seed and run count come from `sim.recommend` and are shown in the provenance footer.
- A user who says "use the ODE" is an explicit override. The model passes `engine_override: "ode"`; the guard accepts it and the view shows a warning chip: "ODE on a net with capacities; the engine recommends SSA".
- The "outcome" dropdown disappears. For goals that need one (`knob`, `best_setting`, `one_more`), the model fills it from the question ("make the peak smaller" means place `I`, measure `max`). If it cannot, it asks (4.4). The default when the net has a single obvious sink or output place is chosen deterministically and stated as an assumption.

### 4.4 Clarifying questions

Rule: ask at most one question per turn, and only when all of these hold:

1. A required input has no value the model can ground in the net (two places both match "the queue"), and
2. no safe default exists, and
3. a wrong guess would produce a plausible but misleading answer (a wrong outcome place).

Otherwise: proceed, state the assumption in the reply ("I took *outcome* to be the peak of I"), and put a "Change" control next to the assumption that reruns with another value. A guess you can see and change costs one click; a question costs a round trip.

A question is a structured card, not prose: the question, 2 to 4 options drawn from the net (place names, transition names), "Other…" and "You decide". "You decide" records the model's choice as an assumption. The card is the `ask_user` tool's result, so it is logged like any other call.

### 4.5 View

The result opens in a results pane docked beside the canvas (the existing Results/artifact renderers in `petri-results.js`: bands, bars/tornado, heatmap, scatter, tables). The pane has:

1. **The answer**: one or two sentences from the model, then the goal's declared answer shape and caveat (from `goals.json`, not the model).
2. **The evidence**: the artifact(s) the plan produced.
3. **Provenance** (section 6).
4. **Follow-ups**: 2 to 3 suggested next questions (static per goal in `goals.json`, e.g. `risk` suggests "which knob reduces this?"). No extra model call.

Views are not modal dialogs. The agent can also open the canvas-side views it already has commands for (`view.*`: highlight a place, Go to a transition, show the firing sequence), so "why is it stuck?" highlights the siphon on the canvas.

### 4.6 Build intent

Describe a process is the first turn of a build conversation with an empty canvas. The draft keeps its gate (`validateDraft`, `draftToNet`, strict `validateNet`). Its notes, assumptions and rates become an "Assumptions" section in the pending-diff card with per-line edit, and "Regenerate" stays as a button on that card. Edits stay in a sandbox until Apply, one undo step, as in phase 4.

## 5. Guards: the mechanism decides, the model proposes

Per the house rule that a procedure living in a prompt becomes a structure that refuses the wrong order, these are code, not prompt text:

1. **Engine guard.** Each registry command declares its validity (`needs: "ode" | "any"` and the net features that make it invalid). The plan runner and the `run_command` path call `sim.recommend` once per net revision (cached) and refuse an engine-dependent command that the recommendation rules out, unless `engine_override` is set. This is the fix for the `analysis.diagnose` failure and it ships before any menu change (Step 1).
2. **Argument defaults from the net**, not from the model: horizon, seed, runs.
3. **Place and transition ids are checked against the net.** A hallucinated id is a tool error returned to the model, never a run.
4. **Result labelling.** The pane tags each line as `engine` (produced by a command) or `assistant` (model text). The model's prose cannot carry a number the artifacts do not contain: the reply renderer shows numbers only from artifact fields (see risk R3 for how strictly).
5. **Unchanged:** explain refuses edits; edits need Apply; at most 8 tool calls per reply and 6 model calls per message.

## 6. Provenance UX

Every result in the pane ends with a collapsed "How this was computed" footer, open by default for the first result in a session:

```
Goal        risk — "How bad can it get? What's the spread?"
Engine      SSA — recommended: this net has capacities (rule 1, engine-selection.md)
Calls       sim.recommend {}  →  sim.ssa {t_end: 42, runs: 20, seed: 1}
Assumed     horizon from sim.recommend; runs=20 (default for risk)
Caveat      Twenty runs give a spread, not a tail probability.
            [ Rerun ] [ Edit settings ] [ Copy MCP call ] [ Open in Tools ]
```

- **Rerun** repeats the exact calls (same seed, same answer, as today).
- **Edit settings** is where the knobs live now: a small form generated from the command's JSON Schema, prefilled, applied as a new result next to the old one. This is the "choices visible, not hidden" answer: the raw knobs are one click away on a result, not three dialogs away before any result.
- **Copy MCP call** is as in the Assistant today.
- **Open in Tools** opens the same call in the palette form. Provenance is the bridge to the escape hatch.
- Results stack in a session list (this replaces the Results dialog). Each item keeps its footer; a result made stale by a later edit to the net is marked "net changed since" and offers Rerun.

## 7. Inventory: kept, merged, hidden, deleted

From the code (`petri-view.js` menu at ~7825, `petri-*-ui.js`, `goals.json`, `llm-tools.json`).

### Menu entries

| Today | Fate | Where it goes |
|---|---|---|
| Save to Server, Open/Save my account, Share, Save as Gist, My Diagrams, Edit Details, Delete, Download JSON, Logout/Login | **Kept** | File |
| Layout Algorithms, Display Settings, Toggle Editor | **Kept**, plain UI | View |
| Help, Sim — Run & Check | **Kept** | Help |
| Describe a process… | **Merged** | Ask (build intent) |
| Draft notes | **Merged** | Assumptions section of the pending-diff card |
| Assistant | **Merged** | Ask (the panel is the Ask pane) |
| What do you want to know? | **Merged** | Suggested prompts in Ask; cards stay as a no-model path (section 9) |
| Analysis (ODE, scans, phase) | **Hidden**, then deleted | Views the agent opens; palette for the deterministic path |
| Simulate (stochastic, influence, what-if) | **Hidden**, then deleted | Same |
| Structure (invariants, verify, reach) | **Hidden**, then deleted | Same |
| Check net | **Automatic** | Runs on load and before every Apply; shows as a "N problems" chip by the title, click for the list. No menu entry |
| Results | **Merged** | Session result list in the Ask pane |
| App view | **Kept** as a view | View → Open as app; the agent can open it ("show this as an app") |
| Components | **Merged** | Build intent uses `compose.fuse`; a "+ Add component" button stays in the Build side of the canvas toolbar (it is editing, not analysis) |

### Dialog tabs (what the agent can open)

| Surface | Tabs / sections | Fate |
|---|---|---|
| Analysis dialog (`_showSimulationDialog`) | Simulate (ODE), Rate Scan, Sweep, Phase Plot | Views. Goals `average`, `best_setting`. Phase plot has no goal yet: add one ("how do X and Y move together?") |
| Simulate/Workbench (`petri-workbench-ui.js`) | Stochastic, Which knob matters, What-if, Heatmap, Optimize, Crosscheck, Equilibrium | Views. Goals `risk`, `knob`, `one_more`, `best_setting`. Crosscheck and Equilibrium have no goal: crosscheck becomes a footer action "check with another engine" on any result; equilibrium becomes goal `settle` ("where does it end up?") |
| Structure (`petri-analysis-ui.js`) | Invariants, siphons, verify, reach, reachability graph, … | Views. Goals `stuck`, `can_happen`, `unbounded`, `conserved` |
| Check net | Strict validator + engine smoke | Automatic (above); `analysis.check` unchanged |
| Results dialog | Artifacts by kind | Session result list |
| goals.json `data_match` | Unavailable (needs an event-log import) | Keep hidden until import exists |
| goals.json `same_net`, `best_play` | Available | Kept as goals; `best_play` only offered for game-shaped nets |

### Code

| Module | Fate |
|---|---|
| `petri-goals.js`, `goals.json` | **Promoted**: now the model's tool catalogue and the no-model router |
| `petri-chat.js`, `petri-chat-ui.js`, `petri-tools.js` | **Kept and reshaped**: becomes the Ask pane; mode tabs removed; manifest shrinks (`gen-llm-tools.mjs`) |
| `petri-draft-ui.js` | **Folded** into the Ask pane's build flow; the load gate `petri-draft.js` is kept as is |
| `petri-goals-ui.js` | **Folded**: the picker becomes suggested prompts + the offline form path |
| `petri-workbench-ui.js`, `petri-analysis-ui.js`, Analysis dialog in `petri-view.js` | **Kept one release behind the palette ("Classic tools")**, then deleted once the Ask path covers their use. The renderers (`petri-results.js`) are what survive |
| `petri-appview-ui.js`, `petri-components-ui.js` | **Kept** |
| `/api/llm/draft` | **Kept** (build's first turn can use it for the structured-output path) or folded into `/api/llm/turn`; decide in Step 3 by measuring |

## 8. The deterministic escape hatch

**Command palette**, opened with ⌘K / Ctrl-K and a "Tools" button. Fuzzy search over the registry (88 exposed commands) by id, label and help; Enter opens a form generated from the command's JSON Schema, runs it with no model, and lands the result in the same pane with the same provenance footer. Everyone gets it: signed-out users, users not on `PFLOW_LLM_ALLOW`, anyone when the model is down. It is the same list the MCP server exposes, which keeps "the UI can do what the connector can do".

Pushback on hiding it: if it is hidden, it reads as removed and power users leave. Keep a visible, quiet "Tools ⌘K" affordance in the top bar.

Palette hygiene: commands are grouped by the user's questions (Stuck? Spread? Which knob? …) before the engine-level names, so the palette is itself mostly goal-shaped. Engine-level commands sit under "All commands".

## 9. Fallback and offline behaviour

`/api/llm/status` already reports enabled / chat / allowed / quota. The Ask input reads it once and picks a mode:

| State | Ask behaves as |
|---|---|
| Signed in, quota left | Full agent |
| Signed out | Goal cards and palette work. The input accepts words, runs the keyword router (`petri-goals.js` ranking) and shows its best 3 goals as cards; a "Sign in to ask in your own words" line. Words are kept across the GitHub round trip as the landing chat already does |
| Not on `PFLOW_LLM_ALLOW`, or server has no chat | As signed out; no sign-in nag |
| Quota exhausted | Keyword router + cards + palette, with "Model calls are used up for today (resets 00:00 UTC)". Anything already shown stays rerunnable (reruns are deterministic, no model) |
| Upstream error / timeout | One retry on the transient errors, then the same degraded mode as quota, and the failed message stays in the input |

In degraded mode a card runs with deterministic defaults and a small inline form for inputs the goal needs (pick a place from a dropdown of the net's places). The keyword matcher's role shrinks to routing and suggestion, where a miss costs a click rather than a wrong answer.

The keyword matcher was missing obvious questions, so it must not be a gate in front of the model. It is the offline path and a source of suggested prompts only.

## 10. Quota and rate-limit assumptions

Policy as set: limits are a safety valve, tightened only if billing alarms fire within a day. This design keeps that and adds no new limit mechanism.

- Existing knobs stay: `PFLOW_LLM_DAILY_LIMIT` (30 per user per UTC day), `PFLOW_LLM_GLOBAL_DAILY_LIMIT` (500), burst 3, refill 20 s, one call in flight per user. They are environment variables, so tightening is a config change and a restart, not a code change.
- The intent classifier is not charged (unchanged).
- Charged unit is still one model call. The design reduces calls per question (goal tool, smaller manifest, no confirm-then-act round trips) but a clarifying question costs one extra call. If those per-question counts do not drop in Step 2's measurement, say so before shipping the merge.
- Token cost per call falls with the manifest (about 5k tokens to roughly 1.5k if the 25-entry manifest holds; estimate, measure in Step 2). The usage log already records tokens per call, so no new telemetry is needed to see this.
- The usage log (`data/llm/usage-YYYY-MM.jsonl`) is the billing-alarm input. Add one field to the `done` line: `goal_id` (or `none`), so cost per goal is visible. It carries no text.
- **Tripwire, written down:** if the global count exceeds a set fraction of its limit in a day, or an individual user hits the daily cap on three consecutive days, the response is to lower the env value; nothing in the UI has to change because the degraded mode above is already the quota-exhausted path.
- Open: a lower daily limit hurts the Ask flow more than the old one, since every question now routes through the model. If tightening is needed, prefer a cheaper model for `run_goal` turns (the small classifier model class) over a lower cap. Decision for Matt.

## 11. Migration plan: small, shippable steps

Each step is one PR, safe to ship alone, and Step 0 to 2 change no menu.

| # | Step | Ships | Check |
|---|---|---|---|
| 0 | **Provenance footer** on every artifact in Results and the Assistant: goal/commands/args/engine reason, Rerun, Copy MCP call | Visible value, no behaviour change | Unit test that a footer renders for each artifact kind; rerun reproduces bytes at the same seed |
| 1 | **Engine guard** in the plan runner and `run_command`: commands declare validity; a command the recommendation rules out is refused unless overridden | Fixes the diagnose-on-capacity failure for everyone, including the old dialogs | Regression: SIR-with-capacity net, `knob` goal, must run SSA or refuse; a test per guarded command |
| 2 | **Goal tools for the model**: `run_goal`, `ask_user`, `command_schema`; manifest shrink; keep the old tools behind a flag for A/B | Fewer calls and tokens per answer | Eval set of ~40 questions per goal paraphrase with expected goal and engine, run with a scripted model in CI and live with `make llm-eval`. Record calls and tokens per question before and after |
| 3 | **Ask pane**: Ask input + Assistant pane merged, mode tabs replaced by the intent chip, goal cards as suggested prompts, Describe as first build turn. Behind `?ui=ask` | New front door, old menu intact | Smoke test under `scripts/` for the five states (full, signed out, not allowed, quota out, upstream down); phone layout |
| 4 | **Palette** (⌘K): registry search, schema-generated forms, same result pane | Escape hatch exists before anything is removed | Every exposed command has a form or an explicit "no form" reason |
| 5 | **Menu swap**: default to File / View / Help / Ask / Tools; old dialogs under palette → "Classic tools" | The simplification users see | Smoke for each removed entry's replacement path; keep the old menu behind `?ui=classic` for one release |
| 6 | **Delete** the classic dialogs and their menu entries when Ask-path usage covers them (the usage log and a count of palette-opened classic tools are the evidence) | Code removal: `petri-workbench-ui.js`, `petri-analysis-ui.js`, `_showSimulationDialog` and friends | Bazel `public/files.bzl` regenerated; `make test` |

Steps 0 and 1 are worth doing even if the rest is rejected.

Two further tracks come from Matt's added requirements and are specified in [section 14](#14-linkable-model-views) (links) and [section 15](#15-composition-that-is-usable-not-a-demo) (composition). They are numbered L and C and slot into the order above:

| # | Step | Depends on | Ships |
|---|---|---|---|
| L1 | View spec + `?v=` / `#view=` open path (read-only commands only, no model) | Step 0 | A "Copy link" on every provenance footer |
| L2 | Share dialog gains "Share this view"; agent-opened views copy a link by default | L1, Step 3 | Sharing |
| L3 | Version pinning, stale-net banner, fork-on-edit | L1 | Stability |
| C1 | Composition becomes a first-class document: save, CID, `#view` link | L1 | A composition survives reload |
| C2 | Bring your own nets: load two of your nets into the compose page | C1 | Real input |
| C3 | Edit with undo/redo and live validation | C1 | Usable editing |
| C4 | Flatten into the editor ("Open composed net") and run it from there | C2 | Closes the loop with analysis |
| C5 | Agent: "connect my queue to this payment net" as a proposed link set with Apply/Discard | Step 2, C3 | Agent role |
| C6 | Retire the fixed examples to a "Gallery" and delete the Components dialog when C5 covers it | C4, C5 | Cleanup |


### Sequencing with the landing chat

The other run's landing chat already routes the hero into the Assistant by mode (Let it decide / Design / Analyse / Explain / Explore). Under this design those routes collapse into the one Ask input: the hero input is the Ask input, "Let it decide" is the default, and Design/Analyse/Explain become the intent chip. Nothing in the landing work conflicts with Steps 0 to 2. Steps 3 and 5 touch `petri-chat-ui.js`, the panel frame and the menu code that branch is editing, so start them after it merges to avoid rebasing a moving panel. Its panel-frame helper (`petri-panel-frame.js`, the phone layout work) should be reused for the results pane.

## 12. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **The model picks the wrong goal and the answer reads confidently.** | Show the goal name and its plain-language question above every answer ("I answered: *How bad can it get?*"); "Not that" re-asks with a different goal; the eval set measures goal-selection accuracy; the answer's caveat comes from `goals.json`, not the model |
| R2 | **Dependence on one provider and on quota.** Every analysis question now needs a model. | Section 9 degraded path is first-class and tested; the palette works with no model |
| R3 | **Model prose with wrong numbers.** | Numbers rendered from artifact fields; prose is checked for numerals not in the artifacts and flagged (start as a warning in the log, not a block) |
| R4 | **Power users lose their knobs.** | Edit settings on every result; palette; classic tools for one release; delete only on usage evidence |
| R5 | **Goal catalogue is the new bottleneck.** 12 goals will not cover everything; the long tail goes through `run_command`, which is the weak spot. | Log composed sequences, promote frequent ones to goals; `run_command` still passes the guards |
| R6 | **Guards over-refuse** (a legitimate ODE run blocked). | Explicit `engine_override` and a clear refusal message naming the rule; per-command tests |
| R7 | **Hidden cost: clarifying questions and retries** raise calls per question. | Ask at most one question, prefer visible assumptions (4.4); measure calls per question in Step 2 |
| R8 | **Discoverability:** with no menu list, people do not know what can be asked. | Suggested prompts that change with the net (a net with capacities suggests "how bad can it get?"), the goal cards as an empty-state grid, "Tools ⌘K" always visible |
| R9 | **Breaks shared contracts.** The editor's analysis surfaces are not part of the Go/JS parity contracts, but `llm-tools.json` is gated by a Go drift test and the MCP tool names are public. | Do not rename registry commands or MCP tools; only the browser manifest changes, regenerated with `scripts/gen-llm-tools.mjs`; Go-side gate updated in the same PR |
| R11 | **A link runs commands from untrusted input.** | Link replay is an allowlist of read-only analysis and view commands, with the same bounds as `/mcp` (runs, horizon, 60 s); edit, store and file commands are refused on open (section 14.6) |
| R12 | **A saved view silently changes meaning** after an engine update. | Pinned engine version plus the artifact hash; a mismatch is shown, never hidden (14.4) |
| R13 | **Composition work is large** and is the likeliest to stay demo-grade if only partly done. | Steps C1 to C4 are each shippable and each fix a named demo-grade defect (15.2) |
| R10 | **Merge conflict with the landing-chat run** in the panel and menu code. | Sequencing above |

## 13. Open questions and recommended answers

1. **Do Layout, Display settings, Toggle editor stay plain UI?** Yes, in View. No model involved, no reason to route them.
2. **Who gets the palette?** Everyone, signed in or not. It is the no-model path, so gating it on sign-in defeats it.
3. **Do the goal cards survive?** Yes, three ways: as suggested prompts under the Ask input, as the empty-state grid, and as the offline form path. The keyword matcher becomes the offline router only.
4. **Offline or no quota?** Section 9: cards, the keyword router, and the palette still work; reruns are deterministic.
5. **Does the model choose the engine?** No. `sim.recommend` does; the model may pass an explicit user override. This is the main change from the starting proposal, which said "the model picks goal, engine, outcome".
6. **Keep Auto/Build/Analyse/Explain tabs?** No; show the intent as a correctable chip. Keeps the safety property (explain does not edit) without asking people to classify themselves.
7. **Should Describe a process keep its own dialog?** No for the entry point; yes for its gate and its notes, which move into the pending-diff card.
8. **Decision for Matt:** cheaper model for goal turns versus a lower daily cap, if billing alarms fire (section 10).

## 14. Linkable model views

Requirement: a link names a net, a view of it, and the configuration that produced the view, and opening it reproduces the view without a model call. Agent-opened views get "Copy link" by default, because the provenance is the link.

### 14.1 What a link contains

A **view spec** is a small JSON-LD object (`@type: ViewSpec`):

```json
{
  "@type": "ViewSpec",
  "net": "zb2rh...",                      // CID of the net (immutable)
  "view": "risk",                          // goal id or a view id (knob-ranking, whatif, deadlock-proof, explanation, composition...)
  "calls": [                               // the tool calls that produced it, fully resolved
    {"id": "sim.recommend", "args": {}},
    {"id": "sim.ssa", "args": {"t_end": 42, "runs": 20, "seed": 1}}
  ],
  "engine": {"registry": "pflow-native <commit>", "app": "<pflow-xyz version>"},
  "expect": {"artifacts": ["sha256:..."]},  // hash of each artifact, to detect drift
  "note": {"by": "assistant", "text": "..."},  // the explanation, if any, labelled as model text
  "parents": ["<cid of an earlier spec>"]   // optional lineage
}
```

The calls are *resolved*: the engine, horizon, seed and run count that `sim.recommend` chose are written into the spec, so a later change to the recommender's rules does not change what the link shows.

### 14.2 URL scheme

Two forms, both opening to the same pane:

| Form | Example | Needs |
|---|---|---|
| **By reference** | `/?v=<specCID>` | The spec saved (sign-in; `POST /api/save`, stored like any object at `/o/{cid}`). Short and stable. The spec CID is `CIDv1(dag-json, sha2-256, base58btc)` over the URDNA2015 form, the same sealing as nets (`seal.go` / `seal-cid.mjs`; needs the `ViewSpec` terms added to both contexts and `public/schema` in lockstep, per the CID parity rule) |
| **Inline** | `/?cid=<netCID>#view=<base64url(deflate(calls))>` | A saved net, no sign-in to open. Works signed-out for a net already on the server. Hash form so it is never sent to the server or logged, and stays under a few KB |
| **Inline, unsaved net** | `/?data=<permalink>#view=...` | Reuses the existing `?data=` permalink for small nets; falls back to "save to get a stable link" above a size limit |

Existing links are untouched: `/?cid=` and `/?data=` open the net alone, exactly as now. `#view=` only adds. The landing page's deep-link rule (skip the hero when `?cid=` or `?data=` is present) extends to `?v=`. Compose-page links (`#view=cospan&ex=orders`) keep working; the composition scheme in 15.5 extends that hash.

### 14.3 Opening a link (no model call)

1. Load the net by CID (`/o/{cid}`) as now; for `?v=`, load the spec first, then the net.
2. Validate the spec (schema, command allowlist, bounds; 14.6).
3. Run the calls on a sandbox registry in order. This is the same plan runner as an Ask goal, with `$stepN` references already resolved. No `/api/llm/*` request is made, so no quota is spent.
4. Render the artifacts, the saved note (labelled "assistant's note, saved with the link"), and the provenance footer. If `expect` hashes do not match, show "This differs from when the link was made" with both engine versions (14.4).

Seeded engines are byte-deterministic by contract (SSA, SDE parity goldens), so the common case is an exact reproduction. The ODE reproduces to the solver's documented tolerance; the hash is over rounded values for float artifacts, with the rounding stated in the spec.

### 14.4 Stability across app versions

- Command ids are pflow-native's and are versioned by the vendored wasm lock (`pflow-native-wasm.lock`). The spec records that commit.
- A renamed command gets an alias table entry (`analysis.validate` became `analysis.check` once already; precedent). Links keep working through aliases.
- If the wasm is newer and the artifact hash changes, the pane says so and offers "Open with the original engine" only if we still ship it (we will not promise that); otherwise it shows the new result next to the saved hash and the reason it may differ. Nothing is silently swapped.
- A spec with a command the app no longer has shows the saved note and the calls, marks the view "not reproducible here", and offers to open the net alone.
- Schema changes to the spec add fields only; a `specVersion` integer gates breaking ones.

### 14.5 If the net is edited after linking

The link names a CID, and CIDs are immutable, so the link always shows the net as it was linked. Editing never changes it.

- The pane shows "This is a saved version of the net" with, when the viewer can tell, "A newer version exists" (the account's file list or the net's `parents` chain; if unknown, no claim).
- **Open latest and rerun** applies the same calls to the newest version and shows which succeeded. A call that names a place that no longer exists fails by name ("place `queue` was removed"), through the existing id check, and the view is marked partial rather than wrong.
- **Edit from here** forks: Apply writes a new net with `parents: [old CID]` (the existing lineage field), so the old link still resolves.
- Delete (`DELETE /o/{cid}`, author only) breaks links to that net. The pane says "net removed by its author"; the spec stays readable. Delete confirmation should say that links will stop working.

### 14.6 Safety of replay

A link is untrusted input that executes commands. Replay therefore:

1. Accepts only commands flagged `replay: true` in the registry: analysis, sim, opt, view and read-only compose commands. Never `edit.*`, `net.*` edits, `store.*`, `file.*`, `export.*` or anything that writes.
2. Enforces the same bounds as `/mcp`: argument ranges (runs, horizon, steps), the 60 s per call timeout and a total step budget.
3. Runs on a sandbox registry, never the live net. Apply is the only way to change the canvas, as today.
4. Treats `note` as text, escaped, never HTML.

Privacy: possession of a CID grants read of that net (`/o/{cid}` is not authenticated today). A link to a view is therefore as private as the CID. Say so in the Share dialog; do not imply access control we do not have.

### 14.7 Fit with the existing flows

| Flow | Change |
|---|---|
| Save to Server | Unchanged. Saving a net gives its CID. "Save view" in the provenance footer saves a ViewSpec through the same `/api/save` |
| Share dialog (`_showShareDialog`) | Adds a "Share this view" choice when a result is open, defaulting on; the dialog still shows the net-only link too |
| Copy link in the footer | New: copies the inline form if the net is saved, the `?v=` form if the spec was saved, otherwise offers "Save to get a link" |
| Agent-opened views | Show "Copy link" next to Rerun and Copy MCP call by default. If the net is unsaved, the button says "Save and copy link" and is one step |
| `?data=` permalink | Still the unsaved path; views hang off it with a hash |
| Share card (`/share-card/{cid}.png`) | Unchanged for nets; a view-specific card (artifact thumbnail) is a later slice |
| Save As Gist / account files | Out of scope; they hold nets, not views |
| MCP | `pflow_get`/`pflow_simulate` already work from a CID; add `pflow_view_link(net, calls)` returning the same URL so a connector and the UI make identical links |

### 14.8 Not decided here

Whether to host spec objects under a separate namespace (`/v/{cid}`) rather than `/o/`; a view has a different lifecycle from a net (many views per net). Recommend `/o/` now (no new route, same store) and revisit if listing "views of this net" becomes a feature.

## 15. Composition that is usable, not a demo

### 15.1 What exists today (read from the code)

| Piece | Where | What it does |
|---|---|---|
| Composition page | `public/compose.html`, `public/compose/*.js` (about 2,000 lines plus 10 views) | Ten drawings (cospan, string, operad, incidence, spiders, process, lens, laws, flat, boundaries) of one composition (orders, workers, payment) and one search plan (Connect-4), on pflow-native's `bundle.*` and `plan.*` commands in the wasm. Links can be added and removed by dragging; link legality, Flatten, scenario runs, the lens test and verdicts are the engine's |
| Components dialog | `public/petri-components-ui.js` (75 lines) | `compose.components` / `compose.fuse` on the net in the editor: add a part, fuse a port onto an existing place |
| App view | `public/petri-appview-ui.js` + `petri-roles.js` | Derives roles from the net and draws it as an app |
| Server-side composition | the `sim_compose` / link tools on the sim MCP server | Exists in sim, not in this editor |
| Registry commands | `bundle.add_instance`, `add_link`, `remove_link`, `remove_instance`, `candidates`, `flatten`, `run`, `lens`, `validate`, `verdicts` | The engine already has the verbs; the page uses most of them |

### 15.2 What makes it demo-grade

1. **Fixed inputs.** The composition is one of two examples from the registry's catalogue (`bundle.instances`; `state.example` is `orders` or `connect4`). You cannot bring your own net.
2. **No persistence.** The composition and the plan are not in the engine's session state; `state.js` says `start()` re-opens both by command on every load. Your links are lost on reload. The URL hash holds only the view and the example, not the links.
3. **No save, CID or share.** Nothing writes the composition to the server; no link reproduces an edited composition.
4. **Edits without undo.** Links can be added and removed, but there is no undo stack, so a mistaken drag is repaired by hand.
5. **Cut off from the editor.** Flatten produces a net on the page but there is no "open this in the editor", so the composed result cannot be edited, analysed with the goals above, or saved as a net. The Components dialog fuses into the live net with no preview and is a different mechanism with different rules.
6. **Read-mostly views.** Ten renderings of one object; most are not tied to analysis questions. The page is more about showing conventions (and Chyp's laws under Pyodide) than about doing a job.
7. **Errors are page-level.** A refused edit comes back as a "[CODE] message" in `state.error`; there is no per-link validity state or guidance on how to fix it.
8. **Agent absent.** Nothing on the page can be driven by the Assistant, and the Assistant's tools reach `compose.*` but not `bundle.*`.

Not a defect: the engine's rules are correctly in the registry, nothing re-implements them in JS, and the scene-manifest parity checks exist. The gap is the workflow around the engine, not the engine.

### 15.3 What "usable" means

A person can, without help:

1. **Compose two nets.** Pick two (or more) of their saved nets or the open one, plus catalogue parts, as instances.
2. **Wire places.** See candidate ports on each side (`bundle.candidates`), drag or pick to link, with the reason when a link is illegal and the nearest legal alternative.
3. **Inspect.** Choose any view; every view shows the same live composition; the flattened net is one click away.
4. **Run.** Run a scenario on the composed net and see the result in the same results pane as any analysis, with provenance.
5. **Edit with confidence.** Undo/redo for add/remove instance and link; no state is lost on reload.
6. **Get told when it is wrong.** Validity is continuous (`bundle.validate`/`verdicts`): an unlinked required port, a leak, a type mismatch appear as a per-item badge with a fix suggestion, not as a failed action.
7. **Keep and share it.** Save the composition (instances by CID, links, version); link to it and to a view of it (section 14); open the flattened net in the editor and save that as a net.

### 15.4 The agent's role

"Connect my queue to this payment net" is a build-intent request over a composition:

1. The model identifies the two sides (the open net's place named like a queue, the payment net the user opened or named) and calls `bundle.candidates` for the ports.
2. It proposes a link set as a **pending composition diff** with the same Apply/Discard as net edits, each link with the engine's verdict and reason; the model does not decide legality, `bundle.add_link` does.
3. Ambiguity (two places that could be the queue) is the structured `ask_user` card of 4.4.
4. After Apply, it can run the composed net (`bundle.run`) and open the result with provenance and a link.
5. "Undo that" is the undo stack from 15.3, not a prompt.

This needs the `bundle.*` commands added to the model's `run_command` surface and to the browser manifest (about 8 commands), plus a composition-diff renderer. The agent adds speed to wiring, never the rules.

### 15.5 Persistence and linking for compositions

A **composition document** (`@type: Composition`):

```json
{"@type": "Composition",
 "instances": [{"id": "orders", "net": "zb2...|catalog:orders"}, {"id": "pay", "net": "zb2..."}],
 "links": [{"kind": "...", "from": "orders.queue", "to": "pay.in"}],
 "parents": []}
```

- Saved through `/api/save` and sealed like a net, so it has a CID and lineage.
- Its flattened net (`bundle.flatten`) is deterministic from the document, so the flattened CID is derivable and need not be stored; "Open composed net" materialises it into the editor.
- A link to a composition view is a ViewSpec (14.1) with `net` pointing at the Composition CID, `view` such as `cospan`, and `calls` including the `bundle.open` / `bundle.add_link` replay (read-only on a sandbox) that reconstructs the state. The page's existing `#view=...&ex=...` hash is kept and extended to `#comp=<cid>&view=<id>`.
- Edit-after-link semantics are those of 14.5: the composition CID is immutable, edits fork.

### 15.6 Concrete steps (shippable)

| Step | Change | Done when |
|---|---|---|
| **C1** Composition as a document | Define `Composition`; `Save` / `Open` on the compose page via `/api/save` and `/o/{cid}`; `#comp=<cid>`; restore on load; add the `Composition` terms to both CID contexts and the schema in lockstep with parity fixtures | Reload keeps your links; two people opening the link see the same composition; `make test-parity` includes a Composition fixture |
| **C2** Your nets as instances | "Add net" picks from My Diagrams, the open editor net, or a CID; instances come from the net, not only the catalogue | A saved net of yours and the Orders example can be composed |
| **C3** Undo/redo and validity | A history of composition edits (command log, replay from the start); undo/redo keys; per-link and per-port verdict badges from `bundle.verdicts`; the refusal reason shown on the item, with the nearest legal candidate | A mistaken link is one undo; an illegal drop explains itself |
| **C4** Close the loop with the editor | "Open composed net" (flatten into the editor as a new net with `parents`), "Run scenario" into the Ask results pane with provenance, and the Ask goals work on the composed net | Compose, open, ask "can it get stuck?", save, link |
| **C5** Agent wiring | `bundle.*` in the manifest; pending composition diff with Apply/Discard; eval cases ("connect my queue to this payment net") | The example request wires a legal link set, or asks one question, and never an illegal link |
| **C6** Cleanup | Fixed examples move to a Gallery; Components dialog removed once C5 covers "add a part"; compose page linked from View → Compose | One composition surface |

Order against the main plan: C1 after L1 (it needs the view-spec machinery); C2 to C4 can proceed while Steps 3 to 5 land; C5 needs Step 2's goal/`run_command` path.

### 15.7 Open questions for Matt

1. Should the compose page and the editor be one page with a "Compose" view, or stay two pages joined by "Open composed net"? Recommended: stay two until C4 works, then decide on evidence.
2. Is a composition an object users name and keep (like a net), or a transient step towards a flattened net? Recommended: keep (C1), because a composition is the more reusable thing.
3. Which views stay in the first usable release? Recommended: cospan (wiring), flat (the result), laws (checks), and process; leave the rest under "More views" until a goal uses them.
