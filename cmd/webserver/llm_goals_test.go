package main

import (
	"os"
	"strings"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/llm"
)

// The analyse mode's brief comes from the same public/goals.json the no-LLM
// picker runs, and only the analyse mode gets it.
func TestGoalCatalogReachesAnalyseMode(t *testing.T) {
	text, n, err := goalCatalogText(os.DirFS("../../public"))
	if err != nil {
		t.Fatal(err)
	}
	if n < 10 || !strings.Contains(text, "stuck") || !strings.Contains(text, "analysis.verify") || !strings.Contains(text, "NOT available") {
		t.Fatalf("%d goals; brief:\n%s", n, text)
	}
	c := &turnClient{resp: &llm.Response{Text: "ok", Parts: []llm.Part{{Text: "ok"}}}}
	s := turnServer(t, c)
	s.llm.modeExtra = map[string]string{"analyse": text}
	do(t, s, "POST", "/api/llm/turn", "good", userTurn)
	if !strings.Contains(c.last.Messages[0].Parts[0].Text, "Goal catalog") {
		t.Fatal("analyse mode did not get the catalog")
	}
	do(t, s, "POST", "/api/llm/turn", "good", strings.Replace(userTurn, `"analyse"`, `"build"`, 1))
	if strings.Contains(c.last.Messages[0].Parts[0].Text, "Goal catalog") {
		t.Fatal("build mode got the analyse catalog")
	}
}
