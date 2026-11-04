// petri-layout.js — pure, deterministic node layout for Petri nets.
//
// No DOM, no randomness: the same model always gives the same positions.
// Input is the editor's model (`places` / `transitions` keyed by id, `arcs` as
// [{source, target}]); output is `{ positions: {id: {x, y}}, algo }`, which the
// editor writes back into `place.x/y` and `transition.x/y` (the JSON stays
// exactly as before; only coordinates change).
//
// Algorithms (see docs/layout.md):
//   sugiyama  layered drawing: Eades–Lin–Smyth cycle breaking, longest-path
//             layering with tightening, dummy nodes for long arcs, barycenter /
//             median sweeps with transposition, Brandes–Köpf coordinates.
//   grid      nodes on a grid, ordered by a connectivity walk, then improved by
//             swaps that shorten arcs and remove crossings.
//   bipartite places left, transitions right, crossing-reduced order, y values
//             pulled toward neighbours.
//   circular  one ring; ring order improved by swaps that remove chord crossings.
//   string    transitions are boxes layered top-to-bottom, places sit on wires.
//   auto      runs sugiyama, bipartite and grid and keeps the best scoring one.
//
// References (public): Sugiyama, Tagawa & Toda 1981; Eades, Lin & Smyth 1993
// (greedy feedback arcs); Gansner et al. 1993 (layer tightening); Brandes &
// Köpf 2001 (coordinate assignment).

import { measure, chooseLabelSides, score } from './petri-layout-metrics.js';

export const GEOM = {
    placeR: 16,        // drawn circle radius (petri-view.css .pv-place-inner)
    transSize: 30,     // drawn transition square
    labelH: 15,        // one label line
    labelMaxW: 150,    // label wraps at this width (petri-view.css .pv-node .pv-label)
    charW: 6.4,        // 12px sans-serif average advance
    gap: 28,           // clear space between neighbouring nodes
    rankSep: 112,      // distance between layer centres
    margin: 100,       // _normalizeNodePositions(100)
};

export const ALGOS = ['auto', 'sugiyama', 'grid', 'bipartite', 'circular', 'string'];

/** Rendered size of a node's label: width after wrapping, and line count. */
export function labelSize(text) {
    const s = String(text ?? '');
    const full = s.length * GEOM.charW;
    if (full <= GEOM.labelMaxW) return { w: Math.max(full, 8), lines: 1 };
    // greedy wrap on spaces, as the browser does with max-width
    let lines = 1, cur = 0, wmax = 0;
    for (const word of s.split(/\s+/)) {
        const ww = word.length * GEOM.charW;
        if (cur === 0) cur = ww;
        else if (cur + GEOM.charW + ww <= GEOM.labelMaxW) cur += GEOM.charW + ww;
        else { wmax = Math.max(wmax, cur); lines++; cur = ww; }
    }
    wmax = Math.max(wmax, cur);
    return { w: Math.min(Math.max(wmax, 8), GEOM.labelMaxW), lines };
}

/** Flatten the editor model into ids, kinds, sizes and unique directed edges. */
export function buildGraph(model) {
    const nodes = [];
    const index = new Map();
    const add = (id, kind, obj) => {
        const ls = labelSize(obj && obj.label ? obj.label : id);
        const shape = kind === 'place' ? GEOM.placeR * 2 : GEOM.transSize;
        index.set(id, nodes.length);
        nodes.push({
            id, kind, label: (obj && obj.label) || id, lines: ls.lines,
            shape, labelW: ls.w,
            w: Math.max(shape, ls.w),             // horizontal footprint
            below: (kind === 'place' ? 46 : 21) + GEOM.labelH * ls.lines - 2, // centre -> bottom of a label hung underneath
        });
    };
    for (const [id, p] of Object.entries(model.places || {})) add(id, 'place', p);
    for (const [id, t] of Object.entries(model.transitions || {})) add(id, 'transition', t);
    const seen = new Set();
    const edges = [];
    for (const a of model.arcs || []) {
        const s = index.get(a.source), t = index.get(a.target);
        if (s === undefined || t === undefined || s === t) continue;
        const key = s + '>' + t;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([s, t]);
    }
    return { nodes, index, edges };
}

// ---------------------------------------------------------------- cycles

