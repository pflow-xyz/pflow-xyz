// petri-ask-pane.js — the Ask pane's decisions, with no DOM (docs/design/agent-first-analysis.md sections 3, 4, 6, 9).
//
// petri-chat-ui.js is the pane and petri-results-pane.js is its list of results; both are thin: they draw what this
// module decides and call what it computes. Everything here is plain data in and out, so deno tests it directly, with
// real ChatSession results where the shape matters.
//
//   sendPlan                  what a message does: the agent, the Describe draft, the router (no model), or nothing
//   retryingPoster            the one retry of a transient failure (section 9), in front of the turn call
//   routeCards, goalCard      the no-model path: a goal as a card with the inputs the words named (visible assumptions)
//                             and a small form for the ones still missing
//   cardModel                 a result as the card shows it: who said what, the chips, the assumptions, the follow-ups
//   changeControl, patchForChange, withChange
//                             "Assumed ... Change": the control for an assumption and the arguments patch that reruns
//                             the result with the person's value (ChatSession.rerunResult)
//   editSettings, patchFromEdit
//                             "Edit settings": the calls of a record as forms prefilled from its arguments, and what
//                             the person changed in them, as a rerunResult patch
//   sameEvidence              Rerun's "reproduced" check: the two runs' artifacts have the same digests
//   isStaleResult             "net changed since": a result's revision against the net's
//   proposalFromDraft, setRate
//                             Describe's notes, assumptions and rates as the pending card shows them (and edits them)
//   gateOf                    the problems gate in front of an Apply, from the view's hook or petri-problems.js
//   toolsInfo                 the Tools section's count and note for either toolset
//   notThatText               the message "Not that" sends again
//
// Nothing here asks a model for anything.
import { assumptionLine, followUpsFor, isTransient, routeWords } from './petri-ask.js';
import { inferPlace, missingInputs } from './petri-goals.js';
import { formModel, goalFormModel } from './petri-schema-form.js';
import { artifactDigest } from './petri-viewspec.js';

// ---- what a message does ----

/** A net with nothing in it: no places and no transitions.
 * @param {any} model
 */
export function emptyCanvas(model) {
    return !Object.keys(model?.places || {}).length && !Object.keys(model?.transitions || {}).length;
}

/**
 * What sending a message does (section 9 and 4.6):
 *   'nothing'  a blank message
 *   'route'    the model cannot be asked (askState says router): the keyword router and the cards
 *   'draft'    Describe, folded in: the canvas is empty, the intent is already build (a /?route=build link, the empty
 *              canvas's button, or "Build instead" on the first message) and this is the conversation's first message:
 *              the words go to /api/llm/draft and the gated net comes back as the pending change
 *   'agent'    the tool loop (ChatSession.send)
 * Where the intent is not known before the message (the hero's Ask on an empty canvas: the server labels it in the
 * same call that answers it), the agent builds in the sandbox exactly as the Assistant did, and "Build instead" takes the
 * Describe path for a first message.
 * @param {{ask: any, intent: string|null, canvasEmpty: boolean, started: boolean, text: string}} o
 * @returns {{do: 'nothing'|'route'|'draft'|'agent', text: string}}
 */
export function sendPlan({ ask, intent, canvasEmpty, started, text }) {
    const t = String(text ?? '').trim();
    if (!t) return { do: 'nothing', text: t };
    if (!ask?.canAsk) return { do: 'route', text: t };
    if (intent === 'build' && canvasEmpty && !started) return { do: 'draft', text: t };
    return { do: 'agent', text: t };
}

/**
 * A turn poster that tries a transient failure once more (section 9: "one retry on the transient errors"): a 5xx, a
 * timeout, no connection. A 429 is not retried here: ChatSession waits a short one out and the daily one is the
 * quota's. The failure that survives the retry is thrown as it was.
 * @param {(body: any) => Promise<any>} post
 * @param {{sleep?: (ms: number) => Promise<void>, onRetry?: (error: any) => void, delayMs?: number}} [o]
 */
export function retryingPoster(post, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry = () => {}, delayMs = 1200 } = {}) {
    return async (body) => {
        try {
            return await post(body);
        } catch (e) {
            if (e?.status === 429 || !isTransient(e)) throw e;
            onRetry(e);
            await sleep(delayMs);
            return post(body);
        }
    };
}

