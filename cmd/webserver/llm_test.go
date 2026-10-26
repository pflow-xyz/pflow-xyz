package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/auth"
	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

type stubVerifier struct{ down bool }

func (v stubVerifier) Verify(_ context.Context, token string) (*auth.GitHubUserInfo, error) {
	if v.down {
		return nil, auth.ErrVerifierUnavailable
	}
	switch token {
	case "good":
		return &auth.GitHubUserInfo{ID: "42", UserName: "Octo"}, nil
	case "other":
		return &auth.GitHubUserInfo{ID: "43", UserName: "someone"}, nil
	}
	return nil, auth.ErrInvalidToken
}

type stubClient struct {
	reply string
	err   error
	calls int
	last  llm.Request
}

func (c *stubClient) Model() string { return "stub-model" }
func (c *stubClient) Complete(_ context.Context, req llm.Request) (*llm.Response, error) {
	c.calls++
	c.last = req
	if c.err != nil {
		return nil, c.err
	}
	return &llm.Response{Text: c.reply, Model: "stub-model", InputTokens: 10, OutputTokens: 20}, nil
}

const goodDraft = `{"name":"n","summary":"s","places":[],"transitions":[],"arcs":[],"assumptions":[]}`

func testLLMServer(t *testing.T, client *stubClient, limits llm.Limits) *Server {
	t.Helper()
	lim, err := llm.NewLimiter(limits, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &Server{llm: &llmService{client: client, limiter: lim, verifier: stubVerifier{}}}
}

func do(t *testing.T, s *Server, method, path, token, body string, hdr ...string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestLLMDisabledShipsDark(t *testing.T) {
	s := &Server{}
	rec := do(t, s, "GET", "/api/llm/status", "", "")
	var st map[string]any
	json.Unmarshal(rec.Body.Bytes(), &st)
	if rec.Code != 200 || st["enabled"] != false {
		t.Fatalf("status: %d %v", rec.Code, st)
	}
	if rec := do(t, s, "POST", "/api/llm/draft", "good", `{"description":"x"}`); rec.Code != 503 {
		t.Fatalf("draft with no key: %d", rec.Code)
	}
	if svc, err := newLLMService(func(string) string { return "" }, t.TempDir()); svc != nil || err != nil {
		t.Fatalf("no key must mean no service: %v %v", svc, err)
	}
}

func TestLLMDraftRefusalsCostNothing(t *testing.T) {
	c := &stubClient{reply: goodDraft}
	s := testLLMServer(t, c, llm.DefaultLimits)
	cases := []struct {
		name, method, token, body string
		want                      int
	}{
		{"no token", "POST", "", `{"description":"x"}`, 401},
		{"bad token", "POST", "nope", `{"description":"x"}`, 401},
		{"GET", "GET", "good", "", 405},
		{"empty", "POST", "good", `{"description":"  "}`, 400},
		{"unknown field", "POST", "good", `{"description":"x","model":"pro"}`, 400},
		{"not json", "POST", "good", `description=x`, 400},
		{"too long", "POST", "good", `{"description":"` + strings.Repeat("a", 2001) + `"}`, 413},
		{"body too big", "POST", "good", `{"description":"` + strings.Repeat("a", 17<<10) + `"}`, 413},
	}
	for _, tc := range cases {
		if rec := do(t, s, tc.method, "/api/llm/draft", tc.token, tc.body); rec.Code != tc.want {
			t.Errorf("%s: %d, want %d (%s)", tc.name, rec.Code, tc.want, rec.Body.String())
		}
	}
	if c.calls != 0 {
		t.Fatalf("refused requests reached the model %d times", c.calls)
	}
	if left, _ := s.llm.limiter.Remaining("42"); left != llm.DefaultLimits.Daily {
		t.Fatalf("refused requests were charged: %d left", left)
	}
}

func TestLLMDraftSuccess(t *testing.T) {
	c := &stubClient{reply: goodDraft}
	s := testLLMServer(t, c, llm.DefaultLimits)
	rec := do(t, s, "POST", "/api/llm/draft", "good", `{"description":"A coffee shop"}`, "Origin", "https://evil.example")
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("the LLM routes must not answer cross-origin")
	}
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out["prompt"] != draftPromptVersion || out["remaining_today"] != float64(llm.DefaultLimits.Daily-1) {
		t.Fatalf("response %v", out)
	}
	if c.last.System != draftPromptV1 || c.last.Temperature != 0.2 || c.last.MaxOutputTokens != 16384 || c.last.ResponseSchema == nil {
		t.Fatalf("request %+v", c.last)
	}
	if len(c.last.Messages) != 1 || c.last.Messages[0].Role != "user" || c.last.Messages[0].Parts[0].Text != "A coffee shop" {
		t.Fatalf("the description must be the single user message: %+v", c.last.Messages)
	}
	if strings.Contains(c.last.System, "A coffee shop") {
		t.Fatal("user text reached the system prompt")
	}
}

func TestLLMDraftUpstreamFailures(t *testing.T) {
	cases := []struct {
		name string
		c    *stubClient
		want int
	}{
		{"timeout", &stubClient{err: llm.ErrTimeout}, 504},
		{"bad reply", &stubClient{err: llm.ErrBadReply}, 502},
		{"upstream", &stubClient{err: llm.ErrUpstream}, 502},
		{"not json", &stubClient{reply: "Sure! Here is your net:"}, 502},
		{"missing key", &stubClient{reply: `{"name":"x"}`}, 502},
	}
	for _, tc := range cases {
		s := testLLMServer(t, tc.c, llm.DefaultLimits)
		rec := do(t, s, "POST", "/api/llm/draft", "good", `{"description":"x"}`)
		if rec.Code != tc.want {
			t.Errorf("%s: %d, want %d", tc.name, rec.Code, tc.want)
		}
		if strings.Contains(rec.Body.String(), "Sure!") {
			t.Errorf("%s: raw model text echoed to the client", tc.name)
		}
		if left, _ := s.llm.limiter.Remaining("42"); left != llm.DefaultLimits.Daily-1 {
			t.Errorf("%s: an upstream call is charged even when it fails (%d left)", tc.name, left)
		}
	}
}

func TestLLMDraftRateLimited(t *testing.T) {
	c := &stubClient{reply: goodDraft}
	s := testLLMServer(t, c, llm.Limits{Burst: 1, Refill: time.Hour, Daily: 10, GlobalDaily: 10})
	if rec := do(t, s, "POST", "/api/llm/draft", "good", `{"description":"x"}`); rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	rec := do(t, s, "POST", "/api/llm/draft", "good", `{"description":"x"}`)
	if rec.Code != 429 || rec.Header().Get("Retry-After") == "" || !strings.Contains(rec.Body.String(), `"reset"`) {
		t.Fatalf("429 needs Retry-After and reset: %d %v %s", rec.Code, rec.Header(), rec.Body.String())
	}
}

func TestLLMAllowlistAndVerifierDown(t *testing.T) {
	c := &stubClient{reply: goodDraft}
	s := testLLMServer(t, c, llm.DefaultLimits)
	s.llm.allow = map[string]bool{"octo": true}
	if rec := do(t, s, "POST", "/api/llm/draft", "other", `{"description":"x"}`); rec.Code != 403 {
		t.Fatalf("not allowlisted: %d", rec.Code)
	}
	if rec := do(t, s, "POST", "/api/llm/draft", "good", `{"description":"x"}`); rec.Code != 200 {
		t.Fatalf("allowlisted (case-insensitive): %d", rec.Code)
	}
	s.llm.verifier = stubVerifier{down: true}
	if rec := do(t, s, "POST", "/api/llm/draft", "good", `{"description":"x"}`); rec.Code != 503 {
		t.Fatalf("GitHub unreachable: %d", rec.Code)
	}
}

func TestLLMStatusQuota(t *testing.T) {
	s := testLLMServer(t, &stubClient{reply: goodDraft}, llm.DefaultLimits)
	var anon, signed map[string]any
	json.Unmarshal(do(t, s, "GET", "/api/llm/status", "", "").Body.Bytes(), &anon)
	json.Unmarshal(do(t, s, "GET", "/api/llm/status", "good", "").Body.Bytes(), &signed)
	if anon["enabled"] != true || anon["signed_in"] != false || anon["remaining_today"] != nil {
		t.Fatalf("anonymous status %v", anon)
	}
	if signed["signed_in"] != true || signed["remaining_today"] != float64(llm.DefaultLimits.Daily) || signed["reset"] == nil {
		t.Fatalf("signed-in status %v", signed)
	}
}
