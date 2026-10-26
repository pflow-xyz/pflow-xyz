// Copy / paste for places and transitions, DOM-free so it can be tested under
// Deno. Mirrors pflow-native's crates/core/src/commands/clipboard.rs
// (edit.copy / edit.cut / edit.paste / edit.duplicate): the clipboard is
// in-memory only, paste mints fresh ids and keeps the copied coordinates plus an
// offset, and arcs travel only when both of their ends were copied.
//
// A clip is plain data: {places: [{id, node}], transitions: [{id, node}], arcs: []}.
// Nodes and arcs are deep clones, so editing the net after a copy never
// changes what a later paste puts down. Places and transitions are arrays (not
// objects) so their order survives integer-like ids, which JS would reorder.

export const DEFAULT_PASTE_OFFSET = 40;

/** True when `id` names a place or a transition in `model`. */
function used(model, id) {
    return Object.hasOwn(model.places || {}, id) || Object.hasOwn(model.transitions || {}, id);
}

/**
 * The first free `${prefix}${n}` (n = 0, 1, 2, ...), where free means unused by
 * any place OR transition (pflow-native doc.rs fresh_id).
 * @param {{places?: Object, transitions?: Object}} model
 * @param {string} prefix
 * @returns {string}
 */
export function freshId(model, prefix) {
    for (let n = 0; ; n++) {
        const id = `${prefix}${n}`;
        if (!used(model, id)) return id;
    }
}

/**
 * Deep-clone the selected places and transitions, and the arcs whose source AND
 * target are both selected. Changes nothing in `model`.
 * @param {Object} model
 * @param {Iterable<string>} selectedIds
 * @returns {{places: Array, transitions: Array, arcs: Array}|null} null when
 *   the selection names no place or transition.
 */
export function copySelection(model, selectedIds) {
    const sel = new Set(selectedIds || []);
    if (!model || sel.size === 0) return null;
    const places = [];
    for (const [id, node] of Object.entries(model.places || {})) {
        if (sel.has(id)) places.push({id, node: structuredClone(node)});
    }
    const transitions = [];
    for (const [id, node] of Object.entries(model.transitions || {})) {
        if (sel.has(id)) transitions.push({id, node: structuredClone(node)});
    }
    if (places.length + transitions.length === 0) return null;
    const have = new Set([...places, ...transitions].map(n => n.id));
    const arcs = (model.arcs || [])
        .filter(a => have.has(a.source) && have.has(a.target))
        .map(a => structuredClone(a));
    return {places, transitions, arcs};
}

const shift = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : 0) + d;

/**
 * Put a clip into `model` in place. Every pasted node gets a new id, places
 * first (in clip order) and then transitions; arcs are remapped through the
 * old->new ids. Positions are the ORIGINAL copied coordinates plus (dx, dy), so
 * pasting twice puts the second copy on top of the first, as native does.
 * Does not normalize or record history; that is the caller's job.
 * @returns {string[]} the new ids, places then transitions
 */
export function pasteInto(model, clip, {dx = DEFAULT_PASTE_OFFSET, dy = DEFAULT_PASTE_OFFSET} = {}) {
    if (!model || !clip) return [];
    model.places ||= {};
    model.transitions ||= {};
    model.arcs ||= [];
    const map = new Map();
    const newIds = [];
    for (const {id, node} of clip.places) {
        const nid = freshId(model, 'p');
        const p = structuredClone(node);
        p.x = shift(p.x, dx);
        p.y = shift(p.y, dy);
        model.places[nid] = p;
        map.set(id, nid);
        newIds.push(nid);
    }
    for (const {id, node} of clip.transitions) {
        const nid = freshId(model, 't');
        const t = structuredClone(node);
        t.x = shift(t.x, dx);
        t.y = shift(t.y, dy);
        model.transitions[nid] = t;
        map.set(id, nid);
        newIds.push(nid);
    }
    for (const arc of clip.arcs) {
        if (!map.has(arc.source) || !map.has(arc.target)) continue;
        const a = structuredClone(arc);
        a.source = map.get(arc.source);
        a.target = map.get(arc.target);
        model.arcs.push(a);
    }
    return newIds;
}

/**
 * Pure paste: returns a new model with the clip added, and the new ids. `model`
 * is not touched.
 * @returns {{model: any, newIds: string[]}}
 */
export function pasteClip(model, clip, opts) {
    const next = structuredClone(model);
    const newIds = pasteInto(next, clip, opts);
    return {model: next, newIds};
}
