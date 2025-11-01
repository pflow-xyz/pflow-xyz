package seal

import (
	"encoding/json"
	"testing"
)

// TestSealJSONLD_ConsistentWithDifferentKeyOrder tests that JSON with different key ordering
// produces the same CID (since RDF normalization is order-independent)
func TestSealJSONLD_ConsistentWithDifferentKeyOrder(t *testing.T) {
	json1 := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [],
		"places": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {}
	}`)

	json2 := []byte(`{
		"transitions": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"places": {},
		"arcs": [],
		"@version": "1.1",
		"@type": "PetriNet",
		"@context": "https://pflow.xyz/schema"
	}`)

	cid1, _, err := SealJSONLD(json1)
	if err != nil {
		t.Fatalf("SealJSONLD failed for json1: %v", err)
	}

	cid2, _, err := SealJSONLD(json2)
	if err != nil {
		t.Fatalf("SealJSONLD failed for json2: %v", err)
	}

	if cid1 != cid2 {
		t.Errorf("Expected same CID for different key ordering, got %s vs %s", cid1, cid2)
	}
}

// TestSealJSONLD_ConsistentAfterReMarshaling tests that re-marshaling JSON
// through Go's json.Marshal doesn't change the CID
func TestSealJSONLD_ConsistentAfterReMarshaling(t *testing.T) {
	original := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [],
		"places": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {}
	}`)

	// Get CID from original
	cid1, _, err := SealJSONLD(original)
	if err != nil {
		t.Fatalf("SealJSONLD failed for original: %v", err)
	}

	// Simulate what the backend does: unmarshal then re-marshal
	var doc map[string]interface{}
	if err := json.Unmarshal(original, &doc); err != nil {
		t.Fatalf("Failed to unmarshal: %v", err)
	}

	remarshaled, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("Failed to marshal: %v", err)
	}

	// Get CID from remarshaled
	cid2, _, err := SealJSONLD(remarshaled)
	if err != nil {
		t.Fatalf("SealJSONLD failed for remarshaled: %v", err)
	}

	if cid1 != cid2 {
		t.Errorf("Expected same CID after re-marshaling, got %s vs %s", cid1, cid2)
	}
}

// TestSealJSONLD_MultipleReMarshalings tests that multiple re-marshalings
// produce consistent CIDs (checking for randomness in Go's map iteration)
func TestSealJSONLD_MultipleReMarshalings(t *testing.T) {
	original := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [],
		"places": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {}
	}`)

	// Run multiple times to check for any randomness
	cids := make(map[string]bool)
	for i := 0; i < 10; i++ {
		var doc map[string]interface{}
		if err := json.Unmarshal(original, &doc); err != nil {
			t.Fatalf("Failed to unmarshal: %v", err)
		}

		remarshaled, err := json.Marshal(doc)
		if err != nil {
			t.Fatalf("Failed to marshal: %v", err)
		}

		cid, _, err := SealJSONLD(remarshaled)
		if err != nil {
			t.Fatalf("SealJSONLD failed: %v", err)
		}
		cids[cid] = true
	}

	if len(cids) != 1 {
		t.Errorf("Expected exactly 1 unique CID from 10 runs, got %d unique CIDs", len(cids))
		for cid := range cids {
			t.Logf("  CID: %s", cid)
		}
	}
}
