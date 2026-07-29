// Package sim_test is the Go side of the JS/Go behavioral parity contract.
//
// It generates seeded random models in the pflow.xyz JSON format, walks each
// one in lockstep with parity/sim/replay.mjs (which drives the browser's own
// public/petri-sim.js), and asserts both engines agree on the enabled set and
// the marking at every step.
//
// The walk is deterministic — fire the lexicographically smallest enabled
// transition — so no randomness crosses the language boundary; a divergence is
// a semantic difference between the two engines, not test noise.
//
// The generator covers weights above 1, weighted input inhibitors, output-side
// inhibitors (test arcs), and place capacities. Token COLORS are deliberately
// out of scope: petri-sim.js is component-wise per color while go-pflow's
// discrete engine sums color vectors into scalar markings — a known
// representational gap, not something a test can reconcile.
package sim_test

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"

	"github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/go-pflow/reachability"
)

const (
	numModels = 200
	maxSteps  = 40
)

// jsonModel mirrors the pflow.xyz model format both engines consume.
type jsonModel struct {
	Places      map[string]jsonPlace      `json:"places"`
	Transitions map[string]jsonTransition `json:"transitions"`
	Arcs        []jsonArc                 `json:"arcs"`
}

type jsonPlace struct {
	Initial  float64 `json:"initial"`
	Capacity float64 `json:"capacity,omitempty"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
}

type jsonTransition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type jsonArc struct {
	Source            string  `json:"source"`
	Target            string  `json:"target"`
	Weight            float64 `json:"weight"`
	InhibitTransition bool    `json:"inhibitTransition,omitempty"`
}

type step struct {
	Enabled []string       `json:"enabled"`
	Fired   any            `json:"fired"`
	Marking map[string]int `json:"marking"`
}

type modelTrace struct {
	Name  string `json:"name"`
	Steps []step `json:"steps"`
}

// generate builds a random single-color model exercising the dimensions the
// two engines could disagree on.
func generate(r *rand.Rand) jsonModel {
	np := 2 + r.Intn(4)
	nt := 1 + r.Intn(4)

	m := jsonModel{
		Places:      map[string]jsonPlace{},
		Transitions: map[string]jsonTransition{},
	}

	for i := 0; i < np; i++ {
		p := jsonPlace{Initial: float64(r.Intn(4))}
		if r.Intn(4) == 0 {
			p.Capacity = float64(1 + r.Intn(4)) // 0 stays "unbounded"
		}
		m.Places[fmt.Sprintf("p%d", i)] = p
	}
	for i := 0; i < nt; i++ {
		tid := fmt.Sprintf("t%d", i)
		m.Transitions[tid] = jsonTransition{}

		for k := 0; k <= r.Intn(2); k++ {
			m.Arcs = append(m.Arcs, jsonArc{
				Source: fmt.Sprintf("p%d", r.Intn(np)), Target: tid,
				Weight: float64(1 + r.Intn(3)),
			})
		}
		for k := 0; k <= r.Intn(2); k++ {
			m.Arcs = append(m.Arcs, jsonArc{
				Source: tid, Target: fmt.Sprintf("p%d", r.Intn(np)),
				Weight: float64(1 + r.Intn(3)),
			})
		}
		// ~25%: a weighted input inhibitor (disables at tokens >= weight).
		if r.Intn(4) == 0 {
			m.Arcs = append(m.Arcs, jsonArc{
				Source: fmt.Sprintf("p%d", r.Intn(np)), Target: tid,
				Weight: float64(1 + r.Intn(2)), InhibitTransition: true,
			})
		}
		// ~12%: an output-side inhibitor (test arc: requires tokens >= weight,
		// moves nothing).
		if r.Intn(8) == 0 {
			m.Arcs = append(m.Arcs, jsonArc{
				Source: tid, Target: fmt.Sprintf("p%d", r.Intn(np)),
				Weight: float64(1 + r.Intn(2)), InhibitTransition: true,
			})
		}
	}
	return m
}

// goWalk performs the lockstep walk with go-pflow's engine.
func goWalk(t *testing.T, raw []byte) []step {
	t.Helper()
	net, err := parser.FromJSON(raw)
	if err != nil {
		t.Fatalf("go parser rejected generated model: %v", err)
	}

	initial := make(reachability.Marking, len(net.Places))
	for name, p := range net.Places {
		initial[name] = int(p.GetTokenCount())
	}

	g := reachability.NewGraph(net, initial)
	marks := initial
	var steps []step

	for i := 0; i < maxSteps; i++ {
		st := g.AddState(marks)
		enabled := append([]string(nil), st.Enabled...)
		sort.Strings(enabled)

		s := step{Enabled: enabled, Marking: map[string]int{}}
		for k, v := range marks {
			s.Marking[k] = v
		}

		if len(enabled) == 0 {
			s.Fired = nil
			steps = append(steps, s)
			break
		}

		fired := enabled[0]
		next := g.Fire(marks, fired)
		if next == nil {
			s.Fired = "FIRE_FAILED:" + fired
			steps = append(steps, s)
			break
		}
		marks = next
		s.Fired = fired
		s.Marking = map[string]int{}
		for k, v := range marks {
			s.Marking[k] = v
		}
		steps = append(steps, s)
	}
	return steps
}

func TestSimParityJSvsGo(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not found in PATH; JS/Go parity needs node")
	}

	// Generate the shared batch.
	type entry struct {
		Name  string    `json:"name"`
		Model jsonModel `json:"model"`
	}
	batch := struct {
		MaxSteps int     `json:"maxSteps"`
		Models   []entry `json:"models"`
	}{MaxSteps: maxSteps}

	rawModels := map[string][]byte{}
	for seed := 0; seed < numModels; seed++ {
		r := rand.New(rand.NewSource(int64(seed)))
		m := generate(r)
		name := fmt.Sprintf("seed-%03d", seed)
		raw, err := json.Marshal(m)
		if err != nil {
			t.Fatal(err)
		}
		rawModels[name] = raw
		batch.Models = append(batch.Models, entry{Name: name, Model: m})
	}

	batchFile := filepath.Join(t.TempDir(), "models.json")
	data, err := json.Marshal(batch)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(batchFile, data, 0644); err != nil {
		t.Fatal(err)
	}

	// JS side.
	out, err := exec.Command("node", "replay.mjs", batchFile).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			t.Fatalf("replay.mjs failed: %v\nstderr: %s", err, ee.Stderr)
		}
		t.Fatalf("replay.mjs failed: %v", err)
	}
	var jsTraces []modelTrace
	if err := json.Unmarshal(out, &jsTraces); err != nil {
		t.Fatalf("bad replay.mjs output: %v", err)
	}

	// Go side + comparison.
	divergent := 0
	for _, jt := range jsTraces {
		goSteps := goWalk(t, rawModels[jt.Name])

		if d := diffTraces(jt.Steps, goSteps); d != "" {
			divergent++
			if divergent <= 10 {
				t.Errorf("model %s diverges:\n%s\nmodel: %s", jt.Name, d, rawModels[jt.Name])
			}
		}
	}
	if divergent > 0 {
		t.Errorf("TOTAL: %d/%d models diverge between petri-sim.js and go-pflow", divergent, numModels)
	}
}

// diffTraces returns a description of the first divergence, or "".
func diffTraces(js, goS []step) string {
	n := len(js)
	if len(goS) < n {
		n = len(goS)
	}
	for i := 0; i < n; i++ {
		if !equalStrings(js[i].Enabled, goS[i].Enabled) {
			return fmt.Sprintf("  step %d enabled sets differ:\n    js: %v\n    go: %v\n    js marking before: %v",
				i, js[i].Enabled, goS[i].Enabled, prevMarking(js, i))
		}
		if fmt.Sprint(js[i].Fired) != fmt.Sprint(goS[i].Fired) {
			return fmt.Sprintf("  step %d fired differ: js=%v go=%v", i, js[i].Fired, goS[i].Fired)
		}
		if !equalMarkings(js[i].Marking, goS[i].Marking) {
			return fmt.Sprintf("  step %d markings differ after firing %v:\n    js: %v\n    go: %v",
				i, js[i].Fired, js[i].Marking, goS[i].Marking)
		}
	}
	if len(js) != len(goS) {
		return fmt.Sprintf("  trace lengths differ: js=%d go=%d", len(js), len(goS))
	}
	return ""
}

func prevMarking(steps []step, i int) map[string]int {
	if i == 0 {
		return nil
	}
	return steps[i-1].Marking
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func equalMarkings(a, b map[string]int) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}
