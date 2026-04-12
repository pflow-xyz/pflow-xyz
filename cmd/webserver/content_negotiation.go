package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io/fs"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// wantsHTML returns true when the client prefers text/html over JSON-LD/JSON.
// A missing or wildcard-only Accept header (e.g. curl's "*/*") is treated as a
// machine client and returns false, preserving JSON-LD as the default.
func wantsHTML(r *http.Request) bool {
	accept := r.Header.Get("Accept")
	if accept == "" {
		return false
	}
	var htmlQ, jsonQ float64
	for _, part := range strings.Split(accept, ",") {
		mt, q := parseAcceptMedia(part)
		switch mt {
		case "text/html", "application/xhtml+xml":
			if q > htmlQ {
				htmlQ = q
			}
		case "application/ld+json", "application/json":
			if q > jsonQ {
				jsonQ = q
			}
		}
	}
	return htmlQ > jsonQ
}

func parseAcceptMedia(part string) (string, float64) {
	fields := strings.Split(strings.TrimSpace(part), ";")
	mt := strings.ToLower(strings.TrimSpace(fields[0]))
	q := 1.0
	for _, f := range fields[1:] {
		kv := strings.SplitN(strings.TrimSpace(f), "=", 2)
		if len(kv) == 2 && strings.TrimSpace(kv[0]) == "q" {
			if v, err := strconv.ParseFloat(strings.TrimSpace(kv[1]), 64); err == nil {
				q = v
			}
		}
	}
	return mt, q
}

// schemaTerm is one entry from the JSON-LD @context, flattened for display.
type schemaTerm struct {
	Name      string
	ID        string
	Type      string
	Container string
}

