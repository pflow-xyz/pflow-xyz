// The layout algorithms as they were before petri-layout.js (copied verbatim
// from public/petri-view.js at 2e8582b), run against a bare model so the
// benchmark can show before/after. Not used by the editor.
class Legacy {
    constructor(model) { this._model = model; }
    _pushHistory() {} _renderUI() {} _syncLD() {}

    _normalizeNodePositions(minMargin = 100) {
        // Find current bounds
        let minX = Infinity, minY = Infinity;
        
        for (const place of Object.values(this._model.places || {})) {
            if (place.x !== undefined) minX = Math.min(minX, place.x);
            if (place.y !== undefined) minY = Math.min(minY, place.y);
        }
        
        for (const transition of Object.values(this._model.transitions || {})) {
            if (transition.x !== undefined) minX = Math.min(minX, transition.x);
            if (transition.y !== undefined) minY = Math.min(minY, transition.y);
        }
        
        // Calculate offset needed to ensure minimum margin
        const offsetX = minX < minMargin ? minMargin - minX : 0;
        const offsetY = minY < minMargin ? minMargin - minY : 0;
        
        // Apply offset if needed
        if (offsetX > 0 || offsetY > 0) {
            for (const place of Object.values(this._model.places || {})) {
                if (place.x !== undefined) place.x += offsetX;
                if (place.y !== undefined) place.y += offsetY;
            }
            
            for (const transition of Object.values(this._model.transitions || {})) {
                if (transition.x !== undefined) transition.x += offsetX;
                if (transition.y !== undefined) transition.y += offsetY;
            }
        }
    }

    _applySugiyamaLayout() {
        this._pushHistory();

        const nodes = new Map();
        for (const [id] of Object.entries(this._model.places || {})) {
            nodes.set(id, { id, type: 'place', level: -1 });
        }
        for (const [id] of Object.entries(this._model.transitions || {})) {
            nodes.set(id, { id, type: 'transition', level: -1 });
        }
        if (nodes.size === 0) return;

        // Build adjacency lists
        const outgoing = new Map();
        const incoming = new Map();
        for (const [id] of nodes) {
            outgoing.set(id, []);
            incoming.set(id, []);
        }
        for (const arc of (this._model.arcs || [])) {
            if (nodes.has(arc.source) && nodes.has(arc.target)) {
                outgoing.get(arc.source).push(arc.target);
                incoming.get(arc.target).push(arc.source);
            }
        }

        // Phase 1: DFS cycle-breaking
        const visited = new Set();
        const onStack = new Set();
        const backEdges = new Set();
        const dfs = (id) => {
            visited.add(id);
            onStack.add(id);
            for (const t of outgoing.get(id)) {
                if (!visited.has(t)) dfs(t);
                else if (onStack.has(t)) backEdges.add(`${id}->${t}`);
            }
            onStack.delete(id);
        };
        for (const [id] of nodes) {
            if (!visited.has(id)) dfs(id);
        }

        // Phase 2: Longest-path level assignment (ignoring back edges)
        for (const [id] of nodes) {
            let effectiveIn = 0;
            for (const src of incoming.get(id)) {
                if (!backEdges.has(`${src}->${id}`)) effectiveIn++;
            }
            if (effectiveIn === 0) nodes.get(id).level = 0;
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const [id, node] of nodes) {
                if (node.level < 0) continue;
                for (const t of outgoing.get(id)) {
                    if (backEdges.has(`${id}->${t}`)) continue;
                    const newLevel = node.level + 1;
                    if (newLevel > nodes.get(t).level) {
                        nodes.get(t).level = newLevel;
                        changed = true;
                    }
                }
            }
        }
        for (const [, node] of nodes) {
            if (node.level < 0) node.level = 0;
        }

        // Group by level
        const levels = new Map();
        let maxLevel = 0;
        for (const [, node] of nodes) {
            if (!levels.has(node.level)) levels.set(node.level, []);
            levels.get(node.level).push(node);
            maxLevel = Math.max(maxLevel, node.level);
        }

        // Phase 3: Barycenter crossing minimization (4 passes, 2 sweeps each)
        const posOf = new Map();
        for (let lvl = 0; lvl <= maxLevel; lvl++) {
            (levels.get(lvl) || []).forEach((n, i) => posOf.set(n.id, i));
        }

