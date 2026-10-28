package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestServeGzippedWasm(t *testing.T) {
	raw := []byte("\x00asm\x01\x00\x00\x00 pretend module")
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(raw)
	zw.Close()
	s := &Server{publicFS: fstest.MapFS{
		"vendor/x/m_bg.wasm.gz": {Data: gz.Bytes()},
		"plain.wasm":            {Data: raw},
	}}

	req := httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 || rec.Header().Get("Content-Encoding") != "gzip" || rec.Header().Get("Content-Type") != "application/wasm" {
		t.Fatalf("gzip client: %d %v", rec.Code, rec.Header())
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := io.ReadAll(zr); !bytes.Equal(got, raw) {
		t.Fatal("gzip body does not decompress to the module")
	}

	req = httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "" || !bytes.Equal(rec.Body.Bytes(), raw) {
		t.Fatalf("a client without gzip must get the raw module: %v", rec.Header())
	}

	req = httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	req.Header.Set("Accept-Encoding", "gzip;q=0")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatal("gzip;q=0 refuses gzip")
	}

	// validators: each form has its own ETag, a match is a 304, and nothing is cached without asking
	req = httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	etagGz := rec.Header().Get("ETag")
	if etagGz == "" || rec.Header().Get("Cache-Control") != "no-cache" || rec.Header().Get("Content-Length") == "" {
		t.Fatalf("the gzip form needs ETag, no-cache and Content-Length: %v", rec.Header())
	}
	req = httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("If-None-Match", etagGz)
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 304 || rec.Body.Len() != 0 {
		t.Fatalf("matching If-None-Match: %d, %d body bytes", rec.Code, rec.Body.Len())
	}
	req = httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	req.Header.Set("If-None-Match", etagGz)
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), raw) {
		t.Fatalf("the gzip ETag must not validate the decompressed form: %d", rec.Code)
	}

	req = httptest.NewRequest("GET", "/plain.wasm", nil)
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), raw) {
		t.Fatalf("a .wasm with no .gz falls through to the file server: %d", rec.Code)
	}
}

func TestServeBrotliWasm(t *testing.T) {
	raw := []byte("\x00asm\x01\x00\x00\x00 pretend module")
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(raw)
	zw.Close()
	br := []byte("pretend brotli stream") // the server never decodes it, it only sends it
	s := &Server{publicFS: fstest.MapFS{
		"vendor/x/m_bg.wasm.gz": {Data: gz.Bytes()},
		"vendor/x/m_bg.wasm.br": {Data: br},
	}}
	get := func(ae string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
		if ae != "" {
			req.Header.Set("Accept-Encoding", ae)
		}
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		return rec
	}

	rec := get("gzip, deflate, br, zstd")
	if rec.Header().Get("Content-Encoding") != "br" || !bytes.Equal(rec.Body.Bytes(), br) || rec.Header().Get("Content-Type") != "application/wasm" {
		t.Fatalf("a client that accepts br gets the .br bytes: %v", rec.Header())
	}
	etagBr := rec.Header().Get("ETag")
	rec = get("gzip, deflate")
	if rec.Header().Get("Content-Encoding") != "gzip" || !bytes.Equal(rec.Body.Bytes(), gz.Bytes()) {
		t.Fatalf("a client without br gets the .gz bytes: %v", rec.Header())
	}
	if etagBr == rec.Header().Get("ETag") || !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatalf("the two forms need their own ETag, and Vary: %q %q", etagBr, rec.Header().Get("ETag"))
	}
	if rec = get("br;q=0, gzip"); rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("br;q=0 refuses br")
	}
	if rec = get(""); rec.Header().Get("Content-Encoding") != "" || !bytes.Equal(rec.Body.Bytes(), raw) {
		t.Fatalf("a client with neither gets the raw module: %v", rec.Header())
	}
	// a .br with no .gz beside it is not served: the .gz is the form every client can be given
	only := &Server{publicFS: fstest.MapFS{"vendor/x/m_bg.wasm.br": {Data: br}}}
	req := httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	req.Header.Set("Accept-Encoding", "br")
	rec = httptest.NewRecorder()
	only.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") == "br" {
		t.Fatal("a .wasm.br without a .wasm.gz must fall through")
	}
}