/** Eades–Lin–Smyth greedy ordering; returns pos[] such that few edges go backward. */
function greedyOrder(n, edges) {
    const out = Array.from({ length: n }, () => []);
    const inn = Array.from({ length: n }, () => []);
    for (const [s, t] of edges) { out[s].push(t); inn[t].push(s); }
    const od = out.map(a => a.length), idg = inn.map(a => a.length);
    const alive = new Array(n).fill(true);
    const front = [], back = [];
    let left = n;
    const remove = (v) => {
        alive[v] = false; left--;
        for (const t of out[v]) if (alive[t]) idg[t]--;
        for (const s of inn[v]) if (alive[s]) od[s]--;
    };
    while (left > 0) {
        let progress = true;
        while (progress) {
            progress = false;
            for (let v = 0; v < n; v++) {
                if (alive[v] && od[v] === 0) { back.push(v); remove(v); progress = true; }
            }
            for (let v = 0; v < n; v++) {
                if (alive[v] && idg[v] === 0) { front.push(v); remove(v); progress = true; }
            }
        }
        if (left === 0) break;
        let best = -1, bestD = -Infinity;
        for (let v = 0; v < n; v++) {
            if (!alive[v]) continue;
            const d = od[v] - idg[v];
            if (d > bestD) { bestD = d; best = v; }
        }
        front.push(best); remove(best);
    }
    const order = front.concat(back.reverse());
    const pos = new Array(n);
    order.forEach((v, i) => { pos[v] = i; });
    return pos;
}

// ---------------------------------------------------------------- layering

function layerNodes(g, dagEdges, opts) {
    const n = g.nodes.length;
    const out = Array.from({ length: n }, () => []);
    const inn = Array.from({ length: n }, () => []);
    for (const [s, t] of dagEdges) { out[s].push(t); inn[t].push(s); }
    // longest path via Kahn
    const indeg = inn.map(a => a.length);
    const layer = new Array(n).fill(0);
    const queue = [];
    for (let v = 0; v < n; v++) if (indeg[v] === 0) queue.push(v);
    const topo = [];
    for (let qi = 0; qi < queue.length; qi++) {
        const v = queue[qi];
        topo.push(v);
        for (const t of out[v]) {
            layer[t] = Math.max(layer[t], layer[v] + 1);
            if (--indeg[t] === 0) queue.push(t);
        }
    }
    // tighten: a node moves toward the side with more edges; sinks stay put here
    for (let iter = 0; iter < 30; iter++) {
        let moved = false;
        for (const v of (iter % 2 ? topo.slice().reverse() : topo)) {
            const ins = inn[v], outs = out[v];
            if (outs.length === 0) continue;
            const lo = ins.length ? Math.max(...ins.map(u => layer[u])) + 1 : 0;
            const hi = Math.min(...outs.map(u => layer[u])) - 1;
            let target = layer[v];
            if (ins.length < outs.length) target = hi;
            else if (ins.length > outs.length) target = lo;
            if (target !== layer[v] && target >= lo && target <= hi) { layer[v] = target; moved = true; }
        }
        if (!moved) break;
    }
    let maxL = 0;
    for (let v = 0; v < n; v++) maxL = Math.max(maxL, layer[v]);
    if (opts.sinksBottom) {
        for (let v = 0; v < n; v++) {
            if (out[v].length === 0 && inn[v].length > 0) layer[v] = maxL;
        }
    }
    // compact empty layers
    const used = [...new Set(layer)].sort((a, b) => a - b);
    const remap = new Map(used.map((l, i) => [l, i]));
    return layer.map(l => remap.get(l));
}

// ---------------------------------------------------------------- crossings

function countBilayer(upper, lower, adjDown) {
    // adjDown: id -> array of ids in the lower layer
    const lpos = new Map(lower.map((v, i) => [v, i]));
    const pairs = [];
    upper.forEach((u, i) => {
        for (const w of adjDown(u)) { const p = lpos.get(w); if (p !== undefined) pairs.push([i, p]); }
    });
    let c = 0;
    for (let a = 0; a < pairs.length; a++) {
        for (let b = a + 1; b < pairs.length; b++) {
            if ((pairs[a][0] - pairs[b][0]) * (pairs[a][1] - pairs[b][1]) < 0) c++;
        }
    }
    return c;
}

function totalCrossings(layers, down) {
    let c = 0;
    for (let i = 0; i + 1 < layers.length; i++) c += countBilayer(layers[i], layers[i + 1], v => down.get(v) || []);
    return c;
}

function median(vals) {
    const s = vals.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    if (s.length % 2) return s[m];
    if (s.length === 2) return (s[0] + s[1]) / 2;
    const left = s[m - 1] - s[0], right = s[s.length - 1] - s[m];
    return left + right === 0 ? (s[m - 1] + s[m]) / 2 : (s[m - 1] * right + s[m] * left) / (left + right);
}

