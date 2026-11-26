package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// The tab push tools have their own OAuth scope, pflow:tabs, separate from
// pflow:save (docs/design/tab-push.md, taste call 6).

// scopeServer is the OAuth test server with tab push on.
func scopeServer(t *testing.T) *Server {
	t.Helper()
	s, _ := oauthServer(t)
	s.configureTabs(func(k string) string {
		if k == "PFLOW_TAB_PUSH" {
			return "1"
		}
		return ""
	}, false)
	t.Cleanup(func() { setTabPush(false) })
	return s
}

func mcpPost(t *testing.T, s *Server, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return serve(t, s, req)
}

func scopeOf(tok map[string]any) string { s, _ := tok["scope"].(string); return s }

func TestTabScopeAdvertisedInMetadata(t *testing.T) {
	s := scopeServer(t)
	for _, p := range []string{protectedMetaPath + "/mcp", authServerMetaPath} {
		rec := serve(t, s, httptest.NewRequest("GET", p, nil))
		var m map[string]any
		json.Unmarshal(rec.Body.Bytes(), &m)
		got := m["scopes_supported"].([]any)
		if len(got) != 2 || got[0] != mcpScopeSave || got[1] != mcpScopeTabs {
			t.Fatalf("%s scopes_supported with tab push on: %v", p, got)
		}
	}
	// With tab push off the scope is not advertised: there is no tool for it to gate.
	setTabPush(false)
	for _, p := range []string{protectedMetaPath + "/mcp", authServerMetaPath} {
		rec := serve(t, s, httptest.NewRequest("GET", p, nil))
		var m map[string]any
		json.Unmarshal(rec.Body.Bytes(), &m)
		if got := m["scopes_supported"].([]any); len(got) != 1 || got[0] != mcpScopeSave {
			t.Fatalf("%s scopes_supported with tab push off: %v", p, got)
		}
	}
}

func TestTabScopeGrantedOnlyWhenAsked(t *testing.T) {
	s := scopeServer(t)
	if got := scopeOf(signInScope(t, s, "github", "gh-code", mcpScopeSave)); got != mcpScopeSave {
		t.Fatalf("save only: %q", got)
	}
	if got := scopeOf(signInScope(t, s, "github", "gh-code", "")); got != mcpScopeSave {
		t.Fatalf("no scope asked keeps the old default: %q", got)
	}
	if got := scopeOf(signInScope(t, s, "github", "gh-code", mcpScopeTabs+" "+mcpScopeSave+" offline_access")); got != mcpScopeSave+" "+mcpScopeTabs {
		t.Fatalf("both: %q", got)
	}
	if got := scopeOf(signInScope(t, s, "github", "gh-code", mcpScopeTabs)); got != mcpScopeTabs {
		t.Fatalf("tabs only: %q", got)
	}
}

func TestTabScopeRefusedByAuthorizeWhenOffOrUnknown(t *testing.T) {
	s := scopeServer(t)
	authorize := func(scope string) string {
		const redirect = "https://claude.ai/api/mcp/auth_callback"
		rec := serve(t, s, httptest.NewRequest("POST", mcpRegisterPath, strings.NewReader(`{"redirect_uris":["`+redirect+`"],"client_name":"Claude"}`)))
		var reg map[string]any
		json.Unmarshal(rec.Body.Bytes(), &reg)
		_, challenge := pkce()
		q := url.Values{"response_type": {"code"}, "client_id": {reg["client_id"].(string)}, "redirect_uri": {redirect}, "code_challenge": {challenge},
			"code_challenge_method": {"S256"}, "state": {"xyz"}, "scope": {scope}, "resource": {testOrigin + "/mcp"}}
		rec = serve(t, s, httptest.NewRequest("GET", mcpAuthorizePath+"?"+q.Encode(), nil))
		if rec.Code == 302 {
			u, _ := url.Parse(rec.Header().Get("Location"))
			return u.Query().Get("error")
		}
		return rec.Body.String()
	}
	if got := authorize("pflow:admin"); got != "invalid_scope" {
		t.Fatalf("unknown scope: %q", got)
	}
	setTabPush(false)
	if got := authorize(mcpScopeTabs); got != "invalid_scope" {
		t.Fatalf("pflow:tabs with tab push off: %q", got)
	}
}

