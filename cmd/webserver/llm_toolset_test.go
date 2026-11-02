package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

// The goals toolset of /api/llm/turn (llm_goal_tools.go): what it declares,
// what it refuses, what its first user message says, which model answers it
// and what it costs per goal. The "all" toolset's behaviour is the other
// llm_turn tests'; here only that it did not change.

// goalServer is turnServer with the goals toolset loaded from the real
// public/llm-goal-tools.json and goals.json, the cost-per-goal stats on, and
// the models the test names.
func goalServer(t *testing.T, c *turnClient) *Server {
	t.Helper()
	s := turnServer(t, c)
	s.publicFS = os.DirFS("../../public")
	gt, err := loadGoalToolset(s.publicFS)
	if err != nil {
		t.Fatal(err)
	}
	s.llm.goalTools = gt
	stats, err := llm.NewGoalStats(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s.llm.goalStats = stats
	return s
}

func turnBody(toolset, mode, text string) string {
	b := map[string]any{"mode": mode, "net": map[string]any{"places": []map[string]string{{"id": "queue"}}},
		"messages": []any{map[string]any{"role": "user", "parts": []any{map[string]string{"text": text}}}}}
	if toolset != "" {
		b["toolset"] = toolset
	}
	raw, _ := json.Marshal(b)
	return string(raw)
}

func ok(text string, calls ...llm.FunctionCall) *llm.Response {
	parts := []llm.Part{{Text: text}}
	for i := range calls {
		parts = append(parts, llm.Part{FunctionCall: &calls[i]})
	}
	return &llm.Response{Text: text, Calls: calls, Parts: parts, Model: "stub", InputTokens: 1000, OutputTokens: 50, ThoughtTokens: 7}
}

type turnOut struct {
	Calls   []turnCall    `json:"tool_calls"`
	Refused []turnRefusal `json:"refused"`
	Tools   string        `json:"tools"`
	Model   string        `json:"model"`
	Mode    string        `json:"mode"`
	Error   string        `json:"error"`
}

func post(t *testing.T, s *Server, body string) (int, turnOut, map[string]json.RawMessage) {
	t.Helper()
	rec := do(t, s, "POST", "/api/llm/turn", "good", body)
	var out turnOut
	json.Unmarshal(rec.Body.Bytes(), &out)
	var keys map[string]json.RawMessage
	json.Unmarshal(rec.Body.Bytes(), &keys)
	return rec.Code, out, keys
}

func TestToolsetIsValidated(t *testing.T) {
	c := &turnClient{resp: ok("fine")}
	s := goalServer(t, c)
	for _, ts := range []string{"", "all", "goals"} {
		if code, out, _ := post(t, s, turnBody(ts, "analyse", "hi")); code != 200 {
			t.Errorf("toolset %q: %d %v", ts, code, out)
		}
	}
	for _, bad := range []string{"ALL", "goal", " goals", "none", "goals,all", "classic"} {
		code, out, _ := post(t, s, turnBody(bad, "analyse", "hi"))
		if code != 400 || out.Error != "toolset must be all or goals" {
			t.Errorf("toolset %q: %d %q", bad, code, out.Error)
		}
	}
	if code, _, _ := post(t, s, `{"mode":"analyse","toolset":7,"messages":[{"role":"user","parts":[{"text":"x"}]}]}`); code != 400 {
		t.Errorf("a number toolset: %d", code)
	}
	if left, _ := s.llm.limiter.Remaining("42"); left != llm.DefaultLimits.Daily-3 {
		t.Fatalf("only the three good turns are charged: %d left", left)
	}
}

func TestGoalsToolsetDeclaresExactlyTheGoalTools(t *testing.T) {
	c := &turnClient{resp: ok("fine")}
	s := goalServer(t, c)
	code, out, _ := post(t, s, turnBody("goals", "analyse", "is it deadlock free?"))
	if code != 200 {
		t.Fatalf("%d", code)
	}
	raw, _ := os.ReadFile("../../public/llm-goal-tools.json")
	var m struct {
		Version string `json:"version"`
		Tools   []struct{ Name string }
	}
	json.Unmarshal(raw, &m)
	var got []string
	for _, d := range c.last.Tools {
		got = append(got, d.Name)
	}
	var want []string
	for _, tl := range m.Tools {
		want = append(want, tl.Name)
	}
	if strings.Join(got, ",") != strings.Join(want, ",") || len(got) >= 30 {
		t.Fatalf("declared %v, want the goal manifest's %v", got, want)
	}
	for _, name := range []string{"run_goal", "ask_user", "command_schema", "run_command", "open_view", "net_info", "analysis_check", "edit_undo"} {
		if !s.llm.goalTools.names[name] {
			t.Errorf("%s is not a goal tool", name)
		}
	}
	for _, name := range got {
		if name == "sim_ode" || name == "analysis_verify" {
			t.Errorf("%s is a command of the full manifest, not a goal tool", name)
		}
	}
	if out.Tools != m.Version || out.Tools != "goal-tools-v1" {
		t.Errorf("tools version %q, want the goal manifest's %q", out.Tools, m.Version)
	}
	if c.last.System != turnPromptV1 || strings.Contains(c.last.System, "run_goal") {
		t.Error("the goal rules are user content, not the system prompt")
	}
}

func TestGoalsToolsetRefusesCallsOutsideItAndBadArguments(t *testing.T) {
	calls := []llm.FunctionCall{
		{Name: "sim_ode", Args: map[string]any{"t_end": 5.0}}, // a command of the full manifest
		{Name: "rm_rf"}, // nothing
		{Name: "run_goal", Args: map[string]any{"goal_id": "knob_typo"}},                      // not a goal
		{Name: "run_goal", Args: map[string]any{"goal_id": "data_match"}},                     // a goal that is not available
		{Name: "run_goal", Args: map[string]any{"goal_id": "risk", "engine_override": "ssa"}}, // not an override
		{Name: "run_goal"}, // no goal
		{Name: "ask_user", Args: map[string]any{"question": "Which?", "options": []any{"only one"}}},              // one option
		{Name: "ask_user", Args: map[string]any{"question": "Which?", "options": []any{"a", "b", "c", "d", "e"}}}, // five
		{Name: "open_view", Args: map[string]any{"view": "settings"}},
		{Name: "run_goal", Args: map[string]any{"goal_id": "knob", "inputs": `{"observable":"I"}`, "engine_override": "ode"}},
		{Name: "ask_user", Args: map[string]any{"question": "Which place?", "options": []any{"S", "I"}, "default_option": "I"}},
		{Name: "command_schema", Args: map[string]any{"id": "sim.ode"}},
		{Name: "run_command", Args: map[string]any{"id": "sim.ode", "args": `{"t_end": 5}`}},
		{Name: "open_view", Args: map[string]any{"view": "structure"}},
		{Name: "net_info"},
	}
	s := goalServer(t, &turnClient{})
	// a reply may make 8 calls, so go through them in two replies
	s.llm.client = &turnClient{resp: ok("x", calls[:9]...)}
	_, out, _ := post(t, s, turnBody("goals", "analyse", "hi"))
	if len(out.Calls) != 0 || len(out.Refused) != 9 {
		t.Fatalf("accepted %+v refused %+v", out.Calls, out.Refused)
	}
	if !strings.Contains(out.Refused[0].Reason, "run_command") || out.Refused[1].Reason == "" {
		t.Errorf("a command outside the toolset points at run_command: %q", out.Refused[0].Reason)
	}
	if !strings.Contains(out.Refused[2].Reason, "goal_id must be one of") || !strings.Contains(out.Refused[2].Reason, "stuck") {
		t.Errorf("a typo'd goal lists the goals: %q", out.Refused[2].Reason)
	}
	if !strings.Contains(out.Refused[3].Reason, "goal_id must be one of") || strings.Contains(out.Refused[3].Reason, "data_match") {
		t.Errorf("an unavailable goal is not offered: %q", out.Refused[3].Reason)
	}
	if out.Refused[4].Reason != "engine_override must be one of ode, sde" || out.Refused[5].Reason != "missing goal_id" {
		t.Errorf("%q / %q", out.Refused[4].Reason, out.Refused[5].Reason)
	}
	if out.Refused[6].Reason != "options must be 2 to 4 choices" || out.Refused[7].Reason != "options must be 2 to 4 choices" {
		t.Errorf("%q / %q", out.Refused[6].Reason, out.Refused[7].Reason)
	}

	s.llm.client = &turnClient{resp: ok("x", calls[9:]...)}
	_, out, _ = post(t, s, turnBody("goals", "analyse", "hi"))
	names := []string{}
	for _, c := range out.Calls {
		names = append(names, c.Name)
	}
	if len(out.Refused) != 0 || strings.Join(names, ",") != "run_goal,ask_user,command_schema,run_command,open_view,net_info" {
		t.Fatalf("accepted %v refused %+v", names, out.Refused)
	}
	if out.Calls[0].Args["goal_id"] != "knob" || out.Calls[0].Args["engine_override"] != "ode" {
		t.Errorf("arguments travel as the model made them: %v", out.Calls[0].Args)
	}

	// the same names on the default toolset: run_goal is not a tool of the editor there
	s.llm.client = &turnClient{resp: ok("x", llm.FunctionCall{Name: "run_goal", Args: map[string]any{"goal_id": "risk"}}, llm.FunctionCall{Name: "sim_ode"})}
	_, out, _ = post(t, s, turnBody("", "analyse", "hi"))
	if len(out.Calls) != 1 || out.Calls[0].Name != "sim_ode" || len(out.Refused) != 1 || out.Refused[0].Reason != "not a tool of this editor" {
		t.Fatalf("all: accepted %+v refused %+v", out.Calls, out.Refused)
	}
}

// The default toolset is today's behaviour: asking for "all" is asking for nothing.
func TestAllToolsetIsUnchanged(t *testing.T) {
	run := func(toolset string) (llm.Request, turnOut, map[string]json.RawMessage) {
		c := &turnClient{resp: ok("fine", llm.FunctionCall{Name: "sim_ode"})}
		s := goalServer(t, c)
		s.llm.modeExtra = map[string]string{"analyse": "Goal catalog. long plans here"}
		s.llm.goalModel = "cheap-model"
		_, out, keys := post(t, s, turnBody(toolset, "analyse", "hi"))
		return c.last, out, keys
	}
	a, outA, keysA := run("")
	b, outB, keysB := run("all")
	if len(a.Tools) != 2 || a.Model != "" || !strings.Contains(a.Messages[0].Parts[0].Text, "Goal catalog. long plans here") {
		t.Fatalf("default: %d tools, model %q, lead %q", len(a.Tools), a.Model, a.Messages[0].Parts[0].Text)
	}
	if strings.Contains(a.Messages[0].Parts[0].Text, "run_goal") || outA.Tools != "tools-v1" {
		t.Fatal("the default toolset got goal guidance")
	}
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Fatalf("toolset all differs from the default:\n%s\n%s", ja, jb)
	}
	if len(keysA) != len(keysB) || len(outA.Calls) != 1 || len(outB.Calls) != 1 {
		t.Fatal("the response differs")
	}
	// and the goals toolset answers in the same shape
	_, outG, keysG := func() (int, turnOut, map[string]json.RawMessage) {
		s := goalServer(t, &turnClient{resp: ok("fine")})
		return post(t, s, turnBody("goals", "analyse", "hi"))
	}()
	for k := range keysA {
		if _, found := keysG[k]; !found {
			t.Errorf("the goals response lacks %q", k)
		}
	}
	for k := range keysG {
		if _, found := keysA[k]; !found {
			t.Errorf("the goals response adds %q", k)
		}
	}
	_ = outG
}

