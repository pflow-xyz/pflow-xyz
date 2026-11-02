package main

// The goal toolset for /api/llm/turn (docs/design/agent-first-analysis.md 4.2
// to 4.4 and section 10): a request with "toolset": "goals" declares the
// handful of goal-level tools of public/llm-goal-tools.json (run_goal,
// ask_user, command_schema, run_command, open_view and a dozen edit/read
// tools) instead of the whole command list of llm-tools.json, and gets a
// brief goal catalog, the rules for using the tools and a compact index of
// the commands run_command reaches as its first user message. The server
// stays stateless and runs no tool: the browser executes run_goal and the rest
// (they are registry commands and plans there) and sends the results back.
//
// The default toolset, "all", is unchanged.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"strings"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

const (
	toolsetAll   = "all"
	toolsetGoals = "goals"

	// goalRulesVersion names goalRules; it travels in the usage log's prompt label.
	goalRulesVersion = "goal-rules-v1"
)

// goalRules is the guidance for the goals toolset. Like the mode and the net,
// it is user content, never the system prompt: a label in a shared net is data,
// not an instruction, and this text must not be mistaken for one that a net
// could override.
const goalRules = `Tools. You have goal-level tools, not the editor's whole command list.
- run_goal answers a question with one of the goals listed below. Choose the goal whose question the person is asking. Pass only the inputs that goal names, with place and transition ids exactly as the net lists them. Never choose the engine, horizon, seed or number of runs: the goal's plan takes them from sim_recommend. Pass engine_override only if the person named an engine ("use the ODE").
- ask_user puts one question to the person as a card of 2 to 4 options drawn from the net. Ask at most once per turn, and only when a required input has no value you can ground in the net (two places both match "the queue"), no safe default exists, and a wrong guess would give a plausible but misleading answer. Otherwise go ahead and state the assumption in your reply ("I took the outcome to be the peak of I").
- If no goal fits, find the command in the index below, read its schema with command_schema, run it with run_command, and say "no standard goal matched; I composed this".
- After run_goal, answer in one or two sentences from the evidence it returned. Quote numbers only from results, never from memory. The interface adds the goal's caveat, so do not repeat it.
- open_view opens one of the editor's classic views (analysis, simulate, structure, results, app, components, check) when the person wants to explore it themselves.
- The edit tools (net_add_place, net_add_arc, sim_set_rate and the rest) change a sandbox preview until the person applies it. A name with an underscore elsewhere in these instructions (compose_fuse, sim_ode) is a command id with a dot (compose.fuse, sim.ode): if it is not one of your tools, run it with run_command.`

// goalToolset is the second tool set beside svc.tools/toolDecls/toolsVersion.
type goalToolset struct {
	Version  string
	names    map[string]bool
	decls    []llm.FunctionDecl
	goalIDs  map[string]bool                       // run_goal's goal_id enum: what a stats key may be
	enums    map[string]map[string]map[string]bool // tool -> parameter -> allowed values
	required map[string][]string
	lead     string // the guidance: rules, brief catalog and command index
}

// goalPseudoTools are the tools the interface answers itself; a manifest
// without them is not a goal toolset.
var goalPseudoTools = []string{"run_goal", "ask_user", "command_schema", "run_command", "open_view"}

