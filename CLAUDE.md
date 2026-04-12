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
