package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// a producer/consumer ring: p1 -t1-> p2 -t2-> p1, two tokens, so every
// analysis has something to say.
const ringNet = `{"@context":"https://pflow.xyz/schema","@type":"PetriNet","token":["https://pflow.xyz/tokens/black"],
 "places":{"p1":{"initial":[2],"capacity":[0],"x":0,"y":0},"p2":{"initial":[0],"capacity":[0],"x":100,"y":0}},
 "transitions":{"t1":{"x":0,"y":100},"t2":{"x":100,"y":100}},
 "arcs":[{"source":"p1","target":"t1","weight":[1]},{"source":"t1","target":"p2","weight":[1]},
         {"source":"p2","target":"t2","weight":[1]},{"source":"t2","target":"p1","weight":[1]}]}`

func TestMCPEveryToolIsAnnotated(t *testing.T) {
	s := &Server{}
	// with a bearer token, so pflow_save is listed too
	_, out := mcpCall(t, s, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, "Authorization", "Bearer x")
	tools := out["result"].(map[string]any)["tools"].([]any)
	if len(tools) < 20 {
		t.Fatalf("%d tools listed", len(tools))
	}
	seen := map[string]bool{}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		name := tool["name"].(string)
		seen[name] = true
		a, _ := tool["annotations"].(map[string]any)
		if a == nil {
			t.Errorf("%s: no annotations", name)
			continue
		}
		ro, hasRO := a["readOnlyHint"].(bool)
		de, hasDe := a["destructiveHint"].(bool)
		if !hasRO && !hasDe {
			t.Errorf("%s: neither readOnlyHint nor destructiveHint", name)
		}
		if ro && de {
			t.Errorf("%s: both read-only and destructive", name)
		}
		if a["openWorldHint"] != false {
			t.Errorf("%s: openWorldHint should be false", name)
		}
		if a["title"] == nil || tool["title"] == nil {
			t.Errorf("%s: no title", name)
		}
		if _, ok := mcpAnnotations[name]; !ok {
			t.Errorf("%s: missing from mcpAnnotations", name)
		}
	}
	if a := toolAnnotations(t, out, "pflow_save"); a["destructiveHint"] != true || a["readOnlyHint"] != false {
		t.Errorf("pflow_save must be destructive: %v", a)
	}
	for n := range mcpAnnotations {
		if !seen[n] {
			t.Errorf("annotation for unlisted tool %s", n)
		}
	}
}

func toolAnnotations(t *testing.T, out map[string]any, name string) map[string]any {
	t.Helper()
	for _, raw := range out["result"].(map[string]any)["tools"].([]any) {
		if tool := raw.(map[string]any); tool["name"] == name {
			return tool["annotations"].(map[string]any)
		}
	}
	t.Fatalf("no tool %s", name)
	return nil
}

func call(t *testing.T, name, args string) map[string]any {
	t.Helper()
	_, out := mcpCall(t, &Server{}, toolCall(name, args))
	return structured(t, out)
}

func TestMCPEditBuildsANet(t *testing.T) {
	got := call(t, "pflow_edit", `{"ops":[
	  {"op":"set_details","name":"ring"},
	  {"op":"add_place","id":"p1","initial":2},
	  {"op":"add_place"},
	  {"op":"add_transition","label":"go","rate":2},
	  {"op":"add_transition"},
	  {"op":"add_arc","source":"p1","target":"t0"},
	  {"op":"add_arc","source":"t0","target":"p0","weight":2},
	  {"op":"set_arc","source":"t0","target":"p0","weight":1},
	  {"op":"add_arc","source":"p0","target":"t1"},
	  {"op":"add_arc","source":"t1","target":"p1"},
	  {"op":"add_tokens","id":"p0","delta":3},
	  {"op":"add_tokens","id":"p0","delta":-3},
	  {"op":"set_rate","id":"t1","rate":0.5},
	  {"op":"set_label","id":"p1","label":"pool"},
	  {"op":"rename","id":"p0","new_id":"done"},
	  {"op":"move","id":"done","x":300,"y":50},
	  {"op":"add_place","id":"junk"},
	  {"op":"delete","ids":["junk"]},
	  {"op":"add_arc","source":"p1","target":"t1","inhibit":true},
	  {"op":"delete_arc","source":"p1","target":"t1"}
	]}`)
	sum := got["summary"].(map[string]any)
	if sum["places"] != float64(2) || sum["transitions"] != float64(2) || sum["arcs"] != float64(4) {
		t.Fatalf("summary %v", sum)
	}
	if got["cid"] == nil || got["warning"] != nil {
		t.Fatalf("cid/warning: %v %v", got["cid"], got["warning"])
	}
	net := got["net"].(map[string]any)
	if net["name"] != "ring" || net["places"].(map[string]any)["done"] == nil {
		t.Fatalf("net %v", net)
	}
	// the edited net is analysable as is
	b, _ := json.Marshal(net)
	r := call(t, "pflow_reachability", `{"net":`+string(b)+`}`)
	if r["states"] != float64(3) {
		t.Fatalf("reachability %v", r)
	}

	// All or nothing, and the failing op is named.
	_, out := mcpCall(t, &Server{}, toolCall("pflow_edit", `{"net":`+ringNet+`,"ops":[{"op":"add_place","id":"x"},{"op":"add_arc","source":"p1","target":"p2"}]}`))
	res := out["result"].(map[string]any)
	if res["isError"] != true || !strings.Contains(res["content"].([]any)[0].(map[string]any)["text"].(string), "ops[1]") {
		t.Fatalf("expected ops[1] error: %v", res)
	}
	// editing leaves the argument alone and the capacity guard holds
	_, out = mcpCall(t, &Server{}, toolCall("pflow_edit", `{"net":`+ringNet+`,"ops":[{"op":"set_place","id":"p1","capacity":1}]}`))
	if out["result"].(map[string]any)["isError"] != true {
		t.Fatalf("2 tokens over capacity 1 should be refused: %v", out)
	}
}

