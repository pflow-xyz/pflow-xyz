// diagram-viewer.js — Petri Net → String Diagram Web Component
// Translates a Petri net model into a category-theoretic string diagram:
//   Transitions → Boxes (morphisms)
//   Places → Wire types (objects)
//   Arcs → Typed ports and wires

// ── Layout constants ──────────────────────────────────────────────
const BOX_HEIGHT = 40;
const BOX_MIN_WIDTH = 80;
const PORT_SPACING = 24;
const LAYER_GAP = 80;
const BOX_H_GAP = 40;
const PORT_RADIUS = 4;
const PADDING = 30;
const FONT_SIZE = 12;
const LABEL_FONT_SIZE = 10;

// ── Phase 1: Build Boxes ──────────────────────────────────────────
// Each transition becomes a Box with typed input/output ports.
function buildBoxes(model) {
    const places = model.places || {};
    const transitions = model.transitions || {};
    const arcs = model.arcs || [];
    const boxes = [];

    for (const tid of Object.keys(transitions)) {
        const inputs = [];
        const outputs = [];
        for (const arc of arcs) {
            // P → T arc: input port
            if (arc.target === tid && places[arc.source]) {
                inputs.push({
                    wireType: arc.source,
                    weight: arc.weight || [1],
                    inhibit: !!arc.inhibitTransition
                });
            }
            // T → P arc: output port
            if (arc.source === tid && places[arc.target]) {
                outputs.push({
                    wireType: arc.target,
                    weight: arc.weight || [1],
                    inhibit: false
                });
            }
        }
        boxes.push({
            id: tid,
            label: tid,
            inputs,
            outputs,
            layer: 0,
            posInLayer: 0,
            x: 0,
            y: 0,
            width: 0
        });
    }
    return boxes;
}

// ── Phase 2: Build transition DAG ─────────────────────────────────
// Edges through shared places: if T1 outputs to place P and T2 inputs from P,
// then T1 → T2 in the DAG.
function buildDAG(boxes, model) {
    const places = model.places || {};
    const arcs = model.arcs || [];
    const boxIds = new Set(boxes.map(b => b.id));

    // place → [transitions that produce into it]
    const placeProducers = {};
    // place → [transitions that consume from it]
    const placeConsumers = {};
    for (const pid of Object.keys(places)) {
        placeProducers[pid] = [];
        placeConsumers[pid] = [];
    }
    for (const arc of arcs) {
        if (boxIds.has(arc.source) && places[arc.target]) {
            placeProducers[arc.target].push(arc.source);
        }
        if (places[arc.source] && boxIds.has(arc.target)) {
            placeConsumers[arc.source].push(arc.target);
        }
    }

    const outgoing = {};
    const incoming = {};
    for (const b of boxes) {
        outgoing[b.id] = [];
        incoming[b.id] = [];
    }

    for (const pid of Object.keys(places)) {
        for (const src of placeProducers[pid]) {
            for (const tgt of placeConsumers[pid]) {
                if (src !== tgt) {
                    outgoing[src].push(tgt);
                    incoming[tgt].push(src);
                }
            }
        }
    }

    return { outgoing, incoming };
}

// ── Phase 3: DFS cycle-breaking ───────────────────────────────────
function breakCycles(boxes, outgoing) {
    const visited = new Set();
    const onStack = new Set();
    const backEdges = new Set();

    function dfs(id) {
        visited.add(id);
        onStack.add(id);
        for (const t of (outgoing[id] || [])) {
            if (!visited.has(t)) dfs(t);
            else if (onStack.has(t)) backEdges.add(`${id}->${t}`);
        }
        onStack.delete(id);
    }

    for (const b of boxes) {
        if (!visited.has(b.id)) dfs(b.id);
    }
    return backEdges;
}

// ── Phase 4: Longest-path layering ────────────────────────────────
function assignLayers(boxes, outgoing, incoming, backEdges) {
    const level = {};
    for (const b of boxes) level[b.id] = -1;

    // Sources: no non-back incoming edges
    for (const b of boxes) {
        let effectiveIn = 0;
        for (const src of (incoming[b.id] || [])) {
            if (!backEdges.has(`${src}->${b.id}`)) effectiveIn++;
        }
        if (effectiveIn === 0) level[b.id] = 0;
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const b of boxes) {
            if (level[b.id] < 0) continue;
            for (const t of (outgoing[b.id] || [])) {
                if (backEdges.has(`${b.id}->${t}`)) continue;
                const newLevel = level[b.id] + 1;
                if (newLevel > level[t]) {
                    level[t] = newLevel;
                    changed = true;
                }
            }
        }
    }

    // Anything still unassigned → layer 0
    for (const b of boxes) {
        if (level[b.id] < 0) level[b.id] = 0;
    }

    // Write layers onto boxes
    for (const b of boxes) b.layer = level[b.id];

    return level;
}

