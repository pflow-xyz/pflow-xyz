package auth

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// appStub plays GitHub's POST /applications/{client_id}/token for the app
// "cid" / "secret": "ours" is one of its tokens, anything else is not.
func appStub(t *testing.T, status int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/applications/cid/token" {
			t.Errorf("got %s %s", r.Method, r.URL.Path)
		}
		if id, sec, ok := r.BasicAuth(); !ok || id != "cid" || sec != "secret" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if status != 0 {
			w.WriteHeader(status)
			return
		}
		var body struct {
			AccessToken string `json:"access_token"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		switch body.AccessToken {
		case "ours":
			w.Write([]byte(`{"id": 1, "token": "ours", "user": {"id": 42, "login": "octo", "name": "Octo Cat"}}`))
		case "no-user":
			w.Write([]byte(`{"id": 1, "token": "no-user"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func TestGitHubAppVerifier(t *testing.T) {
	srv := appStub(t, 0)
	defer srv.Close()
	v := &GitHubAppVerifier{ClientID: "cid", ClientSecret: "secret", Client: srv.Client(), BaseURL: srv.URL}
	ctx := context.Background()

	u, err := v.Verify(ctx, "Bearer ours")
	if err != nil || u.GitHubID != "42" || u.ID != "42" || u.UserName != "octo" {
		t.Fatalf("our token: %+v, %v", u, err)
	}
	for _, tok := range []string{"someone-elses", "no-user", "", "Bearer "} {
		if _, err := v.Verify(ctx, tok); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("%q: %v, want ErrInvalidToken", tok, err)
		}
	}
	// Wrong app credentials are this server's fault, not the user's.
	bad := &GitHubAppVerifier{ClientID: "cid", ClientSecret: "wrong", Client: srv.Client(), BaseURL: srv.URL}
	if _, err := bad.Verify(ctx, "ours"); !errors.Is(err, ErrVerifierUnavailable) {
		t.Errorf("wrong secret: %v, want ErrVerifierUnavailable", err)
	}
	if _, err := (&GitHubAppVerifier{Client: srv.Client(), BaseURL: srv.URL}).Verify(ctx, "ours"); !errors.Is(err, ErrVerifierUnavailable) {
		t.Errorf("no app configured: %v, want ErrVerifierUnavailable", err)
	}
}

func TestGitHubAppVerifierFailsClosed(t *testing.T) {
	// 403 is GitHub rate limiting or an abuse lock: unavailable, not signed out.
	for _, status := range []int{http.StatusForbidden, http.StatusBadGateway, http.StatusInternalServerError} {
		srv := appStub(t, status)
		v := &GitHubAppVerifier{ClientID: "cid", ClientSecret: "secret", Client: srv.Client(), BaseURL: srv.URL}
		if _, err := v.Verify(context.Background(), "ours"); !errors.Is(err, ErrVerifierUnavailable) {
			t.Errorf("status %d: %v, want ErrVerifierUnavailable", status, err)
		}
		srv.Close()
	}
	srv := appStub(t, http.StatusUnprocessableEntity)
	defer srv.Close()
	v := &GitHubAppVerifier{ClientID: "cid", ClientSecret: "secret", Client: srv.Client(), BaseURL: srv.URL}
	if _, err := v.Verify(context.Background(), "ours"); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("422: %v, want ErrInvalidToken", err)
	}
}
