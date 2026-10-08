package main

import (
	"bytes"
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/static"
)

func TestWantsHTML(t *testing.T) {
	cases := []struct {
		accept string
		want   bool
	}{
		{"", false},
		{"*/*", false},
		{"application/json", false},
		{"application/ld+json", false},
		{"text/html", true},
		{"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", true},
		{"application/ld+json, text/html;q=0.5", false},
		{"text/html;q=0.5, application/ld+json", false},
		{"text/html;q=0.9, application/ld+json;q=0.5", true},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "/x", nil)
		req.Header.Set("Accept", c.accept)
		got := wantsHTML(req)
		if got != c.want {
			t.Errorf("wantsHTML(%q) = %v, want %v", c.accept, got, c.want)
		}
	}
}

func newTestServer(t *testing.T) *Server {
	t.Helper()
	publicFS, err := static.Public()
	if err != nil {
		t.Fatalf("static.Public: %v", err)
	}
	return &Server{publicFS: publicFS}
}

func TestHandleSchema_JSONLD(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest("GET", "/schema", nil)
	req.Header.Set("Accept", "application/ld+json")
	w := httptest.NewRecorder()
	s.handleSchema(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/ld+json" {
		t.Errorf("Content-Type = %q, want application/ld+json", ct)
	}
	var doc map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if _, ok := doc["@context"]; !ok {
		t.Error("response missing @context")
	}
}

func TestHandleSchema_HTML(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest("GET", "/schema", nil)
	req.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	s.handleSchema(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, "<table>") {
		t.Error("HTML missing <table>")
	}
	if !strings.Contains(body, "PetriNet") {
		t.Error("HTML missing PetriNet term")
	}
}

// The HTML representation is what a crawler indexes (it is in the sitemap),
// so it needs the same canonical + Open Graph + Twitter head the landing page
// carries.
func TestHandleSchema_HTMLHeadTags(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest("GET", "/schema", nil)
	req.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	s.handleSchema(w, req)

	body := w.Body.String()
	head := body[:strings.Index(body, "</head>")]
	if n := strings.Count(head, `rel="canonical"`); n != 1 {
		t.Errorf("want exactly one canonical link, got %d", n)
	}
	for _, want := range []string{
		`<link rel="canonical" href="https://pflow.xyz/schema"/>`,
		`<meta name="description" content=`,
		`<meta property="og:title" content="pflow.xyz Schema"/>`,
		`<meta property="og:description" content=`,
		`<meta property="og:type" content="website"/>`,
		`<meta property="og:url" content="https://pflow.xyz/schema"/>`,
		`<meta property="og:image" content="https://pflow.xyz/banner.png"/>`,
		`<meta name="twitter:card" content="summary_large_image"/>`,
		`<meta name="twitter:title" content="pflow.xyz Schema"/>`,
		`<meta name="twitter:description" content=`,
		`<meta name="twitter:image" content="https://pflow.xyz/banner.png"/>`,
	} {
		if !strings.Contains(head, want) {
			t.Errorf("schema HTML head missing %s", want)
		}
	}
	// The og:image must resolve to a file the server actually ships.
	if _, err := fs.Stat(s.publicFS, "banner.png"); err != nil {
		t.Errorf("og:image banner.png is not in the embedded public tree: %v", err)
	}
}

// The JSON-LD bytes are the contract other repos' @context resolution depends
// on; the SEO head tags must not leak into them, and every non-HTML Accept
// must keep getting exactly the embedded file.
func TestHandleSchema_JSONLDBytesUnchanged(t *testing.T) {
	s := newTestServer(t)
	want, err := fs.ReadFile(s.publicFS, "schema")
	if err != nil {
		t.Fatal(err)
	}
	for _, accept := range []string{"", "*/*", "application/ld+json", "application/json", "application/ld+json, text/html;q=0.5"} {
		req := httptest.NewRequest("GET", "/schema", nil)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		w := httptest.NewRecorder()
		s.handleSchema(w, req)
		if ct := w.Header().Get("Content-Type"); ct != "application/ld+json" {
			t.Errorf("Accept=%q Content-Type = %q, want application/ld+json", accept, ct)
		}
		if !bytes.Equal(w.Body.Bytes(), want) {
			t.Errorf("Accept=%q body differs from the embedded schema file", accept)
		}
	}
}

// Two representations at one URL: a shared cache (CDN, proxy) must key on
// Accept or it will hand the browser page to a JSON-LD client.
func TestHandleSchema_VaryAccept(t *testing.T) {
	s := newTestServer(t)
	for _, accept := range []string{"text/html", "application/ld+json", ""} {
		req := httptest.NewRequest("GET", "/schema", nil)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		w := httptest.NewRecorder()
		s.handleSchema(w, req)
		if got := w.Header().Values("Vary"); len(got) != 1 || got[0] != "Accept" {
			t.Errorf("Accept=%q Vary = %q, want [Accept]", accept, got)
		}
	}
}

func TestHandleSchema_DefaultIsJSONLD(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest("GET", "/schema", nil)
	w := httptest.NewRecorder()
	s.handleSchema(w, req)

	if ct := w.Header().Get("Content-Type"); ct != "application/ld+json" {
		t.Errorf("default Content-Type = %q, want application/ld+json", ct)
	}
}

func TestHandleTokenType_HTML(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest("GET", "/tokens/red", nil)
	req.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	s.handleTokenType(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	body := w.Body.String()
	if !strings.Contains(body, "swatch") {
		t.Error("HTML missing swatch element")
	}
	if !strings.Contains(body, ">red<") {
		t.Error("HTML missing color label 'red'")
	}
}

func TestHandleTokenType_HexHTML(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest("GET", "/tokens/ff0000,00ff00", nil)
	req.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	s.handleTokenType(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, "background-color: #ff0000") {
		t.Error("HTML should prefix bare hex with #")
	}
	if !strings.Contains(body, "colorCount") || !strings.Contains(body, "2") {
		t.Error("HTML should report colorCount=2")
	}
}

func TestHandleTokenType_DefaultJSONLD(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest("GET", "/tokens/red", nil)
	w := httptest.NewRecorder()
	s.handleTokenType(w, req)

	if ct := w.Header().Get("Content-Type"); ct != "application/ld+json" {
		t.Errorf("Content-Type = %q, want application/ld+json", ct)
	}
	var doc map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatalf("body not JSON: %v", err)
	}
	if doc["@type"] != "TokenType" {
		t.Errorf("@type = %v, want TokenType", doc["@type"])
	}
	if doc["name"] != "red" {
		t.Errorf("name = %v, want red", doc["name"])
	}
}

func TestHandleTokenType_InvalidColor(t *testing.T) {
	s := newTestServer(t)
	for _, accept := range []string{"text/html", "application/ld+json", ""} {
		req := httptest.NewRequest("GET", "/tokens/notacolor", nil)
		if accept != "" {
			req.Header.Set("Accept", accept)
		}
		w := httptest.NewRecorder()
		s.handleTokenType(w, req)
		if w.Code != http.StatusBadRequest {
			body, _ := io.ReadAll(w.Body)
			t.Errorf("Accept=%q status = %d, want 400 (body=%s)", accept, w.Code, body)
		}
	}
}
