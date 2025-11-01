package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/pflow-xyz/pflow-xyz/internal/auth"
	"github.com/pflow-xyz/pflow-xyz/internal/seal"
	"github.com/pflow-xyz/pflow-xyz/internal/static"
	"github.com/pflow-xyz/pflow-xyz/internal/store"
)

// Storage interface abstracts filesystem backends
type Storage interface {
	GetObject(cid string) ([]byte, error)
	SaveObject(cid string, raw []byte, canonical []byte) error
	SaveObjectWithAuthor(cid string, raw []byte, canonical []byte, githubUser, githubID string) error
	GetLatest(user, slug string) (string, error)
	GetHistory(user, slug string) ([]store.HistoryEntry, error)
	UpdateLatest(user, slug, cid string) error
	AppendHistory(user, slug, cid string) error
	DeleteObject(cid string) error
	GetObjectAuthor(cid string) (githubUser, githubID string, err error)
}

// FSStorage implements Storage using filesystem
type FSStorage struct {
	store *store.FSStore
}

func NewFSStorage(basePath string) *FSStorage {
	return &FSStorage{store: store.NewFSStore(basePath)}
}

func (fs *FSStorage) GetObject(cid string) ([]byte, error) {
	return fs.store.ReadObject(cid)
}

func (fs *FSStorage) SaveObject(cid string, raw []byte, canonical []byte) error {
	return fs.store.SaveObject(cid, raw, canonical)
}

func (fs *FSStorage) SaveObjectWithAuthor(cid string, raw []byte, canonical []byte, githubUser, githubID string) error {
	return fs.store.SaveObjectWithAuthor(cid, raw, canonical, githubUser, githubID)
}

func (fs *FSStorage) GetLatest(user, slug string) (string, error) {
	return fs.store.ReadLatest(user, slug)
}

func (fs *FSStorage) GetHistory(user, slug string) ([]store.HistoryEntry, error) {
	return fs.store.ReadHistory(user, slug)
}

func (fs *FSStorage) UpdateLatest(user, slug, cid string) error {
	return fs.store.UpdateLatest(user, slug, cid)
}

func (fs *FSStorage) AppendHistory(user, slug, cid string) error {
	return fs.store.AppendHistory(user, slug, cid)
}

func (fs *FSStorage) DeleteObject(cid string) error {
	return fs.store.DeleteObject(cid)
}

func (fs *FSStorage) GetObjectAuthor(cid string) (string, string, error) {
	return fs.store.GetObjectAuthor(cid)
}

// validateJSONLD validates the structure and content of a JSON-LD document
func validateJSONLD(doc map[string]interface{}) error {
	// Check for required @context field
	context, hasContext := doc["@context"]
	if !hasContext {
		return fmt.Errorf("missing @context field")
	}

	// Validate @context is a valid type (string, object, or array)
	switch context.(type) {
	case string, map[string]interface{}, []interface{}:
		// Valid types
	default:
		return fmt.Errorf("@context must be a string, object, or array")
	}

	// Validate there are no excessively deep nested structures (prevent DoS)
	if err := validateDepth(doc, 0, 50); err != nil {
		return err
	}

	// Validate keys don't contain control characters or other dangerous content
	if err := validateKeys(doc); err != nil {
		return err
	}

	return nil
}

// validateDepth recursively checks the nesting depth of a structure
func validateDepth(data interface{}, current, max int) error {
	if current > max {
		return fmt.Errorf("document exceeds maximum nesting depth of %d", max)
	}

	switch v := data.(type) {
	case map[string]interface{}:
		for _, val := range v {
			if err := validateDepth(val, current+1, max); err != nil {
				return err
			}
		}
	case []interface{}:
		for _, val := range v {
			if err := validateDepth(val, current+1, max); err != nil {
				return err
			}
		}
	}

	return nil
}

