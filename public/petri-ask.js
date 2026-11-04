// petri-ask.js — the Ask's pure half: what the input offers and how it degrades, no DOM and no model.
// (docs/design/agent-first-analysis.md sections 4.1, 4.2, 4.5, 9 and R3; the loop that runs the model's goal tools is
// petri-chat.js, the pane that shows the results is built on both.)
//
//   askState         which of six states the Ask input is in, from /api/llm/status and the last error: the full
//                    agent, or the router and the cards when the model cannot be asked (section 9's table)
//   INTENTS, intentChip, otherIntents, normalizeIntent
//                    one vocabulary for the intent chip: Build, Analyse, Explain. "design" is build; "auto" is not an
//                    intent (it is nobody having forced one)
//   suggestPrompts   questions that change with the net, deterministic, no model: capacities and inhibitors suggest
//                    "How bad can it get?", a game suggests best play ...
//   routeWords       the offline path: the goals the person's words resemble, with the places the words name filled
//                    in as visible assumptions and the inputs still missing. A SUGGESTION source only: a miss costs a
//                    click and it never runs anything
//   followUpsFor     a goal's 2 to 3 next questions (goals.json followUps): no extra model call
//   assumptionLine   an assumption as a sentence ("I took the outcome to watch to be I")
//   answerLabel, taggedLines
//                    every line of a result is tagged 'engine' (a command produced it, or the goal catalogue wrote it
//                    beside the plan) or 'assistant' (model text), the footer's own convention
//   numeralsOutside  R3: the numbers in the model's prose that are in no artifact or result field
//
// A model is never asked for anything here.
import { inferPlace, matchGoals, missingInputs } from './petri-goals.js';
import { goalFormModel } from './petri-schema-form.js';

// ---- the input's state ----

const RESET_DEFAULT = '00:00';

/** "HH:MM" (UTC) of an RFC 3339 time, or the day's turn-over the limiter uses when there is none. */
function resetClock(reset) {
    const d = new Date(reset);
    return Number.isNaN(d.getTime()) ? RESET_DEFAULT : d.toISOString().slice(11, 16);
}

/**
 * What a failed model call means for the Ask: a 401 means the sign-in is gone, a 403 that the account may not ask,
 * a 429 that advises more than the wait ChatSession is willing to spend (the daily limit) that the quota is used up;
 * anything else (a 5xx, a timeout, no connection) is the upstream being down.
 * @param {{status?: number, retryAfter?: number}} [error]
 * @returns {'signed-out'|'not-allowed'|'quota'|'upstream'}
 */
export function errorKind(error) {
    const s = error?.status;
    if (s === 401) return 'signed-out';
    if (s === 403) return 'not-allowed';
    if (s === 429 && (error.retryAfter ?? 0) > 90) return 'quota';
    return 'upstream';
}

/** Whether one retry is worth it (section 9: "one retry on the transient errors"): no answer at all, a timeout, a 5xx, a short 429. */
export function isTransient(error) {
    const s = error?.status;
    return s === undefined || s === 408 || s === 425 || (typeof s === 'number' && s >= 500) || (s === 429 && (error.retryAfter ?? 0) <= 90);
}

const WORDS = {
    agent: '',
    'signed-out': 'Sign in to ask in your own words. The questions below work without.',
    'not-allowed': 'Asking in your own words is not open to this account. The questions below work.',
    off: 'Asking in your own words is not available here. The questions below work.',
};

/**
 * The Ask input's state (section 9). The agent needs a model that answers: signed in, allowed, quota left, upstream up.
 * Everything else is the router and the cards, which need none (`router`), and only the signed-out state invites a
 * sign-in (`signIn`): not being on the allow list is not a thing to nag about.
 * @param {Object} [status]  /api/llm/status: {enabled, chat, signed_in, allowed, remaining_today, reset, toolsets}
 * @param {Object} [o]
 * @param {Error & {status?: number, retryAfter?: number}} [o.error]  the last failed model call, if any
 * @param {number} [o.quotaLeft]  calls left today when the page knows better than the status it read (a turn's `quota` event)
 * @param {boolean} [o.retried]  the transient failure was already retried once
 * @returns {{state: 'agent'|'signed-out'|'not-allowed'|'quota'|'off'|'upstream', words: string, canAsk: boolean, router: boolean, signIn: boolean,
 *   toolset: 'goals'|'all', reset?: string, retry?: boolean, error?: string}}
 *   toolset: which tool set to ask for (status.toolsets lists the server's; an older server lists none, so 'all')
 */
