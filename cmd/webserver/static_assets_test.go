package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func staticTestServer() (*Server, []byte) {
	js := []byte(strings.Repeat("export const answer = 42; // a line of a module\n", 200))
	return &Server{publicFS: fstest.MapFS{
		"compose/app.js":       {Data: js},
		"tiny.js":              {Data: []byte("export {};\n")},
		"data.json":            {Data: []byte(`{"k":"` + strings.Repeat("v", 3000) + `"}`)},
		"logo.png":             {Data: bytes.Repeat([]byte{0x89, 'P', 'N', 'G', 1, 2, 3, 4}, 400)},
		"compose/chyp/th.chyp": {Data: []byte(strings.Repeat("rule r : a = b\n", 200))},
		"index.html":           {Data: []byte("<!doctype html><title>x</title>")},
		"sub/index.html":       {Data: []byte("<!doctype html><title>sub</title>")},
	}}, js
}

func get(s *Server, target string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", target, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestStaticGzipAndValidators(t *testing.T) {
	s, js := staticTestServer()

	rec := get(s, "/compose/app.js", map[string]string{"Accept-Encoding": "gzip, deflate, br"})
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("gzip client: %d %v", rec.Code, rec.Header())
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := io.ReadAll(zr); !bytes.Equal(got, js) {
		t.Fatal("the gzip body does not decompress to the file")
	}
	h := rec.Header()
	etagGz := h.Get("ETag")
	if etagGz == "" || h.Get("Cache-Control") != "no-cache" || !strings.Contains(h.Get("Vary"), "Accept-Encoding") {
		t.Fatalf("validators and Vary missing: %v", h)
	}
	if h.Get("Content-Type") != "text/javascript; charset=utf-8" || h.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("type or CORS lost: %v", h)
	}
	if n := rec.Body.Len(); n != 0 && h.Get("Content-Length") == "" {
		t.Fatal("no Content-Length on the gzip body")
	}

	// the same bytes, revalidated: 304 and no body
	rec = get(s, "/compose/app.js", map[string]string{"Accept-Encoding": "gzip", "If-None-Match": etagGz})
	if rec.Code != 304 || rec.Body.Len() != 0 {
		t.Fatalf("matching If-None-Match: %d, %d body bytes", rec.Code, rec.Body.Len())
	}

	// a client without gzip gets the file as it is, under another ETag
	rec = get(s, "/compose/app.js", nil)
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "" || !bytes.Equal(rec.Body.Bytes(), js) {
		t.Fatalf("identity client: %d %v", rec.Code, rec.Header())
	}
	etagID := rec.Header().Get("ETag")
	if etagID == "" || etagID == etagGz || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("the identity form needs its own ETag: %q vs %q", etagID, etagGz)
	}
	rec = get(s, "/compose/app.js", map[string]string{"If-None-Match": etagID})
	if rec.Code != 304 {
		t.Fatalf("identity If-None-Match: %d", rec.Code)
	}
	// the gzip form's ETag does not validate the identity form
	rec = get(s, "/compose/app.js", map[string]string{"If-None-Match": etagGz})
	if rec.Code != 200 {
		t.Fatalf("a gzip ETag matched the identity form: %d", rec.Code)
	}

	rec = get(s, "/compose/app.js", map[string]string{"Accept-Encoding": "gzip;q=0"})
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatal("gzip;q=0 refuses gzip")
	}

	// HEAD answers the headers of the form GET would send
	req := httptest.NewRequest("HEAD", "/compose/app.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "gzip" || rec.Body.Len() != 0 {
		t.Fatalf("HEAD: %d %v", rec.Code, rec.Header())
	}
}

