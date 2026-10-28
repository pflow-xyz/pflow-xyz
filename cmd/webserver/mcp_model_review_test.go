package main

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// What two reviews of the composition tools found, each held: the answers
// that differed from pflow-native's, the ones that changed from call to call,
// and the arguments that were taken without a word.
// (What the tools answer, compared with native's, is mcp_models_parity_test.go;
// the cases that need a document native can read are in
// parity/native/mcp_cases.json.)

// twoSubnets is a bundle of two subnets: `a` (places p, holding 4, and q;
// transition t moves 2 from p to q) and `b` (place r and transition u, which
// takes 1 from r), with no ports declared and p, q and r exported.
func twoSubnets(links ...any) map[string]any {
	a := map[string]any{"id": "a", "net_type": "ResourceNet", "model": map[string]any{"name": "a",
		"places":      []any{map[string]any{"id": "p", "initial": 4, "exported": true}, map[string]any{"id": "q", "exported": true}},
		"transitions": []any{map[string]any{"id": "t"}},
		"arcs":        []any{map[string]any{"from": "p", "to": "t", "weight": 2}, map[string]any{"from": "t", "to": "q", "weight": 2}}}}
	b := map[string]any{"id": "b", "net_type": "ResourceNet", "model": map[string]any{"name": "b",
		"places":      []any{map[string]any{"id": "r", "initial": 0, "exported": true}},
		"transitions": []any{map[string]any{"id": "u"}},
		"arcs":        []any{map[string]any{"from": "r", "to": "u", "weight": 1}}}}
	return map[string]any{"name": "two", "subnets": []any{a, b}, "links": links}
}

func tokenLink(from, to string) map[string]any {
	f, t := strings.Split(from, ":"), strings.Split(to, ":")
	return map[string]any{"kind": "token", "from": map[string]any{"subnet": f[0], "port": f[1]}, "to": map[string]any{"subnet": t[0], "port": t[1]}}
}

// withArc returns a copy of the bundle whose subnet a has one more arc.
func withArc(b map[string]any, arc map[string]any) map[string]any {
	text, _ := json.Marshal(b)
	var c map[string]any
	json.Unmarshal(text, &c)
	m := c["subnets"].([]any)[0].(map[string]any)["model"].(map[string]any)
	m["arcs"] = append(m["arcs"].([]any), arc)
	return c
}

// ---- numbers JSON-RPC cannot carry

func TestMCPBundleRefusesNumbersJSONRPCCannotCarry(t *testing.T) {
	set := func(initial any) map[string]any {
		b := twoSubnets()
		b["subnets"].([]any)[0].(map[string]any)["model"].(map[string]any)["places"].([]any)[0].(map[string]any)["initial"] = initial
		return b
	}
	for _, c := range []struct {
		name    string
		initial any
		want    string
	}{
		{"2^53", float64(1 << 53), "subnets[0].model.places[0].initial is 9007199254740992; a count or weight is at most 9007199254740991"},
		{"max int64", float64(math.MaxInt64), "subnets[0].model.places[0].initial is 9223372036854775808"},
		{"negative", float64(-(1 << 53)), "initial is -9007199254740992"},
	} {
		t.Run(c.name, func(t *testing.T) {
			for tool := range bundleHandlers {
				if tool == "pflow_bundle_example" {
					continue
				}
				args := map[string]any{"bundle": set(c.initial)}
				switch tool {
				case "pflow_bundle_add_link":
					args["kind"], args["from"], args["to"] = "token", "a:p", "b:r"
				case "pflow_bundle_candidates":
					args["from"] = "a:p"
				case "pflow_bundle_run":
					args["script"] = []any{}
				}
				if _, err := callBundleTool(t, tool, args); err == nil || !strings.Contains(err.Error(), c.want) {
					t.Errorf("%s: %v; want one containing %q", tool, err, c.want)
				}
			}
		})
	}
	// the largest exact one is taken, and kept exactly
	out, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": set(float64(1<<53 - 1)), "script": []any{}})
	if err != nil {
		t.Fatal(err)
	}
	if got := out.(map[string]any)["final_marking"].(map[string]any)["a/p"]; got != 1<<53-1 {
		t.Errorf("p = %v", got)
	}
	// 9007199254740993 arrives from a client as 9007199254740992: the number that
	// was sent cannot be told, so the number that arrived is refused
	text, _ := json.Marshal(twoSubnets())
	raw := strings.Replace(string(text), `"initial":4`, `"initial":9007199254740993`, 1)
	_, res := mcpCall(t, &Server{}, toolCall("pflow_bundle_validate", `{"bundle":`+raw+`}`))
	got := res["result"].(map[string]any)
	if got["isError"] != true || !strings.Contains(got["content"].([]any)[0].(map[string]any)["text"].(string), "is 9007199254740992") {
		t.Errorf("%v", got)
	}
	// an expectation is held to it too
	if _, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": twoSubnets(), "script": []any{}, "expect": []any{map[string]any{"place": "a/p", "n": float64(1 << 53)}}}); err == nil || !strings.Contains(err.Error(), "expect[0]") {
		t.Errorf("expect: %v", err)
	}
}

