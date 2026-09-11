# CLAUDE.md - pflow-xyz

This file provides guidance for Claude Code when working with this repository.

## Project Overview

pflow-xyz is a web-based visual editor and simulator for Petri nets. It provides an interactive interface for building, editing, and simulating Petri nets using JSON-LD format with IPFS content addressing (CIDv1).

**Key features:**
- Browser-based drag-and-drop Petri net editor
- Discrete-event and continuous-time (ODE) simulation
- JSON-LD persistence with IPFS CIDv1 content-addressed storage
- GitHub OAuth authentication
- Go backend with SVG rendering and API

## Build Commands

```bash
make build      # Build webserver binary to bin/webserver
make run        # Build and run on port 8080
make run-dev    # Development mode on port 3000
make test       # Run all Go tests
make clean      # Clean build artifacts
make deps       # Install dependencies
```

Direct Go commands:
```bash
go build ./...              # Build all packages
go test ./...               # Run all tests
./bin/webserver -port 8080  # Run server with custom port
```

## Build systems

pflow-xyz builds two ways. **Go tooling and Bazel coexist** — `go.mod` stays the
source of truth for dependencies; Bazel reads it via Gazelle. `make build` is
the ship path (pflow.dev deploys with it); Bazel is the hermetic verification
build and the way other repos can pin this repo's JS.

```bash
make build / make test          # Go + deno + parity, as before
make bazel-build                # bazel build //...   (runs nogo: vet + x/tools)
make bazel-test                 # bazel test //...
make bazel-gazelle              # regenerate BUILD.bazel after adding Go files
bazel test --config=remote //... # use the shared bazel.stackdump.com cache
```

Pins mirror the ecosystem line — `rules_go 0.61.1 / gazelle 0.51.3 / Go SDK
1.26.0` — so action keys match graph-wide and the shared remote cache is reusable
across go-pflow, bitwrap-io and petri-pilot.

**Decisions baked in:**

- **`//public` is exported.** `@pflow_xyz//public:browser_modules` is the
  filegroup consumers vendor. A Bazel-ported consumer can take a `bazel_dep` on
  this module and diff its vendored copy against a *pinned upstream version*
  rather than a bare sha256 — the provenance `pflow-js.lock` alone cannot give.
  The copies still exist regardless: bitwrap-io and modeldao-org need files on
  disk for `//go:embed`, stackedup-gg serves them from disk at runtime, and
  pflow.dev ships `make build`.
- **`internal/static/public/**` is produced in-graph.** The Makefile does
  `cp -r public internal/static/` and the tree is gitignored, so Gazelle would
  otherwise glob whatever the last `make build` left behind — making the Bazel
  build depend on having run make, and letting the embedded assets go stale
  silently. `//internal/static:gen_public` copies from `//public` instead, with
  `# gazelle:exclude public`. Verified by deleting the on-disk tree and
  rebuilding.
- **One file list, two consumers.** `public/files.bzl` holds `PUBLIC_FILES`,
  read by both `//public` and `//internal/static`. Regenerate it when adding or
  removing anything under `public/`.
- **Pure Go, no cgo.** go-ethereum's `crypto/secp256k1` does a relative cgo
  `#include` of libsecp256k1's C sources, which does not resolve in Bazel's
  sandbox. Without cgo, go-ethereum selects `signature_nocgo.go` and decred's
  pure-Go secp256k1 (already an indirect dep). The only consumer is
  `internal/ethsig`; the backends are interchangeable there. Note this is one
  way the hermetic build differs from what `make build` ships.
- **gnark-crypto asm is patched hermetically**, reusing go-pflow's
  `bazel/patches/gnark-crypto-asm-hermetic.patch` — both repos pin v0.19.2. It
  arrives indirectly via go-ethereum's KZG path.
- **The parity tests run under Bazel** and use `//public` directly, so the
  differential drives the same files the browser loads rather than a copy. They
  shell out to **host** `node` (they `exec.LookPath` and skip if absent), so
  that one edge is not hermetic.

## Project Structure

