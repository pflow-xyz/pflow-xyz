// SPDX-License-Identifier: MIT

package notation

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ColourList returns the net's colours in declaration order with their token URIs.
func (f *File) ColourList() (names, uris []string) {
	for _, c := range f.Colours {
		names = append(names, c.Name.Name)
		if c.URI != "" {
			uris = append(uris, c.URI)
		} else {
			uris = append(uris, TokenURIPrefix+c.Name.Name)
		}
	}
	return
}

// TokenURIPrefix is where pflow.xyz names its token colours.
const TokenURIPrefix = "https://pflow.xyz/tokens/"

// Width is the length of the net's vectors: one component for each colour, and
// one when the net declares none.
func (f *File) Width() int {
	if len(f.Colours) == 0 {
		return 1
	}
	return len(f.Colours)
}

// Check is the second tier: what the text says about the net once it is read.
// It is the notation's own, cheap and total; the structural analysis (P-invariants,
// boundedness, deadlock) is a third tier, run on the compiled net (see
// docs/pflow-notation.md, "The advisor"). Every rule here is one the editor's
// Check net (public/petri-validate.js) already holds: the notation moves it onto
// the line that wrote the mistake.
func (f *File) Check() []Diagnostic {
	var ds []Diagnostic
	add := func(sev Severity, sp Span, msg string, expected []string, found, help string) {
		ds = append(ds, Diagnostic{Severity: sev, Source: "check", Span: sp, Message: msg, Expected: expected, Found: found, Help: help})
	}
	w := f.Width()
	colourNames, _ := f.ColourList()
	colourIdx := map[string]int{}
	for i, c := range f.Colours {
		if j, dup := colourIdx[c.Name.Name]; dup {
			add(Error, c.Name.Span, fmt.Sprintf("the colour `%s` is declared twice", c.Name.Name), nil, "", fmt.Sprintf("it is already colour %d", j+1))
			continue
		}
		colourIdx[c.Name.Name] = i
	}

	if f.HasNet && f.Kind != "PetriNet" {
		add(Warning, f.KindSpan, fmt.Sprintf("`%s` is a net type sim and the ontology know; the editor's Check net accepts \"PetriNet\" only", f.Kind), []string{"PetriNet"}, f.Kind, "public/petri-validate.js reports any other @type as an error")
	}
	touched0 := map[string]bool{} // names whose line broke: not reported as unconnected either
	kind := map[string]string{}   // id -> "place" | "transition"
	where := map[string]Span{}
	declare := func(id ID, k string) {
		if prev, dup := kind[id.Name]; dup {
			add(Error, id.Span, fmt.Sprintf("`%s` is already a %s of this net: places and transitions share one namespace", id.Name, prev), nil, "", "")
			return
		}
		kind[id.Name] = k
		where[id.Name] = id.Span
	}
	for _, p := range f.Places {
		declare(p.ID, "place")
	}
	for _, t := range f.Transitions {
		declare(t.ID, "transition")
	}
	for _, b := range f.Broken { // declared on a line that did not parse: the syntax error is the news
		if _, dup := kind[b.ID.Name]; !dup {
			kind[b.ID.Name] = b.Kind
			where[b.ID.Name] = b.ID.Span
			touched0[b.ID.Name] = true
		}
	}
	ids := make([]string, 0, len(kind))
	for id := range kind {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	vecOK := func(v *Vec, what string) {
		if v == nil {
			return
		}
		if v.Literal {
			if len(v.Items) > w && len(f.Colours) > 0 {
				add(Error, v.Span, fmt.Sprintf("%s has %d entries but the net has %d colour(s)", what, len(v.Items), w), nil, "", "one entry for each colour, in the order the `color` line declares them")
			}
			return
		}
		seen := map[string]bool{}
		for _, t := range v.Terms {
			switch {
			case t.Colour == "" && len(f.Colours) > 1:
				add(Error, t.Span, fmt.Sprintf("this net has %d colours: say which one %s counts", len(f.Colours), what), colourNames, t.Num, "write `"+t.Num+" "+colourNames[0]+"`")
			case t.Colour == "" && len(v.Terms) > 1:
				add(Error, t.Span, "a sum names a colour in every term", colourNames, t.Num, "")
			case t.Colour != "":
				if _, ok := colourIdx[t.Colour]; !ok {
					help := ""
					if m := nearest(t.Colour, colourNames); m != "" {
						help = "did you mean `" + m + "`?"
					}
					if len(f.Colours) == 0 {
						help = "declare it first: `color " + t.Colour + "`"
					}
					add(Error, t.ColourSpan, fmt.Sprintf("`%s` is not a colour of this net", t.Colour), colourNames, t.Colour, help)
				} else if seen[t.Colour] {
					add(Error, t.ColourSpan, fmt.Sprintf("`%s` appears twice in the sum", t.Colour), nil, "", "add the numbers")
				}
				seen[t.Colour] = true
			}
		}
	}
	for _, p := range f.Places {
		vecOK(p.Init, "the marking")
		vecOK(p.Cap, "the capacity")
		if iv, cv := vectorOf(p.Init, f, w), vectorOf(p.Cap, f, w); iv != nil && cv != nil {
			for i := 0; i < len(iv) && i < len(cv); i++ {
				if cv[i] != nil && *cv[i] > 0 && iv[i] != nil && *iv[i] > *cv[i] {
					sp := p.Init.Span
					add(Error, sp, fmt.Sprintf("`%s` starts with %s but holds at most %s", p.ID.Name, FormatNumber(*iv[i]), FormatNumber(*cv[i])), nil, "", "the editor would clamp the marking to the capacity; the net you wrote is not the net you would get")
					break
				}
			}
		}
	}
	for _, t := range f.Transitions {
		if t.Rate != nil {
			if r, _ := strconv.ParseFloat(t.Rate.Text, 64); r < 0 {
				add(Error, t.Rate.Span, "a rate cannot be negative", nil, t.Rate.Text, "")
			}
		}
	}

	// the label rule of the editor's label box (public/petri-validate.js labelProblem)
	label := func(l *Str) {
		if l == nil {
			return
		}
		switch {
		case strings.TrimSpace(l.Value) == "":
			add(Error, l.Span, "a label cannot be empty", nil, "", "leave `label` out to show the id")
		case runeCount(l.Value) > 100:
			add(Error, l.Span, "a label is 100 characters or fewer", nil, "", "")
		case strings.ContainsAny(l.Value, "\r\n"):
			add(Error, l.Span, "a label is a single line", nil, "", "")
		}
	}
	for _, p := range f.Places {
		label(p.Label)
	}
	for _, t := range f.Transitions {
		label(t.Label)
	}

	touched := map[string]bool{}
	for id := range touched0 {
		touched[id] = true
	}
	for _, a := range f.Arcs {
		var ends [2]string
		bad := false
		for i, op := range [2]Operand{a.Src, a.Dst} {
			k, ok := kind[op.ID.Name]
			if !ok {
				help := ""
				if m := nearest(op.ID.Name, ids); m != "" {
					help = "did you mean `" + m + "`?"
				}
				add(Error, op.ID.Span, fmt.Sprintf("`%s` is not declared: an arc joins a place and a transition that exist", op.ID.Name), nil, op.ID.Name, help)
				bad = true
				continue
			}
			ends[i] = k
			touched[op.ID.Name] = true
		}
		if bad {
			continue
		}
		switch a.Arrow {
		case "->":
			if ends[0] == ends[1] {
				add(Error, a.Hop, fmt.Sprintf("an arc joins a place and a transition, and this one joins two %ss", ends[0]), nil, "", "")
				continue
			}
		case "-o":
			if ends[0] != "place" || ends[1] != "transition" {
				add(Error, a.Hop, "an inhibitor arc runs from a place to a transition: `p -o t`", []string{"place -o transition"}, "", "")
				continue
			}
		case "<->":
			if ends[0] != "place" || ends[1] != "transition" {
				add(Error, a.Hop, "a read arc joins a place and a transition: `p <-> t`", []string{"place <-> transition"}, "", "")
				continue
			}
		}
		// the weight belongs to the place end
		for i, op := range [2]Operand{a.Src, a.Dst} {
			if op.Weight != nil && ends[i] != "place" {
				add(Error, op.Weight.Span, "a weight belongs to the place end of an arc", nil, "", "write it on `"+otherEnd(a, i)+"`")
			}
			if op.Weight != nil && ends[i] == "place" {
				vecOK(op.Weight, "the weight")
				if v := weightVec(op.Weight, f, w); v != nil {
					zero := true
					for _, x := range v {
						if x != 0 {
							zero = false
						}
					}
					if zero && a.Arrow == "->" {
						add(Warning, op.Weight.Span, "an arc of weight 0 moves no tokens", nil, "", "")
					}
				}
			}
		}
		if w > 1 {
			for i, op := range [2]Operand{a.Src, a.Dst} {
				if ends[i] == "place" && op.Weight == nil {
					add(Error, op.ID.Span, fmt.Sprintf("this net has %d colours: say how many of which this arc moves", w), colourNames, op.ID.Name, "write `"+op.ID.Name+"*1 "+colourNames[0]+"`")
				}
			}
		}
	}
	for _, id := range ids {
		if !touched[id] {
			add(Warning, where[id], fmt.Sprintf("`%s` has no arcs", id), nil, "", "an unconnected "+kind[id]+" does nothing")
		}
	}
	sort.SliceStable(ds, func(i, j int) bool { return ds[i].Span.Start < ds[j].Span.Start })
	// a chain `a -> t -> b` is two arcs that share an operand: say it once
	var out []Diagnostic
	seen := map[string]bool{}
	for _, d := range ds {
		k := fmt.Sprint(d.Span, d.Message)
		if !seen[k] {
			seen[k] = true
			out = append(out, d)
		}
	}
	return out
}

func otherEnd(a *ArcDecl, i int) string {
	if i == 0 {
		return a.Dst.ID.Name
	}
	return a.Src.ID.Name
}

// vectorOf evaluates a marking or capacity to w components; nil entries are
// "unbounded/null". A nil Vec is the default (all zero). Returns nil when the
// vector cannot be evaluated (the checker has reported why).
func vectorOf(v *Vec, f *File, w int) []*float64 {
	out := make([]*float64, w)
	zero := 0.0
	for i := range out {
		z := zero
		out[i] = &z
	}
	if v == nil {
		return out
	}
	if v.Literal {
		out = out[:0]
		for _, it := range v.Items {
			if it.Null {
				out = append(out, nil)
				continue
			}
			x, _ := strconv.ParseFloat(it.Num, 64)
			out = append(out, &x)
		}
		return out
	}
	vec := weightVec(v, f, w)
	if vec == nil {
		return nil
	}
	out = out[:0]
	for i := range vec {
		x := vec[i]
		out = append(out, &x)
	}
	return out
}

// weightVec evaluates a sum to w components, or nil if a colour is unknown.
func weightVec(v *Vec, f *File, w int) []float64 {
	if v.Literal {
		out := []float64{}
		for _, it := range v.Items {
			x, _ := strconv.ParseFloat(it.Num, 64)
			out = append(out, x)
		}
		return out
	}
	out := make([]float64, w)
	idx := map[string]int{}
	for i, c := range f.Colours {
		idx[c.Name.Name] = i
	}
	for _, t := range v.Terms {
		x, _ := strconv.ParseFloat(t.Num, 64)
		switch {
		case t.Colour == "":
			if len(f.Colours) > 1 {
				return nil
			}
			out[0] += x
		default:
			i, ok := idx[t.Colour]
			if !ok {
				return nil
			}
			out[i] += x
		}
	}
	return out
}

// nearest returns the candidate within edit distance 2 of s (and not equal), or "".
func nearest(s string, cands []string) string {
	best, bd := "", 3
	for _, c := range cands {
		if d := editDistance(s, c); d < bd && d > 0 {
			best, bd = c, d
		}
	}
	return best
}

func editDistance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur := make([]int, len(rb)+1)
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(rb)]
}
