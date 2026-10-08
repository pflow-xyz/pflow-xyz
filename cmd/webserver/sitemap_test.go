package main

import (
	"encoding/xml"
	"net/http/httptest"
	"strings"
	"testing"
)

// sitemapURLs parses a rendered sitemap and returns its <loc> values in
// document order. Parsing (rather than substring checks) is what proves the
// output is well-formed XML a crawler will accept.
func sitemapURLs(t *testing.T, body string) []string {
	t.Helper()
	var doc struct {
		URLs []struct {
			Loc      string `xml:"loc"`
			Priority string `xml:"priority"`
		} `xml:"url"`
	}
	if err := xml.Unmarshal([]byte(body), &doc); err != nil {
		t.Fatalf("sitemap is not valid XML: %v\n%s", err, body)
	}
	locs := make([]string, 0, len(doc.URLs))
	for _, u := range doc.URLs {
		locs = append(locs, u.Loc)
	}
	return locs
}

func TestSitemapListsOnlyStoredObjects(t *testing.T) {
	dir := t.TempDir()
	storage := NewFSStorage(dir)
	const good = "z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8"
	if err := storage.SaveObject(good, []byte(`{"@type":"PetriNet"}`), []byte("c")); err != nil {
		t.Fatal(err)
	}
	srv := &Server{storage: storage}
	rec := httptest.NewRecorder()
	srv.handleSitemap(rec, httptest.NewRequest("GET", "/sitemap.xml", nil))
	body := rec.Body.String()
	for _, want := range []string{"<loc>https://pflow.xyz/</loc>", "<loc>https://pflow.xyz/schema</loc>", "/img/" + good + ".svg"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in\n%s", want, body)
		}
	}
	if n := strings.Count(body, "<url>"); n != 3 {
		t.Errorf("expected 3 urls (/, /schema, one svg), got %d", n)
	}
}

// The /?cid= model pages serve the same SPA shell as "/", so listing one per
// stored model advertised N duplicates of the landing page. They stay
// reachable, they just are not in the sitemap.
func TestSitemapOmitsCIDQueryURLs(t *testing.T) {
	storage := NewFSStorage(t.TempDir())
	cids := []string{
		"z4EBG9izF5nW754U9qVfUTn8VE2NX5YoVRddibcBKjST17VFAhC",
		"z4EBG9izmK8do9jvrvDqUmRsX4A1JYPM5vEsgE31Jg1FXJ6wEkS",
		"z4EBG9izqbpRJp3epFKruG3YWqgP1QzZeKRXznoJhvijHgAA5Ps",
	}
	for _, cid := range cids {
		if err := storage.SaveObject(cid, []byte(`{"@type":"PetriNet"}`), []byte("c")); err != nil {
			t.Fatal(err)
		}
	}
	// A stored name that is not a CID must not become a sitemap entry.
	if err := storage.SaveObject("not-a-cid", []byte(`{"@type":"PetriNet"}`), []byte("c")); err != nil {
		t.Fatal(err)
	}
	srv := &Server{storage: storage}
	rec := httptest.NewRecorder()
	srv.handleSitemap(rec, httptest.NewRequest("GET", "/sitemap.xml", nil))

	if ct := rec.Header().Get("Content-Type"); ct != "application/xml; charset=utf-8" {
		t.Errorf("Content-Type = %q", ct)
	}
	body := rec.Body.String()
	if strings.Contains(body, "cid=") {
		t.Errorf("sitemap lists a ?cid= URL:\n%s", body)
	}
	locs := sitemapURLs(t, body)
	if want := 2 + len(cids); len(locs) != want {
		t.Errorf("got %d urls, want %d (/, /schema, one svg per model): %v", len(locs), want, locs)
	}
	seen := map[string]bool{}
	for _, loc := range locs {
		if seen[loc] {
			t.Errorf("duplicate url %s", loc)
		}
		seen[loc] = true
		if strings.Contains(loc, "?") {
			t.Errorf("query-string url in sitemap: %s", loc)
		}
		if !strings.HasPrefix(loc, "https://pflow.xyz/") {
			t.Errorf("url off the canonical origin: %s", loc)
		}
	}
	for _, cid := range cids {
		if !seen["https://pflow.xyz/img/"+cid+".svg"] {
			t.Errorf("missing svg for %s", cid)
		}
	}
}

func TestSitemapEmptyStore(t *testing.T) {
	srv := &Server{storage: NewFSStorage(t.TempDir())}
	rec := httptest.NewRecorder()
	srv.handleSitemap(rec, httptest.NewRequest("GET", "/sitemap.xml", nil))
	locs := sitemapURLs(t, rec.Body.String())
	if len(locs) != 2 || locs[0] != "https://pflow.xyz/" || locs[1] != "https://pflow.xyz/schema" {
		t.Errorf("empty store sitemap = %v, want [/ /schema]", locs)
	}
}
