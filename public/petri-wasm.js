// petri-wasm.js — pflow-native's registry in the browser, for the commands
// the JS engines lack.
//
// The engine is pflow-native-core compiled to wasm (pflow-native
// crates/wasm, "pflow-native-wasm"), vendored in public/vendor/pflow-native-wasm/
// with a lock (pflow-native-wasm.lock). It is loaded on first use only: the
// editor, and every consumer that vendors petri-view.js, pays nothing until
// someone runs a structural analysis.
//
// The contract is pflow-native's registry over JSON (ROADMAP, "WASM: what
// moves to Rust, and how", option A). Each call:
//
//   1. loads the editor's current document into the engine (file.load_json);
//   2. runs the command;
//   3. exports every artifact the result names (export.artifact, json) and
//      clears the engine's own, so results live in ONE place: the JS
//      registry, which renders and exports them like any other;
//   4. saves the session state if the call changed it (below).
//
// The page keeps one engine. What outlives a document in it (the model
// library, systems, macros, notes and the content-addressed store) is the
// SESSION STATE: saved in browser storage after every call that changes it
// (Engine session.dump_state, compared with the last copy saved), and restored
// once when the engine loads (Engine.restoreState), before any command runs.
// Step 1 keeps it (load replaces only the document) and step 3 clears only
// results, which are not part of it: the engine's results never outlive a
// call, so the saved copy leaves them out.
//
// Storage is IndexedDB (idbStorage): the state carries every stored model and
// library net as text, which outgrows localStorage's ~5 MB per origin quickly,
// and an IndexedDB write does not block the page. localStorage is the fallback
// where IndexedDB is missing; with neither (or in tests, unless they pass one)
// the session lives in memory only. Storage that fails to read starts the
// engine empty and saves nothing that session, so a broken read never ends in
// an empty state written over a good one. A saved state the engine refuses (a
// newer format, a damaged part) is set aside under its own key, not
// overwritten, and the engine starts empty. Two tabs each keep their own
// engine, and the last one to save wins (there is no cross-tab sync).
//
// The JS engines (token game, ODE, SSA, SDE) stay the engines of record for
// what they do; nothing here replaces them.
//
// WHERE THE .wasm COMES FROM. The build is also published to cdn.stackdump.com
// under its content address (pflow-native `make wasm-publish`), and
// vendor/pflow-native-wasm/cdn.js pins that URL and the .wasm's sha256
// (scripts/sync-native-wasm.mjs --cdn, which checks the CDN copy is the
// vendored build byte for byte). In the browser the engine is fetched from
// there (the .gz, decompressed here: the CDN's nginx does not compress wasm),
// hashed, and compiled only if the hash is the pinned one; the CDN is a
// transport, never trusted for content. Anything else (no pin, a network or
// CORS failure, a wrong hash) falls back to the vendored copy, which is the
// same bytes. engineState.source says which was used.

const VENDOR = new URL('./vendor/pflow-native-wasm/', import.meta.url);

let enginePromise = null;

// The parts of session.dump_state the page saves: everything but the results
// (artifacts), which the bridge clears after every call.
const SAVED_PARTS = JSON.stringify({ parts: ['models', 'systems', 'macros', 'recording', 'notes', 'store'] });

// The browser storage the session state is saved in, chosen on the first
// load (undefined until then; null = none) and kept across dropEngine().
let storage;
// The last state written (or restored), so an unchanged state is not written
// again; and whether this page saves at all (off after a failed read, see
// restoreSaved).
let lastSaved = null;
let canSave = true;
let saving = Promise.resolve();

// Keys of a native result that hold artifact ids (one id or a list of them).
const ARTIFACT_KEYS = new Set(['artifact', 'artifacts', 'sets', 'report', 'trace', 'traces', 'graph', 'matrices', 'p_basis', 't_basis', 'table', 'bars', 'heatmap', 'scatter', 'series', 'log', 'data', 'timeseries', 'overlay']);
const ARTIFACT_ID = /^a\d+$/;

/**
 * The engine, initialised once, with the saved session state restored. In the
 * browser the .wasm is fetched next to the vendored glue (the server sends it
 * gzip-encoded). Tests pass `bytes`, and `storage` (memoryStorage()) to
 * exercise saving; the default is browserStorage().
 * @param {{bytes?: BufferSource, storage?: SessionStorage|null}} [o]
 */
