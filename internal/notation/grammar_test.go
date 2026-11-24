// SPDX-License-Identifier: MIT

package notation

// The drift test: docs/notation/pflow.ebnf is the grammar, and it is held to the
// parser both ways, as BeatScript's crates/djlive/tests/grammar.rs holds its grammar.
//
//	one way:   every example is a sentence of the grammar (the recognizer below reads
//	           the lexer's tokens against the productions);
//	the other: every sentence the grammar writes for the core statements is a program
//	           the parser reads (the generator walks the productions with a seeded rng).
//
// The EBNF reader here is a Go port of the ISO 14977 subset BeatScript's
// crates/djlive/src/grammar/ebnf.rs reads, and the recognizer a port of its
// recognize.rs (a set of end positions per node and place, memoised). They are test
// code on purpose: the design (docs/pflow-notation.md, "Tooling reuse") puts the one
// copy in a shared crate, and this port is the proof that the notation reads with it.

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type gnode struct {
	kind string // seq choice opt rep term ref
	kids []*gnode
	text string
}

type grule struct {
	name string
	node *gnode
	line int
	note string
}

type grammar struct {
	rules  []*grule
	byName map[string]*grule
}

type gtok struct {
	kind string // ident str sym comment
	text string
	line int
}

func lexEBNF(src string) ([]gtok, error) {
	var out []gtok
	i, line := 0, 1
	for i < len(src) {
		c := src[i]
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case strings.HasPrefix(src[i:], "(*"):
			j := strings.Index(src[i:], "*)")
			if j < 0 {
				return nil, fmt.Errorf("line %d: a comment is never closed", line)
			}
			text := src[i+2 : i+j]
			out = append(out, gtok{"comment", text, line})
			line += strings.Count(text, "\n")
			i += j + 2
		case c == '"' || c == '\'':
			j := strings.IndexByte(src[i+1:], c)
			if j < 0 {
				return nil, fmt.Errorf("line %d: a terminal is never closed", line)
			}
			out = append(out, gtok{"str", src[i+1 : i+1+j], line})
			i += j + 2
		case c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'):
			j := i
			for j < len(src) && (src[j] == '_' || (src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9')) {
				j++
			}
			out = append(out, gtok{"ident", src[i:j], line})
			i = j
		case strings.ContainsRune("=|;[]{}()", rune(c)):
			out = append(out, gtok{"sym", string(c), line})
			i++
		default:
			return nil, fmt.Errorf("line %d: `%c` is not EBNF here", line, c)
		}
	}
	return out, nil
}

type gparser struct {
	toks []gtok
	at   int
}

func (p *gparser) skip() {
	for p.at < len(p.toks) && p.toks[p.at].kind == "comment" {
		p.at++
	}
}
func (p *gparser) peek() *gtok {
	p.skip()
	if p.at < len(p.toks) {
		return &p.toks[p.at]
	}
	return nil
}
func (p *gparser) isSym(s string) bool {
	t := p.peek()
	return t != nil && t.kind == "sym" && t.text == s
}

func (p *gparser) alt() (*gnode, error) {
	first, err := p.seq()
	if err != nil {
		return nil, err
	}
	alts := []*gnode{first}
	for p.isSym("|") {
		p.at++
		n, err := p.seq()
		if err != nil {
			return nil, err
		}
		alts = append(alts, n)
	}
	if len(alts) == 1 {
		return first, nil
	}
	return &gnode{kind: "choice", kids: alts}, nil
}

