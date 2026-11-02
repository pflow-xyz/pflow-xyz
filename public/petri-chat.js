// petri-chat.js — the editor's assistant: the tool loop, with no DOM.
//
// A ChatSession holds one conversation with /api/llm/turn and runs the tools
// the model asks for. The model never touches the live document:
//
//   - edits run in a SANDBOX registry over a copy of the net; the person sees
//     the pending change as a diff and applies it as one undo step, or
//     discards it (ROADMAP phase 4, "Edits are previews until applied");
//   - queries and analyses run in the sandbox too, so the model can check its
//     own edits before the person applies them;
//   - view commands (highlight, show a set, fit) act on the live canvas;
//   - artifacts land in the editor's own store, so they show up in Results;
//   - a command whose answer depends on the engine is checked against the
//     net's own recommendation first (petri-engine-guard.js): a refusal is
//     the tool's error answer, so the model reads why and nothing ran.
//
// Two tool sets (docs/design/agent-first-analysis.md 4.2). 'all' is the
// Assistant's original surface: every registry command is a tool
// (public/llm-tools.json, petri-tools.js decodeCall). 'goals' is the Ask
// surface (public/llm-goal-tools.json, decodeGoalCall): the model gets
// goal-level tools and the interface does the work they name.
//
//   run_goal        look the goal up in the catalog (public/goals.json), check
//                   its inputs against the net (a place the net does not have
//                   is the tool's error, never a run), fill what the person's
//                   words and the goal's defaults can, run the plan on the
//                   sandbox through the engine guard, and keep the result:
//                   a provenance record, the artifacts, the assumptions. The
//                   model gets a COMPACT answer (goalAnswer); the interface
//                   adds the goal's caveat. {type:'goal', entry}
//   ask_user        end the loop on a question card (at most one a turn);
//                   answer() resumes it. {type:'ask', card}
//   command_schema  one command's JSON Schema and help, from the index
//   run_command     one registry command from the index: exactly runCall's
//                   path (sandbox, guard with engine_override, explain
//                   refuses edits). Analysis run this way with no goal is
//                   logged by id as composed work. {type:'composed', ids}
//   open_view       tells the interface to open a classic view
//                   {type:'open_view', view}; the interface opens it
//
// The model's prose is checked against the evidence (R3): when its reply
// follows a goal result, the numbers in it that are in no artifact, result or
// call argument become a warning on that result ({type:'answer', result,
// answer}), never a block. The reply is kept as result.answer, labelled the
// assistant's.
//
// Around the loop (design 4.1, 4.6 and 6):
//   force(mode), intent, resend(mode)   the intent chip: the person's own label for
//                   the next message, the label in force, "Not what I meant"
//   proposeNet(net, {notes, assumptions})   a described net as the pending change
//   rerunResult(result, {args})   the footer's Rerun / Edit settings, unguarded
//
// The twelve direct tools (net_add_place ... view_fit) are plain commands.
// A server that does not know the goals toolset answers 400 "toolset goals is
// not available"; the session then falls back to 'all' once
// ({type:'toolset', toolset:'all'}), which needs the full manifest as
// `allManifest`. A session built with the full manifest only is an 'all'
// session, as before.
//
// post(body) is injected: the UI passes a fetch to /api/llm/turn, tests a
// scripted model.
import { Registry, createHeadlessHost } from './petri-commands.js';
import { GOAL_VIEWS, decodeCall, decodeGoalCall, summarizeResult } from './petri-tools.js';
import { EngineGuard, checkEngine, engineNeeded, isEdit, modelKey, needsGuard, overrideAllowed, refusalText } from './petri-engine-guard.js';
import { inferPlace, runGoal } from './petri-goals.js';
import { engineOf, provenance, recordFromCall, recordFromGoalRun, rerun } from './petri-provenance.js';
import { followUpsFor, numeralsOutside } from './petri-ask.js';

// isEdit (which commands change the document, or the token game's marking,
// which lives in it: they make the sandbox differ from the live net) lives in
// the engine guard, which reads the same rule to judge a macro's steps; it is
// exported from here too, for the packages that gate on it.
export { isEdit };
// Commands that act on the canvas: always the live registry.
const VIEW = new Set(['view.highlight', 'view.clear_highlight', 'view.fit', 'artifact.show_set']);

export const MODES = ['auto', 'build', 'analyse', 'explain'];

// 'auto' lets the server label each message (intent and sentiment); the
// label picks one of the three real modes for that message's tool loop.

// sim's interview steps (pkg/builder): the server adds each step's guidance
// to the build mode's brief. The model ends a reply with "Next: <step>" when
// a step is complete; only a forward move is taken.
export const STEPS = ['describe', 'structure', 'rates', 'validate', 'preview', 'done'];

/** The step a reply asks to move to, or null. */
export function nextStepIn(text, current) {
    const m = /\bNext:\s*(describe|structure|rates|validate|preview|done)\b/i.exec(String(text || ''));
    if (!m) return null;
    const to = m[1].toLowerCase();
    return STEPS.indexOf(to) > STEPS.indexOf(current) ? to : null;
}

function checksText(report) {
    if (!report.findings.length) return `Checks after your edits (the engine's): none failed (${report.exhaustive ? 'every reachable marking explored' : report.note}).`;
    return `Checks after your edits (the engine's, not yours to dispute; fix them or say why they are intended):\n`
        + report.findings.map((f) => `- ${f.category}: ${f.message}`).join('\n')
        + (report.exhaustive ? '' : `\n(${report.note})`);
}

/** Whether a manifest is the goal toolset's (public/llm-goal-tools.json): pseudo-tools and a command index. */
export function isGoalManifest(manifest) {
    return !!manifest && Array.isArray(manifest.command_index) && (manifest.tools || []).some((t) => t.name === 'run_goal');
}

/**
 * The manifest's tools a mode can run: all of them, but for explain, which refuses an edit (runCall). A tool that edits
 * only when asked to (opt.fit with apply) stays, since it runs without edits there. A pseudo-tool of the goal toolset
 * (run_goal, ask_user ... : no command) stays too: run_command refuses an edit in explain mode itself.
 * @returns {Array<{name: string, command?: string, description: string}>}
 */
export function toolsFor(manifest, mode) {
    return mode === 'explain' ? manifest.tools.filter((t) => !t.command || !isEdit(t.command, {})) : manifest.tools;
}

/** The three intents a person can force; 'design' (the landing page's old word) is build. */
export const INTENT_MODES = ['build', 'analyse', 'explain'];

// ---- the goal toolset's pure helpers ----

const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');

function listIds(ids, max = 30) {
    return ids.length <= max ? ids.join(', ') : `${ids.slice(0, max).join(', ')} … (${ids.length - max} more)`;
}

function didYouMean(value, ids) {
    const k = norm(value);
    const hit = k ? ids.find((id) => norm(id) === k) : '';
    return hit ? ` Did you mean ${hit}?` : '';
}

const KIND_HELP = {
    place: 'a place id of the net', transition: 'a transition id of the net', number: 'a number',
    marking: 'a JSON object of place → token count, e.g. {"R": 10}', json: 'JSON',
};

// plan argument → the goal input it takes its value from ("$input.max_rate*0.25" → max_rate), over the plan steps that ran
function inputOfArg(goal, steps) {
    const map = new Map();
    (goal.plan || []).forEach((s, index) => {
        const ran = steps.find((x) => x.index === index);
        if (!ran || ran.skipped || ran.args === undefined) return;
        for (const [k, v] of Object.entries(s.args || {})) {
            const m = typeof v === 'string' ? /^\$input\.(\w+)(?:\*-?\d+(?:\.\d+)?)?$/.exec(v) : null;
            if (m && !map.has(k)) map.set(k, m[1]);
        }
    });
    return map;
}

