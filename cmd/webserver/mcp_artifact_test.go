package main

import (
	"crypto/sha256"
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
		"engine":  `{"net":` + artRingNet + `,"engine":"native"}`,
		"colours": `{"net":` + colored + `}`,
		"no net":  `{}`,
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

// The wasm page embeds the engine as base64 (decoded with atob, never fetched)
// and the source net for re-analysis. With node on the path, the page's own
// script is syntax-checked and the embedded engine is run on the embedded net:
// it must agree with go-pflow's baked verdicts, which is what the page checks
// on load.
func TestArtifactWasm(t *testing.T) {
	sum, page := artifactCall(t, `{"net":`+philosophers3(t)+`,"engine":"wasm"}`)
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
	if d["source"] == nil || d["engine"] != "wasm" {
		t.Error("wasm page needs the source net")
	}
	t.Logf("wasm philosophers page: %d bytes (summary says %v)", len(page), sum["html_bytes"])

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
	if len(baked) > 40<<10 {
		t.Errorf("baked page is %d bytes", len(baked))
	}
	if len(wasm) > maxArtifactResultBytes || len(wasm) < len(artifactEngine) {
		t.Errorf("wasm page is %d bytes", len(wasm))
	}
}
