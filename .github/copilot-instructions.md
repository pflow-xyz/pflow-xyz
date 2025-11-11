# Copilot Instructions for pflow-xyz

## Working with Copilot

This repository uses GitHub Copilot coding agent to assist with development tasks. When working on issues:

1. **Issue Assignment**: Copilot can be assigned to issues directly. Ensure issues have clear acceptance criteria.
2. **Pull Request Review**: After opening a PR, review the changes and mention `@copilot` in comments to request modifications or clarifications.
3. **Iterative Feedback**: Treat Copilot like a team member - provide specific feedback on changes that need adjustment.
4. **Code Review**: All Copilot-generated code must be reviewed by a human before merging.

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

**Testing Requirements**:
- **ALWAYS** run tests before committing changes: `make test`
- **ALWAYS** build the project before testing to ensure static files are embedded: `make build`
- Write tests for new functionality following the existing test patterns in the repository
- All tests must pass before a PR can be merged

**Note**: Some tests may fail if:
- The `public` directory hasn't been copied to `internal/static/public` (run `make build` first)
- Missing Ethereum dependencies for `internal/ethsig` package (this is a known issue - tests for this package may be skipped)

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
- **Linting**: Run `go fmt` on all Go files before committing
- **Error Handling**: Always check and handle errors appropriately
- **Documentation**: Add package and function comments following Go documentation standards

### JavaScript/Frontend
- ES module syntax
- Web Components for UI encapsulation
- JSON-LD format for Petri net data (schema: https://pflow.xyz/schema)
- Keep code compatible with modern browsers (ES6+)
- Avoid external dependencies where possible to keep the component lightweight

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

## Security Best Practices

When working on this repository:

1. **No Secrets in Code**: Never commit secrets, API keys, or authentication tokens to the repository
2. **JWT Validation**: Always validate JWT tokens using the configured `SUPABASE_JWT_SECRET` environment variable
3. **Authentication**: DELETE operations require authentication - ensure proper JWT validation is in place
4. **Input Validation**: Validate and sanitize all user inputs, especially in API endpoints
5. **CID Verification**: When working with CIDs, ensure proper validation to prevent path traversal or injection attacks
6. **Dependencies**: Review security advisories for Go dependencies periodically using `go list -m all`
7. **CORS**: Be mindful of CORS settings if modifying API endpoints
8. **File Operations**: Validate file paths to prevent directory traversal in storage operations

## When Making Changes

- **Frontend changes**: Modify files in `public/`, then run `make build` to embed changes into the binary
- **Backend API changes**: Update handler code in `cmd/webserver/`, add tests, rebuild and test
- **Storage/CID logic**: Changes in `internal/seal/` or `internal/store/` should include tests
- **Authentication**: Changes in `internal/auth/` require JWT validation tests
- **Documentation**: Update README.md for user-facing changes

### Change Validation Checklist

Before requesting review on a PR:

1. **Build**: Run `make build` and ensure it completes without errors
2. **Test**: Run `make test` and ensure all tests pass
3. **Format**: Run `go fmt ./...` to format Go code
4. **Functionality**: Manually test changed functionality if applicable
5. **Documentation**: Update relevant documentation if behavior changes
6. **Security**: Review changes for potential security issues
7. **Git**: Ensure no build artifacts or temporary files are committed (check `.gitignore`)

## Best Practices

1. Keep the web component self-contained and framework-agnostic
2. Maintain JSON-LD schema compatibility for Petri net data
3. Ensure CID computation remains consistent with IPFS standards
4. Write tests for new functionality (except ethsig package which has dependency issues)
5. Use meaningful commit messages that describe what changed and why
6. Update documentation when adding features or changing APIs
7. Keep PRs focused and small - address one concern per PR
8. Test edge cases and error conditions
9. Follow the existing code style and patterns in the repository
10. Ask questions if requirements are unclear - clarity before code

## Common Pitfalls to Avoid

1. **Forgetting to rebuild**: Always run `make build` after changing frontend files in `public/`
2. **Missing embedded files**: Running tests before building will cause "no matching files found" errors
3. **Breaking CID compatibility**: Changes to canonicalization or hashing will break existing CIDs
4. **Authentication bypass**: Ensure DELETE endpoints validate JWT tokens
5. **Ignoring test failures**: Don't assume existing test failures are unrelated without investigation
6. **Large commits**: Avoid committing `node_modules`, `bin/`, `data/`, or other build artifacts
