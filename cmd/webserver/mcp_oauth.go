package main

// OAuth 2.1 for /mcp, so a Claude connector (or any MCP client) can sign a
// person in before pflow_save and every other tool stays open: "lazy" sign-in.
//
// pflow.xyz is its own authorization server. It does not keep accounts: the
// person proves who they are with GitHub or Google, and pflow.xyz issues its
// own short-lived, HMAC-signed access token for /mcp. Nothing from GitHub or
// Google is kept beyond the user id (and, for GitHub, the public login).
//
// The flow, as Claude's client runs it:
//  1. tools/call pflow_save with no valid token → HTTP 401 with
//     WWW-Authenticate: Bearer resource_metadata=…, scope="pflow:save".
//  2. Claude reads /.well-known/oauth-protected-resource/mcp, then this
//     server's /.well-known/oauth-authorization-server.
//  3. Claude identifies itself with a Client ID Metadata Document (an https
//     client_id) or registers at /auth/mcp/register, then sends the person to
//     /auth/mcp/authorize (PKCE S256 required).
//  4. The consent page names the asking app and offers "Continue with GitHub"
//     and "Continue with Google"; the provider sends the person back to
//     /auth/github/callback/mcp or /auth/google/callback.
//  5. pflow.xyz redirects to the client's redirect_uri with a one-time code,
//     which /auth/mcp/token exchanges for an access token (1 h) and a rotating
//     refresh token (30 d).
//
// Every endpoint but the two discovery documents lives under /auth/, which
// the nginx vhost already proxies to this server.
//
// Configuration (environment):
//   - GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET: the editor's existing GitHub
//     OAuth app. GitHub accepts any redirect_uri below the registered callback,
//     so /auth/github/callback/mcp needs no change to the app.
//   - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET: a Google OAuth client (web
//     application) with https://<host>/auth/google/callback as a redirect URI.
//   - MCP_OAUTH_SECRET: the signing key; when unset, one is generated once and
//     kept in <data>/mcp-oauth/secret.
//   - MCP_PUBLIC_URL: the public origin (default: the request's).
//   - MCP_TERMS_URL / MCP_PRIVACY_URL: shown on the consent page (default
//     <origin>/terms.html and <origin>/privacy.html, which public/ serves).
//
// With neither provider configured, OAuth is off and /mcp behaves as before:
// pflow_save is listed only to a connection that sends a GitHub token.

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/auth"
)

const (
	mcpScopeSave       = "pflow:save"
	mcpAccessTokenTTL  = time.Hour
	mcpRefreshTokenTTL = 30 * 24 * time.Hour
	mcpCodeTTL         = 2 * time.Minute
	mcpPendingTTL      = 10 * time.Minute
	mcpAuthCookie      = "pflow_mcp_auth"
	maxClientMetadata  = 64 << 10
	maxRedirectURIs    = 10
	maxRedirectURILen  = 512
	mcpProviderTimeout = 10 * time.Second
	githubCallbackPath = "/auth/github/callback/mcp"
	googleCallbackPath = "/auth/google/callback"
	mcpAuthorizePath   = "/auth/mcp/authorize"
	mcpLoginPath       = "/auth/mcp/login"
	mcpTokenPath       = "/auth/mcp/token"
	mcpRegisterPath    = "/auth/mcp/register"
	protectedMetaPath  = "/.well-known/oauth-protected-resource"
	authServerMetaPath = "/.well-known/oauth-authorization-server"
	mcpSignInRequired  = "Signing in to pflow.xyz is required to save a net"
)

// mcpProtectedTools need a signed-in person; every other tool is open.
var mcpProtectedTools = map[string]bool{"pflow_save": true}

// oauthProvider is GitHub or Google, as the person picks on the consent page.
type oauthProvider struct {
	name, label  string
	clientID     string
	clientSecret string
	authURL      string
	tokenURL     string
	userURL      string // Google's userinfo; GitHub goes through auth.GitHubVerifier
	scope        string
	callbackPath string
}

// mcpIdentity is who signed in. ID is GitHub's numeric user id or Google's sub.
type mcpIdentity struct {
	Provider string `json:"prov"`
	ID       string `json:"sub"`
	Name     string `json:"name,omitempty"`
}

// mcpOAuth is the authorization server's configuration and its small state.
type mcpOAuth struct {
	secret     []byte
	publicURL  string
	termsURL   string
	privacyURL string
	providers  []*oauthProvider
	github     *auth.GitHubVerifier
	client     *http.Client // provider token and userinfo calls
	cimd       *http.Client // client metadata fetches (public addresses only)
	now        func() time.Time

	mu        sync.Mutex
	usedCodes map[string]time.Time  // code id → expiry, so a code works once
	families  map[string]*mcpFamily // refresh-token family → current generation
	stateFile string                // where families persist; "" keeps them in memory
}