// validateKeys checks that all keys in the document are safe
func validateKeys(data interface{}) error {
	switch v := data.(type) {
	case map[string]interface{}:
		for key, val := range v {
			// Check for control characters or null bytes
			for _, ch := range key {
				if ch < 32 || ch == 127 {
					return fmt.Errorf("keys cannot contain control characters")
				}
			}
			// Recursively validate nested structures
			if err := validateKeys(val); err != nil {
				return err
			}
		}
	case []interface{}:
		for _, val := range v {
			if err := validateKeys(val); err != nil {
				return err
			}
		}
	}

	return nil
}

// Server represents the web server
type Server struct {
	storage  Storage
	publicFS fs.FS
}

// handleCORS handles CORS preflight requests
func (s *Server) handleCORS(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
	}

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return true
	}

	return false
}

// Handler for GET /o/{cid} - get object by CID
func (s *Server) handleGetObject(w http.ResponseWriter, r *http.Request) {
	if s.handleCORS(w, r) {
		return
	}

	// Extract CID from path
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/o/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "CID required", http.StatusBadRequest)
		return
	}
	cid := parts[0]

	data, err := s.storage.GetObject(cid)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Object not found", http.StatusNotFound)
			return
		}
		log.Printf("Error getting object %s: %v", cid, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/ld+json")
	w.Write(data)
}

// Handler for GET /api/ownership/{cid} - check if current user owns the object
func (s *Server) handleCheckOwnership(w http.ResponseWriter, r *http.Request) {
	if s.handleCORS(w, r) {
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract CID from path
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/ownership/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "CID required", http.StatusBadRequest)
		return
	}
	cid := parts[0]

	// Extract and validate authentication token
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		// Return not owned if not authenticated
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"owned": false})
		return
	}

	userInfo, err := auth.ExtractUserFromToken(authHeader)
	if err != nil {
		// Return not owned if authentication fails
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"owned": false})
		return
	}

	// Get the object author
	authorUser, authorID, err := s.storage.GetObjectAuthor(cid)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Object not found", http.StatusNotFound)
			return
		}
		log.Printf("Error getting object author for %s: %v", cid, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Check if the user is the author
	// Priority: GitHub ID (most secure) > username (for backward compatibility)
	isOwned := (authorID != "" && userInfo.GitHubID != "" && authorID == userInfo.GitHubID) ||
		(authorUser != "" && userInfo.UserName != "" && authorUser == userInfo.UserName)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"owned": isOwned})
}

// Handler for POST /api/save - save JSON-LD and return CID
func (s *Server) handleSave(w http.ResponseWriter, r *http.Request) {
	if s.handleCORS(w, r) {
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract and validate authentication token
	authHeader := r.Header.Get("Authorization")
	var userInfo *auth.GitHubUserInfo
	var err error

	if authHeader != "" {
		userInfo, err = auth.ExtractUserFromToken(authHeader)
		if err != nil {
			log.Printf("Invalid authentication token: %v", err)
			http.Error(w, "Invalid authentication token", http.StatusUnauthorized)
			return
		}
	}

	// Read and validate request body
	var doc map[string]interface{}
	if err := json.NewDecoder(r.Body).Decode(&doc); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Validate JSON-LD structure
	if err := validateJSONLD(doc); err != nil {
		http.Error(w, fmt.Sprintf("Invalid JSON-LD: %v", err), http.StatusBadRequest)
		return
	}

	// Convert to raw JSON
	raw, err := json.Marshal(doc)
	if err != nil {
		http.Error(w, "Failed to serialize JSON", http.StatusInternalServerError)
		return
	}

	// Seal the JSON-LD (canonicalize and compute CID)
	cid, canonical, err := seal.SealJSONLD(raw)
	if err != nil {
		log.Printf("Sealing failed: %v", err)
		http.Error(w, fmt.Sprintf("Sealing failed: %v", err), http.StatusBadRequest)
		return
	}

	// Save with or without author info
	if userInfo != nil {
		err = s.storage.SaveObjectWithAuthor(cid, raw, canonical, userInfo.UserName, userInfo.GitHubID)
	} else {
		err = s.storage.SaveObject(cid, raw, canonical)
	}

	if err != nil {
		log.Printf("Failed to save object: %v", err)
		http.Error(w, "Failed to save object", http.StatusInternalServerError)
		return
	}

	// Return CID
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"cid": cid})
}

