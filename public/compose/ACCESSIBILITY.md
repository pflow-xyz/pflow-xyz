# Accessibility of the composition page

`compose.html` draws the views of the view registry (`VIEWS.md`) of one composition and one search plan. Its
signature interaction is snap-together linking (drag from a port). This note says
how each part is reached without a pointer, what is announced, and what is not
covered. The logic is in small DOM-free modules with deno tests; the DOM side is
`a11y.js` (a pass after each render), `snap.js` (link mode) and `inspect.js`.

## Keyboard map

| Where | Keys | Does |
|---|---|---|
| anywhere | `1`-`9`, `0` | switch to view 1-10 (Cospans, Spiders, Operad, String, Flat net, Boundaries, Lenses, Incidence, Processes, Laws). Ignored with Ctrl, Cmd or Alt held, in a form field, a select, a contenteditable region or an ARIA text box, and during link mode (where a press says the view keys are off) |
| anywhere | `[`, `]` | previous or next view, wrapping; the way to a view past the tenth, which has no number |
| anywhere | `V` | the index of all views, with their links |
| link bar | `Tab` to it | the link to this view (focus selects it), Copy link, All views |
| anywhere | `E` | switch between the orders and the Connect-4 example (same exceptions) |
| first Tab | skip links | "Skip to the diagram", "Skip to the inspector" (they move focus and leave the address, with its view and example parameters, as it is) |
| view tabs | `Left` `Right` `Home` `End`, then `Enter` | move between tabs (focus only: opening a view such as Laws loads Pyodide, so it is not automatic), open one |
| the diagram | `Tab` | one Tab stop per kind of thing, so a view with 500 cells is not 500 stops: the ports, the palette pieces, the small in-drawing buttons, and everything else inspectable |
| the side column | `Tab` | one more Tab stop for the inspectable things there: the four link rules and, in the orders example, the rows of the Links card (each also has its own `×` button, a Tab stop of its own) |
| a stop | `Arrow` keys | move to the nearest thing in that direction (by position); `Home` `End` to the first and last |
| a port or palette piece | `Enter` / `Space` | start linking (below) |
| any other thing | `Enter` / `Space` | what a click does: a view's own handler (fire an enabled transition in the Flat view, remove or reorder a piece with `×` `◀` `▶`, "go to the Operad view"), else pin the inspector. A real button or link (the Laws view's tabs and chips) is pressed by the browser itself |
| any thing | `I` | pin the inspector on it (`I` again lets go) |
| anywhere | `Esc` | let go of a pinned inspector (the key is left alone when nothing is pinned) |

### Linking by keyboard

Linking uses the registry's verdicts, the ones a drag uses (`bundle.candidates`
for ports, `plan.slot_candidates` for pieces, through `model.js`/`state.js`);
nothing in the page re-implements a rule. `Enter` or `Space` on a port or piece
lights the same targets a drag lights (legal ones glow, refused ones fade) and
hands the keys to the machine in `a11y-link.js`:

| Key in link mode | Does |
|---|---|
| `Tab`, `Shift+Tab`, `Arrow` keys | the next / previous LIT target (wraps). Focus moves to it, and the rubber band follows |
| `Home` `End` | first / last lit target |
| `R`, `Shift+R` | the next / previous REFUSED target, and say why: the registry's error codes and messages |
| `Enter` / `Space` | link to the focused lit target. On a refused one it says why again and links nothing |
| `?` | say the instructions again |
| `Esc` | cancel; focus returns to the origin port |

