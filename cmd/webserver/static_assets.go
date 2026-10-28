package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// serveStatic answers a request for a file of the embedded public/ tree. What
// http.FileServer does, plus the two things the bare file server leaves out
// (the embedded files have no modification time, so it sends neither
// Last-Modified nor ETag, and nginx on pflow.dev compresses only text/html):
//
//   - ETag and Cache-Control: no-cache. The files are not content-hashed (a
//     page imports ./views/cospan.js, not cospan.3f9a.js), so a cached copy is
//     only safe if the browser asks before it uses it: the answer is a 304 with
//     no body when nothing changed, and a deploy takes effect on the next
//     load, with no mixed old and new modules. (max-age, and above all
//     immutable, would need names that change with the content.)
//   - gzip for the text types (JS, CSS, JSON, HTML, SVG, Python, ...), made
//     once per file and kept, for a client that accepts it. The composition page
//     alone is about 1 MB of JavaScript and JSON.
//
// A request with a Range header gets the identity form from http.FileServer
// (206, Content-Range, Accept-Ranges, If-Range against the identity ETag), never
// the gzip body: byte ranges address the file, not its compressed copy, and the
// gzip answer is a whole-body 200 that ignores the range.
//
// Anything it does not take (a directory, index.html, another method, a path
// that is not a file) goes to http.FileServer unchanged.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	next := http.FileServer(http.FS(s.publicFS))
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		next.ServeHTTP(w, r)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" || strings.HasSuffix(r.URL.Path, "/") || path.Base(name) == "index.html" || !fs.ValidPath(name) {
		next.ServeHTTP(w, r)
		return
	}
	a, err := s.assets.get(s.publicFS, name)
	if err != nil {
		next.ServeHTTP(w, r)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-cache")
	if !a.compressible {
		h.Set("ETag", a.etag)
		next.ServeHTTP(w, r) // http.FileServer answers If-None-Match from the ETag set above
		return
	}
	h.Add("Vary", "Accept-Encoding")
	if a.gz == nil || r.Header.Get("Range") != "" || chooseEncoding(r, "gzip") != "gzip" {
		h.Set("ETag", a.etag)
		next.ServeHTTP(w, r)
		return
	}
	// The gzip form is a different representation, so a different ETag.
	etag := a.etag[:len(a.etag)-1] + `-gz"`
	h.Set("ETag", etag)
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Type", a.ctype)
	h.Set("Content-Encoding", "gzip")
	h.Set("Content-Length", strconv.Itoa(len(a.gz)))
	if r.Method == http.MethodHead {
		return
	}
	w.Write(a.gz)
}

// assetCache holds, per embedded file, what is worked out once from its bytes.
// The zero value is ready; the files of an embedded tree do not change.
type assetCache struct {
	m sync.Map // name -> *asset
}

type asset struct {
	etag         string // quoted, strong, of the file's bytes
	compressible bool
	ctype        string
	gz           []byte // nil unless the file is a text type worth compressing
}

// compressibleExt lists the extensions served gzip-compressed. Images, fonts,
// video and .wasm.gz are already compressed.
var compressibleExt = map[string]bool{
	".html": true, ".js": true, ".mjs": true, ".css": true, ".json": true, ".jsonld": true,
	".svg": true, ".txt": true, ".xml": true, ".md": true, ".webmanifest": true,
	".py": true, ".chyp": true,
}

// gzipMin is the size under which a file is sent as it is: the saving would be
// smaller than the cost of asking.
const gzipMin = 1024

func (c *assetCache) get(fsys fs.FS, name string) (*asset, error) {
	if v, ok := c.m.Load(name); ok {
		return v.(*asset), nil
	}
	st, err := fs.Stat(fsys, name)
	if err != nil || !st.Mode().IsRegular() {
		return nil, fs.ErrNotExist
	}
	data, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	a := &asset{etag: `"` + hex.EncodeToString(sum[:16]) + `"`}
	ext := strings.ToLower(path.Ext(name))
	a.compressible = compressibleExt[ext]
	if a.compressible {
		// what http.FileServer would send (it sniffs the bytes when the extension is unknown)
		a.ctype = mime.TypeByExtension(ext)
		if a.ctype == "" {
			a.ctype = "text/plain; charset=utf-8"
		}
		if len(data) >= gzipMin {
			var buf bytes.Buffer
			zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			zw.Write(data)
			zw.Close()
			if buf.Len() < len(data) {
				a.gz = buf.Bytes()
			}
		}
	}
	v, _ := c.m.LoadOrStore(name, a)
	return v.(*asset), nil
}

// acceptedEncodings reads an Accept-Encoding header (RFC 9110 12.5.3) into
// coding -> quality. Codings are matched case-insensitively and "*" is kept as
// a key of its own. A quality that is not a number from 0 to 1 ("abc", "1.5",
// "-1", "") counts as 0: the coding is not accepted. "q" is matched
// case-insensitively and "00" reads as 0. A coding listed twice keeps its first
// quality.
func acceptedEncodings(header string) map[string]float64 {
	m := map[string]float64{}
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(part, ";")
		coding := strings.ToLower(strings.TrimSpace(fields[0]))
		if coding == "" {
			continue
		}
		if _, seen := m[coding]; seen {
			continue
		}
		q := 1.0
		for _, p := range fields[1:] {
			if name, val, ok := strings.Cut(p, "="); ok && strings.ToLower(strings.TrimSpace(name)) == "q" {
				q = parseQuality(strings.TrimSpace(val))
			}
		}
		m[coding] = q
	}
	return m
}

// parseQuality reads a qvalue: digits with at most one point, 0 to 1. Anything
// else (empty, a sign, an exponent, "NaN", "1.5") is 0.
func parseQuality(v string) float64 {
	dots := 0
	for i := 0; i < len(v); i++ {
		switch c := v[i]; {
		case c >= '0' && c <= '9':
		case c == '.' && dots == 0 && i > 0 && i < len(v)-1:
			dots++
		default:
			return 0
		}
	}
	q, err := strconv.ParseFloat(v, 64)
	if err != nil || q < 0 || q > 1 {
		return 0
	}
	return q
}

// chooseEncoding picks, from the content codings the server can send (in order
// of preference: the first wins a tie), the one the request ranks highest. It
// returns "" when none is acceptable, or when the request lists "identity" with
// a quality above all of them: the caller sends the file as it is. A coding the
// request does not name takes the quality of "*", else 0. The request is read
// from every Accept-Encoding header line.
func chooseEncoding(r *http.Request, offered ...string) string {
	acc := acceptedEncodings(strings.Join(r.Header.Values("Accept-Encoding"), ","))
	star, hasStar := acc["*"]
	best, bestQ := "", 0.0
	for _, enc := range offered {
		q, ok := acc[enc]
		if !ok && hasStar {
			q = star
		}
		if q > bestQ {
			best, bestQ = enc, q
		}
	}
	if idq, ok := acc["identity"]; ok && idq > bestQ {
		return ""
	}
	return best
}

// etagMatches reports whether an If-None-Match header names etag (weak
// comparison, as RFC 9110 says for If-None-Match) or is "*".
func etagMatches(header, etag string) bool {
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimSpace(t)
		if t == "*" || strings.TrimPrefix(t, "W/") == etag {
			return true
		}
	}
	return false
}