func (p *gparser) seq() (*gnode, error) {
	var items []*gnode
	for {
		t := p.peek()
		if t == nil {
			break
		}
		var n *gnode
		switch {
		case t.kind == "str":
			p.at++
			n = &gnode{kind: "term", text: t.text}
		case t.kind == "ident":
			if p.at+1 < len(p.toks) && p.toks[p.at+1].kind == "sym" && p.toks[p.at+1].text == "=" {
				return nil, fmt.Errorf("line %d: `%s =` starts a production: the one before it has no `;`", t.line, t.text)
			}
			p.at++
			n = &gnode{kind: "ref", text: t.text}
		case t.kind == "sym" && (t.text == "[" || t.text == "{" || t.text == "("):
			open := t.text
			p.at++
			inner, err := p.alt()
			if err != nil {
				return nil, err
			}
			closeSym := map[string]string{"[": "]", "{": "}", "(": ")"}[open]
			if !p.isSym(closeSym) {
				return nil, fmt.Errorf("line %d: expected `%s`", t.line, closeSym)
			}
			p.at++
			switch open {
			case "[":
				n = &gnode{kind: "opt", kids: []*gnode{inner}}
			case "{":
				n = &gnode{kind: "rep", kids: []*gnode{inner}}
			default:
				n = inner
			}
		}
		if n == nil {
			break
		}
		items = append(items, n)
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("an empty alternative")
	}
	if len(items) == 1 {
		return items[0], nil
	}
	return &gnode{kind: "seq", kids: items}, nil
}

func readEBNF(src string) (*grammar, error) {
	toks, err := lexEBNF(src)
	if err != nil {
		return nil, err
	}
	g := &grammar{byName: map[string]*grule{}}
	p := &gparser{toks: toks}
	for {
		t := p.peek()
		if t == nil {
			break
		}
		if t.kind != "ident" {
			return nil, fmt.Errorf("line %d: expected a production's name, found %q", t.line, t.text)
		}
		name, line := t.text, t.line
		p.at++
		if !p.isSym("=") {
			return nil, fmt.Errorf("line %d: expected `=` after `%s`", line, name)
		}
		p.at++
		n, err := p.alt()
		if err != nil {
			return nil, err
		}
		if !p.isSym(";") {
			return nil, fmt.Errorf("line %d: `%s` has no `;`", line, name)
		}
		p.at++
		r := &grule{name: name, node: n, line: line}
		if _, dup := g.byName[name]; dup {
			return nil, fmt.Errorf("line %d: `%s` is defined twice", line, name)
		}
		g.byName[name] = r
		g.rules = append(g.rules, r)
	}
	return g, nil
}

func isClassName(s string) bool {
	if s == "" || !(s[0] >= 'A' && s[0] <= 'Z') {
		return false
	}
	for _, c := range s {
		if !(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9') && c != '_' {
			return false
		}
	}
	return true
}

func (n *gnode) refs(out map[string]bool) {
	if n.kind == "ref" {
		out[n.text] = true
	}
	for _, k := range n.kids {
		k.refs(out)
	}
}

// problems: a name used and never defined, one nothing uses (but the first).
func (g *grammar) problems() []string {
	var out []string
	used := map[string]bool{}
	for _, r := range g.rules {
		refs := map[string]bool{}
		r.node.refs(refs)
		for n := range refs {
			if g.byName[n] == nil && !isClassName(n) {
				out = append(out, fmt.Sprintf("line %d: `%s` uses `%s`, which is not defined", r.line, r.name, n))
			}
			used[n] = true
		}
	}
	for i, r := range g.rules {
		if i > 0 && !used[r.name] {
			out = append(out, fmt.Sprintf("line %d: nothing uses `%s`", r.line, r.name))
		}
	}
	sort.Strings(out)
	return out
}

