# pflow-xyz

**Interactive web component for authoring, visualizing, and simulating Petri nets.**

[![](https://data.jsdelivr.com/v1/package/gh/pflow-xyz/pflow-xyz/badge)](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz)

## Try It Live

**Editor:** [pflow.xyz](https://pflow.xyz) | **Models you can run and check:** [sim.pflow.xyz](https://sim.pflow.xyz) | **Book:** [book.pflow.xyz](https://book.pflow.xyz)

### Models on sim.pflow.xyz

Describe a decision, process or mechanism to your AI assistant and get back a model you can run and check. Open one to see how it behaves:

| Model | What it shows | Link |
|-------|---------------|------|
| **Second car or ride-share?** | A household decision with its spread shown | [Open](https://sim.pflow.xyz/second-car/) |
| **Cold-chain attack** | How many technicians it takes to beat a freezer defrost attack | [Open](https://sim.pflow.xyz/whatif/?id=7d736018c17edd5d7b083444) |
| **Baggage hall** | Conveyor health against sorter headcount | [Open](https://sim.pflow.xyz/whatif/?id=3741e97f8256ab15e7a28aed) |

---

## The pflow Ecosystem

| Project | Purpose | Language |
|---------|---------|----------|
| **[pflow-xyz](https://github.com/pflow-xyz/pflow-xyz)** | Visual editor + browser ODE simulator, byte-exact to go-pflow | JavaScript |
| **[go-pflow](https://github.com/pflow-xyz/go-pflow)** | Core library — ODE/SSA/SDE engines, fitting, reachability & verification | Go |
| **[pflow-rs](https://github.com/pflow-xyz/pflow-rs)** | Rust port — ODE solvers, token-model DSL, ZK provers | Rust |
| **[pflow-jl](https://github.com/pflow-xyz/pflow-jl)** | Julia port, bridged to AlgebraicPetri.jl for categorical composition | Julia |
| **[sim-pflow-xyz](https://sim.pflow.xyz)** | Describe a process, get a model you can run and check (hosted, MCP) | Go |
| **[book-pflow-xyz](https://github.com/pflow-xyz/book-pflow-xyz)** | "Petri Nets as a Universal Abstraction" — practitioner's guide | mdBook |

```
JSON-LD Model ──▶ go-pflow (engines) ──▶ sim.pflow.xyz (run + check)
      ▲                                          │
      └──── pflow-xyz (visual editor) ◀──────────┘
            book-pflow-xyz (guide)
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

**Analysis workbench** (`9` or ☰ → Analysis) — Tsit5 adaptive solver with mass-action kinetics, in four tabs: time-series **Simulate**, **Rate Scan** (steady state vs one rate), **Sweep** (overlaid trajectories), and **Phase Plot**. Interactive plots (crosshair, click-to-toggle legend), numeric results tables and CSV/JSON export.

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

[sim.pflow.xyz](https://sim.pflow.xyz) provides an MCP server for AI assistants to build, run and check models. This repo ships a `.mcp.json` pointing at the hosted server, so Claude Code picks it up automatically (in the terminal and on the web). To add it to other clients:

```bash
claude mcp add --transport http sim https://sim.pflow.xyz/mcp
```

| Tool | Description |
|------|-------------|
| `sim_create_model` | Store a model from a description or net |
| `sim_scenario` | Seeded what-if runs |
| `sim_invariants` | Conservation laws |
| `sim_reach` | Reachability and deadlocks |
| `sim_verify` | Check properties of a model |
| `sim_code_to_flow` | Turn code into a flow model |

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
| **Sim** | [sim.pflow.xyz](https://sim.pflow.xyz) |
| **Book** | [book.pflow.xyz](https://book.pflow.xyz) |
| **go-pflow** | [github.com/pflow-xyz/go-pflow](https://github.com/pflow-xyz/go-pflow) |
| **CDN** | [jsdelivr.com/package/gh/pflow-xyz/pflow-xyz](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz) |
| **npm** | [@pflow-xyz/pflow-xyz](https://www.npmjs.com/package/@pflow-xyz/pflow-xyz) |
| **Schema** | [pflow.xyz/schema](https://pflow.xyz/schema) |

## Contributing

We don't merge outside code, so pull requests won't be merged as-is.
Feature requests and bug reports are welcome: please open an
[issue](https://github.com/pflow-xyz/pflow-xyz/issues).

## License

See [LICENSE](LICENSE) file for details.
