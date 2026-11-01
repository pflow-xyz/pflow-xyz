package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

const mcpNet = `{"@context":"https://pflow.xyz/schema","@type":"PetriNet","token":["https://pflow.xyz/tokens/black"],
 "places":{"a":{"initial":[3],"capacity":[0],"x":0,"y":0},"b":{"initial":[0],"capacity":[0],"x":0,"y":0}},
 "transitions":{"t":{"x":0,"y":0,"rate":0.5}},
 "arcs":[{"source":"a","target":"t","weight":[1]},{"source":"t","target":"b","weight":[1]}]}`

func mcpCall(t *testing.T, s *Server, body string, hdr ...string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func toolCall(name, args string) string {
	return `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"` + name + `","arguments":` + args + `}}`
}

func structured(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	res, _ := out["result"].(map[string]any)
	if res == nil {
		t.Fatalf("no result: %v", out)
	}
	if res["isError"] == true {
		t.Fatalf("tool error: %v", res["content"])
	}
	return res["structuredContent"].(map[string]any)
}

func TestMCPHandshakeAndList(t *testing.T) {
	s := &Server{}
	code, out := mcpCall(t, s, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`)
	res := out["result"].(map[string]any)
	if code != 200 || res["protocolVersion"] != "2025-03-26" || res["capabilities"].(map[string]any)["tools"] == nil {
		t.Fatalf("initialize: %d %v", code, out)
	}
	if code, _ := mcpCall(t, s, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); code != 202 {
		t.Fatalf("notification: %d", code)
	}
	_, out = mcpCall(t, s, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	tools := out["result"].(map[string]any)["tools"].([]any)
	if len(tools) != len(allMCPTools())-1 { // pflow_save needs a bearer token to be listed
		t.Fatalf("%d tools", len(tools))
	}
	_, out = mcpCall(t, s, `{"jsonrpc":"2.0","id":3,"method":"nope"}`)
	if out["error"].(map[string]any)["code"] != float64(-32601) {
		t.Fatalf("unknown method: %v", out)
	}
	req := httptest.NewRequest("GET", "/mcp", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 405 {
		t.Fatalf("GET: %d", rec.Code)
	}
}

func TestMCPTools(t *testing.T) {
	s := &Server{}
	_, out := mcpCall(t, s, toolCall("pflow_check", `{"net":`+mcpNet+`}`))
	if c := structured(t, out); c["ok"] != true || c["places"] != float64(2) {
		t.Fatalf("check: %v", c)
	}
	_, out = mcpCall(t, s, toolCall("pflow_cid", `{"net":`+mcpNet+`}`))
	if c := structured(t, out); !strings.HasPrefix(c["cid"].(string), "z") {
		t.Fatalf("cid: %v", c)
	}
	_, out = mcpCall(t, s, toolCall("pflow_simulate", `{"net":`+mcpNet+`,"t_end":20,"points":5}`))
	sim := structured(t, out)
	final := sim["final"].(map[string]any)
	if final["a"].(float64)+final["b"].(float64) < 2.999 || final["b"].(float64) < 2.9 {
		t.Fatalf("simulate: %v", final)
	}
	if len(sim["t"].([]any)) != 5 || sim["rates"].(map[string]any)["t"] != 0.5 {
		t.Fatalf("simulate shape: %v", sim)
	}
	_, out = mcpCall(t, s, toolCall("pflow_reachability", `{"net":`+mcpNet+`}`))
	rc := structured(t, out)
	if rc["states"] != float64(4) || rc["complete"] != true || rc["deadlocks"] != float64(1) {
		t.Fatalf("reachability: %v", rc)
	}
	_, out = mcpCall(t, s, toolCall("pflow_links", `{"cid":"zABC"}`))
	if l := structured(t, out); !strings.HasSuffix(l["editor"].(string), "/?cid=zABC") {
		t.Fatalf("links: %v", l)
	}
}

func TestMCPToolErrorsAndSave(t *testing.T) {
	s := &Server{}
	_, out := mcpCall(t, s, toolCall("pflow_simulate", `{"net":`+mcpNet+`,"t_end":1e9}`))
	if res := out["result"].(map[string]any); res["isError"] != true {
		t.Fatalf("an out-of-bounds horizon must be a tool error: %v", out)
	}
	_, out = mcpCall(t, s, toolCall("pflow_save", `{"net":`+mcpNet+`}`))
	res := out["result"].(map[string]any)
	if res["isError"] != true || !strings.Contains(res["content"].([]any)[0].(map[string]any)["text"].(string), "Bearer") {
		t.Fatalf("save without a token: %v", out)
	}
	s.mcpVerifier = stubVerifier{}
	_, out = mcpCall(t, s, toolCall("pflow_save", `{"net":`+mcpNet+`}`), "Authorization", "Bearer nope")
	if out["result"].(map[string]any)["isError"] != true {
		t.Fatal("a rejected token must not save")
	}
	_, out = mcpCall(t, s, toolCall("pflow_bogus", `{}`))
	if out["error"] == nil {
		t.Fatal("unknown tool")
	}
}

func TestMCPReachabilityDoesNotOverclaim(t *testing.T) {
	s := &Server{}
	// an arrival source: unbounded, so any budget stops the search
	src := `{"places":{"q":{"initial":[0],"capacity":[0],"x":0,"y":0}},"transitions":{"arrive":{"x":0,"y":0}},"arcs":[{"source":"arrive","target":"q","weight":[1]}]}`
	_, out := mcpCall(t, s, toolCall("pflow_reachability", `{"net":`+src+`,"max_states":50}`))
	rc := structured(t, out)
	if rc["complete"] != false || !strings.HasPrefix(rc["bounded"].(string), "unknown") {
		t.Fatalf("an incomplete search must not claim bounded: %v", rc)
	}
	for _, verdict := range []string{"live", "deadlock_free", "quasi_live"} {
		if rc[verdict] != "unknown" {
			t.Errorf("%s = %v, want unknown: the search stopped early", verdict, rc[verdict])
		}
	}
	bound, _ := rc["bound"].(map[string]any)
	if bound == nil || bound["max_states"] != float64(50) || bound["max_tokens"] != float64(1000) {
		t.Errorf("bound = %v, want the limits the search ran under", rc["bound"])
	}
	if rc["witness"] != nil {
		t.Errorf("no witness without a refutation: %v", rc["witness"])
	}
}

// Two philosophers, each taking their left fork first. Every transition fires
// somewhere, and both holding a fork is a dead marking: the net the tool once
// called live.
const philosophersNet = `{"places":{
"fork1":{"initial":[1],"x":0,"y":0},"fork2":{"initial":[1],"x":0,"y":0},
"p1_thinking":{"initial":[1],"x":0,"y":0},"p1_has_left":{"initial":[0],"x":0,"y":0},"p1_eating":{"initial":[0],"x":0,"y":0},
"p2_thinking":{"initial":[1],"x":0,"y":0},"p2_has_left":{"initial":[0],"x":0,"y":0},"p2_eating":{"initial":[0],"x":0,"y":0}},
"transitions":{"p1_take_left":{"x":0,"y":0},"p1_take_right":{"x":0,"y":0},"p1_release":{"x":0,"y":0},
"p2_take_left":{"x":0,"y":0},"p2_take_right":{"x":0,"y":0},"p2_release":{"x":0,"y":0}},
"arcs":[
{"source":"p1_thinking","target":"p1_take_left","weight":[1]},{"source":"fork1","target":"p1_take_left","weight":[1]},{"source":"p1_take_left","target":"p1_has_left","weight":[1]},
{"source":"p1_has_left","target":"p1_take_right","weight":[1]},{"source":"fork2","target":"p1_take_right","weight":[1]},{"source":"p1_take_right","target":"p1_eating","weight":[1]},
{"source":"p1_eating","target":"p1_release","weight":[1]},{"source":"p1_release","target":"p1_thinking","weight":[1]},{"source":"p1_release","target":"fork1","weight":[1]},{"source":"p1_release","target":"fork2","weight":[1]},
{"source":"p2_thinking","target":"p2_take_left","weight":[1]},{"source":"fork2","target":"p2_take_left","weight":[1]},{"source":"p2_take_left","target":"p2_has_left","weight":[1]},
{"source":"p2_has_left","target":"p2_take_right","weight":[1]},{"source":"fork1","target":"p2_take_right","weight":[1]},{"source":"p2_take_right","target":"p2_eating","weight":[1]},
{"source":"p2_eating","target":"p2_release","weight":[1]},{"source":"p2_release","target":"p2_thinking","weight":[1]},{"source":"p2_release","target":"fork1","weight":[1]},{"source":"p2_release","target":"fork2","weight":[1]}
]}`

func TestMCPReachabilityPhilosophersAreNotLive(t *testing.T) {
	_, out := mcpCall(t, &Server{}, toolCall("pflow_reachability", `{"net":`+philosophersNet+`}`))
	rc := structured(t, out)
	if rc["complete"] != true {
		t.Fatalf("expected a complete search: %v", rc)
	}
	if rc["live"] != false {
		t.Errorf("live = %v, want false", rc["live"])
	}
	if rc["deadlock_free"] != false {
		t.Errorf("deadlock_free = %v, want false", rc["deadlock_free"])
	}
	if rc["quasi_live"] != true {
		t.Errorf("quasi_live = %v, want true", rc["quasi_live"])
	}
	if rc["deadlocks"] != float64(1) {
		t.Errorf("deadlocks = %v, want 1", rc["deadlocks"])
	}
	w, _ := rc["witness"].(map[string]any)
	if w == nil {
		t.Fatalf("no witness: %v", rc)
	}
	if w["kind"] != "deadlock" {
		t.Errorf("witness kind = %v", w["kind"])
	}
	trace, _ := w["trace"].([]any)
	if len(trace) != 2 || trace[0] != "p1_take_left" || trace[1] != "p2_take_left" {
		t.Errorf("witness trace = %v", w["trace"])
	}
	if rc["bound"] != nil {
		t.Errorf("a complete search has no bound: %v", rc["bound"])
	}

	// The witness replays through the tool that plays the token game.
	seq, _ := json.Marshal(trace)
	_, out = mcpCall(t, &Server{}, toolCall("pflow_fire", `{"net":`+philosophersNet+`,"sequence":`+string(seq)+`}`))
	fired := structured(t, out)
	if m, _ := fired["marking"].(map[string]any); m == nil || m["p1_has_left"] != float64(1) || m["p2_has_left"] != float64(1) {
		t.Errorf("replaying the witness: %v", fired)
	}
}

func TestMCPReachabilityLiveNet(t *testing.T) {
	ring := `{"places":{"a":{"initial":[1],"x":0,"y":0},"b":{"initial":[0],"x":0,"y":0}},"transitions":{"ab":{"x":0,"y":0},"ba":{"x":0,"y":0}},"arcs":[{"source":"a","target":"ab","weight":[1]},{"source":"ab","target":"b","weight":[1]},{"source":"b","target":"ba","weight":[1]},{"source":"ba","target":"a","weight":[1]}]}`
	_, out := mcpCall(t, &Server{}, toolCall("pflow_reachability", `{"net":`+ring+`}`))
	rc := structured(t, out)
	if rc["live"] != true || rc["deadlock_free"] != true || rc["quasi_live"] != true || rc["deadlocks"] != float64(0) {
		t.Fatalf("a ring is live: %v", rc)
	}
	if rc["witness"] != nil {
		t.Fatalf("a live net has no witness: %v", rc["witness"])
	}
}

func TestMCPVerifyL4Live(t *testing.T) {
	_, out := mcpCall(t, &Server{}, toolCall("pflow_verify", `{"net":`+philosophersNet+`,"properties":[{"kind":"l4-live"},{"kind":"live"}]}`))
	raw, _ := json.Marshal(structured(t, out))
	var report struct {
		Verdicts []struct {
			Status         string `json:"status"`
			Counterexample *struct {
				Trace []string `json:"trace"`
			} `json:"counterexample"`
		} `json:"verdicts"`
	}
	if err := json.Unmarshal(raw, &report); err != nil || len(report.Verdicts) != 2 {
		t.Fatalf("verify report: %v %s", err, raw)
	}
	l4, l1 := report.Verdicts[0], report.Verdicts[1]
	if l4.Status != "refuted" || l4.Counterexample == nil || len(l4.Counterexample.Trace) != 2 {
		t.Errorf("l4-live: %s", raw)
	}
	if l1.Status != "proved" {
		t.Errorf("live is L1 in pflow_verify, and holds here: %s", raw)
	}
}
