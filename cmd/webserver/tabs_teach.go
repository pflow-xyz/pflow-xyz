package main

// The teaching verbs of tab push: what an agent next to a linked pflow.xyz page
// uses to show and explain, on top of pflow_show. Each tool sends one event the
// page hands to the IDE shell's one entry, window.pflowShell.dispatch
// (docs/ide-shell.md, section 3.5), and waits briefly for the page to say what
// it did, so a refusal (a view above the page's level of detail) reaches the
// caller instead of only the person.
//
//	pflow_level      {type:"level", level}
//	pflow_highlight  {type:"highlight", targets, label?}
//	pflow_annotate   {type:"annotate", text, id?, target?}
//	pflow_focus      {type:"focus", target}
//	pflow_tour       {type:"tour", title?, steps} or {type:"tour_control", action}
//
// On the wire the verb's fields travel in the event's params (internal/tabhub's
// Event is unchanged, so BeatScript's shared vectors still hold); the page
// spreads them into the event it dispatches.

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"

	"github.com/pflow-xyz/pflow-xyz/internal/tabhub"
)

// shellLevels are the shell's levels of detail, least detail first (petri-shell.js LEVELS).
var shellLevels = []string{"outcome", "model", "math"}

const (
	maxTeachTargets = 50 // petri-shell.js MAX_TARGETS
	maxTourSteps    = 30 // petri-shell.js MAX_STEPS
	maxTeachLabel   = 200
	maxAnnotateID   = 40
)

// targetRe is petri-shell.js parseTarget: node:<id>, line:<n>, range:<a>-<b>, panel:<id>, view:<type>.
var targetRe = regexp.MustCompile(`^(node:.{1,128}|line:[1-9]\d{0,5}|range:[1-9]\d{0,5}-[1-9]\d{0,5}|panel:[a-z][a-z0-9-]*(:\d+)?|view:[a-z][a-z0-9-]*)$`)

func checkTarget(field string, v any) (string, error) {
	t, ok := v.(string)
	if !ok || len(t) > 200 || !targetRe.MatchString(t) {
		return "", fmt.Errorf("%s: node:<place or transition id>, line:<n>, range:<a>-<b>, panel:<id> or view:<type>", field)
	}
	if m := regexp.MustCompile(`^range:(\d+)-(\d+)$`).FindStringSubmatch(t); m != nil {
		var a, b int
		fmt.Sscan(m[1], &a)
		fmt.Sscan(m[2], &b)
		if a > b {
			return "", fmt.Errorf("%s: a range runs from the lower line to the higher", field)
		}
	}
	return t, nil
}

func optString(args map[string]any, key string, max int) (string, error) {
	v, ok := args[key]
	if !ok || v == nil {
		return "", nil
	}
	s, ok := v.(string)
	if !ok || len(s) > max {
		return "", fmt.Errorf("%s: text up to %d bytes", key, max)
	}
	return s, nil
}