func TestGoalsLeadHasTheBriefCatalogTheRulesAndTheIndex(t *testing.T) {
	c := &turnClient{resp: ok("fine")}
	s := goalServer(t, c)
	s.llm.modeExtra = map[string]string{"analyse": "Goal catalog. long plans here"}
	for _, mode := range []string{"analyse", "explain", "build"} {
		post(t, s, turnBody("goals", mode, "hi"))
		lead := c.last.Messages[0].Parts[0].Text
		if c.last.Messages[0].Role != "user" || !strings.HasPrefix(lead, modeGuidance[mode]) {
			t.Fatalf("%s: the mode guidance comes first, as user content", mode)
		}
		for _, want := range []string{
			"Never choose the engine, horizon, seed or number of runs",
			"ask_user", "at most once per turn", "plausible but misleading",
			"I took the outcome to be the peak of I",
			"no standard goal matched; I composed this",
			"Quote numbers only from results",
			"command id with a dot",
			"- stuck: \"Can it get stuck?\"",
			"- knob: \"Which knob matters?\" inputs: observable (place, optional)",
			"- best_play:", "[example: {\"x_\": 1, \"o_\": -1}]",
			"data_match", "NOT available",
			"sim.ode: ", "compose.fuse: ", "command_schema",
			`The net now (net_info):`, `"queue"`,
		} {
			if !strings.Contains(lead, want) {
				t.Errorf("%s: the lead lacks %q", mode, want)
			}
		}
		// the brief names no plan steps and no caveats, and replaces the long catalog
		for _, not := range []string{"Goal catalog", "long plans here", "analysis.verify {", "plan:", "Caveat", "$step0", "$input."} {
			if strings.Contains(lead, not) {
				t.Errorf("%s: the lead has %q", mode, not)
			}
		}
		// the direct tools are not in the index (they are declared)
		for _, line := range strings.Split(lead, "\n") {
			for _, direct := range []string{"net.info:", "net.add_place:", "edit.undo:", "sim.set_rate:"} {
				if strings.HasPrefix(line, direct) {
					t.Errorf("%s: %q is declared, so it is not in the index", mode, line)
				}
			}
		}
	}
}

