// petri-tools.js — the registry as an LLM's tool list, and back.
//
// The chat (petri-chat.js) and the server (/api/llm/turn) agree on one
// manifest, public/llm-tools.json, generated from the registry by
// scripts/gen-llm-tools.mjs (a test fails when the two drift). Each tool is a
// registry command:
//
//   name         the command id with its first '.' as '_' (net.add_place →
//                net_add_place): Gemini function names allow neither every
//                character nor every length, and namespaces have no '_', so
//                the mapping is reversible
//   parameters   the command's JSON Schema, cut down to the OpenAPI subset
//                Gemini's function calling accepts (no unions, no
//                additionalProperties, no free-form objects)
//   json_args    arguments whose schema is free-form (a marking, a property
//                list): the model passes them as a JSON string, and decodeArgs
//                parses them back before the command sees them
//
// summarizeResult() bounds what goes back to the model after a call: long
// series become their ends and extremes, so a 600-point ODE run costs a few
// hundred tokens, not thirty thousand.

export const MANIFEST_VERSION = 'tools-v1';

// Commands the chat does not get: a whole-document load (the chat edits
// through commands instead), and export (text for a file, not for a model).
// Nor the account files (file.save … file.delete): a write to the person's
// account is theirs to make, not the model's, and a read would send their
// saved files to the model's provider. (The chat's sandbox host carries no
// sign-in either, so they would only refuse.)
export const EXCLUDED = new Set([
    'file.load_json', 'export.artifact', 'export.svg',
    'file.save', 'file.open', 'file.list', 'file.get', 'file.write', 'file.delete',
]);

export const toolName = (id) => id.replace('.', '_');
export const commandId = (name) => name.replace('_', '.');

function cleanSchema(s, path, jsonArgs) {
    const out = {};
    if (s.description) out.description = s.description;
    let types = [].concat(s.type || []);
    const nullable = types.includes('null');
    types = types.filter((t) => t !== 'null');
    let type = types.length > 1 ? (types.includes('array') ? 'array' : types.includes('object') ? 'object' : types[0]) : types[0];
    const freeForm = !type || (type === 'object' && !Object.keys(s.properties || {}).length);
    if (freeForm) {
        jsonArgs.push(path);
        return { type: 'string', description: `${s.description || ''} (pass a JSON value as a string)`.trim() };
    }
    if (type === 'integer' && types.includes('number')) type = 'number';
    out.type = type;
    if (nullable) out.nullable = true;
    if (s.enum) out.enum = s.enum;
    if (typeof s.minimum === 'number') out.minimum = s.minimum;
    if (typeof s.maximum === 'number') out.maximum = s.maximum;
    if (type === 'array') {
        const items = s.items || {};
        const it = [].concat(items.type || []).filter((t) => t !== 'null');
        out.items = it.length ? { type: it[0] === 'integer' ? 'integer' : it[0] } : { type: 'string' };
        if (out.items.type === 'object') out.items = { type: 'string' };
    }
    if (type === 'object') {
        out.properties = {};
        for (const [k, v] of Object.entries(s.properties)) out.properties[k] = cleanSchema(v, `${path}.${k}`, []);
        if (s.required?.length) out.required = s.required;
    }
    return out;
}

/**
 * The manifest for a registry's specs (Registry.list()).
 * @returns {{version: string, tools: Array<{name, command, description, parameters?, json_args?}>}}
 */
export function buildManifest(specs) {
    const tools = [];
    for (const s of specs) {
        if (EXCLUDED.has(s.id)) continue;
        const jsonArgs = [];
        const props = {};
        for (const [k, v] of Object.entries(s.args.properties || {})) props[k] = cleanSchema(v, k, jsonArgs);
        const tool = { name: toolName(s.id), command: s.id, description: `${s.label}. ${s.help}`.slice(0, 1000) };
        if (Object.keys(props).length) {
            tool.parameters = { type: 'object', properties: props };
            if (s.args.required?.length) tool.parameters.required = s.args.required;
        }
        if (jsonArgs.length) tool.json_args = jsonArgs;
        if (s.requires?.length || s.available === false) tool.requires = s.requires || ['view'];
        tools.push(tool);
    }
    return { version: MANIFEST_VERSION, tools };
}

/** A model's call → [commandId, args], with json_args parsed. Throws on a bad JSON arg. */
export function decodeCall(manifest, call) {
    const tool = manifest.tools.find((t) => t.name === call.name);
    if (!tool) throw new Error(`unknown tool ${call.name}`);
    const args = { ...(call.args || {}) };
    for (const k of tool.json_args || []) {
        if (typeof args[k] === 'string') {
            try { args[k] = JSON.parse(args[k]); } catch { throw new Error(`${k}: not valid JSON`); }
        }
    }
    return [tool.command, args];
}

const MAX_TEXT = 3000;

function compactSeries(values) {
    if (!Array.isArray(values) || values.length <= 6) return values;
    let min = Infinity, max = -Infinity;
    for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
    const r = (v) => (typeof v === 'number' ? +v.toPrecision(5) : v);
    return { n: values.length, first: r(values[0]), last: r(values[values.length - 1]), min: r(min), max: r(max) };
}

/** A bounded picture of an artifact, for the model. */
export function summarizeArtifact(art) {
    const d = art.data;
    const base = { id: art.id, title: art.title, kind: d.kind };
    switch (d.kind) {
        case 'timeseries':
            return { ...base, x_label: d.x_label, x: compactSeries(d.x), series: d.series.map((s) => ({ name: s.name, group: s.group, values: compactSeries(s.values) })) };
        case 'sets':
            return { ...base, sets: d.sets.slice(0, 20).map((s) => ({ label: s.label, nodes: s.nodes })), more: Math.max(0, d.sets.length - 20) };
        case 'trace':
            return { ...base, steps: d.steps.length, fired: d.steps.map((s) => s.transition).filter(Boolean).slice(0, 40), end: d.steps[d.steps.length - 1]?.marking };
        case 'graph':
            return { ...base, nodes: d.nodes.length, edges: d.edges.length, deadlocks: d.nodes.filter((n) => n.data?.deadlock).map((n) => n.id).slice(0, 20) };
        case 'matrix':
            return { ...base, rows: d.rows, cols: d.cols, values: d.rows.length * d.cols.length <= 100 ? d.values : `${d.rows.length}×${d.cols.length}` };
        case 'table':
            return { ...base, columns: d.columns, rows: d.rows.slice(0, 15), more: Math.max(0, d.rows.length - 15) };
        default:
            return { ...base, data: d };
    }
}

function clip(v) {
    const s = JSON.stringify(v);
    if (s.length <= MAX_TEXT) return v;
    return { truncated: true, text: s.slice(0, MAX_TEXT) };
}

/**
 * What goes back to the model after a call: the result (long arrays
 * compacted) and a summary of every artifact it made, under MAX_TEXT
 * characters each.
 */
export function summarizeResult(result, artifacts = []) {
    const compact = (v, depth = 0) => {
        if (Array.isArray(v)) return v.length > 30 && v.every((x) => typeof x === 'number') ? compactSeries(v) : v.slice(0, 50).map((x) => compact(x, depth + 1));
        if (v && typeof v === 'object' && depth < 6) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x, depth + 1)]));
        return v;
    };
    return { result: clip(compact(result)), artifacts: artifacts.map((a) => clip(summarizeArtifact(a))) };
}
