package main

// The LLM proxy: /api/llm/status and /api/llm/draft (guided modelling, slice 1;
// docs/design/guided-modelling-slice1.md). The server holds the Gemini key,
// the system prompt and the quota; the browser validates, converts and lays
// out what comes back (public/petri-draft.js). The routes are same-origin
// only: they never call handleCORS, so a cross-origin page gets no
// Access-Control-Allow-Origin.

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pflow-xyz/pflow-xyz/internal/auth"
	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

//go:embed prompts/draft-net-v1.md
var draftPromptV1 string

const (
	draftPromptVersion = "draft-net-v1"
	maxLLMBody         = 16 << 10
	maxDescription     = 2000
)

// draftSchema is the Gemini responseSchema for a draft (the slice-1 "Draft
// schema (v1)"). Every field is required, so the decoder cannot drop one; the
// browser's validateDraft checks the values.
var draftSchema = map[string]any{
	"type": "OBJECT",
	"properties": map[string]any{
		"name":    map[string]any{"type": "STRING"},
		"summary": map[string]any{"type": "STRING"},
		"places": map[string]any{"type": "ARRAY", "items": map[string]any{
			"type": "OBJECT",
			"properties": map[string]any{
				"id": map[string]any{"type": "STRING"}, "label": map[string]any{"type": "STRING"},
				"description": map[string]any{"type": "STRING"},
				"initial":     map[string]any{"type": "INTEGER"}, "capacity": map[string]any{"type": "INTEGER"},
			},
			"required": []string{"id", "label", "description", "initial", "capacity"},
		}},
		"transitions": map[string]any{"type": "ARRAY", "items": map[string]any{
			"type": "OBJECT",
			"properties": map[string]any{
				"id": map[string]any{"type": "STRING"}, "label": map[string]any{"type": "STRING"},
				"description": map[string]any{"type": "STRING"}, "rate": map[string]any{"type": "NUMBER"},
			},
			"required": []string{"id", "label", "description", "rate"},
		}},
		"arcs": map[string]any{"type": "ARRAY", "items": map[string]any{
			"type": "OBJECT",
			"properties": map[string]any{
				"from": map[string]any{"type": "STRING"}, "to": map[string]any{"type": "STRING"},
				"weight": map[string]any{"type": "INTEGER"}, "inhibitor": map[string]any{"type": "BOOLEAN"},
			},
			"required": []string{"from", "to", "weight", "inhibitor"},
		}},
		"assumptions": map[string]any{"type": "ARRAY", "items": map[string]any{"type": "STRING"}},
	},
	"required": []string{"name", "summary", "places", "transitions", "arcs", "assumptions"},
}

// llmService is nil-safe: a nil *llmService (no key configured) reports
// enabled: false and refuses every call with 503.
type llmService struct {
	client   llm.Client
	limiter  *llm.Limiter
	verifier auth.Verifier
	allow    map[string]bool // lower-cased GitHub logins; nil = every signed-in user
}