// ── Phase 5: Barycenter crossing minimization ─────────────────────
function minimizeCrossings(boxes, outgoing, incoming, backEdges) {
    const layers = new Map();
    let maxLayer = 0;
    for (const b of boxes) {
        if (!layers.has(b.layer)) layers.set(b.layer, []);
        layers.get(b.layer).push(b);
        maxLayer = Math.max(maxLayer, b.layer);
    }

    const posOf = {};
    for (let lvl = 0; lvl <= maxLayer; lvl++) {
        (layers.get(lvl) || []).forEach((b, i) => { posOf[b.id] = i; });
    }

    for (let pass = 0; pass < 4; pass++) {
        // Down sweep
        for (let lvl = 1; lvl <= maxLayer; lvl++) {
            const layer = layers.get(lvl) || [];
            const bary = {};
            for (const b of layer) {
                let sum = 0, count = 0;
                for (const src of (incoming[b.id] || [])) {
                    if (backEdges.has(`${src}->${b.id}`)) continue;
                    const srcBox = boxes.find(x => x.id === src);
                    if (srcBox && srcBox.layer === lvl - 1) {
                        sum += posOf[src];
                        count++;
                    }
                }
                bary[b.id] = count > 0 ? sum / count : posOf[b.id];
            }
            layer.sort((a, b) => bary[a.id] - bary[b.id]);
            layer.forEach((b, i) => { posOf[b.id] = i; });
        }
        // Up sweep
        for (let lvl = maxLayer - 1; lvl >= 0; lvl--) {
            const layer = layers.get(lvl) || [];
            const bary = {};
            for (const b of layer) {
                let sum = 0, count = 0;
                for (const tgt of (outgoing[b.id] || [])) {
                    if (backEdges.has(`${b.id}->${tgt}`)) continue;
                    const tgtBox = boxes.find(x => x.id === tgt);
                    if (tgtBox && tgtBox.layer === lvl + 1) {
                        sum += posOf[tgt];
                        count++;
                    }
                }
                bary[b.id] = count > 0 ? sum / count : posOf[b.id];
            }
            layer.sort((a, b) => bary[a.id] - bary[b.id]);
            layer.forEach((b, i) => { posOf[b.id] = i; });
        }
    }

    // Write posInLayer
    for (let lvl = 0; lvl <= maxLayer; lvl++) {
        (layers.get(lvl) || []).forEach((b, i) => { b.posInLayer = i; });
    }

    return layers;
}

// ── Phase 6: Compute positions and route wires ────────────────────
function computePositions(boxes, layers) {
    let maxLayer = 0;
    for (const b of boxes) maxLayer = Math.max(maxLayer, b.layer);

    // Compute box widths based on label and port count
    for (const b of boxes) {
        const labelWidth = b.label.length * (FONT_SIZE * 0.65) + 20;
        const inputsWidth = b.inputs.length * PORT_SPACING;
        const outputsWidth = b.outputs.length * PORT_SPACING;
        b.width = Math.max(BOX_MIN_WIDTH, labelWidth, inputsWidth, outputsWidth);
    }

    // Position boxes: center each layer
    for (let lvl = 0; lvl <= maxLayer; lvl++) {
        const layer = layers.get(lvl) || [];
        let totalWidth = 0;
        for (const b of layer) totalWidth += b.width;
        totalWidth += (layer.length - 1) * BOX_H_GAP;

        let xCursor = PADDING + (totalWidth > 0 ? 0 : 0);
        const y = PADDING + lvl * (BOX_HEIGHT + LAYER_GAP);
        for (const b of layer) {
            b.x = xCursor;
            b.y = y;
            xCursor += b.width + BOX_H_GAP;
        }
    }
}

function getPortX(box, portIndex, portCount) {
    if (portCount <= 0) return box.x + box.width / 2;
    const totalSpan = (portCount - 1) * PORT_SPACING;
    const startX = box.x + (box.width - totalSpan) / 2;
    return startX + portIndex * PORT_SPACING;
}

