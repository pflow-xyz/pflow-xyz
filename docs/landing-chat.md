# The landing chat

pflow.xyz opens on a question, "What are you working on?", and routes the answer into a session.
This is Phase 0 of the design in val run 1c202365 ("pflow.xyz landing chat: design exploration"):
no new server state and no pairing, only what was already shipped put at the front door.

## What it does

`public/petri-landing.js`, on the hero of `public/index.html`:

| route | goes to | needs |
|---|---|---|
| Let it decide | the Assistant, mode `auto` (the server labels the message) | GitHub sign-in |
| Design | the Assistant, mode `build`, beside the canvas; edits wait for Apply | GitHub sign-in |
| Analyse | the Assistant, mode `analyse` | GitHub sign-in |
| Explain | the Assistant, mode `explain`; it does not edit | GitHub sign-in |
| Explore | `/compose.html`; it links back to `/?route=design` to build | nothing |

The chat is `petri-chat-ui.js` and the proxy is `/api/llm/turn`, unchanged: no second chat, and the route is a
suggestion, because a session can change mode on any message. `/?route=design` (also with `?cid=`) opens the
editor with the Assistant in that mode and sends nothing by itself.

`/api/llm/status` decides what is offered, before anyone types: signed in and allowed gets the quota line;
signed out gets a sign-in button that keeps the words in `sessionStorage` across the GitHub round trip and sends
them on return; not on `PFLOW_LLM_ALLOW` (the status now says `allowed`), or a server with no chat, gets the
editor and the connector. Nothing offers a chat that would answer 401 or 403.

The static landing content below the hero is unchanged, so what a crawler reads moves only in the hero.

## Decided here, for Matt to overrule

- **It is the landing page, not behind a flag.** The change is the hero's content; everything else on the page
  is as it was, and the editor is one click away (design question 5).
- **Returning visitors still land in the editor** (`pflow_skip_landing`), as before; the logo brings them back
  (question 5, the conservative answer).
- **Explore then build is a link, not a handoff.** No composition travels to the design tab yet (Phase 3).
- **Auto does not pick Explore.** The server's classifier has three labels; a fourth is a prompt change (Phase 3).
- **Quota stays as it was:** GitHub-keyed, `PFLOW_LLM_ALLOW`-gated (question 6).

## Later slices

Phase 1 pairs an MCP client with a tab, per account (`canvasHub`, `/api/canvas/stream`, `pflow_canvas_*`, a
consent banner, an nginx SSE location). Web saves are already per account (`docs/account-files.md`); the chat does
not reach them, and `file.*` stays out of its tools.

## Checks

`public/petri-landing_test.ts` (`make test-js`) holds the states, the routes and the kept words as pure functions.
`scripts/landing-smoke.ts` drives the page in Chrome. It cannot sign in to GitHub, so a signed-in session is answered
in the page: it proves the route, the mode and the words reach the Assistant's request, not Gemini.
