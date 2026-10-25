package main

import (
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// serveGzippedWasm answers a request for X.wasm from the embedded X.wasm.gz.
//
// public/vendor/pflow-native-wasm/ keeps pflow-native's wasm shim only
// gzip-compressed (about 6 MB raw, about 1.2 MB gzip; ROADMAP phase 2), and
// nginx on pflow.dev compresses only text/html. A client that accepts gzip
// (every browser) gets the stored bytes with Content-Encoding: gzip; any
// other gets them decompressed. It reports false when there is no X.wasm.gz,
// so a plain .wasm still falls through to the file server.
func (s *Server) serveGzippedWasm(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasSuffix(r.URL.Path, ".wasm") || s.publicFS == nil {
		return false
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/") + ".gz"
	f, err := s.publicFS.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	if st, err := f.Stat(); err != nil || st.IsDir() {
		return false
	}
	h := w.Header()
	h.Set("Content-Type", "application/wasm")
	h.Set("Vary", "Accept-Encoding")
	h.Set("Cache-Control", "public, max-age=3600")
	// Module workers and import() from other origins fetch with CORS, as the
	// .js modules do.
	h.Set("Access-Control-Allow-Origin", "*")
	if acceptsGzip(r) {
		h.Set("Content-Encoding", "gzip")
		if r.Method != http.MethodHead {
			io.Copy(w, f.(io.Reader))
		}
		return true
	}
	gr, err := gzip.NewReader(f.(io.Reader))
	if err != nil {
		http.Error(w, "corrupt wasm bundle", http.StatusInternalServerError)
		return true
	}
	defer gr.Close()
	if r.Method != http.MethodHead {
		io.Copy(w, gr)
	}
	return true
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		enc := strings.TrimSpace(strings.SplitN(part, ";", 2)[0])
		if enc == "gzip" && !strings.Contains(strings.ReplaceAll(part, " ", ""), "q=0") {
			return true
		}
	}
	return false
}

var _ fs.File // the embedded FS's files are io.Readers
