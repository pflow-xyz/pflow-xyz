"""diagrams: every gen, rule side and rewrite step of a theory as a JSON hypergraph.

Shape of one diagram (ids are strings, 'v<n>' for Chyp vertex n and 'e<n>' for
Chyp hyperedge n, so they agree between the two sides of a step):

    {
      "term":     Chyp's graph_to_term of the graph (Chyp's normal printing),
      "vertices": [{"id", "type", "size"?, "x"?, "y"?, "route"?}],
      "edges":    [{"id", "label", "inputs": [vertexId], "outputs": [vertexId],
                    "x"?, "y"?, "w"?, "h"?}],
      "inputs":   [vertexId],            # left boundary, top to bottom
      "outputs":  [vertexId],            # right boundary, top to bottom
      "hypergraph": {"boxes": [{"id", "inputs", "outputs"}],
                     "inputs": [vertexId], "outputs": [vertexId]},
      "layout":   "chyp" | "none",
      "layers"?:  [[edgeId]],            # Chyp's box layers, left to right, top to bottom
      "bounds"?:  {"xmin", "xmax", "ymin", "ymax"},
      "layout_error"?: "..."             # Chyp's layout raised; no coordinates
    }

Mapping (Chyp -> this JSON -> js/layout/hypergraph.js):
  - Chyp vertex (a wire) -> "vertices" entry -> a vertex id. type is Chyp's
    vertex type (null = Chyp's default type); size its register size, only
    when it is not 1;
  - Chyp hyperedge (a box) -> "edges" entry -> a box. label is the generator's
    name; inputs/outputs are Chyp's ordered EData.s / EData.t. The generator's
    colours (Chyp's fg/bg) are listed once per label in diagrams()['styles'];
  - Chyp's boundary Graph.inputs()/outputs() -> inputs/outputs -> the same;
  - "hypergraph" is that topology in layoutHypergraph's input format,
    {boxes: [{id, inputs, outputs}], inputs, outputs}, ready to lay out.
The topology is the same for both layouts.

With layout='chyp' the coordinates are Chyp's own: chyp.layout.convex_layout
(term.layer_decomp, then an L1 program solved by cvxpy) run on a copy of the
graph. Units are Chyp's: box layers 3.0 apart in x, boundary wires >= 1.0 apart
in y, y grows downward; Chyp's GUI draws 50 px per unit. (x, y) of a box is its
centre; w, h are the size Chyp's GUI draws it (1.1 x 0.8 when it has at most
one port per side, else 1.1 x 1.6: chyp/gui/graphscene.py:29-31, 60-66,
restated, not imported). A vertex's (x, y) is where Chyp puts it: on the left
or right boundary for inputs/outputs, else 0.7 right of its producer's port.
layer_decomp makes every wire cross one layer at a time by inserting identity
boxes (Graph.insert_id_after), which Chyp's GUI draws invisible; they are not
listed as edges here. Instead a wire that crosses several layers gets "route":
the [x, y] points it passes after its own vertex (each identity box's centre,
then the vertex after it), ending at its output position when it is an output.
"layers" are the real boxes per layer (usable as hypergraph.js's layerOrder).

With layout='none' (or when cvxpy cannot be imported) there are no
coordinates, routes, layers or bounds.

In diagrams()['rewrites'] each rewrite lists its graphs once, in "graphs"
(Chyp builds step k+1's before-graph as a copy of step k's after-graph, so they
are shared), and each step names them by index: "before", "after". A step also
carries "match": which part of the before-graph the rule's lhs matched and
which part of the after-graph it inserted, as Chyp's own rule tactic finds it
(step_match). Chyp 3d28483's GUI does not highlight this (the calls are
commented out in chyp/tactic/ruletac.py:41-48), so a page can.
"""
from __future__ import annotations

from typing import Any

from . import _chyp
from ._chyp import (GenPart, Goal, Graph, Part, ProofState, ProofStepPart,
                    RewritePart, Rule, RulePart, find_iso)
from .checking import CheckReport, check
from .theory import Theory, term_of

# Chyp's GUI geometry (chyp/gui/graphscene.py:29-31 BOX_WIDTH = 1.1; 60-66 heights).
BOX_W = 1.1
BOX_H = {1: 0.8, 2: 1.6}

UNITS = ("Chyp layout units (chyp/layout.py): box layers 3.0 apart in x, boundary "
         "wires >= 1.0 apart in y, y grows downward; Chyp's GUI draws 50 px per unit "
         "(chyp/gui/graphscene.py:29)")


