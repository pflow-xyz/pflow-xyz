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
	if len(tools) != 7 {
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
}