type mcpFamily struct {
	Gen int       `json:"gen"`
	Exp time.Time `json:"exp"`
}

// configureMCPOAuth turns OAuth on when at least one provider is configured.
func (s *Server) configureMCPOAuth(dataDir string) {
	o := newMCPOAuth(os.Getenv, dataDir)
	if o == nil {
		log.Printf("MCP OAuth: off (no GITHUB_CLIENT_ID/SECRET or GOOGLE_CLIENT_ID/SECRET)")
		return
	}
	names := make([]string, 0, len(o.providers))
	for _, p := range o.providers {
		names = append(names, p.name)
	}
	log.Printf("MCP OAuth: on, sign in with %s", strings.Join(names, ", "))
	s.mcpOAuth = o
}

func newMCPOAuth(getenv func(string) string, dataDir string) *mcpOAuth {
	o := &mcpOAuth{
		publicURL:  strings.TrimRight(getenv("MCP_PUBLIC_URL"), "/"),
		termsURL:   getenv("MCP_TERMS_URL"),
		privacyURL: getenv("MCP_PRIVACY_URL"),
		github:     auth.NewGitHubVerifier(),
		client:     &http.Client{Timeout: mcpProviderTimeout},
		cimd:       publicOnlyClient(),
		now:        time.Now,
		usedCodes:  map[string]time.Time{},
		families:   map[string]*mcpFamily{},
	}
	if id, sec := getenv("GITHUB_CLIENT_ID"), getenv("GITHUB_CLIENT_SECRET"); id != "" && sec != "" {
		o.providers = append(o.providers, &oauthProvider{
			name: "github", label: "GitHub", clientID: id, clientSecret: sec,
			authURL: "https://github.com/login/oauth/authorize", tokenURL: "https://github.com/login/oauth/access_token",
			scope: "read:user", callbackPath: githubCallbackPath,
		})
	}
	if id, sec := getenv("GOOGLE_CLIENT_ID"), getenv("GOOGLE_CLIENT_SECRET"); id != "" && sec != "" {
		o.providers = append(o.providers, &oauthProvider{
			name: "google", label: "Google", clientID: id, clientSecret: sec,
			authURL: "https://accounts.google.com/o/oauth2/v2/auth", tokenURL: "https://oauth2.googleapis.com/token",
			userURL: "https://openidconnect.googleapis.com/v1/userinfo", scope: "openid", callbackPath: googleCallbackPath,
		})
	}
	if len(o.providers) == 0 {
		return nil
	}
	var err error
	if o.secret, err = mcpSigningKey(getenv("MCP_OAUTH_SECRET"), dataDir); err != nil {
		log.Printf("MCP OAuth: off, no signing key: %v", err)
		return nil
	}
	if dataDir != "" {
		o.stateFile = filepath.Join(dataDir, "mcp-oauth", "refresh.json")
		if b, err := os.ReadFile(o.stateFile); err == nil {
			json.Unmarshal(b, &o.families)
		}
	}
	return o
}

