package main

import (
	"bytes"
	"encoding/json"
	"image/png"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/static"
)

const testGAID = "G-TESTONLY1"

func composeServer(t *testing.T, gaID string) *Server {
	t.Helper()
	publicFS, err := static.Public()
	if err != nil {
		t.Fatalf("static.Public: %v", err)
	}
	return &Server{publicFS: publicFS, googleAnalyticsID: gaID, storage: NewFSStorage(t.TempDir())}
}

func servePage(s *Server, method, target string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

// With an analytics ID configured the page carries the tag once, inside <head>,
// and is served as HTML.
func TestComposePageAnalyticsInjectedOnce(t *testing.T) {
	s := composeServer(t, testGAID)
	rec := servePage(s, "GET", "/compose.html", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("Content-Type = %q, want text/html", ct)
	}
	body := rec.Body.String()
	for _, want := range []string{
		`https://www.googletagmanager.com/gtag/js?id=` + testGAID,
		`gtag('config', '` + testGAID + `')`,
	} {
		if n := strings.Count(body, want); n != 1 {
			t.Errorf("%q appears %d times, want exactly 1", want, n)
		}
	}
	if n := strings.Count(body, "googletagmanager.com"); n != 1 {
		t.Errorf("googletagmanager.com appears %d times, want 1", n)
	}
	i, j := strings.Index(body, "googletagmanager.com"), strings.Index(body, "</head>")
	if i < 0 || j < 0 || i > j {
		t.Errorf("the tag is not inside <head> (tag at %d, </head> at %d)", i, j)
	}
}

// Unset, the page is the embedded file byte for byte.
func TestComposePageNoAnalyticsWhenUnset(t *testing.T) {
	s := composeServer(t, "")
	rec := servePage(s, "GET", "/compose.html", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	want, err := fs.ReadFile(s.publicFS, "compose.html")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(rec.Body.Bytes(), want) {
		t.Error("with no analytics ID the response differs from the embedded compose.html")
	}
	if strings.Contains(rec.Body.String(), "googletagmanager") || strings.Contains(rec.Body.String(), "gtag(") {
		t.Error("analytics present although GOOGLE_ANALYTICS_ID is unset")
	}
}

// A page that already carries the tag is not tagged a second time.
func TestInjectAnalyticsIsIdempotent(t *testing.T) {
	s := &Server{googleAnalyticsID: testGAID}
	once := s.injectAnalytics([]byte("<html><head><title>x</title></head><body></body></html>"))
	twice := s.injectAnalytics(once)
	if !bytes.Equal(once, twice) {
		t.Error("injecting twice changed the page")
	}
	if n := bytes.Count(twice, []byte("gtag/js")); n != 1 {
		t.Errorf("gtag/js appears %d times after two injections, want 1", n)
	}
}

// HEAD and conditional requests keep working on the injected page.
func TestComposePageHeadAndConditional(t *testing.T) {
	s := composeServer(t, testGAID)
	get := servePage(s, "GET", "/compose.html", nil)
	etag := get.Header().Get("ETag")
	if etag == "" {
		t.Fatal("no ETag on the injected page")
	}

	head := servePage(s, "HEAD", "/compose.html", nil)
	if head.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d", head.Code)
	}
	if head.Body.Len() != 0 {
		t.Errorf("HEAD returned a %d-byte body", head.Body.Len())
	}
	if ct := head.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("HEAD Content-Type = %q", ct)
	}
	if cl := head.Header().Get("Content-Length"); cl != get.Header().Get("Content-Length") || cl == "" {
		t.Errorf("HEAD Content-Length = %q, GET's = %q", cl, get.Header().Get("Content-Length"))
	}
	if head.Header().Get("ETag") != etag {
		t.Errorf("HEAD ETag = %q, GET's = %q", head.Header().Get("ETag"), etag)
	}

	nm := servePage(s, "GET", "/compose.html", map[string]string{"If-None-Match": etag})
	if nm.Code != http.StatusNotModified || nm.Body.Len() != 0 {
		t.Errorf("If-None-Match with the current ETag: status %d, %d body bytes; want 304 and none", nm.Code, nm.Body.Len())
	}
	stale := servePage(s, "GET", "/compose.html", map[string]string{"If-None-Match": `"stale"`})
	if stale.Code != http.StatusOK || !bytes.Equal(stale.Body.Bytes(), get.Body.Bytes()) {
		t.Errorf("If-None-Match with a stale ETag: status %d, want the full page", stale.Code)
	}
	// An If-Modified-Since the embedded tree cannot answer (no mtime) must not break the page.
	ims := servePage(s, "GET", "/compose.html", map[string]string{"If-Modified-Since": "Wed, 21 Oct 2026 07:28:00 GMT"})
	if ims.Code != http.StatusOK || !bytes.Equal(ims.Body.Bytes(), get.Body.Bytes()) {
		t.Errorf("If-Modified-Since: status %d, want the full page", ims.Code)
	}
	// The tag is a function of the configured ID: a different ID is a different ETag.
	other := composeServer(t, "G-OTHERONE22")
	if servePage(other, "GET", "/compose.html", nil).Header().Get("ETag") == etag {
		t.Error("ETag does not change with the analytics ID")
	}
	// A query string does not change what is served.
	if q := servePage(s, "GET", "/compose.html?x=1", nil); q.Code != http.StatusOK || !bytes.Equal(q.Body.Bytes(), get.Body.Bytes()) {
		t.Errorf("/compose.html?x=1: status %d, body differs", q.Code)
	}
}