/** The error a failed /api/llm/draft call stands for, in the shape askState reads.
 * @param {any} got
 * @returns {Error & {status?: number, retryAfter?: number, reset?: string}}
 */
export function draftError(got) {
    return Object.assign(new Error(got?.error || 'the draft failed'), {
        ...(got?.status !== undefined ? { status: got.status } : {}),
        ...(got?.retryAfter !== undefined ? { retryAfter: got.retryAfter } : {}),
        ...(got?.reset !== undefined ? { reset: got.reset } : {}),
    });
}

// ---- the no-model path: goals as cards ----

/**
 * The form a card shows: the inputs still missing, and the ones the words already named with their value filled in (the
 * Change control of an inferred assumption is the same select). The rest take their defaults.
 * @param {any} card
 * @returns {{fields: Array<any>, noForm: string|null}}
 */
export function cardForm(card) {
    const full = card.form;
    if (!full || full.noForm) return full || { fields: [], noForm: 'no form' };
    const needs = new Set((card.missing || []).map((i) => i.name));
    const fields = full.fields
        .filter((f) => needs.has(f.name) || card.inputs?.[f.name] !== undefined)
        .map((f) => (card.inputs?.[f.name] !== undefined ? { ...f, default: card.inputs[f.name] } : f));
    return { fields, noForm: null };
}

/**
 * The cards for the person's words (petri-ask.js routeWords, up to three), each with the form of its missing inputs.
 * @returns {Array<any>} {goal, inputs, assumed, missing, ready, form: {fields, noForm}}
 */
export function routeCards(catalog, model, text, o = {}) {
    return routeWords(catalog, model, text, o).map((card) => ({ ...card, form: cardForm(card) }));
}

/** One goal as a card (the empty state's grid, a follow-up): the places the words name are proposed as assumptions.
 * @param {any} goal
 * @param {any} model
 * @param {string} [text]
 * @returns {any}
 */
export function goalCard(goal, model, text = '') {
    const inputs = {};
    const assumed = [];
    for (const i of goal.inputs || []) {
        if (i.kind !== 'place') continue;
        const p = text ? inferPlace(model, text) : '';
        if (!p) continue;
        const label = i.label || i.name;
        inputs[i.name] = p;
        assumed.push({ key: i.name, how: 'inferred', label, value: p, text: `${label} = ${p} (taken from your words)`, change: { input: i.name, kind: 'place', options: Object.keys(model?.places || {}) } });
    }
    const missing = missingInputs(goal, inputs);
    const card = { goal, inputs, assumed, missing, ready: missing.length === 0, form: goalFormModel(goal) };
    return { ...card, form: cardForm(card) };
}

/** The goals the empty state offers as cards: every one that can run here, in the catalogue's order.
 * @param {any} catalog
 * @returns {Array<any>}
 */
export function availableGoals(catalog) {
    return (catalog?.goals || []).filter((g) => g.available !== false);
}

// ---- a result as the card shows it ----

const STRAY_CHIP = 'a number in this reply is not in the results';

/**
 * The control that changes an assumption, or null when it is not the person's to change here (the assistant's pick, a
 * plan's own horizon, an edit already made): a select for a place or a transition, a number box for a number.
 * @param {any} a  an assumption: {how, value, change: {input, kind, options, default}}
 * @returns {{kind: 'select'|'number'|'text', input: string, options?: string[], value: any, optional?: boolean}|null}
 */
export function changeControl(a) {
    const c = a?.change;
    if (!c || typeof c !== 'object' || typeof c.input !== 'string' || !c.input) return null;
    if (c.kind === 'marking' || c.kind === 'json') return null;
    const value = a.value ?? c.default ?? '';
    if (Array.isArray(c.options) && c.options.length) return { kind: 'select', input: c.input, options: c.options, value, optional: a.how === 'unnamed' };
    if (c.kind === 'number') return { kind: 'number', input: c.input, value };
    return { kind: 'text', input: c.input, value };
}

/**
 * Everything a result card shows, as data. The assumptions are the result's own, each tagged by who made them (the
 * model's "you decide" is the assistant's; the rest is code's), with the control that changes them.
 * @param {any} result  a result (petri-results-pane.js documents the shape)
 * @param {{catalog?: any, stale?: boolean, latest?: boolean}} [o]  latest: this result is the last turn's (Not that applies)
 */