```
cmd/webserver/main.go    # Server entry point, HTTP handlers, OAuth flow
internal/
  auth/                  # GitHub OAuth token verification
  canonical/             # JSON-LD canonicalization (URDNA2015)
  seal/                  # CID computation (IPFS CIDv1 with SHA2-256)
  store/                 # Filesystem-based object storage
  svg/                   # SVG generation with layout algorithms
  static/                # Embedded static files
public/
  petri-view.js          # Main web component (~7000 lines)
  petri-solver.js        # ODE solver module (Tsit5)
  index.html             # Demo page
examples/                # Example Petri nets in JSON-LD
```

## Key Files

- **cmd/webserver/main.go** - HTTP server, API endpoints, GitHub OAuth
- **public/petri-view.js** - `<petri-view>` web component with all editor logic
- **public/petri-solver.js** - Standalone ODE solver for simulations
- **internal/seal/seal.go** - CID computation from JSON-LD
- **internal/store/store.go** - Filesystem storage for objects
- **docs/engine-selection.md** - which engine (ODE/SSA/SDE) for which
  question; vendored from go-pflow (`scripts/docs-sync.sh check`/`sync`,
  same hash-lock pattern as the shared browser JS below)

## API Endpoints

- `GET /auth/github` - Initiate GitHub OAuth
- `GET /auth/user` - Get current user info
- `POST /api/save` - Save JSON-LD, returns CID
- `GET /o/{cid}` - Retrieve object by CID
- `DELETE /o/{cid}` - Delete object (author only)
- `GET /img/{cid}.svg` - Generate SVG (optional `?layout=force-atlas-2|circular|hierarchical`)
- `GET /schema` - JSON-LD context (HTML reference page when `Accept: text/html`)
- `GET /tokens/{color}` - JSON-LD token type (HTML page when `Accept: text/html`); accepts CSS named colors and bare hex (e.g. `red`, `ff0000`, `red,blue`)
- `GET /share-card/{cid}.svg` - 1200×630 social share card (vector) for the stored net
- `GET /share-card/{cid}.png` - 1200×630 social share card (raster) — used as `og:image` because Twitter/Mastodon/Bluesky drop SVG og:images
- `GET /?cid={cid}` - SPA shell, decorated with Open Graph / Twitter / JSON-LD `<head>` meta tags pointing at the share card (see `cmd/webserver/share_page.go`)

Content negotiation for `/schema` and `/tokens/{color}` is implemented in `cmd/webserver/content_negotiation.go`. Browsers (Accept includes `text/html` ranked above JSON) get a styled dark-theme page; everything else (curl, no Accept, `*/*`) gets JSON-LD.

## Environment Variables

```bash
GITHUB_CLIENT_ID        # GitHub OAuth App client ID
GITHUB_CLIENT_SECRET    # GitHub OAuth App client secret
```

## Code Conventions

- Go code uses standard library patterns with minimal dependencies
- Frontend is vanilla JavaScript with ES6 modules, no build step
- JSON-LD schema at https://pflow.xyz/schema
- CIDs use base58btc encoding (z prefix)

## Testing

Go tests are alongside source files (`*_test.go`). Key test files:
- `internal/seal/seal_test.go` - CID computation
- `internal/store/store_test.go` - Storage operations
- `internal/svg/svg_test.go` - SVG generation

Frontend testing via `public/test-solver.html` for the ODE solver.

## Publishing to cdn.stackdump.com

`publish/cdn.py` is this repo's implementation of the ecosystem producer
contract (see `~/Workspace/CLAUDE.md`). Use it for demo pages, saved models,
or any artifact directory — it computes the CID, generates `index.md`, stages
atomically, pings the indexer, and mirrors to pflow.dev.

```bash
make publish SRC=path/to/demo.html                     # infers title + schema
make publish SRC=./artifact-dir ARGS='--tag ode --meta solver=tsit5'
make publish SRC=model.jsonld ARGS='--dry-run'         # print CID + index.md, write nothing
python3 publish/cdn.py demo.html --body notes.md --draft
```

Public URL is `https://cdn.stackdump.com/ipfs/<cid>/`; the tool prints it.
`make test-publish` covers the module (temp blobs dir, no real state touched)
and runs as part of `make test`.