// newLLMService builds the proxy from the environment. With no
// GEMINI_API_KEY it returns nil and the feature ships dark.
func newLLMService(getenv func(string) string, dataDir string) (*llmService, error) {
	key := getenv("GEMINI_API_KEY")
	if key == "" {
		return nil, nil
	}
	lim, err := llm.NewLimiter(llm.LimitsFromEnv(getenv), filepath.Join(dataDir, "llm"))
	if err != nil {
		return nil, err
	}
	svc := &llmService{
		client:   llm.NewGemini(key, getenv("PFLOW_LLM_MODEL")),
		limiter:  lim,
		verifier: auth.NewCachingVerifier(auth.NewGitHubVerifier()),
	}
	if a := strings.TrimSpace(getenv("PFLOW_LLM_ALLOW")); a != "" {
		svc.allow = map[string]bool{}
		for _, login := range strings.Split(a, ",") {
			if login = strings.ToLower(strings.TrimSpace(login)); login != "" {
				svc.allow[login] = true
			}
		}
	}
	return svc, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func llmError(w http.ResponseWriter, status int, msg string, extra map[string]any) {
	body := map[string]any{"error": msg}
	for k, v := range extra {
		body[k] = v
	}
	writeJSON(w, status, body)
}

// user verifies the request's bearer token. It writes the refusal itself and
// returns nil when the caller may not go on.
func (s *llmService) user(w http.ResponseWriter, r *http.Request) *auth.GitHubUserInfo {
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	if token == "" {
		llmError(w, http.StatusUnauthorized, "sign in with GitHub to use drafting", nil)
		return nil
	}
	u, err := s.verifier.Verify(r.Context(), token)
	switch {
	case errors.Is(err, auth.ErrInvalidToken):
		llmError(w, http.StatusUnauthorized, "sign in with GitHub to use drafting", nil)
		return nil
	case err != nil:
		log.Printf("[llm] github verification: %v", err)
		llmError(w, http.StatusServiceUnavailable, "cannot reach GitHub to check your sign-in; try again shortly", nil)
		return nil
	}
	if s.allow != nil && !s.allow[strings.ToLower(u.UserName)] {
		llmError(w, http.StatusForbidden, "drafting is not open to every account yet", nil)
		return nil
	}
	return u
}

func (s *Server) handleLLMStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		llmError(w, http.StatusMethodNotAllowed, "GET only", nil)
		return
	}
	svc := s.llm
	if svc == nil {
		writeJSON(w, http.StatusOK, map[string]any{"enabled": false, "signed_in": false})
		return
	}
	out := map[string]any{"enabled": true, "signed_in": false, "model": svc.client.Model()}
	if token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "); strings.TrimSpace(token) != "" {
		if u, err := svc.verifier.Verify(r.Context(), token); err == nil {
			left, reset := svc.limiter.Remaining(u.ID)
			out["signed_in"] = true
			out["remaining_today"] = left
			out["daily_limit"] = svc.limiter.L.Daily
			out["reset"] = reset.Format(time.RFC3339)
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// admit runs the checks every LLM call shares, after the request itself was
// read: the quota (429), then the usage log (503, fail closed). It writes the
// refusal and returns nil when the call may not go upstream.
func (s *llmService) admit(w http.ResponseWriter, u *auth.GitHubUserInfo, kind, prompt string) func(llm.Usage) {
	done, err := s.limiter.Begin(llm.Usage{Kind: kind, GHID: u.ID, Login: u.UserName, Prompt: prompt})
	var le *llm.LimitError
	switch {
	case errors.As(err, &le):
		secs := int(math.Ceil(le.RetryAfter.Seconds()))
		if secs < 1 {
			secs = 1
		}
		w.Header().Set("Retry-After", fmt.Sprint(secs))
		llmError(w, http.StatusTooManyRequests, le.Reason, map[string]any{"retry_after_s": secs, "reset": le.Reset.Format(time.RFC3339)})
		return nil
	case err != nil:
		log.Printf("[llm] usage log: %v", err)
		llmError(w, http.StatusServiceUnavailable, "drafting is unavailable right now", nil)
		return nil
	}
	return done
}

// upstreamStatus maps a client error to the slice-1 status table.
func upstreamStatus(err error) (int, string) {
	switch {
	case errors.Is(err, llm.ErrTimeout):
		return http.StatusGatewayTimeout, "the model took too long to answer; try again"
	case errors.Is(err, llm.ErrBadReply):
		return http.StatusBadGateway, "the model returned an unusable reply"
	default:
		return http.StatusBadGateway, "the model service failed; try again"
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func (s *Server) handleLLMDraft(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		llmError(w, http.StatusMethodNotAllowed, "POST only", nil)
		return
	}
	svc := s.llm
	if svc == nil {
		llmError(w, http.StatusServiceUnavailable, "drafting is not configured on this server", nil)
		return
	}
	u := svc.user(w, r)
	if u == nil {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxLLMBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	var req struct {
		Description string `json:"description"`
	}
	if err := dec.Decode(&req); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			llmError(w, http.StatusRequestEntityTooLarge, "request too large", map[string]any{"limit": maxDescription})
			return
		}
		llmError(w, http.StatusBadRequest, "body must be {\"description\": \"...\"}", nil)
		return
	}
	desc := strings.TrimSpace(req.Description)
	if desc == "" {
		llmError(w, http.StatusBadRequest, "description is empty", nil)
		return
	}
	if utf8.RuneCountInString(desc) > maxDescription {
		llmError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("description is over %d characters", maxDescription), map[string]any{"limit": maxDescription})
		return
	}

	done := svc.admit(w, u, "draft", draftPromptVersion)
	if done == nil {
		return
	}
	resp, err := svc.client.Complete(r.Context(), llm.Request{
		System:          draftPromptV1,
		Messages:        []llm.Message{{Role: "user", Parts: []llm.Part{{Text: desc}}}},
		ResponseSchema:  draftSchema,
		Temperature:     0.2,
		MaxOutputTokens: 4096,
	})
	if err != nil {
		status, msg := upstreamStatus(err)
		done(llm.Usage{Status: status})
		log.Printf("[llm] draft for %s: %v", u.UserName, err)
		llmError(w, status, msg, nil)
		return
	}
	var draft map[string]any
	if err := json.Unmarshal([]byte(resp.Text), &draft); err != nil {
		done(llm.Usage{Status: http.StatusBadGateway, In: resp.InputTokens, Out: resp.OutputTokens})
		log.Printf("[llm] draft for %s: reply is not JSON: %q", u.UserName, truncate(resp.Text, 400))
		llmError(w, http.StatusBadGateway, "the model returned an unusable reply", nil)
		return
	}
	for _, k := range []string{"name", "summary", "places", "transitions", "arcs", "assumptions"} {
		if _, ok := draft[k]; !ok {
			done(llm.Usage{Status: http.StatusBadGateway, In: resp.InputTokens, Out: resp.OutputTokens})
			log.Printf("[llm] draft for %s: reply lacks %q: %q", u.UserName, k, truncate(resp.Text, 400))
			llmError(w, http.StatusBadGateway, "the model returned an unusable reply", nil)
			return
		}
	}
	done(llm.Usage{Status: http.StatusOK, In: resp.InputTokens, Out: resp.OutputTokens})
	left, reset := svc.limiter.Remaining(u.ID)
	writeJSON(w, http.StatusOK, map[string]any{
		"draft": draft, "model": resp.Model, "prompt": draftPromptVersion,
		"usage":           map[string]int{"input_tokens": resp.InputTokens, "output_tokens": resp.OutputTokens},
		"remaining_today": left, "reset": reset.Format(time.RFC3339),
	})
}

// configureLLM wires the proxy from the environment and logs which way it went.
func (s *Server) configureLLM(dataDir string) {
	svc, err := newLLMService(os.Getenv, dataDir)
	switch {
	case err != nil:
		log.Printf("LLM drafting: disabled (%v)", err)
	case svc == nil:
		log.Printf("LLM drafting: disabled (no GEMINI_API_KEY)")
	default:
		s.llm = svc
		who := "every signed-in user"
		if svc.allow != nil {
			who = fmt.Sprintf("%d allowlisted login(s)", len(svc.allow))
		}
		log.Printf("LLM drafting: enabled (model %s, %s)", svc.client.Model(), who)
	}
}
