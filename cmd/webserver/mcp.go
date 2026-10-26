package main

// /mcp: pflow.xyz as an MCP server (ROADMAP phase 8), so Claude or any MCP
// client can check, seal, simulate, explore, fetch and save nets without a
// browser.
//
// Transport: MCP's Streamable HTTP, in its simplest stateless form. Every
// POST carries one JSON-RPC message (or a batch) and gets a JSON reply; there
// is no session and no server-sent stream, so GET answers 405. Methods:
// initialize, ping, tools/list, tools/call; notifications get 202.
//
// The tools run on the server's own engines, the ones that already back
// /api/save and the SVG renderer: go-pflow's parser, Tsit5 solver and
// reachability analyzer, and internal/seal. The browser's richer registry
// (petri-commands.js, the pflow-native wasm) stays in the browser; an agent
// that wants it drives the editor. Every tool is bounded (body size, horizon,
// states) so one call cannot tie up the server.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/go-pflow/reachability"
	"github.com/pflow-xyz/go-pflow/solver"
	"github.com/pflow-xyz/pflow-xyz/internal/seal"
)

const (
	mcpProtocolVersion = "2025-06-18"
	maxMCPBody         = 512 << 10
	maxMCPStates       = 20000
	maxMCPTEnd         = 10000.0
)

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// mcpTool is one tool: its MCP declaration and its handler.
type mcpTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	run         func(s *Server, r *http.Request, args map[string]any) (any, error)
}

var netArg = map[string]any{"type": "object", "description": "a pflow.xyz net (JSON-LD, the editor's format)"}

func obj(props map[string]any, required ...string) map[string]any {
	o := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		o["required"] = required
	}
	return o
}

func mcpTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "pflow_check",
			Description: "Parse a net with go-pflow (the engines' reader) and report its size, colours and anything it refuses. For the editor's full strict check (what normalisation would repair, with paths), open the net in the editor: Check net.",
			InputSchema: obj(map[string]any{"net": netArg}, "net"),
			run:         mcpCheck,
		},
		{
			Name:        "pflow_cid",
			Description: "The CID a net seals to: URDNA2015 canonical N-Quads, sha256, CIDv1 base58btc. The same as /api/save, the editor and pflow-native (top-level @id ignored).",
			InputSchema: obj(map[string]any{"net": netArg}, "net"),
			run:         mcpCID,
		},
		{
			Name:        "pflow_get",
			Description: "A stored net by CID.",
			InputSchema: obj(map[string]any{"cid": map[string]any{"type": "string"}}, "cid"),
			run:         mcpGet,
		},
		{
			Name:        "pflow_simulate",
			Description: "Integrate the mass-action ODE (go-pflow Tsit5) from the net's initial marking, with each transition's rate (default 1.0) unless rates overrides it. Returns every place's final value and a sampled trajectory. Mean-field: wrong at small token counts. A net with inhibitor/read arcs or capacities, which a continuous solver cannot test, runs instead on go-pflow's discrete SSA (mean of 20 seeded paths), the engine the page uses; engine and gates say so.",
			InputSchema: obj(map[string]any{
				"net":    netArg,
				"t_end":  map[string]any{"type": "number", "description": "end time (default 10, ≤ 10000)"},
				"rates":  map[string]any{"type": "object", "description": "{transition: rate} overrides"},
				"points": map[string]any{"type": "integer", "description": "samples returned (default 21, ≤ 200)"},
			}, "net"),
			run: mcpSimulate,
		},
		{
			Name:        "pflow_reachability",
			Description: "Explore the reachable markings (go-pflow reachability, untimed: rates play no part): state count, bounded or not, deadlocks with the marking of the first, transitions that never fire, liveness. Exhaustive only when complete is true.",
			InputSchema: obj(map[string]any{
				"net":        netArg,
				"max_states": map[string]any{"type": "integer", "description": "budget (default 2000, ≤ 20000)"},
			}, "net"),
			run: mcpReachability,
		},
		{
			Name:        "pflow_links",
			Description: "Where a person can see a net: the editor (with the net loaded), its SVG and its JSON-LD. Give a cid of a stored net, or a net (the editor link then carries it in the URL).",
			InputSchema: obj(map[string]any{"cid": map[string]any{"type": "string"}, "net": netArg}),
			run:         mcpLinks,
		},
		{
			Name:        "pflow_save",
			Description: "Store a net on pflow.xyz and return its CID, recorded as yours. Stored nets are public. Needs you signed in to pflow.xyz (with GitHub or Google); the first call asks you to sign in.",
			InputSchema: obj(map[string]any{"net": netArg}, "net"),
			run:         mcpSave,
		},
	}
}

