#!/bin/bash
# Verify the npm package as it would actually ship:
#   1. npm pack, extract, assert the import graph is complete and site media absent
#   2. run scripts/npm-smoke.mjs against the extracted package
#   3. install the tarball into a scratch package and resolve the exports map
# Skips (exit 0) when npm/node are not installed, mirroring the parity tests.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v npm >/dev/null || ! command -v node >/dev/null; then
  echo "npm-pack-test: npm/node not found, skipping"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

tarball="$(npm pack --pack-destination "$tmp" --silent | tail -1)"
tar -xzf "$tmp/$tarball" -C "$tmp"
pkg="$tmp/package"

# Every file in the runtime import graph must ship, or imports 404 at runtime.
required=(
  public/petri-solver.js
  public/petri-sim.js
  public/petri-colors.js
  public/petri-view.js
  public/petri-view.css
  public/diagram-viewer.js
  public/seal-cid.mjs
  public/vendor/jsonld.bundle.mjs
)
for f in "${required[@]}"; do
  [ -f "$pkg/$f" ] || { echo "FAIL: $f missing from tarball"; exit 1; }
done

# Site media must NOT ship.
banned=$(cd "$pkg" && find . -name '*.png' -o -name '*.webm' -o -name '*.mp4' -o -name '*.ico')
if [ -n "$banned" ]; then
  echo "FAIL: media leaked into tarball:"
  echo "$banned"
  exit 1
fi

node scripts/npm-smoke.mjs "$pkg"

# Prove the exports map resolves from a consumer's point of view.
# The package name is read from package.json so a rename cannot silently
# leave this test importing a stale specifier.
name="$(node -p "require('./package.json').name")"
scratch="$tmp/scratch"
mkdir -p "$scratch"
( cd "$scratch" \
  && npm init -y --silent >/dev/null \
  && npm install --silent --no-audit --no-fund "$tmp/$tarball" >/dev/null \
  && PKG="$name" node --input-type=module -e '
    import { createRequire } from "node:module";
    import { readdirSync } from "node:fs";
    const pkg = process.env.PKG;
    const require = createRequire(process.cwd() + "/x.js");

    const solver = await import(pkg);
    const sim = await import(`${pkg}/petri-sim.js`);
    if (typeof solver.solve !== "function") throw new Error(`${pkg}: solve export missing`);
    if (typeof sim.fire !== "function") throw new Error(`${pkg}/petri-sim.js: fire export missing`);

    // The web components must load outside a browser, not just in one.
    const view = await import(`${pkg}/petri-view.js`);
    const diag = await import(`${pkg}/diagram-viewer.js`);
    if (view.PetriView !== undefined) throw new Error("petri-view.js: expected undefined export without a DOM");
    if (typeof diag.translatePetriNet !== "function") throw new Error("diagram-viewer.js: translatePetriNet missing");

    // Anything that ships must be reachable through the exports map, or it is
    // dead weight in the tarball that consumers cannot import.
    const root = require.resolve(`${pkg}/package.json`).replace(/package\.json$/, "");
    const unreachable = readdirSync(root + "public")
      .filter(f => /\.(js|mjs)$/.test(f))
      .filter(f => { try { require.resolve(`${pkg}/${f}`); return false; } catch { return true; } });
    if (unreachable.length) {
      throw new Error(`ships but not in exports map: ${unreachable.join(", ")}`);
    }
    console.log(`ok: exports map complete, web components load under node (${pkg})`);
  ' )