// teachFields checks one verb's fields and returns them as the event's params.
// step is true inside a tour, where a step may also carry `say`.
func teachFields(verb string, args map[string]any, step bool) (map[string]any, error) {
	out := map[string]any{}
	allowed := map[string][]string{
		"level":     {"level"},
		"highlight": {"targets", "label"},
		"annotate":  {"text", "id", "target"},
		"focus":     {"target"},
		"show":      {"view", "params", "note"},
	}[verb]
	if allowed == nil {
		return nil, fmt.Errorf("a step's type is one of show, level, highlight, annotate, focus (got %q)", verb)
	}
	for k := range args {
		ok := k == "tab" && !step || k == "type" && step || k == "say" && step
		for _, a := range allowed {
			ok = ok || a == k
		}
		if !ok {
			if step && (k == "net" || k == "cid") {
				return nil, errors.New("a tour step does not carry a net: put the net on the canvas with pflow_show first, then tour it")
			}
			return nil, fmt.Errorf("%s: no field %q (it takes %v)", verb, k, allowed)
		}
	}
	switch verb {
	case "level":
		l, _ := args["level"].(string)
		found := false
		for _, x := range shellLevels {
			found = found || x == l
		}
		if !found {
			return nil, fmt.Errorf("level: one of %v", shellLevels)
		}
		out["level"] = l
	case "highlight":
		raw, ok := args["targets"].([]any)
		if !ok {
			return nil, errors.New("targets: a list of targets ([] clears)")
		}
		if len(raw) > maxTeachTargets {
			return nil, fmt.Errorf("targets: at most %d", maxTeachTargets)
		}
		ts := make([]string, 0, len(raw))
		for i, v := range raw {
			t, err := checkTarget(fmt.Sprintf("targets[%d]", i), v)
			if err != nil {
				return nil, err
			}
			ts = append(ts, t)
		}
		out["targets"] = ts
		label, err := optString(args, "label", maxTeachLabel)
		if err != nil {
			return nil, err
		}
		if label != "" {
			out["label"] = label
		}
	case "annotate":
		text, ok := args["text"].(string)
		if !ok || len(text) > maxTabNoteBytes {
			return nil, fmt.Errorf("text: up to %d bytes (\"\" removes the annotation named by id)", maxTabNoteBytes)
		}
		out["text"] = text
		id, err := optString(args, "id", maxAnnotateID)
		if err != nil {
			return nil, err
		}
		if id != "" {
			out["id"] = id
		}
		if v, ok := args["target"]; ok && v != nil {
			t, err := checkTarget("target", v)
			if err != nil {
				return nil, err
			}
			out["target"] = t
		}
	case "focus":
		t, err := checkTarget("target", args["target"])
		if err != nil {
			return nil, err
		}
		out["target"] = t
	case "show":
		view, _ := args["view"].(string)
		known := false
		for _, v := range tabViews {
			known = known || v == view
		}
		if !known || view == "categorical" {
			return nil, fmt.Errorf("a show step's view: one of %v but categorical (which needs a cid: use pflow_show)", tabViews)
		}
		out["view"] = view
		if p, ok := args["params"]; ok && p != nil {
			raw, err := tabParams(view, p)
			if err != nil {
				return nil, err
			}
			var m map[string]any
			json.Unmarshal(raw, &m)
			out["params"] = m
		}
		note, err := optString(args, "note", maxTabNoteBytes)
		if err != nil {
			return nil, err
		}
		if note != "" {
			out["note"] = note
		}
	}
	if step {
		out["type"] = verb
		say, err := optString(args, "say", maxTabNoteBytes)
		if err != nil {
			return nil, err
		}
		if say != "" {
			out["say"] = say
		}
	}
	return out, nil
}

// pageAnswer puts what the page said it did into a tool's answer. The page's
// reply is its report with `result`, the shell's dispatch answer.
func pageAnswer(out map[string]any, answer tabhub.Report) {
	if answer == nil {
		out["answered"] = false
		return
	}
	var rep map[string]any
	if json.Unmarshal(answer, &rep) != nil {
		out["answered"] = false
		return
	}
	out["answered"] = true
	res, _ := rep["result"].(map[string]any)
	if res == nil {
		return
	}
	out["result"] = res
	if res["ok"] == false {
		msg, _ := res["error"].(string)
		if needs, _ := res["needs"].(string); needs != "" {
			msg = fmt.Sprintf("the page is at the %v level and this needs %s: send pflow_level {\"level\":\"%s\"} first (the person also sees a Step down button)", res["level"], needs, needs)
		}
		if msg == "" {
			msg = "the page refused it"
		}
		out["note"] = "Refused by the page: " + msg
	}
	if shell, _ := rep["shell"].(map[string]any); shell != nil {
		out["shell"] = shell
	}
}

