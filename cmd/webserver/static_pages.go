package main

// Static pages the server decorates the way it decorates "/".
//
// Most of public/ is served as it is by http.FileServer, with no analytics.
// Two pages are counted: "/" (index.html, in main.go) and /compose.html, which
// carries its own share head (canonical, Open Graph, Twitter, JSON-LD) in the
// file and gets the same Google Analytics injection here when
// GOOGLE_ANALYTICS_ID is set. The privacy page names exactly these.
//
// The page is read from the embedded tree, injected, and handed to
// http.ServeContent, so HEAD, byte ranges and conditional requests behave as
// they do under FileServer; the ETag is over the injected bytes, which only
// change with the file or the configured analytics ID.
//
// The future /m/<cid> model pages need the same treatment (this head from the
// stored object, a sitemap entry, this injection), server-side, because they
// are the same client-rendered shell; that waits on D3/D4.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"net/http"
	"time"
)

// The compose page's URL path and its file in the embedded tree.
const (
	composePath = "/compose.html"
	composeFile = "compose.html"
)

// serveComposePage handles the compose page's own URLs and reports whether it
// answered. Anything else (including its assets under /compose/) falls
// through to the static handler.
func (s *Server) serveComposePage(w http.ResponseWriter, r *http.Request) bool {
	switch r.URL.Path {
	case "/compose", "/compose/":
		// FileServer would send "/compose" on to a listing of the page's source
		// directory. A person typing the short name wants the page. Not a 301:
		// where the page lives is still being settled (design D3/D4).
		target := composePath
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		http.Redirect(w, r, target, http.StatusFound)
		return true
	case composePath:
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			return false
		}
		s.serveHTMLWithAnalytics(w, r, composeFile)
		return true
	}
	return false
}

// serveHTMLWithAnalytics serves an embedded HTML file with the analytics tag
// injected (when configured), as a content-addressed, conditional response.
func (s *Server) serveHTMLWithAnalytics(w http.ResponseWriter, r *http.Request, name string) {
	data, err := fs.ReadFile(s.publicFS, name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	data = s.injectAnalytics(data)
	sum := sha256.Sum256(data)
	w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:8])+`"`)
	// A zero modtime: the embedded tree has none, so no Last-Modified is sent
	// and If-Modified-Since is ignored; If-None-Match against the ETag does the
	// work. The name's extension gives "text/html; charset=utf-8".
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}