// The coding is the one the request ranks highest, tokens without regard to
// case, "*" for the rest, br first on a tie; anything else is the module as it
// is (TestChooseEncoding has the full table of the header's grammar).
func TestServeWasmNegotiation(t *testing.T) {
	raw := []byte("\x00asm\x01\x00\x00\x00 pretend module")
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(raw)
	zw.Close()
	br := []byte("pretend brotli stream")
	s := &Server{publicFS: fstest.MapFS{
		"vendor/x/m_bg.wasm.gz": {Data: gz.Bytes()},
		"vendor/x/m_bg.wasm.br": {Data: br},
	}}
	get := func(ae string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
		if ae != "" {
			req.Header.Set("Accept-Encoding", ae)
		}
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		return rec
	}
	for _, c := range []struct {
		header, enc string
	}{
		{"BR", "br"},
		{"GZIP", "gzip"},
		{"Gzip, Br;Q=0.5", "gzip"},
		{"br;q=0.1, gzip;q=1", "gzip"},
		{"br;q=0.9, gzip;q=0.8", "br"},
		{"gzip, br", "br"},
		{"*", "br"},
		{"*;q=0", ""},
		{"gzip, *;q=0", "gzip"},
		{"br;q=abc, gzip", "gzip"},
		{"br;q=0, gzip;q=0", ""},
		{"gzip;q=00", ""},
		{"identity, gzip;q=0.5", ""},
		{"deflate", ""},
	} {
		rec := get(c.header)
		if rec.Code != 200 || rec.Header().Get("Content-Encoding") != c.enc {
			t.Errorf("Accept-Encoding %q: %d, Content-Encoding %q, want %q", c.header, rec.Code, rec.Header().Get("Content-Encoding"), c.enc)
			continue
		}
		var want []byte
		switch c.enc {
		case "br":
			want = br
		case "gzip":
			want = gz.Bytes()
		default:
			want = raw
		}
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("Accept-Encoding %q: wrong bytes for %q", c.header, c.enc)
		}
	}
}

// What a Range request on the wasm gets, stated: the whole body, 200, in the
// negotiated coding, with "Accept-Ranges: none" (RFC 9110 14.2: a server may
// ignore Range). It is never a 206 of the compressed stream, whose offsets
// mean nothing to the client, and never a 206 of a different representation.
func TestServeWasmIgnoresRange(t *testing.T) {
	raw := []byte("\x00asm\x01\x00\x00\x00 pretend module")
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	zw.Write(raw)
	zw.Close()
	br := []byte("pretend brotli stream")
	s := &Server{publicFS: fstest.MapFS{
		"vendor/x/m_bg.wasm.gz": {Data: gz.Bytes()},
		"vendor/x/m_bg.wasm.br": {Data: br},
	}}
	for _, c := range []struct {
		ae, enc string
		body    []byte
	}{
		{"br, gzip", "br", br},
		{"gzip", "gzip", gz.Bytes()},
		{"", "", raw},
	} {
		req := httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
		if c.ae != "" {
			req.Header.Set("Accept-Encoding", c.ae)
		}
		req.Header.Set("Range", "bytes=4-9")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		h := rec.Header()
		if rec.Code != 200 || h.Get("Content-Range") != "" || h.Get("Content-Encoding") != c.enc || !bytes.Equal(rec.Body.Bytes(), c.body) {
			t.Errorf("Range with Accept-Encoding %q: %d %v", c.ae, rec.Code, h)
		}
		if h.Get("Accept-Ranges") != "none" || h.Get("ETag") == "" || h.Get("Cache-Control") != "no-cache" {
			t.Errorf("Range with Accept-Encoding %q: headers %v", c.ae, h)
		}
	}
	// If-Range changes nothing either
	req := httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	req = httptest.NewRequest("GET", "/vendor/x/m_bg.wasm", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-3")
	req.Header.Set("If-Range", rec.Header().Get("ETag"))
	rec2 := httptest.NewRecorder()
	s.ServeHTTP(rec2, req)
	if rec2.Code != 200 || !bytes.Equal(rec2.Body.Bytes(), gz.Bytes()) {
		t.Errorf("Range + If-Range: %d", rec2.Code)
	}
}
