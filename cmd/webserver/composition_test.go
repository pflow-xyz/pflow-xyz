package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/pflow-xyz/pflow-xyz/internal/model"
	"github.com/pflow-xyz/pflow-xyz/internal/seal"
)

const modelFixtures = "../../parity/model/fixtures"

func compFixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(modelFixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func compositionServer(t *testing.T) *Server {
	t.Helper()
	return &Server{
		storage: NewFSStorage(t.TempDir()),
		publicFS: fstest.MapFS{
			"index.html":   {Data: []byte(`<!DOCTYPE html><html><head><title>pflow</title></head><body>editor</body></html>`)},
			"compose.html": {Data: []byte(`<!DOCTYPE html><html><head><title>Composition views</title></head><body>compose</body></html>`)},
		},
	}
}

// put stores raw under its sealed CID, as POST /api/save does for a net.
func compPut(t *testing.T, s *Server, raw []byte) string {
	t.Helper()
	cid, canonical, err := seal.SealJSONLD(raw)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.storage.SaveObject(cid, raw, canonical); err != nil {
		t.Fatal(err)
	}
	return cid
}

func compGet(s *Server, method, target string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, bytes.NewReader(body))
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

// saved stores the two parts and the handoff composition and returns their CIDs.
func compSaved(t *testing.T, s *Server) (maker, taker, comp string) {
	t.Helper()
	maker = compPut(t, s, compFixture(t, "part-maker.jsonld"))
	taker = compPut(t, s, compFixture(t, "part-taker.jsonld"))
	comp = compPut(t, s, compFixture(t, "compose-handoff.jsonld"))
	return
}

// /?cid=<composition> must reach the composition page; a net keeps the editor.
func TestCompositionCIDRoutesToComposePage(t *testing.T) {
	s := compositionServer(t)
	maker, _, comp := compSaved(t, s)

	w := compGet(s, "GET", "/?cid="+comp, nil)
	if w.Code != http.StatusFound || w.Header().Get("Location") != "/compose.html?cid="+comp {
		t.Fatalf("composition: %d Location=%q", w.Code, w.Header().Get("Location"))
	}
	w = compGet(s, "GET", "/?cid="+maker, nil)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "editor") {
		t.Fatalf("net: %d, want the editor", w.Code)
	}
	if w := compGet(s, "GET", "/?cid=zUnknownUnknownUnknownUnknown", nil); w.Code != http.StatusNotFound {
		t.Fatalf("unknown cid: %d", w.Code)
	}
	// A plan is not a net either: the page shows it.
	plan := compPut(t, s, compFixture(t, "plan-coffee-shop.jsonld"))
	if w := compGet(s, "GET", "/?cid="+plan, nil); w.Code != http.StatusFound || w.Header().Get("Location") != "/compose.html?cid="+plan {
		t.Fatalf("plan: %d Location=%q", w.Code, w.Header().Get("Location"))
	}
}

