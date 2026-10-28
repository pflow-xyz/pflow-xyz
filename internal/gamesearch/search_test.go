package gamesearch

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/pflow-xyz/go-pflow/metamodel"
	"github.com/pflow-xyz/go-pflow/parser"
)

// The search against a brute-force minimax of its own, apart from the
// goldens that hold it to pflow-native (cmd/webserver/mcp_game_parity_test.go):
// a value must be the minimax value whatever pieces a plan picks.

const fixtures = "../../parity/native/fixtures/"

func load(t *testing.T, name string) (*Net, map[string]any) {
	t.Helper()
	raw, err := os.ReadFile(fixtures + name)
	if err != nil {
		t.Fatal(err)
	}
	m, colors, err := parser.ModelFromJSON(raw)
	if err != nil || colors != nil {
		t.Fatalf("%s: %v %v", name, err, colors)
	}
	mk := map[string]int64{}
	for _, p := range m.Places {
		mk[p.ID] = int64(p.Initial)
	}
	return &Net{Model: m, Marking: mk}, nil
}

type fixture struct {
	file string
	args string
}

var games = map[string]fixture{
	"ttt":   {"game-tic-tac-toe.jsonld", `{"sides": {"x_": 1, "o_": -1}, "reward": {"win_x": 1, "win_o": -1}, "auto": ["x_win_", "o_win_"]}`},
	"nim":   {"game-nim.jsonld", `{"sides": {"a_take": 1, "b_take": -1}, "reward": {"win_a": 1, "win_b": -1}, "auto": ["a_lose", "b_lose"]}`},
	"p123":  {"game-prizes-123.jsonld", `{"sides": {"x_take": 1, "o_take": -1}, "reward": {"x0": 1, "x1": 2, "x2": 3, "o0": -1, "o1": -2, "o2": -3}}`},
	"p1111": {"game-prizes-1111.jsonld", `{"sides": {"x_take": 1, "o_take": -1}, "reward": {"x0": 1, "x1": 1, "x2": 1, "x3": 1, "o0": -1, "o1": -1, "o2": -1, "o3": -1}}`},
}

func args(t *testing.T, g fixture, plan string, extra map[string]any) map[string]any {
	t.Helper()
	var a map[string]any
	if err := json.Unmarshal([]byte(g.args), &a); err != nil {
		t.Fatal(err)
	}
	if plan != "" {
		var p any
		if err := json.Unmarshal([]byte(plan), &p); err != nil {
			t.Fatal(err)
		}
		a["plan"] = p
	}
	for k, v := range extra {
		a[k] = v
	}
	return a
}

