package main

// Tab push (docs/design/tab-push.md): a signed-in pflow.xyz page registers as
// a tab and listens on a stream; MCP tools push a net or a view into it, read
// back what it shows, and clear it. BeatScript's hub, carried over.
//
// Off unless PFLOW_TAB_PUSH=1 (or -tab-push). When off the routes answer as if
// they did not exist, status says disabled, and the four tools are neither
// listed nor callable, so a server without the flag is unchanged.
//
// Page routes (same-origin only, bearer = the editor's GitHub token, the same
// sign-in /api/files uses; the stream is SSE framing read with fetch, because
// EventSource cannot send a bearer token):
//
//	GET  /api/tab/status        {enabled, views, signed_in?}
//	POST /api/tab               {id, user}
//	GET  /api/tab/{id}/events   text/event-stream
//	POST /api/tab/{id}/report   the page's report (a JSON object, 256 KiB)
//	POST /api/tab/{id}/reply    {request_id, state}
//	DELETE /api/tab/{id}        unlink
//
// MCP tools: pflow_tabs, pflow_show, pflow_tab_get, pflow_tab_stop.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/model"
	"github.com/pflow-xyz/pflow-xyz/internal/tabhub"
)

const tabPrefix = "/api/tab"

// tabViews are the views a show event may name, in the order the tool lists
// them. "notation" is reserved for the pflow-notation panel.
var tabViews = []string{"canvas", "plot", "reachability", "invariants", "categorical", "notation"}

// composeViewIDs are the composition page's views a categorical push may name
// (public/compose/views-meta.js); the page checks again against its registry.
var composeViewIDs = []string{"cospan", "spiders", "operad", "string", "flat", "boundaries", "lens", "incidence", "process", "laws"}

const (
	maxTabNetBytes  = 256 << 10
	maxTabNoteBytes = 1000
	maxTabSource    = 64 << 10
	tabPingEvery    = 20 * time.Second
)

// tabPushOn gates the MCP tools (a package-level switch because the tool list is
// built without a Server). configureTabs sets it; tests set it directly.
var tabPushOn atomic.Bool

var tabToolNames = map[string]bool{"pflow_tabs": true, "pflow_show": true, "pflow_tab_get": true, "pflow_tab_stop": true}

// tabService is the hub and the page-side sign-in check.
type tabService struct {
	hub      *tabhub.Hub
	accounts fileAccountResolver // page's bearer token → "provider:subject"
	ping     time.Duration
}

// configureTabs turns tab push on when asked (flag or PFLOW_TAB_PUSH). The page
// sign-in is account files' resolver, so it also needs the GitHub OAuth app.
func (s *Server) configureTabs(getenv func(string) string, flagOn bool) {
	on := flagOn
	switch strings.ToLower(strings.TrimSpace(getenv("PFLOW_TAB_PUSH"))) {
	case "1", "true", "yes", "on":
		on = true
	}
	if !on {
		s.tabs = nil
		setTabPush(false)
		return
	}
	svc := &tabService{hub: tabhub.New(nil), ping: tabPingEvery}
	if s.files != nil {
		svc.accounts = s.files.accounts
	} else {
		log.Printf("Tab push: on, but no GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET, so no page can sign in; MCP tools will find no tabs")
	}
	s.tabs = svc
	setTabPush(true)
	go func(h *tabhub.Hub) {
		for range time.Tick(time.Minute) {
			h.Sweep()
		}
	}(svc.hub)
	log.Printf("Tab push: on (%d views)", len(tabViews))
}

func tabError(w http.ResponseWriter, err error) {
	var e *tabhub.Error
	if errors.As(err, &e) {
		if e.Status == 429 {
			w.Header().Set("Retry-After", "30")
		}
		filesError(w, e.Status, e.Msg, map[string]any{"code": e.Code})
		return
	}
	filesError(w, http.StatusInternalServerError, "internal error", nil)
}

