# cdnjs submission (staged, not yet filed)

`pflow-xyz.json` is the package definition for
[cdnjs/packages](https://github.com/cdnjs/packages). It is staged here because
cdnjs's acceptance bar (from their CONTRIBUTING.md: **800+ npm downloads/month
or ~200 GitHub stars**, at maintainer discretion) is not met yet. File the PR
once it is.

Why cdnjs at all: `cdnjs.cloudflare.com` is the only external script origin
allowed inside claude.ai artifacts, so acceptance is what makes the solver
importable there.

## How to file

1. Fork `cdnjs/packages`, branch.
2. Copy `pflow-xyz.json` to `packages/p/pflow-xyz.json`.
3. Run their checker: `npm test` in the fork validates the JSON against the schema.
4. Commit message: `Add pflow-xyz w/ npm auto-update` (matches `autoupdate.source`).
5. Open the PR; a cdnjs maintainer reviews popularity and merges.

## Decisions already made

- **`autoupdate.source: npm`** — cdnjs mirrors each new `pflow-xyz` npm release
  automatically. The npm tarball ships exactly the runtime import graph and no
  site media, so the `fileMap` globs can't pick up junk.
- **`.mjs` is on the cdnjs extension whitelist** (checked against
  `https://api.cdnjs.com/whitelist` 2026-08-01: `js, mjs, ts, wasm, map, json,
  css, …`), so `seal-cid.mjs` and `vendor/jsonld.bundle.mjs` copy fine and
  `petri-view.js`'s full import chain works from cdnjs. No renames needed.
- **Minification left enabled** (no `optimization` key). cdnjs generates
  `.min.js` siblings alongside the originals; harmless. The **canonical
  documented URL is the unminified file** — the modules import each other by
  their unminified names (`./petri-colors.js`), so pointing docs at the
  originals keeps the whole loaded graph consistent, and the files are small
  enough (34KB solver) that minification buys little.
- **`filename: petri-solver.js`** — the default file cdnjs features. The
  solver is the artifact-sandbox use case; the editor component is secondary.

## Consumer URL shape (post-acceptance)

cdnjs serves no `latest` alias; every URL is version-pinned:

```
https://cdnjs.cloudflare.com/ajax/libs/pflow-xyz/<version>/petri-solver.js
```

Relative imports (`./petri-colors.js`, `./seal-cid.mjs`,
`./vendor/jsonld.bundle.mjs`) resolve against that same directory, so a single
import of `petri-solver.js` or `petri-view.js` pulls the rest of the graph
from cdnjs automatically.

After acceptance, fill in the placeholder URLs in `public/llms.txt` and
`public/llms-full.txt`.
