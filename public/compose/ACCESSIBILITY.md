# Accessibility of the composition page

`compose.html` draws ten views of one composition and one search plan. Its
signature interaction is snap-together linking (drag from a port). This note says
how each part is reached without a pointer, what is announced, and what is not
covered. The logic is in small DOM-free modules with deno tests; the DOM side is
`a11y.js` (a pass after each render), `snap.js` (link mode) and `inspect.js`.

## Keyboard map

| Where | Keys | Does |
|---|---|---|
| anywhere | `1`-`9`, `0` | switch to view 1-10 (Cospans, Spiders, Operad, String, Flat net, Boundaries, Lenses, Incidence, Processes, Laws). Ignored with Ctrl, Cmd or Alt held, and during link mode |
| anywhere | `E` | switch between the orders and the Connect-4 example |
| first Tab | skip links | "Skip to the diagram", "Skip to the inspector" |
| view tabs | `Left` `Right` `Home` `End`, then `Enter` | move between tabs (focus only: opening a view such as Laws loads Pyodide, so it is not automatic), open one |
| the diagram | `Tab` | one Tab stop per kind of thing, so a view with 500 cells is not 500 stops: the ports, the palette pieces, the small in-drawing buttons, and everything else inspectable |
| a stop | `Arrow` keys | move to the nearest thing in that direction (by position); `Home` `End` to the first and last |
| a port or palette piece | `Enter` / `Space` | start linking (below) |
| any other thing | `Enter` / `Space` | what a click does: a view's own handler (fire an enabled transition in the Flat view, remove or reorder a piece with `×` `◀` `▶`, "go to the Operad view"), else pin the inspector |
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

Moving focus out of the ports (a click elsewhere, Tab leaving) also ends link
mode. After a link is made the stage is redrawn and focus is given back to the
origin port. A pointer drag is unchanged.

## What is announced

One polite live region (`#a11y-live`, `role=status`) carries all speech; the same
text of link mode is also written into the visible status line under the diagram.

- entering link mode: "Linking from orders:out, out port on a place, schema queue:items. 10 legal ports lit, 10 refused. Arrow keys or Tab choose a target, Enter links; R says why a refused port is refused; Escape cancels."
- a lit target: "workers:available ...: legal, token link. <the rules it passed, in the registry's words>. Target 2 of 10. Press Enter to link."
- a refused target (`R`): "orders:in ...: refused. token: E_SCHEMA_MISMATCH port schemas differ ... | data: ... Refused port 1 of 10."
- a link created / removed / reset / cleared, an instance added, a piece placed, the plan mode, an edit the registry refused: one sentence each (`eventText` in `a11y-text.js`, from the state change itself, so a drag, a key and a toolbar button all announce the same)
- link mode cancelled; the inspector pinned / dismissed; the view changed ("View 3 of 10: ...")

Ports, pieces, slots and every inspectable thing have an accessible name
(`orders:out, out port on a place, schema queue:items`); the focused thing is
described through `aria-describedby` (the ontology concept, its definition and
facts, from the same `info` the hover inspector shows, as plain text) plus a short
hint of what Enter does. In link mode the descriptions stand down, because the
live region is speaking.

## The inspector without hover

Hover and keyboard focus show a thing in the Inspector panel (and the short tip at
the thing, since the panel can be below the fold). A click, a tap, `Enter` or `I`
pins it; a second click or tap on the same thing, `Esc`, or the Dismiss button lets
go. On a narrow screen a pinned inspector is a sheet over the bottom of the screen,
so a tap shows it. It never traps focus: the pin is released with `Esc`, and the
panel's links are ordinary content after the diagram. A click now pins the thing
clicked (the innermost, the one hover shows), not the outermost of the things
nested around it.

## Colour is not the only carrier

- **Link kind**: each kind has a stroke and a glyph as well as a colour, RenderDOT's
  vocabulary (go-pflow `metamodel/composedot.go`): token dashed `◆`, data dotted
  `▷`, event bold `⊗`, guard dash-dot `⊘`. The registry gives guard and token the
  same dash; the page gives guard its own (`distinctDashes`, applied at load).
  The legend card lists all four, drawn.
- **Port schema**: every place port's dot carries a letter (I `queue:items`, P
  `queue:payload`, R `resource`, A `account`, S `saga:outcome`); transition ports
  are squares with no schema. The legend lists them.
- **While linking**: lit targets glow and the rest fade; the band is dashed to a
  refused target; and the same is in words through the live region.
- the Links card names each link's kind in words for a screen reader.

The scene manifest (`ctx.emit`) is unchanged: none of this is drawn by the views,
and `parity/composition-views/` still compares 112 of 112 with pflow-native.

## Structure

`compose.html` has a skip link, one `h1`, `main`, a `nav` holding the view tablist
(`role=tab`, `aria-selected`, `aria-controls`, `aria-keyshortcuts` 1-9,0), an
`aside`, headings and labelled cards, the Keyboard card, and the Legend card. Each
view's svg is a labelled group (`role=group`, `aria-roledescription=diagram`,
`aria-label`, a `<desc>` from the view's summary). It is a group, not `role=img`,
because an image hides its parts from assistive technology and these parts are
the interface. Decorative shapes are `aria-hidden`; their text labels stay in the
reading order. Toggles say `aria-pressed`.

## Reduced motion

`prefers-reduced-motion: reduce` stops every CSS animation and transition (one rule
in `compose.css`), zeroes every Web Animations API animation the views run (one
guard on `Element.animate`, `motion.js`, read at each call), skips the Spiders
fusion and the Laws pulse (as before), and turns off the Lenses play dot
(`lens.js`; the drawing says the same). Stepping through the token game in the Flat
view is a user-started sequence of states, not motion, and still runs.

## Not covered (honestly)

- **No real assistive technology was run.** The wording, the live region's pacing
  and `aria-describedby` on focus are checked with Chrome and key events, not with
  VoiceOver, NVDA, JAWS or TalkBack. Expect to tune wording. There is no axe or
  Lighthouse audit, and colour contrast of the views' own palettes was not audited.
- **Big drawings are long.** Incidence has about 500 inspectable cells: reachable
  by arrows, with `Home`/`End`, but with no table or grid semantics (row and column
  names). The diagram text stays in the reading order, which is verbose.
- **Other colour-only channels remain**: the Connect-4 views' search wire types
  (Position, Value, MoveList, ...) and piece kinds are coloured (the labels name
  them), and the red/green states of the process and lens views. Only link kinds
  and port schemas, the two the page's rules turn on, were given a second channel.
  Views that hard-code a dash for a kind (a few guard strokes in Spiders, String
  and Boundaries) were not unified with the legend's.
- **The schema letter is tiny** (about 7-9 px) on small dots, and beside the arrow
  rather than inside it in the Spiders view.
- **Some interactions are still pointer-only**: the draggable magnifier lens in the
  String view's transition level; dragging in the Laws view's Chyp diagrams (its
  internals are Pyodide's). The Laws view's own buttons are ordinary buttons.
- **A pinned inspector on a narrow screen covers the lower part of the view**: a
  covered thing cannot be tapped for its second tap; use the Dismiss button or `Esc`.
- **Focus after a view change**: if the focused thing is not in the new view, focus
  goes to the diagram region, not to a similar thing.
- **Touch dragging** is as before (the pointer path is unchanged); the keyboard path
  is the alternative, there is no touch-specific linking gesture.
- The token game's firing in the Flat view is not announced (only the inspector
  facts, which follow it, change).
