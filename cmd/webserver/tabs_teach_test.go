package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// teachNet is the net the end-to-end test pushes: the one scripts/shell-smoke.ts
// pushes too, so the recorded frames load through the page's strict gate.
const teachNet = `{"@context":"https://pflow.xyz/schema","@type":"PetriNet","@version":"1.1","token":["https://pflow.xyz/tokens/black"],` +
	`"places":{"pushedA":{"@type":"Place","initial":[3],"capacity":[0],"x":100,"y":100,"offset":0},"pushedB":{"@type":"Place","initial":[0],"capacity":[0],"x":300,"y":100,"offset":0}},` +
	`"transitions":{"move":{"@type":"Transition","x":200,"y":100}},` +
	`"arcs":[{"@type":"Arrow","source":"pushedA","target":"move","weight":[1],"inhibitTransition":false},{"@type":"Arrow","source":"move","target":"pushedB","weight":[1],"inhibitTransition":false}]}`

// teachGolden is the frames a page receives for the end-to-end sequence, with
// request ids numbered; public/petri-tab_test.ts and scripts/shell-smoke.ts
// replay this file into a page, so the two halves are held to one recording.
const teachGolden = "../../testdata/tab-teach/frames.json"

// fakeShellPage stands in for a linked shell page: it reads the stream and
// answers each pushed event on /reply with what a shell would say, recording
// every event it saw.
type fakeShellPage struct {
	mu     sync.Mutex
	seen   []map[string]any
	level  string
	answer func(ev map[string]any) map[string]any
}

func (p *fakeShellPage) run(t *testing.T, srv string, token, id string, ch <-chan map[string]any) {
	go func() {
		for ev := range ch {
			typ, _ := ev["type"].(string)
			if typ == "ping" || typ == "hello" {
				continue
			}
			p.mu.Lock()
			p.seen = append(p.seen, ev)
			res := p.answer(ev)
			p.mu.Unlock()
			rid, _ := ev["request_id"].(string)
			if rid == "" {
				continue
			}
			body, _ := json.Marshal(map[string]any{"request_id": rid, "state": map[string]any{"view": "canvas", "places": 2, "result": res, "shell": map[string]any{"level": p.level}}})
			httpJSONNoT(srv+"/api/tab/"+id+"/reply", token, string(body))
		}
	}()
}

// httpJSONNoT posts from the page's goroutine, where t.Fatal may not be called.
func httpJSONNoT(url, token, body string) {
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	if resp, err := http.DefaultClient.Do(req); err == nil {
		resp.Body.Close()
	}
}

