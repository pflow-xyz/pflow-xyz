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
//      registry, which renders and exports them like any other.
//
// The JS engines (token game, ODE, SSA, SDE) stay the engines of record for
// what they do; nothing here replaces them.

const VENDOR = new URL('./vendor/pflow-native-wasm/', import.meta.url);

let enginePromise = null;

// Keys of a native result that hold artifact ids (one id or a list of them).
const ARTIFACT_KEYS = new Set(['artifact', 'artifacts', 'sets', 'report', 'trace', 'traces', 'graph', 'matrices', 'p_basis', 't_basis', 'table', 'bars', 'heatmap', 'scatter', 'series']);
const ARTIFACT_ID = /^a\d+$/;

/**
 * The engine, initialised once. In the browser the .wasm is fetched next to
 * the vendored glue (the server sends it gzip-encoded). Tests pass `bytes`.
 * @param {{bytes?: BufferSource}} [o]
 */
export function loadEngine(o = {}) {
    enginePromise ||= (async () => {
        const glue = await import(new URL('pflow_native_wasm.js', VENDOR).href);
        if (o.bytes) glue.initSync({ module: o.bytes });
        else await glue.default({ module_or_path: new URL('pflow_native_wasm_bg.wasm', VENDOR) });
        return { glue, engine: new glue.Engine(), version: glue.Engine.version() };
    })();
    enginePromise.catch(() => { enginePromise = null; });
    return enginePromise;
}

/** True once loadEngine() has resolved (for UI that wants to say "loading…"). */
export const engineState = { loaded: false };

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
            if (ARTIFACT_KEYS.has(k) && typeof v === 'string' && ARTIFACT_ID.test(v)) ids.add(v);
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
        if (ARTIFACT_KEYS.has(k) && typeof v === 'string' && map.has(v)) out[k] = map.get(v);
        else if (ARTIFACT_KEYS.has(k) && Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v.map((x) => map.get(x) ?? x);
        else out[k] = rewriteIds(v, map);
    }
    return out;
}

/**
 * Run one native command against `model` (the editor's document).
 * `store(title, data, meta, source)` files an artifact in the JS registry and
 * returns it; native artifact ids in the result are rewritten to the JS ids.
 * @returns {Promise<Object>} the command's result
 */
export async function runNative(model, id, args, store) {
    const { engine } = await loadEngine();
    engineState.loaded = true;
    try {
        engine.load(JSON.stringify(model));
        let raw;
        try {
            raw = engine.execute(id, JSON.stringify(args || {}));
        } catch (e) {
            // wasm-bindgen throws a JsError carrying the registry's message.
            const err = new Error(String(e?.message || e));
            err.native = true;
            throw err;
        }
        const result = parseJSON(raw);
        const map = new Map();
        for (const nid of collectIds(result)) {
            let art;
            try {
                art = parseJSON(parseJSON(engine.execute('export.artifact', JSON.stringify({ id: nid, format: 'json' }))));
            } catch {
                continue; // a stale id in a result is not worth failing the command over
            }
            const kept = store(art.title, art.data, { native: { id: nid, version: (await loadEngine()).version } });
            map.set(nid, kept.id);
        }
        return rewriteIds(result, map);
    } finally {
        try { engine.execute('artifact.clear', '{}'); } catch { /* older engines: harmless */ }
    }
}

/** The native registry's specs for `ids` (used to refresh the vendored snapshot). */
export async function nativeSpecs(ids) {
    const { engine } = await loadEngine();
    const all = parseJSON(engine.listCommands(''));
    return ids.map((id) => all.find((c) => c.id === id)).filter(Boolean);
}
