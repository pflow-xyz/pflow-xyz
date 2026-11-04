package main

// The goal toolset's eval (docs/design/agent-first-analysis.md, Step 2 and
// section 10): does the model pick the right goal, with the right inputs, and
// ask when it should? parity/ask/goal-cases.json holds the questions (3 to 4
// paraphrases of each goal, six deliberately ambiguous ones), each on one of
// the repo's own nets with the net.info summary the editor would send.
//
// Each case goes through the real /api/llm/turn handler with "toolset":
// "goals" in analyse mode, so what is measured is what ships: the manifest,
// the brief catalog and rules, the argument checks, and the model the server
// would pick. The model's FIRST accepted tool call is scored:
//
//	goal       run_goal with the expected goal_id (or ask_user, for the
//	           ambiguous cases: a guess there counts as a miss)
//	inputs     every input the case expects, with that value (ids exactly as
//	           the net lists them; JSON-kind inputs may arrive as text or as
//	           values)
//	override   engine_override only on the cases whose text names an engine,
//	           and then that engine; the model never picks one otherwise
//
// The live test is opt-in like the draft eval (TestLLMEvalLive): it needs
// PFLOW_LLM_EVAL=1 and GEMINI_API_KEY and never runs in make test or CI. Which
// model answers is PFLOW_LLM_GOAL_EVAL_MODEL:
//
//	unset  the main model (PFLOW_LLM_MODEL, else the default): what goal turns
//	       use today, and the baseline
//	goal   the goal model, PFLOW_LLM_GOAL_MODEL: the cheaper model the design
//	       wants for goal turns, to see whether selection accuracy holds on it
//	other  that model name
//
//	PFLOW_LLM_EVAL=1 GEMINI_API_KEY=... go test ./cmd/webserver/ -run TestLLMGoalEvalLive -count=1 -v
//	PFLOW_LLM_GOAL_EVAL_MODEL=goal PFLOW_LLM_GOAL_MODEL=gemini-flash-lite-latest ... (same)
//
// (A make target would be llm-goal-eval beside llm-eval; the Makefile is not
// this change's to edit.) The per-case results are printed and written to
// testdata/llm/goal-eval-<model>.json. The offline tests below run in make
// test: they check the cases file against the shipped manifest and drive the
// whole harness with a scripted model.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

type goalEvalNet struct {
	File   string          `json:"file"`
	Format string          `json:"format"`
	Engine string          `json:"engine"`
	Info   json.RawMessage `json:"info"`
}

type goalEvalCase struct {
	ID             string         `json:"id"`
	Text           string         `json:"text"`
	Net            string         `json:"net"`
	Goal           string         `json:"goal"` // a goal id, or ask_user
	Inputs         map[string]any `json:"inputs"`
	Engine         string         `json:"engine"`
	EngineOverride string         `json:"engine_override"`
	Why            string         `json:"why"`
}

type goalEvalFile struct {
	Version string                 `json:"version"`
	Nets    map[string]goalEvalNet `json:"nets"`
	Cases   []goalEvalCase         `json:"cases"`
}

func loadGoalEvalFile(t testing.TB) *goalEvalFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "parity", "ask", "goal-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f goalEvalFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("goal-cases.json: %v", err)
	}
	return &f
}

// goalEvalResult is one case scored.
type goalEvalResult struct {
	Case        goalEvalCase `json:"case"`
	Got         string       `json:"got"` // run_goal(knob), ask_user, none, or another tool's name
	GoalOK      bool         `json:"goal_ok"`
	InputsOK    bool         `json:"inputs_ok"`
	OverrideOK  bool         `json:"override_ok"`
	Detail      string       `json:"detail,omitempty"`
	InputTokens int          `json:"input_tokens,omitempty"`
	OutTokens   int          `json:"output_tokens,omitempty"`
	Model       string       `json:"model,omitempty"`
}

func (r goalEvalResult) strict() bool { return r.GoalOK && r.InputsOK && r.OverrideOK }