**Two conventions it encodes so callers don't have to remember them:**

- **CID** is `bafyrei` + the first 32 hex of `sha256(primary artifact bytes)` —
  the house rule shared with beats-builder. Not a real CIDv1; the CDN
  sanitises rather than validates. Adding sibling assets does **not** change
  the address, only the primary artifact's bytes do.
- **`index.html` is renamed to `demo.html` on staging.** The CDN's file server
  301s `/ipfs/<cid>/index.html` → `./`, which renders the `index.md` landing
  page — so an artifact literally named `index.html` is unreachable and the
  landing page's link to it is a redirect loop. This bit the first publish;
  the rename is now automatic and asserted by a test.

Schema and title are inferred (`InteractiveDemo/v1` for HTML, `PetriNet/v1`
for a JSON-LD net, `Dataset/v1`/`Document/v1` otherwise; title from `<title>`
or the JSON `title`/`name`), and `--title`/`--schema` override. Every
`--meta KEY=VALUE` becomes a searchable facet (`?meta.solver=tsit5`), with
numeric values left unquoted so range queries work. Republishing the same
bytes replaces the directory cleanly and yields the same CID.

## Common Tasks

**Adding a new API endpoint:**
1. Add handler method to `Server` struct in `cmd/webserver/main.go`
2. Register route in `ServeHTTP` method
3. Handle CORS via `handleCORS` helper

**Modifying the editor:**
1. Edit `public/petri-view.js` - the `PetriView` class
2. No build step needed, changes are live on reload
3. Test with `python3 -m http.server 8000 --directory public`

**Working with CIDs:**
- CIDs are computed from canonicalized JSON-LD via `seal.SealJSONLD()`
- Storage paths use sanitized CID strings
- Objects are immutable once stored