        for (let pass = 0; pass < 4; pass++) {
            // Down sweep
            for (let lvl = 1; lvl <= maxLevel; lvl++) {
                const layer = levels.get(lvl) || [];
                const bary = new Map();
                for (const node of layer) {
                    let sum = 0, count = 0;
                    for (const src of incoming.get(node.id)) {
                        if (backEdges.has(`${src}->${node.id}`)) continue;
                        if (nodes.get(src).level === lvl - 1) {
                            sum += posOf.get(src);
                            count++;
                        }
                    }
                    bary.set(node.id, count > 0 ? sum / count : posOf.get(node.id));
                }
                layer.sort((a, b) => bary.get(a.id) - bary.get(b.id));
                layer.forEach((n, i) => posOf.set(n.id, i));
            }
            // Up sweep
            for (let lvl = maxLevel - 1; lvl >= 0; lvl--) {
                const layer = levels.get(lvl) || [];
                const bary = new Map();
                for (const node of layer) {
                    let sum = 0, count = 0;
                    for (const tgt of outgoing.get(node.id)) {
                        if (backEdges.has(`${node.id}->${tgt}`)) continue;
                        if (nodes.get(tgt).level === lvl + 1) {
                            sum += posOf.get(tgt);
                            count++;
                        }
                    }
                    bary.set(node.id, count > 0 ? sum / count : posOf.get(node.id));
                }
                layer.sort((a, b) => bary.get(a.id) - bary.get(b.id));
                layer.forEach((n, i) => posOf.set(n.id, i));
            }
        }

        // Phase 4: Assign coordinates
        const levelSpacing = 150;
        const nodeSpacing = 120;
        const startY = 100;

        for (let lvl = 0; lvl <= maxLevel; lvl++) {
            const layer = levels.get(lvl) || [];
            const totalWidth = (layer.length - 1) * nodeSpacing;
            const startX = 400 - totalWidth / 2;

            layer.forEach((node, i) => {
                const x = Math.round(startX + i * nodeSpacing);
                const y = Math.round(startY + lvl * levelSpacing);
                if (node.type === 'place') {
                    this._model.places[node.id].x = x;
                    this._model.places[node.id].y = y;
                } else {
                    this._model.transitions[node.id].x = x;
                    this._model.transitions[node.id].y = y;
                }
            });
        }

