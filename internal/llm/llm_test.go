package llm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---- Gemini client ----

type captured struct {
	path, key string
	body      map[string]any
}

func geminiStub(t *testing.T, reply string, status int, delay time.Duration, got *captured) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if got != nil {
			got.path = r.URL.String()
			got.key = r.Header.Get("x-goog-api-key")
			json.Unmarshal(raw, &got.body)
		}
		if delay > 0 {
			select {
			case <-time.After(delay):
			case <-r.Context().Done():
				return
			}
		}
		w.WriteHeader(status)
		io.WriteString(w, reply)
	}))
}

const okReply = `{"candidates":[{"content":{"role":"model","parts":[{"text":"{\"name\":\"x\"}"}]},"finishReason":"STOP"}],
"usageMetadata":{"promptTokenCount":812,"candidatesTokenCount":1406},"modelVersion":"gemini-2.5-flash"}`

func TestGeminiRequestShape(t *testing.T) {
	var got captured
	srv := geminiStub(t, okReply, 200, 0, &got)
	defer srv.Close()
	g := NewGemini("SECRET-KEY", "")
	g.BaseURL = srv.URL
	schema := map[string]any{"type": "OBJECT"}
	resp, err := g.Complete(context.Background(), Request{
		System:         "the fixed prompt",
		Messages:       []Message{{Role: "user", Parts: []Part{{Text: "a coffee shop"}}}},
		ResponseSchema: schema, Temperature: 0.2, MaxOutputTokens: 4096,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.key != "SECRET-KEY" || strings.Contains(got.path, "SECRET") {
		t.Fatalf("key must travel in x-goog-api-key only: path %q header %q", got.path, got.key)
	}
	if got.path != "/models/gemini-3.8-flash:generateContent" {
		t.Fatalf("path %q", got.path)
	}
	sys := got.body["systemInstruction"].(map[string]any)["parts"].([]any)[0].(map[string]any)["text"]
	if sys != "the fixed prompt" {
		t.Fatalf("systemInstruction %v", sys)
	}
	contents := got.body["contents"].([]any)
	if len(contents) != 1 || contents[0].(map[string]any)["role"] != "user" {
		t.Fatalf("user text must be the single user-role message: %v", contents)
	}
	gc := got.body["generationConfig"].(map[string]any)
	if gc["temperature"] != 0.2 || gc["maxOutputTokens"] != 4096.0 || gc["responseMimeType"] != "application/json" || gc["responseSchema"] == nil {
		t.Fatalf("generationConfig %v", gc)
	}
	if resp.Text != `{"name":"x"}` || resp.InputTokens != 812 || resp.OutputTokens != 1406 {
		t.Fatalf("response %+v", resp)
	}
}

func TestGeminiThinkingBudget(t *testing.T) {
	budget := func(n int) *int { return &n }
	for _, c := range []struct {
		name string
		b    *int
		want any // nil = thinkingConfig absent
	}{{"unset", nil, nil}, {"zero turns thinking off", budget(0), 0.0}, {"1024", budget(1024), 1024.0}} {
		var got captured
		srv := geminiStub(t, okReply, 200, 0, &got)
		g := NewGemini("k", "")
		g.BaseURL = srv.URL
		_, err := g.Complete(context.Background(), Request{Messages: []Message{{Role: "user", Parts: []Part{{Text: "x"}}}}, ThinkingBudget: c.b})
		srv.Close()
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		tc, ok := got.body["generationConfig"].(map[string]any)["thinkingConfig"].(map[string]any)
		if c.want == nil {
			if ok {
				t.Errorf("%s: thinkingConfig sent: %v", c.name, tc)
			}
		} else if !ok || tc["thinkingBudget"] != c.want {
			t.Errorf("%s: thinkingConfig %v, want budget %v", c.name, tc, c.want)
		}
	}
}

func TestGeminiMaxTokensIsTruncated(t *testing.T) {
	reply := `{"candidates":[{"content":{"role":"model","parts":[{"text":"{\"name\":\"x\",\"places\":[{"}]},"finishReason":"MAX_TOKENS"}],
"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":153,"thoughtsTokenCount":3930}}`
	srv := geminiStub(t, reply, 200, 0, nil)
	defer srv.Close()
	g := NewGemini("k", "")
	g.BaseURL = srv.URL
	resp, err := g.Complete(context.Background(), Request{Messages: []Message{{Role: "user", Parts: []Part{{Text: "x"}}}}, MaxOutputTokens: 4096})
	if !errors.Is(err, ErrTruncated) || !errors.Is(err, ErrBadReply) {
		t.Fatalf("err %v, want ErrTruncated (and ErrBadReply)", err)
	}
	if !strings.Contains(err.Error(), "3930 thinking") {
		t.Errorf("error should say where the tokens went: %v", err)
	}
	if resp == nil || resp.ThoughtTokens != 3930 || resp.OutputTokens != 153 {
		t.Errorf("usage must still be reported on truncation: %+v", resp)
	}
}

func TestGeminiFunctionCalls(t *testing.T) {
	reply := `{"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"sim_ode","args":{"t_end":5}}}]}}]}`
	var got captured
	srv := geminiStub(t, reply, 200, 0, &got)
	defer srv.Close()
	g := NewGemini("k", "m")
	g.BaseURL = srv.URL
	resp, err := g.Complete(context.Background(), Request{
		Messages: []Message{{Role: "user", Parts: []Part{{Text: "run it"}}}},
		Tools:    []FunctionDecl{{Name: "sim_ode", Description: "run the ODE"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Calls) != 1 || resp.Calls[0].Name != "sim_ode" || resp.Calls[0].Args["t_end"] != 5.0 {
		t.Fatalf("calls %+v", resp.Calls)
	}
	if got.body["tools"] == nil {
		t.Fatal("tools not sent")
	}
}

func TestGeminiErrors(t *testing.T) {
	cases := []struct {
		name, reply string
		status      int
		want        error
	}{
		{"no candidates", `{"candidates":[]}`, 200, ErrBadReply},
		{"not json", `<html>`, 200, ErrBadReply},
		{"oversize", `{"x":"` + strings.Repeat("a", MaxReplyBytes) + `"}`, 200, ErrBadReply},
		{"upstream 400 with echo", `{"error":{"message":"your prompt was: TOP SECRET"}}`, 400, ErrUpstream},
	}
	for _, c := range cases {
		srv := geminiStub(t, c.reply, c.status, 0, nil)
		g := NewGemini("k", "")
		g.BaseURL = srv.URL
		_, err := g.Complete(context.Background(), Request{Messages: []Message{{Role: "user", Parts: []Part{{Text: "x"}}}}})
		srv.Close()
		if !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", c.name, err, c.want)
		}
		if err != nil && strings.Contains(err.Error(), "TOP SECRET") {
			t.Errorf("%s: upstream error body leaked: %v", c.name, err)
		}
	}
}

func TestGeminiTimeout(t *testing.T) {
	srv := geminiStub(t, okReply, 200, 2*time.Second, nil)
	defer srv.Close()
	g := NewGemini("k", "")
	g.BaseURL = srv.URL
	g.Timeout = 50 * time.Millisecond
	_, err := g.Complete(context.Background(), Request{Messages: []Message{{Role: "user", Parts: []Part{{Text: "x"}}}}})
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("%v, want ErrTimeout", err)
	}
}

// ---- limits ----

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newTestLimiter(t *testing.T, l Limits) (*Limiter, *clock, string) {
	t.Helper()
	dir := t.TempDir()
	c := &clock{t: time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)}
	lim := &Limiter{L: l, Dir: dir, Now: c.now}
	if err := lim.replay(); err != nil {
		t.Fatal(err)
	}
	return lim, c, dir
}

func TestBurstRefills(t *testing.T) {
	lim, c, _ := newTestLimiter(t, Limits{Burst: 2, Refill: 20 * time.Second, Daily: 100, GlobalDaily: 100})
	for i := 0; i < 2; i++ {
		done, err := lim.Begin(Usage{GHID: "1", Kind: "draft"})
		if err != nil {
			t.Fatal(err)
		}
		done(Usage{Status: 200})
	}
	_, err := lim.Begin(Usage{GHID: "1"})
	var le *LimitError
	if !errors.As(err, &le) || le.RetryAfter <= 0 {
		t.Fatalf("third call within the burst: %v", err)
	}
	c.t = c.t.Add(21 * time.Second)
	done, err := lim.Begin(Usage{GHID: "1"})
	if err != nil {
		t.Fatalf("after a refill: %v", err)
	}
	done(Usage{})
}

func TestOneInFlightPerUser(t *testing.T) {
	lim, _, _ := newTestLimiter(t, DefaultLimits)
	done, err := lim.Begin(Usage{GHID: "1"})
	if err != nil {
		t.Fatal(err)
	}
	var le *LimitError
	if _, err := lim.Begin(Usage{GHID: "1"}); !errors.As(err, &le) {
		t.Fatalf("a second concurrent call: %v", err)
	}
	if d2, err := lim.Begin(Usage{GHID: "2"}); err != nil {
		t.Fatalf("another user: %v", err)
	} else {
		d2(Usage{})
	}
	done(Usage{})
}

func TestDailyAndGlobalLimitsResetAtUTCMidnight(t *testing.T) {
	lim, c, _ := newTestLimiter(t, Limits{Burst: 100, Refill: time.Second, Daily: 2, GlobalDaily: 3})
	call := func(id string) error {
		done, err := lim.Begin(Usage{GHID: id})
		if err == nil {
			done(Usage{})
		}
		return err
	}
	if call("a") != nil || call("a") != nil {
		t.Fatal("first two calls refused")
	}
	if err := call("a"); err == nil || !strings.Contains(err.Error(), "daily limit of 2") {
		t.Fatalf("third call for a: %v", err)
	}
	if call("b") != nil {
		t.Fatal("b refused")
	}
	if err := call("c"); err == nil || !strings.Contains(err.Error(), "service's daily limit") {
		t.Fatalf("global cap: %v", err)
	}
	left, reset := lim.Remaining("b")
	if left != 0 || reset != time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC) {
		t.Fatalf("remaining %d reset %v", left, reset)
	}
	c.t = time.Date(2026, 10, 26, 0, 0, 1, 0, time.UTC)
	if call("a") != nil {
		t.Fatal("not reset at the UTC day boundary")
	}
}

func TestReplayRebuildsCounters(t *testing.T) {
	lim, c, dir := newTestLimiter(t, Limits{Burst: 100, Refill: time.Second, Daily: 5, GlobalDaily: 50})
	for i := 0; i < 3; i++ {
		done, err := lim.Begin(Usage{GHID: "7", Login: "octo", Kind: "draft"})
		if err != nil {
			t.Fatal(err)
		}
		done(Usage{Status: 200, In: 10, Out: 20})
	}
	// A restart: a fresh limiter over the same directory.
	again := &Limiter{L: lim.L, Dir: dir, Now: c.now}
	if err := again.replay(); err != nil {
		t.Fatal(err)
	}
	if left, _ := again.Remaining("7"); left != 2 {
		t.Fatalf("after replay, %d left, want 2", left)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "usage-2026-10.jsonl"))
	if n := strings.Count(string(raw), `"event":"done"`); n != 3 {
		t.Fatalf("%d done lines", n)
	}
}

func TestUnwritableLogFailsClosed(t *testing.T) {
	dir := t.TempDir()
	blocker := filepath.Join(dir, "llm")
	os.WriteFile(blocker, []byte("a file where the directory should be"), 0o644)
	lim := &Limiter{L: DefaultLimits, Dir: blocker, Now: time.Now}
	lim.replay()
	if _, err := lim.Begin(Usage{GHID: "1"}); !errors.Is(err, ErrUsageLog) {
		t.Fatalf("%v, want ErrUsageLog", err)
	}
	if left, _ := lim.Remaining("1"); left != DefaultLimits.Daily {
		t.Fatal("a call that could not be logged was charged")
	}
}

func TestLimitsFromEnv(t *testing.T) {
	env := map[string]string{"PFLOW_LLM_DAILY_LIMIT": "7", "PFLOW_LLM_BURST": "lots", "PFLOW_LLM_REFILL_S": "5"}
	l := LimitsFromEnv(func(k string) string { return env[k] })
	if l.Daily != 7 || l.Burst != DefaultLimits.Burst || l.Refill != 5*time.Second || l.GlobalDaily != DefaultLimits.GlobalDaily {
		t.Fatalf("%+v", l)
	}
}
