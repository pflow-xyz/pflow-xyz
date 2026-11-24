// SPDX-License-Identifier: MIT

package notation

import (
	"strings"
	"testing"
)

func diagsOf(src string) []Diagnostic {
	f, ds := Parse(src)
	return append(ds, f.Check()...)
}

// at finds the diagnostic whose message contains frag and returns its line and column.
func at(t *testing.T, src, frag string) (Diagnostic, int, int) {
	t.Helper()
	for _, d := range diagsOf(src) {
		if strings.Contains(d.Message, frag) {
			l, c, _ := d.Position(src)
			return d, l, c
		}
	}
	t.Fatalf("no diagnostic containing %q in %v", frag, diagsOf(src))
	return Diagnostic{}, 0, 0
}

func TestSyntaxErrorsCarryLineColAndWhatWasExpected(t *testing.T) {
	src := "#! pflow 1\nnet\nplace p = 3 cap\ntransition t ratee 1\nplace q label\n"
	ds, _ := Parse(src)
	_ = ds
	_, pds := Parse(src)
	// three bad lines, three errors: a line that does not parse costs the lines after it nothing
	if len(pds) != 3 {
		t.Fatalf("want 3 syntax errors, got %d: %v", len(pds), pds)
	}
	wants := []struct{ line, col int }{{3, 16}, {4, 14}, {5, 14}}
	for i, w := range wants {
		l, c, _ := pds[i].Position(src)
		if l != w.line || c != w.col {
			t.Errorf("error %d at %d:%d, want %d:%d (%s)", i, l, c, w.line, w.col, pds[i].Message)
		}
	}
	if got := pds[1].Expected; len(got) == 0 || got[0] != "rate" {
		t.Errorf("a transition line should say what it expects: %v", got)
	}
	if pds[1].Found != "ratee" {
		t.Errorf("found: %q", pds[1].Found)
	}
}

func TestOneBadLineDoesNotHideTheRest(t *testing.T) {
	src := "net\nplace a\nplace b = = 2\nplace c\ntransition t\na -> t -> c\n"
	f, ds := Parse(src)
	if len(ds) != 1 {
		t.Fatalf("want one error, got %v", ds)
	}
	if len(f.Places) != 2 || len(f.Transitions) != 1 || len(f.Arcs) != 2 {
		t.Errorf("the lines around the bad one were not read: %d places, %d transitions, %d arcs", len(f.Places), len(f.Transitions), len(f.Arcs))
	}
}

func TestReservedWordsAndQuotedNames(t *testing.T) {
	d, l, _ := at(t, "net\nplace cap\n", "reserved word")
	if l != 2 || len(d.Expected) != 2 || !strings.Contains(d.Expected[1], `"cap"`) {
		t.Errorf("a reserved word should offer the quoted name: %v", d)
	}
	// quoted, it is a name; `in` and `out` are not reserved
	src := "net\nplace \"cap\"\nplace in\nplace out\ntransition work\nin -> work -> out\n\"cap\" -> work\n"
	for _, d := range diagsOf(src) {
		if d.IsError() {
			t.Errorf("unexpected: %s", d.Render(src))
		}
	}
}

func TestCheckTier(t *testing.T) {
	cases := []struct {
		name, src, frag string
		line            int
		sev             Severity
	}{
		{"initial over capacity", "net\nplace p = 5 cap 3\ntransition t\np -> t\n", "starts with 5 but holds at most 3", 2, Error},
		{"unknown colour, did you mean", "net\ncolor red, blue\nplace p = 1 rde\ntransition t\np*1 red -> t\n", "not a colour", 3, Error},
		{"bare weight in a coloured net", "net\ncolor red, blue\nplace p = 1 red\ntransition t\np -> t\n", "say how many of which", 5, Error},
		{"undeclared end", "net\nplace slots\ntransition produce\nslot -> produce\n", "not declared", 4, Error},
		{"two places", "net\nplace a\nplace b\na -> b\n", "joins two places", 4, Error},
		{"weight on the transition", "net\nplace a\ntransition t\na -> t*2\n", "belongs to the place end", 4, Error},
		{"duplicate id", "net\nplace a\ntransition a\n", "already a place", 3, Error},
		{"inhibitor from a transition", "net\nplace a\ntransition t\nt -o a\n", "inhibitor arc runs from a place", 4, Error},
		{"unconnected", "net\nplace a\nplace lonely\ntransition t\na -> t\n", "has no arcs", 3, Warning},
		{"zero weight", "net\nplace a\ntransition t\na*0 -> t\n", "weight 0", 4, Warning},
		{"negative rate", "net\nplace a\ntransition t rate -1\na -> t\n", "cannot be negative", 3, Error},
		{"empty label", "net\nplace a label \"  \"\ntransition t\na -> t\n", "label cannot be empty", 2, Error},
		{"two-line label", "net\nplace a label \"x\\ny\"\ntransition t\na -> t\n", "single line", 2, Error},
		{"names colour twice", "net\ncolor red, red\n", "declared twice", 2, Error},
	}
	for _, c := range cases {
		d, l, _ := at(t, c.src, c.frag)
		if l != c.line || d.Severity != c.sev {
			t.Errorf("%s: %s at line %d, want %s at line %d", c.name, d.Severity, l, c.sev, c.line)
		}
	}
	// the help names the near miss
	d, _, _ := at(t, "net\nplace slots\ntransition produce\nslot -> produce\n", "not declared")
	if !strings.Contains(d.Help, "slots") {
		t.Errorf("help: %q", d.Help)
	}
}

