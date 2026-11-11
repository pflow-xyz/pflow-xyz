package main

import (
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

const artRingNet = `{"@context":"https://pflow.xyz/schema","@type":"PetriNet","name":"ring",
 "places":{"a":{"initial":[1],"capacity":[0],"x":100,"y":100},"b":{"initial":[0],"capacity":[0],"x":300,"y":100}},
 "transitions":{"go":{"x":200,"y":50},"back":{"x":200,"y":150}},
 "arcs":[{"source":"a","target":"go","weight":[1]},{"source":"go","target":"b","weight":[1]},
         {"source":"b","target":"back","weight":[1]},{"source":"back","target":"a","weight":[1]}]}`

// artifactCall runs pflow_artifact and returns the summary and the page.
func artifactCall(t *testing.T, args string) (map[string]any, string) {
	t.Helper()
	_, out := mcpCall(t, &Server{}, toolCall("pflow_artifact", args))
	res, _ := out["result"].(map[string]any)
	if res == nil || res["isError"] == true {
		t.Fatalf("pflow_artifact failed: %v", out)
	}
	if _, ok := res["structuredContent"]; ok {
		t.Error("the page must not travel twice (structuredContent)")
	}
	content := res["content"].([]any)
	if len(content) != 2 {
		t.Fatalf("want summary + page, got %d blocks", len(content))
	}
	var sum map[string]any
	if err := json.Unmarshal([]byte(content[0].(map[string]any)["text"].(string)), &sum); err != nil {
		t.Fatalf("summary is not JSON: %v", err)
	}
	return sum, content[1].(map[string]any)["text"].(string)
}

var reData = regexp.MustCompile(`(?s)<script type="application/json" id="pflow-data">(.*?)</script>`)

func pageData(t *testing.T, page string) map[string]any {
	t.Helper()
	m := reData.FindStringSubmatch(page)
	if m == nil {
		t.Fatal("no data blob")
	}
	var d map[string]any
	if err := json.Unmarshal([]byte(m[1]), &d); err != nil {
		t.Fatalf("data blob: %v", err)
	}
	return d
}

func philosophers3(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile("testdata/philosophers3.json")
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(b))
}

// The three philosophers deadlock: the page carries the engine's verdicts,
// the witness, the invariants and the class those verdicts earn.
func TestArtifactPhilosophersBaked(t *testing.T) {
	sum, page := artifactCall(t, `{"net":`+philosophers3(t)+`,"title":"Three philosophers"}`)
	low := strings.ToLower(page)
	for _, banned := range []string{"<!doctype", "<html", "<head>", "<head ", "<body", "<link", " src=", "fetch(", "@import"} {
		if strings.Contains(low, banned) {
			t.Errorf("page contains %q", banned)
		}
	}
	if !strings.HasPrefix(page, "<title>Three philosophers</title>") {
		t.Errorf("title: %.60q", page)
	}
	for _, want := range []string{`@media (prefers-color-scheme:dark)`, `:root[data-theme="dark"]`, `:root:not([data-theme="light"])`, "body{", "padding:16px"} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	d := pageData(t, page)
	a := d["analysis"].(map[string]any)
	if a["states"] != float64(14) || a["edges"] != float64(27) || a["deadlock_free"] != false || a["live"] != false || a["quasi_live"] != true || a["bounded"] != true {
		t.Errorf("analysis = %v", a)
	}
	w := a["witness"].(map[string]any)
	if tr, _ := json.Marshal(w["trace"]); string(tr) != `["takeL0","takeL1","takeL2"]` || w["kind"] != "deadlock" {
		t.Errorf("witness = %v", w)
	}
	if n := len(d["invariants"].([]any)); n != 6 {
		t.Errorf("%d P-invariants, want 6", n)
	}
	if _, ok := d["source"]; ok {
		t.Error("a baked page needs no source net")
	}
	if !strings.Contains(d["editor"].(string), "/?data=") || d["stored"] != false {
		t.Errorf("editor = %v", d["editor"])
	}
	classes, _ := json.Marshal(sum["classes"])
	if string(classes) != `[{"class":"PetriNet","iri":"https://ontology.pflow.xyz/ns#PetriNet"},{"class":"BoundedNet","iri":"https://ontology.pflow.xyz/ns#BoundedNet"}]` {
		t.Errorf("classes = %s", classes)
	}
	if sum["engine"] != "baked" || int(sum["html_bytes"].(float64)) != len(page) || !strings.HasPrefix(sum["cid"].(string), "z") {
		t.Errorf("summary = %v", sum)
	}
	t.Logf("baked philosophers page: %d bytes", len(page))
}

