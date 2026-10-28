package main

import (
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"
)

// serveGzippedWasm answers a request for X.wasm from the embedded X.wasm.br
// or X.wasm.gz.
//
// public/vendor/pflow-native-wasm/ keeps pflow-native's wasm shim only
// compressed (8,544,501 bytes raw, 1,891,277 gzip, pflow-native-wasm.lock;
// brotli is a third smaller than gzip, docs/compose-load-budget.md), and
// nginx on pflow.dev compresses only text/html. A client that accepts br gets
// the .br bytes with Content-Encoding: br (browsers ask for br over https and
// on loopback http), one that accepts gzip gets the .gz bytes, and any other
// gets the .gz decompressed. It reports false when there is no X.wasm.gz, so a
// plain .wasm still falls through to the file server.
//
// The coding is the one the request ranks highest (Accept-Encoding with
// q-values, "*" and case-insensitive tokens; br wins a tie), the .gz
// decompressed when the request names neither or prefers "identity".
//
// The file is not content-hashed (the glue imports it by name), so a cached
// copy must be asked about before it is used: each form carries an ETag and
// Cache-Control: no-cache, and a matching If-None-Match gets a 304. A fixed
// max-age would let a visitor run new glue against a wasm cached from the
// previous vendoring.
//
// Range is ignored on purpose (RFC 9110 14.2 lets a server do that, and this
// handler never honoured it): the stored forms are compressed streams, which
// the offsets of the module do not address, and a range of the decompressed
// module would mean holding all 8.5 MB per request. A request with a Range (or
// If-Range) header gets the whole body, 200, and every answer says
// "Accept-Ranges: none" so a client does not try again. (Static files are
// different: static_assets.go serves a range from the file as it is.) Nothing
// in the page ranges over the wasm; instantiateStreaming reads one response.
func (s *Server) serveGzippedWasm(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasSuffix(r.URL.Path, ".wasm") || s.publicFS == nil {
		return false
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if !fs.ValidPath(name) {
		return false
	}
	stored := name + ".gz"
	if st, err := fs.Stat(s.publicFS, stored); err != nil || st.IsDir() {
		return false
	}
	offered := []string{"gzip"}
	if st, err := fs.Stat(s.publicFS, name+".br"); err == nil && !st.IsDir() {
		offered = []string{"br", "gzip"}
	}
	enc := chooseEncoding(r, offered...) // "" = the decompressed module
	if enc == "br" {
		stored = name + ".br"
	}
	a, err := s.assets.get(s.publicFS, stored)
	if err != nil {
		return false
	}
	f, err := s.publicFS.Open(stored)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false
	}
	passthrough := enc != ""
	etag := a.etag
	if !passthrough {
		etag = a.etag[:len(a.etag)-1] + `-raw"` // the decompressed form
	}
	h := w.Header()
	h.Set("Content-Type", "application/wasm")
	h.Set("Vary", "Accept-Encoding")
	h.Set("Cache-Control", "no-cache")
	h.Set("Accept-Ranges", "none")
	h.Set("ETag", etag)
	// Module workers and import() from other origins fetch with CORS, as the
	// .js modules do.
	h.Set("Access-Control-Allow-Origin", "*")
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return true
	}
	if passthrough {
		h.Set("Content-Encoding", enc)
		h.Set("Content-Length", strconv.FormatInt(st.Size(), 10))
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

var _ fs.File // the embedded FS's files are io.Readers
