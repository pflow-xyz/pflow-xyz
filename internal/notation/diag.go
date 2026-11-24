// SPDX-License-Identifier: MIT

package notation

import (
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Severity of a diagnostic: the three BeatScript's djlive::diag has.
type Severity string

const (
	Error   Severity = "error"
	Warning Severity = "warning"
	Info    Severity = "info"
)

// Span is a byte range of the program text.
type Span struct{ Start, End int }

// Diagnostic is one thing to tell the person typing: the shape of
// djlive::diag::Diagnostic, so an editor that draws BeatScript's squiggles
// draws these. Source says which tier produced it ("syntax", "check",
// "analysis").
type Diagnostic struct {
	Severity Severity
	Source   string
	Span     Span
	Message  string
	Expected []string
	Found    string
	Help     string
	// Related are other places in the text that the diagnostic is about: the other
	// places of a conservation law, the transitions a deadlock leaves dead.
	Related []Related
	// Data is what a client can act on without reading the message: the verdict
	// (proved, refuted, unknown), a witness firing sequence, the invariant's terms.
	Data Obj
}

// Related is a second span a diagnostic points at, with its own words.
type Related struct {
	Span    Span
	Message string
}

func (d Diagnostic) IsError() bool { return d.Severity == Error }

// LineCol returns the 1-based line and column (in characters) of a byte offset.
func LineCol(src string, off int) (line, col int) {
	if off > len(src) {
		off = len(src)
	}
	line, col = 1, 1
	for i, r := range src {
		if i >= off {
			break
		}
		if r == '\n' {
			line++
			col = 1
		} else {
			col++
		}
	}
	return
}

// Position is the 1-based line, column and the column just past the end on that
// line (the span's end, or the line's end when it runs over): BeatScript's
// Diagnostic::position.
func (d Diagnostic) Position(src string) (line, col, endCol int) {
	line, col = LineCol(src, d.Span.Start)
	endLine, endC := LineCol(src, d.Span.End)
	if endLine == line {
		endCol = endC
		if endCol < col+1 {
			endCol = col + 1
		}
	} else {
		endCol = col + 1
	}
	return
}

func utf16At(src string, off int) int {
	if off > len(src) {
		off = len(src)
	}
	n := 0
	for _, r := range src[:off] {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

// Render is the caret form for a terminal or a model:
//
//	error: message
//	  --> 3:7
//	   |
//	 3 | place x = oops
//	   |           ^^^^
func (d Diagnostic) Render(src string) string {
	line, col, endCol := d.Position(src)
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	text := ""
	if line-1 < len(lines) {
		text = lines[line-1]
	}
	gutter := fmt.Sprint(line)
	pad := strings.Repeat(" ", len(gutter))
	n := endCol - col
	if n < 1 {
		n = 1
	}
	s := fmt.Sprintf("%s: %s\n%s--> %d:%d\n%s |\n%s | %s\n%s | %s%s", d.Severity, d.Message, pad, line, col, pad, gutter, text, pad, strings.Repeat(" ", col-1), strings.Repeat("^", n))
	if len(d.Expected) > 0 {
		s += "\n" + pad + " = expected: " + listOr(d.Expected)
	}
	if d.Found != "" {
		s += "\n" + pad + " = found: " + d.Found
	}
	if d.Help != "" {
		s += "\n" + pad + " = help: " + d.Help
	}
	return s
}

func listOr(xs []string) string {
	switch len(xs) {
	case 0:
		return ""
	case 1:
		return xs[0]
	case 2:
		return xs[0] + " or " + xs[1]
	}
	return strings.Join(xs[:len(xs)-1], ", ") + " or " + xs[len(xs)-1]
}

// JSON is the diagnostic as the web editor and the CLI of BeatScript carry it:
// severity, line, col (1-based, in characters), end_col, byte offsets start/end
// and UTF-16 offsets start16/end16, message, expected, found, help and render.
// "source" is the one field BeatScript's lacks.
func (d Diagnostic) JSON(src string) Obj {
	line, col, endCol := d.Position(src)
	start, end := d.Span.Start, d.Span.End
	if start > len(src) {
		start = len(src)
	}
	if end > len(src) {
		end = len(src)
	}
	exp := []any{}
	for _, e := range d.Expected {
		exp = append(exp, e)
	}
	var help any
	if d.Help != "" {
		help = d.Help
	}
	related := []any{}
	for _, r := range d.Related {
		l, c, ec := Diagnostic{Span: r.Span}.Position(src)
		related = append(related, Obj{{"line", l}, {"col", c}, {"end_col", ec}, {"start", r.Span.Start}, {"end", r.Span.End}, {"message", r.Message}})
	}
	var data any
	if len(d.Data) > 0 {
		data = d.Data
	}
	return Obj{
		{"severity", string(d.Severity)},
		{"source", d.Source},
		{"line", line},
		{"col", col},
		{"end_col", endCol},
		{"start", start},
		{"end", end},
		{"start16", utf16At(src, start)},
		{"end16", utf16At(src, end)},
		{"message", d.Message},
		{"expected", exp},
		{"found", d.Found},
		{"help", help},
		{"related", related},
		{"data", data},
		{"render", d.Render(src)},
	}
}

func runeCount(s string) int { return utf8.RuneCountInString(s) }
