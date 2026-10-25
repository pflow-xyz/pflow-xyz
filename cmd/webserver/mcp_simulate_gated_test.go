package main

import (
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// The three gates a continuous solver cannot test. Each net's expected final
// marking is what the page's token game and SSA give; the ODE would drain a,
// consume the read place and overfill b.
var gatedNets = []struct {
	name, net string
	want      map[string]float64
}{
	{"inhibitor blocks", `{"places":{"a":{"initial":[5]},"h":{"initial":[1]},"b":{"initial":[0]}},
	 "transitions":{"t":{"rate":1}},
	 "arcs":[{"source":"a","target":"t","weight":[1]},{"source":"h","target":"t","weight":[1],"inhibitTransition":true},{"source":"t","target":"b","weight":[1]}]}`,
		map[string]float64{"a": 5, "h": 1, "b": 0}},
	{"read arc keeps its tokens", `{"places":{"a":{"initial":[3]},"r":{"initial":[1]},"b":{"initial":[0]}},
	 "transitions":{"t":{"rate":1}},
	 "arcs":[{"source":"a","target":"t","weight":[1]},{"source":"r","target":"t","weight":[1],"type":"read"},{"source":"t","target":"b","weight":[1]}]}`,
		map[string]float64{"a": 0, "r": 1, "b": 3}},
	{"capacity stops the firing", `{"places":{"a":{"initial":[5]},"b":{"initial":[0],"capacity":[2]}},
	 "transitions":{"t":{"rate":1}},
	 "arcs":[{"source":"a","target":"t","weight":[1]},{"source":"t","target":"b","weight":[1]}]}`,
		map[string]float64{"a": 3, "b": 2}},
}

// pageFinal runs the net through the page's own SSA engine (public/petri-ssa.js).
func pageFinal(t *testing.T, net string) map[string]float64 {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed: the page-engine side needs it")
	}
	abs, _ := filepath.Abs("../../public/petri-ssa.js")
	script := filepath.Join(t.TempDir(), "run.mjs")
	src := `import { simulate } from ` + jsonStr(abs) + `;
const r = simulate(JSON.parse(process.argv[2]), { horizon: 50, samples: 5, realizations: 20, seed: 42 });
console.log(JSON.stringify(r.final));`
	if err := os.WriteFile(script, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, script, net).CombinedOutput()
	if err != nil {
		t.Fatalf("page engine: %v\n%s", err, out)
	}
	var f map[string]float64
	if err := json.Unmarshal(out, &f); err != nil {
		t.Fatalf("page engine output %q: %v", out, err)
	}
	return f
}

func jsonStr(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestMCPSimulateHonoursGatesLikeThePage(t *testing.T) {
	s := &Server{}
	for _, c := range gatedNets {
		t.Run(c.name, func(t *testing.T) {
			_, out := mcpCall(t, s, toolCall("pflow_simulate", `{"net":`+c.net+`,"t_end":50,"points":5}`))
			sim := structured(t, out)
			if e, _ := sim["engine"].(string); len(e) < 3 || e[:3] != "ssa" {
				t.Fatalf("a gated net must run on the discrete engine, got %v", sim["engine"])
			}
			got := sim["final"].(map[string]any)
			page := pageFinal(t, c.net)
			for p, want := range c.want {
				g, _ := got[p].(float64)
				if math.Abs(g-want) > 1e-6 {
					t.Errorf("hosted %s = %v, want %v (full %v)", p, g, want, got)
				}
				if math.Abs(page[p]-g) > 1e-6 {
					t.Errorf("hosted %s = %v but the page engine gives %v", p, g, page[p])
				}
			}
		})
	}
}

// An ungated net keeps the ODE.
func TestMCPSimulateUngatedStaysODE(t *testing.T) {
	_, out := mcpCall(t, &Server{}, toolCall("pflow_simulate", `{"net":`+mcpNet+`,"t_end":20,"points":5}`))
	if e, _ := structured(t, out)["engine"].(string); e != "ode (go-pflow Tsit5)" {
		t.Fatalf("engine = %q", e)
	}
}