export function askState(status, { error, quotaLeft, retried = false } = {}) {
    const toolset = Array.isArray(status?.toolsets) && status.toolsets.includes('goals') ? 'goals' : 'all';
    const make = (state, extra = {}) => ({
        state, words: WORDS[state] ?? '', canAsk: state === 'agent', router: state !== 'agent', signIn: state === 'signed-out', toolset, ...extra,
    });
    if (!status || !status.enabled || !status.chat) return make('off');
    if (!status.signed_in) return make('signed-out');
    if (status.allowed === false) return make('not-allowed');
    const quota = (reset) => {
        const at = resetClock(reset);
        return make('quota', { words: `Model calls are used up for today (resets ${at} UTC)`, reset: at });
    };
    if (error) {
        const kind = errorKind(error);
        if (kind === 'quota') return quota(error.reset ?? status.reset);
        if (kind === 'upstream') {
            const retry = !retried && isTransient(error);
            return make('upstream', {
                words: retry
                    ? 'The assistant did not answer. Trying once more.'
                    : 'The assistant did not answer. Your message is kept; try again, or use the questions below.',
                retry, error: String(error.message || error),
            });
        }
        return make(kind);
    }
    if (quotaLeft === 0 || (quotaLeft === undefined && status.remaining_today === 0)) return quota(status.reset);
    return make('agent');
}

// ---- the intent chip ----

/** One vocabulary everywhere (design 16.1): the server's three labels, in the order the chip's menu lists them. */
export const INTENTS = [
    { id: 'build', label: 'Build', chip: 'Building' },
    { id: 'analyse', label: 'Analyse', chip: 'Analysing' },
    { id: 'explain', label: 'Explain', chip: 'Explaining' },
];

/** 'build' | 'analyse' | 'explain' for a mode or an old word ('design'), else null ('auto' is no intent). */
export function normalizeIntent(mode) {
    const m = mode === 'design' ? 'build' : mode;
    return INTENTS.some((i) => i.id === m) ? m : null;
}

/** The chip for an intent: {id, label, chip}; null when there is none to show (auto, not yet labelled). */
export function intentChip(mode) {
    const id = normalizeIntent(mode);
    return INTENTS.find((i) => i.id === id) || null;
}

/** The chip menu's other entries ("Build instead", "Explain instead"): every intent but this one. */
export function otherIntents(mode) {
    const id = normalizeIntent(mode);
    return INTENTS.filter((i) => i.id !== id).map((i) => ({ ...i, instead: `${i.label} instead` }));
}

// ---- reading a net for what to ask ----

const capped = (p) => {
    const c = p?.capacity;
    return (Array.isArray(c) ? c : [c]).some((x) => typeof x === 'number' && Number.isFinite(x) && x > 0);
};

/**
 * The constraints that only exist at a firing instant, read off the net with the rule sim.recommend applies
 * (a capacity, an inhibitor arc, a read arc) and none of its token counts. A conservative stand-in for when no
 * registry is at hand: suggestPrompts uses sim.recommend's own `gating` whenever it has it.
 * @param {{places?: Object, transitions?: Object, arcs?: Array}} model
 * @returns {string[]} e.g. ["capacity on queue", "inhibitor arc(s) …", "read arc(s) …"]
 */
export function gatingHints(model) {
    const places = model?.places || {};
    const out = [];
    const cap = Object.keys(places).filter((id) => capped(places[id]));
    const flagged = (model?.arcs || []).filter((a) => a.inhibitTransition || a.inhibit);
    const inhibitors = flagged.filter((a) => places[a.source]);
    const reads = flagged.filter((a) => !places[a.source]);
    if (inhibitors.length) out.push(`inhibitor arc(s) ${inhibitors.map((a) => `${a.source} → ${a.target}`).join(', ')}`);
    if (reads.length) out.push(`read arc(s) ${reads.map((a) => `${a.source} → ${a.target}`).join(', ')}`);
    if (cap.length) out.push(`capacity on ${cap.join(', ')}`);
    return out;
}