**JS/Go CID parity (enforced).** The browser editor and the Go server must
produce byte-identical CIDs. Both compute `CIDv1(dag-json, sha2-256, base58btc)`
over the **`@id`-stripped** URDNA2015 N-Quads (the top-level `@id` is the CID
itself, so it's excluded from its own preimage — this makes CIDs idempotent).
- Go: `internal/seal/seal.go` (strips `@id`, uses `piprate/json-gold`).
- JS: `public/seal-cid.mjs` — the single source of truth, imported by
  `petri-view.js`. Uses a vendored `jsonld` ESM bundle at
  `public/vendor/jsonld.bundle.mjs` (regenerate with
  `esbuild jsonld --bundle --format=esm --platform=browser --banner:js='globalThis.self ??= globalThis;'`).
- **Lineage:** a `parents` field (ordered, `@container:@list`, newest-first array of
  parent CID strings) carries provenance — mirrors beats-bitwrap-io. It is **not**
  the top-level `@id`, so it IS part of the CID, and because it's a list its order
  is significant. Adding a context term means updating BOTH CID contexts
  (`seal.go` + `seal-cid.mjs`) and `public/schema` in lockstep.
- Contract is locked by `make test-parity`: shared fixtures in `parity/fixtures/`
  + golden CIDs in `parity/golden.json`, checked from Go
  (`internal/seal/parity_test.go`) and JS (`parity/parity_check.mjs`). Any
  divergence fails the build. Regenerate goldens with
  `go run ./cmd/cidprobe parity/fixtures/*.jsonld`.

**JS/Go behavioral parity (enforced).** Beyond CIDs, the browser's simulation
engines and go-pflow must produce identical *behavior* from identical models —
this is what makes an analysis result from go-pflow trustworthy for a net built
in this editor. Locked by `make test-parity-behavior` (`parity/sim/` and
`parity/ode/`, both need `node`):
- **Discrete firing** (`parity/sim`): 200 seeded random models walked in
  lockstep — fire the lexicographically smallest enabled transition — comparing
  enabled sets and markings at every step between `public/petri-sim.js` and
  go-pflow's reachability engine. The shared rules: weighted inhibitors disable
  at tokens >= weight; output-side inhibitors are test arcs (require tokens >=
  weight, move nothing); capacities are enforced with same-firing consumption
  netted and production aggregated per place; multiple input arcs from one
  place require the sum of their weights. Token colors ARE covered: ~1/3 of
  models use two-color vectors, which go-pflow analyzes via petri.ExpandColors
  (colored-net unfolding) and this side natively; vector weight components
  preserve explicit zeros ("color not involved"), while a scalar weight of 0
  still defaults to 1. The engines are contracted to agree on LEGAL states —
  initial markings above a declared capacity are malformed (go-pflow
  validation rejects them) and excluded from generation.
- **ODE** (`parity/ode`): fixed fixtures integrated by `public/petri-solver.js`
  and go-pflow's Tsit5 with shared default options; final states agree to
  ~1e-15 (the implementations are step-for-step identical), asserted at 1e-6.
  Token colors are handled here the same way as in the discrete engine — by
  unfolding. `ODEProblem` calls `expandColors` (see below), so mass action runs
  per color: a transition's flux depends only on the colors its input arcs
  name, and consumes only those.
- **Differentiable fitting** (`parity/learn` + `public/petri-learn.js`): a JS
  mirror of go-pflow's `learn` package — forward sensitivities (augmented ODE,
  analytic Jacobian, the one-sided derivative at flux==0, tied parameters via
  `SharedScalar`), MSE/relative loss gradients, Adam / gradient-descent /
  Nelder-Mead / coordinate-descent, `hingeRankLoss`, and a `fitRates`
  convenience. Goldens in `parity/learn/goldens.json` are generated FROM
  go-pflow by `make learn-goldens` (regeneration is deliberate, never a build
  side effect) and replayed by `public/petri-learn_test.ts` in `make test-js`.
  Fixed-step cases and the analytic-objective optimizer runs are asserted
  BIT-FOR-BIT (Adam's integer bias-correction pow is ported as `goPowInt`;
  Go constant-folds `1-beta` exactly, mirrored); adaptive-step cases are
  asserted at 1e-12 relative because Go's step controller calls `math.Pow`
  whose amd64 assembly V8 cannot bit-match (measured agreement ~4e-14).
  **`LearnableProblem.solveAdjoint` / `mseLossAdjoint` / `relativeMseLossAdjoint`**
  mirror `learn/adjoint.go`'s reverse-mode gradient — one backward (costate)
  solve produces the full parameter gradient at a cost independent of
  parameter count, versus forward mode's n·(P+1) augmented states. Goldens
  (`point1Adjoint`/`point2Adjoint`) are asserted under the SAME exact/tolerance
  rule as everything else, but that compares JS-adjoint against Go-adjoint,
  NOT adjoint against forward-mode: the adjoint's forward pass is a plain
  (unaugmented) solve, so on an adaptive case its accepted-step grid genuinely
  differs from the augmented sensitivity ODE's, and even on a fixed-step case
  the gradient is a numerically distinct computation from forward mode's
  (bit-identical loss, not bit-identical grad) — both correct, different
  algorithms. No RMSE adjoint exists on either side: sqrt after the sum does
  not decompose pointwise.