function reduceCrossings(layers, up, down, fixedFirst) {
    const L = layers.length;
    let best = layers.map(l => l.slice());
    let bestC = totalCrossings(best, down);
    if (bestC === 0 || L < 2) return best;
    const cur = layers.map(l => l.slice());
    const reorder = (i, nbrs, useMedian) => {
        const ref = new Map();
        const refLayer = nbrs === up ? cur[i - 1] : cur[i + 1];
        refLayer.forEach((v, p) => ref.set(v, p));
        const key = new Map();
        cur[i].forEach((v, p) => {
            const ps = (nbrs.get(v) || []).map(w => ref.get(w)).filter(x => x !== undefined);
            key.set(v, ps.length ? (useMedian ? median(ps) : ps.reduce((a, b) => a + b, 0) / ps.length) : p);
        });
        const idx = new Map(cur[i].map((v, p) => [v, p]));
        cur[i].sort((a, b) => (key.get(a) - key.get(b)) || (idx.get(a) - idx.get(b)));
    };
    const transpose = () => {
        let improved = true, guard = 0;
        while (improved && guard++ < 20) {
            improved = false;
            for (let i = 0; i < L; i++) {
                for (let p = 0; p + 1 < cur[i].length; p++) {
                    const a = cur[i][p], b = cur[i][p + 1];
                    const before = localCross(cur, i, down, up);
                    cur[i][p] = b; cur[i][p + 1] = a;
                    const after = localCross(cur, i, down, up);
                    if (after < before) improved = true;
                    else { cur[i][p] = a; cur[i][p + 1] = b; }
                }
            }
        }
    };
    const maxIter = layers.reduce((s, l) => s + l.length, 0) > 400 ? 6 : 24;
    for (let iter = 0; iter < maxIter; iter++) {
        const useMedian = iter % 2 === 0;
        if (iter % 2 === 0) for (let i = 1; i < L; i++) reorder(i, up, useMedian);
        else for (let i = L - 2; i >= 0; i--) reorder(i, down, useMedian);
        transpose();
        const c = totalCrossings(cur, down);
        if (c < bestC) { bestC = c; best = cur.map(l => l.slice()); if (c === 0) break; }
    }
    return best;
}

function localCross(layers, i, down, up) {
    let c = 0;
    if (i > 0) c += countBilayer(layers[i - 1], layers[i], v => down.get(v) || []);
    if (i + 1 < layers.length) c += countBilayer(layers[i], layers[i + 1], v => down.get(v) || []);
    return c;
}

// ---------------------------------------------------------------- Brandes–Köpf

