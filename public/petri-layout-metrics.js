// petri-layout-metrics.js — how good is a set of node positions?
// Pure and deterministic. Geometry mirrors the drawn sizes in petri-view.css:
// place circle r=16, transition 30x30, label 12px text under the node (or
// beside it, see chooseLabelSides), wrapped at 150px.

const PLACE_R = 16, TRANS = 30, LINE_H = 15, CHAR_W = 6.4, MAX_W = 150;

function labelDims(text) {
    const s = String(text ?? '');
    let w = s.length * CHAR_W, lines = 1;
    if (w > MAX_W) {
        lines = 1; let cur = 0, wmax = 0;
        for (const word of s.split(/\s+/)) {
            const ww = word.length * CHAR_W;
            if (cur === 0) cur = ww;
            else if (cur + CHAR_W + ww <= MAX_W) cur += CHAR_W + ww;
            else { wmax = Math.max(wmax, cur); lines++; cur = ww; }
        }
        w = Math.min(Math.max(wmax, cur), MAX_W);
    }
    return { w: Math.max(w, 8), h: LINE_H * lines - 2 };
}

function nodeList(model, positions) {
    const out = [];
    for (const [kind, set] of [['place', model.places || {}], ['transition', model.transitions || {}]]) {
        for (const [id, obj] of Object.entries(set)) {
            const p = positions[id];
            if (!p) continue;
            const half = kind === 'place' ? PLACE_R : TRANS / 2;
            out.push({ id, kind, x: p.x, y: p.y, half, label: (obj && obj.label) || id });
        }
    }
    return out;
}

const SIDES = ['below', 'above', 'right', 'left'];

function labelBox(n, side) {
    const d = labelDims(n.label);
    const belowY = n.kind === 'place' ? 46 : 21;   // label top under the node (css: top:100% + 6px of the node's box)
    switch (side) {
        case 'below': return { x0: n.x - d.w / 2, x1: n.x + d.w / 2, y0: n.y + belowY, y1: n.y + belowY + d.h };
        case 'above': return { x0: n.x - d.w / 2, x1: n.x + d.w / 2, y0: n.y - n.half - 6 - d.h, y1: n.y - n.half - 6 };
        case 'right': return { x0: n.x + n.half + 6, x1: n.x + n.half + 6 + d.w, y0: n.y - d.h / 2, y1: n.y + d.h / 2 };
        default: return { x0: n.x - n.half - 6 - d.w, x1: n.x - n.half - 6, y0: n.y - d.h / 2, y1: n.y + d.h / 2 };
    }
}

function segHitsBox(a, b, box) {
    // Liang–Barsky clip of segment a-b against an axis-aligned box
    let t0 = 0, t1 = 1;
    const dx = b.x - a.x, dy = b.y - a.y;
    const clip = (p, q) => {
        if (p === 0) return q >= 0;
        const r = q / p;
        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
        return true;
    };
    return clip(-dx, a.x - box.x0) && clip(dx, box.x1 - a.x) && clip(-dy, a.y - box.y0) && clip(dy, box.y1 - a.y) && t1 >= t0;
}

function shapeBox(n, pad = 0) {
    return { x0: n.x - n.half - pad, x1: n.x + n.half + pad, y0: n.y - n.half - pad, y1: n.y + n.half + pad };
}

function boxesOverlap(a, b) { return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1; }

function segCross(p1, p2, p3, p4) {
    const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function arcSegments(model, byId) {
    const segs = [];
    for (const a of model.arcs || []) {
        const s = byId.get(a.source), t = byId.get(a.target);
        if (s && t && s !== t) segs.push({ s, t });
    }
    return segs;
}

/**
 * Pick, for each node, the side its label goes on: the first of
 * below / above / right / left whose box touches no incident arc, else the
 * side with the fewest hits. The editor uses the same rule, so what is measured
 * is what is drawn.
 */
export function chooseLabelSides(model, positions) {
    const nodes = nodeList(model, positions);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const segs = arcSegments(model, byId);
    const sides = {};
    for (const n of nodes) {
        const mine = segs.filter(e => e.s === n || e.t === n);
        let best = 'below', bestHits = Infinity;
        for (const side of SIDES) {
            const box = labelBox(n, side);
            let hits = 0;
            for (const e of mine) if (segHitsBox(e.s, e.t, box)) hits++;
            if (hits < bestHits) { bestHits = hits; best = side; }
            if (hits === 0) break;
        }
        sides[n.id] = best;
    }
    return sides;
}

export function measure(model, positions) {
    const nodes = nodeList(model, positions);
    const byId = new Map(nodes.map(n => [n.id, n]));
    const segs = arcSegments(model, byId);
    const sides = chooseLabelSides(model, positions);
    const labels = nodes.map(n => ({ n, box: labelBox(n, sides[n.id]) }));

    let crossings = 0;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        if (a.s === b.s || a.s === b.t || a.t === b.s || a.t === b.t) continue;
        if (segCross(a.s, a.t, b.s, b.t)) crossings++;
    }
    let overlaps = 0;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
        if (boxesOverlap(shapeBox(nodes[i], 2), shapeBox(nodes[j], 2))) overlaps++;
    }
    for (const { n, box } of labels) {
        for (const m of nodes) if (m !== n && boxesOverlap(box, shapeBox(m, 2))) overlaps++;
    }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
        if (boxesOverlap(labels[i].box, labels[j].box)) overlaps++;
    }
    let throughNodes = 0, throughLabels = 0, totalLength = 0;
    for (const e of segs) {
        totalLength += Math.hypot(e.s.x - e.t.x, e.s.y - e.t.y);
        for (const m of nodes) if (m !== e.s && m !== e.t && segHitsBox(e.s, e.t, shapeBox(m, 2))) throughNodes++;
        for (const { n, box } of labels) if (segHitsBox(e.s, e.t, box)) throughLabels++;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (b) => { x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); };
    nodes.forEach(n => grow(shapeBox(n)));
    labels.forEach(l => grow(l.box));
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    return {
        nodes: nodes.length, arcs: segs.length,
        crossings, overlaps, throughNodes, throughLabels,
        length: Math.round(totalLength),
        width: Math.round(w), height: Math.round(h),
        aspect: +(Math.max(w / h, h / w)).toFixed(2),
    };
}

/** One number to rank layouts by; smaller is better. */
export function score(m) {
    const aspectPenalty = Math.max(0, m.aspect - 2.2) * 40;
    return m.overlaps * 1000 + m.throughNodes * 120 + m.throughLabels * 40 + m.crossings * 25 + m.length / 60 + aspectPenalty;
}
