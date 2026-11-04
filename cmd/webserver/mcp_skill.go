package main

import (
	"bytes"
	"fmt"
	"net/http"
	"runtime/debug"
	"strings"
	"text/template"
	"time"
)

// pflow_skill hands the client a ready-to-save Claude skill: the procedure
// layer (describe → build → check → explain → show → save) with the tool list
// filled in from the live registry, so it cannot drift from what the server
// exposes.
//
// Inspired by pstack (https://github.com/backnotprop/pstack), which ships its
// workflow as a skill.

var skillClients = []string{"claude-code", "claude-ai", "generic"}
var skillFocuses = []string{"artifact", "verify", "compose"}

func skillTools() []mcpTool {
	return []mcpTool{{
		Name:        "pflow_skill",
		Description: "A ready-to-save Claude skill (SKILL.md) for working with pflow.xyz: the procedure to model, check and show a process, with this server's tool list filled in live, plus install notes for the client. Optional client (claude-code, claude-ai, generic) and focus (artifact, verify, compose). Offer it when the person wants to keep pflow's workflow across sessions; never save it without asking.",
		InputSchema: obj(map[string]any{
			"client": map[string]any{"type": "string", "enum": skillClients, "description": "where it will be installed (default generic)"},
			"focus":  map[string]any{"type": "string", "enum": skillFocuses, "description": "add a section on one part of the workflow"},
		}),
		run: mcpSkill,
	}}
}

type skillTool struct{ Name, Summary string }

type skillData struct {
	Version, Date, Client, Focus string
	Tools                        []skillTool
	have                         map[string]bool
}

func (d skillData) Has(name string) bool { return d.have[name] }

// firstSentence is the tool description up to its first full stop, cut to n runes.
func firstSentence(s string, n int) string {
	if i := strings.Index(s, ". "); i >= 0 {
		s = s[:i+1]
	}
	r := []rune(strings.Join(strings.Fields(s), " "))
	if len(r) > n {
		s = strings.TrimSpace(string(r[:n-1])) + "…"
	} else {
		s = string(r)
	}
	return s
}

func skillVersion() string {
	rev := runningBuild().Revision
	if rev == "" {
		if bi, ok := debug.ReadBuildInfo(); ok {
			for _, s := range bi.Settings {
				if s.Key == "vcs.revision" {
					rev = s.Value
				}
			}
		}
	}
	if len(rev) > 7 {
		rev = rev[:7]
	}
	if rev == "" {
		rev = "dev"
	}
	return rev
}

// renderSkill builds the SKILL.md. tools is the live registry.
func renderSkill(tools []mcpTool, client, focus string, now time.Time) (string, error) {
	d := skillData{Version: skillVersion(), Date: now.UTC().Format("2006-01-02"), Client: client, Focus: focus, have: map[string]bool{}}
	for _, t := range tools {
		d.have[t.Name] = true
		d.Tools = append(d.Tools, skillTool{t.Name, firstSentence(t.Description, 170)})
	}
	var b bytes.Buffer
	if err := skillTmpl.Execute(&b, d); err != nil {
		return "", err
	}
	return b.String(), nil
}

var skillInstall = map[string]string{
	"claude-code": "Claude Code: write the skill to .claude/skills/pflow/SKILL.md in the project, or ~/.claude/skills/pflow/SKILL.md to have it everywhere. Start a new session (or /skills) to pick it up. The server itself: claude mcp add --transport http pflow https://pflow.xyz/mcp. Local alternative: claude mcp add pflow -- npx -y @pflow-xyz/pflow-mcp",
	"claude-ai":   "claude.ai: save the text as SKILL.md in a folder named pflow, zip the folder, and upload it under Settings → Capabilities → Skills. Connect https://pflow.xyz/mcp as a custom connector so the tools it names are there.",
	"generic":     "Save the text as SKILL.md in a folder named pflow, inside your client's skills directory. Claude Code: .claude/skills/pflow/SKILL.md or ~/.claude/skills/pflow/SKILL.md. claude.ai: Settings → Capabilities → Skills (upload the folder as a zip). Local alternative to the hosted server: claude mcp add pflow -- npx -y @pflow-xyz/pflow-mcp",
}