func TestComposePageCarriesShareCard(t *testing.T) {
	s := compositionServer(t)
	_, _, comp := compSaved(t, s)
	w := compGet(s, "GET", "/compose.html?cid="+comp, nil)
	body := w.Body.String()
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	for _, want := range []string{
		`/share-card/` + comp + `.png`,
		`<title>handoff · pflow.xyz</title>`,
		`A composition of 2 parts and 1 links`,
		`compose`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	if w := compGet(s, "GET", "/compose.html?cid=garbage", nil); w.Code != http.StatusNotFound {
		t.Errorf("malformed cid: %d", w.Code)
	}
	if w := compGet(s, "GET", "/compose.html", nil); w.Code != http.StatusOK {
		t.Errorf("bare page: %d", w.Code)
	}
}

// A stored composition used to hand the net renderer a document with no
// places. It must draw its flat net, and never fail.
func TestCompositionImageAndShareCard(t *testing.T) {
	s := compositionServer(t)
	_, _, comp := compSaved(t, s)

	w := compGet(s, "GET", "/img/"+comp+".svg", nil)
	body := w.Body.String()
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "image/svg+xml" || !strings.Contains(body, "<svg") {
		t.Fatalf("img: %d %s", w.Code, w.Header().Get("Content-Type"))
	}
	// The flat net's namespaced places are on the drawing.
	for _, want := range []string{"maker/Idle", "taker/Got"} {
		if !strings.Contains(body, want) {
			t.Errorf("flat net drawing lacks %q", want)
		}
	}
	card := compGet(s, "GET", "/share-card/"+comp+".svg", nil)
	if card.Code != http.StatusOK || !strings.Contains(card.Body.String(), "handoff") {
		t.Fatalf("share-card svg: %d", card.Code)
	}
	png := compGet(s, "GET", "/share-card/"+comp+".png", nil)
	if png.Code != http.StatusOK || !bytes.HasPrefix(png.Body.Bytes(), []byte("\x89PNG")) {
		t.Fatalf("share-card png: %d", png.Code)
	}
	// Every sitemap entry resolves, compositions included.
	sm := compGet(s, "GET", "/sitemap.xml", nil).Body.String()
	if !strings.Contains(sm, "/img/"+comp+".svg") {
		t.Fatalf("sitemap does not list the composition's image")
	}
}

// A part that is not in the store leaves the parts diagram, not a 500.
func TestCompositionWithMissingPartsStillRenders(t *testing.T) {
	s := compositionServer(t)
	comp := compPut(t, s, compFixture(t, "compose-handoff.jsonld")) // parts never stored
	for _, path := range []string{"/img/" + comp + ".svg", "/share-card/" + comp + ".svg", "/share-card/" + comp + ".png"} {
		if w := compGet(s, "GET", path, nil); w.Code != http.StatusOK {
			t.Errorf("%s: %d", path, w.Code)
		}
	}
	body := compGet(s, "GET", "/img/"+comp+".svg", nil).Body.String()
	if !strings.Contains(body, "maker") || !strings.Contains(body, "taker") {
		t.Errorf("the parts diagram names its parts; got %.200s", body)
	}
	if w := compGet(s, "GET", "/?cid="+comp, nil); w.Code != http.StatusFound {
		t.Errorf("redirect: %d", w.Code)
	}
}

// Plans and unknown documents are objects too; none may 500 a thumbnail.
func TestPlanImageDoesNotFail(t *testing.T) {
	s := compositionServer(t)
	plan := compPut(t, s, compFixture(t, "plan-coffee-shop.jsonld"))
	for _, path := range []string{"/img/" + plan + ".svg", "/share-card/" + plan + ".svg", "/share-card/" + plan + ".png"} {
		if w := compGet(s, "GET", path, nil); w.Code != http.StatusOK {
			t.Errorf("%s: %d", path, w.Code)
		}
	}
}

func compSaveResponse(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	return out
}

func TestSaveCompositionRequiresStoredParts(t *testing.T) {
	s := compositionServer(t)
	comp := compFixture(t, "compose-handoff.jsonld")

	w := compGet(s, "POST", "/api/save", comp)
	if w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "E_PART_MISSING") {
		t.Fatalf("parts missing: %d %s", w.Code, w.Body.String())
	}
	maker := compSaveResponse(t, compGet(s, "POST", "/api/save", compFixture(t, "part-maker.jsonld")))
	taker := compSaveResponse(t, compGet(s, "POST", "/api/save", compFixture(t, "part-taker.jsonld")))
	// A net's response is exactly what it always was.
	if len(maker) != 1 || maker["cid"] == nil {
		t.Fatalf("net save response changed: %v", maker)
	}
	_ = taker

	w = compGet(s, "POST", "/api/save", comp)
	out := compSaveResponse(t, w)
	id, _ := model.Identify(comp)
	if w.Code != http.StatusOK || out["cid"] != id.CID || out["kind"] != "composition" {
		t.Fatalf("composition save: %d %v", w.Code, out)
	}
	if got := compGet(s, "GET", "/o/"+id.CID, nil); got.Code != http.StatusOK {
		t.Errorf("stored composition does not resolve: %d", got.Code)
	}
	// Saving it again is idempotent.
	if again := compSaveResponse(t, compGet(s, "POST", "/api/save", comp)); again["cid"] != id.CID {
		t.Errorf("re-save: %v", again)
	}
}