// scoreGoalCase scores the model's first accepted call against the case.
func scoreGoalCase(c goalEvalCase, calls []turnCall) goalEvalResult {
	r := goalEvalResult{Case: c, Got: "none", InputsOK: true, OverrideOK: true}
	if len(calls) == 0 {
		r.Detail = "no tool call"
		r.InputsOK, r.OverrideOK = c.Goal == "ask_user", c.Goal == "ask_user"
		return r
	}
	first := calls[0]
	r.Got = first.Name
	if c.Goal == "ask_user" {
		r.GoalOK = first.Name == "ask_user"
		if !r.GoalOK {
			if g, _ := first.Args["goal_id"].(string); first.Name == "run_goal" {
				r.Got = "run_goal(" + g + ")"
			}
			r.Detail = "guessed instead of asking"
		}
		return r
	}
	if first.Name != "run_goal" {
		r.Detail = "first call is " + first.Name
		r.InputsOK, r.OverrideOK = false, false
		return r
	}
	got, _ := first.Args["goal_id"].(string)
	r.Got = "run_goal(" + got + ")"
	r.GoalOK = got == c.Goal
	if !r.GoalOK {
		r.Detail = "wanted " + c.Goal
	}
	in := decodeEvalInputs(first.Args["inputs"])
	var missing []string
	for k, want := range c.Inputs {
		if !sameEvalValue(want, in[k]) {
			missing = append(missing, fmt.Sprintf("%s=%v (want %v)", k, in[k], want))
		}
	}
	sort.Strings(missing)
	if r.InputsOK = len(missing) == 0; !r.InputsOK {
		r.Detail = strings.TrimSpace(r.Detail + " inputs: " + strings.Join(missing, ", "))
	}
	override, _ := first.Args["engine_override"].(string)
	if r.OverrideOK = override == c.EngineOverride; !r.OverrideOK {
		r.Detail = strings.TrimSpace(fmt.Sprintf("%s engine_override %q (want %q)", r.Detail, override, c.EngineOverride))
	}
	return r
}

// decodeEvalInputs: run_goal's inputs argument is a JSON object in a string;
// a model may also send the object itself.
func decodeEvalInputs(v any) map[string]any {
	switch x := v.(type) {
	case map[string]any:
		return x
	case string:
		var m map[string]any
		if json.Unmarshal([]byte(x), &m) == nil {
			return m
		}
	}
	return nil
}

// sameEvalValue compares an expected input with what the model passed: numbers
// by value, and a JSON text where an object or list was expected as that value.
func sameEvalValue(want, got any) bool {
	norm := func(v any) any {
		raw, _ := json.Marshal(v)
		var out any
		json.Unmarshal(raw, &out)
		return out
	}
	w := norm(want)
	if s, ok := got.(string); ok {
		switch w.(type) {
		case map[string]any, []any:
			var parsed any
			if json.Unmarshal([]byte(s), &parsed) == nil {
				got = parsed
			}
		}
	}
	return reflect.DeepEqual(w, norm(got))
}

