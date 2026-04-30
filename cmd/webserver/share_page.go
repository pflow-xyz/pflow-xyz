package main

// Server-rendered share page metadata. When the SPA is loaded with
// /?cid=z…, link-unfurlers (Twitter, Slack, Discord, iMessage,
// Mastodon, Bluesky, Facebook, …) hit "/" without ever running JS
// and so see the static index.html. This file decorates that response
// with Open Graph / Twitter / JSON-LD meta tags derived from the
// stored payload, so every shared CID URL gets a real preview card.
//
// The cid-less / unknown-cid path falls through to the plain static
// index, so the app behaviour is unchanged for everyone who isn't
// linking a specific net.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// decorateIndexForShare returns either the original index bytes, or
// a copy with a cid-specific <head> block injected. Always returns
// the original on miss / parse failure — the SPA is still valid HTML
// without the decoration.
func (s *Server) decorateIndexForShare(r *http.Request, indexHTML []byte) []byte {
	cid := r.URL.Query().Get("cid")
	if cid == "" || !cidPattern.MatchString(cid) {
		return indexHTML
	}
	raw, err := s.storage.GetObject(cid)
	if err != nil {
		return indexHTML
	}
	var p cardPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return indexHTML
	}
	origin := schemeHost(r)
	summary := summarizeCard(p, cid, origin)
	cardPNG := fmt.Sprintf("%s/share-card/%s.png", origin, cid)
	cardSVG := fmt.Sprintf("%s/share-card/%s.svg", origin, cid)
	desc := summary.Subtitle
	if d := strings.TrimSpace(p.Description); d != "" {
		if len(d) > 200 {
			d = d[:197] + "…"
		}
		desc = d
	}
	title := summary.Title + " · pflow.xyz"
	imgAlt := fmt.Sprintf("%s — %s", summary.Title, summary.Subtitle)

	// JSON-LD projection: a small descriptor pointing at the canonical
	// payload, plus the payload itself re-embedded so consumers that
	// parse the page can recover the exact net without an extra
	// round-trip to /o/{cid}.
	projection := map[string]interface{}{
		"@context":    "https://schema.org",
		"@type":       "CreativeWork",
		"name":        summary.Title,
		"description": desc,
		"url":         summary.ShareURL,
		"image":       cardPNG,
		"identifier":  cid,
	}
	projJSON, _ := json.Marshal(projection)

	block := buildShareHeadBlock(shareHeadFields{
		Title:    title,
		Desc:     desc,
		ShareURL: summary.ShareURL,
		CardPNG:  cardPNG,
		CardSVG:  cardSVG,
		ImgAlt:   imgAlt,
		CID:      cid,
		ProjJSON: string(projJSON),
		Payload:  string(raw),
	})

	// Strip the static og:* / twitter:* / canonical / description meta
	// tags from the original document before injecting the per-CID block.
	// Without this, both sets co-exist and unfurlers' "first vs last
	// wins" behaviour determines which card shows — modern crawlers
	// take last, but it's cheaper to just remove the duplicates.
	out := stripExistingShareMeta(indexHTML)
	out = injectIntoHead(out, []byte(block))
	out = replaceTitleTag(out, title)
	return out
}

// stripExistingShareMeta removes <meta property="og:…">, <meta
// name="twitter:…">, <meta name="description">, and <link
// rel="canonical"> tags from doc. Used by decorateIndexForShare so
// the per-CID block is the only social metadata in the response.
var (
	staticOGRe         = regexp.MustCompile(`(?i)\s*<meta\s+property="og:[^"]*"[^>]*/?>\s*\n?`)
	staticTwitterRe    = regexp.MustCompile(`(?i)\s*<meta\s+name="twitter:[^"]*"[^>]*/?>\s*\n?`)
	staticDescRe       = regexp.MustCompile(`(?i)\s*<meta\s+name="description"[^>]*/?>\s*\n?`)
	staticCanonicalRe  = regexp.MustCompile(`(?i)\s*<link\s+rel="canonical"[^>]*/?>\s*\n?`)
	staticAlternateRe  = regexp.MustCompile(`(?i)\s*<link\s+rel="alternate"\s+type="application/ld\+json"[^>]*/?>\s*\n?`)
)

func stripExistingShareMeta(doc []byte) []byte {
	doc = staticOGRe.ReplaceAll(doc, []byte("\n"))
	doc = staticTwitterRe.ReplaceAll(doc, []byte("\n"))
	doc = staticDescRe.ReplaceAll(doc, []byte("\n"))
	doc = staticCanonicalRe.ReplaceAll(doc, []byte("\n"))
	doc = staticAlternateRe.ReplaceAll(doc, []byte("\n"))
	return doc
}

