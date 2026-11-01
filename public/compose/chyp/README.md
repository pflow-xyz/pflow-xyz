# Chyp, for the Laws view

The composition views' Laws view (`../views/laws.js`) draws what Chyp itself decided about the four
theories in this directory, and re-checks them live in the browser with chyp-rs (`../laws-live.js`).

| Path | What | Licence |
|---|---|---|
| `*.chyp` | The four theories (orderer-monoid, filter-meet, driver-wrap, sync-spiders), copied unmodified from pflow-views-prototype `chyp/` at 91695ad. Their sha256s are the ones `../assets/chyp/index.json` records; the view recomputes them. | the prototype's (not chosen yet); `sync-spiders.chyp` contains the `frobL` / `frobR` proofs and the Frobenius axioms' presentation from Chyp's `examples/frobenius.chyp` (lines 37–49), Apache-2.0 |
| `LICENSE-chyp` | Chyp's `LICENSE`, the Apache License 2.0 full text, as in its checkout at 3d28483. | — |
| `../../vendor/chyp-rs-wasm/` | **chyp-rs**, https://github.com/stackdump/chyp-rs: an unofficial Rust port of the core of **Chyp** (https://github.com/akissinger/chyp, commit `3d2848361e261b07a86daaacf70b2b4b018affcf`, v0.5.2, Copyright (C) 2022–2023 Aleks Kissinger), as WebAssembly, vendored by `scripts/sync-chyp-wasm.mjs` and pinned by `chyp-rs-wasm.lock`. It ships with its own `LICENSE.txt`, `NOTICE.txt` and `THIRD-PARTY-NOTICES.txt`. Each ported source file in chyp-rs names the Chyp file it came from and what changed. chyp-rs is not affiliated with or endorsed by the Chyp project. | Apache License 2.0 |

**Where each thing on the page comes from.** The results and the diagrams shown are `../assets/chyp/*.json`, exported
from Chyp itself by `chyp_headless export` under CPython 3.14.4 (see `../assets/chyp/index.json` for versions and the
generation time), layouts included: Chyp's `convex_layout` needs cvxpy, and the port has no such solver, so the view
draws the exported coordinates. The live check is chyp-rs's, and the page says so. Its contract is Chyp's verdicts:

- chyp-rs's `tests/fixtures/pflow/` holds these theories verbatim, and its tests compare every part's status, every
  error and the rule names with what Python Chyp produced on them;
- `../laws-live_test.ts` runs the vendored bundle on them here and compares every rewrite and step with the export
  (33 rewrites: 30 proved, 3 must-fail controls fail).

Nothing is fetched from another host, and no Python runs in the browser. Until 2026-11 this view ran Chyp under
Pyodide from cdn.jsdelivr.net and lark from PyPI: `docs/compose-load-budget.md` has the before and after.
