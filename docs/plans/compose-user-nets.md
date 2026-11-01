# Cospans of your own nets on the composition page

Status: **scoping only. Nothing here is built.** Date: 2026-11-01.
Parent: [docs/design/models-first.md](../design/models-first.md), slices 3-5;
[docs/model-identity.md](../model-identity.md); [docs/account-files.md](../account-files.md).

**Goal.** On `compose.html` (Composition views, Cospans first) a person sees the cospan of a
net they built, not only the Queue, ResourcePool and Saga instances from the pattern catalog.

**How cites work.** Unprefixed paths are pflow-xyz at `origin/main` 78ac051. `native:` is
pflow-native at d0f4a47, the build the page pins. `compose/` abbreviates `public/compose/`.

**What was run.** Results marked *probe* came from driving the pinned wasm under deno on
2026-11-01, through `parity/composition-views/render.js`. The scripts are not committed; Stage 0
turns them into tests. A view that "renders" in a probe did not throw in the headless DOM. Nobody
has looked at these drawings in a browser, so nothing here says the geometry is good.

## Summary

- **The engine is most of the way there.** `bundle.load` with inline subnets and declared ports
  gives real validation, candidates, links, pushouts, runs and export (*probe*, section 3).
- **The page is not.** Any model with no pattern throws in eight of the ten views, and the stage
  shows `render failed:` with a stack. Lens and Laws are the exceptions.
- **One engine gap blocks the feature as specified.** A place port on a net loaded *by reference*
  is refused with `E_PORT_NOT_EXPORTED`. The editor's format has no `exported` flag, so no editor
  net can have a place port today. A cospan's feet are place ports, so this one matters most.
- **Ports live on the composition, never in the net.** The net keeps its CID, as the identity
  rule requires. The wrapper carrying ports gets its own CID.
- **The first useful thing to ship** is the closed net: `∅ → S ← ∅` for any `?cid=` or canvas
  net. It needs no engine change.

## Decisions taken here

Each is the recommendation this plan is written against. Overrule any of them and the stage it
names changes.

| # | Decision | Why | Stage |
|---|---|---|---|
| 1 | The page never converts editor JSON to the metamodel shape. It `store.put`s the net into the engine and names it by `cid`. | Two converters would disagree. The engine already compiles it, colours included. | 2 |
| 2 | `state.example` stays `orders` for any open composition. A new, separate `state.source` says where it came from. | About 28 sites branch on `example` (`models-first.md`'s count at 57f6caf); their meaning ("a composition, not a plan") still holds. | 2 |
| 3 | A place port on a by-reference part exports the place it names. This is resolved at load, in pflow-native and in Go. | It is the only option that keeps the net's CID (section 2.2). | 4 |
| 4 | Port declaration starts as a form panel, not a canvas gesture. | It works in all ten views, by keyboard and on a phone, on day one. | 5 |
| 5 | A portless net is drawn as `∅ → S ← ∅`, as a statement and not a warning. Ports are never inferred on load. | An interface is the author's claim. | 2 |
| 6 | Ontology facts stay a pinned build-time snapshot; only links go live. | Section 6.3. | O4, O5 |
| 7 | Citations move to versioned public IRIs, and the private repo stays private (Matt, 2026-11-01). | Section 6.4. | O6 |
| 8 | Drop the vendored `.wasm.br` and `.wasm.gz`; keep the small text files. | Matt, 2026-11-01: "we can drop the vendored copy". Section 3.4. | V |

**Decided (Matt, 2026-11-01):** `ontology-pflow-xyz` stays private for now (6.4). `models-first.md` is still marked
as a proposal; this plan uses only its slices 3-5, and none of its URL or navigation changes.

---

## 1. Import

### 1.1 What the view needs and what the editor produces

The views read `bundle.state` through `subnetOf` (`compose/model.js:105`).

| The view reads | Editor JSON-LD ("Shape A") has | Who bridges it |
|---|---|---|
| `places: [{id, initial, capacity, exported, description}]` | `places: {id: {label, x, y, initial: [n], capacity: [n]}}` | engine compile (`native:crates/core/src/composition/document.rs:856`) |
| `arcs: [{from, to, weight, type}]` | `arcs: [{source, target, weight: [n], inhibitTransition}]` | engine compile |
| several token colours | `token: [...]`, vector weights | engine compile unfolds them: `CoffeeBeans` becomes `CoffeeBeans.brown` (*probe*) |
| `ports: [{id, kind, target, place, transition, schema}]` | nothing | **the author, in the composition document** (section 2) |
| `net_type` | nothing | **the author, optional** (2.4) |
| `exported` | nothing | **missing: stage 4** |
| node positions (`NO_LAYOUT`) | `x`, `y` | **dropped by compile; the page keeps them beside the part** (1.4) |
| `pattern`, `params`, `why`, `steps`, `accounts` | nothing | stays empty; handled in section 4 |

Shape A cannot go inline. `{"model": <Shape A>}` is refused with
`[BUNDLE_PARSE] invalid type: sequence, expected i64` (*probe*). By reference works:

```js
engine.call('store.put', { document: net });          // -> {cid}
engine.call('bundle.load', { document: {
  '@context': 'https://pflow.xyz/schema', '@type': 'PetriNetBundle',
  subnets: [{ '@type': 'PetriNet', id: 'mine', cid }],
}});
```

This wrapper is a bare one, so `bundle.load` reports `reduced: true` and `model_cid` equal to the
net's own CID (*probe*): the rule in `docs/model-identity.md` holds with no new code. `store.put` is
in the wasm and held in memory. It is not exposed to the editor (`scripts/sync-native-wasm.mjs`), but
the page's engines can call it, as they already call `bundle.*`.

### 1.2 Sources

The picker is a third button beside the two examples (`#ex-orders`, `#ex-connect4`), "My model". It
lists these sources in this order.

| Source | How it reaches the page | Sign-in | Link it leaves | Stage |
|---|---|---|---|---|
| **A stored net or composition** (`?cid=`) | `compose/identity.js` already fetches it (`fetchModel`). A composition's by-reference parts are fetched from `/o/<cid>` and `store.put` first. | no | `?cid=`, already kept in every link | 2 |
| **Pasted JSON** | A text box. Takes a net or a `PetriNetBundle`, which also covers bundles from `/mcp` (`pflow_bundle_*`) or any outside chat. | no | none until saved; the page says so | 2 |
| **The editor's canvas** | Menu item (`public/petri-view.js:7932`) | no | `#handoff=<nonce>`, this browser only | 3 |
| **The chat session** | The Assistant's Apply lands in the editor as one undo step, so its net *is* the canvas. Add an "Open in Composition Views" button to the chat panel, using the same handoff. No new tool. | as the chat | as the canvas | 3 |
| **Account files** | `file.list`, `file.get` against `/api/files`, with the token at `localStorage.pflow_auth_token` (`public/petri-view.js:254`), same origin | yes | `#file=<name>`, opens for the owner only, and the page says so | 6 |

Details that shape the work:

- **The canvas handoff is one-shot.** The menu opens with `noopener`, so the new tab has its own
  `sessionStorage` and no `opener`. The editor writes the net to
  `localStorage['pflow_compose_handoff:<nonce>']`. The page reads and deletes it, then keeps its own
  copy in `sessionStorage` so a reload still works.
- **The page shows a snapshot, not a live view.** It says "a copy of your canvas as of 14:02", with
  the CID. Live sync is out of scope: it would make a drawn cospan change under a pinned inspector.
- **`file.open` refuses a bundle**, because the editor's check requires `@type` PetriNet. The
  account picker therefore reads the file and branches on `@type`, and `file.list`'s `kind` (`net`
  for any `.json`) cannot be used to filter.
