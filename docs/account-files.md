# Account files: pflow-native's file-system writes, the web way

pflow-native writes to the user's disk: `file.save` takes a path, the
`export.*` commands write one when given, and the app keeps a data directory.
A web page has no disk. The editor asks for no File System Access either.
Instead, pflow.xyz saves over HTTPS to the signed-in user's own file space on
the server. Each account has its own space, and nothing is shared between
accounts.

> "We can allow saves over the network rather than allowing for direct file
> system access, and things will be saved based on their authenticated access
> for their account. Segregated just for each user." (Matt)

| Piece | Where |
|---|---|
| HTTP API | `cmd/webserver/files.go`: `/api/files` |
| Storage, names, limits | `internal/userfiles` |
| Commands | `public/petri-commands.js`: `file.save`, `file.open`, `file.list`, `file.get`, `file.write`, `file.delete`, `export.artifact {name}` |
| Menu and dialogs | `public/petri-view.js`: ☁️ Save to my account…, 🗂️ Open from my account… |
| Tests | `internal/userfiles/userfiles_test.go`, `cmd/webserver/files_test.go` (including the page's commands run by node against the handler), `public/petri-files_test.ts` |

## What pflow-native writes, and the web equivalent

This survey covers pflow-native at commit `1a44427`
(`crates/core/src/commands/*.rs`, `crates/core/src/{store,outbound,provenance,zk,auth,control_auth}.rs`,
`crates/app`, `crates/cli`). It lists every command that writes to the local
file system. The commands that only read a path are listed after them, because
on the web they read the same account files.

### Writes

| Native | What it writes | Web |
|---|---|---|
| `file.save {path?, rates?}` | The document as pflow.xyz JSON-LD, to `path` (or, with no `path`, the file the document came from), replacing whatever file is there without asking. | **`file.save {name, overwrite?}`** → `PUT /api/files/{name}`. The page always names the file: there is no implicit "current path", so a re-save is an explicit overwrite. `rates` does not apply, because on the web rates are part of the document. |
| `export.svg {path?}` | The net as SVG. | `export.svg` is pflow-native's own command, run in wasm. The page strips its `path` argument (`STRIP_ARGS`) and returns the SVG. **`file.write {name: "net.svg", content}`** saves that SVG. The id `export.svg` belongs to the wasm command, so a JS command cannot reuse it. |
| `export.artifact {format, id?, path?}` | A result as json, csv or svg. | **`export.artifact {id, format?, name, overwrite?}`**: the JS command (json or csv) saves to `name` instead of returning the text. An SVG of a result → `file.write`. |
| `export.png {id?, width?, path?}` | The net or a result rendered as a PNG. | **Not applicable in the page.** The web build cannot render PNGs (native's own `png_available` says so). The API still accepts `.png`, checked by its signature, so a client that can render one can store it. `file.get` reads a PNG back as base64, as `content_base64` (native's `export.png` calls its field `png_base64`). |
| `view.screenshot {path}` | A PNG of the app window. | **Not applicable.** The page is not a window it can capture, and the browser has its own screenshot tools. |
| `rnn.imitate` / `rnn.verify {labels}` | A JSONL cache of exact labels, read and then appended to. | **Not applicable yet.** The `rnn.*` commands are not in the wasm build. When they are exposed, the cache can be an account `.jsonl` file: read it with `file.get` and write it with `file.write`. `.jsonl` is in the extension list for this reason, and for event logs. Two gaps to close then: native's cache tolerates a cut-off last line, which the `.jsonl` check refuses, and a large cache can outgrow the 1 MiB file limit. |
| `store.put`, `store.delete`, `store.link`, `store.collection_create`, `store.collection_add`, `store.license`, `store.supersede`, `store.accept_migration`, `store.map_put` | The local content-addressed store, under `<data_dir>/store/`: `models/<cid>.jsonld`, the index, edges, collections and maps. | **Not applicable.** The web's content-addressed store is pflow.xyz itself (`POST /api/save`, `GET /o/{cid}`). Native reaches it with `remote.pflow.save`. `store.*` stays unexposed in the page (`NOT_EXPOSED` in `scripts/sync-native-wasm.mjs`). |
| `model.save`, `model.import`, `model.delete` | The model library. It is session state, and the app persists it in its eframe storage on exit, together with the document, its path, the systems and the settings. | **Not applicable here.** The library is session state that the page does not have yet (`NOT_EXPOSED`, "needs a persistent browser session"). A library entry is a net, so account files could back it later. `model.save`'s `{name, overwrite}` shape is the one `file.save` uses. |
| `auth.login` / `auth.logout` | `<data_dir>/credentials.json` (tokens, mode 0600). | **Not applicable.** The page signs in with GitHub OAuth. Its token stays in the browser and is never stored as a file. |
| `sim.receipt`, `provenance.key` | `<data_dir>/keys/receipt-ed25519.json`, the signing key, created on first use. | **Not applicable.** A receipt key must stay private to its holder. A key the server kept for the user would not be the user's key. These two commands stay unexposed in the page, and `provenance.verify_receipt` is exposed. |
| `zk.setup`, `zk.prove_fire`, `zk.prove_trace` | `<data_dir>/zk/<digest>/{proving,verifying}.key`, a key cache. | **Not applicable.** The browser has no proof system. `zk.*` stays unexposed. |
| (app launch, not a command) | `<data_dir>/control.json`: the control port's address and token. | **Not applicable.** The page has no control port. |
| (`pflow-native-cli mcp` screenshot) | A temporary PNG that the CLI reads back and deletes. | **Not applicable.** It is internal to the CLI. |

### Reads of a path (for completeness)

| Native | Web |
|---|---|
| `file.open {path}` | **`file.open {name, repair?}`** → `GET /api/files/{name}`. The net gets the same strict check as `file.load_json`, and loading it is one undo step. |
| `data.load_log {path}` | Read the log with `file.get {name}`, then pass `content` to `data.load_log {text}`. The page strips `path`. |
| `model.import {path}` | Not applicable, as for `model.*` above. |

**Added by the web, with no native counterpart** (native has the file system
itself): `file.list` (`GET /api/files`), `file.get` (read any of your files),
`file.write` (save text you already have) and `file.delete`.

### Ids

`file.save` and `file.open` keep pflow-native's ids because the semantics
match: a path becomes a name. `export.artifact` keeps its id, and `path`
becomes `name`. The page's registry already had these ids as JS commands, or
they were in `NOT_EXPOSED`. None of them is an exposed native id, so the
collision guard in `scripts/sync-native-wasm.mjs` passes. `file.open` and
`file.save` are still listed in its `NOT_EXPOSED` block ("reads or writes the
host"). That is harmless, because the check accepts an id that is a JS command
or listed there. The next run that edits `EXPOSED` should move them into the
"same id as a JS command" group.

## The API

All routes are under `/api/files` and are same-origin only. Every file route
needs `Authorization: Bearer <GitHub token>`, and only a token **this server's
own GitHub OAuth app issued** (the editor's sign-in) is accepted; see
[Who is signed in](#who-is-signed-in).

| Request | Answer |
|---|---|
| `GET /api/files/status` | `200 {enabled, limits, extensions, max_name}`, no sign-in needed and nothing about anyone. `enabled: false` when the server keeps no account files. The editor shows its two menu items only when this says enabled; a server without the route (a vendored copy of the editor) answers 404, which reads as off. `status` has no extension, so it can never be a file's name. |
| `GET /api/files` | `200 {files: [{name, size, modified, kind}], usage: {files, bytes}, limits: {max_file_bytes, max_files, max_total_bytes, max_root_bytes}}`, files sorted by name. An account that never saved has `files: []`. |
| `GET /api/files/{name}` | `200` with the file's bytes, its `Content-Type`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Content-Disposition: attachment`. A stored SVG never runs as a page. `404` if you have no such file. |
| `PUT /api/files/{name}` | The body becomes the file. `201 {name, size, modified, kind, created: true, usage}`. **`409` when you already have that name**, unless `?overwrite=true` (or `1`), which gives `200 {…, created: false}`. Any other `overwrite` value → `400`. |
| `DELETE /api/files/{name}` | `200 {deleted, usage}`. `404` if you have no such file. |

**Create vs. overwrite.** Saving under a name you already have is refused
unless the request says `overwrite`. This is pflow-native's `model.save`
contract (`{name, overwrite}`), and deliberately not native `file.save`'s,
which replaces any file at its path without asking: a desktop app has the
operating system's save dialog to confirm a replace, a page calling an API
does not. When the menu's save hits a `409`, it asks "Replace it?" and
resends with `overwrite`.

**Errors** are JSON: `{"error": "…"}`, plus details where useful (`limit`,
`used`, `what`, `extensions`).

| Status | When |
|---|---|
| 400 | Bad name, content that does not match its extension, bad `overwrite` |
| 401 | No token, a token that is not one of this server's OAuth app's (a personal access token, another site's GitHub token, this server's own MCP tokens), or one GitHub reports revoked: `"sign in to save: files are kept in your own account, and this request is not signed in"` |
| 403 | A cross-origin browser request; or a signed-in account that is not on `PFLOW_FILES_ALLOW` when that is set |
| 404 | No such file (also when another account has one by that name) |
| 405 | Wrong method (`Allow` header: `GET` on the list, `GET, PUT, DELETE` on a file) |
| 409 | The name exists and `overwrite` was not given |
| 413 | Over the per-file size (`limit` in the body). The body is read through a size-limited reader, and a declared `Content-Length` over the limit is refused unread. |
| 503 | GitHub could not be asked (`auth.ErrVerifierUnavailable`: network, timeout, 5xx, or a 403 rate limit). It fails closed: never anonymous, never a shared bucket, and never a sign-out. Also 503 when account files are off (no `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`). |
| 507 | Full: the account's file count (`what: "files"`) or total bytes (`what: "bytes"`), or the server's store-wide limit (`what: "server"`). It is the WebDAV quota status, chosen over 409 so that "name exists" stays unambiguous. |

### Names and kinds

A name is 1–100 ASCII characters: letters, digits, `.`, `_` and `-`. It starts
with a letter or digit, has no `..`, and ends in a known extension
(case-insensitive). The name is taken from the request path **as sent and
never decoded**. A valid name needs no escaping, so any `%` makes it invalid:
`..%2f`, `%2e%2e`, an encoded slash or backslash, `%00`. Even an over-escaped
`%61.json` is refused. Separators, a leading dot, NUL and anything outside
ASCII (so no look-alike slashes such as `∕` or `／`) cannot pass the
allowlist.

| Extension | Kind | Content check | Written by |
|---|---|---|---|
| `.json`, `.jsonld` | net | valid JSON | `file.save`, `export.artifact {format: json}` |
| `.svg` | svg | UTF-8 containing `<svg` (a sanity check, **not** a sanitizer: an SVG is only ever served back to its owner as an attachment under `default-src 'none'; sandbox`, and must stay so) | `file.write` (an `export.svg` result) |
| `.png` | png | PNG signature | API clients (the page renders no PNG) |
| `.csv` | csv | UTF-8 | `export.artifact {format: csv}`, `file.write` |
| `.jsonl` | jsonl | UTF-8, each non-blank line JSON | `file.write` (event logs, `rnn` label caches later) |
| `.txt` | text | UTF-8 | `file.write` |

### Limits

| Limit | Default | Environment |
|---|---|---|
| One file | 1 MiB (the same as `/api/save`, and nginx's default `client_max_body_size`) | `PFLOW_FILES_MAX_FILE_BYTES` |
| Files per account | 200 | `PFLOW_FILES_MAX_FILES` |
| Bytes per account | 20 MiB | `PFLOW_FILES_MAX_TOTAL_BYTES` |
| Bytes across every account | 1 GiB | `PFLOW_FILES_MAX_ROOT_BYTES` |
| Who may keep files | every signed-in account | `PFLOW_FILES_ALLOW` (comma-separated GitHub logins) |

Per-account limits alone would let many throwaway GitHub accounts fill the
disk pflow.dev shares with every other service, so a store-wide byte limit
caps them together. It is counted from disk on the first write after a start,
kept by every write and delete, and claimed before a write lands, so two
accounts saving at once cannot both pass it. `PFLOW_FILES_ALLOW` narrows
account files to named people, as `PFLOW_LLM_ALLOW` does for drafting.

Raising the per-file limit past 1 MiB also needs `client_max_body_size` on
the nginx vhost. Replacing a file counts the size change, not a new file, so an
overwrite is allowed at the file-count limit.

## Identity and storage

**The owner key is provider-qualified**: `github:<numeric GitHub user id>`.
It uses the numeric id, never the login, because a login can be renamed and
then taken by someone else. A test checks that a renamed login keeps its
files. `internal/userfiles.Owner{Provider, Subject}` validates the key:
the provider is `[a-z][a-z0-9]{1,15}` (no `:`) and the subject is 1–100 bytes
of printable ASCII.

**Layout**: `<data>/files/<hex(owner key)>/<name>`, where `<data>` is the
server's `-data` directory (`./data` by default). The owner directory is the
lower-case hex of `"github:12345"`. It is injective (hex is a bijection, and
the provider name has no `:`), needs no escaping, and is at most 234
characters. It is never the raw key. To find whose directory one is:
`echo <dir> | xxd -r -p`. Directories are created mode 0700 and files mode
0600.

**Safety.** Every file operation goes through an `os.Root` opened on the
owner's directory, so even a name that slipped past the allowlist could not
escape it. Symlinks and anything else that is not a regular file are never
listed, counted, read, replaced or deleted. Writes go to a temporary
`.tmp-<random>` file, are synced, then renamed into place. A reader sees the
old file or the new one, never a torn write, and a temp file a crash leaves
behind is removed by the next write after an hour. Writes and deletes are
serialised per owner, so the limits hold under concurrent saves. A test runs
40 parallel saves against a 5-file limit.

### Who is signed in

These files are private, so "has a GitHub token for this account" is not
enough: `GET api.github.com/user` (what `/api/save` and `/mcp`'s GitHub path
ask) answers for any token at all, including a personal access token or the
token some other "Sign in with GitHub" site holds for the same person. Account
files ask GitHub's app-bound **check a token** API instead
(`POST /applications/{GITHUB_CLIENT_ID}/token`, with the app's own client id
and secret as basic auth; `auth.GitHubAppVerifier`). It answers 404 for any
token this app did not issue, so only the editor's own sign-in opens the
files. The consequences, on purpose:

- A personal access token, a GitHub App token and another site's OAuth token
  get 401. So would a future pflow-native client with its own token: it should
  sign in through the same OAuth app (device flow), or with a pflow-issued
  token whose audience is account files (below).
- With no `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, account files are off
  (`/status` says disabled, the routes answer 503). That server cannot sign
  anyone in through the page anyway.
- A token holding a `.` (this server's MCP tokens `pfa.…`/`pfr.…`, any JWT)
  is refused locally, and never sent on to GitHub. GitHub tokens hold no `.`.
- The check is cached for 10 minutes per token (keyed by sha256(token)), with
  a 5 s timeout; failures are never cached. A revoked token keeps working for
  at most those 10 minutes. Unknown junk tokens are not cached either, so each
  one costs one call to GitHub, as on `/api/save` and `/mcp` today; nothing
  throttles that per client yet.

**The identity seam.** `cmd/webserver/files.go` asks a `fileAccountResolver`
(`func(*http.Request) (userfiles.Owner, error)`) who is calling. Today that is
`githubFileAccounts(verifier, allow)`, built on
`auth.NewCachingVerifier(auth.NewGitHubAppVerifier(id, secret))`. The GitHub id
must be canonical (a positive decimal, no leading zero), so `12` and `012` can
never be two owners. Tests inject a fake verifier.

**How it combines with PR #111** (merged: OAuth sign-in for `/mcp` with GitHub
or Google). This branch depends on nothing in it and adds no OAuth code; it
does not touch `mcp_oauth*.go`. The two agree on the key: #111's identities
are `mcpIdentity{Provider, ID}` with `Provider` "github" (numeric id) or
"google" (`sub`), and it stamps authors as `Provider + ":" + ID`, which is
exactly `userfiles.Owner{Provider, Subject}.Key()`. So a Google account can
get files later with no storage migration: another resolver, tried in front
of the GitHub one, returns `Owner{Provider: "google", Subject: sub}`, and that
owner gets its own directory; a GitHub identity reached either way is the same
`github:<id>` and the same files. What that resolver must **not** do is accept
#111's `pfa.` access tokens as they are: they are issued for `/mcp`
(audience `/mcp`, scope `pflow:save`) to any dynamically registered MCP
client, so honouring them here would hand every connector the person ever
approved to "save nets" the right to read and delete their private files. It
needs its own audience and scope (say `pflow:files`) and a browser sign-in
for the page (Google in the editor's sign-in menu), not the connector flow.

## Same-origin only

`handleCORS` reflects any `Origin` with credentials allowed. These routes never
call it, like `/api/llm/*`. With no `Access-Control-Allow-Origin`, a page on
another site can read no answer, and it cannot send the `Authorization` header
at all, because that needs a preflight these routes never pass. On top of
that, the handler refuses a browser's cross-origin request outright (403)
before anything is read or written:

- `Sec-Fetch-Site` decides when present. A page cannot forge it. `same-origin`
  passes; `cross-site` and `same-site` (another subdomain) are refused.
- Otherwise, an `Origin` header must name this host (`Host`: nginx passes the
  public host through). `X-Forwarded-Host` is not consulted: nothing in front
  of the server sets it, so a client could. `Origin: null` is refused.
- A request with neither header (curl, a script holding the editor's token) is
  not a page's request. Its token alone decides.

The token is a bearer header, not a cookie, so a request from another site
carries no credential by accident.

## The page

- **Menu** (backend mode, as on pflow.xyz, and only when `/api/files/status`
  says enabled): ☁️ **Save to my account…** asks
  for a name. It prefills the name last used, or the net's name plus `.json`,
  and runs `file.save`. On `409` it asks "Replace it?" and resends with
  `overwrite`. 🗂️ **Open from my account…** lists your files with your usage.
  Nets have **Open** (`file.open`, which offers a repaired load when the strict
  check finds errors), other files have **Download** (`file.get`), and every
  file has **Delete** (`file.delete`). Signed out, both items open a dialog
  that says **"Sign in to save"** and offers the GitHub sign-in.
- **Host**: the editor's command host passes `authToken: () => this._authToken`.
  `createHeadlessHost(model, {token, fetch, apiBase})` gives an agent or a test
  the same commands. Without a token, every account command refuses with
  `SIGN_IN_TO_SAVE` (code `unauthenticated`) and sends nothing.
- **Error codes** for a refused command: `unauthenticated` 401,
  `forbidden` 403, `not_found` 404, `conflict` 409, `too_large` 413,
  `unavailable` 503 or no network, `quota` 507, `invalid` 400. The message is
  the server's.
- **Downloads stay.** The existing download buttons (CSV, JSON, SVG) are
  unchanged.

**The Assistant does not get these commands.** They are in `EXCLUDED` in
`public/petri-tools.js`, so `public/llm-tools.json` is unchanged. A write to
someone's account is that person's decision, not the model's. A read would
send their saved files to the model provider. The chat's sandbox host also
carries no sign-in, so the commands would only refuse there. If this changes,
start with `file.list` and `file.get` behind an explicit confirmation, and
keep writes out.

## Operating it

- **State not in git**: `data/files/` on pflow.dev. Back it up with the rest of
  `data/` (plain files, so `cp -a` or `rsync` is fine; no SQLite).
- **Configuration**: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (already
  set for the editor's sign-in) turn account files on; the `PFLOW_FILES_*`
  variables above tune them.
- **nginx**: per the vhost template (`pflow-dev/pflow.xyz`; the live config on
  pflow.dev was not checked), no change is needed. Names ending `.json`,
  `.svg`, `.png` or `.txt` match the static-extension regex location, which
  beats the `/api/` prefix; `.jsonld`, `.csv`, `.jsonl` and `/status` take
  `/api/`. Both proxy to :8081 with `Host $host`, which the same-origin check
  compares an `Origin` with. One quirk: `/api/` 404s any URI containing
  `wp-`, `wordpress`, `xmlrpc` or `phpmyadmin`, so a file named like
  `swp-model.csv` cannot be reached through nginx. nginx's default 1 MiB body
  limit matches the per-file limit.
- **Logs**: `[files] …` lines for internal errors and the GitHub check (they
  name the owner key and the file), the server's request log line (which
  names the path, so file names appear in pflow.dev's logs), and one
  `Account files: …` line at startup with the limits.
- **Watch**: the size of `data/files/` (the store-wide limit is the backstop).