// mcpSigningKey is MCP_OAUTH_SECRET, or a random key kept in the data dir so
// tokens survive a restart.
func mcpSigningKey(env, dataDir string) ([]byte, error) {
	if env != "" {
		return []byte(env), nil
	}
	if dataDir == "" {
		return randomBytes(32), nil
	}
	path := filepath.Join(dataDir, "mcp-oauth", "secret")
	if b, err := os.ReadFile(path); err == nil && len(b) >= 32 {
		return b, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	key := []byte(hex.EncodeToString(randomBytes(32)))
	if err := os.WriteFile(path, key, 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

func randomID() string { return base64.RawURLEncoding.EncodeToString(randomBytes(16)) }

func (o *mcpOAuth) provider(name string) *oauthProvider {
	for _, p := range o.providers {
		if p.name == name {
			return p
		}
	}
	return nil
}

func (o *mcpOAuth) origin(r *http.Request) string {
	if o.publicURL != "" {
		return o.publicURL
	}
	return schemeHost(r)
}

func (o *mcpOAuth) resource(r *http.Request) string { return o.origin(r) + "/mcp" }

// ---- signed blobs: tokens, codes, pending requests, registered clients ----
//
// Each is "<prefix>.<base64url JSON>.<base64url HMAC-SHA256>". The prefix
// names the kind and is covered by the MAC, so one kind never passes as another.

func (o *mcpOAuth) sign(prefix string, v any) string {
	body, _ := json.Marshal(v)
	payload := prefix + "." + base64.RawURLEncoding.EncodeToString(body)
	m := hmac.New(sha256.New, o.secret)
	m.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

// open checks a blob's prefix and MAC and decodes it into v.
func (o *mcpOAuth) open(prefix, s string, v any) bool {
	if !strings.HasPrefix(s, prefix+".") {
		return false
	}
	i := strings.LastIndexByte(s, '.')
	if i <= len(prefix) {
		return false
	}
	mac, err := base64.RawURLEncoding.DecodeString(s[i+1:])
	if err != nil {
		return false
	}
	m := hmac.New(sha256.New, o.secret)
	m.Write([]byte(s[:i]))
	if !hmac.Equal(mac, m.Sum(nil)) {
		return false
	}
	body, err := base64.RawURLEncoding.DecodeString(s[len(prefix)+1 : i])
	if err != nil {
		return false
	}
	return json.Unmarshal(body, v) == nil
}

type accessClaims struct {
	mcpIdentity
	Aud    string `json:"aud"`
	Client string `json:"cid"`
	Scope  string `json:"scope"`
	Exp    int64  `json:"exp"`
}

type refreshClaims struct {
	mcpIdentity
	Family string `json:"fam"`
	Gen    int    `json:"gen"`
	Aud    string `json:"aud"`
	Client string `json:"cid"`
	Scope  string `json:"scope"`
	Exp    int64  `json:"exp"`
}

type codeClaims struct {
	mcpIdentity
	ID        string `json:"jti"`
	Client    string `json:"cid"`
	Redirect  string `json:"ru"`
	Challenge string `json:"cc"`
	Scope     string `json:"scope"`
	Aud       string `json:"aud"`
	Exp       int64  `json:"exp"`
}

// pendingRequest carries an authorize request across the provider round trip.
type pendingRequest struct {
	Client    string `json:"cid"`
	Redirect  string `json:"ru"`
	Challenge string `json:"cc"`
	State     string `json:"st,omitempty"`
	Scope     string `json:"scope"`
	Aud       string `json:"aud"`
	Nonce     string `json:"n"` // matches the browser's mcpAuthCookie
	Provider  string `json:"p,omitempty"`
	Exp       int64  `json:"exp"`
}

// registeredClient is a dynamically registered client, kept in its own id.
type registeredClient struct {
	Redirects []string `json:"ru"`
	Name      string   `json:"name,omitempty"`
}

// ---- verifying a bearer token on /mcp ----

// errNoToken and errBadToken both answer 401; errAuthUnavailable is a
// provider outage and fails closed as a tool error.
var (
	errNoToken         = errors.New("no bearer token")
	errBadToken        = errors.New("the token is invalid or expired")
	errAuthUnavailable = errors.New("sign-in could not be checked right now; try again shortly")
)

// mcpIdentityFor resolves the request's bearer token: a pflow.xyz access token
// is checked locally; anything else is taken as a GitHub token (how /mcp
// signed in before OAuth) and checked with GitHub.
func (s *Server) mcpIdentityFor(r *http.Request) (*mcpIdentity, error) {
	token := bearerToken(r)
	if token == "" {
		return nil, errNoToken
	}
	if s.mcpOAuth != nil && strings.HasPrefix(token, "pfa.") {
		var c accessClaims
		if !s.mcpOAuth.open("pfa", token, &c) || c.Exp < s.mcpOAuth.now().Unix() || c.Aud != s.mcpOAuth.resource(r) {
			return nil, errBadToken
		}
		id := c.mcpIdentity
		return &id, nil
	}
	verifier := s.mcpVerifier
	if verifier == nil {
		verifier = auth.NewCachingVerifier(auth.NewGitHubVerifier())
		s.mcpVerifier = verifier
	}
	u, err := verifier.Verify(r.Context(), token)
	switch {
	case errors.Is(err, auth.ErrVerifierUnavailable):
		return nil, errAuthUnavailable
	case err != nil:
		return nil, errBadToken
	}
	return &mcpIdentity{Provider: "github", ID: u.GitHubID, Name: u.UserName}, nil
}

type mcpIdentityKey struct{}

func withMCPIdentity(r *http.Request, id *mcpIdentity) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), mcpIdentityKey{}, id))
}

func mcpIdentityOf(r *http.Request) *mcpIdentity {
	id, _ := r.Context().Value(mcpIdentityKey{}).(*mcpIdentity)
	return id
}

// callsProtectedTool reports whether a JSON-RPC body (one message or a batch)
// calls a tool that needs sign-in.
func callsProtectedTool(body []byte) bool {
	var msgs []rpcRequest
	if t := strings.TrimSpace(string(body)); strings.HasPrefix(t, "[") {
		if json.Unmarshal(body, &msgs) != nil {
			return false
		}
	} else {
		var m rpcRequest
		if json.Unmarshal(body, &m) != nil {
			return false
		}
		msgs = []rpcRequest{m}
	}
	for _, m := range msgs {
		if m.Method != "tools/call" {
			continue
		}
		var p struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(m.Params, &p) == nil && mcpProtectedTools[p.Name] {
			return true
		}
	}
	return false
}

