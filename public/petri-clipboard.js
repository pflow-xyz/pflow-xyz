// Copy / paste for places and transitions, DOM-free so it can be tested under
// Deno. Mirrors pflow-native's crates/core/src/commands/clipboard.rs
// (edit.copy / edit.cut / edit.paste / edit.duplicate): paste mints fresh ids
// and keeps the copied coordinates plus an offset, and arcs travel only when
// both of their ends were copied.
//
// A clip is plain data: {places: [{id, node}], transitions: [{id, node}], arcs: [],
// token?: [...]}, token being the source net's token list when it has one.
// Nodes and arcs are deep clones, so editing the net after a copy never
// changes what a later paste puts down. Places and transitions are arrays (not
// objects) so their order survives integer-like ids, which JS would reorder.
//
// The editor keeps the clip in memory AND puts it on the system clipboard as
// text, in the format pflow-native reads and writes too
// (docs/clipboard-format.md): clipToText / clipFromText convert, choosePaste
// decides what a Paste puts down, and clipboardShortcut, usesCommandKey,
// hasTextSelection, editableTarget, writeClipboardText, clipboardEventText and
// readClipboardText are the small browser-facing pieces, kept here so they can
// be tested without a DOM.

export const DEFAULT_PASTE_OFFSET = 40;

/** The clipboard format version this module writes and reads. */
export const CLIP_VERSION = 1;
/** `pflowClip.origin` on the clips this module writes. */
export const CLIP_ORIGIN = 'pflow.xyz';

const SCHEMA = 'https://pflow.xyz/schema';
const DEFAULT_TOKEN = ['https://pflow.xyz/tokens/black'];

/** True when `id` names a place or a transition in `model`. */
function used(model, id) {
    return Object.hasOwn(model.places || {}, id) || Object.hasOwn(model.transitions || {}, id);
}

/** The first n >= from for which `${prefix}${n}` is free. */
function freeIndex(model, prefix, from) {
    for (let n = from; ; n++) {
        if (!used(model, `${prefix}${n}`)) return n;
    }
}

/**
 * The first free `${prefix}${n}` (n = from, from + 1, ...; from defaults to 0),
 * where free means unused by any place OR transition (pflow-native doc.rs
 * fresh_id).
 * @param {{places?: Object, transitions?: Object}} model
 * @param {string} prefix
 * @param {number} [from]
 * @returns {string}
 */
export function freshId(model, prefix, from = 0) {
    return `${prefix}${freeIndex(model, prefix, from)}`;
}

/**
 * How many token colors `model` declares: its token list's length, at least 1
 * (no list, or an empty one, is one plain color), as petri-validate.js and
 * pflow-native's Document::colors count them.
 */
export function declaredColors(model) {
    return Array.isArray(model?.token) ? Math.max(1, model.token.length) : 1;
}

// A per-color vector cut or padded with 0 to n components, as pflow-native's
// paste resizes initial, capacity and weight (Vec::resize(ncol, 0.0)): 0 is no
// tokens, an unbounded capacity, and "this color is not involved" in a weight.
// A bare value is one component first, as normalizeModel reads it.
function fitColors(v, n) {
    const out = (Array.isArray(v) ? v : [v]).slice(0, n);
    while (out.length < n) out.push(0);
    return out;
}

// normalizeModel reads a missing or null weight as [1] and a bare one as
// [Number(w) || 1]; pad that, not the raw value (a padded null would read as 0).
const weightVector = (w) => (Array.isArray(w) ? w : [w == null ? 1 : (Number(w) || 1)]);

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
    const clip = {places, transitions, arcs};
    if (Array.isArray(model.token)) clip.token = [...model.token];
    return clip;
}

const shift = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : 0) + d;

/**
 * Put a clip into `model` in place. Every pasted node gets a new id, places
 * first (in clip order) and then transitions; arcs are remapped through the
 * old->new ids. Positions are the ORIGINAL copied coordinates plus (dx, dy), so
 * pasting twice puts the second copy on top of the first, as native does.
 * A place's initial and capacity and an arc's weight are cut or padded with 0
 * to `model`'s token colors (declaredColors), so a clip from a net with other
 * colors pastes as a well-formed net, its colors mapped by position (see
 * colorMappingNote); a field the clip node does not have stays absent.
 * Does not normalize or record history; that is the caller's job.
 * @returns {string[]} the new ids, places then transitions
 */