// goalEvalServer is the real handler with the real goal toolset, a client of
// the caller's choosing and limits that do not get in the way of 44 turns.
func goalEvalServer(t testing.TB, client llm.Client, goalModel string) *Server {
	t.Helper()
	lim, err := llm.NewLimiter(llm.Limits{Burst: 1000, Refill: time.Millisecond, Daily: 100000, GlobalDaily: 100000}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{publicFS: os.DirFS(filepath.Join("..", "..", "public"))}
	m, decls, names, err := loadToolManifest(s.publicFS)
	if err != nil {
		t.Fatal(err)
	}
	gt, err := loadGoalToolset(s.publicFS)
	if err != nil {
		t.Fatal(err)
	}
	stats, err := llm.NewGoalStats(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.llm = &llmService{client: client, limiter: lim, verifier: stubVerifier{}, tools: names, toolDecls: decls, toolsVersion: m.Version,
		goalTools: gt, goalStats: stats, goalModel: goalModel}
	return s
}

// runGoalEval sends every case through the handler and scores it.
func runGoalEval(t *testing.T, s *Server, f *goalEvalFile) []goalEvalResult {
	t.Helper()
	var out []goalEvalResult
	for _, c := range f.Cases {
		body, _ := json.Marshal(map[string]any{
			"mode": "analyse", "toolset": "goals", "net": f.Nets[c.Net].Info,
			"messages": []any{map[string]any{"role": "user", "parts": []any{map[string]string{"text": c.Text}}}},
		})
		rec := do(t, s, "POST", "/api/llm/turn", "good", string(body))
		var resp struct {
			Calls []turnCall     `json:"tool_calls"`
			Usage map[string]int `json:"usage"`
			Model string         `json:"model"`
			Error string         `json:"error"`
		}
		json.Unmarshal(rec.Body.Bytes(), &resp)
		r := scoreGoalCase(c, resp.Calls)
		if rec.Code != 200 {
			r = goalEvalResult{Case: c, Got: "error", Detail: fmt.Sprintf("HTTP %d %s", rec.Code, resp.Error)}
		}
		r.InputTokens, r.OutTokens, r.Model = resp.Usage["input_tokens"], resp.Usage["output_tokens"], resp.Model
		out = append(out, r)
	}
	return out
}

// goalEvalSummary prints the per-case lines and the accuracy figures, and
// returns the share of cases with the right goal (or an ask where one was due).
func goalEvalSummary(t testing.TB, results []goalEvalResult) float64 {
	t.Helper()
	var goalOK, strict, ask, askOK, withInputs, inputsOK, withOverride, overrideOK, inTok, outTok int
	perGoal := map[string][2]int{}
	for _, r := range results {
		mark := "ok  "
		if !r.strict() {
			mark = "MISS"
		}
		t.Logf("%s %-14s %-28s %s", mark, r.Case.ID, r.Got, r.Detail)
		if r.GoalOK {
			goalOK++
		}
		if r.strict() {
			strict++
		}
		g := perGoal[r.Case.Goal]
		g[1]++
		if r.GoalOK {
			g[0]++
		}
		perGoal[r.Case.Goal] = g
		if r.Case.Goal == "ask_user" {
			ask++
			if r.GoalOK {
				askOK++
			}
		} else if r.GoalOK && len(r.Case.Inputs) > 0 {
			withInputs++
			if r.InputsOK {
				inputsOK++
			}
		}
		if r.Case.Goal != "ask_user" && r.GoalOK {
			withOverride++
			if r.OverrideOK {
				overrideOK++
			}
		}
		inTok += r.InputTokens
		outTok += r.OutTokens
	}
	n := len(results)
	acc := float64(goalOK) / float64(n)
	t.Logf("goal selection: %d/%d = %.1f%% (ask_user due: %d/%d)", goalOK, n, 100*acc, askOK, ask)
	t.Logf("inputs right when the goal was: %d/%d; engine_override right when the goal was: %d/%d", inputsOK, withInputs, overrideOK, withOverride)
	t.Logf("all of goal, inputs and override: %d/%d = %.1f%%", strict, n, 100*float64(strict)/float64(n))
	goals := make([]string, 0, len(perGoal))
	for g := range perGoal {
		goals = append(goals, g)
	}
	sort.Strings(goals)
	for _, g := range goals {
		t.Logf("  %-13s %d/%d", g, perGoal[g][0], perGoal[g][1])
	}
	t.Logf("tokens per turn: %d in, %d out (mean over %d turns)", inTok/n, outTok/n, n)
	return acc
}

// TestLLMGoalEvalLive is opt-in: PFLOW_LLM_EVAL=1 and GEMINI_API_KEY.
func TestLLMGoalEvalLive(t *testing.T) {
	key := os.Getenv("GEMINI_API_KEY")
	if os.Getenv("PFLOW_LLM_EVAL") != "1" || key == "" {
		t.Skip("live goal eval: set PFLOW_LLM_EVAL=1 and GEMINI_API_KEY (and PFLOW_LLM_GOAL_EVAL_MODEL=goal with PFLOW_LLM_GOAL_MODEL to try the goal model)")
	}
	goalModel := ""
	switch m := os.Getenv("PFLOW_LLM_GOAL_EVAL_MODEL"); m {
	case "":
	case "goal":
		if goalModel = strings.TrimSpace(os.Getenv("PFLOW_LLM_GOAL_MODEL")); goalModel == "" {
			t.Fatal("PFLOW_LLM_GOAL_EVAL_MODEL=goal needs PFLOW_LLM_GOAL_MODEL")
		}
	default:
		goalModel = m
	}
	client := llm.NewGemini(key, os.Getenv("PFLOW_LLM_MODEL"))
	label := client.Model()
	if goalModel != "" {
		label = goalModel
	}
	t.Logf("model for goal turns: %s", label)
	f := loadGoalEvalFile(t)
	results := runGoalEval(t, goalEvalServer(t, client, goalModel), f)
	acc := goalEvalSummary(t, results)

	dir := filepath.Join("..", "..", "testdata", "llm")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	rec, _ := json.MarshalIndent(map[string]any{"model": label, "cases": f.Version, "goal_selection": acc, "results": results}, "", "  ")
	name := filepath.Join(dir, "goal-eval-"+regexp.MustCompile(`[^a-zA-Z0-9.-]+`).ReplaceAllString(label, "_")+".json")
	if err := os.WriteFile(name, append(rec, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s", name)
}

// ---- offline: the cases file against the shipped manifest ----

func TestGoalCasesFileMatchesTheShippedGoalToolset(t *testing.T) {
	f := loadGoalEvalFile(t)
	if f.Version != "goal-cases-v1" {
		t.Fatal(f.Version)
	}
	gt, err := loadGoalToolset(os.DirFS(filepath.Join("..", "..", "public")))
	if err != nil {
		t.Fatal(err)
	}
	per := map[string]int{}
	seen := map[string]bool{}
	for _, c := range f.Cases {
		if seen[c.ID] || c.Text == "" || c.Why == "" {
			t.Errorf("%s: duplicate id, or no text or why", c.ID)
		}
		seen[c.ID] = true
		per[c.Goal]++
		n, ok := f.Nets[c.Net]
		if !ok || len(n.Info) == 0 || len(n.Info) > maxNetSummary {
			t.Errorf("%s: net %q missing or over the %d bytes the server takes", c.ID, c.Net, maxNetSummary)
			continue
		}
		if c.Engine != n.Engine || (n.Engine != "ode" && n.Engine != "ssa") {
			t.Errorf("%s: engine %q, the net's is %q", c.ID, c.Engine, n.Engine)
		}
		if c.Goal != "ask_user" && !gt.goalIDs[c.Goal] {
			t.Errorf("%s: %q is not a goal run_goal offers", c.ID, c.Goal)
		}
		if c.EngineOverride != "" && c.EngineOverride != "ode" && c.EngineOverride != "sde" {
			t.Errorf("%s: engine_override %q", c.ID, c.EngineOverride)
		}
		var info struct {
			Places      []struct{ ID string } `json:"places"`
			Transitions []struct{ ID string } `json:"transitions"`
		}
		json.Unmarshal(n.Info, &info)
		ids := map[string]bool{}
		for _, p := range info.Places {
			ids[p.ID] = true
		}
		for _, p := range info.Transitions {
			ids[p.ID] = true
		}
		for _, k := range []string{"observable", "place", "transition"} {
			if v, ok := c.Inputs[k].(string); ok && !ids[v] {
				t.Errorf("%s: %s=%q is not an id of net %s", c.ID, k, v, c.Net)
			}
		}
	}
	for id := range gt.goalIDs {
		if per[id] < 3 || per[id] > 4 {
			t.Errorf("goal %s has %d cases, want 3 to 4", id, per[id])
		}
	}
	if per["ask_user"] != 6 || len(f.Cases) < 40 {
		t.Errorf("%d ambiguous cases of %d", per["ask_user"], len(f.Cases))
	}
}

func TestScoreGoalCase(t *testing.T) {
	knob := goalEvalCase{ID: "k", Goal: "knob", Inputs: map[string]any{"observable": "served"}}
	play := goalEvalCase{ID: "p", Goal: "best_play", Inputs: map[string]any{"sides": map[string]any{"x_": 1, "o_": -1}, "reward": map[string]any{"win_x": 1}}}
	override := goalEvalCase{ID: "o", Goal: "average", EngineOverride: "ode"}
	mark := goalEvalCase{ID: "m", Goal: "can_happen", Inputs: map[string]any{"to": map[string]any{"R": 1000}}}
	ask := goalEvalCase{ID: "a", Goal: "ask_user"}
	call := func(name string, args map[string]any) []turnCall { return []turnCall{{Name: name, Args: args}} }
	cases := []struct {
		name               string
		c                  goalEvalCase
		calls              []turnCall
		goal, inputs, over bool
	}{
		{"right goal and inputs", knob, call("run_goal", map[string]any{"goal_id": "knob", "inputs": `{"observable":"served"}`}), true, true, true},
		{"inputs as an object", knob, call("run_goal", map[string]any{"goal_id": "knob", "inputs": map[string]any{"observable": "served"}}), true, true, true},
		{"extra inputs are tolerated", knob, call("run_goal", map[string]any{"goal_id": "knob", "inputs": `{"observable":"served","x":1}`}), true, true, true},
		{"wrong place", knob, call("run_goal", map[string]any{"goal_id": "knob", "inputs": `{"observable":"Served"}`}), true, false, true},
		{"no inputs", knob, call("run_goal", map[string]any{"goal_id": "knob"}), true, false, true},
		{"wrong goal", knob, call("run_goal", map[string]any{"goal_id": "risk"}), false, false, true},
		{"json inputs as text", play, call("run_goal", map[string]any{"goal_id": "best_play", "inputs": `{"sides":"{\"x_\": 1, \"o_\": -1}","reward":{"win_x":1.0}}`}), true, true, true},
		{"marking numbers by value", mark, call("run_goal", map[string]any{"goal_id": "can_happen", "inputs": `{"to":{"R":1000.0}}`}), true, true, true},
		{"override named", override, call("run_goal", map[string]any{"goal_id": "average", "engine_override": "ode"}), true, true, true},
		{"override missing", override, call("run_goal", map[string]any{"goal_id": "average"}), true, true, false},
		{"override not asked for", knob, call("run_goal", map[string]any{"goal_id": "knob", "inputs": `{"observable":"served"}`, "engine_override": "ode"}), true, true, false},
		{"first call is not a goal", knob, call("net_info", nil), false, false, false},
		{"no call", knob, nil, false, false, false},
		{"asked when due", ask, call("ask_user", map[string]any{"question": "?"}), true, true, true},
		{"guessed when an ask was due", ask, call("run_goal", map[string]any{"goal_id": "knob"}), false, true, true},
		{"asked when a goal was due", knob, call("ask_user", nil), false, false, false},
		{"only the first call counts", knob, append(call("net_info", nil), turnCall{Name: "run_goal", Args: map[string]any{"goal_id": "knob"}}), false, false, false},
	}
	for _, tc := range cases {
		r := scoreGoalCase(tc.c, tc.calls)
		if r.GoalOK != tc.goal || r.InputsOK != tc.inputs || r.OverrideOK != tc.over {
			t.Errorf("%s: goal %v inputs %v override %v, want %v %v %v (%s)", tc.name, r.GoalOK, r.InputsOK, r.OverrideOK, tc.goal, tc.inputs, tc.over, r.Detail)
		}
	}
}

// goalOracle is a scripted model: it answers each case the way the case says a
// model should, as a real one would (inputs as JSON in a string). With
// flawless false it picks the stuck goal for everything.
type goalOracle struct {
	byText   map[string]goalEvalCase
	flawless bool
	t        testing.TB
	requests int
}

func (o *goalOracle) Model() string { return "oracle" }
func (o *goalOracle) Complete(_ context.Context, req llm.Request) (*llm.Response, error) {
	o.requests++
	if req.ResponseSchema != nil {
		o.t.Error("a goals turn in analyse mode made a classifier call")
	}
	if len(req.Tools) >= 30 || len(req.Tools) < 15 {
		o.t.Errorf("%d tools declared", len(req.Tools))
	}
	last := req.Messages[len(req.Messages)-1].Parts[0].Text
	c, ok := o.byText[last]
	if !ok {
		o.t.Errorf("unknown question %q", last)
		return &llm.Response{Parts: []llm.Part{{Text: "?"}}}, nil
	}
	lead := req.Messages[0].Parts[0].Text
	if !strings.Contains(lead, "Mode: analyse") || !strings.Contains(lead, "Never choose the engine") || !strings.Contains(lead, `"places"`) {
		o.t.Errorf("%s: the lead lacks the mode, the rules or the net", c.ID)
	}
	call := llm.FunctionCall{Name: "run_goal", Args: map[string]any{"goal_id": "stuck"}}
	switch {
	case !o.flawless:
	case c.Goal == "ask_user":
		call = llm.FunctionCall{Name: "ask_user", Args: map[string]any{"question": "Which one do you mean?", "options": []any{"a", "b"}}}
	default:
		call.Args = map[string]any{"goal_id": c.Goal}
		if len(c.Inputs) > 0 {
			raw, _ := json.Marshal(c.Inputs)
			call.Args["inputs"] = string(raw)
		}
		if c.EngineOverride != "" {
			call.Args["engine_override"] = c.EngineOverride
		}
	}
	return &llm.Response{Calls: []llm.FunctionCall{call}, Parts: []llm.Part{{FunctionCall: &call}}, Model: "oracle", InputTokens: 3000, OutputTokens: 40}, nil
}

func TestGoalEvalHarnessWithAScriptedModel(t *testing.T) {
	f := loadGoalEvalFile(t)
	by := map[string]goalEvalCase{}
	for _, c := range f.Cases {
		by[c.Text] = c
	}
	oracle := &goalOracle{byText: by, flawless: true, t: t}
	s := goalEvalServer(t, oracle, "")
	results := runGoalEval(t, s, f)
	if acc := goalEvalSummary(t, results); acc != 1 {
		t.Fatalf("a flawless scripted model scored %.3f", acc)
	}
	for _, r := range results {
		if !r.strict() {
			t.Errorf("%s: %+v", r.Case.ID, r)
		}
	}
	if oracle.requests != len(f.Cases) {
		t.Fatalf("%d model calls for %d cases", oracle.requests, len(f.Cases))
	}
	// cost per goal: one call per case, charged to its goal, the six asks to none
	total, perGoal := 0, map[string]int{}
	for k, v := range s.llm.goalStats.Counts() {
		total += v.Count
		perGoal[k[strings.Index(k, "|")+1:]] += v.Count
		if v.In != 3000*v.Count || v.Out != 40*v.Count {
			t.Errorf("%s: %+v", k, v)
		}
	}
	if total != len(f.Cases) || perGoal["none"] != 6 || perGoal["knob"] != 4 || perGoal["stuck"] != 4 {
		t.Fatalf("%d counted: %v", total, perGoal)
	}

	// a model that picks one goal for everything is seen to be wrong
	bad := goalEvalServer(t, &goalOracle{byText: by, t: t}, "")
	badResults := runGoalEval(t, bad, f)
	acc := goalEvalSummary(t, badResults)
	if acc >= 0.2 || acc == 0 {
		t.Fatalf("the always-stuck model scored %.3f, want only stuck's 4 of %d", acc, len(f.Cases))
	}
}

// The harness selects the goal model like the server does: only the goal model
// answers, for goal turns in analyse mode.
func TestGoalEvalUsesTheGoalModelWhenAsked(t *testing.T) {
	f := loadGoalEvalFile(t)
	f.Cases = f.Cases[:2]
	c := &modelRecorder{}
	s := goalEvalServer(t, c, "cheap-model")
	runGoalEval(t, s, f)
	if len(c.models) != 2 || c.models[0] != "cheap-model" || c.models[1] != "cheap-model" {
		t.Fatalf("%v", c.models)
	}
	c = &modelRecorder{}
	runGoalEval(t, goalEvalServer(t, c, ""), f)
	if c.models[0] != "" {
		t.Fatalf("no goal model means the client's own: %v", c.models)
	}
}

type modelRecorder struct{ models []string }

func (m *modelRecorder) Model() string { return "main" }
func (m *modelRecorder) Complete(_ context.Context, req llm.Request) (*llm.Response, error) {
	m.models = append(m.models, req.Model)
	return &llm.Response{Text: "ok", Parts: []llm.Part{{Text: "ok"}}}, nil
}
