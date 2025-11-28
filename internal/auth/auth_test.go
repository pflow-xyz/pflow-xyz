package auth

import (
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Helper function to create a valid signed JWT for testing
func createTestToken(t *testing.T, claims *GitHubClaims) string {
	t.Helper()

	// Use a test secret
	testSecret := "test-secret-key-for-testing"

	// Set the secret in environment for the test
	os.Setenv("JWT_SECRET", testSecret)

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
	claims := &GitHubClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   "12345678",
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Email:    "test@example.com",
		UserName: "testuser",
		FullName: "Test User",
		GitHubID: "12345678",
	}

	token := createTestToken(t, claims)

	// Test extraction
	userInfo, err := ExtractUserFromToken(token)
	if err != nil {
		t.Fatalf("Failed to extract user: %v", err)
	}

	// Validate extracted information
	if userInfo.ID != "12345678" {
		t.Errorf("Expected ID '12345678', got '%s'", userInfo.ID)
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
	claims := &GitHubClaims{
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
	os.Setenv("JWT_SECRET", "test-secret")

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
	claims := &GitHubClaims{
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
	os.Unsetenv("JWT_SECRET")

	// Just use a dummy token - we don't need to create a valid one
	// since the function should fail before validating the signature
	token := "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.test"

	_, err := ExtractUserFromToken(token)
	if err == nil {
		t.Error("Expected error when JWT_SECRET is not set, got nil")
	}

	// Restore for other tests
	os.Setenv("JWT_SECRET", "test-secret")
}