// The short names go to the page, not to a listing of its source directory; the
// directory's files are still served; FileServer's own redirects are unchanged.
func TestComposeRedirects(t *testing.T) {
	s := composeServer(t, testGAID)
	for _, c := range []struct{ from, to string }{
		{"/compose", "/compose.html"},
		{"/compose/", "/compose.html"},
		{"/compose?x=1", "/compose.html?x=1"},
	} {
		rec := servePage(s, "GET", c.from, nil)
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != c.to {
			t.Errorf("GET %s = %d -> %q, want 302 -> %s", c.from, rec.Code, rec.Header().Get("Location"), c.to)
		}
	}
	// FileServer drops a trailing slash after a file, with a relative Location
	// ("../compose.html"); resolved against the request it is the page.
	rec := servePage(s, "GET", "/compose.html/", nil)
	base, _ := url.Parse("http://pflow.test/compose.html/")
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil || rec.Code != http.StatusMovedPermanently || base.ResolveReference(loc).Path != "/compose.html" {
		t.Errorf("GET /compose.html/ = %d -> %q, want 301 -> /compose.html", rec.Code, rec.Header().Get("Location"))
	}
	// The page's modules and styles live under /compose/ and are not redirected.
	for _, p := range []string{"/compose/app.js", "/compose/compose.css"} {
		rec := servePage(s, "GET", p, nil)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", p, rec.Code)
		}
	}
	if rec := servePage(s, "GET", "/compose/app.js", nil); strings.Contains(rec.Body.String(), "googletagmanager") {
		t.Error("a module under /compose/ was tagged with analytics")
	}
}

// Which pages carry Google Analytics. The privacy page says "the editor's home
// page"; this is the list that sentence has to match.
func TestAnalyticsPages(t *testing.T) {
	s := composeServer(t, testGAID)
	for _, p := range []string{"/", "/compose.html"} {
		body := servePage(s, "GET", p, nil).Body.String()
		if n := strings.Count(body, "googletagmanager.com"); n != 1 {
			t.Errorf("%s: googletagmanager.com appears %d times, want 1", p, n)
		}
	}
	for _, p := range []string{"/mcp.html", "/privacy.html", "/terms.html", "/test-solver.html", "/schema", "/compose/app.js", "/petri-view.js"} {
		req := httptest.NewRequest("GET", p, nil)
		req.Header.Set("Accept", "text/html")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status %d", p, rec.Code)
			continue
		}
		if strings.Contains(rec.Body.String(), "googletagmanager.com") {
			t.Errorf("%s carries analytics; the privacy page lists only / and /compose.html", p)
		}
	}
}

// Every static page in the sitemap resolves, which is what the sitemap promises.
func TestSitemapStaticEntriesResolve(t *testing.T) {
	s := composeServer(t, "")
	rec := httptest.NewRecorder()
	s.handleSitemap(rec, httptest.NewRequest("GET", "/sitemap.xml", nil))
	var found bool
	for _, loc := range sitemapURLs(t, rec.Body.String()) {
		path := strings.TrimPrefix(loc, "https://pflow.xyz")
		if strings.HasPrefix(path, "/img/") {
			continue
		}
		if path == "/compose.html" {
			found = true
		}
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Accept", "text/html")
		got := httptest.NewRecorder()
		s.ServeHTTP(got, req)
		if got.Code != http.StatusOK {
			t.Errorf("sitemap lists %s but it answers %d", loc, got.Code)
		}
	}
	if !found {
		t.Error("/compose.html is not in the sitemap")
	}
}

