// SPDX-License-Identifier: MIT

package notation

// The syntax tree of the core subset: what the parser reads and the checker,
// the compiler and the outline work from. Every node keeps its byte span, so a
// diagnostic about the net lands on the line (and the token) that wrote it.

// Item is one entry of a literal vector: a number or null.
type Item struct {
	Span Span
	Null bool
	Num  string // as written
}

// Term is one `N colour` of a sum; Colour is "" when the colour is not written.
type Term struct {
	Span       Span
	Num        string
	NumSpan    Span
	Colour     string
	ColourSpan Span
}

// Vec is a marking, a capacity or a weight: a literal `[1, 0, 2]` or a sum
// `1 red + 2 blue`.
type Vec struct {
	Span    Span
	Literal bool
	Items   []Item
	Terms   []Term
}

// Str is a string literal with its decoded value.
type Str struct {
	Span  Span
	Value string
}

// Num is a number literal with its text.
type NumLit struct {
	Span Span
	Text string
}

// At is a layout position `@ x, y`.
type At struct {
	Span Span
	X, Y string
}

// ID is a place, transition or colour name.
type ID struct {
	Span   Span
	Name   string
	Quoted bool
}

// PlaceDecl is a `place` line.
type PlaceDecl struct {
	Span   Span // the whole line
	ID     ID
	Init   *Vec
	Cap    *Vec
	Label  *Str
	About  *Str
	Offset *NumLit
	At     *At
}

// TransDecl is a `transition` line.
type TransDecl struct {
	Span   Span
	ID     ID
	Rate   *NumLit
	Label  *Str
	About  *Str
	Role   *ID
	Offset *NumLit
	At     *At
}

// Operand is one end of an arc, with the weight written on it.
type Operand struct {
	ID     ID
	Weight *Vec
}

// ArcDecl is one arc: a statement `a, b -> t -> c` is three of them.
type ArcDecl struct {
	Span  Span // the whole statement
	Src   Operand
	Dst   Operand
	Arrow string // "->", "-o" or "<->"
	Hop   Span   // the arrow token
}

// ColourDecl is one entry of a `color` line.
type ColourDecl struct {
	Span Span
	Name ID
	URI  string // "" for the default https://pflow.xyz/tokens/<name>
}

// Stmt is a statement as the outline sees it.
type Stmt struct {
	Kind string // pragma net about color parents place transition arc
	Name string
	Span Span
}

// File is a parsed program.
type File struct {
	Src         string
	Version     string // the pragma's version, "" when there is none
	HasNet      bool
	Kind        string // the net's @type, "PetriNet" by default
	KindSpan    Span
	Name        *Str
	About       *Str
	Colours     []*ColourDecl
	ParentsList []string
	ParentsSpan Span
	HasParents  bool
	Places      []*PlaceDecl
	Transitions []*TransDecl
	Arcs        []*ArcDecl
	Stmts       []Stmt
	// Broken lists the names a `place` or `transition` line declared before it failed to
	// parse: the line is lost, the name is not, so an arc that uses it is not reported as
	// naming something undeclared on top of the real error.
	Broken []BrokenDecl
}

// BrokenDecl is a name declared on a line that did not parse.
type BrokenDecl struct {
	ID   ID
	Kind string // "place" or "transition"
}