// ---- names for kinds

func TestMCPBundleRefusesMisspeltKinds(t *testing.T) {
	edit := func(f func(b map[string]any)) map[string]any {
		b := twoSubnets(tokenLink("a:q", "b:r"))
		f(b)
		return b
	}
	sub := func(b map[string]any, i int) map[string]any { return b["subnets"].([]any)[i].(map[string]any) }
	for _, c := range []struct {
		name string
		b    map[string]any
		want string
	}{
		{"arc_merge avg", edit(func(b map[string]any) { b["arc_merge"] = "avg" }), `bundle.arc_merge is "avg"; it is one of "sum", "max"`},
		{"arc_merge min", edit(func(b map[string]any) { b["arc_merge"] = "min" }), `bundle.arc_merge is "min"`},
		{"arc_merge a number", edit(func(b map[string]any) { b["arc_merge"] = 1 }), `bundle.arc_merge is 1`},
		{"net_type", edit(func(b map[string]any) { sub(b, 1)["net_type"] = "ResourceNe" }), `subnets[1].net_type is "ResourceNe"`},
		{"place kind", edit(func(b map[string]any) {
			sub(b, 0)["model"].(map[string]any)["places"].([]any)[1].(map[string]any)["kind"] = "tokn"
		}), `subnets[0].model.places[1].kind is "tokn"; it is one of "token", "data"`},
		{"port kind", edit(func(b map[string]any) {
			sub(b, 0)["ports"] = []any{map[string]any{"id": "q", "kind": "sideways", "place": "q"}}
		}), `subnets[0].ports[0].kind is "sideways"; it is one of "in", "out", "inout", "observe"`},
		{"port target", edit(func(b map[string]any) {
			sub(b, 0)["ports"] = []any{map[string]any{"id": "t", "kind": "inout", "target": "transiton", "transition": "t"}}
		}), `subnets[0].ports[0].target is "transiton"`},
		{"link kind", edit(func(b map[string]any) { b["links"].([]any)[0].(map[string]any)["kind"] = "tokn" }), `links[0].kind is "tokn"; it is one of "token", "data", "event", "guard"`},
	} {
		t.Run(c.name, func(t *testing.T) {
			for _, tool := range []string{"pflow_bundle_validate", "pflow_bundle_flatten", "pflow_bundle_incidence"} {
				if _, err := callBundleTool(t, tool, map[string]any{"bundle": c.b}); err == nil || !strings.Contains(err.Error(), c.want) {
					t.Errorf("%s: %v; want one containing %q", tool, err, c.want)
				}
			}
		})
	}
	// the right spellings, and no spelling at all, are taken
	b := edit(func(b map[string]any) {
		b["arc_merge"] = "max"
		sub(b, 0)["net_type"] = ""
		sub(b, 0)["ports"] = []any{map[string]any{"id": "q", "kind": "inout", "target": "place", "place": "q"}}
		sub(b, 1)["model"].(map[string]any)["places"].([]any)[0].(map[string]any)["kind"] = "data"
	})
	if out, err := callBundleTool(t, "pflow_bundle_validate", map[string]any{"bundle": b}); err != nil {
		t.Errorf("%v %v", out, err)
	}
}