func (g *grammar) classes() []string {
	set := map[string]bool{}
	for _, r := range g.rules {
		refs := map[string]bool{}
		r.node.refs(refs)
		for n := range refs {
			if g.byName[n] == nil && isClassName(n) {
				set[n] = true
			}
		}
	}
	var out []string
	for c := range set {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

func loadGrammar(t *testing.T) *grammar {
	t.Helper()
	b, err := os.ReadFile("../../docs/notation/pflow.ebnf")
	if err != nil {
		t.Fatal(err)
	}
	g, err := readEBNF(string(b))
	if err != nil {
		t.Fatal(err)
	}
	return g
}

// --- the recognizer: the lexer's tokens against the productions ---

func classMatches(class string, tok Token) bool {
	switch class {
	case "NEWLINE":
		return tok.Kind == TNewline
	case "NAME", "KIND":
		return tok.Kind == TWord && !IsReserved(tok.Text)
	case "INT":
		if tok.Kind != TNumber {
			return false
		}
		for _, c := range tok.Text {
			if c < '0' || c > '9' {
				return false
			}
		}
		return true
	case "NUMBER":
		return tok.Kind == TNumber
	case "STRING":
		return tok.Kind == TString
	case "URI":
		return tok.Kind == TURI
	case "CID":
		return tok.Kind == TWord && looksLikeCID(tok.Text)
	}
	return false
}

type recognizer struct {
	g    *grammar
	toks []Token
	memo map[string][]int
}

func (r *recognizer) ends(n *gnode, at int) []int {
	switch n.kind {
	case "term":
		if at < len(r.toks) && (r.toks[at].Kind == TWord || r.toks[at].Kind == TSym) && r.toks[at].Text == n.text {
			return []int{at + 1}
		}
		return nil
	case "ref":
		if rule := r.g.byName[n.text]; rule != nil {
			key := fmt.Sprintf("%s@%d", n.text, at)
			if v, ok := r.memo[key]; ok {
				return v
			}
			r.memo[key] = nil // a left-recursive production matches nothing while it is being read
			v := r.ends(rule.node, at)
			r.memo[key] = v
			return v
		}
		if n.text == "JSON" { // the rest of the line: one or more tokens
			var out []int
			for j := at; j < len(r.toks) && r.toks[j].Kind != TNewline; j++ {
				out = append(out, j+1)
			}
			return out
		}
		if at < len(r.toks) && classMatches(n.text, r.toks[at]) {
			return []int{at + 1}
		}
		return nil
	case "seq":
		cur := []int{at}
		for _, k := range n.kids {
			next := map[int]bool{}
			for _, p := range cur {
				for _, e := range r.ends(k, p) {
					next[e] = true
				}
			}
			cur = keys(next)
			if len(cur) == 0 {
				return nil
			}
		}
		return cur
	case "choice":
		set := map[int]bool{}
		for _, k := range n.kids {
			for _, e := range r.ends(k, at) {
				set[e] = true
			}
		}
		return keys(set)
	case "opt":
		set := map[int]bool{at: true}
		for _, e := range r.ends(n.kids[0], at) {
			set[e] = true
		}
		return keys(set)
	case "rep":
		set := map[int]bool{at: true}
		frontier := []int{at}
		for len(frontier) > 0 {
			var nf []int
			for _, p := range frontier {
				for _, e := range r.ends(n.kids[0], p) {
					if !set[e] {
						set[e] = true
						nf = append(nf, e)
					}
				}
			}
			frontier = nf
		}
		return keys(set)
	}
	return nil
}

func keys(m map[int]bool) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}

// recognize reports whether the program is a sentence of the grammar's first production.
func (g *grammar) recognize(src string) bool {
	toks := Lex(src)
	toks = toks[:len(toks)-1] // the EOF
	r := &recognizer{g: g, toks: toks, memo: map[string][]int{}}
	for _, e := range r.ends(g.rules[0].node, 0) {
		if e == len(toks) {
			return true
		}
	}
	return false
}

// --- the generator: a seeded walk of the productions ---

func (g *grammar) sample(class string, rng *rand.Rand) string {
	pick := func(xs ...string) string { return xs[rng.Intn(len(xs))] }
	switch class {
	case "NEWLINE":
		return "\n"
	case "NAME", "KIND":
		return pick("slots", "items", "work", "p_1", "Brew")
	case "INT":
		return "1" // the only version the pragma names
	case "NUMBER":
		return pick("1", "2", "0.5", "10")
	case "STRING":
		return pick(`"a label"`, `"x"`, `"Brew Coffee"`)
	case "URI":
		return "<https://pflow.xyz/tokens/red>"
	case "CID":
		return "z4EBG9j24VWJqPNmR2KxNBT5zT9vruLbJT39E7fKuhJAUe5vkwa"
	case "JSON":
		return `{"a":1}`
	}
	return "?"
}

func (g *grammar) walk(n *gnode, depth int, rng *rand.Rand, out *[]string) {
	switch n.kind {
	case "term":
		*out = append(*out, n.text)
	case "ref":
		if rule := g.byName[n.text]; rule != nil {
			g.walk(rule.node, depth+1, rng, out)
		} else {
			*out = append(*out, g.sample(n.text, rng))
		}
	case "seq":
		for _, k := range n.kids {
			g.walk(k, depth+1, rng, out)
		}
	case "choice":
		g.walk(n.kids[rng.Intn(len(n.kids))], depth+1, rng, out)
	case "opt":
		if depth < 12 && rng.Intn(2) == 0 {
			g.walk(n.kids[0], depth+1, rng, out)
		}
	case "rep":
		for i, c := 0, 0; depth < 12 && i < 2; i++ {
			if rng.Intn(2) == 0 {
				c++
				g.walk(n.kids[0], depth+1, rng, out)
			}
		}
	}
}

func TestGrammarIsWellFormed(t *testing.T) {
	g := loadGrammar(t)
	if p := g.problems(); len(p) != 0 {
		t.Fatalf("pflow.ebnf: %s", strings.Join(p, "\n"))
	}
	want := []string{"CID", "INT", "JSON", "KIND", "NAME", "NEWLINE", "NUMBER", "STRING", "URI"}
	got := g.classes()
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("token classes: got %v want %v (update the header of pflow.ebnf and lex.go together)", got, want)
	}
}

