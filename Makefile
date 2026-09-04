.PHONY: all build run clean test test-js test-parity ode-expected learn-goldens test-publish test-npm-pack test-theme test-version publish

# Build the webserver
build:
	@echo "Copying public directory to internal/static..."
	@rm -rf internal/static/public
	@cp -r public internal/static/
	@# Bazel build files are not web assets, and copying BUILD.bazel would make
	@# internal/static/public a Bazel subpackage, which breaks the embed target.
	@rm -f internal/static/public/BUILD.bazel internal/static/public/files.bzl
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
test: test-js test-parity test-parity-behavior test-publish test-npm-pack test-theme test-version
	@go test ./...

# Run JavaScript tests
test-js:
	@deno test --allow-read=parity/ode public/petri-sim_test.ts public/petri-colors_test.ts public/petri-solver_test.ts public/petri-learn_test.ts parity/ode/ode_expected_test.ts

# Regenerate the differentiable-fitting parity goldens (parity/learn/goldens.json)
# from go-pflow's learn package. Deliberate, never a side effect of another
# target: the goldens are the contract public/petri-learn_test.ts replays.
learn-goldens:
	@go run ./parity/learn/gen
	@echo "regenerated parity/learn/goldens.json — run 'make test-js' to verify"

# Regenerate the ODE parity trajectories (parity/ode/expected.json) from
# go-pflow's Tsit5 over parity/ode/fixtures.json. Same rule: deliberate only.
# pflow-rs carries a byte-identical copy under crates/pflow-solver/tests/fixtures/ode/
# — re-copy both files there after regenerating.
ode-expected:
	@go run ./parity/ode/gen
	@echo "regenerated parity/ode/expected.json — run 'make test-js' to verify"

# npm package verification: pack the tarball, extract it, assert the import
# graph ships and site media doesn't, smoke-test the solver from the extracted
# package, and resolve the exports map from a scratch install. Skips if npm is
# not installed (same policy as the node edge in the parity tests).
# Guard the design-token contract (see scripts/check-theme-tokens.py)
test-theme:
	@python3 scripts/check-theme-tokens.py

# The version shown in the hamburger footer is a literal in petri-view.js (no
# build step can inject it); keep it tied to package.json.
test-version:
	@python3 scripts/check-version.py

test-npm-pack:
	@./scripts/npm-pack-test.sh

# Publisher for cdn.stackdump.com (uses a temp blobs dir; touches no real state)
test-publish:
	@python3 publish/test_cdn.py

# Publish a page/model/dir to cdn.stackdump.com. Public URL is printed on success.
#   make publish SRC=examples/predator-prey.html
#   make publish SRC=./demo-dir ARGS='--tag ode --meta solver=tsit5 --draft'
# Add ARGS='--dry-run' to see the CID and generated index.md without writing.
publish:
	@test -n "$(SRC)" || { echo "usage: make publish SRC=<file-or-dir> [ARGS='--tag x']"; exit 2; }
	@python3 publish/cdn.py "$(SRC)" $(ARGS)

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

# ── Bazel (hermetic verification build; `make build` remains the ship path) ──

.PHONY: bazel-build bazel-test bazel-gazelle
bazel-build:
	@bazel build //...

bazel-test:
	@bazel test //...

# Regenerate BUILD.bazel files after adding/moving Go files. After adding or
# removing anything under public/, also regenerate public/files.bzl — it is the
# single list //public and //internal/static both read.
bazel-gazelle:
	@bazel run //:gazelle