function brandesKopf(layers, up, down, width, gap, isDummy) {
    const pos = new Map();
    layers.forEach(l => l.forEach((v, p) => pos.set(v, p)));
    // type 1 conflicts: non-inner segment crossing an inner (dummy–dummy) segment
    const conflict = new Set();
    const ck = (a, b) => a + '|' + b;
    for (let i = 1; i + 1 < layers.length; i++) {
        const lower = layers[i + 1];
        let k0 = 0, l = 0;
        for (let l1 = 0; l1 < lower.length; l1++) {
            const v = lower[l1];
            const inner = isDummy(v) ? (up.get(v) || []).find(u => isDummy(u)) : undefined;
            if (l1 === lower.length - 1 || inner !== undefined) {
                let k1 = layers[i].length - 1;
                if (inner !== undefined) k1 = pos.get(inner);
                while (l <= l1) {
                    const w = lower[l];
                    for (const u of up.get(w) || []) {
                        const k = pos.get(u);
                        if (k < k0 || k > k1) conflict.add(ck(u, w));
                    }
                    l++;
                }
                k0 = k1;
            }
        }
    }
    const results = [];
    for (const vdir of [0, 1]) {            // 0: top-down, 1: bottom-up
        for (const hdir of [0, 1]) {        // 0: left, 1: right
            let ls = layers.map(l => l.slice());
            let nb = vdir === 0 ? up : down;
            if (vdir === 1) ls = ls.slice().reverse();
            if (hdir === 1) ls = ls.map(l => l.slice().reverse());
            const p = new Map();
            ls.forEach(l => l.forEach((v, i) => p.set(v, i)));
            const root = new Map(), align = new Map();
            for (const l of ls) for (const v of l) { root.set(v, v); align.set(v, v); }
            const conf = (u, v) => (vdir === 0 ? conflict.has(ck(u, v)) : conflict.has(ck(v, u)));
            for (let i = 1; i < ls.length; i++) {
                let r = -1;
                for (const v of ls[i]) {
                    const ns = (nb.get(v) || []).slice().sort((a, b) => p.get(a) - p.get(b));
                    if (!ns.length) continue;
                    const d = ns.length;
                    const ms = d % 2 ? [(d - 1) / 2] : [d / 2 - 1, d / 2];
                    for (const m of ms) {
                        if (align.get(v) !== v) break;
                        const u = ns[m];
                        if (!conf(u, v) && r < p.get(u)) {
                            align.set(u, v); root.set(v, root.get(u)); align.set(v, root.get(v)); r = p.get(u);
                        }
                    }
                }
            }
            const sink = new Map(), shift = new Map(), x = new Map();
            for (const l of ls) for (const v of l) { sink.set(v, v); shift.set(v, Infinity); }
            const sep = (a, b) => (width.get(a) + width.get(b)) / 2 + gap;
            const place = (v) => {
                if (x.has(v)) return;
                x.set(v, 0);
                let w = v;
                do {
                    const row = ls.find(l => l[p.get(w)] === w);
                    if (p.get(w) > 0) {
                        const left = row[p.get(w) - 1];
                        const u = root.get(left);
                        place(u);
                        if (sink.get(v) === v) sink.set(v, sink.get(u));
                        if (sink.get(v) !== sink.get(u)) {
                            shift.set(sink.get(u), Math.min(shift.get(sink.get(u)), x.get(v) - x.get(u) - sep(left, w)));
                        } else {
                            x.set(v, Math.max(x.get(v), x.get(u) + sep(left, w)));
                        }
                    }
                    w = align.get(w);
                } while (w !== v);
            };
            for (const l of ls) for (const v of l) if (root.get(v) === v) place(v);
            const xs = new Map();
            for (const l of ls) for (const v of l) {
                const r = root.get(v);
                const sh = shift.get(sink.get(r));
                xs.set(v, x.get(r) + (sh < Infinity ? sh : 0));
            }
            if (hdir === 1) for (const [v, val] of xs) xs.set(v, -val);
            results.push(xs);
        }
    }
    // align to the narrowest layout, then take the average of the two medians
    let narrow = results[0], nw = Infinity;
    const extent = (m) => { let lo = Infinity, hi = -Infinity; for (const v of m.values()) { lo = Math.min(lo, v); hi = Math.max(hi, v); } return [lo, hi]; };
    for (const r of results) { const [lo, hi] = extent(r); if (hi - lo < nw) { nw = hi - lo; narrow = r; } }
    const [nlo, nhi] = extent(narrow);
    results.forEach((r, k) => {
        const [lo, hi] = extent(r);
        const d = (k % 2 === 0) ? nlo - lo : nhi - hi;   // left layouts hug the left, right ones the right
        for (const [v, val] of r) r.set(v, val + d);
    });
    const final = new Map();
    for (const v of results[0].keys()) {
        const vals = results.map(r => r.get(v)).sort((a, b) => a - b);
        final.set(v, (vals[1] + vals[2]) / 2);
    }
    return final;
}

// ---------------------------------------------------------------- sugiyama

