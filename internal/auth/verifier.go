package auth

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrInvalidToken means GitHub rejected the token: the caller is not signed in.
var ErrInvalidToken = errors.New("github rejected the token")

// ErrVerifierUnavailable means GitHub could not be asked (network, timeout,
// 5xx). Callers fail closed with 503 rather than treating it as signed out.
var ErrVerifierUnavailable = errors.New("github verification unavailable")

// Verifier turns a GitHub access token into the user it belongs to.
type Verifier interface {
	Verify(ctx context.Context, token string) (*GitHubUserInfo, error)
}

// GitHubVerifier asks api.github.com/user, with a timeout (ExtractUserFromToken
// uses http.DefaultClient, which has none and can hang a handler forever).
type GitHubVerifier struct {
	Client  *http.Client
	BaseURL string // default https://api.github.com; tests point it at httptest
}

// NewGitHubVerifier returns a verifier with a 5 s timeout.
func NewGitHubVerifier() *GitHubVerifier {
	return &GitHubVerifier{Client: &http.Client{Timeout: 5 * time.Second}, BaseURL: "https://api.github.com"}
}

func (v *GitHubVerifier) Verify(ctx context.Context, token string) (*GitHubUserInfo, error) {
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return nil, ErrInvalidToken
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.BaseURL+"/user", nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrVerifierUnavailable, err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github.v3+json")
	resp, err := v.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrVerifierUnavailable, err)
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return nil, ErrInvalidToken
	case resp.StatusCode != http.StatusOK:
		return nil, fmt.Errorf("%w: github status %d", ErrVerifierUnavailable, resp.StatusCode)
	}
	var gh gitHubAPIUserResponse
	if err := json.NewDecoder(resp.Body).Decode(&gh); err != nil {
		return nil, fmt.Errorf("%w: decoding github response: %v", ErrVerifierUnavailable, err)
	}
	if gh.ID == 0 {
		return nil, ErrInvalidToken
	}
	id := strconv.FormatInt(gh.ID, 10)
	return &GitHubUserInfo{ID: id, Email: gh.Email, UserName: gh.Login, FullName: gh.Name, GitHubID: id}, nil
}

// CachingVerifier remembers successful verifications for TTL, keyed by
// sha256(token) so a raw token is never kept. A failure is never cached and
// the cache never rejects a token by itself; a revoked token keeps working for
// at most TTL.
type CachingVerifier struct {
	Inner Verifier
	TTL   time.Duration
	Max   int
	Now   func() time.Time

	mu      sync.Mutex
	entries map[[32]byte]*list.Element
	lru     *list.List // front = most recent
}

type cacheEntry struct {
	key     [32]byte
	user    GitHubUserInfo
	expires time.Time
}

// NewCachingVerifier caches inner's answers for 10 minutes, at most 10k entries.
func NewCachingVerifier(inner Verifier) *CachingVerifier {
	return &CachingVerifier{Inner: inner, TTL: 10 * time.Minute, Max: 10000, Now: time.Now}
}

func (c *CachingVerifier) Verify(ctx context.Context, token string) (*GitHubUserInfo, error) {
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	key := sha256.Sum256([]byte(token))
	now := c.Now()

	c.mu.Lock()
	if c.entries == nil {
		c.entries = map[[32]byte]*list.Element{}
		c.lru = list.New()
	}
	if el, ok := c.entries[key]; ok {
		e := el.Value.(*cacheEntry)
		if now.Before(e.expires) {
			c.lru.MoveToFront(el)
			u := e.user
			c.mu.Unlock()
			return &u, nil
		}
		c.lru.Remove(el)
		delete(c.entries, key)
	}
	c.mu.Unlock()

	u, err := c.Inner.Verify(ctx, token)
	if err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = c.lru.PushFront(&cacheEntry{key: key, user: *u, expires: now.Add(c.TTL)})
	for c.Max > 0 && c.lru.Len() > c.Max {
		old := c.lru.Back()
		c.lru.Remove(old)
		delete(c.entries, old.Value.(*cacheEntry).key)
	}
	return u, nil
}

// Len reports how many verifications are cached (for tests).
func (c *CachingVerifier) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.lru == nil {
		return 0
	}
	return c.lru.Len()
}
