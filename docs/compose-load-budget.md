# Composition page: what it loads, what it should cost

`public/compose.html` is the page the models-first design would put in front of
visitors. This note records what it loads (measured, before and after the
changes of this branch), the budget we propose for it, how to measure it again,
and what the wasm costs and why. It answers review gap 12 (stale numbers, no
load budget). Numbers are from 2026-10-28, macOS arm64, headless Chrome 156,
the local `bin/webserver` on `127.0.0.1` (HTTP/1.1, no nginx in between), the
merge base `8d30d96` for "before".

## Claim check

The design (5.2, first risk row) says the wasm is "about 1.66 MB gzip". The
vendored `public/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz` is
**1,891,277 bytes** (1.89 MB, 1.80 MiB; the raw wasm is 8,544,501), 14 percent
more. The number has moved a lot because the build recipe has not been fixed:

| vendoring (git) | commands | raw wasm | gzip |
|---|---:|---:|---:|
| 64154b4 (phase 2) | 175 | 6,249,263 | 1,161,646 |
| 3f2bdce | 175 | 6,093,780 | 1,641,250 |
| e6bd14c | 177 | 6,514,927 | 1,195,111 |
| 14388f8 (bundle.\*, plan.\*) | 205 | 8,718,715 | 2,315,833 |
| 7b2e50d | 209 | 8,353,342 | 1,842,524 |
| bf82013 (main, game.\*) | 179 | 6,753,686 | 1,255,855 |
| f3da0ad (now, 1a13459) | 211 | 8,544,501 | 1,891,277 |

(`git log -p -- pflow-native-wasm.lock`.) Which recipe built which vendoring is
not recorded; the size follows the build, not the page. The old comment in
`cmd/webserver/wasm.go` ("about 6 MB raw, about 1.6 MB gzip") was stale too and
is fixed.

## How it is measured

`scripts/measure-compose-load.ts` (Deno, no dependencies; Chrome over the
DevTools protocol). Cold = a new Chrome profile; warm = a second tab of the
same profile after the first settled. Median of 3. Profiles:

| name | network | CPU |
|---|---|---|
| none | unthrottled | 1x |
| 4g | WebPageTest "4G": 9 Mbps down, 9 Mbps up, 170 ms | 4x slowdown |
| 3g | DevTools "Fast 3G": 1.6 Mbps down, 0.75 Mbps up, 562.5 ms | 4x slowdown |