export function cardModel(result, { catalog = null, stale = false, latest = false } = {}) {
    const goal = result?.goal || result?.record?.goal || null;
    const engine = result?.record?.engine || null;
    const chips = [];
    if (engine?.overridden) chips.push({ kind: 'override', text: 'engine override', title: engine.warning || engine.reason || '' });
    for (const w of result?.warnings || []) chips.push({ kind: 'warn', text: String(w) });
    if (result?.answer?.stray?.length) chips.push({ kind: 'stray', text: STRAY_CHIP, title: `Not in the results: ${result.answer.stray.join(', ')}` });
    const chosenByModel = result?.pickedBy === 'assistant';
    return {
        id: result?.id || '',
        title: result?.title || goal?.question || 'Result',
        goal,
        // "I answered: ..." only for a goal the model picked; a card the person ran is titled by its question
        answered: chosenByModel && goal ? `I answered: “${goal.question}”` : '',
        notThat: chosenByModel && !!goal && latest,
        chips,
        answer: result?.answer?.text ? { by: 'assistant', text: String(result.answer.text) } : null,
        engine: engine ? { name: engine.name, reason: engine.reason || '', recommendedOnly: !!engine.recommendedOnly } : null,
        assumed: (result?.assumed || []).map((a) => ({
            key: a.key, by: a.how === 'decided' ? 'assistant' : 'engine', how: a.how, text: assumptionLine(a), change: changeControl(a), source: a,
        })),
        caveat: result?.caveat || result?.record?.caveat || '',
        answerShape: result?.answerShape || '',
        followUps: followUpsFor(goal?.id, catalog).filter((g) => !result?.followUps || result.followUps.includes(g.id)).slice(0, 3).map((g) => ({ id: g.id, question: g.question })),
        stale: !!stale,
    };
}

/** The message "Not that" sends in place of the last one: the same words, and which answer to leave. */
export function notThatText(text, question) {
    return `${String(text ?? '').trim()}\n\n(Not “${question}”: choose a different goal for this.)`;
}

/**
 * A result is stale when the net it ran on is no longer the net: its revision (petri-engine-guard.js modelKey) differs
 * from the net's now. A result made on a pending change (a described net, edits not applied) is judged against the
 * sandbox, which is the net it ran on; a revision that is not a key (the palette's results carry none) says nothing.
 * @param {any} result
 * @param {{liveKey?: string, sandboxKey?: string}} keys  modelKey of the live net and of the session's sandbox
 */
export function isStaleResult(result, { liveKey, sandboxKey } = {}) {
    const rev = result?.record?.net?.revision;
    if (typeof rev !== 'string') return false;
    const now = result?.onPending ? sandboxKey : liveKey;
    return typeof now === 'string' && rev !== now;
}

// ---- Change ----

const REF = /^\$input\.(\w+)(?:\*(-?\d+(?:\.\d+)?))?$/;

/**
 * The rerunResult `args` (aligned with record.calls) that give an input another value, by the plan's own references
 * ("$input.observable", "$input.max_rate*0.25"). The calls are matched to the plan's steps in order by command, so a
 * rerun's result (whose steps no longer carry the plan's indices) works too. Null when no call that ran takes the input at
 * the top level (best_setting's scenarios hold it in a nested list): the caller runs the goal again instead.
 * @param {any} result
 * @param {any} goal  the catalogue's goal
 * @param {{input: string, kind?: string}} change  an assumption's change
 * @param {any} value  a place or transition id, or a number (a numeric string is read)
 * @returns {Array<Object|undefined>|null}
 */
export function patchForChange(result, goal, change, value) {
    const calls = result?.record?.calls || [];
    const plan = goal?.plan || [];
    if (!change?.input || !calls.length || !plan.length) return null;
    const v = change.kind === 'number' ? (typeof value === 'string' && value.trim() !== '' ? Number(value) : value) : value;
    if (change.kind === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`${change.input}: ${JSON.stringify(value)} is not a number`);
    const patches = calls.map(() => undefined);
    let cursor = 0;
    let hit = false;
    calls.forEach((call, k) => {
        const at = plan.findIndex((s, i) => i >= cursor && s.command === call.command);
        if (at < 0) return;
        cursor = at + 1;
        for (const [arg, ref] of Object.entries(plan[at].args || {})) {
            const m = typeof ref === 'string' ? REF.exec(ref) : null;
            if (!m || m[1] !== change.input) continue;
            patches[k] = { ...(patches[k] || {}), [arg]: m[2] !== undefined && typeof v === 'number' ? v * Number(m[2]) : v };
            hit = true;
        }
    });
    return hit ? patches : null;
}