func teachPush(s *Server, r *http.Request, args map[string]any, typ string, params map[string]any) (any, error) {
	owner, _, err := tabCaller(s, r)
	if err != nil {
		return nil, err
	}
	tabID, _ := args["tab"].(string)
	raw, _ := json.Marshal(params)
	ev := tabhub.Event{Type: typ, RequestID: tabhub.NewID(), Params: raw}
	n, answer, err := s.tabs.hub.PushAwait(r.Context(), owner, tabID, ev, s.tabs.replyWait)
	if err != nil {
		return nil, hubMessage(err)
	}
	log.Printf("tab push: %s %d bytes tab=%q delivered=%d", typ, len(raw), tabID, n)
	out := map[string]any{"sent": n > 0, "tabs": n, "type": typ, "request_id": ev.RequestID}
	if n == 0 {
		out["note"] = "No linked page had a live stream, so nothing was sent. Check pflow_tabs; the person opens pflow.xyz with ?shell=1 and links it (Link to Claude, or ?tab=1)."
		return out, nil
	}
	pageAnswer(out, answer)
	if _, ok := out["note"]; !ok && out["answered"] == false {
		out["note"] = "Sent, but the page did not answer in time (it may not have the IDE shell on: ?shell=1). Call pflow_tab_get to see what it shows."
	}
	return out, nil
}

func teachVerb(verb string) func(*Server, *http.Request, map[string]any) (any, error) {
	return func(s *Server, r *http.Request, args map[string]any) (any, error) {
		if s.tabs == nil {
			return nil, errors.New("tab push is not turned on for this server")
		}
		params, err := teachFields(verb, args, false)
		if err != nil {
			return nil, err
		}
		return teachPush(s, r, args, verb, params)
	}
}

func mcpTour(s *Server, r *http.Request, args map[string]any) (any, error) {
	if s.tabs == nil {
		return nil, errors.New("tab push is not turned on for this server")
	}
	if a, ok := args["action"]; ok && a != nil {
		action, _ := a.(string)
		if action != "next" && action != "back" && action != "end" {
			return nil, errors.New(`action: "next", "back" or "end"`)
		}
		if _, ok := args["steps"]; ok {
			return nil, errors.New("give steps (start a tour) or action (move through the open one), not both")
		}
		return teachPush(s, r, args, "tour_control", map[string]any{"action": action})
	}
	for k := range args {
		if k != "steps" && k != "title" && k != "tab" {
			return nil, fmt.Errorf("pflow_tour: no field %q (it takes steps, title, tab; or action)", k)
		}
	}
	raw, ok := args["steps"].([]any)
	if !ok || len(raw) == 0 || len(raw) > maxTourSteps {
		return nil, fmt.Errorf("steps: 1 to %d steps, or give action to move through an open tour", maxTourSteps)
	}
	steps := make([]map[string]any, 0, len(raw))
	for i, v := range raw {
		st, ok := v.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("steps[%d]: an object", i)
		}
		typ, _ := st["type"].(string)
		if typ == "" {
			if _, ok := st["view"]; ok {
				typ = "show"
			} else {
				// A step with only `say` narrates and runs no event (petri-shell.js tourGo).
				say, err := optString(st, "say", maxTabNoteBytes)
				if err != nil || say == "" || len(st) != 1 {
					return nil, fmt.Errorf("steps[%d]: give type (show, level, highlight, annotate, focus), or only say", i)
				}
				steps = append(steps, map[string]any{"say": say})
				continue
			}
		}
		if typ == "tour" || typ == "tour_control" || typ == "stop" {
			return nil, fmt.Errorf("steps[%d]: a step is show, level, highlight, annotate or focus", i)
		}
		f, err := teachFields(typ, st, true)
		if err != nil {
			return nil, fmt.Errorf("steps[%d]: %v", i, err)
		}
		steps = append(steps, f)
	}
	params := map[string]any{"steps": steps}
	title, err := optString(args, "title", 80)
	if err != nil {
		return nil, err
	}
	if title != "" {
		params["title"] = title
	}
	return teachPush(s, r, args, "tour", params)
}

var targetArg = map[string]any{"type": "string", "description": "node:<place or transition id> (the canvas and its notation lines), line:<n> or range:<a>-<b> (lines of the notation panel), panel:<id> (an open panel), view:<type> (opens it)"}

