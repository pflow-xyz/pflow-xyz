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
//
// A second manifest, public/llm-goal-tools.json (buildGoalManifest below), is
// what the model sees when /api/llm/turn is asked for the 'goals' toolset: the
// goal-level surface of docs/design/agent-first-analysis.md section 4.2
// (run_goal, ask_user, command_schema, run_command, open_view and a dozen
// edit/read tools) instead of every command. The long tail is not declared as
// tools; it is listed by id and one line of help (command_index) and reached
// through run_command.

export const MANIFEST_VERSION = 'tools-v1';

// Commands the chat does not get: a whole-document load (the chat edits
// through commands instead), and export (text for a file, not for a model).
// Nor any command that writes the session state the page saves in browser
// storage (spec.writesState: model.save, store.put, note.add, …): that is the
// person's own library and store, written at once, which the chat's sandbox
// cannot preview the way it previews an edit of the net (store.license is
// irrevocable). The chat still reads them (model.list, store.query, …) and
// opens a library or stored model into its sandbox (model.open, store.open).
export const EXCLUDED = new Set(['file.load_json', 'export.artifact', 'export.svg']);

export const toolName = (id) => id.replace('.', '_');
export const commandId = (name) => name.replace('_', '.');

// Nor the account files (file.save … file.delete): a write to the person's
// account is theirs to make, not the model's, and a read would send their
// saved files to the model's provider. (The chat's sandbox host carries no
// sign-in either, so they would only refuse.)
for (const id of ['file.save', 'file.open', 'file.list', 'file.get', 'file.write', 'file.delete']) EXCLUDED.add(id);

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
        if (EXCLUDED.has(s.id) || s.writesState) continue;
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


// ---- the goal toolset ----------------------------------------------------

export const GOAL_MANIFEST_VERSION = 'goal-tools-v1';

/** The classic dialogs open_view can open, as views (the browser maps each name to its dialog). */
export const GOAL_VIEWS = ['analysis', 'simulate', 'structure', 'results', 'app', 'components', 'check'];

/** What engine_override may name: the two continuous engines, the ones a guard can rule out. */
export const ENGINE_OVERRIDES = ['ode', 'sde'];

/**
 * The registry commands the goal toolset declares as tools of their own, with
 * why each is there. The rest (the long tail) goes through run_command. The
 * list is measured against what the Assistant's build flows already call:
 * public/petri-refine_test.ts's scripted interview uses net_add_place,
 * net_add_transition, net_add_arc, compose_fuse, sim_set_rate, net_set_goals,
 * analysis_check, analysis_defects and sim_recommend; the step guidance in
 * cmd/webserver/llm_turn.go names the same, plus net_info. Anything used once
 * per interview (net_set_goals, compose_fuse, compose_components) or inside a
 * goal's own plan (sim_recommend) stays behind run_command: a declared tool
 * costs its schema on every call of the conversation, where a command_schema
 * call costs one extra round once.
 *
 * Twelve, in the order they appear in the manifest.
 */
export const GOAL_DIRECT_TOOLS = [
    // read
    { command: 'net.info', why: 'the build prompt says "before editing a net you have not seen, call net_info"; the lead carries a summary, but the sandbox changes under edits' },
    { command: 'analysis.check', why: 'the structure check: the validate step and "check the result before saying it is done" (build mode)' },
    { command: 'analysis.defects', why: 'the refinement gate (0 is clean) the validate step names beside analysis_check; the pending-edits bar shows it' },
    // add / connect
    { command: 'net.add_place', why: 'structure step: every build starts by adding places' },
    { command: 'net.add_transition', why: 'structure step: and transitions' },
    { command: 'net.add_arc', why: 'structure step: connects them (inhibit makes an inhibitor or read arc)' },
    // set a field
    { command: 'net.set_place', why: 'initial marking and capacity, the other thing a place needs' },
    { command: 'sim.set_rate', why: 'rates step: every transition gets a real rate' },
    // remove / undo
    { command: 'edit.delete', why: 'remove places and transitions with their arcs (the correction a build makes most)' },
    { command: 'edit.undo', why: 'take back the last edit without rebuilding it by hand' },
    // the canvas
    { command: 'view.highlight', why: 'the Assistant already points at the nodes it is talking about (a siphon, a deadlock)' },
    { command: 'view.fit', why: 'frames the net after edits, as the Assistant already does' },
];

/**
 * The tools the interface answers itself, not registry commands (each carries
 * `ask: true` and no `command`). Their calls and results are described in
 * docs/design/agent-first-analysis.md 4.2 to 4.4:
 *   run_goal       runs a goal's plan (public/goals.json) on the sandbox registry
 *   ask_user       shows a question card; the person's pick is the result
 *   command_schema answers with one command's JSON Schema
 *   run_command    runs one registry command from the index, validated by the registry
 *   open_view      opens a classic dialog as a view
 */
