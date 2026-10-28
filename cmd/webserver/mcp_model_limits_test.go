package main

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The limits that keep a composition call cheap: names of a bounded length, an
// answer that cannot outgrow the request that asked for it, a matrix that fits
// a 60 KB answer.

// allocated is how many bytes f allocated (a cumulative count, so a garbage
// collection in the middle does not hide any).
func allocated(f func()) uint64 {
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	f()
	runtime.ReadMemStats(&after)
	return after.TotalAlloc - before.TotalAlloc
}

func padTo(s string, n int) string {
	for len(s) < n {
		s += "x"
	}
	return s
}

// fusedChain is `subnets` subnets of `per` transitions each, every id `idLen`
// bytes long, and `links` event links chaining the first transition of each
// subnet... to the next: one fused class of links+1 members.
func fusedChain(subnets, per, idLen, links int) map[string]any {
	var ss, ls []any
	type end struct{ s, t int }
	var all []end
	for i := 0; i < subnets; i++ {
		var ts, ports, as []any
		for j := 0; j < per; j++ {
			ts = append(ts, map[string]any{"id": padTo(fmt.Sprintf("t%d_", j), idLen)})
			ports = append(ports, map[string]any{"id": padTo(fmt.Sprintf("e%d_", j), idLen), "kind": "inout", "target": "transition", "transition": padTo(fmt.Sprintf("t%d_", j), idLen)})
			as = append(as, map[string]any{"from": "p", "to": padTo(fmt.Sprintf("t%d_", j), idLen), "weight": 1},
				map[string]any{"from": padTo(fmt.Sprintf("t%d_", j), idLen), "to": "p", "weight": 1}) // fires again and again
			all = append(all, end{i, j})
		}
		id := padTo(fmt.Sprintf("s%02d_", i), idLen)
		ss = append(ss, map[string]any{"id": id, "net_type": "ResourceNet",
			"model": map[string]any{"name": id, "places": []any{map[string]any{"id": "p", "initial": 100}}, "transitions": ts, "arcs": as}, "ports": ports})
	}
	for k := 0; k+1 < len(all) && len(ls) < links; k++ {
		a, b := all[k], all[k+1]
		ls = append(ls, map[string]any{"kind": "event",
			"from": map[string]any{"subnet": padTo(fmt.Sprintf("s%02d_", a.s), idLen), "port": padTo(fmt.Sprintf("e%d_", a.t), idLen)},
			"to":   map[string]any{"subnet": padTo(fmt.Sprintf("s%02d_", b.s), idLen), "port": padTo(fmt.Sprintf("e%d_", b.t), idLen)}})
	}
	return map[string]any{"name": "chain", "subnets": ss, "links": ls}
}

