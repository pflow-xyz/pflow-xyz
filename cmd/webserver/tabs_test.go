package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/tabhub"
	"github.com/pflow-xyz/pflow-xyz/internal/userfiles"
)

// tabServer is a server with tab push on: pages sign in with filesVerifier's
// accounts (alice 1001, bob 1002), and so does the MCP side.
func tabServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	s, _ := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	s.mcpVerifier = filesVerifier{}
	s.storage = NewFSStorage(t.TempDir())
	s.configureTabs(func(k string) string {
		if k == "PFLOW_TAB_PUSH" {
			return "1"
		}
		return ""
	}, false)
	t.Cleanup(func() { setTabPush(false) })
	s.tabs.ping = 50 * time.Millisecond
	s.tabs.replyWait = 300 * time.Millisecond // a fake page that answers does so at once; one that does not costs this much per push
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return s, srv
}

func httpJSON(t *testing.T, method, url, token, body string, hdr ...string) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest(method, url, strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var out map[string]any
	json.Unmarshal(b, &out)
	return resp.StatusCode, out
}

func newTab(t *testing.T, srv *httptest.Server, token string) string {
	t.Helper()
	code, out := httpJSON(t, "POST", srv.URL+"/api/tab", token, "")
	if code != 200 {
		t.Fatalf("create tab: %d %v", code, out)
	}
	return out["id"].(string)
}

// frames reads SSE frames from a stream onto a channel.
func frames(t *testing.T, srv *httptest.Server, token, id string) (<-chan map[string]any, func()) {
	t.Helper()
	req, _ := http.NewRequest("GET", srv.URL+"/api/tab/"+id+"/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("stream: %d %s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	ch := make(chan map[string]any, 64)
	go func() {
		defer close(ch)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 1<<20), 1<<20)
		var name string
		for sc.Scan() {
			line := sc.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				name = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				var m map[string]any
				json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &m)
				if m["type"] != name {
					t.Errorf("frame name %q vs type %v", name, m["type"])
				}
				ch <- m
			}
		}
	}()
	return ch, func() { resp.Body.Close() }
}

func next(t *testing.T, ch <-chan map[string]any, typ string) map[string]any {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m, ok := <-ch:
			if !ok {
				t.Fatalf("stream closed waiting for %s", typ)
			}
			if m["type"] == typ {
				return m
			}
		case <-deadline:
			t.Fatalf("no %s frame", typ)
		}
	}
}

func tabTool(t *testing.T, srv *httptest.Server, token, name, args string) (map[string]any, bool) {
	t.Helper()
	hdr := []string{}
	code, out := httpJSON(t, "POST", srv.URL+"/mcp", token, toolCall(name, args), hdr...)
	if code != 200 {
		t.Fatalf("%s: HTTP %d %v", name, code, out)
	}
	res, _ := out["result"].(map[string]any)
	if res == nil {
		t.Fatalf("%s: %v", name, out)
	}
	if res["isError"] == true {
		return map[string]any{"error": res["content"].([]any)[0].(map[string]any)["text"]}, true
	}
	return res["structuredContent"].(map[string]any), false
}

func TestTabPushOffChangesNothing(t *testing.T) {
	s := &Server{}
	s.configureTabs(func(k string) string {
		if k == "PFLOW_TAB_PUSH" {
			return "0"
		}
		return ""
	}, false)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, httptest.NewRequest("GET", "/api/tab/status", nil))
	var st map[string]any
	json.Unmarshal(rec.Body.Bytes(), &st)
	if rec.Code != 200 || st["enabled"] != false {
		t.Fatalf("status: %d %s", rec.Code, rec.Body)
	}
	for _, rt := range [][2]string{{"POST", "/api/tab"}, {"GET", "/api/tab/x/events"}, {"POST", "/api/tab/x/report"}} {
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, httptest.NewRequest(rt[0], rt[1], strings.NewReader("{}")))
		if rec.Code != 404 {
			t.Fatalf("%v with the flag off: %d", rt, rec.Code)
		}
	}
	for _, tl := range allMCPTools() {
		if tabToolNames[tl.Name] {
			t.Fatalf("%s listed with the flag off", tl.Name)
		}
	}
	_, out := mcpCall(t, s, toolCall("pflow_show", `{"view":"canvas"}`))
	if out["error"] == nil {
		t.Fatalf("pflow_show callable with the flag off: %v", out)
	}
}

