package main

// Auto mode for /api/llm/turn: the browser sends mode "auto" with the first
// round of a message, the server labels the message (intent and sentiment)
// with a small, fast model and then runs the turn in the mode it chose. The
// label travels back so the browser can use it for the rest of the message
// (the tools it may run depend on it: explain never edits). It is one HTTP
// request and one quota unit: the classifier call is not charged to the
// person, and it can only ever pick one of the three existing modes, so it
// widens nothing a person could not have chosen by hand.

import (
	"context"
	_ "embed"
	"encoding/json"
	"log"
	"strings"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

//go:embed prompts/classify-v1.md
var classifyPromptV1 string

const (
	classifyPromptVersion = "classify-v1"
	defaultClassifyModel  = "gemini-flash-lite-latest"
	maxClassifyText       = 1000
	// minAutoConfidence: below it the person's current mode (or analyse, the
	// read-only default) stands.
	minAutoConfidence = 0.5
	fallbackMode      = "analyse"
)

var sentiments = map[string]bool{"positive": true, "neutral": true, "confused": true, "frustrated": true}

var classifySchema = map[string]any{
	"type": "OBJECT",
	"properties": map[string]any{
		"intent":     map[string]any{"type": "STRING", "enum": []string{"build", "analyse", "explain"}},
		"sentiment":  map[string]any{"type": "STRING", "enum": []string{"positive", "neutral", "confused", "frustrated"}},
		"confidence": map[string]any{"type": "NUMBER"},
	},
	"required": []string{"intent", "sentiment", "confidence"},
}

// classification is what auto mode decided, returned to the browser.
type classification struct {
	Mode       string  `json:"mode"`
	Sentiment  string  `json:"sentiment"`
	Confidence float64 `json:"confidence"`
	Fallback   bool    `json:"fallback,omitempty"` // the classifier failed or was unsure
}

// lastUserText is the text of the newest message when it is the person's own
// words (not tool results), or "".
func lastUserText(msgs []llm.Message) string {
	if len(msgs) == 0 {
		return ""
	}
	var b strings.Builder
	for _, p := range msgs[len(msgs)-1].Parts {
		if p.Text != "" {
			b.WriteString(p.Text)
			b.WriteString("\n")
		}
	}
	return strings.TrimSpace(b.String())
}

// classify labels text. It never fails the turn: on any problem the person's
// current mode (or analyse) stands and Fallback says so.
func (svc *llmService) classify(ctx context.Context, text, current string) classification {
	if _, ok := modeGuidance[current]; !ok {
		current = fallbackMode
	}
	fb := classification{Mode: current, Sentiment: "neutral", Fallback: true}
	if len(text) > maxClassifyText {
		text = text[:maxClassifyText]
	}
	resp, err := svc.client.Complete(ctx, llm.Request{
		System:          classifyPromptV1,
		Model:           svc.classifyModel,
		Messages:        []llm.Message{{Role: "user", Parts: []llm.Part{{Text: "Current mode: " + current + "\n\nMessage:\n" + text}}}},
		ResponseSchema:  classifySchema,
		Temperature:     0,
		MaxOutputTokens: 128,
	})
	if err != nil {
		log.Printf("[llm] classify: %v", err)
		return fb
	}
	var out struct {
		Intent     string  `json:"intent"`
		Sentiment  string  `json:"sentiment"`
		Confidence float64 `json:"confidence"`
	}
	if err := json.Unmarshal([]byte(resp.Text), &out); err != nil {
		log.Printf("[llm] classify: reply is not JSON: %q", truncate(resp.Text, 200))
		return fb
	}
	if _, ok := modeGuidance[out.Intent]; !ok {
		return fb
	}
	if !sentiments[out.Sentiment] {
		out.Sentiment = "neutral"
	}
	if out.Confidence < minAutoConfidence {
		fb.Sentiment = out.Sentiment
		fb.Confidence = out.Confidence
		return fb
	}
	return classification{Mode: out.Intent, Sentiment: out.Sentiment, Confidence: out.Confidence}
}