Moving focus out of the ports (Tab leaving) or pressing anywhere else (a click
on plain text, which moves no focus) also ends link mode. After a link is made the
stage is redrawn and focus is given back to the origin port, in the same drawing
when a port is drawn twice (and in its first drawing when the redraw no longer has
the second: a linked port leaves the outer interface). Where a view draws nothing
to link to (the Flat net draws the palette's pieces and no slots) link mode is not
entered, and it says so. A pointer drag is unchanged. A view's own background work
(the Laws view's data arriving, its live Pyodide check or layout finishing) never
cuts a drag or link mode: the redraw waits until the gesture has ended, is dropped
if another view is shown by then, and the Laws status lines ("Laws: the live layout
is drawn.") are spoken only while Laws is the view shown (the latest one that
came while it was away is spoken once, when it is drawn again). The reason a target is
refused is also written in the status line at the bottom of the window (it stays
on screen on a short laptop display), since the keyboard path never shows the
pointer's tip.

## What is announced

One polite live region (`#a11y-live`, `role=status`) carries all speech, while the
page loads and when something fails too: nothing else on the page is a live region
(the loading line and the failure messages are plain text in the stage; there is no
`role=alert`, which would be a second region saying the same words). The same text of
link mode is also written into the visible status line under the diagram.
Messages that arrive together (a link removed and, in the same click, an inspector
released) are all spoken, in order, as one utterance (`createAnnouncer` in
`a11y-bus.js`); a message after that moment starts the next one, so a fast walk
through link targets does not queue up behind itself.

The quoted texts below are built from the machine by `a11y-link_test.ts` (the
registry's `bundle.candidates` from `orders:out`, the machine in `a11y-link.js`,
the reducer in `a11y-inspect.js`) and compared with this document, so a change to
the wording fails the test until the quote is updated.

- entering link mode: "Linking from orders:out, out port on a place, schema queue:items. 10 legal ports lit, 10 refused. Arrow keys or Tab choose a target, Enter links; R says why a refused port is refused; Escape cancels."
- a lit target (the registry's words for the rules it passed): "workers:acquire, in port on a transition, no schema: legal, guard link. from is the gated transition, to is the observed place; net kinds allow a guard link: ResourceNet → ResourceNet; condition "> 0" lowers to a read arc (structural). Target 1 of 10. Press Enter to link."
- a refused target, from `R` (the registry's error codes and messages, one clause per link kind it tried; from `orders:out` the first is `orders:in`, on the same subnet): "orders:in, in port on a place, schema queue:items: refused. token: PAGE_SAME_SUBNET both ends are on subnet "orders"; a link connects two subnets | data: PAGE_SAME_SUBNET both ends are on subnet "orders"; a link connects two subnets. Refused port 1 of 10." Other targets are refused with `E_SCHEMA_MISMATCH` (schemas differ), `E_PORT_DIRECTION` or `E_DATALINK_CONSUMES`.
- a view that draws no target for the thing you started from: "threats, order piece: this view draws no slots to link to, so there is nothing to light. Another view may draw them."
- cancelled: "Linking cancelled." (Escape, a press outside the ports, Tab leaving, or the view redrawn under it)
- Copy link: "Link copied.", or that the browser did not allow it, with the link left selected in its field.
- a view key (a number, `[`, `]`, `V`, `E`) in link mode: "Linking is on, so the view keys are off. Escape cancels linking."
- a link created / removed / reset / cleared, an instance added, a piece placed, the plan mode, an edit the registry refused: one sentence each (`eventText` in `a11y-text.js`, from the state change itself, so a drag, a key and a toolbar button all announce the same)
- the inspector pinned: "Inspector pinned: port orders:in. Press Escape to dismiss."
- the inspector dismissed: "Inspector dismissed."
- the pin released because a redraw no longer has its thing (a link removed while its row was pinned): "Inspector released: the pinned thing is no longer in the view."
- the view changed ("View 3 of 10: ..."), and also at the first drawing when the view or example was chosen while the page was still loading (keys, tabs, a changed address); a page that opens on the view in its address says nothing about it
- loading, once per change of text, not at every repaint: "Loading pflow-native's registry (wasm)…", then "Loading the Laws view…" when a view's module is fetched on first use. While it shows, the stage is labelled by the tab that is selected now
- the registry did not load: "The registry did not load: Failed to fetch." The stage shows that line first, with the stack behind a "Technical details" disclosure, the tabs and example buttons disabled, and focus on the message (the tab that had it is disabled)
- a view whose module did not load: "The Lenses view failed to load: TypeError: Failed to fetch dynamically imported module: http://127.0.0.1:8080/compose/views/lens.js." It takes the place of "View 7 of 10: ...", is written into the stage too, and the tab's name says "7. Lenses (failed to load)"

Ports, pieces, slots and every inspectable thing have an accessible name
(`orders:out, out port on a place, schema queue:items`); the focused thing is
described through `aria-describedby` (the ontology concept, its definition and
facts, from the same `info` the hover inspector shows, as plain text) plus a short
hint of what Enter does. In link mode the descriptions stand down, because the
live region is speaking. A real button or link with visible words (the Laws
view's tabs and chips) keeps those words as its name, and says `aria-pressed` for
the one shown.

## The inspector without hover

Hover and keyboard focus show a thing in the Inspector panel (and the short tip at
the thing, since the panel can be below the fold). A click, a tap, `Enter` or `I`
pins it; a second click or tap on the same thing, `Esc`, or the Dismiss button lets
go. On a narrow screen a pinned inspector is a sheet over the bottom of the screen,
so a tap shows it. It never traps focus: the pin is released with `Esc`, and the
panel's links are ordinary content after the diagram. A thing is identified by
its title and its place among the equally titled ones (the Operad draws
"port orders:in" twice; pinning the second moves the pin, it does not release the
first), so the pin survives an edit that leaves its thing drawn and is released,
and said so, when a redraw drops it. Pressing Dismiss from the keyboard returns
focus to the pinned thing. A click on a nested inspectable pins the innermost one
(the one hover shows), not the outermost; no inspectable is nested in another in
any view today, so this is latent. Controls nested in an inspectable are not that:
a button or link inside one (Retry in the Laws status bar, "Assume a backward
pass" in the Lenses card) does its own work and pins nothing (`isNestedControl` in
`a11y-inspect.js`, checked in the click handler of `inspect.js`); after Retry
the status line has focus and is read as it is, with no second announcement beside it.

## Colour is not the only carrier

- **Link kind**: each kind has a glyph, a stroke and a colour. Read the glyph
  first and the stroke second: token `◆`, data `▷`, event `⊗`, guard `⊘`. The
  glyphs and the strokes token dashed, data dotted, event bold are go-pflow
  RenderDOT's (`metamodel/composedot.go:28-33`). RenderDOT draws guard dashed too,
  the same as token, so the legend and the page's own wires draw guard dash-dot
  (`distinctDashes` in `a11y-text.js`, applied at load) to keep the four apart. The
  strokes are not the same in every view, so they are a second channel and never
  the only one. Measured in the default orders composition: Cospans draws event
  ghost links as thin dashes (`5 4`) where the legend says bold; Boundaries draws
  event as `5 4` and `3 2.5`, and its own legend's token swatch `3 3`; the Spiders
  legend draws its guard bracket `4 3`; String draws token wires solid (only data
  takes the registry's dash) and its legend's guard swatch `6 4`, which is the
  dash the legend gives token (its guard wires follow the registry). The Operad
  view follows the legend's strokes. The legend card lists the four kinds drawn,
  and says this.
- **Port schema**: every place port's dot carries a letter (I `queue:items`, P
  `queue:payload`, R `resource`, A `account`, S `saga:outcome`); transition ports
  are squares with no schema. On the dots too small to hold a letter (Spiders) the
  letter is framed above the arrow, so a narrow "I" does not read as a tick. The
  legend lists them.
- **While linking**: lit targets glow and the rest fade; the band is dashed to a
  refused target; and the same is in words through the live region and the status
  line.
- the Links card names each link's kind in words for a screen reader.

The scene manifest (`ctx.emit`) is unchanged: none of this is drawn by the views,
and `parity/composition-views/` still compares 112 of 112 with pflow-native.

## Structure

`compose.html` has two skip links (to the diagram and to the inspector), one `h1`, `main`, a `nav` holding the view tablist
(`role=tab`, `aria-selected`, `aria-controls`, `aria-keyshortcuts` 1-9,0 for the first ten, `v` for the index, none for later views), an
`aside`, headings that go down one level at a time (the cards the Flat and Laws views draw are `h3` under the `h2` "Diagram"; the smoke script checks every view and example), labelled cards, the Keyboard card, and the Legend card. Each
view's svg is a labelled group (`role=group`, `aria-roledescription=diagram`,
`aria-label`, a `<desc>` from the view's summary). It is a group, not `role=img`,
because an image hides its parts from assistive technology and these parts are
the interface. Decorative shapes are `aria-hidden`; their text labels stay in the
reading order. Toggles say `aria-pressed`.

A thing made keyboard-reachable keeps a native role (a button, a link, a list
item: the Links card and the Laws view's lists stay lists), and is never given
`role=button` over other controls or readable content, since a button's children
are presentational: those get `role=group` (`roleFor` in `a11y-nav.js`). Nothing
that has a name and a Tab stop is `aria-hidden`. `scripts/a11y-smoke.ts` scans
every view for these (below).

## Reduced motion

`prefers-reduced-motion: reduce` stops every CSS animation and transition (one rule
in `compose.css`), zeroes every Web Animations API animation the views run (one
guard on `Element.animate`, `motion.js`, read at each call), skips the Spiders
fusion and the Laws pulse (as before), and turns off the Lenses play dot
(`lens.js`; the drawing says the same). Stepping through the token game in the Flat
view is a user-started sequence of states, not motion, and still runs.

## Checking it

`deno run -A scripts/a11y-smoke.ts <url>` (for example
`http://127.0.0.1:8080/compose.html`) drives the page in headless Chrome and
checks, in every view module of both examples: zero console problems; no focusable
element is `aria-hidden`; no `role=button` holds a focusable descendant; no
inspectable is click-only; headings never skip a level; `#a11y-live` is the only
live region; and, in the views that draw ports, that Tab reaches the ports, Enter
lights targets, Tab and the arrows walk them, Enter links, Esc restores focus and
the live region says so. It also holds the regressions found in review: the Laws
view's live check ending (its network held, then failed) while a link is in progress
in Cospans or in Laws, Retry and the Lenses button pinning nothing, and the skip links. It is not part of `make test` (it
needs Chrome and a running server). The unit tests (`make test-js`) cover the pure
modules; this is what covers the DOM glue.

## Not covered (honestly)

- **No real assistive technology was run.** The wording, the live region's pacing
  and `aria-describedby` on focus are checked with Chrome and key events, not with
  VoiceOver, NVDA, JAWS or TalkBack. Expect to tune wording. There is no axe or
  Lighthouse audit (the smoke script checks three of axe's rules by hand:
  nested-interactive, aria-hidden-focus, and click-only controls), and colour
  contrast of the views' own palettes was not audited.
- **Big drawings are long.** Incidence has about 500 inspectable cells: reachable
  by arrows, with `Home`/`End`, but with no table or grid semantics (row and column
  names). The diagram text stays in the reading order, which is verbose.
- **Other colour-only channels remain**: the Connect-4 views' search wire types
  (Position, Value, MoveList, ...) and piece kinds are coloured (the labels name
  them), and the red/green states of the process and lens views. Only link kinds
  and port schemas, the two the page's rules turn on, were given a second channel.
  The views' own strokes for link kinds differ from the legend's in the places
  listed above.
- **The schema letter is small**: about 7-9 px on the dots that hold one, a framed
  10 px box beside the dots that are too small (Spiders).
- **Some interactions are still pointer-only**: the draggable magnifier lens in the
  String view's transition level; dragging in the Laws view's Chyp diagrams (its
  internals are Pyodide's). The Laws view's own buttons are ordinary buttons. Every
  other `.inspectable` thing (stage and side column, both examples, every view module)
  has a Tab stop and a key handler.
- **Inspectables with the same title and facts** (the Incidence view's cells) are
  told apart by their place among the equals, which is the same after a redraw
  only while the things before them are.
- **A pinned inspector on a narrow screen covers the lower part of the view**: a
  covered thing cannot be tapped for its second tap; use the Dismiss button or `Esc`.
- **Focus after a view change**: if the focused thing is not in the new view, focus
  goes to the diagram region, not to a similar thing. (After a link, a second drawing
  that is gone falls back to the first drawing of the same thing.)
- **Touch dragging** is as before (the pointer path is unchanged); the keyboard path
  is the alternative, there is no touch-specific linking gesture.
- The token game's firing in the Flat view is not announced (only the inspector
  facts, which follow it, change).
