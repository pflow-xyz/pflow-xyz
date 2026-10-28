"""Record what Chyp's own layout does, so js/layout/hypergraph.js can be checked against it.

This script imports Chyp (https://github.com/akissinger/chyp, Apache-2.0, Aleks
Kissinger) read-only from a checkout and runs, headless:

  * chyp.parser.parse            to build each hypergraph from a Chyp term,
  * chyp.layout.convex_layout    (layout.py:26-142, cvxpy, L1 objective),
  * chyp.term.layer_decomp       (term.py:30-109), captured by wrapping the name
                                 that layout.py imports, so the layers and id
                                 boxes it inserted are recorded,
  * chyp.checker.check and ProofState.rewrite_lhs for one rewrite step, to record
    which edges the match covers (what a rewrite display would highlight).

Nothing in the Chyp checkout is modified. The wrapping of `layer_decomp` and
`Problem` happens in this process's memory only. Run it with bytecode writing
off so no __pycache__ lands in the checkout:

  PYTHONDONTWRITEBYTECODE=1 <venv>/bin/python -B -I \\
      js/layout/receipts/chyp_layout_receipt.py \\
      --chyp ~/Workspace/chyp --out js/layout/receipts/chyp-layout.json

The venv needs cvxpy and lark (not PySide6: no GUI is imported).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

# Each case is Chyp source; the term named `t` is laid out. Sources are from the
# Chyp README (README.md lines cited) and examples/, plus two shapes from this
# prototype written as Chyp terms (boxes only, no semantics).
CASES = [
    ("readme_a", "README.md:58-64",
     "gen f : 2 -> 1\ngen g : 1 -> 2\ngen h : 1 -> 1\nlet t = g * h ; h * f\n"),
    ("readme_b", "README.md:66-68",
     "gen f : 2 -> 1\ngen g : 1 -> 2\nlet t = g * g ; id * sw * id ; f * f\n"),
    ("readme_ba2_step2", "README.md:163",
     "gen f : 2 -> 1\ngen g : 1 -> 2\n"
     "let t = g * g * g ; id * id * id * sw * id ; id * id * f * f ; id * sw * id ; f * f ; id * g\n"),
    ("readme_ba2_step3", "README.md:164",
     "gen f : 2 -> 1\ngen g : 1 -> 2\n"
     "let t = g * g * g ; id * id * id * sw * id ; id * g * f * f ; sw * sw * id ; id * f * id * g ; sw * sw * id ; id * f * f\n"),
    ("monoid_assoc_lhs", "README.md:204",
     "gen m : 2 -> 1\nlet t = m * id ; m\n"),
    ("monoid_eq_lhs", "README.md:208-210",
     "gen u : 0 -> 1\ngen m : 2 -> 1\nlet t = id * u * u * id ; m * m ; m\n"),
    ("frob_lhs", "examples/frobenius.chyp:22",
     "gen m : 2 -> 1\ngen n : 1 -> 2\nlet t = n * id ; id * m\n"),
    ("frobL_step2", "examples/frobenius.chyp (rewrite frobL, step 2)",
     "gen m : 2 -> 1\ngen u : 0 -> 1\ngen n : 1 -> 2\n"
     "let t = u * id * id ; n * id * id ; id * m * id ; id * m\n"),
    ("identity_wire", "this prototype: a wire straight from input to output",
     "gen f : 1 -> 1\nlet t = f * id\n"),
    ("orders_workers_payment", "this prototype: the orders/workers/payment event links as wires",
     "gen orders : 1 -> 1\ngen copy : 1 -> 2\ngen workers : 1 -> 1\ngen payment : 2 -> 1\n"
     "let t = orders ; copy ; workers * id ; sw ; payment\n"),
]

# One rewrite step (README.md:98-108): a correct step and a wrong one.
REWRITE_SRC = (
    "gen f : 2 -> 1\ngen g : 1 -> 2\n"
    "rule assoc : f * id ; f = id * f ; f\n"
    "rule bialg : f ; g = g * g ; id * sw * id ; f * f\n"
    "rewrite ba1 :\n"
    "  f * id ; f ; g ; g * id\n"
    "  = id * f ; f ; g ; g * id by assoc\n"
    "rewrite wrong :\n"
    "  f * id ; f ; g ; g * id\n"
    "  = id * f ; f ; g ; g * id by bialg\n"
)


def graph_json(g, vname=lambda v: f"v{v}", ename=lambda e: f"e{e}"):
    """A Chyp Graph as the input shape of layoutHypergraph, plus Chyp's own fields."""
    return {
        "boxes": [
            {"id": ename(e), "label": str(g.edge_data(e).value),
             "inputs": [vname(v) for v in g.source(e)],
             "outputs": [vname(v) for v in g.target(e)],
             "box_size": g.edge_data(e).box_size()}
            for e in g.edges()
        ],
        "inputs": [vname(v) for v in g.inputs()],
        "outputs": [vname(v) for v in g.outputs()],
    }