KB in the tables is 1,024 bytes; MB in prose is 1,000,000 bytes. `4g` is the mid-range phone on a good connection; `3g` is its bad day. The
page's own marks (`performance.mark`) are `compose:shell` (tabs and a status
line drawn), `compose:registry-ready` (wasm instantiated, ontology facts and
the composition and plan opened) and `compose:ready` (first view drawn; this is
`body[data-ready]`, the page's ready signal). "Wire" is the encoded body Chrome
received, "decoded" what the page got. The "before" and "after" runs below were
taken back to back, profile by profile, on a machine that other builds were
loading heavily (load average above 100), so the unthrottled rows are noise;
the throttled rows are bound by the emulated link and are repeatable to about
10 percent.

## Before (merge base)

Cold, Fast 3G + 4x CPU: first paint 1.6 s (the static header), DOMContentLoaded
3.4 s, wasm instantiated 15.3 s, **first view drawn 33.2 s**. 4G + 4x CPU:
wasm instantiated 4.1 s, **first view drawn 9.5 s**. Unthrottled the page is
ready in about 0.3 s.

| cold, until the first view is drawn | requests | wire KB | decoded KB |
|---|---:|---:|---:|
| wasm (registry) | 1 | 1,847 | 8,344 |
| the ten view modules (12,743 lines) and what they import | 11 + 2 | 851 + 23 | same (not compressed) |
| connect-4.json | 1 | 302 | 302 |
| core modules (app, model, state, snap, ...) + petri-wasm.js + glue | 16 | 150 | same |
| css, html, favicon | 3 | 11 | 12 |
| **total** | **33** | **3,183** | **9,681** |

What the log shows (full request list in the appendix):

1. **Nothing third-party is requested at page start.** No Pyodide, no
   jsdelivr, no PyPI, no fonts, no Ace. `laws-live.js` is fetched (6 KB) and
   does nothing until the Laws view is drawn. The comment at the top of
   `laws-live.js` ("Nothing is loaded until the Laws view asks") is true; the
   guard test below holds it.
2. **The view JS waterfalls behind the wasm.** `loadViews()` ran after
   `await registry.init()`, and imported the ten modules one after another. On
   Fast 3G the wasm finished at 15 s and the views started at 16 s and ended
   at 30 s.
3. **The wasm fetch itself starts late.** html (0.7 s) -> `app.js` (1.4 s) ->
   `registry.js` -> `petri-wasm.js` -> `pflow_native_wasm.js` -> wasm: the wasm
   is the sixth request of a dependency chain, and its request leaves at 4.2 s on
   Fast 3G.
4. **Nothing but the wasm is cacheable.** Static files carry no ETag, no
   Last-Modified, no Cache-Control (`http.FileServer` over an embedded tree has
   no modification time), so a warm load fetched 31 of 32 requests again in
   full, 1,334 KB: 21.1 s to ready on Fast 3G. The wasm had `max-age=3600`,
   which also means that for up to an hour after a re-vendoring a visitor can
   run the new glue against the old wasm.
5. **JS and JSON are sent uncompressed in production.** `HEAD` on
   `https://pflow.xyz/compose/app.js` (nginx/1.24.0) answers `Content-Length:
   14891` and no `Content-Encoding` with `Accept-Encoding: gzip, br`;
   `compose.html` is gzip (nginx compresses text/html only), the wasm is gzip
   (the Go handler). connect-4.json is 302 KB raw, 9.5 KB gzip.
6. **The nine views the visitor has not opened cost 0.8 MB** of the 3.2 MB at
   page start, none of it needed to draw the first view.

What each view requests when first opened (same server, unthrottled; the
"before" run):

| view | new requests | third-party |
|---|---:|---|
| cospan, spiders, operad, string, flat, boundaries, lens, incidence, process | 0 | none |
| **laws** | **52, 24,391 KB (25 MB)** | cdn.jsdelivr.net x10 (23,695 KB), pypi.org x1 (5.4 KB), files.pythonhosted.org x2 (111 KB) |

The Laws view's live check, in order (one run; the sandbox's link to the CDN
varied by a factor of 2 between runs):

| step | host | what | KB |
|---|---|---|---:|
| Pyodide 314.0.7 | cdn.jsdelivr.net | pyodide.mjs 7, pyodide-lock.json 24, python_stdlib.zip 2,449, pyodide.asm.wasm 3,362, pyodide.asm.mjs 256, micropip wheel 109 | 6,207 |
| lark 1.3.1 | pypi.org, files.pythonhosted.org | simple index 5.4, wheel 111, metadata 0.9 | 117 |
| check (Chyp, 33 rewrites) | | runs in Pyodide: 0.4 to 1.4 s | |
| live layout | cdn.jsdelivr.net | cvxpy_base 640, numpy 2,862, **scipy 13,547**, clarabel 440 | 17,489 |