def _num(x: Any, precision: int | None) -> float:
    v = float(x)
    if precision is not None:
        v = round(v, precision)
    return 0.0 if v == 0 else v


def topology(g: Graph) -> dict[str, Any]:
    """The graph in js/layout/hypergraph.js's input format (no coordinates)."""
    return {
        'boxes': [{'id': f'e{e}',
                   'inputs': [f'v{v}' for v in g.source(e)],
                   'outputs': [f'v{v}' for v in g.target(e)]}
                  for e in sorted(g.edges())],
        'inputs': [f'v{v}' for v in g.inputs()],
        'outputs': [f'v{v}' for v in g.outputs()],
    }


def layout_copy(g: Graph) -> Graph:
    """A copy of g laid out by chyp.layout.convex_layout (which mutates its
    argument: layer_decomp inserts identity boxes). Needs cvxpy."""
    layout = _chyp.import_layout()
    h = g.copy()
    layout.convex_layout(h)
    return h


def _route(h: Graph, v: int, orig_e: set[int], precision: int | None) -> list[list[float]]:
    """The points a wire passes after its own vertex, through the identity boxes
    layer_decomp inserted after it (Graph.insert_id_after: v -> id box -> new w,
    w taking over v's consumers and output positions): box centre, then w."""
    pts: list[list[float]] = []
    seen: set[int] = set()
    while True:
        nxt = [e for e in sorted(h.out_edges(v)) if e not in orig_e]
        if not nxt or nxt[0] in seen:
            return pts
        e = nxt[0]
        seen.add(e)
        ed = h.edge_data(e)
        pts.append([_num(ed.x, precision), _num(ed.y, precision)])
        t = h.target(e)
        if not t:
            return pts
        v = t[0]
        vd = h.vertex_data(v)
        pts.append([_num(vd.x, precision), _num(vd.y, precision)])


def graph_dict(g: Graph | None, *, layout: str = 'none', precision: int | None = 3,
               colors: bool = True) -> dict[str, Any] | None:
    """One Chyp graph as the documented diagram dict (see the module docstring).

    colors: put each box's fg/bg on its edge (diagrams() leaves them out and
    lists them once per label in 'styles' instead)."""
    if g is None:
        return None
    h = None
    err = None
    if layout == 'chyp':
        try:
            h = layout_copy(g)
        except ImportError:
            raise
        except Exception as e:  # noqa: BLE001  (layer_decomp refuses cycles; solver failures)
            err = f'{type(e).__name__}: {e}'
    orig_e = set(g.edges())
    vertices = []
    for v in sorted(g.vertices()):
        vd = g.vertex_data(v)
        d: dict[str, Any] = {'id': f'v{v}', 'type': vd.vtype}
        if vd.size != 1:
            d['size'] = vd.size
        if h is not None:
            hv = h.vertex_data(v)
            d['x'] = _num(hv.x, precision)
            d['y'] = _num(hv.y, precision)
            r = _route(h, v, orig_e, precision)
            if r:
                d['route'] = r
        vertices.append(d)
    edges = []
    for e in sorted(g.edges()):
        ed = g.edge_data(e)
        d = {'id': f'e{e}', 'label': str(ed.value),
             'inputs': [f'v{v}' for v in ed.s], 'outputs': [f'v{v}' for v in ed.t]}
        if h is not None:
            he = h.edge_data(e)
            d['x'] = _num(he.x, precision)
            d['y'] = _num(he.y, precision)
            d['w'] = BOX_W
            d['h'] = BOX_H[ed.box_size()]
        if colors:
            if ed.fg:
                d['fg'] = ed.fg
            if ed.bg:
                d['bg'] = ed.bg
        edges.append(d)
    out: dict[str, Any] = {
        'term': term_of(g), 'vertices': vertices, 'edges': edges,
        'inputs': [f'v{v}' for v in g.inputs()], 'outputs': [f'v{v}' for v in g.outputs()],
        'hypergraph': topology(g), 'layout': 'chyp' if h is not None else 'none'}
    if h is not None:
        cols: dict[float, list[int]] = {}
        for e in orig_e:
            cols.setdefault(float(h.edge_data(e).x), []).append(e)
        out['layers'] = [[f'e{e}' for e in sorted(cols[x], key=lambda e: (float(h.edge_data(e).y), e))]
                         for x in sorted(cols)]
        xs: list[float] = []
        ys: list[float] = []
        for v in h.vertices():
            xs.append(float(h.vertex_data(v).x))
            ys.append(float(h.vertex_data(v).y))
        for e in orig_e:
            ed = h.edge_data(e)
            xs += [float(ed.x) - BOX_W / 2, float(ed.x) + BOX_W / 2]
            ys += [float(ed.y) - BOX_H[ed.box_size()] / 2, float(ed.y) + BOX_H[ed.box_size()] / 2]
        if xs:
            out['bounds'] = {'xmin': _num(min(xs), precision), 'xmax': _num(max(xs), precision),
                             'ymin': _num(min(ys), precision), 'ymax': _num(max(ys), precision)}
    if err:
        out['layout_error'] = err
    return out


