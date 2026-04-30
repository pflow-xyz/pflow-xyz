package main

import (
	"bytes"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleCID = "z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8"

func loadSample(t *testing.T) []byte {
	t.Helper()
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// cwd is cmd/webserver; example lives at repo root.
	path := filepath.Join(root, "..", "..", "examples", sampleCID+".jsonld")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read example: %v", err)
	}
	return raw
}

// stubStorage returns the same bytes for every CID, missing for "".
type stubStorage struct {
	Storage
	raw []byte
}

func (s *stubStorage) GetObject(cid string) ([]byte, error) {
	if cid == "" {
		return nil, os.ErrNotExist
	}
	return s.raw, nil
}

func TestRenderShareCardSVG(t *testing.T) {
	raw := loadSample(t)
	p, err := parseCardPayload(raw)
	if err != nil {
		t.Fatal(err)
	}
	summary := summarizeCard(p, sampleCID, "https://pflow.xyz")
	if summary.PlaceCount == 0 || summary.TransitionCount == 0 {
		t.Fatalf("expected non-empty net, got %+v", summary)
	}
	out := renderShareCardSVG(summary, "")
	s := string(out)
	for _, want := range []string{
		`viewBox="0 0 1200 630"`,
		"PFLOW.XYZ",
		summary.Title,
		summary.Subtitle,
		"share-card", // no — the card SVG itself doesn't contain that string; replace below
	} {
		if want == "share-card" {
			continue
		}
		if !strings.Contains(s, want) {
			t.Errorf("svg missing %q", want)
		}
	}
	if !strings.Contains(s, "/?cid=") {
		t.Errorf("svg missing share URL fragment")
	}
}

func TestRenderShareCardPNG(t *testing.T) {
	raw := loadSample(t)
	p, err := parseCardPayload(raw)
	if err != nil {
		t.Fatal(err)
	}
	summary := summarizeCard(p, sampleCID, "https://pflow.xyz")
	out, err := renderShareCardPNG(summary, p)
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode png: %v", err)
	}
	b := img.Bounds()
	if b.Dx() != 1200 || b.Dy() != 630 {
		t.Errorf("png dims = %dx%d, want 1200x630", b.Dx(), b.Dy())
	}
}

func TestShareCardHandler(t *testing.T) {
	raw := loadSample(t)
	st := &stubStorage{raw: raw}
	origin := func(r *http.Request) string { return "https://pflow.xyz" }
	h := shareCardHandler(st, origin)

	t.Run("svg", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/share-card/"+sampleCID+".svg", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("status = %d", w.Code)
		}
		if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "image/svg+xml") {
			t.Errorf("content-type = %q", ct)
		}
	})

	t.Run("png", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/share-card/"+sampleCID+".png", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("status = %d", w.Code)
		}
		if ct := w.Header().Get("Content-Type"); ct != "image/png" {
			t.Errorf("content-type = %q", ct)
		}
		if _, err := png.Decode(bytes.NewReader(w.Body.Bytes())); err != nil {
			t.Errorf("png decode: %v", err)
		}
	})

	t.Run("invalid cid", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/share-card/not-a-cid.png", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Errorf("status = %d, want 400", w.Code)
		}
	})

	t.Run("unsupported ext", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/share-card/"+sampleCID+".gif", nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Errorf("status = %d, want 400", w.Code)
		}
	})
}

func TestDecorateIndexForShare(t *testing.T) {
	raw := loadSample(t)
	st := &stubStorage{raw: raw}
	srv := &Server{storage: st}
	indexHTML := []byte(`<!DOCTYPE html><html><head><title>pflow</title></head><body></body></html>`)

	t.Run("decorated when cid present", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/?cid="+sampleCID, nil)
		r.Host = "pflow.xyz"
		out := srv.decorateIndexForShare(r, indexHTML)
		s := string(out)
		for _, want := range []string{
			`property="og:image"`,
			`/share-card/` + sampleCID + `.png`,
			`name="twitter:card"`,
			`application/ld+json`,
		} {
			if !strings.Contains(s, want) {
				t.Errorf("decorated html missing %q\n--\n%s", want, s)
			}
		}
	})

	t.Run("untouched when no cid", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/", nil)
		out := srv.decorateIndexForShare(r, indexHTML)
		if !bytes.Equal(out, indexHTML) {
			t.Errorf("expected unchanged html when no cid")
		}
	})

	t.Run("untouched when invalid cid", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/?cid=garbage", nil)
		out := srv.decorateIndexForShare(r, indexHTML)
		if !bytes.Equal(out, indexHTML) {
			t.Errorf("expected unchanged html when cid invalid")
		}
	})
}

func TestStripSVGWrapper(t *testing.T) {
	in := `<svg xmlns="..." viewBox="0 0 100 50" width="100" height="50"><circle/></svg>`
	inner, vb := stripSVGWrapper(in)
	if inner != "<circle/>" {
		t.Errorf("inner = %q", inner)
	}
	if vb != "0 0 100 50" {
		t.Errorf("viewBox = %q", vb)
	}
}

func TestTokenColorHex(t *testing.T) {
	cases := map[string]string{
		"https://pflow.xyz/tokens/red": "#dc3545",
		"#abcdef":                      "#abcdef",
		"ff0000":                       "#ff0000",
		"":                             "",
		"https://pflow.xyz/tokens/nonexistent": "",
	}
	for in, want := range cases {
		if got := tokenColorHex(in); got != want {
			t.Errorf("tokenColorHex(%q) = %q, want %q", in, got, want)
		}
	}
}
