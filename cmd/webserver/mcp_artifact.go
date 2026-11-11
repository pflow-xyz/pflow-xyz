package main

// pflow_artifact: one net as a self-contained interactive page for a client
// to publish (a claude.ai Artifact, or any page host). The verdicts are
// computed here, on the same go-pflow engines as pflow_reachability and
// pflow_invariants (the handlers are called, not re-implemented), and baked
// into the page; the page plays the token game with go-pflow's firing rule
// (graph.go isEnabled/Fire, the contract petri-sim.js and parity/sim hold)
// and re-checks the P-invariants after every firing.
//
// engine "wasm" adds pflow-rs's reachability engine to the page as one
// <script src> from jsDelivr: @pflow-xyz/engine (pflow-rs crates/
// pflow-artifact-engine), pinned to an exact version with an SRI hash
// (artifact/engine-cdn.lock.json). That script embeds the module and defines
// PflowEngine, because an Artifact's CSP lets a page load a script from
// cdn.jsdelivr.net/npm but blocks any other fetch, a .wasm from the same host
// included. The page stays the size of a baked one, re-analyzes when the
// person edits the initial marking, and cross-checks the server's verdicts on
// load; if the script does not load, the baked verdicts stand and the page
// says so.
//
// engine "wasm-inline" is the older form: the same engine (artifact/
// engine.wasm, artifact/engine.lock.json) embedded as base64 in the page,
// decoded with atob and compiled with WebAssembly.instantiate (never fetched).
// It loads nothing, but the page is about 450 KB, which most chat clients
// truncate as a tool result.
//
// The page is a fragment (no doctype, html, head or body): the client wraps
// it. Only engine "wasm" loads anything, and only that one script.

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

//go:embed artifact/engine-cdn.lock.json
var artifactEngineCDNLock []byte

// engineCDN is the pinned @pflow-xyz/engine script engine "wasm" loads.
type engineCDN struct {
	Package   string `json:"package"`
	Version   string `json:"version"`
	File      string `json:"file"`
	Integrity string `json:"integrity"`
}

var artifactCDN = func() engineCDN {
	var c engineCDN
	if err := json.Unmarshal(artifactEngineCDNLock, &c); err != nil {
		panic("artifact/engine-cdn.lock.json: " + err.Error())
	}
	return c
}()

// URL is the jsDelivr URL of the pinned file.
func (c engineCDN) URL() string {
	return "https://cdn.jsdelivr.net/npm/" + c.Package + "@" + c.Version + "/" + c.File
}

// scriptTag is the <script> engine "wasm" puts before the page script. No
// async or defer: it must have run (or failed) when the page script starts.
func (c engineCDN) scriptTag() string {
	return `<script src="` + c.URL() + `" integrity="` + c.Integrity + `" crossorigin="anonymous"></script>` + "\n"
}

// maxArtifactResultBytes bounds a pflow_artifact answer. It is over the
// general ~60KB guard because the page is the point of the call: a baked or
// wasm page is tens of KB, a wasm-inline one about 450KB (the engine as base64).
const maxArtifactResultBytes = 1 << 20

const ontologyNS = "https://ontology.pflow.xyz/ns#"

