package seal

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestParityGolden asserts that SealJSONLD reproduces every CID in the shared
// golden manifest. The same fixtures and golden values are checked from the JS
// side by parity/parity_check.mjs, so a green run on both languages proves the
// Go and JS CID pipelines agree byte-for-byte. See `make test-parity`.
func TestParityGolden(t *testing.T) {
	root := filepath.Join("..", "..", "parity")

	goldenRaw, err := os.ReadFile(filepath.Join(root, "golden.json"))
	if err != nil {
		t.Fatalf("read golden.json: %v", err)
	}
	var golden map[string]string
	if err := json.Unmarshal(goldenRaw, &golden); err != nil {
		t.Fatalf("parse golden.json: %v", err)
	}

	checked := 0
	for name, want := range golden {
		if name == "_comment" {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(root, "fixtures", name))
		if err != nil {
			t.Errorf("%s: read fixture: %v", name, err)
			continue
		}
		got, _, err := SealJSONLD(raw)
		if err != nil {
			t.Errorf("%s: SealJSONLD: %v", name, err)
			continue
		}
		if got != want {
			t.Errorf("%s: CID mismatch\n  want %s\n  got  %s", name, want, got)
			continue
		}
		checked++
	}
	if checked == 0 {
		t.Fatal("no fixtures checked — golden.json empty or fixtures missing")
	}
	t.Logf("parity OK: %d fixtures match golden CIDs", checked)
}

// TestSealIgnoresTopLevelID guards the idempotency contract: a net's @id is
// self-referential, so adding/removing/changing the top-level @id must not
// change the CID. (public/seal-cid.js strips @id identically.)
func TestSealIgnoresTopLevelID(t *testing.T) {
	base := `{"@context":"https://pflow.xyz/schema","@type":"PetriNet",` +
		`"places":[{"@type":"Place","label":"p0","initial":[1],"capacity":[0],"x":10,"y":20}]}`

	want, _, err := SealJSONLD([]byte(base))
	if err != nil {
		t.Fatalf("seal base: %v", err)
	}
	for _, id := range []string{`"anything"`, `"z4EBdeadbeef"`, `""`} {
		withID := `{"@id":` + id + `,` + base[1:]
		got, _, err := SealJSONLD([]byte(withID))
		if err != nil {
			t.Fatalf("seal with @id=%s: %v", id, err)
		}
		if got != want {
			t.Errorf("@id=%s changed CID: want %s got %s", id, want, got)
		}
	}
}

// TestParentsLineageContract locks the `parents` semantics (mirrors
// beats-bitwrap-io): parent CIDs are part of the content hash, and because
// `parents` is declared @container:@list, their order is significant.
func TestParentsLineageContract(t *testing.T) {
	body := func(parents string) []byte {
		return []byte(`{"@context":"https://pflow.xyz/schema","@type":"PetriNet",` +
			`"places":[{"@type":"Place","label":"p0","initial":[1],"capacity":[0],"x":0,"y":0}]` +
			parents + `}`)
	}
	none, _, err := SealJSONLD(body(``))
	if err != nil {
		t.Fatalf("seal none: %v", err)
	}
	fwd, _, err := SealJSONLD(body(`,"parents":["zA","zB"]`))
	if err != nil {
		t.Fatalf("seal fwd: %v", err)
	}
	rev, _, err := SealJSONLD(body(`,"parents":["zB","zA"]`))
	if err != nil {
		t.Fatalf("seal rev: %v", err)
	}

	if fwd == none {
		t.Error("parents must change the CID (lineage is part of content identity)")
	}
	if fwd == rev {
		t.Error("parents order must change the CID (@container:@list ⇒ ordered)")
	}
}
