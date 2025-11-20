# Julia Optimizer Service Architecture

## Overview

The pflow-xyz repository now includes a Julia-based webservice for advanced Petri net optimization and evaluation. This complements the existing Go webserver and JavaScript frontend.

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Browser                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │            petri-view.js (Web Component)               │ │
│  │  • Visual Editor  • Simulation  • UI Controls          │ │
│  └──────────┬──────────────────────────┬──────────────────┘ │
│             │                          │                     │
└─────────────┼──────────────────────────┼─────────────────────┘
              │                          │
              │ Static Files             │ Optimization/
              │ CID Storage              │ Evaluation API
              ▼                          ▼
┌─────────────────────┐    ┌──────────────────────────┐
│   Go Webserver      │    │  Julia Optimizer Service │
│   (Port 8080)       │    │  (Port 8081)             │
│                     │    │                          │
│ • Serve frontend    │    │ • ODE Simulation         │
│ • JSON-LD storage   │    │ • Rate Optimization      │
│ • CID generation    │    │ • Scenario Evaluation    │
│ • Authentication    │    │ • Expert System Support  │
│ • SVG generation    │    │                          │
└─────────────────────┘    └──────────────────────────┘
```

## Component Responsibilities

### Go Webserver (`cmd/webserver`)
- **Primary Role**: Frontend hosting and data persistence
- **Responsibilities**:
  - Serve static files (HTML, JS, CSS)
  - Handle JSON-LD model storage with CID addressing
  - User authentication (Supabase JWT)
  - Generate SVG representations
  - Manage object ownership

### Julia Optimizer Service (`julia-optimizer/`)
- **Primary Role**: Computational backend for optimization
- **Responsibilities**:
  - Run ODE simulations with DifferentialEquations.jl
  - Optimize transition rates (SPSA, gradient descent)
  - Evaluate scenarios for expert systems
  - Compare multiple configurations
  - Heavy numerical computation

### JavaScript Frontend (`public/petri-view.js`)
- **Primary Role**: User interface and interaction
- **Responsibilities**:
  - Visual editing of Petri nets
  - Manual step-by-step simulation
  - JavaScript-based ODE solver (lightweight, in-browser)
  - Optional: Call Julia service for complex optimizations
  - UI controls and event handling

## Communication Flow

### Scenario 1: User Edits and Saves Model

```
User → petri-view.js → Go Server (/api/save)
                              ↓
                        Store JSON-LD + compute CID
                              ↓
                        Return CID to frontend
```

### Scenario 2: User Runs Optimization

```
User clicks "Optimize" → petri-view.js
                              ↓
                    Check if Julia service available
                              ↓
                    POST /api/optimize (Julia service)
                              ↓
                    Receive optimal rates
                              ↓
                    Update UI with results
```

### Scenario 3: Expert System (Game Tree Evaluation)

```
User loads game model → petri-view.js
                              ↓
                    For each possible move:
                       POST /api/evaluate (Julia)
                              ↓
                    Collect scores for all moves
                              ↓
                    Display ranked moves to user
```

## Deployment Options

### Option 1: Full Stack (Recommended for production)

```bash
# Terminal 1: Start Go server
cd /path/to/pflow-xyz
make run

# Terminal 2: Start Julia service  
cd /path/to/pflow-xyz/julia-optimizer
julia start_server.jl
```

Access:
- Frontend: http://localhost:8080
- Julia API: http://localhost:8081

### Option 2: Frontend Only (Development)

```bash
# Just serve static files
cd /path/to/pflow-xyz/public
python3 -m http.server 8000
```

Access:
- Frontend: http://localhost:8000
- Note: Optimization features won't work without Julia service

### Option 3: Docker Compose (Future)

```yaml
version: '3.8'
services:
  go-server:
    build: .
    ports:
      - "8080:8080"
  
  julia-optimizer:
    build: ./julia-optimizer
    ports:
      - "8081:8081"
```

## API Integration

### From JavaScript to Julia Service

```javascript
// In petri-view.js or custom frontend code

async function optimizeRates(model, targetPlace, options = {}) {
  const response = await fetch('http://localhost:8081/api/evaluate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      rates: options.rates || {},
      targetPlaces: [targetPlace],
      tstart: options.tstart || 0.0,
      tend: options.tend || 10.0,
      dt: options.dt || 0.01,
      abstol: options.abstol || 1e-6,
      reltol: options.reltol || 1e-3
    })
  });
  
  if (!response.ok) {
    throw new Error(`Optimization failed: ${response.statusText}`);
  }
  
  return await response.json();
}