func TestArtifactLiveRing(t *testing.T) {
	sum, page := artifactCall(t, `{"net":`+artRingNet+`}`)
	classes, _ := json.Marshal(sum["classes"])
	if !strings.Contains(string(classes), `"LiveNet"`) || !strings.Contains(string(classes), `"BoundedNet"`) || strings.Contains(string(classes), "DeadlockFree") {
		t.Errorf("classes = %s", classes)
	}
	if sum["title"] != "ring" || !strings.HasPrefix(page, "<title>ring</title>") {
		t.Errorf("title from the net's name: %v", sum["title"])
	}
	if sum["witness"] != nil {
		t.Errorf("a live net has no witness: %v", sum["witness"])
	}
}

func TestOntologyClasses(t *testing.T) {
	for _, c := range []struct {
		complete           bool
		live, dlf, bounded any
		want               string
	}{
		{true, true, true, true, "LiveNet,BoundedNet"},
		{true, false, true, true, "DeadlockFreeNet,BoundedNet"},
		{true, false, false, false, "PetriNet"},
		{false, "unknown", "unknown", "unknown: the search stopped at max_states", "PetriNet"},
		{false, true, true, true, "PetriNet"}, // an incomplete search earns nothing
	} {
		if got := strings.Join(ontologyClasses(c.complete, c.live, c.dlf, c.bounded), ","); got != c.want {
			t.Errorf("%+v: %s", c, got)
		}
	}
}

// A label cannot break out of the page: it travels as JSON with < escaped and
// is set with textContent.
func TestArtifactEscapes(t *testing.T) {
	net := strings.Replace(artRingNet, `"x":100,"y":100}`, `"x":100,"y":100,"label":"</script><script>alert(1)</script>"}`, 1)
	_, page := artifactCall(t, `{"net":`+net+`,"title":"<b>x</b>"}`)
	if strings.Contains(page, "<script>alert") || strings.Contains(page, "<b>x</b>") {
		t.Error("unescaped markup in the page")
	}
	if d := pageData(t, page); d["title"] != "<b>x</b>" {
		t.Errorf("title = %v", d["title"])
	}
}

// A title or label that spells a template placeholder must come out as text,
// not be substituted into by a later placeholder.
func TestArtifactPlaceholderText(t *testing.T) {
	net := strings.Replace(artRingNet, `"x":100,"y":100}`, `"x":100,"y":100,"label":"__PFLOW_ENGINE__"}`, 1)
	_, page := artifactCall(t, `{"net":`+net+`,"title":"__PFLOW_DATA__"}`)
	if strings.Contains(page, "<title>{") {
		t.Error("the data blob was substituted into the title")
	}
	d := pageData(t, page) // fails if the data script no longer parses
	if d["title"] != "__PFLOW_DATA__" {
		t.Errorf("title = %v", d["title"])
	}
	if strings.Contains(page, `id="pflow-engine"`) {
		t.Error("an engine script was injected by a label")
	}
}

func TestArtifactRefusals(t *testing.T) {
	colored := `{"@context":"https://pflow.xyz/schema","@type":"PetriNet","token":["https://pflow.xyz/tokens/red","https://pflow.xyz/tokens/blue"],
	 "places":{"a":{"initial":[1,1],"x":0,"y":0}},"transitions":{"t":{"x":0,"y":0}},"arcs":[{"source":"a","target":"t","weight":[1,0]}]}`
	for name, args := range map[string]string{
		"engine": `{"net":` + artRingNet + `,"engine":"native"}`,
		// A coloured net is drawn from its unfolding (TestArtifactColoredNet); the
		// in-page engine reads single-colour nets only.
		"colours with the in-page engine": `{"net":` + colored + `,"engine":"wasm"}`,
		"no net":                          `{}`,
	} {
		_, out := mcpCall(t, &Server{}, toolCall("pflow_artifact", args))
		if res, _ := out["result"].(map[string]any); res == nil || res["isError"] != true {
			t.Errorf("%s: accepted: %v", name, out)
		}
	}
}

func TestArtifactEngineLock(t *testing.T) {
	var lock struct {
		SHA256 string `json:"sha256"`
		Bytes  int    `json:"bytes"`
	}
	b, err := os.ReadFile("artifact/engine.lock.json")
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(b, &lock)
	sum := sha256.Sum256(artifactEngine)
	if hex.EncodeToString(sum[:]) != lock.SHA256 || len(artifactEngine) != lock.Bytes {
		t.Errorf("artifact/engine.wasm does not match engine.lock.json")
	}
}