- **Discrete-stochastic SSA** (`parity/ssa` + `public/petri-ssa.js`): a
  Gillespie direct-method simulator held BYTE-EXACT to go-pflow's `stochastic`
  package (portable path) — and, through the same goldens, to pflow-rs and
  pflow-jl. Three things are pinned so no platform can leak in: the PRNG
  (SplitMix64-seeded xoshiro256**, BigInt with explicit 64-bit masks), the
  logarithm (`plog`, a port of pure-Go `math.log`; `Math.log` differs on ~7%
  of inputs, `log(3.0)` is the witness, and must never appear on that path),
  and arithmetic order (propensity sums, cumulative scan, naive population
  variance — all written in the spec's order). The five goldens in
  `parity/ssa/*.json` (chain, sir, dimer, gates, coffeeshop) are Go-generated:
  go-pflow's `cmd/ssa-goldens` writes `stochastic/testdata/portable/*.json` on
  branch `discrete-stochastic`, and the copies here are byte-identical
  (`parity/ssa/README.md` names the generating commit and the sha256 of every
  file; `sha256sum` both sides to verify). `public/petri-ssa_test.ts` replays
  every double with `!==` in `make test-js` and in CI. This repo consumes the
  goldens, it does not produce them — `go.mod` pins a go-pflow release without
  the stochastic package, so there is no Go generator or Go-side test for it
  here. `compile()` takes `places`/`transitions` as arrays; an id-keyed object
  is accepted only when no key is integer-like (JS enumerates those first, in
  numeric order, so the declaration order Go uses would be lost — it throws
  instead). `petri-ssa.js` is deliberately NOT in `//public:browser_modules`
  (that list pairs positionally with bitwrap-io's vendored list); no consumer
  lock changes.
- Changing firing semantics on either side means changing BOTH engines and
  their tests in lockstep — the differential fails otherwise. go-pflow's side
  of the contract is pinned by Go-native tests in its reachability package.
- **Chemical Langevin SDE** (`public/petri-sde.js`): the third leg of
  Petri.jl's ODEProblem/JumpProblem/SDEProblem trio (go-pflow ROADMAP.md G6),
  a port of go-pflow's `stochastic/sde.go`. Continuous state via
  Euler-Maruyama (20 fixed internal substeps per reported grid point), but
  with the net's own intrinsic firing noise rather than SSA's discrete events
  or the ODE's none at all. Reuses `petri-ssa.js`'s `compile()`,
  `Xoshiro256` and `plog` rather than duplicating them. Refuses a gated model
  (read arc, inhibitor, reachable capacity) exactly as `Forecast`/
  `SimulateSDE` do on the Go side, including matching go-pflow's `Gating()`
  reason/caveat wording field for field (arc counts, `[a b c]`-style place
  lists) — ported from pflow-rs's already-corrected `sde.rs::gating_reasons`.
  Part of the byte-exact cross-language contract SSA has: `parity/sde/`
  (the same five models as `parity/ssa/`) is replayed bit-for-bit by
  `public/petri-sde_test.ts`, closing the pflow-xyz side of a contract
  go-pflow↔pflow-rs already held. Its Gaussian sampler (`GaussianSampler`,
  Marsaglia polar over `plog` + the IEEE-754-exact `Math.sqrt`, deliberately
  not Box-Muller which would need a second ported transcendental) is
  additionally checked bit-for-bit against go-pflow's own
  `stochastic/portable_test.go` `TestPortableNormalVectors` at seed 42 (Go is
  the reference implementation; there is no external SDE spec). The
  remaining tests are consistency checks against this repo's own SSA,
  mirroring go-pflow's `stochastic/sde_test.go`.

**`public/` is the canonical source for shared browser modules.** bitwrap-io,
stackedup-gg and modeldao-org each serve their own copy (each embeds its own
static assets), so the files are duplicated on disk by necessity — but never
divergently. Each consumer carries `scripts/pflow-js.sh` + a `pflow-js.lock`
recording every vendored file's sha256 and the pflow-xyz commit it came from:

| Consumer | Vendored |
|---|---|
| bitwrap-io | `public/`: petri-sim.js, petri-solver.js, petri-colors.js, petri-view.js, seal-cid.mjs, vendor/jsonld.bundle.mjs |
| stackedup-gg | `frontends/zk-poker/`: petri-solver.js, petri-colors.js |
| modeldao-org | `internal/static/public/`: seal-cid.mjs, vendor/jsonld.bundle.mjs |

`make check-pflow-js` (wired into each repo's `make test`, and bitwrap-io's CI)
verifies the copies still match the lock. It is offline by design — the failure
it prevents is someone editing a vendored copy in place, and a network fetch
would only make that check flaky. `make sync-pflow-js` re-copies from a
pflow-xyz checkout (`PFLOW_XYZ=`, default `../pflow-xyz`) and rewrites the lock;
`./scripts/pflow-js.sh status` reports staleness without changing anything.

**Fix shared-module bugs HERE, then sync.** bitwrap-io's petri-sim.js sat 57
lines behind for months, still coercing a `[0,2]` arc weight to `[1,2]` — which
makes "this color is not involved" unexpressible — plus missing the aggregate
consumption and capacity checks. Nothing failed, because nothing compared.

Not covered, deliberately: modeldao-org's `petri-view.js` (a genuine 1404-line
fork, not drift) and petri-pilot / pflow-pilot's `pflow-engine.js` (a derived
unified ODE + event-sourcing runtime, not a copy). Those need the shared parts
extracted, not a file swap.