// Usage
const result = await optimizeRates(petriNetModel, 'output', {
  rates: { transition1: 1.0, transition2: 0.5 },
  tend: 10.0
});

console.log('Final value:', result.final_values.output);
console.log('Time series:', result.places.output);
```

### Expert System Pattern

```javascript
// Compare different choices (e.g., tic-tac-toe moves)

async function evaluateMove(model, moveName, moveRate = 1.0) {
  // Set all moves to 0 except the one being evaluated
  const rates = {};
  for (const trans in model.transitions) {
    rates[trans] = (trans === moveName) ? moveRate : 0.0;
  }
  
  const result = await optimizeRates(model, 'win_state', {
    rates: rates,
    tend: 9.0  // Evaluate at specific time
  });
  
  return {
    move: moveName,
    score: result.final_values.win_state
  };
}

// Evaluate all possible moves
const possibleMoves = ['move_A', 'move_B', 'move_C'];
const evaluations = await Promise.all(
  possibleMoves.map(move => evaluateMove(model, move))
);

// Rank by score
evaluations.sort((a, b) => b.score - a.score);
console.log('Best move:', evaluations[0].move);
```

## Performance Considerations

### When to Use Julia Service

✅ **Use Julia service for:**
- Complex optimization problems (many transitions)
- Long simulation times (tend > 100)
- High precision requirements
- Batch processing of scenarios
- Expert system evaluations

❌ **Use JavaScript solver for:**
- Quick interactive simulations
- Simple models (< 10 transitions)
- Offline/disconnected usage
- When Julia service unavailable

### Optimization

The Julia service is optimized for:
- Concurrent requests (HTTP.jl handles multiple connections)
- Memory efficiency (each request is isolated)
- Numerical stability (DifferentialEquations.jl adaptive solvers)

For high-traffic scenarios, consider:
- Load balancing multiple Julia instances
- Caching common scenarios
- Rate limiting on expensive operations

## Security

### CORS Configuration

The Julia service enables CORS for all origins (`Access-Control-Allow-Origin: *`). In production:

```julia
# Restrict to specific origin
function add_cors_headers(response::HTTP.Response)
    HTTP.setheader(response, "Access-Control-Allow-Origin" => "https://pflow.xyz")
    # ...
end
```

### Input Validation

The service validates:
- JSON structure
- Model format (places, transitions, arcs)
- Numeric ranges (rates between 0 and 1)
- Reasonable simulation parameters

### Resource Limits

Consider adding:
- Timeout for long-running simulations
- Maximum model size (number of places/transitions)
- Request rate limiting

## Future Enhancements

### Planned Features

1. **Full Optimization Support** - Add SPSA and gradient-based optimizers to Julia service
2. **Comparison Endpoint** - Multi-scenario evaluation in a single request
3. **Streaming Results** - Server-sent events for long simulations
4. **Caching Layer** - Redis cache for common evaluations
5. **Batch API** - Evaluate multiple models in one request

### Integration Opportunities

- **Jupyter Notebooks**: Use the service from Python/Julia notebooks
- **CLI Tool**: Command-line interface for optimization
- **VS Code Extension**: Visualize and simulate Petri nets in the editor
- **GitHub Actions**: Automated testing and optimization in CI/CD

## Troubleshooting

### Julia Service Won't Start

Check:
- Julia is installed and in PATH
- Dependencies are installed (`Pkg.instantiate()`)
- Port 8081 is available
- No syntax errors in `src/PflowOptimizer.jl`

### CORS Errors

If frontend can't reach Julia service:
- Check browser console for CORS errors
- Verify Julia service is running (visit http://localhost:8081)
- Ensure CORS headers are set correctly
- Try from same origin or use a proxy

### Slow Simulations

If evaluations are taking too long:
- Reduce `tend` (simulation end time)
- Increase `dt` (time step - less precision, faster)
- Simplify the model
- Check for stiff ODEs (may need different solver)

## References

- [Go Webserver Documentation](../README_WEBSERVER.md)
- [Julia Service README](../julia-optimizer/README.md)
- [DifferentialEquations.jl](https://diffeq.sciml.ai/)
- [HTTP.jl](https://juliaweb.github.io/HTTP.jl/)
- [Tic-Tac-Toe Example](https://gist.github.com/stackdump/06e7ccc96dd08b478b0da781a88c8d7a)
