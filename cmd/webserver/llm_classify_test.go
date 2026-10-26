package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

// autoClient answers the classifier (recognised by its system prompt) with
// label, and every other call with a plain reply.
type autoClient struct {
	label    string
	labelErr error
	models   []string
	lastTurn llm.Request
}

func (c *autoClient) Model() string { return "stub" }
func (c *autoClient) Complete(_ context.Context, req llm.Request) (*llm.Response, error) {
	if req.System == classifyPromptV1 {
		c.models = append(c.models, req.Model)
		if c.labelErr != nil {
			return nil, c.labelErr
		}
		return &llm.Response{Text: c.label}, nil
	}
	c.lastTurn = req
	return &llm.Response{Text: "ok", Parts: []llm.Part{{Text: "ok"}}}, nil
}

const autoTurn = `{"mode":"auto","prev_mode":"analyse","net":{},"messages":[{"role":"user","parts":[{"text":"add a queue place"}]}]}`

func autoResult(t *testing.T, c *autoClient, body string) (map[string]any, *Server) {
	t.Helper()
	s := turnServer(t, &turnClient{})
	s.llm.client = c
	s.llm.classifyModel = "lite"
	rec := do(t, s, "POST", "/api/llm/turn", "good", body)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return out, s
}

func TestLLMAutoPicksModeAndReportsSentiment(t *testing.T) {
	c := &autoClient{label: `{"intent":"build","sentiment":"frustrated","confidence":0.9}`}
	out, s := autoResult(t, c, autoTurn)
	if out["mode"] != "build" {
		t.Fatalf("mode %v", out["mode"])
	}
	a := out["auto"].(map[string]any)
	if a["sentiment"] != "frustrated" || a["mode"] != "build" {
		t.Fatalf("auto %v", a)
	}
	if !strings.Contains(c.lastTurn.Messages[0].Parts[0].Text, "Mode: build") {
		t.Fatal("the turn did not run in the chosen mode")
	}
	if len(c.models) != 1 || c.models[0] != "lite" {
		t.Fatalf("classifier model %v", c.models)
	}
	if left, _ := s.llm.limiter.Remaining("42"); left != llm.DefaultLimits.Daily-1 {
		t.Fatalf("auto must cost one unit, %d left", left)
	}
}

func TestLLMAutoFallsBack(t *testing.T) {
	for name, c := range map[string]*autoClient{
		"upstream error": {labelErr: errors.New("down")},
		"not json":       {label: "build"},
		"bad intent":     {label: `{"intent":"delete","sentiment":"neutral","confidence":1}`},
		"unsure":         {label: `{"intent":"build","sentiment":"confused","confidence":0.2}`},
	} {
		out, _ := autoResult(t, c, autoTurn)
		a := out["auto"].(map[string]any)
		if out["mode"] != "analyse" || a["fallback"] != true {
			t.Errorf("%s: mode %v auto %v (want the previous mode, analyse)", name, out["mode"], a)
		}
	}
}

func TestLLMAutoValidation(t *testing.T) {
	s := turnServer(t, &turnClient{})
	for _, b := range []string{
		// tool results only: nothing to label
		`{"mode":"auto","messages":[{"role":"user","parts":[{"functionResponse":{"name":"net_info","response":{}}}]}]}`,
		`{"mode":"build","prev_mode":"explain","messages":[{"role":"user","parts":[{"text":"x"}]}]}`,
	} {
		if rec := do(t, s, "POST", "/api/llm/turn", "good", b); rec.Code != 400 {
			t.Errorf("%s: %d", b, rec.Code)
		}
	}
}

func TestLLMAutoDropsStepOutsideBuild(t *testing.T) {
	c := &autoClient{label: `{"intent":"explain","sentiment":"neutral","confidence":0.8}`}
	autoResult(t, c, strings.Replace(autoTurn, `"net"`, `"step":"rates","net"`, 1))
	if strings.Contains(c.lastTurn.Messages[0].Parts[0].Text, "Interview step") {
		t.Fatal("interview step leaked into a non-build turn")
	}
}