func teachTools() []mcpTool {
	levelDesc := "outcome (plain-language answers and plots, no Petri-net terms), model (the net: canvas, notation, outline, checks; the default) or math (also invariants, reachability, categorical views)"
	stepSchema := map[string]any{
		"type":        "object",
		"description": "One step: an event like the other teaching tools take, plus say (the line shown for it). type is show (view, params, note), level (level), highlight (targets, label), annotate (text, target, id) or focus (target); a step with only say just narrates. A show step does not carry a net.",
		"properties": map[string]any{
			"type":    map[string]any{"type": "string", "enum": []string{"show", "level", "highlight", "annotate", "focus"}},
			"say":     map[string]any{"type": "string", "description": "what to tell the person at this step"},
			"view":    map[string]any{"type": "string", "enum": tabViews},
			"params":  map[string]any{"type": "object"},
			"note":    map[string]any{"type": "string"},
			"level":   map[string]any{"type": "string", "enum": shellLevels},
			"targets": map[string]any{"type": "array", "items": targetArg},
			"label":   map[string]any{"type": "string"},
			"text":    map[string]any{"type": "string"},
			"target":  targetArg,
			"id":      map[string]any{"type": "string"},
		},
	}
	return []mcpTool{
		{
			Name:        "pflow_level",
			Description: "Set the level of detail of your linked pflow.xyz page (the IDE shell, ?shell=1): " + levelDesc + ". The page shows only views at or below its level and refuses a pflow_show above it, so when teaching, set the level first. The person sees the change in the page's level control and can change it back.",
			InputSchema: obj(map[string]any{"level": map[string]any{"type": "string", "enum": shellLevels}, "tab": tabArg}, "level"),
			run:         teachVerb("level"),
		},
		{
			Name:        "pflow_highlight",
			Description: "Highlight places, transitions or lines of the notation in your linked pflow.xyz page, to point at what you are talking about. targets: node:<id> lights the node on the canvas and every notation line that mentions it; line:<n> and range:<a>-<b> light notation lines. An empty list clears the highlight.",
			InputSchema: obj(map[string]any{"targets": map[string]any{"type": "array", "items": targetArg, "maxItems": maxTeachTargets}, "label": map[string]any{"type": "string", "description": "a short caption"}, "tab": tabArg}, "targets"),
			run:         teachVerb("highlight"),
		},
		{
			Name:        "pflow_annotate",
			Description: "Put a line of narration in your linked pflow.xyz page (the strip above the editor, and the Answer panel at the outcome level), optionally pointing at a target, which is then highlighted. Give an id to replace that annotation later; text \"\" with an id removes it. The page labels it as the assistant's.",
			InputSchema: obj(map[string]any{"text": map[string]any{"type": "string"}, "target": targetArg, "id": map[string]any{"type": "string"}, "tab": tabArg}, "text"),
			run:         teachVerb("annotate"),
		},
		{
			Name:        "pflow_focus",
			Description: "Bring something into view in your linked pflow.xyz page: panel:<id> activates an open panel, view:<type> opens a view (outline, diagnostics, notation, plot, …, within the page's level), node:<id> and line:<n> highlight.",
			InputSchema: obj(map[string]any{"target": targetArg, "tab": tabArg}, "target"),
			run:         teachVerb("focus"),
		},
		{
			Name:        "pflow_tour",
			Description: "A guided tour in your linked pflow.xyz page: an ordered list of steps, each an event (show a view, set the level, highlight, annotate, focus) with a line to say. Step 1 runs now; the person moves with Back / Next / End tour, or you do with action next, back or end. Put the net on the canvas with pflow_show first; a step does not carry one. At most 30 steps.",
			InputSchema: obj(map[string]any{
				"steps":  map[string]any{"type": "array", "items": stepSchema, "minItems": 1, "maxItems": maxTourSteps},
				"title":  map[string]any{"type": "string"},
				"action": map[string]any{"type": "string", "enum": []string{"next", "back", "end"}, "description": "move through the open tour instead of starting one"},
				"tab":    tabArg,
			}),
			run: mcpTour,
		},
	}
}