func TestDiagnosticJSONIsBeatScriptsShape(t *testing.T) {
	src := "net \"café\"\nplace p = 3 cap 2\ntransition t\np -> t\n"
	ds := diagsOf(src)
	if len(ds) != 1 {
		t.Fatalf("%v", ds)
	}
	j := ds[0].JSON(src)
	want := []string{"severity", "source", "line", "col", "end_col", "start", "end", "start16", "end16", "message", "expected", "found", "help", "related", "data", "render"}
	for i, k := range want {
		if j[i].Key != k {
			t.Fatalf("field %d is %q, want %q", i, j[i].Key, k)
		}
	}
	if v, _ := j.Get("line"); v != 2 {
		t.Errorf("line %v", v)
	}
	// "café" has a two-byte é: byte offsets and UTF-16 offsets part on the lines after it
	start, _ := j.Get("start")
	s16, _ := j.Get("start16")
	if start.(int) != s16.(int)+1 {
		t.Errorf("start %v, start16 %v: the é is two bytes and one UTF-16 unit", start, s16)
	}
	if !strings.Contains(ds[0].Render(src), "|           ^") {
		t.Errorf("no caret: %s", ds[0].Render(src))
	}
}

func TestChainsAndGroupsExpandInOrder(t *testing.T) {
	src := "net\nplace a\nplace b\ntransition t\ntransition u\na, b -> t -> a, b\nb -o u\n"
	f, ds := Parse(src)
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	var got []string
	for _, a := range f.Arcs {
		got = append(got, a.Src.ID.Name+a.Arrow+a.Dst.ID.Name)
	}
	want := "a->t b->t t->a t->b b-ou"
	if strings.Join(got, " ") != want {
		t.Errorf("arcs %v, want %s", got, want)
	}
}

func TestWeightsAndVectors(t *testing.T) {
	src := "net\ncolor red, blue\nplace p = 2 red + 1 blue cap 5 red\nplace q = [1, 0]\ntransition t\np*1 red + 2 blue -> t\nt -> q*[1, 1]\n"
	doc, ds := CompileText(src)
	for _, d := range ds {
		if d.IsError() {
			t.Fatal(d.Render(src))
		}
	}
	js := CompactJSON(doc)
	for _, frag := range []string{`"capacity":[5, 0]`, `"initial":[2, 1]`, `"initial":[1, 0]`, `"weight":[1, 2]`, `"weight":[1, 1]`} {
		if !strings.Contains(js, frag) {
			t.Errorf("missing %s in %s", frag, js)
		}
	}
}

// Comments, blank lines and spacing are not in the document: they cannot change a CID.
func TestTriviaDoesNotChangeTheCID(t *testing.T) {
	a := "#! pflow 1\nnet \"x\"\nplace p = 1\ntransition t\np -> t\n"
	b := "#! pflow 1\n\n# a comment\nnet   \"x\"   # trailing\nplace   p   =   1\n\n\ntransition t\n   p->t\n"
	da, _ := CompileText(a)
	db, _ := CompileText(b)
	ca, _ := CID(da)
	cb, _ := CID(db)
	if ca != cb {
		t.Errorf("%s != %s", ca, cb)
	}
}

// What the sealer ignores, the notation may choose freely; what it does not, the notation must keep.
func TestSealingEquivalencesTheDesignRelies(t *testing.T) {
	seal := func(capacity string) string {
		v, err := ParseJSON([]byte(`{"@context":"https://pflow.xyz/schema","@type":"PetriNet","@version":"1.1","token":[],"arcs":[],"places":{"p":{"@type":"Place",` + capacity + `"initial":[1],"offset":0}},"transitions":{}}`))
		if err != nil {
			t.Fatal(err)
		}
		c, err := CID(v)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	same := func(a, b string) bool { return seal(a) == seal(b) }
	if !same(`"capacity":[null],`, `"capacity":[],`) || !same(`"capacity":[null],`, `"capacity":[null,null],`) {
		t.Error("nulls in a list should seal as the empty list")
	}
	if same(`"capacity":[null],`, ``) {
		t.Error("an absent capacity is not an empty one")
	}
	if same(`"capacity":[null],`, `"capacity":[0],`) {
		t.Error("[0] and [null] mean the same to the engines and seal differently: the notation must tell them apart")
	}
	if !same(`"capacity":[3],`, `"capacity":[3.0],`) || !same(`"capacity":[100],`, `"capacity":[1e2],`) {
		t.Error("1, 1.0 and 1e0 are one number")
	}
	// the hazard: a null inside a list is dropped, so [null, 3] is [3]
	if !same(`"capacity":[null,3],`, `"capacity":[3],`) {
		t.Error("expected the sealer to drop an inner null: [null, 3] seals as [3]")
	}
}

// A line that does not parse still declares its name: the arcs that use it are not reported on top of the real error.
func TestBrokenLineDoesNotCascade(t *testing.T) {
	src := "net\nplace a\ntransition t rat 1\na -> t\n"
	ds := diagsOf(src)
	if len(ds) != 1 || ds[0].Source != "syntax" {
		t.Fatalf("want the one syntax error, got %v", ds)
	}
}
