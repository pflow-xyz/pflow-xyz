# Guided modelling, slice 1: describe it, get a draft net

Status: design, not implemented. Date: 2026-10-15.
Parent: [ROADMAP.md](../../ROADMAP.md), "Guided modelling and simulation in the
browser". This document follows that section's **Decided** and **LLM access**
paragraphs.

## What this slice delivers

1. **A narrow Gemini proxy on the pflow.xyz Go webserver.** The server holds
   the key. Only users signed in with the existing GitHub login can call it.
   Each user has rate limits, and there is a global cap on top.
2. **A "describe it, get a draft net" flow in the editor.** The user describes
   a process in words. Gemini returns a draft. The browser checks the draft,
   turns it into the editor's own JSON-LD, lays it out and loads it onto the
   canvas, where the user can see, read and edit it.

The result is a Petri net on the canvas, not an answer. The flow ends with the
design in front of the user, each place and transition labelled with what it
stands for and a list of the assumptions behind the draft. Simulation, the
model check, ranking the parameters and plain-language results come in later
slices.

**Out of scope here:** multi-turn refinement ("add a second barista"), token
colours, analysis help, sharing with sim, and storing prompts.

## What the survey found (and what it changes)

### The editor's model format

`public/petri-view.js` holds a JSON-LD object:

```json
{
  "@context": "https://pflow.xyz/schema", "@type": "PetriNet", "@version": "1.1",
  "name": "...", "description": "...",
  "token": ["https://pflow.xyz/tokens/black"],
  "places":      { "<id>": {"@type": "Place", "label": "...", "initial": [n], "capacity": [n|null], "x": 0, "y": 0, "offset": 0} },
  "transitions": { "<id>": {"@type": "Transition", "label": "...", "x": 0, "y": 0} },
  "arcs": [ {"@type": "Arrow", "source": "<id>", "target": "<id>", "weight": [w], "inhibitTransition": false} ]
}
```

Places and transitions are maps keyed by id. Marking, capacity and weight are
per-colour vectors. A capacity of `null` or `0` means unbounded.

**There is no rate field.** Rates live only in the Analysis dialog's
session state (`this._analysisState.rates`, default 1.0 per transition) and
are lost on reload. The schema (`public/schema`) has no `rate` term either.

### The editor has no strict validator

The only gates today are:

- `_basicJsonLdValidation()`, which checks that `@context`, `@type`, `@id`
  or `@graph` is present.
- `_normalizeModel()`, which **coerces** rather than rejects. It fills
  defaults, turns bad numbers into 0, maps capacity 0 to unbounded, and
  quietly clamps an initial marking that exceeds its capacity.
- The server's `validateJSONLD()` on `/api/save`, which checks `@context`,
  nesting depth and control characters in keys.

