#!/usr/bin/env python3
"""Writes ../game_cases.json, the input of this generator: what positions of
what fixtures game.value and game.move are asked about, under which plans.
Edit here, run `python3 make_cases.py`, then `make game-goldens`.
"""
import json, os

here = os.path.dirname(os.path.abspath(__file__))

RULES = {
    # Keys are written in sorted order: the Go tool reads a JSON object's
    # members in sorted order, native in the order written.
    "ttt": {"auto": ["o_win_", "x_win_"], "reward": {"win_o": -1, "win_x": 1}, "sides": {"o_": -1, "x_": 1}},
    "nim": {"auto": ["a_lose", "b_lose"], "reward": {"win_a": 1, "win_b": -1}, "sides": {"a_take": 1, "b_take": -1}},
    "bucket": {"auto": ["a_stuck", "b_stuck"], "reward": {"win_a": 1, "win_b": -1}, "sides": {"a_add": 1, "b_add": -1}},
    "cnim": {"auto": ["a_lose", "b_lose"], "reward": {"win_a": 1, "win_b": -1}, "sides": {"a_": 1, "b_": -1}},
    # A reward of one place: two distinct rewards, so a value is one search
    # over the range and aspiration starts from a window around the guess.
    "nim-a": {"auto": ["a_lose", "b_lose"], "reward": {"win_a": 1}, "sides": {"a_take": 1, "b_take": -1}},
    # Eighteen reward places: more than a search steps through value by value.
    "ttt-cells": {"auto": ["o_win_", "x_win_"],
                  "reward": {f"{s}{r}{c}": w for s, w in (("o", -1), ("x", 1)) for r in range(3) for c in range(3)},
                  "sides": {"o_": -1, "x_": 1}},
    "prizes-123": {"reward": {"o0": -1, "o1": -2, "o2": -3, "x0": 1, "x1": 2, "x2": 3}, "sides": {"o_take": -1, "x_take": 1}},
    "prizes-1111": {"reward": {"o0": -1, "o1": -1, "o2": -1, "o3": -1, "x0": 1, "x1": 1, "x2": 1, "x3": 1}, "sides": {"o_take": -1, "x_take": 1}},
}


def calls(plans, tools=("game.value", "game.move")):
    out = []
    for label, args in plans:
        for tool in tools:
            out.append({"name": f"{tool.split('.')[1]}-{label}", "tool": tool, "args": args})
    return out


def plan(label, **p):
    return (label, {"plan": p})


def budget(n):
    return {"budget": {"nodes": n}}


# Every exact piece, each alone and in combination.
MATRIX = [
    ("default", {}),
    plan("empty-plan"),
    plan("order-hist", order=["history"]),
    plan("order-none", order=[]),
    plan("order-ttb", order=["tt_best"]),
    plan("order-iw-ttb", order=["immediate_win", "tt_best", "history"]),
    plan("order-cent", order=["tt_best", "immediate_win", "centrality", "history"]),
    plan("order-threats", order=["threats", "tt_best"]),
    plan("order-cent-threats", order=["centrality", "threats", "immediate_win"]),
    plan("filters-none", filters=[]),
    plan("filters-mw", filters=["must_win"]),
    plan("filters-nl", filters=["non_losing"]),
    plan("filters-both", filters=["must_win", "non_losing"]),
    plan("filters-both-cent", filters=["non_losing", "must_win"], order=["tt_best", "centrality", "threats"]),
    plan("root-nl", root={"order": ["non_losing"]}),
    plan("root-nl-filters-none", root={"order": ["non_losing"]}, filters=[]),
    plan("root-empty", root={"order": []}),
    plan("drivers-none", drivers=[]),
    plan("drivers-nw", drivers=["null_window"]),
    plan("drivers-mtdf", drivers=["mtd_f"]),
    plan("drivers-mtdf-filters-none", drivers=["mtd_f"], filters=[]),
    plan("drivers-mtdf-nl", drivers=["mtd_f"], filters=["non_losing"], root={"order": ["non_losing"]}),
    plan("drivers-budget", drivers=[budget(100000)]),
    plan("drivers-nw-budget", drivers=["null_window", budget(100000)]),
    plan("drivers-mtdf-budget", drivers=[budget(100000), "mtd_f"]),
    plan("memo-1", memo={"entries": 1}),
    plan("memo-2", memo={"entries": 2}),
    plan("memo-7", memo={"entries": 7}),
    plan("memo-16", memo={"entries": 16}),
    plan("memo-100", memo={"entries": 100}),
    plan("memo-5000", memo={"entries": 5000}),
    plan("memo-16-mtdf-nofilters", memo={"entries": 16}, drivers=["mtd_f"], filters=[]),
    plan("memo-64-hist", memo={"entries": 64}, order=["history"], filters=[]),
    plan("mode-exact", mode="exact"),
    plan("mode-play", mode="play"),
    plan("heuristics-empty", heuristics=[]),
    ("nodes-1", {"nodes": 1}),
    ("nodes-5", {"nodes": 5}),
    ("nodes-40", {"nodes": 40}),
    ("nodes-300", {"nodes": 300}),
    ("nodes-2000", {"nodes": 2000}),
    ("nodes-5-play", {"nodes": 5, "plan": {"mode": "play"}}),
    ("nodes-40-play", {"nodes": 40, "plan": {"mode": "play"}}),
    ("nodes-40-play-nl", {"nodes": 40, "plan": {"mode": "play", "root": {"order": ["non_losing"]}}}),
    ("nodes-40-play-mtdf", {"nodes": 40, "plan": {"mode": "play", "drivers": ["mtd_f"]}}),
    ("plan-string", {"plan": json.dumps({"order": ["history"], "drivers": ["mtd_f"]})}),
    ("plan-string-nodes", {"plan": "{}", "nodes": 77}),
    ("plan-null", {"plan": None}),
    ("nodes-float", {"nodes": 500.0}),
]

