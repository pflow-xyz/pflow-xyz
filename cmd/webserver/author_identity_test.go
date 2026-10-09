package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/static"
)

// authorIdentity is the head markup that ties every pflow.xyz HTML page to
// its author (rel=me for IndieAuth/Mastodon-style verification, meta author
// for crawlers). The strings are shared byte for byte with the other
// properties (book, sim, beats, cdn, blog); change them everywhere or nowhere.
var authorIdentity = []string{
	`<meta name="author" content="Matt York">`,
	`<link rel="me" href="https://github.com/stackdump">`,
	`<link rel="me" href="https://blog.stackdump.com/">`,
}

// assertAuthorIdentity fails unless body carries each authorIdentity line
// exactly once, inside <head>.
func assertAuthorIdentity(t *testing.T, name, body string) {
	t.Helper()
	open := strings.Index(body, "<head>")
	end := strings.Index(body, "</head>")
	if open < 0 || end < open {
		t.Errorf("%s: no <head>…</head> in response", name)
		return
	}
	head := body[open:end]
	for _, line := range authorIdentity {
		if n := strings.Count(body, line); n != 1 {
			t.Errorf("%s: %q appears %d times, want exactly 1", name, line, n)
		} else if !strings.Contains(head, line) {
			t.Errorf("%s: %q is outside <head>", name, line)
		}
	}
}

func TestHTMLPagesCarryAuthorIdentity(t *testing.T) {
	storage := NewFSStorage(t.TempDir())
	if err := storage.SaveObject(sampleCID, loadSample(t), []byte("c")); err != nil {
		t.Fatal(err)
	}
	publicFS, err := static.Public()
	if err != nil {
		t.Fatalf("static.Public: %v", err)
	}
	srv := &Server{storage: storage, publicFS: publicFS}

	cases := []struct {
		name, path, accept, marker string
	}{
		{"home", "/", "", ""},
		// Same shell, but decorateIndexForShare rewrites the head for it;
		// the marker proves the decorated path ran.
		{"home with cid (share page)", "/?cid=" + sampleCID, "", "/share-card/" + sampleCID + ".png"},
		{"static test page", "/test-solver.html", "", ""},
		{"schema html", "/schema", "text/html", ""},
		{"token html", "/tokens/red", "text/html", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", c.path, nil)
			if c.accept != "" {
				req.Header.Set("Accept", c.accept)
			}
			w := httptest.NewRecorder()
			srv.ServeHTTP(w, req)
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", w.Code)
			}
			if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
				t.Fatalf("Content-Type = %q, want text/html", ct)
			}
			if c.marker != "" && !strings.Contains(w.Body.String(), c.marker) {
				t.Fatalf("response lacks %q, so this case is not exercising the path it names", c.marker)
			}
			assertAuthorIdentity(t, c.name, w.Body.String())
		})
	}
}

// Only the HTML representation gets the markup; the JSON-LD a machine client
// negotiates for the same URL is a data document and must stay untouched.
func TestJSONRepresentationsHaveNoAuthorIdentity(t *testing.T) {
	publicFS, err := static.Public()
	if err != nil {
		t.Fatalf("static.Public: %v", err)
	}
	srv := &Server{publicFS: publicFS}
	for _, path := range []string{"/schema", "/tokens/red"} {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Accept", "application/ld+json")
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, req)
		if ct := w.Header().Get("Content-Type"); ct != "application/ld+json" {
			t.Errorf("%s: Content-Type = %q, want application/ld+json", path, ct)
		}
		for _, line := range authorIdentity {
			if strings.Contains(w.Body.String(), line) {
				t.Errorf("%s: JSON-LD response contains %q", path, line)
			}
		}
	}
}

// Every .html under public/ is served as-is by the static file handler, so a
// page added later without the markup fails here instead of shipping bare.
func TestEveryPublicHTMLPageHasAuthorIdentity(t *testing.T) {
	publicFS, err := static.Public()
	if err != nil {
		t.Fatalf("static.Public: %v", err)
	}
	pages := 0
	err = fs.WalkDir(publicFS, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(path, ".html") {
			return err
		}
		raw, err := fs.ReadFile(publicFS, path)
		if err != nil {
			return err
		}
		pages++
		assertAuthorIdentity(t, path, string(raw))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if pages == 0 {
		t.Fatal("found no .html under public/ (is internal/static/public stale? run make build)")
	}
}
