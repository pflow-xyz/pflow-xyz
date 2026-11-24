// SPDX-License-Identifier: MIT

package notation

import (
	"fmt"
	"strconv"

	"github.com/pflow-xyz/pflow-xyz/internal/seal"
)

// Context is the one JSON-LD context a net names: the schema the sealer preloads.
const Context = "https://pflow.xyz/schema"

// ModelVersion is the @version the editor writes; notation version 1 means it.
const ModelVersion = "1.1"

// Compile turns a checked program into the JSON-LD document the editor writes.
//
// The document is in the editor's profile: every place has @type, capacity,
// initial and offset (0 unless the text says otherwise), every arc has @type,
// inhibitTransition and a weight, and the net has @version, token, places,
// transitions and arcs. Keys are in byte order, except that places and
// transitions keep the order the text declares them in and arcs keep the order
// of the text: the sealer treats the first two as sets and the arcs as a list,
// so none of it can change a CID except the arcs' order.
//
// A net with errors does not compile: the caller has the diagnostics.
func Compile(f *File) (Obj, error) {
	w := f.Width()
	kinds := map[string]string{}
	for _, p := range f.Places {
		kinds[p.ID.Name] = "place"
	}
	for _, t := range f.Transitions {
		kinds[t.ID.Name] = "transition"
	}
	_, uris := f.ColourList()
	token := []any{}
	for _, u := range uris {
		token = append(token, u)
	}

	places := Obj{}
	for _, p := range f.Places {
		o := Obj{{"@type", "Place"}}
		o = append(o, KV{"capacity", vecJSON(p.Cap, f, w, defaultNull)})
		if p.About != nil {
			o = append(o, KV{"description", p.About.Value})
		}
		o = append(o, KV{"initial", vecJSON(p.Init, f, w, defaultZero)})
		if p.Label != nil {
			o = append(o, KV{"label", p.Label.Value})
		}
		off := Num("0")
		if p.Offset != nil {
			off = Num(canonNum(p.Offset.Text))
		}
		o = append(o, KV{"offset", off})
		if p.At != nil {
			o = append(o, KV{"x", Num(canonNum(p.At.X))}, KV{"y", Num(canonNum(p.At.Y))})
		}
		places = append(places, KV{p.ID.Name, o.Sorted()})
	}
	trans := Obj{}
	for _, t := range f.Transitions {
		o := Obj{{"@type", "Transition"}}
		if t.About != nil {
			o = append(o, KV{"description", t.About.Value})
		}
		if t.Label != nil {
			o = append(o, KV{"label", t.Label.Value})
		}
		if t.Offset != nil {
			o = append(o, KV{"offset", Num(canonNum(t.Offset.Text))})
		}
		if t.Rate != nil {
			o = append(o, KV{"rate", Num(canonNum(t.Rate.Text))})
		}
		if t.Role != nil {
			o = append(o, KV{"role", t.Role.Name})
		}
		if t.At != nil {
			o = append(o, KV{"x", Num(canonNum(t.At.X))}, KV{"y", Num(canonNum(t.At.Y))})
		}
		trans = append(trans, KV{t.ID.Name, o.Sorted()})
	}
	arcs := []any{}
	for _, a := range f.Arcs {
		sk, tk := kinds[a.Src.ID.Name], kinds[a.Dst.ID.Name]
		if sk == "" || tk == "" {
			return nil, fmt.Errorf("arc %s %s %s: an end is not declared", a.Src.ID.Name, a.Arrow, a.Dst.ID.Name)
		}
		var weight *Vec
		switch {
		case sk == "place" && a.Src.Weight != nil:
			weight = a.Src.Weight
		case tk == "place" && a.Dst.Weight != nil:
			weight = a.Dst.Weight
		}
		src, dst, inhibit := a.Src.ID.Name, a.Dst.ID.Name, false
		switch a.Arrow {
		case "-o":
			inhibit = true
		case "<->":
			// the editor's read arc: an inhibitTransition arc that runs transition -> place
			src, dst, inhibit = dst, src, true
		}
		var wj any
		if weight == nil {
			wj = []any{Num("1")}
		} else {
			wj = vecJSON(weight, f, w, defaultNull)
		}
		arcs = append(arcs, Obj{
			{"@type", "Arrow"}, {"inhibitTransition", inhibit}, {"source", src}, {"target", dst}, {"weight", wj},
		}.Sorted())
	}

	doc := Obj{
		{"@context", Context},
		{"@type", f.Kind},
		{"@version", ModelVersion},
		{"arcs", arcs},
	}
	if f.About != nil {
		doc = append(doc, KV{"description", f.About.Value})
	}
	if f.Name != nil {
		doc = append(doc, KV{"name", f.Name.Value})
	}
	if f.HasParents {
		ps := []any{}
		for _, p := range f.ParentsList {
			ps = append(ps, p)
		}
		doc = append(doc, KV{"parents", ps})
	}
	doc = append(doc, KV{"places", places}, KV{"token", token}, KV{"transitions", trans})
	return doc.Sorted(), nil
}

type vecDefault int

const (
	defaultZero vecDefault = iota // a marking with nothing said: all zero
	defaultNull                   // a capacity with nothing said: unbounded, as the editor writes it
)

// vecJSON writes a marking, capacity or weight as the JSON list it means.
func vecJSON(v *Vec, f *File, w int, d vecDefault) []any {
	out := []any{}
	if v == nil {
		for i := 0; i < w; i++ {
			if d == defaultNull {
				out = append(out, nil)
			} else {
				out = append(out, Num("0"))
			}
		}
		return out
	}
	if v.Literal {
		for _, it := range v.Items {
			if it.Null {
				out = append(out, nil)
			} else {
				out = append(out, Num(canonNum(it.Num)))
			}
		}
		return out
	}
	vec := weightVec(v, f, w)
	for _, x := range vec {
		out = append(out, Num(FormatNumber(x)))
	}
	return out
}

func canonNum(s string) string {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return s
	}
	return FormatNumber(f)
}

// CompileText parses, checks and compiles. The diagnostics are the syntax and
// check tiers together; the document is nil when any is an error.
func CompileText(src string) (Obj, []Diagnostic) {
	f, ds := Parse(src)
	ds = append(ds, f.Check()...)
	for _, d := range ds {
		if d.IsError() {
			return nil, ds
		}
	}
	doc, err := Compile(f)
	if err != nil {
		ds = append(ds, Diagnostic{Severity: Error, Source: "check", Message: err.Error()})
		return nil, ds
	}
	return doc, ds
}

// CID is the CID the document seals to: the pflow.xyz sealing contract
// (internal/seal) over the document's JSON, whatever wrote it.
func CID(doc any) (string, error) {
	cid, _, err := seal.SealJSONLD(MarshalJSON(doc))
	return cid, err
}