func TestStaticWhatIsNotCompressed(t *testing.T) {
	s, _ := staticTestServer()
	gzipOK := map[string]string{"Accept-Encoding": "gzip"}

	// too small to be worth it: still validated
	rec := get(s, "/tiny.js", gzipOK)
	if rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("ETag") == "" || rec.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("tiny.js: %v", rec.Header())
	}
	// already compressed formats are left alone but validated
	rec = get(s, "/logo.png", gzipOK)
	if rec.Header().Get("Content-Encoding") != "" || rec.Header().Get("ETag") == "" || rec.Header().Get("Vary") != "" {
		t.Fatalf("logo.png: %v", rec.Header())
	}
	rec2 := get(s, "/logo.png", map[string]string{"Accept-Encoding": "gzip", "If-None-Match": rec.Header().Get("ETag")})
	if rec2.Code != 304 {
		t.Fatalf("logo.png If-None-Match: %d", rec2.Code)
	}
	// files the browser fetches from Python and Chyp's loaders are text too
	rec = get(s, "/compose/chyp/th.chyp", gzipOK)
	if rec.Header().Get("Content-Encoding") != "gzip" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/plain") {
		t.Fatalf("th.chyp: %v", rec.Header())
	}
	rec = get(s, "/data.json", gzipOK)
	if rec.Header().Get("Content-Encoding") != "gzip" || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("data.json: %v", rec.Header())
	}
}

func TestStaticLeavesTheFileServerWhatItDoes(t *testing.T) {
	s, _ := staticTestServer()
	// /index.html redirects to ./ (the landing page is served by "/" with its decorations)
	if rec := get(s, "/index.html", nil); rec.Code != http.StatusMovedPermanently {
		t.Fatalf("/index.html: %d", rec.Code)
	}
	if rec := get(s, "/sub/", nil); rec.Code != 200 || !strings.Contains(rec.Body.String(), "sub") {
		t.Fatalf("/sub/: %d %q", rec.Code, rec.Body.String())
	}
	if rec := get(s, "/nope.js", nil); rec.Code != 404 {
		t.Fatalf("/nope.js: %d", rec.Code)
	}
	if rec := get(s, "/compose/", nil); rec.Code != 200 {
		t.Fatalf("/compose/ (a directory listing): %d", rec.Code)
	}
	// a range request on an identity file still works (FileServer)
	req := httptest.NewRequest("GET", "/logo.png", nil)
	req.Header.Set("Range", "bytes=0-3")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.Len() != 4 {
		t.Fatalf("range: %d %d", rec.Code, rec.Body.Len())
	}
}

func TestEtagMatches(t *testing.T) {
	for _, c := range []struct {
		h, e string
		want bool
	}{
		{`"a"`, `"a"`, true},
		{`W/"a"`, `"a"`, true},
		{`"b", "a"`, `"a"`, true},
		{`*`, `"a"`, true},
		{`"b"`, `"a"`, false},
		{``, `"a"`, false},
	} {
		if got := etagMatches(c.h, c.e); got != c.want {
			t.Errorf("etagMatches(%q, %q) = %v", c.h, c.e, got)
		}
	}
}