- **The Assistant keeps out of account files.** They stay in `EXCLUDED` (`docs/account-files.md`).
  Proposing ports from chat is a later idea, and would be labelled judgment if it is built.
- **`/?route=explore`** (`public/petri-landing.js:16`) keeps opening the catalog. It carries no net.

### 1.3 Saving

| Action | Goes to | Visibility | Note |
|---|---|---|---|
| Save to my account | `file.write`, `<name>.json` | private | The envelope below. |
| Publish | `POST /api/save`, parts first, then the composition | **public** | An explicit button that says it is public. `/api/save` refuses unstored parts with `E_PART_MISSING`, so a private net cannot stay private here. |

A by-reference part in a private file has nowhere to resolve from, and Shape A cannot go inline. So
the account file is an unsealed envelope around the sealed document:

```json
{"@type": "ComposeWorkspace", "bundle": { "...": "the PetriNetBundle as written" },
 "parts": {"z4EB...": { "...": "the Shape A net" }}}
```

The loader `store.put`s each part and refuses the file if a returned CID differs from its key, then
loads `bundle`. `bundle`'s CID is the model's CID; the envelope has none. The native app can read
the same file from disk (section 5). The account limit of 1 MiB per file applies.

### 1.4 Layout

The document stores no positions, and `layoutFallback` (`compose/views/cospan.js:223-227`) is not
made for this. In the 200-wide default frame it fits two nodes per row, starting at y=300, in a
frame 400 high, so a net of more than about six nodes runs out of the frame. Other views have their
own fallbacks (`gridHomes`, `compose/views/flat.js:416`), not yet looked at for this.

The page keeps each part's Shape A `x`, `y` beside it, and `localLayout` scales them into a frame
sized to the net. Unfolded colours share their base place's position with a small offset. Layout is
a view's own business and not a rule, so this does not break "nothing re-implements a rule in JS".
The parity manifest does not carry geometry. A pasted bundle with inline parts has no positions and
keeps a sized grid.

---

## 2. Port declaration

### 2.1 Where ports go

On the part, in the `PetriNetBundle`, beside `cid`:

