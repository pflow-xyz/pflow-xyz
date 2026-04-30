package main

// Social-share cards for /?cid=… URLs. Two surfaces from the same
// payload:
//
//   GET /share-card/{cid}.svg  — vector card; nice for Slack/Discord/iMessage
//   GET /share-card/{cid}.png  — rasterised twin; required because Twitter/X,
//                                Mastodon, Bluesky, and most newsreaders
//                                silently drop SVG og:images.
//
// Both renders read the stored JSON-LD via the object store and draw a
// 1200×630 card with the model name, place/transition counts, token
// color swatches, the canonical share URL, and a QR code that scans
// to the same /?cid= URL.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"

	"github.com/fogleman/gg"
	qrcode "github.com/skip2/go-qrcode"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"

	"github.com/pflow-xyz/pflow-xyz/internal/svg"
)

// cidPattern is the basic shape of a base58btc CIDv1 ("z…"). Loose
// match — the store does the real lookup, so we just gate against
// path traversal and obvious garbage here.
var cidPattern = regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{20,80}$`)

// cardPayload is the slice of saved JSON-LD we use to build a card.
// Mirrors the schema's optional name/description plus the structural
// fields needed for the visualization.
type cardPayload struct {
	Type        string                    `json:"@type"`
	Name        string                    `json:"name,omitempty"`
	Description string                    `json:"description,omitempty"`
	Token       []string                  `json:"token,omitempty"`
	Places      map[string]cardPlace      `json:"places"`
	Transitions map[string]cardTransition `json:"transitions"`
	Arcs        []cardArc                 `json:"arcs"`
}

type cardPlace struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Initial []int   `json:"initial"`
}

type cardTransition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type cardArc struct {
	Source            string `json:"source"`
	Target            string `json:"target"`
	InhibitTransition bool   `json:"inhibitTransition"`
}

// cardSummary is the rendered-card-ready projection of a payload.
type cardSummary struct {
	Title           string
	Subtitle        string // "N places · M transitions"
	PlaceCount      int
	TransitionCount int
	ArcCount        int
	TokenColors     []string // hex
	ShareURL        string   // canonical /?cid=…
	CID             string
}

func parseCardPayload(raw []byte) (cardPayload, error) {
	var p cardPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		return p, err
	}
	return p, nil
}

// summarizeCard projects a payload + an optional URL-supplied title
// override into the card-ready summary. titleOverride wins over the
// payload's name field, which wins over the "Petri Net" fallback.
// The override is needed because saved CIDs are immutable — the
// landing-page examples have no name field embedded but the page
// knows them ("Tic-Tac-Toe", "Coffee Shop", …) and can pass the
// label through ?title=.
func summarizeCard(p cardPayload, cid, origin, titleOverride string) cardSummary {
	title := strings.TrimSpace(titleOverride)
	if title == "" {
		title = strings.TrimSpace(p.Name)
	}
	if title == "" {
		title = "Petri Net"
	}
	if len(title) > 80 {
		title = title[:77] + "…"
	}
	tokens := make([]string, 0, len(p.Token))
	for _, t := range p.Token {
		if hex := tokenColorHex(t); hex != "" {
			tokens = append(tokens, hex)
		}
	}
	if len(tokens) == 0 {
		tokens = []string{"#000000"}
	}
	return cardSummary{
		Title:           title,
		Subtitle:        fmt.Sprintf("%d places · %d transitions", len(p.Places), len(p.Transitions)),
		PlaceCount:      len(p.Places),
		TransitionCount: len(p.Transitions),
		ArcCount:        len(p.Arcs),
		TokenColors:     tokens,
		ShareURL:        buildShareURL(origin, cid, titleOverride),
		CID:             cid,
	}
}

// buildShareURL preserves the title override in the canonical share
// URL so a scanned QR / clicked link reproduces the same labelled
// card on the landing page.
func buildShareURL(origin, cid, titleOverride string) string {
	u := fmt.Sprintf("%s/?cid=%s", origin, cid)
	if t := strings.TrimSpace(titleOverride); t != "" {
		u += "&title=" + queryEscape(t)
	}
	return u
}

func queryEscape(s string) string {
	// URL.QueryEscape but without importing net/url here — the inputs
	// are short titles so a small percent-encode loop is enough.
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		case c == ' ':
			b.WriteByte('+')
		default:
			b.WriteByte('%')
			b.WriteByte(hex[c>>4])
			b.WriteByte(hex[c&0x0F])
		}
	}
	return b.String()
}

// tokenColorHex resolves a token URL or bare hex to a #rrggbb string.
// Mirrors the dictionary in internal/svg so the card and the embedded
// net glyph agree on color.
func tokenColorHex(tok string) string {
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return ""
	}
	if strings.HasPrefix(tok, "#") && (len(tok) == 7 || len(tok) == 4) {
		return tok
	}
	parts := strings.Split(tok, "/")
	name := strings.ToLower(parts[len(parts)-1])
	dict := map[string]string{
		"black": "#000000", "red": "#dc3545", "blue": "#007bff",
		"green": "#28a745", "yellow": "#ffc107", "orange": "#fd7e14",
		"purple": "#6f42c1", "pink": "#e83e8c", "brown": "#8b4513",
		"cyan": "#17a2b8", "gray": "#6c757d", "grey": "#6c757d",
		"white": "#ffffff",
	}
	if h, ok := dict[name]; ok {
		return h
	}
	// Bare hex without leading # (e.g. "ff0000")
	if len(name) == 6 && allHex(name) {
		return "#" + name
	}
	return ""
}

func allHex(s string) bool {
	for _, c := range s {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

// netBounds returns the place+transition position bounding box, with
// fallback to a unit box when the net is empty.
func netBounds(p cardPayload) (minX, minY, maxX, maxY float64) {
	first := true
	upd := func(x, y float64) {
		if first {
			minX, maxX, minY, maxY = x, x, y, y
			first = false
			return
		}
		if x < minX {
			minX = x
		}
		if x > maxX {
			maxX = x
		}
		if y < minY {
			minY = y
		}
		if y > maxY {
			maxY = y
		}
	}
	for _, pl := range p.Places {
		upd(pl.X, pl.Y)
	}
	for _, t := range p.Transitions {
		upd(t.X, t.Y)
	}
	if first {
		return 0, 0, 100, 100
	}
	return
}

// --- SVG card -----------------------------------------------------

// renderShareCardSVG builds the 1200×630 framed SVG card. The actual
// network graphic is generated via internal/svg and embedded as a
// nested <svg> with its own viewBox, so it scales cleanly into the
// reserved area.
func renderShareCardSVG(s cardSummary, netSVG string) []byte {
	var buf bytes.Buffer
	const W, H = 1200, 630
	fmt.Fprintf(&buf, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d">`, W, H, W, H)
	buf.WriteString(`<defs><style>`)
	buf.WriteString(`.bg{fill:#1C1C1D}`)
	buf.WriteString(`.panel{fill:#ffffff}`)
	buf.WriteString(`.title{font:700 44px system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;fill:#ffffff}`)
	buf.WriteString(`.sub{font:400 22px system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;fill:#999999}`)
	buf.WriteString(`.brand{font:700 24px system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;fill:#EBFF00;letter-spacing:2px}`)
	buf.WriteString(`.url{font:400 18px ui-monospace,SFMono-Regular,Menlo,monospace;fill:#999999}`)
	buf.WriteString(`.tag{font:600 16px system-ui,sans-serif;fill:#cccccc;letter-spacing:1.5px}`)
	buf.WriteString(`</style></defs>`)
	// Background
	fmt.Fprintf(&buf, `<rect class="bg" width="%d" height="%d"/>`, W, H)
	// Accent bar (top)
	fmt.Fprintf(&buf, `<rect x="0" y="0" width="%d" height="6" fill="#EBFF00"/>`, W)
	// Brand mark
	buf.WriteString(`<text class="brand" x="48" y="70">PFLOW.XYZ</text>`)
	// Title block (top-right)
	titleSafe := svgEscape(s.Title)
	subSafe := svgEscape(s.Subtitle)
	fmt.Fprintf(&buf, `<text class="title" x="%d" y="120" text-anchor="end">%s</text>`, W-48, titleSafe)
	fmt.Fprintf(&buf, `<text class="sub" x="%d" y="158" text-anchor="end">%s</text>`, W-48, subSafe)
	// Token swatches under subtitle (right-aligned)
	swatchX := float64(W - 48)
	for i := len(s.TokenColors) - 1; i >= 0; i-- {
		swatchX -= 28
		fmt.Fprintf(&buf, `<circle cx="%.0f" cy="180" r="10" fill="%s" stroke="#444" stroke-width="1"/>`, swatchX, s.TokenColors[i])
	}
	// Net panel (white card) — left/center, with the QR + URL as a
	// dedicated column on the right so neither overlaps the diagram.
	const panelX, panelY, panelW, panelH = 48, 220, 760, 340
	fmt.Fprintf(&buf, `<rect x="%d" y="%d" width="%d" height="%d" rx="8" class="panel"/>`, panelX, panelY, panelW, panelH)
	// Embed the net SVG by stripping its <svg ...> wrapper and rewrapping
	// in a positioned <svg>. The inner content is otherwise opaque to us.
	inner, vb := stripSVGWrapper(netSVG)
	if inner != "" {
		fmt.Fprintf(&buf, `<svg x="%d" y="%d" width="%d" height="%d" viewBox="%s" preserveAspectRatio="xMidYMid meet">`,
			panelX+16, panelY+16, panelW-32, panelH-32, vb)
		buf.WriteString(inner)
		buf.WriteString(`</svg>`)
	}
	// QR column (right of panel).
	const qrSize = 180
	qrX := W - qrSize - 48
	qrY := panelY + (panelH-qrSize)/2 - 18
	qrSVG := qrCodeSVG(s.ShareURL, qrSize)
	if qrSVG != "" {
		fmt.Fprintf(&buf, `<g transform="translate(%d %d)">%s</g>`, qrX, qrY, qrSVG)
	}
	// Share URL centered under QR.
	fmt.Fprintf(&buf, `<text class="url" x="%d" y="%d" text-anchor="middle">%s</text>`,
		qrX+qrSize/2, qrY+qrSize+28, svgEscape(displayURL(s.ShareURL)))
	// "PETRI NET" tag bottom-left
	buf.WriteString(`<text class="tag" x="48" y="608">PETRI NET · DRAW · GENERATE · PROVE</text>`)
	buf.WriteString(`</svg>`)
	return buf.Bytes()
}

