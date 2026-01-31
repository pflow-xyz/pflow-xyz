# pflow-xyz

**Interactive web component for authoring, visualizing, and simulating Petri nets.**

[![](https://data.jsdelivr.com/v1/package/gh/pflow-xyz/pflow-xyz/badge)](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz)

> Petri nets are a mathematical formalism for modeling concurrent systems, workflows, and resource flows. Unlike statistical ML models, Petri nets provide **explicit causal structure** — the model itself is the explanation.

## The pflow Ecosystem

pflow-xyz is part of a suite of tools for Petri net-based application development:

| Project | Purpose | Language |
|---------|---------|----------|
| **[pflow-xyz](https://github.com/pflow-xyz/pflow-xyz)** | Browser-based visual editor & ODE simulator | JavaScript |
| **[go-pflow](https://github.com/pflow-xyz/go-pflow)** | Production library for Petri net modeling, simulation & code generation | Go |
| **[petri-pilot](https://github.com/pflow-xyz/petri-pilot)** | MCP server for AI-assisted model design + full-stack app generation | Go |

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Development Flow                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│   │  pflow-xyz   │───▶│   go-pflow   │───▶│    petri-pilot       │  │
│   │              │    │              │    │                      │  │
│   │ Visual Editor│    │ Go Library   │    │ MCP Server +         │  │
│   │ ODE Simulator│    │ ODE Solver   │    │ Code Generation      │  │
│   │ JSON-LD I/O  │    │ Code Gen     │    │ Full-Stack Apps      │  │
│   └──────────────┘    └──────────────┘    └──────────────────────┘  │
│         │                    │                      │                │
│         ▼                    ▼                      ▼                │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │                    JSON-LD Models                             │  │
│   │              https://pflow.xyz/schema                         │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

## Try It Live

### Interactive Tutorials

Learn Petri net concepts through playable demos at **[pilot.pflow.xyz](https://pilot.pflow.xyz)**:

| Demo | Concepts | Link |
|------|----------|------|
| **Tic-Tac-Toe** | Places, transitions, arcs, ODE strategic analysis | [Play](https://pilot.pflow.xyz/tic-tac-toe/) |
| **ZK Tic-Tac-Toe** | Zero-knowledge proofs with gnark circuits | [Play](https://pilot.pflow.xyz/zk-tic-tac-toe/) |
| **Coffee Shop** | Capacity limits, weighted arcs, resource flow | [Play](https://pilot.pflow.xyz/coffeeshop/) |
| **Texas Hold'em** | Role-based access, guards, event sourcing | [Play](https://pilot.pflow.xyz/texas-holdem/) |
| **Knapsack** | Optimization via mass-action kinetics | [Play](https://pilot.pflow.xyz/knapsack/) |

### Visual Editor

Build your own models: **[pflow.xyz](https://pflow.xyz)** or **[pilot.pflow.xyz/pflow](https://pilot.pflow.xyz/pflow)**

### GraphQL API

Every model becomes a typed API: **[pilot.pflow.xyz/graphql/i](https://pilot.pflow.xyz/graphql/i)**

---

## AI-Assisted Development (MCP)

[petri-pilot](https://github.com/pflow-xyz/petri-pilot) provides an **MCP (Model Context Protocol) server** that enables AI assistants like Claude to design Petri net models and generate applications.

### MCP Tools

| Tool | Description |
|------|-------------|
| `petri_validate` | Check model for structural correctness |
| `petri_simulate` | Fire transitions and verify behavior |
| `petri_analyze` | Reachability, deadlocks, liveness analysis |
| `petri_codegen` | Generate Go backend from model |
| `petri_frontend` | Generate ES modules frontend |
| `petri_application` | Generate complete full-stack app |

### Example: AI-Driven App Generation

```
User: "Create a task management app with todo, in-progress, and done states"

Claude (via MCP):
1. petri_validate() - Design and validate the workflow model
2. petri_simulate() - Test state transitions
3. petri_application() - Generate Go backend + ES modules frontend
4. service_start() - Launch the application
```

The result is a working application with:
- Event-sourced state management
- REST/GraphQL APIs
- Real-time UI
- SQLite persistence

---

## Quick Start

### Using jsDelivr CDN (Recommended)

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Petri Net Editor</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/petri-view.css"/>
</head>
<body>
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
</body>
</html>
```

### ODE Solver (Standalone)

The `petri-solver.js` module can be used independently:

```javascript
import * as Solver from 'https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/petri-solver.js';

// Parse Petri net from JSON-LD
const net = Solver.fromJSON(petriNetData);

// Set up initial state and rates
const initialState = Solver.setState(net);
const rates = Solver.setRates(net, { produce: 1.0, consume: 0.5 });

// Solve ODE
const prob = new Solver.ODEProblem(net, initialState, [0, 10], rates);
const sol = Solver.solve(prob, Solver.Tsit5(), { dt: 0.01 });

// Plot results
const svg = Solver.SVGPlotter.plotSolution(sol, ['buffer'], {
  title: 'Token Flow Over Time'
});
```

---

## Features

### Visual Editor
- **Drag-and-drop** places, transitions, and arcs
- **Inhibitor arcs** that block transitions
- **Place capacity** limits with visual indicators
- **Multi-select** with shift-click or bounding box
- **Pan & zoom** for large nets
- **Undo/redo** full history

### ODE Simulation
- **Tsit5 solver** (5th order Runge-Kutta, adaptive)
- **Mass-action kinetics** automatic ODE generation
- **Rate optimization** find optimal transition rates
- **Interactive plotting** with SVG output

### Data & Integration
- **JSON-LD format** with schema at `https://pflow.xyz/schema`
- **IPFS CID** content addressing (SHA2-256)
- **Custom events** for framework integration
- **Public API** for programmatic control

---

## How It Differs From AI/ML

| Aspect | Machine Learning | Petri Net Simulation |
|--------|------------------|---------------------|
| **Model** | Learned weight matrices | User-defined graph structure |
| **Behavior** | Probabilistic inference | Deterministic state evolution |
| **Explanation** | Requires interpretability tools | The model *is* the explanation |
| **Computation** | Gradient descent on loss | ODE integration of token flow |

Petri nets provide **explicit causal structure**. Token flow follows directly from places, transitions, and arcs — no training data, no opacity.

```
ML:        f(data) → learned weights → probabilistic inference
Petri:     f(structure) → ODE integration → deterministic trajectories
```

---

## JSON-LD Schema

Models use JSON-LD format compatible across all pflow tools:

```json
{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "places": {
    "ready": { "@type": "Place", "initial": [1], "x": 100, "y": 100 },
    "running": { "@type": "Place", "initial": [0], "x": 250, "y": 100 },
    "done": { "@type": "Place", "initial": [0], "x": 400, "y": 100 }
  },
  "transitions": {
    "start": { "@type": "Transition", "x": 175, "y": 100 },
    "finish": { "@type": "Transition", "x": 325, "y": 100 }
  },
  "arcs": [
    { "@type": "Arrow", "source": "ready", "target": "start", "weight": [1] },
    { "@type": "Arrow", "source": "start", "target": "running", "weight": [1] },
    { "@type": "Arrow", "source": "running", "target": "finish", "weight": [1] },
    { "@type": "Arrow", "source": "finish", "target": "done", "weight": [1] }
  ]
}
```

---

## Code Generation

### From Model to Application

petri-pilot can generate complete applications from Petri net models:

**Backend (Go):**
- Event-sourced aggregate with Petri net workflow
- REST API handlers for each transition
- GraphQL schema and resolvers
- SQLite persistence

**Frontend (ES Modules):**
- State visualization
- Transition forms
- Admin dashboard
- Real-time updates

```bash
# Generate backend
petri-pilot codegen -o ./myapp -pkg myapp model.json

# Generate frontend
petri-pilot frontend -o ./myapp/frontend model.json

# Or generate both via MCP
petri_application(spec='{"name":"myapp", ...}')
```

---

## Events & API

### Custom Events

```javascript
const pv = document.querySelector('petri-view');

pv.addEventListener('transition-fired-success', (e) => {
  console.log('Fired:', e.detail.id);
});

pv.addEventListener('marking-changed', (e) => {
  console.log('Tokens:', e.detail.marks);
});

pv.addEventListener('jsonld-updated', (e) => {
  console.log('Model:', e.detail.json);
});
```

### Public API

```javascript
// Get/set model
const model = pv.getModel();
pv.setModel(newModel);

// Import/export
const json = pv.exportJSON();
pv.importJSON(jsonData);

// Download
await pv.downloadJSON();
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `1-6` | Switch modes (select, place, transition, arc, token, delete) |
| `Space` + drag | Pan canvas |
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |
| `Delete` | Delete selected |
| `X` | Start/stop simulation |
| `Shift` + click | Multi-select |
| `Shift` + drag | Bounding box select |

---

## Links

| Resource | URL |
|----------|-----|
| **Live Editor** | [pflow.xyz](https://pflow.xyz) |
| **Interactive Demos** | [pilot.pflow.xyz](https://pilot.pflow.xyz) |
| **GraphQL Playground** | [pilot.pflow.xyz/graphql/i](https://pilot.pflow.xyz/graphql/i) |
| **go-pflow Library** | [github.com/pflow-xyz/go-pflow](https://github.com/pflow-xyz/go-pflow) |
| **petri-pilot MCP** | [github.com/pflow-xyz/petri-pilot](https://github.com/pflow-xyz/petri-pilot) |
| **jsDelivr CDN** | [jsdelivr.com/package/gh/pflow-xyz/pflow-xyz](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz) |
| **JSON-LD Schema** | [pflow.xyz/schema](https://pflow.xyz/schema) |

---

## Browser Support

Modern browsers with ES6 module support:
- Chrome/Edge 61+
- Firefox 60+
- Safari 11+
- Opera 48+

## License

See [LICENSE](LICENSE) file for details.