Load 2.3 s + check 0.4 s + layout 11.3 s = 14 s here, up to 41 s in another run
(Pyodide's load 9 s, layout 30 s). The layout step downloads 17,489 KB (72 percent
of the Laws view's bytes) to compute numbers that, in every run, **equal the
precomputed layout** the page already has (5,771 numbers, difference 0).
Recommendation below.

## What changed

1. **View modules are imported on first use** (`compose/app.js`
   `loadView`), the shown view first. The tab labels come from
   `compose/views-meta.js` (no imports; a test holds it equal to each module's
   `title` and `short`). A tab pressed while its module loads shows "Loading
   the X view..." and draws when the module arrives. The other nine are
   fetched together at low priority and imported one at a time when the
   browser is idle after the first view is drawn, so switching is instant and
   still works if the network goes (verified offline, below). A failed import,
   and a module with no default export, are kept as a view that says why
   (`compose/loader.js`; a missing default export used to leave `undefined` in
   the map, and the render waiting on it retried through microtasks for ever).
2. **The wasm and the shown view's module are fetched together.** A view reads
   the ontology facts (`model.js`, filled by `loadFacts()` from the registry)
   when its module is *evaluated* (`cospan.js` line 55: `linkStyle:
   LINK_STYLE_CITE`, a `let` that is `null` until then), so it must be
   evaluated after the registry is ready: the module is fetched with a runtime
   `<link rel=modulepreload>` (nothing in the html), evaluated by `import()`
   once the facts are in. (A plain `import()` in parallel with the wasm drew a
   `TypeError` in `repoOf(null)`, `sources.js`.)
3. **A shell is drawn at once**: the ten tabs and a `role=status` line in the
   stage ("Loading pflow-native's registry (wasm)..."). A tab, a key or a link
   during the load moves the selection in the order it happened and fetches that
   view's module; nothing renders before the registry and the view exist. The
   sequencing is `compose/loader.js` (`createStartup`, with the effects passed
   in), held by `parity/composition-views/loader_test.ts`: hash changes and keys
   before the registry is ready render nothing and the last one wins, the view
   is evaluated after the facts are loaded, the shell stops repainting once the
   registry is ready, and a registry that fails leaves the page still (the tabs
   and example buttons drawn disabled, the keys ignored, the error shown). Only
   the first view's module is fetched at the browser's priority; the ones asked
   for while loading (keys, tabs, links) are `fetchpriority=low`, so pressing
   1 to 9 during the load does not put nine modules (231 KB) in front of the
   wasm (measured below). This also fixes two defects of the review: the `hashchange` handler was
   registered before `views` existed (a hash change during load threw a
   TypeError in `renderTabs`), and `readHash` accepted any view id (a
   `#view=nope` hashchange left no tab active and wrote `view=nope` back); it
   now keeps the current view and the next write puts the real one back.
4. **Revalidation for every static file** (`cmd/webserver/static_assets.go`):
   a strong `ETag` and `Cache-Control: no-cache`, 304 on a match; JS, CSS,
   JSON, HTML, SVG, Python and `.chyp` (over 1 KB) are gzip-compressed once
   per file and kept. The files are not content-hashed, so `max-age` or
   `immutable` would let a visitor run new `app.js` with old views; `no-cache`
   makes the browser ask first and a deploy takes effect on the next load. The
   wasm moves from `max-age=3600` to the same (`wasm.go`). `Accept-Encoding` is
   read the RFC 9110 way (`chooseEncoding`): tokens in any case, `*`, q-values
   ranking the codings (a bad q, or 0, 00, `Q=0`, means not accepted), `identity`
   when the client prefers it. A request with a `Range` header gets the file as
   it is from `http.FileServer` (206, `Accept-Ranges`, `If-Range` judged against
   the identity ETag), never the whole gzip body; the wasm, which is stored
   compressed, ignores `Range` (200 with the whole body in the negotiated
   coding, and `Accept-Ranges: none`; nothing in the page ranges over it).
5. **Brotli for the wasm** (`wasm.go`, `scripts/sync-native-wasm.mjs`,
   `pflow_native_wasm_bg.wasm.br`): 1,254,525 bytes against 1,891,277 gzip
   (-33.7 percent). Served to a client that sends `Accept-Encoding: br`
   (browsers do over https; the `.gz` stays for the rest and is the fallback).
   The lock records the `.br`'s sha256 and size, and `petri-wasm_test.ts`
   checks that it decodes to the wasm the lock names.
6. **Laws**: still lazy (nothing changed in what is fetched or when). Its
   status line now tells what is coming ("about 6.5 MB for Pyodide and lark,
   then about 18 MB more for the live layout"), the stages are announced in a
   persistent `role=status aria-live=polite` region (`compose/announce.js`; the
   stage is rebuilt on every redraw, a region inside it would be replaced), and
   a failure shows its last line, not a Python traceback (the whole error goes
   to `console.warn`). A failed check or layout leaves a **Retry the live
   check** button in the status bar (a real button; the run is reset, the retry
   announced, focus moved to the new bar), which fetches again; Chrome does not
   keep a failed `import()` of Pyodide, so a retry after the CDN is back works.
   `py.loadPackage(['cvxpy-base', 'clarabel'])` does not throw when those wheels
   are blocked (it logs a warning per package and resolves, and Chyp then
   exports topology only), so the layout step checks `py.loadedPackages` and
   that every export says `layout.used = 'chyp'`, and fails saying which
   package did not load; the page then says "The live layout could not run (...);
   the precomputed layout is the one shown", never "the live layout is drawn".
7. `performance.mark` calls, `window.__pv.loadView`, and two test files in
   `make test-js`: the guard test (`parity/composition-views/load_budget_test.ts`:
   the static import graph, and `compose.html` itself, which may name no other
   host than `https://pflow.xyz` in any attribute that fetches, nor in an inline
   script or style) and the start-up test (`loader_test.ts`).

## After

Same server build, same profiles, back to back with the "before" runs.

| | before | after |
|---|---:|---:|
| **cold, Fast 3G + 4x CPU: first view drawn** | 33.2 s | **14.4 s** |
| cold, Fast 3G: shell drawn (tabs + status line) | n/a (nothing) | 3.6 s |
| cold, Fast 3G: wasm instantiated | 15.3 s | 13.2 s |
| cold, Fast 3G: main-thread long tasks | 4.1 s | 1.2 s |
| **cold, 4G + 4x CPU: first view drawn** | 9.5 s | **4.0 s** |
| cold, 4G: shell drawn | n/a | 1.3 s |
| **warm, Fast 3G + 4x CPU: first view drawn** | 21.1 s | **6.1 s** |
| **warm, 4G + 4x CPU: first view drawn** | 6.4 s | **2.4 s** |
| cold, wire KB until the first view is drawn | 3,183 (33 requests) | **1,310** (21) |
| cold, wire KB including the idle import of the other nine views | 3,183 | 1,569 (35) |
| warm, KB re-fetched | 1,334 (31 of 32 in full) | **0 body bytes**: 34 revalidations (304), 6.3 KB of headers |
| decoded KB (what the page parses) until the first view | 9,681 | 8,874 |
| third-party requests at page start, on any view but Laws | 0 | 0 |

Measured again after the review fixes (start-up sequencing moved to
`compose/loader.js`, the Accept-Encoding and Range changes), on a machine that
was not loaded, median of 3, same profiles: cold Fast 3G + 4x CPU first view
drawn 12.0 s (shell 3.7 s, wasm instantiated 11.8 s), cold 4G 3.5 s, warm Fast
3G 5.4 s, warm 4G 2.4 s; cold wire bytes until the first view 1,312 KB in 22
requests (1,573 KB in 36 with the idle import of the other nine views); warm 35
revalidations (304), 0 body bytes. The timings above were taken back to back
with the "before" runs on a loaded machine (the reviews, on a quiet one, saw
11.8 s and 3.7 s for the same two cold cells), so the budget's margins stand;
the bytes did not move.

By group, cold, until the first view is drawn (wire KB): wasm 1,225 (was
1,847; the 1,254,525-byte `.br`), the shown view 29, core modules and glue 43,
connect-4.json 9.5, css and html 3, favicon 1. The other nine views and what
they import, fetched after the first view is drawn: 259 KB gzip (was about 900
KB uncompressed, before the first view).

Keys pressed while the page loads (cold, Fast 3G + 4x CPU, keys `1` to `9`
pressed as soon as the shell is drawn, median of 3, local HTTP/1.1 server):

| | wasm download ends | first view drawn | view modules fetched before it |
|---|---:|---:|---:|
| no key | 11.6 s | 11.9 s | 1 |
| keys 1 to 9, before this change (every key fetched its view) | 12.7 s | 13.0 s | 9 |
| keys 1 to 9, now (the last view, once the selection holds still, low priority) | 11.6 s | 11.8 s | 2 |

A low `fetchpriority` alone is not enough on HTTP/1.1, where a priority does not
hold back the other requests (it gained 0.35 s, 12.4 s); the 300 ms wait is what
keeps the nine modules off the wasm. A single key press, or a deep link
(`#view=lens`, about 30 KB), still fetches its view beside the wasm.

Checked in a real browser (headless Chrome, zero console errors, exceptions
and failed requests on load):

- A deep link `#view=lens&ex=orders` loads `lens.js` and `lens-orders.js`
  first and draws that view; the number keys `1`..`9` and `e` work; a
  `hashchange` to `#view=nope` keeps the view and rewrites the hash; a hash
  change and a key pressed while the page is still loading are applied in
  order (the later one wins).
- With one view module blocked, its tab is marked broken, the panel says
  `View spiders failed to load: ...`, and the other views still work.
- Only the shown view's module is evaluated before the first render. The
  third-party requests before the Laws view is opened: none, including after
  the idle import has evaluated `laws.js` (it is the dynamic import inside
  `pyodide()` that fetches Pyodide, and it runs on the first `check()`).
- Laws: opens, announces its stages, runs Chyp's checker live (33 of 33
  rewrites agree), and draws the live layout (equal to the precomputed one),
  with no console error. With `cdn.jsdelivr.net` blocked: one browser-reported
  network error, no exception, the status line says "The live check did not
  run (Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/...)"
  and the precomputed result stays. With PyPI blocked: "ValueError: Can't fetch
  metadata for 'lark'..." (it was the full 25-line traceback). With the
  network gone after the page loaded: every view still switches (they were
  imported when idle); Laws then cannot fetch its `assets/chyp/*.json`, as
  before.
- Laws, with only `*cvxpy*` and `*clarabel*` blocked (what `loadPackage` does
  not throw on): the bar says "The live layout could not run (cvxpy-base and
  clarabel did not load: their files could not be fetched from
  cdn.jsdelivr.net); the precomputed layout is the one shown", the live region
  says the layout did not run (it used to say "the live layout is drawn"), and a
  **Retry the live check** button is there; with the requests unblocked,
  focusing the button and pressing Enter ends on "Shown: the live result" (also
  after `cdn.jsdelivr.net` was blocked: Chrome does not keep the failed
  `import()`), no console error. The failure is one `console.warn` line of the
  whole error.
