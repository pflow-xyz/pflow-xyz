package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"strings"
)

// goalCatalogText turns public/goals.json (the goal advisor's catalog, ROADMAP
// phase 5) into the analyse mode's routing brief: the closed set of goals the
// assistant maps the person's words to, each with its plan and the caveat
// its answer must carry. The same file drives the no-LLM picker
// (public/petri-goals-ui.js), so the two cannot disagree.
func goalCatalogText(public fs.FS) (string, int, error) {
	if public == nil {
		return "", 0, fmt.Errorf("no public filesystem")
	}
	raw, err := fs.ReadFile(public, "goals.json")
	if err != nil {
		return "", 0, err
	}
	var cat struct {
		Goals []struct {
			ID        string `json:"id"`
			Question  string `json:"question"`
			Available *bool  `json:"available"`
			Inputs    []struct {
				Name  string `json:"name"`
				Label string `json:"label"`
			} `json:"inputs"`
			Plan []struct {
				Command string         `json:"command"`
				Args    map[string]any `json:"args"`
				When    *struct {
					Ref    string `json:"ref"`
					Equals any    `json:"equals"`
				} `json:"when"`
			} `json:"plan"`
			Caveat string `json:"caveat"`
		} `json:"goals"`
	}
	if err := json.Unmarshal(raw, &cat); err != nil {
		return "", 0, fmt.Errorf("goals.json: %w", err)
	}
	var b strings.Builder
	b.WriteString("Goal catalog. Map what the person wants to ONE of these goals (or say none fits). ")
	b.WriteString("Say in a sentence which goal you are answering and run its plan; these commands only read the net, so do not ask permission first (ask only before an edit that replaces or alters the net). ")
	b.WriteString("Run a step marked [only if ...] only when the earlier result says so: analysis_diagnose ranks knobs on the ODE and is wrong for a small or constrained net, where sim_recommend says ssa and analysis_diagnose_ssa is the one to run. ")
	b.WriteString("If the person's question names an outcome (walkouts, wait, throughput), pass the matching place as the observable. ")
	b.WriteString("Run the plan's commands (tool name = command with its first '.' as '_'), then answer in plain language with the evidence, and always give the goal's caveat.\n")
	for _, g := range cat.Goals {
		if g.Available != nil && !*g.Available {
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