// mcpAuthGate runs before dispatch. A call to a protected tool without a
// valid token gets HTTP 401 and a WWW-Authenticate challenge, which is what
// makes Claude show its sign-in prompt and retry; a tool error would not.
// It returns the request (carrying the identity, if any) and whether the
// caller should go on.
func (s *Server) mcpAuthGate(w http.ResponseWriter, r *http.Request, body []byte) (*http.Request, bool) {
	if s.mcpOAuth == nil || !callsProtectedTool(body) {
		return r, true
	}
	id, err := s.mcpIdentityFor(r)
	if err == nil {
		return withMCPIdentity(r, id), true
	}
	if errors.Is(err, errAuthUnavailable) {
		return r, true // pflow_save reports the outage as a tool error
	}
	o := s.mcpOAuth
	desc := mcpSignInRequired
	challenge := fmt.Sprintf(`Bearer resource_metadata="%s%s/mcp", scope="%s"`, o.origin(r), protectedMetaPath, mcpScopeSave)
	if errors.Is(err, errBadToken) {
		desc = "The pflow.xyz sign-in has expired or is invalid"
		challenge = `Bearer error="invalid_token", error_description="` + desc + `", ` + strings.TrimPrefix(challenge, "Bearer ")
	}
	w.Header().Set("WWW-Authenticate", challenge)
	writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_token", "error_description": desc})
	return r, false
}

// ---- discovery ----

func (s *Server) handleProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	o := s.mcpOAuth
	if o == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 o.resource(r),
		"resource_name":            "pflow.xyz",
		"authorization_servers":    []string{o.origin(r)},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{mcpScopeSave},
	})
}

func (s *Server) handleAuthServerMetadata(w http.ResponseWriter, r *http.Request) {
	o := s.mcpOAuth
	if o == nil {
		http.NotFound(w, r)
		return
	}
	base := o.origin(r)
	w.Header().Set("Access-Control-Allow-Origin", "*")
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         base,
		"authorization_endpoint":                         base + mcpAuthorizePath,
		"token_endpoint":                                 base + mcpTokenPath,
		"registration_endpoint":                          base + mcpRegisterPath,
		"scopes_supported":                               []string{mcpScopeSave},
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"code_challenge_methods_supported":               []string{"S256"},
		"client_id_metadata_document_supported":          true,
		"authorization_response_iss_parameter_supported": true,
		"service_documentation":                          base + "/",
	})
}

// ---- clients: Client ID Metadata Documents and dynamic registration ----

// clientInfo is what the consent page and the redirect check need.
type clientInfo struct {
	display   string // the host that is asking, never a self-asserted name
	redirects []string
}