func TestMCPRegistryAnalyses(t *testing.T) {
	n := `{"net":` + ringNet + `}`

	info := call(t, "pflow_info", n)
	if len(info["places"].([]any)) != 2 || info["enabled"].([]any)[0] != "t1" {
		t.Fatalf("info %v", info)
	}

	fire := call(t, "pflow_fire", `{"net":`+ringNet+`,"sequence":["t1","t1","t2"]}`)
	m := fire["marking"].(map[string]any)
	if fire["fired"] != true || m["p1"] != float64(1) || m["p2"] != float64(1) || fire["net"] == nil {
		t.Fatalf("fire %v", fire)
	}
	stuck := call(t, "pflow_fire", `{"net":`+ringNet+`,"sequence":["t2"]}`)
	if stuck["fired"] != false || stuck["failed_transition"] != "t2" {
		t.Fatalf("stuck %v", stuck)
	}

	val := call(t, "pflow_validate", `{"net":`+ringNet+`,"reachability":true}`)
	if val["valid"] != true || val["reachability"] == nil {
		t.Fatalf("validate %v", val)
	}

	ver := call(t, "pflow_verify", `{"net":`+ringNet+`,"properties":[{"kind":"deadlock-free"},{"kind":"bounded"},{"kind":"invariant","expr":"p1 + p2 == 2"},{"kind":"reachable","target":{"p2":2}}]}`)
	if ver["ok"] != true || ver["proved"] != float64(4) {
		t.Fatalf("verify %v", ver)
	}
	bad := call(t, "pflow_verify", `{"net":`+ringNet+`,"properties":[{"kind":"invariant","expr":"p1 == 2"}]}`)
	if bad["refuted"] != float64(1) {
		t.Fatalf("verify should refute: %v", bad)
	}

	inv := call(t, "pflow_invariants", n)
	if len(inv["p_invariants"].([]any)) != 1 || len(inv["t_invariants"].([]any)) != 1 || inv["p_invariants"].([]any)[0].(map[string]any)["equation"] != "p1 + p2 == 2" {
		t.Fatalf("invariants %v", inv)
	}

	inc := call(t, "pflow_incidence", n)
	if len(inc["matrix"].([]any)) != 2 {
		t.Fatalf("incidence %v", inc)
	}

	ssa := call(t, "pflow_ssa", `{"net":`+ringNet+`,"t_end":5,"runs":3,"points":6}`)
	if len(ssa["times"].([]any)) != 6 || len(ssa["series"].([]any)) != 2 {
		t.Fatalf("ssa %v", ssa)
	}
	again := call(t, "pflow_ssa", `{"net":`+ringNet+`,"t_end":5,"runs":3,"points":6}`)
	a, _ := json.Marshal(ssa)
	b, _ := json.Marshal(again)
	if string(a) != string(b) {
		t.Fatal("ssa is seeded; the same call must give the same answer")
	}

	scan := call(t, "pflow_rate_scan", `{"net":`+ringNet+`,"transition":"t1","from":0,"to":2,"steps":3,"t_end":5}`)
	if len(scan["scan"].([]any)) != 3 {
		t.Fatalf("scan %v", scan)
	}

	exp := call(t, "pflow_export", `{"net":`+ringNet+`,"format":"svg"}`)
	if !strings.Contains(exp["svg"].(string), "<svg") {
		t.Fatalf("export %v", exp)
	}
	if call(t, "pflow_export", n)["cid"] == nil {
		t.Fatal("json export carries the CID")
	}
}

