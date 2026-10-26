package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

// missingStorage reports os.ErrNotExist for every cid except sampleCID, and
// a transient error for flakyCID.
type missingStorage struct {
	Storage
	raw []byte
}

const flakyCID = "zFkakyFkakyFkakyFkakyFkaky"

func (s *missingStorage) GetObject(cid string) ([]byte, error) {
	switch cid {
	case sampleCID:
		return s.raw, nil
	case flakyCID:
		return nil, os.ErrPermission
	}
	return nil, os.ErrNotExist
}

// An unknown or malformed ?cid= must not be served as a 200 copy of the
// landing page (Search Console reports those as soft 404s).
func TestRootStatusForShareCID(t *testing.T) {
	const landing = `<!DOCTYPE html><html><head><title>pflow</title></head><body>landing</body></html>`
	srv := &Server{
		storage:  &missingStorage{raw: loadSample(t)},
		publicFS: fstest.MapFS{"index.html": {Data: []byte(landing)}},
	}

	cases := []struct {
		name, query string
		status      int
	}{
		{"no cid", "", http.StatusOK},
		{"empty cid", "?cid=", http.StatusOK},
		{"malformed cid", "?cid=garbage", http.StatusNotFound},
		{"unknown well-formed cid", "?cid=zUnknownUnknownUnknownUnknown", http.StatusNotFound},
		{"found cid", "?cid=" + sampleCID, http.StatusOK},
		{"transient storage error", "?cid=" + flakyCID, http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/"+tc.query, nil)
			w := httptest.NewRecorder()
			srv.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d", w.Code, tc.status)
			}
			if !strings.Contains(w.Body.String(), "landing") {
				t.Errorf("body is not the landing page:\n%s", w.Body.String())
			}
		})
	}
}
