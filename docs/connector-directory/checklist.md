# Directory submission checklist

Status at 2026-11-01: **not submitted, and not ready to be.** Neither target category's gate is
open (the canvas is building, the library closed). Matt submits from the developer portal himself; nothing in this repo touches claude.ai.

The portal's fields are in [`listing.json`](listing.json). Its copy claims only what ships today.
`cmd/webserver/mcp_directory_test.go` holds it to the portal's limits, to the segmentation below and
to the server, so a claim that outruns a closed gate fails `make test`.

## The segmentation (Matt, 2026-11-01)

| Listing | Category | What it is | Gate |
|---------|----------|------------|------|
| pflow (`pflow.xyz/mcp`) | **Designs & media** | The canvas: the snap-together composition interface, inline in Claude as an MCP App | 1, building |
| pflow (`pflow.xyz/mcp`) | **Reference docs** | The library: verified parts, queryable by concept | 2, closed |
| mine (`mine.pflow.xyz`) | Automation & workflows, Logs & errors | Process mining, a separate listing | that repo's roadmap, M5 |

The snap-together interface is the core offering, not a later phase. Public copy leads with outcomes
and keeps Petri nets as the engine. Process mining stays out of the main listing.

## Gate 1: the canvas (Designs & media)

Status: **building**. `pflow_canvas` opens `cmd/webserver/mcpapp/canvas.html` as an MCP App.
`scripts/canvas-smoke.ts` plays the host in Chrome, under the sandbox and CSP the spec gives as the
default, against the real `/mcp`. It has not been seen in Claude, and that is what decides this gate.

The page is one self-contained file with no engine in it. Every rule comes from calling the
`pflow_bundle_*` tools back through the host, so it needs no WebAssembly (not in the default CSP) and
declares no CSP exceptions. It is a new, smaller canvas: `/compose.html`'s ten views stay a web page.

- [x] `/mcp` serves an MCP App: the `resources` capability and the UI extension in `initialize`,
      `resources/list` and `resources/read`, `ui://pflow/canvas` with MIME
      `text/html;profile=mcp-app`, and `_meta.ui.resourceUri` on the tool.
- [x] The page loads under the default sandbox and CSP, in Chrome. `TestCanvasPageIsSelfContained`
      refuses any other origin, WebAssembly or markup injection.
- [x] A composition reaches the canvas from a conversation: `pflow_canvas` takes it in the call, and
      edits go back to Claude through `ui/update-model-context`.