// The wasm-inline page embeds the engine as base64 (decoded with atob, never fetched)
// and the source net for re-analysis. With node on the path, the page's own
// script is syntax-checked and the embedded engine is run on the embedded net:
// it must agree with go-pflow's baked verdicts, which is what the page checks
// on load.
func TestArtifactWasmInline(t *testing.T) {
	sum, page := artifactCall(t, `{"net":`+philosophers3(t)+`,"engine":"wasm-inline"}`)
	if strings.Contains(page, `fetch("data:`) || !strings.Contains(page, "WebAssembly.instantiate(bytes") || !strings.Contains(page, "atob(") {
		t.Error("the engine must be decoded with atob and instantiated from bytes")
	}
	m := regexp.MustCompile(`<script type="application/octet-stream" id="pflow-engine">([A-Za-z0-9+/=]+)</script>`).FindStringSubmatch(page)
	if m == nil {
		t.Fatal("no embedded engine")
	}
	bin, err := base64.StdEncoding.DecodeString(m[1])
	if err != nil || string(bin) != string(artifactEngine) {
		t.Fatal("embedded engine is not artifact/engine.wasm")
	}
	d := pageData(t, page)
	if d["source"] == nil || d["engine"] != "wasm-inline" {
		t.Error("wasm-inline page needs the source net")
	}
	if strings.Contains(page, "<script src=") {
		t.Error("wasm-inline loads nothing")
	}
	t.Logf("wasm-inline philosophers page: %d bytes (summary says %v)", len(page), sum["html_bytes"])

	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found: page script and engine not run")
	}
	dir := t.TempDir()
	script := regexp.MustCompile(`(?s)<script>\n(.*?)</script>`).FindStringSubmatch(page)
	if script == nil {
		t.Fatal("no page script")
	}
	os.WriteFile(filepath.Join(dir, "page.js"), []byte(script[1]), 0o644)
	if out, err := exec.Command(node, "--check", filepath.Join(dir, "page.js")).CombinedOutput(); err != nil {
		t.Fatalf("page script does not parse: %v\n%s", err, out)
	}
	dataJSON, _ := json.Marshal(d)
	os.WriteFile(filepath.Join(dir, "data.json"), dataJSON, 0o644)
	os.WriteFile(filepath.Join(dir, "engine.b64"), []byte(m[1]), 0o644)
	harness := `import { readFileSync } from "node:fs";
const dir = process.argv[2];
const D = JSON.parse(readFileSync(dir + "/data.json", "utf8"));
const bytes = Uint8Array.from(atob(readFileSync(dir + "/engine.b64", "utf8")), (c) => c.charCodeAt(0));
const { instance } = await WebAssembly.instantiate(bytes, {});
const x = instance.exports, enc = new TextEncoder(), dec = new TextDecoder();
const call = (fn, req) => { const b = enc.encode(JSON.stringify(req)), p = x.alloc(b.length);
  new Uint8Array(x.memory.buffer, p, b.length).set(b);
  const r = x[fn](p, b.length), rp = Number(r >> 32n), rl = Number(r & 0xffffffffn);
  const o = JSON.parse(dec.decode(new Uint8Array(x.memory.buffer, rp, rl))); x.dealloc(rp, rl); x.dealloc(p, b.length); return o; };
const a = call("analyze", { net: D.source, max_states: D.analysis.max_states });
const g = D.analysis;
const got = { states: a.state_count, edges: a.edge_count, complete: a.complete, deadlock_free: a.deadlock_free, live: a.live, quasi_live: a.quasi_live, bounded: a.bounded, invariants: a.p_invariants.length, trace: a.witness && a.witness.trace };
const want = { states: g.states, edges: g.edges, complete: g.complete, deadlock_free: g.deadlock_free, live: g.live, quasi_live: g.quasi_live, bounded: g.bounded, invariants: D.invariants.length, trace: g.witness && g.witness.trace };
console.log(JSON.stringify({ got, want }));
process.exit(JSON.stringify(got) === JSON.stringify(want) ? 0 : 1);
`
	os.WriteFile(filepath.Join(dir, "harness.mjs"), []byte(harness), 0o644)
	if out, err := exec.Command(node, filepath.Join(dir, "harness.mjs"), dir).CombinedOutput(); err != nil {
		t.Fatalf("in-page engine disagrees with go-pflow: %v\n%s", err, out)
	}
}