// loadSchemaTerms parses the embedded schema JSON-LD and returns its terms
// (skipping JSON-LD keywords like @version, @vocab) sorted alphabetically.
func loadSchemaTerms(data []byte) ([]schemaTerm, error) {
	var doc struct {
		Context map[string]interface{} `json:"@context"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	terms := make([]schemaTerm, 0, len(doc.Context))
	for name, raw := range doc.Context {
		if strings.HasPrefix(name, "@") {
			continue
		}
		def, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		t := schemaTerm{Name: name}
		if v, ok := def["@id"].(string); ok {
			t.ID = v
		}
		if v, ok := def["@type"].(string); ok {
			t.Type = v
		}
		if v, ok := def["@container"].(string); ok {
			t.Container = v
		}
		terms = append(terms, t)
	}
	sort.Slice(terms, func(i, j int) bool { return terms[i].Name < terms[j].Name })
	return terms, nil
}

// schemaCache lazily loads and caches the parsed schema.
type schemaCache struct {
	once  sync.Once
	raw   []byte
	terms []schemaTerm
	err   error
}

func (c *schemaCache) load(publicFS fs.FS) ([]byte, []schemaTerm, error) {
	c.once.Do(func() {
		c.raw, c.err = fs.ReadFile(publicFS, "schema")
		if c.err != nil {
			return
		}
		c.terms, c.err = loadSchemaTerms(c.raw)
	})
	return c.raw, c.terms, c.err
}

var (
	schemaTpl = template.Must(template.New("schema").Parse(schemaHTMLTpl))
	tokenTpl  = template.Must(template.New("token").Parse(tokenHTMLTpl))
)

type tokenSwatch struct {
	Label string
	CSS   template.CSS
}

type tokenViewData struct {
	Name        string
	Description string
	ColorCount  int
	Swatches    []tokenSwatch
}

// renderTokenHTML writes the human-readable token page.
func renderTokenHTML(w http.ResponseWriter, name, description string, colors []string, isHex []bool) error {
	swatches := make([]tokenSwatch, len(colors))
	for i, c := range colors {
		css := c
		if isHex[i] {
			css = "#" + c
		}
		swatches[i] = tokenSwatch{Label: c, CSS: template.CSS(css)}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	return tokenTpl.Execute(w, tokenViewData{
		Name:        name,
		Description: description,
		ColorCount:  len(colors),
		Swatches:    swatches,
	})
}

// renderSchemaHTML writes the human-readable schema reference page.
func renderSchemaHTML(w http.ResponseWriter, terms []schemaTerm) error {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	return schemaTpl.Execute(w, struct{ Terms []schemaTerm }{terms})
}

// handleSchema serves /schema with content negotiation: HTML for browsers,
// JSON-LD (the embedded public/schema file) for everyone else.
func (s *Server) handleSchema(w http.ResponseWriter, r *http.Request) {
	if s.handleCORS(w, r) {
		return
	}
	raw, terms, err := s.schemaCache.load(s.publicFS)
	if err != nil {
		http.Error(w, fmt.Sprintf("schema unavailable: %v", err), http.StatusInternalServerError)
		return
	}
	if wantsHTML(r) {
		if err := renderSchemaHTML(w, terms); err != nil {
			http.Error(w, "render error", http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/ld+json")
	w.Write(raw)
}

const schemaHTMLTpl = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pflow.xyz Schema</title>
<style>
:root {
  --pf-bg: #1C1C1D;
  --pf-bg-card: #2a2a2b;
  --pf-text: #ffffff;
  --pf-text-muted: #999999;
  --pf-accent: #EBFF00;
  --pf-border: #333333;
}
body {
  background: var(--pf-bg);
  color: var(--pf-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  margin: 0;
  padding: 32px 16px;
  line-height: 1.5;
}
.container { max-width: 960px; margin: 0 auto; }
h1 { color: var(--pf-accent); font-size: 28px; margin-top: 0; }
a { color: var(--pf-accent); }
p { color: var(--pf-text-muted); }
table { width: 100%; border-collapse: collapse; margin-top: 24px; background: var(--pf-bg-card); border-radius: 4px; overflow: hidden; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--pf-border); font-size: 14px; vertical-align: top; }
th { background: #1a1a1a; color: var(--pf-accent); font-weight: 500; }
td.term { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--pf-text); white-space: nowrap; }
td.id, td.type { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--pf-text-muted); font-size: 12px; word-break: break-all; }
pre { background: var(--pf-bg-card); padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.nav { margin-bottom: 24px; font-size: 14px; }
.nav a { text-decoration: none; }
</style>
</head>
<body>
<div class="container">
<div class="nav"><a href="/">&larr; pflow.xyz</a></div>
<h1>Petri Net Schema</h1>
<p>JSON-LD context for pflow Petri net documents. This page describes the vocabulary used by <code>@context: "https://pflow.xyz/schema"</code>. Machine clients receive JSON-LD; browsers see this human-readable reference.</p>
<p>Fetch as JSON-LD:</p>
<pre><code>curl -H 'Accept: application/ld+json' https://pflow.xyz/schema</code></pre>
<table>
<thead><tr><th>Term</th><th>@id</th><th>@type</th><th>@container</th></tr></thead>
<tbody>
{{range .Terms}}<tr>
<td class="term">{{.Name}}</td>
<td class="id">{{.ID}}</td>
<td class="type">{{.Type}}</td>
<td class="type">{{.Container}}</td>
</tr>
{{end}}</tbody>
</table>
</div>
</body>
</html>`

const tokenHTMLTpl = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Name}} – pflow.xyz token</title>
<style>
:root {
  --pf-bg: #1C1C1D;
  --pf-bg-card: #2a2a2b;
  --pf-text: #ffffff;
  --pf-text-muted: #999999;
  --pf-accent: #EBFF00;
  --pf-border: #333333;
}
body {
  background: var(--pf-bg);
  color: var(--pf-text);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  margin: 0;
  padding: 32px 16px;
  line-height: 1.5;
}
.container { max-width: 720px; margin: 0 auto; }
h1 { color: var(--pf-accent); font-size: 28px; margin-top: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
a { color: var(--pf-accent); }
p { color: var(--pf-text-muted); }
.swatches { display: flex; gap: 8px; margin: 24px 0; flex-wrap: wrap; }
.swatch {
  width: 96px; height: 96px;
  border-radius: 4px;
  border: 1px solid var(--pf-border);
  display: flex; align-items: flex-end;
  padding: 6px; box-sizing: border-box;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #fff;
  text-shadow: 0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.6);
}
pre { background: var(--pf-bg-card); padding: 12px; border-radius: 4px; overflow-x: auto; font-size: 13px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.nav { margin-bottom: 24px; font-size: 14px; }
.nav a { text-decoration: none; }
.meta { font-size: 13px; margin-top: 24px; }
.meta dt { color: var(--pf-text); margin-top: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.meta dd { color: var(--pf-text-muted); margin: 4px 0 0 16px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<div class="container">
<div class="nav"><a href="/">&larr; pflow.xyz</a> &middot; <a href="/schema">schema</a></div>
<h1>{{.Name}}</h1>
<div class="swatches">
{{range .Swatches}}<div class="swatch" style="background-color: {{.CSS}}">{{.Label}}</div>
{{end}}</div>
<p>{{.Description}}</p>
<dl class="meta">
<dt>@type</dt><dd>TokenType</dd>
<dt>@id</dt><dd>https://pflow.xyz/tokens/{{.Name}}</dd>
<dt>colorCount</dt><dd>{{.ColorCount}}</dd>
</dl>
<p>Fetch as JSON-LD:</p>
<pre><code>curl -H 'Accept: application/ld+json' https://pflow.xyz/tokens/{{.Name}}</code></pre>
</div>
</body>
</html>`