function sugiyamaCore(g, edges, opts) {
    const n = g.nodes.length;
    const pos = greedyOrder(n, edges);
    const dag = [];
    const feedback = [];
    for (const [s, t] of edges) {
        if (pos[s] < pos[t]) dag.push([s, t]); else { dag.push([t, s]); feedback.push([s, t]); }
    }
    // merge reversed duplicates
    const dset = new Set(); const dag2 = [];
    for (const [s, t] of dag) { const k = s + '>' + t; if (!dset.has(k)) { dset.add(k); dag2.push([s, t]); } }
    const layer = layerNodes(g, dag2, opts);

    // layered graph with dummies; ids: number for real nodes, 'd<k>' for dummies
    const widths = new Map(), up = new Map(), down = new Map();
    const layers = [];
    const nL = Math.max(0, ...layer) + 1;
    for (let i = 0; i < nL; i++) layers.push([]);
    g.nodes.forEach((nd, i) => { widths.set(i, nd.w); layers[layer[i]].push(i); up.set(i, []); down.set(i, []); });
    let dc = 0;
    const dummies = new Set();
    for (const [s, t] of dag2) {
        let prev = s;
        for (let l = layer[s] + 1; l < layer[t]; l++) {
            const d = 'd' + (dc++);
            dummies.add(d); widths.set(d, 8); up.set(d, []); down.set(d, []);
            layers[l].push(d);
            down.get(prev).push(d); up.get(d).push(prev);
            prev = d;
        }
        down.get(prev).push(t); up.get(t).push(prev);
    }
    // initial order: depth-first from sources keeps connected nodes together
    const rank = new Map();
    let r = 0;
    const seen = new Set();
    const visit = (v) => { if (seen.has(v)) return; seen.add(v); rank.set(v, r++); for (const w of down.get(v)) visit(w); };
    for (let v = 0; v < n; v++) if (!up.get(v).length) visit(v);
    for (let v = 0; v < n; v++) visit(v);
    for (const d of dummies) visit(d);
    layers.forEach(l => l.sort((a, b) => rank.get(a) - rank.get(b)));

    let ordered = reduceCrossings(layers, up, down);

    // resource / loop places (touched by a feedback arc) sit beside the cycle
    const loopNodes = new Set();
    for (const [s, t] of feedback) { if (g.nodes[s].kind === 'place') loopNodes.add(s); if (g.nodes[t].kind === 'place') loopNodes.add(t); }
    const hasLoopSide = opts.loopsBeside !== false;
    if (hasLoopSide) {
        for (const v of [...loopNodes].sort((a, b) => a - b)) {
            const li = ordered.findIndex(l => l.includes(v));
            if (li < 0 || ordered[li].length < 2) continue;
            let bestOrder = null, bestC = totalCrossings(ordered, down);
            for (const side of ['right', 'left']) {
                const trial = ordered.map(l => l.slice());
                trial[li] = trial[li].filter(x => x !== v);
                if (side === 'right') trial[li].push(v); else trial[li].unshift(v);
                const c = totalCrossings(trial, down);
                if (c <= bestC) { bestC = c; bestOrder = trial; break; }
            }
            if (bestOrder) ordered = bestOrder;
        }
    }

    const isDummy = (v) => typeof v === 'string';
    const xs = brandesKopf(ordered, up, down, widths, opts.gap ?? GEOM.gap, isDummy);
    // y: layers spaced by the tallest label hanging below the previous layer
    const ys = [];
    let y = 0;
    ordered.forEach((l, i) => {
        if (i > 0) {
            const prevBelow = Math.max(...ordered[i - 1].map(v => isDummy(v) ? 0 : g.nodes[v].below));
            const nextHalf = Math.max(...l.map(v => isDummy(v) ? 0 : g.nodes[v].shape / 2));
            y += Math.max(GEOM.rankSep, prevBelow + nextHalf + 10);
        }
        ys.push(y);
    });
    const posOut = {};
    ordered.forEach((l, i) => l.forEach(v => { if (!isDummy(v)) posOut[g.nodes[v].id] = { x: xs.get(v), y: ys[i] }; }));
    return { posOut, layer, feedback };
}

function finish(posOut, margin = GEOM.margin) {
    let minX = Infinity, minY = Infinity;
    for (const p of Object.values(posOut)) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); }
    const out = {};
    for (const [id, p] of Object.entries(posOut)) {
        out[id] = { x: Math.round(p.x - minX + margin), y: Math.round(p.y - minY + margin) };
    }
    return out;
}

export function layoutSugiyama(model, opts = {}) {
    const g = buildGraph(model);
    if (!g.nodes.length) return { positions: {}, algo: 'sugiyama' };
    // widen the gap until no label or node overlaps another (labels may hang to the side)
    let positions = null;
    for (const gap of [GEOM.gap, 48, 72, 100]) {
        const { posOut } = sugiyamaCore(g, g.edges, { sinksBottom: opts.sinksBottom !== false, ...opts, gap });
        positions = finish(posOut);
        if (measure(model, positions).overlaps === 0) break;
    }
    return { positions, algo: 'sugiyama' };
}

// ---------------------------------------------------------------- grid

function walkOrder(g) {
    const n = g.nodes.length;
    const nb = Array.from({ length: n }, () => []);
    const outn = Array.from({ length: n }, () => 0), inn = Array.from({ length: n }, () => 0);
    for (const [s, t] of g.edges) { nb[s].push(t); nb[t].push(s); outn[s]++; inn[t]++; }
    const seen = new Array(n).fill(false);
    const order = [];
    const starts = [...Array(n).keys()].sort((a, b) => (inn[a] - inn[b]) || (a - b));
    for (const s of starts) {
        if (seen[s]) continue;
        const q = [s]; seen[s] = true;
        for (let qi = 0; qi < q.length; qi++) {
            const v = q[qi]; order.push(v);
            for (const w of nb[v].slice().sort((a, b) => a - b)) if (!seen[w]) { seen[w] = true; q.push(w); }
        }
    }
    return order;
}

