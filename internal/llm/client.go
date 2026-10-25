// Package llm is the pflow.xyz server's narrow seam onto a hosted LLM.
//
// The server owns the prompt, the key and the quota; the browser owns the
// meaning (validation, conversion, layout). This package therefore knows
// nothing about Petri nets: it sends a fixed system prompt plus user content
// and returns text or function calls. Handlers in cmd/webserver decide what a
// reply may contain.
//
// Only a Gemini client is built (gemini.go). The Client interface is the seam
// a second provider would implement (slice 1 design, open decision 7).
package llm

import (
	"context"
	"errors"
)

// Message is one turn of a conversation. Role is "user" or "model".
type Message struct {
	Role  string `json:"role,omitempty"`
	Parts []Part `json:"parts"`
}

// Part is one piece of a message: text, a function call the model made, or
// the response to one.
type Part struct {
	Text             string            `json:"text,omitempty"`
	FunctionCall     *FunctionCall     `json:"functionCall,omitempty"`
	FunctionResponse *FunctionResponse `json:"functionResponse,omitempty"`
	// ThoughtSignature is Gemini's opaque token for a thinking model's
	// reasoning; it must be sent back unchanged with the part it came on.
	ThoughtSignature string `json:"thoughtSignature,omitempty"`
}

// FunctionCall is the model asking for a tool to run.
type FunctionCall struct {
	Name string         `json:"name"`
	Args map[string]any `json:"args,omitempty"`
}

// FunctionResponse carries a tool's result back to the model.
type FunctionResponse struct {
	Name     string         `json:"name"`
	Response map[string]any `json:"response"`
}

// FunctionDecl declares a tool the model may call. Parameters is an OpenAPI
// schema object (Gemini's function-calling subset).
type FunctionDecl struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters,omitempty"`
}

// Request is one generateContent call.
type Request struct {
	System          string
	Messages        []Message
	ResponseSchema  map[string]any // when set, the reply is JSON constrained to it
	Tools           []FunctionDecl
	Temperature     float64
	MaxOutputTokens int
}

// Response is what came back. Text is the concatenated text parts; Calls the
// function calls, in order.
type Response struct {
	Text         string
	Calls        []FunctionCall
	Parts        []Part // the candidate's parts, verbatim, to send back next turn
	Model        string
	InputTokens  int
	OutputTokens int
}

// Client is the provider seam.
type Client interface {
	Complete(ctx context.Context, req Request) (*Response, error)
	Model() string
}

var (
	// ErrBadReply: the provider answered, but with nothing usable (no
	// candidates, not the requested JSON, over the size cap). Maps to 502.
	ErrBadReply = errors.New("the model returned an unusable reply")
	// ErrTimeout: the provider took too long. Maps to 504.
	ErrTimeout = errors.New("the model took too long to answer")
	// ErrUpstream: the provider refused or failed (4xx/5xx, network). Maps to
	// 502. Its message never includes the provider's error body, which can
	// echo request content.
	ErrUpstream = errors.New("the model service failed")
)