func TestTabToolsListedAndAnnotatedWhenOn(t *testing.T) {
	_, srv := tabServer(t)
	_, out := httpJSON(t, "POST", srv.URL+"/mcp", "alice", `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	seen := map[string]bool{}
	for _, x := range out["result"].(map[string]any)["tools"].([]any) {
		seen[x.(map[string]any)["name"].(string)] = true
	}
	for n := range tabToolNames {
		if !seen[n] {
			t.Errorf("%s not listed", n)
		}
		if _, ok := mcpAnnotations[n]; !ok {
			t.Errorf("%s not annotated", n)
		}
	}
}

func TestTabPageAndMCPShareTheAccount(t *testing.T) {
	_, srv := tabServer(t)
	alice := newTab(t, srv, "alice")
	ch, closeStream := frames(t, srv, "alice", alice)
	defer closeStream()
	hello := next(t, ch, "hello")
	if hello["tab"] != alice || len(hello["views"].([]any)) != len(tabViews) {
		t.Fatalf("hello: %v", hello)
	}

	// pflow_tabs: alice sees her tab, bob sees none
	out, isErr := tabTool(t, srv, "alice", "pflow_tabs", `{}`)
	tabs := out["tabs"].([]any)
	if isErr || len(tabs) != 1 || tabs[0].(map[string]any)["id"] != alice || tabs[0].(map[string]any)["connected"] != true {
		t.Fatalf("alice's tabs: %v", out)
	}
	out, _ = tabTool(t, srv, "bob", "pflow_tabs", `{}`)
	if out["tabs"] != nil && len(out["tabs"].([]any)) != 0 || out["note"] == nil {
		t.Fatalf("bob's tabs: %v", out)
	}

	// a private push carries the net in the event and answers sent
	out, isErr = tabTool(t, srv, "alice", "pflow_show", `{"view":"plot","net":`+mcpNet+`,"params":{"t_end":5},"note":"look"}`)
	if isErr || out["sent"] != true || out["tabs"] != float64(1) || out["private"] != true {
		t.Fatalf("show: %v", out)
	}
	ev := next(t, ch, "show")
	if ev["view"] != "plot" || ev["net"] == nil || ev["cid"] != nil || ev["note"] != "look" || ev["params"].(map[string]any)["t_end"] != float64(5) {
		t.Fatalf("show event: %v", ev)
	}

	// bob cannot drive alice's tab, and learns nothing about it
	out, isErr = tabTool(t, srv, "bob", "pflow_show", `{"view":"canvas","net":`+mcpNet+`,"tab":"`+alice+`"}`)
	if !isErr || !strings.Contains(out["error"].(string), "no such tab") {
		t.Fatalf("bob: %v", out)
	}
	out, _ = tabTool(t, srv, "bob", "pflow_show", `{"view":"canvas","net":`+mcpNet+`}`)
	if out["sent"] != false || out["tabs"] != float64(0) {
		t.Fatalf("bob with no tabs: %v", out)
	}
	select {
	case m := <-ch:
		if m["type"] != "ping" {
			t.Fatalf("alice's stream got bob's push: %v", m)
		}
	case <-time.After(10 * time.Millisecond):
	}

	// stop
	out, _ = tabTool(t, srv, "alice", "pflow_tab_stop", `{}`)
	if out["sent"] != true {
		t.Fatalf("stop: %v", out)
	}
	next(t, ch, "stop")
}

func TestTabGetRoundTripThroughThePage(t *testing.T) {
	_, srv := tabServer(t)
	id := newTab(t, srv, "alice")
	ch, closeStream := frames(t, srv, "alice", id)
	defer closeStream()
	next(t, ch, "hello")
	var asked atomic.Int32
	go func() {
		get := next(t, ch, "get")
		asked.Add(1)
		code, _ := httpJSON(t, "POST", srv.URL+"/api/tab/"+id+"/reply", "alice", `{"request_id":"`+get["request_id"].(string)+`","state":{"view":"reachability","places":2}}`)
		if code != 204 {
			t.Errorf("reply: %d", code)
		}
	}()
	out, isErr := tabTool(t, srv, "alice", "pflow_tab_get", `{}`)
	if isErr || out["fresh"] != true || out["tab"] != id || out["report"].(map[string]any)["view"] != "reachability" {
		t.Fatalf("get: %v", out)
	}
	// a fresh report is answered without asking the page again
	httpJSON(t, "POST", srv.URL+"/api/tab/"+id+"/report", "alice", `{"view":"canvas"}`)
	out, _ = tabTool(t, srv, "alice", "pflow_tab_get", `{}`)
	if out["report"].(map[string]any)["view"] != "canvas" || asked.Load() != 1 {
		t.Fatalf("fresh get: %v asked=%d", out, asked.Load())
	}
}

func TestTabShowByCIDAndRefusals(t *testing.T) {
	s, srv := tabServer(t)
	id := newTab(t, srv, "alice")
	ch, closeStream := frames(t, srv, "alice", id)
	defer closeStream()
	next(t, ch, "hello")
	cid := "bafytestcid"
	if err := s.storage.SaveObject(cid, []byte(mcpNet), []byte("x")); err != nil {
		t.Fatal(err)
	}
	out, isErr := tabTool(t, srv, "alice", "pflow_show", `{"view":"reachability","cid":"`+cid+`","params":{"max_states":500}}`)
	if isErr || out["private"] != false {
		t.Fatalf("by cid: %v", out)
	}
	ev := next(t, ch, "show")
	if ev["cid"] != cid || ev["net"] == nil {
		t.Fatalf("cid event: %v", ev)
	}
	refusals := map[string]string{
		`{"view":"plot"}`: "exactly one",
		`{"view":"plot","net":` + mcpNet + `,"cid":"` + cid + `"}`:                          "exactly one",
		`{"view":"nope","net":` + mcpNet + `}`:                                              "view:",
		`{"view":"plot","net":` + mcpNet + `,"params":{"t_end":-1}}`:                        "params.t_end",
		`{"view":"plot","net":` + mcpNet + `,"params":{"max_states":5}}`:                    "not a parameter",
		`{"view":"plot","net":` + mcpNet + `,"params":{"engine":"magic"}}`:                  "params.engine",
		`{"view":"categorical","net":` + mcpNet + `}`:                                       "stored composition",
		`{"view":"categorical","cid":"` + cid + `"}`:                                        "is a net",
		`{"view":"plot","cid":"missing"}`:                                                   "no model",
		`{"view":"plot","net":{"places":[]}}`:                                               "net.places",
		`{"view":"invariants","net":` + mcpNet + `,"params":{"kind":"x"}}`:                  "params.kind",
		`{"view":"canvas","net":` + mcpNet + `,"note":"` + strings.Repeat("n", 1001) + `"}`: "note",
	}
	for args, want := range refusals {
		out, isErr := tabTool(t, srv, "alice", "pflow_show", args)
		if !isErr || !strings.Contains(out["error"].(string), want) {
			t.Errorf("%s: want error containing %q, got %v", args, want, out)
		}
	}
	select {
	case m := <-ch:
		if m["type"] != "ping" {
			t.Fatalf("a refused push reached the page: %v", m)
		}
	case <-time.After(10 * time.Millisecond):
	}
}

func TestTabPageRoutesNeedSignInAndSameOrigin(t *testing.T) {
	_, srv := tabServer(t)
	if code, _ := httpJSON(t, "POST", srv.URL+"/api/tab", "", ""); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := httpJSON(t, "POST", srv.URL+"/api/tab", "forged", ""); code != 401 {
		t.Fatalf("forged: %d", code)
	}
	if code, _ := httpJSON(t, "POST", srv.URL+"/api/tab", "alice", "", "Sec-Fetch-Site", "cross-site"); code != 403 {
		t.Fatalf("cross-site: %d", code)
	}
	id := newTab(t, srv, "alice")
	// bob cannot report into, subscribe to or drop alice's tab
	if code, _ := httpJSON(t, "POST", srv.URL+"/api/tab/"+id+"/report", "bob", `{}`); code != 404 {
		t.Fatalf("bob report: %d", code)
	}
	if code, _ := httpJSON(t, "GET", srv.URL+"/api/tab/"+id+"/events", "bob", ""); code != 404 {
		t.Fatalf("bob events: %d", code)
	}
	if code, _ := httpJSON(t, "DELETE", srv.URL+"/api/tab/"+id, "bob", ""); code != 404 {
		t.Fatalf("bob delete: %d", code)
	}
	if code, _ := httpJSON(t, "POST", srv.URL+"/api/tab/"+id+"/report", "alice", `{not json`); code != 400 {
		t.Fatalf("bad report: %d", code)
	}
	big := `{"x":"` + strings.Repeat("a", tabhub.MaxReportBytes) + `"}`
	if code, _ := httpJSON(t, "POST", srv.URL+"/api/tab/"+id+"/report", "alice", big); code != 413 {
		t.Fatalf("big report: %d", code)
	}
	if code, _ := httpJSON(t, "POST", srv.URL+"/api/tab/"+id+"/reply", "alice", `{"state":{}}`); code != 400 {
		t.Fatalf("reply without request_id: %d", code)
	}
	if code, _ := httpJSON(t, "DELETE", srv.URL+"/api/tab/"+id, "alice", ""); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	code, st := httpJSON(t, "GET", srv.URL+"/api/tab/status", "", "")
	if code != 200 || st["enabled"] != true {
		t.Fatalf("status: %d %v", code, st)
	}
}

func TestTabMCPNeedsSignIn(t *testing.T) {
	_, srv := tabServer(t)
	out, isErr := tabTool(t, srv, "", "pflow_tabs", `{}`)
	if !isErr || !strings.Contains(out["error"].(string), "signed in") {
		t.Fatalf("unsigned: %v", out)
	}
	out, isErr = tabTool(t, srv, "forged", "pflow_tabs", `{}`)
	if !isErr || !strings.Contains(out["error"].(string), "not accepted") {
		t.Fatalf("forged: %v", out)
	}
}

func TestTabPushAnswersZeroWhenNoStream(t *testing.T) {
	_, srv := tabServer(t)
	newTab(t, srv, "alice") // registered, never subscribed
	out, _ := tabTool(t, srv, "alice", "pflow_show", `{"view":"canvas","net":`+mcpNet+`}`)
	if out["sent"] != false || !strings.Contains(out["note"].(string), "nothing was sent") {
		t.Fatalf("%v", out)
	}
	out, isErr := tabTool(t, srv, "alice", "pflow_tab_get", `{}`)
	if !isErr || !strings.Contains(out["error"].(string), "no open stream") {
		t.Fatalf("get with no stream and no report: %v", out)
	}
}
