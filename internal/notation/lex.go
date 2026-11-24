// SPDX-License-Identifier: MIT

package notation

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// TokKind is the kind of a token.
type TokKind int

const (
	TWord TokKind = iota // a name or a reserved word
	TNumber
	TString
	TURI
	TSym
	TNewline
	TEOF
	TError
)

// Token is one lexical item with its byte span.
type Token struct {
	Kind       TokKind
	Text       string
	Start, End int
}

func (t Token) Span() Span { return Span{t.Start, t.End} }

// Reserved words: the words that start a statement or an attribute. A place, a
// transition or a colour is never called one of these unless the name is quoted.
// The other words the grammar spells (in, out, null, sum, event, when ...) are
// read as words only where the grammar expects them, so `in -> work -> out` is an arc.
var reserved = map[string]bool{
	"net": true, "about": true, "color": true, "parents": true, "place": true, "transition": true,
	"cap": true, "label": true, "offset": true, "rate": true, "role": true,
	"ext": true, "compose": true, "part": true, "port": true, "link": true,
}

// IsReserved reports whether a word is reserved.
func IsReserved(w string) bool { return reserved[w] }

func isWordStart(r rune) bool { return r == '_' || (r < 128 && unicode.IsLetter(r)) }
func isWordPart(r rune) bool  { return isWordStart(r) || (r >= '0' && r <= '9') }

// Lex reads the whole text. Comments (`#` to the end of the line) are dropped,
// except that `#!` at the start of a line is the pragma token. Every line ends
// in a TNewline token (the last one is added if the text does not end in one),
// and the stream ends with TEOF.
func Lex(src string) []Token {
	var toks []Token
	i := 0
	lineStart := true
	for i < len(src) {
		r, w := utf8.DecodeRuneInString(src[i:])
		switch {
		case r == '\n':
			toks = append(toks, Token{TNewline, "\n", i, i + 1})
			i++
			lineStart = true
			continue
		case r == '\r' || r == ' ' || r == '\t' || r == 0xFEFF:
			i += w
			continue
		case r == '#':
			if lineStart && strings.HasPrefix(src[i:], "#!") {
				toks = append(toks, Token{TSym, "#!", i, i + 2})
				i += 2
				lineStart = false
				continue
			}
			for i < len(src) && src[i] != '\n' {
				i++
			}
			continue
		}
		lineStart = false
		start := i
		switch {
		case r == '"':
			j := i + 1
			closed := false
			for j < len(src) && src[j] != '\n' {
				if src[j] == '\\' && j+1 < len(src) && src[j+1] != '\n' {
					j += 2
					continue
				}
				if src[j] == '"' {
					j++
					closed = true
					break
				}
				j++
			}
			if !closed {
				toks = append(toks, Token{TError, src[start:j], start, j})
			} else {
				toks = append(toks, Token{TString, src[start:j], start, j})
			}
			i = j
		case isWordStart(r):
			j := i
			for j < len(src) {
				c, cw := utf8.DecodeRuneInString(src[j:])
				if !isWordPart(c) {
					break
				}
				j += cw
			}
			toks = append(toks, Token{TWord, src[start:j], start, j})
			i = j
		case (r >= '0' && r <= '9') || (r == '-' && i+1 < len(src) && src[i+1] >= '0' && src[i+1] <= '9'):
			j := i + 1
			for j < len(src) && src[j] >= '0' && src[j] <= '9' {
				j++
			}
			if j+1 < len(src) && src[j] == '.' && src[j+1] >= '0' && src[j+1] <= '9' {
				j++
				for j < len(src) && src[j] >= '0' && src[j] <= '9' {
					j++
				}
			}
			if j < len(src) && (src[j] == 'e' || src[j] == 'E') {
				k := j + 1
				if k < len(src) && (src[k] == '+' || src[k] == '-') {
					k++
				}
				if k < len(src) && src[k] >= '0' && src[k] <= '9' {
					for k < len(src) && src[k] >= '0' && src[k] <= '9' {
						k++
					}
					j = k
				}
			}
			toks = append(toks, Token{TNumber, src[start:j], start, j})
			i = j
		case strings.HasPrefix(src[i:], "<->"):
			toks = append(toks, Token{TSym, "<->", i, i + 3})
			i += 3
		case strings.HasPrefix(src[i:], "->"):
			toks = append(toks, Token{TSym, "->", i, i + 2})
			i += 2
		case strings.HasPrefix(src[i:], "-o") && (i+2 >= len(src) || src[i+2] == ' ' || src[i+2] == '\t' || src[i+2] == '\n' || src[i+2] == '\r'):
			toks = append(toks, Token{TSym, "-o", i, i + 2})
			i += 2
		case r == '<':
			j := i + 1
			for j < len(src) && src[j] != '>' && src[j] != '\n' && src[j] != ' ' {
				j++
			}
			if j < len(src) && src[j] == '>' {
				toks = append(toks, Token{TURI, src[start : j+1], start, j + 1})
				i = j + 1
			} else {
				toks = append(toks, Token{TError, src[start:j], start, j})
				i = j
			}
		case strings.ContainsRune("=*,@+[]{}.:~", r):
			toks = append(toks, Token{TSym, string(r), i, i + w})
			i += w
		default:
			toks = append(toks, Token{TError, string(r), i, i + w})
			i += w
		}
	}
	if n := len(toks); n == 0 || toks[n-1].Kind != TNewline {
		toks = append(toks, Token{TNewline, "", len(src), len(src)})
	}
	toks = append(toks, Token{TEOF, "", len(src), len(src)})
	return toks
}

// Unquote reads a TString token's text.
func Unquote(tok string) string {
	v, err := ParseJSON([]byte(tok))
	if s, ok := v.(string); ok && err == nil {
		return s
	}
	return strings.Trim(tok, `"`)
}
