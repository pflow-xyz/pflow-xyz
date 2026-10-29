package model

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"

	"github.com/pflow-xyz/go-pflow/metamodel"
	"github.com/pflow-xyz/go-pflow/parser"
)

// Fetcher returns the stored object for a CID (os.ErrNotExist when absent).
type Fetcher func(cid string) ([]byte, error)

// Resolve decodes a composition into go-pflow's metamodel.Bundle, the
// reference implementation Flatten runs on. Inline parts are read as the
// metamodel shape they are written in. A part given by CID is fetched, must
// be a net, and is converted with parser.ModelFromJSON, the one converter
// from the editor's Shape A to the metamodel (colours unfold to "pool.red").
//
// Keys the Bundle struct has no field for (cid, pattern, params) are not
// read: they take no part in the flat net. They do take part in the
// composition's CID, which is computed from the document, never from this
// struct.
func Resolve(raw []byte, fetch Fetcher) (*metamodel.Bundle, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
		return nil, refuse(ErrNotAModelDoc, "not a JSON object")
	}
	if Kind(doc) != KindComposition {
		return nil, refuse(ErrBundleShape, "@type is %v, not %s", doc["@type"], TypeComposition)
	}
	if err := checkComposition(doc); err != nil {
		return nil, err
	}
	var b metamodel.Bundle
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, refuse(ErrBundleShape, "not a metamodel.Bundle: %v", err)
	}
	subs, _ := doc["subnets"].([]any)
	if len(subs) != len(b.Subnets) {
		return nil, refuse(ErrSubnet, "subnets did not decode (%d of %d)", len(b.Subnets), len(subs))
	}
	for i, s := range subs {
		m := s.(map[string]any)
		cid, ok := m["cid"].(string)
		if !ok {
			if b.Subnets[i].Model == nil {
				return nil, refuse(ErrPart, "subnet %q: model did not decode as the metamodel shape", b.Subnets[i].ID)
			}
			continue
		}
		if fetch == nil {
			return nil, refuse(ErrPartMissing, "subnet %q is the stored net %s and no store was given", b.Subnets[i].ID, cid)
		}
		data, err := fetch(cid)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, refuse(ErrPartMissing, "subnet %q: net %s is not in the store", b.Subnets[i].ID, cid)
			}
			return nil, fmt.Errorf("subnet %q: fetch %s: %w", b.Subnets[i].ID, cid, err)
		}
		if k := KindOf(data); k != KindNet {
			return nil, refuse(ErrPartKind, "subnet %q: %s is a %s; a by-reference part is a net", b.Subnets[i].ID, cid, k)
		}
		m2, _, err := parser.ModelFromJSON(data)
		if err != nil {
			return nil, refuse(ErrPart, "subnet %q: net %s does not read as a model: %v", b.Subnets[i].ID, cid, err)
		}
		b.Subnets[i].Model = m2
	}
	return &b, nil
}

// Flatten resolves a composition and lowers it with go-pflow's
// Bundle.FlattenWithMap: the same Flatten the wasm's bundle.flatten
// (pflow-compose) is held to by parity/model-identity.
func Flatten(raw []byte, fetch Fetcher) (*metamodel.Model, *metamodel.FlattenMap, error) {
	b, err := Resolve(raw, fetch)
	if err != nil {
		return nil, nil, err
	}
	return b.FlattenWithMap()
}

// FlatNet is a flat model in the editor's Shape A, for the SVG renderer and
// the share card. It carries no coordinates (Flatten has none); the caller
// lays it out. Read arcs are written as the reversed inhibitor go-pflow's
// petri package uses for them.
func FlatNet(m *metamodel.Model) map[string]any {
	places := map[string]any{}
	for _, p := range m.Places {
		pl := map[string]any{
			"@type":   "Place",
			"initial": []int{p.Initial},
			"offset":  0,
			"x":       p.X,
			"y":       p.Y,
		}
		if p.Capacity > 0 {
			pl["capacity"] = []int{p.Capacity}
		} else {
			pl["capacity"] = []int{0}
		}
		places[p.ID] = pl
	}
	trans := map[string]any{}
	for _, t := range m.Transitions {
		trans[t.ID] = map[string]any{"@type": "Transition", "x": 0, "y": 0}
	}
	arcs := make([]map[string]any, 0, len(m.Arcs))
	for _, a := range m.Arcs {
		w := a.Weight
		if w <= 0 {
			w = 1
		}
		src, dst, inhibit := a.From, a.To, false
		switch a.Type {
		case metamodel.InhibitorArc:
			inhibit = true
		case metamodel.ReadArc:
			// place -> transition read arc: reversed inhibitor.
			src, dst, inhibit = a.To, a.From, true
		}
		arcs = append(arcs, map[string]any{
			"@type":             "Arrow",
			"source":            src,
			"target":            dst,
			"weight":            []int{w},
			"inhibitTransition": inhibit,
		})
	}
	sort.SliceStable(arcs, func(i, j int) bool {
		if arcs[i]["source"].(string) != arcs[j]["source"].(string) {
			return arcs[i]["source"].(string) < arcs[j]["source"].(string)
		}
		return arcs[i]["target"].(string) < arcs[j]["target"].(string)
	})
	net := map[string]any{
		"@context":    Context,
		"@type":       "PetriNet",
		"token":       []string{"https://pflow.xyz/tokens/black"},
		"places":      places,
		"transitions": trans,
		"arcs":        arcs,
	}
	if m.Name != "" {
		net["name"] = m.Name
	}
	if m.Description != "" {
		net["description"] = m.Description
	}
	return net
}

// FlatNetJSON is FlatNet marshalled.
func FlatNetJSON(m *metamodel.Model) ([]byte, error) {
	return json.Marshal(FlatNet(m))
}
