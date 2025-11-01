package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// sanitizePathComponent validates and sanitizes a path component to prevent path traversal
func sanitizePathComponent(component string) (string, error) {
	// Disallow empty strings
	if component == "" {
		return "", fmt.Errorf("path component cannot be empty")
	}
	
	// Disallow path separators and parent directory references
	if strings.Contains(component, "/") || strings.Contains(component, "\\") || 
	   strings.Contains(component, "..") || component == "." {
		return "", fmt.Errorf("invalid path component: %s", component)
	}
	
	// Clean the path component
	cleaned := filepath.Clean(component)
	
	// Verify it hasn't changed (would indicate suspicious input)
	if cleaned != component {
		return "", fmt.Errorf("path component contains invalid characters: %s", component)
	}
	
	return cleaned, nil
}

// FSStore is a simple file-system-backed store for sealed objects and user containers.
// Structure:
//  {base}/o/{cid}              -> original JSON-LD bytes
//  {base}/o/canonical/{cid}.nq -> canonical n-quads text
//  {base}/u/{login}/g/{slug}/latest -> text file containing CID
//  {base}/u/{login}/g/{slug}/_history -> JSON array of history entries
type FSStore struct {
	base string
	// mu protects concurrent access to files, especially for read-modify-write operations like AppendHistory
	mu sync.Mutex
}

type HistoryEntry struct {
	CID       string    `json:"cid"`
	CreatedAt time.Time `json:"createdAt"`
}

func NewFSStore(base string) *FSStore {
	return &FSStore{base: base}
}

// ObjectPath returns the path where the original JSON-LD for a CID is stored.
func (s *FSStore) ObjectPath(cid string) string {
	// Note: This is a public API that returns a path string
	// The actual file operations should sanitize the CID
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		// Return an invalid path that will fail on use
		return ""
	}
	return filepath.Join(s.base, "o", cleanCID)
}

// SaveObject writes the raw JSON-LD and canonical bytes to disk.
// It injects the computed CID as the @id field into the stored JSON-LD.
func (s *FSStore) SaveObject(cid string, raw []byte, canonical []byte) error {
	return s.SaveObjectWithAuthor(cid, raw, canonical, "", "")
}

// SaveObjectWithAuthor writes the raw JSON-LD and canonical bytes to disk.
// It injects the computed CID as the @id field and author information into the stored JSON-LD.
func (s *FSStore) SaveObjectWithAuthor(cid string, raw []byte, canonical []byte, githubUser, githubID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		return fmt.Errorf("invalid cid: %w", err)
	}
	
	objDir := filepath.Join(s.base, "o")
	if err := os.MkdirAll(objDir, 0o755); err != nil {
		return err
	}
	
	// Inject the @id field into the JSON-LD before saving
	var doc map[string]interface{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return err
	}
	
	// Add the @id field with ipfs:// prefix
	doc["@id"] = "ipfs://" + cid
	
	// Add author information if we have at least username or GitHub ID
	// Both are needed to provide meaningful provenance
	if githubUser != "" || githubID != "" {
		author := make(map[string]interface{})
		author["@type"] = "Person"
		
		// Only add username-based fields if username is present
		if githubUser != "" {
			author["name"] = githubUser
			author["identifier"] = "https://github.com/" + githubUser
		}
		
		// Add GitHub ID if present
		if githubID != "" {
			author["id"] = "github:" + githubID
		}
		
		doc["author"] = author
	}
	
	// Marshal back to JSON with indentation for readability
	modifiedRaw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	
	// Save the modified JSON-LD with injected @id
	if err := os.WriteFile(filepath.Join(objDir, cleanCID), modifiedRaw, 0o644); err != nil {
		return err
	}
	
	// canonical
	canonDir := filepath.Join(objDir, "canonical")
	if err := os.MkdirAll(canonDir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(canonDir, cleanCID+".nq"), canonical, 0o644); err != nil {
		return err
	}
	return nil
}

