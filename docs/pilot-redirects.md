# pilot.pflow.xyz redirect map

pilot.pflow.xyz is retired. nginx on pflow.dev answers every request with a permanent redirect (`/mcp` uses 308 so POSTs survive). The first path segment picks the target; the rest of the path is dropped. Unknown paths go to the sim model directory (`/whatif/`). `/` goes to sim's home page.

| Pilot path | Sim target | Match |
|---|---|---|
| `/cafe/` | cafe (curated) | exact |
| `/coffeeshop/` | cafe (curated) | close: same coffee shop |
| `/predator-prey/` | predator-prey (curated) | exact |
| `/vet-clinic/` | vet-clinic (curated) | exact |
| `/tic-tac-toe/` | tic-tac-toe (CC0) | exact |
| `/zk-tic-tac-toe/` | tic-tac-toe (CC0) | close: same game, no ZK layer |
| `/optimal-play/` | tic-tac-toe (CC0) | close: same game |
| `/loan-approval/` | loan-book (CC0) | close: lending flow |
| `/hiring-pipeline/` | claims-desk (CC0) | loose: multi-stage case workflow |
| `/learn/` | sim help | fallback |
| `/advanced/` | sim help | fallback |
| `/patterns/` | sim help | fallback |
| `/code-to-flow/` | sim help | fallback: sim has code-to-flow as an MCP tool only, no page |
| `/enzyme-kinetics/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/knapsack/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/galton-board/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/thermostat/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/stoplight/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/tcp-handshake/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/producer-consumer/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/dining-philosophers/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/texas-holdem/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/poker-hand/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/march-madness-2026/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/zk-intro/` | model directory (/whatif/) | fallback: no related CC0 model |
| `/mcp` | `https://sim.pflow.xyz/mcp` (308) | same protocol, different tools (`sim_*`) |
| `/` | `https://sim.pflow.xyz/` | home |
| anything else | `/whatif/` | fallback |

Source of the map: `docs/pilot-redirect-map.nginx`. Model ids come from `sim_list_models` on 2026-10-14.
