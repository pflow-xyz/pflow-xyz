package main

// /api/llm/turn: one model call of the editor's chat (ROADMAP phase 4).
//
// The server is stateless: the browser sends the whole conversation, the
// mode and a bounded summary of the net each time, and runs the tools itself
// (every tool is a registry command, public/petri-commands.js). The server
// owns the prompt, the tool manifest and the quota: it sends the fixed
// system prompt, declares the manifest's tools, charges one unit per model
// call, and refuses any tool call the manifest does not name. It returns the
// model's message verbatim (thought signatures included, which Gemini wants
// back on the next call) plus the calls it accepted.

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

//go:embed prompts/turn-v1.md
var turnPromptV1 string

const (
	turnPromptVersion = "turn-v1"
	maxTurnBody       = 256 << 10
	maxTurnMessages   = 80
	maxNetSummary     = 24 << 10
	maxCallsPerReply  = 8
)

// modeGuidance is appended to the first user message: what the person wants
// from the assistant now. Phase 5 extends analyse with the goal catalog and
// phase 6 build with the interview steps.
var modeGuidance = map[string]string{
	"build": "Mode: build. The person is building or changing the net. Make the edits through the tools, a few at a time, " +
		"and check the result with analysis_check before saying it is done.",
	"analyse": "Mode: analyse. The person wants to know something about the net. Find out what (one question if it is unclear), " +
		"run the analysis that answers it, and answer in plain language with the evidence.",
	"explain": "Mode: explain. The person wants to understand the net or a result. Explain with the net's own labels; " +
		"use tools only to look things up. Do not edit.",
}

// stepGuidance is sim's interview (sim-pflow-xyz pkg/builder/llm.go
// stepGuidance), adapted: the editor's tools instead of sim's operation
// vocabulary, the editor's components (compose_fuse) for the calibration
// discipline, and "Next: <step>" in the reply instead of a step_done field.
var stepGuidance = map[string]string{
	"describe":  `Interview step "describe": understand the process. What kind of operation, what question they want answered (staffing? capacity? walkouts? can it get stuck?), the busiest arrival volume. One focused question per turn; prefer concrete numbers. Do not edit yet unless something is unambiguous. When you can name the resources, the activities and the question, end your reply with "Next: structure".`,
	"structure": `Interview step "structure": build places, transitions and arcs together, activity by activity. Calibration discipline: a resource is held across two firings (start_X takes it into in_X, finish_X returns it); the queue → start_X pickup is fast (rate 720 per hour); every queue needs a patience transition to a walked_out sink; outcomes people count get sink places. compose_components lists ready-made parts that already follow this (arrivals, service, hazard, inventory, decision, mailbox, datastore); compose_fuse adds one, fusing its ports onto existing places. Confirm each activity with the person as you add it. When the net covers every activity and resource named, end with "Next: rates".`,
	"rates":     `Interview step "rates": put a rate on every transition (sim_set_rate, per hour unless they said otherwise; a 6-minute service is rate 10). Ask for real numbers; suggest defaults only when they do not know, and say so. Declare what the net should be able to reach with net_set_goals (e.g. everyone served). When no transition is left at the default 1.0 by accident, end with "Next: validate".`,
	"validate":  `Interview step "validate": run analysis_check and analysis_defects (the refinement gate: 0 is clean) and fix what they report with edits. The behaviour checks that come back after your edits are the engine's; fix them or say why they are intended (an end state that cannot fire is often fine). When the check is clean and the defect weight is 0 (or every remaining defect is explained), end with "Next: preview".`,
	"preview":   `Interview step "preview": run a short simulation (sim_recommend, then the engine it suggests) and say in plain words whether the headline numbers look like the person's real operation; adjust rates or initial counts if not. When they are satisfied, tell them to Apply the pending edits and end with "Next: done".`,
	"done":      `The interview is finished: the person applies the net. Answer questions; edit only if asked.`,
}

// toolManifest is public/llm-tools.json (scripts/gen-llm-tools.mjs).
type toolManifest struct {
	Version string `json:"version"`
	Tools   []struct {
		Name        string         `json:"name"`
		Command     string         `json:"command"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters,omitempty"`
	} `json:"tools"`
}

func loadToolManifest(public fs.FS) (*toolManifest, []llm.FunctionDecl, map[string]bool, error) {
	if public == nil {
		return nil, nil, nil, errors.New("no public filesystem")
	}
	raw, err := fs.ReadFile(public, "llm-tools.json")
	if err != nil {
		return nil, nil, nil, err
	}
	var m toolManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, nil, nil, fmt.Errorf("llm-tools.json: %w", err)
	}
	decls := make([]llm.FunctionDecl, 0, len(m.Tools))
	names := map[string]bool{}
	for _, t := range m.Tools {
		decls = append(decls, llm.FunctionDecl{Name: t.Name, Description: t.Description, Parameters: t.Parameters})
		names[t.Name] = true
	}
	return &m, decls, names, nil
}

