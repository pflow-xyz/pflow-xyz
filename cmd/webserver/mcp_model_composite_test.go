package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pflow-xyz/go-pflow/composite"
)

// The composition tools that read a composite as a net and judge its glue
// (mcp_model_composite.go): what they list, what they refuse, and that a
// composite flows through the other pflow_* tools. What they answer is
// go-pflow's composite package's to hold to pflow-rs (its testdata golden);
// here that golden is replayed over the server's CID sealer.

var compositeToolNames = []string{"pflow_bundle_net", "pflow_bundle_prove", "pflow_bundle_check_proof", "pflow_bundle_parts"}

func partsBundle(t *testing.T, instances []any, links ...any) map[string]any {
	t.Helper()
	out, errText := bundleRPC(t, "pflow_bundle_parts", map[string]any{"instances": instances, "links": links})
	if errText != "" {
		t.Fatal(errText)
	}
	return out["bundle"].(map[string]any)
}

func partInst(pairs ...string) []any {
	var out []any
	for i := 0; i < len(pairs); i += 2 {
		out = append(out, map[string]any{"id": pairs[i], "part": pairs[i+1]})
	}
	return out
}

func partLink(kind, fs, fp, ts, tp string) map[string]any {
	return map[string]any{"kind": kind, "from": map[string]any{"subnet": fs, "port": fp}, "to": map[string]any{"subnet": ts, "port": tp}}
}

func defaultComposite(t *testing.T) map[string]any {
	return partsBundle(t, partInst("orders", "queue", "workers", "resource-pool", "payment", "saga"),
		partLink("event", "orders", "dequeue", "workers", "acquire"),
		partLink("event", "orders", "dequeue", "payment", "do:reserve"),
		partLink("event", "workers", "release", "payment", "commit"))
}