// ensureGistDir ensures the directory structure for a user's gist exists.
func (s *FSStore) ensureGistDir(user, slug string) (string, error) {
	cleanUser, err := sanitizePathComponent(user)
	if err != nil {
		return "", fmt.Errorf("invalid user: %w", err)
	}
	cleanSlug, err := sanitizePathComponent(slug)
	if err != nil {
		return "", fmt.Errorf("invalid slug: %w", err)
	}
	
	dir := filepath.Join(s.base, "u", cleanUser, "g", cleanSlug)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

// UpdateLatest writes the pointer file /u/{login}/g/{slug}/latest containing the CID.
func (s *FSStore) UpdateLatest(user, slug, cid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	dir, err := s.ensureGistDir(user, slug)
	if err != nil {
		return err
	}
	latestPath := filepath.Join(dir, "latest")
	return os.WriteFile(latestPath, []byte(cid), 0o644)
}

// AppendHistory appends a history entry (CID + timestamp) to _history (JSON array).
func (s *FSStore) AppendHistory(user, slug, cidStr string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	dir, err := s.ensureGistDir(user, slug)
	if err != nil {
		return err
	}
	historyPath := filepath.Join(dir, "_history")

	var entries []HistoryEntry
	if data, err := os.ReadFile(historyPath); err == nil {
		_ = json.Unmarshal(data, &entries) // ignore error; we'll overwrite if corrupted
	}

	entries = append(entries, HistoryEntry{
		CID:       cidStr,
		CreatedAt: time.Now().UTC(),
	})

	out, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(historyPath, out, 0o644)
}

// ReadLatest returns the CID stored in latest (or empty string if not present).
func (s *FSStore) ReadLatest(user, slug string) (string, error) {
	cleanUser, err := sanitizePathComponent(user)
	if err != nil {
		return "", fmt.Errorf("invalid user: %w", err)
	}
	cleanSlug, err := sanitizePathComponent(slug)
	if err != nil {
		return "", fmt.Errorf("invalid slug: %w", err)
	}
	
	dir := filepath.Join(s.base, "u", cleanUser, "g", cleanSlug)
	latestPath := filepath.Join(dir, "latest")
	b, err := os.ReadFile(latestPath)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// ReadHistory reads and returns the history entries for a gist.
func (s *FSStore) ReadHistory(user, slug string) ([]HistoryEntry, error) {
	cleanUser, err := sanitizePathComponent(user)
	if err != nil {
		return nil, fmt.Errorf("invalid user: %w", err)
	}
	cleanSlug, err := sanitizePathComponent(slug)
	if err != nil {
		return nil, fmt.Errorf("invalid slug: %w", err)
	}
	
	dir := filepath.Join(s.base, "u", cleanUser, "g", cleanSlug)
	historyPath := filepath.Join(dir, "_history")
	b, err := os.ReadFile(historyPath)
	if err != nil {
		return nil, err
	}
	var entries []HistoryEntry
	if err := json.Unmarshal(b, &entries); err != nil {
		return nil, err
	}
	return entries, nil
}

// Utility: Create container for user (e.g., when user logs in)
func (s *FSStore) EnsureUserContainer(user string) error {
	cleanUser, err := sanitizePathComponent(user)
	if err != nil {
		return fmt.Errorf("invalid user: %w", err)
	}
	
	dir := filepath.Join(s.base, "u", cleanUser)
	return os.MkdirAll(dir, 0o755)
}

// Utility: Save identity doc at /id/github:{id}
func (s *FSStore) SaveIdentity(githubID string, doc []byte) error {
	dir := filepath.Join(s.base, "id")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	path := filepath.Join(dir, "github:"+githubID+".jsonld")
	return os.WriteFile(path, doc, 0o644)
}

// Utility: Read object raw JSON-LD
func (s *FSStore) ReadObject(cid string) ([]byte, error) {
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		return nil, fmt.Errorf("invalid cid: %w", err)
	}
	
	path := filepath.Join(s.base, "o", cleanCID)
	return os.ReadFile(path)
}

// Utility: Read canonical n-quads for a cid
func (s *FSStore) ReadCanonical(cid string) ([]byte, error) {
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		return nil, fmt.Errorf("invalid cid: %w", err)
	}
	
	path := filepath.Join(s.base, "o", "canonical", cleanCID+".nq")
	return os.ReadFile(path)
}

