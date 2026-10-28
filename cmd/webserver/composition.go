package main

// Compositions in the object store. A stored object is a net (Shape A editor
// JSON-LD), a composition (@type PetriNetBundle: parts by CID plus typed
// links) or a search plan; internal/model has the rule. Every surface keyed by
// CID used to assume a net, so each branches here on the object's kind:
//
//   - GET /?cid=<composition>   → 302 /compose.html?cid=<composition> (the
//     editor cannot open a bundle); a net CID still opens the editor.
//   - GET /compose.html?cid=…   → the composition page, with the share card
//     head block the editor page gets.
//   - GET /img/<cid>.svg and /share-card/<cid>.{svg,png} draw the composition's
//     flat net (go-pflow's Bundle.Flatten, the reference implementation), or,
//     when a part is missing from the store, the parts diagram. Never a 500.
//   - POST /api/save and pflow_save refuse a composition whose parts are not
//     stored, and answer a bare wrapper with the net's own CID instead of
//     storing a second object for the same net.

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"sort"
	"strings"

	"github.com/pflow-xyz/pflow-xyz/internal/auth"
	"github.com/pflow-xyz/pflow-xyz/internal/model"
	"github.com/pflow-xyz/pflow-xyz/internal/seal"
	"github.com/pflow-xyz/pflow-xyz/internal/svg"
)

// compositionLayout places the nodes of a net that has no coordinates.
const compositionLayout = "sugiyama"

// compositionNet returns a stored composition as an editor-shape net with
// coordinates, for the SVG and the share card: its flat net when every part
// resolves (flat true), else a diagram of its parts and links.
func compositionNet(storage Storage, raw []byte) (net []byte, flat bool) {
	if m, _, err := model.Flatten(raw, storage.GetObject); err == nil {
		var named struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		_ = json.Unmarshal(raw, &named)
		if named.Name != "" {
			m.Name = named.Name
		}
		if named.Description != "" {
			m.Description = named.Description
		}
		if js, err := model.FlatNetJSON(m); err == nil {
			if laid, err := svg.LayoutJSON(js, compositionLayout); err == nil {
				return laid, true
			}
			return js, true
		}
	}
	js := partsNetJSON(raw)
	if laid, err := svg.LayoutJSON(js, compositionLayout); err == nil {
		return laid, false
	}
	return js, false
}

// partsNetJSON draws a composition's structure: a place per part, a
// transition per link, an arc from each link's source part and into its
// target part. It needs nothing from the store, so it is the fallback when a
// part is missing.
func partsNetJSON(raw []byte) []byte {
	var doc map[string]any
	_ = json.Unmarshal(raw, &doc)
	places := map[string]any{}
	trans := map[string]any{}
	arcs := []map[string]any{}
	subs, _ := doc["subnets"].([]any)
	for _, s := range subs {
		if m, ok := s.(map[string]any); ok {
			if id, _ := m["id"].(string); id != "" {
				places[id] = map[string]any{"@type": "Place", "initial": []int{0}, "capacity": []int{0}, "offset": 0, "x": 0, "y": 0, "label": id}
			}
		}
	}
	links, _ := doc["links"].([]any)
	for i, l := range links {
		m, ok := l.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := m["kind"].(string)
		id := fmt.Sprintf("link%d", i+1)
		trans[id] = map[string]any{"@type": "Transition", "x": 0, "y": 0, "label": kind}
		from, _ := m["from"].(map[string]any)
		to, _ := m["to"].(map[string]any)
		fs, _ := from["subnet"].(string)
		ts, _ := to["subnet"].(string)
		if _, ok := places[fs]; ok {
			arcs = append(arcs, map[string]any{"@type": "Arrow", "source": fs, "target": id, "weight": []int{1}, "inhibitTransition": false})
		}
		if _, ok := places[ts]; ok {
			arcs = append(arcs, map[string]any{"@type": "Arrow", "source": id, "target": ts, "weight": []int{1}, "inhibitTransition": false})
		}
	}
	net := map[string]any{
		"@context": model.Context, "@type": "PetriNet",
		"token":  []string{"https://pflow.xyz/tokens/black"},
		"places": places, "transitions": trans, "arcs": arcs,
	}
	if n, _ := doc["name"].(string); n != "" {
		net["name"] = n
	}
	out, _ := json.Marshal(net)
	return out
}

// drawableNet turns any stored object into editor-shape net JSON the SVG and
// share-card code can draw: a net as is, a composition as its flat net, a
// plan as an empty net named for it. flat reports a composition that resolved.
func drawableNet(storage Storage, raw []byte) (net []byte, kind string, flat bool) {
	kind = model.KindOf(raw)
	switch kind {
	case model.KindComposition:
		net, flat = compositionNet(storage, raw)
		return net, kind, flat
	case model.KindPlan:
		var doc map[string]any
		_ = json.Unmarshal(raw, &doc)
		mc, _ := doc["model_cid"].(string)
		out, _ := json.Marshal(map[string]any{
			"@context": model.Context, "@type": "PetriNet",
			"name":        "Search plan",
			"description": "A search plan for the model " + mc,
			"token":       []string{"https://pflow.xyz/tokens/black"},
			"places":      map[string]any{}, "transitions": map[string]any{}, "arcs": []any{},
		})
		return out, kind, false
	}
	return raw, kind, false
}

// ---- GET /?cid= and /compose.html?cid= ----

// composeURL is where a composition CID opens for people.
func composeURL(cid string) string { return "/compose.html?cid=" + cid }