type shareHeadFields struct {
	Title, Desc, ShareURL, CardPNG, CardSVG, ImgAlt, CID string
	ProjJSON, Payload                                    string
}

// buildShareHeadBlock renders the OG/Twitter/JSON-LD block. Hand-rolled
// rather than html/template because we need the inline JSON-LD payload
// to remain the canonical bytes (so the CID still hashes), and the
// default html escaper would mangle the `</script>`-safe variant we
// emit below.
func buildShareHeadBlock(f shareHeadFields) string {
	var b strings.Builder
	b.WriteString("<!-- pflow-xyz share card -->\n")
	writeMeta := func(prop, content string) {
		fmt.Fprintf(&b, `<meta property=%q content=%q/>`+"\n", prop, content)
	}
	writeName := func(name, content string) {
		fmt.Fprintf(&b, `<meta name=%q content=%q/>`+"\n", name, content)
	}
	writeMeta("og:type", "website")
	writeMeta("og:title", f.Title)
	writeMeta("og:description", f.Desc)
	writeMeta("og:url", f.ShareURL)
	writeMeta("og:image", f.CardPNG)
	writeMeta("og:image:secure_url", f.CardPNG)
	writeMeta("og:image:type", "image/png")
	writeMeta("og:image:width", "1200")
	writeMeta("og:image:height", "630")
	writeMeta("og:image:alt", f.ImgAlt)
	writeMeta("og:site_name", "pflow.xyz")
	writeName("twitter:card", "summary_large_image")
	writeName("twitter:title", f.Title)
	writeName("twitter:description", f.Desc)
	writeName("twitter:image", f.CardPNG)
	writeName("twitter:image:alt", f.ImgAlt)
	writeName("description", f.Desc)
	fmt.Fprintf(&b, `<link rel="canonical" href=%q/>`+"\n", f.ShareURL)
	fmt.Fprintf(&b, `<link rel="alternate" type="application/ld+json" href="/o/%s"/>`+"\n", f.CID)
	if f.ProjJSON != "" {
		fmt.Fprintf(&b, `<script type="application/ld+json">%s</script>`+"\n", escapeForScriptTag(f.ProjJSON))
	}
	if f.Payload != "" {
		fmt.Fprintf(&b, `<script type="application/ld+json">%s</script>`+"\n", escapeForScriptTag(f.Payload))
	}
	return b.String()
}

// escapeForScriptTag prevents a `</script>` substring inside a JSON
// string from terminating the surrounding <script> element.
func escapeForScriptTag(s string) string {
	return strings.ReplaceAll(s, "</", "<\\/")
}

// injectIntoHead splices `block` in just before </head>. Falls back
// to prepending the block when the marker isn't found.
func injectIntoHead(doc []byte, block []byte) []byte {
	marker := []byte("</head>")
	i := bytes.Index(doc, marker)
	if i < 0 {
		out := make([]byte, 0, len(doc)+len(block))
		out = append(out, block...)
		return append(out, doc...)
	}
	out := make([]byte, 0, len(doc)+len(block))
	out = append(out, doc[:i]...)
	out = append(out, block...)
	return append(out, doc[i:]...)
}

// replaceTitleTag swaps the contents of the first <title>…</title>
// in doc with newTitle. No-op if the tag isn't present.
func replaceTitleTag(doc []byte, newTitle string) []byte {
	open := []byte("<title>")
	close := []byte("</title>")
	i := bytes.Index(doc, open)
	if i < 0 {
		return doc
	}
	j := bytes.Index(doc[i:], close)
	if j < 0 {
		return doc
	}
	out := make([]byte, 0, len(doc)+len(newTitle))
	out = append(out, doc[:i+len(open)]...)
	out = append(out, []byte(htmlEscape(newTitle))...)
	out = append(out, doc[i+j:]...)
	return out
}

func htmlEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

// schemeHost returns the public origin (scheme://host) for the
// request, honoring X-Forwarded-Proto / X-Forwarded-Host so cards
// resolve correctly behind nginx on pflow.dev.
func schemeHost(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if v := r.Header.Get("X-Forwarded-Proto"); v != "" {
		scheme = v
	}
	host := r.Host
	if v := r.Header.Get("X-Forwarded-Host"); v != "" {
		host = v
	}
	return scheme + "://" + host
}