# A smaller set for every position of a sweep.
SWEEP = [
    ("default", {}),
    plan("filters-both", filters=["must_win", "non_losing"]),
    plan("root-nl", root={"order": ["non_losing"]}),
    plan("mtdf", drivers=["mtd_f"]),
    plan("cent", order=["tt_best", "immediate_win", "centrality", "threats", "history"]),
    plan("memo-32", memo={"entries": 32}),
    ("nodes-60", {"nodes": 60}),
]

def ode(label, root=("ode",), **p):
    return plan(label, root={"order": list(root)}, **p)


# The root estimate "ode" (the mass-action ODE, solved at the root once per
# move) and the aspiration driver that starts from its best guess.
ODE = [
    ode("root-ode"),
    ode("root-ode-nl", root=("ode", "non_losing")),
    ode("root-nl-ode", root=("non_losing", "ode")),
    ode("aspiration-ode", drivers=["aspiration", "null_window"]),
    ode("mtdf-aspiration-ode", drivers=["mtd_f", "aspiration"]),
    ode("aspiration-only-ode", drivers=["aspiration"]),
    ode("no-driver-ode", drivers=[]),
    ode("mtdf-ode", drivers=["mtd_f"]),
    ode("ode-cent", order=["tt_best", "immediate_win", "centrality", "threats", "history"]),
    ode("ode-filters-none", filters=[]),
    ode("ode-nl-filters", filters=["must_win", "non_losing"], drivers=["aspiration", "null_window"]),
    ode("aspiration-ode-memo-16", drivers=["aspiration", "null_window"], memo={"entries": 16}),
    ode("mtdf-aspiration-ode-memo-16", drivers=["aspiration", "mtd_f"], memo={"entries": 16}, filters=[]),
    ode("aspiration-ode-nl-root", root=("non_losing", "ode"), drivers=["aspiration", "mtd_f"]),
    ("nodes-40-ode", {"nodes": 40, "plan": {"root": {"order": ["ode"]}}}),
    ("nodes-300-aspiration-ode", {"nodes": 300, "plan": {"root": {"order": ["ode"]}, "drivers": ["aspiration"]}}),
    ("nodes-40-play-ode", {"nodes": 40, "plan": {"mode": "play", "root": {"order": ["ode"]}}}),
    ("nodes-5-play-ode", {"nodes": 5, "plan": {"mode": "play", "root": {"order": ["ode"]}}}),
    ("nodes-60-play-aspiration-ode", {"nodes": 60, "plan": {"mode": "play", "root": {"order": ["ode"]}, "drivers": ["aspiration", "mtd_f"]}}),
    ("plan-string-ode", {"plan": json.dumps({"root": {"order": ["ode"]}, "drivers": ["aspiration"]})}),
]
# A smaller set, for the nets and the sweeps where each call is dear.
SWEEP_NAMES = ["root-ode", "root-ode-nl", "aspiration-ode", "mtdf-aspiration-ode", "aspiration-only-ode", "ode-cent",
               "aspiration-ode-nl-root", "nodes-40-ode", "nodes-40-play-ode"]
