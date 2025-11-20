# Example Use Cases for Julia Optimizer Service

This document demonstrates practical applications of the Julia optimizer service using the expert system approach (similar to the tic-tac-toe example).

## Use Case 1: Knapsack Problem (0-1)

### Problem Description

You have items with different values and weights, and a knapsack with limited capacity. Which items should you include to maximize value?

### Petri Net Model

- **Places**: 
  - `item_N_available` - One token if item N is available
  - `capacity` - Remaining knapsack capacity (initial = max capacity)
  - `value` - Accumulated value (starts at 0)
  
- **Transitions**:
  - `take_item_N` - Decision to include item N
  
- **Arcs**:
  - `item_N_available -> take_item_N` (consume availability)
  - `take_item_N -> value` (produce value_N tokens)
  - `capacity -> take_item_N` (consume weight_N tokens)
  - `take_item_N -> taken_item_N` (mark as taken)

### Expert System Approach

```julia
# For each possible item combination, evaluate the outcome
scenarios = []

# Scenario 1: Take items 1, 3, 5
push!(scenarios, Dict(
    "take_item_1" => 1.0,
    "take_item_2" => 0.0,
    "take_item_3" => 1.0,
    "take_item_4" => 0.0,
    "take_item_5" => 1.0
))

# Scenario 2: Take items 2, 4
push!(scenarios, Dict(
    "take_item_1" => 0.0,
    "take_item_2" => 1.0,
    "take_item_3" => 0.0,
    "take_item_4" => 1.0,
    "take_item_5" => 0.0
))

# Evaluate each scenario
for scenario in scenarios
    result = evaluate_scenario(
        model, scenario, ["value", "capacity"],
        0.0, 5.0, 0.1, 1e-6, 1e-3
    )
    
    final_value = result["final_values"]["value"]
    final_capacity = result["final_values"]["capacity"]
    
    println("Scenario: ", scenario)
    println("  Total value: ", final_value)
    println("  Remaining capacity: ", final_capacity)
end
```

### REST API Call

```bash
curl -X POST http://localhost:8081/api/evaluate \
  -H "Content-Type: application/json" \
  -d '{
    "model": { ... knapsack Petri net ... },
    "rates": {
      "take_item_1": 1.0,
      "take_item_2": 0.0,
      "take_item_3": 1.0,
      "take_item_4": 0.0,
      "take_item_5": 1.0
    },
    "targetPlaces": ["value", "capacity"],
    "tend": 5.0
  }'
```

## Use Case 2: Tic-Tac-Toe Expert System

### Problem Description

Given a tic-tac-toe board state, which move leads to the highest probability of winning?

### Petri Net Model

Based on: https://gist.github.com/stackdump/06e7ccc96dd08b478b0da781a88c8d7a

- **Places**:
  - `P00` - `P22`: Available board positions
  - `X00` - `X22`: X marks on board
  - `O00` - `O22`: O marks on board  
  - `Next`: Turn indicator (0 = X's turn, 1 = O's turn)
  - `win_x`, `win_o`: Win states

- **Transitions**:
  - `X00` - `X22`: X places mark
  - `O00` - `O22`: O places mark
  - `X00_X01_X02`: X wins with top row
  - ... (other win conditions)

### Expert System Approach

```julia
# Initial state: X to move, all positions available
initial_state = (
    P00=1, P01=1, P02=1, P10=1, P11=1, P12=1, P20=1, P21=1, P22=1,
    Next=0,  # X's turn
    X00=0, X01=0, X02=0, X10=0, X11=0, X12=0, X20=0, X21=0, X22=0,
    O00=0, O01=0, O02=0, O10=0, O11=0, O12=0, O20=0, O21=0, O22=0,
    win_x=0, win_o=0
)

# Possible first moves for X
possible_moves = ["X00", "X01", "X02", "X10", "X11", "X12", "X20", "X21", "X22"]

# Evaluate each move
move_scores = Dict()

for move in possible_moves
    # Set rate=1 for this move, 0 for all others
    rates = Dict{String, Float64}()
    for trans in all_transitions
        rates[trans] = (trans == move) ? 1.0 : 0.0
    end
    
    result = evaluate_scenario(
        model, rates, ["win_x"],
        0.0, 9.0, 0.1, 1e-6, 1e-3
    )
    
    move_scores[move] = result["final_values"]["win_x"]
end

# Rank moves by score
sorted_moves = sort(collect(move_scores), by=x->x[2], rev=true)

println("Best move: ", sorted_moves[1][1], " (score: ", sorted_moves[1][2], ")")
```

### REST API Workflow

```javascript
// Frontend JavaScript to evaluate all moves

async function findBestMove(model, possibleMoves) {
  const evaluations = [];
  
  for (const move of possibleMoves) {
    // Build rates dict: 1.0 for this move, 0.0 for others
    const rates = {};
    for (const trans of Object.keys(model.transitions)) {
      rates[trans] = trans === move ? 1.0 : 0.0;
    }
    
    // Evaluate this move
    const response = await fetch('http://localhost:8081/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        rates: rates,
        targetPlaces: ['win_x'],
        tend: 9.0
      })
    });
    
    const result = await response.json();
    evaluations.push({
      move: move,
      score: result.final_values.win_x,
      trajectory: result.places.win_x
    });
  }
  
  // Sort by score
  evaluations.sort((a, b) => b.score - a.score);
  
  return evaluations;
}

// Usage
const bestMoves = await findBestMove(ticTacToeModel, possibleFirstMoves);
console.log('Best first move:', bestMoves[0].move);
console.log('Win probability:', bestMoves[0].score);
```

