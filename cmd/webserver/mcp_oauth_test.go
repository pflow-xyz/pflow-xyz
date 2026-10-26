package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/auth"
)

const testOrigin = "https://pflow.test"

// fakeProviders answers as GitHub (token exchange and /user) and Google
// (token exchange and userinfo).
func fakeProviders(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/gh/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.PostForm.Get("code") != "gh-code" || r.PostForm.Get("client_secret") != "gh-secret" {
			writeJSON(w, 200, map[string]string{"error": "bad_verification_code"})
			return
		}
		writeJSON(w, 200, map[string]string{"access_token": "gh-token"})
	})
	mux.HandleFunc("/user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer gh-token" {
			w.WriteHeader(401)
			return
		}
		writeJSON(w, 200, map[string]any{"id": 42, "login": "octo"})
	})
	mux.HandleFunc("/g/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.PostForm.Get("code") != "g-code" || r.PostForm.Get("grant_type") != "authorization_code" {
			w.WriteHeader(400)
			writeJSON(w, 400, map[string]string{"error": "invalid_grant"})
			return
		}
		writeJSON(w, 200, map[string]string{"access_token": "g-token"})
	})
	mux.HandleFunc("/g/userinfo", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer g-token" {
			w.WriteHeader(401)
			return
		}
		writeJSON(w, 200, map[string]any{"sub": "g-123"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func oauthServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	fake := fakeProviders(t)
	env := map[string]string{
		"GITHUB_CLIENT_ID": "gh-id", "GITHUB_CLIENT_SECRET": "gh-secret",
		"GOOGLE_CLIENT_ID": "g-id", "GOOGLE_CLIENT_SECRET": "g-secret",
		"MCP_PUBLIC_URL": testOrigin,
	}
	dir := t.TempDir()
	o := newMCPOAuth(func(k string) string { return env[k] }, dir)
	if o == nil {
		t.Fatal("OAuth should be on with both providers configured")
	}
	gh, g := o.provider("github"), o.provider("google")
	gh.authURL, gh.tokenURL = fake.URL+"/gh/authorize", fake.URL+"/gh/token"
	g.authURL, g.tokenURL, g.userURL = fake.URL+"/g/authorize", fake.URL+"/g/token", fake.URL+"/g/userinfo"
	o.github = &auth.GitHubVerifier{Client: fake.Client(), BaseURL: fake.URL}
	return &Server{storage: NewFSStorage(filepath.Join(dir, "store")), mcpOAuth: o}, fake
}

func serve(t *testing.T, s *Server, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func pkce() (verifier, challenge string) {
	verifier = strings.Repeat("v", 50)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// signIn runs register → authorize → provider → callback → token and returns
// the token response.
func signIn(t *testing.T, s *Server, provider, providerCode string) map[string]any {
	t.Helper()
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	rec := serve(t, s, httptest.NewRequest("POST", mcpRegisterPath, strings.NewReader(`{"redirect_uris":["`+redirect+`"],"client_name":"Claude"}`)))
	if rec.Code != 201 {
		t.Fatalf("register: %d %s", rec.Code, rec.Body)
	}
	var reg map[string]any
	json.Unmarshal(rec.Body.Bytes(), &reg)
	clientID := reg["client_id"].(string)

	verifier, challenge := pkce()
	q := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "code_challenge": {challenge},
		"code_challenge_method": {"S256"}, "state": {"xyz"}, "scope": {mcpScopeSave}, "resource": {testOrigin + "/mcp"}}
	rec = serve(t, s, httptest.NewRequest("GET", mcpAuthorizePath+"?"+q.Encode(), nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Continue with GitHub") || !strings.Contains(rec.Body.String(), "Continue with Google") {
		t.Fatalf("consent page: %d %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), "claude.ai") || !strings.Contains(rec.Body.String(), testOrigin+"/terms.html") {
		t.Fatal("the consent page names the asking host and links the terms")
	}
	cookie := rec.Result().Cookies()[0]
	links := regexp.MustCompile(`href="(/auth/mcp/login\?req=[^"]+)"`).FindAllStringSubmatch(rec.Body.String(), -1)
	var login string
	for _, l := range links {
		u := html.UnescapeString(l[1])
		var p pendingRequest
		pu, _ := url.Parse(u)
		if s.mcpOAuth.open("pfp", pu.Query().Get("req"), &p) && p.Provider == provider {
			login = u
		}
	}
	if login == "" {
		t.Fatalf("no %s button", provider)
	}

	rec = serve(t, s, httptest.NewRequest("GET", login, nil))
	if rec.Code != 302 {
		t.Fatalf("login: %d", rec.Code)
	}
	to, _ := url.Parse(rec.Header().Get("Location"))
	if to.Query().Get("redirect_uri") != testOrigin+s.mcpOAuth.provider(provider).callbackPath {
		t.Fatalf("provider redirect_uri: %s", to)
	}

	cb := httptest.NewRequest("GET", s.mcpOAuth.provider(provider).callbackPath+"?"+url.Values{"code": {providerCode}, "state": {to.Query().Get("state")}}.Encode(), nil)
	cb.AddCookie(cookie)
	rec = serve(t, s, cb)
	back, _ := url.Parse(rec.Header().Get("Location"))
	if rec.Code != 302 || !strings.HasPrefix(back.String(), redirect) || back.Query().Get("state") != "xyz" || back.Query().Get("iss") != testOrigin {
		t.Fatalf("callback: %d %s", rec.Code, back)
	}
	code := back.Query().Get("code")
	if code == "" {
		t.Fatalf("no code: %s", back)
	}

	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {redirect}, "client_id": {clientID}, "code_verifier": {verifier}}
	tok := tokenCall(t, s, form)
	if tok["access_token"] == nil || tok["refresh_token"] == nil || tok["token_type"] != "Bearer" {
		t.Fatalf("token: %v", tok)
	}
	// the code works once
	if again := tokenCall(t, s, form); again["error"] != "invalid_grant" {
		t.Fatalf("a code must not work twice: %v", again)
	}
	return tok
}

func tokenCall(t *testing.T, s *Server, form url.Values) map[string]any {
	t.Helper()
	req := httptest.NewRequest("POST", mcpTokenPath, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := serve(t, s, req)
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}

func TestMCPOAuthDiscovery(t *testing.T) {
	s, _ := oauthServer(t)
	for _, p := range []string{protectedMetaPath, protectedMetaPath + "/mcp"} {
		rec := serve(t, s, httptest.NewRequest("GET", p, nil))
		var m map[string]any
		json.Unmarshal(rec.Body.Bytes(), &m)
		if rec.Code != 200 || m["resource"] != testOrigin+"/mcp" || m["authorization_servers"].([]any)[0] != testOrigin {
			t.Fatalf("%s: %d %v", p, rec.Code, m)
		}
	}
	rec := serve(t, s, httptest.NewRequest("GET", authServerMetaPath, nil))
	var m map[string]any
	json.Unmarshal(rec.Body.Bytes(), &m)
	if m["issuer"] != testOrigin || m["client_id_metadata_document_supported"] != true ||
		m["token_endpoint_auth_methods_supported"].([]any)[0] != "none" || m["code_challenge_methods_supported"].([]any)[0] != "S256" {
		t.Fatalf("authorization server metadata: %v", m)
	}
	// with OAuth off there are no discovery documents
	if rec := serve(t, &Server{}, httptest.NewRequest("GET", authServerMetaPath, nil)); rec.Code != 404 {
		t.Fatalf("OAuth off: %d", rec.Code)
	}
}

func TestMCPOAuthGate(t *testing.T) {
	s, _ := oauthServer(t)
	post := func(body string, hdr ...string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/mcp", strings.NewReader(body))
		for i := 0; i+1 < len(hdr); i += 2 {
			req.Header.Set(hdr[i], hdr[i+1])
		}
		return serve(t, s, req)
	}
	rec := post(toolCall("pflow_save", `{"net":`+mcpNet+`}`))
	if rec.Code != 401 || !strings.Contains(rec.Header().Get("WWW-Authenticate"), `resource_metadata="`+testOrigin+protectedMetaPath+`/mcp"`) ||
		!strings.Contains(rec.Header().Get("WWW-Authenticate"), `scope="pflow:save"`) {
		t.Fatalf("unsigned save: %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
	// in a batch too
	if rec := post(`[` + toolCall("pflow_check", `{"net":`+mcpNet+`}`) + `,` + toolCall("pflow_save", `{"net":`+mcpNet+`}`) + `]`); rec.Code != 401 {
		t.Fatalf("batch with save: %d", rec.Code)
	}
	// open tools and the listing need no sign-in, and save is listed
	if rec := post(toolCall("pflow_check", `{"net":`+mcpNet+`}`)); rec.Code != 200 {
		t.Fatalf("open tool: %d", rec.Code)
	}
	rec = post(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"pflow_save"`) {
		t.Fatalf("tools/list: %d", rec.Code)
	}
	// a forged or expired pflow token is invalid_token
	if rec := post(toolCall("pflow_save", `{"net":`+mcpNet+`}`), "Authorization", "Bearer pfa.e30.AAAA"); rec.Code != 401 ||
		!strings.Contains(rec.Header().Get("WWW-Authenticate"), `error="invalid_token"`) {
		t.Fatalf("forged token: %d %q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}
	expired := s.mcpOAuth.sign("pfa", accessClaims{mcpIdentity: mcpIdentity{Provider: "github", ID: "1"}, Aud: testOrigin + "/mcp", Exp: time.Now().Add(-time.Minute).Unix()})
	if rec := post(toolCall("pflow_save", `{"net":`+mcpNet+`}`), "Authorization", "Bearer "+expired); rec.Code != 401 {
		t.Fatalf("expired token: %d", rec.Code)
	}
	otherAud := s.mcpOAuth.sign("pfa", accessClaims{mcpIdentity: mcpIdentity{Provider: "github", ID: "1"}, Aud: "https://elsewhere/mcp", Exp: time.Now().Add(time.Minute).Unix()})
	if rec := post(toolCall("pflow_save", `{"net":`+mcpNet+`}`), "Authorization", "Bearer "+otherAud); rec.Code != 401 {
		t.Fatalf("token for another resource: %d", rec.Code)
	}
}

func saveWith(t *testing.T, s *Server, access string) map[string]any {
	t.Helper()
	req := httptest.NewRequest("POST", "/mcp", strings.NewReader(toolCall("pflow_save", `{"net":`+mcpNet+`}`)))
	req.Header.Set("Authorization", "Bearer "+access)
	rec := serve(t, s, req)
	if rec.Code != 200 {
		t.Fatalf("signed save: %d %s", rec.Code, rec.Body)
	}
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return structured(t, out)
}

func TestMCPOAuthGitHubFlowSaves(t *testing.T) {
	s, _ := oauthServer(t)
	tok := signIn(t, s, "github", "gh-code")
	res := saveWith(t, s, tok["access_token"].(string))
	if res["author"] != "octo" || res["signed_in_with"] != "github" {
		t.Fatalf("save: %v", res)
	}
	user, id, err := s.storage.GetObjectAuthor(res["cid"].(string))
	if err != nil || user != "octo" || id != "42" {
		t.Fatalf("stored author: %q %q %v", user, id, err)
	}
}

func TestMCPOAuthGoogleFlowSaves(t *testing.T) {
	s, _ := oauthServer(t)
	tok := signIn(t, s, "google", "g-code")
	res := saveWith(t, s, tok["access_token"].(string))
	if res["signed_in_with"] != "google" || res["author"] != nil {
		t.Fatalf("save: %v", res)
	}
	raw, _ := s.storage.GetObject(res["cid"].(string))
	var doc map[string]any
	json.Unmarshal(raw, &doc)
	if a := doc["author"].(map[string]any); a["id"] != "google:g-123" || a["name"] != nil {
		t.Fatalf("stored author: %v", a)
	}
}

func TestMCPOAuthRefreshRotates(t *testing.T) {
	s, _ := oauthServer(t)
	tok := signIn(t, s, "github", "gh-code")
	first := tok["refresh_token"].(string)
	next := tokenCall(t, s, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {first}})
	if next["access_token"] == nil || next["refresh_token"] == first {
		t.Fatalf("refresh: %v", next)
	}
	saveWith(t, s, next["access_token"].(string))
	// replaying the old refresh token revokes the family, so the new one dies too
	if again := tokenCall(t, s, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {first}}); again["error"] != "invalid_grant" {
		t.Fatalf("replay: %v", again)
	}
	if after := tokenCall(t, s, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {next["refresh_token"].(string)}}); after["error"] != "invalid_grant" {
		t.Fatalf("family should be revoked: %v", after)
	}
	// families persist across a restart
	b, err := os.ReadFile(s.mcpOAuth.stateFile)
	if err != nil || !json.Valid(b) {
		t.Fatalf("refresh state not written: %v", err)
	}
}

func TestMCPOAuthRejects(t *testing.T) {
	s, _ := oauthServer(t)
	const redirect = "https://claude.ai/api/mcp/auth_callback"
	clientID := s.mcpOAuth.sign("pfd", registeredClient{Redirects: []string{redirect}})
	_, challenge := pkce()
	base := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {redirect}, "code_challenge": {challenge}, "code_challenge_method": {"S256"}, "state": {"s"}}
	get := func(mod func(url.Values)) *httptest.ResponseRecorder {
		q := url.Values{}
		for k, v := range base {
			q[k] = v
		}
		mod(q)
		return serve(t, s, httptest.NewRequest("GET", mcpAuthorizePath+"?"+q.Encode(), nil))
	}
	// an unregistered redirect is refused on the page, never redirected to
	if rec := get(func(q url.Values) { q.Set("redirect_uri", "https://evil.example/cb") }); rec.Code != 400 || rec.Header().Get("Location") != "" {
		t.Fatalf("bad redirect: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	if rec := get(func(q url.Values) { q.Set("client_id", "pfd.forged.sig") }); rec.Code != 400 {
		t.Fatalf("forged client: %d", rec.Code)
	}
	// missing PKCE goes back to the client as an error
	rec := get(func(q url.Values) { q.Del("code_challenge_method") })
	if loc, _ := url.Parse(rec.Header().Get("Location")); rec.Code != 302 || loc.Query().Get("error") != "invalid_request" || loc.Query().Get("state") != "s" {
		t.Fatalf("no PKCE: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	if rec := get(func(q url.Values) { q.Set("resource", "https://elsewhere/mcp") }); !strings.Contains(rec.Header().Get("Location"), "invalid_target") {
		t.Fatalf("wrong resource: %s", rec.Header().Get("Location"))
	}
	// a callback from a browser without the cookie is refused
	p := pendingRequest{Client: clientID, Redirect: redirect, Challenge: challenge, Nonce: "n", Provider: "github", Exp: time.Now().Add(time.Minute).Unix()}
	if rec := serve(t, s, httptest.NewRequest("GET", githubCallbackPath+"?code=gh-code&state="+url.QueryEscape(s.mcpOAuth.sign("pfp", p)), nil)); rec.Code != 400 {
		t.Fatalf("callback without cookie: %d", rec.Code)
	}
	// a wrong PKCE verifier fails the exchange
	code := s.mcpOAuth.sign("pfc", codeClaims{mcpIdentity: mcpIdentity{Provider: "github", ID: "1"}, ID: "c1", Client: clientID, Redirect: redirect, Challenge: challenge, Aud: testOrigin + "/mcp", Exp: time.Now().Add(time.Minute).Unix()})
	if out := tokenCall(t, s, url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {"wrong"}}); out["error"] != "invalid_grant" {
		t.Fatalf("wrong verifier: %v", out)
	}
	// a refresh token is not a code, and an access token is not a refresh token
	acc := s.mcpOAuth.sign("pfa", accessClaims{Exp: time.Now().Add(time.Hour).Unix()})
	if out := tokenCall(t, s, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {acc}}); out["error"] != "invalid_grant" {
		t.Fatalf("access as refresh: %v", out)
	}
	// registration refuses non-https, non-loopback redirects
	if rec := serve(t, s, httptest.NewRequest("POST", mcpRegisterPath, strings.NewReader(`{"redirect_uris":["http://evil.example/cb"]}`))); rec.Code != 400 {
		t.Fatalf("http redirect registered: %d", rec.Code)
	}
}

func TestMCPOAuthRedirectMatching(t *testing.T) {
	allowed := []string{"http://localhost/callback", "http://127.0.0.1/callback", "https://claude.ai/api/mcp/auth_callback"}
	for uri, want := range map[string]bool{
		"http://localhost:3118/callback":              true,
		"http://127.0.0.1:50000/callback":             true,
		"https://claude.ai/api/mcp/auth_callback":     true,
		"https://claude.ai:444/api/mcp/auth_callback": false,
		"http://localhost:3118/other":                 false,
		"http://evil.example/callback":                false,
		"https://claude.ai/api/mcp/auth_callback#x":   false,
	} {
		if got := redirectAllowed(uri, allowed); got != want {
			t.Errorf("%s: %v, want %v", uri, got, want)
		}
	}
}

func TestMCPOAuthClientMetadataDocument(t *testing.T) {
	s, _ := oauthServer(t)
	var docURL string
	meta := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := docURL
		if r.URL.Path == "/liar" {
			id = "https://someone-else.example/meta"
		}
		writeJSON(w, 200, map[string]any{"client_id": id, "redirect_uris": []string{"http://localhost/callback"}})
	}))
	defer meta.Close()
	docURL = meta.URL + "/meta"
	// the production client refuses loopback addresses
	if _, err := s.mcpOAuth.resolveClient(context.Background(), docURL); err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("loopback metadata fetch should be refused: %v", err)
	}
	s.mcpOAuth.cimd = meta.Client()
	c, err := s.mcpOAuth.resolveClient(context.Background(), docURL)
	if err != nil || c.display != "127.0.0.1" || !redirectAllowed("http://localhost:9999/callback", c.redirects) {
		t.Fatalf("CIMD: %v %v", c, err)
	}
	if _, err := s.mcpOAuth.resolveClient(context.Background(), meta.URL+"/liar"); err == nil {
		t.Fatal("a document naming another client_id must be refused")
	}
	if _, err := s.mcpOAuth.resolveClient(context.Background(), "http://plain.example/meta"); err == nil {
		t.Fatal("a non-https client_id must be refused")
	}
}

func TestMCPOAuthOffWithoutProviders(t *testing.T) {
	if o := newMCPOAuth(func(string) string { return "" }, t.TempDir()); o != nil {
		t.Fatal("no providers, no OAuth")
	}
	// the signing key is generated once and reused
	dir := t.TempDir()
	a, _ := mcpSigningKey("", dir)
	b, _ := mcpSigningKey("", dir)
	if string(a) != string(b) || len(a) < 32 {
		t.Fatal("the generated key should persist")
	}
}
