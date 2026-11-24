// SPDX-License-Identifier: MIT

package notation

import (
	"fmt"
	"strings"
)

// Parse reads a program. It never stops at the first error: the grammar is one
// statement to a line, so a line that does not parse is reported and skipped,
// and the lines after it are read as usual. The returned File holds everything
// that did parse.
func Parse(src string) (*File, []Diagnostic) {
	p := &parser{src: src, toks: Lex(src), f: &File{Src: src, Kind: "PetriNet"}}
	p.run()
	return p.f, p.diags
}

type parser struct {
	src   string
	toks  []Token
	at    int
	f     *File
	diags []Diagnostic
	// per line
	lineStart int
	failed    bool
}

func (p *parser) peek() Token { return p.toks[p.at] }

func (p *parser) next() Token {
	t := p.toks[p.at]
	if t.Kind != TNewline && t.Kind != TEOF {
		p.at++
	}
	return t
}

func (p *parser) atEnd() bool {
	k := p.peek().Kind
	return k == TNewline || k == TEOF
}

func (p *parser) isSym(s string) bool {
	t := p.peek()
	return t.Kind == TSym && t.Text == s
}

func (p *parser) isWord(s string) bool {
	t := p.peek()
	return t.Kind == TWord && t.Text == s
}

func (p *parser) accept(s string) bool {
	t := p.peek()
	if (t.Kind == TSym || t.Kind == TWord) && t.Text == s {
		p.at++
		return true
	}
	return false
}

func describe(t Token) string {
	switch t.Kind {
	case TNewline, TEOF:
		return "the end of the line"
	case TString:
		return t.Text
	}
	return "`" + t.Text + "`"
}

// fail records a syntax error at the current token and marks the line failed.
func (p *parser) fail(msg string, expected ...string) {
	if p.failed {
		return
	}
	p.failed = true
	t := p.peek()
	sp := t.Span()
	if t.Kind == TNewline || t.Kind == TEOF {
		// point at the end of the last token of the line, not at the newline
		if p.at > p.lineStart {
			prev := p.toks[p.at-1]
			sp = Span{prev.End, prev.End + 1}
			if sp.End > len(p.src) {
				sp = Span{prev.End, prev.End}
			}
		}
	}
	d := Diagnostic{Severity: Error, Source: "syntax", Span: sp, Message: msg, Expected: expected}
	if t.Kind != TNewline && t.Kind != TEOF {
		d.Found = t.Text
	} else {
		d.Found = "the end of the line"
	}
	p.diags = append(p.diags, d)
}

func (p *parser) run() {
	first := true
	for p.peek().Kind != TEOF {
		p.lineStart = p.at
		p.failed = false
		if p.peek().Kind == TNewline {
			p.at++
			continue
		}
		start := p.peek().Start
		p.statement(first)
		first = false
		// anything left on the line is an error, unless the line already failed
		if !p.failed && !p.atEnd() {
			p.fail("this does not belong on the line: the statement is complete before it")
		}
		// resync: the next line
		for p.peek().Kind != TNewline && p.peek().Kind != TEOF {
			p.at++
		}
		if p.peek().Kind == TNewline {
			p.at++
		}
		_ = start
	}
}

var statementWords = []string{"net", "about", "color", "parents", "place", "transition", "ext", "compose", "part", "port", "link"}

func (p *parser) statement(first bool) {
	t := p.peek()
	start := t.Start
	endOf := func() int { return p.toks[p.at-1].End }
	switch {
	case t.Kind == TSym && t.Text == "#!":
		p.pragma(first)
	case t.Kind == TWord && t.Text == "net":
		p.at++
		p.netStmt()
	case t.Kind == TWord && t.Text == "about":
		p.at++
		if s := p.str("the net's description"); s != nil {
			p.f.About = s
			p.f.Stmts = append(p.f.Stmts, Stmt{"about", "", Span{start, endOf()}})
		}
	case t.Kind == TWord && t.Text == "color":
		p.at++
		p.colorStmt(start)
	case t.Kind == TWord && t.Text == "parents":
		p.at++
		p.parentsStmt(start)
	case t.Kind == TWord && t.Text == "place":
		p.at++
		p.placeStmt(start)
	case t.Kind == TWord && t.Text == "transition":
		p.at++
		p.transitionStmt(start)
	case t.Kind == TWord && (t.Text == "compose" || t.Text == "part" || t.Text == "port" || t.Text == "link" || t.Text == "ext"):
		p.fail(fmt.Sprintf("`%s` is in the grammar (docs/notation/pflow.ebnf) but not in this prototype's core subset", t.Text))
	case t.Kind == TWord || t.Kind == TString:
		p.arcStmt(start)
	case t.Kind == TError:
		p.fail("this character is not part of the notation")
	default:
		p.fail("a statement starts with a word", append([]string{"an id (an arc)"}, statementWords[:7]...)...)
	}
}

