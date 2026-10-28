// Left-to-right layout of a hypergraph with boundary (a string diagram).
//
// Adapted from Chyp (https://github.com/akissinger/chyp), "an interactive theorem
// prover for string diagrams", Copyright (C) 2022 Aleks Kissinger, Apache License
// 2.0 (copy in js/layout/LICENSE-chyp), at commit 3d28483:
//   - chyp/term.py:30-109   layer_decomp: layers as soon as inputs are ready,
//                           identity boxes for wires that skip a layer, one
//                           barycentre pass forward and one backward;
//   - chyp/layout.py:26-142 convex_layout: y-coordinates that make wires as
//                           straight as possible (L1), subject to boundary order
//                           (>= 1 apart) and box order in a layer (>= (s1+s2)/2),
//                           plus 0.1 x the spread of each ordered list;
//   - chyp/gui/graphscene.py:114-176 port offsets on a box and the tentacle
//                           curve (cubic, horizontal tangents, controls 0.4·dx in).
// No Python was copied. This file re-implements those ideas in JavaScript and
// changes them (docs/chyp-notes.md, "Ported code (NOTICE)"):
//   - cvxpy is replaced by a deterministic solver: block coordinate descent over
//     columns, each column solved exactly by isotonic regression (pool adjacent
//     violators) under its ordering constraints; L1 by iteratively reweighted
//     least squares;
//   - identity boxes become dummy nodes, wire junctions get their own columns,
//     so one vertex may have several producers and consumers;
//   - cycles (Petri nets have them) are broken by DFS and drawn as feedback wires
//     below the diagram instead of raising "Is graph acyclic?";
//   - crossing reduction runs several sweeps and keeps the best ordering;
//   - box height grows with the number of ports.
//
// API
// ---
//   layoutHypergraph(graph, opts?) -> layout
//
//   graph = {
//     boxes:   [{ id, inputs: [vertexId], outputs: [vertexId], width?, height? }],
//     inputs:  [vertexId],   // left boundary, top to bottom
//     outputs: [vertexId],   // right boundary, top to bottom
//   }
//   A vertex is a wire. It is produced by box outputs and/or the left boundary and
//   consumed by box inputs and/or the right boundary. Port order is the array order.
//
//   layout = {
//     boxes:    { id: { x, y, w, h, inY: [y per input port], outY: [y per output
//                       port], inX, outX, layer, order } },
//               // (x, y) is the box centre; inX/outX are its left/right edges
//     vertices: { id: { x, y,                // the junction where the wire's ends meet
//                       paths: [[{x, y}]],   // one polyline per end, left to right:
//                                            // producer pin .. junction, junction .. consumer pin
//                       route: [{x, y}] | null,  // the whole wire when it has one
//                                            // producer and one consumer (null otherwise)
//                       feedback: [[{x, y}]],    // orthogonal routes for ends that
//                                            // run right-to-left (cycles), drawn below
//                       inputs: [i], outputs: [j] } },  // boundary positions it sits at
//     inputs:  [{ x, y, vertex }],  outputs: [{ x, y, vertex }],
//     layers:  [[boxId]],            // box layers left to right, each top to bottom
//     width, height,
//     stats:   { crossings, bend, objective, sweeps, reweights, feedback, feedbackEdges },
//   }
//   Coordinates are in the same units as opts (pixels by default), y downwards.
//
//   opts (all optional): boxWidth 64, boxMinHeight 32, portPitch 16, rowGap 16
//   (between boxes), wireGap 16 (between parallel wires), gap 48 (width of a wire
//   column), margin 24, feedbackGap 16, objective 'l1' | 'l2', compact 0.1,
//   portOffsets(i, n, h) -> offset from the box centre, layerOrder [[boxId]]
//   (fix the order of boxes per layer; skips crossing reduction), orderSweeps 4,
//   maxSweeps 3000 (Gauss-Seidel sweeps in all), tol 1e-6 (x wireGap).
//
//   wirePath(points) -> SVG path data: straight where y is level, otherwise Chyp's
//   tentacle cubic. feedbackPath(points) -> orthogonal polyline.
//
// Deterministic: no randomness, no Map/Set iteration over unordered keys; ties are
// broken by the order of graph.boxes, graph.inputs and graph.outputs.