function routeWires(boxes, model, backEdges) {
    const places = model.places || {};
    const arcs = model.arcs || [];
    const wires = [];
    const boxMap = {};
    for (const b of boxes) boxMap[b.id] = b;

    // Build port position maps: for each box, map wireType → {x, y}
    // Outputs are on the bottom of the box, inputs on top
    const outputPositions = {}; // boxId -> wireType -> {x, y}
    const inputPositions = {};

    for (const b of boxes) {
        outputPositions[b.id] = {};
        inputPositions[b.id] = {};
        for (let i = 0; i < b.outputs.length; i++) {
            const port = b.outputs[i];
            outputPositions[b.id][port.wireType] = {
                x: getPortX(b, i, b.outputs.length),
                y: b.y + BOX_HEIGHT,
                portIndex: i
            };
        }
        for (let i = 0; i < b.inputs.length; i++) {
            const port = b.inputs[i];
            inputPositions[b.id][port.wireType] = {
                x: getPortX(b, i, b.inputs.length),
                y: b.y,
                portIndex: i
            };
        }
    }

    // Connect matching output→input ports through shared places
    for (const pid of Object.keys(places)) {
        // Find producers and consumers for this place
        const producers = [];
        const consumers = [];
        for (const arc of arcs) {
            if (arc.source && boxMap[arc.source] && arc.target === pid) {
                producers.push({ boxId: arc.source, arc });
            }
            if (arc.target && boxMap[arc.target] && arc.source === pid) {
                consumers.push({ boxId: arc.target, arc });
            }
        }

        for (const prod of producers) {
            for (const cons of consumers) {
                const isBack = backEdges.has(`${prod.boxId}->${cons.boxId}`);
                const outPos = outputPositions[prod.boxId]?.[pid];
                const inPos = inputPositions[cons.boxId]?.[pid];
                if (outPos && inPos) {
                    wires.push({
                        wireType: pid,
                        fromX: outPos.x,
                        fromY: outPos.y,
                        toX: inPos.x,
                        toY: inPos.y,
                        isCrossing: false,
                        isBack,
                        inhibit: !!cons.arc.inhibitTransition,
                        weight: prod.arc.weight || [1]
                    });
                }
            }
        }
    }

    // Detect crossings: two wires cross if their X-coordinates swap order
    for (let i = 0; i < wires.length; i++) {
        for (let j = i + 1; j < wires.length; j++) {
            const a = wires[i], b = wires[j];
            if (a.isBack || b.isBack) continue;
            const aDir = a.toX - a.fromX;
            const bDir = b.toX - b.fromX;
            if ((a.fromX < b.fromX && a.toX > b.toX) ||
                (a.fromX > b.fromX && a.toX < b.toX)) {
                a.isCrossing = true;
                b.isCrossing = true;
            }
        }
    }

    return wires;
}

// Find boundary wires: source places (no producer) and sink places (no consumer)
function findBoundaries(boxes, model) {
    const places = model.places || {};
    const arcs = model.arcs || [];
    const boxSet = new Set(boxes.map(b => b.id));

    const produced = new Set();
    const consumed = new Set();
    for (const arc of arcs) {
        if (boxSet.has(arc.source) && places[arc.target]) produced.add(arc.target);
        if (places[arc.source] && boxSet.has(arc.target)) consumed.add(arc.source);
    }

    const boundaryInputs = [];  // places consumed but not produced → enter from top
    const boundaryOutputs = []; // places produced but not consumed → exit at bottom
    for (const pid of Object.keys(places)) {
        if (consumed.has(pid) && !produced.has(pid)) boundaryInputs.push(pid);
        if (produced.has(pid) && !consumed.has(pid)) boundaryOutputs.push(pid);
    }

    return { boundaryInputs, boundaryOutputs };
}

// ── Main translation function ─────────────────────────────────────
function translatePetriNet(model) {
    if (!model) return { boxes: [], wires: [], boundaryInputs: [], boundaryOutputs: [], backEdges: [], width: 0, height: 0 };

    const boxes = buildBoxes(model);
    if (boxes.length === 0) {
        return { boxes: [], wires: [], boundaryInputs: [], boundaryOutputs: [], backEdges: [], width: 0, height: 0 };
    }

    const { outgoing, incoming } = buildDAG(boxes, model);
    const backEdges = breakCycles(boxes, outgoing);
    assignLayers(boxes, outgoing, incoming, backEdges);
    const layers = minimizeCrossings(boxes, outgoing, incoming, backEdges);
    computePositions(boxes, layers);

    const wires = routeWires(boxes, model, backEdges);
    const { boundaryInputs, boundaryOutputs } = findBoundaries(boxes, model);

    // Compute total dimensions
    let maxX = 0, maxY = 0;
    for (const b of boxes) {
        maxX = Math.max(maxX, b.x + b.width);
        maxY = Math.max(maxY, b.y + BOX_HEIGHT);
    }

    return {
        boxes,
        wires,
        boundaryInputs,
        boundaryOutputs,
        backEdges: [...backEdges],
        width: maxX + PADDING,
        height: maxY + PADDING + (boundaryOutputs.length > 0 ? LAYER_GAP : 0)
    };
}