// netBytes takes the net argument and returns its JSON.
func netBytes(args map[string]any) ([]byte, map[string]any, error) {
	n, ok := args["net"].(map[string]any)
	if !ok {
		return nil, nil, errors.New("net: a JSON object (the editor's format) is required")
	}
	raw, err := json.Marshal(n)
	return raw, n, err
}

func mcpCheck(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	raw, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"ok": true}
	if err := validateJSONLD(doc); err != nil {
		out["ok"] = false
		out["jsonld"] = err.Error()
	}
	net, err := parser.FromJSON(raw)
	if err != nil {
		out["ok"] = false
		out["parse"] = err.Error()
		return out, nil
	}
	out["places"] = len(net.Places)
	out["transitions"] = len(net.Transitions)
	out["arcs"] = len(net.Arcs)
	return out, nil
}

func mcpCID(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	raw, _, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	cid, _, err := seal.SealJSONLD(raw)
	if err != nil {
		return nil, fmt.Errorf("does not seal: %v", err)
	}
	return map[string]any{"cid": cid}, nil
}

func mcpGet(s *Server, _ *http.Request, args map[string]any) (any, error) {
	cid, _ := args["cid"].(string)
	if cid == "" || strings.ContainsAny(cid, "/\\.") {
		return nil, errors.New("cid: a stored net's CID")
	}
	raw, err := s.storage.GetObject(cid)
	if err != nil {
		return nil, fmt.Errorf("no net %s", cid)
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("stored object is not JSON")
	}
	return map[string]any{"cid": cid, "net": doc}, nil
}

// ratesOf reads each transition's `rate` from the editor's format.
func ratesOf(doc map[string]any) map[string]float64 {
	out := map[string]float64{}
	ts, _ := doc["transitions"].(map[string]any)
	for id, t := range ts {
		if m, ok := t.(map[string]any); ok {
			if r, ok := m["rate"].(float64); ok && r >= 0 && !math.IsInf(r, 0) {
				out[id] = r
			}
		}
	}
	return out
}

func numArg(args map[string]any, k string, def, lo, hi float64) (float64, error) {
	v, ok := args[k]
	if !ok {
		return def, nil
	}
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || f < lo || f > hi {
		return 0, fmt.Errorf("%s: a number in [%g, %g]", k, lo, hi)
	}
	return f, nil
}

func mcpSimulate(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	raw, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	tEnd, err := numArg(args, "t_end", 10, 1e-9, maxMCPTEnd)
	if err != nil {
		return nil, err
	}
	pts, err := numArg(args, "points", 21, 2, 200)
	if err != nil {
		return nil, err
	}
	net, err := parser.FromJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	rates := ratesOf(doc)
	if over, ok := args["rates"].(map[string]any); ok {
		for k, v := range over {
			f, ok := v.(float64)
			if !ok || f < 0 {
				return nil, fmt.Errorf("rates.%s: a number ≥ 0", k)
			}
			rates[k] = f
		}
	}
	n := int(pts)
	if gm := gatedModel(doc, rates); len(gm.Gating()) > 0 {
		return simulateGated(rates, tEnd, n, gm.Gating(), gm)
	}
	sol := solver.Solve(solver.NewProblem(net, net.SetState(nil), [2]float64{0, tEnd}, net.SetRates(rates)), solver.Tsit5(), solver.DefaultOptions())
	final := sol.GetFinalState()
	places := make([]string, 0, len(final))
	for p := range final {
		places = append(places, p)
	}
	sort.Strings(places)
	times := make([]float64, n)
	series := map[string][]float64{}
	for i := 0; i < n; i++ {
		times[i] = tEnd * float64(i) / float64(n-1)
	}
	for _, p := range places {
		ys := sol.GetVariable(p)
		vals := make([]float64, n)
		for i, t := range times {
			vals[i] = interpolate(sol.T, ys, t)
		}
		series[p] = vals
	}
	return map[string]any{"engine": "ode (go-pflow Tsit5)", "t_end": tEnd, "rates": rates, "final": final, "t": times, "series": series, "truncated": sol.Truncated}, nil
}

