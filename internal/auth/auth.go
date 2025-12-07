package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// GitHubUserInfo contains the GitHub user information
type GitHubUserInfo struct {
	ID       string `json:"sub"`       // User ID (GitHub user ID)
	Email    string `json:"email"`     // User email
	UserName string `json:"user_name"` // GitHub username
	FullName string `json:"full_name"` // GitHub full name
	GitHubID string `json:"github_id"` // GitHub user ID (same as ID for direct GitHub auth)
}

// gitHubAPIUserResponse represents the GitHub API user response
type gitHubAPIUserResponse struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Name  string `json:"name"`
	Email string `json:"email"`
}

// gitHubEmailResponse represents a GitHub email entry
type gitHubEmailResponse struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

// ExtractUserFromToken verifies the GitHub access token and extracts user information
// by calling the GitHub API directly
func ExtractUserFromToken(tokenString string) (*GitHubUserInfo, error) {
	// Remove "Bearer " prefix if present
	tokenString = strings.TrimPrefix(tokenString, "Bearer ")

	// Call GitHub API to verify token and get user info
	req, err := http.NewRequest("GET", "https://api.github.com/user", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+tokenString)
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to call GitHub API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned status %d", resp.StatusCode)
	}

	var ghUser gitHubAPIUserResponse
	if err := json.NewDecoder(resp.Body).Decode(&ghUser); err != nil {
		return nil, fmt.Errorf("failed to decode GitHub response: %w", err)
	}

	email := ghUser.Email
	// If email is not in the user response, fetch from emails endpoint
	if email == "" {
		email, _ = getGitHubPrimaryEmail(tokenString)
	}

	userID := strconv.FormatInt(ghUser.ID, 10)

	userInfo := &GitHubUserInfo{
		ID:       userID,
		Email:    email,
		UserName: ghUser.Login,
		FullName: ghUser.Name,
		GitHubID: userID,
	}

	// Validate we have at least some user identification
	if userInfo.ID == "" && userInfo.Email == "" && userInfo.UserName == "" {
		return nil, fmt.Errorf("no user identification found")
	}

	return userInfo, nil
}

// getGitHubPrimaryEmail fetches the primary email from GitHub API
func getGitHubPrimaryEmail(accessToken string) (string, error) {
	req, err := http.NewRequest("GET", "https://api.github.com/user/emails", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/vnd.github.v3+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub API error: %s", resp.Status)
	}

	var emails []gitHubEmailResponse
	if err := json.NewDecoder(resp.Body).Decode(&emails); err != nil {
		return "", err
	}

	// Find primary email
	for _, e := range emails {
		if e.Primary && e.Verified {
			return e.Email, nil
		}
	}

	// Fallback to first verified email
	for _, e := range emails {
		if e.Verified {
			return e.Email, nil
		}
	}

	return "", nil
}