ODE_SWEEP = [c for c in ODE if c[0] in SWEEP_NAMES]

# What both refuse, with the same words.
REFUSED = [
    ("bad-order-piece", {"plan": {"order": ["bogus"]}}),
    ("order-is-a-filter", {"plan": {"order": ["must_win"]}}),
    ("order-twice", {"plan": {"order": ["history", "history"]}}),
    ("order-too-long", {"plan": {"order": ["tt_best", "immediate_win", "history", "centrality", "threats", "tt_best", "history", "history", "tt_best"]}}),
    ("bad-filter", {"plan": {"filters": ["beam"]}}),
    ("filter-twice", {"plan": {"filters": ["must_win", "must_win"]}}),
    ("filter-unknown", {"plan": {"filters": ["nope"]}}),
    ("heuristic-static-eval", {"plan": {"heuristics": ["static_eval"]}}),
    ("heuristic-static-eval-play", {"plan": {"heuristics": ["static_eval"], "mode": "play"}}),
    ("heuristic-unknown", {"plan": {"heuristics": ["nope"]}}),
    ("driver-unknown", {"plan": {"drivers": ["nope"]}}),
    ("driver-twice", {"plan": {"drivers": ["null_window", "null_window"]}}),
    ("driver-mtdf-twice", {"plan": {"drivers": ["mtd_f", "mtd_f"]}}),
    ("driver-both-windows", {"plan": {"drivers": ["null_window", "mtd_f"]}}),
    ("driver-budget-twice", {"plan": {"drivers": [budget(10), budget(20)]}}),
    ("driver-budget-bare", {"plan": {"drivers": ["budget"]}}),
    ("driver-budget-empty", {"plan": {"drivers": [{"budget": {}}]}}),
    ("driver-budget-zero", {"plan": {"drivers": [budget(0)]}}),
    ("driver-two-keys", {"plan": {"drivers": [{"budget": {"nodes": 5}, "mtd_f": {}}]}}),
    ("driver-number", {"plan": {"drivers": [5]}}),
    ("driver-args", {"plan": {"drivers": [{"null_window": {}}]}}),
    ("driver-is-order", {"plan": {"drivers": ["history"]}}),
    ("aspiration-no-estimate", {"plan": {"drivers": ["aspiration"]}}),
    ("budget-ms", {"plan": {"drivers": [{"budget": {"nodes": 1000, "ms": 50}}]}}),
    ("budget-ms-only", {"plan": {"drivers": [{"budget": {"ms": 50}}]}}),
    ("budget-over-cap", {"plan": {"drivers": [budget(200000000)]}}),
    ("budget-and-nodes", {"plan": {"drivers": [budget(10)]}, "nodes": 10}),
    ("nodes-over-cap", {"nodes": 200000000}),
    ("nodes-zero", {"nodes": 0}),
    ("nodes-negative", {"nodes": -3}),
    ("nodes-fraction", {"nodes": 2.5}),
    ("nodes-string", {"nodes": "ten"}),
    ("memo-over-cap", {"plan": {"memo": {"entries": 1 << 24}}}),
    ("memo-zero", {"plan": {"memo": {"entries": 0}}}),
    ("memo-no-entries", {"plan": {"memo": {}}}),
    ("memo-unknown-field", {"plan": {"memo": {"entries": 4, "bits": 2}}}),
    ("root-unknown", {"plan": {"root": {"order": ["nope"]}}}),
    ("root-twice", {"plan": {"root": {"order": ["non_losing", "non_losing"]}}}),
    ("root-is-filter", {"plan": {"root": {"order": ["must_win"]}}}),
    ("root-two-estimates", {"plan": {"root": {"order": ["ode", "ode"]}}}),
    ("root-estimate-is-a-driver", {"plan": {"root": {"order": ["aspiration"]}}}),
    ("aspiration-estimate-in-order", {"plan": {"order": ["ode"], "drivers": ["aspiration"]}}),
    ("estimate-as-filter", {"plan": {"filters": ["ode"]}}),
    ("root-no-order", {"plan": {"root": {}}}),
    ("plan-unknown-field", {"plan": {"orders": []}}),
    ("plan-bad-mode", {"plan": {"mode": "fast"}}),
    ("plan-order-not-list", {"plan": {"order": "history"}}),
    ("plan-order-not-strings", {"plan": {"order": [1]}}),
    ("plan-drivers-not-list", {"plan": {"drivers": "mtd_f"}}),
    ("plan-not-object", {"plan": [1, 2]}),
    ("plan-number", {"plan": 5}),
    ("plan-string-not-object", {"plan": "[1]"}),
    ("unknown-argument", {"depth": 3}),
    ("bad-auto-type", {"auto": "x_win_"}),
    ("bad-auto-prefix", {"auto": ["nothing_"]}),
    ("bad-sides-prefix", {"sides": {"zzz": 1}}),
    ("bad-sides-sign", {"sides": {"x_": "yes", "o_": -1}}),
    ("bad-sides-type", {"sides": [1]}),
    ("sides-string", {"sides": "{\"x_\": 1, \"o_\": -1}"}),
    ("sides-bad-string", {"sides": "x_"}),
    ("missing-sides", {"sides": None}),
    ("missing-reward", {"reward": None}),
    ("bad-reward-place", {"reward": {"nowhere": 1}}),
    ("bad-reward-weight", {"reward": {"win_x": "one"}}),
    ("reward-type", {"reward": 3}),
    ("reward-string", {"reward": "{\"win_x\": 1, \"win_o\": -1}"}),
    ("one-side-only", {"sides": {"x_": 1}}),
    ("no-sides-at-all", {"sides": {}}),
    ("reward-too-big", {"reward": {"win_x": 5, "win_o": -1}}),
    ("book-not-string", {"book": 3}),
]