func (p *parser) pragma(first bool) {
	start := p.peek().Start
	p.at++
	if !first {
		p.at--
		p.fail("the `#!` line comes first in the file")
		return
	}
	if !p.accept("pflow") {
		p.fail("the pragma names the language", "pflow")
		return
	}
	t := p.peek()
	if t.Kind != TNumber {
		p.fail("the pragma carries the notation's version", "a whole number")
		return
	}
	p.at++
	p.f.Version = t.Text
	p.f.Stmts = append(p.f.Stmts, Stmt{"pragma", "", Span{start, t.End}})
	if t.Text != "1" {
		p.diags = append(p.diags, Diagnostic{Severity: Error, Source: "syntax", Span: t.Span(), Message: "this reader knows `#! pflow 1` only", Expected: []string{"1"}, Found: t.Text})
	}
}

func (p *parser) str(what string) *Str {
	t := p.peek()
	if t.Kind != TString {
		p.fail("a quoted string is written here: "+what, "a string in double quotes")
		return nil
	}
	p.at++
	return &Str{t.Span(), Unquote(t.Text)}
}

func (p *parser) number(what string) *NumLit {
	t := p.peek()
	if t.Kind != TNumber {
		p.fail("a number is written here: "+what, "a number")
		return nil
	}
	p.at++
	return &NumLit{t.Span(), t.Text}
}

// name reads an id: a word that is not reserved, or a quoted string.
func (p *parser) name(what string) *ID {
	t := p.peek()
	switch {
	case t.Kind == TWord && !IsReserved(t.Text):
		p.at++
		return &ID{t.Span(), t.Text, false}
	case t.Kind == TString:
		p.at++
		return &ID{t.Span(), Unquote(t.Text), true}
	case t.Kind == TWord:
		p.fail(fmt.Sprintf("`%s` is a reserved word and cannot name %s", t.Text, what), "a name", "a quoted name: \""+t.Text+"\"")
	default:
		p.fail("a name is written here: "+what, "a name")
	}
	return nil
}

func (p *parser) netStmt() {
	start := p.toks[p.at-1].Start
	if p.f.HasNet {
		p.at--
		p.fail("a file describes one net: `net` appears once (several nets in a file arrive with `compose`)")
		return
	}
	p.f.HasNet = true
	if t := p.peek(); t.Kind == TWord && !IsReserved(t.Text) {
		p.at++
		p.f.Kind = t.Text
		p.f.KindSpan = t.Span()
	}
	if p.peek().Kind == TString {
		p.f.Name = p.str("the net's name")
	}
	p.f.Stmts = append(p.f.Stmts, Stmt{"net", "", Span{start, p.toks[p.at-1].End}})
}

func (p *parser) colorStmt(start int) {
	for {
		id := p.name("a colour")
		if id == nil {
			return
		}
		cd := &ColourDecl{Span: id.Span, Name: *id}
		if p.accept("=") {
			t := p.peek()
			if t.Kind != TURI {
				p.fail("a colour's token URI is written in angle brackets", "<https://...>")
				return
			}
			p.at++
			cd.URI = strings.Trim(t.Text, "<>")
			cd.Span.End = t.End
		}
		p.f.Colours = append(p.f.Colours, cd)
		if !p.accept(",") {
			break
		}
	}
	p.f.Stmts = append(p.f.Stmts, Stmt{"color", "", Span{start, p.toks[p.at-1].End}})
}