export function pasteInto(model, clip, {dx = DEFAULT_PASTE_OFFSET, dy = DEFAULT_PASTE_OFFSET} = {}) {
    if (!model || !clip) return [];
    model.places ||= {};
    model.transitions ||= {};
    model.arcs ||= [];
    const ncol = declaredColors(model);
    // Ids are only taken during a paste, so each prefix's next free index is
    // never below the last one found: the same ids as scanning from 0 every
    // time, without the quadratic rescan on a big paste.
    const next = {p: 0, t: 0};
    const take = (prefix) => {
        const n = freeIndex(model, prefix, next[prefix]);
        next[prefix] = n + 1;
        return `${prefix}${n}`;
    };
    const map = new Map();
    const newIds = [];
    for (const {id, node} of clip.places) {
        const nid = take('p');
        const p = structuredClone(node);
        p.x = shift(p.x, dx);
        p.y = shift(p.y, dy);
        if (p.initial !== undefined) p.initial = fitColors(p.initial, ncol);
        if (p.capacity !== undefined) p.capacity = fitColors(p.capacity, ncol);
        model.places[nid] = p;
        map.set(id, nid);
        newIds.push(nid);
    }
    for (const {id, node} of clip.transitions) {
        const nid = take('t');
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
        if (a.weight !== undefined) a.weight = fitColors(weightVector(a.weight), ncol);
        model.arcs.push(a);
    }
    return newIds;
}

const sameTokens = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);
const tokenNames = (list) => list.map((t) => String(t).replace(/\/+$/, '').split('/').pop()).join(', ');

/**
 * A status line for pasting `clip` into `model` when the clip names other
 * token colors than the net (pasteInto has then mapped them by position), else
 * null. A missing or empty token list reads as the one black token, on either
 * side.
 * @returns {string|null}
 */
