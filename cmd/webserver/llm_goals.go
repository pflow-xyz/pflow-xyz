package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"
)

// goalCatalog is public/goals.json as the server reads it: the fields the
// briefs need, not the answer text (that stays in the browser's picker).
type goalCatalog struct {
	Goals []goalEntry `json:"goals"`
}

type goalEntry struct {
	ID        string      `json:"id"`
	Question  string      `json:"question"`
	Available *bool       `json:"available"`
	Inputs    []goalInput `json:"inputs"`
	Plan      []struct {
		Command string         `json:"command"`
		Args    map[string]any `json:"args"`
		When    *struct {
			Ref    string `json:"ref"`
			Equals any    `json:"equals"`
		} `json:"when"`
	} `json:"plan"`
	Caveat string `json:"caveat"`
}

type goalInput struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	Optional bool   `json:"optional"`
	Default  any    `json:"default"`
	Example  string `json:"example"`
}

func (g goalEntry) available() bool { return g.Available == nil || *g.Available }

func readGoalCatalog(public fs.FS) (*goalCatalog, error) {
	if public == nil {
		return nil, fmt.Errorf("no public filesystem")
	}
	raw, err := fs.ReadFile(public, "goals.json")
	if err != nil {
		return nil, err
	}
	var cat goalCatalog
	if err := json.Unmarshal(raw, &cat); err != nil {
		return nil, fmt.Errorf("goals.json: %w", err)
	}
	return &cat, nil
}

// goalCatalogText turns public/goals.json (the goal advisor's catalog, ROADMAP
// phase 5) into the analyse mode's routing brief: the closed set of goals the
// assistant maps the person's words to, each with its plan and the caveat
// its answer must carry. The same file drives the no-LLM picker
// (public/petri-goals-ui.js), so the two cannot disagree.
func goalCatalogText(public fs.FS) (string, int, error) {
	cat, err := readGoalCatalog(public)
	if err != nil {
		return "", 0, err
	}
	var b strings.Builder
	b.WriteString("Goal catalog. Map what the person wants to ONE of these goals (or say none fits). ")
	b.WriteString("Say in a sentence which goal you are answering and run its plan; these commands only read the net, so do not ask permission first (ask only before an edit that replaces or alters the net). ")
	b.WriteString("Run a step marked [only if ...] only when the earlier result says so: analysis_diagnose ranks knobs on the ODE and is wrong for a small or constrained net, where sim_recommend says ssa and analysis_diagnose_ssa is the one to run. ")
	b.WriteString("If the person's question names an outcome (walkouts, wait, throughput), pass the matching place as the observable. ")
	b.WriteString("Run the plan's commands (tool name = command with its first '.' as '_'), then answer in plain language with the evidence, and always give the goal's caveat.\n")
	for _, g := range cat.Goals {
		if !g.available() {
			fmt.Fprintf(&b, "- %s: %q — NOT available in the browser: %s\n", g.ID, g.Question, g.Caveat)
			continue
		}
		steps := make([]string, 0, len(g.Plan))
		for _, s := range g.Plan {
			args, _ := json.Marshal(s.Args)
			step := s.Command + " " + string(args)
			if s.When != nil { // run the step only when the earlier result says so
				step += fmt.Sprintf(" [only if %s = %v]", s.When.Ref, s.When.Equals)
			}
			steps = append(steps, step)
		}
		fmt.Fprintf(&b, "- %s: %q plan: %s", g.ID, g.Question, strings.Join(steps, " → "))
		if len(g.Inputs) > 0 {
			in := make([]string, 0, len(g.Inputs))
			for _, i := range g.Inputs {
				in = append(in, "$input."+i.Name+" = "+i.Label)
			}
			fmt.Fprintf(&b, " (ask for: %s)", strings.Join(in, "; "))
		}
		fmt.Fprintf(&b, ". Caveat: %s\n", g.Caveat)
	}
	b.WriteString("($stepN.field means a field of step N's result; use the actual value.)")
	return b.String(), len(cat.Goals), nil
}

// goalCatalogBrief is the goals toolset's routing brief (docs/design/
// agent-first-analysis.md 4.2): the same goals.json, but only what the model
// chooses with: each goal's id, the question it answers and the inputs it
// takes. No plan steps (the interface runs the plan, so the model neither
// sees nor composes it) and no caveat (the interface shows the goal's own).
// Returns the text and the available goals' ids, in catalog order.
func goalCatalogBrief(public fs.FS) (string, []string, error) {
	cat, err := readGoalCatalog(public)
	if err != nil {
		return "", nil, err
	}
	var b strings.Builder
	var ids []string
	b.WriteString("Goals for run_goal (goal_id: the question it answers; the inputs it takes):\n")
	for _, g := range cat.Goals {
		if !g.available() {
			fmt.Fprintf(&b, "- %s: %q NOT available in the browser yet: say so, do not call run_goal for it.\n", g.ID, g.Question)
			continue
		}
		ids = append(ids, g.ID)
		fmt.Fprintf(&b, "- %s: %q", g.ID, g.Question)
		if len(g.Inputs) > 0 {
			in := make([]string, 0, len(g.Inputs))
			for _, i := range g.Inputs {
				in = append(in, briefInput(i))
			}
			fmt.Fprintf(&b, " inputs: %s", strings.Join(in, "; "))
		}
		b.WriteString("\n")
	}
	return strings.TrimRight(b.String(), "\n"), ids, nil
}

// briefInput is "name (kind[, optional | default d]) = what it is [example: ...]".
func briefInput(i goalInput) string {
	var notes []string
	notes = append(notes, i.Kind)
	switch {
	case i.Default != nil:
		notes = append(notes, fmt.Sprintf("default %v", i.Default))
	case i.Optional:
		notes = append(notes, "optional")
	}
	s := fmt.Sprintf("%s (%s) = %s", i.Name, strings.Join(notes, ", "), briefLabel(i.Label))
	if i.Kind == "json" && i.Example != "" {
		s += " [example: " + i.Example + "]"
	}
	return s
}

// briefLabel cuts a goals.json input label at its parenthetical (the notes
// about blanks and budgets are for the picker's form, not for the model).
func briefLabel(l string) string {
	if i := strings.Index(l, " ("); i > 0 {
		l = l[:i]
	}
	return l
}
