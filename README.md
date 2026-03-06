# pflow-xyz

**Interactive web component for authoring, visualizing, and simulating Petri nets.**

[![](https://data.jsdelivr.com/v1/package/gh/pflow-xyz/pflow-xyz/badge)](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz)

## Try It Live

**Editor:** [pflow.xyz](https://pflow.xyz) | **Demos:** [pilot.pflow.xyz](https://pilot.pflow.xyz) | **Code to Flow:** [pilot.pflow.xyz/code-to-flow](https://pilot.pflow.xyz/code-to-flow/) | **Book:** [book.pflow.xyz](https://book.pflow.xyz) | **GraphQL:** [pilot.pflow.xyz/graphql/i](https://pilot.pflow.xyz/graphql/i)

### Demos

Every demo is a full-stack app generated from a Petri net model by [petri-pilot](https://github.com/pflow-xyz/petri-pilot).

| Demo | Concepts | Link |
|------|----------|------|
| **Tic-Tac-Toe** | Places, transitions, arcs, ODE analysis | [Play](https://pilot.pflow.xyz/tic-tac-toe/) |
| **ZK Tic-Tac-Toe** | Zero-knowledge proofs with gnark circuits | [Play](https://pilot.pflow.xyz/zk-tic-tac-toe/) |
| **Coffee Shop** | Capacity limits, weighted arcs, resource flow | [Play](https://pilot.pflow.xyz/coffeeshop/) |
| **Texas Hold'em** | Role-based access, guards, event sourcing | [Play](https://pilot.pflow.xyz/texas-holdem/) |
| **Knapsack** | Optimization via mass-action kinetics | [Play](https://pilot.pflow.xyz/knapsack/) |
| **Predator-Prey** | Lotka-Volterra dynamics, continuous simulation | [Play](https://pilot.pflow.xyz/predator-prey/) |
| **Dining Philosophers** | Deadlock detection, mutual exclusion | [Play](https://pilot.pflow.xyz/dining-philosophers/) |
| **Loan Approval** | Multi-stage workflow, conditional branching | [Play](https://pilot.pflow.xyz/loan-approval/) |
| **TCP Handshake** | Protocol state machines, sequencing | [Play](https://pilot.pflow.xyz/tcp-handshake/) |
| **Thermostat** | Feedback loops, threshold-based control | [Play](https://pilot.pflow.xyz/thermostat/) |
| **Producer-Consumer** | Buffered channels, synchronization | [Play](https://pilot.pflow.xyz/producer-consumer/) |
| **Hiring Pipeline** | Multi-phase pipeline, resource tracking | [Play](https://pilot.pflow.xyz/hiring-pipeline/) |
| **Enzyme Kinetics** | Michaelis-Menten, biochemical modeling | [Play](https://pilot.pflow.xyz/enzyme-kinetics/) |
| **Stoplight** | Cyclic state machines, timing constraints | [Play](https://pilot.pflow.xyz/stoplight/) |

---

## The pflow Ecosystem

| Project | Purpose | Language |
|---------|---------|----------|
| **[pflow-xyz](https://github.com/pflow-xyz/pflow-xyz)** | Visual editor & ODE simulator | JavaScript |
| **[go-pflow](https://github.com/pflow-xyz/go-pflow)** | Petri net library, simulation & code generation | Go |
| **[petri-pilot](https://github.com/pflow-xyz/petri-pilot)** | MCP server + full-stack app generation from models | Go |
| **[book-pflow-xyz](https://github.com/pflow-xyz/book-pflow-xyz)** | "Petri Nets as a Universal Abstraction" — practitioner's guide | mdBook |

```
JSON-LD Model ──▶ go-pflow (codegen) ──▶ petri-pilot (serve) ──▶ Running App
      ▲                                                               │
      └──────────── pflow-xyz (visual editor) ◀───────────────────────┘
                    book-pflow-xyz (guide)
```

### Design Philosophy

**Arc topology replaces coded formulas.** A Petri net's structure — which places connect to which transitions, with what weights — encodes behavior declaratively. A double arc makes a transition fire quadratically with token concentration. Changing a rate constant tunes dynamics without touching logic. The wiring *is* the program.

This means models stay small enough to visualize and verify, while producing real applications. See [Building ZK Poker](https://blog.stackdump.com/posts/building-zk-poker) for a deep dive into how four cooperating Petri nets drive a provably fair poker game — strategy, hand evaluation, chip conservation, and phase control, all from arc topology.

---

## Quick Start

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

**Editor** — Drag-and-drop places, transitions, arcs. Inhibitor arcs, capacity limits, multi-select, pan & zoom, undo/redo.

**ODE Simulation** — Tsit5 adaptive solver, mass-action kinetics, rate optimization, interactive SVG plots.

**Data** — JSON-LD with [schema](https://pflow.xyz/schema), IPFS CID content addressing, custom events, public API.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1-6` | Switch modes (select, place, transition, arc, token, delete) |
| `Space` + drag | Pan canvas |
| `Ctrl/Cmd + Z/Shift+Z` | Undo / Redo |
| `Delete` | Delete selected |
| `X` | Start/stop simulation |
| `Shift` + click/drag | Multi-select / bounding box |

---

## AI-Assisted Development (MCP)

[petri-pilot](https://github.com/pflow-xyz/petri-pilot) provides an MCP server for AI assistants to design models and generate apps.

| Tool | Description |
|------|-------------|
| `petri_validate` | Structural correctness |
| `petri_simulate` | Fire transitions, verify behavior |
| `petri_analyze` | Reachability, deadlocks, liveness |
| `petri_codegen` | Generate Go backend |
| `petri_frontend` | Generate ES modules frontend |
| `petri_application` | Full-stack app from spec |

```bash
petri-pilot codegen -o ./myapp -pkg myapp model.json
petri-pilot frontend -o ./myapp/frontend model.json
```

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
| **Demos** | [pilot.pflow.xyz](https://pilot.pflow.xyz) |
| **Code to Flow** | [pilot.pflow.xyz/code-to-flow](https://pilot.pflow.xyz/code-to-flow/) |
| **Book** | [book.pflow.xyz](https://book.pflow.xyz) |
| **GraphQL** | [pilot.pflow.xyz/graphql/i](https://pilot.pflow.xyz/graphql/i) |
| **go-pflow** | [github.com/pflow-xyz/go-pflow](https://github.com/pflow-xyz/go-pflow) |
| **petri-pilot** | [github.com/pflow-xyz/petri-pilot](https://github.com/pflow-xyz/petri-pilot) |
| **CDN** | [jsdelivr.com/package/gh/pflow-xyz/pflow-xyz](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz) |
| **Schema** | [pflow.xyz/schema](https://pflow.xyz/schema) |

## License

See [LICENSE](LICENSE) file for details.