- With the wasm blocked: "The registry did not load: ...", the ten tabs and the
  two example buttons drawn disabled, the keys `7`, `3`, `e` and a hash change
  do nothing.

### Not done in this branch: two lines in the page's `<head>` (the disco builder's file)

The wasm download only starts after five dependent round trips (finding 3).
Adding to `public/compose.html`:

```html
<link rel="preload" href="vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm" as="fetch" crossorigin>
<link rel="modulepreload" href="vendor/pflow-native-wasm/pflow_native_wasm.js">
```

starts it with the html (measured on a throwaway copy of this branch): the wasm
fetch starts at 0.8 s instead of 4.3 s, **first view drawn 14.4 s -> 9.8 s on
Fast 3G, 4.0 s -> 2.5 s on 4G, warm 6.1 s -> 4.9 s on Fast 3G**. Worth adding
when the head is merged.

## Budget

For `compose.html` on a mid-range phone (profile `4g`: 9 Mbps, 170 ms, 4x CPU;
`3g` is the floor) as of this branch. Re-measure with the commands below; no CI
gate, because timings are noise on shared machines. The static guard test is
the part that fails a build.

| what | budget | now |
|---|---|---|
| cold, first view drawn, 4G + 4x CPU | 5 s | 4.0 s |
| cold, first view drawn, Fast 3G + 4x CPU | 16 s (10 s with the two head hints) | 14.4 s |
| cold, shell drawn, Fast 3G | 4 s | 3.6 s |
| cold, wire bytes until the first view | 1,500 KB | 1,310 KB |
| cold, wire bytes including the other nine views | 1,800 KB | 1,569 KB |
| warm, body bytes re-fetched | 0 (304s only) | 0 |
| warm, first view drawn, 4G + 4x CPU | 3 s | 2.4 s |
| third-party requests before the Laws view is opened | 0 (the guard test) | 0 |
| the Laws view's live check, bytes | 6,500 KB | 6,324 KB |
| the Laws view's live layout, bytes | not in the budget: opt in | 17,489 KB |
| the wasm, wire | 1,300 KB (brotli) | 1,225 KB |