// minimax is the value of settled mk by plain minimax: no table, no pieces.
func minimax(t *testing.T, g *Game, mk []int64) float64 {
	moves := g.Moves(mk)
	if len(moves) == 0 {
		v, err := g.Score(mk)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	s, err := g.Mover(moves)
	if err != nil {
		t.Fatal(err)
	}
	best := math.Inf(-1)
	if s < 0 {
		best = math.Inf(1)
	}
	for _, m := range moves {
		next, err := g.play(mk, m)
		if err != nil {
			t.Fatal(err)
		}
		v := minimax(t, g, next)
		if (s > 0 && v > best) || (s < 0 && v < best) {
			best = v
		}
	}
	return best
}

var plans = []string{
	``,
	`{"filters": []}`,
	`{"filters": ["non_losing"]}`,
	`{"filters": ["must_win", "non_losing"], "root": {"order": ["non_losing"]}}`,
	`{"order": ["history"], "drivers": []}`,
	`{"drivers": ["mtd_f"]}`,
	`{"drivers": ["mtd_f"], "filters": [], "memo": {"entries": 5}}`,
	`{"memo": {"entries": 1}, "order": []}`,
	// The root estimate changes the order of the root's moves, never the value.
	`{"root": {"order": ["ode"]}}`,
	`{"root": {"order": ["ode", "non_losing"]}, "filters": []}`,
	`{"root": {"order": ["non_losing", "ode"]}, "drivers": ["mtd_f"], "memo": {"entries": 7}}`,
}

func TestValueIsTheMinimaxValue(t *testing.T) {
	for name, gm := range games {
		net, _ := load(t, gm.file)
		ix := NewIndexed(net.Model)
		a := args(t, gm, "", nil)
		r, err := readRules(ix, a)
		if err != nil {
			t.Fatal(err)
		}
		g := NewGame(ix, r.auto, r.sign, r.reward)
		start := ix.Dense(net.Marking)
		if err := g.Settle(start); err != nil {
			t.Fatal(err)
		}
		// The start, and the positions after each of its first moves.
		positions := [][]int64{start}
		for _, m := range g.Moves(start) {
			next, err := g.play(start, m)
			if err != nil {
				t.Fatal(err)
			}
			positions = append(positions, next)
		}
		for i, mk := range positions {
			if name == "ttt" && i == 0 {
				continue // 550,000 positions; its moves' values are checked
			}
			want := minimax(t, g, mk)
			for _, p := range plans {
				n := &Net{Model: net.Model, Marking: map[string]int64{}}
				for j, pl := range ix.Places {
					n.Marking[pl] = mk[j]
				}
				out, err := Value(n, args(t, gm, p, nil), Config{})
				if err != nil {
					t.Fatalf("%s %d %s: %v", name, i, p, err)
				}
				if len(g.Moves(mk)) > 0 && (out["exact"] != true || out["value"] != want) {
					t.Errorf("%s position %d, plan %q: value %v, minimax %v", name, i, p, out["value"], want)
				}
				mv, err := Move(n, args(t, gm, p, nil), Config{})
				if err != nil {
					t.Fatalf("%s %d %s: %v", name, i, p, err)
				}
				if len(g.Moves(mk)) > 0 {
					// The move is a best one: playing it keeps the value.
					id, _ := mv["transition"].(string)
					var t0 int
					for j, tid := range ix.Transitions {
						if tid == id {
							t0 = j
						}
					}
					next, _ := g.play(mk, t0)
					if mv["value"] != want || minimax(t, g, next) != want {
						t.Errorf("%s position %d, plan %q: move %s is not best (value %v, minimax %v)", name, i, p, id, mv["value"], want)
					}
				}
			}
		}
	}
}

func TestTicTacToeIsADraw(t *testing.T) {
	net, _ := load(t, games["ttt"].file)
	out, err := Value(net, args(t, games["ttt"], "", nil), Config{})
	if err != nil {
		t.Fatal(err)
	}
	// pflow-native's docs: "Tic-tac-toe's start: value 0 in 2,297 nodes."
	if out["value"] != 0.0 || out["nodes"] != 2297 || out["mover"] != 1.0 || out["moves"] != 9 {
		t.Errorf("%v", out)
	}
}

func TestPastTheBudgetThereIsNoValue(t *testing.T) {
	net, _ := load(t, games["ttt"].file)
	out, err := Value(net, args(t, games["ttt"], "", map[string]any{"nodes": 10.0}), Config{})
	if err != nil || out["value"] != nil || out["exact"] != false || out["nodes"] != 10 {
		t.Errorf("%v %v", out, err)
	}
	mv, err := Move(net, args(t, games["ttt"], "", map[string]any{"nodes": 10.0}), Config{})
	if err != nil || mv["transition"] != nil || mv["exact"] != false {
		t.Errorf("%v %v", mv, err)
	}
	mv, err = Move(net, args(t, games["ttt"], `{"mode": "play"}`, map[string]any{"nodes": 10.0}), Config{})
	if err != nil || mv["transition"] == nil || mv["exact"] != false {
		t.Errorf("%v %v", mv, err)
	}
}

// What is still refused. The root estimate is built for "ode" alone; a time
// budget needs a clock the browser build lacks, so it is refused as native
// refuses it; the aspiration driver needs an estimate to start from.
func TestWhatIsStillRefused(t *testing.T) {
	net, _ := load(t, games["ttt"].file)
	for _, c := range []struct{ plan, want string }{
		{`{"drivers": ["aspiration"]}`, `driver "aspiration" starts from the root's estimate: name one in root.order`},
		{`{"drivers": ["aspiration"], "root": {"order": ["ode"]}}`, `the driver "aspiration" is not ported`},
		{`{"root": {"order": ["nope"]}}`, `unknown root piece "nope"`},
		{`{"root": {"order": ["ode", "ode"]}}`, `root piece "ode" is listed twice`},
		{`{"drivers": [{"budget": {"nodes": 1000, "ms": 50}}]}`, "budget.ms"},
		{`{"heuristics": ["static_eval"]}`, `heuristic "static_eval"`},
		{`{"filters": ["beam"]}`, `filter "beam"`},
	} {
		for _, run := range []func(*Net, map[string]any, Config) (map[string]any, error){Value, Move} {
			out, err := run(net, args(t, games["ttt"], c.plan, nil), Config{})
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Errorf("%s: %v %v", c.plan, out, err)
			}
		}
	}
}