// ── SVG generation ────────────────────────────────────────────────
function generateSVG(diagram) {
    const { boxes, wires, boundaryInputs, boundaryOutputs, width, height } = diagram;
    const parts = [];

    // Find max layer for boundary output positioning
    let maxLayer = 0;
    for (const b of boxes) maxLayer = Math.max(maxLayer, b.layer);

    const svgWidth = Math.max(width, 200);
    const svgHeight = Math.max(height, 100);

    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" font-family="sans-serif">`);

    // Defs for arrowhead
    parts.push(`<defs>`);
    parts.push(`<marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#666"/></marker>`);
    parts.push(`<marker id="arrowhead-back" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#c44"/></marker>`);
    parts.push(`</defs>`);

    // Background
    parts.push(`<rect width="${svgWidth}" height="${svgHeight}" fill="#fafafa" rx="4"/>`);

    // ── Draw boundary input wires (source places entering from top) ──
    if (boundaryInputs.length > 0) {
        const boxMap = {};
        for (const b of boxes) boxMap[b.id] = b;

        for (const pid of boundaryInputs) {
            // Find which boxes consume this place
            for (const b of boxes) {
                for (let i = 0; i < b.inputs.length; i++) {
                    if (b.inputs[i].wireType === pid) {
                        const px = getPortX(b, i, b.inputs.length);
                        const py = b.y;
                        const startY = Math.max(0, py - LAYER_GAP / 2);
                        const dash = b.inputs[i].inhibit ? ' stroke-dasharray="4,3"' : '';
                        parts.push(`<path d="M${px},${startY} C${px},${startY + 15} ${px},${py - 15} ${px},${py}" stroke="#888" stroke-width="1.5" fill="none"${dash}/>`);
                        // Label
                        parts.push(`<text x="${px}" y="${startY + (py - startY) / 2}" text-anchor="middle" font-size="${LABEL_FONT_SIZE}" fill="#666" dy="-3">${escapeXml(pid)}</text>`);
                        // Port dot
                        if (b.inputs[i].inhibit) {
                            parts.push(`<circle cx="${px}" cy="${py}" r="${PORT_RADIUS}" fill="none" stroke="#c44" stroke-width="1.5"/>`);
                        } else {
                            parts.push(`<circle cx="${px}" cy="${py}" r="${PORT_RADIUS}" fill="#666"/>`);
                        }
                    }
                }
            }
        }
    }

    // ── Draw wires ──
    for (const w of wires) {
        if (w.isBack) continue; // draw back edges separately
        const midY = (w.fromY + w.toY) / 2;
        const stroke = w.inhibit ? '#c44' : '#888';
        const dash = w.inhibit ? ' stroke-dasharray="4,3"' : '';
        parts.push(`<path d="M${w.fromX},${w.fromY} C${w.fromX},${midY} ${w.toX},${midY} ${w.toX},${w.toY}" stroke="${stroke}" stroke-width="1.5" fill="none"${dash}/>`);

        // Wire label at midpoint
        const labelX = (w.fromX + w.toX) / 2;
        const labelY = midY;
        parts.push(`<text x="${labelX}" y="${labelY}" text-anchor="middle" font-size="${LABEL_FONT_SIZE}" fill="#666" dy="-4">${escapeXml(w.wireType)}</text>`);

        // Weight label if > 1
        const wt = (w.weight && w.weight[0] > 1) ? w.weight[0] : 0;
        if (wt > 0) {
            parts.push(`<text x="${labelX + 8}" y="${labelY}" text-anchor="start" font-size="${LABEL_FONT_SIZE}" fill="#c44" dy="8" font-weight="bold">${wt}</text>`);
        }
    }

    // ── Draw back edges (feedback arcs) ──
    for (const w of wires) {
        if (!w.isBack) continue;
        // Route around the right side
        const rightX = svgWidth - PADDING / 2;
        const midY1 = w.fromY + 20;
        const midY2 = w.toY - 20;
        parts.push(`<path d="M${w.fromX},${w.fromY} C${w.fromX + 30},${midY1} ${rightX},${midY1} ${rightX},${(w.fromY + w.toY) / 2}" stroke="#c44" stroke-width="1.5" fill="none" stroke-dasharray="6,3"/>`);
        parts.push(`<path d="M${rightX},${(w.fromY + w.toY) / 2} C${rightX},${midY2} ${w.toX + 30},${midY2} ${w.toX},${w.toY}" stroke="#c44" stroke-width="1.5" fill="none" stroke-dasharray="6,3" marker-end="url(#arrowhead-back)"/>`);
        // Label
        parts.push(`<text x="${rightX - 4}" y="${(w.fromY + w.toY) / 2}" text-anchor="end" font-size="${LABEL_FONT_SIZE}" fill="#c44" dy="-3">${escapeXml(w.wireType)}</text>`);
    }

    // ── Draw boxes ──
    for (const b of boxes) {
        // Box rectangle
        parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${BOX_HEIGHT}" rx="6" fill="white" stroke="#333" stroke-width="1.5"/>`);
        // Label
        parts.push(`<text x="${b.x + b.width / 2}" y="${b.y + BOX_HEIGHT / 2}" text-anchor="middle" dominant-baseline="central" font-size="${FONT_SIZE}" fill="#333">${escapeXml(b.label)}</text>`);

        // Input ports (top)
        for (let i = 0; i < b.inputs.length; i++) {
            const px = getPortX(b, i, b.inputs.length);
            const py = b.y;
            if (b.inputs[i].inhibit) {
                parts.push(`<circle cx="${px}" cy="${py}" r="${PORT_RADIUS}" fill="none" stroke="#c44" stroke-width="1.5"/>`);
            } else {
                parts.push(`<circle cx="${px}" cy="${py}" r="${PORT_RADIUS}" fill="#666"/>`);
            }
        }
        // Output ports (bottom)
        for (let i = 0; i < b.outputs.length; i++) {
            const px = getPortX(b, i, b.outputs.length);
            const py = b.y + BOX_HEIGHT;
            parts.push(`<circle cx="${px}" cy="${py}" r="${PORT_RADIUS}" fill="#666"/>`);
        }
    }

    // ── Draw boundary output wires (sink places exiting at bottom) ──
    if (boundaryOutputs.length > 0) {
        for (const pid of boundaryOutputs) {
            for (const b of boxes) {
                for (let i = 0; i < b.outputs.length; i++) {
                    if (b.outputs[i].wireType === pid) {
                        const px = getPortX(b, i, b.outputs.length);
                        const py = b.y + BOX_HEIGHT;
                        const endY = py + LAYER_GAP / 2;
                        parts.push(`<path d="M${px},${py} C${px},${py + 15} ${px},${endY - 15} ${px},${endY}" stroke="#888" stroke-width="1.5" fill="none"/>`);
                        parts.push(`<text x="${px}" y="${py + (endY - py) / 2}" text-anchor="middle" font-size="${LABEL_FONT_SIZE}" fill="#666" dy="-3">${escapeXml(pid)}</text>`);
                    }
                }
            }
        }
    }

    parts.push(`</svg>`);
    return parts.join('\n');
}