func TestTabScopeConsentNamesWhatIsAsked(t *testing.T) {
	s := scopeServer(t)
	consent := func(scope string) string {
		const redirect = "https://claude.ai/api/mcp/auth_callback"
		rec := serve(t, s, httptest.NewRequest("POST", mcpRegisterPath, strings.NewReader(`{"redirect_uris":["`+redirect+`"],"client_name":"Claude"}`)))
		var reg map[string]any
		json.Unmarshal(rec.Body.Bytes(), &reg)
		_, challenge := pkce()
		q := url.Values{"response_type": {"code"}, "client_id": {reg["client_id"].(string)}, "redirect_uri": {redirect}, "code_challenge": {challenge},
			"code_challenge_method": {"S256"}, "scope": {scope}, "resource": {testOrigin + "/mcp"}}
		return serve(t, s, httptest.NewRequest("GET", mcpAuthorizePath+"?"+q.Encode(), nil)).Body.String()
	}
	if c := consent(mcpScopeSave); !strings.Contains(c, "save Petri nets") || strings.Contains(c, "pages you have linked") {
		t.Fatalf("save-only consent: %s", c)
	}
	if c := consent(mcpScopeTabs); strings.Contains(c, "save Petri nets") || !strings.Contains(c, "pages you have linked") {
		t.Fatalf("tabs-only consent: %s", c)
	}
	if c := consent(mcpScopeSave + " " + mcpScopeTabs); !strings.Contains(c, "save Petri nets") || !strings.Contains(c, "pages you have linked") {
		t.Fatalf("both consent: %s", c)
	}
}

func TestTabToolsNeedTheTabsScope(t *testing.T) {
	s := scopeServer(t)
	saveOnly := signInScope(t, s, "github", "gh-code", mcpScopeSave)["access_token"].(string)

	for name := range tabToolNames {
		rec := mcpPost(t, s, saveOnly, toolCall(name, `{}`))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s with a pflow:save token: %d %s", name, rec.Code, rec.Body)
		}
		h := rec.Header().Get("WWW-Authenticate")
		if !strings.Contains(h, `error="insufficient_scope"`) || !strings.Contains(h, `scope="pflow:save pflow:tabs"`) ||
			!strings.Contains(h, `resource_metadata="`+testOrigin+protectedMetaPath+`/mcp"`) {
			t.Fatalf("%s challenge: %q", name, h)
		}
		var body map[string]string
		json.Unmarshal(rec.Body.Bytes(), &body)
		if body["error"] != "insufficient_scope" {
			t.Fatalf("%s body: %s", name, rec.Body)
		}
	}
	// in a batch too, and the open tool next to it does not rescue the call
	if rec := mcpPost(t, s, saveOnly, `[`+toolCall("pflow_check", `{"net":`+mcpNet+`}`)+`,`+toolCall("pflow_tabs", `{}`)+`]`); rec.Code != http.StatusForbidden {
		t.Fatalf("batch: %d", rec.Code)
	}
	// the token still does what it did: save and the open tools
	if res := saveWith(t, s, saveOnly); res["cid"] == nil {
		t.Fatalf("save with the old scope: %v", res)
	}
	if rec := mcpPost(t, s, saveOnly, toolCall("pflow_check", `{"net":`+mcpNet+`}`)); rec.Code != 200 {
		t.Fatalf("open tool: %d", rec.Code)
	}
}