The brief says "generated JSON-LD must pass the editor's own
schema/validation before loading". As things stand, that test would accept
almost anything and repair the rest without saying so. **This slice adds the
missing validator** (see [Validation](#output-validation-the-load-gate)). It
does not count normalisation as validation.

### Auth today

- The OAuth scope is `read:user,user:email,gist`. The callback puts the
  GitHub access token in the URL fragment. The editor stores it in
  `localStorage['pflow_auth_token']` and sends it as
  `Authorization: Bearer <token>`.
- `internal/auth.ExtractUserFromToken` checks the token against
  `api.github.com/user` **on every request**. It uses `http.DefaultClient`,
  which has no timeout, and caches nothing.
- `handleCORS` echoes back any `Origin`, with credentials allowed.

### How sim calls Gemini (the reference)

These are in `~/Workspace/sim-pflow-xyz`:

- `internal/llm/vertex_gemini.go` calls Vertex AI `:generateContent` over
  plain REST (no SDK). It sends `systemInstruction`, `contents` and
  `generationConfig{temperature, maxOutputTokens, responseMimeType:
  "application/json"}`. The default model is `gemini-2.5-flash`. Auth is GCP
  ADC or the metadata server, **not an API key**.
- `pkg/builder/llm.go` is the prompt worth reusing. Its discipline:
  - The system prompt is a fixed constant. User text travels only as
    user-role messages, so nothing the user types can rewrite the
    instructions.
  - The LLM can only act through a **closed vocabulary**.
  - The output contract is strict JSON.
  - `parseTurn` never fails: malformed output becomes a plain reply, because
    a crash on model output would hand the model a denial-of-service lever.
  - It runs at temperature 0.2 with 4096 max tokens.
  - The calibration rules (hold a resource across two firings, make pickup
    arcs non-kinetic, give queues a patience sink) are specific to sim's
    staffing questions.
- `pkg/modelstore.Validate` returns **every** structural error at once rather
  than stopping at the first. It checks: name, at least one place and one
  transition, unique ids, no id used as both a place and a transition,
  non-negative markings and rates, a place cap (500), and per-place and
  total token caps.
- `generator.ExtractModelJSON` finds the JSON in replies wrapped in prose or
  code fences.
- `cmd/sim-server/builder.go` `passQuota` enforces a daily per-user LLM quota
  (`SIM_LLM_DAILY_LIMIT`, default 50). It returns **429 with a `reset`
  time** and **fails closed with 503** if the quota store errors.
  `internal/ratelimit` is a token bucket backed by Firestore.

**Reuse ideas, not code.** sim is a private repo, `internal/llm` cannot be
imported from outside it, and its transport is tied to GCP. pflow.dev is an
EC2 box with no metadata server. The Gemini client we need is about 120 lines
of REST, so it is cheaper to write it than to depend on sim.

## Architecture

```
browser (petri-view.js)                        pflow.xyz webserver                      Google
──────────────────────────                     ───────────────────                      ──────
Describe dialog ── POST /api/llm/draft ──────▶ verify GitHub token (cached)
  {description}     Authorization: Bearer gh   rate limit (bucket, daily, global)
                                               fixed system prompt + user text ───────▶ Gemini API
                                               parse JSON, check size/shape   ◀──────── generateContent
              ◀──── {draft, usage, quota} ──── append usage log
petri-draft.js (dynamic import):
  validateDraft → draftToNet → validateNet
  → engine smoke checks → load + layout
Draft notes panel (assumptions, legend)
```

The server owns the **prompt**, the **key** and the **quota**. The browser
owns the **meaning**: validation, conversion to JSON-LD, layout and loading.
This matches "mostly client-side" in the roadmap. The rules that decide
whether a net is legal belong with the JS engines, which are already
byte-exact with go-pflow.

### Why the endpoint is task-shaped, not a raw passthrough

A generic `POST /api/gemini` that forwards any prompt would make the key a
free general-purpose LLM for anyone with a GitHub account. The proxy exposes
one task, "draft a net from this description", and keeps the system prompt
on the server. It is still thin: about 150 lines of handler and no model
semantics. A user can still ask the model something off-topic, but the
answer has to fit the draft response schema, and a non-net comes back as a
validation failure, not as free text.

## Proxy API

All routes are under `/api/llm/`. JSON in, JSON out.

### `GET /api/llm/status`

No auth needed. The UI calls it to decide whether to show the entry point.

```json
{ "enabled": true, "signed_in": true, "model": "gemini-3.8-flash",
  "remaining_today": 27, "daily_limit": 30, "reset": "2026-10-16T00:00:00Z" }
```

- `enabled` is false when no key is configured. The menu item is then hidden,
  and every other consumer of `petri-view.js` sees it this way (see
  [Vendoring](#vendoring-trap-bitwrap-io)).
- With no or an invalid `Authorization` header, the quota fields are omitted
  and `signed_in` is false. This endpoint does not count against the quota.

### `POST /api/llm/draft`

The request:

```json
{ "description": "A coffee shop with two baristas. Customers arrive, queue, order, and leave once served or after waiting too long." }
```

The success response (200):

```json
{
  "draft": { ...see Draft schema... },
  "model": "gemini-3.8-flash",
  "usage": { "input_tokens": 812, "output_tokens": 1406 },
  "remaining_today": 26, "reset": "2026-10-16T00:00:00Z"
}
```

| Status | When | Body |
|---|---|---|
| 400 | Body is not JSON, `description` is missing or empty, or there are unknown fields | `{"error": "..."}` |
| 401 | No token, or GitHub rejects it | `{"error": "sign in with GitHub to use drafting"}` |
| 403 | An allowlist is set and the user is not on it | `{"error": "..."}` |
| 405 | Method is not POST | |
| 413 | Body over 16 KiB, or `description` over 2000 characters | `{"error": "...", "limit": 2000}` |
| 429 | Burst, daily or global limit hit, or a request from this user is already in flight | `{"error": "...", "retry_after_s": 14, "reset": "..."}` plus a `Retry-After` header |
| 502 | Gemini answered but the reply is not JSON, has no candidates, or exceeds the size cap | `{"error": "the model returned an unusable reply"}` (the raw reply is logged server-side, truncated, never echoed) |
| 503 | No key configured, the quota store failed (fail closed, as in sim), or GitHub verification is unreachable | `{"error": "..."}` |
| 504 | Gemini took longer than the 45 s upstream timeout | `{"error": "..."}` |

The draft is returned as **data**. The server checks only that it parses as
JSON and has the top-level keys the response schema requires. It does not
repair, reshape or interpret the draft.

**Upstream error bodies are never passed through.** Gemini errors can echo
request content. The server logs status, latency, user id and token counts,
and returns one of the fixed messages above.

## Auth and rate-limit design

### Auth

1. Read `Authorization: Bearer <token>` (the header `/api/save` already uses).
2. Verify it through **a verifier interface** around
   `auth.ExtractUserFromToken`. The interface lets tests stub it. Two changes
   to that path:
   - Give the GitHub calls an `http.Client` with a 5 s timeout. Today they
     use `DefaultClient`, which has no timeout and could hang a handler
     forever.
   - Add a **verified-token cache**: key `sha256(token)` (the raw token is
     never kept as a map key), value the `GitHubUserInfo`, TTL 10 minutes,
     at most 10k entries with LRU eviction. A failed verification is
     **not** cached, and the cache is never consulted to reject a token. A
     revoked token keeps working for at most 10 minutes, which is
     acceptable for a drafting endpoint. `/api/save` and `/auth/user` can
     adopt the cache too, but that is a separate change.
3. **The quota identity is the numeric GitHub id** (`GitHubUserInfo.ID`).
   Logins can be renamed; numeric ids cannot.
4. **Optional allowlist** `PFLOW_LLM_ALLOW`: a comma-separated list of GitHub
   logins, or unset meaning every signed-in user. This is a soft-launch
   lever, not the access model. The roadmap says any GitHub-authenticated
   user.
5. **CORS:** the `/api/llm/*` handlers do **not** call `handleCORS`. They
   answer same-origin only, and a cross-origin preflight gets no
   `Access-Control-Allow-Origin`. The token sits in pflow.xyz's
   `localStorage`, so a foreign origin can't read it anyway. Dropping CORS
   costs nothing and removes "is this callable from elsewhere" from the
   threat model.

### Rate limits

GitHub accounts are free to create, so per-user limits stop accidents and
casual abuse, not a determined user. **The global cap is the cost ceiling.**

| Limit | Default | Env | Purpose |
|---|---|---|---|
| Per-user burst bucket | burst 3, refill 1 per 20 s | `PFLOW_LLM_BURST`, `PFLOW_LLM_REFILL_S` | stops runaway clicking and scripts |
| Per-user in-flight | 1 | (fixed) | stops one user running parallel calls |
| Per-user daily | 30 per UTC day | `PFLOW_LLM_DAILY_LIMIT` | sim's pattern (sim uses 50) |
| Global daily | 500 per UTC day | `PFLOW_LLM_GLOBAL_DAILY_LIMIT` | caps spend whatever the user count |

- **A call is charged when it is sent upstream.** It is charged after auth
  and the request checks, so a 400 or 401 costs nothing. A 502 or 504 still
  costs a unit, because Gemini billed us.
- **The daily counters survive restarts.** Pushing `main` restarts this
  service, often several times a day, so in-memory daily counters would
  reset on every deploy. Every upstream call appends one line to
  `data/llm/usage-YYYY-MM.jsonl`:
  `{"t":"...","gh_id":"...","login":"...","in":812,"out":1406,"status":200,"ms":3120}`.
  On startup the current month's file is replayed to rebuild today's
  per-user and global counts. The burst bucket stays in memory, because
  losing it on restart is harmless.
- **The log doubles as the cost and audit record.** It is gitignored under
  `data/` and belongs in this project's decommissioning table next to
  `data/pflow.db`.
- **If the log can't be written, the call fails closed with 503.** An
  unrecorded call is a call the cap cannot see.
- This repo has no SQLite. The stack default is SQLite, but one append-only
  file per month is smaller than adding a driver for a counter. See
  [open decision 5](#open-decisions-for-matt).

## Key configuration

| Env | Required | Default | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | yes, or the feature is off | (none) | Gemini API (AI Studio) key |
| `PFLOW_LLM_MODEL` | no | `gemini-3.8-flash` | same default as sim |
| `PFLOW_LLM_DAILY_LIMIT` and the other limits above | no | see the table | a malformed value logs once at startup and uses the default, as in sim's `dailyLimit()` |
| `PFLOW_LLM_ALLOW` | no | unset (all users) | soft-launch allowlist |

- **Where the key lives.** It goes in the `~/services` environment on
  pflow.dev, next to `GITHUB_CLIENT_SECRET`, and is documented in the "This
  service" section of `CLAUDE.md`. It is never committed, never sent to the
  browser and never logged. At startup the server logs only
  `LLM drafting: enabled (model gemini-3.8-flash)` or `disabled (no
  GEMINI_API_KEY)`.
- **The endpoint** is
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`.
  The key goes in the **`x-goog-api-key` header**, not in a `?key=` query
  parameter, so it can't leak into access logs or error strings.
- **Why an API key rather than Vertex like sim.** pflow.dev has no GCP
  metadata server. Vertex would need a service-account JSON on the box and an
  OAuth token refresher. The roadmap says "holds the Gemini key". The
  Gemini API and Vertex take the same `generateContent` body, so switching
  later only changes the transport.
- **Unset key means the feature ships dark.** See [Rollout](#rollout).

## Prompt and output contract

### Shape: the model writes a draft; code writes the JSON-LD

**Gemini never writes JSON-LD, coordinates or `@context`.** It writes a
compact draft in a closed format, constrained when decoding by Gemini's
**`responseSchema`** (structured output) with `responseMimeType:
application/json`. Deterministic browser code then converts the draft into
the editor's format.

This applies the prime directive. The model is used where judgment is
needed: which states, events and resources the description implies. A
mechanism decides whether the result is a legal net. Coordinates and
JSON-LD boilerplate are where an LLM is least reliable and where code is
exact.

### Draft schema (v1)

```json
{
  "name": "Coffee shop",
  "summary": "Customers queue for two baristas; unserved customers walk out.",
  "places": [
    {"id": "queue", "label": "Waiting customers", "description": "Customers who have arrived and not been served", "initial": 0, "capacity": 0},
    {"id": "baristas_free", "label": "Free baristas", "description": "Baristas not currently making a drink", "initial": 2, "capacity": 0}
  ],
  "transitions": [
    {"id": "arrive", "label": "Customer arrives", "description": "...", "rate": 30},
    {"id": "start_order", "label": "Start order", "description": "...", "rate": 720}
  ],
  "arcs": [
    {"from": "arrive", "to": "queue", "weight": 1, "inhibitor": false}
  ],
  "assumptions": [
    "Rates are per hour; 30 customers arrive per hour at peak.",
    "Customers leave after about 10 minutes of waiting."
  ]
}
```

- `capacity: 0` means unbounded (the editor's convention).
- `rate` is per unit time, and the unit is stated in `assumptions`.
- Single colour only (`token: black`) in v1.
- The `responseSchema` marks every field required, so the decoder can't drop
  one. That leaves the validator to deal with values, not with missing keys.

### System prompt

The prompt lives server-side, embedded with `//go:embed` from
`cmd/webserver/prompts/draft-net-v1.md`. It is versioned by file name, and
the version is recorded in the usage log line. It is adapted from sim's
`pkg/builder` `systemPrompt`:

- **Role:** "You turn a plain-language description of a process into a first
  draft of a Petri net that a person will read and edit. Clarity of the
  design matters more than completeness."
- **Modelling rules:**
  - Places are states, buffers, resources or outcomes. Transitions are
    events or activities.
  - Arcs connect a place and a transition, never two of the same kind.
  - A resource that is busy for a while is taken by `start_X`, held in
    `in_X`, and returned by `finish_X`. This is sim's two-firing rule,
    kept because it is what makes contention visible on the canvas.
  - Outcomes the user would count (served, walked out, failed) get their own
    sink places.
  - Use an inhibitor only for "X cannot happen while Y holds".
- **Size discipline:** at most 30 places and 30 transitions, ideally under
  15 each. Prefer a smaller net the user can read.
- **Id rules:** `snake_case`, `[a-z][a-z0-9_]{0,39}`, unique across places
  and transitions. Labels are short, single-line and human-readable.
  Descriptions are one sentence.
- **Rates:** positive numbers in one time unit, stated in `assumptions`.
  Choose plausible values rather than asking. Every guess becomes an
  assumption the user can see.
- **Assumptions:** list every choice the description did not settle. This is
  the "say what was chosen and why" line from the roadmap.
- **Off-topic or empty input:** return the smallest honest draft and say in
  `assumptions` that the description did not describe a process. The model
  must not refuse in prose.

The user's description is sent **only** as the single user-role message,
following sim's injection discipline. Generation runs at temperature 0.2,
with `maxOutputTokens` 16384, a drafts `thinkingBudget` of 1024 (thinking tokens count against the cap in Gemini 3.x; a `MAX_TOKENS` reply is refused as unusable) and a 45 s timeout. Each request is single-turn.

The few-shot examples come from this repo's showcase nets, not from sim's
staffing catalogue, so the drafts look like the editor's own examples.

## Output validation: the load gate

New module **`public/petri-draft.js`**, with no DOM dependency so deno can
test it. It exports four pure functions, each returning
`{ok, errors: [...], warnings: [...]}` with **every** problem listed, as
sim's `Validate` does. Loading happens only if all four pass.

### 1. `validateDraft(draft)`: the draft contract

- **Closed key sets** at every level: an unknown key is an error, not
  ignored.
- **Types:**
  - `initial` and `weight` are integers.
  - `capacity` is an integer ≥ 0.
  - `rate` is finite, > 0 and ≤ 1e6.
  - `inhibitor` is a boolean.
  - Strings are strings.
- **Ids:**
  - Each id matches `^[a-z][a-z0-9_]{0,39}$`.
  - Ids are unique **across** places and transitions.
  - No id is `__proto__`, `constructor` or `prototype`, because places and
    transitions become object keys.
- **Bounds:**
  - 1 to 50 places and 1 to 50 transitions. The prompt asks for at most 30;
    the extra room is so a slightly long draft is still accepted.
  - At most 200 arcs.
  - `initial` ≤ 1000 per place, with the total also capped. Both caps follow
    sim's caps on places and tokens.
- **Labels** pass the editor's own `_validateLabel` rules: non-empty, ≤ 100
  characters, one line. The rule moves into the module so the label editor
  and this gate share one definition. Descriptions are ≤ 300 characters.
  `summary` is ≤ 500 characters. There are at most 12 `assumptions` of ≤ 300
  characters each.
- **Arcs:**
  - Every `from` and `to` is a declared id.
  - Each arc joins a place and a transition (bipartite).
  - `weight` ≥ 1.
  - No duplicate `(from, to)` pair.
  - `inhibitor: true` only on place→transition arcs.
- **Legal state** (the engine contract in CLAUDE.md, which go-pflow
  enforces): `initial ≤ capacity` wherever `capacity > 0`. Today
  `_normalizeModel` clamps this quietly. Here it is an error.
- **Warnings** (shown, not blocking):
  - A transition with no arcs.
  - A place no arc touches.
  - A net with no enabled transition at the initial marking (dead on
    arrival).

### 2. `draftToNet(draft)`: deterministic conversion

- Builds the editor format shown above:
  - `@context`, `@type: PetriNet`, `@version: "1.1"`, `token: [black]`.
  - `name`, and `description` set from `summary`.
  - Places with `label`, `description`, `initial: [n]`, `capacity: [n]`
    (with `0` mapped to `null`), `x`, `y` and `offset: 0`.
  - Transitions with `label` and `description`.
  - Arcs as `Arrow`, with `weight: [w]` and `inhibitTransition`.
- Coordinates start on a grid. The editor's Sugiyama layout then places
  them after loading (step 5).
- Insertion order follows the draft's array order, so the same draft always
  yields the same bytes and the same CID.
- **Rates are not written into the net.** See below.

### 3. `validateNet(model)`: the editor's own check

This is the strict validator the editor lacks, and the brief's "the editor's
own schema/validation". It checks:

- **Schema terms:** every key on the net, places, transitions and arcs is one
  the editor already writes, or a term in `public/schema`. The net-level
  `description` is in the context, and node-level `label` and `description`
  resolve through `@vocab` (schema.org), as `label` does today.
- **Structure:** maps keyed by id. Vectors are arrays of finite non-negative
  numbers whose lengths match `token`.
- **Normalisation is the identity:**
  `deepEqual(normalizeModel(structuredClone(m)), m)`. If `_normalizeModel`
  would change anything (a default, a clamp, a coercion), the net was not
  valid.
  - This needs `_normalizeModel`'s body moved into an exported pure
    `normalizeModel(m)` that the component calls. The behaviour is
    unchanged and covered by the existing tests.
  - This is the one refactor inside `petri-view.js`.

The same `validateNet` is then available to the other import paths (paste,
file open, `?data=`). Wiring it into those paths is a later slice.

### 4. Engine smoke checks

These prove the net works in the engines users will run next:

- `petri-sim.js` computes the enabled set at the initial marking without
  throwing.
- `petri-solver.js` `fromJSON`, `setState` and `setRates` accept the net
  with the draft's rates.
- `seal-cid.mjs` computes a CID, which proves the net canonicalises and so
  `/api/save` will accept it.

### 5. Load

Loading reuses `setModel()`, which normalises (now a no-op), renders, refits,
syncs the LD and **pushes history**, so **Undo restores the previous net**.
Then it calls `_applySugiyamaLayout()` (which pushes its own history entry)
and `_refit()`.

If the canvas was not empty, the dialog says before Generate:
"This replaces the current net. Undo brings it back." Download is offered
next to that message. There is **no `confirm()`**, because a modal blocks the
page.

### Where rates go

The editor format has no rate field. In slice 1 the draft's rates are put
**into `this._analysisState.rates`**, so opening Analysis shows Gemini's
rates, marked "from the draft". They are also listed in the notes panel. They
are lost on reload, as rates are today. Making rates part of the model is
[open decision 1](#open-decisions-for-matt).

### When validation fails

The dialog shows:

- The validator's errors, each with its path (e.g. `arcs[4].to: "barista"
  is not a declared place or transition`).
- A "Show raw reply" disclosure.
- Two buttons:
  - **Try again**: the same description, at one quota unit.
  - **Edit description**.

There is no automatic repair loop in slice 1. Each retry costs a unit, so
the user decides when to spend it. A repair turn that feeds the errors back,
as sim's builder does, belongs in the refinement slice.

Wording follows the standing rule: the validator's verdicts are labelled
"Check", and the summary and assumptions are labelled "Gemini's draft
notes". **No LLM output is presented as an engine result.**

## UI entry point

- **Menu item:** "✨ Describe a process…" in the hamburger menu, placed above
  "🧮 Analysis". It appears only when `/api/llm/status` reports
  `enabled: true`. The status call runs once when the menu is built, with
  the result cached for the session.
- **Empty-canvas prompt:** when the model has no places and no transitions,
  a small overlay button reads "Describe a process in words → get a draft
  net". The newcomer the roadmap describes arrives at an empty canvas, so
  this is the main entry point. The menu item is the one for people who
  already use the editor.
- **Signed out:** the dialog opens, explains that drafting needs a GitHub
  sign-in (to apply a fair-use limit), and shows the existing "🔑 Login with
  GitHub" button. It keeps the typed description in `sessionStorage` through
  the OAuth round trip. The redirect reloads the page, which would otherwise
  lose the text.
- **The dialog** reuses the `pv-dialog` styles that Analysis uses. It has:
  - a textarea with a character counter (2000 maximum);
  - three clickable example descriptions (a coffee shop, an order pipeline,
    an SIR epidemic);
  - "N drafts left today";
  - **Generate**, and **Cancel**, which aborts the fetch through an
    `AbortController`;
  - a progress state that says what is happening ("Asking Gemini…" then
    "Checking the draft…").
- **After loading**, the dialog collapses into a **Draft notes** side panel,
  dismissible and reopenable from the menu while the session lasts. It shows:
  - the summary;
  - the assumptions;
  - a legend listing each place and transition with its description.
    Clicking an entry selects and centres that node on the canvas, which is
    how a newcomer learns to read the net;
  - the rates handed to Analysis;
  - a **Regenerate** button, which makes a sibling draft from the same
    description and costs one unit.
- **Lazy loading:** `petri-draft.js` is loaded with a dynamic `import()` only
  when the dialog opens, the way `petri-solver.js` is loaded for Analysis.
- **Coexistence with Analysis** (the roadmap's open question): slice 1
  leaves Analysis unchanged and only seeds its rates. Deciding how the two
  coexist belongs to the slice that adds guided simulation.

### Vendoring trap: bitwrap-io

bitwrap-io vendors `petri-view.js` but has no `/api/llm/*` endpoint and no
copy of `petri-draft.js`. Three rules keep a future `make sync-pflow-js`
from breaking it:

- Only a dynamic import loads the new module, and only after the menu item
  is clicked.
- The menu item only appears when `/api/llm/status` answers
  `enabled: true`. On bitwrap that call returns a 404, which counts as
  disabled.
- `petri-draft.js` is **not** added to `//public:browser_modules`. The same
  goes for `petri-ssa.js`, because that list lines up position by position
  with bitwrap-io's vendored list.

After this slice lands, the bitwrap-io and stackedup-gg locks show stale in
`status`, as after any `petri-view.js` change. Nothing fails.

## Files this slice touches

| File | Change |
|---|---|
| `internal/llm/gemini.go` (new) | Gemini API REST client: request and response types, `responseSchema`, header auth, timeout, no SDK. Modelled on sim's `vertex_gemini.go` |
| `internal/llm/limits.go` (new) | burst bucket, in-flight guard, daily and global counters, jsonl usage log and replay |
| `internal/auth/auth.go` | verifier interface, client with timeout, verified-token cache |
| `cmd/webserver/llm.go` (new) | `/api/llm/status` and `/api/llm/draft` handlers; routes registered in `ServeHTTP` |
| `cmd/webserver/prompts/draft-net-v1.md` (new) | system prompt and few-shot examples (embedded) |
| `cmd/webserver/main.go` | build the LLM deps from env in `main()`, routes |
| `public/petri-draft.js` (new) | `validateDraft`, `draftToNet`, `validateNet`, `normalizeModel`, smoke checks |
| `public/petri-view.js` | menu item, empty-canvas prompt, dialog, notes panel; `_normalizeModel` delegates to `normalizeModel` |
| `public/petri-view.css` | dialog and notes panel styles |
| `public/files.bzl`, `BUILD.bazel` files | regenerate with `make bazel-gazelle` and the `PUBLIC_FILES` list |
| `CLAUDE.md` | API endpoints, env vars, decommissioning row for `data/llm/` |

## Test plan

There are no live Gemini calls in `make test` or CI.

### Go (`make test`, `bazel test //...`)

- **`internal/llm` client**, tested against an `httptest` server:
  - The key is sent in `x-goog-api-key` and is **absent from the URL**.
  - `systemInstruction` is the embedded prompt, byte for byte.
  - The user text appears only in `contents[0]`, with role `user`.
  - `generationConfig` carries `responseSchema`, temperature 0.2 and
    `maxOutputTokens` 4096.
  - No candidates, non-JSON and oversize replies all map to the 502 error.
  - The 45 s timeout gives a 504.
  - An upstream error body is never part of the returned error string.
- **Limits:**
  - The burst bucket refills on schedule (with an injectable clock).
  - A second concurrent call from one user gets 429.
  - The daily and global limits are enforced, and reset at the UTC day
    boundary.
  - **Replay:** write a usage log, rebuild the counters from it and check
    the counts. This test is the deploy-restart case.
  - An unwritable log fails closed with 503.
  - A malformed limit env value falls back to the default.
- **Handlers**, with a stub verifier and a stub Gemini client:
  - 401 with no token and with a bad token, and no Gemini call made.
  - 503 with the key unset; `status` reports `enabled: false`.
  - 400 for empty or unknown fields, and 413 for oversize, with no charge.
  - 403 for a user missing from the allowlist.
  - 429 includes a `Retry-After` header and a `reset` field.
  - A cross-origin request gets no `Access-Control-Allow-Origin`.
  - 405 for GET on `/draft`.
  - The quota fields on `status`.
- **Token cache:**
  - A hit within the TTL makes no GitHub call.
  - An entry expires after the TTL.
  - A failed verification is not cached.
  - Keys are hashes: the raw token appears nowhere in the cache.

### JS (`make test-js`, deno)

`public/petri-draft_test.ts` covers:

- **`validateDraft`:**
  - A known-good draft for each example description passes.
  - **One negative fixture per rule.** An unknown key, a duplicate id, an id
    used for both a place and a transition, a place-to-place arc, a dangling
    reference, initial above capacity, a negative or NaN rate, a multi-line
    label and a `__proto__` id each produce exactly their own error.
  - A fixture with several faults reports all of them.
- **`draftToNet`:**
  - Golden output: the draft gives fixed JSON-LD bytes, through
    `_stableStringify`'s key order.
  - The same draft always gives the same CID (via `seal-cid.mjs`).
- **`validateNet`:**
  - Every net in `examples/` passes, so the new validator doesn't reject
    nets the editor already saves. If an existing example fails, that is a
    finding to report, not something to suppress.
  - Normalisation is the identity on converted drafts.
  - A net that normalisation would clamp is rejected.
- **Smoke checks** run across the draft fixtures.
- **Recorded replies:** `testdata/llm/*.json` holds raw Gemini responses,
  captured once with the real key, for about eight descriptions. They are
  replayed through the whole pipeline offline. This is the regression net
  for prompt changes.

### Cross-language (`make test-parity-behavior`)

- The draft fixtures, once converted, go through go-pflow's validation and
  reachability loading in a Go test. go-pflow is already a dependency. The
  test asserts that go-pflow accepts exactly the nets `validateNet` accepts,
  for the legal-state rules (capacity, inhibitors, weights). This keeps the
  JS gate from drifting from the engine contract in CLAUDE.md.

### Prompt quality (opt-in, live)

`make llm-eval GEMINI_API_KEY=…` runs about 20 descriptions against the live
model. It reports the share that pass the validator first time, the median
net size, and the warnings. It is **not** part of `make test`. Run it when
`draft-net-v*.md` changes and record the number in the prompt file's header.

### Browser

- Run locally (`make run-dev` with a key set), through claude-in-chrome
  against a real signed-in Chrome, per the workspace guide.
- Check:
  - the empty-canvas prompt;
  - the signed-out sign-in round trip keeps the description;
  - generate, then the notes panel, then Undo restores the previous net;
  - the 429 message;
  - the rates handed to Analysis;
  - the menu item is hidden with no key set.

## Rollout

- **Pushing `main` deploys**, so the slice ships **dark**. With no
  `GEMINI_API_KEY` in `~/services` on pflow.dev, `status` answers
  `enabled: false`, the menu item and empty-canvas prompt never appear, and
  `/api/llm/draft` returns 503.
- Matt turns it on by adding the key (and `PFLOW_LLM_ALLOW` for a soft
  launch) and running `~/services restart pflow-xyz`.
- Turning it off is the reverse.
- Before enabling, set a **budget alert** on the Google project that owns
  the key. The global daily cap limits how many calls are made, not what
  Google bills.

## Open decisions for Matt

1. **Rates in the model.** The editor format has no rate. Slice 1 hands the
   draft's rates to the Analysis dialog for the session only.
   - Option: add a `rate` term to the schema. This changes the CID contract
     and has to land in lockstep across `seal.go`, `seal-cid.mjs`,
     `public/schema` and the parity goldens.
   - Recommendation: defer it to the guided-simulation slice, which is where
     rates start to matter.
2. **Which Google project and key.** A dedicated Gemini API key for pflow.xyz
   with its own budget alert, or a key under sim's GCP project? A dedicated
   key is recommended, so pflow.xyz costs are visible separately.
3. **Default limits.**
   - Proposed: 30 per user per day, burst 3, and **500 per day globally**.
     sim uses 50 per user per day.
   - Is 500 drafts a day the right global ceiling for the spend you're
     willing to carry? At flash pricing a draft costs a fraction of a cent,
     so this is mainly a guard against abuse.
4. **Launch audience.** Open to every GitHub user from day one, as the
   roadmap says, or behind `PFLOW_LLM_ALLOW` (you first) for a week of
   `llm-eval` and real use?
5. **Usage persistence.** Monthly append-only `data/llm/usage-*.jsonl`
   (proposed), or bring SQLite into this repo, which the stack prefers? The
   log adds no dependency, and replaying one month at startup is cheap at
   these volumes.
6. **Provenance in saved nets.** Should a saved draft record that Gemini
   produced it, for example a `generatedBy` note or a prompt CID?
   - Proposed: **no** for slice 1. It would add a schema term, which touches
     the CID contract, and storing prompts raises privacy questions. The
     notes panel is per session and is not saved.
7. **Staying on Gemini.** The roadmap fixes Gemini, which this design
   follows. Should the client keep a provider seam the way sim's `llm.Client`
   does? This design keeps the interface (`Complete(ctx, Request)`) so
   adding a provider later stays cheap, but builds only the Gemini client.
