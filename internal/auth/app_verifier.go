package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// GitHubAppVerifier accepts only tokens that GitHub issued to one OAuth app
// (this server's GITHUB_CLIENT_ID), by asking GitHub's "check a token" API:
// POST /applications/{client_id}/token with the app's own credentials as basic
// auth. GitHubVerifier's GET /user answers for any token at all — a personal
// access token, or a token some other "Sign in with GitHub" site holds — which
// is fine for attributing a public save, and not for opening private files.
//
// Statuses: 200 is the token's user; 404 and 422 mean the token is not one of
// this app's (or is revoked): ErrInvalidToken. Anything else (401 for wrong
// app credentials, 403 rate limiting, 5xx, a network error) is
// ErrVerifierUnavailable, so callers fail closed without signing anyone out.
type GitHubAppVerifier struct {
	ClientID     string
	ClientSecret string
	Client       *http.Client
	BaseURL      string // default https://api.github.com; tests point it at httptest
}

// NewGitHubAppVerifier returns an app-bound verifier with a 5 s timeout.
func NewGitHubAppVerifier(clientID, clientSecret string) *GitHubAppVerifier {
	return &GitHubAppVerifier{
		ClientID:     clientID,
		ClientSecret: clientSecret,
		Client:       &http.Client{Timeout: 5 * time.Second},
		BaseURL:      "https://api.github.com",
	}
}

func (v *GitHubAppVerifier) Verify(ctx context.Context, token string) (*GitHubUserInfo, error) {
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return nil, ErrInvalidToken
	}
	if v.ClientID == "" || v.ClientSecret == "" {
		return nil, fmt.Errorf("%w: no GitHub OAuth app configured", ErrVerifierUnavailable)
	}
	body, _ := json.Marshal(map[string]string{"access_token": token})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		v.BaseURL+"/applications/"+url.PathEscape(v.ClientID)+"/token", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrVerifierUnavailable, err)
	}
	req.SetBasicAuth(v.ClientID, v.ClientSecret)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Content-Type", "application/json")
	resp, err := v.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrVerifierUnavailable, err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusUnprocessableEntity:
		return nil, ErrInvalidToken
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%w: github status %d", ErrVerifierUnavailable, resp.StatusCode)
	}
	var check struct {
		User gitHubAPIUserResponse `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&check); err != nil {
		return nil, fmt.Errorf("%w: decoding github response: %v", ErrVerifierUnavailable, err)
	}
	if check.User.ID <= 0 {
		return nil, ErrInvalidToken
	}
	id := strconv.FormatInt(check.User.ID, 10)
	return &GitHubUserInfo{ID: id, Email: check.User.Email, UserName: check.User.Login, FullName: check.User.Name, GitHubID: id}, nil
}