/**
 * Check what the model passed for a goal's inputs against the net, and fill
 * what the code can: a place or transition the net does not have is an error
 * that names the ids it does have (never a run); a blank place input is
 * inferred from the person's own words (inferPlace) and recorded as an
 * ASSUMPTION; a blank input with a default is left for runGoal to default.
 * @param {Object} goal  a catalog goal
 * @param {Object} given the model's inputs
 * @param {{places: Object, transitions: Object}} model  the net the plan will run on
 * @param {string} [userText]  the person's words
 * @returns {{error: string} | {inputs: Object, filled: Object, defaulted: string[], assumed: Array<Object>, ignored: string[]}}
 *   inputs: given or inferred; filled: those plus the goal's defaults (defaulted names them); assumed: [{key, how: 'inferred'|'unnamed', label, value?, text, change}]
 */
export function prepareGoalInputs(goal, given, model, userText = '') {
    const places = Object.keys(model?.places || {});
    const transitions = Object.keys(model?.transitions || {});
    const asked = given && typeof given === 'object' && !Array.isArray(given) ? given : {};
    const declared = new Set((goal.inputs || []).map((i) => i.name));
    const ignored = Object.keys(asked).filter((k) => !declared.has(k));
    const inputs = {};
    const assumed = [];
    for (const i of goal.inputs || []) {
        const label = i.label || i.name;
        const v = asked[i.name];
        const blank = v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
        const options = i.kind === 'place' ? places : i.kind === 'transition' ? transitions : null;
        const change = { input: i.name, kind: i.kind, options };
        if (blank) {
            if (i.default !== undefined) continue;
            if (i.kind === 'place') {
                const p = inferPlace(model, userText);
                if (p) {
                    inputs[i.name] = p;
                    assumed.push({ key: i.name, how: 'inferred', label, value: p, text: `${label} = ${p} (taken from your words)`, change });
                    continue;
                }
            }
            if (i.optional) {
                if (i.kind === 'place') assumed.push({ key: i.name, how: 'unnamed', label, text: `${label}: not named; the command picks its own default`, change });
                continue;
            }
            return { error: `${goal.id} needs ${i.name} (${label}): ${KIND_HELP[i.kind] || i.kind}.${options ? ` Choices: ${listIds(options)}.` : ''} If the person's words do not say, ask them with ask_user.` };
        }
        if (i.kind === 'place' || i.kind === 'transition') {
            if (typeof v !== 'string' || !options.includes(v)) {
                return { error: `${i.name}: ${JSON.stringify(v)} is not a ${i.kind} of this net. The net's ${i.kind}s are: ${listIds(options)}.${typeof v === 'string' ? didYouMean(v, options) : ''} Nothing ran.` };
            }
            inputs[i.name] = v;
        } else if (i.kind === 'number') {
            const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
            if (typeof n !== 'number' || !Number.isFinite(n)) return { error: `${i.name}: ${JSON.stringify(v)} is not a number. Nothing ran.` };
            inputs[i.name] = n;
        } else if (i.kind === 'marking') {
            let m = v;
            if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return { error: `${i.name}: not valid JSON. Pass ${KIND_HELP.marking}. Nothing ran.` }; } }
            if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: `${i.name}: pass ${KIND_HELP.marking}. Nothing ran.` };
            const bad = Object.keys(m).find((k) => !places.includes(k));
            if (bad !== undefined) return { error: `${i.name}: ${JSON.stringify(bad)} is not a place of this net. The net's places are: ${listIds(places)}.${didYouMean(bad, places)} Nothing ran.` };
            inputs[i.name] = m;
        } else {
            inputs[i.name] = v; // json: text or a value; runGoal parses text
        }
    }
    const filled = { ...inputs };
    const defaulted = [];
    for (const i of goal.inputs || []) {
        if (filled[i.name] === undefined && i.default !== undefined) {
            filled[i.name] = i.default;
            defaulted.push(i.name);
        }
    }
    return { inputs, filled, defaulted, assumed, ignored };
}

const clipValue = (v, n) => {
    const s = JSON.stringify(v);
    return s === undefined || s.length <= n ? v : { truncated: true, text: s.slice(0, n) };
};

/**
 * The longest a run_goal answer to the model may be, in JSON characters. The
 * scripted eval (petri-ask-eval_test.ts) measures the 44 cases against it;
 * goalAnswer shrinks an answer that would exceed it, so it is a guarantee.
 */
export const GOAL_ANSWER_MAX = 6000;

/**
 * What goes back to the model after run_goal: compact, and only the evidence.
 * The engine decision, then each step that ran (summarizeResult: long series
 * become their ends and extremes) with the arguments the plan resolved, the
 * assumptions and the warnings. Never the goal's caveat (the interface adds
 * it), and no number that is not in a result or an artifact the model is told
 * to quote. The sim.recommend step is folded into `engine`.
 * @param {Object} o
 * @param {Object} o.goal
 * @param {Object} o.record  the provenance record
 * @param {Array} o.steps    runGoal's steps
 * @param {(id: string) => Object|undefined} o.artifact  an artifact object by id
 * @param {string[]} [o.warnings]
 * @param {Array<{text: string}>} [o.assumed]
 * @param {string[]} [o.notes]
 * @param {number} [o.max]
 */
export function goalAnswer({ goal, record, steps, artifact, warnings = [], assumed = [], notes = [], max = GOAL_ANSWER_MAX }) {
    /** @type {Record<string, any>} */
    const out = { goal: goal.id, question: goal.question };
    if (record.engine) {
        out.engine = { name: record.engine.name };
        // the recommender's first sentence (what the net has); the rest is the generic rule, which the footer shows
        if (record.engine.reason) out.engine.why = (/^[\s\S]*?\.(?= [A-Z]|$)/.exec(record.engine.reason) || [record.engine.reason])[0];
        if (record.engine.overridden) out.engine.overridden = true;
        if (record.engine.recommendedOnly) out.engine.recommendedOnly = true;
    }
    out.steps = steps.filter((s) => s.command !== 'sim.recommend' && !s.skipped && !s.refused && !s.error && s.args !== undefined).map((s) => {
        const arts = (s.artifacts || []).map(artifact).filter(Boolean);
        const sum = summarizeResult(s.result ?? null, arts);
        // a result too big to quote whole that is mostly its own artifacts (sim.what_if's series and table): the
        // artifacts' summaries are the evidence, and a clipped copy of the result would only repeat them badly
        if (sum.result && sum.result.truncated && arts.length && s.result && typeof s.result === 'object') {
            const scalars = Object.fromEntries(Object.entries(s.result).filter(([, v]) => v === null || typeof v !== 'object'));
            sum.result = { ...scalars, inTheArtifacts: Object.keys(s.result).filter((k) => !(k in scalars)) };
        }
        return { command: s.command, args: clipValue(s.args, 300), ...sum };
    });
    if (assumed.length) out.assumed = assumed.map((a) => a.text);
    if (warnings.length) out.warnings = [...warnings]; // (a copy: the result's own list gets more later, and this one is in the conversation)
    if (notes.length) out.notes = notes;
    const size = () => JSON.stringify(out).length;
    if (size() > max) for (const s of out.steps) delete s.args;
    if (size() > max && out.steps.length) {
        const budget = Math.max(400, Math.floor((max - 1200) / out.steps.length));
        for (const s of out.steps) {
            s.result = clipValue(s.result, Math.floor(budget / 2));
            s.artifacts = s.artifacts.map((a) => clipValue(a, Math.floor(budget / (2 * Math.max(1, s.artifacts.length)))));
        }
    }
    return out;
}