**Offline** is not a target: the page is not a PWA (no service worker), and
`no-cache` files cannot be reloaded offline. After it has loaded, the ten
views work offline (see above); Laws' live check and data do not.
**Mobile**: the profile above is the target; the page lays out at phone width
(a11y builder's work), the drag interactions need a pointer (not a load
matter).

## The wasm: how it is built, and what it could weigh

Built in pflow-native (read at `1a13459`, the vendored commit; nothing here
changes that repository or the vendored binary): `make wasm-shim` runs
`cargo build --profile wasm-release -p pflow-native-wasm --target
wasm32-unknown-unknown`, then `wasm-bindgen --target web --out-dir
target/wasm-shim`, then prints `gzip -9` size. The root `Cargo.toml` has

```toml
[profile.wasm-release]
inherits = "release"
opt-level = "s"
lto = true
codegen-units = 1
```

No `panic`, `strip`, `debug` setting (wasm32-unknown-unknown aborts on panic
anyway); no `wasm-opt` step anywhere (neither the Makefile nor the sync script
runs one; `wasm-opt` and `wasm-strip` are not installed here, so nothing below
is a wasm-opt measurement). The sync script's header still said
`CARGO_PROFILE_RELEASE_OPT_LEVEL=z`; it is corrected to the profile above
(opt-level "z" and "s" are different recipes; which one built each vendoring
in the table above is not recorded).

