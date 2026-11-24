# Tab push: a Claude session drives an open pflow.xyz page

Status: on main. On by default on the server (`PFLOW_TAB_PUSH=0` turns it off); a page offers the link only with the
IDE shell on (`?shell=1`, docs/ide-shell.md), which is also what the teaching verbs below drive.

A Claude client connected to `/mcp` can list the pflow.xyz pages its signed-in person has open, push a net or a
view into one, read back what the page shows, and clear it. The person keeps chatting in one window and watches the
canvas in another. This is BeatScript's MCP-to-display setup (`beatscript/crates/beatscript-serve`, `hub/`,
`mcp/tools.rs`: eval, load, get, stop, devices, push_private, queue) carried over to pflow.

## What BeatScript does, and what pflow takes from it

| BeatScript | pflow |
|---|---|
| A page registers a session: `POST /api/session` returns `{id}`; the session is owned by the signed-in account (cookie, bearer or device signature). | `POST /api/tab` returns `{id, user}`. The owner is the account key `provider:subject` that `/api/files` already uses (`github:<numeric id>`). **A tab needs a signed-in page**; BeatScript's anonymous sessions are dropped, because an anonymous tab could be driven by anyone who guessed its id. |
| The page listens on `GET /api/session/{id}/events` (SSE) and `POST`s `report` (what it shows) and `reply` (answer to a `get`). | Same three routes under `/api/tab/{id}/`. The stream is SSE framing over `fetch` (not `EventSource`), because pflow's sign-in is a bearer token and `EventSource` cannot send one. Frames are `event: <type>\ndata: <json>\n\n`, with a 20 s `ping`. |
| MCP `eval`/`load`/`stop` push an event to the caller's live tabs (one named by `session`, else all); the answer says how many pages received it. | `pflow_show` / `pflow_tab_stop`, same `tab` argument and same count. |
| MCP `get` returns the last report; if it is older than 1.5 s the hub pushes `{type:"get", request_id}` and waits up to 3 s for the page's `reply`. | `pflow_tab_get`, same round trip and the same two constants (`STATE_FRESH`, `GET_WAIT`). |
| MCP `devices` lists paired phones; pairing is a QR code claimed by the phone. | `pflow_tabs` lists open tabs. There is no pairing step: the page proves the account with its own bearer token when it registers, and the MCP caller proves the same account through OAuth. **The account is the pairing.** Both sides must resolve to the same `provider:subject`. |
| MCP OAuth (`oauth.rs`): the tools need a token, the first call answers 401 with `WWW-Authenticate`. | pflow already has this (`mcp_oauth.go`, PKCE, GitHub or Google). The four tab tools join `mcpProtectedTools`, so a connector is asked to sign in on first use. A Google-only MCP identity has no tab, because pflow's page signs in with GitHub only; `pflow_tabs` says so rather than listing nothing silently. |
| `load` sends a stored program by CID (public). `eval` sends the text (not stored). `push_private` seals text for one phone and keeps nothing. | `pflow_show` with `cid` is a **public** push: the net is a stored one and the tab opens it by that address. `pflow_show` with `net` is a **private** push: the net travels in the event, is held in memory only for delivery, is never stored, never given a CID, never logged, and a tab that is not connected receives nothing (no queue). The server logs only the event's size and the tab id. |
| `queue` (up next). | Not carried over. A queue makes sense for audio that plays through; a net on a canvas has no "next". |
| Caps: 20 sessions per user, 5000 total, 4 streams per session, 40 streams per address, 256 KiB report, 128 MiB report budget, 10 min idle TTL. | Same numbers (`internal/tabhub`), except the total report budget, which is 32 MiB: pflow's reports are small. |

## Protocol

Events sent to a tab (`GET /api/tab/{id}/events`):

```
{"type":"hello","tab":"<id>","views":["canvas","plot","reachability","invariants","categorical","notation"]}
{"type":"show","view":"plot","net":{...}|"cid":"<cid>","params":{...},"note":"text","request_id":"..."}
{"type":"stop","request_id":"..."}
{"type":"get","request_id":"..."}
{"type":"ping"}
```

`show.view` is one of:

