package main

import (
	"bytes"
	"encoding/json"
	"html"
	"io/fs"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/piprate/json-gold/ld"

	"github.com/pflow-xyz/go-pflow/metamodel"
	"github.com/pflow-xyz/pflow-xyz/internal/seal"
)

// jsonNames returns the JSON field names of a struct type, from its tags.
func jsonNames(t reflect.Type) []string {
	var out []string
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

func docNames(fields []fieldDoc) []string {
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		out = append(out, f.Name)
	}
	sort.Strings(out)
	return out
}

// Every field the page documents is a field go-pflow's Bundle format has, and
// every field it has is documented. go-pflow is the source of truth.
func TestBundleFieldsMatchGoPflow(t *testing.T) {
	for _, c := range []struct {
		name string
		typ  reflect.Type
		docs []fieldDoc
	}{
		{"Bundle", reflect.TypeOf(metamodel.Bundle{}), bundleFields.Bundle},
		{"Subnet", reflect.TypeOf(metamodel.Subnet{}), bundleFields.Subnet},
		{"Port", reflect.TypeOf(metamodel.Port{}), bundleFields.Port},
		{"Link", reflect.TypeOf(metamodel.Link{}), bundleFields.Link},
		{"Endpoint", reflect.TypeOf(metamodel.Endpoint{}), bundleFields.Endpoint},
	} {
		got, want := docNames(c.docs), jsonNames(c.typ)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: the page documents %v, go-pflow's struct has %v", c.name, got, want)
		}
		for _, f := range c.docs {
			if f.Type == "" || f.Meaning == "" {
				t.Errorf("%s.%s has no type or no meaning", c.name, f.Name)
			}
		}
	}
	// The closed sets: the page spells them with go-pflow's constants; this
	// pins how many there are, so a new value there is noticed here.
	for _, c := range []struct {
		name string
		got  []enumDoc
		n    int
	}{
		{"net_type", bundleNetTypes, 5},
		{"port kind", bundlePortKinds, 4},
		{"link kind", bundleLinkKinds, 4},
		{"lowering", bundleLowerings, 4},
		{"arc_merge", bundleArcMerges, 2},
	} {
		if len(c.got) != c.n {
			t.Errorf("%s: %d documented values, expected %d; update the page if go-pflow added one", c.name, len(c.got), c.n)
		}
		seen := map[string]bool{}
		for _, e := range c.got {
			if e.Value == "" || e.Meaning == "" || seen[e.Value] {
				t.Errorf("%s: empty or duplicate entry %q", c.name, e.Value)
			}
			seen[e.Value] = true
		}
	}
}

// The example on the page is a real bundle: it decodes with no unknown field,
// validates with no error, and flattens, with the pinned go-pflow.
func TestBundleExampleValidatesAndFlattens(t *testing.T) {
	var b metamodel.Bundle
	dec := json.NewDecoder(strings.NewReader(bundleExample))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		t.Fatalf("the example does not decode into metamodel.Bundle: %v", err)
	}
	if b.Type != "PetriNetBundle" || b.Context != "https://pflow.xyz/schema" {
		t.Errorf("envelope = %q / %q", b.Type, b.Context)
	}
	res := b.Validate()
	if !res.Valid {
		t.Fatalf("the example does not validate: %+v", res.Errors)
	}
	flat, fmap, err := b.FlattenWithMap()
	if err != nil {
		t.Fatalf("the example does not flatten: %v", err)
	}
	// The event link fused orders/ship with stock/take into one transition.
	if len(fmap.FusedGroups) != 1 {
		t.Errorf("fused groups = %v, want one (ship+take)", fmap.FusedGroups)
	}
	if n := len(flat.Transitions); n != 1 {
		t.Errorf("flat net has %d transitions, want the one fused transition", n)
	}
	// The guard link lowered to a read arc (>= 2) on the fused transition.
	var read bool
	for _, a := range flat.Arcs {
		if a.Type == metamodel.ReadArc && a.Weight == 2 {
			read = true
		}
	}
	if !read {
		t.Errorf("no read arc of weight 2 in the flat net: %+v", flat.Arcs)
	}
}

// The term table is computed from the live context: defined terms show their
// IRI, the rest fall to @vocab, and both are set against the sealer's.
func TestBundleTermTableFollowsContext(t *testing.T) {
	s := newTestServer(t)
	_, terms, err := s.schemaCache.load(s.publicFS)
	if err != nil {
		t.Fatal(err)
	}
	vocab := s.schemaCache.vocab
	if vocab != "https://schema.org/" {
		t.Fatalf("published @vocab = %q; if it changed, review the note on /schema", vocab)
	}
	rows := map[string]bundleTerm{}
	for _, r := range buildBundleDoc(vocab, terms).Terms {
		rows[r.Name] = r
	}
	for _, n := range []string{"PetriNetBundle", "subnets", "arc_merge", "namespace", "ports", "net_type"} {
		r, ok := rows[n]
		if !ok {
			t.Errorf("no row for %s", n)
			continue
		}
		// Today these are not defined in the published context. If a lockstep
		// change defines one, the row flips by itself; this assertion is the
		// reminder to revise the page's wording with it.
		if r.Defined || r.Published != "https://schema.org/"+n || r.Sealing != "https://pflow.xyz/schema#"+n || r.Same {
			t.Errorf("%s: %+v", n, r)
		}
	}
	for _, n := range []string{"PetriNet", "links", "from", "to", "place", "transition", "model"} {
		if r := rows[n]; !r.Defined || !r.Same {
			t.Errorf("%s: want defined, and the same IRI as the sealer's: %+v", n, r)
		}
	}
	// With a context that does define a term, the row follows it.
	synth := buildBundleDoc("https://example.test/v/", []schemaTerm{{Name: "subnets", ID: "https://pflow.xyz/schema#subnets"}})
	for _, r := range synth.Terms {
		switch r.Name {
		case "subnets":
			if !r.Defined || !r.Same || r.Published != "https://pflow.xyz/schema#subnets" {
				t.Errorf("defined term: %+v", r)
			}
		case "links":
			if r.Defined || r.Published != "https://example.test/v/links" {
				t.Errorf("undefined term: %+v", r)
			}
		}
	}
}

