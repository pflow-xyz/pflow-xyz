package main

import (
	"net/http/httptest"
	"strings"
	"testing"
)

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
	for _, want := range []string{"<loc>https://pflow.xyz/</loc>", "/?cid=" + good, "/img/" + good + ".svg"} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in\n%s", want, body)
		}
	}
	if n := strings.Count(body, "<url>"); n != 4 {
		t.Errorf("expected 4 urls, got %d", n)
	}
}
