package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveObject_InjectsID(t *testing.T) {
	// Create a temporary directory for testing
	tmpDir, err := os.MkdirTemp("", "store-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store := NewFSStore(tmpDir)

	// Test data
	cid := "z4EBG9jTestCID123"
	raw := []byte(`{
		"@context": {
			"name": "http://schema.org/name"
		},
		"name": "Test"
	}`)
	canonical := []byte("_:c14n0 <http://schema.org/name> \"Test\" .\n")

	// Save the object
	err = store.SaveObject(cid, raw, canonical)
	if err != nil {
		t.Fatalf("SaveObject failed: %v", err)
	}

	// Read the saved object
	savedPath := filepath.Join(tmpDir, "o", cid)
	savedData, err := os.ReadFile(savedPath)
	if err != nil {
		t.Fatalf("Failed to read saved object: %v", err)
	}

	// Parse the saved JSON
	var savedDoc map[string]interface{}
	if err := json.Unmarshal(savedData, &savedDoc); err != nil {
		t.Fatalf("Failed to parse saved JSON: %v", err)
	}

	// Verify @id field was injected
	idValue, ok := savedDoc["@id"]
	if !ok {
		t.Errorf("@id field was not injected into saved object")
	}

	expectedID := "ipfs://" + cid
	if idValue != expectedID {
		t.Errorf("Expected @id to be %q, got %q", expectedID, idValue)
	}

	// Verify other fields are preserved
	if savedDoc["name"] != "Test" {
		t.Errorf("Original fields were not preserved")
	}
}

func TestSaveObject_SavesCanonical(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "store-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store := NewFSStore(tmpDir)

	cid := "z4EBG9jTestCID123"
	raw := []byte(`{"name": "Test"}`)
	canonical := []byte("_:c14n0 <http://schema.org/name> \"Test\" .\n")

	err = store.SaveObject(cid, raw, canonical)
	if err != nil {
		t.Fatalf("SaveObject failed: %v", err)
	}

	// Verify canonical file was saved
	canonicalPath := filepath.Join(tmpDir, "o", "canonical", cid+".nq")
	savedCanonical, err := os.ReadFile(canonicalPath)
	if err != nil {
		t.Fatalf("Failed to read canonical file: %v", err)
	}

	if string(savedCanonical) != string(canonical) {
		t.Errorf("Canonical content mismatch.\nExpected: %s\nGot: %s", canonical, savedCanonical)
	}
}

func TestSaveObject_FormatsJSON(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "store-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store := NewFSStore(tmpDir)

	cid := "z4EBG9jTestCID123"
	// Compact JSON input
	raw := []byte(`{"@context":{"name":"http://schema.org/name"},"name":"Test"}`)
	canonical := []byte("test")

	err = store.SaveObject(cid, raw, canonical)
	if err != nil {
		t.Fatalf("SaveObject failed: %v", err)
	}

	// Read the saved object
	savedPath := filepath.Join(tmpDir, "o", cid)
	savedData, err := os.ReadFile(savedPath)
	if err != nil {
		t.Fatalf("Failed to read saved object: %v", err)
	}

	// Verify it's formatted (has newlines)
	savedStr := string(savedData)
	if len(savedStr) == len(string(raw)) {
		t.Errorf("Expected JSON to be formatted with indentation")
	}

	// Verify it's valid JSON
	var doc map[string]interface{}
	if err := json.Unmarshal(savedData, &doc); err != nil {
		t.Errorf("Saved data is not valid JSON: %v", err)
	}
}

func TestReadObject(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "store-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store := NewFSStore(tmpDir)

	cid := "z4EBG9jTestCID123"
	raw := []byte(`{"name": "Test"}`)
	canonical := []byte("test")

	// Save first
	err = store.SaveObject(cid, raw, canonical)
	if err != nil {
		t.Fatalf("SaveObject failed: %v", err)
	}

	// Read back
	readData, err := store.ReadObject(cid)
	if err != nil {
		t.Fatalf("ReadObject failed: %v", err)
	}

	// Parse and verify @id was injected
	var doc map[string]interface{}
	if err := json.Unmarshal(readData, &doc); err != nil {
		t.Fatalf("Failed to parse read data: %v", err)
	}

	expectedID := "ipfs://" + cid
	if doc["@id"] != expectedID {
		t.Errorf("Expected @id to be %q, got %q", expectedID, doc["@id"])
	}
}

func TestSaveSignature(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "store-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store := NewFSStore(tmpDir)

	cid := "z4EBG9jTestCID123"
	signature := "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12"
	signerAddr := "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
	usePersonalSign := true

	err = store.SaveSignature(cid, signature, signerAddr, usePersonalSign)
	if err != nil {
		t.Fatalf("SaveSignature failed: %v", err)
	}

	// Verify signature file was saved
	sigPath := store.SignaturePath(cid)
	if _, err := os.Stat(sigPath); os.IsNotExist(err) {
		t.Fatal("Signature file was not created")
	}

	// Read and verify
	savedData, err := os.ReadFile(sigPath)
	if err != nil {
		t.Fatalf("Failed to read signature file: %v", err)
	}

	var meta SignatureMetadata
	if err := json.Unmarshal(savedData, &meta); err != nil {
		t.Fatalf("Failed to parse signature metadata: %v", err)
	}

	if meta.Signature != signature {
		t.Errorf("Signature mismatch: expected %s, got %s", signature, meta.Signature)
	}

	if meta.SignerAddress != signerAddr {
		t.Errorf("SignerAddress mismatch: expected %s, got %s", signerAddr, meta.SignerAddress)
	}

	if meta.UsePersonalSign != usePersonalSign {
		t.Errorf("UsePersonalSign mismatch: expected %v, got %v", usePersonalSign, meta.UsePersonalSign)
	}
}

func TestReadSignature(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "store-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	store := NewFSStore(tmpDir)

	cid := "z4EBG9jTestCID123"
	signature := "0xabcdef1234567890"
	signerAddr := "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
	usePersonalSign := false

	// Save first
	err = store.SaveSignature(cid, signature, signerAddr, usePersonalSign)
	if err != nil {
		t.Fatalf("SaveSignature failed: %v", err)
	}

	// Read back
	meta, err := store.ReadSignature(cid)
	if err != nil {
		t.Fatalf("ReadSignature failed: %v", err)
	}

	if meta.Signature != signature {
		t.Errorf("Signature mismatch: expected %s, got %s", signature, meta.Signature)
	}

	if meta.SignerAddress != signerAddr {
		t.Errorf("SignerAddress mismatch: expected %s, got %s", signerAddr, meta.SignerAddress)
	}

	if meta.UsePersonalSign != usePersonalSign {
		t.Errorf("UsePersonalSign mismatch: expected %v, got %v", usePersonalSign, meta.UsePersonalSign)
	}
}

func TestSignaturePath(t *testing.T) {
	tmpDir := "/tmp/test-store"
	store := NewFSStore(tmpDir)

	cid := "z4EBG9jTestCID123"
	expectedPath := filepath.Join(tmpDir, "o", "signatures", cid+".json")

	actualPath := store.SignaturePath(cid)

	if actualPath != expectedPath {
		t.Errorf("SignaturePath mismatch: expected %s, got %s", expectedPath, actualPath)
	}
}

func TestPathSanitization(t *testing.T) {
	tmpDir := t.TempDir()
	st := NewFSStore(tmpDir)

	// Test path traversal attempts in CID
	_, err := st.ReadObject("../../../etc/passwd")
	if err == nil {
		t.Error("Expected error for path traversal in CID")
	}

	_, err = st.ReadObject("test/../../../etc/passwd")
	if err == nil {
		t.Error("Expected error for path traversal in CID")
	}

	// Test path traversal in user/slug
	_, err = st.ReadLatest("../../../etc", "passwd")
	if err == nil {
		t.Error("Expected error for path traversal in user")
	}

	_, err = st.ReadLatest("testuser", "../../../etc/passwd")
	if err == nil {
		t.Error("Expected error for path traversal in slug")
	}

	// Test valid inputs still work
	validCID := "z4EBG9jDcmuFgD2Vs1unB4caki8tPhKrdWeoEME9d35HmhBZfJQ"
	raw := []byte(`{"@context":"test","name":"test"}`)
	canonical := []byte(`canonical`)

	if err := st.SaveObject(validCID, raw, canonical); err != nil {
		t.Fatalf("Valid CID should work: %v", err)
	}

	if _, err := st.ReadObject(validCID); err != nil {
		t.Errorf("Reading valid CID should work: %v", err)
	}

	// Test valid user/slug
	if err := st.UpdateLatest("testuser", "testslug", validCID); err != nil {
		t.Fatalf("Valid user/slug should work: %v", err)
	}

	if _, err := st.ReadLatest("testuser", "testslug"); err != nil {
		t.Errorf("Reading valid user/slug should work: %v", err)
	}
}
