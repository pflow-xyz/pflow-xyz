# Chyp, for the Laws view

The composition views' Laws view (`../views/laws.js`) runs Chyp's own checker
in the browser, under Pyodide (`../laws-live.js`), on the four theories in this
directory. This directory holds what that run needs.

| Path | What | Licence |
|---|---|---|
| `*.chyp` | The four theories (orderer-monoid, filter-meet, driver-wrap, sync-spiders), copied unmodified from pflow-views-prototype `chyp/` at 91695ad. Their sha256s are the ones `../assets/chyp/index.json` records; the view recomputes them. | the prototype's (not chosen yet, see below); `sync-spiders.chyp` contains the `frobL` / `frobR` proofs and the Frobenius axioms' presentation from Chyp's `examples/frobenius.chyp` (lines 37–49), Apache-2.0 |
| `py/chyp/` | **Chyp**, https://github.com/akissinger/chyp at commit `3d2848361e261b07a86daaacf70b2b4b018affcf` (v0.5.2), without its empty `py.typed` marker (nginx on pflow.dev refuses the extension, and `laws-live.js` stops at the first file it cannot fetch): the non-GUI modules only, **unmodified** (`chyp/*.py`, `chyp/tactic/*.py`, `py.typed`). Left out: `chyp/gui/` and `chyp/__main__.py`, the only modules that import Qt. | Apache License 2.0, Copyright (C) 2022–2023 Aleks Kissinger (the years in Chyp's source headers). Full text: `LICENSE-chyp`. Chyp ships no NOTICE file at 3d28483. |
| `py/chyp_headless/` | The prototype's headless API over Chyp (pflow-views-prototype `chyp_headless/` at 91695ad, tests left out): it imports Chyp at run time and copies no Chyp code. | the prototype's own licence is not chosen yet (pflow-views-prototype README, "Third-party notices") |
| `files.json` | The list `laws-live.js` writes into Pyodide's file system, with sha256s. | — |
| `LICENSE-chyp` | Chyp's `LICENSE`, the Apache License 2.0 full text, as in the checkout at 3d28483. | — |

Pyodide 314.0.7 is loaded from `cdn.jsdelivr.net` and lark 1.3.1 from PyPI (through
micropip) at run time, only when the Laws view is opened; neither is vendored here.
The layout run also loads Pyodide's `cvxpy-base` and `clarabel` packages.

The precomputed results the view shows first are `../assets/chyp/*.json`, exported by
`chyp_headless export` under CPython 3.14.4 (see `../assets/chyp/index.json` for
versions and the generation time). The live check was verified to match them: all
33 rewrites' verdicts equal CPython's (30 proved, 3 must-fail controls fail), and the
live `export()` layouts equal the precomputed ones number for number.