func TestGoalCatalogBriefFromTheShippedGoals(t *testing.T) {
	text, ids, err := goalCatalogBrief(os.DirFS("../../public"))
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) < 10 || strings.Contains(text, "->") || strings.Contains(text, "→") {
		t.Fatalf("%d goals; brief:\n%s", len(ids), text)
	}
	for _, id := range ids {
		if id == "data_match" {
			t.Error("an unavailable goal is not a goal id")
		}
	}
	long, _, _ := goalCatalogText(os.DirFS("../../public"))
	if len(text) > len(long)/2 {
		t.Errorf("the brief is %d bytes, the long catalog %d: it should be well under half", len(text), len(long))
	}
	// an input's parenthetical (the picker's notes) is cut; its default and optionality are said
	fs := fstest.MapFS{"goals.json": {Data: []byte(`{"goals":[{"id":"g","question":"Q?","inputs":[
	  {"name":"a","kind":"number","label":"a number (blank = ten)","default":2},
	  {"name":"b","kind":"place","label":"a place","optional":true},
	  {"name":"c","kind":"json","label":"rules (see docs)","example":"{\"k\": 1}"}],"plan":[{"command":"sim.ode"}]}]}`)}}
	got, _, err := goalCatalogBrief(fs)
	want := `- g: "Q?" inputs: a (number, default 2) = a number; b (place, optional) = a place; c (json) = rules [example: {"k": 1}]`
	if err != nil || !strings.HasSuffix(got, want) {
		t.Fatalf("%v\n%s\nwant suffix\n%s", err, got, want)
	}
}

