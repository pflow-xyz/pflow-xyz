#!/usr/bin/env python3
"""Writes the game fixtures in ../fixtures: pflow-native's bundled examples
(tic-tac-toe, connect-3, connect-4) copied as they are, and nets derived from
them or built here to reach what the examples do not:

  game-ttt-count.jsonld   tic-tac-toe whose every move also puts a token on a
                          counter place: the second move leaves 0/1 and the
                          bit engine spills to counts.
  game-ttt-double.jsonld  tic-tac-toe whose win detectors also read their first
                          cell: a second condition on one place, which the bit
                          engine counts once and the counts engine twice (the
                          deficit the "threats" order and the non_losing filter
                          read).
  game-ttt-wide.jsonld    tic-tac-toe with 230 unused places: past 256 places
                          the bit engine does not apply, so the search runs on
                          counts (128-bit Zobrist keys) from the root.
  game-nim.jsonld         Nim (take 1 or 2 from 7): a pile with more than one
                          token, an inhibitor arc, and a transition of weight 2.
  game-bucket.jsonld      players add 1 or 2 tokens to a bucket that holds 5: a
                          capacity, a weight-2 output arc and a read arc of
                          weight 5 (the player who finds it full loses).
  game-prizes-123.jsonld  prizes worth 1, 2, 3 taken in turn: 13 distinct
                          rewards, so null_window and mtd_f have gaps to work.
  game-prizes-1111.jsonld four prizes worth 1: 9 distinct rewards.

usage: make_fixtures.py PFLOW_NATIVE_CHECKOUT   (run from this directory)
"""
import json, os, sys

src = os.path.join(sys.argv[1], "examples")
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures")


def load(name):
    with open(os.path.join(src, name)) as f:
        return json.load(f)


def save(name, doc):
    with open(os.path.join(out, name), "w") as f:
        json.dump(doc, f, indent=2)
        f.write("\n")


def place(x, y, initial=0):
    return {"@type": "Place", "capacity": [None], "initial": [initial], "offset": 0, "x": x, "y": y}


def trans(x, y):
    return {"@type": "Transition", "offset": 0, "role": "default", "x": x, "y": y}


def arc(s, t, w=1, inhibit=False):
    return {"@type": "Arrow", "inhibitTransition": inhibit, "source": s, "target": t, "weight": [w]}


def shell(places, transitions, arcs):
    return {
        "@context": "https://pflow.xyz/schema",
        "@type": "PetriNet",
        "@version": "1.1",
        "arcs": arcs,
        "places": places,
        "token": ["https://pflow.xyz/tokens/black"],
        "transitions": transitions,
    }


for name in ("tic-tac-toe", "connect-3", "connect-4"):
    save(f"game-{name}.jsonld", load(f"{name}.json"))

ttt = load("tic-tac-toe.json")

d = json.loads(json.dumps(ttt))
d["places"]["n"] = place(40, 40)
for t in d["transitions"]:
    if "_play_" in t:
        d["arcs"].append(arc(t, "n"))
save("game-ttt-count.jsonld", d)

d = json.loads(json.dumps(ttt))
for t in list(d["transitions"]):
    if "_win_" in t:
        first = next(a["source"] for a in d["arcs"] if a["target"] == t)
        d["arcs"].append({"@type": "Arrow", "inhibitTransition": True, "source": t, "target": first, "weight": [1]})
save("game-ttt-double.jsonld", d)

d = json.loads(json.dumps(ttt))
for i in range(230):
    d["places"][f"pad{i:03d}"] = place(40 + 10 * (i % 20), 700 + 10 * (i // 20))
save("game-ttt-wide.jsonld", d)

save("game-nim.jsonld", shell(
    {"pile": place(100, 100, 7), "a_turn": place(100, 200, 1), "b_turn": place(300, 200),
     "win_a": place(100, 400), "win_b": place(300, 400)},
    {"a_take1": trans(100, 150), "a_take2": trans(150, 150), "b_take1": trans(300, 150),
     "b_take2": trans(350, 150), "a_lose": trans(100, 300), "b_lose": trans(300, 300)},
    [arc("pile", "a_take1"), arc("a_turn", "a_take1"), arc("a_take1", "b_turn"),
     arc("pile", "a_take2", 2), arc("a_turn", "a_take2"), arc("a_take2", "b_turn"),
     arc("pile", "b_take1"), arc("b_turn", "b_take1"), arc("b_take1", "a_turn"),
     arc("pile", "b_take2", 2), arc("b_turn", "b_take2"), arc("b_take2", "a_turn"),
     arc("a_turn", "a_lose"), arc("pile", "a_lose", 1, True), arc("a_lose", "win_b"),
     arc("b_turn", "b_lose"), arc("pile", "b_lose", 1, True), arc("b_lose", "win_a")]))


def read(t, p, w=1):
    """The editor's read arc: from the transition to the place, inhibitTransition."""
    return arc(t, p, w, True)


bucket = shell(
    {"bucket": place(200, 100), "a_turn": place(100, 200, 1), "b_turn": place(300, 200),
     "win_a": place(100, 400), "win_b": place(300, 400)},
    {"a_add1": trans(100, 150), "a_add2": trans(150, 150), "b_add1": trans(300, 150),
     "b_add2": trans(350, 150), "a_stuck": trans(100, 300), "b_stuck": trans(300, 300)},
    [arc("a_turn", "a_add1"), arc("a_add1", "b_turn"), arc("a_add1", "bucket"),
     arc("a_turn", "a_add2"), arc("a_add2", "b_turn"), arc("a_add2", "bucket", 2),
     arc("b_turn", "b_add1"), arc("b_add1", "a_turn"), arc("b_add1", "bucket"),
     arc("b_turn", "b_add2"), arc("b_add2", "a_turn"), arc("b_add2", "bucket", 2),
     arc("a_turn", "a_stuck"), read("a_stuck", "bucket", 5), arc("a_stuck", "win_b"),
     arc("b_turn", "b_stuck"), read("b_stuck", "bucket", 5), arc("b_stuck", "win_a")])
bucket["places"]["bucket"]["capacity"] = [5]
save("game-bucket.jsonld", bucket)


def prizes(weights):
    places = {"x_turn": place(100, 100, 1), "o_turn": place(300, 100)}
    transitions, arcs = {}, []
    for i, w in enumerate(weights):
        places[f"prize{i}"] = place(200, 200 + 60 * i, 1)
        for s, (me, them) in (("x", ("x_turn", "o_turn")), ("o", ("o_turn", "x_turn"))):
            places[f"{s}{i}"] = place(100 if s == "x" else 300, 200 + 60 * i)
            t = f"{s}_take{i}"
            transitions[t] = trans(100 if s == "x" else 300, 150 + 60 * i)
            arcs += [arc(f"prize{i}", t), arc(me, t), arc(t, f"{s}{i}"), arc(t, them)]
    return shell(places, transitions, arcs)


save("game-prizes-123.jsonld", prizes([1, 2, 3]))
save("game-prizes-1111.jsonld", prizes([1, 1, 1, 1]))