// Every byte the client must copy is reported, per engine.
func TestArtifactSizes(t *testing.T) {
	_, baked := artifactCall(t, `{"net":`+philosophers3(t)+`}`)
	_, wasm := artifactCall(t, `{"net":`+philosophers3(t)+`,"engine":"wasm"}`)
	_, inline := artifactCall(t, `{"net":`+philosophers3(t)+`,"engine":"wasm-inline"}`)
	// The page template carries the graph, the views and the Explore dialog, so
	// it is bigger than the token game it began as. The budget that matters for
	// clients is the "wasm" one below.
	if len(baked) > 72<<10 {
		t.Errorf("baked page is %d bytes", len(baked))
	}
	// The point of engine "wasm": a page a chat client does not truncate.
	if len(wasm) > 80<<10 {
		t.Errorf("wasm page is %d bytes, over the 80 KB budget", len(wasm))
	}
	if len(inline) > maxArtifactResultBytes || len(inline) < len(artifactEngine) {
		t.Errorf("wasm-inline page is %d bytes", len(inline))
	}
	t.Logf("philosophers3: baked %d B, wasm %d B, wasm-inline %d B", len(baked), len(wasm), len(inline))
}

// engine "wasm" loads @pflow-xyz/engine from jsDelivr, pinned to an exact
// version with an SRI hash, before the page script and synchronously; the
// page itself carries no engine bytes.
var reExactSemver = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

func TestArtifactEngineCDNPinned(t *testing.T) {
	c := artifactCDN
	if c.Package != "@pflow-xyz/engine" || c.File == "" {
		t.Fatalf("lock names %q / %q", c.Package, c.File)
	}
	if !reExactSemver.MatchString(c.Version) {
		t.Errorf("version %q is not an exact x.y.z (never a range, a tag or latest)", c.Version)
	}
	if !strings.HasPrefix(c.Integrity, "sha384-") {
		t.Errorf("integrity %q is not an SRI sha384", c.Integrity)
	}
	sum, page := artifactCall(t, `{"net":`+philosophers3(t)+`,"engine":"wasm"}`)
	want := `<script src="https://cdn.jsdelivr.net/npm/@pflow-xyz/engine@` + c.Version + "/" + c.File + `" integrity="` + c.Integrity + `" crossorigin="anonymous"></script>`
	i, j := strings.Index(page, want), strings.Index(page, "<script>\n")
	if i < 0 {
		t.Fatalf("no pinned engine script; want %s", want)
	}
	if j < 0 || i > j {
		t.Error("the engine script must come before the page script")
	}
	if n := strings.Count(page, "<script src="); n != 1 {
		t.Errorf("the page loads %d scripts; only the engine script may load", n)
	}
	for _, bad := range []string{"@latest", "@^", "@~", `id="pflow-engine"`} {
		if strings.Contains(page, bad) {
			t.Errorf("page contains %q", bad)
		}
	}
	if sum["engine"] != "wasm" || sum["engine_script"] != artifactCDN.URL() {
		t.Errorf("summary: engine %v, engine_script %v", sum["engine"], sum["engine_script"])
	}
	d := pageData(t, page)
	if d["source"] == nil || d["engine"] != "wasm" {
		t.Error("wasm page needs the source net")
	}
	// The fallback: a missing PflowEngine keeps the baked verdicts and says so.
	if !strings.Contains(page, `typeof PflowEngine === "undefined"`) || !strings.Contains(page, "did not load") {
		t.Error("the page must fall back to the baked verdicts when the engine script does not load")
	}
	// With the built package at hand (PFLOW_ENGINE_JS=…/pflow-engine.js), its
	// bytes must be the ones the integrity hash names.
	if f := os.Getenv("PFLOW_ENGINE_JS"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		h := sha512.Sum384(b)
		if got := "sha384-" + base64.StdEncoding.EncodeToString(h[:]); got != c.Integrity {
			t.Errorf("%s is %s, the lock pins %s", f, got, c.Integrity)
		}
		node, err := exec.LookPath("node")
		if err != nil {
			t.Skip("node not found: engine script not run")
		}
		// Run it as the page does (a classic script, then PflowEngine.load()) on
		// the page's own net: it must agree with go-pflow's baked verdicts.
		tmp := t.TempDir()
		dataJSON, _ := json.Marshal(d)
		os.WriteFile(filepath.Join(tmp, "data.json"), dataJSON, 0o644)
		harness := `import { readFileSync } from "node:fs"; import vm from "node:vm";
const [js, data] = process.argv.slice(2);
const D = JSON.parse(readFileSync(data, "utf8"));
const g = { atob, Blob, Response, DecompressionStream, TextEncoder, TextDecoder, WebAssembly, BigInt, Uint8Array, JSON, Number, Promise };
g.globalThis = g; vm.createContext(g); vm.runInContext(readFileSync(js, "utf8"), g);
const e = await g.PflowEngine.load();
const a = e.analyze({ net: D.source, max_states: D.analysis.max_states }), w = D.analysis;
const got = [a.state_count, a.edge_count, a.complete, a.deadlock_free, a.live, a.quasi_live, a.bounded, a.p_invariants.length, a.witness && a.witness.trace];
const want = [w.states, w.edges, w.complete, w.deadlock_free, w.live, w.quasi_live, w.bounded, D.invariants.length, w.witness && w.witness.trace];
console.log(JSON.stringify({ got, want }));
process.exit(JSON.stringify(got) === JSON.stringify(want) ? 0 : 1);
`
		os.WriteFile(filepath.Join(tmp, "harness.mjs"), []byte(harness), 0o644)
		if out, err := exec.Command(node, filepath.Join(tmp, "harness.mjs"), f, filepath.Join(tmp, "data.json")).CombinedOutput(); err != nil {
			t.Fatalf("@pflow-xyz/engine disagrees with go-pflow: %v\n%s", err, out)
		}
	}
}

