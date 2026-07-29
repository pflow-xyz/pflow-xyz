.PHONY: all build run clean test test-js test-parity

# Build the webserver
build:
	@echo "Copying public directory to internal/static..."
	@rm -rf internal/static/public
	@cp -r public internal/static/
	@echo "Building webserver..."
	@go build -o bin/webserver ./cmd/webserver
	@echo "Build complete: bin/webserver"

# Run the webserver
run: build
	@echo "Starting webserver on port 8080..."
	@./bin/webserver

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf bin/
	@rm -rf internal/static/public
	@echo "Clean complete"

# Run tests
test: test-js test-parity test-parity-behavior
	@go test ./...

# Run JavaScript tests
test-js:
	@deno test public/petri-sim_test.ts

# Cross-language behavioral parity: go-pflow engines vs the browser's JS engines.
# sim: lockstep discrete-firing walks over 200 seeded random models
#      (public/petri-sim.js vs go-pflow reachability)
# ode: Tsit5 trajectory agreement on fixed fixtures
#      (public/petri-solver.js vs go-pflow solver)
test-parity-behavior:
	@echo "Parity: petri-sim.js / petri-solver.js vs go-pflow..."
	@go test ./parity/sim/ ./parity/ode/ -count=1

# Cross-language CID parity: Go seal (internal/seal) vs JS seal (public/seal-cid.mjs)
# against the shared golden fixtures in parity/. Fails the build on any divergence.
# parity_check.mjs runs under node or deno; node is used here for portability.
test-parity:
	@echo "Parity: Go seal vs JS seal-cid.mjs (parity/golden.json)..."
	@go test ./internal/seal/ -count=1
	@node parity/parity_check.mjs

# Build and run with custom port
run-dev: build
	@echo "Starting webserver on port 3000 with hot reload..."
	@./bin/webserver -port 3000 -data ./data-dev

# Install dependencies
deps:
	@go mod download
	@go mod tidy

all: clean build