func TestGoalModelOnlyForGoalTurnsInAnalyseAndExplain(t *testing.T) {
	cases := []struct {
		toolset, mode, goalModel, want string
	}{
		{"goals", "analyse", "cheap", "cheap"},
		{"goals", "explain", "cheap", "cheap"},
		{"goals", "build", "cheap", ""},
		{"", "analyse", "cheap", ""},
		{"all", "explain", "cheap", ""},
		{"goals", "analyse", "", ""},
	}
	for _, tc := range cases {
		c := &turnClient{resp: ok("fine")}
		s := goalServer(t, c)
		s.llm.goalModel = tc.goalModel
		if code, _, _ := post(t, s, turnBody(tc.toolset, tc.mode, "hi")); code != 200 {
			t.Fatalf("%+v: %d", tc, code)
		}
		if c.last.Model != tc.want {
			t.Errorf("toolset %q mode %s goal model %q: request model %q, want %q", tc.toolset, tc.mode, tc.goalModel, c.last.Model, tc.want)
		}
	}
}

// Auto labels the message first; the goal model is chosen by the mode it picked.
func TestGoalModelFollowsAutoModesLabel(t *testing.T) {
	for label, want := range map[string]string{"analyse": "cheap", "explain": "cheap", "build": ""} {
		c := &routedClient{labels: `{"intent":"` + label + `","sentiment":"neutral","confidence":0.9}`, turn: ok("fine")}
		s := goalServer(t, &turnClient{})
		s.llm.client = c
		s.llm.goalModel = "cheap"
		s.llm.classifyModel = "label-model"
		if code, out, _ := post(t, s, turnBody("goals", "auto", "hi")); code != 200 || out.Mode != label {
			t.Fatalf("%s: %d %+v", label, code, out)
		}
		if c.turnModel != want || c.labelModel != "label-model" {
			t.Errorf("label %s: the turn ran on %q (want %q), the label on %q", label, c.turnModel, want, c.labelModel)
		}
	}
}