// pageOwner resolves the page's bearer token to an account key.
func (svc *tabService) pageOwner(r *http.Request) (string, error) {
	if svc.accounts == nil {
		return "", &tabhub.Error{Status: 503, Code: "unavailable", Msg: "page sign-in is not configured on this server"}
	}
	o, err := svc.accounts(r)
	switch {
	case errors.Is(err, errFilesAuthUnavailable):
		return "", &tabhub.Error{Status: 503, Code: "unavailable", Msg: "cannot check your sign-in right now; try again shortly"}
	case errors.Is(err, errFilesNotAllowed):
		return "", &tabhub.Error{Status: 403, Code: "not_allowed", Msg: errFilesNotAllowed.Error()}
	case err != nil:
		return "", &tabhub.Error{Status: 401, Code: "auth_required", Msg: "sign in to link this tab: the link belongs to your account"}
	}
	return o.Key(), nil
}

func clientAddr(r *http.Request) string {
	if v := strings.TrimSpace(r.Header.Get("X-Real-IP")); v != "" {
		return v
	}
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

func (s *Server) handleTab(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.EscapedPath(), tabPrefix)
	svc := s.tabs
	if rest == "/status" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": svc != nil && svc.accounts != nil, "views": tabViews})
		return
	}
	if svc == nil {
		http.NotFound(w, r)
		return
	}
	if !filesSameOrigin(r) {
		filesError(w, http.StatusForbidden, "cross-origin requests to tabs are refused", nil)
		return
	}
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	switch {
	case rest == "" && r.Method == http.MethodPost:
		owner, err := svc.pageOwner(r)
		if err != nil {
			tabError(w, err)
			return
		}
		id, err := svc.hub.Create(owner)
		if err != nil {
			tabError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "user": owner})
	case len(parts) == 1 && r.Method == http.MethodDelete:
		owner, err := svc.pageOwner(r)
		if err == nil {
			err = svc.hub.Drop(parts[0], owner)
		}
		if err != nil {
			tabError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case len(parts) == 2 && parts[1] == "events" && r.Method == http.MethodGet:
		svc.serveEvents(w, r, parts[0])
	case len(parts) == 2 && parts[1] == "report" && r.Method == http.MethodPost:
		owner, body, err := svc.ownerAndBody(r, tabhub.MaxReportBytes)
		if err == nil {
			err = svc.hub.Report(parts[0], owner, body)
		}
		if err != nil {
			tabError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case len(parts) == 2 && parts[1] == "reply" && r.Method == http.MethodPost:
		owner, body, err := svc.ownerAndBody(r, tabhub.MaxReportBytes+1024)
		var in struct {
			RequestID string          `json:"request_id"`
			State     json.RawMessage `json:"state"`
		}
		if err == nil {
			if json.Unmarshal(body, &in) != nil || in.RequestID == "" {
				err = &tabhub.Error{Status: 400, Code: "bad_request", Msg: "the body must be JSON with a request_id"}
			}
		}
		if err == nil {
			err = svc.hub.Reply(parts[0], owner, in.RequestID, in.State)
		}
		if err != nil {
			tabError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Allow", "GET, POST, DELETE")
		filesError(w, http.StatusMethodNotAllowed, "no such tab route", nil)
	}
}

func (svc *tabService) ownerAndBody(r *http.Request, max int) (string, []byte, error) {
	owner, err := svc.pageOwner(r)
	if err != nil {
		return "", nil, err
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, int64(max)+1))
	if err != nil {
		return "", nil, &tabhub.Error{Status: 400, Code: "bad_request", Msg: "could not read the body"}
	}
	if len(b) > max {
		return "", nil, &tabhub.Error{Status: 413, Code: "too_large", Msg: "the body is larger than a tab may send"}
	}
	return owner, bytes.TrimSpace(b), nil
}

// frame is one SSE frame: the event's type as the event name, the event as data.
func tabFrame(ev tabhub.Event) []byte {
	b, _ := json.Marshal(ev)
	return []byte("event: " + ev.Type + "\ndata: " + string(b) + "\n\n")
}

func (svc *tabService) serveEvents(w http.ResponseWriter, r *http.Request, id string) {
	owner, err := svc.pageOwner(r)
	if err != nil {
		tabError(w, err)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		filesError(w, http.StatusInternalServerError, "streaming is not supported here", nil)
		return
	}
	ip := clientAddr(r)
	if !svc.hub.AcquireStream(ip) {
		tabError(w, &tabhub.Error{Status: 429, Code: "rate_limited", Msg: fmt.Sprintf("too many open streams from your address (%d); close a tab or wait", tabhub.MaxStreamsPerIP)})
		return
	}
	defer svc.hub.ReleaseStream(ip)
	sub, err := svc.hub.Subscribe(id, owner, tabViews)
	if err != nil {
		tabError(w, err)
		return
	}
	defer sub.Close()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fl.Flush()
	ping := time.NewTicker(svc.ping)
	defer ping.Stop()
	for {
		select {
		case ev, ok := <-sub.C:
			if !ok {
				return
			}
			if _, err := w.Write(tabFrame(ev)); err != nil {
				return
			}
			fl.Flush()
		case <-ping.C:
			if _, err := w.Write(tabFrame(tabhub.Event{Type: "ping"})); err != nil {
				return
			}
			fl.Flush()
		case <-r.Context().Done():
			return
		}
	}
}