What is in the vendored 8,544,501 bytes (section sizes, parsed from the
decompressed file):

| section | bytes | share |
|---|---:|---:|
| code | 4,173,261 | 48.8% |
| **custom `name`** (function names, debugging only) | **3,260,781** | **38.2%** |
| data | 1,092,008 | 12.8% |
| everything else (types, imports, exports, tables, `producers`, `target_features`) | 18,451 | 0.2% |

Compressed sizes of the vendored module, and of the same module with the
`name` and `producers` sections removed (only these two rows' sections
differ; measured with Node 23's zlib, `brotli` 1.1.0 gives the same
1,254,525 / 1,108,030):

| | raw | gzip -9 | brotli q11 (16 MB window) |
|---|---:|---:|---:|
| vendored | 8,544,501 | 1,891,277 | **1,254,525** (-33.7% vs gzip) |
| without `name` + `producers` | 5,283,606 (-38%) | 1,599,037 (-15.5%) | **1,108,030** (-41.4% vs today's gzip) |

So, in order of effort:

1. **Serve brotli** (done here): -637 KB, no change to pflow-native.
2. **Drop the `name` section in pflow-native**: `strip = "symbols"` in
   `[profile.wasm-release]`, or `wasm-bindgen --remove-name-section
   --remove-producers-section`. Another -147 KB brotli / -292 KB gzip, and it
   is also 3.3 MB less to decompress and hold.
   Cost: wasm stack traces show `wasm-function[123]` instead of Rust names.
   Not measured on a rebuild; the numbers above are the vendored file with the
   section cut out. For the owner and the pflow-native run.
3. **`wasm-opt -Oz`** after `wasm-bindgen`: typically 5 to 15 percent off the
   code section on Rust output; not measured here (not installed), so an
   estimate only. Worth one measurement when binaryen is at hand.
4. `opt-level = "z"` instead of "s", and trimming what the page does not use
   (`serde_json` `preserve_order`, ed25519 provenance, the pflow-metamodel
   search that only `game.*` needs): not measured, builds in pflow-native.

The Go side: `Accept-Encoding` is passed through by nginx (the production
wasm answers gzip to a client that asks gzip), so a client that asks br gets
the `.br` (unless it ranks gzip higher). Browsers send `br` over https; Chrome
also sends it to loopback http (`127.0.0.1`: it sent `gzip, deflate, br, zstd`,
Chrome 156), which is how this was measured, and leaves it out for plain http
on another host (`--accept-br` of the measure script adds it). Chrome also
offers `zstd`, which the server does not serve: a `.wasm.zst` is a possible
follow-up (zstd compresses a little less than brotli q11 but decodes faster);
no code here.

## Recommendations that need a decision (not done)

- **Make the Laws view's live layout opt-in** (a button; the 17,489 KB, 72
  percent of the view's bytes, 11 to 30 s) or self-host Pyodide's packages. It
  reproduces numbers the page already has, and the review's privacy gap
  (visitor IPs to jsdelivr/PyPI) is about exactly these fetches. Left as is:
  it changes what the Laws view claims ("the layout drawn is the live one").
- The two `<head>` lines above.
- Strip the `name` section in pflow-native (item 2).
- A `Content-Security-Policy` that names the three third-party hosts would turn
  the guard test's promise into the browser's.

## Re-measure

```sh
make build
./bin/webserver -port 8135 -data /tmp/pflow-data &

# the table above: cold and warm, three profiles, median of 3 (about 6 minutes)
deno run -A scripts/measure-compose-load.ts --url http://127.0.0.1:8135/compose.html

# one profile, every request of the first cold run, what each view requests
deno run -A scripts/measure-compose-load.ts --profiles 4g --runs 1 --list --views
```

It needs Chrome (`CHROME=...` overrides the path), and the internet for the
Laws row of `--views` (Pyodide and PyPI). The guard test: `make test-js` (or
`deno test --allow-read=parity/composition-views,public,pflow-native-wasm.lock
parity/composition-views/load_budget_test.ts`). To see the wasm forms:

```sh
curl -sI -H 'Accept-Encoding: br'   http://127.0.0.1:8135/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm
curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1:8135/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm
```

After re-vendoring pflow-native: `node scripts/sync-native-wasm.mjs --from ...
--commit ...` writes the `.gz`, the `.br` and the lock; `node
scripts/sync-native-wasm.mjs --brotli-only` makes just the `.br` from the
vendored `.gz` (it checks the decompressed bytes against the lock first).

## Appendix: every request of the first cold run (unthrottled)

Before (merge base): `wire B` is the encoded body, `-` means no header.

| start ms | end ms | wire B | decoded B | enc | cache-control | etag | url |
|---:|---:|---:|---:|---|---|---|---|
| 0 | 1 | | 2,012 | - | - | n | /compose.html |
| 23 | 38 | 8,619 | 8,619 | - | - | n | /compose/compose.css |
| 23 | 38 | 14,891 | 14,891 | - | - | n | /compose/app.js |
| 40 | 48 | 4,093 to 22,996 | same | - | - | n | 11 core modules: registry, model, state, snap, inspect, dom, theme, info, sources, ctx, manifest (84 KB) |
| 47 | 49 | 18,746 | 18,746 | - | - | n | /petri-wasm.js |
| 77 | 84 | 19,006 | 19,006 | - | - | n | /vendor/pflow-native-wasm/pflow_native_wasm.js |
| 87 | 119 | 1,891,753 | 8,544,501 | gzip | public, max-age=3600 | n | /vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm |
| 94 | 95 | 1,066 | 1,066 | - | - | n | /favicon-32x32.png |
| 180 | 184 | 309,653 | 309,653 | - | - | n | /compose/assets/connect-4.json |
| 180 to 230 | to 235 | 851,000 | same | - | - | n | the ten view modules, from `cospan.js` (94,460) to `string.js` (115,066), sequentially |
| 196 | 198 | 23,242 | 23,242 | - | - | n | /diagram-viewer.js (imported by string.js) |
| 233 | 235 | 32,000 | same | - | - | n | /compose/layout/hypergraph.js (25,531), /compose/laws-live.js (6,447) |

After: every response has `Cache-Control: no-cache` and an `ETag`.

| start ms | end ms | wire B | decoded B | enc | url |
|---:|---:|---:|---:|---|---|
| 0 | 1 | | 2,012 | gzip | /compose.html |
| 4 | 32 | 2,578 | 8,619 | gzip | /compose/compose.css |
| 5 | 56 | 6,645 | 18,394 | gzip | /compose/app.js |
| 57 | 64 | 599 to 7,674 | | gzip | 13 core modules and `petri-wasm.js` (6,172) |
| 75 | 80 | 29,987 | 94,460 | gzip | /compose/views/cospan.js (the shown view) |
| 76 | 80 | 9,718 | 309,653 | gzip | /compose/assets/connect-4.json |
| 77 | 80 | 4,451 | 19,006 | gzip | /vendor/pflow-native-wasm/pflow_native_wasm.js |
| 81 | 137 | 1,254,525 | 8,544,501 | br | /vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm |
| 278 | 286 | 19,944 to 36,154 | | gzip | the other nine views (idle import, after the first view is drawn) |
| 377 | 384 | 979 to 9,889 | | | diagram-viewer.js, lens-orders.js, hypergraph.js, laws-live.js, announce.js (their imports) |