export const DEFAULTS = Object.freeze({
  boxWidth: 64,
  boxMinHeight: 32,
  portPitch: 16,
  rowGap: 16,
  wireGap: 16,
  gap: 48,
  margin: 24,
  feedbackGap: 16,
  objective: 'l1',
  compact: 0.1,
  portOffsets: null,
  layerOrder: null,
  orderSweeps: 4,
  maxSweeps: 3000,
  tol: 1e-6,
});

// --- 1. the graph: vertices, ends, feedback ----------------------------------------

function normalize(graph) {
  const boxes = graph.boxes || [];
  const inputs = graph.inputs || [];
  const outputs = graph.outputs || [];
  const boxIndex = new Map();
  boxes.forEach((b, i) => {
    if (b == null || b.id == null) throw new Error(`layoutHypergraph: boxes[${i}] has no id`);
    if (boxIndex.has(b.id)) throw new Error(`layoutHypergraph: duplicate box id ${JSON.stringify(b.id)}`);
    boxIndex.set(b.id, i);
  });
  const vIndex = new Map();
  const verts = [];
  const vert = (id) => {
    if (!vIndex.has(id)) {
      vIndex.set(id, verts.length);
      verts.push({ id, producers: [], consumers: [], inputs: [], outputs: [] });
    }
    return verts[vIndex.get(id)];
  };
  inputs.forEach((v, i) => { const x = vert(v); x.inputs.push(i); x.producers.push({ pin: 'in', index: i }); });
  boxes.forEach((b, bi) => {
    (b.inputs || []).forEach((v, k) => vert(v).consumers.push({ box: bi, port: k }));
    (b.outputs || []).forEach((v, k) => vert(v).producers.push({ box: bi, port: k }));
  });
  outputs.forEach((v, j) => { const x = vert(v); x.outputs.push(j); x.consumers.push({ pin: 'out', index: j }); });
  return { boxes, inputs, outputs, verts, boxIndex, vIndex };
}

// Box-to-box edges A -> B (A produces a vertex B consumes), in a fixed order; a DFS
// in box order marks back edges and self-loops as feedback. Layers: longest path
// over the remaining DAG, as soon as inputs are ready (term.py:52-80).
function assignLayers(g) {
  const n = g.boxes.length;
  const succ = Array.from({ length: n }, () => []);
  g.boxes.forEach((b, a) => {
    for (const v of b.outputs || []) {
      const vx = g.verts[g.vIndex.get(v)];
      for (const c of vx.consumers) if (c.box !== undefined) succ[a].push(c.box);
    }
  });
  const state = new Uint8Array(n); // 0 new, 1 on stack, 2 done
  const back = new Set(); // "a>b"
  for (let s = 0; s < n; s++) {
    if (state[s]) continue;
    const stack = [[s, 0]];
    state[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [a, i] = top;
      if (i < succ[a].length) {
        top[1]++;
        const b = succ[a][i];
        if (state[b] === 1) back.add(`${a}>${b}`);
        else if (state[b] === 0) { state[b] = 1; stack.push([b, 0]); }
      } else { state[a] = 2; stack.pop(); }
    }
  }
  const indeg = new Array(n).fill(0);
  for (let a = 0; a < n; a++) for (const b of succ[a]) if (!back.has(`${a}>${b}`)) indeg[b]++;
  const layer = new Array(n).fill(1);
  const queue = [];
  for (let a = 0; a < n; a++) if (indeg[a] === 0) queue.push(a);
  for (let qi = 0; qi < queue.length; qi++) {
    const a = queue[qi];
    for (const b of succ[a]) {
      if (back.has(`${a}>${b}`)) continue;
      layer[b] = Math.max(layer[b], layer[a] + 1);
      if (--indeg[b] === 0) queue.push(b);
    }
  }
  return { layer, feedbackEdges: back.size };
}

// --- 2. the layered graph: columns, nodes, springs ------------------------------------
//
// Columns: 0 = left boundary, 2k = box layer k, odd = wire columns between layers,
// R = 2n+2 = right boundary. Every wire end runs pin -> dummies -> junction (or
// junction -> dummies -> pin), one column at a time, so every spring joins
// adjacent columns. A dummy in a box column plays the role of Chyp's identity box.