// resolveClient accepts an https client_id (a Client ID Metadata Document,
// fetched and checked) or one this server issued at /auth/mcp/register.
func (o *mcpOAuth) resolveClient(ctx context.Context, clientID string) (*clientInfo, error) {
	if strings.HasPrefix(clientID, "pfd.") {
		var c registeredClient
		if !o.open("pfd", clientID, &c) {
			return nil, errors.New("unknown client_id")
		}
		name := "an app"
		if len(c.Redirects) > 0 {
			if u, err := url.Parse(c.Redirects[0]); err == nil && u.Hostname() != "" {
				name = u.Hostname()
			}
		}
		return &clientInfo{display: name, redirects: c.Redirects}, nil
	}
	u, err := url.Parse(clientID)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Fragment != "" || u.User != nil {
		return nil, errors.New("client_id: an https URL (a Client ID Metadata Document) or a registered client")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, clientID, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := o.cimd.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not fetch the client's metadata: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("the client's metadata answered %d", resp.StatusCode)
	}
	var doc struct {
		ClientID     string   `json:"client_id"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxClientMetadata)).Decode(&doc); err != nil {
		return nil, errors.New("the client's metadata is not JSON")
	}
	if doc.ClientID != clientID {
		return nil, errors.New("the client's metadata names a different client_id")
	}
	return &clientInfo{display: u.Hostname(), redirects: doc.RedirectURIs}, nil
}

// redirectAllowed matches exactly, except that a loopback redirect matches
// on any port (RFC 8252 §7.3), for native clients such as Claude Code.
func redirectAllowed(requested string, allowed []string) bool {
	ru, err := url.Parse(requested)
	if err != nil || ru.Fragment != "" {
		return false
	}
	for _, a := range allowed {
		if a == requested {
			return true
		}
		au, err := url.Parse(a)
		if err != nil || !isLoopback(au) || !isLoopback(ru) {
			continue
		}
		if au.Scheme == ru.Scheme && au.Hostname() == ru.Hostname() && au.Path == ru.Path && au.RawQuery == ru.RawQuery {
			return true
		}
	}
	return false
}

func isLoopback(u *url.URL) bool {
	if u.Scheme != "http" {
		return false
	}
	h := u.Hostname()
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

// validRedirect is a redirect a client may register: https, or http on loopback.
func validRedirect(s string) bool {
	if len(s) > maxRedirectURILen {
		return false
	}
	u, err := url.Parse(s)
	if err != nil || u.Fragment != "" || u.Host == "" {
		return false
	}
	return u.Scheme == "https" || isLoopback(u)
}

// handleRegister is RFC 7591 dynamic client registration, kept stateless: the
// client_id is a signed record of the redirect URIs, so nothing is stored.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	o := s.mcpOAuth
	if o == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "POST client metadata as JSON", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		RedirectURIs []string `json:"redirect_uris"`
		ClientName   string   `json:"client_name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, maxClientMetadata)).Decode(&req); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "the body must be JSON client metadata")
		return
	}
	if len(req.RedirectURIs) == 0 || len(req.RedirectURIs) > maxRedirectURIs {
		oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", fmt.Sprintf("give 1 to %d redirect_uris", maxRedirectURIs))
		return
	}
	for _, u := range req.RedirectURIs {
		if !validRedirect(u) {
			oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "each redirect_uri must be https, or http on localhost/127.0.0.1: "+u)
			return
		}
	}
	name := req.ClientName
	if len([]rune(name)) > 100 {
		name = string([]rune(name)[:100])
	}
	id := o.sign("pfd", registeredClient{Redirects: req.RedirectURIs, Name: name})
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  id,
		"client_id_issued_at":        o.now().Unix(),
		"client_name":                name,
		"redirect_uris":              req.RedirectURIs,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
}

// ---- authorize, consent, provider round trip ----

func (s *Server) handleAuthorize(w http.ResponseWriter, r *http.Request) {
	o := s.mcpOAuth
	if o == nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	clientID, redirect := q.Get("client_id"), q.Get("redirect_uri")
	client, err := o.resolveClient(r.Context(), clientID)
	if err != nil {
		consentError(w, http.StatusBadRequest, "This app could not be identified: "+err.Error())
		return
	}
	if redirect == "" && len(client.redirects) == 1 {
		redirect = client.redirects[0]
	}
	if !redirectAllowed(redirect, client.redirects) {
		consentError(w, http.StatusBadRequest, "The return address this app asked for is not one it registered.")
		return
	}
	// From here on, errors go back to the client's redirect, as RFC 6749 asks.
	fail := func(code, desc string) {
		redirectWith(w, r, redirect, url.Values{"error": {code}, "error_description": {desc}, "state": {q.Get("state")}, "iss": {o.origin(r)}})
	}
	if q.Get("response_type") != "code" {
		fail("unsupported_response_type", "only response_type=code is supported")
		return
	}
	challenge := q.Get("code_challenge")
	if q.Get("code_challenge_method") != "S256" || len(challenge) < 43 || len(challenge) > 128 {
		fail("invalid_request", "PKCE with code_challenge_method=S256 is required")
		return
	}
	aud := o.resource(r)
	if res := q.Get("resource"); res != "" && strings.TrimRight(res, "/") != aud {
		fail("invalid_target", "this server issues tokens only for "+aud)
		return
	}
	for _, sc := range strings.Fields(q.Get("scope")) {
		if sc != mcpScopeSave && sc != "offline_access" {
			fail("invalid_scope", "the only scope is "+mcpScopeSave)
			return
		}
	}
	nonce := randomID()
	http.SetCookie(w, &http.Cookie{Name: mcpAuthCookie, Value: nonce, Path: "/auth/", MaxAge: int(mcpPendingTTL.Seconds()),
		HttpOnly: true, Secure: strings.HasPrefix(o.origin(r), "https://"), SameSite: http.SameSiteLaxMode})
	pending := pendingRequest{Client: clientID, Redirect: redirect, Challenge: challenge, State: q.Get("state"),
		Scope: mcpScopeSave, Aud: aud, Nonce: nonce, Exp: o.now().Add(mcpPendingTTL).Unix()}
	redirectHost := redirect
	if u, err := url.Parse(redirect); err == nil {
		redirectHost = u.Host
	}
	var buttons strings.Builder
	for _, p := range o.providers {
		pending.Provider = p.name
		link := mcpLoginPath + "?req=" + url.QueryEscape(o.sign("pfp", pending))
		fmt.Fprintf(&buttons, `<a class="btn" href="%s">Continue with %s</a>`, html.EscapeString(link), html.EscapeString(p.label))
	}
	terms, privacy := o.termsURL, o.privacyURL
	if terms == "" {
		terms = o.origin(r) + "/terms.html"
	}
	if privacy == "" {
		privacy = o.origin(r) + "/privacy.html"
	}
	consentPage(w, http.StatusOK, fmt.Sprintf(`<h1>Sign in to pflow.xyz</h1>
<p><b>%s</b> is asking to save Petri nets to pflow.xyz in your name. Saved nets are public and show who saved them.</p>
<p>After you sign in you will be sent back to <b>%s</b>. Only continue if you started this from an app you trust.</p>
<div class="btns">%s</div>
<p class="small">pflow.xyz keeps only your account id from GitHub or Google (and your GitHub username), never a password. By continuing you agree to the <a href="%s">terms</a> and <a href="%s">privacy policy</a>.</p>`,
		html.EscapeString(client.display), html.EscapeString(redirectHost), buttons.String(), html.EscapeString(terms), html.EscapeString(privacy)))
}