export function loadEngine(o = {}) {
    if (o.storage !== undefined) storage = o.storage;
    enginePromise ||= (async () => {
        const glue = await import(new URL('pflow_native_wasm.js', VENDOR).href);
        if (o.bytes) {
            glue.initSync({ module: o.bytes });
            Object.assign(engineState, { source: 'bytes', cdnError: null });
        } else {
            let pinned = null, cdnError = null;
            try {
                const { CDN } = await import(new URL('cdn.js', VENDOR).href);
                pinned = await fetchPinned(CDN);
            } catch (e) {
                cdnError = String(e?.message ?? e);
                warn(`engine from the CDN failed, using the vendored copy: ${cdnError}`);
            }
            if (pinned) await glue.default({ module_or_path: await WebAssembly.compile(pinned) });
            else await glue.default({ module_or_path: new URL('pflow_native_wasm_bg.wasm', VENDOR) });
            Object.assign(engineState, { source: pinned ? 'cdn' : 'vendored', cdnError });
        }
        if (storage === undefined) storage = browserStorage();
        const engine = new glue.Engine();
        await restoreSaved(engine);
        return { glue, engine, version: glue.Engine.version() };
    })();
    enginePromise.catch(() => { enginePromise = null; });
    return enginePromise;
}

/**
 * Forget the engine: the next loadEngine() makes a new one and restores the
 * saved state into it, as a page reload does. The storage choice is kept.
 * Resolves once the pending saves have landed.
 */
export async function dropEngine() {
    const p = enginePromise;
    enginePromise = null;
    await saving;
    if (p) {
        try { (await p).engine.free(); } catch { /* never loaded */ }
    }
    engineState.loaded = false;
}

/**
 * True once loadEngine() has resolved (for UI that wants to say "loading…"),
 * and what the start-up restore did: `storage` (indexeddb, localstorage,
 * memory or none), `restored` (the engine's summary of what came back, or
 * null when nothing was saved), `refused` (why a saved state was set aside),
 * `saving` (false when this page saves nothing, see restoreSaved).
 */
/** @type {{loaded: boolean, storage: string, restored: Object|null, refused: string|null, saving: boolean, source: string|null, cdnError: string|null}} */
export const engineState = { loaded: false, storage: 'none', restored: null, refused: null, saving: true, source: null, cdnError: null };

/**
 * The engine's .wasm bytes from the CDN `pin` names ({url, file, sha256}, as
 * vendor/pflow-native-wasm/cdn.js exports it): the gzip file fetched,
 * decompressed, and returned only if its sha256 is the pinned one. Throws on
 * anything else (no pin, an HTTP error, a wrong hash); the caller falls back
 * to the vendored copy. `fetchImpl` is for tests.
 * @param {{url: string, file: string, sha256: string}|null|undefined} pin
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchPinned(pin, fetchImpl = fetch) {
    if (!pin?.url || !pin?.file || !/^[0-9a-f]{64}$/.test(pin?.sha256 || '')) throw new Error('no CDN pin');
    const res = await fetchImpl(new URL(pin.file, pin.url).href);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${pin.url}${pin.file}`);
    const bytes = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const got = [...digest].map((x) => x.toString(16).padStart(2, '0')).join('');
    if (got !== pin.sha256) throw new Error(`the CDN's engine hashes to ${got}, not the pinned ${pin.sha256}`);
    return bytes;
}

function warn(msg, e) {
    if (typeof console === 'undefined') return;
    if (e === undefined) console.warn(`[pflow-native] ${msg}`);
    else console.warn(`[pflow-native] ${msg}`, e);
}

// The state the page saves, as the engine dumps it.
function dumpSaved(engine) {
    return engine.execute('session.dump_state', SAVED_PARTS);
}

/**
 * Restore the saved session state into a new engine. Nothing saved: an empty
 * session. A read that fails: an empty session that saves nothing this page
 * (the copy it could not read may still be good). A state the engine refuses:
 * set aside under its own key and an empty session; if setting it aside fails
 * too, nothing is saved this page, so the refused copy is never overwritten.
 */
async function restoreSaved(engine) {
    Object.assign(engineState, { storage: storage?.kind || 'none', restored: null, refused: null, saving: true });
    canSave = !!storage;
    lastSaved = null;
    if (storage) {
        let saved = null;
        try {
            saved = await storage.load();
        } catch (e) {
            warn('could not read the saved session; starting empty, and saving nothing this page', e);
            canSave = false;
        }
        if (saved != null) {
            try {
                const summary = JSON.parse(engine.restoreState(typeof saved === 'string' ? saved : JSON.stringify(saved)));
                engineState.restored = summary;
                for (const w of summary.warnings || []) warn(w);
            } catch (e) {
                const why = String(e?.message || e);
                engineState.refused = why;
                warn(`the saved session was refused (${why}); it is set aside and the engine starts empty`);
                try {
                    await storage.setAside(saved, why);
                } catch (e2) {
                    warn('could not set the refused session aside; saving nothing this page so it is not overwritten', e2);
                    canSave = false;
                }
            }
        }
    }
    engineState.saving = canSave;
    try { lastSaved = dumpSaved(engine); } catch { /* an engine without session.dump_state */ }
}