function build(g, layers, o) {
  const nL = layers.length ? Math.max(0, ...layers) : 0;
  const R = 2 * nL + 2;
  const nodes = [];
  const add = (node) => { node.idx = nodes.length; nodes.push(node); return node.idx; };

  const offsetsFor = (count, h) => {
    const out = [];
    for (let k = 0; k < count; k++) out.push(o.portOffsets ? o.portOffsets(k, count, h) : ((k + 0.5) / count - 0.5) * h);
    return out;
  };
  const boxNode = g.boxes.map((b, bi) => {
    const nIn = (b.inputs || []).length, nOut = (b.outputs || []).length;
    const w = b.width ?? o.boxWidth;
    const h = b.height ?? Math.max(o.boxMinHeight, Math.max(nIn, nOut, 1) * o.portPitch);
    return add({ kind: 'box', box: bi, col: 2 * layers[bi], w, h, inOff: offsetsFor(nIn, h), outOff: offsetsFor(nOut, h) });
  });
  const inPin = g.inputs.map((v, i) => add({ kind: 'pin', side: 'in', index: i, col: 0 }));
  const outPin = g.outputs.map((v, j) => add({ kind: 'pin', side: 'out', index: j, col: R }));

  const endOf = (e, producer) => {
    if (e.pin === 'in') return { node: inPin[e.index], off: 0 };
    if (e.pin === 'out') return { node: outPin[e.index], off: 0 };
    const nd = nodes[boxNode[e.box]];
    return { node: nd.idx, off: producer ? nd.outOff[e.port] : nd.inOff[e.port] };
  };

  const springs = [];
  const wires = g.verts.map((vx) => {
    const prod = vx.producers.map((e) => endOf(e, true));
    const cons = vx.consumers.map((e) => endOf(e, false));
    const pc = prod.map((e) => nodes[e.node].col);
    const cc = cons.map((e) => nodes[e.node].col);
    const cJ = pc.length ? Math.max(...pc) + 1 : cc.length ? Math.min(...cc) - 1 : 1;
    const J = add({ kind: 'junction', vertex: vx.id, col: cJ });
    const chain = (from, to) => { // from.col < to.col, returns the node path
      const path = [from];
      let prev = from;
      for (let c = nodes[from.node].col + 1; c < nodes[to.node].col; c++) {
        const d = { node: add({ kind: 'dummy', vertex: vx.id, col: c }), off: 0 };
        springs.push({ a: prev, b: d, w: 1 });
        path.push(d);
        prev = d;
      }
      springs.push({ a: prev, b: to, w: 1 });
      path.push(to);
      return path;
    };
    const jEnd = { node: J, off: 0 };
    const prodPaths = prod.map((e) => chain(e, jEnd));
    const consPaths = [];
    const feedback = [];
    cons.forEach((e) => { if (nodes[e.node].col > cJ) consPaths.push(chain(jEnd, e)); else feedback.push([jEnd, e]); });
    return { vertex: vx, J, prodPaths, consPaths, feedback };
  });
  return { nodes, springs, wires, R, nL, boxNode, inPin, outPin };
}

// --- 3. ordering within columns (crossing reduction) ----------------------------------

function columnsOf(L) {
  const cols = Array.from({ length: L.R + 1 }, () => []);
  for (const nd of L.nodes) cols[nd.col].push(nd.idx);
  // boundaries keep their given order; inner columns start in creation order
  cols[0].sort((a, b) => L.nodes[a].index - L.nodes[b].index);
  cols[L.R].sort((a, b) => L.nodes[a].index - L.nodes[b].index);
  return cols;
}

function subpos(L, end) {
  const nd = L.nodes[end.node];
  if (nd.kind !== 'box' || nd.h <= 0) return 0;
  return Math.max(-0.45, Math.min(0.45, (end.off / nd.h) * 0.9));
}

function springsBetween(L, c) { // springs with one end in column c and the other in c+1
  return L.springs.filter((s) => L.nodes[s.a.node].col === c && L.nodes[s.b.node].col === c + 1);
}

