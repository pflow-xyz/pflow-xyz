package main

import (
	"encoding/json"
	"fmt"
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

// ---- negative weights and counts past the integers

// pflow-rs never enables a transition with a negative arc weight; go-pflow
// fires it and makes tokens. The tools fire as pflow-rs does.
func TestMCPBundleNegativeWeightsNeverEnable(t *testing.T) {
	b := withArc(twoSubnets(), map[string]any{"from": "t", "to": "p", "weight": -2}) // t -> p, weight -2
	out, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": b, "script": []any{"a/t", "a/t"}})
	if err != nil {
		t.Fatal(err)
	}
	res := asJSON(t, out).(map[string]any)
	steps := res["steps"].([]any)
	if res["completed"] != false || res["stopped_at"] != float64(0) || len(steps) != 1 ||
		steps[0].(map[string]any)["why"] != "a/t: arc to/from a/p has negative weight -2" {
		t.Fatalf("%v", res)
	}
	if got := res["final_marking"].(map[string]any)["a/p"]; got != float64(4) {
		t.Errorf("p = %v; nothing fired", got)
	}
	// the flat net's initial enablement says the same
	out, err = callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": b})
	if err != nil {
		t.Fatal(err)
	}
	en := asJSON(t, out).(map[string]any)["initial_enablement"].([]any)[0].(map[string]any)
	if en["enabled"] != false || en["why"] != "a/t: arc to/from a/p has negative weight -2" {
		t.Errorf("%v", en)
	}
	// validate has nothing to say, as in native
	out, _ = callBundleTool(t, "pflow_bundle_validate", map[string]any{"bundle": b})
	if asJSON(t, out).(map[string]any)["valid"] != true {
		t.Errorf("%v", out)
	}
}

// The weights are checked in the order pflow-rs checks them: the inputs in arc
// order (each one's sign, then its tokens), then the outputs, then the read
// and inhibitor arcs.
func TestMCPBundleNegativeWeightsAreCheckedInNativeOrder(t *testing.T) {
	why := func(arcs ...map[string]any) string {
		b := twoSubnets()
		m := b["subnets"].([]any)[0].(map[string]any)["model"].(map[string]any)
		m["arcs"] = []any{}
		for _, a := range arcs {
			m["arcs"] = append(m["arcs"].([]any), a)
		}
		out, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": b, "script": []any{"a/t"}})
		if err != nil {
			t.Fatal(err)
		}
		return asJSON(t, out).(map[string]any)["steps"].([]any)[0].(map[string]any)["why"].(string)
	}
	in := func(place string, w int) map[string]any { return map[string]any{"from": place, "to": "t", "weight": w} }
	outArc := func(place string, w int) map[string]any { return map[string]any{"from": "t", "to": place, "weight": w} }
	read := func(place string, w int) map[string]any {
		return map[string]any{"from": place, "to": "t", "weight": w, "type": "read"}
	}
	for _, c := range []struct {
		name string
		arcs []map[string]any
		want string
	}{
		{"an input short of tokens comes before a later negative input", []map[string]any{in("q", 1), in("p", -3)}, "a/t needs 1 token(s) on a/q, have 0"},
		{"a negative input comes before a later input short of tokens", []map[string]any{in("p", -3), in("q", 1)}, "a/t: arc to/from a/p has negative weight -3"},
		{"an input short of tokens comes before a negative output", []map[string]any{outArc("q", -1), in("q", 1)}, "a/t needs 1 token(s) on a/q, have 0"},
		{"a negative output comes before an unsatisfied read arc", []map[string]any{read("q", 1), outArc("p", -1)}, "a/t: arc to/from a/p has negative weight -1"},
		{"a negative read arc", []map[string]any{read("p", -1)}, "a/t: arc to/from a/p has negative weight -1"},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := why(c.arcs...); got != c.want {
				t.Errorf("%q; want %q", got, c.want)
			}
		})
	}
}

// go-pflow's counts wrap around; pflow-rs' saturate at the ends of int64.
func TestMCPBundleCountsSaturate(t *testing.T) {
	// 8 output arcs of 2^52 into one place: 2^55 a firing, 2^63 after 256 of them
	var arcs []any
	for i := 0; i < 8; i++ {
		arcs = append(arcs, map[string]any{"from": "t", "to": "p", "weight": 1 << 52})
	}
	b := twoSubnets()
	b["subnets"].([]any)[0].(map[string]any)["model"].(map[string]any)["arcs"] = arcs
	script := make([]any, 300)
	for i := range script {
		script[i] = "a/t"
	}
	out, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": b, "script": script})
	if err != nil {
		t.Fatal(err)
	}
	res := out.(map[string]any)
	if got := res["final_marking"].(map[string]any)["a/p"]; got != math.MaxInt {
		t.Errorf("p = %v; want %d", got, math.MaxInt)
	}
	if res["completed"] != true {
		t.Errorf("%v", res["steps"].([]any)[len(res["steps"].([]any))-1])
	}
	// and a place already at the top does not wrap negative when it is fed
	if mbSatAdd(math.MaxInt, 1) != math.MaxInt || mbSatSub(math.MinInt, 1) != math.MinInt ||
		mbSatSub(math.MaxInt, -1) != math.MaxInt || mbSatAdd(math.MinInt, -1) != math.MinInt || mbSatAdd(5, -7) != -2 {
		t.Error("saturating arithmetic")
	}
}