// loadGoalToolset reads public/llm-goal-tools.json (scripts/gen-llm-tools.mjs)
// and builds the lead text from it and goals.json. A missing file is the
// error the caller logs: the server then reports the toolset as unavailable.
func loadGoalToolset(public fs.FS) (*goalToolset, error) {
	if public == nil {
		return nil, errors.New("no public filesystem")
	}
	raw, err := fs.ReadFile(public, "llm-goal-tools.json")
	if err != nil {
		return nil, err
	}
	var m struct {
		Version string `json:"version"`
		Tools   []struct {
			Name        string         `json:"name"`
			Ask         bool           `json:"ask"`
			Description string         `json:"description"`
			Parameters  map[string]any `json:"parameters,omitempty"`
		} `json:"tools"`
		CommandIndex []struct {
			ID   string `json:"id"`
			Help string `json:"help"`
		} `json:"command_index"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("llm-goal-tools.json: %w", err)
	}
	ts := &goalToolset{
		Version:  m.Version,
		names:    map[string]bool{},
		goalIDs:  map[string]bool{},
		enums:    map[string]map[string]map[string]bool{},
		required: map[string][]string{},
	}
	for _, t := range m.Tools {
		if ts.names[t.Name] {
			return nil, fmt.Errorf("llm-goal-tools.json: tool %s twice", t.Name)
		}
		ts.names[t.Name] = true
		ts.decls = append(ts.decls, llm.FunctionDecl{Name: t.Name, Description: t.Description, Parameters: t.Parameters})
		props, _ := t.Parameters["properties"].(map[string]any)
		for p, v := range props {
			prop, _ := v.(map[string]any)
			vals, _ := prop["enum"].([]any)
			if len(vals) == 0 {
				continue
			}
			if ts.enums[t.Name] == nil {
				ts.enums[t.Name] = map[string]map[string]bool{}
			}
			ts.enums[t.Name][p] = map[string]bool{}
			for _, e := range vals {
				if s, ok := e.(string); ok {
					ts.enums[t.Name][p][s] = true
				}
			}
		}
		for _, r := range anyStrings(t.Parameters["required"]) {
			ts.required[t.Name] = append(ts.required[t.Name], r)
		}
	}
	for _, n := range goalPseudoTools {
		if !ts.names[n] {
			return nil, fmt.Errorf("llm-goal-tools.json: no %s tool", n)
		}
	}
	ts.goalIDs = ts.enums["run_goal"]["goal_id"]
	if len(ts.goalIDs) == 0 {
		return nil, errors.New("llm-goal-tools.json: run_goal has no goal_id enum")
	}

	brief, ids, err := goalCatalogBrief(public)
	if err != nil {
		return nil, fmt.Errorf("goal catalog: %w", err)
	}
	// the two files are generated apart: a goal the tool offers must be in the brief
	inBrief := map[string]bool{}
	for _, id := range ids {
		inBrief[id] = true
	}
	for id := range ts.goalIDs {
		if !inBrief[id] {
			return nil, fmt.Errorf("llm-goal-tools.json offers goal %q, which goals.json does not have (run scripts/gen-llm-tools.mjs)", id)
		}
	}

	var idx strings.Builder
	idx.WriteString("Other commands (give the id to command_schema, then run_command; an id with no arguments needs no schema):\n")
	for _, e := range m.CommandIndex {
		fmt.Fprintf(&idx, "%s: %s\n", e.ID, e.Help)
	}
	ts.lead = goalRules + "\n\n" + brief + "\n\n" + strings.TrimRight(idx.String(), "\n")
	return ts, nil
}

func anyStrings(v any) []string {
	a, _ := v.([]any)
	var out []string
	for _, x := range a {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// problem is why a call of this toolset cannot be accepted ("" when it can):
// a missing required argument, a value outside a declared enum (a goal id the
// catalog does not have, an engine that is not ode or sde), or an ask_user
// card that is not 2 to 4 options. The model is told (a refused call comes
// back as the tool's error) and may call again; nothing reaches the browser.
func (ts *goalToolset) problem(name string, args map[string]any) string {
	for _, r := range ts.required[name] {
		if v, ok := args[r]; !ok || v == nil || v == "" {
			return "missing " + r
		}
	}
	for _, p := range sortedKeys(ts.enums[name]) {
		v, present := args[p]
		if !present {
			continue
		}
		if s, ok := v.(string); !ok || !ts.enums[name][p][s] {
			return fmt.Sprintf("%s must be one of %s", p, strings.Join(sortedKeys(ts.enums[name][p]), ", "))
		}
	}
	if name == "ask_user" {
		opts, _ := args["options"].([]any)
		if len(opts) < 2 || len(opts) > 4 {
			return "options must be 2 to 4 choices"
		}
		for _, o := range opts {
			if s, ok := o.(string); !ok || strings.TrimSpace(s) == "" {
				return "options must be non-empty strings"
			}
		}
	}
	return ""
}

// goalOf is the goal a goals-toolset call is charged to in data/llm/goal-stats.json:
// the first run_goal this reply accepted, else the first one the model already
// made for the question being answered (the call that reads a goal's result
// back to the person belongs to that goal: a goal costs both calls), else none.
// The exchange starts at the person's last message of their own words (text
// and no tool results).
func (ts *goalToolset) goalOf(accepted []turnCall, history []llm.Message) string {
	for _, c := range accepted {
		if c.Name == "run_goal" {
			if id, _ := c.Args["goal_id"].(string); ts.goalIDs[id] {
				return id
			}
		}
	}
	start := 0
	for i := len(history) - 1; i >= 0; i-- {
		if isPersonsOwn(history[i]) {
			start = i
			break
		}
	}
	for _, m := range history[start:] {
		if m.Role != "model" {
			continue
		}
		for _, p := range m.Parts {
			if p.FunctionCall != nil && p.FunctionCall.Name == "run_goal" {
				if id, _ := p.FunctionCall.Args["goal_id"].(string); ts.goalIDs[id] {
					return id
				}
			}
		}
	}
	return llm.NoGoal
}

// isPersonsOwn: a user message with text and no tool results.
func isPersonsOwn(m llm.Message) bool {
	if m.Role != "user" {
		return false
	}
	text := false
	for _, p := range m.Parts {
		if p.FunctionResponse != nil {
			return false
		}
		if p.Text != "" {
			text = true
		}
	}
	return text
}