        this._normalizeNodePositions(100);
        this._renderUI();
        this._syncLD();
    }

    _applyGridLayout() {
        this._pushHistory();

        const places = Object.keys(this._model.places || {});
        const transitions = Object.keys(this._model.transitions || {});
        const totalNodes = places.length + transitions.length;
        if (totalNodes === 0) return;

        // Compute degree for each node
        const degree = {};
        for (const arc of (this._model.arcs || [])) {
            degree[arc.source] = (degree[arc.source] || 0) + 1;
            degree[arc.target] = (degree[arc.target] || 0) + 1;
        }

        // Collect all nodes with type
        const nodeList = [];
        for (const id of places) nodeList.push({ id, type: 'place', degree: degree[id] || 0 });
        for (const id of transitions) nodeList.push({ id, type: 'transition', degree: degree[id] || 0 });

        // Sort by degree descending
        nodeList.sort((a, b) => b.degree - a.degree);

        // Grid parameters
        const cols = Math.ceil(Math.sqrt(totalNodes));
        const spacing = 120;
        const rows = Math.ceil(totalNodes / cols);
        const totalWidth = (cols - 1) * spacing;
        const totalHeight = (rows - 1) * spacing;
        const offsetX = 400 - totalWidth / 2;
        const offsetY = 300 - totalHeight / 2;

        for (let i = 0; i < nodeList.length; i++) {
            const node = nodeList[i];
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = Math.round(offsetX + col * spacing);
            const y = Math.round(offsetY + row * spacing);

            if (node.type === 'place') {
                this._model.places[node.id].x = x;
                this._model.places[node.id].y = y;
            } else {
                this._model.transitions[node.id].x = x;
                this._model.transitions[node.id].y = y;
            }
        }

        this._normalizeNodePositions(100);
        this._renderUI();
        this._syncLD();
    }

    _applyBipartiteLayout() {
        this._pushHistory();

        const placeIds = Object.keys(this._model.places || {});
        const transitionIds = Object.keys(this._model.transitions || {});
        if (placeIds.length + transitionIds.length === 0) return;

        // Build neighbor map (regardless of arc direction)
        const neighbors = {};
        for (const arc of (this._model.arcs || [])) {
            if (!neighbors[arc.source]) neighbors[arc.source] = [];
            if (!neighbors[arc.target]) neighbors[arc.target] = [];
            neighbors[arc.source].push(arc.target);
            neighbors[arc.target].push(arc.source);
        }

        // Working copies
        const places = placeIds.slice();
        const transitions = transitionIds.slice();

        // Assign initial positions
        const posOf = {};
        places.forEach((id, i) => posOf[id] = i);
        transitions.forEach((id, i) => posOf[id] = i);

        // Barycenter sort: 4 iterations alternating columns
        for (let iter = 0; iter < 4; iter++) {
            // Sort transitions by barycenter of neighboring places
            const tBary = {};
            for (const id of transitions) {
                let sum = 0, count = 0;
                for (const nb of (neighbors[id] || [])) {
                    if (this._model.places && this._model.places[nb]) {
                        sum += posOf[nb];
                        count++;
                    }
                }
                tBary[id] = count > 0 ? sum / count : posOf[id];
            }
            transitions.sort((a, b) => tBary[a] - tBary[b]);
            transitions.forEach((id, i) => posOf[id] = i);

            // Sort places by barycenter of neighboring transitions
            const pBary = {};
            for (const id of places) {
                let sum = 0, count = 0;
                for (const nb of (neighbors[id] || [])) {
                    if (this._model.transitions && this._model.transitions[nb]) {
                        sum += posOf[nb];
                        count++;
                    }
                }
                pBary[id] = count > 0 ? sum / count : posOf[id];
            }
            places.sort((a, b) => pBary[a] - pBary[b]);
            places.forEach((id, i) => posOf[id] = i);
        }

        // Assign coordinates
        const colGap = 300;
        const vSpacing = 120;
        const leftX = 250;
        const rightX = leftX + colGap;
        const centerY = 300;

        const placeHeight = (places.length - 1) * vSpacing;
        const transHeight = (transitions.length - 1) * vSpacing;
        const placeStartY = centerY - placeHeight / 2;
        const transStartY = centerY - transHeight / 2;

        places.forEach((id, i) => {
            this._model.places[id].x = leftX;
            this._model.places[id].y = Math.round(placeStartY + i * vSpacing);
        });
        transitions.forEach((id, i) => {
            this._model.transitions[id].x = rightX;
            this._model.transitions[id].y = Math.round(transStartY + i * vSpacing);
        });

        this._normalizeNodePositions(100);
        this._renderUI();
        this._syncLD();
    }

    _applyCircularLayout() {
        // Save state for undo
        this._pushHistory();

        // Get all nodes
        const nodes = [];
        for (const id of Object.keys(this._model.places || {})) {
            nodes.push({ id, type: 'place' });
        }
        for (const id of Object.keys(this._model.transitions || {})) {
            nodes.push({ id, type: 'transition' });
        }

        if (nodes.length === 0) return;

        // Layout parameters
        const centerX = 500;
        const centerY = 400;
        const radius = Math.min(300, 50 + nodes.length * 15);

        // Position nodes in a circle
        nodes.forEach((node, index) => {
            const angle = (2 * Math.PI * index) / nodes.length - Math.PI / 2; // Start at top
            const x = Math.round(centerX + radius * Math.cos(angle));
            const y = Math.round(centerY + radius * Math.sin(angle));

            if (node.type === 'place') {
                this._model.places[node.id].x = x;
                this._model.places[node.id].y = y;
            } else {
                this._model.transitions[node.id].x = x;
                this._model.transitions[node.id].y = y;
            }
        });

        // Ensure all coordinates are non-negative
        this._normalizeNodePositions(100);

        // Update the view
        this._renderUI();
        this._syncLD();
    }

    _applyStringDiagramLayout() {
        this._pushHistory();

        const transitionIds = Object.keys(this._model.transitions || {});
        const placeIds = Object.keys(this._model.places || {});
        if (transitionIds.length + placeIds.length === 0) return;

        // Phase 1: Build transition-only DAG mediated by places
        // For each place, find input transitions (T→P) and output transitions (P→T)
        const placeInputs = {};  // place -> [transitions that feed into it]
        const placeOutputs = {}; // place -> [transitions it feeds into]
        for (const id of placeIds) {
            placeInputs[id] = [];
            placeOutputs[id] = [];
        }
        for (const arc of (this._model.arcs || [])) {
            if (this._model.transitions && this._model.transitions[arc.source] &&
                this._model.places && this._model.places[arc.target]) {
                // T → P arc
                placeInputs[arc.target].push(arc.source);
            }
            if (this._model.places && this._model.places[arc.source] &&
                this._model.transitions && this._model.transitions[arc.target]) {
                // P → T arc
                placeOutputs[arc.source].push(arc.target);
            }
        }

        // Build transition-to-transition edges (through places)
        const tOutgoing = {};
        const tIncoming = {};
        for (const id of transitionIds) {
            tOutgoing[id] = [];
            tIncoming[id] = [];
        }
        for (const pid of placeIds) {
            for (const src of placeInputs[pid]) {
                for (const tgt of placeOutputs[pid]) {
                    if (src !== tgt) {
                        tOutgoing[src].push(tgt);
                        tIncoming[tgt].push(src);
                    }
                }
            }
        }

        // Phase 2: DFS cycle-breaking on transition graph
        const visited = new Set();
        const onStack = new Set();
        const backEdges = new Set();
        const dfs = (id) => {
            visited.add(id);
            onStack.add(id);
            for (const t of tOutgoing[id]) {
                if (!visited.has(t)) dfs(t);
                else if (onStack.has(t)) backEdges.add(`${id}->${t}`);
            }
            onStack.delete(id);
        };
        for (const id of transitionIds) {
            if (!visited.has(id)) dfs(id);
        }

        // Phase 3: Longest-path layer assignment for transitions
        const tLevel = {};
        for (const id of transitionIds) tLevel[id] = -1;

        // Sources: transitions with no non-back incoming edges
        for (const id of transitionIds) {
            let effectiveIn = 0;
            for (const src of tIncoming[id]) {
                if (!backEdges.has(`${src}->${id}`)) effectiveIn++;
            }
            if (effectiveIn === 0) tLevel[id] = 0;
        }

        let changed = true;
        while (changed) {
            changed = false;
            for (const id of transitionIds) {
                if (tLevel[id] < 0) continue;
                for (const t of tOutgoing[id]) {
                    if (backEdges.has(`${id}->${t}`)) continue;
                    const newLevel = tLevel[id] + 1;
                    if (newLevel > tLevel[t]) {
                        tLevel[t] = newLevel;
                        changed = true;
                    }
                }
            }
        }
        for (const id of transitionIds) {
            if (tLevel[id] < 0) tLevel[id] = 0;
        }

        // Group transitions by layer
        const layers = new Map();
        let maxLayer = 0;
        for (const id of transitionIds) {
            const lvl = tLevel[id];
            if (!layers.has(lvl)) layers.set(lvl, []);
            layers.get(lvl).push(id);
            maxLayer = Math.max(maxLayer, lvl);
        }

        // Phase 4: Barycenter crossing minimization on transition layers
        const posOf = {};
        for (let lvl = 0; lvl <= maxLayer; lvl++) {
            (layers.get(lvl) || []).forEach((id, i) => posOf[id] = i);
        }

        for (let pass = 0; pass < 4; pass++) {
            // Down sweep
            for (let lvl = 1; lvl <= maxLayer; lvl++) {
                const layer = layers.get(lvl) || [];
                const bary = {};
                for (const id of layer) {
                    let sum = 0, count = 0;
                    for (const src of tIncoming[id]) {
                        if (backEdges.has(`${src}->${id}`)) continue;
                        if (tLevel[src] === lvl - 1) {
                            sum += posOf[src];
                            count++;
                        }
                    }
                    bary[id] = count > 0 ? sum / count : posOf[id];
                }
                layer.sort((a, b) => bary[a] - bary[b]);
                layer.forEach((id, i) => posOf[id] = i);
            }
            // Up sweep
            for (let lvl = maxLayer - 1; lvl >= 0; lvl--) {
                const layer = layers.get(lvl) || [];
                const bary = {};
                for (const id of layer) {
                    let sum = 0, count = 0;
                    for (const tgt of tOutgoing[id]) {
                        if (backEdges.has(`${id}->${tgt}`)) continue;
                        if (tLevel[tgt] === lvl + 1) {
                            sum += posOf[tgt];
                            count++;
                        }
                    }
                    bary[id] = count > 0 ? sum / count : posOf[id];
                }
                layer.sort((a, b) => bary[a] - bary[b]);
                layer.forEach((id, i) => posOf[id] = i);
            }
        }

        // Phase 5: Assign transition coordinates
        const layerSpacing = 180;
        const boxSpacing = 120;
        const startY = 100;

        for (let lvl = 0; lvl <= maxLayer; lvl++) {
            const layer = layers.get(lvl) || [];
            const totalWidth = (layer.length - 1) * boxSpacing;
            const startX = 400 - totalWidth / 2;

            layer.forEach((id, i) => {
                this._model.transitions[id].x = Math.round(startX + i * boxSpacing);
                this._model.transitions[id].y = Math.round(startY + lvl * layerSpacing);
            });
        }

        // Phase 6: Position places along wires
        for (const pid of placeIds) {
            const inputs = placeInputs[pid];
            const outputs = placeOutputs[pid];

            if (inputs.length > 0 && outputs.length > 0) {
                // Place on the wire: midpoint between avg source and avg target layers
                let srcLayerSum = 0, srcXSum = 0;
                for (const t of inputs) {
                    srcLayerSum += tLevel[t];
                    srcXSum += this._model.transitions[t].x;
                }
                let tgtLayerSum = 0, tgtXSum = 0;
                for (const t of outputs) {
                    tgtLayerSum += tLevel[t];
                    tgtXSum += this._model.transitions[t].x;
                }
                const avgSrcLayer = srcLayerSum / inputs.length;
                const avgTgtLayer = tgtLayerSum / outputs.length;
                const avgSrcX = srcXSum / inputs.length;
                const avgTgtX = tgtXSum / outputs.length;

                const midLayer = (avgSrcLayer + avgTgtLayer) / 2;
                this._model.places[pid].x = Math.round((avgSrcX + avgTgtX) / 2);
                this._model.places[pid].y = Math.round(startY + midLayer * layerSpacing);
            } else if (inputs.length > 0) {
                // Output boundary: place below its source transitions
                let srcXSum = 0, srcLayerMax = 0;
                for (const t of inputs) {
                    srcXSum += this._model.transitions[t].x;
                    srcLayerMax = Math.max(srcLayerMax, tLevel[t]);
                }
                this._model.places[pid].x = Math.round(srcXSum / inputs.length);
                this._model.places[pid].y = Math.round(startY + (srcLayerMax + 0.5) * layerSpacing);
            } else if (outputs.length > 0) {
                // Input boundary: place above its target transitions
                let tgtXSum = 0, tgtLayerMin = maxLayer;
                for (const t of outputs) {
                    tgtXSum += this._model.transitions[t].x;
                    tgtLayerMin = Math.min(tgtLayerMin, tLevel[t]);
                }
                this._model.places[pid].x = Math.round(tgtXSum / outputs.length);
                this._model.places[pid].y = Math.round(startY + (tgtLayerMin - 0.5) * layerSpacing);
            } else {
                // Disconnected: place at bottom
                this._model.places[pid].x = 400;
                this._model.places[pid].y = Math.round(startY + (maxLayer + 1.5) * layerSpacing);
            }
        }

        this._normalizeNodePositions(100);
        this._renderUI();
        this._syncLD();
    }
}

export function legacyLayout(model, algo) {
    const m = JSON.parse(JSON.stringify(model));
    for (const o of [...Object.values(m.places||{}), ...Object.values(m.transitions||{})]) { delete o.x; delete o.y; }
    const l = new Legacy(m);
    ({sugiyama:'_applySugiyamaLayout',grid:'_applyGridLayout',bipartite:'_applyBipartiteLayout',circular:'_applyCircularLayout',string:'_applyStringDiagramLayout'})[algo];
    l[{sugiyama:'_applySugiyamaLayout',grid:'_applyGridLayout',bipartite:'_applyBipartiteLayout',circular:'_applyCircularLayout',string:'_applyStringDiagramLayout'}[algo]]();
    const positions = {};
    for (const [id,o] of Object.entries(m.places||{})) positions[id] = {x:o.x,y:o.y};
    for (const [id,o] of Object.entries(m.transitions||{})) positions[id] = {x:o.x,y:o.y};
    return positions;
}