// ---- one answer for one bundle

// Two event links with one id that fuse different transitions merge into one
// flat transition in go-pflow and pflow-rs; go-pflow's answer depended on the
// order of a map (four different answers in 60 calls).
func TestMCPBundleFlattenIsDeterministicWithSharedLinkIds(t *testing.T) {
	sub := func(id string, ts ...string) map[string]any {
		var trans, ports []any
		for _, tr := range ts {
			trans = append(trans, map[string]any{"id": tr, "description": "does " + tr})
			ports = append(ports, map[string]any{"id": tr, "kind": "inout", "target": "transition", "transition": tr})
		}
		return map[string]any{"id": id, "net_type": "ResourceNet", "model": map[string]any{"name": id, "places": []any{}, "transitions": trans, "arcs": []any{}}, "ports": ports}
	}
	ev := func(id, a, ap, b, bp string) map[string]any {
		return map[string]any{"kind": "event", "id": id, "from": map[string]any{"subnet": a, "port": ap}, "to": map[string]any{"subnet": b, "port": bp}}
	}
	for _, c := range []struct {
		name  string
		links []any
		group []any // the fused group "x" names
	}{
		{"two classes", []any{ev("x", "a", "t", "b", "t"), ev("x", "a", "u", "b", "v")}, []any{"a/u", "b/v"}},
		{"three classes", []any{ev("x", "a", "u", "b", "v"), ev("x", "a", "t", "b", "t"), ev("x", "c", "w", "d", "w")}, []any{"c/w", "d/w"}},
		{"the same class twice", []any{ev("x", "a", "t", "b", "t"), ev("x", "b", "t", "a", "t")}, []any{"a/t", "b/t"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			bundle := map[string]any{"subnets": []any{sub("a", "t", "u"), sub("b", "t", "v"), sub("c", "w"), sub("d", "w")}, "links": c.links}
			distinct := map[string]bool{}
			var first map[string]any
			for i := 0; i < 200; i++ {
				out, err := callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": bundle})
				if err != nil {
					t.Fatal(err)
				}
				text, _ := json.Marshal(out)
				distinct[string(text)] = true
				if first == nil {
					first = asJSON(t, out).(map[string]any)
				}
			}
			if len(distinct) != 1 {
				t.Fatalf("%d different answers in 200 calls", len(distinct))
			}
			groups := first["fused_groups"].(map[string]any)
			if fmt.Sprint(groups["x"]) != fmt.Sprint(c.group) {
				t.Errorf("fused group x = %v; want %v (the class that comes last)", groups["x"], c.group)
			}
			// the description is that class's, the warnings are one per class in class order
			for _, tr := range first["transitions"].([]any) {
				if m := tr.(map[string]any); m["id"] == "x" && !strings.Contains(m["description"].(string), "fires with: "+strings.Join(strings.Fields(strings.Trim(fmt.Sprint(c.group), "[]")), ", ")) {
					t.Errorf("description %q", m["description"])
				}
			}
			warnings := first["warnings"].([]any)
			var roots []string
			for _, w := range warnings {
				if m := w.(map[string]any); m["code"] == "W_EVENTLINK_CYCLE" {
					roots = append(roots, strings.TrimPrefix(m["message"].(string), "transitions "))
				}
			}
			for i := 1; i < len(roots); i++ {
				if roots[i-1] > roots[i] {
					t.Errorf("cycle warnings out of class order: %v", roots)
				}
			}
		})
	}
}

// ---- ports derived from exported places