- [ ] **Seen rendering in real Claude, added as a custom connector.** This needs the branch deployed.
      Claude Code is text-only and cannot show it. Known risks, all from open or closed public reports,
      none confirmed: [frames that never mount](https://github.com/anthropics/claude-ai-mcp/issues/165),
      including a question whether rendering is gated to directory connectors (if so, this box cannot be
      ticked before listing; ask mcp-apps@anthropic.com). `tools/list` is reported cached per connector,
      so remove and re-add the connector after a change. Claude has been reported negotiating protocol
      `2026-07-28`, which `/mcp` answers with `2025-06-18`; look there if it connects and does not draw.
- [ ] Inline height in Claude. The host caps inline height and clips the rest, and the default
      composition is tall (payment alone has 12 ports). The full screen button is at the top so it stays
      reachable. Check it, and if clipping hurts, start inline with a shorter summary.
- [ ] Host-specific bridge behaviour the smoke only imitates: style variables, fonts, safe areas, and
      whether Claude offers `updateModelContext` and full screen.
- [ ] The person's own parts by reference. A composition with inline subnets and declared ports draws
      and links today. A place port on a part loaded by reference is still refused (plan:
      [compose-user-nets](../plans/compose-user-nets.md)), and a part with no declared ports can take no
      links, so the canvas says so.
- [ ] 3 to 5 PNG screenshots: at least 1000px wide, cropped to the app with no prompt in the image,
      each with its prompt given separately. No video or GIF. They must come from Claude, not the smoke.
- [ ] To open it, once the first box is ticked: set `status` to `open` in `listing.json`, work
      `copy_when_open` into the description, and take the canvas line out of `#on-the-way` in
      `public/mcp.html`.

## Gate 2: the library (Reference docs)

- [ ] A concept query returns a model, its invariants and theorem or arXiv links, with a stable CID
      to cite. Today [ontology.pflow.xyz](https://ontology.pflow.xyz) has `search_terms`,
      `describe_term`, `get_claim` and `sparql_query`, one worked claim, and a theorem layer still
      marked proposed.
- [ ] The query is a tool on `https://pflow.xyz/mcp`. A listing connects one server URL, and the
      ontology is a separate server, so it does not count for this listing as it stands.
- [ ] "Verified" means something a check decides. Say what a part must pass to be listed as verified.
      The catalog behind `pflow_bundle_example` (queue, resource pool, saga) comes from go-pflow's
      constructors; nothing yet ties a part to a claim, so the copy says "catalog".
- [ ] A part that comes back can go straight into `pflow_bundle_*`, with its ports. This needs the
      same by-reference port fix as gate 1.
- [ ] To open it: as for gate 1, with this gate's own `copy_when_open` and `#on-the-way` line.

## Before submitting, whichever gate opens first

- [ ] Confirm the category labels in the portal. The public docs say "one to five categories" and do
      not name them, so "Designs & media" and "Reference docs" are unchecked against the picker.
- [ ] Decide the slug. `pflow` is in `listing.json`, and a slug is permanent once published.
- [ ] Icon. The largest square icon in `public/` is 192x192 grey-and-alpha
      (`android-chrome-192x192.png`); the docs give no size, so check it in the portal.
- [ ] Reviewer test account. The portal requires credentials and instructions. Only `pflow_save` needs
      sign-in (GitHub or Google); no account has been set up for this.
- [ ] Run every tool in Claude as a custom connector and in MCP Inspector. **Test & launch** asks you
      to confirm this. Not yet done from Claude; the example prompts' tool chains were run against the
      live server over HTTP.
- [ ] Support contact. `listing.json` gives the GitHub issues page; give an email if the portal wants one.
- [ ] Portal answers: company name and primary contact, and the seven compliance acknowledgments.
- [ ] Copy that still pitches the engine, outside this pass: `/compose.html`'s head and `llms.txt`'s
      composition line both say "three Petri nets".

## Already met

- Remote HTTPS, Streamable HTTP, stateless: `https://pflow.xyz/mcp`.
- 30 tools, each with a `title` and read-only and destructive hints; only `pflow_save` is destructive;
  longest name 23 characters (`TestDirectoryToolRules`).
- Sign-in on demand: OAuth 2.0 with dynamic client registration, which accepts any https redirect, so
  `https://claude.ai/api/mcp/auth_callback` registers. Both discovery documents answer 200 live. A real
  sign-in from Claude is part of the tool run above.
- Limits inside Claude's: the 60s call timeout (240s allowed) and the 60KB result guard (about 150,000
  characters allowed on claude.ai, 25,000 tokens in Claude Code).
- Public docs, terms and privacy: `/mcp.html`, `/terms.html`, `/privacy.html`.

## Sources

Read 2026-11-01:
[submit a connector](https://claude.com/docs/connectors/building/submission),
[pre-submission checklist](https://claude.com/docs/connectors/building/review-criteria),
[build a server](https://claude.com/docs/connectors/building/index),
[MCP Apps](https://claude.com/docs/connectors/building/mcp-apps/getting-started),
[MCP Apps quickstart](https://claude.com/docs/connectors/building/mcp-apps/quickstart),
[MCP Apps troubleshooting](https://claude.com/docs/connectors/building/mcp-apps/troubleshooting),
[MCP Apps design guidelines](https://claude.com/docs/connectors/building/mcp-apps/design-guidelines),
[MCP Apps spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx),
[directory policy](https://support.claude.com/en/articles/13145358-anthropic-software-directory-policy).