const COMPOSE_PREFIXES = ['analysis.', 'sim.', 'opt.', 'game.'];
/** An analysis, simulation or optimisation command that does not edit: the work a goal would stand for. */
const isComposable = (id, args) => COMPOSE_PREFIXES.some((p) => id.startsWith(p)) && !isEdit(id, args);

// an entry's command arguments (a run_command entry keeps the call's own in `args`)
const argsOf = (entry) => entry.commandArgs ?? entry.args;
const editsNet = (entry) => typeof entry.command === 'string' && isEdit(entry.command, argsOf(entry));

// ---- what a person's edit of a rerun says ----

function patchArgs(args, patch) {
    const out = JSON.parse(JSON.stringify(args ?? {}));
    for (const [k, v] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
        if (v === undefined) delete out[k]; else out[k] = v;
    }
    return out;
}

function overridesFor(calls, args) {
    if (!args) return calls.map(() => undefined);
    if (Array.isArray(args)) return calls.map((_, i) => args[i]);
    return calls.map((c, i) => args[i] ?? args[c.command]);
}

function editText(command, before, after) {
    const show = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
    const changes = keys.filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))
        .map((k) => `${k} ${before?.[k] === undefined ? '(unset)' : show(before[k])} → ${after?.[k] === undefined ? '(unset)' : show(after[k])}`);
    return changes.length ? `${command}: ${changes.join(', ')}` : '';
}

let resultSeq = 0;
const resultId = () => `r${++resultSeq}`;

export class ChatSession {
    /**
     * @param {Object} o
     * @param {Registry} o.live      the editor's registry
     * @param {Object} o.manifest    the tool manifest of the toolset: public/llm-goal-tools.json for 'goals', public/llm-tools.json for 'all'
     * @param {(body: Object) => Promise<Object>} o.post   one /api/llm/turn call
     * @param {string} [o.mode]
     * @param {number} [o.maxRounds] model calls per message at most (default 6)
     * @param {(ms: number) => Promise<void>} [o.sleep] how a 429's wait is spent (tests pass a fake)
     * @param {number} [o.maxWaitS] the longest 429 advice worth waiting out, in seconds (default 90)
     * @param {'goals'|'all'} [o.toolset] 'goals' (the default) is the Ask surface and needs the goal manifest as `manifest` and the
     *   catalog as `goals`; given the full manifest instead, the session is an 'all' session, the Assistant's original surface
     * @param {{goals: Array}} [o.goals]  public/goals.json, for run_goal
     * @param {Object} [o.allManifest]  public/llm-tools.json: what a 'goals' session falls back to when the server lacks the goals toolset
     * @param {string} [o.netCid]  the open net's CID, for the provenance records (settable as session.netCid)
     * @param {{registry?: string, app?: string}} [o.versions]  the engine identities records are made with (default: petri-provenance.js's)
     */
    constructor({ live, manifest, post, mode = 'analyse', maxRounds = 6, step = 'describe', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitS = 90,
        toolset = 'goals', goals = null, allManifest = null, netCid = null, versions = null }) {
        if (toolset !== 'goals' && toolset !== 'all') throw new Error("toolset must be 'goals' or 'all'");
        this.sleep = sleep;
        this.maxWaitS = maxWaitS;
        this.live = live;
        this.post = post;
        this.mode = mode;
        this.goals = goals;
        this.netCid = netCid;
        this.versions = versions;
        if (isGoalManifest(manifest)) {
            this.allManifest = allManifest;
            if (toolset === 'goals') {
                if (!Array.isArray(goals?.goals)) throw new TypeError('the goals toolset needs the goal catalog (public/goals.json) as `goals`');
                this.toolset = 'goals';
                this.manifest = manifest;
            } else {
                if (!allManifest) throw new TypeError("toolset 'all' needs the full manifest (public/llm-tools.json) as `allManifest`");
                this.toolset = 'all';
                this.manifest = allManifest;
            }
        } else {
            // the full manifest only: the Assistant's original surface, whichever toolset was asked for
            this.toolset = 'all';
            this.manifest = manifest;
            this.allManifest = allManifest || manifest;
        }
        /** The commands run_command and command_schema reach: the goal manifest's index and its direct tools' commands. */
        this._runnable = isGoalManifest(manifest)
            ? new Set([...manifest.command_index.map((e) => e.id), ...manifest.tools.filter((t) => t.command).map((t) => t.command)])
            : new Set();
        /** In auto mode: the mode the last message resolved to (analyse, the read-only one, until one has). */
        this.resolved = null;
        this.step = step;
        this.maxRounds = maxRounds;
        /** The engine guard, over whichever sandbox is current. */
        this.guard = new EngineGuard(() => this.sandbox);
        this.messages = [];
        /** {round, name, command, args, ok, result?, error?, artifacts: string[], ms} */
        this.calls = [];
        /** Analysis composed with run_command and no goal, one list of command ids per turn: the input for adding goals (R5). No text. */
        this.composedLog = [];
        /** {notes, assumptions} while a described net waits as the pending change (proposeNet), else null. */
        this.proposal = null;
        this.pending = false;
        this._forced = null;
        this._ask = null;
        this._decided = [];
        this._reseed();
        this._turn = this._newTurn('');
        this._turn.open = false;
    }

    _reseed() {
        const host = createHeadlessHost(structuredClone(this.live.host.getModel()));
        this.sandbox = new Registry(host, undefined, { store: this.live._store });
        this.pending = false;
        this.proposal = null;
    }

    /** The sandbox's net (what the model sees and edits). */
    model() {
        return this.sandbox.host.getModel();
    }

    setMode(mode) {
        if (!MODES.includes(mode)) throw new Error(`mode must be ${MODES.join(', ')}`);
        this.mode = mode;
    }

    /** The mode the tools run under: the person's forced intent for this message, the chosen mode, or auto's latest label. */
    get effectiveMode() {
        if (this._turn.open && this._turn.forced) return this._turn.forced;
        return this.mode === 'auto' ? (this.resolved || 'analyse') : this.mode;
    }

    /**
     * The intent the last message ran under, or the next one will: what the person forced, else the server's last label
     * (auto), else the session's mode. null in auto mode until the server has labelled a message.
     * @returns {'build'|'analyse'|'explain'|null}
     */
    get intent() {
        if (this._forced) return this._forced;
        if (this._turn.open && this._turn.forced) return this._turn.forced;
        return this.mode === 'auto' ? this.resolved : this.mode;
    }

    /**
     * The next message is labelled by the person, not the server: 'build', 'analyse' or 'explain' ('design' is build).
     * It costs no classifier call. force(null) takes it back.
     */
    force(mode) {
        if (mode === null || mode === undefined) { this._forced = null; return; }
        const m = mode === 'design' ? 'build' : mode;
        if (!INTENT_MODES.includes(m)) throw new Error(`intent must be ${INTENT_MODES.join(', ')} ('design' is build)`);
        this._forced = m;
    }

    /** What the assistant can use right now; `calls` is what it has used. */
    get tools() {
        return toolsFor(this.manifest, this.effectiveMode);
    }

