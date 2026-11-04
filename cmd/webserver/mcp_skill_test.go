package main

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func skillFrontmatter(t *testing.T, md string) map[string]any {
	t.Helper()
	parts := strings.SplitN(md, "---\n", 3)
	if len(parts) != 3 || parts[0] != "" {
		t.Fatalf("no frontmatter:\n%.200s", md)
	}
	var fm map[string]any
	if err := yaml.Unmarshal([]byte(parts[1]), &fm); err != nil {
		t.Fatalf("frontmatter is not YAML: %v", err)
	}
	return fm
}

func TestSkillRendersWithValidFrontmatter(t *testing.T) {
	for _, focus := range append([]string{""}, skillFocuses...) {
		md, err := renderSkill(allMCPTools(), "generic", focus, time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC))
		if err != nil {
			t.Fatal(err)
		}
		fm := skillFrontmatter(t, md)
		if fm["name"] != "pflow" {
			t.Errorf("name %v", fm["name"])
		}
		if d, _ := fm["description"].(string); len(d) < 80 || !strings.Contains(d, "Petri") {
			t.Errorf("description %q", d)
		}
		for _, want := range []string{"2026-11-02", "call pflow_skill again", "claude mcp add pflow -- npx -y @pflow-xyz/pflow-mcp", "pflow_edit", "deadlock_free"} {
			if !strings.Contains(md, want) {
				t.Errorf("focus %q: missing %q", focus, want)
			}
		}
		if strings.Contains(md, "pstack") || strings.Contains(md, "<no value>") {
			t.Errorf("focus %q: stray text", focus)
		}
	}
}

// Every tool the skill names exists in the registry, and every tool in the
// registry is listed in the skill.
func TestSkillNamesOnlyRegisteredTools(t *testing.T) {
	tools := allMCPTools()
	reg := map[string]bool{}
	for _, tl := range tools {
		reg[tl.Name] = true
	}
	for _, focus := range append([]string{""}, skillFocuses...) {
		md, _ := renderSkill(tools, "generic", focus, time.Now())
		for _, name := range regexp.MustCompile(`pflow_[a-z_]+`).FindAllString(md, -1) {
			if !reg[name] {
				t.Errorf("focus %q: skill names %s, which is not registered", focus, name)
			}
		}
		for n := range reg {
			if !strings.Contains(md, "- "+n+":") {
				t.Errorf("focus %q: %s missing from the tool list", focus, n)
			}
		}
	}
}

func TestSkillOnlyNamesArtifactWhenRegistered(t *testing.T) {
	var without []mcpTool
	for _, tl := range allMCPTools() {
		if tl.Name != "pflow_artifact" && tl.Name != "pflow_canvas" {
			without = append(without, tl)
		}
	}
	md, _ := renderSkill(without, "generic", "artifact", time.Now())
	if strings.Contains(md, "Use pflow_artifact") || strings.Contains(md, "pflow_canvas") {
		t.Error("names a tool that is not registered")
	}
	with := append(without, mcpTool{Name: "pflow_artifact", Description: "A page."})
	md, _ = renderSkill(with, "generic", "artifact", time.Now())
	if !strings.Contains(md, "Use pflow_artifact") {
		t.Error("does not offer pflow_artifact when registered")
	}
}

func TestSkillToolOverMCP(t *testing.T) {
	_, out := mcpCall(t, &Server{}, toolCall("pflow_skill", `{"client":"claude-code","focus":"verify"}`))
	res := out["result"].(map[string]any)
	if res["isError"] == true {
		t.Fatalf("%v", res)
	}
	sc := res["structuredContent"].(map[string]any)
	if !strings.Contains(sc["install"].(string), ".claude/skills/pflow/SKILL.md") || sc["filename"] != "SKILL.md" {
		t.Errorf("%v", sc)
	}
	skillFrontmatter(t, sc["skill_md"].(string))
	_, out = mcpCall(t, &Server{}, toolCall("pflow_skill", `{"client":"vim"}`))
	toolError(t, out)
}

func TestInstructionsOfferTheSkill(t *testing.T) {
	_, out := mcpCall(t, &Server{}, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	text := out["result"].(map[string]any)["instructions"].(string)
	if !strings.Contains(text, "pflow_skill") || !strings.Contains(text, "never save it without asking") {
		t.Error("instructions do not offer pflow_skill")
	}
}
