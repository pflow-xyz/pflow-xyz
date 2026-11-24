package main

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func notationPost(t *testing.T, s *Server, body string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("POST", "/api/notation", strings.NewReader(body)))
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// The endpoint is the Go notation package: a net prints to the example's text,
// and that text compiles back to the example's CID (docs/notation/examples).
func TestNotationEndpointRoundTrip(t *testing.T) {
	s := &Server{}
	jsonld, err := os.ReadFile("../../docs/notation/examples/bounded-buffer.jsonld")
	if err != nil {
		t.Fatal(err)
	}
	var cids map[string]any
	raw, _ := os.ReadFile("../../docs/notation/examples/cids.json")
	json.Unmarshal(raw, &cids)

	code, out := notationPost(t, s, `{"net":`+string(jsonld)+`,"advise":true}`)
	if code != 200 {
		t.Fatalf("print: %d %v", code, out)
	}
	text, _ := out["text"].(string)
	if !strings.Contains(text, "place slots = 3 cap 3") || !strings.Contains(text, "transition produce") {
		t.Fatalf("printed text:\n%s", text)
	}
	nodes := out["nodes"].(map[string]any)
	lines := strings.Split(text, "\n")
	if l, ok := nodes["produce"].(float64); !ok || !strings.HasPrefix(lines[int(l)-1], "transition produce") {
		t.Fatalf("nodes: %v", nodes)
	}
	// The advisor ran (go-pflow's verifier): a bounded buffer is bounded, and the verdict sits on a line.
	diags, _ := out["diagnostics"].([]any)
	if len(diags) == 0 {
		t.Fatalf("no advice for the bounded buffer: %v", out)
	}
	for _, d := range diags {
		if d.(map[string]any)["line"].(float64) < 1 {
			t.Fatalf("diagnostic without a line: %v", d)
		}
	}

	code, out = notationPost(t, s, `{"text":`+jsonString(text)+`}`)
	if code != 200 || out["net"] == nil {
		t.Fatalf("compile: %d %v", code, out)
	}
	want, _ := cids["bounded-buffer"].(string)
	if want == "" || out["cid"] != want {
		t.Fatalf("round trip CID %v, want %s", out["cid"], want)
	}
}

func TestNotationEndpointErrorsOnTheirLines(t *testing.T) {
	s := &Server{}
	code, out := notationPost(t, s, `{"text":"#! pflow 1\nnet \"x\"\nplace a = 1\nplace b\na -> nowhere -> b\n"}`)
	if code != 200 || out["net"] != nil || out["cid"] != nil {
		t.Fatalf("a text with an error compiled: %d %v", code, out)
	}
	found := false
	for _, d := range out["diagnostics"].([]any) {
		m := d.(map[string]any)
		if m["severity"] == "error" && m["line"] == float64(5) {
			found = true
		}
	}
	if !found {
		t.Fatalf("no error on line 5: %v", out["diagnostics"])
	}
	if code, _ := notationPost(t, s, `{}`); code != 400 {
		t.Fatalf("empty body: %d", code)
	}
	if code, _ := notationPost(t, s, `{"net":{},"text":""}`); code != 400 {
		t.Fatalf("both: %d", code)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/api/notation", nil))
	if rec.Code != 405 {
		t.Fatalf("GET: %d", rec.Code)
	}
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
