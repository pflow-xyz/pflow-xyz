// Command gocheck loads the showcase models through go-pflow directly (no MCP):
// the colored theme through parser.FromJSON, the operations variation through
// metamodel validation, ExpandStages and the schedule-aware SSA, and the
// kinetics variation through the portable (byte-exact) SSA, whose final marking
// it writes to fixtures/ssa-go-seed42.json. Run from the repo root:
//
//	go run ./examples/showcase/gocheck
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/pflow-xyz/go-pflow/metamodel"
	"github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/go-pflow/stochastic"
)

const dir = "examples/showcase/"

func load(name string) *metamodel.Model {
	raw, err := os.ReadFile(dir + name)
	if err != nil { panic(err) }
	var m metamodel.Model
	if err := json.Unmarshal(raw, &m); err != nil { panic(name + ": " + err.Error()) }
	return &m
}

func initial(m *metamodel.Model) map[string]int {
	out := map[string]int{}
	for _, p := range m.Places { out[p.ID] = p.Initial }
	return out
}

func main() {
	// Theme: the pflow.xyz colored shape through go-pflow's parser.
	raw, _ := os.ReadFile(dir + "cafe.jsonld")
	net, err := parser.FromJSON(raw)
	if err != nil { panic(err) }
	fmt.Printf("cafe.jsonld: %d places, %d transitions, %d arcs via parser.FromJSON\n", len(net.Places), len(net.Transitions), len(net.Arcs))

	// Variation II: schedules, stages, parameters validated; SSA with the schedule honoured.
	svc := load("cafe-service.json")
	fmt.Println("cafe-service ValidateSchedules:", svc.ValidateSchedules(), "ValidateParameters:", svc.ValidateParameters())
	exp, info, err := svc.ExpandStages()
	if err != nil { panic(err) }
	fmt.Printf("ExpandStages: %d -> %d transitions (%+v)\n", len(svc.Transitions), len(exp.Transitions), info)
	res, err := stochastic.SimulateSchedule(svc, initial(svc), stochastic.Options{Horizon: 8, Samples: 9, Seed: 42, Realizations: 10, Portable: true, Rates: map[string]float64{"vip_arrives": 0}})
	if err != nil { panic(err) }
	fmt.Printf("SimulateSchedule seed 42 x10: served=%.1f walked_out=%.1f beans=%.1f caveats=%v\n", res.Final["served"], res.Final["walked_out"], res.Final["beans"], res.Caveats)

	// Variation I: portable SSA, the byte-exact cross-language path.
	kin := load("cafe-kinetics.json")
	r2, err := stochastic.Simulate(kin, initial(kin), stochastic.Options{Horizon: 8, Samples: 5, Seed: 42, Realizations: 1, Portable: true})
	if err != nil { panic(err) }
	fmt.Printf("cafe-kinetics portable SSA seed 42: final=%v\n", r2.Final)
	b, _ := json.Marshal(r2.Final)
	os.WriteFile(dir+"fixtures/ssa-go-seed42.json", b, 0o644)
}
