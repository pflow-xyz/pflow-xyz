// SPDX-License-Identifier: MIT

package notation

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var nameRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// idText writes an id: bare when it is a plain name and not reserved, quoted otherwise.
func idText(id string) string {
	if nameRe.MatchString(id) && !IsReserved(id) {
		return id
	}
	return jsonString(id)
}

// Print writes a JSON-LD net in the notation's canonical form. The document
// must be the order-preserving read of the JSON (ParseJSON), because the order
// of places, transitions and arcs is the order of the text.
//
// Canonical form: one statement to a line, one space between tokens, sections
// in a fixed order (pragma, net, about, color, parents; places; transitions;
// arcs) with a blank line between them, one arc to a line in the order of the
// document's arcs, attributes in a fixed order, numbers in their shortest form.
//
// lossy lists everything in the document the notation's core subset cannot
// say. A document with nothing in lossy prints text that compiles back to the
// same CID in every case the round-trip tests cover; the CID comparison, not
// this list, is what decides (see docs/pflow-notation.md, "Round trips").
func Print(v any) (text string, lossy []string, err error) {
	doc, ok := v.(Obj)
	if !ok {
		return "", nil, fmt.Errorf("a net is a JSON object")
	}
	lose := func(format string, a ...any) { lossy = append(lossy, fmt.Sprintf(format, a...)) }
	str := func(o Obj, key string) (string, bool) {
		x, ok := o.Get(key)
		s, isStr := x.(string)
		return s, ok && isStr
	}

	known := map[string]bool{"@context": true, "@id": true, "@type": true, "@version": true, "arcs": true, "description": true, "name": true, "parents": true, "places": true, "token": true, "transitions": true}
	for _, kv := range doc {
		if !known[kv.Key] {
			lose("net: `%s` has no notation in the core subset", kv.Key)
		}
	}
	if c, _ := str(doc, "@context"); c != Context {
		lose("net: @context is not %s", Context)
	}
	if ver, _ := str(doc, "@version"); ver != ModelVersion {
		lose("net: @version is not %s", ModelVersion)
	}

	// colours
	var uris []string
	if t, ok := doc.Get("token"); ok {
		list, isList := t.([]any)
		if !isList {
			lose("net: token is not a list")
		}
		for _, x := range list {
			s, isStr := x.(string)
			if !isStr {
				lose("net: token holds a non-string")
				continue
			}
			uris = append(uris, s)
		}
	} else {
		lose("net: no `token` list (the notation always writes one)")
	}
	w := len(uris)
	if w == 0 {
		w = 1
	}
	var colourText []string
	colourNames := make([]string, len(uris))
	used := map[string]bool{}
	for i, u := range uris {
		name := ""
		if strings.HasPrefix(u, TokenURIPrefix) {
			n := strings.TrimPrefix(u, TokenURIPrefix)
			if nameRe.MatchString(n) && !IsReserved(n) && !used[n] {
				name = n
			}
		}
		if name != "" {
			colourText = append(colourText, name)
		} else {
			name = fmt.Sprintf("c%d", i+1)
			for used[name] {
				name += "_"
			}
			colourText = append(colourText, name+" = <"+u+">")
		}
		used[name] = true
		colourNames[i] = name
	}

	var b strings.Builder
	section := func() {
		if b.Len() > 0 {
			b.WriteByte('\n')
		}
	}
	b.WriteString("#! pflow 1\n")
	kind, _ := str(doc, "@type")
	if kind == "" {
		kind = "PetriNet"
	}
	line := "net"
	if kind != "PetriNet" {
		if !nameRe.MatchString(kind) || IsReserved(kind) {
			lose("net: @type `%s` is not a name", kind)
		} else {
			line += " " + kind
		}
	}
	if n, ok := str(doc, "name"); ok {
		line += " " + jsonString(n)
	}
	b.WriteString(line + "\n")
	if d, ok := str(doc, "description"); ok {
		b.WriteString("about " + jsonString(d) + "\n")
	}
	if len(colourText) > 0 {
		b.WriteString("color " + strings.Join(colourText, ", ") + "\n")
	}
	if ps, ok := doc.getList("parents"); ok {
		var cs []string
		for _, p := range ps {
			s, isStr := p.(string)
			if !isStr || !looksLikeCID(s) {
				lose("net: parents holds something that is not a CID")
				continue
			}
			cs = append(cs, s)
		}
		if len(cs) > 0 {
			b.WriteString("parents " + strings.Join(cs, ", ") + "\n")
		}
	}

	places, _ := doc.getObj("places")
	trans, _ := doc.getObj("transitions")
	kinds := map[string]string{}
	for _, kv := range places {
		kinds[kv.Key] = "place"
	}
	for _, kv := range trans {
		if kinds[kv.Key] == "place" {
			lose("net: `%s` is both a place and a transition", kv.Key)
		}
		kinds[kv.Key] = "transition"
	}

	// places
	if len(places) > 0 {
		section()
	}
	for _, kv := range places {
		o, ok := kv.Val.(Obj)
		if !ok {
			lose("place %s: not an object", kv.Key)
			continue
		}
		checkKeys(o, "place "+kv.Key, map[string]bool{"@type": true, "capacity": true, "description": true, "initial": true, "label": true, "offset": true, "x": true, "y": true}, lose)
		l := "place " + idText(kv.Key)
		if x, ok := o.Get("initial"); ok {
			if t := vecText(x, w, colourNames, false, lose, "place "+kv.Key+" initial"); t != "" {
				l += " = " + t
			}
		} else {
			lose("place %s: no `initial`", kv.Key)
		}
		if x, ok := o.Get("capacity"); ok {
			if t := vecText(x, w, colourNames, true, lose, "place "+kv.Key+" capacity"); t != "" {
				l += " cap " + t
			}
		} else {
			lose("place %s: no `capacity`", kv.Key)
		}
		l += attrs(o, kv.Key, lose, true)
		b.WriteString(l + "\n")
	}
	// transitions
	if len(trans) > 0 {
		section()
	}
	for _, kv := range trans {
		o, ok := kv.Val.(Obj)
		if !ok {
			lose("transition %s: not an object", kv.Key)
			continue
		}
		checkKeys(o, "transition "+kv.Key, map[string]bool{"@type": true, "description": true, "label": true, "offset": true, "rate": true, "role": true, "x": true, "y": true}, lose)
		l := "transition " + idText(kv.Key)
		if r, ok := o.Get("rate"); ok {
			if n, isNum := r.(Num); isNum {
				l += " rate " + canonNum(string(n))
			} else {
				lose("transition %s: rate is not a number", kv.Key)
			}
		}
		l += attrs(o, kv.Key, lose, false)
		b.WriteString(l + "\n")
	}
	// arcs
	arcs, _ := doc.getList("arcs")
	if len(arcs) > 0 {
		section()
	}
	for i, x := range arcs {
		o, ok := x.(Obj)
		if !ok {
			lose("arc %d: not an object", i)
			continue
		}
		checkKeys(o, fmt.Sprintf("arc %d", i), map[string]bool{"@type": true, "inhibitTransition": true, "source": true, "target": true, "weight": true}, lose)
		src, _ := str(o, "source")
		dst, _ := str(o, "target")
		inh, hasInh := o.Get("inhibitTransition")
		inhibit, _ := inh.(bool)
		if !hasInh {
			lose("arc %d: no `inhibitTransition`", i)
		}
		wt := ""
		if wx, ok := o.Get("weight"); ok {
			wt = weightText(wx, w, colourNames, lose, fmt.Sprintf("arc %d weight", i))
		} else {
			lose("arc %d: no `weight`", i)
		}
		sk, tk := kinds[src], kinds[dst]
		var l string
		switch {
		case inhibit && sk == "place" && tk == "transition":
			l = idText(src) + wt + " -o " + idText(dst)
		case inhibit && sk == "transition" && tk == "place":
			l = idText(dst) + wt + " <-> " + idText(src)
		case !inhibit && sk == "place" && tk == "transition":
			l = idText(src) + wt + " -> " + idText(dst)
		case !inhibit && sk == "transition" && tk == "place":
			l = idText(src) + " -> " + idText(dst) + wt
		default:
			lose("arc %d: %s -> %s does not join a place and a transition that exist", i, src, dst)
			l = idText(src) + " -> " + idText(dst) + wt
		}
		b.WriteString(l + "\n")
	}
	return b.String(), lossy, nil
}