def sweep(seed, plies, count):
    return {"random": {"seed": seed, "plies": plies, "count": count}}


sets = []

TTT = "native/fixtures/game-tic-tac-toe.jsonld"
sets.append({"name": "ttt-matrix", "fixture": TTT, "rules": "ttt",
             "positions": [{"initial": True}, {"fire": ["x_play_11", "o_play_00"]}, sweep(3, 6, 1)],
             "calls": calls(MATRIX)})
sets.append({"name": "ttt-sweep", "fixture": TTT, "rules": "ttt",
             "positions": [sweep(11, 9, 8), sweep(12, 5, 3)],
             "calls": calls(SWEEP)})
sets.append({"name": "ttt-final", "fixture": TTT, "rules": "ttt",
             "positions": [{"fire": ["x_play_00", "o_play_01", "x_play_11", "o_play_02", "x_play_22"]},
                           {"fire": ["x_play_00", "o_play_01", "x_play_02", "o_play_11", "x_play_10", "o_play_12", "x_play_21", "o_play_20", "x_play_22"]}],
             "calls": calls([
                 ("default", {}),
                 plan("play", mode="play"),
                 plan("ode", root={"order": ["ode"]}),
                 plan("aspiration-ode", root={"order": ["ode"]}, drivers=["aspiration"]),
             ])})
sets.append({"name": "ttt-ode", "fixture": TTT, "rules": "ttt",
             "positions": [{"initial": True}, {"fire": ["x_play_11"]}, {"fire": ["x_play_11", "o_play_00"]}, sweep(91, 9, 8)],
             "calls": calls(ODE)})
sets.append({"name": "ttt-refused", "fixture": TTT, "rules": "ttt",
             "positions": [{"initial": True}],
             "calls": calls(REFUSED, tools=("game.value",)) + calls(REFUSED[:12], tools=("game.move",))})

sets.append({"name": "connect3", "fixture": "native/fixtures/game-connect-3.jsonld", "rules": "ttt",
             "positions": [sweep(21, 12, 3), sweep(22, 6, 1)],
             "calls": calls(MATRIX[:2] + MATRIX[6:9] + MATRIX[10:16] + MATRIX[17:21] + MATRIX[23:26] + [("nodes-300", {"nodes": 300}), ("nodes-5000", {"nodes": 5000}), ("nodes-5000-play", {"nodes": 5000, "plan": {"mode": "play"}})])})