    async _netSummary() {
        const info = await this.sandbox.execute('net.info');
        const s = JSON.stringify(info);
        return s.length <= 20000 ? info : { note: 'net too large to summarise in full', places: info.places.length, transitions: info.transitions.length, arcs: info.arcs.length };
    }

    /**
     * One /api/llm/turn call. A 429 that advises a short wait (the per-minute
     * limit: "try again in 17 s") is waited out and retried here, with the
     * same messages, so a turn whose tools already ran (and spent calls) is
     * not dropped and the person does not have to type "continue". A daily
     * limit (hours) is not waited out: it is thrown as is.
     */
    async _post(body, onEvent) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.post(body);
            } catch (e) {
                const s = e.retryAfter;
                if (e.status !== 429 || !(s > 0) || s > this.maxWaitS || attempt >= 3) throw e;
                onEvent({ type: 'wait', seconds: s, attempt: attempt + 1 });
                await this.sleep((s + 1) * 1000);
            }
        }
    }

    /**
     * _post, and once: a server without the goals toolset answers 400 "toolset
     * goals is not available on this server". The session becomes an 'all'
     * session ({type:'toolset', toolset:'all'}) and the same turn is asked again
     * without the toolset field. Without the full manifest to decode the calls
     * with, the error stands.
     */
    async _turnPost(body, onEvent) {
        try {
            return await this._post(body, onEvent);
        } catch (e) {
            if (this.toolset !== 'goals' || e.status !== 400 || !/toolset goals is not available/i.test(String(e.message)) || !this.allManifest) throw e;
            this.toolset = 'all';
            this.manifest = this.allManifest;
            onEvent({ type: 'toolset', toolset: 'all', reason: String(e.message) });
            const { toolset, ...rest } = body;
            return this._post(rest, onEvent);
        }
    }

    /** The person's latest typed message (not a tool answer), or ''. */
    _lastUserText() {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role !== 'user') continue;
            const parts = m.parts || [];
            // what the person typed into a question card's "Other…" travels as a tool result, but it is their words
            const typed = parts.filter((p) => p.functionResponse?.response?.other === true && typeof p.functionResponse.response.answer === 'string')
                .map((p) => p.functionResponse.response.answer);
            if (typed.length) return typed.join('\n');
            if (parts.some((p) => p.functionResponse)) continue;
            const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
            if (text) return text;
        }
        return '';
    }

    /**
     * Run one model call's tool call. Never throws: a failure is the tool's
     * answer. A command whose answer depends on the engine goes through the
     * engine guard first: when the net's recommendation rules the engine out,
     * the answer is "refused: <why>" and nothing runs; when it runs on a
     * caution, entry.warning carries the chip's text.
     *
     * On the goal toolset the five pseudo-tools are answered here too (see the
     * header); their entries carry `kind` ('goal' | 'ask' | 'schema' | 'command'
     * | 'view'), and a run_command entry has the command in `command` and its
     * arguments in `commandArgs` (`args` stays the call's own, which rerun repeats).
     * @param {{name: string, args?: Object}} call
     * @param {number} [round]
     * @param {Object} [opts]
     * @param {string} [opts.override]  the engine the model asks for against the recommendation (a run_goal / run_command
     *   engine_override); honoured only when the person's latest message names that engine
     * @param {boolean} [opts.canOverride]  the interface this call came through offers an engine_override, so the refusal
     *   tells the model it can pass one. The plain tools have none: there the refusal is final
     * @param {string} [opts.userText]  the person's words, when not their latest message (a rerun)
     * @returns {Promise<any>} the logged call: {round, name, command, args, ok, result?, error?, refused?, warning?, override?, artifacts, ms}
     */
    async runCall(call, round = 0, opts = {}) {
        const t0 = Date.now();
        const entry = { round, name: call.name, args: call.args || {}, ok: false, artifacts: [] };
        try {
            if (this.toolset === 'goals') {
                const d = decodeGoalCall(this.manifest, call);
                entry.args = d.args;
                if (d.pseudo) {
                    await this._pseudo(d.name, d.args, entry, opts);
                } else {
                    entry.command = d.command;
                    await this._exec(entry, d.command, d.args, opts);
                }
            } else {
                const [id, args] = decodeCall(this.manifest, call);
                entry.command = id;
                entry.args = args;
                await this._exec(entry, id, args, opts);
            }
        } catch (e) {
            entry.error = e.message || String(e);
        }
        entry.ms = Date.now() - t0;
        this.calls.push(entry);
        return entry;
    }

    /** A registry command through the sandbox (view commands: the live registry), the guard in front. Throws the tool's error. */
    async _exec(entry, id, args, opts) {
        if (this.effectiveMode === 'explain' && isEdit(id, args)) throw new Error('explain mode does not edit; switch to build to change the net');
        if (!this.pending && !VIEW.has(id)) this._reseed();
        if (!VIEW.has(id) && needsGuard(id, args)) {
            const userText = opts.userText ?? this._lastUserText();
            const v = await this.guard.check(id, args, { override: opts.override, userText });
            if (v.verdict === 'refuse') {
                entry.refused = { rule: v.rule, message: v.message, recommended: v.recommended };
                throw new Error(refusalText(v, { canOverride: !!opts.canOverride }));
            }
            if (v.verdict === 'warn') {
                entry.warning = v.message;
                if (v.overridden) {
                    entry.override = v.needs;
                    entry.overrideText = userText;
                }
            }
        }
        const reg = VIEW.has(id) ? this.live : this.sandbox;
        const before = new Set(reg.artifacts().map((a) => a.id));
        entry.result = await reg.execute(id, args);
        entry.ok = true;
        entry.artifacts = reg.artifacts().filter((a) => !before.has(a.id)).map((a) => a.id);
        if (isEdit(id, args)) this.pending = true;
    }

    // ---- the goal toolset's pseudo-tools ----

    async _pseudo(name, args, entry, opts) {
        switch (name) {
        case 'run_goal': return this._runGoal(args, entry, opts);
        case 'ask_user': return this._askUser(args, entry);
        case 'command_schema': return this._commandSchema(args, entry);
        case 'run_command': return this._runCommand(args, entry, opts);
        case 'open_view': return this._openView(args, entry);
        default: throw new Error(`unknown tool ${name}`);
        }
    }

    _requireRunnable(id) {
        if (typeof id === 'string' && this._runnable.has(id)) return;
        const near = typeof id === 'string' ? [...this._runnable].find((c) => c.replace('.', '_') === id) : '';
        throw new Error(near ? `${JSON.stringify(id)} is not a command id: did you mean ${near}?` : `${JSON.stringify(id)} is not a command of the command index; give an id from the index, such as sim.ode`);
    }

    _netRef() {
        return { ...(this.netCid ? { cid: this.netCid } : {}), revision: modelKey(this.model()) };
    }

    _artifacts(ids) {
        return ids.map((id) => this.live._store.items.find((a) => a.id === id)).filter(Boolean);
    }

    async _runGoal(args, entry, opts) {
        entry.kind = 'goal';
        const goals = this.goals.goals;
        const goal = goals.find((g) => g.id === args.goal_id);
        if (!goal || goal.available === false) {
            throw new Error(`${JSON.stringify(args.goal_id)} is not a goal you can run. The goals are: ${goals.filter((g) => g.available !== false).map((g) => g.id).join(', ')}.`);
        }
        entry.goal = { id: goal.id, question: goal.question };
        if (args.inputs !== undefined && (args.inputs === null || typeof args.inputs !== 'object' || Array.isArray(args.inputs))) {
            throw new Error('inputs must be a JSON object in a string, e.g. {"observable":"I"}');
        }
        if (!this.pending) this._reseed();
        const model = this.model();
        const userText = opts.userText ?? this._lastUserText();
        const prep = prepareGoalInputs(goal, args.inputs || {}, model, userText);
        if (prep.error) throw new Error(prep.error);
        entry.inputs = prep.filled;

        // The engine the model asked for against the recommendation counts only when the person's own words name it
        // (overrideAllowed); the plan picks its branch by sim.recommend's engine, so an honoured 'ode' makes the plan's
        // ODE branch the one that runs (its guard then warns). No goal has an SDE step: that override changes nothing.
        const asked = typeof (opts.override ?? args.engine_override) === 'string' ? String(opts.override ?? args.engine_override).toLowerCase() : undefined;
        const honoured = asked && overrideAllowed(userText, asked) ? asked : undefined;
        if (asked && !honoured) entry.overrideIgnored = asked;
        let registry = this.sandbox;
        let guard = this.guard;
        if (honoured === 'ode') {
            const real = this.sandbox;
            registry = {
                artifacts: () => real.artifacts(),
                execute: async (id, a) => {
                    const r = await real.execute(id, a);
                    return id === 'sim.recommend' && r && typeof r === 'object' ? { ...r, engine: 'ode' } : r;
                },
            };
            // the guard judges against the net's real recommendation, which the patched result must not replace
            guard = { check: (id, a, o) => this.guard.check(id, a, o), prime() {} };
        }
        const run = await runGoal(registry, goal, prep.filled, () => {}, { guard, override: asked, userText });
        const failed = run.steps.find((s) => s.error || s.refused);
        if (!run.ok && failed) {
            if (failed.refused) {
                entry.refused = failed.refused;
                throw new Error(refusalText({ message: failed.refused.message, needs: engineNeeded(failed.command, failed.args)?.needs ?? null }, { canOverride: true }));
            }
            const blank = (goal.inputs || []).filter((i) => i.kind === 'place' && prep.inputs[i.name] === undefined);
            const hint = blank.length ? ` Pass ${blank.map((i) => `inputs.${i.name}`).join(' and ')} (a place of the net: ${listIds(Object.keys(model.places || {}))}), or ask the person with ask_user.` : '';
            // optional inputs that were left out may be what the plan needs (best_play's `auto`: win claims that fire on their own)
            const unset = (goal.inputs || []).filter((i) => i.optional && i.kind !== 'place' && prep.filled[i.name] === undefined);
            const optional = unset.length ? ` Optional inputs you did not pass: ${unset.map((i) => `${i.name} (${String(i.label || '').split(/[,:(]/)[0].trim()}${i.example ? `, e.g. ${i.example}` : ''})`).join('; ')}.` : '';
            throw new Error(`${failed.command}: ${failed.error}.${hint}${optional} Nothing was shown.`);
        }

        const rec = honoured === 'ode' ? await this.guard.recommendation() : undefined;
        const record = recordFromGoalRun(goal, run, { recommendation: rec, inputs: prep.inputs, net: this._netRef(), versions: this.versions || undefined });
        // A plan that always runs the SSA (risk, one_more) on a net the recommender gave to the ODE is not an override: the
        // SSA reads every net, and the goal asks for runs. recordFromGoalRun flags any engine that differs from the
        // recommendation; only a guard warning (an override the person earned) is kept as such.
        const e = record.engine;
        if (e && e.overridden && !honoured && !run.steps.some((x) => x.warning)) {
            delete e.overridden;
            delete e.warning;
            e.reason = `The ${goal.id} goal runs the ${e.name} by design. ${e.reason}`.trim();
        }
        // the plan's own assumptions get a Change where the value came from an input; the code's own are added
        const refs = inputOfArg(goal, run.steps);
        const declared = new Map((goal.inputs || []).map((i) => [i.name, i]));
        const assumed = record.assumed.map((a) => {
            const isDefault = / \(default for /.test(a.text);
            const decl = isDefault && declared.get(refs.get(a.key));
            if (decl) a.change = a.key;
            return { key: a.key, text: a.text, how: isDefault ? 'default' : 'plan', ...(decl ? { change: { input: decl.name, kind: decl.kind, arg: a.key, options: null, default: decl.default } } : {}) };
        });
        // the call argument an input fills, when a call that ran takes it at the top level (else the footer names the input)
        const argOf = (input) => [...refs].find(([, name]) => name === input)?.[0] || input;
        // a default the plan uses inside a nested argument (best_setting's scenarios) is not one the record can see
        const covered = new Set(record.assumed.map((a) => refs.get(a.key)).filter(Boolean));
        const fell = prep.defaulted.filter((n) => !covered.has(n)).map((n) => {
            const i = declared.get(n);
            const label = i.label || i.name;
            return { key: n, how: 'default', label, value: i.default, text: `${label} = ${i.default} (default for ${goal.id})`, change: { input: n, kind: i.kind, arg: [...refs].find(([, name]) => name === n)?.[0] || null, options: null, default: i.default } };
        });
        for (const a of [...prep.assumed, ...fell, ...this._decided.splice(0)]) {
            assumed.push(a);
            record.assumed.push({ key: a.key, text: a.text, ...(a.change ? { change: argOf(a.change.input) } : {}) });
        }

        const notes = [];
        const warnings = [...new Set(run.steps.map((s) => s.warning).filter(Boolean))];
        if (asked && !honoured) {
            notes.push(`engine_override "${asked}" was not applied: the person's own message does not name that engine.`);
        } else if (honoured) {
            const ran = run.steps.some((s) => s.args !== undefined && !s.skipped && !s.refused && !s.error
                && (engineOf(s.command, s.args) || '').split('+').includes(honoured.toUpperCase()));
            if (!ran) {
                const w = `You asked for the ${honoured.toUpperCase()}; the “${goal.id}” goal has no ${honoured.toUpperCase()} step for this net, so it ran what the plan runs. The ${honoured.toUpperCase()} is in the Tools palette.`;
                warnings.push(w);
                record.warnings.push(w);
                notes.push(w);
                entry.overrideUnused = honoured;
            }
        }
        if (honoured) {
            entry.override = honoured;
            entry.overrideText = userText;
        }
        const ids = [...new Set(run.steps.flatMap((s) => s.artifacts || []))];
        const artifacts = this._artifacts(ids);
        const warning = warnings[0];
        const result = {
            id: resultId(), title: goal.question, source: 'ask', goal: { id: goal.id, question: goal.question },
            record, artifacts, steps: run.steps, inputs: prep.filled, warnings, assumed,
            caveat: goal.caveat || '', answerShape: goal.answer || '', followUps: followUpsFor(goal, this.goals).map((g) => g.id),
            registry: this.sandbox, onProposal: !!this.proposal, answer: null, stale: false,
        };
        entry.ok = true;
        entry.result = result;
        entry.artifacts = ids;
        if (warning) entry.warning = warning;
        entry.response = goalAnswer({ goal, record, steps: run.steps, artifact: (id) => artifacts.find((a) => a.id === id), warnings, assumed, notes });
        this._turn.goalRuns++;
        this._turn.results.push(result);
    }

    _askUser(args, entry) {
        entry.kind = 'ask';
        if (this._turn.asks >= 1) {
            throw new Error('You already asked the person a question this turn. Do not ask again: go ahead with your best assumption, run the goal, and state the assumption in your reply.');
        }
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        const options = Array.isArray(args.options) ? [...new Set(args.options.filter((o) => typeof o === 'string').map((o) => o.trim()).filter(Boolean))] : [];
        if (!question || options.length < 2 || options.length > 4) throw new Error('ask_user needs a question and 2 to 4 different options');
        const given = typeof args.default_option === 'string' ? args.default_option.trim() : '';
        this._turn.asks++;
        entry.ok = true;
        entry.asked = { question, options, default_option: options.includes(given) ? given : null, callName: entry.name, round: entry.round };
    }

    _commandSchema(args, entry) {
        entry.kind = 'schema';
        this._requireRunnable(args.id);
        const spec = this.live.describe(args.id);
        const payload = { id: spec.id, label: spec.label, help: spec.help, args: spec.args };
        if (spec.available === false) payload.available = false;
        if (JSON.stringify(payload).length > 6000) {
            const strip = (s) => (s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'description').map(([k, v]) => [k, Array.isArray(v) ? v : strip(v)])) : s);
            payload.args = strip(spec.args);
        }
        entry.ok = true;
        entry.result = payload;
        entry.response = payload;
    }

    async _runCommand(args, entry, opts) {
        entry.kind = 'command';
        this._requireRunnable(args.id);
        const cargs = args.args ?? {};
        if (cargs === null || typeof cargs !== 'object' || Array.isArray(cargs)) throw new Error('args must be the command\'s arguments as a JSON object in a string');
        entry.command = args.id;
        entry.commandArgs = cargs;
        const override = typeof args.engine_override === 'string' ? args.engine_override : opts.override;
        await this._exec(entry, args.id, cargs, { ...opts, override, canOverride: true });
        if (isComposable(args.id, cargs)) this._turn.composed.push(args.id);
        if (entry.artifacts.length) entry.shown = this._commandResult(entry);
    }

    /** A run_command that made artifacts, as a result the Ask pane can stack (no goal, no caveat). */
    _commandResult(entry) {
        const used = engineOf(entry.command, entry.commandArgs);
        const engine = used ? { name: used, reason: '', ...(entry.override ? { overridden: true } : {}), ...(entry.warning ? { warning: entry.warning } : {}) } : null;
        const record = recordFromCall({ command: entry.command, args: entry.commandArgs }, { engine, net: this._netRef(), versions: this.versions || undefined });
        let title = entry.command;
        try { title = this.live.describe(entry.command).label || title; } catch { /* the id is the title */ }
        return {
            id: resultId(), title, source: 'ask', goal: null, record, artifacts: this._artifacts(entry.artifacts),
            steps: [{ index: 0, command: entry.command, args: entry.commandArgs, result: entry.result, artifacts: entry.artifacts }],
            inputs: {}, warnings: entry.warning ? [entry.warning] : [], assumed: [], caveat: '', answerShape: '', followUps: [],
            registry: this.sandbox, onProposal: !!this.proposal, answer: null, stale: false, composed: true,
        };
    }

    _openView(args, entry) {
        entry.kind = 'view';
        if (!GOAL_VIEWS.includes(args.view)) throw new Error(`view must be one of ${GOAL_VIEWS.join(', ')}`);
        entry.view = args.view;
        entry.ok = true;
        entry.result = { opened: args.view };
        entry.response = entry.result;
    }

    _responseFor(entry) {
        if (!entry.ok) return { name: entry.name, response: { error: entry.error } };
        if (entry.response) return { name: entry.name, response: entry.response };
        const arts = entry.artifacts.map((id) => this.live._store.items.find((a) => a.id === id)).filter(Boolean);
        const payload = summarizeResult(entry.result, arts);
        if (entry.warning) payload.warning = `${entry.warning}. Say so when you report this result.`;
        if (this.pending && editsNet(entry)) payload.note = 'previewed in the sandbox; the person applies or discards it';
        return { name: entry.name, response: payload };
    }

    _newTurn(text) {
        return {
            open: true, text, forced: this._forced,
            messagesLen: this.messages.length, callsLen: this.calls.length, composedLen: this.composedLog.length,
            model: structuredClone(this.sandbox.host.getModel()), pending: this.pending, proposal: this.proposal, step: this.step,
            asks: 0, goalRuns: 0, composed: [], results: [],
        };
    }

    /**
     * The model's reply after a goal result is that result's answer, labelled the assistant's. R3: a number in it that
     * is in no artifact, step result, call argument or word of the person's is a warning on the result (not a block).
     */
    _checkAnswer(text, onEvent) {
        const results = this._turn.results;
        const last = results.at(-1);
        const evidence = results.map((r) => [r.artifacts.map((a) => a.data), r.steps.map((s) => s.result), r.record.calls, r.record.engine, r.record.assumed, r.inputs]);
        const stray = numeralsOutside(text, evidence, { also: this._lastUserText() });
        last.answer = { by: 'assistant', text, ...(stray.length ? { stray } : {}) };
        if (stray.length) last.warnings.push(`The assistant's text has ${stray.length === 1 ? 'a number' : 'numbers'} that ${stray.length === 1 ? 'is' : 'are'} in none of the results: ${stray.join(', ')}.`);
        onEvent({ type: 'answer', result: last, answer: last.answer });
    }

    /** The turn is over: analysis composed from commands with no goal is logged by id, for adding goals later. */
    _finishTurn(onEvent) {
        const t = this._turn;
        if (!t.open) return;
        t.open = false;
        if (t.composed.length && !t.goalRuns) {
            this.composedLog.push([...t.composed]);
            onEvent({ type: 'composed', ids: [...t.composed] });
        }
    }

    /**
     * Send the person's message and run the loop until the model answers
     * without tools, asks the person a question, or maxRounds model calls.
     * onEvent receives {type: 'reply' | 'call' | 'round' | 'quota' | 'auto' | 'wait' | 'step' | 'checks' | 'intent'
     * | 'toolset' | 'goal' | 'command' | 'ask' | 'choice' | 'answer' | 'open_view' | 'composed', ...} as it happens (the goals
     * toolset's events are described on the pseudo-tools in the header: goal {entry}, command {entry}, ask {card}, choice
     * {answer} (the person's pick on a card), answer {result, answer} (the model's reply attached to the goal result it follows), open_view {view}, composed
     * {ids}, toolset {toolset}; intent {mode, forced, sentiment?, confidence?} when a message's intent is known).
     * A message typed while a question card is open is the card's "Other…" answer (see answer).
     * @param {string} text
     * @param {(e: Object) => void} [onEvent]
     * @returns {Promise<{reply: string, rounds: number, stopped?: string, asked?: {question: string, options: string[], default_option: string|null, callName: string, round: number}}>}
     */
    async send(text, onEvent = () => {}) {
        if (this._ask) return this.answer({ other: text }, onEvent);
        if (!this.pending) this._reseed();
        this._turn = this._newTurn(text);
        const forced = this._forced;
        this._forced = null;
        if (forced) {
            this.resolved = forced;
            onEvent({ type: 'intent', mode: forced, forced: true });
        }
        this.messages.push({ role: 'user', parts: [{ text }] });
        return this._loop(onEvent, true);
    }

    async _loop(onEvent, first) {
        try {
            return await this._rounds(onEvent, first);
        } catch (e) {
            this._turn.open = false;
            throw e;
        }
    }

    async _rounds(onEvent, first) {
        const t = this._turn;
        let reply = '';
        for (let round = 1; round <= this.maxRounds; round++) {
            onEvent({ type: 'round', round });
            // Auto asks the server to label the message on the first round only (and not when the person
            // labelled it); later rounds (tool results) carry the mode it chose.
            const labelling = this.mode === 'auto' && first && round === 1 && !t.forced;
            const body = { mode: labelling ? 'auto' : this.effectiveMode, net: await this._netSummary(), messages: this.messages };
            if (this.toolset === 'goals') body.toolset = 'goals';
            if (labelling && this.resolved) body.prev_mode = this.resolved;
            if (labelling || this.effectiveMode === 'build') body.step = this.step;
            const resp = await this._turnPost(body, onEvent);
            if (labelling && resp.auto) {
                this.resolved = resp.auto.mode;
                onEvent({ type: 'auto', ...resp.auto });
                onEvent({ type: 'intent', mode: resp.auto.mode, forced: false, sentiment: resp.auto.sentiment, confidence: resp.auto.confidence });
            }
            if (resp.remaining_today !== undefined) onEvent({ type: 'quota', remaining: resp.remaining_today, reset: resp.reset });
            this.messages.push(resp.message && resp.message.parts?.length ? resp.message : { role: 'model', parts: [{ text: resp.reply || '…' }] });
            if (resp.reply) {
                reply = resp.reply;
                onEvent({ type: 'reply', text: resp.reply });
                if (t.results.length) this._checkAnswer(resp.reply, onEvent);
                const to = this.effectiveMode === 'build' ? nextStepIn(resp.reply, this.step) : null;
                if (to) {
                    this.step = to;
                    onEvent({ type: 'step', step: to });
                }
            }
            const calls = resp.tool_calls || [];
            const refused = resp.refused || [];
            if (!calls.length && !refused.length) {
                this._finishTurn(onEvent);
                return { reply, rounds: round };
            }
            const { parts, ask } = await this._runCalls(calls, round, onEvent);
            for (const r of refused) parts.push({ functionResponse: { name: r.name, response: { error: `refused: ${r.reason}` } } });
            // Build mode: after a round that edited the net, the engine's
            // behaviour checks go back with the tool results (sim's builder
            // feeds its checks back the same way).
            if (this.effectiveMode === 'build' && this.calls.some((e) => e.round === round && e.ok && editsNet(e))) {
                try {
                    const report = await this.sandbox.execute('analysis.behaviour');
                    this.lastChecks = report;
                    onEvent({ type: 'checks', report });
                    parts.push({ text: checksText(report) });
                } catch { /* the checks are advice; never stop the loop */ }
            }
            if (ask) {
                // the loop ends on the question; answer() posts the tool results with the person's choice in its place
                this._ask = { index: ask.index, parts, entry: ask.entry, card: ask.entry.asked };
                onEvent({ type: 'ask', card: ask.entry.asked });
                return { reply, rounds: round, asked: ask.entry.asked };
            }
            this.messages.push({ role: 'user', parts });
        }
        this._finishTurn(onEvent);
        return { reply, rounds: this.maxRounds, stopped: `stopped after ${this.maxRounds} model calls; ask to continue` };
    }

    /** Run one reply's tool calls in order; returns the function responses (a null where the question card waits) and the card's call. */
    async _runCalls(calls, round, onEvent) {
        const parts = [];
        let ask = null;
        for (const c of calls) {
            if (ask && c.name !== 'ask_user') {
                parts.push({ functionResponse: { name: c.name, response: { error: 'not run: the person has a question to answer first; call it again after their answer if it is still needed' } } });
                continue;
            }
            const entry = await this.runCall(c, round, { onEvent });
            onEvent({ type: 'call', entry });
            if (entry.ok && entry.kind === 'goal') onEvent({ type: 'goal', entry });
            if (entry.ok && entry.kind === 'command' && entry.shown) onEvent({ type: 'command', entry });
            if (entry.ok && entry.kind === 'view') onEvent({ type: 'open_view', view: entry.view });
            if (entry.ok && entry.asked) {
                ask = { index: parts.length, entry };
                parts.push(null);
                continue;
            }
            parts.push({ functionResponse: this._responseFor(entry) });
        }
        return { parts, ask };
    }

    /**
     * The person's answer to the question card ask_user put up; the loop goes on from it. `choice` is one of the card's
     * options (a string), {other: text} for what they typed, or {decide: true} for "you decide": the model's default
     * option (or the first) is taken and kept as an assumption on the next result. Resumes with a fresh budget of
     * maxRounds model calls.
     * @param {string|{other: string}|{decide: true}} choice
     * @param {(e: Object) => void} [onEvent]
     * @returns {Promise<{reply: string, rounds: number, stopped?: string, asked?: Object}>} as send's
     */
    async answer(choice, onEvent = () => {}) {
        const a = this._ask;
        if (!a) throw new Error('no question is waiting');
        const card = a.card;
        let response;
        if (choice && typeof choice === 'object' && choice.decide) {
            const take = card.default_option || card.options[0];
            response = { answer: take, decided: 'model' };
            this._decided.push({ key: 'decided', how: 'decided', question: card.question, value: take, text: `You left “${card.question}” to me; I took ${take}.` });
        } else if (choice && typeof choice === 'object' && typeof choice.other === 'string') {
            response = { answer: choice.other, other: true };
        } else if (typeof choice === 'string') {
            response = card.options.includes(choice) ? { answer: choice } : { answer: choice, other: true };
        } else {
            throw new TypeError('answer is one of the options, {other: text} or {decide: true}');
        }
        this._ask = null;
        a.entry.answer = response;
        a.parts[a.index] = { functionResponse: { name: a.entry.name, response } };
        this.messages.push({ role: 'user', parts: a.parts });
        onEvent({ type: 'choice', answer: response });
        return this._loop(onEvent, false);
    }

    /**
     * "Not what I meant": the last message again under another intent. The conversation and the sandbox go back to
     * where that message found them (its replies, tool calls and edits are dropped), the intent is forced, and the
     * message is sent. Costs the model calls any message does.
     * @param {'build'|'analyse'|'explain'|'design'} mode
     */
    async resend(mode, onEvent = () => {}) {
        const t = this._turn;
        if (!t.text) throw new Error('there is no message to resend');
        this.force(mode);
        this._ask = null;
        this._decided = [];
        this.messages.length = t.messagesLen;
        this.calls.length = t.callsLen;
        this.composedLog.length = t.composedLen;
        this.sandbox = new Registry(createHeadlessHost(structuredClone(t.model)), undefined, { store: this.live._store });
        this.pending = t.pending;
        this.proposal = t.proposal;
        this.step = t.step;
        return this.send(t.text, onEvent);
    }

    /**
     * The refinement gate (sim's defect weight) for the live net and the
     * sandbox: dead transitions, unmarked siphons, unreachable goals, and,
     * for the sandbox, the live net's conservation laws it no longer keeps.
     * @returns {Promise<{before: Object, after: Object, worse: boolean}>}
     */
    async weights() {
        const inv = await this.live.execute('analysis.invariants', { kind: 'p' }).catch(() => null);
        const laws = (inv?.p_invariants || []).map((p) => p.coefficients);
        const before = await this.live.execute('analysis.defects', {});
        const after = await this.sandbox.execute('analysis.defects', { baseline_laws: laws });
        return { before, after, worse: after.weight > before.weight };
    }

    /** What applying would change: nodes, arcs, rates and the marking. */
    diff() {
        return diffNets(this.live.host.getModel(), this.model());
    }

    /** Commit the sandbox's net to the editor as one undo step. */
    apply() {
        if (!this.pending) return false;
        this.live.host.commit(structuredClone(this.model()), 'assistant edits');
        this._reseed();
        return true;
    }

    discard() {
        this._reseed();
    }

    /**
     * A described net (Describe, folded into the Ask pane's build flow) as the pending change: the finished, already
     * gated net goes into the sandbox in place of whatever it held, exactly as if the model had built it with edits,
     * so diff / apply / discard are the ones every edit has. `proposal` keeps the draft's notes and assumptions for
     * the pending-diff card until apply or discard clears it.
     * @param {Object} net  an editor net (draftToNet's output, after the gate)
     * @param {{notes?: Array, assumptions?: Array}} [o]
     * @returns {ReturnType<typeof diffNets>} what applying would change
     */
    proposeNet(net, { notes = [], assumptions = [] } = {}) {
        if (!net || typeof net !== 'object' || !net.places || !net.transitions) throw new TypeError('proposeNet takes an editor net (places and transitions)');
        this.sandbox = new Registry(createHeadlessHost(structuredClone(net)), undefined, { store: this.live._store });
        this.pending = true;
        this.proposal = { notes: [...notes], assumptions: [...assumptions] };
        return this.diff();
    }

    /** Re-run one logged call by hand (the Tools panel's Rerun). */
    rerun(entry) {
        // An override the person's words once earned (entry.override) is theirs still.
        const again = entry.override ? { override: entry.override, userText: entry.overrideText } : {};
        return this.runCall({ name: entry.name, args: entry.args }, entry.round, again);
    }

    /**
     * The footer's Rerun and Edit settings: run a result's recorded calls again on a fresh sandbox over the net as it is
     * now, and return a new result beside the old one. Unguarded: the person chose these settings, so an engine the net's
     * recommendation advises against runs, with the same warning chip the guard would have put on an override. Nothing is
     * re-resolved, so a seeded engine reproduces the artifacts byte for byte.
     * @param {Object} result  a goal result (entry.result) or a command result (entry.shown)
     * @param {Object} [o]
     * @param {Array<Object>|Object} [o.args]  per-call overrides merged over the recorded arguments (undefined removes a key):
     *   an array aligned with record.calls, or an object keyed by call index or command id
     * @returns {Promise<Object>} a result of the same shape; same goal and caveat; record.assumed says the settings were edited by the person
     */
    async rerunResult(result, { args } = {}) {
        const old = result?.record;
        if (!old || !Array.isArray(old.calls) || !old.calls.length) throw new TypeError('rerunResult takes a result with a record');
        const patches = overridesFor(old.calls, args);
        const calls = old.calls.map((c, i) => ({ command: c.command, args: patchArgs(c.args, patches[i]) }));
        const edits = old.calls.map((c, i) => editText(c.command, c.args, calls[i].args)).filter(Boolean);
        const sandbox = new Registry(createHeadlessHost(structuredClone(this.live.host.getModel())), undefined, { store: this.live._store });
        const steps = await rerun(sandbox, { calls });
        const failed = steps.find((s) => s.error);
        if (failed) throw Object.assign(new Error(`${failed.command}: ${failed.error}`), { step: failed.index });

        const chips = [];
        const guard = new EngineGuard(sandbox);
        for (const c of calls) {
            const need = c.command !== 'macro.play' && engineNeeded(c.command, c.args);
            if (!need) continue;
            const v = checkEngine(c.command, await guard.recommendation(), { override: need.needs, args: c.args });
            if (v.verdict === 'warn' && v.message && !chips.includes(v.message)) chips.push(v.message);
        }
        const used = calls.map((c) => engineOf(c.command, c.args)).find(Boolean);
        let engine = old.engine;
        if (used) engine = { name: used, reason: old.engine?.reason || '', ...(chips.length || old.engine?.overridden ? { overridden: true } : {}), ...(chips[0] ? { warning: chips[0] } : {}) };
        const net = { ...(this.netCid ? { cid: this.netCid } : {}), revision: modelKey(sandbox.host.getModel()) };
        const assumed = (result.assumed || old.assumed || []).map((a) => ({ ...a }));
        const notes = [];
        if (edits.length) notes.push({ key: 'settings', how: 'edited', text: `Settings edited by you: ${edits.join('; ')}` });
        if (old.net?.revision !== undefined && old.net.revision !== net.revision) notes.push({ key: 'net', how: 'edited', text: 'The net has changed since this result was made: these are the same calls on the net as it is now' });
        const record = provenance({
            goal: old.goal, calls, engine,
            assumed: [...old.assumed, ...notes.map((n) => ({ key: n.key, text: n.text }))],
            caveat: old.caveat, net, versions: this.versions || undefined, note: null,
            warnings: [...chips, ...(old.warnings || []).filter((w) => !chips.includes(w))],
        });
        const ids = [...new Set(steps.flatMap((s) => s.artifacts))];
        return {
            id: resultId(), title: result.title, source: result.source || 'ask', goal: result.goal || old.goal,
            record, artifacts: this._artifacts(ids),
            steps: steps.map((s) => ({ index: s.index, command: s.command, args: s.args, result: s.result, artifacts: s.artifacts })),
            inputs: result.inputs || {}, warnings: record.warnings.slice(), assumed: [...assumed, ...notes],
            caveat: result.caveat ?? old.caveat, answerShape: result.answerShape || '', followUps: [...(result.followUps || [])],
            registry: sandbox, onProposal: false, answer: null, stale: false, rerunOf: result.id ?? null, edited: edits.length > 0,
            ...(result.composed ? { composed: true } : {}),
        };
    }
}

