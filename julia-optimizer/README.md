# Pflow Optimizer - Julia Webservice

A Julia-based HTTP webservice for optimizing and evaluating Petri net models using ODE simulation.

## Overview

This service provides endpoints for:

1. **Scenario Evaluation** - Run ODE simulations with specific transition rates
2. **Rate Optimization** - Find optimal rates to maximize/minimize target places  
3. **Expert Systems** - Compare multiple scenarios and rank by outcome (like tic-tac-toe)

## Features

- **ODE Simulation**: Uses `DifferentialEquations.jl` with Tsit5 solver for accurate continuous-time simulation
- **Mass Action Kinetics**: Automatic generation of ODE systems from Petri net structure
- **Inhibitor Arcs**: Full support for inhibitor arcs (input and output)
- **JSON-LD Compatible**: Accepts Petri nets in the standard pflow.xyz JSON-LD format
- **CORS Enabled**: Ready for cross-origin requests from web frontends

## Installation

### Prerequisites

- Julia 1.6 or later
- Internet connection (for package installation)

### Setup

```bash
cd julia-optimizer

# Start Julia
julia

# Activate the project environment
using Pkg
Pkg.activate(".")
Pkg.instantiate()
```

This will install all required dependencies:
- HTTP.jl - HTTP server
- JSON.jl - JSON parsing
- DifferentialEquations.jl - ODE solvers
- LabelledArrays.jl - Named state vectors

## Running the Service

### Option 1: From Julia REPL

```julia
using Pkg
Pkg.activate(".")

using PflowOptimizer
PflowOptimizer.start_server(host="0.0.0.0", port=8081)
```

### Option 2: Using startup script

```bash
julia start_server.jl
```

The service will start on `http://localhost:8081`

## API Endpoints

### GET /

Returns service information and status page.

### POST /api/evaluate

Evaluate a scenario with given transition rates.

**Request Body:**
```json
{
  "model": {
    "@context": "https://pflow.xyz/schema",
    "@type": "PetriNet",
    "places": { ... },
    "transitions": { ... },
    "arcs": [ ... ]
  },
  "rates": {
    "transition1": 1.0,
    "transition2": 0.5
  },
  "targetPlaces": ["place1", "place2"],
  "tstart": 0.0,
  "tend": 10.0,
  "dt": 0.01,
  "abstol": 1e-6,
  "reltol": 1e-3
}
```

**Response:**
```json
{
  "time": [0.0, 0.01, 0.02, ...],
  "places": {
    "place1": [5.0, 4.9, 4.8, ...],
    "place2": [0.0, 0.1, 0.2, ...]
  },
  "final_values": {
    "place1": 2.3,
    "place2": 7.7
  }
}
```

## Use Cases

### 1. Knapsack Optimization

Use rate = 0 or 1 for each transition representing items to include/exclude. Maximize a value place while respecting capacity constraints.

### 2. Expert System (Game Tree Evaluation)

Like the tic-tac-toe example - model game states as places and moves as transitions. Evaluate different moves by running simulations and comparing final win probabilities.

Example workflow:
1. Model the game as a Petri net
2. For each possible move, set that transition's rate to 1.0, others to 0.0
3. Call `/api/evaluate` for each scenario
4. Compare the final values of the "win" place
5. Choose the move with highest win probability

### 3. Resource Allocation

Model resources as places and allocation decisions as transitions. Find optimal rates that maximize throughput or minimize cost.

## Comparison with JavaScript Implementation

This Julia service provides equivalent functionality to the JavaScript `petri-solver.js` optimizer but with:

- **Better Performance**: Julia's JIT compilation and DifferentialEquations.jl are highly optimized
- **Server-Side Processing**: Offload computation from the browser
- **Scalability**: Handle larger Petri nets and longer simulations
- **Research Integration**: Easy to extend with Julia's scientific computing ecosystem

## Architecture

```
julia-optimizer/
├── Project.toml           # Package dependencies
├── src/
│   └── PflowOptimizer.jl # Main module
├── start_server.jl        # Startup script
├── test/
│   └── test_examples.jl   # Test cases
└── README.md              # This file
```

## Development

### Adding New Endpoints

Edit `src/PflowOptimizer.jl` and add new handler functions in the `router` function:

```julia
function router(req::HTTP.Request)
    if req.method == "POST" && req.target == "/api/my_endpoint"
        return handle_my_endpoint(req)
    ...
end
```

### Testing

```julia
using Pkg
Pkg.activate(".")
Pkg.test()
```

## Integration with pflow.xyz

The service is designed to work alongside the existing Go webserver:

1. **Go server** (port 8080): Serves frontend, handles CID storage
2. **Julia service** (port 8081): Provides optimization/evaluation API

The frontend can call the Julia service directly via AJAX:

```javascript
const response = await fetch('http://localhost:8081/api/evaluate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: petriNetModel,
    rates: { transition1: 1.0, transition2: 0.5 },
    targetPlaces: ['output'],
    tend: 10.0
  })
});
const result = await response.json();
console.log('Final values:', result.final_values);
```

## Performance Considerations

- **Simulation Time**: ODE solving is the main computational cost. For large nets or long time spans, simulations may take seconds.
- **Concurrency**: HTTP.jl handles concurrent requests efficiently
- **Memory**: Each simulation creates a new ODE problem. Monitor memory for high-traffic scenarios.

## Troubleshooting

### Port Already in Use

Change the port when starting:
```julia
PflowOptimizer.start_server(port=8082)
```

### Package Installation Fails

Update package registry:
```julia
using Pkg
Pkg.update()
Pkg.instantiate()
```

### Simulation Errors

- Check that all places in arcs exist in the model
- Verify initial token counts are non-negative
- Ensure rates dictionary includes all transitions

## References

- [DifferentialEquations.jl Documentation](https://diffeq.sciml.ai/stable/)
- [HTTP.jl Documentation](https://juliaweb.github.io/HTTP.jl/stable/)
- [pflow.xyz Schema](https://pflow.xyz/schema)
- [Tic-Tac-Toe Expert System Example](https://gist.github.com/stackdump/06e7ccc96dd08b478b0da781a88c8d7a)

## License

See the main repository LICENSE file.
