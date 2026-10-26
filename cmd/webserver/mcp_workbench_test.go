package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// fixtureNet is a parity fixture as a tool argument (JSON text).
func fixtureNet(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile("../../parity/" + path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// callText is a tools/call over JSON-RPC and the text the client reads.
func callText(t *testing.T, name, args string) (map[string]any, string) {
	t.Helper()
	_, out := mcpCall(t, &Server{}, toolCall(name, args))
	res, _ := out["result"].(map[string]any)
	if res == nil {
		t.Fatalf("no result: %v", out)
	}
	return res, res["content"].([]any)[0].(map[string]any)["text"].(string)
}

func TestMCPWorkbenchToolsOverJSONRPC(t *testing.T) {
	sir := fixtureNet(t, "native/fixtures/sir.jsonld")

	sde := call(t, "pflow_sde", `{"net":`+sir+`,"runs":4,"seed":3,"points":21}`)
	ts := sde["timeseries"].(map[string]any)
	if sde["engine"] != "sde" || len(ts["x"].([]any)) != 21 || len(ts["series"].([]any)) != 3 || sde["final_sd"] == nil {
		t.Fatalf("sde: %v", sde)
	}
	if s := ts["series"].([]any)[0].(map[string]any); s["band"] == nil || len(s["values"].([]any)) != 21 {
		t.Fatalf("sde series: %v", s)
	}
	one := call(t, "pflow_sde", `{"net":`+sir+`,"places":["I"]}`)
	if s := one["timeseries"].(map[string]any)["series"].([]any); len(s) != 1 || s[0].(map[string]any)["name"] != "I" || one["final_sd"] != nil {
		t.Fatalf("places filter / one run: %v", one)
	}
	if len(one["final"].(map[string]any)) != 3 {
		t.Fatalf("finals cover every place: %v", one["final"])
	}

	wi := call(t, "pflow_what_if", `{"net":`+sir+`,"place":"I"}`)
	sc := wi["scenarios"].([]any)
	if len(sc) != 2 || sc[0].(map[string]any)["name"] != "as is" || sc[1].(map[string]any)["name"] != "+1 I" {
		t.Fatalf("what_if scenarios: %v", sc)
	}
	if wi["from"] != float64(1) || wi["to"] != float64(2) || len(wi["finals"].([]any)) != 2 ||
		len(wi["timeseries"].(map[string]any)["series"].([]any)) != 6 || len(wi["table"].(map[string]any)["rows"].([]any)) != 2 {
		t.Fatalf("what_if: %v", wi)
	}

	opt := call(t, "pflow_optimize", `{"net":`+sir+`,"samples":15,"parameters":[{"transition":"infect","min":0.01,"max":0.2},{"transition":"recover","min":0.05,"max":0.5}],"objectives":[{"place":"R"},{"place":"I","sense":"min"}]}`)
	if opt["pareto_count"].(float64) < 1 || len(opt["table"].(map[string]any)["rows"].([]any)) != 15 || len(opt["scatter"].(map[string]any)["points"].([]any)) != 15 {
		t.Fatalf("optimize: %v", opt)
	}

	// Seeded: the same call gives the same answer. The stochastic engines to
	// the byte; the optimizer to rounding, because go-pflow's Tsit5 sums the
	// derivative in map order (measured: ~1e-15 relative between identical
	// calls), as pflow_simulate and pflow_rate_scan do.
	for _, c := range []struct {
		tool, args string
		tol        float64
	}{
		{"pflow_sde", `{"net":` + sir + `,"runs":3}`, 0},
		{"pflow_what_if", `{"net":` + sir + `,"place":"S","delta":-2,"runs":4}`, 0},
		{"pflow_optimize", `{"net":` + sir + `,"samples":5,"parameters":[{"transition":"recover","min":0.1,"max":0.3}],"objectives":[{"place":"R"}]}`, 1e-12},
	} {
		_, a := callText(t, c.tool, c.args)
		_, b := callText(t, c.tool, c.args)
		var x, y any
		json.Unmarshal([]byte(a), &x)
		json.Unmarshal([]byte(b), &y)
		if c.tol == 0 && a != b || len(jsonDiff(x, y, "", c.tol, nil)) > 0 {
			t.Errorf("%s: two identical calls differ: %v", c.tool, jsonDiff(x, y, "", c.tol, nil))
		}
		if len(a) > mcpMaxResultBytes/4 || strings.Contains(a, `"truncated"`) {
			t.Errorf("%s: a default-sized answer should be far under the size guard (%d bytes)", c.tool, len(a))
		}
	}
}

func TestMCPWorkbenchGatedNet(t *testing.T) {
	gated := fixtureNet(t, "native/fixtures/gated.jsonld")
	res, text := callText(t, "pflow_sde", `{"net":`+gated+`}`)
	if res["isError"] != true || !strings.HasPrefix(text, "sde refused:") || !strings.Contains(text, "inhibitor arc(s)") || !strings.Contains(text, "capacity is declared on") {
		t.Fatalf("SDE on a gated net should refuse: %v", text)
	}
	// what_if runs it on the discrete engine, which honours the gates: the
	// queue never holds more than its capacity of 3.
	wi := call(t, "pflow_what_if", `{"net":`+gated+`,"place":"Queue","delta":2,"runs":8,"t_end":6}`)
	for _, f := range wi["finals"].([]any) {
		for _, row := range f.(map[string]any)["rows"].([]any) {
			r := row.([]any)
			if r[0] == "Queue" && r[4].(float64) > 3 {
				t.Fatalf("Queue above its capacity: %v", r)
			}
			if r[0] == "Done" && r[4].(float64) > 4 {
				t.Fatalf("Done above its capacity: %v", r)
			}
		}
	}
}

func TestMCPWorkbenchBadInput(t *testing.T) {
	sir := fixtureNet(t, "native/fixtures/sir.jsonld")
	colored := fixtureNet(t, "native/fixtures/colored.jsonld")
	opt := `"parameters":[{"transition":"recover","min":0.1,"max":0.3}],"objectives":[{"place":"R"}]`
	for _, c := range []struct{ tool, args, want string }{
		{"pflow_sde", `{}`, "net: a JSON object"},
		{"pflow_sde", `{"net":` + sir + `,"steps":3}`, `unknown argument "steps"`},
		{"pflow_sde", `{"net":` + sir + `,"seed":1.5}`, `argument "seed" should be an integer`},
		{"pflow_sde", `{"net":` + sir + `,"points":501}`, "points 501 is outside 2..500"},
		{"pflow_sde", `{"net":` + sir + `,"runs":201}`, "runs 201 is outside 1..200"},
		{"pflow_sde", `{"net":` + sir + `,"seed":-1}`, "seed must be ≥ 0, got -1"},
		{"pflow_sde", `{"net":` + sir + `,"runs":200,"dt":0.00002}`, "over this server's budget"},
		{"pflow_sde", `{"net":` + sir + `,"places":["Z"]}`, `places: no place "Z"`},
		{"pflow_what_if", `{"net":` + sir + `}`, `missing argument "place"`},
		{"pflow_what_if", `{"net":` + sir + `,"place":"I","delta":1.5}`, `argument "delta" should be an integer`},
		{"pflow_what_if", `{"net":` + sir + `,"place":"I","samples":501}`, "samples 501 is outside 2..500"},
		{"pflow_what_if", `{"net":` + sir + `,"place":"I","runs":0}`, "runs 0 is outside 1..200"},
		{"pflow_what_if", `{"net":` + sir + `,"place":"I","t_end":0}`, "t_end 0 is outside (0, 10000]"},
		{"pflow_what_if", `{"net":` + sir + `,"place":"I","delta":-2}`, "I has 1; cannot remove 2"},
		{"pflow_what_if", `{"net":` + colored + `,"place":"Pool"}`, `place "Pool" holds several colors`},
		{"pflow_optimize", `{"net":` + sir + `,"objectives":[{"place":"R"}]}`, `missing argument "parameters"`},
		{"pflow_optimize", `{"net":` + sir + `,` + opt + `,"samples":501}`, "samples 501 is outside 1..500"},
		{"pflow_optimize", `{"net":` + sir + `,` + opt + `,"t_end":20000}`, "over this server's cap"},
		{"pflow_optimize", `{"net":` + sir + `,` + opt + `,"dt":-1}`, "dt must be a positive number, got -1"},
		{"pflow_optimize", `{"net":` + sir + `,"parameters":[{"transition":"recover","min":0.1,"max":0.3}],"objectives":[{"place":"Z"}]}`, `no place "Z"; places are ["I", "R", "S"]`},
	} {
		res, text := callText(t, c.tool, c.args)
		if res["isError"] != true || !strings.Contains(text, c.want) {
			t.Errorf("%s %.80s: want an error containing %q, got %v %s", c.tool, c.args, c.want, res["isError"], text)
		}
	}
}

// The engines stop when the call's context does (callMCPTool's deadline).
func TestMCPWorkbenchStopsWhenCancelled(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(fixtureNet(t, "native/fixtures/sir.jsonld")), &doc); err != nil {
		t.Fatal(err)
	}
	n, err := newWBNet(doc)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runSDE(ctx, n, wbArgs{}, sdeOpts{maxPoints: wbMaxSDEPoints, maxWork: wbMaxSDEWork}); err == nil || !strings.Contains(err.Error(), "cancel") {
		t.Errorf("sde: %v", err)
	}
	if _, err := runWhatIf(ctx, n, wbArgs{"place": "I"}, whatIfOpts{maxSamples: wbMaxWhatIfSamples, maxSteps: maxSSASteps}); err == nil || !strings.Contains(err.Error(), "cancel") {
		t.Errorf("what_if: %v", err)
	}
	a := wbArgs{"parameters": []any{map[string]any{"transition": "recover", "min": 0.1, "max": 0.3}}, "objectives": []any{map[string]any{"place": "R"}}}
	if _, err := runOptimize(ctx, n, a, optOpts{maxSamples: wbMaxOptSamples, maxTEnd: maxMCPTEnd}); err == nil || !strings.Contains(err.Error(), "cancel") {
		t.Errorf("optimize: %v", err)
	}
}
