package auth

import (
	"fmt"
	"os"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// GitHubUserInfo contains the GitHub user information from Supabase JWT
type GitHubUserInfo struct {
	ID       string `json:"sub"`         // Supabase user ID
	Email    string `json:"email"`       // User email
	UserName string `json:"user_name"`   // GitHub username from user_metadata
	FullName string `json:"full_name"`   // GitHub full name from user_metadata
	GitHubID string `json:"provider_id"` // GitHub user ID
}

// SupabaseClaims represents the JWT claims from Supabase
type SupabaseClaims struct {
	jwt.RegisteredClaims
	Email        string                 `json:"email"`
	UserMetadata map[string]interface{} `json:"user_metadata"`
	AppMetadata  map[string]interface{} `json:"app_metadata"`
}

// ExtractUserFromToken extracts and verifies GitHub user information from a Supabase JWT token
// The token signature is verified using the Supabase JWT secret from the SUPABASE_JWT_SECRET environment variable
func ExtractUserFromToken(tokenString string) (*GitHubUserInfo, error) {
	// Remove "Bearer " prefix if present
	tokenString = strings.TrimPrefix(tokenString, "Bearer ")

	// Get JWT secret from environment variable
	jwtSecret := os.Getenv("SUPABASE_JWT_SECRET")
	if jwtSecret == "" {
		return nil, fmt.Errorf("SUPABASE_JWT_SECRET environment variable not set")
	}

	// Parse and verify the JWT token
	token, err := jwt.ParseWithClaims(tokenString, &SupabaseClaims{}, func(token *jwt.Token) (interface{}, error) {
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
	claims, ok := token.Claims.(*SupabaseClaims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}

	// Build user info from verified claims
	userInfo := &GitHubUserInfo{
		ID:    claims.Subject,
		Email: claims.Email,
	}

	// Extract user_metadata which contains GitHub info
	if claims.UserMetadata != nil {
		if userName, ok := claims.UserMetadata["user_name"].(string); ok {
			userInfo.UserName = userName
		}
		if fullName, ok := claims.UserMetadata["full_name"].(string); ok {
			userInfo.FullName = fullName
		}
		// Try multiple fields for GitHub user ID
		// Supabase may store this in different fields depending on OAuth flow and token refresh
		if providerID, ok := claims.UserMetadata["provider_id"].(string); ok && providerID != "" {
			userInfo.GitHubID = providerID
		} else if sub, ok := claims.UserMetadata["sub"].(string); ok && sub != "" {
			// Fallback to 'sub' which may contain GitHub user ID from OAuth provider
			userInfo.GitHubID = sub
		}
	}

	// Also try app_metadata for provider info
	if claims.AppMetadata != nil {
		if provider, ok := claims.AppMetadata["provider"].(string); ok {
			if provider != "github" {
				return nil, fmt.Errorf("unsupported provider: %s", provider)
			}
		}
	}

	// Validate we have at least some user identification
	if userInfo.ID == "" && userInfo.Email == "" && userInfo.UserName == "" {
		return nil, fmt.Errorf("no user identification found in token")
	}

	return userInfo, nil
}