// A bare wrapper IS the net it names: no second object, no second CID.
func TestSaveBareWrapperReturnsTheNetsCID(t *testing.T) {
	s := compositionServer(t)
	coffee, err := os.ReadFile("../../parity/fixtures/coffee-shop.jsonld")
	if err != nil {
		t.Fatal(err)
	}
	wrap := compFixture(t, "wrap-coffee-shop.jsonld")

	// The net is not stored yet: refuse, as for any composition.
	if w := compGet(s, "POST", "/api/save", wrap); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("wrapper of an unstored net: %d", w.Code)
	}
	netCID := compPut(t, s, coffee)
	w := compGet(s, "POST", "/api/save", wrap)
	out := compSaveResponse(t, w)
	if w.Code != http.StatusOK || out["cid"] != netCID || out["reduced"] != true || out["kind"] != "net" {
		t.Fatalf("wrapper save: %d %v (net %s)", w.Code, out, netCID)
	}
	sealed, _, _ := seal.SealJSONLD(wrap)
	if _, err := s.storage.GetObject(sealed); !os.IsNotExist(err) {
		t.Errorf("the wrapper was stored under its own CID %s: that is a second identity for the net", sealed)
	}
}

func TestSaveRefusals(t *testing.T) {
	s := compositionServer(t)
	cases := map[string]string{
		"no subnets":    `{"@context":"https://pflow.xyz/schema","@type":"PetriNetBundle","subnets":[]}`,
		"tokenmodel":    `{"@context":"https://pflow.xyz/schema","@type":"PetriNetBundle","subnets":[{"id":"a","model":{}},{"id":"b","model":{}}],"links":[{"kind":"token","from_subnet":"a","from_port":"x","to_subnet":"b","to_port":"y"}]}`,
		"params array":  `{"@context":"https://pflow.xyz/schema","@type":"PetriNetBundle","subnets":[{"id":"a","model":{},"pattern":"saga","params":{"steps":["a"]}}]}`,
		"plan no model": `{"@context":"https://pflow.xyz/schema","@type":"SearchPlan","plan":"{}"}`,
	}
	for name, doc := range cases {
		if w := compGet(s, "POST", "/api/save", []byte(doc)); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
	// A plan may name a model the store does not hold.
	w := compGet(s, "POST", "/api/save", compFixture(t, "plan-coffee-shop.jsonld"))
	if out := compSaveResponse(t, w); w.Code != http.StatusOK || out["kind"] != "plan" {
		t.Errorf("plan save: %d %v", w.Code, out)
	}
}

func TestMCPCIDUsesTheModelRule(t *testing.T) {
	var wrap map[string]any
	if err := json.Unmarshal(compFixture(t, "wrap-coffee-shop.jsonld"), &wrap); err != nil {
		t.Fatal(err)
	}
	got, err := mcpCID(nil, nil, map[string]any{"net": wrap})
	if err != nil {
		t.Fatal(err)
	}
	out := got.(map[string]any)
	if out["cid"] != "z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8" || out["reduced"] != true {
		t.Errorf("pflow_cid of a bare wrapper: %v", out)
	}
	// A net: the response is what it always was.
	coffee, _ := os.ReadFile("../../parity/fixtures/coffee-shop.jsonld")
	var net map[string]any
	_ = json.Unmarshal(coffee, &net)
	got, err = mcpCID(nil, nil, map[string]any{"net": net})
	if err != nil {
		t.Fatal(err)
	}
	if out := got.(map[string]any); len(out) != 1 || out["cid"] != "z4EBG9jDsuUdvVN4bUXRHxoDG3p274FfhcJd8BiruRcE1jLCHi8" {
		t.Errorf("pflow_cid of a net changed: %v", out)
	}
}
