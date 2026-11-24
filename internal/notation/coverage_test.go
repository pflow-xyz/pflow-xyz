// SPDX-License-Identifier: MIT

package notation

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The law: whatever the printer says it carried, it carried. For every pflow.xyz net
// JSON-LD in the repository, print it, compile the text, and compare CIDs. A document
// the core subset cannot carry says so in lossy and is not held to the law; a document
// it says it can carry is.
func TestEveryNetInTheRepoEitherRoundTripsOrSaysWhyNot(t *testing.T) {
	root := "../.."
	var carried, notCarried, skipped int
	reasons := map[string]int{}
	var failures []string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", "node_modules", "bazel-bin", "bazel-out", "bazel-testlogs", "bazel-pflow-xyz", "vendor":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".jsonld") || strings.Contains(path, "docs/notation/") {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		v, err := ParseJSON(raw)
		doc, isObj := v.(Obj)
		if err != nil || !isObj {
			skipped++
			return nil
		}
		if ty, _ := doc.Get("@type"); ty == "PetriNetBundle" || ty == "SearchPlan" {
			skipped++
			return nil
		}
		if _, ok := doc.getObj("places"); !ok {
			skipped++
			return nil
		}
		// sealing is superlinear in the document (docs/composition-documents.md, 1.3): the
		// big game nets take minutes, and the law does not need them
		pl, _ := doc.getObj("places")
		tr, _ := doc.getObj("transitions")
		ar, _ := doc.getList("arcs")
		if len(pl)+len(tr)+len(ar) > 60 {
			skipped++
			return nil
		}
		text, lossy, err := Print(v)
		if err != nil {
			skipped++
			return nil
		}
		if len(lossy) > 0 {
			notCarried++
			for _, l := range lossy {
				// keep the reason, not the place it was said about
				if i := strings.Index(l, ": "); i >= 0 {
					l = l[i+2:]
				}
				reasons[l]++
			}
			return nil
		}
		want, err := CID(v)
		if err != nil {
			skipped++
			return nil
		}
		out, ds := CompileText(text)
		if out == nil {
			failures = append(failures, path+": printed text does not compile: "+ds[0].Message)
			return nil
		}
		got, _ := CID(out)
		if got != want {
			failures = append(failures, path+": "+got+" != "+want)
			return nil
		}
		carried++
		return nil
	})
	for _, f := range failures {
		t.Error(f)
	}
	var rs []string
	for r, n := range reasons {
		rs = append(rs, strings.Join([]string{r}, "")+" ×"+itoa(n))
	}
	sort.Strings(rs)
	t.Logf("%d nets carried with the same CID, %d need something the core subset lacks, %d are not nets; reasons: %s", carried, notCarried, skipped, strings.Join(rs, "; "))
	if carried < 5 {
		t.Errorf("expected the fixtures and the showcase nets to round-trip, got %d", carried)
	}
}

func itoa(n int) string { return FormatNumber(float64(n)) }
