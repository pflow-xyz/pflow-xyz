// SPDX-License-Identifier: MIT

package notation

import (
	"encoding/json"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the generated example files (.jsonld, cids.json, the two real nets' .pnet)")

const examplesDir = "../../docs/notation/examples"

// the two real pflow.xyz nets: their JSON-LD is a fixture in parity/ whose CID is a
// golden of the sealing contract (parity/golden.json). The notation text is what
// Print writes for them, and a test holds the text to the golden CID.
var realNets = map[string]string{ // example name -> parity fixture
	"coffee-shop": "with-rates",
	"knapsack":    "knapsack",
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func goldenCIDs(t *testing.T) map[string]string {
	var g map[string]string
	if err := json.Unmarshal(readFile(t, "../../parity/golden.json"), &g); err != nil {
		t.Fatal(err)
	}
	return g
}

// TestExamples holds every example to the contract: the text compiles to the
// JSON-LD beside it, byte for byte, and both seal to the CID cids.json records;
// the JSON-LD prints to text that compiles to that CID again.
func TestExamples(t *testing.T) {
	golden := goldenCIDs(t)
	if *update {
		for name, fx := range realNets {
			v, err := ParseJSON(readFile(t, "../../parity/fixtures/"+fx+".jsonld"))
			if err != nil {
				t.Fatal(err)
			}
			text, lossy, err := Print(v)
			if err != nil || len(lossy) > 0 {
				t.Fatalf("%s: %v %v", name, err, lossy)
			}
			if err := os.WriteFile(filepath.Join(examplesDir, name+".pnet"), []byte(text), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	files, _ := filepath.Glob(filepath.Join(examplesDir, "*.pnet"))
	sort.Strings(files)
	cids := map[string]string{}
	var compiled []string
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".pnet")
		if name == "pipeline" {
			continue // a composition: the core prototype does not compile `compose` (see composition_test.go)
		}
		src := string(readFile(t, f))
		doc, ds := CompileText(src)
		for _, d := range ds {
			if d.IsError() {
				t.Fatalf("%s: %s", name, d.Render(src))
			}
		}
		if len(ds) != 0 {
			t.Errorf("%s: examples carry no warnings, got %d: %s", name, len(ds), ds[0].Render(src))
		}
		cid, err := CID(doc)
		if err != nil {
			t.Fatal(err)
		}
		cids[name] = cid
		compiled = append(compiled, name)
		jsonPath := filepath.Join(examplesDir, name+".jsonld")
		if *update {
			if err := os.WriteFile(jsonPath, MarshalJSON(doc), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if got := string(readFile(t, jsonPath)); got != string(MarshalJSON(doc)) {
			t.Errorf("%s: the .jsonld is not what the .pnet compiles to (run: go test ./internal/notation -run Examples -update)", name)
		}
		// the JSON-LD sealed on its own is the same CID: the text is not part of identity
		v, err := ParseJSON(readFile(t, jsonPath))
		if err != nil {
			t.Fatal(err)
		}
		if c2, _ := CID(v); c2 != cid {
			t.Errorf("%s: JSON-LD seals to %s, text to %s", name, c2, cid)
		}
		// JSON-LD -> text -> JSON-LD
		text, lossy, err := Print(v)
		if err != nil || len(lossy) > 0 {
			t.Errorf("%s: print: %v %v", name, err, lossy)
		}
		doc2, ds2 := CompileText(text)
		if doc2 == nil {
			t.Fatalf("%s: printed text does not compile: %v", name, ds2)
		}
		if c3, _ := CID(doc2); c3 != cid {
			t.Errorf("%s: print then compile seals to %s, want %s", name, c3, cid)
		}
		if string(MarshalJSON(doc2)) != string(MarshalJSON(doc)) {
			t.Errorf("%s: print then compile is not the same JSON-LD", name)
		}
		// printing is a fixed point
		if v3, _ := ParseJSON(MarshalJSON(doc2)); true {
			if text3, _, _ := Print(v3); text3 != text {
				t.Errorf("%s: canonical text is not a fixed point", name)
			}
		}
		// the real nets are checked against the sealing contract's golden CIDs
		if fx, real := realNets[name]; real {
			want := golden[fx+".jsonld"]
			if cid != want {
				t.Errorf("%s: seals to %s, the golden for parity/fixtures/%s.jsonld is %s", name, cid, fx, want)
			}
			if got := string(readFile(t, f)); got != text {
				t.Errorf("%s: the checked-in text is not the canonical print of the fixture", name)
			}
		}
	}
	if *update {
		merged := map[string]string{}
		_ = json.Unmarshal(readFile(t, filepath.Join(examplesDir, "cids.json")), &merged) // keeps the composition's entry
		for k, v := range cids {
			merged[k] = v
		}
		b, _ := json.MarshalIndent(merged, "", "  ")
		if err := os.WriteFile(filepath.Join(examplesDir, "cids.json"), append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var want map[string]string
	if err := json.Unmarshal(readFile(t, filepath.Join(examplesDir, "cids.json")), &want); err != nil {
		t.Fatal(err)
	}
	for _, name := range compiled {
		if want[name] != cids[name] {
			t.Errorf("%s: cids.json says %s, the example seals to %s", name, want[name], cids[name])
		}
	}
}

// The editor's own strict check (public/petri-validate.js, what Check net runs) finds nothing
// to say about any compiled example: no error, and no warning that a default was filled in.
func TestExamplesPassTheEditorsOwnCheck(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	files, _ := filepath.Glob(filepath.Join(examplesDir, "*.jsonld"))
	var nets []string
	for _, f := range files {
		if filepath.Base(f) != "pipeline.jsonld" { // a composition is not a net
			nets = append(nets, f)
		}
	}
	args := append([]string{"../../scripts/check-nets.mjs"}, nets...)
	out, err := exec.Command(node, args...).CombinedOutput()
	if err != nil {
		t.Fatalf("Check net: %v\n%s", err, out)
	}
	if strings.Count(string(out), "0 error(s), 0 warning(s)") != len(nets) {
		t.Errorf("Check net has something to say:\n%s", out)
	}
}