/**
 * Save the engine's session state if it changed since the last save. Writes
 * are chained, so they land in order; a failed write is reported, not thrown
 * (the command that caused it succeeded), and the next change retries.
 */
function saveIfChanged(engine) {
    if (!storage || !canSave) return saving;
    let now;
    try { now = dumpSaved(engine); } catch (e) { warn('could not dump the session state', e); return saving; }
    if (now === lastSaved) return saving;
    lastSaved = now;
    saving = saving.then(() => storage.save(now)).catch((e) => {
        warn('could not save the session state', e);
        lastSaved = null;
    });
    return saving;
}

// ---- browser storage ----

/**
 * @typedef {Object} SessionStorage
 * @property {string} kind
 * @property {() => Promise<string|null>} load      the saved state, or null
 * @property {(text: string) => Promise<void>} save
 * @property {(text: string, why: string) => Promise<void>} setAside
 *   keep a refused state under its own key and clear the main one
 */

const STATE_KEY = 'pflow-native-session';

/** IndexedDB: database `pflow-native`, object store `state`, key `pflow-native-session`. */
export function idbStorage(idb = globalThis.indexedDB, dbName = 'pflow-native') {
    let dbp = null;
    const open = () => (dbp ||= new Promise((resolve, reject) => {
        const req = idb.open(dbName, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('state');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
    }).catch((e) => { dbp = null; throw e; }));
    const tx = async (mode, fn) => {
        const db = await open();
        return new Promise((resolve, reject) => {
            const t = db.transaction('state', mode);
            const req = fn(t.objectStore('state'));
            t.oncomplete = () => resolve(req?.result);
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
        });
    };
    return {
        kind: 'indexeddb',
        load: async () => (await tx('readonly', (st) => st.get(STATE_KEY))) ?? null,
        save: async (text) => { await tx('readwrite', (st) => st.put(text, STATE_KEY)); },
        setAside: async (text, why) => {
            await tx('readwrite', (st) => {
                st.put({ text, why, at: new Date().toISOString() }, `${STATE_KEY}.refused.${Date.now()}`);
                return st.delete(STATE_KEY);
            });
        },
    };
}

/**
 * localStorage (or any Storage-shaped object): key `pflow-native-session`.
 * @param {{getItem(k: string): string|null, setItem(k: string, v: string): void, removeItem(k: string): void}} [ls]
 */
export function localStorageStorage(ls = globalThis.localStorage) {
    return {
        kind: 'localstorage',
        load: async () => ls.getItem(STATE_KEY),
        save: async (text) => { ls.setItem(STATE_KEY, text); },
        setAside: async (text, why) => {
            ls.setItem(`${STATE_KEY}.refused.${Date.now()}`, JSON.stringify({ text, why, at: new Date().toISOString() }));
            ls.removeItem(STATE_KEY);
        },
    };
}

/** In memory, for tests: `data` is a Map standing in for the browser's storage. */
export function memoryStorage(data = new Map()) {
    return {
        kind: 'memory',
        data,
        load: async () => data.get(STATE_KEY) ?? null,
        save: async (text) => { data.set(STATE_KEY, text); },
        setAside: async (text, why) => {
            data.set(`${STATE_KEY}.refused.${data.size}`, { text, why });
            data.delete(STATE_KEY);
        },
    };
}

/**
 * The page's storage: IndexedDB, else localStorage, else none. Only in a
 * page (a document): a test runner's localStorage would outlive the test.
 */
export function browserStorage() {
    if (typeof document === 'undefined') return null;
    try {
        if (globalThis.indexedDB) return idbStorage();
        if (globalThis.localStorage) return localStorageStorage();
    } catch { /* storage access denied (some privacy modes throw on the getter) */ }
    return null;
}

function parseJSON(s) {
    return typeof s === 'string' ? JSON.parse(s) : s;
}

// Artifact ids can sit anywhere in a result (verify puts each verdict's trace
// inside verdicts[]), so both walks go all the way down.
function collectIds(result, ids = new Set()) {
    if (Array.isArray(result)) {
        result.forEach((x) => collectIds(x, ids));
    } else if (result && typeof result === 'object') {
        for (const [k, v] of Object.entries(result)) {
            if (k === 'artifacts' && v && typeof v === 'object' && !Array.isArray(v)) Object.values(v).forEach((x) => { if (typeof x === 'string' && ARTIFACT_ID.test(x)) ids.add(x); });
            else if (ARTIFACT_KEYS.has(k) && typeof v === 'string' && ARTIFACT_ID.test(v)) ids.add(v);
            else if (ARTIFACT_KEYS.has(k) && Array.isArray(v)) v.forEach((x) => { if (typeof x === 'string' && ARTIFACT_ID.test(x)) ids.add(x); });
            if (v && typeof v === 'object') collectIds(v, ids);
        }
    }
    return [...ids];
}

function rewriteIds(result, map) {
    if (Array.isArray(result)) return result.map((x) => rewriteIds(x, map));
    if (!result || typeof result !== 'object') return result;
    const out = {};
    for (const [k, v] of Object.entries(result)) {
        if (k === 'export' && v && typeof v === 'object' && map.has(v.args?.id)) out[k] = { ...v, args: { ...v.args, id: map.get(v.args.id) } };
        else if (k === 'artifacts' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = Object.fromEntries(Object.entries(v).map(([n, x]) => [n, typeof x === 'string' && map.has(x) ? map.get(x) : x]));
        else if (ARTIFACT_KEYS.has(k) && typeof v === 'string' && map.has(v)) out[k] = map.get(v);
        else if (ARTIFACT_KEYS.has(k) && Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v.map((x) => map.get(x) ?? x);
        else out[k] = rewriteIds(v, map);
    }
    return out;
}

/**
 * Run one native command against `model` (the editor's document).
 * `store(title, data, meta, source)` files an artifact in the JS registry and
 * returns it; native artifact ids in the result are rewritten to the JS ids.
 * opts.full returns {result, doc}, where doc is the engine's document after
 * the command when opts.edits (for commands that edit the net).
 * opts.artifactArgs names arguments that hold a registry artifact id; opts.lookup(id)
 * returns that artifact ({title, data}), which is filed into the engine
 * (artifact.put) before the command runs, and the argument becomes the engine's id.
 * @returns {Promise<Object>} the command's result
 */
export async function runNative(model, id, args, store, opts = {}) {
    const { engine, version } = await loadEngine();
    engineState.loaded = true;
    try {
        const map = new Map();
        engine.load(JSON.stringify(model));
        args = { ...(args || {}) };
        for (const k of opts.artifactArgs || []) {
            if (typeof args[k] !== 'string') continue;
            const art = opts.lookup(args[k]); // throws a CommandError naming the known results
            const put = parseJSON(engine.execute('artifact.put', JSON.stringify({ title: art.title, data: art.data })));
            args[k] = put.artifact;
            map.set(put.artifact, art.id); // the engine echoes its id for it; the caller knows the registry's
        }
        let raw;
        try {
            raw = engine.execute(id, JSON.stringify(args));
        } catch (e) {
            // wasm-bindgen throws a JsError carrying the registry's message.
            const err = new Error(String(e?.message || e));
            err.native = true;
            throw err;
        }
        const result = parseJSON(raw);
        for (const nid of collectIds(result)) {
            if (map.has(nid)) continue; // an input, already a registry artifact
            let art;
            try {
                art = parseJSON(parseJSON(engine.execute('export.artifact', JSON.stringify({ id: nid, format: 'json' }))));
            } catch {
                continue; // a stale id in a result is not worth failing the command over
            }
            const kept = store(art.title, art.data, { native: { id: nid, version } });
            map.set(nid, kept.id);
        }
        const rewritten = rewriteIds(result, map);
        if (!opts.full) return rewritten;
        // An editing command (compose.fuse, compose.extend) changed the
        // engine's document: hand back its export, rates included.
        const doc = opts.edits ? parseJSON(engine.execute('file.export_json', JSON.stringify({ rates: true }))) : null;
        return { result: rewritten, doc };
    } finally {
        try { engine.execute('artifact.clear', '{}'); } catch { /* older engines: harmless */ }
        await saveIfChanged(engine);
    }
}

/** The native registry's specs for `ids` (used to refresh the vendored snapshot). */
export async function nativeSpecs(ids) {
    const { engine } = await loadEngine();
    const all = parseJSON(engine.listCommands(''));
    return ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
}