sets.append({"name": "connect3-start", "fixture": "native/fixtures/game-connect-3.jsonld", "rules": "ttt",
             "positions": [{"initial": True}],
             "calls": calls([("default", {}), ("nodes-3000", {"nodes": 3000}), ("nodes-3000-play", {"nodes": 3000, "plan": {"mode": "play"}})])})
sets.append({"name": "connect3-ode", "fixture": "native/fixtures/game-connect-3.jsonld", "rules": "ttt",
             "positions": [{"initial": True}, sweep(23, 14, 3)],
             "calls": calls(ODE_SWEEP + [
                 ("nodes-5000-ode", {"nodes": 5000, "plan": {"root": {"order": ["ode"]}}}),
                 ("nodes-5000-aspiration-ode", {"nodes": 5000, "plan": {"root": {"order": ["ode"]}, "drivers": ["aspiration"]}}),
             ])})
sets.append({"name": "connect4", "fixture": "native/fixtures/game-connect-4.jsonld", "rules": "ttt",
             "positions": [sweep(31, 40, 4), {"initial": True}],
             "calls": calls([("default-nodes-4000", {"nodes": 4000}),
                             ("cent-nodes-4000", {"nodes": 4000, "plan": {"order": ["tt_best", "immediate_win", "centrality", "threats", "history"]}}),
                             ("nl-nodes-4000", {"nodes": 4000, "plan": {"root": {"order": ["non_losing"]}, "filters": []}}),
                             ("mtdf-nodes-4000", {"nodes": 4000, "plan": {"drivers": ["mtd_f"]}}),
                             ("play-nodes-4000", {"nodes": 4000, "plan": {"mode": "play"}}),
                             ("ode-nodes-4000", {"nodes": 4000, "plan": {"root": {"order": ["ode"]}}}),
                             ("ode-nl-nodes-4000", {"nodes": 4000, "plan": {"root": {"order": ["ode", "non_losing"]}, "filters": []}}),
                             ("aspiration-ode-nodes-4000", {"nodes": 4000, "plan": {"root": {"order": ["ode"]}, "drivers": ["aspiration", "null_window"]}}),
                             ("mtdf-aspiration-ode-nodes-4000", {"nodes": 4000, "plan": {"root": {"order": ["ode"]}, "drivers": ["aspiration", "mtd_f"]}}),
                             ("play-ode-nodes-4000", {"nodes": 4000, "plan": {"mode": "play", "root": {"order": ["ode"]}}})])})

sets.append({"name": "ttt-count", "fixture": "native/fixtures/game-ttt-count.jsonld", "rules": "ttt",
             "positions": [{"initial": True}, {"fire": ["x_play_00"]}, sweep(41, 7, 3)],
             "calls": calls(SWEEP + [plan("mtdf-filters-none", drivers=["mtd_f"], filters=[]), plan("memo-8", memo={"entries": 8})])})
sets.append({"name": "ttt-double", "fixture": "native/fixtures/game-ttt-double.jsonld", "rules": "ttt",
             "positions": [{"initial": True}, sweep(81, 9, 6)],
             "calls": calls(SWEEP + [plan("threats", order=["threats"]), plan("threats-nl", order=["threats", "history"], filters=["non_losing"]),
                                     plan("threats-mtdf", order=["tt_best", "threats"], drivers=["mtd_f"], root={"order": ["non_losing"]})])})
sets.append({"name": "ttt-wide", "fixture": "native/fixtures/game-ttt-wide.jsonld", "rules": "ttt",
             "positions": [{"initial": True}, sweep(51, 7, 2)],
             "calls": calls(SWEEP + MATRIX[10:13] + MATRIX[25:32])})
sets.append({"name": "nim", "fixture": "native/fixtures/game-nim.jsonld", "rules": "nim",
             "positions": [{"initial": True}, {"fire": ["a_take1"]}, {"fire": ["a_take2", "b_take2"]}, {"fire": ["a_take2", "b_take1", "a_take1"]}],
             "calls": calls(SWEEP + [plan("filters-none", filters=[]), plan("memo-3", memo={"entries": 3}), plan("hist", order=["history"])])})