func TestMCPBundleNamesAreBounded(t *testing.T) {
	long := strings.Repeat("n", mbMaxIDBytes+1)
	ok := strings.Repeat("n", mbMaxIDBytes)
	// a bundle with one name put in each place a name can be
	bundle := func(name string) []struct {
		where, want string
		b           map[string]any
	} {
		sub := func(id string, model, extra map[string]any) map[string]any {
			s := map[string]any{"id": id, "model": model}
			for k, v := range extra {
				s[k] = v
			}
			return s
		}
		model := func(p, tr string, arcFrom, arcTo string) map[string]any {
			return map[string]any{"places": []any{map[string]any{"id": p, "exported": true}}, "transitions": []any{map[string]any{"id": tr}},
				"arcs": []any{map[string]any{"from": arcFrom, "to": arcTo}}}
		}
		return []struct {
			where, want string
			b           map[string]any
		}{
			{"subnet id", "subnets[0].id", map[string]any{"subnets": []any{sub(name, model("p", "t", "p", "t"), nil)}}},
			{"place id", "subnets[0].model.places[0].id", map[string]any{"subnets": []any{sub("a", model(name, "t", "p", "t"), nil)}}},
			{"transition id", "subnets[0].model.transitions[0].id", map[string]any{"subnets": []any{sub("a", model("p", name, "p", "t"), nil)}}},
			{"arc from", "subnets[0].model.arcs[0].from", map[string]any{"subnets": []any{sub("a", model("p", "t", name, "t"), nil)}}},
			{"arc to", "subnets[0].model.arcs[0].to", map[string]any{"subnets": []any{sub("a", model("p", "t", "p", name), nil)}}},
			{"port id", "subnets[0].ports[0].id", map[string]any{"subnets": []any{sub("a", model("p", "t", "p", "t"), map[string]any{"ports": []any{map[string]any{"id": name, "kind": "inout", "place": "p"}}})}}},
			{"link id", "links[0].id", map[string]any{"subnets": []any{sub("a", model("p", "t", "p", "t"), nil), sub("b", model("p", "t", "p", "t"), nil)},
				"links": []any{map[string]any{"kind": "token", "id": name, "from": map[string]any{"subnet": "a", "place": "p"}, "to": map[string]any{"subnet": "b", "place": "p"}}}}},
			{"link end", "links[0].to.subnet", map[string]any{"subnets": []any{sub("a", model("p", "t", "p", "t"), nil)},
				"links": []any{map[string]any{"kind": "token", "from": map[string]any{"subnet": "a", "place": "p"}, "to": map[string]any{"subnet": name, "place": "p"}}}}},
		}
	}
	for _, c := range bundle(long) {
		t.Run(c.where, func(t *testing.T) {
			for _, tool := range []string{"pflow_bundle_validate", "pflow_bundle_flatten", "pflow_bundle_incidence"} {
				_, err := callBundleTool(t, tool, map[string]any{"bundle": c.b})
				want := fmt.Sprintf("bundle: %s is %d bytes; names are at most %d bytes", c.want, len(long), mbMaxIDBytes)
				if err == nil || !strings.Contains(err.Error(), want) {
					t.Errorf("%s: error %v; want one containing %q", tool, err, want)
				}
			}
		})
	}
	for _, c := range bundle(ok) {
		t.Run(c.where+" at the limit", func(t *testing.T) {
			if _, err := callBundleTool(t, "pflow_bundle_validate", map[string]any{"bundle": c.b}); err != nil {
				t.Errorf("%v", err)
			}
		})
	}
}

// 32 subnets of 7 transitions, 200 event links fusing 201 of them into one
// class: a fused name is a list of its members, and every map, arc and list
// that mentions the transition repeats it. Before names and the answer were
// bounded a 264 KB request of this shape (ids of 400 bytes) answered 19.6 MB.
func TestMCPBundleAnAnswerCannotOutgrowItsRequest(t *testing.T) {
	// names past the limit are refused before anything is built
	_, err := callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": fusedChain(32, 7, 400, 200)})
	if err == nil || !strings.Contains(err.Error(), "names are at most 128 bytes") {
		t.Fatalf("400-byte names: %v", err)
	}
	// and at the limit the fused name (201 x 133 bytes) is repeated too often for one answer
	bundle := fusedChain(32, 7, mbMaxIDBytes, 200)
	for _, tool := range []string{"pflow_bundle_flatten", "pflow_bundle_incidence", "pflow_bundle_run"} {
		args := map[string]any{"bundle": bundle}
		if tool == "pflow_bundle_run" {
			args["script"] = []any{}
		}
		var err error
		start := time.Now()
		bytes := allocated(func() { _, err = callBundleTool(t, tool, args) })
		if err == nil || !strings.Contains(err.Error(), "answer would be") {
			t.Errorf("%s: %v", tool, err)
		}
		if bytes > 64<<20 {
			t.Errorf("%s: refused after allocating %d MB", tool, bytes>>20)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Errorf("%s: took %s", tool, d)
		}
	}
	// a script cannot make the answer grow either: a class of 60 members (a name
	// of 8 KB) is answered, a script of 1000 steps that each name it is not
	bundle = fusedChain(10, 6, mbMaxIDBytes, 59)
	out, err := callBundleTool(t, "pflow_bundle_flatten", map[string]any{"bundle": bundle})
	if err != nil {
		t.Fatalf("a class of 60: %v", err)
	}
	if n := len(mcpResult(out)["content"].([]map[string]any)[0]["text"].(string)); n > mcpMaxResultBytes {
		t.Errorf("%d bytes", n)
	}
	member := padTo("s00_", mbMaxIDBytes) + "/" + padTo("t0_", mbMaxIDBytes)
	script := make([]any, mbMaxScript)
	for i := range script {
		script[i] = member
	}
	var runErr error
	bytes := allocated(func() {
		_, runErr = callBundleTool(t, "pflow_bundle_run", map[string]any{"bundle": bundle, "script": script})
	})
	if runErr == nil || !strings.Contains(runErr.Error(), "the answer would be over") {
		t.Errorf("a long script on a long name: %v", runErr)
	}
	if bytes > 64<<20 {
		t.Errorf("run: %d MB", bytes>>20)
	}
}