// ---- MCP tools ----

// setTabPush turns the four tools on or off together with their annotations
// (TestMCPEveryToolIsAnnotated holds annotations to the tools that are listed).
func setTabPush(on bool) {
	tabPushOn.Store(on)
	for name, a := range map[string]mcpAnnotation{
		"pflow_tabs":     {"List the pflow.xyz pages you have linked", true, false, true},
		"pflow_show":     {"Show a net or a view in a linked page", false, false, false},
		"pflow_tab_get":  {"Read what a linked page shows", true, false, true},
		"pflow_tab_stop": {"Clear views in a linked page", false, false, true},
	} {
		if on {
			mcpAnnotations[name] = a
		} else {
			delete(mcpAnnotations, name)
		}
	}
}

var tabArg = map[string]any{"type": "string", "description": "A tab id from pflow_tabs. Leave out to use every live tab of yours (pflow_tab_get: the most recently seen)."}

func tabTools() []mcpTool {
	return []mcpTool{
		{
			Name:        "pflow_tabs",
			Description: "The pflow.xyz pages you have open and linked (menu: Link to Claude), most recently seen first, each with whether its stream is connected and what it last reported. A tab belongs to the account that opened it: sign in here as the same GitHub account. Needs you signed in.",
			InputSchema: obj(map[string]any{}),
			run:         mcpTabs,
		},
		{
			Name: "pflow_show",
			Description: "Show a net or a view in one of your linked pflow.xyz pages, which the person is watching in another window. view: canvas (load the net into the editor; the page keeps what it replaced and offers Restore), plot (simulate: ODE, or params.engine \"ssa\"), reachability, invariants, categorical (a stored composition cid on the composition page; params.name is its view, e.g. cospan), notation (reserved). " +
				"Give net (a PRIVATE push: sent to the page and never stored, no CID made, nothing queued if the page is not connected) or cid (a stored net or composition, which is public). A view runs on the page's own engines in a sandbox, exactly as an opened #view= link does. The answer says how many pages received it; 0 means none had a live stream.",
			InputSchema: obj(map[string]any{
				"view":   map[string]any{"type": "string", "enum": tabViews},
				"net":    netArg,
				"cid":    map[string]any{"type": "string", "description": "a stored model's CID (public)"},
				"tab":    tabArg,
				"params": map[string]any{"type": "object", "description": "plot: t_end, points, runs, seed, engine (ode|ssa); reachability: max_states; invariants: kind (p|t); categorical: name (cospan, spiders, operad, string, flat, boundaries, lens, incidence, process, laws); notation: source (text)"},
				"note":   map[string]any{"type": "string", "description": "one line shown with the view, labelled as the assistant's"},
			}, "view"),
			run: mcpShow,
		},
		{
			Name:        "pflow_tab_get",
			Description: "What a linked page shows: its net's size and marking, the view open, the results on screen, whether it has unsaved edits. Asks the page when the last report is more than a second and a half old and waits up to three seconds; a page that does not answer returns its last report marked fresh:false. net:true also asks for the net on the canvas.",
			InputSchema: obj(map[string]any{"tab": tabArg, "net": map[string]any{"type": "boolean", "description": "include the net on the canvas (the page's reply is capped at 256 KiB)"}}),
			run:         mcpTabGet,
		},
		{
			Name:        "pflow_tab_stop",
			Description: "Clear what pflow_show opened in your linked pages: result cards and overlays close and a running replay is cancelled. It never touches the net on the canvas.",
			InputSchema: obj(map[string]any{"tab": tabArg}),
			run:         mcpTabStop,
		},
	}
}

