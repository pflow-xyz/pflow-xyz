package auth

import (
	"fmt"
	"os"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// GitHubUserInfo contains the GitHub user information from JWT
type GitHubUserInfo struct {
	ID       string `json:"sub"`         // User ID (GitHub user ID)
	Email    string `json:"email"`       // User email
	UserName string `json:"user_name"`   // GitHub username
	FullName string `json:"full_name"`   // GitHub full name
	GitHubID string `json:"github_id"`   // GitHub user ID (same as ID for direct GitHub auth)
}

// GitHubClaims represents the JWT claims for GitHub authenticated users
type GitHubClaims struct {
	jwt.RegisteredClaims
	Email    string `json:"email"`
	UserName string `json:"user_name"`
	FullName string `json:"full_name"`
	GitHubID string `json:"github_id"`
}

// ExtractUserFromToken extracts and verifies GitHub user information from a JWT token
// The token signature is verified using the JWT secret from the JWT_SECRET environment variable
func ExtractUserFromToken(tokenString string) (*GitHubUserInfo, error) {
	// Remove "Bearer " prefix if present
	tokenString = strings.TrimPrefix(tokenString, "Bearer ")

	// Get JWT secret from environment variable
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET environment variable not set")
	}

	// Parse and verify the JWT token
	token, err := jwt.ParseWithClaims(tokenString, &GitHubClaims{}, func(token *jwt.Token) (interface{}, error) {
		// Verify the signing method is HMAC
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return []byte(jwtSecret), nil
	})

	if err != nil {
		return nil, fmt.Errorf("failed to parse JWT: %w", err)
	}

	// Extract claims
	claims, ok := token.Claims.(*GitHubClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}

	// Build user info from verified claims
	userInfo := &GitHubUserInfo{
		ID:       claims.Subject,
		Email:    claims.Email,
		UserName: claims.UserName,
		FullName: claims.FullName,
		GitHubID: claims.GitHubID,
	}

	// Validate we have at least some user identification
	if userInfo.ID == "" && userInfo.Email == "" && userInfo.UserName == "" {
		return nil, fmt.Errorf("no user identification found in token")
	}

	return userInfo, nil
}