// The page's two factual claims about expansion, proved with the real
// processors: the sealer expands an unlisted key (every bundle term) through
// its own @vocab, and the published context expands the same key through
// schema.org. So the two do not yield the same RDF for a bundle.
func TestSealerAndPublishedContextExpandBundleTermsDifferently(t *testing.T) {
	const doc = `{"@context":"https://pflow.xyz/schema","@type":"PetriNetBundle","name":"x","namespace":true,"arc_merge":"sum",
		"subnets":[{"@type":"PetriNet","id":"a","net_type":"ResourceNet","model":{"name":"a"}}],
		"links":[{"kind":"event","from":{"subnet":"a","transition":"t"},"to":{"subnet":"a","transition":"u"}}]}`

	// The sealer: canonical N-Quads of the hashed document.
	_, nq, err := seal.SealJSONLD([]byte(doc))
	if err != nil {
		t.Fatalf("SealJSONLD: %v", err)
	}
	canonical := string(nq)
	for _, term := range []string{"subnets", "arc_merge", "namespace", "net_type", "PetriNetBundle", "kind"} {
		if !strings.Contains(canonical, "<"+sealVocab+term+">") {
			t.Errorf("the sealed document has no <%s%s>", sealVocab, term)
		}
	}
	if strings.Contains(canonical, "schema.org") {
		t.Error("the sealer's N-Quads mention schema.org; its @vocab is pflow.xyz/schema#")
	}

	// The published context, loaded as a document processor would load it.
	s := newTestServer(t)
	raw, err := fs.ReadFile(s.publicFS, "schema")
	if err != nil {
		t.Fatal(err)
	}
	var published map[string]interface{}
	if err := json.Unmarshal(raw, &published); err != nil {
		t.Fatal(err)
	}
	loader := ld.NewCachingDocumentLoader(ld.NewDefaultDocumentLoader(nil))
	loader.AddDocument("https://pflow.xyz/schema", published)
	opts := ld.NewJsonLdOptions("")
	opts.DocumentLoader = loader
	var input map[string]interface{}
	if err := json.Unmarshal([]byte(doc), &input); err != nil {
		t.Fatal(err)
	}
	expanded, err := ld.NewJsonLdProcessor().Expand(input, opts)
	if err != nil {
		t.Fatalf("expanding against the published context: %v", err)
	}
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(expanded); err != nil {
		t.Fatal(err)
	}
	out := buf.String()
	for _, term := range []string{"subnets", "arc_merge", "namespace", "net_type", "PetriNetBundle"} {
		if !strings.Contains(out, "https://schema.org/"+term) {
			t.Errorf("the published context does not expand %s through schema.org: %s", term, out)
		}
		if strings.Contains(out, sealVocab+term) {
			t.Errorf("the published context expands %s to the sealer's IRI", term)
		}
	}
	// Terms it does define agree with the sealer's IRI: links is the example.
	if !strings.Contains(out, "https://pflow.xyz/schema#links") {
		t.Errorf("links is not expanded to https://pflow.xyz/schema#links: %s", out)
	}
}

// The reference page, as a browser gets it, documents the bundle format and
// the @vocab difference; JSON-LD clients still get the unchanged context
// (TestHandleSchema_JSONLDBytesUnchanged).
func TestHandleSchema_HTMLDocumentsBundle(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest("GET", "/schema", nil)
	req.Header.Set("Accept", "text/html")
	w := httptest.NewRecorder()
	s.handleSchema(w, req)
	if w.Code != 200 {
		t.Fatalf("status = %d", w.Code)
	}
	body := html.UnescapeString(w.Body.String())
	for _, want := range []string{
		`id="bundle"`, `id="vocab"`,
		"PetriNetBundle", "PetriNet", "subnets", "links", "constraints", "namespace", "arc_merge", "net_type", "ports",
		"WorkflowNet", "ResourceNet", "observe", "inout", "rename", "condition", "lowering",
		">token<", ">data<", ">event<", ">guard<",
		"examples/showcase/cafe.bundle.json", "metamodel/compose.go", "CompositeNet", "GuardLink",
		"@vocab", "https://schema.org/", "https://pflow.xyz/schema#",
		"https://schema.org/subnets", "https://pflow.xyz/schema#subnets",
		"internal/seal", "seal-cid.mjs",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("the schema HTML page does not mention %q", want)
		}
	}
	// The documented example is on the page, verbatim.
	if !strings.Contains(body, strings.Split(bundleExample, "\n")[3]) { // the "name" line
		t.Error("the page does not carry the example")
	}
	if a, b := strings.Count(body, "<table>"), strings.Count(body, "</table>"); a != b || a < 8 {
		t.Errorf("%d <table> and %d </table>", a, b)
	}
	// The head tags the existing test pins are untouched, and there is one <h1>.
	if n := strings.Count(body, "<h1>"); n != 1 {
		t.Errorf("%d <h1>", n)
	}
}
