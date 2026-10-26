package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/static"
)

// The connector directory asks for public docs, terms and a privacy policy;
// the consent page links the last two. They are plain files under public/,
// served as *.html because the nginx vhost proxies only that suffix.
func TestMCPDirectoryPagesAreServed(t *testing.T) {
	publicFS, err := static.Public()
	if err != nil {
		t.Fatalf("static.Public: %v", err)
	}
	srv := &Server{publicFS: publicFS}
	for _, c := range []struct{ path, title string }{
		{"/mcp.html", "MCP connector"},
		{"/terms.html", "Terms of use"},
		{"/privacy.html", "Privacy policy"},
	} {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest("GET", c.path, nil))
		if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
			t.Fatalf("%s: %d %q", c.path, rec.Code, rec.Header().Get("Content-Type"))
		}
		if !strings.Contains(rec.Body.String(), "<title>"+c.title) {
			t.Errorf("%s: title is not %q", c.path, c.title)
		}
	}
}

// The docs page lists every tool, so a tool added to the server without a
// line in public/mcp.html fails here.
func TestMCPDocsListEveryTool(t *testing.T) {
	publicFS, err := static.Public()
	if err != nil {
		t.Fatalf("static.Public: %v", err)
	}
	raw, err := fs.ReadFile(publicFS, "mcp.html")
	if err != nil {
		t.Fatal(err)
	}
	page := string(raw)
	for _, tool := range allMCPTools() {
		if !strings.Contains(page, "<code>"+tool.Name+"</code></td>") {
			t.Errorf("public/mcp.html does not list %s", tool.Name)
		}
	}
	if !strings.Contains(page, "https://pflow.xyz/mcp") {
		t.Error("public/mcp.html does not give the connector URL")
	}
}

// Opening the connector URL in a browser shows the docs; an MCP client's GET
// (asking for an event stream) still gets 405.
func TestMCPBrowserGetShowsDocs(t *testing.T) {
	s := &Server{}
	req := httptest.NewRequest("GET", "/mcp", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	rec := httptest.NewRecorder()
	s.handleMCP(rec, req)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "/mcp.html" {
		t.Fatalf("browser GET: %d %q", rec.Code, rec.Header().Get("Location"))
	}
	req = httptest.NewRequest("GET", "/mcp", nil)
	req.Header.Set("Accept", "text/event-stream")
	rec = httptest.NewRecorder()
	s.handleMCP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("event-stream GET: %d", rec.Code)
	}
}
