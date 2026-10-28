# Model identity

Which CID names a model, and how every CID that exists today stays valid as one.

This is the rule the models-first design ([`docs/design/models-first.md`], PR #124)
leaves open: it says a model's CID is the CID of its Bundle JSON and that a single
net is a one-subnet bundle, which would change every net's CID. The rule below keeps
the sealing contract and every existing CID, and adds a model that is more than one net.

[`docs/design/models-first.md`]: https://github.com/pflow-xyz/pflow-xyz/pull/124

## The sealing contract is unchanged

`internal/seal` (Go), `public/seal-cid.mjs` (JS) and pflow-native's
`crates/core/src/cid.rs` (Rust) still do exactly this, and nothing here edits
them: drop the top-level `@id`, canonicalise with URDNA2015 under the preloaded
pflow.xyz context, sha-256, CIDv1 dag-json base58btc. No context term is added.
The rule decides only **what is sealed**.

## The rule

| What | Its model CID | Shape |
|---|---|---|
| **A net** | the CID it has always had: `seal(net)` | Shape A, the editor's JSON-LD, coordinates included. Anything that is not a composition or a plan is a net, so unknown documents keep their CID too |
| **A composition** | `seal(composition)`, the document as written | `@type: "PetriNetBundle"`, go-pflow's `metamodel.Bundle`: `subnets` and typed `links`. Each subnet is **by reference** (`cid`: a stored net) or **inline** (`model`: the metamodel shape, only for a part with no net CID) |
| **A bare wrapper** | the part's CID | a composition that is nothing but one net by reference (below) |
| **A plan** | `seal(plan)` | `@type: "SearchPlan"`, `model_cid`, `plan` (below) |

Changing a link changes only the composition's CID: each part keeps its own, because the
composition holds the part's CID, not its content. Editing a part is a new net, so a new
part CID, so a new composition CID.

### A single net IS a model

The ask was that a one-subnet, no-link model normalise to the net before sealing. Here is
exactly when that holds. `Bundle.Flatten` returns a lone subnet's model as a clone, but it
**overrides the model's name with the bundle's name and appends the bundle's constraints**
(`metamodel/compose_flatten.go`, the identity short-circuit). So only a wrapper that adds
nothing is the net:

> **Bare wrapper:** one subnet whose only keys are `@type`, `id`, `net_type` and `cid`;
> no links and no constraints (absent or empty); no `name`, `version`, `description`,
> `parents` or any other key. `namespace` and `arc_merge` may appear, since Flatten
> ignores both for one subnet.

Its model CID is the part's `cid`. A name, a description, a constraint, `ports`, a recipe
or a second part makes it a composition with its own CID.

A one-subnet bundle whose subnet is **inline** does not reduce. It never had an editor CID
(there is no metamodel-to-Shape-A converter, and the conversion would drop `exported`,
ports, `kinetic` and the rest), so there is nothing to keep stable and nothing is re-minted.

The save paths enforce the same thing: `POST /api/save` of a bare wrapper stores nothing
and answers `{"cid": <the net's CID>, "kind": "net", "reduced": true}`. Without that,
saving a wrapper would put a second object, under a second CID, in the store for one net.

### Parts and the store

A by-reference part must be a stored **net**; a composition of compositions is refused
(`E_PART_KIND`) for now. `POST /api/save` refuses a composition whose parts are not stored
(`422 E_PART_MISSING`, naming them), like git objects: what a document names exists before
it does. Reading resolves a part with the one converter from Shape A to the metamodel,
go-pflow's `parser.ModelFromJSON`, and flattens with `Bundle.FlattenWithMap`.

## Arrays hash as sets: ordered payloads are text

Only `arcs`, `token`, `weight`, `capacity`, `initial` and `parents` are `@list` in the
sealing context (`seal.go`, `seal-cid.mjs`, `cid.rs`). **Every other array hashes as an
unordered set.** `internal/model.TestOrderedPayloadsAreEmbeddedAsText` (and its Rust twin)
shows two sagas whose `steps` are in the other order sealing to the same CID.

That is harmless for `subnets`, `links` and `ports`: Flatten is order-independent, and the
sealer treats them as sets (reversing both leaves the CID unchanged). It is not harmless for
anything ordered. So an ordered or nested payload is embedded as **canonical JSON text**, a
string, and hashed exactly as given:

> **Canonical JSON text:** object keys sorted by code point (byte order of UTF-8), lists in
> order, no whitespace, `null`/`true`/`false`, numbers as doubles in `JSON.stringify`'s
> shortest form (`1`, not `1.0`; keep them within ±2^53 and avoid exponents), strings escaped
> only for `"`, `\` and controls below 0x20 (`\b \f \n \r \t`, else `\u00xx`). `<`, `>`, `&`,
> U+007F, U+2028 and U+2029 are written raw.

`internal/model.CanonicalJSON`, `public/model-cid.mjs canonicalJson` and pflow-native's
`model_id::canonical_json` agree on `parity/model/canonical.json`. A sealed string is never
re-canonicalised: it is a producer's job, and a consumer hashes what it is given.

## Pattern instances

A prototype-style instance (`{pattern, params}`, a pflow-compose constructor call such as
`queue {ID: orders, Capacity: 3}`) **builds a net**. The net is the identity; the recipe is
how it was made. So a pattern instance is addressed as an ordinary part, **by the net it
built**, and the recipe rides beside it:

```json
{"@type": "PetriNet", "id": "workers", "net_type": "ResourceNet",
 "model": { … the built net, metamodel shape … },
 "pattern": "resource-pool",
 "params": "{\"capacity\":2,\"id\":\"workers\",\"name\":\"workers\"}"}
```

* `cid` or `model` pins the net. A recipe alone does not (the same `params` through a later
  constructor revision builds a different net under one CID), so `{pattern, params}` without
  a net is refused (`E_PART`). This is design option B in the review, rejected for that reason.
* `pattern` (non-empty string) and `params` (canonical JSON text of an object) are hashed
  with the rest. The same net built by two recipes is two compositions; a verifier can rebuild
  the recipe and compare, which is a receipt, not part of identity.
* Pattern-built parts have no editor CID (constructors emit the metamodel shape), so they are
  **inline** in practice. Hand-written parts that are editor nets are **by reference**.
* Curated text about an instance (`label`, `why`, findings) is not in the document: everything
  in a sealed document is hashed, so judgment text lives beside the model, not in it.

go-pflow's `metamodel.Subnet` and pflow-rs's `pflow_compose::Subnet` have no field for `cid`,
`pattern` or `params` and drop unknown keys on load. Composition documents are therefore
**raw JSON for identity** (this repo, and pflow-native's loader, keep the document as given);
the typed structs are views used to flatten. A schema change in both twins is a follow-up,
not a precondition.

## Plans

A search plan is a separate document that names the model it is for; the model never names
its plans, so adding a plan never changes a model's CID.

```json
{"@context": "https://pflow.xyz/schema", "@type": "SearchPlan",
 "model_cid": "z4EBG9j…", "plan": "{\"drivers\":[…],\"mode\":\"exact\",\"order\":[…]}"}
```

`plan` is the `SearchPlan` JSON as pflow-rs accepts it, as canonical text, because its lists
(`order`, `drivers`, `filters`) are ordered. `SearchPlan` itself has `deny_unknown_fields`, so
the reference cannot live inside the plan; it lives in the envelope. The same plan on another
model is another document (a plan applies to nets, and whether it works on a given net is a
receipt about the pair). Plan **storage** and the many-to-many binding record of the review's
D2 are not built here; sealing and the vectors are.

## Backport

Every CID that exists today stays valid as a model CID: the rule is the identity function on
nets. The proof, by corpus (all green; the run is in the PR):

* **Repository** (`go test ./internal/model -run Backport`): every pflow.xyz JSON-LD net
  reachable in the tree seals to the same CID as the rule gives it; files named by their CID
  are checked against their name. Documents over 60 KB are skipped by default (sealing a
  368 KB Connect-4 net with json-gold takes minutes); `MODEL_BACKPORT_FULL=1` seals them too.
* **JS** (`node parity/model_check.mjs`): the parity fixtures and `examples/` through
  `modelCid` against `computeCid`.
* **Rust** (pflow-native `cargo test --test model`): the 113 nets of
  `tests/fixtures/cid` (parity corpus, gallery, 100+ edge cases) keep their CID, and the
  sealer and the rule refuse the same 9.
* **Live store:** the 26 objects at `pflow.xyz/sitemap.xml` (read through the public
  `/o/<cid>`) are all nets; for each, the rule's CID equals what the sealer gives the served
  document. See the caveat below.

**`examples/showcase/cafe.bundle.json`.** Raw-bundle CID `z4EBG9j1SUhuY7XnEcPfHQPzQkmqjUtgrD2wHADw8qdRbpnNt6W`;
composition CID **the same**. Its three subnets are inline metamodel nets with no net CID, so
the document is already a composition and the rule changes nothing in it. (A by-reference form
would need its parts as Shape A nets, which the metamodel's `exported`, `kinetic:false` and
rates do not survive.) Go, JS and Rust all give this CID (`parity/model/golden.json`).

**Caveat on legacy keys.** Of the 26 live objects, 8 re-seal to their stored CID today; the
other 18 do not, with or without the `author` the server adds on read. They were stored under
an earlier version of the contract (pflow-native's tests already note nets "sealed under the
old contract"). That predates this change and the rule does not touch it: a stored object is
found by its key, and nothing here recomputes a key. For those 18 the identity is the key.

## What the server does

| Request | Net | Composition | Plan |
|---|---|---|---|
| `GET /?cid=` | the editor, as now | `302 /compose.html?cid=` | `302 /compose.html?cid=` |
| `GET /compose.html?cid=` | page with the net's share head | page with the share head, and a model panel (parts, links, flat net, the CID recomputed in the browser) | same |
| `GET /img/<cid>.svg`, `/share-card/<cid>.{svg,png}` | as now | the flat net (go-pflow `Flatten` over the parts in the store), or a parts diagram if a part is missing | a placeholder |
| `POST /api/save` | as now (`{"cid"}`) | checks, requires stored parts, `{"cid","kind":"composition"}` | `{"cid","kind":"plan"}` |
| `/sitemap.xml` | lists `/img/<cid>.svg` | same, and it now draws | same |
| MCP `pflow_cid` | as now | model CID, with `kind` and `reduced` when they are not the plain case | |

Before this change a stored composition did not 500: `/img/<cid>.svg` answered 200 with a
blank 100×100 SVG and the share card said "0 places · 0 transitions". It now draws the flat net.

The composition page loads the stored model and shows it, but the ten views still draw the
built-in orders/workers/payment example: loading a stored Bundle into the registry needs
`bundle.load` in pflow-native, which the vendored wasm does not have.

## Parity

| Check | Where |
|---|---|
| Sealing (nets), Go vs JS | `make test-parity`: `internal/seal` and `parity/parity_check.mjs` over `parity/golden.json` (unchanged) |
| Model identity, Go vs JS | `internal/model` and `parity/model_check.mjs` over `parity/model/golden.json` (13 documents, 13 refusals) and `canonical.json` (10 vectors) |
| Model identity under deno | `public/model-cid_test.ts`, `public/compose/identity_test.ts` (`make test-js`) |
| Model identity, Rust | pflow-native `crates/core/tests/model.rs`, a copy of `parity/model/` (`tests/fixtures/model/`) |
| go-pflow `Flatten` = the wasm's `bundle.flatten` | `internal/model/flatten_parity_test.go` and `parity/model/flatten_parity_test.ts` over `parity/model/flat/` (three catalog compositions: 21, 42 and 21 places; 9, 21 and 12 transitions; 40, 80 and 40 arcs; same ids, same fused groups, same weights) |

Regenerate the golden CIDs with `go run ./cmd/modelprobe parity/model/fixtures/*.json
parity/model/fixtures/*.jsonld`, and the flat goldens with
`deno run --allow-read --allow-write=parity/model/flat parity/model/gen_flat.ts`.
Both are deliberate, never a side effect of a test.

## Not done

* The registry cannot load a stored Bundle (`bundle.load`/`bundle.export` are another change
  in pflow-native); the composition page shows the model but the views keep the built-in example.
* A composition of compositions, and a by-reference part that is not a net.
* The `cid`, `pattern` and `params` fields in go-pflow's and pflow-rs's `Subnet`.
* Terms for `PetriNetBundle` on the public `/schema` page.
* Plan storage and the plan/model binding record.
* `pflow_save` of a composition over MCP (it points at `/api/save`).