// The caps stay: the node budget and the table are the server's.
func TestTheCapsStay(t *testing.T) {
	net, _ := load(t, games["ttt"].file)
	cfg := Config{MaxNodes: 1000, MaxMemo: 64}
	for _, c := range []struct {
		plan  string
		extra map[string]any
		want  string
	}{
		{`{"root": {"order": ["ode"]}}`, map[string]any{"nodes": 5000.0}, "nodes must be in 1..1000"},
		{`{"root": {"order": ["ode"]}, "drivers": [{"budget": {"nodes": 5000}}]}`, nil, "budget.nodes must be at most 1000"},
		{`{"root": {"order": ["ode"]}, "memo": {"entries": 100}}`, nil, "memo.entries must be at most 64"},
	} {
		out, err := Value(net, args(t, games["ttt"], c.plan, c.extra), cfg)
		if err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v %v", c.plan, out, err)
		}
	}
}

// The ODE estimate on a net small enough to solve by hand: A -> t -> B at
// rate 1 for 3 time units leaves A e^-3 of its tokens.
func TestOdeEstimateSolvesTheMassActionODE(t *testing.T) {
	m := &metamodel.Model{
		Places:      []metamodel.Place{{ID: "A", Initial: 4}, {ID: "B"}},
		Transitions: []metamodel.Transition{{ID: "t"}},
		Arcs:        []metamodel.Arc{{From: "A", To: "t", Weight: 1}, {From: "t", To: "B", Weight: 1}},
	}
	ix := NewIndexed(m)
	g := NewGame(ix, []bool{false}, []float64{1}, []Reward{{Place: 1, Weight: 1}})
	e := NewOdeEstimate(g, nil)
	u, err := e.FinalState([]int64{4, 0})
	if err != nil {
		t.Fatal(err)
	}
	if want := 4 * math.Exp(-3); math.Abs(u[0]-want) > 1e-3 || math.Abs(u[0]+u[1]-4) > 1e-9 {
		t.Errorf("A = %v, want %v; A+B = %v", u[0], want, u[0]+u[1])
	}
	v, err := e.Estimate(g, []int64{4, 0})
	if err != nil || v != u[1] {
		t.Errorf("%v %v", v, err)
	}
	// A read arc gates a flux without taking from its place; an arc on the
	// same place twice multiplies it twice.
	m.Arcs = []metamodel.Arc{{From: "A", To: "t", Weight: 1, Type: metamodel.ReadArc}, {From: "t", To: "B", Weight: 1}}
	e = NewOdeEstimate(NewGame(NewIndexed(m), []bool{false}, []float64{1}, []Reward{{Place: 1, Weight: 1}}), nil)
	if u, _ = e.FinalState([]int64{4, 0}); u[0] != 4 || u[1] < 11 {
		t.Errorf("read arc: %v", u)
	}
}

// An estimate that is told to stop does.
func TestTheOdeEstimateStopsWhenToldTo(t *testing.T) {
	net, _ := load(t, games["ttt"].file)
	stop := Config{Cancel: func() error { return os.ErrDeadlineExceeded }}
	_, err := Value(net, args(t, games["ttt"], `{"root": {"order": ["ode"]}}`, nil), stop)
	if err == nil {
		t.Error("an estimate that was told to stop returned a value")
	}
}

