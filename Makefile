.PHONY: all llm-eval build run clean test test-js test-parity ode-expected learn-goldens native-goldens game-goldens sync-native-wasm sync-composition-goldens test-publish test-npm-pack test-theme test-version publish

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
	@deno test --allow-read=parity/ode,parity/editor-shape,parity/fixtures,parity/clipboard,parity/ssa,parity/roles,parity/native,parity/composition-views,examples,testdata,public,pflow-native-wasm.lock public/petri-sim_test.ts public/petri-colors_test.ts public/petri-shape_test.ts public/petri-solver_test.ts public/petri-learn_test.ts public/petri-ssa_test.ts public/petri-sde_test.ts public/petri-validate_test.ts public/petri-commands_test.ts public/petri-files_test.ts public/petri-draft_test.ts public/petri-wasm_test.ts public/petri-chat_test.ts public/petri-goals_test.ts public/petri-refine_test.ts public/petri-roles_test.ts public/petri-clipboard_test.ts parity/ode/ode_expected_test.ts parity/native/native_parity_test.ts parity/native/js_vs_wasm_test.ts parity/composition-views/parity_test.ts public/compose/layout/hypergraph_test.ts public/compose/chyp/files_test.ts public/compose/laws-live_test.ts public/compose/engine_access_test.ts parity/composition-views/sources_test.ts

# Regenerate the differentiable-fitting parity goldens (parity/learn/goldens.json)
# from go-pflow's learn package. Deliberate, never a side effect of another
# target: the goldens are the contract public/petri-learn_test.ts replays.
learn-goldens:
	@go run ./parity/learn/gen
	@echo "regenerated parity/learn/goldens.json — run 'make test-js' to verify"

# Regenerate the native parity goldens: parity/native/goldens.json (the cases in
# parity/native/cases.json, for the wasm) and parity/native/mcp_goldens.json (the
# /mcp workbench and composition (pflow_bundle_*) tool calls in
# parity/native/mcp_cases.json), both run through pflow-native's registry
# natively (Rust, pinned in parity/native/gen/Cargo.toml to the commit the
# vendored wasm was built from). Deliberate, never a side effect.
# Needs cargo and network access to github.com (git uses the CLI so your
# credentials apply). The receipt case embeds a freshly signed receipt (and the
# store cases a clock), so those cases' goldens change on every run: commit only
# the cases you changed (parity/native/README.md, "Regenerating").
native-goldens:
	@CARGO_NET_GIT_FETCH_WITH_CLI=true cargo run --release --manifest-path parity/native/gen/Cargo.toml
	@echo "regenerated parity/native/goldens.json and mcp_goldens.json — run 'make test-js' and 'go test ./cmd/webserver/' to verify"

# Regenerate parity/native/game_goldens.json: pflow-native's game.value and
# game.move on the positions and plans of parity/native/game_cases.json (the
# /mcp game tools' parity suite, cmd/webserver/mcp_game_parity_test.go). The
# generator builds pflow-native at the commit pinned in
# parity/native/gen-game/Cargo.toml, which pins pflow-rs at PFLOW_RS_REV (the
# search the Go port follows, with the mtd_f driver and pflow_solver::game's
# ODE estimate); no patch is needed. To build against a pflow-rs checkout
# instead (e.g. main), name it:
#   make game-goldens PFLOW_RS=../pflow-rs
# The checkout's crates must be the code of PFLOW_RS_REV (a later commit that
# only touches docs is fine), or the goldens would not be what they record.
# Needs cargo and network access to github.com (for pflow-native). After
# editing game_cases.json's source, `python3 parity/native/gen-game/make_cases.py`;
# fixtures: `python3 parity/native/gen-game/make_fixtures.py <pflow-native checkout>`.
PFLOW_RS_REV := 35be80745784e9ed0375103bfc035ffcfcfaeb2c
game-goldens:
	@mkdir -p parity/native/gen-game/target
	@if [ -n "$(PFLOW_RS)" ]; then \
	  git -C "$(PFLOW_RS)" diff --quiet $(PFLOW_RS_REV) HEAD -- crates || { echo "$(PFLOW_RS)'s crates differ from pflow-rs $(PFLOW_RS_REV)"; exit 2; }; \
	  { echo '[patch."https://github.com/pflow-xyz/pflow-rs"]'; for c in compose core eventlog learn metamodel mining parser reachability solver validation verify; do echo "pflow-$$c = { path = \"$$(cd "$(PFLOW_RS)" && pwd)/crates/pflow-$$c\" }"; done; } > parity/native/gen-game/target/patch.toml; \
	  CARGO_NET_GIT_FETCH_WITH_CLI=true cargo run --release -q --config parity/native/gen-game/target/patch.toml --manifest-path parity/native/gen-game/Cargo.toml; \
	else \
	  CARGO_NET_GIT_FETCH_WITH_CLI=true cargo run --release -q --manifest-path parity/native/gen-game/Cargo.toml; \
	fi
	@echo "regenerated parity/native/game_goldens.json — run 'go test ./cmd/webserver/ -run TestMCPGameMatchesNative' to verify"

