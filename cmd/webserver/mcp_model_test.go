package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// The composition tools' own behaviour: what they list, what they refuse, what
// bounds them. What they answer, compared with pflow-native, is
// mcp_models_parity_test.go.

func readBundle(t *testing.T, path string) map[string]any {
	t.Helper()
	var b map[string]any
	loadJSON(t, path, &b)
	return b
}

func cafeBundle(t *testing.T) map[string]any {
	return readBundle(t, "../../examples/showcase/cafe.bundle.json")
}

// exampleBundle is the default composition, as pflow_bundle_example builds it.
func exampleBundle(t *testing.T, args map[string]any) map[string]any {
	t.Helper()
	out, err := callBundleTool(t, "pflow_bundle_example", args)
	if err != nil {
		t.Fatal(err)
	}
	return asJSON(t, out).(map[string]any)["bundle"].(map[string]any)
}

func bundleRPC(t *testing.T, name string, args map[string]any) (map[string]any, string) {
	t.Helper()
	text, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	_, out := mcpCall(t, &Server{}, toolCall(name, string(text)))
	res, _ := out["result"].(map[string]any)
	if res == nil {
		t.Fatalf("%s: no result: %v", name, out)
	}
	if res["isError"] == true {
		return nil, res["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	return res["structuredContent"].(map[string]any), ""
}

func TestMCPBundleToolsAreListed(t *testing.T) {
	_, out := mcpCall(t, &Server{}, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	listed := map[string]map[string]any{}
	for _, raw := range out["result"].(map[string]any)["tools"].([]any) {
		tool := raw.(map[string]any)
		listed[tool["name"].(string)] = tool
	}
	for name := range bundleHandlers {
		tool, ok := listed[name]
		if !ok {
			t.Errorf("%s is not listed", name)
			continue
		}
		a := tool["annotations"].(map[string]any)
		if a["readOnlyHint"] != true || a["destructiveHint"] != false || a["idempotentHint"] != true || a["openWorldHint"] != false {
			t.Errorf("%s: annotations %v; a tool that stores nothing is read-only, idempotent and closed-world", name, a)
		}
		if tool["title"] == "" || tool["title"] == name {
			t.Errorf("%s: no title", name)
		}
		schema := tool["inputSchema"].(map[string]any)
		if schema["type"] != "object" {
			t.Errorf("%s: schema %v", name, schema)
		}
		req, _ := schema["required"].([]any)
		hasBundle := false
		for _, r := range req {
			hasBundle = hasBundle || r == "bundle"
		}
		if name != "pflow_bundle_example" && !hasBundle {
			t.Errorf("%s: bundle is not required", name)
		}
		if desc, _ := tool["description"].(string); len(desc) < 80 {
			t.Errorf("%s: description %q", name, desc)
		}
	}
	if len(listed) < len(bundleHandlers) {
		t.Errorf("%d tools listed", len(listed))
	}
	// none of them needs a sign-in: they are listed to an anonymous connection
	if _, ok := listed["pflow_save"]; ok {
		t.Error("pflow_save is listed without a token")
	}
}

func TestMCPBundleToolsOverRPC(t *testing.T) {
	ex, errText := bundleRPC(t, "pflow_bundle_example", map[string]any{})
	if errText != "" {
		t.Fatal(errText)
	}
	bundle := ex["bundle"]
	if got := len(ex["scenarios"].([]any)); got != 4 {
		t.Fatalf("%d scenarios", got)
	}
	v, errText := bundleRPC(t, "pflow_bundle_validate", map[string]any{"bundle": bundle})
	if errText != "" || v["valid"] != true {
		t.Fatalf("validate: %v %s", v, errText)
	}
	f, errText := bundleRPC(t, "pflow_bundle_flatten", map[string]any{"bundle": bundle})
	if errText != "" || f["ok"] != true {
		t.Fatalf("flatten: %v %s", f, errText)
	}
	run, errText := bundleRPC(t, "pflow_bundle_run", map[string]any{"bundle": bundle, "scenario": "commit"})
	if errText != "" || run["completed"] != true {
		t.Fatalf("run: %v %s", run, errText)
	}
	for _, e := range run["expect"].([]any) {
		if e.(map[string]any)["pass"] != true {
			t.Errorf("commit: %v", e)
		}
	}
	c, errText := bundleRPC(t, "pflow_bundle_candidates", map[string]any{"bundle": bundle, "from": "orders:dequeue"})
	if errText != "" || c["lit"].(float64) < 1 || c["prefer"] != "auto" || len(c["candidates"].([]any)) != 20 {
		t.Fatalf("candidates: lit %v of %d, %s", c["lit"], len(c["candidates"].([]any)), errText)
	}
	// a legal, new link: the answer carries the links with it appended
	a, errText := bundleRPC(t, "pflow_bundle_add_link", map[string]any{"bundle": bundle, "kind": "event", "from": "orders:enqueue", "to": "workers:release"})
	if errText != "" || a["index"] != float64(3) || len(a["links"].([]any)) != 4 {
		t.Fatalf("add_link: %v %s", a, errText)
	}
	// and a refused one is an error of the call listing each reason
	_, errText = bundleRPC(t, "pflow_bundle_add_link", map[string]any{"bundle": bundle, "kind": "event", "from": "orders:dequeue", "to": "workers:acquire"})
	if errText != "[PAGE_DUPLICATE] already linked" {
		t.Fatalf("duplicate: %q", errText)
	}
	inc, errText := bundleRPC(t, "pflow_bundle_incidence", map[string]any{"bundle": bundle})
	if errText != "" || inc["ok"] != true || len(inc["invariants"].([]any)) == 0 {
		t.Fatalf("incidence: %v %s", inc, errText)
	}
	for _, i := range inc["invariants"].([]any) {
		if i.(map[string]any)["holds"] != true {
			t.Errorf("a declared constraint of the example does not hold: %v", i)
		}
	}
}

// The tools take the bundle from the call and put nothing back: the same call
// gives the same answer, and the bundle the caller sent is not touched.
func TestMCPBundleToolsAreStatelessAndDeterministic(t *testing.T) {
	cafe := cafeBundle(t)
	before, _ := json.Marshal(cafe)
	for _, call := range []struct {
		tool string
		args map[string]any
	}{
		{"pflow_bundle_validate", nil}, {"pflow_bundle_flatten", nil}, {"pflow_bundle_incidence", nil},
		{"pflow_bundle_run", map[string]any{"script": []any{"counter/order", "counter/order", "counter/start_espresso"}}},
		{"pflow_bundle_candidates", map[string]any{"from": "pantry:beans"}},
		{"pflow_bundle_add_link", map[string]any{"kind": "token", "from": "pantry:beans", "to": "pantry:beans"}},
	} {
		args := map[string]any{"bundle": cafe}
		for k, v := range call.args {
			args[k] = v
		}
		var first string
		for i := 0; i < 40; i++ { // go-pflow lists some things in map order; the answer must not
			out, err := callBundleTool(t, call.tool, args)
			text := fmt.Sprint(err)
			if err == nil {
				b, _ := json.Marshal(out)
				text = string(b)
			}
			if i == 0 {
				first = text
			} else if text != first {
				t.Fatalf("%s: call %d differs from the first:\n%s\n%s", call.tool, i, text, first)
			}
		}
	}
	after, _ := json.Marshal(cafe)
	if string(before) != string(after) {
		t.Error("a tool changed the bundle it was given")
	}
}

// Nothing here names a composition by content id.
func TestMCPBundleToolsMintNoCIDs(t *testing.T) {
	bundle := exampleBundle(t, map[string]any{})
	ex, _ := callBundleTool(t, "pflow_bundle_example", map[string]any{})
	texts := []string{fmt.Sprint(mustJSON(t, ex))}
	for tool := range bundleHandlers {
		if tool == "pflow_bundle_example" {
			continue
		}
		args := map[string]any{"bundle": bundle}
		switch tool {
		case "pflow_bundle_add_link":
			args["kind"], args["from"], args["to"] = "event", "orders:enqueue", "workers:release"
		case "pflow_bundle_candidates":
			args["from"] = "orders:dequeue"
		case "pflow_bundle_run":
			args["scenario"] = "commit"
		}
		out, err := callBundleTool(t, tool, args)
		if err != nil {
			t.Fatalf("%s: %v", tool, err)
		}
		texts = append(texts, mustJSON(t, out))
	}
	for _, text := range texts {
		for _, banned := range []string{`"cid"`, `"@id"`, "bafy", "z4EBG", "ipfs"} {
			if strings.Contains(text, banned) {
				t.Errorf("an answer contains %s: %.200s", banned, text)
			}
		}
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestMCPBundleRefusesBadArguments(t *testing.T) {
	cafe := cafeBundle(t)
	for _, c := range []struct {
		name string
		tool string
		args map[string]any
		want string
	}{
		{"no bundle", "pflow_bundle_validate", map[string]any{}, "a PetriNetBundle"},
		{"bundle is a string", "pflow_bundle_flatten", map[string]any{"bundle": "cafe"}, "a PetriNetBundle"},
		{"bundle is a list", "pflow_bundle_incidence", map[string]any{"bundle": []any{}}, "a PetriNetBundle"},
		{"a net is not a bundle", "pflow_bundle_validate", map[string]any{"bundle": map[string]any{"@type": "PetriNet", "places": map[string]any{}}}, `@type is "PetriNet"`},
		{"no subnets", "pflow_bundle_validate", map[string]any{"bundle": map[string]any{"@type": "PetriNetBundle", "name": "x"}}, `non-empty "subnets"`},
		{"empty subnets", "pflow_bundle_validate", map[string]any{"bundle": map[string]any{"subnets": []any{}}}, `non-empty "subnets"`},
		{"subnets is an object", "pflow_bundle_validate", map[string]any{"bundle": map[string]any{"subnets": map[string]any{}}}, `non-empty "subnets"`},
		{"subnet is a number", "pflow_bundle_validate", map[string]any{"bundle": map[string]any{"subnets": []any{3}}}, "pflow_bundle_validate: bundle:"},
		{"fractional tokens", "pflow_bundle_validate", map[string]any{"bundle": map[string]any{"subnets": []any{map[string]any{"id": "a", "model": map[string]any{"places": []any{map[string]any{"id": "p", "initial": 1.5}}}}}}}, "bundle:"},
		{"unknown argument", "pflow_bundle_validate", map[string]any{"bundle": cafe, "strict": true}, `unknown argument "strict"`},
		{"kind is a number", "pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": 3, "from": "a:b", "to": "c:d"}, `argument "kind" should be a string`},
		{"no kind", "pflow_bundle_add_link", map[string]any{"bundle": cafe, "from": "a:b", "to": "c:d"}, `missing argument "kind"`},
		{"no from", "pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": "token", "to": "c:d"}, `missing argument "from"`},
		{"no to", "pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": "token", "from": "c:d"}, `missing argument "to"`},
		{"endpoint is a number", "pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": "token", "from": 3, "to": "c:d"}, "an endpoint is"},
		{"endpoint without a port", "pflow_bundle_candidates", map[string]any{"bundle": cafe, "from": "pantry"}, `is not "subnet:port"`},
		{"no from at all", "pflow_bundle_candidates", map[string]any{"bundle": cafe}, `missing argument "from"`},
		{"unknown subnet", "pflow_bundle_candidates", map[string]any{"bundle": cafe, "from": "bank:out"}, `no subnet "bank"`},
		{"unknown port", "pflow_bundle_candidates", map[string]any{"bundle": cafe, "from": "pantry:oven"}, `has no port "oven"`},
		{"prefer is not a kind", "pflow_bundle_candidates", map[string]any{"bundle": cafe, "from": "pantry:beans", "prefer": "all"}, "unknown link kind"},
		{"unknown subnet in a link", "pflow_bundle_add_link", map[string]any{"bundle": cafe, "kind": "data", "from": "bank:out", "to": "pantry:beans"}, "E_BAD_ENDPOINT"},
		{"neither script nor scenario", "pflow_bundle_run", map[string]any{"bundle": cafe}, "pass `scenario` or `script`"},
		{"both script and scenario", "pflow_bundle_run", map[string]any{"bundle": cafe, "scenario": "commit", "script": []any{"counter/order"}}, "pass `scenario` or `script`"},
		{"unknown scenario", "pflow_bundle_run", map[string]any{"bundle": cafe, "scenario": "brunch"}, `no scenario "brunch"; there are ["commit", "refund", "charge-fails", "second-order"]`},
		{"script of numbers", "pflow_bundle_run", map[string]any{"bundle": cafe, "script": []any{1, 2}}, `argument "script" should be a list of strings`},
		{"expect with a scenario", "pflow_bundle_run", map[string]any{"bundle": cafe, "scenario": "commit", "expect": []any{}}, "goes with `script`"},
		{"expect is not a list", "pflow_bundle_run", map[string]any{"bundle": cafe, "script": []any{}, "expect": "all"}, "expect should be a list"},
		{"expect without a place", "pflow_bundle_run", map[string]any{"bundle": cafe, "script": []any{}, "expect": []any{map[string]any{"n": 1}}}, "expect[0]"},
		{"expect with a fractional n", "pflow_bundle_run", map[string]any{"bundle": cafe, "script": []any{}, "expect": []any{map[string]any{"place": "counter/done", "n": 1.5}}}, "expect[0]"},
		{"expect with an operator", "pflow_bundle_run", map[string]any{"bundle": cafe, "script": []any{}, "expect": []any{map[string]any{"place": "counter/done", "n": 1, "op": ">="}}}, `unknown field "op"`},
		{"example: unknown instance", "pflow_bundle_example", map[string]any{"instances": []any{"bank"}}, `no instance "bank"; the catalog has ["orders", "workers", "payment", "payment2", "orders2", "workers2"]`},
		{"example: links is an object", "pflow_bundle_example", map[string]any{"links": map[string]any{}}, "links must be an array"},
		{"example: a link without a kind", "pflow_bundle_example", map[string]any{"links": []any{map[string]any{"from": "a:b", "to": "c:d"}}}, `has no "kind"`},
		{"example: instances are numbers", "pflow_bundle_example", map[string]any{"instances": []any{1}}, `should be a list of strings`},
	} {
		t.Run(c.name, func(t *testing.T) {
			out, err := callBundleTool(t, c.tool, c.args)
			if err == nil {
				t.Fatalf("answered: %s", mustJSON(t, out))
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %q does not contain %q", err, c.want)
			}
		})
	}
}

// The counts a bundle is held to, each refused before any engine runs.
func TestMCPBundleRefusesHugeBundles(t *testing.T) {
	net := func(id string, places, transitions, arcs int) map[string]any {
		var ps, ts, as []any
		for i := 0; i < places; i++ {
			ps = append(ps, map[string]any{"id": fmt.Sprintf("p%d", i), "initial": 1})
		}
		for i := 0; i < transitions; i++ {
			ts = append(ts, map[string]any{"id": fmt.Sprintf("t%d", i)})
		}
		for i := 0; i < arcs; i++ {
			as = append(as, map[string]any{"from": "p0", "to": "t0"})
		}
		return map[string]any{"id": id, "net_type": "ResourceNet", "model": map[string]any{"name": id, "places": ps, "transitions": ts, "arcs": as}}
	}
	many := func(n int, f func(i int) map[string]any) []any {
		var out []any
		for i := 0; i < n; i++ {
			out = append(out, f(i))
		}
		return out
	}
	subnet := func(i int) map[string]any { return net(fmt.Sprintf("s%d", i), 1, 1, 1) }
	link := func(i int) map[string]any {
		return map[string]any{"kind": "token", "from": map[string]any{"subnet": "s0", "place": "p0"}, "to": map[string]any{"subnet": "s1", "place": "p0"}}
	}
	for _, c := range []struct {
		name   string
		bundle map[string]any
		want   string
	}{
		{"subnets", map[string]any{"subnets": many(mbMaxSubnets+1, subnet)}, fmt.Sprintf("%d subnets; at most %d", mbMaxSubnets+1, mbMaxSubnets)},
		{"links", map[string]any{"subnets": many(2, subnet), "links": many(mbMaxLinks+1, link)}, fmt.Sprintf("%d links; at most %d", mbMaxLinks+1, mbMaxLinks)},
		{"places", map[string]any{"subnets": []any{net("a", mbMaxPlaces+1, 1, 0)}}, fmt.Sprintf("%d places; at most %d", mbMaxPlaces+1, mbMaxPlaces)},
		{"transitions", map[string]any{"subnets": []any{net("a", 1, mbMaxTransitions+1, 0)}}, "transitions; at most"},
		{"arcs", map[string]any{"subnets": []any{net("a", 1, 1, mbMaxArcs+1)}}, "arcs; at most"},
		{"places across subnets", map[string]any{"subnets": many(11, func(i int) map[string]any { return net(fmt.Sprintf("s%d", i), 100, 1, 0) })}, "places; at most"},
		{"ports", map[string]any{"subnets": many(3, func(i int) map[string]any {
			s := net(fmt.Sprintf("s%d", i), 1, 1, 0)
			s["ports"] = many(200, func(j int) map[string]any {
				return map[string]any{"id": fmt.Sprintf("q%d", j), "kind": "inout", "place": "p0"}
			})
			return s
		})}, "ports; at most"},
	} {
		t.Run(c.name, func(t *testing.T) {
			for tool := range bundleHandlers {
				if tool == "pflow_bundle_example" {
					continue
				}
				args := map[string]any{"bundle": c.bundle}
				switch tool {
				case "pflow_bundle_add_link":
					args["kind"], args["from"], args["to"] = "token", "s0:q0", "s1:q0"
				case "pflow_bundle_candidates":
					args["from"] = "s0:q0"
				case "pflow_bundle_run":
					args["script"] = []any{}
				}
				start := time.Now()
				_, err := callBundleTool(t, tool, args)
				if err == nil || !strings.Contains(err.Error(), c.want) {
					t.Errorf("%s: error %v; want one containing %q", tool, err, c.want)
				}
				if d := time.Since(start); d > 2*time.Second {
					t.Errorf("%s: took %s to refuse", tool, d)
				}
			}
		})
	}
	t.Run("script steps", func(t *testing.T) {
		script := make([]any, mbMaxScript+1)
		for i := range script {
			script[i] = "counter/order"
		}
		_, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": cafeBundle(t), "script": script})
		if err == nil || !strings.Contains(err.Error(), "at most 1000") {
			t.Errorf("error %v", err)
		}
		// a script of exactly the limit is run (and stops at the first member that is not there)
		script = script[:mbMaxScript]
		out, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": cafeBundle(t), "script": script})
		if err != nil || len(out.(map[string]any)["steps"].([]any)) != mbMaxScript {
			t.Errorf("a script of %d steps: %v", mbMaxScript, err)
		}
	})
	t.Run("predicates", func(t *testing.T) {
		expect := make([]any, mbMaxExpect+1)
		for i := range expect {
			expect[i] = map[string]any{"place": "counter/done", "n": 0}
		}
		_, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": cafeBundle(t), "script": []any{}, "expect": expect})
		if err == nil || !strings.Contains(err.Error(), "at most 100") {
			t.Errorf("error %v", err)
		}
	})
	t.Run("example instances and links", func(t *testing.T) {
		_, err := callBundleTool(t, "pflow_bundle_example", map[string]any{"instances": []any{"orders", "orders", "orders", "orders", "orders", "orders", "orders"}})
		if err == nil || !strings.Contains(err.Error(), "the catalog has 6") {
			t.Errorf("error %v", err)
		}
		_, err = callBundleTool(t, "pflow_bundle_example", map[string]any{"links": many(mbMaxLinks+1, func(int) map[string]any {
			return map[string]any{"kind": "event", "from": "a:b", "to": "c:d"}
		})})
		if err == nil || !strings.Contains(err.Error(), "links; at most") {
			t.Errorf("error %v", err)
		}
	})
}

// A bundle at the limits is answered, in time, whatever its links do.
func TestMCPBundleLargeBundlesAreAnsweredInTime(t *testing.T) {
	const subnets = 30
	var ss, ls []any
	for i := 0; i < subnets; i++ {
		var ps, ts, as []any
		for j := 0; j < 30; j++ {
			ps = append(ps, map[string]any{"id": fmt.Sprintf("p%d", j), "initial": j % 3, "exported": true})
			ts = append(ts, map[string]any{"id": fmt.Sprintf("t%d", j)})
			as = append(as, map[string]any{"from": fmt.Sprintf("p%d", j), "to": fmt.Sprintf("t%d", j)}, map[string]any{"from": fmt.Sprintf("t%d", j), "to": fmt.Sprintf("p%d", (j+1)%30)})
		}
		id := fmt.Sprintf("n%02d", i)
		ss = append(ss, map[string]any{"id": id, "net_type": "ResourceNet",
			"model": map[string]any{"name": id, "places": ps, "transitions": ts, "arcs": as},
			"ports": []any{map[string]any{"id": "in", "kind": "inout", "place": "p0"}, map[string]any{"id": "go", "kind": "inout", "target": "transition", "transition": "t0"}}})
		// a ring of token links and of event links: every class joins them all
		next := fmt.Sprintf("n%02d", (i+1)%subnets)
		ls = append(ls,
			map[string]any{"kind": "token", "from": map[string]any{"subnet": id, "port": "in"}, "to": map[string]any{"subnet": next, "port": "in"}},
			map[string]any{"kind": "event", "from": map[string]any{"subnet": id, "port": "go"}, "to": map[string]any{"subnet": next, "port": "go"}})
	}
	bundle := map[string]any{"name": "ring", "subnets": ss, "links": ls}
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"pflow_bundle_validate", nil}, {"pflow_bundle_flatten", nil}, {"pflow_bundle_incidence", nil},
		{"pflow_bundle_run", map[string]any{"script": []any{"n00/t0", "n01/t0", "n05/t7"}}},
		{"pflow_bundle_candidates", map[string]any{"from": "n00:in"}},
		{"pflow_bundle_candidates", map[string]any{"from": "n00:go"}},
		{"pflow_bundle_add_link", map[string]any{"kind": "data", "from": "n00:in", "to": "n03:in"}},
	} {
		args := map[string]any{"bundle": bundle}
		for k, v := range c.args {
			args[k] = v
		}
		start := time.Now()
		out, err := callBundleTool(t, c.tool, args)
		if d := time.Since(start); d > 5*time.Second {
			t.Errorf("%s took %s", c.tool, d)
		}
		switch {
		case c.tool == "pflow_bundle_add_link":
			// a refusal is an answer
		case c.tool == "pflow_bundle_incidence":
			// 871 x 871 flat cells: more than a 60 KB answer can hold, refused up front
			if err == nil || !strings.Contains(err.Error(), "the matrices would have 785641 cells") {
				t.Errorf("%s: %v", c.tool, err)
			}
		case err != nil:
			t.Errorf("%s: %v", c.tool, err)
		}
		// whatever the answer, it goes out whole or marked as cut, under the limit
		res := mcpResult(out)
		text := res["content"].([]map[string]any)[0]["text"].(string)
		if len(text) > mcpMaxResultBytes {
			t.Errorf("%s: %d bytes", c.tool, len(text))
		}
	}
	// the ring fuses: one place and one transition per index, not thirty each
	out, err := callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": bundle})
	if err != nil {
		t.Fatal(err)
	}
	flat := asJSON(t, out).(map[string]any)
	if got := len(flat["places"].([]any)); got != 30*subnets-(subnets-1) {
		t.Errorf("%d flat places", got)
	}
	if got := len(flat["fused_groups"].(map[string]any)); got != 1 {
		t.Errorf("%d fused groups", got)
	}
}