// stripSVGWrapper extracts the inner content and viewBox of an SVG
// document so it can be re-embedded inside an outer <svg>. Returns
// ("", "") on failure.
func stripSVGWrapper(s string) (inner, viewBox string) {
	open := strings.Index(s, "<svg")
	if open < 0 {
		return "", ""
	}
	gt := strings.Index(s[open:], ">")
	if gt < 0 {
		return "", ""
	}
	header := s[open : open+gt+1]
	close := strings.LastIndex(s, "</svg>")
	if close < open+gt+1 {
		return "", ""
	}
	inner = s[open+gt+1 : close]
	if m := regexp.MustCompile(`viewBox="([^"]+)"`).FindStringSubmatch(header); len(m) == 2 {
		viewBox = m[1]
	} else {
		viewBox = "0 0 100 100"
	}
	return inner, viewBox
}

func qrCodeSVG(text string, size int) string {
	if text == "" {
		return ""
	}
	q, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return ""
	}
	q.DisableBorder = true
	bits := q.Bitmap()
	n := len(bits)
	if n == 0 {
		return ""
	}
	cell := float64(size) / float64(n)
	var buf bytes.Buffer
	fmt.Fprintf(&buf, `<rect width="%d" height="%d" fill="#ffffff"/>`, size, size)
	for y, row := range bits {
		for x, on := range row {
			if !on {
				continue
			}
			fmt.Fprintf(&buf, `<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" fill="#000000"/>`,
				float64(x)*cell, float64(y)*cell, cell+0.5, cell+0.5)
		}
	}
	return buf.String()
}