## Use Case 3: Resource Allocation

### Problem Description

You have multiple projects competing for limited resources. How should you allocate resources to maximize total output?

### Petri Net Model

- **Places**:
  - `resource_pool`: Available resources
  - `project_N_output`: Output from project N
  - `total_output`: Sum of all project outputs

- **Transitions**:
  - `allocate_to_N`: Allocate resources to project N
  - Each transition has different input/output ratios

### Expert System Approach

```julia
# Test different allocation strategies

# Strategy 1: Focus on high-ROI projects
strategy1 = Dict(
    "allocate_to_A" => 1.0,  # High ROI
    "allocate_to_B" => 1.0,  # High ROI
    "allocate_to_C" => 0.0,  # Low ROI
    "allocate_to_D" => 0.0   # Low ROI
)

# Strategy 2: Balanced allocation
strategy2 = Dict(
    "allocate_to_A" => 0.5,
    "allocate_to_B" => 0.5,
    "allocate_to_C" => 0.5,
    "allocate_to_D" => 0.5
)

# Strategy 3: Diversified
strategy3 = Dict(
    "allocate_to_A" => 0.3,
    "allocate_to_B" => 0.3,
    "allocate_to_C" => 0.2,
    "allocate_to_D" => 0.2
)

strategies = [strategy1, strategy2, strategy3]

for (i, strategy) in enumerate(strategies)
    result = evaluate_scenario(
        model, strategy, ["total_output", "resource_pool"],
        0.0, 10.0, 0.1, 1e-6, 1e-3
    )
    
    println("Strategy $i:")
    println("  Total output: ", result["final_values"]["total_output"])
    println("  Resources remaining: ", result["final_values"]["resource_pool"])
end
```

## Use Case 4: Manufacturing Process Optimization

### Problem Description

A manufacturing line has multiple stages. Which stages should be prioritized to maximize throughput while minimizing bottlenecks?

### Petri Net Model

- **Places**: 
  - `raw_material`: Input materials
  - `stage_N_buffer`: Intermediate buffers
  - `finished_goods`: Output

- **Transitions**:
  - `process_stage_N`: Processing at each stage
  - Different rates = different processing speeds

### Expert System Approach

```julia
# Test different speed configurations

# Scenario 1: Bottleneck at stage 2
config1 = Dict(
    "process_stage_1" => 1.0,
    "process_stage_2" => 0.3,  # Slow!
    "process_stage_3" => 1.0
)

# Scenario 2: Balanced processing
config2 = Dict(
    "process_stage_1" => 0.8,
    "process_stage_2" => 0.8,
    "process_stage_3" => 0.8
)

# Scenario 3: Fast early stages
config3 = Dict(
    "process_stage_1" => 1.0,
    "process_stage_2" => 1.0,
    "process_stage_3" => 0.5
)

for (i, config) in enumerate([config1, config2, config3])
    result = evaluate_scenario(
        model, config, ["finished_goods", "stage_1_buffer", "stage_2_buffer"],
        0.0, 20.0, 0.1, 1e-6, 1e-3
    )
    
    println("Configuration $i:")
    println("  Finished goods: ", result["final_values"]["finished_goods"])
    println("  Buffer 1: ", result["final_values"]["stage_1_buffer"])
    println("  Buffer 2: ", result["final_values"]["stage_2_buffer"])
    println("  Throughput rate: ", 
            result["final_values"]["finished_goods"] / 20.0)
end
```

## Pattern Summary

### The Expert System Pattern

1. **Model the problem** as a Petri net
   - Places = states, resources, outcomes
   - Transitions = decisions, actions, processes

2. **Define scenarios** as rate configurations
   - Rate = 1.0: action is taken / enabled
   - Rate = 0.0: action is not taken / disabled
   - Rate ∈ (0,1): partial allocation / probability

3. **Evaluate each scenario** using ODE simulation
   - Run from initial state to evaluation time
   - Extract final values of target places

4. **Compare and rank** scenarios
   - Sort by objective function value
   - Consider constraints (capacity, etc.)

5. **Visualize results**
   - Plot trajectories to understand dynamics
   - Show trade-offs between objectives

### Key Benefits

- **Explorative**: Try many scenarios quickly
- **Comprehensive**: See full trajectory, not just final state
- **Quantitative**: Precise scores for ranking
- **Flexible**: Easy to add constraints or objectives
- **Scalable**: Efficient for complex systems

### When to Use This Approach

✅ Use expert system pattern for:
- Discrete decision problems (0/1 choices)
- Comparing a set of known alternatives
- Explaining why one option is better
- Game tree evaluation
- Scenario planning

❌ Use optimization instead for:
- Finding optimal continuous parameters
- Large search spaces (too many scenarios)
- Unknown optimal strategy
- Real-time adaptation