function escapeXml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Web Component (browser only) ──────────────────────────────────
let DiagramViewer;
if (typeof HTMLElement !== 'undefined') {
    DiagramViewer = class DiagramViewer extends HTMLElement {
        constructor() {
            super();
            this._model = null;
            this._diagram = null;
            this._svgString = '';
        }

        get model() { return this._model; }
        set model(m) {
            this._model = m;
            this._compile();
            this._render();
        }

        get svgString() { return this._svgString; }
        get diagram() { return this._diagram; }

        connectedCallback() {
            if (this._model) this._render();
        }

        _compile() {
            this._diagram = translatePetriNet(this._model);
            this._svgString = generateSVG(this._diagram);
        }

        _render() {
            if (!this._svgString) return;
            this.innerHTML = this._svgString;
            const svg = this.querySelector('svg');
            if (svg) {
                svg.style.width = '100%';
                svg.style.height = 'auto';
                svg.style.maxHeight = 'calc(90vh - 120px)';
            }
        }
    };
    customElements.define('diagram-viewer', DiagramViewer);
}

export {
    DiagramViewer,
    translatePetriNet,
    buildBoxes,
    buildDAG,
    breakCycles,
    assignLayers,
    minimizeCrossings,
    routeWires,
    findBoundaries,
    generateSVG
};