func svgEscape(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;")
	return r.Replace(s)
}

// displayURL builds the short label printed under the QR. CIDs are
// 49 chars on their own and don't fit at any reasonable font size,
// so we render "host · z4EB…uBL" — first/last fragments of the CID
// with an ellipsis in the middle. The QR carries the full URL so
// the label is purely human-orientation.
func displayURL(u string) string {
	u = strings.TrimPrefix(u, "https://")
	u = strings.TrimPrefix(u, "http://")
	host, query, _ := strings.Cut(u, "/?cid=")
	if query == "" {
		return u
	}
	cid, _, _ := strings.Cut(query, "&")
	if len(cid) > 14 {
		cid = cid[:6] + "…" + cid[len(cid)-5:]
	}
	return host + " · " + cid
}

// --- PNG card -----------------------------------------------------

var (
	regularFont *opentype.Font
	boldFont    *opentype.Font
	fontsOnce   sync.Once
	fontsErr    error
)

func loadFonts() {
	regularFont, fontsErr = opentype.Parse(goregular.TTF)
	if fontsErr != nil {
		return
	}
	boldFont, fontsErr = opentype.Parse(gobold.TTF)
}

func face(bold bool, size float64) (font.Face, error) {
	fontsOnce.Do(loadFonts)
	if fontsErr != nil {
		return nil, fontsErr
	}
	tt := regularFont
	if bold {
		tt = boldFont
	}
	return opentype.NewFace(tt, &opentype.FaceOptions{
		Size: size, DPI: 72, Hinting: font.HintingFull,
	})
}