function pseudoTools(goalIds) {
    return [
        {
            name: 'run_goal',
            ask: true,
            description: 'Answer the person\'s question with one standard goal from the goal list in the instructions. The interface runs the goal\'s plan on the net and picks the engine, horizon, seed and run count itself, so never name them. Pass only the inputs that goal lists. Returns the evidence; the interface shows the goal\'s caveat.',
            parameters: {
                type: 'object',
                properties: {
                    goal_id: { type: 'string', enum: goalIds, description: 'The goal\'s id.' },
                    inputs: { type: 'string', description: 'The goal\'s inputs as a JSON object in a string, e.g. {"observable":"I"}; place and transition ids exactly as the net lists them. Omit when the goal has no inputs.' },
                    engine_override: { type: 'string', enum: ENGINE_OVERRIDES, description: 'Only when the person named an engine ("use the ODE"). Otherwise leave out.' },
                },
                required: ['goal_id'],
            },
            json_args: ['inputs'],
        },
        {
            name: 'ask_user',
            ask: true,
            description: 'Ask the person ONE clarifying question as a card with 2 to 4 options, at most once per turn. Only when a required input has no value you can ground in the net, no safe default exists, and a wrong guess would give a plausible but misleading answer. Otherwise proceed and state your assumption.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'The question, in the person\'s words.' },
                    options: { type: 'array', items: { type: 'string' }, description: '2 to 4 short choices drawn from the net\'s own place or transition ids.' },
                    default_option: { type: 'string', description: 'The option you would take if the person answers "you decide"; one of options.' },
                },
                required: ['question', 'options'],
            },
        },
        {
            name: 'command_schema',
            ask: true,
            description: 'The JSON Schema of one command from the command index, to read before calling it with run_command. Not needed for a command that takes no arguments.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: 'The command id, e.g. sim.ode.' } },
                required: ['id'],
            },
        },
        {
            name: 'run_command',
            ask: true,
            description: 'Run one registry command from the command index: the long tail, for when no goal fits. Read its schema with command_schema first unless it takes no arguments.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'The command id, e.g. sim.ode.' },
                    args: { type: 'string', description: 'The command\'s arguments as a JSON object in a string. Omit when it takes none.' },
                    engine_override: { type: 'string', enum: ENGINE_OVERRIDES, description: 'Only when the person named an engine. Otherwise leave out.' },
                },
                required: ['id'],
            },
            json_args: ['args'],
        },
        {
            name: 'open_view',
            ask: true,
            description: 'Open one of the editor\'s classic views for the person to explore themselves: analysis, simulate, structure, results, app, components, check.',
            parameters: {
                type: 'object',
                properties: { view: { type: 'string', enum: GOAL_VIEWS, description: 'Which view to open.' } },
                required: ['view'],
            },
        },
    ];
}

const INDEX_HELP_MAX = 56;
const DANGLING = /\s+(?:a|an|the|of|to|and|or|with|from|in|on|is|by|for|as|at|that|its|e\.g|i\.e)$/i;

/** One line of help for the command index: the registry's first sentence, cut at a word. */
export function indexHelp(help) {
    // (no lookbehind: this module loads in browsers too, and an old Safari fails the whole module on one)
    const first = String(help || '').trim().replace(/\s+/g, ' ').split(/[.!?](?: |$)/)[0];
    if (first.length <= INDEX_HELP_MAX) return first;
    let cut = first.slice(0, INDEX_HELP_MAX + 1);
    cut = cut.slice(0, Math.max(cut.lastIndexOf(' '), 20));
    // not in the middle of a parenthesis, nor ending on a word that needs a next one
    const open = cut.lastIndexOf('(');
    if (open > 20 && open > cut.lastIndexOf(')')) cut = cut.slice(0, open);
    cut = cut.replace(/[\s,;:(\-]+$/, '');
    while (DANGLING.test(cut)) cut = cut.replace(DANGLING, '');
    return cut + '…';
}

/**
 * The goal toolset for a registry's specs (Registry.list()) and the goal
 * catalog (public/goals.json): the pseudo-tools, the GOAL_DIRECT_TOOLS exactly
 * as the full manifest declares them, and command_index, the id and one line
 * of help for every other command run_command can reach (the full manifest's
 * set: no excluded or session-state command).
 * @returns {{version: string, tools: Array, command_index: Array<{id: string, help: string}>}}
 */
export function buildGoalManifest(specs, goals) {
    const full = buildManifest(specs);
    const byCommand = new Map(full.tools.map((t) => [t.command, t]));
    const direct = GOAL_DIRECT_TOOLS.map(({ command }) => {
        const t = byCommand.get(command);
        if (!t) throw new Error(`goal tool ${command} is not a command the full manifest declares`);
        return t;
    });
    const goalIds = (goals.goals || []).filter((g) => g.available !== false).map((g) => g.id);
    if (!goalIds.length) throw new Error('no available goals');
    const directIds = new Set(GOAL_DIRECT_TOOLS.map((d) => d.command));
    const help = new Map(specs.map((s) => [s.id, s.help]));
    const command_index = full.tools.filter((t) => !directIds.has(t.command)).map((t) => ({ id: t.command, help: indexHelp(help.get(t.command)) }));
    return { version: GOAL_MANIFEST_VERSION, tools: [...pseudoTools(goalIds), ...direct], command_index };
}

/**
 * A model's call on the goal toolset → {pseudo, name, command?, args}. A
 * pseudo-tool has no command (the interface answers it); any other tool is a
 * registry command, as decodeCall has it. json_args are parsed either way.
 */
export function decodeGoalCall(manifest, call) {
    const tool = manifest.tools.find((t) => t.name === call.name);
    if (!tool) throw new Error(`unknown tool ${call.name}`);
    const args = { ...(call.args || {}) };
    for (const k of tool.json_args || []) {
        if (typeof args[k] === 'string') {
            const text = args[k].trim();
            if (!text) { delete args[k]; continue; }
            try { args[k] = JSON.parse(text); } catch { throw new Error(`${k}: not valid JSON`); }
        }
    }
    return tool.ask ? { pseudo: true, name: tool.name, args } : { pseudo: false, name: tool.name, command: tool.command, args };
}
