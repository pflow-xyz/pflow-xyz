package seal

import (
	"strings"
	"testing"

	cid "github.com/ipfs/go-cid"
	mh "github.com/multiformats/go-multihash"
)

func TestSealJSONLD_UsesJsonLdCodec(t *testing.T) {
	input := []byte(`{
		"@context": {
			"name": "http://schema.org/name"
		},
		"name": "Test"
	}`)

	cidStr, _, err := SealJSONLD(input)
	if err != nil {
		t.Fatalf("SealJSONLD failed: %v", err)
	}

	// Decode the CID
	c, err := cid.Decode(cidStr)
	if err != nil {
		t.Fatalf("Failed to decode CID: %v", err)
	}

	// Verify it uses DagJSON codec (0x0129)
	if c.Type() != cid.DagJSON {
		t.Errorf("Expected codec 0x%x (DagJSON), got 0x%x", cid.DagJSON, c.Type())
	}

	// Verify it's CIDv1
	if c.Version() != 1 {
		t.Errorf("Expected CIDv1, got version %d", c.Version())
	}

	// Verify it uses SHA2-256
	decoded, err := mh.Decode(c.Hash())
	if err != nil {
		t.Fatalf("Failed to decode multihash: %v", err)
	}
	if decoded.Code != mh.SHA2_256 {
		t.Errorf("Expected SHA2-256 (0x%x), got 0x%x", mh.SHA2_256, decoded.Code)
	}
}

func TestSealJSONLD_UsesBase58BTC(t *testing.T) {
	input := []byte(`{
		"@context": {
			"name": "http://schema.org/name"
		},
		"name": "Test"
	}`)

	cidStr, _, err := SealJSONLD(input)
	if err != nil {
		t.Fatalf("SealJSONLD failed: %v", err)
	}

	// Base58BTC encoding starts with 'z'
	if !strings.HasPrefix(cidStr, "z") {
		t.Errorf("Expected CID to start with 'z' (base58btc), got: %s", cidStr)
	}

	// For DagJSON codec with CIDv1, the prefix should be 'z4E'
	if len(cidStr) < 4 {
		t.Errorf("CID is too short: %s", cidStr)
	} else if !strings.HasPrefix(cidStr, "z4E") {
		t.Errorf("Expected CID to start with 'z4E' for DagJSON+base58btc, got: %s", cidStr[:4])
	}
}

func TestSealJSONLD_Deterministic(t *testing.T) {
	input := []byte(`{
		"@context": {
			"name": "http://schema.org/name",
			"description": "http://schema.org/description"
		},
		"description": "A test",
		"name": "Test"
	}`)

	cid1, canonical1, err := SealJSONLD(input)
	if err != nil {
		t.Fatalf("First SealJSONLD failed: %v", err)
	}

	cid2, canonical2, err := SealJSONLD(input)
	if err != nil {
		t.Fatalf("Second SealJSONLD failed: %v", err)
	}

	// Same input should produce same CID
	if cid1 != cid2 {
		t.Errorf("Expected deterministic CID, got different results: %s vs %s", cid1, cid2)
	}

	// Same input should produce same canonical form
	if string(canonical1) != string(canonical2) {
		t.Errorf("Expected deterministic canonical form")
	}
}

func TestSealJSONLD_ProducesCanonicalNQuads(t *testing.T) {
	input := []byte(`{
		"@context": {
			"name": "http://schema.org/name"
		},
		"name": "Test"
	}`)

	_, canonical, err := SealJSONLD(input)
	if err != nil {
		t.Fatalf("SealJSONLD failed: %v", err)
	}

	// Canonical output should be N-Quads format
	canonicalStr := string(canonical)

	// Should contain RDF triples
	if !strings.Contains(canonicalStr, "http://schema.org/name") {
		t.Errorf("Expected canonical form to contain the schema.org/name URI")
	}

	// Should end with a period and newline (N-Quads format)
	if !strings.HasSuffix(strings.TrimSpace(canonicalStr), ".") {
		t.Errorf("Expected N-Quads to end with a period")
	}
}

func TestSealJSONLD_DeterministicWithRemoteContext(t *testing.T) {
	// This tests the HTML default value which uses a remote context URL
	input := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [],
		"places": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {}
	}`)

	// Seal the same input multiple times
	cid1, canonical1, err := SealJSONLD(input)
	if err != nil {
		t.Fatalf("First SealJSONLD failed: %v", err)
	}

	cid2, canonical2, err := SealJSONLD(input)
	if err != nil {
		t.Fatalf("Second SealJSONLD failed: %v", err)
	}

	cid3, canonical3, err := SealJSONLD(input)
	if err != nil {
		t.Fatalf("Third SealJSONLD failed: %v", err)
	}

	// All CIDs should be identical
	if cid1 != cid2 || cid2 != cid3 {
		t.Errorf("Expected deterministic CID with remote context, got different results: %s, %s, %s", cid1, cid2, cid3)
	}

	// All canonical forms should be identical
	if string(canonical1) != string(canonical2) || string(canonical2) != string(canonical3) {
		t.Errorf("Expected deterministic canonical form with remote context")
	}

	// Verify the CID has the expected format
	if !strings.HasPrefix(cid1, "z4E") {
		t.Errorf("Expected CID to start with 'z4E', got: %s", cid1[:4])
	}
}