sets.append({"name": "bucket", "fixture": "native/fixtures/game-bucket.jsonld", "rules": "bucket",
             "positions": [{"initial": True}, {"fire": ["a_add1"]}, {"fire": ["a_add2", "b_add2"]}, {"fire": ["a_add1", "b_add1", "a_add1"]}, {"fire": ["a_add2", "b_add2", "a_add1"]}],
             "calls": calls(SWEEP + [plan("filters-none", filters=[]), plan("mtdf-nofilters", drivers=["mtd_f"], filters=[]),
                                     plan("memo-3", memo={"entries": 3}), plan("order-cent", order=["centrality", "threats"]),
                                     plan("order-cent-nl", order=["threats", "history"], filters=["non_losing"], root={"order": ["non_losing"]})])})
sets.append({"name": "nim-ode", "fixture": "native/fixtures/game-nim.jsonld", "rules": "nim",
             "positions": [{"initial": True}, {"fire": ["a_take1"]}, {"fire": ["a_take2", "b_take2"]}, {"fire": ["a_take2", "b_take1", "a_take1"]}, sweep(111, 5, 4)],
             "calls": calls(ODE)})
sets.append({"name": "nim-ode-two-rewards", "fixture": "native/fixtures/game-nim.jsonld", "rules": "nim-a",
             "positions": [{"initial": True}, {"fire": ["a_take1"]}, sweep(112, 5, 4)],
             "calls": calls([("default", {})] + ODE)})
sets.append({"name": "bucket-ode", "fixture": "native/fixtures/game-bucket.jsonld", "rules": "bucket",
             "positions": [{"initial": True}, {"fire": ["a_add1"]}, {"fire": ["a_add2", "b_add2"]}, {"fire": ["a_add1", "b_add1", "a_add1"]}, sweep(113, 4, 4)],
             "calls": calls(ODE)})
for k in ("ttt-count", "ttt-double", "ttt-wide"):
    sets.append({"name": k + "-ode", "fixture": f"native/fixtures/game-{k}.jsonld", "rules": "ttt",
                 "positions": [{"initial": True}, {"fire": ["x_play_00"]}, sweep(121, 7, 3)],
                 "calls": calls(ODE_SWEEP)})
sets.append({"name": "ttt-cells-ode", "fixture": TTT, "rules": "ttt-cells",
             "positions": [{"fire": ["x_play_11", "o_play_00", "x_play_02", "o_play_20"]}, sweep(131, 8, 4)],
             "calls": calls([("default-nodes-20000", {"nodes": 20000})] + [(n + "-nodes-20000", dict(a, nodes=20000)) for n, a in ODE_SWEEP])})
for k in ("prizes-123", "prizes-1111"):
    sets.append({"name": k, "fixture": f"native/fixtures/game-{k}.jsonld", "rules": k,
                 "positions": [{"initial": True}, sweep(61, 3, 3)],
                 "calls": calls([("default", {}), plan("nw", drivers=["null_window"]), plan("mtdf", drivers=["mtd_f"]),
                                 plan("none", drivers=[]), plan("mtdf-nofilters", drivers=["mtd_f"], filters=[]),
                                 plan("mtdf-memo-6", drivers=["mtd_f"], memo={"entries": 6}),
                                 plan("nw-memo-6", memo={"entries": 6}), plan("filters-both", filters=["must_win", "non_losing"]),
                                 plan("root-nl", root={"order": ["non_losing"]}), plan("mtdf-root-nl", drivers=["mtd_f"], root={"order": ["non_losing"]}),
                                 plan("order-cent", order=["centrality"]), ("nodes-8", {"nodes": 8}), ("nodes-8-mtdf", {"nodes": 8, "plan": {"drivers": ["mtd_f"]}})] + ODE)})