func artifactTool() mcpTool {
	return mcpTool{
		Name: "pflow_artifact",
		Description: "One net as a self-contained interactive HTML page, for the person to see, play or share: publish the returned html as a page (an Artifact) as it is, without rewriting it. " +
			"The page draws the net from its own x/y, plays the token game (click or press Enter on an enabled transition, random step, reset), shows the verdicts of pflow_reachability and the P-invariants of pflow_invariants (re-checked after every firing), " +
			"replays the deadlock or livelock witness, tags the net with the ontology.pflow.xyz classes it earns (behaviour: LiveNet ⊂ DeadlockFreeNet ⊂ PetriNet, BoundedNet, UnboundedNet; shape: StateMachineNet, MarkedGraphNet, ConservativeNet), and links the editor. " +
			"The page chooses what to lead with from the net (the summary's views.lead says which): a few places and transitions, or an unbounded net, lead with the graph, the populations over time and the phase plane, because there the dynamics are the point; a small bounded net leads with the token game and verdicts; a net of about 60 nodes or more leads with verdicts and P-invariants. " +
			"Every view stays available: Explore this model, at the bottom of every page, exposes the hidden ones and lets the person edit the marking, the transition rates (the net's optional per-transition rate, default 1) and the arc weights in the page. Read views.lead before telling the person what the page shows first. " +
			"The html is a fragment (no doctype/html/head/body: the host wraps it). Give the net inline as net, or a stored net by cid (then the editor link is ?cid= rather than the net inline, and the net need not pass through the conversation). " +
			"engine \"baked\" (default, tens of KB, loads nothing) fixes the verdicts at the net's marking. " +
			"\"wasm\" (about the size of baked) also loads the pflow-rs engine as one script pinned to an exact version on cdn.jsdelivr.net (@pflow-xyz/engine, " + artifactCDN.Version + "), so the person can edit the initial marking and re-analyze in the page; if that script cannot load, the page keeps the baked verdicts and says so. " +
			"\"wasm-inline\" embeds the same engine as base64 instead (about 450 KB, loads nothing); most chat clients truncate a tool result that large, so prefer \"wasm\". Single-colour nets only.",
		InputSchema: obj(map[string]any{
			"net":        netArg,
			"cid":        map[string]any{"type": "string", "description": "a stored net's CID, instead of net"},
			"title":      map[string]any{"type": "string", "description": "page title (default: the net's name)"},
			"max_states": map[string]any{"type": "integer", "description": "reachability budget (default 2000, ≤ 20000)"},
			"engine":     map[string]any{"type": "string", "enum": []any{"baked", "wasm", "wasm-inline"}, "description": "baked (default; verdicts fixed), wasm (re-analyze in the page; loads the pinned engine script from cdn.jsdelivr.net) or wasm-inline (the engine embedded, ~450 KB: most chat clients truncate it)"},
		}),
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
	Rate  float64 `json:"rate"`
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
	cidArg, _ := args["cid"].(string)
	cidArg = strings.TrimSpace(cidArg)
	if cidArg != "" {
		if args["net"] != nil {
			return nil, errors.New("give net or cid, not both")
		}
		got, err := mcpGet(s, r, map[string]any{"cid": cidArg})
		if err != nil {
			return nil, err
		}
		g := got.(map[string]any)
		if k, ok := g["kind"]; ok {
			return nil, fmt.Errorf("pflow_artifact draws nets; %s is a %v (flatten it with pflow_bundle_flatten, or open it with pflow_links)", cidArg, k)
		}
		next := map[string]any{"net": g["net"]}
		for _, k := range []string{"title", "max_states", "engine"} {
			if v, ok := args[k]; ok {
				next[k] = v
			}
		}
		args = next
	} else if args["net"] == nil {
		return nil, errors.New("give a net, or the cid of a stored one")
	}
	raw, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	engine, _ := args["engine"].(string)
	if engine == "" {
		engine = "baked"
	}
	if engine != "baked" && engine != "wasm" && engine != "wasm-inline" {
		return nil, errors.New(`engine: "baked", "wasm" or "wasm-inline"`)
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
	rates := transitionRates(doc)
	for _, id := range sortedKeys(norm.Transitions) {
		t := norm.Transitions[id]
		rate := 1.0
		if r, ok := rates[id]; ok {
			rate = r
		}
		trans = append(trans, artTransition{ID: id, Label: t.Label, X: t.X, Y: t.Y, Rate: rate})
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
	cid := id.CID
	base := s.getRequestScheme(r) + "://" + r.Host
	stored := false
	if cidArg != "" {
		// Read from the store under this CID: the link names what was asked for.
		cid, stored = cidArg, true
	} else if s.storage != nil {
		if _, err := s.storage.GetObject(cid); err == nil {
			stored = true
		}
	}
	editor := base + "/?data=" + url.QueryEscape(url.QueryEscape(string(raw)))
	if stored {
		editor = base + "/?cid=" + url.QueryEscape(cid)
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
	structural := structuralClasses(places, trans, arcs, invs, reach["bounded"])
	classes = append(classes, structural...)
	views := recommendViews(len(places), len(trans), complete, reach["bounded"])
	data := map[string]any{
		"views": views, "structural": structural,
		"title": title, "cid": cid, "editor": editor, "stored": stored, "engine": engine,
		"net": page, "analysis": analysis, "invariants": invs,
	}
	if engine == "wasm" || engine == "wasm-inline" {
		data["source"] = doc
	}
	blob, err := json.Marshal(data) // escapes <, > and &, so the blob cannot close its script
	if err != nil {
		return nil, err
	}
	// The engine goes before the page script, which reads it as it runs.
	eng := ""
	switch engine {
	case "wasm":
		eng = artifactCDN.scriptTag()
	case "wasm-inline":
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
		"title": title, "cid": cid, "editor": editor, "stored": stored, "engine": engine,
		"html_bytes": len(out), "classes": iris,
		"verdicts": map[string]any{"states": reach["states"], "edges": reach["edges"], "complete": complete,
			"deadlock_free": reach["deadlock_free"], "live": reach["live"], "quasi_live": reach["quasi_live"], "bounded": reach["bounded"]},
		"p_invariants": len(invs),
		"views":        map[string]any{"lead": views.Lead, "shown": views.Shown, "reason": views.Reason},
		"publish":      "The second content block is the page: publish it as an HTML page (an Artifact) exactly as given. It is a fragment; the host adds the document around it.",
	}
	if w, ok := reach["witness"]; ok && w != nil {
		summary["witness"] = w
	}
	if engine == "wasm" {
		summary["engine_script"] = artifactCDN.URL()
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