// renderShareCardPNG draws the rasterised twin. The layout mirrors the
// SVG card so the two reads of the same payload look like siblings.
func renderShareCardPNG(s cardSummary, p cardPayload) ([]byte, error) {
	const W, H = 1200, 630
	dc := gg.NewContext(W, H)

	// Background
	dc.SetHexColor("#1C1C1D")
	dc.Clear()
	// Accent strip
	dc.SetHexColor("#EBFF00")
	dc.DrawRectangle(0, 0, W, 6)
	dc.Fill()

	// Brand mark
	if f, err := face(true, 28); err == nil {
		dc.SetFontFace(f)
		dc.SetHexColor("#EBFF00")
		dc.DrawString("PFLOW.XYZ", 48, 70)
	}

	// Title block (top-right)
	if f, err := face(true, 48); err == nil {
		dc.SetFontFace(f)
		dc.SetHexColor("#FFFFFF")
		dc.DrawStringAnchored(s.Title, W-48, 110, 1, 0)
	}
	if f, err := face(false, 24); err == nil {
		dc.SetFontFace(f)
		dc.SetHexColor("#999999")
		dc.DrawStringAnchored(s.Subtitle, W-48, 154, 1, 0)
	}
	// Token swatches
	x := float64(W - 48)
	for i := len(s.TokenColors) - 1; i >= 0; i-- {
		x -= 28
		dc.SetHexColor(s.TokenColors[i])
		dc.DrawCircle(x, 182, 10)
		dc.Fill()
		dc.SetHexColor("#444444")
		dc.DrawCircle(x, 182, 10)
		dc.SetLineWidth(1)
		dc.Stroke()
	}

	// Net panel — left/center, narrower so the QR column on the right
	// has its own dedicated space (was: panel ran the full width and
	// the QR overlapped the diagram).
	const panelX, panelY, panelW, panelH = 48.0, 220.0, 760.0, 340.0
	dc.SetHexColor("#FFFFFF")
	dc.DrawRoundedRectangle(panelX, panelY, panelW, panelH, 8)
	dc.Fill()

	// Draw the net into the panel
	drawNetGlyph(dc, p, panelX+24, panelY+24, panelW-48, panelH-48)

	// Bottom-left tag
	if f, err := face(true, 18); err == nil {
		dc.SetFontFace(f)
		dc.SetHexColor("#cccccc")
		dc.DrawString("PETRI NET · DRAW · GENERATE · PROVE", 48, 608)
	}

	// QR column (right of panel).
	const qrSize = 180
	qrX := float64(W - qrSize - 48)
	qrY := panelY + (panelH-qrSize)/2 - 18
	if img, err := qrImage(s.ShareURL, qrSize); err == nil && img != nil {
		dc.DrawImage(img, int(qrX), int(qrY))
	}

	// Share URL centered under QR
	if f, err := face(false, 18); err == nil {
		dc.SetFontFace(f)
		dc.SetHexColor("#999999")
		dc.DrawStringAnchored(displayURL(s.ShareURL), qrX+qrSize/2, qrY+qrSize+22, 0.5, 0.5)
	}

	var out bytes.Buffer
	if err := png.Encode(&out, dc.Image()); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// drawNetGlyph paints a simplified rendering of the net into the
// rectangle (x,y,w,h). Places are circles, transitions are squares,
// arcs are straight lines (curves omitted — this is a glyph, not a
// faithful editor view).
func drawNetGlyph(dc *gg.Context, p cardPayload, x, y, w, h float64) {
	if len(p.Places) == 0 && len(p.Transitions) == 0 {
		return
	}
	minX, minY, maxX, maxY := netBounds(p)
	bw := maxX - minX
	bh := maxY - minY
	if bw < 1 {
		bw = 1
	}
	if bh < 1 {
		bh = 1
	}
	// Pad inside the panel for node radii.
	pad := 24.0
	avail := func(d, span float64) float64 {
		return (d - 2*pad) / span
	}
	sx := avail(w, bw)
	sy := avail(h, bh)
	scale := math.Min(sx, sy)
	if scale <= 0 || math.IsInf(scale, 0) {
		scale = 1
	}
	// Center.
	cx := x + w/2
	cy := y + h/2
	mx := (minX + maxX) / 2
	my := (minY + maxY) / 2
	tx := func(px float64) float64 { return cx + (px-mx)*scale }
	ty := func(py float64) float64 { return cy + (py-my)*scale }

	// Arcs first (under nodes).
	dc.SetHexColor("#888888")
	dc.SetLineWidth(1.5)
	for _, a := range p.Arcs {
		var sxn, syn, exn, eyn float64
		var ok1, ok2 bool
		if pl, ok := p.Places[a.Source]; ok {
			sxn, syn, ok1 = tx(pl.X), ty(pl.Y), true
		} else if t, ok := p.Transitions[a.Source]; ok {
			sxn, syn, ok1 = tx(t.X), ty(t.Y), true
		}
		if pl, ok := p.Places[a.Target]; ok {
			exn, eyn, ok2 = tx(pl.X), ty(pl.Y), true
		} else if t, ok := p.Transitions[a.Target]; ok {
			exn, eyn, ok2 = tx(t.X), ty(t.Y), true
		}
		if !ok1 || !ok2 {
			continue
		}
		dc.DrawLine(sxn, syn, exn, eyn)
		dc.Stroke()
	}

	// Places.
	const placeR = 10.0
	dc.SetLineWidth(2)
	for _, pl := range p.Places {
		px, py := tx(pl.X), ty(pl.Y)
		dc.SetHexColor("#FFFFFF")
		dc.DrawCircle(px, py, placeR)
		dc.Fill()
		dc.SetHexColor("#333333")
		dc.DrawCircle(px, py, placeR)
		dc.Stroke()
		// Token dot if initial>0.
		init := 0
		for _, n := range pl.Initial {
			init += n
		}
		if init > 0 {
			dc.SetHexColor("#333333")
			dc.DrawCircle(px, py, 3)
			dc.Fill()
		}
	}
	// Transitions.
	const tw = 16.0
	dc.SetLineWidth(1.5)
	for _, t := range p.Transitions {
		px, py := tx(t.X), ty(t.Y)
		dc.SetHexColor("#FFFFFF")
		dc.DrawRectangle(px-tw/2, py-tw/2, tw, tw)
		dc.Fill()
		dc.SetHexColor("#000000")
		dc.DrawRectangle(px-tw/2, py-tw/2, tw, tw)
		dc.Stroke()
	}
}

// qrImage renders the share URL as a square QR PNG image.
func qrImage(text string, size int) (image.Image, error) {
	if text == "" {
		return nil, nil
	}
	q, err := qrcode.New(text, qrcode.Medium)
	if err != nil {
		return nil, err
	}
	q.DisableBorder = true
	q.ForegroundColor = color.Black
	q.BackgroundColor = color.White
	return q.Image(size), nil
}

// --- HTTP handlers ------------------------------------------------

// shareCardHandler returns an http.Handler that serves /share-card/{cid}.svg
// and /share-card/{cid}.png. The CID is looked up via the storage
// interface; missing CIDs are 404. Cached for 1 hour — cards are
// content-addressed so the bytes can't change for a given CID.
func shareCardHandler(storage Storage, originFunc func(*http.Request) string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/share-card/")
		isPNG := strings.HasSuffix(name, ".png")
		isSVG := strings.HasSuffix(name, ".svg")
		if !isPNG && !isSVG {
			http.Error(w, "expected .svg or .png", http.StatusBadRequest)
			return
		}
		cid := strings.TrimSuffix(strings.TrimSuffix(name, ".png"), ".svg")
		if !cidPattern.MatchString(cid) {
			http.Error(w, "invalid cid", http.StatusBadRequest)
			return
		}
		raw, err := storage.GetObject(cid)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) || os.IsNotExist(err) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, "lookup failed", http.StatusInternalServerError)
			return
		}
		p, err := parseCardPayload(raw)
		if err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		summary := summarizeCard(p, cid, originFunc(r), r.URL.Query().Get("title"))
		w.Header().Set("Cache-Control", "public, max-age=3600")
		if isSVG {
			netSVG, _ := svg.GenerateSVG(raw)
			out := renderShareCardSVG(summary, netSVG)
			w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
			w.Write(out)
			return
		}
		out, err := renderShareCardPNG(summary, p)
		if err != nil {
			http.Error(w, "render failed", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(out)))
		_, _ = io.Copy(w, bytes.NewReader(out))
	})
}