// A stored net by cid: same verdicts as passing it inline, and the editor
// link is ?cid=, not the net inline.
func TestArtifactByCID(t *testing.T) {
	dir := t.TempDir()
	s := &Server{storage: NewFSStorage(filepath.Join(dir, "store"))}
	net := philosophers3(t)
	var doc map[string]any
	json.Unmarshal([]byte(net), &doc)
	raw, _ := json.Marshal(doc)
	const cid = "zb2rhTestPhilosophers3"
	if err := s.storage.SaveObject(cid, raw, []byte("c")); err != nil {
		t.Fatal(err)
	}
	call := func(args string) (map[string]any, string, map[string]any) {
		_, out := mcpCall(t, s, toolCall("pflow_artifact", args))
		res := out["result"].(map[string]any)
		content := res["content"].([]any)
		if res["isError"] == true {
			return nil, "", map[string]any{"error": content[0].(map[string]any)["text"]}
		}
		var sum map[string]any
		json.Unmarshal([]byte(content[0].(map[string]any)["text"].(string)), &sum)
		return sum, content[1].(map[string]any)["text"].(string), nil
	}
	sum, page, e := call(`{"cid":"` + cid + `","engine":"wasm"}`)
	if e != nil {
		t.Fatalf("by cid: %v", e)
	}
	if sum["cid"] != cid || sum["stored"] != true {
		t.Errorf("summary cid %v stored %v", sum["cid"], sum["stored"])
	}
	if ed, _ := sum["editor"].(string); !strings.HasSuffix(ed, "/?cid="+cid) {
		t.Errorf("editor link %q, want ?cid=", ed)
	}
	if strings.Contains(page, "?data=") {
		t.Error("a stored net's page must not carry the net inline in the editor link")
	}
	inlineSum, _ := artifactCall(t, `{"net":`+net+`,"engine":"wasm"}`)
	a, _ := json.Marshal(sum["verdicts"])
	b, _ := json.Marshal(inlineSum["verdicts"])
	if string(a) != string(b) {
		t.Errorf("by cid %s, inline %s", a, b)
	}
	if _, _, e := call(`{"cid":"` + cid + `","net":` + net + `}`); e == nil {
		t.Error("net and cid together must be refused")
	}
	if _, _, e := call(`{"cid":"zNoSuchNet"}`); e == nil {
		t.Error("an unknown cid must be refused")
	}
	if _, _, e := call(`{}`); e == nil {
		t.Error("neither net nor cid must be refused")
	}
}