function countCrossings(L, cols) {
  const pos = new Float64Array(L.nodes.length);
  cols.forEach((col) => col.forEach((n, i) => { pos[n] = i; }));
  let total = 0;
  for (let c = 0; c + 1 < cols.length; c++) {
    const ss = springsBetween(L, c).map((s) => [pos[s.a.node] + subpos(L, s.a), pos[s.b.node] + subpos(L, s.b)]);
    for (let i = 0; i < ss.length; i++) {
      for (let j = i + 1; j < ss.length; j++) {
        if ((ss[i][0] - ss[j][0]) * (ss[i][1] - ss[j][1]) < 0) total++;
      }
    }
  }
  return total;
}

// One barycentre pass over column c against column c + dir (dir = -1 forward, +1 back).
function reorder(L, cols, c, dir, nbrs, fixedBoxOrder) {
  const col = cols[c];
  const other = cols[c + dir];
  if (!other || col.length < 2) return;
  const otherPos = new Map(other.map((n, i) => [n, (i + 0.5) / other.length]));
  const bary = new Map();
  col.forEach((n, i) => {
    let sum = 0, cnt = 0;
    for (const [mine, theirs] of nbrs[n]) {
      if (L.nodes[theirs.node].col !== c + dir) continue;
      sum += otherPos.get(theirs.node) + subpos(L, theirs) / other.length - subpos(L, mine) / col.length;
      cnt++;
    }
    bary.set(n, cnt ? sum / cnt : (i + 0.5) / col.length);
  });
  const cur = new Map(col.map((n, i) => [n, i]));
  const sorted = [...col].sort((a, b) => bary.get(a) - bary.get(b) || cur.get(a) - cur.get(b));
  if (fixedBoxOrder) {
    // keep the slot pattern (box or not) from the barycentre order, fill box slots in the given order
    const boxes = col.filter((n) => L.nodes[n].kind === 'box');
    boxes.sort((a, b) => fixedBoxOrder.get(L.nodes[a].box) - fixedBoxOrder.get(L.nodes[b].box));
    let k = 0;
    for (let i = 0; i < sorted.length; i++) if (L.nodes[sorted[i]].kind === 'box') sorted[i] = boxes[k++];
  }
  cols[c] = sorted;
}

function orderColumns(L, g, o) {
  const cols = columnsOf(L);
  const nbrs = Array.from({ length: L.nodes.length }, () => []);
  for (const s of L.springs) { nbrs[s.a.node].push([s.a, s.b]); nbrs[s.b.node].push([s.b, s.a]); }
  const inner = []; for (let c = 1; c < L.R; c++) inner.push(c);
  let fixed = null;
  if (o.layerOrder) {
    fixed = new Map();
    o.layerOrder.forEach((layer) => layer.forEach((id, i) => {
      if (!g.boxIndex.has(id)) throw new Error(`layoutHypergraph: layerOrder names unknown box ${JSON.stringify(id)}`);
      fixed.set(g.boxIndex.get(id), i);
    }));
    for (const b of g.boxes.keys()) if (!fixed.has(b)) fixed.set(b, Number.MAX_SAFE_INTEGER - (g.boxes.length - b));
    for (const c of inner) reorder(L, cols, c, -1, nbrs, fixed);
    return { cols, crossings: countCrossings(L, cols) };
  }
  for (const c of inner) reorder(L, cols, c, -1, nbrs, null);
  let best = cols.map((x) => [...x]);
  let bestX = countCrossings(L, cols);
  for (let sweep = 0; sweep < o.orderSweeps && bestX > 0; sweep++) {
    for (let i = inner.length - 1; i >= 0; i--) reorder(L, cols, inner[i], +1, nbrs, null);
    let x = countCrossings(L, cols);
    if (x < bestX) { bestX = x; best = cols.map((y) => [...y]); }
    for (const c of inner) reorder(L, cols, c, -1, nbrs, null);
    x = countCrossings(L, cols);
    if (x < bestX) { bestX = x; best = cols.map((y) => [...y]); }
  }
  return { cols: best, crossings: bestX };
}