// The head the page ships: absolute URLs, a PNG share image that exists and has
// the declared size, and JSON-LD that parses.
func TestComposePageHead(t *testing.T) {
	s := composeServer(t, "")
	raw, err := fs.ReadFile(s.publicFS, "compose.html")
	if err != nil {
		t.Fatal(err)
	}
	page := string(raw)
	head := page[:strings.Index(page, "</head>")]

	meta := func(attr, name string) string {
		m := regexp.MustCompile(`<meta\s+` + attr + `="` + regexp.QuoteMeta(name) + `"\s+content="([^"]*)"`).FindStringSubmatch(head)
		if m == nil {
			t.Errorf("head has no <meta %s=%q>", attr, name)
			return ""
		}
		return m[1]
	}
	if n := strings.Count(head, `rel="canonical"`); n != 1 {
		t.Errorf("want exactly one canonical link, got %d", n)
	}
	if !strings.Contains(head, `<link rel="canonical" href="https://pflow.xyz/compose.html">`) {
		t.Error("canonical is not https://pflow.xyz/compose.html")
	}
	for _, p := range []string{"og:title", "og:description", "og:type", "og:url", "og:image", "og:image:alt", "og:image:type", "og:image:width", "og:image:height", "og:site_name"} {
		if meta("property", p) == "" {
			t.Errorf("empty or missing %s", p)
		}
	}
	for _, n := range []string{"description", "theme-color", "twitter:card", "twitter:title", "twitter:description", "twitter:image", "twitter:image:alt"} {
		if meta("name", n) == "" {
			t.Errorf("empty or missing %s", n)
		}
	}
	if got := meta("name", "twitter:card"); got != "summary_large_image" {
		t.Errorf("twitter:card = %q", got)
	}
	for _, u := range []string{meta("property", "og:url"), meta("property", "og:image"), meta("name", "twitter:image")} {
		if !strings.HasPrefix(u, "https://pflow.xyz/") {
			t.Errorf("%q is not an absolute https://pflow.xyz/ URL", u)
		}
	}
	if meta("property", "og:image") != meta("name", "twitter:image") {
		t.Error("og:image and twitter:image differ")
	}

	// The share image is a PNG the static handler serves, 1200x630, under 150 KB.
	img := strings.TrimPrefix(meta("property", "og:image"), "https://pflow.xyz/")
	rec := servePage(s, "GET", "/"+img, nil)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("GET /%s = %d %q, want 200 image/png", img, rec.Code, rec.Header().Get("Content-Type"))
	}
	if rec.Body.Len() > 150*1024 {
		t.Errorf("%s is %d bytes; keep share images under 150 KB", img, rec.Body.Len())
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(rec.Body.Bytes()))
	if err != nil {
		t.Fatalf("%s is not a PNG: %v", img, err)
	}
	if cfg.Width != 1200 || cfg.Height != 630 {
		t.Errorf("%s is %dx%d, want 1200x630", img, cfg.Width, cfg.Height)
	}
	if meta("property", "og:image:width") != "1200" || meta("property", "og:image:height") != "630" {
		t.Error("og:image:width/height do not say 1200x630")
	}

	// JSON-LD: parses, and names the page and the application.
	m := regexp.MustCompile(`(?s)<script type="application/ld\+json">(.*?)</script>`).FindStringSubmatch(head)
	if m == nil {
		t.Fatal("no JSON-LD in the head")
	}
	var doc struct {
		Context string `json:"@context"`
		Graph   []struct {
			Type string `json:"@type"`
			URL  string `json:"url"`
		} `json:"@graph"`
	}
	if err := json.Unmarshal([]byte(m[1]), &doc); err != nil {
		t.Fatalf("JSON-LD does not parse: %v", err)
	}
	types := map[string]string{}
	for _, n := range doc.Graph {
		types[n.Type] = n.URL
	}
	for _, want := range []string{"WebPage", "WebApplication"} {
		if types[want] != "https://pflow.xyz/compose.html" {
			t.Errorf("JSON-LD has no %s with url https://pflow.xyz/compose.html (got %v)", want, types)
		}
	}
	// The head names no analytics of its own: the server adds the tag.
	if strings.Contains(page, "googletagmanager") {
		t.Error("compose.html ships its own analytics tag; the server injects it")
	}
}