/** Places tokens end up in and never leave: they receive an arc and no transition consumes from them (an inhibitor arc consumes nothing). */
export function sinksOf(model) {
    const places = Object.keys(model?.places || {});
    const arcs = (model?.arcs || []).filter((a) => !(a.inhibitTransition || a.inhibit));
    const consumed = new Set(arcs.filter((a) => model.places?.[a.source]).map((a) => a.source));
    const fed = new Set(arcs.filter((a) => model.places?.[a.target]).map((a) => a.target));
    return places.filter((p) => fed.has(p) && !consumed.has(p));
}

/**
 * Whether the net is a two-sided game of the shape best_play's inputs describe: places named <side>_turn for two or
 * more sides, each with transitions named <side>_… (tic-tac-toe's x_turn and x_play_00, the nim and connect fixtures).
 * There is no availability test for best_play in the catalogue (it is offered for every net); this is the one the
 * suggestions use, and it is deliberately narrow: a net that merely has "turn" in a name is not a game.
 */
export function looksLikeGame(model) {
    const sides = Object.keys(model?.places || {}).filter((id) => /^[A-Za-z0-9]+_turn$/.test(id)).map((id) => id.slice(0, -'_turn'.length));
    const ts = Object.keys(model?.transitions || {});
    return sides.filter((s) => ts.some((t) => t.startsWith(`${s}_`))).length >= 2;
}

// What the input offers, as a person would phrase it. Each routes to its goal through matchGoals (a test holds them to it),
// so clicking one in the router's degraded mode lands on the same goal the agent would choose.
const PROMPT = {
    risk: 'How bad can it get?',
    stuck: 'Can it get stuck?',
    knob: 'Which knob matters?',
    average: 'What happens on average?',
    conserved: 'Is anything conserved?',
    best_play: 'Who wins with best play?',
    unbounded: 'Does anything grow without limit?',
};

/**
 * Prompts for this net, most telling first. The order, and the reason each is offered:
 *   a two-sided game             best_play
 *   a capacity, inhibitor, read  risk, stuck (the spread is wide, and a lock can hold forever)
 *   two or more sinks            knob (there is more than one outcome to move)
 *   every net                    average, conserved; then stuck, unbounded to fill the list
 * @param {{places?: Object, transitions?: Object, arcs?: Array}} model
 * @param {{goals: Array}} catalog  public/goals.json: only available goals are offered
 * @param {Object} [o]
 * @param {number} [o.limit]  default 4
 * @param {{engine?: string, gating?: string[]}} [o.recommendation]  sim.recommend's result for this net, when the caller has it
 *   (suggestPromptsFor asks the registry); else gatingHints reads the arcs and capacities
 * @returns {Array<{goal: string, text: string, why: string}>}
 */
export function suggestPrompts(model, catalog, { limit = 4, recommendation } = {}) {
    const available = new Set((catalog?.goals || []).filter((g) => g.available !== false).map((g) => g.id));
    const gating = Array.isArray(recommendation?.gating) ? recommendation.gating : gatingHints(model);
    const sinks = sinksOf(model);
    const out = [];
    const add = (goal, why) => {
        if (available.has(goal) && !out.some((p) => p.goal === goal)) out.push({ goal, text: PROMPT[goal] || catalog.goals.find((g) => g.id === goal).question, why });
    };
    if (looksLikeGame(model)) add('best_play', 'this is a two-sided game');
    if (gating.length) {
        add('risk', `it has ${gating[0]}, so the outcome can swing`);
        add('stuck', 'constraints like these can hold a net forever');
    }
    if (sinks.length >= 2) add('knob', `it has ${sinks.length} outcomes (${sinks.slice(0, 3).join(', ')}${sinks.length > 3 ? ', …' : ''}) to move`);
    add('average', 'the average course of any net');
    add('conserved', 'what the arcs keep fixed, for any net');
    add('stuck', 'any net can get stuck');
    add('unbounded', 'any net can grow without limit');
    return out.slice(0, Math.max(0, limit));
}