// tabCaller is the account key of the MCP caller: the same "provider:subject"
// the page's sign-in gives, so the account is the pairing.
func tabCaller(s *Server, r *http.Request) (string, *mcpIdentity, error) {
	if s.tabs == nil {
		return "", nil, errors.New("tab push is not turned on for this server")
	}
	id := mcpIdentityOf(r)
	if id == nil {
		var err error
		id, err = s.mcpIdentityFor(r)
		switch {
		case errors.Is(err, errNoToken):
			return "", nil, errors.New("driving a linked page needs you signed in to pflow.xyz: connect with OAuth, or send Authorization: Bearer <GitHub token>")
		case errors.Is(err, errAuthUnavailable):
			return "", nil, err
		case err != nil:
			return "", nil, errors.New("that sign-in was not accepted (the token is invalid or expired)")
		}
	}
	return id.Provider + ":" + id.ID, id, nil
}

func hubMessage(err error) error {
	var e *tabhub.Error
	if errors.As(err, &e) {
		return errors.New(e.Msg)
	}
	return err
}

func mcpTabs(s *Server, r *http.Request, _ map[string]any) (any, error) {
	owner, id, err := tabCaller(s, r)
	if err != nil {
		return nil, err
	}
	tabs := s.tabs.hub.List(owner)
	out := map[string]any{"tabs": tabs, "account": owner}
	if len(tabs) == 0 {
		note := "No linked tab. In the pflow.xyz editor, signed in as the same account, choose Link to Claude (or open the page with ?tab=1)."
		if id.Provider != "github" {
			note = "This connection is signed in with " + id.Provider + ", but pflow.xyz pages sign in with GitHub only, so none of your pages can be linked to it. Reconnect with GitHub."
		}
		out["note"] = note
	}
	return out, nil
}

func tabParams(view string, raw any) (json.RawMessage, error) {
	if raw == nil {
		return nil, nil
	}
	p, ok := raw.(map[string]any)
	if !ok {
		return nil, errors.New("params: an object")
	}
	allowed := map[string][]string{
		"plot": {"t_end", "points", "runs", "seed", "engine"}, "reachability": {"max_states"}, "invariants": {"kind"},
		"categorical": {"name"}, "notation": {"source"}, "canvas": {},
	}[view]
	for k := range p {
		ok := false
		for _, a := range allowed {
			ok = ok || a == k
		}
		if !ok {
			return nil, fmt.Errorf("params.%s: not a parameter of view %s (it takes %v)", k, view, allowed)
		}
	}
	num := func(k string, lo, hi float64, integer bool) error {
		v, ok := p[k]
		if !ok {
			return nil
		}
		f, ok := v.(float64)
		if !ok || f < lo || f > hi || (integer && f != float64(int64(f))) {
			return fmt.Errorf("params.%s: a number in [%g, %g]", k, lo, hi)
		}
		return nil
	}
	for _, c := range []struct {
		k      string
		lo, hi float64
		int    bool
	}{{"t_end", 1e-9, maxMCPTEnd, false}, {"points", 2, 200, true}, {"runs", 1, 200, true}, {"seed", 0, 1 << 53, true}, {"max_states", 1, maxMCPStates, true}} {
		if err := num(c.k, c.lo, c.hi, c.int); err != nil {
			return nil, err
		}
	}
	if v, ok := p["engine"]; ok && v != "ode" && v != "ssa" {
		return nil, errors.New(`params.engine: "ode" or "ssa"`)
	}
	if v, ok := p["kind"]; ok && v != "p" && v != "t" {
		return nil, errors.New(`params.kind: "p" or "t"`)
	}
	if v, ok := p["name"]; ok {
		n, _ := v.(string)
		found := false
		for _, id := range composeViewIDs {
			found = found || id == n
		}
		if !found {
			return nil, fmt.Errorf("params.name: one of %v", composeViewIDs)
		}
	}
	if v, ok := p["source"]; ok {
		if t, ok := v.(string); !ok || len(t) > maxTabSource {
			return nil, fmt.Errorf("params.source: text up to %d bytes", maxTabSource)
		}
	}
	b, _ := json.Marshal(p)
	return b, nil
}