export function layoutGrid(model) {
    const g = buildGraph(model);
    const n = g.nodes.length;
    if (!n) return { positions: {}, algo: 'grid' };
    const cols = Math.max(1, Math.ceil(Math.sqrt(n * 1.15)));
    const rows = Math.ceil(n / cols);
    const cw = Math.max(...g.nodes.map(x => x.w)) + GEOM.gap;
    const ch = Math.max(...g.nodes.map(x => x.below)) + 40;
    const cell = (slot) => [(slot % cols) * cw, Math.floor(slot / cols) * ch];
    const slotOf = new Array(n);
    const order = walkOrder(g);
    // row-major in walk order; connected nodes start out close
    order.forEach((v, i) => { slotOf[v] = i; });
    const eval_ = () => {
        let len = 0, x = 0;
        const pts = slotOf.map(s => cell(s));
        for (const [s, t] of g.edges) len += Math.hypot(pts[s][0] - pts[t][0], pts[s][1] - pts[t][1]);
        // crossings counted with the shared metric would be costly; use length plus segment crossings
        const segs = g.edges.map(([s, t]) => [pts[s], pts[t], s, t]);
        for (let a = 0; a < segs.length; a++) for (let b = a + 1; b < segs.length; b++) {
            const A = segs[a], B = segs[b];
            if (A[2] === B[2] || A[2] === B[3] || A[3] === B[2] || A[3] === B[3]) continue;
            if (properCross(A[0], A[1], B[0], B[1])) x++;
        }
        return len + x * (cw + ch);
    };
    let best = eval_();
    const total = rows * cols;
    const free = [];
    for (let s = n; s < total; s++) free.push(s);
    for (let pass = 0; pass < 6; pass++) {
        let improved = false;
        for (let a = 0; a < n; a++) {
            for (let b = a + 1; b < n; b++) {
                [slotOf[a], slotOf[b]] = [slotOf[b], slotOf[a]];
                const c = eval_();
                if (c < best - 1e-9) { best = c; improved = true; } else [slotOf[a], slotOf[b]] = [slotOf[b], slotOf[a]];
            }
        }
        if (!improved) break;
        if (n > 40) break;
    }
    const posOut = {};
    g.nodes.forEach((nd, i) => { const [x, y] = cell(slotOf[i]); posOut[nd.id] = { x, y }; });
    return { positions: finish(posOut), algo: 'grid' };
}

