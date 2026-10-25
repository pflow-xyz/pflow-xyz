package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

type turnClient struct {
	resp *llm.Response
	last llm.Request
}

func (c *turnClient) Model() string { return "stub" }
func (c *turnClient) Complete(_ context.Context, req llm.Request) (*llm.Response, error) {
	c.last = req
	return c.resp, nil
}

const testManifest = `{"version":"tools-v1","tools":[
 {"name":"net_info","command":"net.info","description":"Net info."},
 {"name":"sim_ode","command":"sim.ode","description":"Run ODE.","parameters":{"type":"object","properties":{"t_end":{"type":"number"}}}}]}`

func turnServer(t *testing.T, c *turnClient) *Server {
	t.Helper()
	lim, err := llm.NewLimiter(llm.DefaultLimits, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{publicFS: fstest.MapFS{"llm-tools.json": {Data: []byte(testManifest)}}}
	m, decls, names, err := loadToolManifest(s.publicFS)
	if err != nil {
		t.Fatal(err)
	}
	s.llm = &llmService{client: c, limiter: lim, verifier: stubVerifier{}, tools: names, toolDecls: decls, toolsVersion: m.Version}
	return s
}

const userTurn = `{"mode":"analyse","net":{"places":[{"id":"queue"}]},"messages":[{"role":"user","parts":[{"text":"is it deadlock free?"}]}]}`

func TestLLMTurnDeclaresToolsAndFiltersCalls(t *testing.T) {
	c := &turnClient{resp: &llm.Response{
		Text: "Let me check.",
		Calls: []llm.FunctionCall{
			{Name: "sim_ode", Args: map[string]any{"t_end": 5.0}},
			{Name: "rm_rf", Args: map[string]any{}},
		},
		Parts: []llm.Part{{Text: "Let me check.", ThoughtSignature: "sig=="}, {FunctionCall: &llm.FunctionCall{Name: "sim_ode"}}},
	}}
	s := turnServer(t, c)
	rec := do(t, s, "POST", "/api/llm/turn", "good", userTurn)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Message   llm.Message                     `json:"message"`
		Calls     []struct{ Name string }         `json:"tool_calls"`
		Refused   []struct{ Name, Reason string } `json:"refused"`
		Remaining int                             `json:"remaining_today"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Calls) != 1 || out.Calls[0].Name != "sim_ode" || len(out.Refused) != 1 || out.Refused[0].Name != "rm_rf" {
		t.Fatalf("calls %+v refused %+v", out.Calls, out.Refused)
	}
	if out.Message.Parts[0].ThoughtSignature != "sig==" {
		t.Fatal("the thought signature must come back verbatim")
	}
	if len(c.last.Tools) != 2 || c.last.System != turnPromptV1 {
		t.Fatalf("request tools %d", len(c.last.Tools))
	}
	lead := c.last.Messages[0]
	if lead.Role != "user" || !strings.Contains(lead.Parts[0].Text, "Mode: analyse") || !strings.Contains(lead.Parts[0].Text, `"queue"`) {
		t.Fatalf("mode and net must travel as the first user message: %+v", lead)
	}
	if strings.Contains(c.last.System, "queue") {
		t.Fatal("net content reached the system prompt")
	}
	if out.Remaining != llm.DefaultLimits.Daily-1 {
		t.Fatalf("a turn costs one unit: %d left", out.Remaining)
	}
}

func TestLLMTurnCapsCallsPerReply(t *testing.T) {
	calls := make([]llm.FunctionCall, 11)
	for i := range calls {
		calls[i] = llm.FunctionCall{Name: "net_info"}
	}
	s := turnServer(t, &turnClient{resp: &llm.Response{Calls: calls, Parts: []llm.Part{{Text: "x"}}}})
	rec := do(t, s, "POST", "/api/llm/turn", "good", userTurn)
	var out struct {
		Calls   []any `json:"tool_calls"`
		Refused []any `json:"refused"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if len(out.Calls) != maxCallsPerReply || len(out.Refused) != 11-maxCallsPerReply {
		t.Fatalf("%d accepted, %d refused", len(out.Calls), len(out.Refused))
	}
}

func TestLLMTurnValidation(t *testing.T) {
	s := turnServer(t, &turnClient{resp: &llm.Response{Text: "ok", Parts: []llm.Part{{Text: "ok"}}}})
	bad := []string{
		`{"mode":"chat","messages":[{"role":"user","parts":[{"text":"x"}]}]}`,
		`{"mode":"build","messages":[]}`,
		`{"mode":"build","messages":[{"role":"system","parts":[{"text":"x"}]}]}`,
		`{"mode":"build","messages":[{"role":"user","parts":[{}]}]}`,
		`{"mode":"build","messages":[{"role":"user","parts":[{"text":"x"}]},{"role":"model","parts":[{"text":"y"}]}]}`,
		`{"mode":"build","messages":[{"role":"user","parts":[{"text":"x"}]}],"extra":1}`,
	}
	for _, b := range bad {
		if rec := do(t, s, "POST", "/api/llm/turn", "good", b); rec.Code != 400 {
			t.Errorf("%s: %d", b, rec.Code)
		}
	}
	if rec := do(t, s, "POST", "/api/llm/turn", "", userTurn); rec.Code != 401 {
		t.Fatalf("signed out: %d", rec.Code)
	}
	if left, _ := s.llm.limiter.Remaining("42"); left != llm.DefaultLimits.Daily {
		t.Fatal("refused turns were charged")
	}
}

func TestLLMTurnWithoutManifestIsOff(t *testing.T) {
	s := turnServer(t, &turnClient{})
	s.llm.tools = nil
	if rec := do(t, s, "POST", "/api/llm/turn", "good", userTurn); rec.Code != 503 {
		t.Fatalf("%d", rec.Code)
	}
	var st map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/llm/status", "", "").Body.Bytes(), &st)
	if st["chat"] != false {
		t.Fatalf("status %v", st)
	}
}