/** suggestPrompts with sim.recommend's own reading of the net (its `gating`), from a registry. A registry that cannot say falls back to gatingHints. */
export async function suggestPromptsFor(registry, catalog, o = {}) {
    let recommendation = null;
    try { recommendation = await registry.execute('sim.recommend'); } catch { /* the pure reading stands in */ }
    return suggestPrompts(registry.host.getModel(), catalog, { ...o, recommendation });
}

// ---- the router (no model) ----

/**
 * The goals the person's words resemble, up to three, as cards the pane can show and a person can run with one click.
 * The keyword matcher is not a gate in front of the model (it missed questions the Assistant answered); it is the
 * offline path and a source of suggestions, where a miss costs a click, never a wrong answer. So nothing runs here, a
 * place a word names is only PROPOSED (as an assumption with a Change), and the inputs it cannot fill are listed.
 * @param {{goals: Array}} catalog
 * @param {{places?: Object, transitions?: Object, arcs?: Array}} model
 * @param {string} text
 * @param {{limit?: number}} [o]
 * @returns {Array<{goal: any, inputs: Record<string, any>, assumed: Array<any>, missing: Array<any>, ready: boolean, form: {fields: Array<any>, noForm: string|null}}>}
 *   inputs: the places the words name; assumed: those, in the shape a result's assumptions have; missing: the declared
 *   inputs still needed; ready: nothing is missing; form: the goal's input form (petri-schema-form.js goalFormModel)
 */
export function routeWords(catalog, model, text, { limit = 3 } = {}) {
    if (!String(text || '').trim()) return [];
    const cards = [];
    for (const goal of matchGoals(catalog, text)) {
        if (goal.available === false) continue;
        const inputs = {};
        const assumed = [];
        for (const i of goal.inputs || []) {
            if (i.kind !== 'place') continue;
            const p = inferPlace(model, text);
            if (!p) continue;
            const label = i.label || i.name;
            inputs[i.name] = p;
            assumed.push({ key: i.name, how: 'inferred', label, value: p, text: `${label} = ${p} (taken from your words)`, change: { input: i.name, kind: 'place', options: Object.keys(model?.places || {}) } });
        }
        const missing = missingInputs(goal, inputs);
        cards.push({ goal, inputs, assumed, missing, ready: missing.length === 0, form: goalFormModel(goal) });
        if (cards.length >= limit) break;
    }
    return cards;
}

/**
 * A goal's follow-up questions (goals.json followUps), as goals, available ones only.
 * @param {Object|string} goal  a catalog goal or its id
 * @param {{goals: Array}} catalog
 * @returns {Object[]}
 */
export function followUpsFor(goal, catalog) {
    const g = typeof goal === 'string' ? (catalog?.goals || []).find((x) => x.id === goal) : goal;
    return (g?.followUps || []).map((id) => (catalog?.goals || []).find((x) => x.id === id)).filter((x) => x && x.available !== false);
}

// ---- saying what was assumed, and whose words are whose ----

/**
 * An assumption as a sentence, for the line above a result ("I took the outcome to watch to be I") next to its Change
 * control. The assumption shapes are the ones a goal result carries (petri-chat.js): how is 'inferred' (from the
 * person's words), 'default' (the goal's), 'plan' (the plan's own choice, e.g. the horizon from sim.recommend),
 * 'unnamed', 'decided' (the person said "you decide") or 'edited'. Anything else is its own text.
 * @param {{how?: string, key?: string, label?: string, value?: any, text?: string}} a
 */
export function assumptionLine(a) {
    if (!a) return '';
    const what = a.label || a.key || '';
    const v = typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
    // an entry with no value to say (JSON.stringify(undefined) is undefined) has only its own wording
    if ((a.how === 'inferred' || a.how === 'default') && v === undefined) return a.text || a.key || '';
    switch (a.how) {
    case 'inferred': return `I took ${what} to be ${v}.`;
    case 'default': return `${what.charAt(0).toUpperCase()}${what.slice(1)} is ${v}, the goal's default.`;
    case 'unnamed': return `${what.charAt(0).toUpperCase()}${what.slice(1)} was not named, so the command picked its own default.`;
    default: return a.text || a.key || '';
    }
}

