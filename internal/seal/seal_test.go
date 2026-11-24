package seal

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ipfs/go-cid"
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

// Regression (sealing contract version 2): JSON-LD drops a null inside a
// @list, so under version 1 capacity [null,3] (colour 0 unbounded, colour 1
// capped at 3) and capacity [3] (colour 0 capped) sealed to one CID.
func TestSealNullBeforeValueInList(t *testing.T) {
	net := func(capacity string) []byte {
		return []byte(`{"@context":"https://pflow.xyz/schema","@type":"PetriNet",
			"token":["https://pflow.xyz/tokens/red","https://pflow.xyz/tokens/blue"],
			"places":{"p":{"@type":"Place","initial":[0,0],"capacity":` + capacity + `,"x":0,"y":0}},
			"transitions":{},"arcs":[]}`)
	}
	cid := func(capacity string) string {
		c, _, err := SealJSONLD(net(capacity))
		if err != nil {
			t.Fatalf("%s: %v", capacity, err)
		}
		return c
	}
	if cid("[null,3]") == cid("[3]") {
		t.Errorf("capacity [null,3] and [3] share a CID")
	}
	if cid("[null,null,3]") == cid("[null,3]") {
		t.Errorf("capacity [null,null,3] and [null,3] share a CID")
	}
	// A trailing null reads as an absent entry, so these stay one net, one CID,
	// and so does [null], the editor's unbounded place.
	if cid("[3,null]") != cid("[3]") {
		t.Errorf("capacity [3,null] and [3] differ")
	}
	if cid("[null]") != cid("[]") {
		t.Errorf("capacity [null] and [] differ")
	}
	// Version 1 is kept to check old CIDs, and reproduces the collision.
	v1, _, err := SealJSONLDV1(net("[null,3]"))
	if err != nil {
		t.Fatal(err)
	}
	if v1 != cid("[3]") {
		t.Errorf("SealJSONLDV1([null,3]) = %s, want the version 1 CID %s", v1, cid("[3]"))
	}
	if !ChangedByV2(net("[null,3]")) || ChangedByV2(net("[3,null]")) || ChangedByV2(net("[null]")) {
		t.Errorf("ChangedByV2 should hold only for a null before a value")
	}
	// Only pflow documents: another context's arrays are not touched.
	other := []byte(`{"@context":{"@vocab":"https://example.org/"},"capacity":[null,3]}`)
	a, _, _ := SealJSONLD(other)
	b, _, _ := SealJSONLDV1(other)
	if a != b || ChangedByV2(other) {
		t.Errorf("a non-pflow document changed CID under version 2")
	}
}

// Version 2 changes the CID only of a document with a null before a value in
// a list term. This holds every checked-in document to the list of those
// (only the fixture made for it), so a new one cannot slip in unnoticed.
func TestSealV2ChangesNoOtherCheckedInDocument(t *testing.T) {
	want := map[string]bool{filepath.Join("parity", "fixtures", "null-before-value.jsonld"): true}
	root := filepath.Join("..", "..")
	for _, dir := range []string{"examples", "parity", "public"} {
		if _, err := os.Stat(filepath.Join(root, dir)); err != nil {
			t.Logf("%s: not here (a Bazel sandbox holds only //parity:golden); skipped", dir)
			continue
		}
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !(strings.HasSuffix(path, ".json") || strings.HasSuffix(path, ".jsonld")) {
				return err
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(root, path)
			if ChangedByV2(raw) != want[rel] {
				t.Errorf("%s: ChangedByV2 = %v, want %v", rel, !want[rel], want[rel])
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}
