package main

// pflow_artifact: one net as a self-contained interactive page for a client
// to publish (a claude.ai Artifact, or any page host). The verdicts are
// computed here, on the same go-pflow engines as pflow_reachability and
// pflow_invariants (the handlers are called, not re-implemented), and baked
// into the page; the page plays the token game with go-pflow's firing rule
// (graph.go isEnabled/Fire, the contract petri-sim.js and parity/sim hold)
// and re-checks the P-invariants after every firing.
//
// engine "wasm" also embeds pflow-rs's reachability engine (artifact/
// engine.wasm, from experiments/artifact-wasm; artifact/engine.lock.json) as
// base64, decoded with atob and compiled with WebAssembly.instantiate — never
// fetched, since an Artifact's CSP blocks fetch("data:…") — so the page can
// re-analyze when the person edits the initial marking, and cross-checks the
// server's verdicts on load.
//
// The page is a fragment (no doctype, html, head or body): the client wraps
// it. It loads nothing from anywhere.

import (
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"

	"github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/pflow-xyz/internal/model"
)

//go:embed artifact/page.html
var artifactPage string

//go:embed artifact/engine.wasm
var artifactEngine []byte

// maxArtifactResultBytes bounds a pflow_artifact answer. It is over the
// general ~60KB guard because the page is the point of the call: a baked page
// is tens of KB, a wasm one about 450KB (the engine as base64).
const maxArtifactResultBytes = 1 << 20

const ontologyNS = "https://ontology.pflow.xyz/ns#"

func artifactTool() mcpTool {
	return mcpTool{
		Name: "pflow_artifact",
		Description: "One net as a self-contained interactive HTML page, for the person to see, play or share: publish the returned html as a page (an Artifact) as it is, without rewriting it. " +
			"The page draws the net from its own x/y, plays the token game (click or press Enter on an enabled transition, random step, reset), shows the verdicts of pflow_reachability and the P-invariants of pflow_invariants (re-checked after every firing), " +
			"replays the deadlock or livelock witness, tags the net with the ontology.pflow.xyz class its verdicts earn (LiveNet ⊂ DeadlockFreeNet ⊂ PetriNet, BoundedNet), and links the editor. " +
			"The html is a fragment (no doctype/html/head/body: the host wraps it) and loads nothing from any host. " +
			"engine \"baked\" (default, tens of KB) fixes the verdicts at the net's marking; \"wasm\" (about 450 KB, the pflow-rs engine embedded as base64) lets the person edit the initial marking and re-analyze in the page. Single-colour nets only.",
		InputSchema: obj(map[string]any{
			"net":        netArg,
			"title":      map[string]any{"type": "string", "description": "page title (default: the net's name)"},
			"max_states": map[string]any{"type": "integer", "description": "reachability budget (default 2000, ≤ 20000)"},
			"engine":     map[string]any{"type": "string", "enum": []any{"baked", "wasm"}, "description": "baked (default) or wasm"},
		}, "net"),
		run: mcpArtifact,
	}
}

// artifactResult is a tool answer that is already in MCP result form; the
// dispatcher passes it through instead of JSON-wrapping and size-guarding it.
type artifactResult map[string]any