// --- 4. y-coordinates ---------------------------------------------------------------
//
// Minimise   sum_springs w·|y_a + off_a - y_b - off_b|  +  compact · (span of each
//            boundary and box column)
// subject to y_next - y_prev >= ext_prev + ext_next for consecutive nodes in a column.
// That is convex_layout's problem (layout.py:82-117) over this layered graph. Every
// constraint lives in one column, so block coordinate descent over columns converges;
// each block is a weighted isotonic regression after shifting out the separations.

function extent(nd, o) { return nd.kind === 'box' ? nd.h / 2 + o.rowGap / 2 : o.wireGap / 2; }

function pava(t, w) { // weighted isotonic (non-decreasing) regression
  const val = [], wt = [], cnt = [];
  for (let i = 0; i < t.length; i++) {
    val.push(t[i]); wt.push(w[i]); cnt.push(1);
    while (val.length > 1 && val[val.length - 2] > val[val.length - 1]) {
      const v2 = val.pop(), w2 = wt.pop(), c2 = cnt.pop();
      const k = val.length - 1;
      const W = wt[k] + w2;
      val[k] = (val[k] * wt[k] + v2 * w2) / W; wt[k] = W; cnt[k] += c2;
    }
  }
  const out = new Float64Array(t.length);
  let i = 0;
  for (let k = 0; k < val.length; k++) for (let c = 0; c < cnt[k]; c++) out[i++] = val[k];
  return out;
}

function solveY(L, cols, o) {
  const N = L.nodes.length;
  const y = new Float64Array(N);
  const seps = cols.map((col) => {
    const s = [0];
    for (let j = 1; j < col.length; j++) s.push(s[j - 1] + extent(L.nodes[col[j - 1]], o) + extent(L.nodes[col[j]], o));
    return s;
  });
  cols.forEach((col, c) => { const S = seps[c]; const mid = S.length ? S[S.length - 1] / 2 : 0; col.forEach((n, j) => { y[n] = S[j] - mid; }); });

  // per node: [spring k, own offset, other node, other offset]
  const adj = Array.from({ length: N }, () => []);
  L.springs.forEach((s, k) => {
    adj[s.a.node].push([k, s.a.off, s.b.node, s.b.off]);
    adj[s.b.node].push([k, s.b.off, s.a.node, s.a.off]);
  });
  const isCompact = (c) => c === 0 || c === L.R || (c % 2 === 0);
  const unit = o.wireGap || 1;
  const delta = 1e-3 * unit; // IRLS floor: |r| below this is treated as quadratic
  const eps = 1e-9 / unit; // a whisper of anchoring to 0, so the optimum is unique
  const tol = o.tol * unit;
  const qw = new Float64Array(L.springs.length);
  const resid = (s) => y[s.a.node] + s.a.off - y[s.b.node] - s.b.off;
  const objective = () => {
    let f = 0;
    for (const s of L.springs) f += s.w * Math.abs(resid(s));
    cols.forEach((col, c) => { if (isCompact(c) && col.length > 1) f += o.compact * (y[col[col.length - 1]] - y[col[0]]); });
    return f;
  };
  const scratch = cols.map((col) => ({ A: new Float64Array(col.length), B: new Float64Array(col.length), t: new Float64Array(col.length) }));
  const fwd = [...cols.keys()], bwd = [...fwd].reverse();
  let sweeps = 0;
  // One Gauss-Seidel sweep: each column, in turn, minimises the current quadratic
  // (springs weighted by qw, plus the linear spread term) exactly under its order.
  const sweep = () => {
    sweeps++;
    let moved = 0;
    for (const c of (sweeps % 2 ? fwd : bwd)) {
      const col = cols[c];
      const m = col.length;
      if (!m) continue;
      const { A, B, t } = scratch[c];
      for (let j = 0; j < m; j++) {
        let a = eps, b = 0;
        for (const [k, own, other, otherOff] of adj[col[j]]) { a += qw[k]; b += qw[k] * (y[other] + otherOff - own); }
        A[j] = a; B[j] = b;
      }
      if (isCompact(c) && m > 1) { B[0] += o.compact; B[m - 1] -= o.compact; }
      const S = seps[c];
      for (let j = 0; j < m; j++) t[j] = B[j] / A[j] - S[j];
      const z = pava(t, A);
      for (let j = 0; j < m; j++) {
        const ny = z[j] + S[j];
        moved = Math.max(moved, Math.abs(ny - y[col[j]]));
        y[col[j]] = ny;
      }
    }
    return moved;
  };
  // Least squares first (cost w·r²/(2·unit)): the 'l2' objective, and the start for 'l1'.
  L.springs.forEach((s, k) => { qw[k] = s.w / unit; });
  while (sweeps < o.maxSweeps && sweep() >= tol);
  let rounds = 0;
  if (o.objective !== 'l2') {
    // L1 by iteratively reweighted least squares. The reweighted quadratic majorises
    // the delta-smoothed L1 cost and touches it at the current point, so every sweep
    // that lowers the quadratic lowers the true cost: reweight after each sweep.
    // Straight wires get weight 1/delta and act as rods that one-column moves shift
    // only slowly, so delta is annealed from half a wire gap down to 1e-3 of one.
    const levels = [0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002].map((d) => d * unit).filter((d) => d > delta);
    levels.push(delta);
    for (let li = 0; li < levels.length && sweeps < o.maxSweeps; li++) {
      const d = levels[li];
      const last = li === levels.length - 1;
      const levelTol = last ? tol : Math.max(tol, 1e-4 * unit);
      let prev = Infinity;
      while (sweeps < o.maxSweeps) {
        rounds++;
        L.springs.forEach((s, k) => { qw[k] = s.w / Math.max(Math.abs(resid(s)), d); });
        const moved = sweep();
        const f = objective();
        if (moved < levelTol && Math.abs(prev - f) <= 1e-10 * (1 + f)) break;
        prev = f;
      }
    }
  }
  let bend = 0;
  for (const s of L.springs) bend += Math.abs(resid(s));
  return { y, sweeps, rounds, bend, objective: objective() };
}