func (p *parser) parentsStmt(start int) {
	p.f.HasParents = true
	p.f.ParentsSpan = Span{start, start}
	for {
		t := p.peek()
		if t.Kind != TWord || !looksLikeCID(t.Text) {
			p.fail("a parent is a CID: `z` and base58 characters", "a CID")
			return
		}
		p.at++
		p.f.ParentsList = append(p.f.ParentsList, t.Text)
		if !p.accept(",") {
			break
		}
	}
	p.f.ParentsSpan.End = p.toks[p.at-1].End
	p.f.Stmts = append(p.f.Stmts, Stmt{"parents", "", p.f.ParentsSpan})
}

const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

func looksLikeCID(s string) bool {
	if len(s) < 21 || len(s) > 101 || s[0] != 'z' {
		return false
	}
	for _, c := range s[1:] {
		if !strings.ContainsRune(base58, c) {
			return false
		}
	}
	return true
}

func (p *parser) at2() *At {
	start := p.peek().Start
	p.at++ // @
	x := p.number("the x of the position")
	if x == nil {
		return nil
	}
	if !p.accept(",") {
		p.fail("a position is `@ x, y`", ",")
		return nil
	}
	y := p.number("the y of the position")
	if y == nil {
		return nil
	}
	return &At{Span{start, y.Span.End}, x.Text, y.Text}
}

func (p *parser) placeStmt(start int) {
	id := p.name("a place")
	if id == nil {
		return
	}
	d := &PlaceDecl{ID: *id}
	defer func() {
		if p.failed {
			p.f.Broken = append(p.f.Broken, BrokenDecl{*id, "place"})
		}
	}()
	if p.accept("=") {
		if d.Init = p.marking("the initial marking"); d.Init == nil {
			return
		}
	}
	for !p.atEnd() {
		t := p.peek()
		switch {
		case t.Kind == TWord && t.Text == "cap":
			p.at++
			if d.Cap = p.marking("the capacity"); d.Cap == nil {
				return
			}
		case t.Kind == TWord && t.Text == "label":
			p.at++
			if d.Label = p.str("the label"); d.Label == nil {
				return
			}
		case t.Kind == TWord && t.Text == "about":
			p.at++
			if d.About = p.str("the description"); d.About == nil {
				return
			}
		case t.Kind == TWord && t.Text == "offset":
			p.at++
			if d.Offset = p.number("the offset"); d.Offset == nil {
				return
			}
		case t.Kind == TSym && t.Text == "@":
			if d.At = p.at2(); d.At == nil {
				return
			}
		default:
			p.fail("a place line takes `= <marking>`, `cap`, `label`, `about`, `offset` and `@ x, y`", "cap", "label", "about", "offset", "@")
			return
		}
	}
	d.Span = Span{start, p.toks[p.at-1].End}
	p.f.Places = append(p.f.Places, d)
	p.f.Stmts = append(p.f.Stmts, Stmt{"place", d.ID.Name, d.Span})
}

func (p *parser) transitionStmt(start int) {
	id := p.name("a transition")
	if id == nil {
		return
	}
	d := &TransDecl{ID: *id}
	defer func() {
		if p.failed {
			p.f.Broken = append(p.f.Broken, BrokenDecl{*id, "transition"})
		}
	}()
	for !p.atEnd() {
		t := p.peek()
		switch {
		case t.Kind == TWord && t.Text == "rate":
			p.at++
			if d.Rate = p.number("the rate"); d.Rate == nil {
				return
			}
		case t.Kind == TWord && t.Text == "label":
			p.at++
			if d.Label = p.str("the label"); d.Label == nil {
				return
			}
		case t.Kind == TWord && t.Text == "about":
			p.at++
			if d.About = p.str("the description"); d.About == nil {
				return
			}
		case t.Kind == TWord && t.Text == "role":
			p.at++
			if d.Role = p.name("the role"); d.Role == nil {
				return
			}
		case t.Kind == TWord && t.Text == "offset":
			p.at++
			if d.Offset = p.number("the offset"); d.Offset == nil {
				return
			}
		case t.Kind == TSym && t.Text == "@":
			if d.At = p.at2(); d.At == nil {
				return
			}
		default:
			p.fail("a transition line takes `rate`, `label`, `about`, `role`, `offset` and `@ x, y`", "rate", "label", "about", "role", "offset", "@")
			return
		}
	}
	d.Span = Span{start, p.toks[p.at-1].End}
	p.f.Transitions = append(p.f.Transitions, d)
	p.f.Stmts = append(p.f.Stmts, Stmt{"transition", d.ID.Name, d.Span})
}