// What a page leads with is a rule over size and verdicts, not a judgement.
func TestRecommendViews(t *testing.T) {
	cases := []struct {
		name            string
		places, trans   int
		complete        bool
		bounded         any
		wantLead, first string
	}{
		{"predator and prey: two places, three transitions", 2, 3, true, true, "dynamics", "graph"},
		{"unbounded growth", 3, 4, true, false, "dynamics", "graph"},
		{"search past its budget, mid size", 20, 20, false, "unknown", "dynamics", "graph"},
		{"dining philosophers: 12 places, 9 transitions", 12, 9, true, true, "play", "game"},
		{"tic-tac-toe: 31 places, 34 transitions, search incomplete", 31, 34, false, "unknown", "analysis", "verdicts"},
	}
	for _, c := range cases {
		a := recommendViews(c.places, c.trans, c.complete, c.bounded)
		if a.Lead != c.wantLead || a.Shown[0] != c.first {
			t.Errorf("%s: lead %q first %q, want %q %q", c.name, a.Lead, a.Shown[0], c.wantLead, c.first)
		}
		if len(a.All) != len(allViews) || a.Reason == "" {
			t.Errorf("%s: every view must stay available, with a reason: %+v", c.name, a)
		}
	}
}

func TestStructuralClasses(t *testing.T) {
	_, page := artifactCall(t, `{"net":`+artRingNet+`}`)
	d := pageData(t, page)
	got, _ := json.Marshal(d["structural"])
	if string(got) != `["StateMachineNet","MarkedGraphNet","ConservativeNet"]` {
		t.Errorf("ring structural classes = %s", got)
	}
	sum, _ := artifactCall(t, `{"net":`+philosophers3(t)+`}`)
	for _, c := range sum["classes"].([]any) {
		if k := c.(map[string]any)["class"]; k == "StateMachineNet" || k == "MarkedGraphNet" {
			t.Errorf("philosophers are neither a state machine nor a marked graph, got %v", k)
		}
	}
}

// Every page exposes every view, rates travel with the net, and two arcs
// between one pair, one each way, are drawn curved.
func TestArtifactExploreAndRates(t *testing.T) {
	net := strings.Replace(artRingNet, `"go":{"x":200,"y":50}`, `"go":{"x":200,"y":50,"rate":2.5}`, 1)
	_, page := artifactCall(t, `{"net":`+net+`}`)
	for _, want := range []string{`id="pf-explore"`, `Explore this model`, `id="pf-sec-graph"`, `id="pf-view-toggles"`, `role="tablist"`, `Q${ctrl.x}`} {
		if !strings.Contains(page, want) {
			t.Errorf("page lacks %q", want)
		}
	}
	d := pageData(t, page)
	trs := d["net"].(map[string]any)["transitions"].([]any)
	rates := map[string]float64{}
	for _, x := range trs {
		m := x.(map[string]any)
		rates[m["id"].(string)] = m["rate"].(float64)
	}
	if rates["go"] != 2.5 || rates["back"] != 1 {
		t.Errorf("rates = %v, want go 2.5 and back 1 (the default)", rates)
	}
	v := d["views"].(map[string]any)
	if v["lead"] != "dynamics" || len(v["all"].([]any)) != 5 {
		t.Errorf("views = %v", v)
	}
}

// A coloured net is played as its unfolding and drawn in its colours; the
// verdicts are go-pflow's on the unfolded net. The in-page engine reads
// single-colour nets only, so engine "wasm" refuses with the reason.
func TestArtifactColoredNet(t *testing.T) {
	raw, err := os.ReadFile("../../examples/landing/coffee-shop.jsonld")
	if err != nil {
		t.Fatal(err)
	}
	sum, page := artifactCall(t, `{"net":`+string(raw)+`}`)
	d := pageData(t, page)
	cols, _ := d["colors"].([]any)
	if len(cols) != 3 || cols[0].(map[string]any)["name"] != "red" || cols[1].(map[string]any)["css"] != "brown" {
		t.Errorf("colors = %v", d["colors"])
	}
	pl := d["net"].(map[string]any)["places"].([]any)
	if len(pl) != 12 {
		t.Errorf("%d unfolded places, want 4 places x 3 colours", len(pl))
	}
	p0 := pl[0].(map[string]any)
	if p0["base"] == nil || p0["color"] == nil || p0["baseLabel"] == nil {
		t.Errorf("an unfolded place names its base place and colour: %v", p0)
	}
	classes, _ := json.Marshal(sum["classes"])
	if !strings.Contains(string(classes), `"ColoredNet"`) {
		t.Errorf("classes = %s", classes)
	}
	if sum["views"].(map[string]any)["lead"] != "dynamics" {
		t.Errorf("4 base places and 5 transitions lead with the graph: %v", sum["views"])
	}
	_, out := mcpCall(t, &Server{}, toolCall("pflow_artifact", `{"net":`+string(raw)+`,"engine":"wasm"}`))
	if b, _ := json.Marshal(out); !strings.Contains(string(b), "single-colour") {
		t.Errorf("engine wasm on a coloured net should say why not: %s", b)
	}
}
