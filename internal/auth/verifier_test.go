package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func githubStub(t *testing.T, calls *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(calls, 1)
		switch r.Header.Get("Authorization") {
		case "Bearer good":
			w.Write([]byte(`{"id": 42, "login": "octo", "name": "Octo Cat"}`))
		case "Bearer down":
			w.WriteHeader(http.StatusBadGateway)
		default:
			w.WriteHeader(http.StatusUnauthorized)
		}
	}))
}

func TestGitHubVerifier(t *testing.T) {
	var calls int32
	srv := githubStub(t, &calls)
	defer srv.Close()
	v := &GitHubVerifier{Client: srv.Client(), BaseURL: srv.URL}

	u, err := v.Verify(context.Background(), "Bearer good")
	if err != nil || u.ID != "42" || u.UserName != "octo" {
		t.Fatalf("good token: %+v, %v", u, err)
	}
	if _, err := v.Verify(context.Background(), "bad"); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("bad token: %v, want ErrInvalidToken", err)
	}
	if _, err := v.Verify(context.Background(), "down"); !errors.Is(err, ErrVerifierUnavailable) {
		t.Fatalf("github 502: %v, want ErrVerifierUnavailable", err)
	}
	if _, err := v.Verify(context.Background(), ""); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("empty token: %v", err)
	}
}

func TestCachingVerifier(t *testing.T) {
	var calls int32
	srv := githubStub(t, &calls)
	defer srv.Close()
	now := time.Date(2026, 10, 25, 0, 0, 0, 0, time.UTC)
	c := NewCachingVerifier(&GitHubVerifier{Client: srv.Client(), BaseURL: srv.URL})
	c.Now = func() time.Time { return now }

	for i := 0; i < 3; i++ {
		if _, err := c.Verify(context.Background(), "good"); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("a hit within the TTL called GitHub: %d calls", calls)
	}

	now = now.Add(11 * time.Minute)
	if _, err := c.Verify(context.Background(), "good"); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("an expired entry was served: %d calls", calls)
	}

	for i := 0; i < 2; i++ {
		c.Verify(context.Background(), "bad")
	}
	if calls != 4 {
		t.Fatalf("a failed verification was cached: %d calls", calls)
	}

	for el := c.lru.Front(); el != nil; el = el.Next() {
		e := el.Value.(*cacheEntry)
		if strings.Contains(string(e.key[:]), "good") {
			t.Fatal("raw token in the cache key")
		}
	}
}

func TestCachingVerifierEvicts(t *testing.T) {
	var calls int32
	srv := githubStub(t, &calls)
	defer srv.Close()
	c := NewCachingVerifier(stubVerifier{})
	c.Max = 2
	for _, tok := range []string{"a", "b", "c"} {
		c.Verify(context.Background(), tok)
	}
	if c.Len() != 2 {
		t.Fatalf("cache holds %d entries, want 2", c.Len())
	}
}

type stubVerifier struct{}

func (stubVerifier) Verify(_ context.Context, token string) (*GitHubUserInfo, error) {
	return &GitHubUserInfo{ID: token, UserName: token}, nil
}