def step_match(report: CheckReport, part: RewritePart) -> dict[str, Any] | None:
    """Where the rule of a VALID ``by rule`` step applied, found by Chyp itself.

    This replays what RuleTac.run does (chyp/tactic/ruletac.py:32-50): for each
    (m_g, m_h) that ProofState.rewrite_lhs yields (match_rule + dpo), the first
    one whose rewritten graph Chyp's find_iso finds isomorphic to the stated
    after-term is the match the checker accepted. Reported:
      before.edges/vertices: m_g.edge_image/vertex_image (ids in the step's
        before-graph: the rule's lhs image, boundary vertices included);
      after.edges/vertices: m_h.edge_image/vertex_image mapped through the
        isomorphism into the after-graph's ids (what the rule inserted; its
        boundary vertices are the context's and are not listed), as the
        commented-out highlight code in ruletac.py:41-48 computes it;
      attempt: 1-based position of that match in Chyp's enumeration.
    The proof state is built as chyp.checker.next_rhs builds one (fresh goal
    lhs = rhs, the step's sequence number, the previous step's assumptions).
    Returns None for other steps. Messages Chyp logs meanwhile are discarded.
    """
    if (part.tactic != 'rule' or not part.tactic_args or part.status != Part.VALID
            or part.lhs is None or part.rhs is None):
        return None
    state = report.state
    n = len(state.errors)
    try:
        goal = Goal(Rule(part.lhs.copy(), part.rhs.copy()))
        if part.index > 0:
            prev = state.parts[part.index - 1]
            if (isinstance(prev, ProofStepPart) and prev.proof_state
                    and prev.proof_state.num_goals() > 0):
                goal.assumptions = {k: a.copy()
                                    for k, a in prev.proof_state.goals[0].assumptions.items()}
        ps = ProofState(state, part.sequence, [goal])
        expr = part.tactic_args[0]
        for k, (m_g, m_h) in enumerate(ps.rewrite_lhs(expr) or (), start=1):
            iso = find_iso(m_h.codomain, part.rhs)
            if iso is None:
                continue
            arg = expr.strip()
            return {
                'rule': arg.lstrip('-').strip(),
                'direction': 'converse' if arg.startswith('-') else 'forward',
                'before': {'edges': [f'e{e}' for e in sorted(m_g.edge_image)],
                           'vertices': [f'v{v}' for v in sorted(m_g.vertex_image)]},
                'after': {'edges': [f'e{e}' for e in sorted(iso.edge_map[e] for e in m_h.edge_image)],
                          'vertices': [f'v{v}' for v in sorted(iso.vertex_map[v]
                                                                for v in m_h.vertex_image)]},
                'attempt': k,
            }
        return None
    except Exception:  # noqa: BLE001  (an aid only; the verdict is the checker's)
        return None
    finally:
        del state.errors[n:]


def _no_match_reason(part: RewritePart) -> str:
    if part.stub:
        return 'no steps'
    if part.tactic == 'refl' and not part.tactic_args:
        return 'bare step: no rule applied'
    if part.tactic == 'simp':
        return 'simp: repeated rewriting, no single match'
    if part.status != Part.VALID:
        return 'step not valid'
    return 'no match found'


def layout_available() -> tuple[bool, str | None]:
    """(True, None) when chyp.layout (cvxpy) imports, else (False, reason)."""
    try:
        _chyp.import_layout()
        return True, None
    except ImportError as e:
        return False, f'{type(e).__name__}: {e}'


