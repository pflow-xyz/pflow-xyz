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

### One AI door (H2)

Two text-to-model boxes side by side made a visitor pick a backend before they knew what either was, so the hero has
one (design 16.2). pflow and sim are one product with two surfaces:

- **The hero** has `Open the editor` and `Compose`; the `Describe it instead (sim)` button is gone. Sim stays a link
  in the nav and in the footer, and has its own labelled gallery below.
- **`Calibrated what-ifs (sim.pflow.xyz)`** is the old `Or start from a description` section, under the example
  models, with the same three cards to sim.pflow.xyz and one line on what is different: models already tuned,
  turn the knobs, no editor needed, and to model your own start at the top. It is not a second place to describe.
- **`Draw -> Run -> Prove`**: the middle card used to be `Check`, and said to describe a decision and start from
  words, which is the Ask's job. It now says what sim is for ("Run a calibrated what-if and see which knob binds")
  and keeps its link. The word Check is kept for the editor, where it will mean the problems chip (design 3).
- **Left out:** the mockup's `You have... / Take...` table. It needs a third row about `Copy for sim` and an `Open in
  sim` that does not exist yet, which would promise something on the page (16.2 says not to), and a table between the
  hero and the examples is clutter; the gallery's one line carries the distinction instead.
- Not decided here, and not on the page: whether the two share a sign-in or a quota.

The page's static content stays in the HTML (the script writes the hero's words with `textContent` and flips
`hidden`, never markup), the head's meta tags and structured data are untouched, and every link the page had is still
there except the removed button; `petri-landing_test.ts` holds each of those to the source of `index.html`.

## Decided here, for Matt to overrule

- **It is the landing page, not behind a flag.** The change is the hero's content and the sim section's copy; the
  editor is one click away (design question 5).
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
- **The sim gallery stays on the page**, under the examples, labelled as sim's (design question 16.6.3).
- **Quota stays as it was:** GitHub-keyed, `PFLOW_LLM_ALLOW`-gated (question 6).

## Later slices

Phase 1 pairs an MCP client with a tab, per account (`canvasHub`, `/api/canvas/stream`, `pflow_canvas_*`, a
consent banner, an nginx SSE location). Web saves are already per account (`docs/account-files.md`); the chat does
not reach them, and `file.*` stays out of its tools.

## Checks

`public/petri-landing_test.ts` (`make test-js`) holds the states, the routes (the `design` alias included) and the
kept words as pure functions; drives `initLanding` against a stand-in page for every state (the box, the button,
what a submit sends, a submit before the status answers, a link that forces a mode, the words kept across a
sign-in); and reads the static `index.html` as text (no radios, one Ask, no old names, Compose and every old link
still there, the sim gallery's title and the card that no longer says Check, valid metadata).
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

## The editor's bar: the same Ask, and where the old menu went

Inside the editor the hero's input has a counterpart, the bar over the canvas (`public/petri-menu-ui.js`, with
`petri-menu.js` for the parts that need no DOM): **Ask**, **File**, **View**, **Help**, **Tools** (Ctrl K or ⌘K) and the
problems chip, then the account button. Enter in its Ask input makes the call the hero makes, `view._openChat({mode:
'auto', message})`, and sends nothing itself: a visitor who cannot chat (signed out, not on the allow-list, no chat on
the server) still gets the pane (what the pane does with the words then is the Ask pane's, design section 9), and the
bar never asks the model for anything a signed-out person would be refused. Focusing the input opens nothing. The bar is only in the pflow.xyz
editor (`data-backend`); a standalone `<petri-view>` and `?ui=classic` keep the single hamburger for this release (Help >
Classic menu is the one place that links to it).

| the hamburger's entry | now |
|---|---|
| Describe a process, Draft notes, Assistant | the Ask input (the empty canvas's "Describe a process in words" button opens the Ask pane in `build`) |
| What do you want to know? | the Ask input, and Tools > Questions; the dialog itself is in Tools > Classic tools |
| Analysis, Simulate, Structure, Components, Results, Check net | Tools > Classic tools, each opening the same dialog; the key `9` still opens Analysis |
| Check net | the problems chip: it checks on load and after each burst of edits; its list has Copy MCP call and Details (the old Check net dialog) |
| App view | View > Open as app |
| Composition Views | View > Compose |
| the account, saving, sharing, Download JSON | File, with the conditions they had (signed in, `/api/files/status`) |
| Layout Algorithms, Display Settings, Toggle Editor | View |
| Help, Sim, Book, Native App, GitHub, the version | Help |

A run from Tools (or the palette's "Open in Tools" on a result's footer, which opens the command's form with its
arguments filled in) lands in the same results pane as an Ask result, with the same "How this was computed" footer, and
works with no model: `scripts/menu-smoke.ts` runs it with every `/api/llm/*` answered 503. The smoke also covers the bar
at 1280, 390 and 320 px, each menu from the keyboard, each removed entry's replacement, `?ui=classic` and the standalone
component.