func mcpSkill(s *Server, r *http.Request, args map[string]any) (any, error) {
	client, _ := args["client"].(string)
	focus, _ := args["focus"].(string)
	if client == "" {
		client = "generic"
	}
	if !contains(skillClients, client) {
		return nil, fmt.Errorf("client must be one of %s", strings.Join(skillClients, ", "))
	}
	if focus != "" && !contains(skillFocuses, focus) {
		return nil, fmt.Errorf("focus must be one of %s", strings.Join(skillFocuses, ", "))
	}
	now := time.Now()
	md, err := renderSkill(allMCPTools(), client, focus, now)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"filename": "SKILL.md",
		"skill_md": md,
		"install":  skillInstall[client],
		"client":   client,
		"version":  skillVersion(),
		"date":     now.UTC().Format("2006-01-02"),
		"note":     "Save skill_md only if the person agrees.",
	}, nil
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

var skillTmpl = template.Must(template.New("skill").Parse(`---
name: pflow
description: "Model, check and show a process as a Petri net with pflow.xyz. Use when the user asks to model a workflow, state machine, protocol or queue, to check it for deadlocks or stuck states, to explain why a process can get stuck, or to show a process as a diagram."
---

# pflow: model it, check it, show it

Generated by pflow_skill from pflow.xyz at {{.Version}} on {{.Date}}. If the tools listed below do not match what the server offers, call pflow_skill again and replace this file.

## Procedure

1. Describe the process in the person's words: what moves (tokens), where it waits (places), what changes it (transitions). Ask only if the process is truly ambiguous.
2. Build the net with pflow_edit. Start small; add one edit list at a time.
3. Check it. Run pflow_reachability and read deadlock_free, live (L4: every transition can still fire from every state) and quasi_live. Run pflow_invariants for what is conserved. Raise max_states if a verdict comes back unknown; an unknown is not a yes.
4. Explain any witness in the reader's words. A witness is a firing sequence that ends stuck: replay it step by step as events in the person's domain ("the order is paid, the stock is gone, nobody can ship"), never as place and transition ids.
5. Fix and re-check until the verdicts are the ones the person wants.
6. Show it. {{if .Has "pflow_artifact"}}Use pflow_artifact to give the person the net as a page they can open. {{end}}Use pflow_links for the editor link (the net travels in the URL).
7. Save only if asked: pflow_save needs the person signed in and stores the net publicly; pflow_cid gives its content ID to cite.
{{if eq .Focus "verify"}}
## Focus: verify

Order of checks: pflow_validate, then pflow_reachability, then pflow_verify for named properties, then pflow_invariants. State each verdict as true, false or unknown, and say what a witness shows. Bounded searches that stop early prove nothing positive.
{{end}}{{if eq .Focus "compose"}}
## Focus: compose

For parts that must work together, build a composition rather than one big net: pflow_bundle_example for the parts, pflow_bundle_candidates and pflow_bundle_add_link to join them, pflow_bundle_validate, then pflow_bundle_flatten and pflow_bundle_run to play a scenario.{{if .Has "pflow_canvas"}} pflow_canvas lets the person join parts by hand.{{end}} A flattened net is not a pflow.xyz net: the net tools cannot read it.
{{end}}{{if eq .Focus "artifact"}}
## Focus: artifact

{{if .Has "pflow_artifact"}}Finish by calling pflow_artifact so the person gets a page, not a JSON blob.{{else}}This server has no artifact tool yet; finish with the editor link from pflow_links, and offer to describe the net in a short diagram of your own if the client can render one.{{end}}
{{end}}
## Tools on this server

{{range .Tools}}- {{.Name}}: {{.Summary}}
{{end}}
## Local alternative

To run the engines on your own machine instead of the hosted server: claude mcp add pflow -- npx -y @pflow-xyz/pflow-mcp
`))