/** The lines of assumptionLine for a list, none empty. */
export function assumptionLines(list) {
    return (list || []).map(assumptionLine).filter(Boolean);
}

const LABELS = {
    engine: { id: 'engine', label: 'Engine', title: 'Produced by a command the engine ran (or written beside the goal in the catalogue), not by the model' },
    assistant: { id: 'assistant', label: 'Assistant', title: "The assistant's own words: its judgment, not the engine's output" },
};

/** The tag for a line: 'assistant' for model text, 'engine' for anything else (the same convention as the provenance footer). */
export function answerLabel(by) {
    return LABELS[by === 'assistant' ? 'assistant' : 'engine'];
}

/**
 * Every line a result shows, tagged by who wrote it, in display order: the assistant's answer, the engine and why,
 * warnings, assumptions, the goal's caveat. An assumption the model made when the person said "you decide" is the
 * assistant's judgment; one the code made (a place named in the words, a default, the plan's horizon) is the engine's.
 * @param {Object} result  a goal result (petri-chat.js) or any with {answer, record, warnings, assumed, caveat}
 * @returns {Array<{by: 'engine'|'assistant', kind: 'answer'|'engine'|'warning'|'assumed'|'caveat', text: string}>}
 */
export function taggedLines(result) {
    const lines = [];
    const add = (by, kind, text) => { if (text) lines.push({ by, kind, text }); };
    add('assistant', 'answer', result?.answer?.text);
    const e = result?.record?.engine;
    if (e) add('engine', 'engine', `${e.name}${e.reason ? ` — ${e.reason}` : ''}${e.overridden ? ' (overridden)' : ''}`);
    for (const w of result?.warnings || []) add('engine', 'warning', w);
    for (const a of result?.assumed || []) add(a.how === 'decided' ? 'assistant' : 'engine', 'assumed', assumptionLine(a));
    add('engine', 'caveat', result?.caveat);
    return lines;
}

// ---- R3: numbers in the model's prose ----

