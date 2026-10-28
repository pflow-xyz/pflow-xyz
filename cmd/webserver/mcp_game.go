package main

// The /mcp game tools: pflow_game_value and pflow_game_move, pflow-native's
// game.value and game.move without a browser or a wasm runtime. The search
// itself is internal/gamesearch, a Go port of pflow-metamodel's alpha-beta
// (transposition table, move order, filters, null_window and mtd_f drivers,
// node budget, opening book, root non_losing); this file is the tool around
// it.
//
// Like every registry tool they are stateless and model-in-argument: the net
// travels in the call, its marking is the position searched, and the answer
// is the one pflow-native gives (the Report artifact it also stores aside,
// there being no session). Same arguments (sides, reward, auto, plan, nodes,
// book) and same results.
//
// pflow-native is the reference. parity/native/game_goldens.json is its answer
// to every call in parity/native/game_cases.json (parity/native/gen-game),
// and mcp_game_parity_test.go holds these tools to it: identical values and
// moves, identical node counts, identical refusals' words. That covers the
// root estimate "ode" (the mass-action ODE solved at the root, ode.go). What differs:
//
//   - The "aspiration" driver is refused (it starts from the estimate's guess,
//     which this search does not take yet).
//   - A net with several token colours is refused (native supports one whose
//     colour copies are all used).
//   - The caps are tighter than native's (wbGameMaxNodes, wbGameMaxMemo): a
//     call that asks for more is refused with native's words and the cap.
//     The call's context stops a search that runs on; the result is an error,
//     not a value.
//   - A JSON object's members arrive in sorted order, not the order written,
//     so `sides`, `reward` and the plan are read in sorted order. That
//     changes which of two mistakes is reported first, and the reward's
//     summing order (the place order is the nets's, id order, on both sides).
//
// The tool names are the repo's (pflow_*), as pflow_sde is native's sim.sde;
// tools/call also takes native's own ids, game.value and game.move.

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/pflow-xyz/pflow-xyz/internal/gamesearch"
)

const (
	// wbGameMaxNodes and wbGameMaxMemo lower native's caps (100,000,000 nodes
	// and 2^23 table entries): a call is bounded by the 60 s call timeout and
	// the server's memory, with up to eight calls at once. A table entry takes
	// 25 to 41 bytes.
	wbGameMaxNodes = 10_000_000
	wbGameMaxMemo  = 1 << 21
	// wbGameMaxNet bounds the net: the search does not need more, and a
	// document this size is already over the body limit.
	wbGameMaxNet = 2000
)

// mcpAliases are the names tools/call also takes.
var mcpAliases = map[string]string{
	"game.value": "pflow_game_value",
	"game.move":  "pflow_game_move",
}

func init() {
	for name, a := range map[string]mcpAnnotation{
		"pflow_game_value": {"Exact value of a two-sided game position", true, false, true},
		"pflow_game_move":  {"Best move of a two-sided game position", true, false, true},
	} {
		mcpAnnotations[name] = a
	}
}

var (
	gameRulesArgs = map[string]any{
		"sides":  map[string]any{"description": "{transition-id prefix: sign}: who moves, e.g. {\"x_\": 1, \"o_\": -1} (+1 maximizes the reward); a JSON string of it is accepted"},
		"reward": map[string]any{"description": "{place: weight} read from the final marking, from the +1 side's view, e.g. {\"win_x\": 1, \"win_o\": -1}"},
		"auto":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "transition-id prefixes that fire as soon as they are enabled, before anyone chooses (e.g. [\"x_win_\", \"o_win_\"]: win claims)"},
		"plan": map[string]any{"description": "a SearchPlan, or a JSON string of one: {mode, order, filters, root, drivers, memo}; default {}. " +
			"mode \"exact\" (default) or \"play\" (game.move may guess past the budget). " +
			"order: tt_best, immediate_win, history, centrality, threats (highest priority first; default tt_best, immediate_win, history). " +
			"filters: must_win (default), non_losing. root: {order: [\"non_losing\"]}. " +
			"drivers: null_window (default), mtd_f, {budget: {nodes: N}}. memo: {entries: N}. " +
			"root: {order: [\"non_losing\", \"ode\"]}, at most one estimate: \"ode\" solves the mass-action ODE of the net with every transition at rate 1 (not the net's rates) from each position the root's moves reach, to rank them. " +
			"Refused: a time budget (budget.ms), and the \"aspiration\" driver (not ported)"},
		"nodes": map[string]any{"type": "integer", "minimum": 1, "maximum": wbGameMaxNodes, "description": fmt.Sprintf("the node budget when the plan's drivers set none (default 1,000,000; at most %d here)", wbGameMaxNodes)},
		"book":  map[string]any{"type": "string", "description": "an opening book: the text of a label cache (JSONL, a header line naming the net and rules, then one position per line {mk, vals}); its positions are pinned in the table, exact"},
	}
)

