# The landing chat

pflow.xyz opens on the mission, "Explanations you can run.", and a question, "What are you working on?", and routes the answer into a session.
This is Phase 0 of the design in val run 1c202365 ("pflow.xyz landing chat: design exploration"):
no new server state and no pairing, only what was already shipped put at the front door.

## What it does

`public/petri-landing.js`, on the hero of `public/index.html`: **one input and one Ask button**, then `Open the
editor` and `Compose` as plain links. Per `docs/design/agent-first-analysis.md` section 16 (steps H0 and H1): one
vocabulary, **Build, Analyse, Explain**, the same in the page, the Assistant and the server's labels ("Design" is
now Build); and no mode picker. Forcing nothing is not a mode, so the hero forces nothing: the message goes to the
Assistant in mode `auto` and the server labels it (`/api/llm/turn`, `PFLOW_LLM_CLASSIFIER_MODEL`).

The one place a person states a mode is a link, and nothing on the page advertises it:

| link | opens | needs |
|---|---|---|
| `/?route=build` (`design` is its old name, kept as an alias) | the editor with the Assistant in `build`, beside the canvas; edits wait for Apply | GitHub sign-in |
| `/?route=analyse` | the same, in `analyse` | GitHub sign-in |
| `/?route=explain` | the same, in `explain`; it does not edit | GitHub sign-in |
| `/?route=auto` | the same, in `auto` | GitHub sign-in |

Any of them also works with `?cid=` (a stored net) and sends nothing by itself. An unknown route, `explore` and
`compose` included, shows the landing as usual. Compose is a destination, not a mode: a plain `Compose` link next
to `Open the editor` (and in the nav) to `/compose.html`, which needs no sign-in and links back to a build session
(`/?route=design`, the old name, which still works).

The chat is `petri-chat-ui.js` and the proxy is `/api/llm/turn`, unchanged: no second chat, and the mode is a
suggestion, because a session can change mode on any message. The landing works against the Assistant as it is
(`view._openChat({mode, message})`); relabelling the Assistant's own mode tabs is for the Ask pane.

`/api/llm/status` decides what the hero offers, before anyone types (the button says what a press does):

| state | the box | the button | under it |
|---|---|---|---|
| checking (the status has not answered) | yes | Ask | nothing yet |
| signed in and allowed | yes | Ask | the quota line, and who answers |
| signed out | yes: what is typed waits in `sessionStorage` across the GitHub round trip and is sent on return | Sign in with GitHub and ask | why, and the connector |
| not on `PFLOW_LLM_ALLOW` (the status says `allowed: false`) | **no** | Open the editor | why, and the connector |
| no chat on this server, or the status could not be read | **no** | Open the editor | why, and the connector |

Nothing offers a chat that would answer 401 or 403: where no chat can happen the box (and the question that goes
with it) is hidden, not left to go nowhere. The static markup keeps the box, so the page reads the same to a crawler.

The static landing content below the hero is unchanged by H0 and H1, so what a crawler reads moves only in the hero.

## Decided here, for Matt to overrule

- **It is the landing page, not behind a flag.** The change is the hero's content; everything else on the page
  is as it was, and the editor is one click away (design question 5).
- **Returning visitors still land in the editor** (`pflow_skip_landing`), as before; the logo brings them back
  (question 5, the conservative answer).
- **Build, Analyse, Explain, and nothing else.** "Let it decide" and "Auto" are not shown: they are what happens
  when nothing is forced (design 16.1). `auto` stays as an internal route and a link target.
- **H1 ships without the collapsed Build / Analyse / Explain row** that design question 16.6.1 suggests keeping
  until the label statistics (`data/llm/auto-stats.json`) are read. The brief for this step was to hide the
  radios; the row is a small addition if the statistics ask for it, and the Assistant's own mode tabs are still
  there to correct a label once a session is open.
- **Compose then build is a link, not a handoff.** No composition travels to the build tab yet (Phase 3).
- **Auto does not pick Compose.** The server's classifier has three labels; a fourth is a prompt change (Phase 3).
- **Quota stays as it was:** GitHub-keyed, `PFLOW_LLM_ALLOW`-gated (question 6).

## Later slices

Phase 1 pairs an MCP client with a tab, per account (`canvasHub`, `/api/canvas/stream`, `pflow_canvas_*`, a
consent banner, an nginx SSE location). Web saves are already per account (`docs/account-files.md`); the chat does
not reach them, and `file.*` stays out of its tools.

## Checks

`public/petri-landing_test.ts` (`make test-js`) holds the states, the routes (the `design` alias included) and the
kept words as pure functions; drives `initLanding` against a stand-in page for every state (the box, the button,
what a submit sends, a submit before the status answers, a link that forces a mode, the words kept across a
sign-in); and reads the static `index.html` as text (no radios, one Ask, no old names, Compose still linked).
`scripts/landing-smoke.ts` drives the page in Chrome. It cannot sign in to GitHub, so a signed-in session is answered
in the page: it proves the mode and the words reach the Assistant's request, not Gemini.

On a phone it uses Chrome's mobile layout with touch at 390x664, 375x553, 430x739, 412x732 and 390x380, and asks
`elementFromPoint` rather than only comparing rectangles, because the Assistant's input row was inside the viewport and
still hidden: the run bar (z-index 1200) painted over the panel (1000). The frame comes from `panelFrame` in
`petri-panel-frame.js`, which the App view shares: above the run bar and whatever `visualViewport` says is covered, and a desktop window keeps the
docked rules. No `interactive-widget=resizes-content`, which iOS ignores and which would resize the editor under every
field on Android. No `viewport-fit=cover`, which would put the rest of the page under the notch for no gain here.

A keyboard cannot be raised in headless Chrome, so that case fakes `window.visualViewport`. Neither iOS Safari nor a
real keyboard is exercised by the smoke.

Run the smokes before a push with `scripts/smoke-gate.sh` (or `make smoke-gate`): it serves this checkout on a scratch
port, keeps each smoke's full log and exits non-zero if any smoke did. Do not pipe a smoke into `tail` by hand: `... |
tail || exit 1` tests `tail`, which is how one crash got past a push.