func TestMCPResultSizeGuard(t *testing.T) {
	big := map[string]any{"series": map[string]any{"p": make([]float64, 80000)}, "note": strings.Repeat("x", 5000)}
	res := mcpResult(big)
	text := res["content"].([]map[string]any)[0]["text"].(string)
	if len(text) > mcpMaxResultBytes {
		t.Fatalf("%d bytes, over the limit", len(text))
	}
	env := res["structuredContent"].(map[string]any)
	if env["truncated"] != true || env["original_bytes"].(int) < mcpMaxResultBytes || !strings.Contains(env["note"].(string), "over the") {
		t.Fatalf("not marked truncated: %v", env["note"])
	}
	if !json.Valid([]byte(text)) {
		t.Fatal("a shrunk result stays valid JSON")
	}

	// a small result passes through untouched
	small := mcpResult(map[string]any{"a": 1})
	if small["structuredContent"].(map[string]any)["truncated"] != nil {
		t.Fatal("small results are not wrapped")
	}

	// an object too wide to shrink falls back to a cut preview, still under the limit
	wide := map[string]any{}
	for i := 0; i < 20000; i++ {
		wide[strings.Repeat("k", 10)+string(rune('a'+i%26))+strings.Repeat("z", i%7)+itoa(i)] = i
	}
	res = mcpResultLimit(wide, 50<<10)
	if l := len(res["content"].([]map[string]any)[0]["text"].(string)); l > 50<<10 {
		t.Fatalf("wide object: %d bytes", l)
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func TestMCPCallTimeout(t *testing.T) {
	old := mcpCallTimeout
	mcpCallTimeout = 20 * time.Millisecond
	defer func() { mcpCallTimeout = old }()
	slow := &mcpTool{Name: "slow", run: func(*Server, *http.Request, map[string]any) (any, error) {
		time.Sleep(500 * time.Millisecond)
		return map[string]any{}, nil
	}}
	_, err := callMCPTool(&Server{}, httptest.NewRequest("POST", "/mcp", nil), slow, nil)
	if err == nil || !strings.Contains(err.Error(), "gave up") {
		t.Fatalf("expected a timeout, got %v", err)
	}
}

func TestMCPSaveListedOnlyWithAToken(t *testing.T) {
	s := &Server{}
	names := func(hdr ...string) map[string]bool {
		_, out := mcpCall(t, s, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`, hdr...)
		seen := map[string]bool{}
		for _, raw := range out["result"].(map[string]any)["tools"].([]any) {
			seen[raw.(map[string]any)["name"].(string)] = true
		}
		return seen
	}
	if anon := names(); anon["pflow_save"] || !anon["pflow_check"] || len(anon) != len(allMCPTools())-1 {
		t.Fatalf("without a token: %v", anon)
	}
	if signed := names("Authorization", "bearer abc"); !signed["pflow_save"] || len(signed) != len(allMCPTools()) {
		t.Fatalf("with a token: %v", signed)
	}
	if names("Authorization", "Basic abc")["pflow_save"] {
		t.Fatal("a non-bearer Authorization is not a token")
	}
}

func TestMCPProtocolVersion(t *testing.T) {
	for req, want := range map[string]string{"2025-11-25": "2025-11-25", "2025-03-26": "2025-03-26", "2099-01-01": mcpProtocolVersion, "": mcpProtocolVersion} {
		_, out := mcpCall(t, &Server{}, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"`+req+`","capabilities":{}}}`)
		if got := out["result"].(map[string]any)["protocolVersion"]; got != want {
			t.Errorf("asked %q: answered %v, want %s", req, got, want)
		}
	}
}

func TestMCPBusyWhenSlotsAreFull(t *testing.T) {
	old := mcpQueueWait
	mcpQueueWait = 20 * time.Millisecond
	defer func() { mcpQueueWait = old }()
	for i := 0; i < mcpMaxConcurrentCalls; i++ {
		mcpSlots <- struct{}{}
	}
	quick := &mcpTool{Name: "quick", run: func(*Server, *http.Request, map[string]any) (any, error) { return map[string]any{}, nil }}
	_, err := callMCPTool(&Server{}, httptest.NewRequest("POST", "/mcp", nil), quick, nil)
	for i := 0; i < mcpMaxConcurrentCalls; i++ {
		<-mcpSlots
	}
	if err == nil || !strings.Contains(err.Error(), "busy") {
		t.Fatalf("expected busy, got %v", err)
	}
	if _, err := callMCPTool(&Server{}, httptest.NewRequest("POST", "/mcp", nil), quick, nil); err != nil {
		t.Fatalf("a free slot runs the call: %v", err)
	}
	if len(mcpSlots) != 0 {
		t.Fatalf("%d slot(s) still held after the call", len(mcpSlots))
	}
}
