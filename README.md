# pflow-xyz

**Understand a system by modeling it with Claude.**

[![](https://data.jsdelivr.com/v1/package/gh/pflow-xyz/pflow-xyz/badge)](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz)

pflow.xyz is a modeling tool that teaches. You describe a system and talk it
through with Claude: Claude builds the model with you, explains each concept as
it comes up, and answers your questions from data the engine computed, not from
a guess. A model is shown from several views (the outcome in plain words, the
model itself, the math underneath, its text notation and a simulation), much as
a CAD drawing shows one part as plan, elevation and section. Every view is
computed from the same net, so the views cannot drift apart the way hand-drawn
diagrams do.

The engine is a Petri net. You don't need to know that to start; the views and
Claude's explanations introduce it when it helps.

## Try It Live

**Editor:** [pflow.xyz](https://pflow.xyz) | **Claude connector:** [pflow.xyz/mcp.html](https://pflow.xyz/mcp.html) | **Book:** [book.pflow.xyz](https://book.pflow.xyz)

### Working with Claude: the IDE preview

The IDE shell is on main behind a flag: open [pflow.xyz/?shell=1](https://pflow.xyz/?shell=1).
It arranges the editor's results as panels at three levels of detail: **outcome**
(answers and plots, no Petri-net terms), **model** (the canvas, the notation, an
outline and checks) and **math** (invariants, reachability, categorical views).
Choose *Link to Claude* in the page, add the [connector](https://pflow.xyz/mcp.html),
and Claude can drive the page while you watch:

| Tool | What Claude does with it |
|------|--------------------------|
| `pflow_show` | Put a net on the canvas or open a view (plot, reachability, invariants, notation, categorical) |
| `pflow_level` | Set the level of detail: outcome, model or math |
| `pflow_highlight` | Point at places, transitions or notation lines |
| `pflow_annotate` | Add a line of narration, optionally at a target |
| `pflow_focus` | Bring a node, line or panel into view |
| `pflow_tour` | Walk through a model step by step; you move with Back / Next |

The design and contract are in [`docs/ide-shell.md`](docs/ide-shell.md); the
notation is [`docs/pflow-notation.md`](docs/pflow-notation.md).

---

## The pflow Ecosystem

| Project | Purpose | Language |
|---------|---------|----------|
| **[pflow-xyz](https://github.com/pflow-xyz/pflow-xyz)** | Visual editor + browser ODE simulator, byte-exact to go-pflow | JavaScript |
| **[go-pflow](https://github.com/pflow-xyz/go-pflow)** | Core library — ODE/SSA/SDE engines, fitting, reachability & verification | Go |
| **[pflow-rs](https://github.com/pflow-xyz/pflow-rs)** | Rust port — ODE solvers, token-model DSL, ZK provers | Rust |
| **[pflow-jl](https://github.com/pflow-xyz/pflow-jl)** | Julia port, bridged to AlgebraicPetri.jl for categorical composition | Julia |
| **[book-pflow-xyz](https://github.com/pflow-xyz/book-pflow-xyz)** | "Petri Nets as a Universal Abstraction" — practitioner's guide | mdBook |

```
   you ◀──talk──▶ Claude ──MCP──▶ pflow.xyz/mcp ──▶ go-pflow (engines)
                     │                  │
                     └──── drives ────▶ IDE shell: outcome · model · math views
                                        (one JSON-LD net, every view computed from it)
```

### Design Philosophy

**Arc topology replaces coded formulas.** A Petri net's structure — which places connect to which transitions, with what weights — encodes behavior declaratively. A double arc makes a transition fire quadratically with token concentration. Changing a rate constant tunes dynamics without touching logic. The wiring *is* the program.

This means models stay small enough to visualize and verify, while producing real applications. See [Building ZK Poker](https://blog.stackdump.com/posts/building-zk-poker) for a deep dive into how four cooperating Petri nets drive a provably fair poker game — strategy, hand evaluation, chip conservation, and phase control, all from arc topology.

---

## Quick Start

### npm

```bash
npm i @pflow-xyz/pflow-xyz
```

```javascript
import * as Solver from '@pflow-xyz/pflow-xyz';
import '@pflow-xyz/pflow-xyz/petri-view.js';
```

### CDN

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/petri-view.css"/>
<script type="module" src="https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/petri-view.js"></script>

<petri-view id="pv" data-json-editor>
    <script type="application/ld+json">
    {
        "@context": "https://pflow.xyz/schema",
        "@type": "PetriNet",
        "@version": "1.1",
        "arcs": [],
        "places": {},
        "token": ["https://pflow.xyz/tokens/black"],
        "transitions": {}
    }
    </script>
</petri-view>
```

### ODE Solver (Standalone)

```javascript
import * as Solver from 'https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/petri-solver.js';

const net = Solver.fromJSON(petriNetData);
const prob = new Solver.ODEProblem(net, Solver.setState(net), [0, 10], Solver.setRates(net, { produce: 1.0 }));
const sol = Solver.solve(prob, Solver.Tsit5(), { dt: 0.01 });
```

---

## Features

**Editor** — Drag-and-drop places, transitions, arcs. Inhibitor arcs, capacity limits, multi-select, pan & zoom, undo/redo. Light + dark theme (follows `prefers-color-scheme`).

**The bar** — Ask (say what you want to know or change; a result says how it was computed), File / View / Help, **Tools** (`Ctrl K` or `⌘K`: every command with a form for its arguments, no model needed) and a problems chip that checks the net as you edit. The old single hamburger menu is still there for this release at `?ui=classic`.

**Analysis workbench** (`9`, or Tools → Classic tools → Analysis) — Tsit5 adaptive solver with mass-action kinetics, in four tabs: time-series **Simulate**, **Rate Scan** (steady state vs one rate), **Sweep** (overlaid trajectories), and **Phase Plot**. Interactive plots (crosshair, click-to-toggle legend), numeric results tables and CSV/JSON export.

**Ad-hoc pages** — every module is served from pflow.xyz with `Access-Control-Allow-Origin: *`, so a scratch HTML file (or an AI assistant writing one) can `import "https://pflow.xyz/petri-solver.js"` directly. See [pflow.xyz/llms.txt](https://pflow.xyz/llms.txt) for copy-paste recipes and the model format.

**Data** — JSON-LD with [schema](https://pflow.xyz/schema), IPFS CID content addressing, custom events, public API.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1-6` | Switch modes (select, place, transition, arc, token, delete) |
| `Space` + drag | Pan canvas |
| `Ctrl/Cmd + Z/Shift+Z` | Undo / Redo |
| `Delete` | Delete selected |
| `7` | Toggle label edit |
| `8` / `X` | Start/stop simulation |
| `9` | Analysis workbench |
| `Shift` + click/drag | Multi-select / bounding box |

---

## AI-Assisted Development (MCP)

pflow.xyz serves its own MCP server at `https://pflow.xyz/mcp` (`pflow_*` tools: build, check, simulate, explore, prove and publish a net, and the teaching tools above that drive a linked IDE page; see [pflow.xyz/mcp.html](https://pflow.xyz/mcp.html)). Its source is this repo (`cmd/webserver`, over go-pflow). This repo's `.mcp.json` points Claude Code at it. To add it elsewhere:

```bash
claude mcp add --transport http pflow https://pflow.xyz/mcp
```

The model tools also run offline, with no account, as [`@pflow-xyz/pflow-mcp`](https://www.npmjs.com/package/@pflow-xyz/pflow-mcp) from pflow-rs.

---

## Events & API

```javascript
const pv = document.querySelector('petri-view');
pv.addEventListener('transition-fired-success', (e) => console.log('Fired:', e.detail.id));
pv.addEventListener('marking-changed', (e) => console.log('Tokens:', e.detail.marks));

const model = pv.getModel();
pv.setModel(newModel);
pv.importJSON(jsonData);
```

---

## Links

| Resource | URL |
|----------|-----|
| **Live Editor** | [pflow.xyz](https://pflow.xyz) |
| **Claude connector** | [pflow.xyz/mcp.html](https://pflow.xyz/mcp.html) |
| **Book** | [book.pflow.xyz](https://book.pflow.xyz) |
| **go-pflow** | [github.com/pflow-xyz/go-pflow](https://github.com/pflow-xyz/go-pflow) |
| **CDN** | [jsdelivr.com/package/gh/pflow-xyz/pflow-xyz](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz) |
| **npm** | [@pflow-xyz/pflow-xyz](https://www.npmjs.com/package/@pflow-xyz/pflow-xyz) |
| **Schema** | [pflow.xyz/schema](https://pflow.xyz/schema) |

## Check it yourself

The editor, the hosted MCP server, the engines and the saved nets are public, so
a result from pflow.xyz can be re-run instead of trusted:

- **A net and its CID.** `https://pflow.xyz/o/<cid>` returns a saved net as
  JSON-LD, for anyone. Its CID is CIDv1 (dag-json, sha2-256, base58btc) over the
  URDNA2015 canonical form of the net, computed by `internal/seal` (Go) and
  `public/seal-cid.mjs` (browser), which `make test-parity` holds to
  `parity/golden.json`; go-pflow and pflow-rs compute the same value. To recompute
  one, drop the `@id` and the `author` that the store adds after sealing, and call
  `computeCid` from `seal-cid.mjs`. Not every saved net passes: of the six landing
  examples, coffee-shop and usdc-bridge do not recompute to the CID they are stored
  under (checked 2026-11-10; cause not yet found).
- **A seeded simulation.** The browser SSA is byte-exact with go-pflow and pflow-rs
  at the same seed (`parity/ssa/`, from go-pflow's goldens); the ODE solver is held
  to go-pflow's expected values (`parity/ode/`).
- **A verdict on a page.** A `pflow_artifact` page carries the net, its CID and an
  editor link. Its reachability verdicts come from the engine, and a deadlock comes
  with a trace the page replays. With `engine: "wasm"` the page loads the pflow-rs
  engine, `@pflow-xyz/engine`, pinned to an exact version with an SRI hash.
- **A hosted answer.** The `pflow_*` tools are in `cmd/webserver`, over go-pflow;
  pflow-rs replays captured answers from them in its tests.

## Contributing

We don't merge outside code, so pull requests won't be merged as-is.
Feature requests and bug reports are welcome: please open an
[issue](https://github.com/pflow-xyz/pflow-xyz/issues).

## License

MIT. See [LICENSE](LICENSE).
