package ethsig

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGenerateNewKey(t *testing.T) {
	key, err := GenerateNewKey()
	if err != nil {
		t.Fatalf("GenerateNewKey failed: %v", err)
	}
	if key == nil {
		t.Fatal("Generated key is nil")
	}
}

func TestPrivateKeyToHex(t *testing.T) {
	key, err := GenerateNewKey()
	if err != nil {
		t.Fatalf("GenerateNewKey failed: %v", err)
	}

	hexKey := PrivateKeyToHex(key)
	if len(hexKey) != 64 {
		t.Errorf("Expected hex key length 64, got %d", len(hexKey))
	}

	// Check if it's valid hex
	if _, err := LoadPrivateKeyFromHex(hexKey); err != nil {
		t.Errorf("Generated hex key is not valid: %v", err)
	}
}

func TestLoadPrivateKeyFromHex(t *testing.T) {
	// Generate a key
	key1, err := GenerateNewKey()
	if err != nil {
		t.Fatalf("GenerateNewKey failed: %v", err)
	}

	// Convert to hex
	hexKey := PrivateKeyToHex(key1)

	// Load it back
	key2, err := LoadPrivateKeyFromHex(hexKey)
	if err != nil {
		t.Fatalf("LoadPrivateKeyFromHex failed: %v", err)
	}

	// Compare addresses
	addr1 := GetAddressFromPrivateKey(key1)
	addr2 := GetAddressFromPrivateKey(key2)

	if addr1 != addr2 {
		t.Errorf("Addresses don't match: %s vs %s", addr1, addr2)
	}
}

func TestLoadPrivateKeyFromHex_WithPrefix(t *testing.T) {
	key1, err := GenerateNewKey()
	if err != nil {
		t.Fatalf("GenerateNewKey failed: %v", err)
	}

	hexKey := "0x" + PrivateKeyToHex(key1)

	key2, err := LoadPrivateKeyFromHex(hexKey)
	if err != nil {
		t.Fatalf("LoadPrivateKeyFromHex with 0x prefix failed: %v", err)
	}

	addr1 := GetAddressFromPrivateKey(key1)
	addr2 := GetAddressFromPrivateKey(key2)

	if addr1 != addr2 {
		t.Errorf("Addresses don't match: %s vs %s", addr1, addr2)
	}
}

func TestGetAddressFromPrivateKey(t *testing.T) {
	key, err := GenerateNewKey()
	if err != nil {
		t.Fatalf("GenerateNewKey failed: %v", err)
	}

	addr := GetAddressFromPrivateKey(key)

	// Check format
	if !strings.HasPrefix(addr, "0x") {
		t.Errorf("Address should start with 0x, got: %s", addr)
	}

	if len(addr) != 42 {
		t.Errorf("Address should be 42 characters (0x + 40 hex), got %d", len(addr))
	}
}

func TestCreateAndLoadKeystore(t *testing.T) {
	// Create temp directory for test
	tmpDir := t.TempDir()
	keystorePath := filepath.Join(tmpDir, "test-keystore.json")

	// Generate a key
	key1, err := GenerateNewKey()
	if err != nil {
		t.Fatalf("GenerateNewKey failed: %v", err)
	}

	addr1 := GetAddressFromPrivateKey(key1)
	passphrase := "test-passphrase-123"

	// Create keystore
	if err := CreateKeystore(key1, passphrase, keystorePath); err != nil {
		t.Fatalf("CreateKeystore failed: %v", err)
	}

	// Verify file was created
	if _, err := os.Stat(keystorePath); os.IsNotExist(err) {
		t.Fatal("Keystore file was not created")
	}

	// Load address from keystore (without decrypting)
	addrFromKeystore, err := GetAddressFromKeystore(keystorePath)
	if err != nil {
		t.Fatalf("GetAddressFromKeystore failed: %v", err)
	}

	if !strings.EqualFold(addrFromKeystore, addr1) {
		t.Errorf("Address from keystore doesn't match: %s vs %s", addrFromKeystore, addr1)
	}

	// Load private key from keystore
	key2, err := LoadPrivateKeyFromKeystore(keystorePath, passphrase)
	if err != nil {
		t.Fatalf("LoadPrivateKeyFromKeystore failed: %v", err)
	}

	addr2 := GetAddressFromPrivateKey(key2)

	if addr1 != addr2 {
		t.Errorf("Addresses don't match after loading from keystore: %s vs %s", addr1, addr2)
	}
}

func TestLoadPrivateKeyFromKeystore_WrongPassphrase(t *testing.T) {
	tmpDir := t.TempDir()
	keystorePath := filepath.Join(tmpDir, "test-keystore.json")

	key, err := GenerateNewKey()
	if err != nil {
		t.Fatalf("GenerateNewKey failed: %v", err)
	}

	correctPassphrase := "correct-passphrase"
	wrongPassphrase := "wrong-passphrase"

	if err := CreateKeystore(key, correctPassphrase, keystorePath); err != nil {
		t.Fatalf("CreateKeystore failed: %v", err)
	}

	// Try to load with wrong passphrase
	_, err = LoadPrivateKeyFromKeystore(keystorePath, wrongPassphrase)
	if err == nil {
		t.Error("Expected error when loading keystore with wrong passphrase")
	}

	if !strings.Contains(err.Error(), "decrypt") {
		t.Errorf("Error should mention decryption failure, got: %v", err)
	}
}

func TestGetAddressFromKeystore_InvalidFile(t *testing.T) {
	tmpDir := t.TempDir()
	invalidPath := filepath.Join(tmpDir, "nonexistent.json")

	_, err := GetAddressFromKeystore(invalidPath)
	if err == nil {
		t.Error("Expected error when loading nonexistent keystore file")
	}
}

func TestGetAddressFromKeystore_InvalidJSON(t *testing.T) {
	tmpDir := t.TempDir()
	invalidPath := filepath.Join(tmpDir, "invalid.json")

	// Write invalid JSON
	if err := os.WriteFile(invalidPath, []byte("not valid json"), 0600); err != nil {
		t.Fatalf("Failed to write test file: %v", err)
	}

	_, err := GetAddressFromKeystore(invalidPath)
	if err == nil {
		t.Error("Expected error when loading invalid JSON keystore")
	}
}

func TestLoadPrivateKeyFromHex_InvalidHex(t *testing.T) {
	invalidHex := "not-a-hex-string"

	_, err := LoadPrivateKeyFromHex(invalidHex)
	if err == nil {
		t.Error("Expected error when loading invalid hex private key")
	}
}

func TestLoadPrivateKeyFromHex_WrongLength(t *testing.T) {
	shortHex := "1234567890abcdef"

	_, err := LoadPrivateKeyFromHex(shortHex)
	if err == nil {
		t.Error("Expected error when loading hex key with wrong length")
	}
}

func TestKeystoreFilePermissions(t *testing.T) {
	tmpDir := t.TempDir()
	keystorePath := filepath.Join(tmpDir, "test-keystore.json")

	key, err := GenerateNewKey()
	if err != nil {
		t.Fatalf("GenerateNewKey failed: %v", err)
	}

	if err := CreateKeystore(key, "passphrase", keystorePath); err != nil {
		t.Fatalf("CreateKeystore failed: %v", err)
	}

	// Check file permissions
	info, err := os.Stat(keystorePath)
	if err != nil {
		t.Fatalf("Failed to stat keystore file: %v", err)
	}

	// Should be readable and writable only by owner (0600)
	perm := info.Mode().Perm()
	if perm != 0600 {
		t.Errorf("Expected file permissions 0600, got 0%o", perm)
	}
}
