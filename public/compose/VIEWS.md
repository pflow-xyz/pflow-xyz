# Views on the composition page

Every view `compose.html` shows is an entry in the view registry,
`views-meta.js`. (`registry.js` is another thing: pflow-native's command
registry, which decides the rules.) The tabs, the number keys, the key help, the
`#view=` links and the index at `#view=index` are generated from that list. No
other file names a view.

## Adding a view

1. Store the view: a module under `views/`, or any other file (under `views/stored/`
   or on `cdn.stackdump.com/ipfs/`).
2. Add one line to `ENTRIES` in `views-meta.js`, at the end. An entry's position is
   its tab number and its number key, so adding in the middle moves the keys of
   the ones after it. Its `id` is the view's link: do not rename one without keeping
   the old name in `aliases`.
3. Run `make test-js`, and `scripts/views-smoke.ts` against a running server.

Nothing else changes, and that is checked: the smoke test adds a module and a stored
file by rewriting `views-meta.js` alone, in flight, and drives them in Chrome.

## An entry

| Field | | |
|---|---|---|
| `id` | required | Lower-case letters, digits, hyphens. The link's `view=`. `index` is taken. |
| `short`, `title` | required | The tab's label; the tab's tooltip and the view's heading. |
| `kind` | default `module` | How it is shown: `module`, `image`, `video`, `html`, `text`, `json`, `file`. |
| `src` | default `views/<id>.js` | Relative to `compose/`. A module must be under `views/`: it runs in the page, so it comes from this repository. A stored file may also be a `https://cdn.stackdump.com/ipfs/…` URL. |
| `aliases` | default `[]` | Other names a link may use (`#view=wiring` opens `operad`). The page writes the id back. |
| `examples` | default both | A stored file about one example. It says so when the other is selected, and the index links only to the ones listed. |
| `parity` | default `false` | The view is under the scene-manifest contract with pflow-native's egui renderer (`parity_test.ts` then expects goldens for it). |
| `alt` | | A stored image or video's text alternative. |
| `source`, `consumes`, `convention` | stored files only | As in a module, below. On a stored file `source` is required too: who or what made it. |

```js
{ id: 'pushout-sketch', short: 'Sketch', title: 'A pushout, by hand', kind: 'image',
  src: 'views/stored/pushout-sketch.svg', alt: 'Two places glued into one', examples: ['orders'],
  source: 'drawn by hand, 2026-10-30', consumes: [],
  convention: { summary: 'What the file shows.', honesty: ['Drawn by hand: judgment, not the registry\'s output.'], bib: ['baez-master'] } },
```

An html file runs in an iframe sandboxed with `allow-scripts` only, so it cannot
reach the page. A `text` or `json` file on the CDN must be served with CORS.

## A module

```js
export default {
  id: 'cospan',               // as in the entry (a test holds these three equal)
  title: 'Open Petri nets as cospans',
  short: 'Cospans',
  consumes: ['bundle.flatten', 'bundle.state', 'plan.state'],
  convention: { summary, honesty, bib, cites, examples },
  render(ctx) { /* draw into ctx.root; ctx.js has the rest */ },
};
```

`consumes` lists what the view reads while it draws: the commands it issues on any
engine, what it takes from `ctx.orders`, `ctx.plan` and `ctx.connect4` (named by the
command that filled it), and the `assets/` files it loads. Facts every view shares,
which `model.js` reads once (`bundle.ontology` and the like), are not listed.
`views_registry_test.ts` measures this over the parity contract's states on both
examples and fails if the list is not exactly what was read. It says nothing about
what a click does: an edit goes through `ctx.actions`.

A view added without `parity: true` has no goldens to meet, but is still measured.

## What the page will not show

The honesty rules are enforced at load (`entryProblems`, `viewProblems`, `loader.js`).
A view that breaks one is listed and its tab is struck through, and the stage says
what is missing instead of drawing it:

- no `convention.summary`: it does not say what it shows;
- no `convention.honesty`: it does not mark what in it is judgment (a layout choice, a
  reading of a source, an analogy) as opposed to the registry's answer;
- no provenance: none of `convention.bib`, `convention.cites` or `source`;
- no `consumes`.

A stored file additionally says, on the stage every time it is drawn, that it is a
stored file and not drawn by the registry, that it does not change with the links,
instances or plan on the page, and where it came from. The index shows each view's
reads, sources and judgment in the view's own words.

## Links

```
compose.html#view=<id>&ex=<orders|connect4>
             [&inst=orders,workers,payment,payment2]
             [&links=event~orders:dequeue~workers:acquire,token~a:x~b:y]
             [&plan=<base64url of the plan JSON>]
             [&level=… &lens=… &run=… &idle=… &law=… &rw=… &rule=…]
```

| Parameter | Means | Written |
|---|---|---|
| `view` | A view's id or alias, or `index`. Unknown: the view does not change and the real one is written back. | Always |
| `ex` | The example. | Always |
| `inst` | The instances in the composition. | When they are not the default ones |
| `links` | The links as `kind~subnet:port~subnet:port`, comma-separated. Empty means no links, which is not the same as absent. | When they are not the default ones |
| `plan` | The search plan's JSON. | When it is not the default one |
| others | A view's own (`string.js`, `lens-orders.js`, `process.js`, `laws.js`). The page keeps them. | By the view |

So the plain link to a view on an example stays short, and a link made after an
edit reproduces the edit. `links.js` reads and writes the format and decides nothing:
`state.js` gives what a link asks for to the registry (`bundle.open`, `plan.open`).
What the registry refuses is said in the bar above the stage and through the live
region, the default composition or plan is drawn instead, and the address is written
back to say what is drawn.

Choosing a view or an example and each edit is a history entry, so back and forward
walk them, reopening the composition each named. A view's own toggle is not one: it
replaces the entry. A `?cid=` on the page is kept in every link.

`docs/design/models-first.md` plans `/m/<name>#v=<id>` for slice 2, not built. Its
redirect would map these links, and these parameters would need to travel with it.

## Keys

`1`–`9`, `0`: the first ten views, by position. `[` `]`: the previous or next view,
wrapping, whichever it is, so no view is out of reach however many there are. `V`: the
index. `E`: the other example. A view past the tenth has no number key and no
`aria-keyshortcuts`, and the key help says so.
