package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http/httptest"
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

	req = httptest.NewRequest("GET", "/plain.wasm", nil)
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), raw) {
		t.Fatalf("a .wasm with no .gz falls through to the file server: %d", rec.Code)
	}
}
