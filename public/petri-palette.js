// petri-palette.js — the command palette's index, search and runners. No DOM,
// no model, no network: the dialog (petri-palette-ui.js) is a thin layer over
// this, and deno tests this directly.
//
// The palette is the deterministic escape hatch of docs/design/agent-first-
// analysis.md (section 8): everything the agent can do is a registry command a
// person can run from here with no model, signed in or not.
//
// The index has three kinds of entry, in this order:
//   goal      the questions people ask ("Can it get stuck?"), from
//             public/goals.json, each titled by its own question text; the
//             catalog order is kept. A goal that is not available here is listed
//             with the reason.
//   command   every registry command, under "All commands", sub-grouped by id
//             prefix (sim, analysis, ...). Titled by the registry label, id as
//             the subtitle. A command the host cannot run (view.* without a
//             view) and one a goal's plan already runs (coveredBy) are listed
//             and flagged, never hidden.
//   classic   the dialogs the menu used to open, under "Classic tools"
//             ({id, title, open} from the caller; open stays with the caller).
//
// Every entry says whether it has a form (petri-schema-form.js) and, if not,
// why. For commands that is the rule "every exposed command has a form or an
// explicit reason", held by petri-palette_test.ts against the live registry.
//
// Entry: {kind, id, title, subtitle, group, subgroup, section, keywords,
//   detail, form, noFormReason, available, coveredBy}
//   group      goal: its question; command: 'All commands'; classic: 'Classic tools'
//   subgroup   command: the id prefix; otherwise ''
//   section    the heading to draw: 'Questions' | 'All commands' | 'Classic tools'
//   keywords   words people use for it (a goal's phrases, the phrases of the
//              goals that cover a command, the prefix's name)
//   detail     long text searched with less weight (help, a goal's answer)
//
// searchIndex ranks by weighted matches of each word of the query against the
// id, the title, the keywords, the subtitle and the detail, tolerating a typo
// (edit distance) and a skeleton ("rcmnd" for "recommend"). Same index and same
// query give the same order; ties keep index order.

import { goalFormModel, noFormReason } from './petri-schema-form.js';

/**
 * @typedef {Object} Entry
 * @property {'goal'|'command'|'classic'} kind
 * @property {string} id
 * @property {string} title
 * @property {string} subtitle
 * @property {string} group
 * @property {string} subgroup
 * @property {string} section
 * @property {string[]} keywords
 * @property {string} detail
 * @property {boolean} form
 * @property {string|null} noFormReason
 * @property {boolean} available
 * @property {string[]} coveredBy
 */

/**
 * @typedef {Object} Outcome
 * @property {'goal'|'command'} kind
 * @property {string} title
 * @property {any} goal
 * @property {any} inputs
 * @property {{command: string, args: any}[]} calls
 * @property {any[]} steps
 * @property {string[]} artifacts
 * @property {string|null} error
 * @property {string[]} warnings
 */

export const SECTION = { goal: 'Questions', command: 'All commands', classic: 'Classic tools' };

const PREFIX_LABEL = {
    analysis: 'Analysis', artifact: 'Results', compose: 'Compose', data: 'Event logs', edit: 'Edit',
    export: 'Export', file: 'Files', game: 'Games', macro: 'Macros', model: 'Model library', net: 'Net',
    note: 'Notes', opt: 'Optimise', provenance: 'Provenance', sim: 'Simulate', store: 'Store',
    system: 'Systems', view: 'View',
};