// handleLogin sends the person to the provider they picked.
func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	o := s.mcpOAuth
	if o == nil {
		http.NotFound(w, r)
		return
	}
	var p pendingRequest
	if !o.open("pfp", r.URL.Query().Get("req"), &p) || p.Exp < o.now().Unix() {
		consentError(w, http.StatusBadRequest, "This sign-in link has expired. Start again from your app.")
		return
	}
	prov := o.provider(p.Provider)
	if prov == nil {
		consentError(w, http.StatusBadRequest, "That sign-in option is not available.")
		return
	}
	v := url.Values{
		"client_id":    {prov.clientID},
		"redirect_uri": {o.origin(r) + prov.callbackPath},
		"scope":        {prov.scope},
		"state":        {o.sign("pfp", p)},
	}
	if prov.name == "google" {
		v.Set("response_type", "code")
		v.Set("prompt", "select_account")
	}
	http.Redirect(w, r, prov.authURL+"?"+v.Encode(), http.StatusFound)
}

func (s *Server) handleGitHubMCPCallback(w http.ResponseWriter, r *http.Request) {
	s.providerCallback(w, r, "github")
}

func (s *Server) handleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	s.providerCallback(w, r, "google")
}

// providerCallback finishes the provider round trip and hands the client its code.
func (s *Server) providerCallback(w http.ResponseWriter, r *http.Request, provName string) {
	o := s.mcpOAuth
	prov := (*oauthProvider)(nil)
	if o != nil {
		prov = o.provider(provName)
	}
	if prov == nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	var p pendingRequest
	if !o.open("pfp", q.Get("state"), &p) || p.Exp < o.now().Unix() || p.Provider != provName {
		consentError(w, http.StatusBadRequest, "This sign-in has expired. Start again from your app.")
		return
	}
	if c, err := r.Cookie(mcpAuthCookie); err != nil || !hmac.Equal([]byte(c.Value), []byte(p.Nonce)) {
		consentError(w, http.StatusBadRequest, "This sign-in was started in another browser. Start again from your app.")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: mcpAuthCookie, Value: "", Path: "/auth/", MaxAge: -1})
	back := func(v url.Values) {
		v.Set("iss", o.origin(r))
		if p.State != "" {
			v.Set("state", p.State)
		}
		redirectWith(w, r, p.Redirect, v)
	}
	if e := q.Get("error"); e != "" {
		back(url.Values{"error": {"access_denied"}, "error_description": {prov.label + " sign-in was cancelled"}})
		return
	}
	id, err := o.identify(r.Context(), prov, q.Get("code"), o.origin(r)+prov.callbackPath)
	if err != nil {
		log.Printf("MCP OAuth: %s sign-in failed: %v", provName, err)
		back(url.Values{"error": {"server_error"}, "error_description": {prov.label + " sign-in did not complete; try again"}})
		return
	}
	code := o.sign("pfc", codeClaims{mcpIdentity: *id, ID: randomID(), Client: p.Client, Redirect: p.Redirect,
		Challenge: p.Challenge, Scope: p.Scope, Aud: p.Aud, Exp: o.now().Add(mcpCodeTTL).Unix()})
	back(url.Values{"code": {code}})
}