```json
{"@type": "PetriNet", "id": "mine", "cid": "z4EB...",
 "ports": [{"id": "in",  "kind": "in",  "place": "a", "schema": "job"},
           {"id": "out", "kind": "out", "place": "b", "schema": "job"},
           {"id": "go",  "target": "transition", "transition": "go"}]}
```

The identity rule already covers this: "`ports` ... makes it a composition with its own CID", while
the part keeps its own. `bundle.export` returns the `cid` and the `ports` beside it unchanged
(*probe*). In a Baez–Master open net ([arXiv:1808.05415](https://arxiv.org/abs/1808.05415)) X and Y
are finite sets and the legs are functions into the places S. The page already draws that from
`kind` (`portSides`, `compose/views/cospan.js:126`):

| Declared | Set by | Drawn | In the cospan? |
|---|---|---|---|
| place, `in` | foot X | left column, a leg to the place | yes |
| place, `out` | foot Y | right column | yes |
| place, `inout` | both | both columns | yes |
| place, `observe` | neither | a dotted tap on the top edge | no: a side tap |
| transition | neither | bottom edge | no: an event port, composed by fusion (Bruni et al.), not by a pushout |

A leg need not be injective: two ports on one place validate and flatten (*probe*), which is what a
function into S allows. A place port with no `kind` also validates (*probe*), and `portSides` then
treats it as foot X by default. The panel should always write a `kind`, so that this default is
never what decides a foot.

### 2.2 The blocking gap, and the fix

*Probe, on the page's pinned wasm:*

```
place port, by reference  -> E_PORT_NOT_EXPORTED: port "in" of subnet "x" exposes place "a", which is not exported
transition port, by ref   -> valid; event link adds; flat transition fused:x/go+y/go
place port, inline, exported: true -> valid; pushout flattens to wire:alpha/b
```

`native:document.rs:856` compiles a stored net with every place `exported: false`, because Shape A has
no such field. Go's `internal/model/resolve.go:68` uses the same kind of converter
(`parser.ModelFromJSON`), so it should refuse the same way at `POST /api/save` (`E_FLATTEN`). That was
read, not run; Stage 0 pins it.

| Option | Net's CID | Cost | Verdict |
|---|---|---|---|
| **A. A port on a by-reference part exports its place, at load** | unchanged | a small change in `document.rs` and `resolve.go`, with a shared fixture | **Chosen.** Inside a composition, a declared port is exactly the claim `exported` makes. |
| B. Add `exported` to the editor's places | **changes**, as every key hashes | Editor, schema and `seal` contexts in lockstep | No. Changes a net to change its interface. |
| C. Convert Shape A to inline metamodel in JS | part loses its CID | A second converter | No. `docs/model-identity.md` already rejects this: it drops rates and more. |

Rule A applies only to by-reference parts. An inline part says what it says, and an unexported place
there is still an error.

### 2.3 The panel

"Boundary" sits in the side column, under Links. For each part there is a table of its places and
transitions as `bundle.state` lists them, so colours appear unfolded (`CoffeeBeans.brown`), grouped
under the base place. One editor place therefore gives one foot point per colour, and the panel says
why.

| Column | Control | Decided by |
|---|---|---|
| Place | name, initial marking | |
| Port | none, in, out, inout, observe | |
| Schema tag | text with suggestions: tags already in this composition, plus the catalog's (`queue:items`, `resource`, `account`, `saga:outcome`) | The registry, when a link is tried. Tags must agree when both are set; an empty tag agrees with anything, and the hint says so. |
| Transition | event port on or off | |
| Row verdict | the registry's code and message for that row | `bundle.validate` `element` |

Every change goes to the engine and re-reads `bundle.state`, so what is drawn is what the registry
holds. An unknown kind or duplicate id is refused or reported by the registry; the panel has no rules
of its own (`[BUNDLE_PARSE] unknown variant`, `E_DUPLICATE_PORT`, `E_PORT_UNKNOWN_ELEMENT`, all
*probe*).

**One bad port blocks every link.** `bundle.add_link` runs whole-document validation first: with a
broken port anywhere, each add is refused with that port's error (*probe*). The panel therefore shows
the document's errors before a link is attempted, or the drag's refusals will look unrelated.

**Canvas gesture, later.** In a "mark ports" mode, a click on a place in the Cospans view selects its
row. It is sugar over the panel, so it comes after it.

### 2.4 Net type

`net_type` decides which links are legal. A pushout needs token or data links.

| `net_type` | Token link | Note (*probe*) |
|---|---|---|
| unset | allowed | `W_UNTYPED_SUBNET`: "no link is rejected by typing" |
| `ResourceNet`, `GameNet` | allowed | |
| `WorkflowNet` | refused, `E_ILLEGAL_LINK` | Its places are cursors, not counters. |

The default is unset, because the page has no grounds for a claim. The warning is shown as it comes.
The selector is one optional field per part.

### 2.5 The closed net

A net with no ports is `∅ → S ← ∅`. The precedent is the Connect-4 drawing
(`compose/views/cospan.js:1133`, `:1158`).

- **Drawn:** the net in its frame, both foot columns showing `∅`, with a hover saying "no ports
  declared; every place is interior".
- **Said:** one line above it, level `honesty`, not `warn`: "A closed net: ∅ → S ← ∅. It has no
  boundary, so nothing can be glued to it. Mark ports to open it."
- **Two closed nets:** only `⊗`, a disjoint union, which is what the page says for no links now.
- **Not done:** no ports appear on load. `exported` is not a substitute either.
- **"Suggest ports" button, optional:** source places to `in`, sink places to `out`. It fills the
  form and saves nothing, labelled "Judgment: read off the arcs". It costs little and can wait.

---

## 3. Reuse: does `bundle.*` work on arbitrary subnets?

**Yes for what it decides. The gaps are one engine rule, two edit commands and the page.** All rows
are *probe*, on two hand-written subnets with no pattern.

### 3.1 Works as it stands

| Command | Result |
|---|---|
| `bundle.load` | Loads; returns validation, `flatten`, `cid`, `missing`. |
| `bundle.validate` | Reports `E_PORT_UNKNOWN_ELEMENT`, `E_DUPLICATE_PORT` per element. |
| `bundle.candidates` | Real verdicts: `E_PORT_DIRECTION`, `E_SCHEMA_MISMATCH`, `PAGE_SAME_SUBNET`. A transition drag offers guard and event. |
| `bundle.add_link` | Token and event add, with `passed` rule text and cites. |
| `bundle.flatten` | Pushout `wire:alpha/b` from `[alpha/b, beta/c]`, event `fused:…`. |
| `bundle.run {script}` | Runs across the wire and sums markings. |
| `bundle.export` | Keeps ports and links; the CID moves with the document. |
| `bundle.lens` | Says "no scenario "commit" is declared" rather than a false verdict. |
| `bundle.add_instance` on a raw load | **A user net can sit beside a catalog instance:** `mine` beside `workers`, event link to `workers:acquire`. |

### 3.2 Missing in the engine (pflow-native)

| # | Gap | Fix | Stage |
|---|---|---|---|
| E1 | By-reference place ports (2.2) | Option A | 4 |
| E2 | No command to add a user part: `bundle.add_instance` takes catalog ids only | `bundle.add_part {subnet}` | 4 |
| E3 | No command to change ports | `bundle.set_ports {subnet, ports, net_type?}` | 4 |
| E4 | A mixed composition loses its recipe: after export and reload, `workers` has `pattern: ""` (*probe*). `docs/model-identity.md` defines `pattern` and `params` beside `model`; the engine neither writes nor reads them. | Write and read them | 8 |

The web slice could reload the whole document on each edit and skip E2 and E3. Do not: native's
ground rule is "every action is a registry command", and E1 forces a republish anyway. All three
ship in one engine change.

**Disagreement to settle in Stage 0.** `/mcp` documents "a subnet that declares no ports has one per
exported place" (`cmd/webserver/mcp_model.go:75`), while `bundle.state` on the wasm returns `ports: []`
for that document (*probe*). `parity/native/mcp_goldens.json` holds these together for its cases, so
either no case covers this or the two differ. This plan assumes ports are never derived.

### 3.3 Missing on the page

| # | Gap | Where | Stage |
|---|---|---|---|
| P1 | No pattern throws: `PATTERNS[''].prefLabel` | `compose/info.js:12`, `:17`, `:149`; `views/cospan.js:594`, `operad.js:650`, `:1031`, `string.js:261`, `spiders.js:486`, `flat.js:633`, `incidence.js:250`, `:616`, `process.js:821`, `:1087`, `boundaries.js:380` | 1 |
| P2 | Scenarios are read once at load, for orders, then run against the open model: `no scenario "commit" is declared` | `model.js:43`, `:76`; `flat.js:1003`, `process.js:786` | 1 |
| P3 | The scratch engine can only hold catalog instances (`bundle.open`), and it must hold the user's parts too | `model.js:147-159`; used by `boundaries.js:217`, `:672`, `incidence.js:731` | 2 |
| P4 | The store and hash assume the catalog: `start()`, `openLinked()`, `inst=` | `state.js:73`, `:224-237`, `links.js` | 2 |
| P5 | Catalog text around a user's model: "Reset to the 3 idioms" (on a raw load `bundle.reset_links` **erases the user's links**, *probe*), "Second instance", `PARAMS_NOTE`, the cq/13 line | `app.js:99-103`, `:214`, `:241` | 1 |
| P6 | The composition is not saved across a reload (`SAVED_PARTS` omits it) | `petri-wasm.js:64`. The page's own engines save nothing, so the document goes in `sessionStorage`. | 2 |
| P7 | The model panel says the views keep the built-in example | `identity.js:10-12`, `:107`, `docs/model-identity.md` "Not done" | 2 |

With a stub entry for P1 and with P2 aside, eight of the ten views rendered on a two-part glued model
and on a closed 20-place net (*probe*: Cospans emitted `port: 6, subnet: 2, composite: 1`, and `link: 1`
once glued). P2 still blocks Flat and Processes. So the page work is guards and text more than new
drawing, though the drawings have not been looked at (1.4).

### 3.4 Delivering the engine, and dropping the vendored copy

The page already fetches the engine from `cdn.stackdump.com`, checks it against the pinned sha256,
and only then compiles it (`petri-wasm.js:104-123`). So every engine change in this plan ships as
`make wasm-publish` in pflow-native, then `scripts/sync-native-wasm.mjs --cdn` here.

Matt, 2026-11-01: "we can drop the vendored copy". It is its own PR, and this feature does not depend
on it in either direction. What it means in practice:

| In `public/vendor/pflow-native-wasm/` | Today | After |
|---|---|---|
| `.wasm.br`, `.wasm.gz` (3.5 MB) | Fallback and test bytes | **Deleted**, with the `cmd/webserver/wasm.go` route that serves them |
| `pflow_native_wasm.js` (glue, 20 KB) | Imported first, from this origin | **Kept.** Also on the CDN, but it is code that runs in the page. Only the `.wasm` is hash-checked today. Moving it needs its own check before `import`, for no gain. |
| `commands.js` (80 KB) | Imported by `petri-commands.js` | **Kept.** It is not on the CDN (404). |
| `cdn.js`, `pflow-native-wasm.lock` | The pin | **Kept.** |

Work that has to happen:

- **Tests.** 37 lines name the wasm file, including `parity/composition-views/render.js`, the Go
  parity tests and `public/petri-wasm_test.ts`. They need one helper that fetches the pinned build
  into a cache and checks the hash, so CI and an offline `make test` still work from the cache.
- **Build lists.** `public/files.bzl`, `BUILD.bazel`, `docs/compose-load-budget.md`,
  `parity/native/README.md`, the root `CLAUDE.md`.
- **Failure behaviour changes.** With no fallback, a CDN failure leaves the composition page on
  `renderFailure` after the fetch timeout (`CDN_TIMEOUT_MS`, 30 s), and that timeout should come down.
  The CDN and pflow.xyz resolve to the same address today (3.214.41.34), so this adds no new host,
  but it does add a separate vhost that has to be up. The editor's engine-backed commands fail the
  same way.

---

## 4. Inspector and ontology gaps

A user net has no pattern IRI, idioms or caveats. The inspector must not borrow them, and it must not
look empty either. What it shows instead comes from three places: the net, the registry, and the author.

| Thing | Today (catalog) | User net |
|---|---|---|
| **Title** | `orders: a Queue instance` | `mine: your net` |
| **Concept** | `pat:queue`, a `ns:NetPattern` | `ns:PetriNet`, which the served release has (6.1). No badge. |
| **Definition** | the ontology's words | The part's description if it has one, else none. Never generated. |
| **Facts** | constructor, parameters, labels | Net kind or "untyped"; places and transitions; ports; part CID, linked to `/?cid=`; where it came from ("copy of your canvas", "account file", "`?cid=`") |
| **Caveats** | `ns:caveat`, verbatim | Replaced by what the registry says now: `bundle.validate` warnings (`W_UNTYPED_SUBNET`) and `bundle.state` `missing`. Labelled as such, not as caveats. |
| **Cites** | source lines | none for the net. A link's rule text keeps its cites, since those rules are go-pflow's whatever the net. |
| **Port** | `ns:PatternPort`, pattern comment | `kind`, target, schema, with "declared by you" as the source. The panel's words, never "the ontology says". |
| **Link** | idiom if one matches | `linkInfo` already handles no idiom (`compose/info.js:80`): `lk:<kind>`, rule text, "drawn on this page; legality is go-pflow's". No change. |
| **Invariant** | pattern invariant | Declared constraints only, with "not proved here". `invariantInfo` already has a fallback; only its `p.invariants` read needs a guard. |
| **Model content** | findings, notes | `NO_CONTENT` is shown as it comes. Author notes via `content.load` are later and out of this scope. |

Two things to check when this is built, because a view could mislead rather than crash:

- **Laws.** It rendered 12 rewrites on a user model (*probe*). They are about the patterns' theories,
  not this net, and the view must say so or draw nothing.
- **Lens.** It shows no verdict with no `commit` scenario, which is right. A user who declares none
  sees only that sentence, which should say how to declare one, or that this is not offered yet.

P1's fix is one accessor, `patternOf(s)` in `model.js`, returning `null` for no pattern. Then
`subnetInfo` and `portInfo` take their two shapes from it, and the view sites take a plain label.
The `.insp-unserved` badge cannot appear for a user net except on a link kind (section 6.2).

---

## 5. Native parity, and the staged list

### 5.1 pflow-native (egui)

Native is ahead on tolerating a bare model: `native:crates/app/tests/loaded_documents.rs` draws all
ten views on `cafe.bundle.json` without panicking, and each says what it lacks. It uses safe lookups
(`cospan_view.rs:1324`). So the Stage 1 guards bring the web up to native, not the other way around.

| Topic | Web | Native | Same? |
|---|---|---|---|
| E1, E2, E3 | wasm | same crate | **One fix, both get it.** |
| Port panel | HTML form, Stage 5 | egui panel, Stage 7, calling the same `bundle.set_ports` | Same commands, its own widgets |
| Getting a net in | canvas handoff; account file | Current document: `store.put`, then `bundle.load {cid}`. The registry's menu has "Load Composition…". | Same commands |
| Saves | network, per account (`docs/account-files.md`) | a path on disk | **Same bytes:** the `ComposeWorkspace` envelope (1.3) needs a loader in `native:commands/bundle_doc.rs`, or the app unpacks it. Native reaching the account space needs the device-flow client already noted in `docs/account-files.md`. |
| Layout | Shape A `x`, `y` | `Document` keeps them | Each its own; not in the manifest |
| Inspector | section 4 | same words, own code; the contract does not hold prose | Text drift is possible and accepted, as today |

**Parity contract.** Add states to `native:docs/composition-views-scene.md`, reached by commands alone,
as the contract requires: `user-closed` (`bundle.load` of one part, no ports), `user-open` (two parts
with ports), `user-glued` (plus a token link). Regenerate with `make sync-composition-goldens`.
Update `FEATURES.md` Status in the same commit, as native's `CLAUDE.md` requires.

### 5.2 Stages

Sizes: **S** under a day, **M** 1-2 days, **L** 3-5 days, each including tests and review. Pushing
pflow-xyz `main` deploys (signed tip and green CI), and each stage below is safe to land alone: until
Stage 2 nothing reaches the new paths.

| # | Stage | Repo | Size | Needs | Done when |
|---|---|---|---|---|---|
| 0 | **Pin today's behaviour.** Commit the probes as failing or expected tests: every row of section 3. Settle the `/mcp` derived-ports question. Run the Go side of 2.2. | pflow-xyz | S | | Tests name each gap |
| 1 | **The page survives no pattern.** P1, P2, P5, minimal section 4 titles. | pflow-xyz | M | 0 | All ten views render `user-closed` and `user-open` headless; catalog goldens unchanged |
| 2 | **Open a model.** `?cid=` and paste; `state.source`; P3, P4, P6, P7; the closed-net presentation (2.5). **First user-visible result:** the cospan of any stored net, `∅ → S ← ∅`. | pflow-xyz | L | 1 | `scripts/views-smoke.ts` opens a stored net and a stored composition in Chrome |
| 3 | **Canvas and chat handoff.** Menu item, chat-panel button, one-shot key. | pflow-xyz | S | 2 | The editor's net opens as the closed cospan; reload keeps it |
| 4 | **Engine.** E1, E2, E3, plus `internal/model/resolve.go` and a shared fixture in `parity/model/`. Publish, repin. | pflow-native, pflow-xyz | L | 0 | By-reference place port validates in Rust and Go; `/api/save` accepts it |
| 5 | **Boundary panel.** Section 2.3, 2.4, add a second net. **The goal's result:** declare ports, see the feet, drag a link, see the pushout. | pflow-xyz | L | 2, 4 | `scripts/a11y-smoke.ts` passes the panel; a port edit changes the composition's CID and not the net's |
| 6 | **Account files and publish.** Picker, envelope, `#file=`, the public button. | pflow-xyz | M | 5 | Round trip against `cmd/webserver/files_test.go`'s handler |
| 7 | **Native.** Egui panel, menu route, contract states, goldens. | pflow-native, pflow-xyz | L | 4 | `user-*` goldens agree across both renderers |
| 8 | **Mixed compositions keep their recipe.** E4. | pflow-native | M | 4 | Export and reload keep `pattern` on the catalog part |
| 9 | **Layout from Shape A.** Section 1.4, Cospans first, then the others that fall back to a grid. | pflow-xyz | M | 2 | A 30-place net stays in its frame, checked by eye in a browser and recorded in the PR |
| 10 | **Inspector, full.** The rest of section 4. | pflow-xyz | S | 5 | `sources_test.ts` extended to user nets |
| V | **Drop the vendored `.wasm`.** Section 3.4. | pflow-xyz | M | | `make test` passes from the cache; a blocked CDN shows `renderFailure` in a browser |

The shortest route to what was asked for is 0, 1, 2, 4, 5. Stages 3 and 9 are what make it pleasant
for an editor net, so they should follow straight after. V can go at any point.

---

## 6. ontology.pflow.xyz integration

*This section was asked for by a val message from `matt` during the run. Probes of the live site are
from 2026-11-01. `ontology-pflow-xyz` is Matt's private repo, and only its structure and licence
declarations are described here.*

### 6.1 What is true today

| Claim | Finding |
|---|---|
| The page fetches nothing from the ontology | **True.** `compose/sources.js:6`: "Nothing here is fetched at run time". |
| Facts are baked into the page's JS | **Nearly.** They are in the wasm: `native:crates/core/src/composition/ontology.json` (`include_str!`, `composition/mod.rs:46`), which the page reads through `bundle.ontology`. Its `provenance` says it was serialized from `pflow-views-prototype` `js/model/ontology.js` @91695ad, from `ns/patterns.ttl`@bc4a996. So a fact change is an engine release, and native carries the same data. Views also hold their own cites (`views/cospan.js:37`, `:60-62`), and `orders.content.json` cites bc4a996 in 40 places. |
| The inspector says "(IRI not yet served)" | **True, for `/pattern/` and `/linkkind/`** (`compose/inspect.js:78`, a string match). A served `ns:` term shows as `<code>` with no link at all. |
| The ontology repo is private, with cites by file and line | **True.** `stackdump/ontology-pflow-xyz` is private with no licence file. `repos.ontology.url` is `null`, so the inspector shows a label only (`compose/inspect.js:86`). |

What the site serves (`curl`, `/mcp` `get_release`), version 0.2.0, released 2026-10-26, CC0-1.0:

| Path | HTML | Turtle | JSON-LD |
|---|---|---|---|
| `/ns` | landing page, no term anchors | yes | yes |
| `/ns.ttl`, `.jsonld`, `.nt`, `.rdf` | | files | files |
| `/term/<slug>` (glossary, e.g. `/term/place`) | yes | yes | not offered |
| `/pattern/saga` | **404** | **404** | **404** |
| `/linkkind/token` | **404** | **404** | **404** |
| `/sparql`, `/mcp`, `/release/`, `/.well-known/void` | served | | |

**The real blocker is the release, not the routing.** `pat:` and `lk:` are not in the served graph at
all: `ASK { <…/pattern/saga> ?p ?o }` is false, and there are 0 instances of `ns:NetPattern`.
`ns/patterns.ttl` was added 2026-10-27, the day after the release, and `VERSION` still reads 0.2.0.
`ns:PatternPort`, `ns:PlacePort` and `ns:LinkKind`, all named by the inspector, are absent from
`ns.ttl`. `ns:PetriNet`, `ns:Place` and `ns:Transition` are present. So every "a ns:PatternPort" the
inspector prints today names a term the public graph does not have.

### 6.2 (a) and (b): serving the IRIs, and linking to them

| # | Work | Repo | Size |
|---|---|---|---|
| O1 | **Cut release 0.3.0** with patterns, search and components. The Makefile already builds them in. Keep past releases at `/release/<version>/`; today `/release/` is only the current one. | ontology | S |
| O2 | **Route `/pattern/<key>` and `/linkkind/<key>`,** shaped like `/term/` (`site.go:320`): 200 with content negotiation to Turtle, JSON-LD and HTML, `Vary: Accept`, the term's triples from the pack. Add JSON-LD to `/term/`. Make `/ns` HTML a reference page with `id` anchors, so `…/ns#PatternPort` lands somewhere. Add them to the sitemap. | ontology | M |
| O3 | **The inspector links.** Concept `<code>` becomes a link. Replace the string match at `inspect.js:78` with data: the snapshot records which IRIs its release contains (6.3). Native gets the same flag and opens a browser. | pflow-native, pflow-xyz | S |

200 with negotiation rather than a 303 to a document, because `/term/` already works that way and one
pattern is simpler for clients. `ns:` is a hash namespace, so `/ns` covers it. `/pattern/` and
`/linkkind/` are slash namespaces, so they need the new routes.

Terms the page marks PROPOSED (`ns:Box`, `ns:WireType`, `ns:SearchPiece`, `compose/views/operad.js:380`,
`:394`) must not become links until a release has them. With the flag from O3 this needs no special
case: not in the release, no link. A user net's inspector names only `ns:` terms (section 4), so this
section does not block the feature.

### 6.3 (c): live or pinned facts

**Decision: pinned at build time. Live for links only.**

| Concern | Live fetch at page load | Pinned snapshot (chosen) |
|---|---|---|
| Versioning | Facts move under a fixed engine, so a hover can disagree with the link verdict beside it | Facts and engine change together, in a named release |
| Parity goldens | Web can drift from native, and from its goldens, with no commit on either side | Stable; native reads the same file |
| Offline and native | Native and the page need the network for a hover | Works offline |
| Load budget | Another blocking request or a late redraw (`docs/compose-load-budget.md`), against a rate-limited `/sparql` | None |
| Availability | A second runtime dependency per page view | None |
| Freshness | Always current | **Lags until someone re-pins.** A drift check makes this visible, not silent. |
| Citations | The cited text can change | A fact names the release it came from |

What changes is the snapshot's source. Today it is a one-time `JSON.stringify` of a prototype's
module, and nothing connects it to the graph.

| # | Work | Repo | Size |
|---|---|---|---|
| O4 | **`compose-facts.json` as a release file:** a script in the ontology repo emits the patterns, ports, link kinds and idioms from the pack, by SPARQL over `ns.nt`, and `manifest.json` hashes it. It carries the list of served IRIs. | ontology | M |
| O5 | **Replace `ontology.json`'s generated part with it,** fetched by a sync script and checked by hash, the same pattern as the wasm pin. `provenance` gains `release` and `pack_content_sha256`, and the inspector can name the release. | pflow-native | M |

Not everything moves. `link_style`, `repos`, `bib` and `cq13` have no triples behind them and stay in
native. `ontology.json` holds 3 of the graph's 5 patterns, and the emit script keeps that selection
explicit. Live data is reachable by the link only: "see the current definition" is an `<a>`, not a fetch.

### 6.4 (d): citations at public URLs

Today a reader of `ontology-pflow-xyz ns/patterns.ttl:496 @bc4a996` has no way to check it.

| | **A. Cite versioned IRIs (chosen)** | B. Make the repo public |
|---|---|---|
| A cite becomes | `https://ontology.pflow.xyz/pattern/idiom-pool-release-saga-commit` at release 0.3.0 | a GitHub link to the lines |
| Reader sees | the term's triples, in three formats, with no line numbers | the exact lines, in history |
| Needs | O1, O2, versioned releases, `cq/` in the release | everything in the audit below, across history |
| Survives an edit | yes, by version | yes, by revision |
| Blocked on | nothing but work | Deferred: Matt decided on 2026-11-01 to keep the repo private |

**Decision (Matt, 2026-11-01): A. `ontology-pflow-xyz` stays private for now; it is for our own
purposes.** `compose.html` uses a pinned snapshot built from a release and cites versioned public IRIs.
Other users start with an open ontology of their own, not this repo. A needs nothing made public beyond
the CC0 release that is already public. B is deferred, not rejected, and does not conflict.

The rewrite, O6 (**M**, pflow-native and pflow-xyz): map each `{repo: ontology, path, from, to}` cite to
its term's IRI, by hand, since a line range is not always one term. That covers `ontology.json`,
`orders.content.json`'s 40, and the views' `onto()` and `ttl()` helpers. `citeURL` then returns the
IRI, `parity/composition-views/sources_test.ts` fails on any cite not in the snapshot's IRI list, and
`cq/13` and the other cited queries join the release, since they are cited as files.

**What publishing would take, if B is ever wanted (deferred; reference only, not planned work).**

| Item | State | Needed |
|---|---|---|
| Licence on the data | `ns/core.ttl:18-19` declares CC0 1.0, and the release reports CC0-1.0 | A `LICENSE` stating it for `ns/`, `generated/`, `cq/` |
| Licence on the code | None: no `LICENSE` file; `gh` reports null | MIT, as the sibling repos have, for the Go server, `extract/`, `scripts/` |
| Text from other repos under CC0 | `generated/glossary.ttl` has 51 definitions from `book-pflow-xyz` (public, MIT). `generated/models.ttl` has 7 from sim's published vocabulary. `ns/patterns.ttl` reads from go-pflow (MIT). | **The same owner can dedicate these,** so this is a decision to record rather than a blocker. It should be written down, because a CC0 statement over MIT-sourced text otherwise reads as an error. |
| Third-party text | `ns/references.json` and the bibliography cite papers; the ontology's ROADMAP rule is "cited, never copied" | Spot-check for copied abstracts before publishing |
| Private material | `.sources/` is git-ignored, and sim's source is "never read" per the same rule. Single author; `.git` is 2.9 MB; a grep of `ns`, `generated`, `cq` for `myork`, `@gmail` and `192.168` found nothing. | Repeat across **all history**, not only the tip, and audit `receipts/` and `release/`. Not done here. |
| The rename | `stackdump/ontology-pflow-xyz`, and `apps/ontology-pflow-xyz.yaml` declares it | Nothing, unless it moves to `pflow-xyz` for consistency |

### 6.5 Order

O1 and O2 are independent of everything else here, and they remove the most visible oddity: a page
that prints IRIs its own namespace does not serve. Then O3, O4, O5, O6. None of them blocks stages
0-10.

| # | Stage | Size | Needs |
|---|---|---|---|
| O1 | Release 0.3.0, past releases kept | S | |
| O2 | `/pattern/`, `/linkkind/`, `/ns` anchors | M | O1 |
| O3 | Inspector links, served flag | S | O2, O4 |
| O4 | `compose-facts.json` in the release | M | O1 |
| O5 | Snapshot from the release | M | O4 |
| O6 | Citations to IRIs, test | M | O2, O5 |

## Not in scope

- A composition of compositions (`E_PART_KIND`), and plans for a user's net (design G3).
- Live sync between editor and page.
- Scenario and content authoring on the page. A model can load them, but no UI writes them.
- The `/m/<cid>` routes and the library in `models-first.md`.
- Applying the Laws view's theories to a user's net.