# Re-vendor the wasm shim from a pflow-native build (see scripts/sync-native-wasm.mjs):
#   make sync-native-wasm FROM=../pflow-native/target/wasm-shim COMMIT=<sha>
# then bump the rev in parity/native/gen/Cargo.toml to COMMIT, `make native-goldens`
# (it has no bundle.* or plan.* cases), `make sync-composition-goldens` (below, with the
# same COMMIT: parity/composition-views/parity_test.ts needs the goldens and the wasm from
# one pflow-native commit), `node scripts/gen-llm-tools.mjs` and `make test-js`.
sync-native-wasm:
	@test -n "$(FROM)" -a -n "$(COMMIT)" || { echo "usage: make sync-native-wasm FROM=<wasm-shim dir> COMMIT=<pflow-native sha>"; exit 2; }
	@node scripts/sync-native-wasm.mjs --from "$(FROM)" --commit "$(COMMIT)"

# Re-vendor the composition views' goldens (parity/composition-views/goldens.json + goldens.lock)
# from a pflow-native checkout, as committed at COMMIT (see scripts/sync-composition-goldens.mjs):
#   make sync-composition-goldens FROM=../pflow-native COMMIT=<sha>
# FROM is a git checkout (only read, with `git show`), not the wasm-shim dir. COMMIT is the one
# the vendored wasm was built from (pflow-native-wasm.lock); then `make test-js`. If the wasm lock
# names another commit the script exits 1 and writes nothing (parity_test.ts would fail on the
# pair); ALLOW_MISMATCH=1 (--allow-mismatch) vendors the goldens anyway, with a warning, for when
# the wasm is about to be re-vendored at COMMIT.
# FROM, COMMIT and ALLOW_MISMATCH reach the shell as exported variables ("$$FROM" below), never as
# text pasted into the command line, so a value with quotes, `;` or backticks is only a value.
sync-composition-goldens: export FROM := $(FROM)
sync-composition-goldens: export COMMIT := $(COMMIT)
sync-composition-goldens: export ALLOW_MISMATCH := $(ALLOW_MISMATCH)
sync-composition-goldens:
	@test -n "$$FROM" -a -n "$$COMMIT" || { echo "usage: make sync-composition-goldens FROM=<pflow-native checkout> COMMIT=<pflow-native sha> [ALLOW_MISMATCH=1]"; exit 2; }
	@node scripts/sync-composition-goldens.mjs --from "$$FROM" --commit "$$COMMIT" $${ALLOW_MISMATCH:+--allow-mismatch}

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

# Live prompt-quality eval for /api/llm/draft (opt-in, never in make test or CI):
# captures Gemini's replies to cmd/webserver/llm_eval_test.go's descriptions
# into testdata/llm/ and runs them through the browser's load gate.
#   make llm-eval GEMINI_API_KEY=...
llm-eval:
	@test -n "$(GEMINI_API_KEY)" || { echo "usage: make llm-eval GEMINI_API_KEY=..."; exit 2; }
	@PFLOW_LLM_EVAL=1 GEMINI_API_KEY="$(GEMINI_API_KEY)" go test ./cmd/webserver/ -run TestLLMEvalLive -count=1 -v | grep -v '^20[0-9][0-9]/'
	@node scripts/llm-eval.mjs testdata/llm/*.json