# Coloured nets: a place with a count per token colour, unfolded to a place per
# colour copy. Rewards name a place (every copy) or a copy ("win_a.red").
CNIM = [("default", {}), plan("filters-both", filters=["must_win", "non_losing"]), plan("root-nl", root={"order": ["non_losing"]}),
        plan("mtdf", drivers=["mtd_f"]), plan("cent", order=["tt_best", "immediate_win", "centrality", "threats", "history"]),
        plan("memo-8", memo={"entries": 8}), ("nodes-20", {"nodes": 20}), ("nodes-20-play", {"nodes": 20, "plan": {"mode": "play"}}),
        ("reward-red", {"reward": {"win_a.red": 1, "win_b.red": -1}}),
        ("reward-mixed", {"reward": {"win_a.blue": 1, "win_b.red": -1}}),
        ("reward-weights", {"reward": {"win_a": 1.5, "win_b.blue": -2}}),
        ("reward-mixed-mtdf", {"reward": {"win_a.blue": 1, "win_b.red": -1}, "plan": {"drivers": ["mtd_f"]}}),
        ("reward-no-copy", {"reward": {"win_a.green": 1}}),
        ("reward-no-place", {"reward": {"nope": 1}}),
        ("sides-prefix", {"sides": {"a_take_r": 1, "b_take_r": -1, "a_take_b": 1, "b_take_b": -1, "a_take_rb": 1, "b_take_rb": -1}}),
        ("book-refused", {"book": "x"})]
for name, fixture in (("colored-nim", "game-colored-nim"), ("colored-spare", "game-colored-spare")):
    sets.append({"name": name, "fixture": f"native/fixtures/{fixture}.jsonld", "rules": "cnim",
                 "positions": [{"initial": True}, {"fire": ["a_take_r2"]}, {"fire": ["a_take_rb", "b_take_r1", "a_take_b1"]}, sweep(101, 8, 5)],
                 "calls": calls(CNIM + ODE_SWEEP)})
sets.append({"name": "colored-nim-ode", "fixture": "native/fixtures/game-colored-nim.jsonld", "rules": "cnim",
             "positions": [{"initial": True}, sweep(102, 6, 6)],
             "calls": calls(ODE)})
sets.append({"name": "colored-nim3", "fixture": "native/fixtures/game-colored-nim3.jsonld", "rules": "cnim",
             "positions": [{"initial": True}, {"fire": ["a_take_rg"]}, sweep(103, 8, 5)],
             "calls": calls(CNIM[:8] + [("reward-green", {"reward": {"win_a.green": 1, "win_b.blue": -1}})] + ODE_SWEEP)})


# Books: label caches built by the generator from native's own values.
BOOK_POS = [{"initial": True}, {"fire": ["x_play_11"]}, {"fire": ["x_play_11", "o_play_00"]}]
def book(**kw):
    return {"$book": dict(positions=BOOK_POS, **kw)}
sets.append({"name": "ttt-book", "fixture": TTT, "rules": "ttt",
             "positions": [{"initial": True}, {"fire": ["x_play_11"]}, sweep(71, 4, 1)],
             "calls": calls([("book", {"book": book()}),
                             ("book-nodes-3", {"book": book(), "nodes": 3}),
                             ("book-mtdf", {"book": book(), "plan": {"drivers": ["mtd_f"]}}),
                             ("book-memo-4", {"book": book(), "plan": {"memo": {"entries": 4}}}),
                             ("book-root-nl", {"book": book(), "plan": {"root": {"order": ["non_losing"]}}}),
                             ("book-play-nodes-3", {"book": book(), "nodes": 3, "plan": {"mode": "play"}})])})
sets.append({"name": "ttt-book-refused", "fixture": TTT, "rules": "ttt",
             "positions": [{"initial": True}],
             "calls": calls([("book-bad-header", {"book": book(mutate="header")}),
                             ("book-header-sign", {"book": book(mutate="sign")}),
                             ("book-final-line", {"book": book(mutate="final")}),
                             ("book-short-vals", {"book": book(mutate="short")}),
                             ("book-wrong-marking", {"book": book(mutate="marking")}),
                             ("book-cut-last", {"book": book(mutate="cut")}),
                             ("book-bad-middle", {"book": book(mutate="middle")}),
                             ("book-null-vals", {"book": book(mutate="null")}),
                             ("book-empty", {"book": ""}),
                             ("book-not-json", {"book": "not json"})], tools=("game.value",))})

with open(os.path.join(here, "..", "game_cases.json"), "w") as f:
    json.dump({"_comment": "Input of parity/native/gen-game (make game-goldens); written by gen-game/make_cases.py. See the generator's header for the shapes.",
               "rules": RULES, "sets": sets}, f, indent=1)
    f.write("\n")
print(sum(len(s["calls"]) for s in sets), "calls over", len(sets), "sets")
