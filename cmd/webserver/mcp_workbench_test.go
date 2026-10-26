package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/pflow-xyz/go-pflow/solver"
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

	// Seeded: the same call gives the same bytes, the optimizer included (it
	// sums the derivative in a fixed order; go-pflow's Solve sums it in map
	// order, which differed by ~1e-15 between identical calls).
	for _, c := range []struct{ tool, args string }{
		{"pflow_sde", `{"net":` + sir + `,"runs":3}`},
		{"pflow_what_if", `{"net":` + sir + `,"place":"S","delta":-2,"runs":4}`},
		{"pflow_optimize", `{"net":` + sir + `,"samples":5,"parameters":[{"transition":"recover","min":0.1,"max":0.3}],"objectives":[{"place":"R"}]}`},
	} {
		_, a := callText(t, c.tool, c.args)
		_, b := callText(t, c.tool, c.args)
		if a != b {
			t.Errorf("%s: two identical calls differ:\n%s\n%s", c.tool, a, b)
		}
		if len(a) > mcpMaxResultBytes/4 || strings.Contains(a, `"truncated"`) || strings.Contains(a, `"note"`) {
			t.Errorf("%s: a default-sized answer should be far under the size guard (%d bytes)", c.tool, len(a))
		}
	}
}

// An objective the sampled rates cannot move ties exactly across samples, so
// the Pareto flags are decided by the other objective alone, every time. With
// go-pflow's Solve the tie broke on rounding noise that changed from call to
// call (pareto_count 1 or 2 for the same arguments; native says 1).
func TestMCPWorkbenchOptimizeTieIsDeterministic(t *testing.T) {
	tie := fixtureNet(t, "native/fixtures/tie.jsonld")
	args := `{"net":` + tie + `,"samples":60,"seed":5,"parameters":[{"transition":"tA","min":0.05,"max":0.5}],"objectives":[{"place":"R"},{"place":"B"}]}`
	_, first := callText(t, "pflow_optimize", args)
	var out map[string]any
	if err := json.Unmarshal([]byte(first), &out); err != nil {
		t.Fatal(err)
	}
	if out["pareto_count"] != float64(1) {
		t.Fatalf("pareto_count %v, want 1", out["pareto_count"])
	}
	rs := map[any]bool{}
	for _, row := range out["table"].(map[string]any)["rows"].([]any) {
		rs[row.([]any)[2]] = true
	}
	if len(rs) != 1 {
		t.Fatalf("R should be one value across samples, got %d: %v", len(rs), rs)
	}
	for i := 0; i < 20; i++ {
		if _, again := callText(t, "pflow_optimize", args); again != first {
			t.Fatalf("call %d differs from the first", i+2)
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
		// Numbers out of range print as Rust's saturating casts print them.
		{"pflow_sde", `{"net":` + sir + `,"dt":5e-324}`, "needs 18446744073709551615 sample intervals over t_end 10, over the 50000 cap"},
		{"pflow_what_if", `{"net":` + sir + `,"place":"I","delta":1e300}`, `marking for "I" is 9223372036854775807, over the 1000000 cap`},
		// A seed above 2^53 cannot survive the call's JSON decoding (float64)
		// exactly, so it is refused; native takes it (parity/native/README.md).
		{"pflow_sde", `{"net":` + sir + `,"seed":10000000000000000}`, "seed must be at most 9007199254740992"},
		// This server's limits on the optimizer.
		{"pflow_optimize", `{"net":` + sir + `,` + opt + `,"abstol":1e-15}`, "abstol 0.000000000000001 is below this server's floor of 0.000000000001"},
		{"pflow_optimize", `{"net":` + sir + `,` + opt + `,"reltol":1e-13}`, "reltol 0.0000000000001 is below this server's floor"},
		{"pflow_optimize", `{"net":` + sir + `,` + opt + `,"method":"euler","dt":0.00001}`, "method euler steps a fixed dt of 0.00001: 1000001 steps over t_end 10, past the solver's 100000-step limit"},
		{"pflow_optimize", `{"net":` + sir + `,` + opt + `,"method":"rk4","t_end":2000}`, "method rk4 steps a fixed dt of 0.01: 200001 steps"},
		{"pflow_optimize", `{"net":` + sir + `,"parameters":[{"transition":"recover","min":0.1,"max":0.3}],"objectives":[` + strings.Repeat(`{"place":"R"},`, 16) + `{"place":"R"}]}`, "17 objectives is over this server's cap of 16"},
	} {
		res, text := callText(t, c.tool, c.args)
		if res["isError"] != true || !strings.Contains(text, c.want) {
			t.Errorf("%s %.80s: want an error containing %q, got %v %s", c.tool, c.args, c.want, res["isError"], text)
		}
	}
}

// wbRingNet is a net of p places in a ring, transition t_i moving a token from
// place i to place i+1 at rate 0.2, every place starting with 10 tokens.
func wbRingNet(p int) string {
	places, trans, arcs := []string{}, []string{}, []string{}
	for i := 0; i < p; i++ {
		places = append(places, fmt.Sprintf(`"p%03d":{"initial":[10]}`, i))
		trans = append(trans, fmt.Sprintf(`"t%03d":{"rate":0.2}`, i))
		arcs = append(arcs, fmt.Sprintf(`{"source":"p%03d","target":"t%03d","weight":[1]},{"source":"t%03d","target":"p%03d","weight":[1]}`, i, i, i, (i+1)%p))
	}
	return `{"@context":"https://pflow.xyz/schema","@type":"PetriNet","places":{` + strings.Join(places, ",") +
		`},"transitions":{` + strings.Join(trans, ",") + `},"arcs":[` + strings.Join(arcs, ",") + `]}`
}

// The caps on the net and the work and memory budgets, which count places as
// well as transitions; all refuse before the engine runs.
func TestMCPWorkbenchBudgets(t *testing.T) {
	sir := fixtureNet(t, "native/fixtures/sir.jsonld")
	wide := wbRingNet(301)
	for _, c := range []struct{ tool, args, want string }{
		{"pflow_sde", `{"net":` + wide + `}`, "the net has 301 token places (colours unfolded), over this server's cap of 300"},
		{"pflow_what_if", `{"net":` + wide + `,"place":"p000"}`, "over this server's cap of 300"},
		{"pflow_optimize", `{"net":` + wide + `,"parameters":[{"transition":"t000","min":0.1,"max":1}],"objectives":[{"place":"p001"}]}`, "over this server's cap of 300"},
		// SimulateSDE keeps ~5 doubles per sample and place: a fine dt on 25
		// places (the review's 197 MB case had 100) is refused.
		{"pflow_sde", `{"net":` + wbRingNet(25) + `,"dt":0.00001,"t_end":9.99,"points":2}`, "samples × places is 1248775, over this server's budget of 500000"},
		{"pflow_sde", `{"net":` + wbRingNet(40) + `,"runs":200,"points":200,"places":["p000"]}`, "over this server's budget of 100000000"},
		{"pflow_what_if", `{"net":` + wbRingNet(50) + `,"place":"p000","runs":200,"samples":500,"places":[]}`, "runs × samples × places is 5000000, over this server's budget of 4000000"},
		{"pflow_optimize", `{"net":` + wbRingNet(65) + `,"parameters":[` + func() string {
			ps := []string{}
			for i := 0; i < 65; i++ {
				ps = append(ps, fmt.Sprintf(`{"transition":"t%03d","min":0.1,"max":1}`, i))
			}
			return strings.Join(ps, ",")
		}() + `],"objectives":[{"place":"p001"}]}`, "65 parameters is over this server's cap of 64"},
		{"pflow_optimize", `{"net":` + wbRingNet(200) + `,"samples":500,"method":"euler","dt":0.001,"parameters":[{"transition":"t000","min":0.1,"max":1}],"objectives":[{"place":"p001"}]}`, "over this server's budget of 2000000000"},
	} {
		res, text := callText(t, c.tool, c.args)
		if res["isError"] != true || !strings.Contains(text, c.want) {
			t.Errorf("%s %.80s: want an error containing %q, got %v %.300s", c.tool, c.args, c.want, res["isError"], text)
		}
	}

	// An adaptive solve's step count shows only as it runs: the budget is
	// checked as the solves go, and a solve that runs out of steps is an
	// error (native answers with where it stopped, as if it were t_end).
	stiff := `{"@context":"https://pflow.xyz/schema","@type":"PetriNet","places":{"A":{"initial":[10]},"B":{"initial":[0]}},` +
		`"transitions":{"f":{"rate":10000000},"b":{"rate":10000000}},"arcs":[{"source":"A","target":"f","weight":[1]},{"source":"f","target":"B","weight":[1]},{"source":"B","target":"b","weight":[1]},{"source":"b","target":"A","weight":[1]}]}`
	res, text := callText(t, "pflow_optimize", `{"net":`+stiff+`,"samples":1,"parameters":[{"transition":"f","min":10000000,"max":10000000}],"objectives":[{"place":"B"}]}`)
	if res["isError"] != true || !strings.Contains(text, "optimize: sample 0's solve stopped at t = ") || !strings.Contains(text, "short of t_end 10, at the solver's 100000-step limit") {
		t.Errorf("a truncated solve should be an error: %v %s", res["isError"], text)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(sir), &doc); err != nil {
		t.Fatal(err)
	}
	n, err := newWBNet(doc)
	if err != nil {
		t.Fatal(err)
	}
	o := mcpOptOpts()
	o.maxWork = 400_000 // past the pre-check (50 samples × 20 steps × 336), not the solves
	a := wbArgs{"samples": 50.0, "abstol": 1e-10, "reltol": 1e-10,
		"parameters": []any{map[string]any{"transition": "recover", "min": 0.1, "max": 0.3}}, "objectives": []any{map[string]any{"place": "R"}}}
	if _, err := runOptimize(context.Background(), n, a, o); err == nil || !strings.Contains(err.Error(), "optimize: the solves outgrew this server's budget of 400000 after") {
		t.Errorf("the solve budget: %v", err)
	}
}

// Every answer fits the result guard whole. The size is bounded before the
// run; a count the caller chose that does not fit is refused naming one that
// does, and a default count is lowered, saying so in `note`.
func TestMCPWorkbenchAnswersFit(t *testing.T) {
	sir := fixtureNet(t, "native/fixtures/sir.jsonld")
	knapsack := fixtureNet(t, "fixtures/knapsack.jsonld")
	netB := fixtureNet(t, "fixtures/net-b.jsonld")
	two := `"parameters":[{"transition":"infect","min":0.01,"max":0.2},{"transition":"recover","min":0.05,"max":0.5}],"objectives":[{"place":"R"},{"place":"I","sense":"min"}]`
	refused := []struct{ tool, args, want string }{
		// The review's cases: each was cut by the guard (65, 85, 197, 69 KB).
		{"pflow_sde", `{"net":` + sir + `,"points":500,"runs":8}`, "points 500 makes an answer of 65420 bytes, over this server's 61440-byte limit; about "},
		{"pflow_what_if", `{"net":` + sir + `,"place":"I","samples":500}`, "samples 500 makes an answer of 84721 bytes, over this server's 61440-byte limit; about "},
		{"pflow_what_if", `{"net":` + knapsack + `,"place":"capacity","samples":500}`, "samples 500 makes an answer of 197560 bytes"},
		{"pflow_optimize", `{"net":` + sir + `,"samples":500,` + two + `}`, "samples 500 makes an answer of 65406 bytes (11 of them on the Pareto front), over this server's 61440-byte limit; at most "},
		// Refused before running: even the shortest numbers would not fit.
		{"pflow_what_if", `{"net":` + netB + `,"place":"Next","samples":500}`, "samples 500 would make an answer of at least "},
	}
	for _, c := range refused {
		res, text := callText(t, c.tool, c.args)
		if res["isError"] != true || !strings.Contains(text, c.want) || !strings.Contains(text, " fit") {
			t.Errorf("%s %.60s: want a refusal containing %q, got %v %.300s", c.tool, c.args, c.want, res["isError"], text)
		}
	}
	// The count a refusal names does fit.
	for _, c := range []struct{ tool, args, key string }{
		{"pflow_sde", `{"net":` + sir + `,"runs":8,"points":`, "points"},
		{"pflow_what_if", `{"net":` + knapsack + `,"place":"capacity","samples":`, "samples"},
		{"pflow_optimize", `{"net":` + sir + `,` + two + `,"samples":`, "samples"},
	} {
		_, text := callText(t, c.tool, c.args+`500}`)
		m := regexp.MustCompile(`(?:about|at most) (\d+) fit`).FindStringSubmatch(text)
		if m == nil {
			t.Fatalf("%s: no count in %q", c.tool, text)
		}
		res, again := callText(t, c.tool, c.args+m[1]+`}`)
		if res["isError"] == true || len(again) > mcpMaxResultBytes || strings.Contains(again, `"truncated"`) {
			t.Errorf("%s with %s %s: %v %.200s", c.tool, c.key, m[1], res["isError"], again)
		}
	}

	// Defaults are lowered to fit, and the answer says so.
	ring30, ring60 := wbRingNet(30), wbRingNet(60)
	for _, c := range []struct{ tool, args, note string }{
		{"pflow_what_if", `{"net":` + ring30 + `,"place":"p000"}`, "samples is "},
		{"pflow_what_if", `{"net":` + ring60 + `,"place":"p000"}`, "samples is "},
		{"pflow_sde", `{"net":` + ring60 + `}`, "points is "},
		{"pflow_sde", `{"net":` + ring60 + `,"runs":4}`, "points is "},
	} {
		res, text := callText(t, c.tool, c.args)
		var out map[string]any
		if res["isError"] == true || json.Unmarshal([]byte(text), &out) != nil || len(text) > mcpMaxResultBytes {
			t.Fatalf("%s %.60s: %v %.300s", c.tool, c.args, res["isError"], text)
		}
		if note, _ := out["note"].(string); !strings.HasPrefix(note, c.note) || !strings.Contains(note, "not the default") {
			t.Errorf("%s %.60s: note %q", c.tool, c.args, out["note"])
		}
	}

	// Across nets and arguments, no answer is ever cut by the guard.
	nets := map[string]string{"sir": sir, "knapsack": knapsack, "net-b": netB, "ring30": ring30, "ring120": wbRingNet(120),
		"coffee": fixtureNet(t, "fixtures/coffee-shop.jsonld"), "colored": fixtureNet(t, "native/fixtures/colored.jsonld")}
	answered := 0
	for name, net := range nets {
		var doc map[string]any
		json.Unmarshal([]byte(net), &doc)
		var places, trans []string
		for p := range doc["places"].(map[string]any) {
			places = append(places, p)
		}
		for tr := range doc["transitions"].(map[string]any) {
			trans = append(trans, tr)
		}
		sort.Strings(places)
		sort.Strings(trans)
		params := []string{}
		for _, tr := range trans {
			params = append(params, fmt.Sprintf(`{"transition":%q,"min":0.1,"max":1}`, tr))
		}
		if len(params) > wbMaxOptParams {
			params = params[:wbMaxOptParams]
		}
		objs := fmt.Sprintf(`[{"place":%q},{"place":%q,"sense":"min"}]`, places[0], places[len(places)-1])
		for _, c := range []struct{ tool, args string }{
			{"pflow_sde", `{}`}, {"pflow_sde", `{"runs":8}`}, {"pflow_sde", `{"runs":8,"points":500}`}, {"pflow_sde", `{"dt":0.01,"points":500}`},
			{"pflow_what_if", fmt.Sprintf(`{"place":%q}`, places[0])}, {"pflow_what_if", fmt.Sprintf(`{"place":%q,"samples":500,"runs":10}`, places[0])},
			{"pflow_optimize", `{"parameters":[` + params[0] + `],"objectives":` + objs + `}`},
			{"pflow_optimize", `{"parameters":[` + strings.Join(params, ",") + `],"objectives":` + objs + `}`},
			{"pflow_optimize", `{"samples":500,"parameters":[` + strings.Join(params, ",") + `],"objectives":` + objs + `}`},
		} {
			args := `{"net":` + net + `,` + c.args[1:]
			if c.args == `{}` {
				args = `{"net":` + net + `}`
			}
			res, text := callText(t, c.tool, args)
			if strings.Contains(text, `"truncated"`) || len(text) > mcpMaxResultBytes {
				t.Errorf("%s %s %s: cut by the guard (%d bytes)", name, c.tool, c.args, len(text))
			}
			if res["isError"] != true {
				answered++
			}
		}
	}
	if answered < 30 {
		t.Errorf("only %d of the calls answered", answered)
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
	if _, err := runSDE(ctx, n, wbArgs{}, mcpSDEOpts()); err == nil || !strings.Contains(err.Error(), "cancel") {
		t.Errorf("sde: %v", err)
	}
	if _, err := runWhatIf(ctx, n, wbArgs{"place": "I"}, mcpWhatIfOpts()); err == nil || !strings.Contains(err.Error(), "cancel") {
		t.Errorf("what_if: %v", err)
	}
	a := wbArgs{"parameters": []any{map[string]any{"transition": "recover", "min": 0.1, "max": 0.3}}, "objectives": []any{map[string]any{"place": "R"}}}
	if _, err := runOptimize(ctx, n, a, mcpOptOpts()); err == nil || !strings.Contains(err.Error(), "cancel") {
		t.Errorf("optimize: %v", err)
	}
}

// The optimizer's integrator is go-pflow's solver.Solve, step for step: given
// the same derivative (through Problem.SetDerivative), Solve and solveFinal
// take the same number of steps, stop at the same time and end on the same
// doubles, for every method, with and without tolerances and a dt, and when
// the solve runs out of steps.
func TestWorkbenchODEIsGoPflowSolve(t *testing.T) {
	for _, fx := range []struct {
		path string
		tEnd float64
	}{
		{"native/fixtures/sir.jsonld", 10}, {"native/fixtures/colored.jsonld", 12}, {"native/fixtures/gated.jsonld", 5},
		{"fixtures/with-rates.jsonld", 2}, {"fixtures/knapsack.jsonld", 3}, {"native/fixtures/explode.jsonld", 500},
	} {
		var doc map[string]any
		if err := json.Unmarshal([]byte(fixtureNet(t, fx.path)), &doc); err != nil {
			t.Fatal(err)
		}
		n, err := newWBNet(doc)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range odeMethods {
			cases := []wbArgs{{}, {"abstol": 1e-8, "reltol": 1e-6}, {"dt": 0.5}}
			if name == "euler" && fx.path == "native/fixtures/sir.jsonld" {
				cases = append(cases, wbArgs{"dt": 1e-3}) // 1e4 steps: stops at Maxiters, lowered below
			}
			for _, a := range cases {
				method, _ := odeMethod(name)
				opts, err := gridSolverOptions(a, fx.tEnd)
				if err != nil {
					t.Fatal(err)
				}
				if a["dt"] == 1e-3 {
					opts.Maxiters = 2000
				}
				r, err := newODERunner(n, method, opts, fx.tEnd)
				if err != nil {
					t.Fatal(err)
				}
				rates := r.sampleRates(nil)
				end, err := r.solveFinal(rates, nil)
				if err != nil {
					t.Fatal(err)
				}
				state := map[string]float64{}
				for i, l := range r.labels {
					state[l] = r.u0[i]
				}
				prob := solver.NewProblem(r.net, state, [2]float64{0, fx.tEnd}, nil)
				prob.SetDerivative(func(_ float64, um map[string]float64) map[string]float64 {
					u := make([]float64, len(r.labels))
					for i, l := range r.labels {
						u[i] = um[l]
					}
					du := make([]float64, len(u))
					r.deriv(rates, u, du)
					out := make(map[string]float64, len(u))
					for i, l := range r.labels {
						out[l] = du[i]
					}
					return out
				})
				sol := solver.Solve(prob, method, opts)
				what := fmt.Sprintf("%s %s %v", fx.path, name, a)
				if steps := len(sol.T) - 1; steps != end.steps || sol.Truncated != end.truncated ||
					math.Float64bits(sol.T[steps]) != math.Float64bits(end.t) {
					t.Fatalf("%s: Solve took %d steps to t=%v (truncated %v); solveFinal %d to t=%v (truncated %v)",
						what, steps, sol.T[steps], sol.Truncated, end.steps, end.t, end.truncated)
				}
				fin := sol.U[len(sol.U)-1]
				for i, l := range r.labels {
					if g, m := fin[l], end.u[i]; math.Float64bits(g) != math.Float64bits(m) && !(math.IsNaN(g) && math.IsNaN(m)) {
						t.Fatalf("%s: %s is %v from Solve, %v from solveFinal", what, l, g, m)
					}
				}
			}
		}
	}
}