| view | what the page does |
|---|---|
| `canvas` | loads the net into the editor. The page keeps the net it replaced and says so (see "Taste calls"). |
| `plot` | loads the net, then runs `sim.ode` (or `sim.ssa` with `params.engine:"ssa"`) and opens the result card. `params`: `t_end`, `points`, `runs`, `seed`. |
| `reachability` | loads the net, then `analysis.reachability`. `params.max_states`. |
| `invariants` | loads the net, then `analysis.invariants`. `params.kind` is `p` (default) or `t`. |
| `categorical` | opens the composition page (`/compose.html?cid=<cid>#view=<id>`) in an overlay; `params.name` is one of its view ids (`cospan`, `operad`, `string`, ...). It needs a stored composition `cid`; a private `net` is refused, because the composition page reads only stored models. |
| `notation` | **reserved** for the pflow-notation panel (run 19a75ca7). Today the page loads the net on the canvas and, if `params.source` is given, keeps it for the panel. No protocol change is needed when the panel lands: it consumes the same event. |

The analysis views reuse the existing link-replay machinery (`petri-viewspec.js` / `petri-link-open.js`): the page
builds a ViewSpec from the view name and runs it through `openLinkedView`, so a pushed view is replayed on a sandbox
in a Worker under the same allowlist and bounds as an opened `#view=` link, shows the same status chips, and has the
same provenance footer (Rerun, Copy MCP call, Copy link). A push can never edit the net by running a command; the only
way it changes the canvas is the explicit load.

Reports (`POST /api/tab/{id}/report`, and the body of a `reply`):

```
{"cid":"<cid or ''>","view":"plot","places":4,"transitions":3,"arcs":9,"marking":{"P1":2,...},
 "net_hash":"sha256:...","results":[{"title":"...","status":"reproduced - no model call"}],
 "dirty":false,"note":"..."}
```

The report is a bounded summary, not the net (256 KiB cap). `pflow_tab_get` with `net:true` asks the page to include
the canvas net in the reply (still within the cap).

## MCP tools

Listed unless `PFLOW_TAB_PUSH=0`; each needs a signed-in caller and is annotated.

| tool | arguments | notes |
|---|---|---|
| `pflow_tabs` | none | The caller's open tabs, most recently seen first: `{id, last_seen, connected, state}`. |
| `pflow_show` | `view`, one of `net` or `cid`, `tab?`, `params?`, `note?` | `tab` omitted: every live tab of the caller. Answer: `{sent, tabs, private}`. |
| `pflow_tab_get` | `tab?`, `net?` | The latest report, asking the page when stale. Omitted `tab`: the most recently seen. |
| `pflow_tab_stop` | `tab?` | The page closes result cards and overlays and cancels a running replay. It does not touch the net on the canvas. |
| `pflow_level` | `level`, `tab?` | `outcome`, `model` or `math`: the IDE shell's level of detail. |
| `pflow_highlight` | `targets`, `label?`, `tab?` | `node:<id>`, `line:<n>`, `range:<a>-<b>`; `[]` clears. |
| `pflow_annotate` | `text`, `target?`, `id?`, `tab?` | A line of narration; `text: ""` with an `id` removes it. |
| `pflow_focus` | `target`, `tab?` | `panel:<id>`, `view:<type>`, `node:<id>`, `line:<n>`. |
| `pflow_tour` | `steps` and `title?`, or `action`; `tab?` | Up to 30 steps, each a `show` (no net), `level`, `highlight`, `annotate` or `focus` with `say`; `action` is `next`, `back` or `end`. |