// Handler for DELETE /o/{cid} - delete object (author only)
func (s *Server) handleDeleteObject(w http.ResponseWriter, r *http.Request) {
	if s.handleCORS(w, r) {
		return
	}

	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract CID from path
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/o/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "CID required", http.StatusBadRequest)
		return
	}
	cid := parts[0]

	// Extract and validate authentication token
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		http.Error(w, "Authentication required", http.StatusUnauthorized)
		return
	}

	userInfo, err := auth.ExtractUserFromToken(authHeader)
	if err != nil {
		log.Printf("Invalid authentication token: %v", err)
		http.Error(w, "Invalid authentication token", http.StatusUnauthorized)
		return
	}

	// Get the object author
	authorUser, authorID, err := s.storage.GetObjectAuthor(cid)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Object not found", http.StatusNotFound)
			return
		}
		log.Printf("Error getting object author for %s: %v", cid, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Verify the requesting user is the author
	// Priority: GitHub ID (most secure) > username (for backward compatibility)
	isAuthor := false
	if authorID != "" && userInfo.GitHubID != "" && authorID == userInfo.GitHubID {
		isAuthor = true
	} else if authorUser != "" && userInfo.UserName != "" && authorUser == userInfo.UserName {
		// Username fallback for backward compatibility
		isAuthor = true
	}

	if !isAuthor {
		log.Printf("Delete denied: user %s (ID: %s) tried to delete object authored by %s (ID: %s)",
			userInfo.UserName, userInfo.GitHubID, authorUser, authorID)
		http.Error(w, "Forbidden: only the author can delete this object", http.StatusForbidden)
		return
	}

	// Delete the object
	if err := s.storage.DeleteObject(cid); err != nil {
		log.Printf("Error deleting object %s: %v", cid, err)
		http.Error(w, "Failed to delete object", http.StatusInternalServerError)
		return
	}

	log.Printf("Object %s deleted by author %s (ID: %s)", cid, userInfo.UserName, userInfo.GitHubID)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	log.Printf("%s %s", r.Method, r.URL.Path)

	// API routes
	if r.URL.Path == "/api/save" {
		s.handleSave(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/ownership/") {
		s.handleCheckOwnership(w, r)
		return
	}

	// Object routes
	if strings.HasPrefix(r.URL.Path, "/o/") {
		if r.Method == http.MethodDelete {
			s.handleDeleteObject(w, r)
		} else {
			s.handleGetObject(w, r)
		}
		return
	}

	// Serve static files from embedded filesystem
	if s.publicFS != nil {
		// For root path, serve index.html
		if r.URL.Path == "/" {
			data, err := fs.ReadFile(s.publicFS, "index.html")
			if err != nil {
				http.Error(w, "Not found", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "text/html")
			w.Write(data)
			return
		}

		// Serve other static files
		http.FileServer(http.FS(s.publicFS)).ServeHTTP(w, r)
		return
	}

	http.NotFound(w, r)
}

func main() {
	port := flag.Int("port", 8080, "Port to listen on")
	dataDir := flag.String("data", "./data", "Data directory for storage")
	flag.Parse()

	// Create storage
	storage := NewFSStorage(*dataDir)

	// Get embedded public filesystem
	publicFS, err := static.Public()
	if err != nil {
		log.Fatalf("Failed to get public filesystem: %v", err)
	}

	// Create server
	server := &Server{
		storage:  storage,
		publicFS: publicFS,
	}

	// Start server
	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Starting server on %s", addr)
	log.Printf("Data directory: %s", *dataDir)
	if err := http.ListenAndServe(addr, server); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
