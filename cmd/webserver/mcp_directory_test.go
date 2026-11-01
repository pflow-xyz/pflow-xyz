package main

import (
	"encoding/json"
	"io/fs"
	"os"
	"regexp"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/pflow-xyz/pflow-xyz/internal/static"
)

// docs/connector-directory/listing.json is what goes in the directory portal.
// These tests hold it to the limits the portal states, to the segmentation
// (Matt, 2026-11-01), and to what the server does today, so the listing cannot
// claim a thing that has not shipped. docs/connector-directory/checklist.md has
// the gates and the sources.

type directoryGate struct {
	ID           string   `json:"id"`
	Status       string   `json:"status"`
	EvidenceTool string   `json:"evidence_tool"`
	ClaimMarkers []string `json:"claim_markers"`
	CopyWhenOpen string   `json:"copy_when_open"`
}

type directoryListing struct {
	ConnectionURL string `json:"connection_url"`
	Name          string `json:"name"`
	Slug          string `json:"slug"`
	OneLiner      string `json:"one_liner"`
	Description   string `json:"description"`
	Categories    []struct {
		Name string `json:"name"`
		Gate string `json:"gate"`
	} `json:"categories"`
	Gates          []directoryGate `json:"gates"`
	ExamplePrompts []struct {
		Prompt string   `json:"prompt"`
		Tools  []string `json:"tools"`
	} `json:"example_prompts"`
	DocumentationURL string `json:"documentation_url"`
	PrivacyPolicyURL string `json:"privacy_policy_url"`
	TermsURL         string `json:"terms_url"`
	SupportContact   string `json:"support_contact"`
}

func readDirectoryListing(t *testing.T) directoryListing {
	t.Helper()
	raw, err := os.ReadFile("../../docs/connector-directory/listing.json")
	if err != nil {
		t.Fatal(err)
	}
	var l directoryListing
	if err := json.Unmarshal(raw, &l); err != nil {
		t.Fatal(err)
	}
	return l
}

// publicText is what a reader of the listing sees, without the page.
func (l directoryListing) publicText() string {
	parts := []string{l.Name, l.OneLiner, l.Description}
	for _, p := range l.ExamplePrompts {
		parts = append(parts, p.Prompt)
	}
	return strings.Join(parts, "\n")
}