function properCross(p1, p2, p3, p4) {
    const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// ---------------------------------------------------------------- bipartite

/** Least-squares positions for an ordered column under minimum gaps (pool adjacent violators). */
function spreadOrdered(desired, gaps) {
    // y_i = z_i + cumulative gap; minimise sum (z_i - (d_i - c_i))^2 s.t. z non-decreasing
    const c = [0];
    for (let i = 1; i < desired.length; i++) c.push(c[i - 1] + gaps[i - 1]);
    const blocks = [];
    desired.forEach((d, i) => {
        blocks.push({ sum: d - c[i], n: 1, from: i });
        while (blocks.length > 1) {
            const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
            if (a.sum / a.n <= b.sum / b.n) break;
            a.sum += b.sum; a.n += b.n; blocks.pop();
        }
    });
    const out = new Array(desired.length);
    for (const b of blocks) for (let i = b.from; i < b.from + b.n; i++) out[i] = b.sum / b.n + c[i];
    return out;
}

export function layoutBipartite(model) {
    const g = buildGraph(model);
    const n = g.nodes.length;
    if (!n) return { positions: {}, algo: 'bipartite' };
    const P = [], T = [];
    g.nodes.forEach((nd, i) => (nd.kind === 'place' ? P : T).push(i));
    const nbrP = new Map(), nbrT = new Map();   // for a place -> transitions; for a transition -> places
    g.nodes.forEach((_, i) => { nbrP.set(i, []); nbrT.set(i, []); });
    for (const [s, t] of g.edges) { nbrP.get(s).push(t); nbrP.get(t).push(s); }
    // crossing reduction on two layers: reuse the layered machinery
    const up = new Map(), down = new Map();
    for (const i of [...P, ...T]) { up.set(i, []); down.set(i, []); }
    for (const [s, t] of g.edges) {
        const [a, b] = g.nodes[s].kind === 'place' ? [s, t] : [t, s];
        if (g.nodes[a].kind !== 'place' || g.nodes[b].kind !== 'transition') continue;
        down.get(a).push(b); up.get(b).push(a);
    }
    const ordered = P.length && T.length
        ? reduceCrossings([walkSort(P, g), walkSort(T, g)], up, down)
        : [P, T];
    const [colP, colT] = ordered;
    const posY = new Map();
    const colGapX = 220 + Math.max(0, ...g.nodes.map(x => x.w)) ;
    const place = (col, anchor) => {
        const gaps = [];
        for (let i = 0; i + 1 < col.length; i++) gaps.push(g.nodes[col[i]].below + g.nodes[col[i + 1]].shape / 2 + 8);
        let y = col.map((_, i) => i * 100);
        for (let it = 0; it < 12; it++) {
            const desired = col.map((v, i) => {
                const ys = nbrP.get(v).map(w => posY.get(w)).filter(z => z !== undefined);
                return ys.length ? median(ys) : y[i];
            });
            y = spreadOrdered(desired, gaps);
            col.forEach((v, i) => posY.set(v, y[i]));
            anchor();
        }
    };
    // seed both columns evenly, then alternate
    colP.forEach((v, i) => posY.set(v, i * 110));
    colT.forEach((v, i) => posY.set(v, i * 110));
    for (let round = 0; round < 6; round++) {
        place(colT, () => {});
        place(colP, () => {});
    }
    const posOut = {};
    colP.forEach(v => { posOut[g.nodes[v].id] = { x: 0, y: posY.get(v) }; });
    colT.forEach(v => { posOut[g.nodes[v].id] = { x: colGapX, y: posY.get(v) }; });
    return { positions: finish(posOut), algo: 'bipartite' };
}

function walkSort(ids, g) {
    const rank = new Map(walkOrder(g).map((v, i) => [v, i]));
    return ids.slice().sort((a, b) => rank.get(a) - rank.get(b));
}

// ---------------------------------------------------------------- circular

export function layoutCircular(model) {
    const g = buildGraph(model);
    const n = g.nodes.length;
    if (!n) return { positions: {}, algo: 'circular' };
    const ring = walkOrder(g);
    const chordCross = () => {
        const at = new Array(n);
        ring.forEach((v, i) => { at[v] = i; });
        let c = 0;
        for (let a = 0; a < g.edges.length; a++) for (let b = a + 1; b < g.edges.length; b++) {
            const [s1, t1] = g.edges[a], [s2, t2] = g.edges[b];
            if (s1 === s2 || s1 === t2 || t1 === s2 || t1 === t2) continue;
            let [p, q] = [at[s1], at[t1]]; if (p > q) [p, q] = [q, p];
            const inside = (x) => x > p && x < q;
            if (inside(at[s2]) !== inside(at[t2])) c++;
        }
        return c;
    };
    let best = chordCross();
    const limit = n > 60 ? 1 : 5;
    for (let pass = 0; pass < limit && best > 0; pass++) {
        let improved = false;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                [ring[i], ring[j]] = [ring[j], ring[i]];
                const c = chordCross();
                if (c < best) { best = c; improved = true; } else [ring[i], ring[j]] = [ring[j], ring[i]];
            }
        }
        if (!improved) break;
    }
    const arc = ring.reduce((s, v) => s + g.nodes[v].w + GEOM.gap, 0);
    const R = Math.max(110, arc / (2 * Math.PI));
    const posOut = {};
    ring.forEach((v, i) => {
        const a = (2 * Math.PI * i) / n - Math.PI / 2;
        posOut[g.nodes[v].id] = { x: R * Math.cos(a), y: R * Math.sin(a) };
    });
    return { positions: finish(posOut), algo: 'circular' };
}

// ---------------------------------------------------------------- string diagram

