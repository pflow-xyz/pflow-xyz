// SPDX-License-Identifier: MIT

package notation

import (
	"path/filepath"
	"strings"
	"testing"
)

func adviseExample(t *testing.T, name string, maxStates int) (string, []Diagnostic) {
	t.Helper()
	src := string(readFile(t, filepath.Join(examplesDir, name+".pnet")))
	f, ds := Parse(src)
	if len(ds) != 0 {
		t.Fatal(ds)
	}
	doc, _ := CompileText(src)
	if doc == nil {
		t.Fatalf("%s does not compile", name)
	}
	ads, err := Advise(f, doc, maxStates)
	if err != nil {
		t.Fatal(err)
	}
	return src, ads
}

func find(ds []Diagnostic, kind, verdict string) *Diagnostic {
	for i, d := range ds {
		k, _ := d.Data.Get("kind")
		v, _ := d.Data.Get("verdict")
		if k == kind && v == verdict {
			return &ds[i]
		}
	}
	return nil
}

func lineOf(src string, d *Diagnostic) int {
	l, _, _ := d.Position(src)
	return l
}

func TestAdviseBoundedBuffer(t *testing.T) {
	src, ds := adviseExample(t, "bounded-buffer", 2000)
	inv := find(ds, "p-invariant", "proved")
	if inv == nil || !strings.Contains(inv.Message, "items + slots == 3") {
		t.Fatalf("expected the conservation law: %v", ds)
	}
	// it sits on the first place of the law, and points at the other
	if l := lineOf(src, inv); l != 7 || len(inv.Related) != 1 {
		t.Errorf("law at line %d with %d related", l, len(inv.Related))
	}
	if find(ds, "bounded", "proved") == nil || find(ds, "deadlock-free", "proved") == nil {
		t.Errorf("a bounded, deadlock-free net should say so: %v", ds)
	}
	for _, d := range ds {
		if d.Severity == Warning || d.Severity == Error {
			t.Errorf("a clean net, a diagnostic: %s", d.Message)
		}
	}
}

// The inhibitor arcs of readers-writers are what keep a reader and a writer apart.
func TestAdviseReadersWriters(t *testing.T) {
	_, ds := adviseExample(t, "readers-writers", 2000)
	if find(ds, "deadlock-free", "proved") == nil {
		t.Errorf("the reachability search covers all of it, and finds no deadlock: %v", ds)
	}
	n := 0
	for _, d := range ds {
		if k, _ := d.Data.Get("kind"); k == "p-invariant" {
			n++
		}
	}
	if n != 3 {
		t.Errorf("readers+reading, writers+writing, online+offline: %d laws", n)
	}
}

func TestAdviseUnbounded(t *testing.T) {
	src, ds := adviseExample(t, "lotka-volterra", 2000)
	d := find(ds, "bounded", "refuted")
	if d == nil {
		t.Fatalf("prey breed without limit: %v", ds)
	}
	if l := lineOf(src, d); l != 6 {
		t.Errorf("the warning belongs on the Prey line, got line %d", l)
	}
	if w, _ := d.Data.Get("witness"); len(w.([]any)) == 0 {
		t.Error("a refutation carries the firing sequence that shows it")
	}
	// the search could not finish, and the advisor does not pretend it did
	u := find(ds, "search", "unknown")
	if u == nil || !strings.Contains(u.Message, "deadlock-free") {
		t.Errorf("an unknown is said as unknown: %v", ds)
	}
}

// Unknown is not a pass: at the default bound the coffee shop is unknown, at the bound pflow_verify allows it is proved.
func TestAdviseUnknownThenProved(t *testing.T) {
	_, ds := adviseExample(t, "coffee-shop", 2000)
	if find(ds, "search", "unknown") == nil || find(ds, "bounded", "proved") != nil {
		t.Errorf("2000 markings are not enough for the coffee shop, and it must say so: %v", ds)
	}
	_, ds = adviseExample(t, "coffee-shop", 20000)
	if find(ds, "bounded", "proved") == nil || find(ds, "deadlock-free", "proved") == nil || find(ds, "search", "unknown") != nil {
		t.Errorf("20000 are: %v", ds)
	}
}

func TestAdviseDeadlockAndDeadTransition(t *testing.T) {
	src := "#! pflow 1\nnet \"x\"\nplace a = 1\nplace b\nplace c\ntransition t\ntransition u\na -> t -> b\nc -> u -> c\n"
	f, ds := Parse(src)
	if len(ds) != 0 || len(f.Check()) != 0 {
		t.Fatal(ds, f.Check())
	}
	doc, _ := CompileText(src)
	ads, _ := Advise(f, doc, 2000)
	d := find(ads, "deadlock-free", "refuted")
	if d == nil {
		t.Fatalf("a=1 -> t -> b is stuck after t: %v", ads)
	}
	if w, _ := d.Data.Get("witness"); len(w.([]any)) != 1 || w.([]any)[0] != "t" {
		t.Errorf("witness %v", w)
	}
	var onU *Diagnostic
	for i, x := range ads {
		if strings.Contains(x.Message, "`u` never fires") {
			onU = &ads[i]
		}
	}
	if onU == nil || lineOf(src, onU) != 7 {
		t.Errorf("u never fires and its line says so: %v", ads)
	}
}