def positions(g):
    return {
        "vertices": {f"v{v}": {"x": g.vertex_data(v).x, "y": g.vertex_data(v).y} for v in g.vertices()},
        "edges": {f"e{e}": {"x": g.edge_data(e).x, "y": g.edge_data(e).y,
                            "value": str(g.edge_data(e).value),
                            "highlight": bool(g.edge_data(e).highlight)} for e in g.edges()},
    }


def chyp_objective(g, layers):
    """Recompute convex_layout's objective (layout.py:82-117) from final coordinates."""
    total = 0.0
    for vlist in (g.inputs(), g.outputs()):
        for a, b in zip(vlist, vlist[1:]):
            total += 0.1 * abs(g.vertex_data(b).y - g.vertex_data(a).y)
    for layer in layers:
        for a, b in zip(layer, layer[1:]):
            total += 0.1 * abs(g.edge_data(b).y - g.edge_data(a).y)

    def port(e, v, side):
        lst = g.target(e) if side == "t" else g.source(e)
        shift = 0.0 if len(lst) <= 1 else (lst.index(v) / (len(lst) - 1)) - 0.5
        return g.edge_data(e).y + shift

    for v in g.vertices():
        p1 = g.vertex_data(v).y
        p2 = g.vertex_data(v).y
        if g.in_edges(v):
            p1 = port(next(iter(g.in_edges(v))), v, "t")
        if g.out_edges(v):
            p2 = port(next(iter(g.out_edges(v))), v, "s")
        total += abs(p1 - p2)
    return total


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chyp", required=True, help="path to a Chyp checkout (read only)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    chyp_root = os.path.abspath(os.path.expanduser(args.chyp))
    sys.dont_write_bytecode = True
    sys.path.insert(0, chyp_root)

    import cvxpy
    import lark
    from chyp import parser, layout, checker
    from chyp.parts import Part, RewritePart
    from chyp.proofstate import ProofState, Goal
    from chyp.rule import Rule
    from chyp.matcher import find_iso

    captured_layers = []
    captured_values = []
    orig_layer_decomp = layout.layer_decomp

    def recording_layer_decomp(g):
        layers = orig_layer_decomp(g)
        captured_layers.append([list(l) for l in layers])
        return layers

    class RecordingProblem(layout.Problem):
        def solve(self, *a, **k):
            r = super().solve(*a, **k)
            captured_values.append(float(self.value))
            return r

    layout.layer_decomp = recording_layer_decomp  # in-memory only
    layout.Problem = RecordingProblem  # in-memory only

    def run_layout(g):
        captured_layers.clear()
        captured_values.clear()
        layout.convex_layout(g)
        layers = captured_layers[0] if captured_layers else []
        value = captured_values[0] if captured_values else None
        return layers, value

    try:
        rev = subprocess.run(["git", "-C", chyp_root, "rev-parse", "HEAD"],
                             capture_output=True, text=True, check=True).stdout.strip()
    except Exception as e:  # noqa: BLE001
        rev = f"unknown ({e})"

    out = {
        "generator": "js/layout/receipts/chyp_layout_receipt.py",
        "chyp": {"repo": "https://github.com/akissinger/chyp", "commit": rev, "license": "Apache-2.0"},
        "python": sys.version.split()[0], "cvxpy": cvxpy.__version__, "lark": lark.__version__,
        "solver_note": "cvxpy picks its default solver for convex_layout's problem; the value is problem.value",
        "cases": [],
    }

    for name, source_ref, code in CASES:
        st = parser.parse(code=code)
        if st.errors:
            raise SystemExit(f"{name}: parse errors {st.errors}")
        original = st.graphs["t"].copy()
        g = st.graphs["t"].copy()
        layers, value = run_layout(g)
        case = {
            "name": name, "source": source_ref, "term": code.strip().splitlines()[-1][len("let t = "):],
            "graph": graph_json(original),
            # after layer_decomp: id boxes inserted for wires that skip a layer (term.py:59-63)
            "expanded": graph_json(g),
            "layers": [[f"e{e}" for e in layer] for layer in layers],
            "layout": positions(g),
            "objective": value,
            "objective_recomputed": chyp_objective(g, layers),
        }
        out["cases"].append(case)

    # --- one rewrite step: what Chyp checks, and what a display would highlight ---
    st = parser.parse(code=REWRITE_SRC)
    if st.errors:
        raise SystemExit(f"rewrite: parse errors {st.errors}")
    checker.check(st)
    status_name = {Part.UNCHECKED: "UNCHECKED", Part.CHECKING: "CHECKING", Part.VALID: "VALID", Part.INVALID: "INVALID"}
    steps = []
    for p in st.parts:
        if isinstance(p, RewritePart):
            # Does checking leave highlight flags for the GUI to draw (graphscene.py:80-83,
            # 134-138)? At 3d28483 ruletac.py:41-48 has that code commented out.
            flagged = []
            for side, gr in (("lhs", p.lhs), ("rhs", p.rhs)):
                if gr is None:
                    continue
                flagged += [f"{side}:e{e}" for e, ed in gr.edata.items() if ed.highlight]
                flagged += [f"{side}:v{v}" for v, vd in gr.vdata.items() if vd.highlight]
            steps.append({"name": p.name, "line": p.line, "tactic": p.tactic, "args": p.tactic_args,
                          "status": status_name[p.status], "highlight_flags_after_check": flagged})
    rw_parts = [p for p in st.parts if isinstance(p, RewritePart) and p.name == "ba1"]
    p = rw_parts[0]
    ps = ProofState(st, p.sequence, [Goal(Rule(p.lhs.copy(), p.lhs.copy()))])
    matches = []
    for m_g, m_h in ps.rewrite_lhs("assoc"):
        iso = find_iso(m_h.codomain, p.rhs)
        lhs_g = p.lhs.copy()
        lhs_g.highlight(set(m_g.vertex_image), set(m_g.edge_image))
        rhs_g = m_h.codomain.copy()
        rhs_g.highlight(set(m_h.vertex_image), set(m_h.edge_image))
        lhs_layers, _ = run_layout(lhs_g)
        rhs_layers, _ = run_layout(rhs_g)
        matches.append({
            "lhs_graph": graph_json(p.lhs),
            "lhs_matched_edges": sorted(f"e{e}" for e in m_g.edge_image),
            "lhs_matched_vertices": sorted(f"v{v}" for v in m_g.vertex_image),
            "rewritten_graph": graph_json(m_h.codomain),
            "rhs_inserted_edges": sorted(f"e{e}" for e in m_h.edge_image),
            "rhs_inserted_vertices": sorted(f"v{v}" for v in m_h.vertex_image),
            "equals_stated_rhs": iso is not None,
            "lhs_layers": [[f"e{e}" for e in l] for l in lhs_layers],
            "rhs_layers": [[f"e{e}" for e in l] for l in rhs_layers],
        })
    out["rewrite"] = {"source": "README.md:98-108", "code": REWRITE_SRC, "steps": steps,
                      "rule": "assoc", "matches": matches}

    with open(args.out, "w") as f:
        json.dump(out, f, indent=1, sort_keys=False)
        f.write("\n")
    print(f"wrote {args.out}: {len(out['cases'])} layout cases, {len(matches)} assoc match(es); steps "
          + ", ".join(f"{s['name']}={s['status']}" for s in steps))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