/**
 * A rerun's result with the person's value in its own assumption row and inputs (rerunResult keeps the old row and adds a
 * note that settings were edited; the record still says so). The "Settings edited by you" note is dropped from the card's
 * row because the row it explains now says it itself.
 * @param {any} result  rerunResult's output
 * @param {any} assumption  the row that was changed: {key, how, label, change}
 * @param {any} value
 * @returns {any}
 */
export function withChange(result, assumption, value) {
    const input = assumption?.change?.input;
    const label = assumption?.label || assumption?.key || input;
    const shown = typeof value === 'string' ? value : JSON.stringify(value);
    result.inputs = { ...(result.inputs || {}), ...(input ? { [input]: value } : {}) };
    result.assumed = (result.assumed || [])
        .filter((a) => !(a.how === 'edited' && a.key === 'settings'))
        .map((a) => (a.key === assumption?.key && a.how === assumption?.how
            ? { ...a, how: 'edited', value, label, text: `${label} = ${shown} (changed by you)` }
            : a));
    return result;
}

// ---- Edit settings ----

/**
 * One form per call of a record that has arguments, prefilled with the arguments it ran with. A command the registry does
 * not describe, or whose arguments no form can lay out, says why instead.
 * @param {any} record
 * @param {(id: string) => any} describe  Registry.describe
 * @returns {Array<{index: number, command: string, label: string, model: {fields: Array<any>, noForm: string|null}, recorded: any}>}
 */
