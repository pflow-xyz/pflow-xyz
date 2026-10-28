package model

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/seal"
)

const parityDir = "../../parity/model"

// backportMaxBytes bounds the default corpus walk (see TestBackportEveryNet).
const backportMaxBytes = 60 << 10

type vector struct {
	Name    string   `json:"name"`
	File    string   `json:"file"`
	Kind    string   `json:"kind"`
	Sealed  string   `json:"sealed"`
	Model   string   `json:"model"`
	Reduced bool     `json:"reduced"`
	Parts   []string `json:"parts"`
}

type golden struct {
	Vectors  []vector `json:"vectors"`
	Refusals []struct {
		Name string         `json:"name"`
		Doc  map[string]any `json:"doc"`
		Code string         `json:"code"`
	} `json:"refusals"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(parityDir, "golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func read(t *testing.T, rel string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(parityDir, rel))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestGolden holds Identify to the shared vectors. The JS side
// (parity/model_check.mjs) and pflow-native's crates/core/tests/model.rs check
// the same file, so green on all three is the cross-language contract.
func TestGolden(t *testing.T) {
	g := loadGolden(t)
	for _, v := range g.Vectors {
		id, err := Identify(read(t, v.File))
		if err != nil {
			t.Errorf("%s: %v", v.Name, err)
			continue
		}
		if id.Kind != v.Kind && !(v.Reduced && id.Kind == KindNet) {
			t.Errorf("%s: kind %q, want %q", v.Name, id.Kind, v.Kind)
		}
		if id.Sealed != v.Sealed || id.CID != v.Model || id.Reduced != v.Reduced {
			t.Errorf("%s: got sealed=%s model=%s reduced=%v\n  want sealed=%s model=%s reduced=%v",
				v.Name, id.Sealed, id.CID, id.Reduced, v.Sealed, v.Model, v.Reduced)
		}
		if len(v.Parts) > 0 && strings.Join(id.Parts, ",") != strings.Join(v.Parts, ",") {
			t.Errorf("%s: parts %v, want %v", v.Name, id.Parts, v.Parts)
		}
	}
	for _, r := range g.Refusals {
		err := Check(r.Doc)
		var me *Error
		if !errors.As(err, &me) || me.Code != r.Code {
			t.Errorf("refusal %s: got %v, want code %s", r.Name, err, r.Code)
		}
	}
	t.Logf("%d vectors, %d refusals", len(g.Vectors), len(g.Refusals))
}

func TestCanonicalJSONVectors(t *testing.T) {
	var c struct {
		Vectors []struct{ Name, In, Out string } `json:"vectors"`
	}
	if err := json.Unmarshal(read(t, "canonical.json"), &c); err != nil {
		t.Fatal(err)
	}
	for _, v := range c.Vectors {
		got, err := CanonicalJSON([]byte(v.In))
		if err != nil {
			t.Errorf("%s: %v", v.Name, err)
			continue
		}
		if got != v.Out {
			t.Errorf("%s:\n  got  %s\n  want %s", v.Name, got, v.Out)
		}
		// Canonicalising canonical text is a no-op.
		if again, _ := CanonicalJSON([]byte(got)); again != got {
			t.Errorf("%s: not idempotent: %s", v.Name, again)
		}
	}
}

// The showcase's cafe.bundle.json is a composition whose parts have no net
// CID, so its composition CID is the raw-bundle CID the sealer has always given it.
func TestCafeBundleKeepsItsCID(t *testing.T) {
	const raw = "z4EBG9j1SUhuY7XnEcPfHQPzQkmqjUtgrD2wHADw8qdRbpnNt6W"
	data, err := os.ReadFile("../../examples/showcase/cafe.bundle.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, read(t, "fixtures/cafe.bundle.json")) {
		t.Fatal("parity/model/fixtures/cafe.bundle.json drifted from examples/showcase/cafe.bundle.json")
	}
	id, err := Identify(data)
	if err != nil {
		t.Fatal(err)
	}
	if id.Kind != KindComposition || id.CID != raw || id.Sealed != raw || id.Reduced {
		t.Fatalf("cafe: %+v", id)
	}
}

// TestBackportEveryNet is the backport proof: every pflow.xyz JSON-LD document
// reachable in this repository that is not a composition or a plan keeps the
// CID it has always had, under the rule. A net's model CID is
// seal.SealJSONLD(net), byte for byte; where the file name or @id claims a CID
// the claim is checked too.
//
// Sealing a very large net with json-gold takes minutes, so the default run
// covers documents up to backportMaxBytes and counts the rest as skipped;
// MODEL_BACKPORT_FULL=1 seals everything (run once before a release; the
// result is quoted in the PR that introduced the rule).
func TestBackportEveryNet(t *testing.T) {
	root := "../.."
	limit := int64(backportMaxBytes)
	if os.Getenv("MODEL_BACKPORT_FULL") != "" {
		limit = 1 << 40
	}
	type job struct {
		rel  string
		path string
		raw  []byte
		kind string
	}
	var jobs []job
	var large int
	skipDir := map[string]bool{".git": true, "node_modules": true, "static": true, "vendor": true, "target": true}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skipDir[d.Name()] || strings.HasPrefix(d.Name(), "bazel-") {
				return filepath.SkipDir
			}
			return nil
		}
		if ext := filepath.Ext(path); ext != ".json" && ext != ".jsonld" {
			return nil
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var doc map[string]any
		if json.Unmarshal(raw, &doc) != nil || doc == nil {
			return nil
		}
		if ctx, _ := doc["@context"].(string); ctx != Context {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		if int64(len(raw)) > limit {
			large++
			return nil
		}
		jobs = append(jobs, job{rel: rel, path: path, raw: raw, kind: Kind(doc)})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	// json-gold is slow and single-threaded per document: seal them side by side.
	type result struct {
		sealed string
		serr   error
		id     Identity
		ierr   error
	}
	results := make([]result, len(jobs))
	sem := make(chan struct{}, runtime.NumCPU())
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			r := &results[i]
			r.sealed, _, r.serr = seal.SealJSONLD(jobs[i].raw)
			r.id, r.ierr = Identify(jobs[i].raw)
		}(i)
	}
	wg.Wait()

	var nets, comps, plans, skipped, namedByCID int
	for i, j := range jobs {
		r := results[i]
		switch j.kind {
		case KindNet:
			if (r.serr == nil) != (r.ierr == nil) {
				t.Errorf("%s: seal err=%v, identify err=%v", j.rel, r.serr, r.ierr)
				continue
			}
			if r.serr != nil {
				skipped++
				continue
			}
			if r.id.CID != r.sealed || r.id.Sealed != r.sealed || r.id.Reduced || r.id.Kind != KindNet {
				t.Errorf("%s: model CID %s != sealed %s (reduced=%v kind=%s)", j.rel, r.id.CID, r.sealed, r.id.Reduced, r.id.Kind)
			}
			if base := strings.TrimSuffix(filepath.Base(j.path), ".jsonld"); IsCID(base) {
				namedByCID++
				if base != r.sealed {
					t.Errorf("%s: file name claims %s, seals to %s", j.rel, base, r.sealed)
				}
			}
			nets++
		case KindComposition:
			if r.ierr != nil {
				t.Errorf("%s: composition refused: %v", j.rel, r.ierr)
				continue
			}
			if r.id.CID != r.sealed && !r.id.Reduced {
				t.Errorf("%s: composition CID %s != sealed %s", j.rel, r.id.CID, r.sealed)
			}
			comps++
		case KindPlan:
			plans++
		}
	}
	if nets < 10 {
		t.Fatalf("corpus too small (%d nets): the walk is not finding the repository's documents", nets)
	}
	t.Logf("backport: %d nets keep their CID (%d named by their CID), %d compositions, %d plans; %d unsealable, %d over %d bytes not sealed here (MODEL_BACKPORT_FULL=1 seals them)", nets, namedByCID, comps, plans, skipped, large, backportMaxBytes)
}

// A bare wrapper is the net it names; anything that says more is a composition.
func TestBareWrapperReduction(t *testing.T) {
	const part = "z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8"
	wrap := func(mut func(doc map[string]any)) map[string]any {
		doc := map[string]any{
			"@context": Context, "@type": TypeComposition,
			"subnets": []any{map[string]any{"@type": "PetriNet", "id": "a", "cid": part}},
		}
		if mut != nil {
			mut(doc)
		}
		return doc
	}
	sub := func(doc map[string]any) map[string]any { return doc["subnets"].([]any)[0].(map[string]any) }
	cases := []struct {
		name   string
		mut    func(map[string]any)
		reduce bool
	}{
		{"bare", nil, true},
		{"with @id", func(d map[string]any) { d["@id"] = "z-anything" }, true},
		{"namespace and arc_merge are ignored by Flatten for one subnet", func(d map[string]any) { d["namespace"] = false; d["arc_merge"] = "max" }, true},
		{"empty links and constraints", func(d map[string]any) { d["links"] = []any{}; d["constraints"] = []any{} }, true},
		{"net_type on the part", func(d map[string]any) { sub(d)["net_type"] = "ResourceNet" }, true},
		{"a name", func(d map[string]any) { d["name"] = "x" }, false},
		{"a description", func(d map[string]any) { d["description"] = "x" }, false},
		{"a version", func(d map[string]any) { d["version"] = "1" }, false},
		{"parents", func(d map[string]any) { d["parents"] = []any{part} }, false},
		{"a constraint", func(d map[string]any) { d["constraints"] = []any{map[string]any{"id": "c"}} }, false},
		{"ports on the part", func(d map[string]any) { sub(d)["ports"] = []any{map[string]any{"id": "p"}} }, false},
		{"a recipe on the part", func(d map[string]any) { sub(d)["pattern"] = "queue"; sub(d)["params"] = "{}" }, false},
		{"an inline part", func(d map[string]any) { delete(sub(d), "cid"); sub(d)["model"] = map[string]any{"name": "n"} }, false},
		{"two parts", func(d map[string]any) {
			d["subnets"] = append(d["subnets"].([]any), map[string]any{"id": "b", "cid": part})
		}, false},
	}
	for _, c := range cases {
		got, ok := BareWrapper(wrap(c.mut))
		if ok != c.reduce || (ok && got != part) {
			t.Errorf("%s: reduce=%v (%q), want %v", c.name, ok, got, c.reduce)
		}
	}
}

// Why `params` and `plan` are embedded as text: any array under a term that is
// not @list in the sealing context hashes as an unordered set, so reordering
// the steps of a saga (compensation runs in reverse) would not change the CID.
// The same payload as canonical text does.
func TestOrderedPayloadsAreEmbeddedAsText(t *testing.T) {
	seal1 := func(doc map[string]any) string {
		raw, _ := json.Marshal(doc)
		c, _, err := seal.SealJSONLD(raw)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	nested := func(steps ...any) map[string]any {
		return map[string]any{"@context": Context, "@type": "X", "params": map[string]any{"steps": steps}}
	}
	if seal1(nested("reserve", "charge")) != seal1(nested("charge", "reserve")) {
		t.Fatal("expected a nested array to hash as a set: if this fails the rationale in docs/model-identity.md is stale")
	}
	text := func(steps ...string) map[string]any {
		b, _ := json.Marshal(map[string]any{"steps": steps})
		s, _ := CanonicalJSON(b)
		return map[string]any{"@context": Context, "@type": "X", "params": s}
	}
	if seal1(text("reserve", "charge")) == seal1(text("charge", "reserve")) {
		t.Fatal("canonical text must keep the order in the CID")
	}
}

func TestPlanDocument(t *testing.T) {
	const m = "z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8"
	a, err := NewPlan(m, []byte(`{"order":["tt_best","history"],"mode":"exact"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := NewPlan(m, []byte(`{"mode":"exact","order":["history","tt_best"]}`))
	same, _ := NewPlan(m, []byte(`{ "mode": "exact", "order": ["tt_best", "history"] }`))
	ia, ib, is := mustID(t, a), mustID(t, b), mustID(t, same)
	if ia.Kind != KindPlan || ia.CID != is.CID {
		t.Errorf("a plan is a plan, and its CID does not depend on key order or spacing: %+v %+v", ia, is)
	}
	if ia.CID == ib.CID {
		t.Error("a reordered `order` list is a different plan")
	}
	if _, err := NewPlan("nope", []byte(`{}`)); err == nil {
		t.Error("a plan must name a model CID")
	}
}

func mustID(t *testing.T, raw []byte) Identity {
	t.Helper()
	id, err := Identify(raw)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// fetcher serves parity/model/fixtures by CID, like the object store.
func fetcher(t *testing.T) Fetcher {
	byCID := map[string][]byte{}
	for _, f := range []string{"part-maker.jsonld", "part-taker.jsonld"} {
		raw := read(t, "fixtures/"+f)
		byCID[mustID(t, raw).CID] = raw
	}
	coffee, err := os.ReadFile("../../parity/fixtures/coffee-shop.jsonld")
	if err != nil {
		t.Fatal(err)
	}
	byCID[mustID(t, coffee).CID] = coffee
	byCID[mustID(t, read(t, "fixtures/compose-handoff.jsonld")).CID] = read(t, "fixtures/compose-handoff.jsonld")
	return func(cid string) ([]byte, error) {
		if raw, ok := byCID[cid]; ok {
			return raw, nil
		}
		return nil, os.ErrNotExist
	}
}

// Parts by reference resolve through the store and flatten with go-pflow's
// Flatten; changing a link changes only the composition's CID.
func TestResolveAndFlattenByReference(t *testing.T) {
	fetch := fetcher(t)
	handoff := read(t, "fixtures/compose-handoff.jsonld")
	flat, fm, err := Flatten(handoff, fetch)
	if err != nil {
		t.Fatal(err)
	}
	// maker (2 places, 2 transitions) + taker (2, 2) with Handoff ≡ Take fused: 4 places, 3 transitions.
	if len(flat.Places) != 4 || len(flat.Transitions) != 3 {
		t.Fatalf("flat net has %d places and %d transitions, want 4 and 3", len(flat.Places), len(flat.Transitions))
	}
	if len(fm.Transition) != 2 {
		t.Errorf("FlattenMap covers %d subnets, want 2", len(fm.Transition))
	}

	relinked := read(t, "fixtures/compose-handoff-relinked.jsonld")
	a, b := mustID(t, handoff), mustID(t, relinked)
	if a.CID == b.CID {
		t.Fatal("a different link must give a different composition CID")
	}
	if strings.Join(a.Parts, ",") != strings.Join(b.Parts, ",") {
		t.Fatalf("both compositions reference the same parts: %v vs %v", a.Parts, b.Parts)
	}
	for _, p := range a.Parts {
		raw, _ := fetch(p)
		if got := mustID(t, raw); got.CID != p || got.Kind != KindNet {
			t.Errorf("part %s re-identifies as %+v", p, got)
		}
	}

	// A missing part is a named refusal, not a panic or a 500.
	_, _, err = Flatten(handoff, func(string) ([]byte, error) { return nil, os.ErrNotExist })
	var me *Error
	if !errors.As(err, &me) || me.Code != ErrPartMissing {
		t.Errorf("missing part: %v", err)
	}
	// A composition cannot be a part (yet).
	_, _, err = Flatten(handoff, func(string) ([]byte, error) { return handoff, nil })
	if !errors.As(err, &me) || me.Code != ErrPartKind {
		t.Errorf("composition as a part: %v", err)
	}
}

// A bare wrapper flattens to the net it wraps, unchanged (Flatten's identity case).
func TestFlattenOfBareWrapperIsTheNet(t *testing.T) {
	fetch := fetcher(t)
	flat, _, err := Flatten(read(t, "fixtures/wrap-coffee-shop.jsonld"), fetch)
	if err != nil {
		t.Fatal(err)
	}
	if len(flat.Places) != 4 || len(flat.Transitions) != 5 {
		t.Fatalf("coffee-shop flat: %d places, %d transitions", len(flat.Places), len(flat.Transitions))
	}
	if _, err := FlatNetJSON(flat); err != nil {
		t.Fatal(err)
	}
}

func TestCafeFlattens(t *testing.T) {
	flat, _, err := Flatten(read(t, "fixtures/cafe.bundle.json"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(flat.Places) == 0 || len(flat.Transitions) == 0 {
		t.Fatal("empty flat net")
	}
}