/**
 * A structural diff of two editor nets.
 * @returns {{added: string[], removed: string[], changed: string[], arcsAdded: string[], arcsRemoved: string[], empty: boolean}}
 */
export function diffNets(a, b) {
    const nodes = (m) => new Map([...Object.entries(m.places || {}).map(([k, v]) => [k, ['place', v]]), ...Object.entries(m.transitions || {}).map(([k, v]) => [k, ['transition', v]])]);
    const na = nodes(a), nb = nodes(b);
    const added = [], removed = [], changed = [];
    for (const [id, [kind]] of nb) if (!na.has(id)) added.push(`${kind} ${id}`);
    for (const [id, [kind]] of na) if (!nb.has(id)) removed.push(`${kind} ${id}`);
    const fields = ['label', 'initial', 'capacity', 'rate', 'description'];
    for (const [id, [kind, vb]] of nb) {
        if (!na.has(id)) continue;
        const va = na.get(id)[1];
        const diffs = fields.filter((f) => JSON.stringify(va[f] ?? null) !== JSON.stringify(vb[f] ?? null))
            .map((f) => `${f} ${JSON.stringify(va[f] ?? null)} → ${JSON.stringify(vb[f] ?? null)}`);
        if (diffs.length) changed.push(`${kind} ${id}: ${diffs.join(', ')}`);
    }
    const arc = (x) => `${x.source} → ${x.target}${x.inhibitTransition ? ' (inhibit)' : ''} ×${JSON.stringify(x.weight)}`;
    const aa = new Set((a.arcs || []).map(arc)), ab = new Set((b.arcs || []).map(arc));
    const arcsAdded = [...ab].filter((x) => !aa.has(x)), arcsRemoved = [...aa].filter((x) => !ab.has(x));
    const meta = ['name', 'description'].filter((k) => (a[k] ?? null) !== (b[k] ?? null)).map((k) => `net ${k}`);
    changed.push(...meta);
    return { added, removed, changed, arcsAdded, arcsRemoved, empty: !added.length && !removed.length && !changed.length && !arcsAdded.length && !arcsRemoved.length };
}