// SignatureMetadata holds information about a signature.
type SignatureMetadata struct {
	Signature       string `json:"signature"`
	SignerAddress   string `json:"signerAddress"`
	UsePersonalSign bool   `json:"usePersonalSign"`
}

// SignaturePath returns the path where the signature metadata for a CID is stored.
func (s *FSStore) SignaturePath(cid string) string {
	// Note: This is a public API that returns a path string
	// The actual file operations should sanitize the CID
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		// Return an invalid path that will fail on use
		return ""
	}
	return filepath.Join(s.base, "o", "signatures", cleanCID+".json")
}

// SaveSignature writes signature metadata to disk.
func (s *FSStore) SaveSignature(cid, signature, signerAddr string, usePersonalSign bool) error {
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		return fmt.Errorf("invalid cid: %w", err)
	}
	
	sigDir := filepath.Join(s.base, "o", "signatures")
	if err := os.MkdirAll(sigDir, 0o755); err != nil {
		return err
	}

	meta := SignatureMetadata{
		Signature:       signature,
		SignerAddress:   signerAddr,
		UsePersonalSign: usePersonalSign,
	}

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}

	sigPath := filepath.Join(s.base, "o", "signatures", cleanCID+".json")
	return os.WriteFile(sigPath, data, 0o644)
}

// ReadSignature reads signature metadata for a CID.
func (s *FSStore) ReadSignature(cid string) (*SignatureMetadata, error) {
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		return nil, fmt.Errorf("invalid cid: %w", err)
	}
	
	sigPath := filepath.Join(s.base, "o", "signatures", cleanCID+".json")
	data, err := os.ReadFile(sigPath)
	if err != nil {
		return nil, err
	}

	var meta SignatureMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}

	return &meta, nil
}

// GetObjectAuthor retrieves the author information from a stored object
func (s *FSStore) GetObjectAuthor(cid string) (githubUser, githubID string, err error) {
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		return "", "", fmt.Errorf("invalid cid: %w", err)
	}
	
	path := filepath.Join(s.base, "o", cleanCID)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", err
	}

	var doc map[string]interface{}
	if err := json.Unmarshal(data, &doc); err != nil {
		return "", "", fmt.Errorf("failed to parse object: %w", err)
	}

	// Extract author information
	if author, ok := doc["author"].(map[string]interface{}); ok {
		if name, ok := author["name"].(string); ok {
			githubUser = name
		}
		if id, ok := author["id"].(string); ok {
			// Strip "github:" prefix if present
			githubID = strings.TrimPrefix(id, "github:")
		}
	}

	return githubUser, githubID, nil
}

// DeleteObject removes an object and its associated files
func (s *FSStore) DeleteObject(cid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	
	cleanCID, err := sanitizePathComponent(cid)
	if err != nil {
		return fmt.Errorf("invalid cid: %w", err)
	}
	
	// Delete the main object file
	objPath := filepath.Join(s.base, "o", cleanCID)
	if err := os.Remove(objPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete object: %w", err)
	}
	
	// Delete the canonical file
	canonPath := filepath.Join(s.base, "o", "canonical", cleanCID+".nq")
	if err := os.Remove(canonPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to delete canonical file: %w", err)
	}
	
	// Delete the signature file if it exists
	sigPath := filepath.Join(s.base, "o", "signatures", cleanCID+".json")
	if err := os.Remove(sigPath); err != nil && !os.IsNotExist(err) {
		// Log error but don't fail the deletion - signature may not exist for all objects
		// This is a non-critical cleanup operation
		// Note: We can't use log here since this is internal/store package
		// Callers should check if they need to log this
	}
	
	return nil
}