// routedClient answers the classifier's call (it sends a response schema) and the turn's.
type routedClient struct {
	labels                string
	turn                  *llm.Response
	labelModel, turnModel string
}

func (c *routedClient) Model() string { return "main" }
func (c *routedClient) Complete(_ context.Context, req llm.Request) (*llm.Response, error) {
	if req.ResponseSchema != nil {
		c.labelModel = req.Model
		return &llm.Response{Text: c.labels}, nil
	}
	c.turnModel = req.Model
	return c.turn, nil
}

func TestGoalTurnsAreCountedPerGoalAnonymously(t *testing.T) {
	today := time.Now().UTC().Format("2006-01-02")
	stat := func(s *Server, goal string) llm.GoalCount { return s.llm.goalStats.Counts()[today+"|"+goal] }

	// a reply that runs a goal: charged to it, with the tokens the model call used
	s := goalServer(t, &turnClient{resp: ok("", llm.FunctionCall{Name: "run_goal", Args: map[string]any{"goal_id": "risk"}}, llm.FunctionCall{Name: "run_goal", Args: map[string]any{"goal_id": "stuck"}})})
	post(t, s, turnBody("goals", "analyse", "how bad can it get?"))
	if got, want := stat(s, "risk"), (llm.GoalCount{Count: 1, In: 1000, Out: 50, Thoughts: 7}); got != want {
		t.Fatalf("risk: %+v, want %+v (the first accepted run_goal)", got, want)
	}
	if stat(s, "stuck").Count != 0 || stat(s, "none").Count != 0 {
		t.Fatal("one call is one count, for its first goal")
	}

	// a reply with no goal call: none
	s = goalServer(t, &turnClient{resp: ok("Which place do you mean?", llm.FunctionCall{Name: "ask_user", Args: map[string]any{"question": "Which?", "options": []any{"a", "b"}}})})
	post(t, s, turnBody("goals", "analyse", "what if I had one more?"))
	if stat(s, "none").Count != 1 {
		t.Fatalf("%v", s.llm.goalStats.Counts())
	}

	// a refused run_goal is no goal: a typo cannot make a key
	s = goalServer(t, &turnClient{resp: ok("", llm.FunctionCall{Name: "run_goal", Args: map[string]any{"goal_id": "octocat@example.com"}})})
	post(t, s, turnBody("goals", "analyse", "x"))
	if c := s.llm.goalStats.Counts(); len(c) != 1 || c[today+"|none"].Count != 1 {
		t.Fatalf("%v", c)
	}

	// the call that reads a goal's result back belongs to the goal; a new question starts over
	ran := llm.Message{Role: "model", Parts: []llm.Part{{FunctionCall: &llm.FunctionCall{Name: "run_goal", Args: map[string]any{"goal_id": "knob"}}}}}
	result := llm.Message{Role: "user", Parts: []llm.Part{{FunctionResponse: &llm.FunctionResponse{Name: "run_goal", Response: map[string]any{"ok": true}}}}}
	asked := llm.Message{Role: "user", Parts: []llm.Part{{Text: "which knob matters?"}}}
	earlier := []llm.Message{{Role: "user", Parts: []llm.Part{{Text: "is it stuck?"}}}, {Role: "model", Parts: []llm.Part{{FunctionCall: &llm.FunctionCall{Name: "run_goal", Args: map[string]any{"goal_id": "stuck"}}}}}, result, {Role: "model", Parts: []llm.Part{{Text: "No."}}}}
	s = goalServer(t, &turnClient{resp: ok("The rate of recover matters most.")})
	msgs := append(append(append([]llm.Message{}, earlier...), asked, ran), result)
	raw, _ := json.Marshal(map[string]any{"mode": "analyse", "toolset": "goals", "messages": msgs})
	if rec := do(t, s, "POST", "/api/llm/turn", "good", string(raw)); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if stat(s, "knob").Count != 1 || stat(s, "stuck").Count != 0 || stat(s, "none").Count != 0 {
		t.Fatalf("the summary of knob's result is knob's cost, not stuck's: %v", s.llm.goalStats.Counts())
	}
	msgs = append(append([]llm.Message{}, earlier...), llm.Message{Role: "user", Parts: []llm.Part{{Text: "thanks. and what is the capital of France?"}}})
	raw, _ = json.Marshal(map[string]any{"mode": "analyse", "toolset": "goals", "messages": msgs})
	do(t, s, "POST", "/api/llm/turn", "good", string(raw))
	if stat(s, "none").Count != 1 || stat(s, "stuck").Count != 0 {
		t.Fatalf("a new question is not the last one's goal: %v", s.llm.goalStats.Counts())
	}

	// the "all" toolset records nothing, and neither does a turn the model failed
	s = goalServer(t, &turnClient{resp: ok("", llm.FunctionCall{Name: "sim_ode"})})
	post(t, s, turnBody("", "analyse", "x"))
	post(t, s, turnBody("all", "analyse", "x"))
	if len(s.llm.goalStats.Counts()) != 0 {
		t.Fatalf("%v", s.llm.goalStats.Counts())
	}
	s = goalServer(t, &turnClient{})
	s.llm.client = &stubClient{err: llm.ErrUpstream}
	if code, _, _ := post(t, s, turnBody("goals", "analyse", "x")); code != 502 || len(s.llm.goalStats.Counts()) != 0 {
		t.Fatalf("a failed call completed no turn: %d %v", code, s.llm.goalStats.Counts())
	}

	// no key in the file that identifies a person or carries text
	s = goalServer(t, &turnClient{resp: ok("secret words", llm.FunctionCall{Name: "run_goal", Args: map[string]any{"goal_id": "stuck"}})})
	dir := t.TempDir()
	s.llm.goalStats, _ = llm.NewGoalStats(dir)
	post(t, s, turnBody("goals", "analyse", "my private question about Octo"))
	file, _ := os.ReadFile(dir + "/goal-stats.json")
	for _, leak := range []string{"Octo", "private", "secret", "42", "gh_id"} {
		if strings.Contains(string(file), leak) {
			t.Errorf("goal-stats.json has %q:\n%s", leak, file)
		}
	}
}