func TestMCPCompositeToolsAreListedAndAnnotated(t *testing.T) {
	_, out := mcpCall(t, &Server{}, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	listed := map[string]map[string]any{}
	for _, raw := range out["result"].(map[string]any)["tools"].([]any) {
		tool := raw.(map[string]any)
		listed[tool["name"].(string)] = tool
	}
	for _, name := range compositeToolNames {
		tool, ok := listed[name]
		if !ok {
			t.Errorf("%s is not listed", name)
			continue
		}
		a := tool["annotations"].(map[string]any)
		if a["readOnlyHint"] != true || a["destructiveHint"] != false || a["idempotentHint"] != true || a["openWorldHint"] != false {
			t.Errorf("%s: annotations %v", name, a)
		}
		if tool["title"] == "" || tool["title"] == name {
			t.Errorf("%s: no title", name)
		}
		desc, _ := tool["description"].(string)
		if len(desc) < 200 {
			t.Errorf("%s: description %q", name, desc)
		}
		if name != "pflow_bundle_parts" && !strings.Contains(desc, "pflow_") {
			t.Errorf("%s: the description does not say how it relates to the other tools", name)
		}
	}
	// a composite is said to load in the other net tools
	for _, name := range []string{"pflow_bundle_net", "pflow_bundle_prove"} {
		if d := listed[name]["description"].(string); !strings.Contains(d, "other pflow_*") && !strings.Contains(d, "other net tools") {
			t.Errorf("%s: does not say the flat net loads in the other net tools", name)
		}
	}
	req := func(name string) []any {
		r, _ := listed[name]["inputSchema"].(map[string]any)["required"].([]any)
		return r
	}
	if len(req("pflow_bundle_parts")) != 0 || len(req("pflow_bundle_check_proof")) != 2 || len(req("pflow_bundle_net")) != 1 {
		t.Errorf("required: parts %v, check_proof %v, net %v", req("pflow_bundle_parts"), req("pflow_bundle_check_proof"), req("pflow_bundle_net"))
	}
}

// A composite goes through the other tools: pflow_bundle_net's net is read by
// the net tools, which agree with the composite.
func TestMCPCompositeNetLoadsInTheNetTools(t *testing.T) {
	b := defaultComposite(t)
	n, errText := bundleRPC(t, "pflow_bundle_net", map[string]any{"bundle": b})
	if errText != "" || n["ok"] != true {
		t.Fatalf("net: %v %s", n, errText)
	}
	net := n["net"]
	if n["places"].(float64) != 21 || n["transitions"].(float64) != 9 {
		t.Fatalf("%v places, %v transitions", n["places"], n["transitions"])
	}
	for _, tool := range []string{"pflow_check", "pflow_info", "pflow_invariants", "pflow_incidence", "pflow_validate", "pflow_cid", "pflow_export"} {
		if _, errText := bundleRPC(t, tool, map[string]any{"net": net}); errText != "" {
			t.Errorf("%s cannot read the composite: %s", tool, errText)
		}
	}
	v, errText := bundleRPC(t, "pflow_verify", map[string]any{"net": net, "properties": []any{map[string]any{"kind": "bounded"}}})
	if errText != "" || v["verdicts"].([]any)[0].(map[string]any)["status"] != "proved" {
		t.Fatalf("verify: %v %s", v, errText)
	}
	// the net's CID is the CID the proof names
	cid, errText := bundleRPC(t, "pflow_cid", map[string]any{"net": net})
	if errText != "" {
		t.Fatal(errText)
	}
	p, errText := bundleRPC(t, "pflow_bundle_prove", map[string]any{"bundle": b})
	if errText != "" {
		t.Fatal(errText)
	}
	if got := p["composite"].(map[string]any)["cid"]; got != cid["cid"] {
		t.Fatalf("the proof names %v, pflow_cid says %v", got, cid["cid"])
	}
	// the net tools see the same state space the proof searched
	r, errText := bundleRPC(t, "pflow_reachability", map[string]any{"net": net})
	if errText != "" || r["states"] != p["search"].(map[string]any)["states"] {
		t.Fatalf("reachability %v vs %v (%s)", r["states"], p["search"].(map[string]any)["states"], errText)
	}
}

func TestMCPCompositeProveAndCheck(t *testing.T) {
	b := defaultComposite(t)
	p, errText := bundleRPC(t, "pflow_bundle_prove", map[string]any{"bundle": b})
	if errText != "" || p["type"] != "CompositionProof" || p["verdict"].(map[string]any)["status"] != "consistent" {
		t.Fatalf("prove: %v %s", p["verdict"], errText)
	}
	c, errText := bundleRPC(t, "pflow_bundle_check_proof", map[string]any{"bundle": b, "proof": p})
	if errText != "" || c["valid"] != true {
		t.Fatalf("check: %v %s", c["failed"], errText)
	}
	// tampered: a bound on a vector that is not an invariant
	text, _ := json.Marshal(p)
	var bad map[string]any
	json.Unmarshal(text, &bad)
	bad["claims"].([]any)[0].(map[string]any)["certificate"].(map[string]any)["z"].(map[string]any)["orders/items"] = 5
	c, errText = bundleRPC(t, "pflow_bundle_check_proof", map[string]any{"bundle": b, "proof": bad})
	if errText != "" || c["valid"] != false {
		t.Fatalf("a tampered record checked: %v %s", c["valid"], errText)
	}
	// two queues fused: a declared law breaks, explained, with a counterexample
	two := partsBundle(t, partInst("a", "queue", "b", "queue"), partLink("token", "a", "out", "b", "in"))
	p, errText = bundleRPC(t, "pflow_bundle_prove", map[string]any{"bundle": two})
	if errText != "" || p["verdict"].(map[string]any)["status"] != "needs_attention" {
		t.Fatalf("%v %s", p["verdict"], errText)
	}
	// a search that stops proves nothing
	p, errText = bundleRPC(t, "pflow_bundle_prove", map[string]any{"bundle": b, "max_states": 5})
	if errText != "" || p["search"].(map[string]any)["complete"] != false {
		t.Fatalf("%v %s", p["search"], errText)
	}
	for _, cl := range p["claims"].([]any) {
		if m := cl.(map[string]any); strings.Contains(m["method"].(string), "search") && m["status"] == "proved" {
			t.Errorf("proved by a search that stopped: %v", m)
		}
	}
}

func TestMCPCompositeRefusals(t *testing.T) {
	b := defaultComposite(t)
	guarded := defaultComposite(t)
	guarded["subnets"].([]any)[0].(map[string]any)["model"].(map[string]any)["transitions"].([]any)[0].(map[string]any)["guard"] = "1 == 1"
	for _, c := range []struct {
		tool string
		args map[string]any
		want string
	}{
		{"pflow_bundle_prove", map[string]any{"bundle": b, "max_states": 0}, "max_states"},
		{"pflow_bundle_prove", map[string]any{"bundle": b, "max_states": 20001}, "max_states"},
		{"pflow_bundle_prove", map[string]any{"bundle": b, "nope": 1}, "unknown argument"},
		{"pflow_bundle_prove", map[string]any{"bundle": b, "ablate": "yes"}, "boolean"},
		{"pflow_bundle_prove", map[string]any{}, "bundle"},
		{"pflow_bundle_prove", map[string]any{"bundle": guarded}, "cannot read"},
		{"pflow_bundle_check_proof", map[string]any{"bundle": b}, "proof"},
		{"pflow_bundle_check_proof", map[string]any{"bundle": b, "proof": map[string]any{"type": "other"}}, "CompositionProof"},
		{"pflow_bundle_net", map[string]any{"bundle": map[string]any{"subnets": []any{}}}, "subnets"},
		{"pflow_bundle_parts", map[string]any{"instances": []any{map[string]any{"part": "nope"}}}, "no part"},
		{"pflow_bundle_parts", map[string]any{"instances": []any{map[string]any{"part": "queue", "params": map[string]any{"capacity": 99}}}}, "capacity"},
		{"pflow_bundle_parts", map[string]any{"links": "x"}, "array"},
		{"pflow_bundle_parts", map[string]any{"nope": 1}, "unknown argument"},
	} {
		_, errText := bundleRPC(t, c.tool, c.args)
		if !strings.Contains(errText, c.want) {
			t.Errorf("%s %v: %q does not mention %q", c.tool, c.args, errText, c.want)
		}
	}
	// a net with a guard is answered, not dropped
	n, errText := bundleRPC(t, "pflow_bundle_net", map[string]any{"bundle": guarded})
	if errText != "" || n["ok"] != false || n["net"] != nil || n["unrepresentable"] == nil {
		t.Fatalf("%v %s", n, errText)
	}
	// the catalog
	cat, errText := bundleRPC(t, "pflow_bundle_parts", map[string]any{})
	if errText != "" || len(cat["parts"].([]any)) != 13 {
		t.Fatalf("%v %s", cat, errText)
	}
}

// A record too big for the result limit is answered by its summary, saying so.
func TestMCPCompositeProveSummarisesARecordOverTheLimit(t *testing.T) {
	var inst []any
	for _, id := range []string{"s1", "s2", "s3", "s4", "s5", "s6"} {
		inst = append(inst, map[string]any{"id": id, "part": "saga"})
	}
	b := partsBundle(t, inst)
	rec, err := composite.Call("pflow_bundle_prove", map[string]any{"bundle": b, "ablate": false})
	if err != nil {
		t.Fatal(err)
	}
	if n := encodedLen(rec); n <= mcpMaxResultBytes {
		t.Skipf("the record is %d bytes, under the limit", n)
	}
	p, errText := bundleRPC(t, "pflow_bundle_prove", map[string]any{"bundle": b, "ablate": false})
	if errText != "" {
		t.Fatal(errText)
	}
	if p["record_omitted"] != true || p["truncated"] != nil || p["verdict"] == nil || p["claims"] == nil {
		t.Fatalf("%v", p)
	}
	if n := encodedLen(p); n > mcpMaxResultBytes {
		t.Fatalf("the summary is %d bytes", n)
	}
}

// internal/seal (json-gold) and composite's own sealer agree on every composite
// pflow-rs's golden holds, and on its CIDs.
func TestMCPCompositeSealersAgreeOnTheGolden(t *testing.T) {
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/pflow-xyz/go-pflow").Output()
	if err != nil {
		t.Skipf("go list: %v", err)
	}
	path := filepath.Join(strings.TrimSpace(string(out)), "composite", "testdata", "composite.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("no golden at %s: %v", path, err)
	}
	var g struct {
		Cases []struct {
			Name   string
			Net    map[string]any
			Bundle map[string]any
			Prove  map[string]any
		}
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) == 0 {
		t.Fatal("no cases")
	}
	for _, c := range g.Cases {
		want := c.Prove["composite"].(map[string]any)["cid"]
		net := c.Net["net"].(map[string]any)
		hosted, err := composite.Sealer(net)
		if err != nil || hosted != want {
			t.Errorf("%s: internal/seal says %q (%v), pflow-rs %v", c.Name, hosted, err, want)
		}
		own, err := composite.SealNet(net)
		if err != nil || own != want {
			t.Errorf("%s: composite.SealNet says %q (%v), pflow-rs %v", c.Name, own, err, want)
		}
		// and this server's tool answers the golden
		p, errText := bundleRPC(t, "pflow_bundle_prove", map[string]any{"bundle": c.Bundle})
		if errText != "" {
			t.Fatalf("%s: %s", c.Name, errText)
		}
		if got := p["composite"].(map[string]any)["cid"]; got != want {
			t.Errorf("%s: the tool names %v, pflow-rs %v", c.Name, got, want)
		}
		chk, errText := bundleRPC(t, "pflow_bundle_check_proof", map[string]any{"bundle": c.Bundle, "proof": c.Prove})
		if errText != "" || chk["valid"] != true {
			t.Errorf("%s: pflow-rs's record does not check: %v %s", c.Name, chk["failed"], errText)
		}
	}
}