func readPublicPage(t *testing.T, name string) string {
	t.Helper()
	publicFS, err := static.Public()
	if err != nil {
		t.Fatalf("static.Public: %v", err)
	}
	raw, err := fs.ReadFile(publicFS, name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The limits the portal's Listing step states, and the policy's minimum of
// three working examples.
func TestDirectoryListingFitsThePortal(t *testing.T) {
	l := readDirectoryListing(t)
	for _, c := range []struct {
		field, value string
		max          int
	}{
		{"name", l.Name, 100},
		{"one_liner", l.OneLiner, 200},
		{"description", l.Description, 2000},
	} {
		if n := utf8.RuneCountInString(c.value); n == 0 || n > c.max {
			t.Errorf("%s is %d characters; the portal takes 1 to %d", c.field, n, c.max)
		}
	}
	if n := len(l.Categories); n < 1 || n > 5 {
		t.Errorf("%d categories; the portal takes 1 to 5", n)
	}
	if len(l.ExamplePrompts) < 3 {
		t.Errorf("%d example prompts; the policy asks for at least three", len(l.ExamplePrompts))
	}
	if l.Slug == "" || l.ConnectionURL != "https://pflow.xyz/mcp" {
		t.Errorf("slug %q, connection_url %q", l.Slug, l.ConnectionURL)
	}
	for _, u := range []string{l.DocumentationURL, l.PrivacyPolicyURL, l.TermsURL} {
		name, ok := strings.CutPrefix(u, "https://pflow.xyz/")
		if !ok {
			t.Errorf("%s is not on pflow.xyz", u)
			continue
		}
		readPublicPage(t, name)
	}
	if !strings.HasPrefix(l.SupportContact, "https://") {
		t.Errorf("support_contact %q", l.SupportContact)
	}
}

// The main listing is the composition offering in two categories. Process
// mining is a separate listing, so it stays out of everything this connector
// says about itself. The engine stays under the hood: the listing never names
// it, and the docs page names it only below its opening.
func TestDirectoryListingSegmentation(t *testing.T) {
	l := readDirectoryListing(t)
	got := map[string]string{}
	for _, c := range l.Categories {
		got[c.Name] = c.Gate
	}
	if len(got) != 2 || got["Designs & media"] != "canvas" || got["Reference docs"] != "library" {
		t.Errorf("categories %v, want Designs & media (canvas) and Reference docs (library)", got)
	}

	mining := regexp.MustCompile(`(?i)process[- ]mining|event logs?\b|conformance|mine\.pflow`)
	instructions := func() string {
		_, out := mcpCall(t, &Server{}, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`)
		return out["result"].(map[string]any)["instructions"].(string)
	}()
	surfaces := map[string]string{
		"the listing":         l.publicText(),
		"public/mcp.html":     readPublicPage(t, "mcp.html"),
		"server instructions": instructions,
	}
	for _, tool := range allMCPTools() {
		surfaces[tool.Name+"'s description"] = tool.Description
	}
	for where, text := range surfaces {
		if m := mining.FindString(text); m != "" {
			t.Errorf("%s says %q: process mining is the mine.pflow.xyz listing", where, m)
		}
	}

	if strings.Contains(strings.ToLower(l.publicText()), "petri") {
		t.Error("the listing names the engine; lead with what people get")
	}
	page := readPublicPage(t, "mcp.html")
	opening, _, _ := strings.Cut(page, "</p>") // the title, the meta description and the lede
	if strings.Contains(strings.ToLower(opening), "petri") {
		t.Error("public/mcp.html opens by naming the engine")
	}
	for _, name := range []string{"terms.html", "privacy.html"} {
		if strings.Contains(strings.ToLower(readPublicPage(t, name)), "petri") {
			t.Errorf("public/%s names the engine", name)
		}
	}
}

// A category is gated on something that has not shipped, and the listing and
// the docs page may claim it only once the gate is open. A gate that is building
// or open names the tool that does it, and for the canvas that tool must carry
// the MCP App's UI link. Open is a person's call, after seeing it work in Claude,
// so no test can set it; a test can only refuse what the server contradicts.
func TestDirectoryGatesMatchTheServer(t *testing.T) {
	l := readDirectoryListing(t)
	gates := map[string]directoryGate{}
	for _, g := range l.Gates {
		gates[g.ID] = g
	}
	for _, c := range l.Categories {
		if _, ok := gates[c.Gate]; !ok {
			t.Errorf("category %s names gate %q, which is not listed", c.Name, c.Gate)
		}
	}

	tools := map[string]mcpTool{}
	var uiTools []string
	for _, tool := range allMCPTools() {
		tools[tool.Name] = tool
		if hasUIResource(toolDescriptor(tool)) {
			uiTools = append(uiTools, tool.Name)
		}
	}

	if g := gates["canvas"]; g.Status == "closed" && len(uiTools) > 0 {
		t.Errorf("%v carry an MCP App link but the canvas gate says closed: it is at least building", uiTools)
	}

	page := readPublicPage(t, "mcp.html")
	section := regexp.MustCompile(`(?s)<section id="on-the-way">.*?</section>`)
	if !section.MatchString(page) {
		t.Error(`public/mcp.html has no <section id="on-the-way">`)
	}
	claims := map[string]string{
		"the listing":     strings.ToLower(l.publicText()),
		"public/mcp.html": strings.ToLower(section.ReplaceAllString(page, "")),
	}
	for id, g := range gates {
		if g.Status != "open" {
			for where, text := range claims {
				for _, marker := range g.ClaimMarkers {
					if strings.Contains(text, marker) {
						t.Errorf("%s says %q, but gate %s is %s", where, marker, id, g.Status)
					}
				}
			}
		}
		switch g.Status {
		case "closed":
			if g.EvidenceTool != "" {
				t.Errorf("gate %s is closed but names %s", id, g.EvidenceTool)
			}
		case "building", "open": // building: the tool exists, and has not been seen working where it counts
			tool, ok := tools[g.EvidenceTool]
			if !ok {
				t.Errorf("gate %s is %s but %q is not a tool", id, g.Status, g.EvidenceTool)
			}
			if id == "canvas" && (!ok || !hasUIResource(toolDescriptor(tool))) {
				t.Errorf("the canvas gate is %s but %q carries no _meta.ui.resourceUri", g.Status, g.EvidenceTool)
			}
		default:
			t.Errorf("gate %s has status %q", id, g.Status)
		}
		if g.CopyWhenOpen == "" {
			t.Errorf("gate %s has no copy_when_open", id)
		}
	}
}

func hasUIResource(descriptor map[string]any) bool {
	meta, _ := descriptor["_meta"].(map[string]any)
	ui, _ := meta["ui"].(map[string]any)
	uri, _ := ui["resourceUri"].(string)
	return strings.HasPrefix(uri, "ui://")
}

// Each example prompt is on the docs page as written and names real tools.
func TestDirectoryExamplePromptsAreReal(t *testing.T) {
	l := readDirectoryListing(t)
	page := readPublicPage(t, "mcp.html")
	tools := map[string]bool{}
	for _, tool := range allMCPTools() {
		tools[tool.Name] = true
	}
	for _, p := range l.ExamplePrompts {
		if !strings.Contains(page, `<li>"`+p.Prompt+`"</li>`) {
			t.Errorf("public/mcp.html does not ask %q", p.Prompt)
		}
		if len(p.Tools) == 0 {
			t.Errorf("%q names no tools", p.Prompt)
		}
		for _, name := range p.Tools {
			if !tools[name] {
				t.Errorf("%q names %s, which is not a tool", p.Prompt, name)
			}
		}
	}
}

// The review checklist's rules for a tool's name and annotations.
func TestDirectoryToolRules(t *testing.T) {
	for _, tool := range allMCPTools() {
		if len(tool.Name) > 64 {
			t.Errorf("%s is longer than 64 characters", tool.Name)
		}
		d := toolDescriptor(tool)
		a, _ := d["annotations"].(map[string]any)
		if d["title"] == "" || a["title"] == "" {
			t.Errorf("%s has no title", tool.Name)
		}
		if _, ok := a["readOnlyHint"]; !ok {
			t.Errorf("%s has no readOnlyHint", tool.Name)
		}
		if _, ok := a["destructiveHint"]; !ok {
			t.Errorf("%s has no destructiveHint", tool.Name)
		}
	}
}

// An inline composition gets a refusal, not an editor link that opens empty.
func TestMCPLinksRefusesAnInlineComposition(t *testing.T) {
	s := &Server{}
	_, out := mcpCall(t, s, toolCall("pflow_links", `{"net":{"@context":"https://pflow.xyz/schema","@type":"PetriNetBundle","name":"c","subnets":[{"id":"a"},{"id":"b"}],"links":[]}}`))
	r := out["result"].(map[string]any)
	if r["isError"] != true {
		t.Fatalf("got %v", r)
	}
	text := r["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, "by the cid") {
		t.Errorf("refusal does not say how to open it: %s", text)
	}
}
