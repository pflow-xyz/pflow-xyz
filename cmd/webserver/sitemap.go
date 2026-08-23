package main

import (
	"fmt"
	"net/http"
	"strings"
)

// handleSitemap renders sitemap.xml from what is actually stored: the
// landing page, the schema, and one model page plus one rendered SVG per
// object. Every entry resolves by construction, which the static file this
// replaced could not promise.
func (s *Server) handleSitemap(w http.ResponseWriter, r *http.Request) {
	base := "https://pflow.xyz"
	cids, err := s.storage.ListCIDs()
	if err != nil {
		http.Error(w, "sitemap unavailable", http.StatusInternalServerError)
		return
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n")
	b.WriteString(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` + "\n")
	entry := func(loc, prio string) {
		fmt.Fprintf(&b, "  <url><loc>%s</loc><priority>%s</priority></url>\n", loc, prio)
	}
	entry(base+"/", "1.0")
	entry(base+"/schema", "0.8")
	for _, cid := range cids {
		if !cidPattern.MatchString(cid) {
			continue
		}
		entry(base+"/?cid="+cid, "0.7")
		entry(base+"/img/"+cid+".svg", "0.5")
	}
	b.WriteString("</urlset>\n")
	w.Header().Set("Content-Type", "application/xml; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write([]byte(b.String()))
}
