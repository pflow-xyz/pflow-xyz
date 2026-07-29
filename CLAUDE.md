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
  place require the sum of their weights. Token colors are out of scope (JS is
  per-color, go-pflow sums to scalars — a known representational gap).
- **ODE** (`parity/ode`): fixed fixtures integrated by `public/petri-solver.js`
  and go-pflow's Tsit5 with shared default options; final states agree to
  ~1e-15 (the implementations are step-for-step identical), asserted at 1e-6.
- Changing firing semantics on either side means changing BOTH engines and
  their tests in lockstep — the differential fails otherwise. go-pflow's side
  of the contract is pinned by Go-native tests in its reachability package.

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