func interpolate(ts, ys []float64, t float64) float64 {
	if len(ts) == 0 || len(ys) == 0 {
		return 0
	}
	j := sort.SearchFloat64s(ts, t)
	if j <= 0 {
		return ys[0]
	}
	if j >= len(ts) {
		return ys[len(ys)-1]
	}
	t0, t1 := ts[j-1], ts[j]
	if t1 == t0 {
		return ys[j]
	}
	return ys[j-1] + (ys[j]-ys[j-1])*(t-t0)/(t1-t0)
}

func mcpReachability(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	raw, _, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	max, err := numArg(args, "max_states", 2000, 1, maxMCPStates)
	if err != nil {
		return nil, err
	}
	net, err := parser.FromJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("go-pflow cannot read the net: %v", err)
	}
	res := reachability.NewAnalyzer(net).WithMaxStates(int(max)).Analyze()
	out := map[string]any{
		"states": res.StateCount, "edges": res.EdgeCount, "complete": res.IsComplete, "bounded": res.Bounded,
		"max_tokens": res.MaxTokens, "deadlocks": len(res.Deadlocks), "live": res.Live,
		"dead_transitions": res.DeadTrans, "note": "untimed: rates play no part; a claim about every state holds only when complete is true",
	}
	if res.Truncated {
		out["truncated"] = res.TruncateMsg
	}
	if !res.IsComplete {
		// go-pflow reports bounded/live over the states it saw; a search that
		// stopped at its budget has not seen them all, so say so instead.
		out["bounded"] = "unknown: the search stopped at max_states"
		out["live"] = "unknown: the search stopped at max_states"
	}
	if len(res.Deadlocks) > 0 && res.Deadlocks[0] != nil {
		out["first_deadlock"] = res.Deadlocks[0].Marking
	}
	return out, nil
}

func mcpLinks(s *Server, r *http.Request, args map[string]any) (any, error) {
	base := s.getRequestScheme(r) + "://" + r.Host
	if cid, _ := args["cid"].(string); cid != "" {
		return map[string]any{"editor": base + "/?cid=" + url.QueryEscape(cid), "svg": base + "/img/" + cid + ".svg", "jsonld": base + "/o/" + cid}, nil
	}
	raw, _, err := netBytes(args)
	if err != nil {
		return nil, errors.New("give a cid or a net")
	}
	// The editor reads ?data= as URI-encoded JSON (petri-view.js permalinks).
	return map[string]any{"editor": base + "/?data=" + url.QueryEscape(url.QueryEscape(string(raw)))}, nil
}