func TestTabTeachEndToEnd(t *testing.T) {
	_, srv := tabServer(t)
	id := newTab(t, srv, "alice")
	ch, closeStream := frames(t, srv, "alice", id)
	defer closeStream()
	next(t, ch, "hello")

	// A shell at the model level, as petri-shell.js decides: math views are refused until the level is math.
	page := &fakeShellPage{level: "model"}
	page.answer = func(ev map[string]any) map[string]any {
		p, _ := ev["params"].(map[string]any)
		switch ev["type"] {
		case "show":
			if v := ev["view"]; (v == "reachability" || v == "invariants") && page.level != "math" {
				return map[string]any{"ok": false, "error": "a math-level view", "needs": "math", "level": page.level}
			}
			return map[string]any{"ok": true, "id": ev["view"], "type": ev["view"]}
		case "level":
			page.level = p["level"].(string)
			return map[string]any{"ok": true, "level": page.level}
		case "highlight":
			return map[string]any{"ok": true, "count": len(p["targets"].([]any))}
		case "tour":
			return map[string]any{"ok": true, "steps": len(p["steps"].([]any))}
		case "tour_control":
			return map[string]any{"ok": true}
		}
		return map[string]any{"ok": true}
	}
	page.run(t, srv.URL, "alice", id, ch)

	call := func(name, args string) map[string]any {
		t.Helper()
		out, isErr := tabTool(t, srv, "alice", name, args)
		if isErr {
			t.Fatalf("%s: %v", name, out)
		}
		if out["sent"] != true || out["answered"] != true {
			t.Fatalf("%s: not delivered and answered: %v", name, out)
		}
		return out
	}

	// 1. push a net onto the canvas
	call("pflow_show", `{"view":"canvas","net":`+teachNet+`,"note":"a two-place net"}`)
	// a math view at the model level is refused, and the caller is told what to send
	out := call("pflow_show", `{"view":"reachability","net":`+teachNet+`}`)
	if res, _ := out["result"].(map[string]any); res["ok"] != false || !strings.Contains(out["note"].(string), `pflow_level {"level":"math"}`) {
		t.Fatalf("refusal not surfaced: %v", out)
	}
	// 2. level math
	out = call("pflow_level", `{"level":"math"}`)
	if out["result"].(map[string]any)["level"] != "math" || out["shell"].(map[string]any)["level"] != "math" {
		t.Fatalf("level: %v", out)
	}
	// the same net in the notation panel (the shell's real notation view, PR #133's package behind /api/notation)
	call("pflow_show", `{"view":"notation","net":`+teachNet+`}`)
	// 3. highlight a transition
	out = call("pflow_highlight", `{"targets":["node:move"],"label":"this fires"}`)
	if out["result"].(map[string]any)["count"] != float64(1) {
		t.Fatalf("highlight: %v", out)
	}
	// 4. a two-step tour, then the next step
	out = call("pflow_tour", `{"title":"How tokens move","steps":[`+
		`{"type":"highlight","targets":["node:pushedA"],"say":"Three tokens wait in pushedA."},`+
		`{"type":"show","view":"invariants","params":{"kind":"p"},"say":"pushedA + pushedB is always 3."}]}`)
	if out["result"].(map[string]any)["steps"] != float64(2) {
		t.Fatalf("tour: %v", out)
	}
	call("pflow_tour", `{"action":"next"}`)

	page.mu.Lock()
	seen := page.seen
	page.mu.Unlock()
	want := []string{"show", "show", "level", "show", "highlight", "tour", "tour_control"}
	if len(seen) != len(want) {
		t.Fatalf("page saw %d events, want %d: %v", len(seen), len(want), seen)
	}
	golden := make([]map[string]any, 0, len(seen))
	for i, ev := range seen {
		if ev["type"] != want[i] {
			t.Fatalf("event %d: %v, want %s", i, ev["type"], want[i])
		}
		if ev["request_id"] == nil {
			t.Fatalf("event %d has no request_id", i)
		}
		if i == 1 {
			continue // the refusal is a server-side behaviour; the replay starts from a page that takes every step
		}
		ev["request_id"] = fmt.Sprintf("r%d", len(golden)+1)
		golden = append(golden, ev)
	}
	tour := golden[4]["params"].(map[string]any)["steps"].([]any)
	if tour[0].(map[string]any)["say"] != "Three tokens wait in pushedA." || tour[1].(map[string]any)["view"] != "invariants" {
		t.Fatalf("tour steps on the wire: %v", tour)
	}

	got, _ := json.MarshalIndent(golden, "", "  ")
	got = append(got, '\n')
	if os.Getenv("UPDATE_GOLDEN") == "1" {
		os.MkdirAll(filepath.Dir(teachGolden), 0o755)
		if err := os.WriteFile(teachGolden, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	wantBytes, err := os.ReadFile(teachGolden)
	if err != nil {
		t.Fatalf("%v (run with UPDATE_GOLDEN=1 to write it)", err)
	}
	var a, b any
	json.Unmarshal(got, &a)
	json.Unmarshal(wantBytes, &b)
	ga, _ := json.Marshal(a)
	gb, _ := json.Marshal(b)
	if string(ga) != string(gb) {
		t.Fatalf("frames differ from %s (UPDATE_GOLDEN=1 rewrites it):\n%s", teachGolden, got)
	}
}

func TestTabTeachRefusesBadEvents(t *testing.T) {
	_, srv := tabServer(t)
	for _, c := range []struct{ tool, args, want string }{
		{"pflow_level", `{"level":"expert"}`, "level: one of"},
		{"pflow_highlight", `{"targets":["move"]}`, "targets[0]"},
		{"pflow_highlight", `{"targets":["range:9-3"]}`, "lower line"},
		{"pflow_highlight", `{"targets":"node:a"}`, "a list"},
		{"pflow_annotate", `{"text":"x","colour":"red"}`, `no field "colour"`},
		{"pflow_focus", `{"target":"panel:"}`, "target:"},
		{"pflow_tour", `{"steps":[]}`, "1 to 30"},
		{"pflow_tour", `{"steps":[{"type":"tour","steps":[]}]}`, "a step is"},
		{"pflow_tour", `{"steps":[{"type":"show","view":"canvas","net":{}}]}`, "does not carry a net"},
		{"pflow_tour", `{"steps":[{"type":"show","view":"categorical"}]}`, "categorical"},
		{"pflow_tour", `{"steps":[{"say":"hi","bogus":1}]}`, "or only say"},
		{"pflow_tour", `{"action":"skip"}`, `"next", "back" or "end"`},
	} {
		out, isErr := tabTool(t, srv, "alice", c.tool, c.args)
		if !isErr || !strings.Contains(fmt.Sprint(out["error"]), c.want) {
			t.Errorf("%s %s: %v, want an error with %q", c.tool, c.args, out, c.want)
		}
	}
	// No linked page: sent false and a note, not an error.
	out, isErr := tabTool(t, srv, "alice", "pflow_level", `{"level":"outcome"}`)
	if isErr || out["sent"] != false || !strings.Contains(out["note"].(string), "?shell=1") {
		t.Fatalf("no page: %v", out)
	}
	// Signed out: refused.
	out, isErr = tabTool(t, srv, "", "pflow_highlight", `{"targets":[]}`)
	if !isErr {
		t.Fatalf("signed out: %v", out)
	}
}

func TestTabTeachAnswersWithoutAShell(t *testing.T) {
	// A page that never answers (an old page, or one without the shell): the push is sent and the caller is told.
	s, srv := tabServer(t)
	s.tabs.replyWait = 50 * time.Millisecond
	id := newTab(t, srv, "alice")
	ch, closeStream := frames(t, srv, "alice", id)
	defer closeStream()
	next(t, ch, "hello")
	out, isErr := tabTool(t, srv, "alice", "pflow_annotate", `{"text":"Watch pushedA.","target":"node:pushedA"}`)
	if isErr || out["sent"] != true || out["answered"] != false || !strings.Contains(out["note"].(string), "did not answer") {
		t.Fatalf("unanswered: %v", out)
	}
	ev := next(t, ch, "annotate")
	if p := ev["params"].(map[string]any); p["text"] != "Watch pushedA." || p["target"] != "node:pushedA" {
		t.Fatalf("annotate on the wire: %v", ev)
	}
}

func TestTabPushOnByDefault(t *testing.T) {
	s := &Server{}
	s.configureTabs(func(string) string { return "" }, false)
	t.Cleanup(func() { setTabPush(false) })
	if s.tabs == nil || !tabPushOn.Load() {
		t.Fatal("tab push should be on when PFLOW_TAB_PUSH is unset")
	}
	listed := map[string]bool{}
	for _, tl := range allMCPTools() {
		listed[tl.Name] = true
	}
	for n := range tabToolNames {
		if !listed[n] {
			t.Errorf("%s not listed by default", n)
		}
		if _, ok := mcpAnnotations[n]; !ok {
			t.Errorf("%s not annotated", n)
		}
	}
}
