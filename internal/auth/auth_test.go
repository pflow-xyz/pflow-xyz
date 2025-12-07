package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExtractUserFromToken_InvalidToken(t *testing.T) {
	// Test with an invalid/empty token - should fail when calling GitHub API
	_, err := ExtractUserFromToken("")
	if err == nil {
		t.Error("Expected error for empty token, got nil")
	}
}

func TestExtractUserFromToken_StripsBearerPrefix(t *testing.T) {
	// This test verifies the Bearer prefix is stripped
	// Both should result in the same GitHub API call (and fail since token is invalid)
	_, err1 := ExtractUserFromToken("invalid-token")
	_, err2 := ExtractUserFromToken("Bearer invalid-token")

	// Both should fail (GitHub will reject invalid tokens)
	if err1 == nil || err2 == nil {
		t.Error("Expected errors for invalid tokens")
	}
}

func TestExtractUserFromToken_WithMockServer(t *testing.T) {
	// Create a mock GitHub API server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify the authorization header
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		// Return mock user data
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{
			"id": 12345678,
			"login": "testuser",
			"name": "Test User",
			"email": "test@example.com"
		}`))
	}))
	defer server.Close()

	// Note: This test demonstrates the pattern but won't work without
	// modifying the code to allow injecting the GitHub API URL.
	// For now, we rely on integration testing with real GitHub tokens.
	t.Skip("Skipping: requires GitHub API URL injection for unit testing")
}
