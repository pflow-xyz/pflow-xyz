# Copilot Instructions for pflow-xyz

## Project Overview

pflow-xyz is a lightweight web component for building, editing, and simulating Petri nets in the browser. The project consists of:

1. **Frontend**: An ES module web component (`public/petri-view.js`) that provides a visual editor and simulator for Petri nets
2. **Backend**: A Go webserver that serves the frontend and provides API endpoints for saving/retrieving Petri net models using a compatible backend

The component supports:
- Visual editor for places, transitions and arcs
- Live simulation with manual firing and play/stop mode
- JSON-LD persistence
- Optional in-page JSON editor with Ace
- Undo/redo history, pan & zoom

## Project Structure

```
.
├── cmd/
│   └── webserver/        # Go webserver entry point
├── internal/
│   ├── auth/            # Supabase JWT authentication
│   ├── canonical/       # JSON-LD canonicalization (URDNA2015)
│   ├── ethsig/          # Ethereum signature verification
│   ├── seal/            # CID computation (IPFS CIDv1 with SHA2-256)
│   ├── static/          # Embedded static files
│   └── store/           # Filesystem-based object storage
├── public/              # Frontend static files (HTML, JS, CSS)
│   └── petri-view.js   # Main web component
├── Makefile            # Build and test automation
├── go.mod              # Go dependencies
└── README.md           # Main documentation
```

## Building and Testing

### Prerequisites
- Go 1.24.9 or later
- Make (optional, but recommended)

### Build Commands

```bash
# Build the webserver (includes copying public directory to internal/static)
make build

# Clean build artifacts
make clean

# Install/update dependencies
make deps
```

The build process:
1. Copies `public/` directory to `internal/static/public` (this is embedded in the binary)
2. Builds the Go binary to `bin/webserver`

### Running the Server

```bash
# Run with default settings (port 8080)
make run

# Run with custom port for development
make run-dev  # Uses port 3000 and ./data-dev directory

# Or run directly
./bin/webserver -port 9000 -data /path/to/data
```

### Testing

```bash
# Run all tests
make test

# Or use Go directly
go test ./...
```

**Note**: Some tests may fail if:
- The `public` directory hasn't been copied to `internal/static/public` (run `make build` first)
- Missing Ethereum dependencies for `internal/ethsig` package (this is a known issue)

The following packages have test coverage:
- `internal/auth` - JWT authentication tests
- `internal/canonical` - JSON-LD canonicalization tests
- `internal/seal` - CID computation and consistency tests
- `internal/store` - Object storage tests

## Development Workflow

1. **Frontend changes**: Edit files in `public/` directory
2. **Backend changes**: Edit files in `cmd/` or `internal/` directories
3. **Build**: Run `make build` to rebuild the binary (required for frontend changes to be embedded)
4. **Test**: Run `make test` to verify changes
5. **Run**: Use `make run` or `make run-dev` to test locally

## API Endpoints

The webserver provides these endpoints:

- `GET /` - Serves index.html
- `GET /<file>` - Serves static files from public directory
- `GET /o/{cid}` - Get object by CID
- `POST /api/save` - Save a JSON-LD object and get its CID
- `DELETE /o/{cid}` - Delete object by CID (requires authentication)
- `GET /api/ownership/{cid}` - Check object ownership

## Authentication

- Uses Supabase JWT tokens for authentication
- Set `SUPABASE_JWT_SECRET` environment variable for JWT validation
- Authentication is required for DELETE operations

## Coding Conventions

### Go Code
- Follow standard Go formatting (use `go fmt`)
- Use standard Go project layout with `cmd/` and `internal/` directories
- Keep packages focused on single responsibilities
- Write tests for new functionality

### JavaScript/Frontend
- ES module syntax
- Web Components for UI encapsulation
- JSON-LD format for Petri net data (schema: https://pflow.xyz/schema)

## Dependencies

The project uses:
- `github.com/stackdump/tens-city` - Reference backend implementation for CID computation and storage
- `github.com/piprate/json-gold` - JSON-LD processing
- `github.com/golang-jwt/jwt/v5` - JWT validation
- IPFS multiformats libraries - For CID handling

## Important Notes

1. **Embedded Static Files**: The `public` directory is embedded into the binary at build time using Go's `embed` directive. Always rebuild after frontend changes.

2. **Build Before Test**: If you encounter "pattern all:public: no matching files found" errors, run `make build` first to copy the public directory.

3. **Data Storage**: Objects are stored in a filesystem-based store (default: `./data` directory)

4. **CID Compatibility**: The project uses IPFS CIDv1 with SHA2-256 for content addressing

## When Making Changes

- **Frontend changes**: Modify files in `public/`, then `make build` to embed changes
- **Backend API changes**: Update handler code in `cmd/webserver/`, add tests, rebuild
- **Storage/CID logic**: Changes in `internal/seal/` or `internal/store/` should include tests
- **Authentication**: Changes in `internal/auth/` require JWT validation tests
- **Documentation**: Update README.md for user-facing changes

## Best Practices

1. Keep the web component self-contained and framework-agnostic
2. Maintain JSON-LD schema compatibility for Petri net data
3. Ensure CID computation remains consistent with IPFS standards
4. Write tests for new functionality (except ethsig package which has dependency issues)
5. Use meaningful commit messages
6. Update documentation when adding features or changing APIs