func gameInput() map[string]any {
	props := map[string]any{"net": map[string]any{"type": "object", "description": "a pflow.xyz net (JSON-LD, the editor's format) with one token colour. Its marking is the position searched: the initial tokens of its places. Places and transitions are taken in id order"}}
	for k, v := range gameRulesArgs {
		props[k] = v
	}
	return obj(props, "net", "sides", "reward")
}

func gameTools() []mcpTool {
	return []mcpTool{
		{
			Name: "pflow_game_value",
			Description: "The exact value of a position of a two-sided game played on a net, from the +1 side's view, with both sides playing perfectly: pflow-native's game.value (alpha-beta over the firing rule, with a transposition table). " +
				"The game is the net read through `sides` (who owns each transition), `reward` (read off the final marking) and `auto` (transitions nobody chooses, fired first); the position is the net's marking. " +
				"Returns {value, exact, nodes, mover, moves, budget, book}; the value is null (exact false) when the search runs past its node budget (`nodes` then reports the budget). The same numbers, node counts and refusals as pflow-native for the same plan (the root estimate \"ode\" included, whose node counts can differ across platforms only if the platform's math library rounds differently). Changes nothing.",
			InputSchema: gameInput(),
			run:         mcpGameValue,
		},
		{
			Name: "pflow_game_move",
			Description: "A best move at a position of a two-sided game played on a net, and the position's exact value: pflow-native's game.move (the same search as pflow_game_value, run as `plan` names it). " +
				"It is a best move: another plan may pick another, equally good one. Past the node budget there is no move (transition null, reason \"past the budget\"), unless the plan's mode is \"play\", where the move is a guess (exact false). " +
				"Returns {transition, value, exact, nodes, budget, book}. The move is not played. The same moves, values, node counts and refusals as pflow-native for the same plan.",
			InputSchema: gameInput(),
			run:         mcpGameMove,
		},
	}
}

func mcpGameValue(_ *Server, r *http.Request, args map[string]any) (any, error) {
	return runGame("game.value", gamesearch.Value, r, args)
}

func mcpGameMove(_ *Server, r *http.Request, args map[string]any) (any, error) {
	return runGame("game.move", gamesearch.Move, r, args)
}

func runGame(id string, run func(*gamesearch.Net, map[string]any, gamesearch.Config) (map[string]any, error), r *http.Request, args map[string]any) (any, error) {
	doc, ok := args["net"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s: net: a JSON object (the editor's format) is required", id)
	}
	rest := make(map[string]any, len(args))
	for k, v := range args {
		if k != "net" {
			rest[k] = v
		}
	}
	n, err := newWBNet(doc)
	if err != nil {
		return nil, err
	}
	if n.colors != nil {
		return nil, errors.New(id + ": a net with several token colours is not supported: the search reads one token count per place")
	}
	if len(n.model.Places) > wbGameMaxNet || len(n.model.Transitions) > wbGameMaxNet {
		return nil, fmt.Errorf("%s: the net has %d places and %d transitions; at most %d of each", id, len(n.model.Places), len(n.model.Transitions), wbGameMaxNet)
	}
	marking := make(map[string]int64, len(n.places))
	for p, v := range n.start() {
		marking[p] = int64(v)
	}
	ctx := r.Context()
	cfg := gamesearch.Config{
		MaxNodes: wbGameMaxNodes,
		MaxMemo:  wbGameMaxMemo,
		Cancel:   func() error { return ctx.Err() },
	}
	out, err := run(&gamesearch.Net{Model: n.model, Marking: marking}, rest, cfg)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("%s: gave up after %s; give a node budget or a smaller net", id, mcpCallTimeout)
		}
		return nil, err
	}
	return out, nil
}