func mcpSave(s *Server, r *http.Request, args map[string]any) (any, error) {
	// REVIEW: /api/save stores anonymously when no token is sent; over MCP a
	// sign-in is required, because an agent can loop where a person clicks.
	// With OAuth on, mcpAuthGate has already resolved the identity (or answered
	// 401); otherwise the bearer token is taken as a GitHub token.
	id := mcpIdentityOf(r)
	if id == nil {
		var err error
		id, err = s.mcpIdentityFor(r)
		switch {
		case errors.Is(err, errNoToken):
			return nil, errors.New("saving needs you signed in to pflow.xyz: connect with OAuth, or send Authorization: Bearer <GitHub token>")
		case errors.Is(err, errAuthUnavailable):
			return nil, err
		case err != nil:
			return nil, errors.New("that sign-in was not accepted (GitHub rejected the token, or it expired)")
		}
	}
	raw, doc, err := netBytes(args)
	if err != nil {
		return nil, err
	}
	if err := validateJSONLD(doc); err != nil {
		return nil, fmt.Errorf("invalid JSON-LD: %v", err)
	}
	cid, canonical, err := seal.SealJSONLD(raw)
	if err != nil {
		return nil, fmt.Errorf("does not seal: %v", err)
	}
	if id.Provider == "github" {
		err = s.storage.SaveObjectWithAuthor(cid, raw, canonical, id.Name, id.ID)
	} else {
		var stamped []byte
		if stamped, err = mcpOAuthAuthorDoc(doc, id); err == nil {
			err = s.storage.SaveObject(cid, stamped, canonical)
		}
	}
	if err != nil {
		return nil, errors.New("could not store it")
	}
	out := map[string]any{"cid": cid, "signed_in_with": id.Provider}
	if id.Name != "" {
		out["author"] = id.Name
	}
	return out, nil
}

// ---- JSON-RPC ----

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
		// Someone opened the connector URL in a browser: show the docs.
		http.Redirect(w, r, "/mcp.html", http.StatusFound)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "this MCP endpoint is stateless: POST JSON-RPC, no event stream", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMCPBody))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32600, "request too large"}})
		return
	}
	r, ok := s.mcpAuthGate(w, r, body)
	if !ok {
		return
	}
	trimmed := strings.TrimSpace(string(body))
	if strings.HasPrefix(trimmed, "[") {
		var batch []rpcRequest
		if err := json.Unmarshal(body, &batch); err != nil {
			writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}})
			return
		}
		var out []rpcResponse
		for _, req := range batch {
			if resp, ok := s.mcpDispatch(r, req); ok {
				out = append(out, resp)
			}
		}
		if len(out) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		writeJSON(w, http.StatusOK, out)
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeJSON(w, http.StatusOK, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{-32700, "parse error"}})
		return
	}
	resp, ok := s.mcpDispatch(r, req)
	if !ok {
		w.WriteHeader(http.StatusAccepted) // a notification
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// mcpDispatch answers one request; ok is false for a notification (no id).
func (s *Server) mcpDispatch(r *http.Request, req rpcRequest) (rpcResponse, bool) {
	if len(req.ID) == 0 || string(req.ID) == "null" {
		return rpcResponse{}, false
	}
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(req.Params, &p)
		resp.Result = map[string]any{
			"protocolVersion": negotiateProtocolVersion(p.ProtocolVersion),
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "pflow.xyz", "version": "workbench-1"},
			"instructions": "pflow.xyz: Petri nets in the pflow.xyz JSON-LD format. Check, seal, simulate (ODE) and explore " +
				"(reachability) a net on the server's go-pflow engines; pflow_links opens one in the editor, where the " +
				"structural analyses, stochastic runs and the Assistant live. pflow_save needs the person signed in to " +
				"pflow.xyz.",
		}
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		tools := listedMCPTools(s, r)
		list := make([]map[string]any, 0, len(tools))
		for _, t := range tools {
			list = append(list, toolDescriptor(t))
		}
		resp.Result = map[string]any{"tools": list}
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			resp.Error = &rpcError{-32602, "params: {name, arguments}"}
			break
		}
		var tool *mcpTool
		for _, t := range allMCPTools() {
			if t.Name == p.Name {
				t := t
				tool = &t
			}
		}
		if tool == nil {
			resp.Error = &rpcError{-32602, fmt.Sprintf("unknown tool %q", p.Name)}
			break
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		out, err := callMCPTool(s, r, tool, p.Arguments)
		if err != nil {
			resp.Result = map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": err.Error()}}}
			break
		}
		resp.Result = mcpResult(out)
	default:
		resp.Error = &rpcError{-32601, fmt.Sprintf("method %q not found", req.Method)}
	}
	return resp, true
}