// A number as written: 1,000 · 3.14 · 2e-3, with a % or "percent" after it. A numeral inside a word (S2, t1, 40s) is a name.
const NUMERAL = /\d+(?:,\d{3})*(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function numeralsIn(text) {
    const out = [];
    const s = String(text);
    for (const m of s.matchAll(NUMERAL)) {
        const before = s[m.index - 1] || '';
        const after = s[m.index + m[0].length] || '';
        if (/[A-Za-z_]/.test(before) || /[A-Za-z_]/.test(after)) continue;
        if (before === '.' && /\d/.test(s[m.index - 2] || '')) continue; // the tail of a version or an address
        const written = m[0];
        const x = Number(written.replace(/,/g, ''));
        if (!Number.isFinite(x)) continue;
        const frac = /\.(\d+)/.exec(written);
        out.push({
            written, x, decimals: frac ? frac[1].length : 0, exponent: /[eE]/.test(written),
            percent: after === '%' || /^\s*per ?cent/i.test(s.slice(m.index + m[0].length)),
        });
    }
    return out;
}

// The most numbers one reply's evidence may hold before it is too big to index (40 MB of doubles), and the most
// distinct numerals of one reply that are looked up. Both are far past anything a real result or reply reaches.
const MAX_EVIDENCE = 5_000_000;
const MAX_WANTED = 1000;

/** @param {{values: number[], full: boolean}} acc */
function pushNumber(acc, x) {
    if (acc.values.length >= MAX_EVIDENCE) acc.full = true;
    else acc.values.push(x);
}

function collectNumbers(value, acc, seen = new WeakSet(), depth = 0) {
    if (acc.full || depth > 12) return;
    if (typeof value === 'number') { if (Number.isFinite(value)) pushNumber(acc, value); return; }
    if (typeof value === 'string') { for (const n of numeralsIn(value)) pushNumber(acc, n.x); return; }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { for (const v of value) { if (acc.full) return; collectNumbers(v, acc, seen, depth + 1); } return; }
    if (value.nodeType || typeof value.execute === 'function') return; // a registry or an element, not data
    for (const v of Object.values(value)) { if (acc.full) return; collectNumbers(v, acc, seen, depth + 1); }
}

const roundTo = (v, d) => Number(v.toFixed(Math.min(d, 20)));
const truncTo = (v, d) => Math.trunc(v * 10 ** d) / 10 ** d;

/** Whether the value w is the written numeral n at the digits written (rounded or truncated), or n within 0.1% for an exponent form. */
function at(n, w) {
    return n.exponent ? Math.abs(w - n.x) <= Math.abs(n.x) * 1e-3 : roundTo(w, n.decimals) === n.x || truncTo(w, n.decimals) === n.x;
}

/** The first index of the sorted array whose value is not below x. */
function lowerBound(sorted, x) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (sorted[mid] < x) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/** Whether some value of the sorted array in [lo, hi] satisfies ok. */
function anyIn(sorted, lo, hi, ok) {
    for (let i = lowerBound(sorted, lo); i < sorted.length && sorted[i] <= hi; i++) if (ok(sorted[i])) return true;
    return false;
}

/**
 * Whether the evidence (a sorted array) holds the numeral: a value that rounds or truncates to it at the digits written,
 * or the value times 100 for a percentage. A binary search finds the few values in the window a match can be in (rounding
 * reaches half a unit of the last digit either side, truncation a whole unit above; an exponent form a tenth of a percent),
 * and `at` has the last word on them, so the answer is the one a scan of every value would give.
 */
function holds(sorted, n) {
    const u = n.exponent ? Math.abs(n.x) * 1e-3 : 10 ** -Math.min(n.decimals, 20);
    const slack = u * 1e-6; // the window is only a filter: float noise at its edges must not shut a match out
    // (a zero truncates from either side: -0.7 is "0" at no decimals)
    const lo = (n.exponent ? n.x - u : n.x === 0 ? -u : n.x - u / 2) - slack, hi = n.x + u + slack;
    if (anyIn(sorted, lo, hi, (w) => at(n, w))) return true;
    const rel = (v) => Math.abs(v) * 1e-9;
    return anyIn(sorted, lo / 100 - rel(lo / 100), hi / 100 + rel(hi / 100), (w) => at(n, w * 100));
}

/**
 * R3: the numbers in the model's prose that are in none of the evidence. Evidence is anything JSON-like: artifacts
 * (their data), step results, the record's calls, the person's own words (`also`). A written number matches a value
 * when the value rounds (or truncates) to it at the digits written, or is that ratio as a percentage: "about 41" is
 * 41.237, "35%" is 0.35. 0 and 1 are not checked (`ignore`): they are counts of nothing in particular ("one run").
 * It starts as a warning in result.warnings, not a block; the pane renders numbers from artifact fields. The evidence is
 * sorted once and each numeral is a binary search, so a long table in the reply costs what it says, not the evidence
 * times the table. Evidence of more than 5 million numbers is not indexed and claims no stray; at most 1000 distinct
 * numerals of a reply are looked up.
 * @param {string} text  the model's prose
 * @param {any} artifacts  artifacts and results: anything that may hold numbers
 * @param {Object} [o]
 * @param {string} [o.also]  more text whose numbers count as evidence (the person's question)
 * @param {number[]} [o.ignore]  integers not checked (default [0, 1])
 * @returns {string[]} the numerals as written, once each, in order
 */
export function numeralsOutside(text, artifacts, { also = '', ignore = [0, 1] } = {}) {
    const wanted = numeralsIn(text || '').filter((n) => !(Number.isInteger(n.x) && n.decimals === 0 && !n.percent && ignore.includes(n.x)));
    if (!wanted.length) return [];
    const acc = { values: [], full: false };
    collectNumbers(artifacts, acc);
    for (const n of numeralsIn(also)) pushNumber(acc, n.x);
    // evidence too big to index is evidence not all seen: nothing can be called outside it, so no stray is claimed
    if (acc.full) return [];
    const sorted = Float64Array.from(acc.values).sort();
    const outside = [];
    const looked = new Set();
    for (const n of wanted) {
        const key = `${n.written}|${n.percent}`;
        if (looked.has(key)) continue;
        if (looked.size >= MAX_WANTED) break;
        looked.add(key);
        if (!holds(sorted, n) && !outside.includes(n.written)) outside.push(n.written);
    }
    return outside;
}