// One subnet at the caps (1000 places, 1000 transitions, 4000 arcs) has a
// matrix of a million cells, 138 MB to build before the answer limit cut it.
func TestMCPBundleIncidenceRefusesAMatrixNoAnswerCouldHold(t *testing.T) {
	var ps, ts, as []any
	for i := 0; i < mbMaxPlaces; i++ {
		ps = append(ps, map[string]any{"id": fmt.Sprintf("p%d", i), "initial": 1})
	}
	for i := 0; i < mbMaxTransitions; i++ {
		ts = append(ts, map[string]any{"id": fmt.Sprintf("t%d", i)})
	}
	for i := 0; i < mbMaxArcs; i++ {
		if i%2 == 0 {
			as = append(as, map[string]any{"from": fmt.Sprintf("p%d", i%mbMaxPlaces), "to": fmt.Sprintf("t%d", i%mbMaxTransitions), "weight": 1})
		} else {
			as = append(as, map[string]any{"from": fmt.Sprintf("t%d", i%mbMaxTransitions), "to": fmt.Sprintf("p%d", (i+1)%mbMaxPlaces), "weight": 1})
		}
	}
	bundle := map[string]any{"subnets": []any{map[string]any{"id": "a", "net_type": "ResourceNet", "model": map[string]any{"name": "a", "places": ps, "transitions": ts, "arcs": as}}}}
	var err error
	bytes := allocated(func() { _, err = callBundleTool(t, "pflow_bundle_incidence", map[string]any{"bundle": bundle}) })
	// the flat net is the subnet itself (a lone subnet), and its own block: twice
	if err == nil || !strings.Contains(err.Error(), "the matrices would have 2000000 cells") {
		t.Fatalf("%v", err)
	}
	if bytes > 32<<20 {
		t.Errorf("refused after allocating %d MB", bytes>>20)
	}
	// the other tools answer the same bundle, cut to the answer limit
	for _, tool := range []string{"pflow_bundle_validate", "pflow_bundle_flatten"} {
		out, err := callBundleTool(t, tool, map[string]any{"bundle": bundle})
		if err != nil {
			t.Fatalf("%s: %v", tool, err)
		}
		if n := len(mcpResult(out)["content"].([]map[string]any)[0]["text"].(string)); n > mcpMaxResultBytes {
			t.Errorf("%s: %d bytes", tool, n)
		}
	}
	// 150 x 150, twice, is fine
	small := map[string]any{"subnets": []any{map[string]any{"id": "a", "model": map[string]any{"name": "a", "places": ps[:150], "transitions": ts[:150], "arcs": []any{}}}}}
	if _, err := callBundleTool(t, "pflow_bundle_incidence", map[string]any{"bundle": small}); err != nil {
		t.Errorf("150 x 150: %v", err)
	}
}