// Faults only go-pflow reports (the pinned native refuses to read the document
// at all), and a bundle with holes in it.
func TestMCPBundleValidateReportsWhatGoPflowChecks(t *testing.T) {
	bundle := map[string]any{"subnets": []any{
		map[string]any{"id": "a", "net_type": "ResourceNet", "model": map[string]any{"name": "a",
			"places":      []any{map[string]any{"id": "p", "initial": 1}},
			"transitions": []any{map[string]any{"id": "t"}},
			"arcs":        []any{map[string]any{"from": "p", "to": "t", "type": "weird"}, map[string]any{"from": "t", "to": "p", "type": "read"}}}},
		map[string]any{"id": "hollow"},
	}}
	out, err := callBundleTool(t, "pflow_bundle_validate", map[string]any{"bundle": bundle})
	if err != nil {
		t.Fatal(err)
	}
	res := asJSON(t, out).(map[string]any)
	codes := map[string]bool{}
	for _, e := range res["errors"].([]any) {
		codes[e.(map[string]any)["code"].(string)] = true
	}
	for _, want := range []string{"E_UNKNOWN_ARC_TYPE", "E_READ_ARC_DIRECTION", "E_SUBNET_NO_MODEL"} {
		if !codes[want] {
			t.Errorf("no %s in %v", want, res["errors"])
		}
	}
	if res["valid"] != false {
		t.Error("valid")
	}
	// and the other tools do not trip over a subnet with no model
	for _, c := range []struct {
		tool string
		args map[string]any
	}{
		{"pflow_bundle_flatten", nil}, {"pflow_bundle_incidence", nil},
		{"pflow_bundle_candidates", map[string]any{"from": "a:q"}},
		{"pflow_bundle_add_link", map[string]any{"kind": "event", "from": "a:q", "to": "hollow:q"}},
		{"pflow_bundle_run", map[string]any{"script": []any{"a/t"}}},
	} {
		args := map[string]any{"bundle": bundle}
		for k, v := range c.args {
			args[k] = v
		}
		if _, err := callBundleTool(t, c.tool, args); err != nil && !strings.Contains(err.Error(), "invalid bundle") && !strings.Contains(err.Error(), "has no port") && !strings.Contains(err.Error(), "[E_") {
			t.Errorf("%s: %v", c.tool, err)
		}
	}
	// a ring of event links fuses everything and still flattens (a cyclic bundle terminates)
	cycle := readBundle(t, "../../parity/native/fixtures/bundle-cycle.json")
	out, err = callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": cycle})
	if err != nil || asJSON(t, out).(map[string]any)["ok"] != true {
		t.Errorf("cycle: %v", err)
	}
}