// marking reads a literal `[1, null]` or a sum `2 red + 1 blue`.
func (p *parser) marking(what string) *Vec {
	t := p.peek()
	if t.Kind == TSym && t.Text == "[" {
		return p.literal(what)
	}
	if t.Kind != TNumber {
		p.fail("a number or a `[...]` list is written here: "+what, "a number", "[")
		return nil
	}
	v := &Vec{Span: Span{t.Start, t.End}}
	for {
		nt := p.peek()
		if nt.Kind != TNumber {
			p.fail("a number is written here: "+what, "a number")
			return nil
		}
		p.at++
		term := Term{Span: nt.Span(), Num: nt.Text, NumSpan: nt.Span()}
		if c := p.peek(); c.Kind == TWord && !IsReserved(c.Text) {
			p.at++
			term.Colour = c.Text
			term.ColourSpan = c.Span()
			term.Span.End = c.End
		}
		v.Terms = append(v.Terms, term)
		v.Span.End = term.Span.End
		if !p.accept("+") {
			break
		}
	}
	return v
}

func (p *parser) literal(what string) *Vec {
	open := p.next()
	v := &Vec{Span: Span{open.Start, open.End}, Literal: true}
	if p.accept("]") {
		v.Span.End = p.toks[p.at-1].End
		return v
	}
	for {
		t := p.peek()
		switch {
		case t.Kind == TNumber:
			p.at++
			v.Items = append(v.Items, Item{Span: t.Span(), Num: t.Text})
		case t.Kind == TWord && t.Text == "null":
			p.at++
			v.Items = append(v.Items, Item{Span: t.Span(), Null: true})
		default:
			p.fail("a list holds numbers (and `null` for an unbounded capacity)", "a number", "null")
			return nil
		}
		if p.accept(",") {
			continue
		}
		if p.accept("]") {
			break
		}
		p.fail("a list is closed with `]`", ",", "]")
		return nil
	}
	v.Span.End = p.toks[p.at-1].End
	return v
}

// arcStmt reads `group arrow group { arrow group }` and expands it to arcs:
// each hop pairs every operand on its left with every operand on its right, in
// that order, and the arcs come out in the order the text writes them.
func (p *parser) arcStmt(start int) {
	groups := [][]Operand{}
	arrows := []Token{}
	for {
		g := p.group()
		if g == nil {
			return
		}
		groups = append(groups, g)
		t := p.peek()
		if t.Kind == TSym && (t.Text == "->" || t.Text == "-o" || t.Text == "<->") {
			p.at++
			arrows = append(arrows, t)
			continue
		}
		break
	}
	if len(arrows) == 0 {
		p.fail("a line that starts with a name is an arc: `a -> b`", "->", "-o", "<->")
		return
	}
	end := p.toks[p.at-1].End
	for i, ar := range arrows {
		for _, l := range groups[i] {
			for _, r := range groups[i+1] {
				p.f.Arcs = append(p.f.Arcs, &ArcDecl{Span: Span{start, end}, Src: l, Dst: r, Arrow: ar.Text, Hop: ar.Span()})
			}
		}
	}
	p.f.Stmts = append(p.f.Stmts, Stmt{"arc", "", Span{start, end}})
}

func (p *parser) group() []Operand {
	var g []Operand
	for {
		id := p.name("an arc's end")
		if id == nil {
			return nil
		}
		op := Operand{ID: *id}
		if p.accept("*") {
			w := p.weight()
			if w == nil {
				return nil
			}
			op.Weight = w
		}
		g = append(g, op)
		if !p.accept(",") {
			return g
		}
	}
}

func (p *parser) weight() *Vec {
	return p.marking("the weight")
}