// identify exchanges the provider's code and returns who signed in. The
// provider's token is used once, here, and not kept.
func (o *mcpOAuth) identify(ctx context.Context, prov *oauthProvider, code, redirect string) (*mcpIdentity, error) {
	if code == "" {
		return nil, errors.New("no code")
	}
	form := url.Values{"client_id": {prov.clientID}, "client_secret": {prov.clientSecret}, "code": {code}, "redirect_uri": {redirect}}
	if prov.name == "google" {
		form.Set("grant_type", "authorization_code")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, prov.tokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := o.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&tok); err != nil || tok.AccessToken == "" {
		return nil, fmt.Errorf("token exchange: status %d %s", resp.StatusCode, tok.Error)
	}
	if prov.name == "github" {
		u, err := o.github.Verify(ctx, tok.AccessToken)
		if err != nil {
			return nil, err
		}
		return &mcpIdentity{Provider: "github", ID: u.GitHubID, Name: u.UserName}, nil
	}
	ureq, _ := http.NewRequestWithContext(ctx, http.MethodGet, prov.userURL, nil)
	ureq.Header.Set("Authorization", "Bearer "+tok.AccessToken)
	uresp, err := o.client.Do(ureq)
	if err != nil {
		return nil, err
	}
	defer uresp.Body.Close()
	var info struct {
		Sub string `json:"sub"`
	}
	if err := json.NewDecoder(io.LimitReader(uresp.Body, 64<<10)).Decode(&info); err != nil || info.Sub == "" {
		return nil, fmt.Errorf("userinfo: status %d", uresp.StatusCode)
	}
	return &mcpIdentity{Provider: "google", ID: info.Sub}, nil
}

// ---- token endpoint ----

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	o := s.mcpOAuth
	if o == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		oauthError(w, http.StatusMethodNotAllowed, "invalid_request", "POST a form")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_request", "the body must be application/x-www-form-urlencoded")
		return
	}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		o.exchangeCode(w, r)
	case "refresh_token":
		o.refresh(w, r)
	default:
		oauthError(w, http.StatusBadRequest, "unsupported_grant_type", "grant_type: authorization_code or refresh_token")
	}
}

func (o *mcpOAuth) exchangeCode(w http.ResponseWriter, r *http.Request) {
	f := r.PostForm
	var c codeClaims
	if !o.open("pfc", f.Get("code"), &c) || c.Exp < o.now().Unix() {
		oauthError(w, http.StatusBadRequest, "invalid_grant", "the code is invalid or expired")
		return
	}
	if f.Get("client_id") != "" && f.Get("client_id") != c.Client {
		oauthError(w, http.StatusBadRequest, "invalid_grant", "the code was issued to another client")
		return
	}
	if f.Get("redirect_uri") != "" && f.Get("redirect_uri") != c.Redirect {
		oauthError(w, http.StatusBadRequest, "invalid_grant", "redirect_uri does not match the authorization request")
		return
	}
	if res := f.Get("resource"); res != "" && strings.TrimRight(res, "/") != c.Aud {
		oauthError(w, http.StatusBadRequest, "invalid_target", "this server issues tokens only for "+c.Aud)
		return
	}
	sum := sha256.Sum256([]byte(f.Get("code_verifier")))
	if !hmac.Equal([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(c.Challenge)) {
		oauthError(w, http.StatusBadRequest, "invalid_grant", "code_verifier does not match the code_challenge")
		return
	}
	o.mu.Lock()
	now := o.now()
	for id, exp := range o.usedCodes {
		if exp.Before(now) {
			delete(o.usedCodes, id)
		}
	}
	if _, used := o.usedCodes[c.ID]; used {
		o.mu.Unlock()
		oauthError(w, http.StatusBadRequest, "invalid_grant", "the code was already used")
		return
	}
	o.usedCodes[c.ID] = time.Unix(c.Exp, 0)
	fam := randomID()
	o.families[fam] = &mcpFamily{Gen: 1, Exp: now.Add(mcpRefreshTokenTTL)}
	o.saveFamiliesLocked()
	o.mu.Unlock()
	o.issue(w, c.mcpIdentity, c.Client, c.Scope, c.Aud, fam, 1)
}

// refresh rotates the refresh token. Presenting an older one again means it
// was copied, so the whole family is revoked (OAuth 2.1 §4.3.1).
func (o *mcpOAuth) refresh(w http.ResponseWriter, r *http.Request) {
	f := r.PostForm
	var c refreshClaims
	if !o.open("pfr", f.Get("refresh_token"), &c) || c.Exp < o.now().Unix() {
		oauthError(w, http.StatusBadRequest, "invalid_grant", "the refresh token is invalid or expired")
		return
	}
	if f.Get("client_id") != "" && f.Get("client_id") != c.Client {
		oauthError(w, http.StatusBadRequest, "invalid_grant", "the refresh token was issued to another client")
		return
	}
	o.mu.Lock()
	fam := o.families[c.Family]
	switch {
	case fam == nil:
		o.mu.Unlock()
		oauthError(w, http.StatusBadRequest, "invalid_grant", "the sign-in was revoked; sign in again")
		return
	case fam.Gen != c.Gen:
		delete(o.families, c.Family)
		o.saveFamiliesLocked()
		o.mu.Unlock()
		oauthError(w, http.StatusBadRequest, "invalid_grant", "the refresh token was already used; sign in again")
		return
	}
	fam.Gen++
	fam.Exp = o.now().Add(mcpRefreshTokenTTL)
	gen := fam.Gen
	o.saveFamiliesLocked()
	o.mu.Unlock()
	o.issue(w, c.mcpIdentity, c.Client, c.Scope, c.Aud, c.Family, gen)
}

func (o *mcpOAuth) issue(w http.ResponseWriter, id mcpIdentity, client, scope, aud, fam string, gen int) {
	now := o.now()
	access := o.sign("pfa", accessClaims{mcpIdentity: id, Aud: aud, Client: client, Scope: scope, Exp: now.Add(mcpAccessTokenTTL).Unix()})
	refresh := o.sign("pfr", refreshClaims{mcpIdentity: id, Family: fam, Gen: gen, Aud: aud, Client: client, Scope: scope, Exp: now.Add(mcpRefreshTokenTTL).Unix()})
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(mcpAccessTokenTTL.Seconds()),
		"refresh_token": refresh,
		"scope":         scope,
	})
}

