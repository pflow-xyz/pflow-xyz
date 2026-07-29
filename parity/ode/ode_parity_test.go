// Package ode_test is the Go side of the JS/Go ODE parity contract.
//
// Fixture models are integrated by both public/petri-solver.js (via
// parity/ode/ode_replay.mjs) and go-pflow's solver, with the default options
// both sides share (dt=0.01, dtmin=1e-6, dtmax=0.1, abstol=1e-6, reltol=1e-3,
// Tsit5). Final states must agree within TOL on every place.
//
// The corpus is fixed rather than random: ODE parity is about numerical
// agreement on meaningful dynamics, and a stable corpus keeps the tolerance
// meaningful. The discrete-firing contract next door (parity/sim) is where
// randomized structural coverage lives.
package ode_test

import (
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/go-pflow/solver"
)

// TOL is the max per-place |js-go|/(1+|js|) accepted. Measured agreement is
// ~1e-15 — the two Tsit5 implementations share the same tableau, step-size
// controller and defaults, so they are step-for-step identical, not merely
// within tolerance. The bound leaves nine orders of magnitude of headroom for
// floating-point jitter while still catching any real change to either
// integrator or vector field.
const TOL = 1e-6

type fixture struct {
	Name  string             `json:"name"`
	Model json.RawMessage    `json:"model"`
	Rates map[string]float64 `json:"rates"`
	Tspan [2]float64         `json:"tspan"`
}

type jsResult struct {
	Name  string             `json:"name"`
	Final map[string]float64 `json:"final"`
	Steps int                `json:"steps"`
}

func TestODEParityJSvsGo(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not found in PATH; JS/Go parity needs node")
	}

	raw, err := os.ReadFile("fixtures.json")
	if err != nil {
		t.Fatalf("read fixtures: %v", err)
	}
	var input struct {
		Models []fixture `json:"models"`
	}
	if err := json.Unmarshal(raw, &input); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}
	if len(input.Models) == 0 {
		t.Fatal("no fixtures")
	}

	// JS side.
	tmp := filepath.Join(t.TempDir(), "fixtures.json")
	if err := os.WriteFile(tmp, raw, 0644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("node", "ode_replay.mjs", tmp).Output()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			t.Fatalf("ode_replay.mjs failed: %v\nstderr: %s", err, ee.Stderr)
		}
		t.Fatalf("ode_replay.mjs failed: %v", err)
	}
	var jsResults []jsResult
	if err := json.Unmarshal(out, &jsResults); err != nil {
		t.Fatalf("bad ode_replay.mjs output: %v\nraw: %s", err, out)
	}

	jsByName := map[string]jsResult{}
	for _, r := range jsResults {
		jsByName[r.Name] = r
	}

	// Go side + comparison.
	for _, fx := range input.Models {
		t.Run(fx.Name, func(t *testing.T) {
			js, ok := jsByName[fx.Name]
			if !ok {
				t.Fatalf("no JS result for %s", fx.Name)
			}

			net, err := parser.FromJSON(fx.Model)
			if err != nil {
				t.Fatalf("go parser: %v", err)
			}
			state := net.SetState(nil)
			rates := net.SetRates(fx.Rates)

			prob := solver.NewProblem(net, state, fx.Tspan, rates)
			sol := solver.Solve(prob, solver.Tsit5(), solver.DefaultOptions())
			final := sol.GetFinalState()

			var worst float64
			var worstPlace string
			for place, jsVal := range js.Final {
				goVal, ok := final[place]
				if !ok {
					t.Fatalf("place %q missing from Go final state", place)
				}
				rel := math.Abs(jsVal-goVal) / (1 + math.Abs(jsVal))
				if rel > worst {
					worst, worstPlace = rel, place
				}
				if rel > TOL {
					t.Errorf("place %q diverges: js=%.6f go=%.6f (rel %.2e > %.0e)",
						place, jsVal, goVal, rel, TOL)
				}
			}
			t.Logf("worst place %q rel-diff %.2e (js %d steps)", worstPlace, worst, js.Steps)

			// Both sides must conserve what the net conserves: for the closed
			// fixtures the total mass at tf equals the initial total.
			if fx.Name == "sir" || fx.Name == "cycle" {
				jsTotal, goTotal, initTotal := 0.0, 0.0, 0.0
				for p, v := range js.Final {
					jsTotal += v
					goTotal += final[p]
				}
				for _, v := range state {
					initTotal += v
				}
				if math.Abs(jsTotal-initTotal) > 1e-3*initTotal {
					t.Errorf("JS violates conservation: total %.6f vs initial %.6f", jsTotal, initTotal)
				}
				if math.Abs(goTotal-initTotal) > 1e-3*initTotal {
					t.Errorf("Go violates conservation: total %.6f vs initial %.6f", goTotal, initTotal)
				}
			}
		})
	}
}