**Colored-net unfolding (`public/petri-colors.js`).** A direct port of
go-pflow's `petri/colors.go`; every rule has a counterpart there. `expandColors`
turns a multi-color net into an equivalent single-color one — one place per
color (`pool.red`), one arc per non-zero weight component, transitions shared
so a firing moves every color atomically — so anything that works on a
single-color net works on it unchanged with exact per-color semantics.
- `expandState(net, state)` maps a base-name state vector into the unfolding: a
  base total splits across colors in the proportions the place declares. Chosen
  so `expandState(net, setState(net))` reproduces the declared vectors exactly,
  and so it is idempotent on already-expanded keys.
- **Reporting convention, matching go-pflow's solver:** `ODESolution`'s
  `getFinalState`/`getState`/`getVariable("pool")` report per-place TOTALS under
  the original names, so existing callers (and the editor's plot checkboxes,
  which are keyed by base place id) are unaffected. `getFinalStateByColor`,
  `getStateByColor`, `getVariable("pool.red")` and `getVariableByColor("pool")`
  expose the breakdown. The dynamics are per color either way.
- `petri-sim.js` is natively component-wise and does NOT use this module; it is
  the independent implementation the unfolding is checked against.
- Unit tests: `public/petri-colors_test.ts` (`make test-js`), mirroring
  go-pflow's `petri/colors_test.go`.

## Architecture Notes

- Backend embeds `public/` directory at compile time via `internal/static/`
- GitHub OAuth tokens are passed directly to frontend (no JWT)
- Storage uses filesystem with structure: `data/o/{cid}`, `data/u/{user}/g/{slug}/`
- Frontend `_authToken` is a GitHub access token with `gist` scope

## Deployment (pflow.dev)

All services run on pflow.dev behind nginx. Manage with the `~/services` command:

```bash
~/services list      # Show all services and status
~/services start     # Start all services
~/services stop      # Stop all services  
~/services restart   # Restart all services
```

### Service Ports

| Service | Port | URL |
|---------|------|-----|
| pflow-pilot | 8083 | pilot.pflow.xyz |
| pflow-xyz | 8081 | pflow.xyz |
| blog-stackdump | 8082 | blog.stackdump.com |
| modeldao-org | 8084 | modeldao.org |
| stackdump-com | 8085 | console.stackdump.com |

### This Service

```bash
# Check status
ssh pflow.dev "~/services list"

# View logs
ssh pflow.dev "tmux capture-pane -t servers:pflow-xyz -p | tail -50"

# Restart
ssh pflow.dev "~/services restart"

# Attach to tmux
ssh pflow.dev "tmux attach -t servers"
```

### Environment Variables

Environment variables are configured in `~/services`. This service uses:
- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` - GitHub OAuth
- `GOOGLE_ANALYTICS_ID` - Analytics (G-E7Q5BVDGYB)
- `SUPABASE_JWT_SECRET` - Supabase JWT

## Decommissioning

Visual editor at pflow.xyz (pflow.dev :8081).

See [Archiving, backing up and taking down a project](../stackdump-com/CLAUDE.md#archiving-backing-up-and-taking-down-a-project) for the ecosystem-wide procedure and the ordering. This section records only what **this** project holds, which is the part that differs.

**State that is not in git** (every path below is gitignored):

| Host | Path | Size | What it is |
|---|---|---|---|
| pflow.dev | `~/Workspace/pflow-xyz/data/pflow.db` | 47M | saved models |

**Specific to this project:**

- **Canonical source for the shared browser JS** (`petri-sim.js`, `petri-solver.js`, `petri-colors.js`, `seal-cid.mjs`). bitwrap-io, stackedup-gg and modeldao-org vendor copies pinned by sha256 — retiring this orphans those locks.
- Publishes the `@pflow-xyz/pflow-xyz` npm package. Published versions cannot be unpublished; `npm deprecate` instead.