def diagrams(theory: Theory, *, layout: str = 'chyp', precision: int | None = 3,
             report: CheckReport | None = None) -> dict[str, Any]:
    """Every gen, every rule (lhs, rhs) and every rewrite step (before, after)
    of ``theory`` as JSON-serialisable diagrams (shape: module docstring).

    Args:
        layout: 'chyp' for Chyp's own coordinates (chyp.layout.convex_layout,
            needs cvxpy; falls back to 'none' with a reason when cvxpy is
            missing), 'none' for topology only.
        precision: decimals coordinates are rounded to (None: no rounding).
        report: a CheckReport to reuse (default: check(theory)). The step
            graphs are the checked ones, so steps inside proofs have their
            LHS/RHS filled in, and each valid rule step gets its match.
    """
    if layout not in ('chyp', 'none'):
        raise ValueError(f"layout must be 'chyp' or 'none', not {layout!r}")
    report = report or check(theory)
    state = report.state
    mode = layout
    info: dict[str, Any] = {'requested': layout}
    if layout == 'chyp':
        ok, reason = layout_available()
        if not ok:
            mode = 'none'
            info['reason'] = reason
    info['used'] = mode
    if mode == 'chyp':
        info.update({'engine': 'chyp.layout.convex_layout (chyp/layout.py:26-142)',
                     'units': UNITS,
                     'box': {'w': BOX_W, 'h': {'box_size_1': BOX_H[1], 'box_size_2': BOX_H[2]},
                             'source': 'chyp/gui/graphscene.py:29-31, 60-66 (restated)'},
                     'precision': precision})

    def gd(g: Graph | None) -> dict[str, Any] | None:
        return graph_dict(g, layout=mode, precision=precision, colors=False)

    styles: dict[str, dict[str, str]] = {}
    for g in state.graphs.values():
        for ed in g.edata.values():
            label = str(ed.value)
            if (ed.fg or ed.bg) and label not in styles:
                styles[label] = {k: v for k, v in (('fg', ed.fg), ('bg', ed.bg)) if v}

    gens = [{'name': p.name, 'line': p.line, 'diagram': gd(p.graph)}
            for p in state.parts if isinstance(p, GenPart)]
    rules = [{'name': p.name, 'line': p.line, 'lhs': gd(p.lhs), 'rhs': gd(p.rhs)}
             for p in state.parts if isinstance(p, RulePart)]
    rewrites = []
    for rw in report.rewrites:
        graphs: list[dict[str, Any]] = []

        def ref(d: dict[str, Any] | None) -> int | None:
            if d is None:
                return None
            for i, x in enumerate(graphs):
                if x == d:
                    return i
            graphs.append(d)
            return len(graphs) - 1

        steps = []
        for s in rw.steps:
            p = report.parts[(rw.index, s.step_index)]
            m = step_match(report, p)
            d: dict[str, Any] = {
                'step_index': s.step_index, 'line': s.line, 'status': s.status,
                'before': ref(gd(p.lhs)),
                'after': None if (s.hole or p.stub) else ref(gd(p.rhs)),
                'match': m}
            if m is None:
                d['match_reason'] = _no_match_reason(p)
            steps.append(d)
        rewrites.append({'index': rw.index, 'name': rw.name, 'label': rw.label,
                         'graphs': graphs, 'steps': steps})
    return {'theory': theory.name, 'layout': info,
            'styles': {k: styles[k] for k in sorted(styles)},
            'gens': gens, 'rules': rules, 'rewrites': rewrites}


# --- validation of the documented shape --------------------------------------

def _is_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)