// Every example, the composition one included, is a sentence of the grammar.
func TestExamplesAreSentences(t *testing.T) {
	g := loadGrammar(t)
	files, _ := filepath.Glob(filepath.Join(examplesDir, "*.pnet"))
	if len(files) < 6 {
		t.Fatalf("expected the six examples, found %d", len(files))
	}
	for _, f := range files {
		src := string(readFile(t, f))
		if !g.recognize(src) {
			t.Errorf("%s is not a sentence of pflow.ebnf", filepath.Base(f))
		}
	}
}

func TestRecognizerRejects(t *testing.T) {
	g := loadGrammar(t)
	for _, bad := range []string{
		"place\n",             // no name
		"place p cap\n",       // cap with nothing
		"a -> \n",             // an arc with one end
		"place p = [1,\n",     // an unclosed list
		"transition t rate\n", // rate with nothing
		"place p @ 1\n",       // a position wants two numbers
		"link a.b ~ c.d\n",    // a link wants its kind
		"#! pflow\n",          // the pragma wants its version
		"net 12\n",            // a net's name is a string
		"a -> b -> \n",        // a chain that stops
		"place p = 1 red 2\n", // junk after a term
	} {
		if g.recognize(bad) {
			t.Errorf("recognised, and should not be: %q", bad)
		}
	}
}

// The other direction: what the grammar writes for the core statements, the parser reads.
func TestGrammarSentencesParse(t *testing.T) {
	g := loadGrammar(t)
	core := []string{"pragma", "net", "about", "color", "parents", "place", "transition", "arcs"}
	rng := rand.New(rand.NewSource(7))
	n := 0
	for _, name := range core {
		for i := 0; i < 300; i++ {
			var toks []string
			g.walk(g.byName[name].node, 0, rng, &toks)
			src := strings.Join(toks, " ") + "\n"
			if !g.recognize(src) { // the walk and the recognizer must agree before the parser is asked
				t.Fatalf("%s: the grammar wrote %q and does not recognise it", name, src)
			}
			_, ds := Parse(src)
			for _, d := range ds {
				if d.IsError() {
					t.Fatalf("%s: the grammar wrote %q, the parser says:\n%s", name, src, d.Render(src))
				}
			}
			n++
		}
	}
	t.Logf("%d sentences written by the grammar, all read by the parser", n)
}
