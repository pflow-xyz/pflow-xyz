package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// The game tools as /mcp serves them. The search is held to pflow-native by
// mcp_game_parity_test.go; this is the tool around it: listing, the aliases,
// the refusals that are the server's own, and the call's context.

const gameRulesJSON = `"sides":{"x_":1,"o_":-1},"reward":{"win_x":1,"win_o":-1},"auto":["x_win_","o_win_"]`

func gameFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("../../parity/native/fixtures/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func gameCall(t *testing.T, tool, fixture, rest string) map[string]any {
	t.Helper()
	args := `{"net":` + gameFixture(t, fixture) + `,` + gameRulesJSON + rest + `}`
	_, out := mcpCall(t, &Server{}, toolCall(tool, args))
	return out
}

func toolError(t *testing.T, out map[string]any) string {
	t.Helper()
	res, _ := out["result"].(map[string]any)
	if res == nil || res["isError"] != true {
		t.Fatalf("not a tool error: %v", out)
	}
	return res["content"].([]any)[0].(map[string]any)["text"].(string)
}

func TestMCPGameToolsAreListedAndAnnotated(t *testing.T) {
	_, out := mcpCall(t, &Server{}, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	found := map[string]map[string]any{}
	for _, x := range out["result"].(map[string]any)["tools"].([]any) {
		m := x.(map[string]any)
		found[m["name"].(string)] = m
	}
	for _, name := range []string{"pflow_game_value", "pflow_game_move"} {
		m := found[name]
		if m == nil {
			t.Fatalf("%s is not listed", name)
		}
		ann := m["annotations"].(map[string]any)
		if ann["readOnlyHint"] != true || ann["destructiveHint"] != false {
			t.Errorf("%s: %v", name, ann)
		}
		req := m["inputSchema"].(map[string]any)["required"].([]any)
		if len(req) != 3 {
			t.Errorf("%s requires %v", name, req)
		}
		if strings.ContainsAny(name, ".") {
			t.Errorf("%s is not a name every MCP client takes", name)
		}
	}
}

func TestMCPGameValueAndMove(t *testing.T) {
	v := structured(t, gameCall(t, "pflow_game_value", "game-tic-tac-toe.jsonld", ""))
	if v["value"] != 0.0 || v["nodes"] != 2297.0 || v["exact"] != true || v["mover"] != 1.0 || v["moves"] != 9.0 {
		t.Errorf("%v", v)
	}
	m := structured(t, gameCall(t, "pflow_game_move", "game-tic-tac-toe.jsonld", ""))
	if m["value"] != 0.0 || m["exact"] != true || m["transition"] != "x_play_00" {
		t.Errorf("%v", m)
	}
}

func TestMCPGameToolsAnswerToNativesNames(t *testing.T) {
	for alias, tool := range mcpAliases {
		a := structured(t, gameCall(t, alias, "game-tic-tac-toe.jsonld", `,"nodes":50`))
		b := structured(t, gameCall(t, tool, "game-tic-tac-toe.jsonld", `,"nodes":50`))
		ja, _ := json.Marshal(a)
		jb, _ := json.Marshal(b)
		if string(ja) != string(jb) {
			t.Errorf("%s: %s != %s", alias, ja, jb)
		}
	}
}

// The root estimate "ode" and the aspiration driver are answered, with the
// numbers native gives (held case by case in mcp_game_parity_test.go).
func TestMCPGameAnswersTheOdeEstimate(t *testing.T) {
	for _, c := range []struct {
		plan  string
		nodes float64
	}{
		{`{"root":{"order":["ode"]}}`, 2432},
		{`{"root":{"order":["ode","non_losing"]}}`, 2432},
		{`{"drivers":["aspiration","null_window"],"root":{"order":["ode"]}}`, 2307},
	} {
		v := structured(t, gameCall(t, "pflow_game_value", "game-tic-tac-toe.jsonld", `,"plan":`+c.plan))
		if v["value"] != 0.0 || v["exact"] != true || v["nodes"] != c.nodes {
			t.Errorf("%s: %v", c.plan, v)
		}
		m := structured(t, gameCall(t, "pflow_game_move", "game-tic-tac-toe.jsonld", `,"plan":`+c.plan))
		if m["value"] != 0.0 || m["transition"] != "x_play_11" || m["exact"] != true {
			t.Errorf("%s: %v", c.plan, m)
		}
	}
}

// The aspiration driver starts from an estimate, and has none without one.
func TestMCPGameAspirationNeedsAnEstimate(t *testing.T) {
	msg := toolError(t, gameCall(t, "pflow_game_value", "game-tic-tac-toe.jsonld", `,"plan":{"drivers":["aspiration"]}`))
	if !strings.Contains(msg, `driver "aspiration" starts from the root's estimate`) {
		t.Errorf("%s", msg)
	}
}

func TestMCPGameRefusesWhatNativeRefuses(t *testing.T) {
	for _, c := range []struct{ rest, want string }{
		{`,"plan":{"drivers":[{"budget":{"nodes":1000,"ms":50}}]}`, "budget.ms"},
		{`,"plan":{"order":["bogus"]}`, `unknown order piece "bogus"`},
		{`,"plan":{"drivers":["null_window","mtd_f"]}`, "name one"},
		{`,"nodes":200000000`, "nodes must be in 1..10000000"},
		{`,"plan":{"memo":{"entries":16777216}}`, "memo.entries must be at most 2097152"},
		{`,"depth":3`, `game.value: unknown argument "depth"`},
	} {
		if msg := toolError(t, gameCall(t, "pflow_game_value", "game-tic-tac-toe.jsonld", c.rest)); !strings.Contains(msg, c.want) {
			t.Errorf("%s: %s", c.rest, msg)
		}
	}
}

func TestMCPGameNeedsANetItCanRun(t *testing.T) {
	_, out := mcpCall(t, &Server{}, toolCall("pflow_game_value", `{`+gameRulesJSON+`}`))
	if msg := toolError(t, out); !strings.Contains(msg, "net") {
		t.Errorf("%s", msg)
	}
	// Two token colours: refused, not run with some copies left out.
	var doc map[string]any
	if err := json.Unmarshal([]byte(gameFixture(t, "colored.jsonld")), &doc); err != nil {
		t.Fatal(err)
	}
	net, _ := json.Marshal(doc)
	_, out = mcpCall(t, &Server{}, toolCall("pflow_game_value", `{"net":`+string(net)+`,"sides":{"a":1},"reward":{"Done":1}}`))
	if msg := toolError(t, out); !strings.Contains(msg, "several token colours") {
		t.Errorf("%s", msg)
	}
}

// A call whose context is over stops the search and answers with an error,
// not a value.
func TestMCPGameStopsWhenTheCallIsOver(t *testing.T) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(gameFixture(t, "game-connect-4.jsonld")), &doc); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest("POST", "/mcp", nil).WithContext(ctx)
	var args map[string]any
	if err := json.Unmarshal([]byte(`{`+gameRulesJSON+`,"nodes":5000000}`), &args); err != nil {
		t.Fatal(err)
	}
	args["net"] = doc
	out, err := mcpGameValue(&Server{}, req, args)
	if err == nil || !strings.Contains(err.Error(), "gave up") {
		t.Fatalf("%v %v", out, err)
	}
}

// The goldens and their generator move together: the commits the goldens
// record are the ones the generator pins.
func TestMCPGameGoldensNameTheGeneratorsPins(t *testing.T) {
	var golden struct {
		PflowNative string `json:"pflow_native"`
		PflowRS     string `json:"pflow_rs"`
	}
	loadJSON(t, "../../parity/native/game_goldens.json", &golden)
	cargo, err := os.ReadFile("../../parity/native/gen-game/Cargo.toml")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cargo), golden.PflowNative) {
		t.Errorf("gen-game/Cargo.toml does not pin pflow-native %s, the commit game_goldens.json was generated against", golden.PflowNative)
	}
	if !strings.Contains(string(cargo), golden.PflowRS[:7]) {
		t.Errorf("gen-game/Cargo.toml does not name pflow-rs %s", golden.PflowRS[:7])
	}
}
