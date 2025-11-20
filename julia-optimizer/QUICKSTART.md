# Quick Start Guide

Get the Julia optimizer service running in 5 minutes.

## Prerequisites

- Julia 1.6+ installed ([Download](https://julialang.org/downloads/))
- Git (to clone the repository)

## Installation

```bash
# Clone the repository
git clone https://github.com/pflow-xyz/pflow-xyz.git
cd pflow-xyz/julia-optimizer

# Start Julia
julia

# In Julia REPL:
using Pkg
Pkg.activate(".")
Pkg.instantiate()  # This will download and install all dependencies
```

First-time setup will take a few minutes to download packages.

## Running the Service

### Method 1: Julia REPL

```julia
using PflowOptimizer
PflowOptimizer.start_server(host="0.0.0.0", port=8081)
```

### Method 2: Startup Script

```bash
julia start_server.jl
```

### Method 3: Custom Configuration

```bash
julia start_server.jl --port 9000 --host localhost
```

You should see:
```
======================================================================
 Pflow Optimizer Service
======================================================================
 ...
 Ready to accept requests...
======================================================================
```

## Test the Service

Open http://localhost:8081 in your browser. You should see the service info page.

Or use curl:
```bash
curl http://localhost:8081/
```

## Your First API Call

Save this as `test.json`:

```json
{
  "model": {
    "@context": "https://pflow.xyz/schema",
    "@type": "PetriNet",
    "places": {
      "buffer": {
        "initial": [10],
        "capacity": [20],
        "x": 200,
        "y": 150
      }
    },
    "transitions": {
      "consume": {
        "role": "default",
        "x": 300,
        "y": 150
      }
    },
    "arcs": [
      {
        "source": "buffer",
        "target": "consume",
        "weight": [1]
      }
    ],
    "token": ["https://pflow.xyz/tokens/black"]
  },
  "rates": {
    "consume": 0.5
  },
  "targetPlaces": ["buffer"],
  "tend": 10.0
}
```

Run the evaluation:
```bash
curl -X POST http://localhost:8081/api/evaluate \
  -H "Content-Type: application/json" \
  -d @test.json
```

You should get a JSON response with time series data and final values.

## Stopping the Service

Press `Ctrl+C` in the terminal where the service is running.

## Troubleshooting

### "Package not found" error

Run in Julia:
```julia
using Pkg
Pkg.update()
Pkg.instantiate()
```

### Port already in use

Change the port:
```julia
PflowOptimizer.start_server(port=8082)
```

### Slow first request

The first request after starting takes longer due to Julia's JIT compilation. Subsequent requests are much faster.

## Next Steps

- Read [README.md](README.md) for full documentation
- Check [EXAMPLES.md](EXAMPLES.md) for use case examples
- Review [../ARCHITECTURE.md](../ARCHITECTURE.md) for system integration
- Load your own Petri net models from https://pflow.xyz

## Integration with pflow.xyz

The Julia service works alongside the main Go webserver:

```bash
# Terminal 1: Start Go server (frontend)
cd /path/to/pflow-xyz
make run

# Terminal 2: Start Julia service (backend)
cd /path/to/pflow-xyz/julia-optimizer
julia start_server.jl
```

Access:
- Frontend: http://localhost:8080
- Julia API: http://localhost:8081

The frontend can then call the Julia service for heavy computations.