func (o Obj) getObj(key string) (Obj, bool) {
	v, ok := o.Get(key)
	r, isObj := v.(Obj)
	return r, ok && isObj
}

func (o Obj) getList(key string) ([]any, bool) {
	v, ok := o.Get(key)
	r, isList := v.([]any)
	return r, ok && isList
}

func checkKeys(o Obj, where string, known map[string]bool, lose func(string, ...any)) {
	var extra []string
	for _, kv := range o {
		if !known[kv.Key] {
			extra = append(extra, kv.Key)
		}
	}
	sort.Strings(extra)
	for _, k := range extra {
		lose("%s: `%s` has no notation in the core subset", where, k)
	}
}

// attrs writes label, about, role, offset and the position, in that order.
func attrs(o Obj, id string, lose func(string, ...any), place bool) string {
	var l string
	if s, ok := o.Get("label"); ok {
		if str, isStr := s.(string); isStr {
			l += " label " + jsonString(str)
		} else {
			lose("%s: label is not a string", id)
		}
	}
	if s, ok := o.Get("description"); ok {
		if str, isStr := s.(string); isStr {
			l += " about " + jsonString(str)
		} else {
			lose("%s: description is not a string", id)
		}
	}
	if !place {
		if s, ok := o.Get("role"); ok {
			if str, isStr := s.(string); isStr {
				l += " role " + idText(str)
			} else {
				lose("%s: role is not a string", id)
			}
		}
	}
	off, hasOff := o.Get("offset")
	if hasOff {
		n, isNum := off.(Num)
		switch {
		case !isNum:
			lose("%s: offset is not a number", id)
		case place && canonNum(string(n)) == "0":
			// the editor's profile: every place has offset 0
		default:
			l += " offset " + canonNum(string(n))
		}
	} else if place {
		lose("%s: no `offset` (the notation writes offset 0 on every place)", id)
	}
	x, hx := o.Get("x")
	y, hy := o.Get("y")
	if hx && hy {
		xn, ok1 := x.(Num)
		yn, ok2 := y.(Num)
		if ok1 && ok2 {
			l += " @ " + canonNum(string(xn)) + ", " + canonNum(string(yn))
		} else {
			lose("%s: x or y is not a number", id)
		}
	} else if hx || hy {
		lose("%s: only one of x and y", id)
	}
	return l
}