// chooseEncoding reads Accept-Encoding the way RFC 9110 12.5.3 does: tokens
// without regard to case, "*" for every coding not named, q-values ranking
// them, a bad or zero q meaning not accepted. The server offers gzip alone, or
// br and gzip (the wasm), br first: it wins a tie.
func TestChooseEncoding(t *testing.T) {
	for _, c := range []struct {
		name, header string
		offered      []string
		want         string
	}{
		{"nothing", "", []string{"gzip"}, ""},
		{"gzip", "gzip", []string{"gzip"}, "gzip"},
		{"a browser", "gzip, deflate, br, zstd", []string{"gzip"}, "gzip"},
		{"upper case", "GZIP", []string{"gzip"}, "gzip"},
		{"mixed case and spaces", "  Gzip ; Q=0.5 ,  BR ", []string{"br", "gzip"}, "br"},
		{"a star accepts what is not named", "*", []string{"gzip"}, "gzip"},
		{"a star with a q", "*;q=0.3", []string{"gzip"}, "gzip"},
		{"a star refused", "*;q=0", []string{"gzip"}, ""},
		{"named beats the star", "gzip;q=0, *", []string{"gzip"}, ""},
		{"named beats the star, the other way", "gzip, *;q=0", []string{"gzip", "br"}, "gzip"},
		{"identity only", "identity", []string{"gzip"}, ""},
		{"q=0", "gzip;q=0", []string{"gzip"}, ""},
		{"q=0.0 and q=0.000", "gzip;q=0.0, br;q=0.000", []string{"br", "gzip"}, ""},
		{"q=00", "gzip;q=00", []string{"gzip"}, ""},
		{"Q=0 in upper case", "gzip;Q=0", []string{"gzip"}, ""},
		{"q= 0 with spaces", "gzip ; q = 0", []string{"gzip"}, ""},
		{"q=abc is not accepted", "gzip;q=abc", []string{"gzip"}, ""},
		{"an empty q", "gzip;q=", []string{"gzip"}, ""},
		{"a q above 1", "gzip;q=1.5", []string{"gzip"}, ""},
		{"a negative q", "gzip;q=-1", []string{"gzip"}, ""},
		{"an exponent is not a q", "gzip;q=1e-1", []string{"gzip"}, ""},
		{"NaN is not a q", "gzip;q=NaN", []string{"gzip"}, ""},
		{"a bare point", "gzip;q=.5", []string{"gzip"}, ""},
		{"q=1.000", "gzip;q=1.000", []string{"gzip"}, "gzip"},
		{"a bad q on one coding leaves the others", "br;q=abc, gzip", []string{"br", "gzip"}, "gzip"},
		{"a parameter before q", "gzip;x=1;q=0", []string{"gzip"}, ""},
		{"a parameter that is not q", "gzip;level=9", []string{"gzip"}, "gzip"},
		{"the higher q wins", "br;q=0.1, gzip;q=1", []string{"br", "gzip"}, "gzip"},
		{"the higher q wins, the other way", "br;q=0.9, gzip;q=0.8", []string{"br", "gzip"}, "br"},
		{"a tie goes to the first offered", "gzip, br", []string{"br", "gzip"}, "br"},
		{"a tie goes to the first offered (q)", "gzip;q=0.5, br;q=0.5", []string{"br", "gzip"}, "br"},
		{"a coding the server does not have", "br", []string{"gzip"}, ""},
		{"br without a .br file", "br, gzip;q=0.1", []string{"gzip"}, "gzip"},
		{"the first listing of a coding counts", "gzip;q=0, gzip", []string{"gzip"}, ""},
		{"identity preferred", "identity, gzip;q=0.5", []string{"gzip"}, ""},
		{"identity listed lower", "gzip, identity;q=0.5", []string{"gzip"}, "gzip"},
		{"identity tied with gzip", "gzip, identity", []string{"gzip"}, "gzip"},
		{"empty items", ",, gzip,,", []string{"gzip"}, "gzip"},
	} {
		req := httptest.NewRequest("GET", "/x", nil)
		if c.header != "" {
			req.Header.Set("Accept-Encoding", c.header)
		}
		if got := chooseEncoding(req, c.offered...); got != c.want {
			t.Errorf("%s: chooseEncoding(%q, %v) = %q, want %q", c.name, c.header, c.offered, got, c.want)
		}
	}
	// several header lines are one list
	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Add("Accept-Encoding", "deflate")
	req.Header.Add("Accept-Encoding", "gzip")
	if got := chooseEncoding(req, "gzip"); got != "gzip" {
		t.Errorf("two Accept-Encoding lines: %q", got)
	}
}

func TestStaticAcceptEncodingOverHTTP(t *testing.T) {
	s, js := staticTestServer()
	for _, c := range []struct {
		header string
		gzip   bool
	}{
		{"GZIP", true},
		{"Gzip;Q=1", true},
		{"*", true},
		{"deflate, *;q=0.1", true},
		{"gzip;q=abc", false},
		{"gzip;q=00", false},
		{"gzip;Q=0", false},
		{"*;q=0", false},
		{"br", false},
		{"identity, gzip;q=0.5", false},
	} {
		rec := get(s, "/compose/app.js", map[string]string{"Accept-Encoding": c.header})
		if got := rec.Header().Get("Content-Encoding") == "gzip"; got != c.gzip {
			t.Errorf("Accept-Encoding %q: gzip=%v, want %v", c.header, got, c.gzip)
		}
		if !c.gzip && !bytes.Equal(rec.Body.Bytes(), js) {
			t.Errorf("Accept-Encoding %q: the identity form is not the file", c.header)
		}
	}
}