type turnRequest struct {
	Mode     string          `json:"mode"`
	Step     string          `json:"step,omitempty"` // build mode's interview step (stepGuidance)
	Net      json.RawMessage `json:"net"`
	Messages []llm.Message   `json:"messages"`
}

func validTurn(req *turnRequest) error {
	if _, ok := modeGuidance[req.Mode]; !ok {
		return errors.New("mode must be build, analyse or explain")
	}
	if req.Step != "" {
		if req.Mode != "build" {
			return errors.New("step is for build mode")
		}
		if _, ok := stepGuidance[req.Step]; !ok {
			return errors.New("step must be describe, structure, rates, validate, preview or done")
		}
	}
	if len(req.Net) > maxNetSummary {
		return fmt.Errorf("net summary over %d bytes", maxNetSummary)
	}
	if len(req.Messages) == 0 || len(req.Messages) > maxTurnMessages {
		return fmt.Errorf("messages: 1 to %d", maxTurnMessages)
	}
	for i, m := range req.Messages {
		if m.Role != "user" && m.Role != "model" {
			return fmt.Errorf("messages[%d].role must be user or model", i)
		}
		if len(m.Parts) == 0 {
			return fmt.Errorf("messages[%d] has no parts", i)
		}
		for j, p := range m.Parts {
			n := 0
			if p.Text != "" {
				n++
			}
			if p.FunctionCall != nil {
				n++
			}
			if p.FunctionResponse != nil {
				n++
			}
			if n != 1 && !(n == 0 && p.ThoughtSignature != "") {
				return fmt.Errorf("messages[%d].parts[%d] must be one of text, functionCall, functionResponse", i, j)
			}
		}
	}
	if req.Messages[len(req.Messages)-1].Role != "user" {
		return errors.New("the last message must be the person's (or the tool results)")
	}
	return nil
}

func (s *Server) handleLLMTurn(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		llmError(w, http.StatusMethodNotAllowed, "POST only", nil)
		return
	}
	svc := s.llm
	if svc == nil || svc.tools == nil {
		llmError(w, http.StatusServiceUnavailable, "the assistant is not configured on this server", nil)
		return
	}
	u := svc.user(w, r)
	if u == nil {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxTurnBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req turnRequest
	if err := dec.Decode(&req); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			llmError(w, http.StatusRequestEntityTooLarge, "conversation too large; start a new one", nil)
			return
		}
		llmError(w, http.StatusBadRequest, "body must be {mode, net, messages}", nil)
		return
	}
	if err := validTurn(&req); err != nil {
		llmError(w, http.StatusBadRequest, err.Error(), nil)
		return
	}

	done := svc.admit(w, u, "turn", turnPromptVersion+"/"+svc.toolsVersion)
	if done == nil {
		return
	}
	// The mode and the net travel as user content, never in the system
	// prompt: a label in a shared net is data, not an instruction.
	lead := modeGuidance[req.Mode]
	if extra := svc.modeExtra[req.Mode]; extra != "" {
		lead += "\n\n" + extra
	}
	if g := stepGuidance[req.Step]; g != "" {
		lead += "\n\n" + g
	}
	if len(req.Net) > 0 {
		lead += "\n\nThe net now (net_info):\n" + string(req.Net)
	}
	msgs := append([]llm.Message{{Role: "user", Parts: []llm.Part{{Text: lead}}}}, req.Messages...)
	resp, err := svc.client.Complete(r.Context(), llm.Request{
		System:          turnPromptV1,
		Messages:        msgs,
		Tools:           svc.toolDecls,
		Temperature:     0.2,
		MaxOutputTokens: 4096,
	})
	if err != nil {
		status, msg := upstreamStatus(err)
		done(llm.Usage{Status: status})
		log.Printf("[llm] turn for %s: %v", u.UserName, err)
		llmError(w, status, msg, nil)
		return
	}
	done(llm.Usage{Status: http.StatusOK, In: resp.InputTokens, Out: resp.OutputTokens})

	type call struct {
		Name string         `json:"name"`
		Args map[string]any `json:"args"`
	}
	type refusal struct {
		Name   string `json:"name"`
		Reason string `json:"reason"`
	}
	accepted, refused := []call{}, []refusal{}
	for _, c := range resp.Calls {
		switch {
		case !svc.tools[c.Name]:
			refused = append(refused, refusal{c.Name, "not a tool of this editor"})
		case len(accepted) >= maxCallsPerReply:
			refused = append(refused, refusal{c.Name, fmt.Sprintf("over the %d calls a reply may make", maxCallsPerReply)})
		default:
			accepted = append(accepted, call{c.Name, c.Args})
		}
	}
	left, reset := svc.limiter.Remaining(u.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"message":         llm.Message{Role: "model", Parts: resp.Parts},
		"reply":           strings.TrimSpace(resp.Text),
		"tool_calls":      accepted,
		"refused":         refused,
		"model":           resp.Model,
		"prompt":          turnPromptVersion,
		"tools":           svc.toolsVersion,
		"usage":           map[string]int{"input_tokens": resp.InputTokens, "output_tokens": resp.OutputTokens},
		"remaining_today": left,
		"reset":           reset.Format(time.RFC3339),
	})
}