// compositionRedirect answers GET /?cid=<composition> with the page that can
// show it. Anything else (a net, an unknown or malformed CID, a storage
// error) returns false and falls through to the editor as before.
func (s *Server) compositionRedirect(w http.ResponseWriter, r *http.Request) bool {
	cid := r.URL.Query().Get("cid")
	if cid == "" || !cidPattern.MatchString(cid) {
		return false
	}
	raw, err := s.storage.GetObject(cid)
	if err != nil || model.KindOf(raw) != model.KindComposition {
		return false
	}
	http.Redirect(w, r, composeURL(cid), http.StatusFound)
	return true
}

// serveComposePage serves compose.html with the share head block for the
// model in ?cid=, so a link to a composition unfurls like a link to a net.
func (s *Server) serveComposePage(w http.ResponseWriter, r *http.Request) {
	data, err := fs.ReadFile(s.publicFS, "compose.html")
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	data, status := s.decorateComposeForShare(r, data)
	w.Header().Set("Content-Type", "text/html")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(status)
	w.Write(data)
}

// decorateComposeForShare is decorateIndexForShare for the composition page.
// The status is 404 for a malformed or absent CID (the page itself still
// loads), 200 otherwise.
func (s *Server) decorateComposeForShare(r *http.Request, page []byte) ([]byte, int) {
	cid := r.URL.Query().Get("cid")
	if !cidPattern.MatchString(cid) {
		return page, http.StatusNotFound
	}
	raw, err := s.storage.GetObject(cid)
	if err != nil {
		if os.IsNotExist(err) {
			return page, http.StatusNotFound
		}
		return page, http.StatusOK
	}
	netJSON, kind, _ := drawableNet(s.storage, raw)
	p, err := parseCardPayload(netJSON)
	if err != nil {
		return page, http.StatusOK
	}
	var named struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(raw, &named)
	if named.Name != "" {
		p.Name = named.Name
	}
	origin := schemeHost(r)
	summary := summarizeCard(p, cid, origin, r.URL.Query().Get("title"))
	cardPNG := fmt.Sprintf("%s/share-card/%s.png", origin, cid)
	cardSVG := fmt.Sprintf("%s/share-card/%s.svg", origin, cid)
	desc := summary.Subtitle
	if kind == model.KindComposition {
		var doc map[string]any
		_ = json.Unmarshal(raw, &doc)
		subs, _ := doc["subnets"].([]any)
		links, _ := doc["links"].([]any)
		desc = fmt.Sprintf("A composition of %d parts and %d links · %s", len(subs), len(links), summary.Subtitle)
	}
	if d := strings.TrimSpace(named.Description); d != "" {
		if len(d) > 200 {
			d = d[:197] + "…"
		}
		desc = d
	}
	title := summary.Title + " · pflow.xyz"
	projJSON, _ := json.Marshal(map[string]interface{}{
		"@context": "https://schema.org", "@type": "CreativeWork",
		"name": summary.Title, "description": desc, "url": summary.ShareURL,
		"image": cardPNG, "identifier": cid,
	})
	block := buildShareHeadBlock(shareHeadFields{
		Title: title, Desc: desc, ShareURL: summary.ShareURL, CardPNG: cardPNG, CardSVG: cardSVG,
		ImgAlt: fmt.Sprintf("%s — %s", summary.Title, summary.Subtitle), CID: cid,
		ProjJSON: string(projJSON), Payload: string(raw),
	})
	out := stripExistingShareMeta(page)
	out = injectIntoHead(out, []byte(block))
	out = replaceTitleTag(out, title)
	return out, http.StatusOK
}

// ---- saving ----

// saveModelDoc stores a composition or a plan (POST /api/save and pflow_save
// route here when the document is not a net; nets take the path they always
// took). It answers with the CID the rule gives and what it was.
//
// A composition's by-reference parts must already be stored nets: like git
// objects, the things a document names exist before the document does. A bare
// wrapper is not stored at all; it is the net it names, so the answer is that
// net's CID with reduced:true. A plan may name a model the store does not
// hold (it may live elsewhere).
func (s *Server) saveModelDoc(raw []byte, author *auth.GitHubUserInfo) (status int, out map[string]any, err error) {
	id, err := model.Identify(raw)
	if err != nil {
		return http.StatusBadRequest, nil, err
	}
	if id.Kind == model.KindComposition || id.Reduced {
		var missing []string
		for _, p := range id.Parts {
			part, gerr := s.storage.GetObject(p)
			if gerr != nil || model.KindOf(part) != model.KindNet {
				missing = append(missing, p)
			}
		}
		if len(missing) > 0 {
			sort.Strings(missing)
			return http.StatusUnprocessableEntity, nil, &model.Error{Code: model.ErrPartMissing,
				Msg: "save these nets first: " + strings.Join(missing, ", ")}
		}
	}
	if id.Reduced {
		return http.StatusOK, map[string]any{"cid": id.CID, "kind": model.KindNet, "reduced": true}, nil
	}
	cid, canonical, err := seal.SealJSONLD(raw)
	if err != nil {
		return http.StatusBadRequest, nil, fmt.Errorf("sealing failed: %v", err)
	}
	if author != nil {
		err = s.storage.SaveObjectWithAuthor(cid, raw, canonical, author.UserName, author.GitHubID)
	} else {
		err = s.storage.SaveObject(cid, raw, canonical)
	}
	if err != nil {
		return http.StatusInternalServerError, nil, fmt.Errorf("failed to save object")
	}
	return http.StatusOK, map[string]any{"cid": cid, "kind": id.Kind}, nil
}