// saveFamiliesLocked drops expired families and writes the rest; o.mu is held.
func (o *mcpOAuth) saveFamiliesLocked() {
	now := o.now()
	for k, f := range o.families {
		if f.Exp.Before(now) {
			delete(o.families, k)
		}
	}
	if o.stateFile == "" {
		return
	}
	b, _ := json.Marshal(o.families)
	if err := os.MkdirAll(filepath.Dir(o.stateFile), 0o700); err != nil {
		log.Printf("MCP OAuth: %v", err)
		return
	}
	tmp := o.stateFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		log.Printf("MCP OAuth: %v", err)
		return
	}
	if err := os.Rename(tmp, o.stateFile); err != nil {
		log.Printf("MCP OAuth: %v", err)
	}
}

// ---- helpers ----

func oauthError(w http.ResponseWriter, status int, code, desc string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]string{"error": code, "error_description": desc})
}

func redirectWith(w http.ResponseWriter, r *http.Request, target string, v url.Values) {
	u, err := url.Parse(target)
	if err != nil {
		consentError(w, http.StatusBadRequest, "The app's return address is not valid.")
		return
	}
	q := u.Query()
	for k, vs := range v {
		if len(vs) > 0 && vs[0] != "" {
			q.Set(k, vs[0])
		}
	}
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

func consentError(w http.ResponseWriter, status int, msg string) {
	consentPage(w, status, "<h1>Sign-in problem</h1><p>"+html.EscapeString(msg)+"</p>")
}

func consentPage(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'")
	h.Set("Referrer-Policy", "no-referrer")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>pflow.xyz sign-in</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#16161a}a{color:#8ab4f8}}
.btns{display:flex;flex-direction:column;gap:.75rem;margin:1.5rem 0}.btn{display:block;text-align:center;padding:.75rem 1rem;border:1px solid #8888;border-radius:8px;text-decoration:none;color:inherit;font-weight:600}
.btn:hover{background:#8882}.small{font-size:.85rem;opacity:.8}</style></head><body>%s</body></html>`, body)
}

// publicOnlyClient fetches client metadata documents but refuses to connect
// to loopback, private, link-local or unspecified addresses, so a client_id
// cannot point the server at its own network.
func publicOnlyClient() *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, Control: func(_, address string, _ syscall.RawConn) error {
		host, _, err := net.SplitHostPort(address)
		if err != nil {
			return err
		}
		ip := net.ParseIP(host)
		if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
			return fmt.Errorf("refusing to fetch client metadata from %s", host)
		}
		return nil
	}}
	return &http.Client{
		Timeout:   5 * time.Second,
		Transport: &http.Transport{DialContext: dialer.DialContext, TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("client metadata must not redirect")
		},
	}
}

// mcpOAuthAuthorDoc stamps a Google identity onto a net before it is stored.
// GitHub saves go through SaveObjectWithAuthor, which writes its own author.
func mcpOAuthAuthorDoc(doc map[string]any, id *mcpIdentity) ([]byte, error) {
	c := make(map[string]any, len(doc)+1)
	for k, v := range doc {
		c[k] = v
	}
	c["author"] = map[string]any{"@type": "Person", "id": id.Provider + ":" + id.ID}
	return json.Marshal(c)
}
