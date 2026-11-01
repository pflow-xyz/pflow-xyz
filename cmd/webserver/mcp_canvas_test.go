package main

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func mcpRPC(t *testing.T, method, params string) map[string]any {
	t.Helper()
	_, out := mcpCall(t, &Server{}, `{"jsonrpc":"2.0","id":1,"method":"`+method+`","params":`+params+`}`)
	return out
}

func TestCanvasIsAnMCPApp(t *testing.T) {
	init := mcpRPC(t, "initialize", `{"protocolVersion":"2025-06-18"}`)["result"].(map[string]any)
	caps := init["capabilities"].(map[string]any)
	if _, ok := caps["resources"]; !ok {
		t.Error("initialize does not declare resources")
	}
	ext, _ := caps["extensions"].(map[string]any)
	ui, _ := ext["io.modelcontextprotocol/ui"].(map[string]any)
	if mimes, _ := ui["mimeTypes"].([]any); len(mimes) != 1 || mimes[0] != "text/html;profile=mcp-app" {
		t.Errorf("the UI extension is not declared: %v", caps)
	}

	var canvas map[string]any
	for _, x := range mcpRPC(t, "tools/list", `{}`)["result"].(map[string]any)["tools"].([]any) {
		if d := x.(map[string]any); d["name"] == "pflow_canvas" {
			canvas = d
		} else if _, has := d["_meta"]; has {
			t.Errorf("%s has _meta; only the canvas opens a UI", d["name"])
		}
	}
	if canvas == nil {
		t.Fatal("pflow_canvas is not listed")
	}
	meta := canvas["_meta"].(map[string]any)
	uri := meta["ui"].(map[string]any)["resourceUri"].(string)
	if uri != "ui://pflow/canvas" || meta["ui/resourceUri"] != uri {
		t.Errorf("_meta %v", meta)
	}
	if a := canvas["annotations"].(map[string]any); a["readOnlyHint"] != true || a["destructiveHint"] != false {
		t.Errorf("annotations %v", a)
	}

	resources := mcpRPC(t, "resources/list", `{}`)["result"].(map[string]any)["resources"].([]any)
	if len(resources) != 1 || resources[0].(map[string]any)["uri"] != uri {
		t.Errorf("resources/list %v", resources)
	}
	read := mcpRPC(t, "resources/read", `{"uri":"`+uri+`"}`)["result"].(map[string]any)["contents"].([]any)[0].(map[string]any)
	if read["mimeType"] != "text/html;profile=mcp-app" || !strings.Contains(read["text"].(string), "ui/initialize") {
		t.Errorf("resources/read: mime %v", read["mimeType"])
	}
	// A wrong domain fails hard in Claude, and the page needs no CSP exception.
	ui2 := read["_meta"].(map[string]any)["ui"].(map[string]any)
	for _, k := range []string{"domain", "csp"} {
		if _, has := ui2[k]; has {
			t.Errorf("the resource sets ui.%s", k)
		}
	}

	if out := mcpRPC(t, "resources/read", `{"uri":"ui://pflow/nope"}`); out["error"] == nil {
		t.Errorf("an unknown resource was served: %v", out)
	}
}

// The page must run under a host's default sandbox: inline script and style, no
// other origin, no WebAssembly. These would all fail there, some only in a host.
func TestCanvasPageIsSelfContained(t *testing.T) {
	stripped := strings.ReplaceAll(canvasHTML, "http://www.w3.org/2000/svg", "")
	for _, re := range []string{
		`https?://`, `//[a-z0-9.-]+\.[a-z]{2,}/`,
		`(?i)<script[^>]+src=`, `(?i)<link[^>]+href=`, `@import`, `url\(`,
		`\bfetch\(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebAssembly`, `\beval\(`, `new Function`,
		`localStorage`, `sessionStorage`, `indexedDB`, `\balert\(`, `\bconfirm\(`,
		`\.innerHTML`, `\.outerHTML`, `insertAdjacentHTML`, `document\.write`,
	} {
		if m := regexp.MustCompile(re).FindString(stripped); m != "" {
			t.Errorf("mcpapp/canvas.html contains %q", m)
		}
	}
}

func canvasCall(t *testing.T, args string) (map[string]any, map[string]any) {
	t.Helper()
	_, out := mcpCall(t, &Server{}, toolCall("pflow_canvas", args))
	r := out["result"].(map[string]any)
	if r["isError"] == true {
		return nil, r
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(r["content"].([]any)[0].(map[string]any)["text"].(string)), &v); err != nil {
		t.Fatal(err)
	}
	return v, r
}

func TestCanvasToolResults(t *testing.T) {
	v, _ := canvasCall(t, `{}`)
	if v == nil {
		t.Fatal("the default canvas failed")
	}
	if b := v["bundle"].(map[string]any); len(b["subnets"].([]any)) != 3 || len(b["links"].([]any)) != 3 {
		t.Errorf("default bundle %v", b)
	}
	if len(v["scenarios"].([]any)) != 4 || len(v["catalog"].([]any)) == 0 {
		t.Errorf("scenarios or catalog missing: %v", v)
	}
	if val := v["validation"].(map[string]any); val["valid"] != true {
		t.Errorf("validation %v", val)
	}

	// A composition in the call comes back as given, judged, with no catalog.
	b, _ := json.Marshal(v["bundle"])
	own, _ := canvasCall(t, `{"bundle":`+string(b)+`}`)
	if own == nil || own["catalog"] != nil || own["validation"] == nil {
		t.Errorf("own bundle: %v", own)
	}

	part, _ := canvasCall(t, `{"instances":["orders"],"links":[]}`)
	if part == nil || len(part["bundle"].(map[string]any)["subnets"].([]any)) != 1 || len(part["scenarios"].([]any)) != 0 {
		t.Errorf("one instance: %v", part)
	}

	// Every catalog part at once still fits one untruncated result, which the page needs whole.
	all, r := canvasCall(t, `{"instances":["orders","workers","payment","orders2","workers2","payment2"]}`)
	if all == nil || all["truncated"] != nil {
		t.Errorf("all parts: %v", r)
	}

	for _, bad := range []string{`{"instances":["nope"]}`, `{"nope":1}`, `{"bundle":{"@type":"PetriNetBundle"},"instances":["orders"]}`} {
		if v, r := canvasCall(t, bad); v != nil {
			t.Errorf("%s was accepted: %v", bad, r)
		}
	}
}
