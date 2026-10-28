package model

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

// flatNet is the part of a flat net that must agree between go-pflow's
// Bundle.Flatten and the wasm's bundle.flatten (pflow-compose): the same
// projection as parity/model/flat_lib.ts flatOf.
type flatNet struct {
	Places []struct {
		ID       string `json:"id"`
		Initial  int    `json:"initial"`
		Capacity int    `json:"capacity"`
	} `json:"places"`
	Transitions []struct {
		ID      string   `json:"id"`
		Members []string `json:"members"`
	} `json:"transitions"`
	Arcs []struct {
		From   string `json:"from"`
		To     string `json:"to"`
		Weight int    `json:"weight"`
		Type   string `json:"type"`
	} `json:"arcs"`
}

func project(m *metamodel.Model, fm *metamodel.FlattenMap) flatNet {
	var out flatNet
	for _, p := range m.Places {
		out.Places = append(out.Places, struct {
			ID       string `json:"id"`
			Initial  int    `json:"initial"`
			Capacity int    `json:"capacity"`
		}{p.ID, p.Initial, p.Capacity})
	}
	members := map[string][]string{}
	for subnet, local := range fm.Transition {
		for l, flat := range local {
			members[flat] = append(members[flat], subnet+"/"+l)
		}
	}
	for _, t := range m.Transitions {
		ms := members[t.ID]
		if len(ms) == 0 {
			ms = []string{t.ID}
		}
		sort.Strings(ms)
		out.Transitions = append(out.Transitions, struct {
			ID      string   `json:"id"`
			Members []string `json:"members"`
		}{t.ID, ms})
	}
	for _, a := range m.Arcs {
		w := a.Weight
		if w == 0 {
			w = 1
		}
		out.Arcs = append(out.Arcs, struct {
			From   string `json:"from"`
			To     string `json:"to"`
			Weight int    `json:"weight"`
			Type   string `json:"type"`
		}{a.From, a.To, w, string(a.Type)})
	}
	sort.Slice(out.Places, func(i, j int) bool { return out.Places[i].ID < out.Places[j].ID })
	sort.Slice(out.Transitions, func(i, j int) bool { return out.Transitions[i].ID < out.Transitions[j].ID })
	sort.Slice(out.Arcs, func(i, j int) bool {
		a, b := out.Arcs[i], out.Arcs[j]
		ka := strings.Join([]string{a.From, a.To, a.Type}, "\x00")
		kb := strings.Join([]string{b.From, b.To, b.Type}, "\x00")
		if ka != kb {
			return ka < kb
		}
		return a.Weight < b.Weight
	})
	return out
}

// TestFlattenMatchesTheRegistry holds go-pflow's Flatten (the reference
// implementation the server draws compositions with) to the flat nets the
// wasm's bundle.flatten made of the same compositions. The goldens in
// parity/model/flat are written by gen_flat.ts from the wasm; the deno test
// flatten_parity_test.ts checks the wasm still produces them.
func TestFlattenMatchesTheRegistry(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(parityDir, "flat", "*.bundle.json"))
	if len(files) == 0 {
		t.Fatal("no parity/model/flat/*.bundle.json: run deno run parity/model/gen_flat.ts")
	}
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".bundle.json")
		t.Run(name, func(t *testing.T) {
			raw, _ := os.ReadFile(f)
			m, fm, err := Flatten(raw, nil)
			if err != nil {
				t.Fatal(err)
			}
			got := project(m, fm)
			wantRaw, err := os.ReadFile(strings.TrimSuffix(f, ".bundle.json") + ".flat.json")
			if err != nil {
				t.Fatal(err)
			}
			var want flatNet
			if err := json.Unmarshal(wantRaw, &want); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				g, _ := json.MarshalIndent(got, "", " ")
				w, _ := json.MarshalIndent(want, "", " ")
				_ = os.WriteFile(filepath.Join(os.TempDir(), name+".go-flat.json"), g, 0o644)
				_ = os.WriteFile(filepath.Join(os.TempDir(), name+".wasm-flat.json"), w, 0o644)
				t.Fatalf("go-pflow's flat net differs from the wasm's (written to %s/%s.{go,wasm}-flat.json): %d/%d places, %d/%d transitions, %d/%d arcs",
					os.TempDir(), name, len(got.Places), len(want.Places), len(got.Transitions), len(want.Transitions), len(got.Arcs), len(want.Arcs))
			}
		})
	}
}