def validate_diagram(d: Any, where: str = 'diagram') -> list[str]:
    """Problems with one diagram dict against the documented shape ([] = valid)."""
    errs: list[str] = []

    def bad(msg: str) -> None:
        errs.append(f'{where}: {msg}')

    if not isinstance(d, dict):
        return [f'{where}: not an object']
    for k in ('term', 'vertices', 'edges', 'inputs', 'outputs', 'hypergraph', 'layout'):
        if k not in d:
            bad(f'missing {k!r}')
    if errs:
        return errs
    if d['layout'] not in ('chyp', 'none'):
        bad(f'layout {d["layout"]!r}')
    laid = d['layout'] == 'chyp'
    vids: set[str] = set()
    for v in d['vertices']:
        vid = v.get('id')
        if not isinstance(vid, str) or not vid.startswith('v'):
            bad(f'vertex id {vid!r}')
        if vid in vids:
            bad(f'duplicate vertex {vid}')
        vids.add(vid)
        if 'type' not in v or not (v['type'] is None or isinstance(v['type'], str)):
            bad(f'vertex {vid} type')
        if 'size' in v and not (isinstance(v['size'], int) and v['size'] != 1):
            bad(f'vertex {vid} size')
        for c in ('x', 'y'):
            if laid and not _is_num(v.get(c)):
                bad(f'vertex {vid} has no {c}')
            if not laid and c in v:
                bad(f'vertex {vid} has {c} without a layout')
        if 'route' in v:
            if not laid or not isinstance(v['route'], list) or not all(
                    isinstance(p, list) and len(p) == 2 and all(_is_num(c) for c in p)
                    for p in v['route']):
                bad(f'vertex {vid} route')
    eids: set[str] = set()
    for e in d['edges']:
        eid = e.get('id')
        if not isinstance(eid, str) or not eid.startswith('e'):
            bad(f'edge id {eid!r}')
        if eid in eids:
            bad(f'duplicate edge {eid}')
        eids.add(eid)
        if not isinstance(e.get('label'), str):
            bad(f'edge {eid} label')
        for side in ('inputs', 'outputs'):
            if not isinstance(e.get(side), list) or any(x not in vids for x in e.get(side, [])):
                bad(f'edge {eid} {side} name unknown vertices')
        for c in ('x', 'y', 'w', 'h'):
            if laid and not _is_num(e.get(c)):
                bad(f'edge {eid} has no {c}')
            if not laid and c in e:
                bad(f'edge {eid} has {c} without a layout')
    for side in ('inputs', 'outputs'):
        if not isinstance(d[side], list) or any(x not in vids for x in d[side]):
            bad(f'{side} name unknown vertices')
    hg = d['hypergraph']
    if not isinstance(hg, dict) or not all(k in hg for k in ('boxes', 'inputs', 'outputs')):
        bad('hypergraph lacks boxes/inputs/outputs')
    else:
        want = [{'id': e['id'], 'inputs': e['inputs'], 'outputs': e['outputs']} for e in d['edges']]
        if hg['boxes'] != want:
            bad('hypergraph.boxes is not the edges\' topology')
        if hg['inputs'] != d['inputs'] or hg['outputs'] != d['outputs']:
            bad('hypergraph boundary differs from inputs/outputs')
    if laid:
        if not isinstance(d.get('layers'), list) or sorted(x for L in d['layers'] for x in L) != sorted(eids):
            bad('layers do not list every edge once')
        if d['vertices'] or d['edges']:
            if not isinstance(d.get('bounds'), dict) or not all(
                    _is_num(d['bounds'].get(k)) for k in ('xmin', 'xmax', 'ymin', 'ymax')):
                bad('bounds')
    else:
        for k in ('layers', 'bounds'):
            if k in d:
                bad(f'{k} without a layout')
    return errs


def step_graphs(rewrite: dict[str, Any], step: dict[str, Any]) -> tuple[Any, Any]:
    """(before, after) diagram of a step of a diagrams()['rewrites'] entry."""
    g = rewrite['graphs']
    return (None if step['before'] is None else g[step['before']],
            None if step['after'] is None else g[step['after']])


def validate_diagrams(doc: dict[str, Any]) -> list[str]:
    """Validate every diagram in a diagrams() result (or an export()'s 'diagrams'),
    and that each step's match names ids of its own before/after graphs."""
    errs: list[str] = []
    for g in doc['gens']:
        errs += validate_diagram(g['diagram'], f'gen {g["name"]}')
    for r in doc['rules']:
        errs += validate_diagram(r['lhs'], f'rule {r["name"]}.lhs')
        errs += validate_diagram(r['rhs'], f'rule {r["name"]}.rhs')
    for rw in doc['rewrites']:
        for i, g in enumerate(rw['graphs']):
            errs += validate_diagram(g, f'rewrite {rw["label"]} graph {i}')
        for s in rw['steps']:
            w = f'rewrite {rw["label"]} step {s["step_index"]}'
            for side in ('before', 'after'):
                if s[side] is not None and not (isinstance(s[side], int)
                                                and 0 <= s[side] < len(rw['graphs'])):
                    errs.append(f'{w}: {side} is not an index into graphs')
            m = s.get('match')
            if m is not None:
                before, after = step_graphs(rw, s)
                if before is None or after is None:
                    errs.append(f'{w}: match without both graphs')
                    continue
                be = {e['id'] for e in before['edges']}
                bv = {v['id'] for v in before['vertices']}
                ae = {e['id'] for e in after['edges']}
                av = {v['id'] for v in after['vertices']}
                if not set(m['before']['edges']) <= be or not set(m['before']['vertices']) <= bv:
                    errs.append(f'{w}: match.before names ids not in the before-graph')
                if not set(m['after']['edges']) <= ae or not set(m['after']['vertices']) <= av:
                    errs.append(f'{w}: match.after names ids not in the after-graph')
    return errs
