#!/usr/bin/env bash
# Offline checks for the showcase: every model parses, the theme's CID agrees
# between the Go and JS sealers, the browser simulator honours the theme's
# gates, and go-pflow loads the metamodel variations. Run from the pflow-xyz
# repo root. Julia and Rust checks run only when their toolchains are present.
set -euo pipefail
cd "$(dirname "$0")/../.."
d=examples/showcase
echo "== JSON well-formed"
for f in $d/*.json $d/*.jsonld $d/fixtures/*.json; do python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" && echo "   ok $f"; done
echo "== CID: Go sealer vs @id vs JS sealer"
go_cid=$(go run ./cmd/cidprobe $d/cafe.jsonld | cut -f1)
id=$(python3 -c "import json; print(json.load(open('$d/cafe.jsonld'))['@id'])")
[ "$go_cid" = "$id" ] || { echo "Go CID $go_cid != @id $id"; exit 1; }
node $d/cid.mjs
echo "== petri-sim.js replay"
node $d/replay.mjs
echo "== go-pflow direct"
go run ./$d/gocheck
if command -v julia >/dev/null && [ -d ../pflow-jl ]; then
  echo "== pflow-jl"; (cd ../pflow-jl && julia --project=. "$OLDPWD/$d/cafe.jl")
fi
if command -v cargo >/dev/null && [ -d ../pflow-rs ]; then
  echo "== pflow-rs DSL parse"
  tmp=$(mktemp -d); mkdir -p "$tmp/src"
  printf '[package]\nname="loyaltycheck"\nversion="0.1.0"\nedition="2021"\n[dependencies]\npflow-dsl={path="%s"}\n' "$(pwd)/../pflow-rs/crates/pflow-dsl" > "$tmp/Cargo.toml"
  printf 'fn main(){let s=pflow_dsl::parse_schema(include_str!("%s")).expect("parses");println!("{} states, {} actions",s.states.len(),s.actions.len());}\n' "$(pwd)/$d/cafe-loyalty.pflow" > "$tmp/src/main.rs"
  (cd "$tmp" && cargo run -q); rm -rf "$tmp"
fi
echo "all checks passed"
