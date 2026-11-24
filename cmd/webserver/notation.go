package main

// POST /api/notation: the pflow notation (docs/pflow-notation.md,
// internal/notation) for the IDE shell's notation panel. One endpoint, both
// directions, rendered by the Go package that is the notation's executable
// spec, so the page carries no second parser:
//
//	{"net": {...JSON-LD...}}  ->  {text, lossy, nodes, diagnostics}
//	{"text": "..."}           ->  {net, cid, nodes, diagnostics}   (net and cid are null when the text has an error)
//
// "advise": true also runs the advisor's third tier (go-pflow's verifier:
// deadlock, boundedness, liveness, P-invariants), bounded at notationAdviseStates
// states, with each verdict on the line of the text it is about.
//
// nodes maps each place and transition id to the 1-based line that declares it,
// so a node:<id> target can scroll there. A diagnostic is {severity
// (error|warn|info), message, source (syntax|check|analysis), line, col,
// end_line, end_col, help?, nodes?}: the shape the shell's Diagnostics panel
// takes. Nothing is stored or logged; a pushed private net stays private.

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/pflow-xyz/pflow-xyz/internal/notation"
)

const (
	maxNotationBytes     = 256 << 10
	notationAdviseStates = 2000
)

type notationDiag struct {
	Severity string   `json:"severity"`
	Message  string   `json:"message"`
	Source   string   `json:"source"`
	Line     int      `json:"line"`
	Col      int      `json:"col"`
	EndLine  int      `json:"end_line"`
	EndCol   int      `json:"end_col"`
	Help     string   `json:"help,omitempty"`
	Nodes    []string `json:"nodes,omitempty"`
}

// notationNodes is each declared place and transition's line, and a lookup of
// a declaration span to its id (for a diagnostic's related spans).
func notationNodes(f *notation.File) (map[string]int, map[notation.Span]string) {
	lines := map[string]int{}
	bySpan := map[notation.Span]string{}
	if f == nil {
		return lines, bySpan
	}
	for _, p := range f.Places {
		l, _ := notation.LineCol(f.Src, p.ID.Span.Start)
		lines[p.ID.Name] = l
		bySpan[p.ID.Span] = p.ID.Name
	}
	for _, t := range f.Transitions {
		l, _ := notation.LineCol(f.Src, t.ID.Span.Start)
		lines[t.ID.Name] = l
		bySpan[t.ID.Span] = t.ID.Name
	}
	return lines, bySpan
}

func notationDiags(src string, ds []notation.Diagnostic, bySpan map[notation.Span]string) []notationDiag {
	out := make([]notationDiag, 0, len(ds))
	for _, d := range ds {
		sev := "info"
		switch d.Severity {
		case notation.Error:
			sev = "error"
		case notation.Warning:
			sev = "warn"
		}
		l, c := notation.LineCol(src, d.Span.Start)
		el, ec := notation.LineCol(src, d.Span.End)
		nd := notationDiag{Severity: sev, Message: d.Message, Source: d.Source, Line: l, Col: c, EndLine: el, EndCol: ec, Help: d.Help}
		if id, ok := bySpan[d.Span]; ok {
			nd.Nodes = append(nd.Nodes, id)
		}
		for _, r := range d.Related {
			if id, ok := bySpan[r.Span]; ok {
				nd.Nodes = append(nd.Nodes, id)
			}
		}
		out = append(out, nd)
		if len(out) == 200 {
			break
		}
	}
	return out
}

func (s *Server) handleNotation(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		filesError(w, http.StatusMethodNotAllowed, "POST a net or a text", nil)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxNotationBytes+1))
	if err != nil || len(body) > maxNotationBytes {
		filesError(w, http.StatusRequestEntityTooLarge, "at most 256 KiB", nil)
		return
	}
	var in struct {
		Net    json.RawMessage `json:"net"`
		Text   *string         `json:"text"`
		Advise bool            `json:"advise"`
	}
	if json.Unmarshal(body, &in) != nil || (len(in.Net) == 0) == (in.Text == nil) {
		filesError(w, http.StatusBadRequest, `send {"net": {...}} or {"text": "..."}`, nil)
		return
	}
	advise := func(f *notation.File, doc notation.Obj, bySpan map[notation.Span]string, src string) []notationDiag {
		if !in.Advise || f == nil || doc == nil {
			return nil
		}
		ds, err := notation.Advise(f, doc, notationAdviseStates)
		if err != nil {
			return []notationDiag{{Severity: "info", Message: "the advisor could not read this net: " + err.Error(), Source: "analysis", Line: 1, Col: 1, EndLine: 1, EndCol: 1}}
		}
		return notationDiags(src, ds, bySpan)
	}

	if in.Text != nil {
		src := *in.Text
		f, ds := notation.Parse(src)
		ds = append(ds, f.Check()...)
		nodes, bySpan := notationNodes(f)
		out := map[string]any{"net": nil, "cid": nil, "nodes": nodes}
		bad := false
		for _, d := range ds {
			bad = bad || d.IsError()
		}
		diags := notationDiags(src, ds, bySpan)
		if !bad {
			doc, err := notation.Compile(f)
			if err != nil {
				diags = append(diags, notationDiag{Severity: "error", Message: err.Error(), Source: "check", Line: 1, Col: 1, EndLine: 1, EndCol: 1})
			} else {
				out["net"] = json.RawMessage(notation.MarshalJSON(doc))
				if cid, err := notation.CID(doc); err == nil {
					out["cid"] = cid
				}
				diags = append(diags, advise(f, doc, bySpan, src)...)
			}
		}
		out["diagnostics"] = diags
		writeJSON(w, http.StatusOK, out)
		return
	}

	v, err := notation.ParseJSON(in.Net)
	if err != nil {
		filesError(w, http.StatusBadRequest, "net: "+err.Error(), nil)
		return
	}
	text, lossy, err := notation.Print(v)
	if err != nil {
		filesError(w, http.StatusBadRequest, "net: "+err.Error(), nil)
		return
	}
	f, ds := notation.Parse(text)
	nodes, bySpan := notationNodes(f)
	diags := notationDiags(text, ds, bySpan) // a printed text should parse; anything here is a printer bug, shown not hidden
	if doc, ok := v.(notation.Obj); ok {
		diags = append(diags, advise(f, doc, bySpan, text)...)
	}
	if lossy == nil {
		lossy = []string{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"text": strings.TrimRight(text, "\n") + "\n", "lossy": lossy, "nodes": nodes, "diagnostics": diags})
}
