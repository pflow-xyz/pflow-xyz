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
	"testing/fstest"

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

// The compose page is never tagged twice: a copy of the file that already
// carries the tag is served as it is, and only the whole tag counts, not a
// mention of its URL.
func TestComposePageNeverTaggedTwice(t *testing.T) {
	serve := func(page string) string {
		s := &Server{publicFS: fstest.MapFS{"compose.html": {Data: []byte(page)}}, googleAnalyticsID: testGAID}
		rec := servePage(s, "GET", "/compose.html", nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		return rec.Body.String()
	}
	own := `<html><head><title>x</title>` + gtagTagPrefix + `?id=G-HANDADDED"></script></head><body></body></html>`
	if got := serve(own); got != own {
		t.Errorf("a page with its own tag was changed:\n%s", got)
	}
	// The tag the server writes is the one the guard recognises.
	s := &Server{googleAnalyticsID: testGAID}
	if !strings.Contains(s.getAnalyticsScript(), gtagTagPrefix) {
		t.Errorf("getAnalyticsScript does not write %q; gtagTagPrefix has drifted", gtagTagPrefix)
	}
	once := serve(`<html><head><title>x</title></head><body></body></html>`)
	if n := strings.Count(once, gtagTagPrefix); n != 1 {
		t.Errorf("a plain page got %d tags, want 1", n)
	}
	// The URL in running text is not a tag: the page still gets its own.
	mention := serve(`<html><head><title>about googletagmanager.com/gtag/js</title></head><body></body></html>`)
	if n := strings.Count(mention, gtagTagPrefix); n != 1 {
		t.Errorf("a page that only mentions the URL got %d tags, want 1", n)
	}
}

// "/" is tagged exactly once even when the model it shows echoes the tag's URL
// into the head (a title override, or a stored name): the shared injector must
// not read the document, or such a model's page loses analytics.
func TestRootTaggedOnceWhateverTheHeadSays(t *testing.T) {
	const landing = `<!DOCTYPE html><html><head><title>pflow</title></head><body>landing</body></html>`
	s := &Server{
		storage:           &missingStorage{raw: loadSample(t)},
		publicFS:          fstest.MapFS{"index.html": {Data: []byte(landing)}},
		googleAnalyticsID: testGAID,
	}
	for _, q := range []string{
		"",
		"?cid=" + sampleCID,
		"?cid=" + sampleCID + "&title=see+googletagmanager.com/gtag/js+here",
		"?title=googletagmanager.com/gtag/js",
	} {
		rec := servePage(s, "GET", "/"+q, nil)
		body := rec.Body.String()
		if n := strings.Count(body, gtagTagPrefix); n != 1 {
			t.Errorf("GET /%s: %d analytics tags, want 1", q, n)
		}
		if strings.Contains(q, "title=") && strings.Contains(q, "cid=") {
			// Make sure the case is the one that matters: the head echoes the text.
			if n := strings.Count(body, "googletagmanager.com/gtag/js"); n < 2 {
				t.Errorf("GET /%s: the head does not echo the title (%d mentions); the case no longer tests anything", q, n)
			}
		}
	}
}

// A GOOGLE_ANALYTICS_ID that is not a tag ID is not written into the page.
func TestAnalyticsIDIsValidated(t *testing.T) {
	for _, id := range []string{"G-E7Q5BVDGYB", "GTM-ABC123", "UA-12345-1", "AW-123456789", "G_x-9"} {
		if !validAnalyticsID(id) {
			t.Errorf("%q rejected", id)
		}
		if got := analyticsIDFromEnv(" " + id + "\n"); got != id {
			t.Errorf("analyticsIDFromEnv(%q) = %q, want %q", id, got, id)
		}
	}
	hostile := []string{
		`G-X'); alert(1); //`,
		`G-X"></script><script>alert(1)</script>`,
		"G-X\nG-Y",
		`G-X&l=evil`,
		`G-X?id=Y`,
		"G X",
		"G-é",
		`</script>`,
	}
	for _, id := range hostile {
		if validAnalyticsID(id) {
			t.Errorf("%q accepted", id)
		}
		if got := analyticsIDFromEnv(id); got != "" {
			t.Errorf("analyticsIDFromEnv(%q) = %q, want analytics off", id, got)
		}
		// A Server built any other way is protected too: no tag at all.
		s := &Server{googleAnalyticsID: id, publicFS: fstest.MapFS{"compose.html": {Data: []byte("<html><head></head></html>")}}}
		if script := s.getAnalyticsScript(); script != "" {
			t.Errorf("getAnalyticsScript with ID %q wrote %q", id, script)
		}
		if got := s.injectAnalytics([]byte("<head></head>")); string(got) != "<head></head>" {
			t.Errorf("injectAnalytics with ID %q changed the page: %s", id, got)
		}
		if body := servePage(s, "GET", "/compose.html", nil).Body.String(); strings.Contains(body, "script") {
			t.Errorf("the compose page with ID %q carries a script: %s", id, body)
		}
	}
	if got := analyticsIDFromEnv(""); got != "" {
		t.Errorf("unset = %q", got)
	}
	if got := analyticsIDFromEnv("   "); got != "" {
		t.Errorf("blank = %q", got)
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
	// Revalidate before every use: the page is not content-hashed and the tag
	// follows the configured ID, so a cached copy must be asked about.
	if cc := get.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("GET Cache-Control = %q, want no-cache", cc)
	}
	if cc := head.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("HEAD Cache-Control = %q, want no-cache", cc)
	}

	nm := servePage(s, "GET", "/compose.html", map[string]string{"If-None-Match": etag})
	if nm.Code != http.StatusNotModified || nm.Body.Len() != 0 {
		t.Errorf("If-None-Match with the current ETag: status %d, %d body bytes; want 304 and none", nm.Code, nm.Body.Len())
	}
	if cc := nm.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("304 Cache-Control = %q, want no-cache", cc)
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

// "/compose" goes to the page, not to a listing of its source directory; the
// directory's files and its listing are still the file server's, and so are its
// own redirects.
func TestComposeRedirects(t *testing.T) {
	s := composeServer(t, testGAID)
	for _, c := range []struct{ from, to string }{
		{"/compose", "/compose.html"},
		{"/compose?x=1", "/compose.html?x=1"},
		{"//compose", "/compose.html"},
		{"/./compose", "/compose.html"},
	} {
		rec := servePage(s, "GET", c.from, nil)
		if rec.Code != http.StatusFound || rec.Header().Get("Location") != c.to {
			t.Errorf("GET %s = %d -> %q, want 302 -> %s", c.from, rec.Code, rec.Header().Get("Location"), c.to)
		}
	}
	// "/compose/" is a directory: the file server lists it, as it did before
	// this page was decorated (and as a perf-branch test pins).
	rec := servePage(s, "GET", "/compose/", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `href="app.js"`) {
		t.Errorf("GET /compose/ = %d, want the file server's directory listing", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "googletagmanager") {
		t.Error("the /compose/ listing was tagged with analytics")
	}
	// FileServer drops a trailing slash after a file, with a relative Location
	// ("../compose.html"); resolved against the request it is the page.
	rec = servePage(s, "GET", "/compose.html/", nil)
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

// Every spelling of the page's path that the file server would resolve to it
// is served the same way: tagged once, with the same ETag and cache header.
func TestComposePageSpellings(t *testing.T) {
	s := composeServer(t, testGAID)
	want := servePage(s, "GET", "/compose.html", nil)
	if want.Header().Get("ETag") == "" || want.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("the canonical response has ETag %q, Cache-Control %q", want.Header().Get("ETag"), want.Header().Get("Cache-Control"))
	}
	for _, p := range []string{"//compose.html", "/./compose.html", "/x/../compose.html", "///compose.html", "/compose/../compose.html", "/compose.html/."} {
		rec := servePage(s, "GET", p, nil)
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", p, rec.Code)
			continue
		}
		if n := strings.Count(rec.Body.String(), "googletagmanager.com/gtag/js"); n != 1 {
			t.Errorf("GET %s: the analytics tag appears %d times, want 1", p, n)
		}
		if !bytes.Equal(rec.Body.Bytes(), want.Body.Bytes()) || rec.Header().Get("ETag") != want.Header().Get("ETag") ||
			rec.Header().Get("Cache-Control") != "no-cache" {
			t.Errorf("GET %s is served differently from /compose.html", p)
		}
	}
	// A method the page does not answer is left to the file server, as before.
	if rec := servePage(s, "POST", "/compose.html", nil); rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "googletagmanager") {
		t.Error("a POST to the page was answered with the tagged page")
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
	// Search results show about 160 characters; the share-card texts may run longer.
	if d := []rune(meta("name", "description")); len(d) > 160 {
		t.Errorf("meta description is %d characters, keep it to 160", len(d))
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
			Type   string                 `json:"@type"`
			URL    string                 `json:"url"`
			Offers map[string]interface{} `json:"offers"`
			Rating interface{}            `json:"aggregateRating"`
			Review interface{}            `json:"review"`
		} `json:"@graph"`
	}
	if err := json.Unmarshal([]byte(m[1]), &doc); err != nil {
		t.Fatalf("JSON-LD does not parse: %v", err)
	}
	types := map[string]string{}
	for _, n := range doc.Graph {
		types[n.Type] = n.URL
		// Nothing is claimed that is not so: free to use, and no ratings or reviews.
		if n.Rating != nil || n.Review != nil {
			t.Errorf("%s carries a rating or review; there are none", n.Type)
		}
		if n.Type == "WebApplication" {
			if n.Offers["@type"] != "Offer" || n.Offers["price"] != "0" || n.Offers["priceCurrency"] != "USD" {
				t.Errorf("WebApplication offers = %v, want a free Offer", n.Offers)
			}
		}
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