func TestTabToolsAllowedWithTheTabsScope(t *testing.T) {
	s := scopeServer(t)
	both := signInScope(t, s, "github", "gh-code", mcpScopeSave+" "+mcpScopeTabs)["access_token"].(string)
	rec := mcpPost(t, s, both, toolCall("pflow_tabs", `{}`))
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	if rec.Code != 200 || out["error"] != nil || out["result"].(map[string]any)["isError"] == true {
		t.Fatalf("pflow_tabs with pflow:tabs: %d %s", rec.Code, rec.Body)
	}
	if res := saveWith(t, s, both); res["cid"] == nil {
		t.Fatalf("save with both: %v", res)
	}

	// pflow:tabs alone drives pages but does not save
	tabsOnly := signInScope(t, s, "github", "gh-code", mcpScopeTabs)["access_token"].(string)
	if rec := mcpPost(t, s, tabsOnly, toolCall("pflow_tabs", `{}`)); rec.Code != 200 {
		t.Fatalf("pflow_tabs with a tabs-only token: %d %s", rec.Code, rec.Body)
	}
	rec = mcpPost(t, s, tabsOnly, toolCall("pflow_save", `{"net":`+mcpNet+`}`))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Header().Get("WWW-Authenticate"), `scope="pflow:save pflow:tabs"`) {
		t.Fatalf("save with a tabs-only token: %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
}

func TestTabScopeUnsignedAsksForIt(t *testing.T) {
	s := scopeServer(t)
	rec := mcpPost(t, s, "", toolCall("pflow_show", `{"view":"canvas"}`))
	h := rec.Header().Get("WWW-Authenticate")
	if rec.Code != 401 || !strings.Contains(h, `scope="pflow:tabs"`) || strings.Contains(h, "pflow:save") {
		t.Fatalf("unsigned tab call: %d %q", rec.Code, h)
	}
	// a call that needs both asks for both
	rec = mcpPost(t, s, "", `[`+toolCall("pflow_save", `{}`)+`,`+toolCall("pflow_tabs", `{}`)+`]`)
	if h := rec.Header().Get("WWW-Authenticate"); rec.Code != 401 || !strings.Contains(h, `scope="pflow:save pflow:tabs"`) {
		t.Fatalf("unsigned batch: %d %q", rec.Code, h)
	}
}

func TestTabScopeSurvivesRefresh(t *testing.T) {
	s := scopeServer(t)
	tok := signInScope(t, s, "github", "gh-code", mcpScopeSave+" "+mcpScopeTabs)
	// A refresh token issued with pflow:save alone must not turn into one with pflow:tabs.
	old := signInScope(t, s, "github", "gh-code", mcpScopeSave)
	for _, c := range []struct {
		tok  map[string]any
		want string
	}{{tok, "pflow:save pflow:tabs"}, {old, "pflow:save"}} {
		got := tokenCall(t, s, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.tok["refresh_token"].(string)}})
		if scopeOf(got) != c.want {
			t.Fatalf("refresh kept %q, want %q (%v)", scopeOf(got), c.want, got)
		}
	}
}

func TestTabScopeTokensFromBeforeTheScopeStillSave(t *testing.T) {
	s := scopeServer(t)
	// A token signed before scopes were granted one at a time has no scope
	// claim; every such token was pflow:save.
	legacy := s.mcpOAuth.sign("pfa", accessClaims{mcpIdentity: mcpIdentity{Provider: "github", ID: "42", Name: "octo"}, Aud: testOrigin + "/mcp", Exp: s.mcpOAuth.now().Unix() + 600})
	if res := saveWith(t, s, legacy); res["cid"] == nil {
		t.Fatalf("legacy token cannot save: %v", res)
	}
	if rec := mcpPost(t, s, legacy, toolCall("pflow_tabs", `{}`)); rec.Code != http.StatusForbidden {
		t.Fatalf("legacy token drives tabs: %d", rec.Code)
	}
}

func TestTabScopeBareGitHubTokenIsNotScoped(t *testing.T) {
	// A bare GitHub token is the person's own credential, not a granted
	// scope: it keeps working for tab push as it did before.
	s := scopeServer(t)
	s.mcpVerifier = filesVerifier{}
	if rec := mcpPost(t, s, "alice", toolCall("pflow_tabs", `{}`)); rec.Code != 200 {
		t.Fatalf("bare GitHub token: %d %s", rec.Code, rec.Body)
	}
}

func TestTabScopeOffMeansNoGate(t *testing.T) {
	s, _ := oauthServer(t)
	if need := requiredScopes([]byte(toolCall("pflow_tabs", `{}`))); len(need) != 0 {
		t.Fatalf("with tab push off pflow_tabs needs %v", need)
	}
	saveOnly := signIn(t, s, "github", "gh-code")["access_token"].(string)
	rec := mcpPost(t, s, saveOnly, toolCall("pflow_tabs", `{}`))
	if rec.Code != 200 {
		t.Fatalf("tab tool with tab push off: %d (must be the old not-turned-on answer, not 403)", rec.Code)
	}
}
