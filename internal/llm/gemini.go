package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// MaxReplyBytes caps what is read from the provider.
const MaxReplyBytes = 256 << 10

// Gemini calls the Gemini API's generateContent over plain REST: no SDK, the
// key in the x-goog-api-key header (never in the URL, so it cannot reach an
// access log or an error string). Modelled on sim-pflow-xyz's
// internal/llm/vertex_gemini.go, with an API key instead of GCP ADC because
// pflow.dev has no metadata server.
type Gemini struct {
	Key     string
	ModelID string        // default gemini-2.5-flash
	BaseURL string        // default https://generativelanguage.googleapis.com/v1beta
	Timeout time.Duration // default 45 s
	HTTP    *http.Client
}

// NewGemini returns a client for key and model ("" = gemini-2.5-flash).
func NewGemini(key, model string) *Gemini {
	if model == "" {
		model = "gemini-2.5-flash"
	}
	return &Gemini{Key: key, ModelID: model, BaseURL: "https://generativelanguage.googleapis.com/v1beta",
		Timeout: 45 * time.Second, HTTP: &http.Client{}}
}

func (g *Gemini) Model() string { return g.ModelID }

type geminiRequest struct {
	SystemInstruction *Message        `json:"systemInstruction,omitempty"`
	Contents          []Message       `json:"contents"`
	Tools             []geminiTools   `json:"tools,omitempty"`
	GenerationConfig  geminiGenConfig `json:"generationConfig"`
}

type geminiTools struct {
	FunctionDeclarations []FunctionDecl `json:"functionDeclarations"`
}

type geminiGenConfig struct {
	Temperature      float64        `json:"temperature"`
	MaxOutputTokens  int            `json:"maxOutputTokens,omitempty"`
	ResponseMimeType string         `json:"responseMimeType,omitempty"`
	ResponseSchema   map[string]any `json:"responseSchema,omitempty"`
}

type geminiResponse struct {
	Candidates []struct {
		Content      Message `json:"content"`
		FinishReason string  `json:"finishReason"`
	} `json:"candidates"`
	UsageMetadata struct {
		PromptTokenCount     int `json:"promptTokenCount"`
		CandidatesTokenCount int `json:"candidatesTokenCount"`
	} `json:"usageMetadata"`
	ModelVersion string `json:"modelVersion"`
}

// buildRequest is split out so tests can check the exact body.
func (g *Gemini) buildRequest(req Request) geminiRequest {
	body := geminiRequest{
		Contents: req.Messages,
		GenerationConfig: geminiGenConfig{
			Temperature:     req.Temperature,
			MaxOutputTokens: req.MaxOutputTokens,
		},
	}
	if req.System != "" {
		body.SystemInstruction = &Message{Parts: []Part{{Text: req.System}}}
	}
	if req.ResponseSchema != nil {
		body.GenerationConfig.ResponseMimeType = "application/json"
		body.GenerationConfig.ResponseSchema = req.ResponseSchema
	}
	if len(req.Tools) > 0 {
		body.Tools = []geminiTools{{FunctionDeclarations: req.Tools}}
	}
	return body
}

func (g *Gemini) Complete(ctx context.Context, req Request) (*Response, error) {
	raw, err := json.Marshal(g.buildRequest(req))
	if err != nil {
		return nil, fmt.Errorf("%w: encoding request: %v", ErrUpstream, err)
	}
	timeout := g.Timeout
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	model := g.ModelID
	if req.Model != "" {
		model = req.Model
	}
	url := fmt.Sprintf("%s/models/%s:generateContent", strings.TrimRight(g.BaseURL, "/"), model)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-goog-api-key", g.Key)

	client := g.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(httpReq)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, ErrTimeout
		}
		// The error from net/http names the URL, which holds no secret.
		return nil, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, MaxReplyBytes+1))
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, ErrTimeout
		}
		return nil, fmt.Errorf("%w: reading reply: %v", ErrUpstream, err)
	}
	if resp.StatusCode != http.StatusOK {
		// Never pass the provider's error body on: it can echo the request.
		return nil, fmt.Errorf("%w: status %d", ErrUpstream, resp.StatusCode)
	}
	if len(body) > MaxReplyBytes {
		return nil, fmt.Errorf("%w: reply over %d bytes", ErrBadReply, MaxReplyBytes)
	}
	var gr geminiResponse
	if err := json.Unmarshal(body, &gr); err != nil {
		return nil, fmt.Errorf("%w: reply is not JSON", ErrBadReply)
	}
	if len(gr.Candidates) == 0 {
		return nil, fmt.Errorf("%w: no candidates", ErrBadReply)
	}
	out := &Response{
		Model:        model,
		InputTokens:  gr.UsageMetadata.PromptTokenCount,
		OutputTokens: gr.UsageMetadata.CandidatesTokenCount,
	}
	if gr.ModelVersion != "" {
		out.Model = gr.ModelVersion
	}
	var text strings.Builder
	for _, p := range gr.Candidates[0].Content.Parts {
		if p.Text != "" {
			text.WriteString(p.Text)
		}
		if p.FunctionCall != nil {
			out.Calls = append(out.Calls, *p.FunctionCall)
		}
	}
	out.Text = text.String()
	out.Parts = gr.Candidates[0].Content.Parts
	if out.Text == "" && len(out.Calls) == 0 {
		return nil, fmt.Errorf("%w: empty candidate (finish reason %q)", ErrBadReply, gr.Candidates[0].FinishReason)
	}
	return out, nil
}
