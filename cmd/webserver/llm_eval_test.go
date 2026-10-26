package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

// evalDescriptions are the live prompt-quality set (slice-1 test plan, "Prompt
// quality"). make llm-eval sends each to Gemini with the embedded prompt and
// writes the raw reply to testdata/llm/; scripts/llm-eval.mjs then runs every
// reply through the browser's load gate and reports the pass rate. The
// captured replies are also replayed offline by public/petri-draft_test.ts.
var evalDescriptions = []string{
	"A coffee shop with two baristas. Customers arrive, queue, order, and leave once served or after waiting too long.",
	"Online orders are placed, paid, packed and shipped. A fraud hold stops an order from being packed until it is cleared.",
	"An SIR epidemic in a town of 1000 people.",
	"A hospital emergency department: patients arrive, are triaged, wait for a doctor, and are admitted or discharged.",
	"A traffic light at a crossroads that cycles green, amber, red for each direction.",
	"A vending machine that takes coins, dispenses a drink and gives change, and can run out of stock.",
	"Support tickets are opened, assigned to one of three agents, worked, and closed or escalated.",
	"A bakery bakes bread in batches of 12 in one oven; loaves are sold until the shelf is empty.",
	"A two-player game of tic-tac-toe.",
	"Library books are borrowed, returned late or on time, and reserved by other members.",
	"A CI pipeline: a commit triggers build, then tests, then deploy; a failure stops the pipeline.",
	"Users sign up, verify their email, and either become active or churn after a week.",
	"A warehouse with two forklifts moving pallets from the dock to shelves.",
	"Bees forage for nectar and bring it back to the hive, where it becomes honey.",
	"A restaurant kitchen where orders are cooked by a chef and plated by a sous chef.",
	"A car wash with one bay; cars queue and leave if the line is longer than five.",
	"Loan applications are submitted, checked for credit, approved or rejected, and funded.",
	"Water flows from a reservoir through a treatment plant to houses.",
	"what is the capital of France",
	"",
}

// TestLLMEvalLive is opt-in: PFLOW_LLM_EVAL=1 and GEMINI_API_KEY. It never
// runs in make test or CI.
func TestLLMEvalLive(t *testing.T) {
	key := os.Getenv("GEMINI_API_KEY")
	if os.Getenv("PFLOW_LLM_EVAL") != "1" || key == "" {
		t.Skip("live eval: set PFLOW_LLM_EVAL=1 and GEMINI_API_KEY (make llm-eval)")
	}
	client := llm.NewGemini(key, os.Getenv("PFLOW_LLM_MODEL"))
	dir := filepath.Join("..", "..", "testdata", "llm")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i, desc := range evalDescriptions {
		if desc == "" {
			desc = "(empty)"
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		resp, err := client.Complete(ctx, llm.Request{
			System:          draftPromptV1,
			Messages:        []llm.Message{{Role: "user", Parts: []llm.Part{{Text: desc}}}},
			ResponseSchema:  draftSchema,
			Temperature:     0.2,
			MaxOutputTokens: 16384,
		})
		cancel()
		rec := map[string]any{"description": desc, "prompt": draftPromptVersion, "model": client.Model()}
		if err != nil {
			rec["error"] = err.Error()
		} else {
			rec["raw"] = resp.Text
			rec["usage"] = map[string]int{"in": resp.InputTokens, "out": resp.OutputTokens}
		}
		out, _ := json.MarshalIndent(rec, "", "  ")
		name := filepath.Join(dir, fmt.Sprintf("%s-%02d.json", draftPromptVersion, i))
		if err := os.WriteFile(name, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("%s: %v", name, err)
	}
}