// A subnet that declares no ports has one per exported place: native resolves
// an end to it, and so do the tools (candidates alone lists declared ports).
func TestMCPBundleDerivesPortsFromExportedPlaces(t *testing.T) {
	b := twoSubnets(tokenLink("a:q", "b:r"))
	for _, tool := range []string{"pflow_bundle_validate", "pflow_bundle_flatten", "pflow_bundle_incidence"} {
		out, err := callBundleTool(t, tool, map[string]any{"bundle": b})
		if err != nil {
			t.Fatalf("%s: %v", tool, err)
		}
		res := asJSON(t, out).(map[string]any)
		if res["valid"] == false || res["ok"] == false {
			t.Errorf("%s: %v", tool, res)
		}
	}
	out, _ := callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": b})
	wires, _ := asJSON(t, out).(map[string]any)["wires"].(map[string]any)
	if _, ok := wires["wire:a/q"]; !ok {
		t.Errorf("wires %v", wires)
	}
	res, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": b, "script": []any{"a/t", "b/u"}})
	if err != nil || res.(map[string]any)["completed"] != true {
		t.Errorf("run: %v %v", res, err)
	}
	// a second token link on the same pair is a duplicate, and a new one is added
	_, err = callBundleTool(t, "pflow_bundle_add_link", map[string]any{"bundle": b, "kind": "token", "from": "a:q", "to": "b:r"})
	if err == nil || !strings.HasPrefix(err.Error(), "pflow_bundle_add_link: [PAGE_DUPLICATE] already linked") {
		t.Errorf("duplicate: %v", err)
	}
	if _, err = callBundleTool(t, "pflow_bundle_add_link", map[string]any{"bundle": twoSubnets(), "kind": "token", "from": "a:q", "to": "b:r"}); err != nil {
		t.Errorf("add: %v", err)
	}
	// candidates take declared ports only, and say so
	_, err = callBundleTool(t, "pflow_bundle_candidates", map[string]any{"bundle": b, "from": "a:q"})
	if err == nil || !strings.Contains(err.Error(), `pflow_bundle_candidates: subnet "a" has no port "q". subnet "a" declares no ports, so it offers no candidates`) {
		t.Errorf("candidates: %v", err)
	}
	// the port lists a refusal gives: a subnet's own, or what to do
	_, err = callBundleTool(t, "pflow_bundle_add_link", map[string]any{"bundle": b, "kind": "token", "from": "a:nope", "to": "b:r"})
	if err == nil || !strings.Contains(err.Error(), `has no port "nope". subnet "a" has the ports "p", "q"`) {
		t.Errorf("a port that is not there: %v", err)
	}
	noExports := twoSubnets()
	for _, s := range noExports["subnets"].([]any) {
		for _, p := range s.(map[string]any)["model"].(map[string]any)["places"].([]any) {
			delete(p.(map[string]any), "exported")
		}
	}
	_, err = callBundleTool(t, "pflow_bundle_add_link", map[string]any{"bundle": noExports, "kind": "token", "from": "a:q", "to": "b:r"})
	if err == nil || !strings.Contains(err.Error(), `subnet "a" has no ports: declare them in its "ports"`) {
		t.Errorf("no ports: %v", err)
	}
	// declared ports are the subnet's boundary, as ever
	declared := twoSubnets()
	declared["subnets"].([]any)[0].(map[string]any)["ports"] = []any{map[string]any{"id": "only", "kind": "inout", "place": "p"}}
	_, err = callBundleTool(t, "pflow_bundle_add_link", map[string]any{"bundle": declared, "kind": "token", "from": "a:q", "to": "b:r"})
	if err == nil || !strings.Contains(err.Error(), `subnet "a" has the ports "only"`) {
		t.Errorf("declared: %v", err)
	}
}

// ---- every refusal names its tool

func TestMCPBundleEveryRefusalNamesItsTool(t *testing.T) {
	cafe := cafeBundle(t)
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"pflow_bundle_validate", map[string]any{}},
		{"pflow_bundle_add_link", map[string]any{"bundle": cafe, "from": "a:b", "to": "c:d"}},
		{"pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": "wire", "from": "a:b", "to": "c:d"}},
		{"pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": "token", "from": "pantry", "to": "c:d"}},
		{"pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": "token", "from": "bank:x", "to": "pantry:beans"}},
		{"pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": "token", "from": "pantry:beans", "to": "pantry:beans"}},
		{"pflow_bundle_candidates", map[string]any{"bundle": cafe}},
		{"pflow_bundle_candidates", map[string]any{"bundle": cafe, "from": "pantry"}},
		{"pflow_bundle_candidates", map[string]any{"bundle": cafe, "from": "bank:x"}},
		{"pflow_bundle_candidates", map[string]any{"bundle": cafe, "from": "pantry:oven"}},
		{"pflow_bundle_candidates", map[string]any{"bundle": cafe, "from": "pantry:beans", "prefer": "all"}},
		{"pflow_bundle_run", map[string]any{"bundle": cafe}},
		{"pflow_bundle_run", map[string]any{"bundle": cafe, "scenario": "nope"}},
		{"pflow_bundle_run", map[string]any{"bundle": cafe, "script": []any{}, "expect": []any{map[string]any{"place": "nope/x", "n": 0}}}},
		{"pflow_bundle_example", map[string]any{"instances": []any{"bank"}}},
		{"pflow_bundle_example", map[string]any{"links": map[string]any{}}},
		{"pflow_bundle_example", map[string]any{"links": []any{map[string]any{"from": "a:b", "to": "c:d"}}}},
	} {
		if _, err := callBundleTool(t, c.tool, c.args); err == nil || !strings.HasPrefix(err.Error(), c.tool+": ") {
			t.Errorf("%s %v: %v", c.tool, c.args, err)
		}
	}
}