type artPlace struct {
	ID       string  `json:"id"`
	Label    string  `json:"label,omitempty"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Initial  int     `json:"initial"`
	Capacity int     `json:"capacity"`
}

type artTransition struct {
	ID    string  `json:"id"`
	Label string  `json:"label,omitempty"`
	X     float64 `json:"x"`
	Y     float64 `json:"y"`
}

type artArc struct {
	Source  string `json:"source"`
	Target  string `json:"target"`
	Weight  int    `json:"weight"`
	Inhibit bool   `json:"inhibit"`
}

func sumInts(v []float64) int {
	s := 0.0
	for _, x := range v {
		s += x
	}
	return int(s)
}

// ontologyClasses is the class a set of verdicts earns: the most specific of
// LiveNet ⊂ DeadlockFreeNet ⊂ PetriNet, plus BoundedNet. An incomplete search
// earns no behavioural class. The page applies the same rule (classesOf).
func ontologyClasses(complete bool, live, deadlockFree, bounded any) []string {
	var out []string
	switch {
	case !complete:
		out = append(out, "PetriNet")
	case live == true:
		out = append(out, "LiveNet")
	case deadlockFree == true:
		out = append(out, "DeadlockFreeNet")
	default:
		out = append(out, "PetriNet")
	}
	if complete && bounded == true {
		out = append(out, "BoundedNet")
	}
	return out
}

func mcpArtifact(s *Server, r *http.Request, args map[string]any) (any, error) {
	raw, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	engine, _ := args["engine"].(string)
	if engine == "" {
		engine = "baked"
	}
	if engine != "baked" && engine != "wasm" {
		return nil, errors.New(`engine: "baked" or "wasm"`)
	}
	maxStates, err := numArg(args, "max_states", 2000, 1, maxMCPStates)
	if err != nil {
		return nil, err
	}
	if k := model.KindOf(raw); k != model.KindNet {
		return nil, fmt.Errorf("pflow_artifact draws nets; a %s has no page here (flatten it with pflow_bundle_flatten, or open it with pflow_links)", k)
	}
	pn, err := parser.FromJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	norm := parser.Normalize(pn)
	if len(norm.Token) > 1 {
		return nil, fmt.Errorf("pflow_artifact plays single-colour nets; this one has %d token colours", len(norm.Token))
	}
	if len(norm.Places) == 0 || len(norm.Transitions) == 0 {
		return nil, errors.New("the net needs at least one place and one transition to draw a token game")
	}

	page := map[string]any{"places": []artPlace{}, "transitions": []artTransition{}, "arcs": []artArc{}}
	var places []artPlace
	for _, id := range sortedKeys(norm.Places) {
		p := norm.Places[id]
		places = append(places, artPlace{ID: id, Label: p.Label, X: p.X, Y: p.Y, Initial: sumInts(p.Initial), Capacity: sumInts(p.Capacity)})
	}
	var trans []artTransition
	for _, id := range sortedKeys(norm.Transitions) {
		t := norm.Transitions[id]
		trans = append(trans, artTransition{ID: id, Label: t.Label, X: t.X, Y: t.Y})
	}
	arcs := []artArc{}
	for _, a := range norm.Arcs {
		w := sumInts(a.Weight)
		if len(a.Weight) == 0 {
			w = 1
		}
		arcs = append(arcs, artArc{Source: a.Source, Target: a.Target, Weight: w, Inhibit: a.Inhibit})
	}
	page["places"], page["transitions"], page["arcs"] = places, trans, arcs

	// The verdicts: pflow_reachability's and pflow_invariants' own handlers.
	ra, err := mcpReachability(s, r, map[string]any{"net": doc, "max_states": maxStates})
	if err != nil {
		return nil, err
	}
	reach := ra.(map[string]any)
	complete, _ := reach["complete"].(bool)
	analysis := map[string]any{
		"states": reach["states"], "edges": reach["edges"], "complete": complete, "bounded": reach["bounded"],
		"deadlock_free": reach["deadlock_free"], "live": reach["live"], "quasi_live": reach["quasi_live"],
		"witness": reach["witness"], "max_states": int(maxStates),
	}
	ia, err := mcpInvariants(s, r, map[string]any{"net": doc, "kind": "p"})
	if err != nil {
		return nil, err
	}
	invs := []map[string]any{}
	if l, ok := ia.(map[string]any)["p_invariants"].([]map[string]any); ok {
		for _, inv := range l {
			invs = append(invs, map[string]any{"equation": inv["equation"], "coefficients": inv["coefficients"], "value": inv["value"]})
		}
	}

	id, err := model.Identify(raw)
	if err != nil {
		return nil, fmt.Errorf("does not seal: %v", err)
	}
	base := s.getRequestScheme(r) + "://" + r.Host
	stored := false
	if s.storage != nil {
		if _, err := s.storage.GetObject(id.CID); err == nil {
			stored = true
		}
	}
	editor := base + "/?data=" + url.QueryEscape(url.QueryEscape(string(raw)))
	if stored {
		editor = base + "/?cid=" + url.QueryEscape(id.CID)
	}

	title, _ := args["title"].(string)
	title = strings.TrimSpace(title)
	if title == "" {
		title, _ = doc["name"].(string)
		title = strings.TrimSpace(title)
	}
	if title == "" {
		title = "Petri net"
	}
	if r := []rune(title); len(r) > 120 {
		title = string(r[:120])
	}

	classes := ontologyClasses(complete, reach["live"], reach["deadlock_free"], reach["bounded"])
	data := map[string]any{
		"title": title, "cid": id.CID, "editor": editor, "stored": stored, "engine": engine,
		"net": page, "analysis": analysis, "invariants": invs,
	}
	if engine == "wasm" {
		data["source"] = doc
	}
	blob, err := json.Marshal(data) // escapes <, > and &, so the blob cannot close its script
	if err != nil {
		return nil, err
	}
	// The engine goes before the page script, which reads it as it runs.
	eng := ""
	if engine == "wasm" {
		eng = `<script type="application/octet-stream" id="pflow-engine">` + base64.StdEncoding.EncodeToString(artifactEngine) + "</script>\n"
	}
	// One pass over the template: a Replacer never re-scans text it has inserted,
	// so a title or label that spells a placeholder cannot be substituted into.
	out := strings.NewReplacer(
		"__PFLOW_TITLE__", html.EscapeString(title),
		"__PFLOW_DATA__", string(blob),
		"__PFLOW_ENGINE__", eng,
	).Replace(artifactPage)

	var iris []map[string]string
	for _, c := range classes {
		iris = append(iris, map[string]string{"class": c, "iri": ontologyNS + c})
	}
	summary := map[string]any{
		"title": title, "cid": id.CID, "editor": editor, "stored": stored, "engine": engine,
		"html_bytes": len(out), "classes": iris,
		"verdicts": map[string]any{"states": reach["states"], "edges": reach["edges"], "complete": complete,
			"deadlock_free": reach["deadlock_free"], "live": reach["live"], "quasi_live": reach["quasi_live"], "bounded": reach["bounded"]},
		"p_invariants": len(invs),
		"publish":      "The second content block is the page: publish it as an HTML page (an Artifact) exactly as given. It is a fragment; the host adds the document around it.",
	}
	if w, ok := reach["witness"]; ok && w != nil {
		summary["witness"] = w
	}
	if len(out)+4096 > maxArtifactResultBytes {
		return nil, fmt.Errorf("the page would be %d bytes, over %d; use engine \"baked\" or a smaller net", len(out), maxArtifactResultBytes)
	}
	sj, _ := json.Marshal(summary)
	// No structuredContent: a client that prefers it would drop the page, and
	// carrying the page twice would double the payload.
	return artifactResult{"content": []map[string]any{
		{"type": "text", "text": string(sj)},
		{"type": "text", "text": out},
	}}, nil
}
