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
	"log"
	"net/http"
	"path"
	"regexp"
	"strings"
	"time"
)

// analyticsIDPattern is what a Google tag ID looks like (G-XXXXXXXXXX,
// GTM-XXXX, UA-12345-1, AW-123456789): letters, digits, "-" and "_". The ID
// is written into a script URL and a JS string literal, so nothing else gets in.
var analyticsIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// validAnalyticsID reports whether id can be written into the tag.
func validAnalyticsID(id string) bool { return analyticsIDPattern.MatchString(id) }

// analyticsIDFromEnv turns the GOOGLE_ANALYTICS_ID value into the ID to use:
// "" when it is unset or is not a tag ID, in which case analytics is off and
// the reason is logged once, at startup.
func analyticsIDFromEnv(value string) string {
	id := strings.TrimSpace(value)
	if id == "" {
		return ""
	}
	if !validAnalyticsID(id) {
		log.Printf("Google Analytics disabled: GOOGLE_ANALYTICS_ID %q is not a tag ID (letters, digits, '-' and '_' only)", id)
		return ""
	}
	return id
}

// gtagTagPrefix is the start of the script tag getAnalyticsScript writes. A
// page that already carries a tag is not given a second one.
const gtagTagPrefix = `<script async src="https://www.googletagmanager.com/gtag/js`

// The compose page's URL path and its file in the embedded tree.
const (
	composePath = "/compose.html"
	composeFile = "compose.html"
)

// serveComposeStatic handles the compose page's own URLs and reports whether it
// answered. Anything else (including its assets under /compose/, and the
// listing http.FileServer gives /compose/) falls through to the static handler.
func (s *Server) serveComposeStatic(w http.ResponseWriter, r *http.Request) bool {
	// A path ending in "/" is the file server's: "/compose/" is a directory
	// listing, and "/compose.html/" is its own redirect to the file.
	if strings.HasSuffix(r.URL.Path, "/") {
		return false
	}
	// FileServer cleans the path before it serves, so "//compose.html" and
	// "/./compose.html" are the page too; match what it would serve.
	switch path.Clean(r.URL.Path) {
	case "/compose":
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
	// Matched as the whole tag, not a substring: this is a file we ship, so a
	// tag in it means someone added one by hand, and the idempotence stops there.
	// (injectAnalytics itself does not look: "/" pages echo stored model text
	// and ?title= into their head, and a name that mentions the URL must not
	// switch analytics off for its page.)
	if !bytes.Contains(data, []byte(gtagTagPrefix)) {
		data = s.injectAnalytics(data)
	}
	sum := sha256.Sum256(data)
	w.Header().Set("ETag", `"`+hex.EncodeToString(sum[:8])+`"`)
	// The page is not content-hashed and the tag depends on the configured ID:
	// a cached copy is only safe if the browser asks before it uses it. The
	// ETag makes that a 304 with no body when nothing changed.
	w.Header().Set("Cache-Control", "no-cache")
	// A zero modtime: the embedded tree has none, so no Last-Modified is sent
	// and If-Modified-Since is ignored; If-None-Match against the ETag does the
	// work. The name's extension gives "text/html; charset=utf-8".
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}