// A flat net a Validate-refused bundle cannot make is {ok: false, error}, not an
// error of the call; a run on it is an error.
func TestMCPBundleFlattenOfAnInvalidBundle(t *testing.T) {
	bad := readBundle(t, "../../parity/native/fixtures/bundle-bad-links.json")
	out, err := callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": bad})
	if err != nil {
		t.Fatal(err)
	}
	res := asJSON(t, out).(map[string]any)
	if res["ok"] != false || !strings.HasPrefix(res["error"].(string), "invalid bundle: [E_ILLEGAL_LINK]") {
		t.Errorf("%v", res)
	}
	out, _ = callBundleTool(t, "pflow_bundle_incidence", map[string]any{"bundle": bad})
	if asJSON(t, out).(map[string]any)["ok"] != false {
		t.Errorf("incidence: %v", out)
	}
	if _, err := callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": bad, "script": []any{"shop/sell"}}); err == nil || !strings.HasPrefix(err.Error(), "invalid bundle") {
		t.Errorf("run: %v", err)
	}
}

// pflow_bundle_run's own predicates (native's scenarios carry theirs).
func TestMCPBundleRunPredicates(t *testing.T) {
	bundle := exampleBundle(t, map[string]any{})
	out, err := callBundleTool(t, "pflow_bundle_run", map[string]any{
		"bundle": bundle,
		"script": []any{"orders/dequeue", "payment/do_charge"},
		"expect": []any{
			map[string]any{"place": "payment/merchant", "n": 1, "says": "the charge landed"},
			map[string]any{"place": "payment/customer", "n": 1},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	res := asJSON(t, out).(map[string]any)
	if res["id"] != "script" || res["completed"] != true {
		t.Fatalf("%v", res)
	}
	want := []struct {
		pass   bool
		actual float64
		flat   any
	}{{true, 1, "payment/merchant"}, {false, 0, "payment/customer"}}
	for i, e := range res["expect"].([]any) {
		m := e.(map[string]any)
		if m["pass"] != want[i].pass || m["actual"] != want[i].actual || !reflect.DeepEqual(m["flat"], want[i].flat) || m["op"] != "==" {
			t.Errorf("expect[%d] = %v; want pass %v, actual %v, flat %v", i, m, want[i].pass, want[i].actual, want[i].flat)
		}
	}
	// a place that is not in the composition is refused (a typo with n = 0 would pass)
	_, err = callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": bundle, "script": []any{}, "expect": []any{map[string]any{"place": "payment/ghost", "n": 0}}})
	if err == nil || err.Error() != `pflow_bundle_run: expect[0]: no place "payment/ghost" in the composition` {
		t.Errorf("error %v", err)
	}
	// a fused member fires the whole fusion, and the step names the flat transition
	step := res["steps"].([]any)[0].(map[string]any)
	if step["flat"] != "fused:orders/dequeue+payment/do_reserve+workers/acquire" {
		t.Errorf("step %v", step)
	}
	// stops where a member cannot fire, and says why
	out, _ = callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": bundle, "script": []any{"payment/commit"}})
	res = asJSON(t, out).(map[string]any)
	if res["completed"] != false || res["stopped_at"] != float64(0) || res["stopped_step"] != "payment/commit" ||
		!strings.Contains(res["steps"].([]any)[0].(map[string]any)["why"].(string), "needs 1 token(s) on payment/committing") {
		t.Errorf("%v", res)
	}
}

// The catalog is the composition page's: the instance parameters can be asked
// for one by one, and an extra can be joined to the default three.
func TestMCPBundleExampleCatalog(t *testing.T) {
	out, err := callBundleTool(t, "pflow_bundle_example", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	res := asJSON(t, out).(map[string]any)
	cat := res["catalog"].([]any)
	if len(cat) != 6 {
		t.Fatalf("%d instances in the catalog", len(cat))
	}
	for _, e := range cat {
		m := e.(map[string]any)
		if m["available"] != true || m["reason"] != nil || m["why"] == "" {
			t.Errorf("%v", m)
		}
	}
	if !reflect.DeepEqual(res["instances"], []any{"orders", "workers", "payment"}) || len(res["dropped_links"].([]any)) != 0 {
		t.Errorf("%v %v", res["instances"], res["dropped_links"])
	}
	// a link to an instance that is not there is dropped and listed
	out, err = callBundleTool(t, "pflow_bundle_example", map[string]any{"instances": []any{"orders", "workers"}})
	if err != nil {
		t.Fatal(err)
	}
	dropped := asJSON(t, out).(map[string]any)["dropped_links"].([]any)
	if len(dropped) != 2 || dropped[0].(map[string]any)["reason"] != "not in the composition: payment" {
		t.Errorf("%v", dropped)
	}
	// the bundle it returns is one every other tool reads
	b := exampleBundle(t, map[string]any{"instances": []any{"workers", "workers2"}, "links": []any{map[string]any{"kind": "token", "from": "workers:available", "to": "workers2:available"}}})
	out, err = callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": b})
	if err != nil {
		t.Fatal(err)
	}
	flat := asJSON(t, out).(map[string]any)
	if _, ok := flat["wires"].(map[string]any)["wire:workers/available"]; !ok {
		t.Errorf("wires %v", flat["wires"])
	}
}

func TestMCPBundleDocsAndInstructionsName(t *testing.T) {
	_, out := mcpCall(t, &Server{}, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
	text := out["result"].(map[string]any)["instructions"].(string)
	for _, want := range []string{"PetriNetBundle", "pflow_bundle_example", "pflow_bundle_validate", "_flatten", "_run"} {
		if !strings.Contains(text, want) {
			t.Errorf("the server instructions do not mention %s", want)
		}
	}
	if _, err := os.Stat("../../parity/native/fixtures/bundle-cycle.json"); err != nil {
		t.Error(err)
	}
}