The teaching verbs (`cmd/webserver/tabs_teach.go`) send events whose fields are in `params`; the page spreads them into
the event it gives `window.pflowShell.dispatch`. Every pushed event with a `request_id` (all of them but `get`'s own) is
answered on `/reply` with the report plus `result`, the shell's answer, and `pflow_show` and the verbs wait up to 1.5 s
for it (`tabhub.PushAwait`): the answer carries `answered`, `result`, the shell's `level` and `tour`, and a note when
the page refused (for a view above its level: send `pflow_level` first). A page without the shell answers a verb with
`ok:false`.

## Page side

`public/petri-tab.js` is DOM-free (parser, channel with reconnect, the event-to-ViewSpec planner, the report
builder) and has its own deno tests. `petri-view.js` has about a hundred lines of wiring (`_tabLink*`): after sign-in
and with the IDE shell on (`?shell=1`) it asks `GET /api/tab/status`; when the server says enabled **and** the person
has switched the link on (menu item
"Link to Claude", remembered in `localStorage`; `?tab=1` switches it on for that visit) it registers a tab and
shows its id in a one-line notice. Nothing connects by default.

## IDE shell

The IDE shell (docs/ide-shell.md) hosts panels and modals. When `window.pflowShell.dispatch` exists, the page hands it
the `show` event unchanged (`{view, net|cid, params, note,
request_id}`), `stop` goes to `pflowShell.close(request_id)`, and `pflowShell.state().panels` is merged into the
report. Without a shell the page's own path (result card, overlay) runs. The view names above are the shell's
registry types, so an MCP push and a menu click open the same panel. A pushed net is private: a shell must not
write it to localStorage or the server.

## Not done, and how it was checked

- Checked: `internal/tabhub` (race detector, the vector file), the HTTP routes and four tools end to end over a real
  listener (`cmd/webserver/tabs_test.go`: account isolation, private vs cid, the get round trip, limits, flag off
  changes nothing), the page protocol and planner against the real wasm engine and a fake server (`public/petri-tab_test.ts`),
  and the menu entry. `make test` passes.
- Not checked: a real browser (this box has no display) and a real GitHub sign-in. The editor wiring in
  `petri-view.js` (`_tab*`) is covered only through `petri-tab.js`'s host contract, so it needs one manual pass:
  sign in, File > Link to Claude, then `pflow_show` from a connector signed in as the same GitHub account.
- Not done: the `queue` tool, Google sign-in for pages, a CSP review of the overlay iframe (same-origin, built
  from a validated CID and a fixed view list), and `petri-pilot`'s separate `sim_*` MCP server (sim.pflow.xyz): it
  could call this channel through pflow.xyz if wanted.

## Taste calls

1. **Opt-in per browser.** The page does not stream to the server unless the person turns it on. BeatScript's page is
   a player, so connecting is the point; pflow's editor holds people's work.
2. **A canvas push replaces the net, but never silently.** The page stashes the net it replaced under
   `pflow_tab_prev` and puts a one-line notice with a "Restore" link on screen. Claude cannot read the stash.
3. **Private by default in the tool.** `pflow_show` takes `net` or `cid`; `net` is the private one and is the one
   the tool description recommends for anything the person has not saved. To make it public the caller says so with
   `pflow_save` first.
4. **Accounts, not tab ids, are the security boundary.** A tab id is 22 random characters but is never accepted
   without the matching account (a push to someone else's tab answers "no such tab", not "forbidden").
5. **GitHub-only tabs for now.** The page signs in with GitHub; a Google-only OAuth identity cannot own a tab.
6. **One OAuth scope.** The tab tools reuse `pflow:save`: adding a scope means new consent copy and a connector re-approval. Worth doing before the tools are on by default.

## What should move into shared code

BeatScript's `hub/state.rs` (`Core`) and pflow's `internal/tabhub` are the same machine in two languages: sessions
with owners, SSE subscribers, report / reply / get round trip, ownership checks, caps, sweep, with an injectable
clock. The wire protocol (event frames, `request_id`, `report`, `reply`, the caps) is identical on purpose.
Candidates, in order of value:

1. A protocol document and a **shared fixture file** (`tab-hub-vectors.json`: sequences of create / subscribe /
   push / get / reply and the answers they must give) that both implementations replay. This is the cheap one and
   makes drift a test failure. `internal/tabhub/testdata/vectors.json` is written in that shape now.
2. A Go module `hub` extracted from `internal/tabhub` and used by pflow-xyz and by the Go `btwsite` while it still
   exists (the Rust port in `beatscript-serve` is the one that continues).
3. The page-side SSE-over-fetch reader (`petri-tab.js` `parseFrames`) and BeatScript's `site/` equivalent are the
   same ~40 lines; they should live in one ES module in pflow-xyz's `public/` (canonical for shared browser JS per
   the workspace CLAUDE.md) and be vendored with a lock like `petri-sim.js`.

Not shared: the MCP tool surfaces (domain-specific), the presence rules of the queue (BeatScript only), and the
sealed private relay (phones only).