export function layoutString(model) {
    const g = buildGraph(model);
    const n = g.nodes.length;
    if (!n) return { positions: {}, algo: 'string' };
    // contract places: transition -> transition through each place
    const tIdx = [], tOf = new Map();
    g.nodes.forEach((nd, i) => { if (nd.kind === 'transition') { tOf.set(i, tIdx.length); tIdx.push(i); } });
    if (!tIdx.length) return layoutGrid(model);
    const pin = new Map(), pout = new Map();
    for (const [s, t] of g.edges) {
        if (g.nodes[s].kind === 'transition' && g.nodes[t].kind === 'place') { (pin.get(t) || pin.set(t, []).get(t)).push(s); }
        if (g.nodes[s].kind === 'place' && g.nodes[t].kind === 'transition') { (pout.get(s) || pout.set(s, []).get(s)).push(t); }
    }
    const sub = { nodes: tIdx.map(i => ({ ...g.nodes[i] })), edges: [] };
    const seen = new Set();
    for (const [p, ins] of pin) for (const a of ins) for (const b of pout.get(p) || []) {
        if (a === b) continue;
        const k = tOf.get(a) + '>' + tOf.get(b);
        if (!seen.has(k)) { seen.add(k); sub.edges.push([tOf.get(a), tOf.get(b)]); }
    }
    // transitions are wide enough to carry their wires' labels
    sub.nodes.forEach(nd => { nd.w = Math.max(nd.w, 90); });
    const core = sugiyamaCore(sub, sub.edges, { sinksBottom: false, loopsBeside: false, gap: 56 });
    const posOut = {};
    const tpos = core.posOut;
    sub.nodes.forEach(nd => { posOut[nd.id] = { ...tpos[nd.id] }; });
    const step = GEOM.rankSep;
    const used = [];
    const free = (x, y) => !used.some(u => Math.abs(u[0] - x) < 70 && Math.abs(u[1] - y) < 70);
    g.nodes.forEach((nd, i) => {
        if (nd.kind !== 'place') return;
        const ins = pin.get(i) || [], outs = pout.get(i) || [];
        const pts = (list) => list.map(t => tpos[g.nodes[t].id]);
        let x, y;
        if (ins.length && outs.length) {
            const a = pts(ins), b = pts(outs);
            x = (a.reduce((s, p) => s + p.x, 0) / a.length + b.reduce((s, p) => s + p.x, 0) / b.length) / 2;
            y = (a.reduce((s, p) => s + p.y, 0) / a.length + b.reduce((s, p) => s + p.y, 0) / b.length) / 2;
        } else if (ins.length) {
            const a = pts(ins);
            x = a.reduce((s, p) => s + p.x, 0) / a.length; y = Math.max(...a.map(p => p.y)) + step / 2;
        } else if (outs.length) {
            const b = pts(outs);
            x = b.reduce((s, p) => s + p.x, 0) / b.length; y = Math.min(...b.map(p => p.y)) - step / 2;
        } else { x = 0; y = 0; }
        // avoid sitting on top of transitions or other places
        let dx = 0;
        const clashT = () => Object.values(tpos).some(p => Math.abs(p.x - (x + dx)) < 60 && Math.abs(p.y - y) < 50);
        for (let k = 0; k < 12 && (!free(x + dx, y) || clashT()); k++) dx = (k % 2 ? 1 : -1) * 60 * Math.ceil((k + 1) / 2);
        x += dx;
        used.push([x, y]);
        posOut[nd.id] = { x, y };
    });
    return { positions: finish(posOut), algo: 'string' };
}

// ---------------------------------------------------------------- auto / entry

const RUNNERS = {
    sugiyama: layoutSugiyama, grid: layoutGrid, bipartite: layoutBipartite,
    circular: layoutCircular, string: layoutString,
};

/** Run candidates and keep the best by the shared score (ties go to sugiyama). */
export function layoutAuto(model) {
    const names = ['sugiyama', 'bipartite', 'grid'];
    let best = null;
    for (const name of names) {
        const r = layoutNet(model, name);
        const s = score(measure(model, r.positions));
        if (!best || s < best.s - 1e-9) best = { r, s, name };
    }
    return { positions: best.r.positions, algo: 'auto', chosen: best.name };
}

/** Scale positions up (about the top-left margin) until no node or label overlaps. */
function relax(model, r) {
    let pos = r.positions;
    for (let k = 0; k < 8 && measure(model, pos).overlaps > 0; k++) {
        const next = {};
        for (const [id, p] of Object.entries(pos)) {
            next[id] = { x: Math.round(GEOM.margin + (p.x - GEOM.margin) * 1.18), y: Math.round(GEOM.margin + (p.y - GEOM.margin) * 1.18) };
        }
        pos = next;
    }
    return { ...r, positions: pos };
}

export function layoutNet(model, algo = 'auto', opts) {
    if (algo === 'auto') return layoutAuto(model, opts);
    const run = RUNNERS[algo];
    if (!run) throw new Error(`unknown layout algorithm: ${algo}`);
    const r = run(model, opts);
    return algo === 'sugiyama' ? r : relax(model, r);
}

/** Write positions into the model in place (what the editor does). */
export function applyPositions(model, positions) {
    for (const [id, p] of Object.entries(positions)) {
        const obj = (model.places && model.places[id]) || (model.transitions && model.transitions[id]);
        if (obj) { obj.x = p.x; obj.y = p.y; }
    }
    return model;
}

export { measure, chooseLabelSides, score };