export function editSettings(record, describe) {
    const out = [];
    (record?.calls || []).forEach((c, index) => {
        let spec = null;
        try { spec = describe(c.command); } catch { /* not a command this page knows */ }
        const recorded = c.args && typeof c.args === 'object' ? c.args : {};
        const model = spec ? formModel(spec.args, recorded) : { fields: [], noForm: 'this command is not known here' };
        if (model.fields.length || model.noForm) out.push({ index, command: c.command, label: spec?.label || c.command, model, recorded });
    });
    return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What the person changed in a form, as a patch over the call's recorded arguments: the keys whose value differs, and
 * undefined (remove the key) for one they blanked. Null when nothing changed.
 * @param {any} recorded  the call's arguments as it ran
 * @param {any} model
 * @param {any} values  readValues' args
 */
export function patchFromEdit(recorded, model, values) {
    const patch = {};
    for (const f of model.fields || []) {
        const had = Object.prototype.hasOwnProperty.call(recorded || {}, f.name);
        const has = Object.prototype.hasOwnProperty.call(values || {}, f.name);
        if (has && !same(recorded?.[f.name], values[f.name])) patch[f.name] = values[f.name];
        else if (!has && had) patch[f.name] = undefined;
    }
    return Object.keys(patch).length ? patch : null;
}

// ---- Rerun ----

/** The digests of a result's artifacts, in order.
 * @param {any} result
 */
export async function digestsOf(result) {
    const out = [];
    for (const a of result?.artifacts || []) out.push(await artifactDigest(a));
    return out;
}

/** Whether two results have the same evidence: the same artifacts by digest (a seeded engine is byte-exact; the ODE to the digest's rounding).
 * @param {any} a
 * @param {any} b
 */
export async function sameEvidence(a, b) {
    const [x, y] = [await digestsOf(a), await digestsOf(b)];
    return x.length === y.length && x.every((d, i) => d === y[i]);
}

// ---- Describe's notes, assumptions and rates ----

/**
 * A gated draft's notes for the pending card: the summary and what each part stands for (notes), and the assumptions
 * with the rates (each rate a line the person can edit). The draft is the model's: the card labels all of it "Gemini's
 * draft notes".
 * @param {any} draft  {summary, places, transitions, assumptions}
 * @returns {{notes: Array<any>, assumptions: Array<any>}} notes: {kind: 'summary'|'place'|'transition', id?, label?, text};
 *   assumptions: {kind: 'text', text} | {kind: 'rate', transition, label, value}
 */
export function proposalFromDraft(draft) {
    const legend = (items, kind) => (items || []).map((n) => ({ kind, id: n.id, label: n.label, text: n.description }));
    return {
        notes: [...(draft?.summary ? [{ kind: 'summary', text: draft.summary }] : []), ...legend(draft?.places, 'place'), ...legend(draft?.transitions, 'transition')],
        assumptions: [
            ...(draft?.assumptions || []).map((text) => ({ kind: 'text', text })),
            ...(draft?.transitions || []).filter((t) => typeof t.rate === 'number').map((t) => ({ kind: 'rate', transition: t.id, label: t.label || t.id, value: t.rate })),
        ],
    };
}

/** A rate line edited in place: the new proposal, or an error for a value that is not a rate (a number, 0 or more).
 * @param {any} proposal
 * @param {string} transition
 * @param {any} text
 * @returns {any}
 */
export function setRate(proposal, transition, text) {
    const t = String(text ?? '').trim();
    const n = t === '' ? NaN : Number(t);
    if (!Number.isFinite(n) || n < 0) return { error: `${transition}: a rate is a number, 0 or more (got “${t}”)` };
    return {
        value: n,
        proposal: { ...proposal, assumptions: (proposal.assumptions || []).map((a) => (a.kind === 'rate' && a.transition === transition ? { ...a, value: n } : a)) },
    };
}

// ---- the problems gate in front of an Apply ----

/**
 * What the problems check says about a net before it is applied: {summary, warn, message}. The view's own gate
 * (`_problemsGate(model)`, when it has one) is asked first; it may answer a summary (petri-problems.js), a gate
 * ({warn, message}) or both ({summary, gate}). Otherwise petri-problems.js checkModel runs on the sandbox. The
 * person still decides: nothing here refuses.
 * @param {any} view
 * @param {any} chat  the session (model(), sandbox)
 * @param {any} [P]  petri-problems.js (injected by tests)
 * @returns {Promise<{summary: any, warn: boolean, message: string}>}
 */
export async function gateOf(view, chat, P) {
    const mod = P || await import('./petri-problems.js');
    let got = null;
    if (typeof view?._problemsGate === 'function') {
        try { got = await view._problemsGate(chat.model()); } catch { got = null; }
    }
    let summary = got && Array.isArray(got.items) ? got : got?.summary || null;
    let gate = got && typeof got.warn === 'boolean' ? got : got?.gate || null;
    if (!summary && !gate) summary = await mod.checkModel(null, { registry: chat.sandbox });
    if (!gate) gate = mod.applyGate(summary);
    return { summary, warn: !!gate.warn, message: gate.message || '' };
}

// ---- the Tools section ----

/**
 * The Tools section's line, note and sections (section 4.2: the model's surface is the goal toolset, the rest is under Tools).
 * @param {any} o
 * @param {'goals'|'all'} o.toolset
 * @param {Array<any>} o.tools  what the assistant can use now (ChatSession.tools)
 * @param {any} o.manifest  the session's manifest
 * @param {number} o.runs  tools run in this conversation
 * @param {string} o.state  askState's state
 * @param {string} [o.mode]  the effective mode
 * @param {string} [o.shortcut]  the palette's shortcut as the page writes it ("⌘K")
 */
export function toolsInfo({ toolset, tools, manifest, runs, state, mode, shortcut = 'Ctrl K' }) {
    const n = tools.length;
    const canAsk = state === 'agent';
    const count = canAsk
        ? `${n} available, ${runs ? `${runs} run` : 'none run yet'}`
        : state === 'signed-out' ? `${n} after sign-in` : runs ? `${runs} run` : `${n} when the assistant is available`;
    const left = (manifest?.tools?.length || 0) - n;
    const rest = toolset === 'goals' ? (manifest?.command_index || []).length : 0;
    let note = '';
    if (state === 'signed-out') note = 'Sign in and the assistant can use these on your net.';
    else if (mode === 'explain' && left > 0) note = `Explain mode does not edit, so the ${left} tools that do are left out.`;
    else if (toolset === 'goals') note = `These are the questions and edits the assistant uses directly. The other ${rest} commands it reaches through run_command; you can run all of them yourself under Tools (${shortcut}).`;
    return { count, note, showRuns: canAsk || runs > 0, toolset, rest };
}

/** What the live region says when a result lands: its question and the engine, not the card's contents. */
export function announcement(result) {
    const q = result?.goal?.question || result?.title || 'a result';
    const e = result?.record?.engine;
    return `Result: ${q}.${e?.name ? ` Engine: ${e.name}.` : ''}${result?.warnings?.length ? ` Warning: ${result.warnings[0]}.` : ''}`;
}