func TestGoalsToolsetUnavailableWithoutItsManifest(t *testing.T) {
	c := &turnClient{resp: ok("fine")}
	s := turnServer(t, c) // public/ has llm-tools.json only
	s.llm.goalTools = nil
	rec := do(t, s, "POST", "/api/llm/turn", "good", turnBody("goals", "analyse", "hi"))
	var out turnOut
	json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 400 || out.Error != "toolset goals is not available on this server" {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if c.last.Messages != nil {
		t.Fatal("the model was called")
	}
	if left, _ := s.llm.limiter.Remaining("42"); left != llm.DefaultLimits.Daily {
		t.Fatalf("a refusal was charged: %d left", left)
	}
	// the default toolset still works on that server, and the status says what is on offer
	if code, _, _ := post(t, s, turnBody("", "analyse", "hi")); code != 200 {
		t.Fatalf("all: %d", code)
	}
	var st map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/llm/status", "", "").Body.Bytes(), &st)
	if got, _ := json.Marshal(st["toolsets"]); string(got) != `["all"]` {
		t.Fatalf("status toolsets %s", got)
	}
	g := goalServer(t, &turnClient{})
	st = nil
	json.Unmarshal(do(t, g, "GET", "/api/llm/status", "", "").Body.Bytes(), &st)
	if got, _ := json.Marshal(st["toolsets"]); string(got) != `["all","goals"]` {
		t.Fatalf("status toolsets %s", got)
	}
}

// Under "all" a command is a tool of its own and the allowlist refuses by name
// what the editor must not run. Under "goals" the command id is an argument of
// run_command and command_schema, so the allowlist has to be the ids the
// manifest declares (the index and the direct tools' commands): the browser's
// refusal is the second layer, not the only one.
func TestGoalsToolsetRefusesCommandIDsItDoesNotDeclare(t *testing.T) {
	refusedIDs := []any{
		"store.license", "file.load_json", "model.save", "model.delete", "store.put", "file.save", // the person's library and store
		"../../etc/passwd", "nope", "", "sim.ode ", "SIM.ODE", "sim_ode", "net_add_place", "run_goal",
		12, 1.5, true, nil, []any{"sim.ode"}, map[string]any{"id": "sim.ode"},
	}
	s := goalServer(t, &turnClient{})
	gt := s.llm.goalTools
	for _, tool := range []string{"run_command", "command_schema"} {
		for _, id := range refusedIDs {
			if why := gt.problem(tool, map[string]any{"id": id, "args": `{}`}); why == "" || !strings.Contains(why, "id") {
				t.Errorf("%s id %#v: %q, want a refusal that names the id", tool, id, why)
			}
		}
	}

	// end to end, as the tool calls the interface would otherwise receive: the
	// long tail that "all" refused by name is refused as an argument too
	s.llm.client = &turnClient{resp: ok("x",
		llm.FunctionCall{Name: "run_command", Args: map[string]any{"id": "store.license"}},
		llm.FunctionCall{Name: "run_command", Args: map[string]any{"id": "file.load_json", "args": `{"json": "{}"}`}},
		llm.FunctionCall{Name: "run_command", Args: map[string]any{"id": "model.save"}},
		llm.FunctionCall{Name: "run_command", Args: map[string]any{"id": "../../etc/passwd"}},
		llm.FunctionCall{Name: "command_schema", Args: map[string]any{"id": "nope"}},
		llm.FunctionCall{Name: "command_schema", Args: map[string]any{"id": "store.license"}},
		llm.FunctionCall{Name: "run_command", Args: map[string]any{"id": 12.0}},
		llm.FunctionCall{Name: "run_command", Args: map[string]any{"id": "sim.ode", "args": `{"t_end": 5}`}},
	)}
	_, out, _ := post(t, s, turnBody("goals", "analyse", "hi"))
	if len(out.Calls) != 1 || out.Calls[0].Args["id"] != "sim.ode" || len(out.Refused) != 7 {
		t.Fatalf("accepted %+v refused %+v", out.Calls, out.Refused)
	}
	for _, r := range out.Refused {
		if !strings.Contains(r.Reason, "id") {
			t.Errorf("the model is told why: %+v", r)
		}
	}

	// what the model hears: the id it wrote, cut short, and the id it probably meant
	for id, want := range map[any]string{
		"sim_ode":                "did you mean sim.ode?",
		"net_add_place":          "did you mean net.add_place?",
		"store.license":          `"store.license" is not a command of the command index`,
		12:                       "a string such as sim.ode",
		strings.Repeat("x", 500): `"` + strings.Repeat("x", 64) + `"`,
	} {
		got := gt.problem("run_command", map[string]any{"id": id})
		if !strings.Contains(got, want) || len(got) > 250 {
			t.Errorf("id %v: %q, want %q", id, got, want)
		}
	}
	// a missing id is still the required-argument message
	if got := gt.problem("run_command", map[string]any{}); got != "missing id" {
		t.Errorf("%q", got)
	}

	// the ids the manifest declares are accepted by both tools: an index
	// command, a direct tool's command (also reachable through run_command),
	// and one the lead's own example names
	for _, id := range []string{"sim.ode", "compose.fuse", "file.new", "net.add_place", "net.info", "edit.undo", "view.fit", "game.move"} {
		for _, tool := range []string{"run_command", "command_schema"} {
			if got := gt.problem(tool, map[string]any{"id": id}); got != "" {
				t.Errorf("%s %s: %q", tool, id, got)
			}
		}
	}
	// other tools carry no command id of their own to check: an id there is not this allowlist's business
	if got := gt.problem("net_info", map[string]any{"id": "p1"}); got != "" {
		t.Errorf("net_info: %q", got)
	}
}

// The set run_command accepts is the set of commands "all" declares as tools,
// exactly: no command the editor does not already reach through its tools
// (the excluded and the session-writing ones), and none of them dropped.
func TestGoalsToolsetCommandIDsAreExactlyTheFullManifests(t *testing.T) {
	raw, err := os.ReadFile("../../public/llm-tools.json")
	if err != nil {
		t.Fatal(err)
	}
	var full struct {
		Tools []struct {
			Name    string `json:"name"`
			Command string `json:"command"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &full); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{}
	for _, tl := range full.Tools {
		want[tl.Command] = true
	}
	gt := goalServer(t, &turnClient{}).llm.goalTools
	for id := range gt.commands {
		if !want[id] {
			t.Errorf("run_command accepts %s, which the full manifest does not declare", id)
		}
	}
	for id := range want {
		if !gt.commands[id] {
			t.Errorf("run_command cannot reach %s, which the full manifest declares", id)
		}
	}
	for _, id := range []string{"store.license", "file.load_json", "model.save"} {
		if gt.commands[id] || want[id] {
			t.Errorf("%s is declared", id)
		}
	}
	if len(gt.commands) < 50 {
		t.Errorf("only %d commands", len(gt.commands))
	}
}

func TestLoadGoalToolsetIsStrictAboutItsFiles(t *testing.T) {
	good, _ := os.ReadFile("../../public/llm-goal-tools.json")
	goals, _ := os.ReadFile("../../public/goals.json")
	files := func(manifest string, goalsJSON []byte) fstest.MapFS {
		fs := fstest.MapFS{"goals.json": {Data: goalsJSON}}
		if manifest != "" {
			fs["llm-goal-tools.json"] = &fstest.MapFile{Data: []byte(manifest)}
		}
		return fs
	}
	if _, err := loadGoalToolset(files(string(good), goals)); err != nil {
		t.Fatalf("the shipped files: %v", err)
	}
	// the manifest with one goal taken out of run_goal's enum: goals.json still
	// advertises it in the brief, so the model would be told of a goal it cannot call
	var doc map[string]any
	if err := json.Unmarshal(good, &doc); err != nil {
		t.Fatal(err)
	}
	var kept []any
	for _, tl := range doc["tools"].([]any) {
		tool := tl.(map[string]any)
		if tool["name"] != "run_goal" {
			continue
		}
		enum := tool["parameters"].(map[string]any)["properties"].(map[string]any)["goal_id"].(map[string]any)
		for _, g := range enum["enum"].([]any) {
			if g != "stuck" {
				kept = append(kept, g)
			}
		}
		if len(kept) != len(enum["enum"].([]any))-1 {
			t.Fatal("stuck is not in the shipped enum")
		}
		enum["enum"] = kept
	}
	withoutStuck, _ := json.Marshal(doc)
	if _, err := loadGoalToolset(nil); err == nil {
		t.Error("no public filesystem")
	}
	for name, tc := range map[string]struct {
		manifest string
		goals    []byte
		want     string
	}{
		"missing manifest":       {"", goals, "file does not exist"},
		"not json":               {"{", goals, "llm-goal-tools.json"},
		"no goal catalog":        {string(good), []byte("nope"), "goal catalog"},
		"no pseudo-tools":        {`{"version":"x","tools":[{"name":"net_info","description":"d"}]}`, goals, "no run_goal tool"},
		"a goal not in goals":    {strings.Replace(string(good), `"stuck",`, `"stuck", "vanished",`, 1), goals, `"vanished"`},
		"a goal not in the enum": {string(withoutStuck), goals, `goals.json has the available goal "stuck"`},
		"twice":                  {strings.Replace(string(good), `"name": "ask_user"`, `"name": "run_goal"`, 1), goals, "twice"},
	} {
		if _, err := loadGoalToolset(files(tc.manifest, tc.goals)); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: %v, want an error with %q", name, err, tc.want)
		}
	}
}

// configureLLM wires the toolset from the environment's public files, and a
// server whose public/ lacks the manifest still runs the rest.
func TestConfigureLLMLoadsTheGoalToolsetAndTheGoalModel(t *testing.T) {
	env := map[string]string{"GEMINI_API_KEY": "k", "PFLOW_LLM_GOAL_MODEL": "  gemini-cheap  "}
	svc, err := newLLMService(func(k string) string { return env[k] }, t.TempDir())
	if err != nil || svc == nil {
		t.Fatalf("%v %v", svc, err)
	}
	if svc.goalModel != "gemini-cheap" || svc.goalStats == nil {
		t.Fatalf("goal model %q, stats %v", svc.goalModel, svc.goalStats)
	}
	delete(env, "PFLOW_LLM_GOAL_MODEL")
	svc, _ = newLLMService(func(k string) string { return env[k] }, t.TempDir())
	if svc.goalModel != "" {
		t.Fatalf("unset means the main model, got %q", svc.goalModel)
	}

	t.Setenv("GEMINI_API_KEY", "k")
	t.Setenv("PFLOW_LLM_GOAL_MODEL", "gemini-cheap")
	s := &Server{publicFS: os.DirFS("../../public")}
	s.configureLLM(t.TempDir())
	if s.llm == nil || s.llm.goalTools == nil || s.llm.tools == nil || s.llm.goalModel != "gemini-cheap" {
		t.Fatalf("%+v", s.llm)
	}
	s = &Server{publicFS: fstest.MapFS{"llm-tools.json": {Data: []byte(testManifest)}}}
	s.configureLLM(t.TempDir())
	if s.llm == nil || s.llm.tools == nil || s.llm.goalTools != nil {
		t.Fatalf("a public/ without llm-goal-tools.json keeps the chat and reports the goals toolset off: %+v", s.llm)
	}
}