// The pow behind the step controller is the correctly rounded one. The
// expected values are x^(1/6) (the double nearest 1/6) evaluated to 80
// digits with Python's decimal module and rounded once.
func TestPowIsCorrectlyRounded(t *testing.T) {
	sixth := 1.0 / 6.0
	for _, c := range []struct{ x, want float64 }{
		{1e-9, 0.0316227766016838}, {0.37, 0.8472930043419643}, {2.5, 1.164993050750713},
		{1e6, 9.999999999999998}, {3e11, 81.81888230000268}, {123.456, 2.231440786728173},
		{0.9999999, 0.9999999833333326}, {7e-5, 0.2030094899212487},
	} {
		if got := pow(c.x, sixth); got != c.want {
			t.Errorf("pow(%v, 1/6) = %v, want %v", c.x, got, c.want)
		}
	}
	if got := pow(1024, 0.1); got != 2 {
		t.Errorf("pow(1024, 0.1) = %v", got)
	}
	// The special cases are math.Pow's.
	for _, c := range [][2]float64{{0, 0.5}, {-1, 0.5}, {math.Inf(1), 0.5}, {2, 0}, {math.NaN(), 1}, {1e-320, 0.5}, {1e300, 100}} {
		if got, want := pow(c[0], c[1]), math.Pow(c[0], c[1]); got != want && !(math.IsNaN(got) && math.IsNaN(want)) {
			t.Errorf("pow(%v, %v) = %v, want %v", c[0], c[1], got, want)
		}
	}
}

func TestACancelledSearchIsAnError(t *testing.T) {
	net, _ := load(t, games["ttt"].file)
	stop := Config{Cancel: func() error { return os.ErrDeadlineExceeded }}
	_, err := Value(net, args(t, games["ttt"], "", nil), stop)
	if err == nil {
		t.Error("a search that was told to stop returned a value")
	}
}

func TestTheCallersPlanIsLeftAlone(t *testing.T) {
	net, _ := load(t, games["ttt"].file)
	a := args(t, games["ttt"], `{"order": ["history"]}`, nil)
	before, _ := json.Marshal(a)
	if _, err := Value(net, a, Config{}); err != nil {
		t.Fatal(err)
	}
	after, _ := json.Marshal(a)
	if string(before) != string(after) {
		t.Errorf("the arguments changed:\n%s\n%s", before, after)
	}
}

func key2(i uint64) key { return key{i, i * 31, 0, 0} }

func entry2(i uint64) entry {
	return entry{lo: -float64(i % 3), hi: 1, best: uint32(i)}
}

// The table, as memo.rs' own tests hold it.
func TestTableHoldsWhatItWasGivenUpToItsLimit(t *testing.T) {
	for _, compact := range []bool{true, false} {
		tb := newTable(10_000, 2, compact)
		for i := uint64(0); i < 5000; i++ {
			tb.store(&[]key{key2(i)}[0], false, entry2(i), 1)
		}
		kept := 0
		for i := uint64(0); i < 5000; i++ {
			k := key2(i)
			if e, ok := tb.get(&k, false); ok && e == entry2(i) {
				kept++
			}
		}
		if kept <= 4950 {
			t.Errorf("compact %v: %d kept", compact, kept)
		}
		for i := uint64(0); i < 100_000; i++ {
			k := key2(i)
			tb.store(&k, false, entry2(i), 1)
		}
		if tb.Len() > 10_000 {
			t.Errorf("compact %v: %d entries", compact, tb.Len())
		}
	}
}

func TestATinyTableKeepsToItsEntries(t *testing.T) {
	for n := 1; n < 12; n++ {
		tb := newTable(n, 3, true)
		for i := uint64(0); i < 100; i++ {
			k := key2(i)
			tb.store(&k, false, entry2(i), 1)
			if tb.Len() > n {
				t.Fatalf("%d entries in a table of %d", tb.Len(), n)
			}
		}
	}
}

func TestEnginesDoNotShareEntries(t *testing.T) {
	tb := newTable(100, 2, true)
	k7, k8 := key2(7), key2(8)
	tb.store(&k7, false, entry2(7), 1)
	if _, ok := tb.get(&k7, true); ok {
		t.Error("a bit key found a counts entry")
	}
	if _, ok := tb.get(&k8, false); ok {
		t.Error("a key found another's entry")
	}
	tb.store(&k7, true, entry2(8), 1)
	if e, _ := tb.get(&k7, false); e != entry2(7) {
		t.Errorf("%v", e)
	}
}

func TestAPinnedEntryIsNotPushedOut(t *testing.T) {
	tb := newTable(4, 2, true)
	pinned := key2(1)
	tb.pin(&pinned, false, 1, 0)
	for i := uint64(2); i < 200; i++ {
		k := key2(i)
		tb.store(&k, false, entry2(i), 20)
	}
	if e, ok := tb.get(&pinned, false); !ok || e.lo != 1 || e.hi != 1 {
		t.Errorf("%v %v", e, ok)
	}
}