func mcpShow(s *Server, r *http.Request, args map[string]any) (any, error) {
	owner, _, err := tabCaller(s, r)
	if err != nil {
		return nil, err
	}
	view, _ := args["view"].(string)
	known := false
	for _, v := range tabViews {
		known = known || v == view
	}
	if !known {
		return nil, fmt.Errorf("view: one of %v", tabViews)
	}
	_, hasNet := args["net"]
	cid, _ := args["cid"].(string)
	if hasNet == (cid != "") {
		return nil, errors.New("give exactly one of net (private) and cid (a stored model, public)")
	}
	params, err := tabParams(view, args["params"])
	if err != nil {
		return nil, err
	}
	note, _ := args["note"].(string)
	if len(note) > maxTabNoteBytes {
		return nil, fmt.Errorf("note: at most %d bytes", maxTabNoteBytes)
	}
	tabID, _ := args["tab"].(string)
	ev := tabhub.Event{Type: "show", RequestID: tabhub.NewID(), View: view, Params: params, Note: note}
	private := false
	if hasNet {
		private = true
		if view == "categorical" {
			return nil, errors.New("categorical views read a stored composition: give its cid (pflow_save stores a net; compositions are stored with POST /api/save)")
		}
		raw, doc, err := netBytes(args)
		if err != nil {
			return nil, err
		}
		if len(raw) > maxTabNetBytes {
			return nil, fmt.Errorf("net: at most %d bytes to push to a page", maxTabNetBytes)
		}
		if err := validateJSONLD(doc); err != nil {
			return nil, fmt.Errorf("invalid JSON-LD: %v", err)
		}
		if k := model.KindOf(raw); k != model.KindNet {
			return nil, fmt.Errorf("a %s is shown with view categorical and its cid", k)
		}
		ev.Net = raw
	} else {
		if cid == "" || strings.ContainsAny(cid, "/\\.") {
			return nil, errors.New("cid: a stored model's CID")
		}
		raw, err := s.storage.GetObject(cid)
		if err != nil {
			return nil, fmt.Errorf("no model %s", cid)
		}
		k := model.KindOf(raw)
		switch {
		case view == "categorical" && k == model.KindNet:
			return nil, errors.New("categorical views show a stored composition; this cid is a net (open it with view canvas)")
		case view != "categorical" && k != model.KindNet:
			return nil, fmt.Errorf("this cid is a %s: show it with view categorical", k)
		}
		ev.CID = cid
		if k == model.KindNet {
			if len(raw) > maxTabNetBytes {
				return nil, fmt.Errorf("net: at most %d bytes to push to a page", maxTabNetBytes)
			}
			ev.Net = raw
		}
	}
	n, err := s.tabs.hub.Push(owner, tabID, ev)
	if err != nil {
		return nil, hubMessage(err)
	}
	// What is logged of a push: its size and the tab, never the net.
	log.Printf("tab push: %s %d bytes private=%v tab=%q delivered=%d", view, len(ev.Net), private, tabID, n)
	out := map[string]any{"sent": n > 0, "tabs": n, "view": view, "private": private, "request_id": ev.RequestID}
	if n == 0 {
		out["note"] = "No linked page had a live stream, so nothing was sent and nothing was kept. Check pflow_tabs; the person turns the link on in the page (Link to Claude)."
	} else {
		out["note"] = "Sent. Call pflow_tab_get to see what the page shows."
	}
	return out, nil
}

func mcpTabGet(s *Server, r *http.Request, args map[string]any) (any, error) {
	owner, _, err := tabCaller(s, r)
	if err != nil {
		return nil, err
	}
	tabID, _ := args["tab"].(string)
	wantNet, _ := args["net"].(bool)
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	rep, fresh, id, err := s.tabs.hub.State(ctx, owner, tabID, wantNet)
	if err != nil {
		return nil, hubMessage(err)
	}
	out := map[string]any{"tab": id, "fresh": fresh, "report": rep}
	if !fresh {
		out["note"] = "The page did not answer in time; this is its last report."
	}
	return out, nil
}

func mcpTabStop(s *Server, r *http.Request, args map[string]any) (any, error) {
	owner, _, err := tabCaller(s, r)
	if err != nil {
		return nil, err
	}
	tabID, _ := args["tab"].(string)
	n, err := s.tabs.hub.Push(owner, tabID, tabhub.Event{Type: "stop", RequestID: tabhub.NewID()})
	if err != nil {
		return nil, hubMessage(err)
	}
	return map[string]any{"sent": n > 0, "tabs": n}, nil
}