// --- 5. coordinates -----------------------------------------------------------------

const round = (v) => Math.round(v * 1e6) / 1e6;

export function layoutHypergraph(graph, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const g = normalize(graph);
  const { layer, feedbackEdges } = assignLayers(g);
  const L = build(g, layer, o);
  const { cols, crossings } = orderColumns(L, g, o);
  const { y, sweeps, rounds, bend, objective } = solveY(L, cols, o);

  // x: boundary columns have no width, wire columns `gap`, box columns their widest box
  const colW = cols.map((col, c) => {
    if (c === 0 || c === L.R) return 0;
    if (c % 2 === 1) return o.gap;
    return Math.max(0, ...col.map((n) => (L.nodes[n].kind === 'box' ? L.nodes[n].w : 0)));
  });
  const colX = [], colL = [], colRt = [];
  let cursor = o.margin;
  colW.forEach((w) => { colL.push(cursor); colX.push(cursor + w / 2); colRt.push(cursor + w); cursor += w; });
  const width = cursor + o.margin;

  let top = Infinity, bottom = -Infinity;
  for (const nd of L.nodes) {
    const half = nd.kind === 'box' ? nd.h / 2 : 0;
    top = Math.min(top, y[nd.idx] - half); bottom = Math.max(bottom, y[nd.idx] + half);
  }
  if (!Number.isFinite(top)) { top = 0; bottom = 0; }
  const dy = o.margin - top;
  const Y = (n) => round(y[n] + dy);
  const X = round;

  const pt = (end, role) => {
    const nd = L.nodes[end.node];
    if (nd.kind === 'box') {
      return { x: X(role === 'producer' ? colX[nd.col] + nd.w / 2 : colX[nd.col] - nd.w / 2), y: round(y[nd.idx] + dy + end.off) };
    }
    return { x: X(colX[nd.col]), y: Y(nd.idx) };
  };
  const pathPoints = (path, roleFirst, roleLast) => {
    const out = [];
    path.forEach((end, i) => {
      const nd = L.nodes[end.node];
      if (i === 0) out.push(pt(end, roleFirst));
      else if (i === path.length - 1) out.push(pt(end, roleLast));
      else if (nd.kind === 'dummy' && nd.col % 2 === 0) { // through a box column: level, across it
        out.push({ x: X(colL[nd.col]), y: Y(nd.idx) }, { x: X(colRt[nd.col]), y: Y(nd.idx) });
      } else out.push({ x: X(colX[nd.col]), y: Y(nd.idx) });
    });
    return out;
  };

  const boxes = {};
  const layers = Array.from({ length: L.nL }, () => []);
  cols.forEach((col, c) => {
    if (c % 2 !== 0 || c === 0 || c === L.R) return;
    col.filter((n) => L.nodes[n].kind === 'box').forEach((n, order) => {
      const nd = L.nodes[n];
      const b = g.boxes[nd.box];
      layers[c / 2 - 1].push(b.id);
      boxes[b.id] = {
        x: X(colX[c]), y: Y(n), w: nd.w, h: nd.h,
        inY: nd.inOff.map((off) => round(y[n] + dy + off)),
        outY: nd.outOff.map((off) => round(y[n] + dy + off)),
        inX: X(colX[c] - nd.w / 2), outX: X(colX[c] + nd.w / 2),
        layer: c / 2, order,
      };
    });
  });

  let lane = 0;
  const vertices = {};
  for (const w of L.wires) {
    const paths = [
      ...w.prodPaths.map((p) => pathPoints(p, 'producer', 'junction')),
      ...w.consPaths.map((p) => pathPoints(p, 'junction', 'consumer')),
    ];
    let route = null;
    const np = w.prodPaths.length, nc = w.consPaths.length;
    if (np <= 1 && nc <= 1 && np + nc > 0 && w.feedback.length === 0) {
      const a = np ? pathPoints(w.prodPaths[0], 'producer', 'junction') : [];
      const b = nc ? pathPoints(w.consPaths[0], 'junction', 'consumer') : [];
      route = a.length && b.length ? [...a, ...b.slice(1)] : a.length ? a : b;
    }
    const feedback = w.feedback.map(([jEnd, e]) => {
      lane++;
      const laneY = round(bottom + dy + lane * o.feedbackGap);
      const j = pt(jEnd, 'junction');
      const p = pt(e, 'consumer');
      const turnIn = X(colX[L.nodes[e.node].col - 1] ?? p.x);
      return [j, { x: j.x, y: laneY }, { x: turnIn, y: laneY }, { x: turnIn, y: p.y }, p];
    });
    const j = pt({ node: w.J, off: 0 }, 'junction');
    vertices[w.vertex.id] = { x: j.x, y: j.y, paths, route, feedback, inputs: [...w.vertex.inputs], outputs: [...w.vertex.outputs] };
  }
  const height = round(bottom + dy + lane * o.feedbackGap + o.margin);
  return {
    boxes,
    vertices,
    inputs: g.inputs.map((v, i) => ({ x: X(colX[0]), y: Y(L.inPin[i]), vertex: v })),
    outputs: g.outputs.map((v, j) => ({ x: X(colX[L.R]), y: Y(L.outPin[j]), vertex: v })),
    layers,
    width: round(width),
    height,
    stats: { crossings, bend: round(bend), objective: round(objective), sweeps, reweights: rounds, feedback: lane, feedbackEdges },
  };
}

// --- drawing helpers ----------------------------------------------------------------

const f2 = (v) => String(Math.round(v * 100) / 100);

/** SVG path for a wire polyline: level runs are straight, steps are Chyp's tentacle
 * cubic (graphscene.py:172-176: horizontal tangents, control points 0.4·dx in). */
export function wirePath(points, k = 0.4) {
  if (!points || !points.length) return '';
  let d = `M${f2(points[0].x)} ${f2(points[0].y)}`;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (Math.abs(a.y - b.y) < 1e-9) { d += ` L${f2(b.x)} ${f2(b.y)}`; continue; }
    const dx = Math.abs(b.x - a.x) * k;
    d += ` C${f2(a.x + dx)} ${f2(a.y)} ${f2(b.x - dx)} ${f2(b.y)} ${f2(b.x)} ${f2(b.y)}`;
  }
  return d;
}

/** SVG path for a feedback route (orthogonal polyline). */
export function feedbackPath(points) {
  if (!points || !points.length) return '';
  return points.map((p, i) => `${i ? 'L' : 'M'}${f2(p.x)} ${f2(p.y)}`).join(' ');
}