export function colorMappingNote(clip, model) {
    const list = (t) => (Array.isArray(t) && t.length ? t : DEFAULT_TOKEN);
    const from = list(clip?.token);
    const to = list(model?.token);
    if (sameTokens(from, to)) return null;
    return `Pasted with token colors mapped by position: the copied nodes have ${tokenNames(from)}, this net has ${tokenNames(to)}.`;
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

// ---------------- the system clipboard (docs/clipboard-format.md) ----------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// JSON.stringify(v, null, 2), every line after the first indented by `pad`.
const indented = (v, pad) => JSON.stringify(v, null, 2).replace(/\n/g, '\n' + pad);

// A place as a clip writes it: an unbounded capacity component (Infinity in
// the editor, null in its JSON export) as 0, as the fixture and pflow-native
// write it. Assigning an existing key keeps its place, so key order is kept.
const unbounded = (c) => c === null || (typeof c === 'number' && !Number.isFinite(c));
function clipPlace(node) {
    if (node.capacity === undefined) return node;
    const cap = node.capacity;
    return {...node, capacity: Array.isArray(cap) ? cap.map((c) => (unbounded(c) ? 0 : c)) : (unbounded(cap) ? 0 : cap)};
}

// An object written from [key, value] pairs, in that order. A JS object would
// not do: JSON.stringify enumerates integer-like keys ("2", "10") first, in
// numeric order, so places named 10 and 2 would come out as 2, 10.
function orderedObject(pairs, pad) {
    if (pairs.length === 0) return '{}';
    const inner = pad + '  ';
    const rows = pairs.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${indented(v, inner)}`);
    return `{\n${rows.join(',\n')}\n${pad}}`;
}

/**
 * The clip as clipboard text: a pflow JSON-LD PetriNet document holding only
 * the clip's nodes and arcs, with the `pflowClip` marker and no `@id` (a clip
 * is not sealed). Nodes are written as they are, so ids, labels, coordinates,
 * initial, capacity, offset, a transition's `rate` (the web keeps rates on the
 * transition), arc weight and inhibitTransition all travel; an unbounded
 * capacity (Infinity in the editor) is written as 0, as the fixture and
 * pflow-native write it (both read 0 as unbounded). Places and transitions are
 * written in clip order (see orderedObject), pretty-printed like
 * parity/clipboard/clip-v1.json.
 * @param {{places: Array, transitions: Array, arcs: Array, token?: string[]}} clip
 * @param {{token?: string[], origin?: string}} [opts] token: the source net's
 *   token list (default the clip's own, else black)
 * @returns {string}
 */
export function clipToText(clip, {token = clip.token, origin = CLIP_ORIGIN} = {}) {
    const pad = '  ';
    const field = (k, text) => `${pad}${JSON.stringify(k)}: ${text}`;
    const rows = [
        field('@context', JSON.stringify(SCHEMA)),
        field('@type', JSON.stringify('PetriNet')),
        field('@version', JSON.stringify('1.1')),
        field('pflowClip', indented({version: CLIP_VERSION, origin}, pad)),
        field('token', indented(Array.isArray(token) && token.length ? token : DEFAULT_TOKEN, pad)),
        field('places', orderedObject(clip.places.map(({id, node}) => [id, clipPlace(node)]), pad)),
        field('transitions', orderedObject(clip.transitions.map(({id, node}) => [id, node]), pad)),
        field('arcs', indented(clip.arcs, pad)),
    ];
    return `{\n${rows.join(',\n')}\n}\n`;
}

/**
 * The order the members of the top-level "places" and "transitions" objects
 * are written in, in `text` (which must be valid JSON). JSON.parse cannot
 * report it: the object it builds enumerates integer-like keys first, in
 * numeric order, whatever order the text had, and the order decides which
 * pasted node gets p0, p1, ... A small scan over strings and brackets is
 * enough, since JSON.parse has already checked the text.
 * @returns {{places: string[], transitions: string[]}}
 */
function memberOrder(text) {
    const order = {places: [], transitions: []};
    let depth = 0;       // open { and [
    let str = null;      // the last string read; a key when ':' follows
    let topKey = null;   // the top-level member whose value comes next
    let into = null;     // 'places' | 'transitions' while directly inside that object
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
            str = JSON.parse(text.slice(i, j + 1));
            i = j;
        } else if (c === ':') {
            if (depth === 1) topKey = str;
            else if (depth === 2 && into) order[into].push(str);
        } else if (c === '{' || c === '[') {
            depth++;
            // a repeated member resets: JSON.parse keeps the last one's value
            if (depth === 2 && c === '{' && Object.hasOwn(order, topKey)) order[into = topKey] = [];
        } else if (c === '}' || c === ']') {
            depth--;
            if (depth === 1) into = null;
        }
    }
    return order;
}

/** [{id, node}] for every member of `obj`, in written order; null if a member is not an object. */
function entriesInOrder(obj, written) {
    const out = [];
    const seen = new Set();
    // Object.keys as well, so nothing is lost if the scan and JSON.parse ever disagree
    for (const id of [...written, ...Object.keys(obj)]) {
        if (seen.has(id) || !Object.hasOwn(obj, id)) continue;
        seen.add(id);
        if (!isObject(obj[id])) return null;
        out.push({id, node: obj[id]});
    }
    return out;
}

const NOT_A_CLIP = Object.freeze({kind: 'none'});

/**
 * Read clipboard text (docs/clipboard-format.md, "Readers, on Paste"):
 *  - JSON with `pflowClip.version` 1: {kind: 'clip', clip, origin}
 *  - a plain pflow PetriNet document (no `pflowClip`; `@type` "PetriNet",
 *    `@context` absent or the pflow schema): the whole net as a clip,
 *    {kind: 'clip', clip, origin: null}
 *  - `pflowClip.version` above 1: {kind: 'refused', version, message}, a
 *    status for the caller to show; it must not paste anything
 *  - anything else, including a document whose places, transitions or arcs
 *    have the wrong shape, or one with no places and no transitions (nothing
 *    to paste): {kind: 'none'}, so the caller falls back to its in-memory clip.
 * Places and transitions keep the order the text wrote them in, integer-like
 * ids included (see memberOrder). Arcs that are not objects, or whose source
 * or target is not in the clip, are dropped. Any `@id` is ignored. The
 * document's token list, when it has one, is kept as clip.token.
 * @param {*} text
 * @returns {{kind: 'clip', clip: Object, origin: string|null}|{kind: 'refused', version: number, message: string}|{kind: 'none'}}
 */
export function clipFromText(text) {
    if (typeof text !== 'string' || text.trim() === '') return NOT_A_CLIP;
    let doc;
    try {
        doc = JSON.parse(text);
    } catch {
        return NOT_A_CLIP;
    }
    if (!isObject(doc)) return NOT_A_CLIP;
    let origin = null;
    if (Object.hasOwn(doc, 'pflowClip')) {
        const marker = doc.pflowClip;
        const version = isObject(marker) ? marker.version : undefined;
        if (typeof version === 'number' && version > CLIP_VERSION) {
            return {
                kind: 'refused', version,
                message: `The clipboard holds a pflow clip of version ${version}; this editor reads version ${CLIP_VERSION}. Nothing was pasted.`,
            };
        }
        if (version !== CLIP_VERSION) return NOT_A_CLIP;
        origin = typeof marker.origin === 'string' ? marker.origin : null;
    } else if (doc['@type'] !== 'PetriNet' || (Object.hasOwn(doc, '@context') && doc['@context'] !== SCHEMA)) {
        return NOT_A_CLIP;
    }
    const {places = {}, transitions = {}, arcs = []} = doc;
    if (!isObject(places) || !isObject(transitions) || !Array.isArray(arcs)) return NOT_A_CLIP;
    const order = memberOrder(text);
    const p = entriesInOrder(places, order.places);
    const t = entriesInOrder(transitions, order.transitions);
    if (!p || !t || p.length + t.length === 0) return NOT_A_CLIP;
    const have = new Set([...p, ...t].map(n => n.id));
    const kept = arcs.filter(a => isObject(a) && have.has(a.source) && have.has(a.target));
    const clip = {places: p, transitions: t, arcs: kept};
    if (Array.isArray(doc.token) && doc.token.every((x) => typeof x === 'string')) clip.token = doc.token;
    return {kind: 'clip', clip, origin};
}

/**
 * What a Paste puts down. `text` is the system clipboard's text (null when it
 * could not be read); `memoryClip` the editor's in-memory clip. A clip (or a
 * pflow net) on the system clipboard wins; a newer clip version is refused,
 * with a message, and nothing is pasted; any other text falls back to the
 * in-memory clip. preferMemory says the editor's last write to the system
 * clipboard failed: a pflow.xyz clip still there may then be an older copy of
 * its own, so the in-memory clip wins over it. Anything this editor could not
 * have written (a pflow-native clip, a plain net, a newer clip version) came
 * from elsewhere after that write, and is read as usual.
 * @param {*} text
 * @param {Object|null} memoryClip
 * @param {{preferMemory?: boolean}} [opts]
 * @returns {{clip: Object|null, from: 'system'|'memory'|null, refusal?: string}}
 */
export function choosePaste(text, memoryClip, {preferMemory = false} = {}) {
    const read = clipFromText(text);
    if (preferMemory && memoryClip && read.kind === 'clip' && read.origin === CLIP_ORIGIN) {
        return {clip: memoryClip, from: 'memory'};
    }
    if (read.kind === 'clip') return {clip: read.clip, from: 'system'};
    if (read.kind === 'refused') return {clip: null, from: null, refusal: read.message};
    return memoryClip ? {clip: memoryClip, from: 'memory'} : {clip: null, from: null};
}

/**
 * Whether the platform's clipboard modifier is Cmd (macOS, iPhone, iPad; an
 * iPad reports MacIntel) rather than Ctrl, from navigator.userAgentData or
 * navigator.platform.
 * @param {*} [nav]
 * @returns {boolean}
 */
export function usesCommandKey(nav = globalThis.navigator) {
    const platform = nav?.userAgentData?.platform || nav?.platform || '';
    return /mac|iphone|ipad|ipod/i.test(platform);
}

/**
 * Whether a Selection (window.getSelection()) holds selected text: the user
 * selected something on the page, in a dialog or the host page, and Ctrl+C
 * is for that.
 * @returns {boolean}
 */
export function hasTextSelection(selection) {
    try {
        return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
    } catch {
        return false;
    }
}

/**
 * Which clipboard command a keydown asks for: 'copy', 'cut', 'paste',
 * 'duplicate', or null to leave the key alone. The platform's modifier (Cmd
 * on Apple platforms, where Ctrl+C fires no copy event; Ctrl elsewhere) with
 * C, X, V or D, no other modifier. Never while the user is typing in an
 * input, textarea or contenteditable, which keep the browser's own copy and
 * paste: `typing` (document.activeElement, which stops at a shadow host) or
 * the key's own target looked up through shadow roots (editableTarget). Copy
 * and cut are also left to the browser while the page has selected text.
 * @param {{key?: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean, composedPath?: Function, target?: any}} e
 * @param {{typing?: boolean, mac?: boolean, textSelected?: boolean}} [opts] mac:
 *   Cmd is the modifier (default usesCommandKey())
 * @returns {'copy'|'cut'|'paste'|'duplicate'|null}
 */
export function clipboardShortcut(e, {typing = false, mac = usesCommandKey(), textSelected = false} = {}) {
    if (!e || typing || e.altKey || e.shiftKey || !e.key) return null;
    const modifier = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
    if (!modifier) return null;
    if (editableTarget(e)) return null;
    const cmd = {c: 'copy', x: 'cut', v: 'paste', d: 'duplicate'}[e.key.toLowerCase()] || null;
    if (textSelected && (cmd === 'copy' || cmd === 'cut')) return null;
    return cmd;
}

/**
 * How long a clipboard shortcut waits for the browser's copy/cut/paste event
 * before using navigator.clipboard instead. Not 0: on macOS, Cmd+C/V reach the
 * page as a ClipboardEvent only after a round trip through the browser's Edit
 * menu, a later task than the keydown, and an early fallback would read the
 * clipboard through a permission prompt. Short enough to stay inside the
 * keystroke's user activation (WebKit forwards it to timers under 1s).
 */
export const CLIPBOARD_EVENT_WAIT_MS = 250;

/**
 * Whether a ClipboardEvent (or a keydown) is aimed at an input, textarea or
 * contenteditable, looking through shadow roots (composedPath()[0]): there the
 * page's own copy and paste must win, even if a check on
 * document.activeElement (which stops at a shadow host) missed it.
 */
export function editableTarget(e) {
    let t = null;
    try {
        t = (typeof e?.composedPath === 'function' && e.composedPath()[0]) || e?.target || null;
    } catch {
        t = e?.target || null;
    }
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
}

/**
 * Put text on the system clipboard. Given a copy or cut ClipboardEvent, the
 * text goes into its clipboardData (synchronous, no permission prompt) and the
 * event is cancelled so the browser does not write the page selection over it.
 * Otherwise navigator.clipboard.writeText, whose rejection (denied, no focus,
 * insecure origin) is swallowed: the in-memory clip still works. Never throws.
 * `done` hears whether the text got there: at once for the event route and
 * for no route, when writeText settles for the API route.
 * @param {string} text
 * @param {{event?: {clipboardData?: any, preventDefault?: Function}|null, clipboard?: any, done?: (ok: boolean) => void}} [opts]
 * @returns {'event'|'api'|'none'} the route taken
 */
export function writeClipboardText(text, {event = null, clipboard = globalThis.navigator?.clipboard, done = () => {}} = {}) {
    let route = 'none';
    try {
        if (event?.clipboardData) {
            event.clipboardData.setData('text/plain', text);
            event.preventDefault();
            route = 'event';
        } else if (clipboard && typeof clipboard.writeText === 'function') {
            Promise.resolve(clipboard.writeText(text)).then(() => done(true), () => done(false)).catch(() => {});
            return 'api';
        }
    } catch {
        /* a clipboard that throws is a clipboard we do not have */
        route = 'none';
    }
    done(route === 'event');
    return route;
}

/**
 * The text/plain a paste ClipboardEvent carries, or null. Call it while the
 * event is being dispatched: clipboardData is emptied afterwards.
 * @returns {string|null}
 */
export function clipboardEventText(event) {
    try {
        return event?.clipboardData ? event.clipboardData.getData('text/plain') : null;
    } catch {
        return null;
    }
}

/**
 * The system clipboard's text through navigator.clipboard.readText, which may
 * ask the user's permission; null when there is no Clipboard API or the read
 * is denied. Never rejects.
 * @param {{clipboard?: any}} [opts]
 * @returns {Promise<string|null>}
 */
export async function readClipboardText({clipboard = globalThis.navigator?.clipboard} = {}) {
    if (!clipboard || typeof clipboard.readText !== 'function') return null;
    try {
        const text = await clipboard.readText();
        return typeof text === 'string' ? text : null;
    } catch {
        return null;
    }
}
