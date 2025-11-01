package auth

import (
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Helper function to create a valid signed JWT for testing
func createTestToken(t *testing.T, claims *SupabaseClaims) string {
	t.Helper()

	// Use a test secret
	testSecret := "test-secret-key-for-testing"

	// Set the secret in environment for the test
	os.Setenv("SUPABASE_JWT_SECRET", testSecret)

	// Create the token
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)

	// Sign and get the complete encoded token as a string
	tokenString, err := token.SignedString([]byte(testSecret))
	if err != nil {
		t.Fatalf("Failed to sign token: %v", err)
	}

	return tokenString
}

func TestExtractUserFromToken(t *testing.T) {
	// Create claims with GitHub user info
	claims := &SupabaseClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "user-id-123",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Email: "test@example.com",
		UserMetadata: map[string]interface{}{
			"user_name":   "testuser",
			"full_name":   "Test User",
			"provider_id": "12345678",
		},
		AppMetadata: map[string]interface{}{
			"provider": "github",
		},
	}

	token := createTestToken(t, claims)

	// Test extraction
	userInfo, err := ExtractUserFromToken(token)
	if err != nil {
		t.Fatalf("Failed to extract user: %v", err)
	}

	// Validate extracted information
	if userInfo.ID != "user-id-123" {
		t.Errorf("Expected ID 'user-id-123', got '%s'", userInfo.ID)
	}

	if userInfo.Email != "test@example.com" {
		t.Errorf("Expected email 'test@example.com', got '%s'", userInfo.Email)
	}

	if userInfo.UserName != "testuser" {
		t.Errorf("Expected username 'testuser', got '%s'", userInfo.UserName)
	}

	if userInfo.FullName != "Test User" {
		t.Errorf("Expected full name 'Test User', got '%s'", userInfo.FullName)
	}

	if userInfo.GitHubID != "12345678" {
		t.Errorf("Expected GitHub ID '12345678', got '%s'", userInfo.GitHubID)
	}
}

func TestExtractUserFromTokenWithBearer(t *testing.T) {
	// Create a simple token
	claims := &SupabaseClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "user-id-456",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Email: "user@test.com",
	}

	token := "Bearer " + createTestToken(t, claims)

	// Test extraction with Bearer prefix
	userInfo, err := ExtractUserFromToken(token)
	if err != nil {
		t.Fatalf("Failed to extract user from Bearer token: %v", err)
	}

	if userInfo.ID != "user-id-456" {
		t.Errorf("Expected ID 'user-id-456', got '%s'", userInfo.ID)
	}
}

func TestExtractUserFromTokenInvalid(t *testing.T) {
	// Set a test secret
	os.Setenv("SUPABASE_JWT_SECRET", "test-secret")

	tests := []struct {
		name  string
		token string
	}{
		{"Empty token", ""},
		{"Invalid format", "not.a.valid.jwt.token"},
		{"Only two parts", "header.payload"},
		{"Invalid signature", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.invalid"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ExtractUserFromToken(tt.token)
			if err == nil {
				t.Error("Expected error for invalid token, got nil")
			}
		})
	}
}

func TestExtractUserFromTokenNoUserInfo(t *testing.T) {
	// Create a token with no user identification
	claims := &SupabaseClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
	}

	token := createTestToken(t, claims)

	_, err := ExtractUserFromToken(token)
	if err == nil {
		t.Error("Expected error for token with no user info, got nil")
	}
}

func TestExtractUserFromTokenNoSecret(t *testing.T) {
	// Unset the environment variable
	os.Unsetenv("SUPABASE_JWT_SECRET")

	// Just use a dummy token - we don't need to create a valid one
	// since the function should fail before validating the signature
	token := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.test"

	_, err := ExtractUserFromToken(token)
	if err == nil {
		t.Error("Expected error when SUPABASE_JWT_SECRET is not set, got nil")
	}

	// Restore for other tests
	os.Setenv("SUPABASE_JWT_SECRET", "test-secret")
}

func TestExtractUserFromTokenWithSubFallback(t *testing.T) {
	// Create claims with 'sub' in user_metadata but no 'provider_id'
	// This tests the fallback behavior when provider_id is missing
	claims := &SupabaseClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "supabase-user-id-789",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Email: "fallback@example.com",
		UserMetadata: map[string]interface{}{
			"user_name": "fallbackuser",
			"sub":       "87654321", // GitHub user ID in 'sub' field
		},
	}

	token := createTestToken(t, claims)

	userInfo, err := ExtractUserFromToken(token)
	if err != nil {
		t.Fatalf("Failed to extract user: %v", err)
	}

	// Verify that GitHubID was extracted from 'sub' fallback
	if userInfo.GitHubID != "87654321" {
		t.Errorf("Expected GitHub ID '87654321' from sub fallback, got '%s'", userInfo.GitHubID)
	}

	if userInfo.UserName != "fallbackuser" {
		t.Errorf("Expected username 'fallbackuser', got '%s'", userInfo.UserName)
	}
}

func TestExtractUserFromTokenProviderIdTakesPrecedence(t *testing.T) {
	// Create claims with both 'provider_id' and 'sub' in user_metadata
	// This tests that provider_id takes precedence over sub
	claims := &SupabaseClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "supabase-user-id-999",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Email: "precedence@example.com",
		UserMetadata: map[string]interface{}{
			"user_name":   "precedenceuser",
			"provider_id": "11111111", // Should take precedence
			"sub":         "22222222", // Should be ignored
		},
	}

	token := createTestToken(t, claims)

	userInfo, err := ExtractUserFromToken(token)
	if err != nil {
		t.Fatalf("Failed to extract user: %v", err)
	}

	// Verify that GitHubID was extracted from provider_id, not sub
	if userInfo.GitHubID != "11111111" {
		t.Errorf("Expected GitHub ID '11111111' from provider_id, got '%s'", userInfo.GitHubID)
	}
}