// vecText writes a marking or capacity. "" means "write nothing": the compiler's
// default produces the same CID. capacity: a vector of nulls (or empty) is the
// default because the sealer drops nulls from a list, so [null], [null, null] and []
// are one document.
func vecText(x any, w int, colours []string, capacity bool, lose func(string, ...any), where string) string {
	list, ok := x.([]any)
	if !ok {
		lose("%s: not a list", where)
		return ""
	}
	allNull := true
	allNum := true
	for _, e := range list {
		if e != nil {
			allNull = false
		}
		if _, isNum := e.(Num); !isNum {
			allNum = false
		}
	}
	if capacity && allNull {
		return ""
	}
	if !capacity {
		zeros := len(list) == w && allNum
		if zeros {
			for _, e := range list {
				if canonNum(string(e.(Num))) != "0" {
					zeros = false
				}
			}
		}
		if zeros {
			return ""
		}
	}
	if allNum && len(list) == w {
		return sumText(list, colours)
	}
	return literalText(list, lose, where)
}

func literalText(list []any, lose func(string, ...any), where string) string {
	parts := make([]string, len(list))
	for i, e := range list {
		switch e := e.(type) {
		case nil:
			parts[i] = "null"
		case Num:
			parts[i] = canonNum(string(e))
		default:
			lose("%s: a list entry is not a number", where)
			parts[i] = "null"
		}
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// sumText writes the non-zero entries as `N colour + M colour`, or just `N` for a
// net with no colours; all zero is `0` (and the first colour when there are several).
func sumText(list []any, colours []string) string {
	var terms []string
	for i, e := range list {
		n := canonNum(string(e.(Num)))
		if n == "0" {
			continue
		}
		terms = append(terms, termText(n, i, colours))
	}
	if len(terms) == 0 {
		return termText("0", 0, colours)
	}
	return strings.Join(terms, " + ")
}

func termText(n string, i int, colours []string) string {
	if len(colours) <= 1 {
		return n
	}
	return n + " " + colours[i]
}

// weightText writes an arc's weight as the `*...` after the place, "" for the default [1].
func weightText(x any, w int, colours []string, lose func(string, ...any), where string) string {
	list, ok := x.([]any)
	if !ok {
		lose("%s: not a list", where)
		return ""
	}
	allNum := true
	for _, e := range list {
		if _, isNum := e.(Num); !isNum {
			allNum = false
		}
	}
	if w == 1 && len(list) == 1 && allNum && canonNum(string(list[0].(Num))) == "1" {
		return ""
	}
	if allNum && len(list) == w {
		return "*" + sumText(list, colours)
	}
	return "*" + literalText(list, lose, where)
}