/** The heading for a command id prefix: 'sim' -> 'Simulate'; one the table lacks is capitalised. */
export function prefixLabel(prefix) {
    if (!prefix) return 'Other';
    return PREFIX_LABEL[prefix] || prefix[0].toUpperCase() + prefix.slice(1);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const prefixOf = (id) => (String(id).includes('.') ? String(id).split('.')[0] : '');
const uniq = (xs) => [...new Set(xs)];

/**
 * The palette's entries.
 * @param {{specs?: any[], goals?: any[]|{goals: any[]}, classic?: {id: string, title: string, subtitle?: string, help?: string, keywords?: string[], open?: Function}[]}} [src]
 *   specs: Registry.list(); goals: the catalog (or its goals array); classic: the old dialogs
 * @returns {Entry[]}
 */
export function buildIndex({ specs = [], goals = [], classic = [] } = {}) {
    const goalList = Array.isArray(goals) ? goals : goals?.goals || [];
    const label = new Map(specs.map((s) => [s.id, s.label || s.id]));
    // command id -> the goals whose plan runs it
    const cover = new Map();
    for (const g of goalList) {
        for (const c of uniq((g.plan || []).map((s) => s.command))) {
            if (!cover.has(c)) cover.set(c, []);
            cover.get(c).push(g);
        }
    }
    const entries = [];
    for (const g of goalList) {
        const fm = goalFormModel(g);
        const cmds = uniq((g.plan || []).map((s) => s.command));
        entries.push({
            kind: 'goal', id: g.id, title: g.question,
            subtitle: g.available === false ? (g.caveat || '') : cmds.join(' · '),
            group: g.question, subgroup: '', section: SECTION.goal,
            keywords: [...(g.phrases || [])],
            detail: [g.answer, g.caveat, ...cmds.map((c) => label.get(c))].filter(Boolean).join(' '),
            form: !fm.noForm, noFormReason: fm.noForm,
            available: g.available !== false, coveredBy: [],
        });
    }
    const sorted = [...specs].sort((a, b) => cmp(prefixOf(a.id), prefixOf(b.id)) || cmp(a.id, b.id));
    for (const s of sorted) {
        const reason = noFormReason(s.args);
        const prefix = prefixOf(s.id);
        const goalsFor = cover.get(s.id) || [];
        entries.push({
            kind: 'command', id: s.id, title: s.label || s.id, subtitle: s.id,
            group: SECTION.command, subgroup: prefix, section: SECTION.command,
            keywords: uniq([prefixLabel(prefix), ...goalsFor.flatMap((g) => g.phrases || [])]),
            detail: s.help || '',
            form: !reason, noFormReason: reason,
            available: s.available !== false, coveredBy: goalsFor.map((g) => g.id),
        });
    }
    for (const c of classic) {
        entries.push({
            kind: 'classic', id: c.id, title: c.title, subtitle: c.subtitle ?? 'Classic tool',
            group: SECTION.classic, subgroup: '', section: SECTION.classic,
            keywords: [...(c.keywords || [])], detail: c.help || '',
            form: false, noFormReason: 'opens its own dialog', available: true, coveredBy: [],
        });
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const WORD = /[\p{L}\p{N}]+/gu;
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}._\-/]*/gu;
// Words a spoken question has that say nothing about which tool: dropped when something else is left.
const STOP = new Set(['a', 'an', 'the', 'it', 'is', 'of', 'to', 'in', 'on', 'at', 'i', 'my', 'me', 'we', 'you', 'do', 'does',
    'did', 'can', 'could', 'would', 'should', 'will', 'what', 'how', 'why', 'when', 'which', 'if', 'and', 'or', 'be', 'has', 'have', 'had']);

/** Optimal-string-alignment edit distance (an adjacent swap counts once). */
function distance(a, b) {
    const al = a.length;
    const bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    let prev2 = null;
    let prev = Array.from({ length: bl + 1 }, (_, j) => j);
    for (let i = 1; i <= al; i++) {
        const cur = [i];
        for (let j = 1; j <= bl; j++) {
            let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
            cur[j] = v;
        }
        prev2 = prev;
        prev = cur;
    }
    return prev[bl];
}

function subsequence(t, s) {
    let i = 0;
    for (let j = 0; j < s.length && i < t.length; j++) if (s[j] === t[i]) i++;
    return i === t.length;
}

// The text of a field, ready to match: lower case, its words, and its letters run together (short fields only).
function compile(w, text, short) {
    const t = String(text ?? '').toLowerCase();
    return { w, text: t, words: t.match(WORD) || [], compact: short ? t.replace(/[^\p{L}\p{N}]/gu, '') : '' };
}

const compiled = new WeakMap();
function fieldsOf(e) {
    let f = compiled.get(e);
    if (f) return f;
    f = [compile(10, e.id, true), compile(8, e.title, true)];
    for (const k of e.keywords || []) f.push(compile(6, k, true));
    if (e.subtitle && e.subtitle !== e.id) f.push(compile(3, e.subtitle, false));
    if (e.detail) f.push(compile(3, e.detail, false));
    compiled.set(e, f);
    return f;
}

// How well one word of the query matches a field: 0 (not at all) to 1 (it is the field).
function matchKind(t, F) {
    if (!F.text) return 0;
    if (F.text === t) return 1;
    if (F.words.includes(t)) return 0.95;
    if (F.words.some((w) => w.startsWith(t))) return 0.85;
    if (t.length >= 4 && F.text.includes(t)) return 0.7;
    if (t.length >= 4) {
        const k = t.length >= 8 ? 2 : 1;
        // a word of the field, or the whole field ('sim.recomend' against 'sim.recommend')
        for (const w of [...F.words, F.text]) {
            if (Math.abs(w.length - t.length) > k + 1) continue;
            if (distance(t, w) <= k || (t.length >= 5 && distance(t, w.slice(0, t.length)) <= 1)) return 0.5;
        }
    }
    if (t.length >= 4 && F.compact && subsequence(t, F.compact)) return 0.3;
    return 0;
}

// A field with fewer words says more about its match: "Run SSA" ahead of "Diagnose (Influence, SSA)" for "ssa".
const match = (t, F) => matchKind(t, F) * (0.9 + 0.1 / Math.max(1, F.words.length));

function queryTokens(query) {
    const all = String(query ?? '').toLowerCase().match(TOKEN) || [];
    const kept = all.filter((t) => !STOP.has(t));
    return kept.length ? kept : all;
}

// {score, hits}: the summed best field score per word, and how many words matched anything.
function scoreEntry(e, tokens) {
    const fields = fieldsOf(e);
    let score = 0;
    let hits = 0;
    for (const t of tokens) {
        let best = 0;
        for (const F of fields) best = Math.max(best, F.w * match(t, F));
        if (best > 0) { hits++; score += best; }
    }
    return { score: score + (e.kind === 'goal' && hits ? 0.5 : 0), hits };
}

/**
 * Entries ranked for a query. Every word of the query must match somewhere
 * (the, it, what, ... are skipped when other words remain). A longer query, a
 * spoken question of three words or more, needs only half of its words to
 * match, so one word that is about the person's own net ("barista") does not
 * hide the goal the rest of the question names; the score still puts the entry
 * that matched the most weight first. Case-insensitive; matches the id, title,
 * keywords and detail, tolerates a typo and a skipped letter. An empty query
 * returns the whole index in order (goals, then commands by prefix, then
 * classic). Deterministic: ties keep index order.
 * @param {Entry[]} index buildIndex's entries
 * @param {string} query
 * @param {{limit?: number}} [opts]
 * @returns {Entry[]}
 */
export function searchIndex(index, query, { limit = Infinity } = {}) {
    const tokens = queryTokens(query);
    if (!tokens.length) return index.slice(0, limit);
    const need = tokens.length >= 3 ? Math.ceil(tokens.length / 2) : tokens.length;
    return index.map((e, i) => ({ e, i, ...scoreEntry(e, tokens) }))
        .filter((s) => s.hits >= need)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .slice(0, limit)
        .map((s) => s.e);
}

// ---------------------------------------------------------------------------
// Keyboard (the dialog's logic, kept here so it can be tested)
// ---------------------------------------------------------------------------

/**
 * The list's next active row for an arrow or page key; -1 when the list is
 * empty. The arrows wrap, the pages stop at the ends. (Home and End stay with
 * the search box: they move its caret.)
 */
export function stepActive(count, current, key) {
    if (count <= 0) return -1;
    switch (key) {
    case 'ArrowDown': return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp': return current <= 0 ? count - 1 : current - 1;
    case 'PageDown': return Math.min(Math.max(current, 0) + 8, count - 1);
    case 'PageUp': return Math.max(Math.max(current, 0) - 8, 0);
    default: return current;
    }
}

/**
 * Focus trap: where Tab should go among `count` focusable elements when focus
 * is on `current` (-1: outside them), or null to let the browser move on its
 * own because the step stays inside.
 */
export function trapTarget(count, current, shift) {
    if (count <= 0) return null;
    if (current < 0) return shift ? count - 1 : 0;
    if (!shift && current === count - 1) return 0;
    if (shift && current === 0) return count - 1;
    return null;
}

/**
 * What the open dialog does with a key that arrives while focus is on nothing
 * (<body>: the person clicked plain text, or the focused control went away).
 * The dialog's own key handling does not hear such a key and the editor's
 * window shortcuts (Delete, x, Cmd-Z) would act on the net behind it, so the
 * dialog takes it: 'close' for Escape and the palette chord, 'tab' to bring
 * focus back inside, 'swallow' for every other key (kept from the editor, the
 * browser's own default left alone). null when focus is on something, whose
 * handlers decide.
 * @param {{key?: string, metaKey?: boolean, ctrlKey?: boolean, altKey?: boolean, shiftKey?: boolean}} e
 * @param {boolean} focusIsNowhere document.activeElement is null, <body> or <html>
 * @returns {'close' | 'tab' | 'swallow' | null}
 */
export function strayKeyAction(e, focusIsNowhere) {
    if (!focusIsNowhere || !e) return null;
    if (e.key === 'Escape' || isPaletteChord(e)) return 'close';
    if (e.key === 'Tab') return 'tab';
    return 'swallow';
}

/** Cmd-K or Ctrl-K, with no other modifier (one of Cmd and Ctrl, as the platform has it). */
export function isPaletteChord(e) {
    return !!e && typeof e.key === 'string' && e.key.toLowerCase() === 'k'
        && !!e.metaKey !== !!e.ctrlKey && !e.altKey && !e.shiftKey;
}

/** The shortcut as the Tools button shows it: {text, aria} for Cmd (mac) or Ctrl. */
export function shortcutHint(mac) {
    return mac ? { text: '⌘K', aria: 'Meta+K' } : { text: 'Ctrl K', aria: 'Control+K' };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * The result a run hands to onResult: {kind: 'goal' | 'command', title, goal,
 * inputs, calls, steps, artifacts, error, warnings}.
 *   calls      [{command, args}] the calls that ran and succeeded (rerunnable)
 *   steps      every step: {index, command, args?, result? | error? | skipped?, artifacts?}
 *   artifacts  the ids of the artifacts the run stored (the registry holds them)
 *   error      the first failure, or null
 * @param {{kind: 'goal'|'command', title: string, goal?: any, inputs?: any, steps?: any[], error?: string|null, warnings?: any[]}} o
 * @returns {Outcome}
 */
export function outcomeOf({ kind, title, goal = null, inputs = {}, steps = [], error = null, warnings = [] }) {
    const failed = steps.find((s) => s.error);
    const ran = steps.filter((s) => !s.skipped && !s.error && s.args !== undefined);
    return {
        kind, title, goal, inputs,
        calls: ran.map((s) => ({ command: s.command, args: s.args })),
        steps,
        artifacts: uniq(steps.flatMap((s) => s.artifacts || [])),
        error: error || (failed ? `${failed.command}: ${failed.error}` : null),
        warnings: uniq(warnings.map((w) => String(w?.message ?? w))),
    };
}

/**
 * Run one registry command and say what happened; never throws.
 * @param {any} reg a Registry
 * @param {string} id
 * @param {any} args
 * @param {{title?: string}} [opts]
 * @returns {Promise<Outcome>}
 */
export async function runCommandOutcome(reg, id, args, { title } = {}) {
    const before = new Set(reg.artifacts().map((a) => a.id));
    const step = { index: 0, command: id, args: args ?? {} };
    try {
        step.result = await reg.execute(id, step.args);
        step.artifacts = reg.artifacts().filter((a) => !before.has(a.id)).map((a) => a.id);
    } catch (e) {
        step.error = e?.message || String(e);
    }
    return outcomeOf({ kind: 'command', title: title || id, steps: [step] });
}

/**
 * Run a goal through the caller's runGoal (petri-goals.js; the palette passes
 * that very function, so whatever guard the plan runner has applies) and say
 * what happened; never throws. Warnings are read off the run (`warnings`, on it
 * or on a step) when the runner reports any.
 * @param {any} reg a Registry
 * @param {any} goal
 * @param {any} inputs
 * @param {any} runGoal petri-goals.js's runGoal (reg, goal, inputs, onStep)
 * @param {(step: any) => void} [onStep]
 * @returns {Promise<Outcome>}
 */
export async function runGoalOutcome(reg, goal, inputs, runGoal, onStep) {
    let out;
    try {
        out = await runGoal(reg, goal, inputs, onStep);
    } catch (e) {
        return outcomeOf({ kind: 'goal', title: goal.question, goal, inputs, error: e?.message || String(e) });
    }
    const steps = out?.steps || [];
    const warnings = [].concat(out?.warnings || [], ...steps.map((s) => s.warnings || []));
    const refused = out?.error || out?.refused;
    const error = refused ? String(refused?.message ?? refused) : (out?.ok === false && !steps.some((s) => s.error) ? 'the plan stopped' : null);
    return outcomeOf({ kind: 'goal', title: goal.question, goal, inputs, steps, error, warnings });
}

/** The one line a step's result leads with (its why / summary / verdict / answer), or ''. */
export function stepHeadline(step) {
    const r = step?.result;
    if (!r || typeof r !== 'object') return '';
    for (const k of ['why', 'summary', 'verdict']) if (typeof r[k] === 'string' && r[k]) return r[k];
    if (r.answer !== undefined && r.answer !== null && typeof r.answer !== 'object') return `answer: ${r.answer}`;
    return '';
}

/** A value as indented JSON for display, cut at `limit` characters. */
export function previewJson(v, limit = 6000) {
    let s;
    try {
        s = JSON.stringify(v, null, 2);
    } catch {
        s = String(v);
    }
    if (s === undefined) return '';
    return s.length > limit ? `${s.slice(0, limit)}\n… (${s.length - limit} more characters)` : s;
}
