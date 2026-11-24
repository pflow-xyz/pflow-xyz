// SPDX-License-Identifier: MIT

package notation

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

const docPath = "../../docs/pflow-notation.md"

// The design document quotes the grammar and every example. A quotation that can drift is
// a second copy, so this test holds each one to the file it quotes, and -update rewrites
// the quoted blocks (the prose around them, and the CIDs in it, are the author's: the test
// says which CID is wrong).

func between(doc, begin, end string) (from, to int, ok bool) {
	i := strings.Index(doc, begin)
	if i < 0 {
		return 0, 0, false
	}
	i += len(begin)
	j := strings.Index(doc[i:], end)
	if j < 0 {
		return 0, 0, false
	}
	return i, i + j, true
}

func lineCount(b []byte) int { return strings.Count(string(b), "\n") }

func exampleBlock(t *testing.T, name string) string {
	t.Helper()
	pnet := readFile(t, filepath.Join(examplesDir, name+".pnet"))
	js := readFile(t, filepath.Join(examplesDir, name+".jsonld"))
	open := ""
	if lineCount(js) <= 70 {
		open = " open"
	}
	return fmt.Sprintf("\n<table>\n<tr><th align=\"left\">notation: <code>%s.pnet</code></th><th align=\"left\">JSON-LD: <code>%s.jsonld</code></th></tr>\n<tr><td valign=\"top\">\n\n```pflow\n%s```\n\n</td><td valign=\"top\">\n\n<details%s><summary>%d lines</summary>\n\n```json\n%s```\n\n</details>\n\n</td></tr>\n</table>\n", name, name, pnet, open, lineCount(js), js)
}

func ebnfBlock(t *testing.T) string {
	t.Helper()
	src := string(readFile(t, "../../docs/notation/pflow.ebnf"))
	from := strings.Index(src, "(* ==")
	if from < 0 {
		t.Fatal("pflow.ebnf has no section")
	}
	return "\n```ebnf\n" + strings.TrimRight(src[from:], "\n") + "\n```\n"
}

func TestDocQuotesTheFilesItQuotes(t *testing.T) {
	doc := string(readFile(t, docPath))
	var cids map[string]string
	if err := json.Unmarshal(readFile(t, filepath.Join(examplesDir, "cids.json")), &cids); err != nil {
		t.Fatal(err)
	}
	var names []string
	for n := range cids {
		names = append(names, n)
	}
	sort.Strings(names)
	want := map[string]string{}
	for _, n := range names {
		want["example:"+n] = exampleBlock(t, n)
	}
	changed := false
	for _, n := range names {
		b, e := "<!-- example:"+n+" -->", "<!-- /example:"+n+" -->"
		from, to, ok := between(doc, b, e)
		if !ok {
			t.Errorf("the document has no %s ... %s block", b, e)
			continue
		}
		if doc[from:to] != want["example:"+n] {
			if *update {
				doc = doc[:from] + want["example:"+n] + doc[to:]
				changed = true
			} else {
				t.Errorf("the quoted example %s is not what the files say (go test ./internal/notation -update rewrites it)", n)
			}
		}
	}
	if from, to, ok := between(doc, "<!-- pflow.ebnf: generated from docs/notation/pflow.ebnf -->", "<!-- /pflow.ebnf -->"); !ok {
		t.Error("the document has no grammar block")
	} else if doc[from:to] != ebnfBlock(t) {
		if *update {
			doc = doc[:from] + ebnfBlock(t) + doc[to:]
			changed = true
		} else {
			t.Error("the quoted grammar is not pflow.ebnf (go test ./internal/notation -update rewrites it)")
		}
	}
	if changed {
		if err := os.WriteFile(docPath, []byte(doc), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// a CID in the prose that is no example's is stale
	known := map[string]bool{}
	for _, c := range cids {
		known[c] = true
	}
	for _, n := range []string{"coffee-shop", "knapsack"} {
		_ = n // the two real nets' CIDs are the goldens, which cids.json holds
	}
	cidRe := regexp.MustCompile(`z4EBG9[1-9A-HJ-NP-Za-km-z]{40,}`)
	for _, c := range cidRe.FindAllString(doc, -1) {
		if !known[c] {
			t.Errorf("the document mentions the CID %s, which no example seals to", c)
		}
	}
	for n, c := range cids {
		if !strings.Contains(doc, c) {
			t.Errorf("the document never says the CID of %s (%s)", n, c)
		}
	}
}

// Every ```pflow block in the document is a sentence of the grammar: what the document
// teaches is what the grammar allows.
func TestDocSnippetsAreSentences(t *testing.T) {
	g := loadGrammar(t)
	doc := string(readFile(t, docPath))
	re := regexp.MustCompile("(?s)```pflow\n(.*?)```")
	blocks := re.FindAllStringSubmatch(doc, -1)
	if len(blocks) < 10 {
		t.Fatalf("expected the document's snippets and examples, found %d blocks", len(blocks))
	}
	for i, m := range blocks {
		if !g.recognize(m[1]) {
			t.Errorf("block %d of the document is not a sentence of pflow.ebnf:\n%s", i+1, m[1])
		}
	}
}
