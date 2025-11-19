# pflow-xyz

Lightweight web component for building, editing, and simulating Petri nets in the browser.

[![](https://data.jsdelivr.com/v1/package/gh/pflow-xyz/pflow-xyz/badge)](https://www.jsdelivr.com/package/gh/pflow-xyz/pflow-xyz)

**Try it out:** https://pflow.xyz

The component is implemented as an ES module (`public/petri-view.js`) and exposes a clean API and events for integration.

## Features

### Core Features
- **Visual Editor**: Interactive editor for places, transitions, and arcs with drag-and-drop
- **Inhibitor Arcs**: Support for inhibitor arcs that prevent transitions from firing
- **Place Capacity**: Define maximum token capacity for places
- **Token Management**: Click to add/remove tokens, with visual capacity indicators
- **Live Simulation**: Manual firing of transitions with play/stop mode for automatic simulation
- **ODE Simulation**: Continuous-time simulation using ordinary differential equations (Tsit5 solver)
- **Pan & Zoom**: Navigate large nets with mouse/touch pan and zoom controls
- **Undo/Redo**: Full history support for all editing operations

### Data & Persistence
- **JSON-LD Format**: Uses standard JSON-LD schema (https://pflow.xyz/schema)
- **In-Page Editor**: Optional JSON editor with syntax highlighting (Ace)
- **Multiple Storage**: Save to inline `<script>`, localStorage, or remote server
- **CID Generation**: IPFS CIDv1 content addressing with SHA2-256
- **Download/Upload**: Import and export Petri nets as JSON-LD files

### Integration Features
- **Backend Mode**: Integration with backend server for remote persistence
- **Supabase Auth**: Optional GitHub OAuth authentication via Supabase
- **Custom Events**: Rich event system for integration with your application
- **Public API**: JavaScript methods for programmatic control
- **Compact Mode**: Minimize JSON output for smaller payloads
- **Layout Options**: Vertical or horizontal layout orientation

## Quick Start

### Using jsDelivr CDN (Recommended)

The easiest way to use pflow-xyz is via the jsDelivr CDN:

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

### Local Development

For local development, clone the repository and serve the files:

```bash
git clone https://github.com/pflow-xyz/pflow-xyz.git
cd pflow-xyz
# Serve public/ directory with any web server
python3 -m http.server 8000 --directory public
```

Then visit `http://localhost:8000` in your browser.

## Complete Example with All Features

This example demonstrates all available features:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Complete Petri Net Example</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/petri-view.css"/>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: system-ui, -apple-system, sans-serif;
        }
        #pv {
            width: 100vw;
            height: 100vh;
        }
    </style>
</head>
<body>
    <script type="module" src="https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/petri-view.js"></script>
    
    <!-- 
        Attributes:
        - data-json-editor: Enable in-page JSON editor
        - data-backend: Enable backend server integration
        - data-layout-horizontal: Use horizontal layout (default is vertical)
        - data-compact: Minimize JSON output (no pretty printing)
        - supabase-url: Supabase project URL for authentication
        - supabase-key: Supabase anonymous key for authentication
    -->
    <petri-view 
        id="pv" 
        data-json-editor
        data-backend
        supabase-url="https://zosuuhddfpcnlfphwrab.supabase.co"
        supabase-key="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpvc3V1aGRkZnBjbmxmcGh3cmFiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjE5OTQ0NzUsImV4cCI6MjA3NzU3MDQ3NX0.f99E42qLhMG9tWoPaoTfyG5koqQciKiaqerpA_7amS8">
        <script type="application/ld+json">
        {
            "@context": "https://pflow.xyz/schema",
            "@type": "PetriNet",
            "@version": "1.1",
            "arcs": [
                {
                    "@type": "Arrow",
                    "inhibitTransition": false,
                    "source": "producer",
                    "target": "buffer",
                    "weight": [1]
                },
                {
                    "@type": "Arrow",
                    "inhibitTransition": false,
                    "source": "buffer",
                    "target": "consumer",
                    "weight": [1]
                },
                {
                    "@type": "Arrow",
                    "inhibitTransition": true,
                    "source": "buffer",
                    "target": "overflow_guard",
                    "weight": [5]
                }
            ],
            "places": {
                "buffer": {
                    "@type": "Place",
                    "capacity": [5],
                    "initial": [2],
                    "offset": 0,
                    "x": 200,
                    "y": 150
                }
            },
            "token": ["https://pflow.xyz/tokens/black"],
            "transitions": {
                "producer": {
                    "@type": "Transition",
                    "x": 50,
                    "y": 150
                },
                "consumer": {
                    "@type": "Transition",
                    "x": 350,
                    "y": 150
                },
                "overflow_guard": {
                    "@type": "Transition",
                    "x": 200,
                    "y": 50
                }
            }
        }
        </script>
    </petri-view>

    <script type="module">
        const pv = document.getElementById('pv');
        
        // Listen to events
        pv.addEventListener('transition-fired-success', (e) => {
            console.log('Transition fired:', e.detail.id);
        });
        
        pv.addEventListener('marking-changed', (e) => {
            console.log('New marking:', e.detail.marks);
        });
        
        pv.addEventListener('simulation-started', () => {
            console.log('Simulation started');
        });
        
        pv.addEventListener('simulation-stopped', () => {
            console.log('Simulation stopped');
        });
        
        // Use the public API
        setTimeout(() => {
            const model = pv.getModel();
            console.log('Current model:', model);
            
            const json = pv.exportJSON();
            console.log('Exported JSON:', json);
        }, 1000);
    </script>
</body>
</html>
```

## Attributes

Configure the component using HTML attributes:

| Attribute | Type | Description |
|-----------|------|-------------|
| `data-json-editor` | boolean | Enable in-page JSON editor with toolbar |
| `data-backend` | boolean | Enable backend server integration with save/load features |
| `data-layout-horizontal` | boolean | Use horizontal layout instead of vertical |
| `data-compact` | boolean | Minimize JSON output (no pretty printing) |
| `supabase-url` | string | Supabase project URL for authentication |
| `supabase-key` | string | Supabase anonymous key for authentication |

## Events

The component fires custom events that you can listen to:

| Event | Detail | Description |
|-------|--------|-------------|
| `jsonld-updated` | `{json}` | Fired when the model is updated |
| `transition-fired-success` | `{id}` | Fired when a transition fires successfully |
| `transition-fired-blocked` | `{id}` | Fired when a transition is blocked from firing |
| `marking-changed` | `{marks}` | Fired when the token marking changes |
| `simulation-started` | - | Fired when automatic simulation starts |
| `simulation-stopped` | - | Fired when automatic simulation stops |
| `node-moved` | `{id, kind}` | Fired when a node is moved |
| `node-deleted` | `{id}` | Fired when a node is deleted |
| `data-deleted` | - | Fired when all data is cleared |

## Public API

Control the component programmatically:

```javascript
const petriView = document.querySelector('petri-view');

// Get and set the model
const model = petriView.getModel();
petriView.setModel(newModel);

// Import/export JSON
const json = petriView.exportJSON();
petriView.importJSON(jsonData);

// Save to script tag
petriView.saveToScript();

// Download as JSON-LD file
await petriView.downloadJSON();
```

## JSON-LD Schema

Petri nets are represented using JSON-LD format with the schema at `https://pflow.xyz/schema`.

### Complete Example

```json
{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "arcs": [
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "place1",
      "target": "transition1",
      "weight": [2]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "place2",
      "target": "transition1",
      "weight": [3]
    }
  ],
  "places": {
    "place1": {
      "@type": "Place",
      "capacity": [10],
      "initial": [5],
      "offset": 0,
      "x": 100,
      "y": 100
    },
    "place2": {
      "@type": "Place",
      "capacity": [Infinity],
      "initial": [0],
      "offset": 0,
      "x": 200,
      "y": 100
    }
  },
  "token": ["https://pflow.xyz/tokens/black"],
  "transitions": {
    "transition1": {
      "@type": "Transition",
      "x": 150,
      "y": 200
    }
  }
}
```

### Arc Properties

- `source`: ID of the source node (place or transition)
- `target`: ID of the target node (place or transition)
- `weight`: Array with single integer representing arc weight
- `inhibitTransition`: Boolean, `true` for inhibitor arcs

**Inhibitor Arcs:**
- Input inhibitor (from place to transition): Transition disabled while source place has tokens ≥ weight
- Output inhibitor (from transition to place): Transition disabled until target place has tokens ≥ weight
- Inhibitor arcs do not consume or produce tokens

### Place Properties

- `@type`: Always `"Place"`
- `initial`: Array with initial token count
- `capacity`: Array with maximum token capacity (`Infinity` for unlimited)
- `offset`: Token color offset (usually 0)
- `x`, `y`: Position coordinates in pixels

### Transition Properties

- `@type`: Always `"Transition"`
- `x`, `y`: Position coordinates in pixels

## Editor Controls

### Mouse/Touch Controls
- **Click place**: Add/remove tokens
- **Click transition**: Fire transition (if enabled)
- **Right-click node**: Open context menu (add arcs, delete)
- **Drag node**: Move node
- **Shift + Click node**: Add/remove node from selection (multi-select)
- **Shift + Drag on canvas**: Draw bounding box to select multiple nodes
- **Mouse wheel**: Zoom in/out
- **Space + drag**: Pan the canvas
- **Double-click transition**: Toggle between normal and inhibitor arc mode

### Keyboard Shortcuts
- **Ctrl/Cmd + Z**: Undo
- **Ctrl/Cmd + Shift + Z**: Redo
- **Escape**: Cancel current operation (arc draft, bounding box selection)
- **Delete/Backspace**: Delete selected nodes
- **Space**: Enable pan mode (hold)
- **1-6**: Switch modes (1=select, 2=add place, 3=add transition, 4=add arc, 5=add token, 6=delete)
- **X**: Start/stop simulation

### Selection Features
- **Multi-select**: Hold Shift and click individual nodes to add/remove them from the selection
- **Bounding Box**: Hold Shift and drag on empty canvas to draw a bounding box. All nodes whose centers fall within the box will be selected when you release the mouse
- **Visual Feedback**: Selected nodes are highlighted with an orange outline and shadow
- **Batch Operations**: Delete all selected nodes at once with Delete/Backspace key

### Toolbar
- **Play/Stop**: Start/stop automatic simulation
- **Scale Meter**: Shows current zoom level, click to reset to 1x
- **Hamburger Menu**: Access additional features:
  - Simulate (ODE): Open ODE simulation dialog
  - Layout Algorithms: Apply automatic layout
  - New (clear all)
  - Download JSON-LD
  - Open from URL
  - Toggle JSON Editor
  - Toggle Layout (Vertical/Horizontal)
  - Save Permalink (backend mode)
  - Delete Data (backend mode)
  - Login/Logout (backend mode with Supabase)

## ODE Simulation

The ODE (Ordinary Differential Equation) simulation feature allows you to model continuous-time behavior of Petri nets using differential equations. This is useful for analyzing system dynamics, optimization problems, and chemical reaction networks.

### Accessing the Simulator

Click the hamburger menu (☰) in the top-left corner and select "🧮 Simulate (ODE)" to open the simulation dialog.

### Features

- **Tsit5 Solver**: 5th order Runge-Kutta method with adaptive time stepping
- **Mass Action Kinetics**: Automatic ODE generation from Petri net structure
- **Configurable Parameters**:
  - Time span (start and end time)
  - Initial time step (dt)
  - Absolute and relative tolerances
  - Transition rates (kinetic constants)
- **Interactive Plotting**:
  - Select which places to plot
  - Real-time SVG plot generation
  - Multiple variables on the same plot
- **Fast Computation**: Efficient JavaScript implementation

### Using the Simulation Dialog

1. **Configure Time Parameters**: Set the start and end time for the simulation
2. **Adjust Solver Options**: Fine-tune dt, absolute tolerance, and relative tolerance
3. **Select Places to Plot**: Check the boxes for places you want to visualize
4. **Set Transition Rates**: Configure the rate constants for each transition
5. **Run Simulation**: Click "Run Simulation" to compute and display results

### Using the Solver Module Independently

The `petri-solver.js` module can be used independently of the petri-view component:

```html
<script type="module">
  import * as Solver from './petri-solver.js';

  // Parse Petri net from JSON-LD
  const net = Solver.fromJSON(petriNetData);
  
  // Set up initial state and rates
  const initialState = Solver.setState(net);
  const rates = Solver.setRates(net, { txn0: 1.5, txn1: 2.0 });
  
  // Create ODE problem
  const prob = new Solver.ODEProblem(net, initialState, [0, 10], rates);
  
  // Solve using Tsit5
  const sol = Solver.solve(prob, Solver.Tsit5(), {
    dt: 0.01,
    abstol: 1e-6,
    reltol: 1e-3
  });
  
  // Generate plot
  const svg = Solver.SVGPlotter.plotSolution(sol, ['place1', 'place2'], {
    title: 'Simulation Results',
    xlabel: 'Time',
    ylabel: 'Token Count'
  });
  
  // Display the plot
  document.getElementById('plot').innerHTML = svg;
</script>
```

### API Reference

**Classes**:
- `PetriNet`: Petri net model container
- `Place`: Place node with initial tokens and capacity
- `Transition`: Transition node with role
- `Arc`: Arc connecting places and transitions
- `ODEProblem`: ODE problem definition
- `ODESolution`: Solution containing time points and states
- `SVGPlotter`: SVG plot generator

**Functions**:
- `fromJSON(data)`: Parse JSON-LD to PetriNet
- `setState(net, customState)`: Create initial state from net
- `setRates(net, customRates)`: Set transition rates
- `solve(prob, solver, options)`: Solve ODE problem
- `Tsit5()`: Create Tsit5 solver instance

See `public/test-solver.html` for a complete standalone example.

## Integration Examples

### React
```jsx
import { useEffect, useRef } from 'react';

function PetriNetEditor() {
  const pvRef = useRef(null);
  
  useEffect(() => {
    const pv = pvRef.current;
    
    const handleTransition = (e) => {
      console.log('Transition fired:', e.detail.id);
    };
    
    pv.addEventListener('transition-fired-success', handleTransition);
    return () => pv.removeEventListener('transition-fired-success', handleTransition);
  }, []);
  
  return (
    <petri-view ref={pvRef} data-json-editor>
      <script type="application/ld+json">
        {JSON.stringify({
          "@context": "https://pflow.xyz/schema",
          "@type": "PetriNet",
          "@version": "1.1",
          "arcs": [],
          "places": {},
          "token": ["https://pflow.xyz/tokens/black"],
          "transitions": {}
        })}
      </script>
    </petri-view>
  );
}
```

### Vue
```vue
<template>
  <petri-view 
    ref="petriView" 
    data-json-editor
    @transition-fired-success="handleTransition">
    <script type="application/ld+json">
      {{ modelJson }}
    </script>
  </petri-view>
</template>

<script>
export default {
  data() {
    return {
      modelJson: JSON.stringify({
        "@context": "https://pflow.xyz/schema",
        "@type": "PetriNet",
        "@version": "1.1",
        "arcs": [],
        "places": {},
        "token": ["https://pflow.xyz/tokens/black"],
        "transitions": {}
      })
    };
  },
  methods: {
    handleTransition(e) {
      console.log('Transition fired:', e.detail.id);
    }
  }
}
</script>
```

### Vanilla JavaScript
```html
<script type="module">
import 'https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/petri-view.js';

// Create element dynamically
const pv = document.createElement('petri-view');
pv.setAttribute('data-json-editor', '');

const model = {
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "arcs": [],
  "places": {},
  "token": ["https://pflow.xyz/tokens/black"],
  "transitions": {}
};

pv.addEventListener('jsonld-updated', (e) => {
  console.log('Model updated:', e.detail.json);
});

document.body.appendChild(pv);
pv.setModel(model);
</script>
```

## Development

See [README_WEBSERVER.md](README_WEBSERVER.md) for information about the Go webserver backend.

### Building

```bash
# Build the webserver (embeds public/ directory)
make build

# Run the webserver
make run

# Run with development settings (port 3000)
make run-dev

# Run tests
make test
```

### Project Structure

```
.
├── cmd/
│   └── webserver/        # Go webserver entry point
├── internal/
│   ├── auth/            # Supabase JWT authentication
│   ├── canonical/       # JSON-LD canonicalization (URDNA2015)
│   ├── ethsig/          # Ethereum signature verification
│   ├── seal/            # CID computation (IPFS CIDv1)
│   ├── static/          # Embedded static files
│   └── store/           # Filesystem-based object storage
├── public/              # Frontend static files
│   ├── petri-view.js   # Main web component
│   ├── petri-view.css  # Component styles
│   └── index.html      # Demo page
└── Makefile            # Build automation
```

## Browser Support

Modern browsers with ES6 module support:
- Chrome/Edge 61+
- Firefox 60+
- Safari 11+
- Opera 48+

## License

See [LICENSE](LICENSE) file for details.

## Links

- **Live Demo**: https://pflow-xyz.github.io/pflow-xyz/public/
- **Schema**: https://pflow.xyz/schema
- **jsDelivr CDN**: https://cdn.jsdelivr.net/gh/pflow-xyz/pflow-xyz@latest/public/
- **Repository**: https://github.com/pflow-xyz/pflow-xyz
