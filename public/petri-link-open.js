// petri-link-open.js — opening a view link and making one (docs/design/agent-first-analysis.md sections 14.3,
// 14.5 and 14.7), with no DOM and no model.
//
//   openLinkedView   /?cid=<net>#view=<payload> in, a result for the results pane out. The payload is decoded, checked
//                    against the registry and the replay allowlist, and replayed on a SANDBOX (petri-viewspec.js
//                    replayInWorker: a Worker, so a hostile link cannot freeze the tab). Nothing here can reach a model:
//                    this module calls no /api/llm route (its one request is GET /health, for the build revision in
//                    appRevision), and scripts/links-smoke.ts asserts that no model route is called while a link opens.
//   buildShareLink   a provenance record in, the link that reproduces it out: /?cid=<net>#view= when the net is saved,
//                    /?data=<permalink>#view= when it is small enough to travel in the link, else "Save to get a link".
//                    The expect digests come from a replay of the record's calls, so they are exactly what whoever opens
//                    the link will compute (and a record whose calls a link may not run gets no link).
//   linkStripHtml    the chips, the assistant's note and the "saved version" line drawn over the result.
//
// What an opened link says about itself (statuses, in the order they are drawn):
//
//   Saved version of the net            a CID is immutable: the link shows the net as it was linked (14.5). A link whose
//                                       net travels in ?data= says "Net carried in the link" instead.
//   reproduced - no model call          every expect digest matched, nothing was skipped
//   ran here - ...no digest to compare  the link carries no digests: the view ran, and nothing says it is the same
//   This differs from when the link was made   a digest changed: both engine versions are shown, the new result is
//                                       shown next to the saved and the new digest. Never hidden, never swapped.
//   not reproducible here               a command this app does not have: the note and the calls stay, the net is open
//   partial                             a call failed (a place that is no longer there is named by the engine's error)
//   refused                             a command a link may not run (edit.*, net.*, store.*, file.*, ...): the whole
//                                       link is refused, nothing ran, and its note is not shown
//
// The result handed to the results pane follows petri-results-pane.js's contract (source 'link'); the statuses that are
// warnings go in `warnings`, and the chips, the note and the edit line are drawn by linkStripHtml over the pane.
import { DEFAULT_ROUNDING, decodeView, encodeView, linkFits, linkFor, MAX_LINK_CHARS, parseLocation, permalinkData, replayInWorker, sandboxRegistry, specFromRecord, validateViewSpec } from './petri-viewspec.js';
import { defaultVersions, recordFromSpec, shortCid } from './petri-provenance.js';
import { checkEngine, engineNeeded } from './petri-engine-guard.js';

export const STATUS = Object.freeze({
    saved: 'Saved version of the net',
    carried: 'Net carried in the link',
    reproduced: 'reproduced - no model call',
    ran: 'ran here - the link carries no digest to compare',
    differs: 'This differs from when the link was made',
    unreproducible: 'not reproducible here',
    partial: 'partial',
    refused: 'refused',
});

/** The label the saved note carries wherever it is drawn. */
export const NOTE_LABEL = "assistant's note, saved with the link";

const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const list = (names) => names.map((n) => `"${n}"`).join(', ');
const shortDigest = (d) => (typeof d === 'string' ? `${d.slice(0, 14)}…` : 'none');

/** The goal a view names, from the catalog ({goals: [...]}), or null: a view id that is not a goal has no question. */
function goalFor(spec, goals) {
    const g = goals && Array.isArray(goals.goals) ? goals.goals.find((x) => x.id === spec?.view) : null;
    return g ? { id: g.id, question: g.question, caveat: g.caveat } : null;
}

/** How the engine now differs from the one that made the view, in a sentence. */
export function engineSentence(made, now) {
    const m = made ? `${made.registry}${made.app && made.app !== 'unknown' ? `, app ${made.app}` : ''}` : 'an engine the link does not name';
    const n = `${now.registry}${now.app && now.app !== 'unknown' ? `, app ${now.app}` : ''}`;
    if (made && made.registry === now.registry && made.app === now.app) return `Both ran ${n}; the same engine now gives another answer.`;
    return `The view was made with ${m}; this app runs ${n}.`;
}

/**
 * The statuses of a replay: chips, warnings and the primary status, from the
 * spec and what replayViewSpec / replayInWorker reported. Pure.
 * @param {Object} spec
 * @param {Object} run a replay result
 * @param {{registry: string, app: string}} now this build's versions
 * @returns {{status: string, chips: Array<{id: string, text: string, tone?: string}>, warnings: string[]}}
 */
export function statusesOf(spec, run, now) {
    const chips = [];
    const warnings = [];
    const expected = Array.isArray(spec?.expect?.artifacts) ? spec.expect.artifacts : [];
    const bad = [];

    if (run.timedOut) {
        bad.push('partial');
        chips.push({ id: 'partial', text: STATUS.partial, tone: 'warn' });
        warnings.push(`partial: ${(run.errors || [])[0] || 'the view did not finish in time'}. The net is open on its own.`);
    }
    if (run.notReproducible?.length) {
        bad.push('unreproducible');
        chips.push({ id: 'unreproducible', text: STATUS.unreproducible, tone: 'warn' });
        warnings.push(`${STATUS.unreproducible}: this app has no ${list(run.notReproducible)}. The note and the calls are kept below; the net is open on its own.`);
    }
    const failed = (run.steps || []).filter((s) => s.error);
    if (failed.length) {
        bad.push('partial');
        chips.push({ id: 'partial', text: STATUS.partial, tone: 'warn' });
        warnings.push(`partial: ${failed.map((s) => `${s.command} did not run: ${s.error}`).join('; ')}.`);
    }
    if (run.mutated) {
        bad.push('refused');
        chips.push({ id: 'refused', text: STATUS.refused, tone: 'warn' });
        warnings.push('refused: the view tried to change the net in its sandbox. Nothing was applied to your net.');
    }
    if (run.deferred?.length) warnings.push(`Not run here: ${list([...new Set(run.deferred.map((d) => d.command))])} need the canvas.`);
    const drift = run.drift || { matched: [], differed: [], unchecked: [] };
    if (drift.differed.length) {
        bad.push('differs');
        chips.push({ id: 'differs', text: STATUS.differs, tone: 'warn' });
        const rows = drift.differed.map((d) => `result ${d.index + 1}${d.title ? ` (${d.title})` : ''}: saved ${shortDigest(d.expected)}, now ${shortDigest(d.actual)}`);
        warnings.push(`${STATUS.differs}. ${engineSentence(spec?.engine ?? null, now)} ${rows.join('; ')}. What is shown is the result now, not the saved one.`);
    }
    if (!bad.length) {
        if (expected.length && drift.matched.length === expected.length && run.artifacts?.length === expected.length) chips.push({ id: 'reproduced', text: STATUS.reproduced, tone: 'ok' });
        else if (!expected.length) chips.push({ id: 'ran', text: STATUS.ran });
        else {
            // fewer or more results than the link remembers, with no step failing: say so rather than claim a match
            chips.push({ id: 'differs', text: STATUS.differs, tone: 'warn' });
            bad.push('differs');
            warnings.push(`${STATUS.differs}. The link remembers ${expected.length} result${expected.length === 1 ? '' : 's'}; it gave ${run.artifacts?.length ?? 0}. ${engineSentence(spec?.engine ?? null, now)}`);
        }
    }
    const status = bad[0] || chips[chips.length - 1]?.id || 'ran';
    return { status, chips, warnings };
}

/**
 * What the engine guard says about a spec's calls on this net, the chip a plan
 * would have carried: "ODE on a net where the engine recommends SSA (only 60
 * tokens in all)". A spec does not carry it (it is a fact about the net and the
 * recommender, not about the view), so the opener works it out again. A link
 * that names an engine the recommendation rules out still opens (it is a
 * recorded view, and the person who made it may have asked for that engine),
 * but it is never shown without the caution. Reads the net only: sim.recommend
 * on `registry`, which must be a sandbox. Never throws.
 * @returns {Promise<Array<{command: string, message: string}>>}
 */
export async function engineNotes(calls, registry) {
    try {
        const needing = (calls || []).filter((c) => engineNeeded(c.command ?? c.id, c.args ?? {}));
        if (!needing.length) return [];
        const rec = await registry.execute('sim.recommend');
        const out = [];
        for (const c of needing) {
            const command = c.command ?? c.id;
            const args = c.args ?? {};
            // asking with the engine the command needs as the override yields the chip's text instead of the refusal's
            const v = checkEngine(command, rec, { args, override: engineNeeded(command, args).needs });
            if (v.verdict === 'warn' && !out.some((n) => n.message === v.message)) out.push({ command, message: v.message });
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Open the view in a location, with no model call. Returns what to show:
 *   {kind: 'none'}               no #view= (a compose hash, or nothing): the page opens as it always has
 *   {kind: 'notice', text}       one line saying why the view was not run; the net is open on its own
 *   {kind: 'result', result, opening}   `result` for showResult (without `registry`: the caller adds its sandbox), and
 *                                `opening` ({spec, status, chips, note, netLine}) for linkStripHtml
 * Never throws.
 * @param {Object} o
 * @param {{search?: string, hash?: string}} o.location
 * @param {Object} o.model the net the editor holds (the sandbox is a copy of it)
 * @param {string|null} [o.netCid] the CID the editor loaded the net from (null: it came from ?data= or elsewhere)
 * @param {Object} [o.registry] a registry, to tell commands it has from those it lacks (list() only)
 * @param {Function} [o.replay] (spec, model, opts) => Promise<replay result>; default replayInWorker
 * @param {() => Promise<{registry: string, app: string}>} [o.getVersions] this build's versions
 * @param {Object|null} [o.goals] the goal catalog, for the view's question
 * @param {(calls: Array, registry: Object) => Promise<Array<{command: string, message: string}>>} [o.guardNotes] default engineNotes
 */
export async function openLinkedView({ location, model, netCid = null, registry, replay = replayInWorker, getVersions = async () => defaultVersions(), goals = null, guardNotes = engineNotes } = {}) {
    try {
        const loc = parseLocation(location || {});
        if (!loc.viewPayload) return { kind: 'none' };
        const aloneTail = 'the net is open on its own.';
        // Which net the view belongs to. ?data= wins over ?cid= in the editor's loader, so it does here: a net that
        // travels in the link has no CID to name. A ?cid= the editor could not load (netCid is not it) leaves the
        // editor on some other net, and a view must never be replayed on that.
        if (!loc.data) {
            if (!loc.cid) return { kind: 'notice', text: `This link names no net, so its view was not run; ${aloneTail}` };
            if (netCid !== loc.cid) return { kind: 'notice', text: `This link's net could not be loaded (it may have been removed by its author), so its view was not run; ${aloneTail}` };
        }
        const net = loc.data ? null : loc.cid;
        const decoded = await decodeView(loc.viewPayload, { net });
        if (!decoded.ok) return { kind: 'notice', text: `This link's view could not be opened (${decoded.error}); ${aloneTail}` };
        const spec = decoded.spec;

        const check = validateViewSpec(spec, registry, { model });
        if (check.errors.length) return { kind: 'notice', text: `This link's view could not be used (${check.errors[0]}); ${aloneTail}` };

        const now = await getVersions();
        const goal = goalFor(spec, goals);
        const title = goal ? goal.question : `View: ${spec.view}`;
        const base = { source: 'link', goal: goal ? { id: goal.id, question: goal.question } : null, answer: null, stale: false };
        const netChip = net ? { id: 'saved', text: STATUS.saved } : { id: 'carried', text: STATUS.carried };
        const netLine = net
            ? 'This is a saved version of the net. Edit from here: the net is open in the editor, and saving makes a new net; this link keeps opening this one.'
            : 'The net travels inside this link. Edit from here: it is open in the editor; saving gives a link that does not carry it.';

        if (check.refused.length) {
            // Nothing runs: a link that asks for an edit is refused whole, whatever else is in it, and its note is not shown.
            const warn = `refused: this link asks to run ${list(check.refused)}, which a link may not run. Nothing was run, and your net was not changed.`;
            const record = recordFromSpec(spec, { goal, withNote: false });
            return {
                kind: 'result',
                result: { ...base, title, record, artifacts: [], warnings: [warn] },
                opening: { spec, status: 'refused', chips: [netChip, { id: 'refused', text: STATUS.refused, tone: 'warn' }], note: null, netLine },
            };
        }

        const run = await replay(spec, model, { versions: now });
        if (!run.steps?.length && (run.errors || []).length && !run.timedOut) {
            return { kind: 'notice', text: `This link's view could not be run (${run.errors[0]}); ${aloneTail}` };
        }
        const st = statusesOf(spec, run, now);
        const notes = await guardNotes(spec.calls, sandboxRegistry(model));
        for (const n of notes) st.warnings.push(`engine caution: ${n.message}.`);
        const sourceOf = new Map();
        for (const s of run.steps || []) for (const id of s.artifacts || []) sourceOf.set(id, { command: s.command, args: s.args ?? {} });
        const artifacts = (run.artifactData || []).map((a) => ({
            id: a.id, title: a.title, data: a.data, ...(a.meta ? { meta: a.meta } : {}),
            source: sourceOf.get(a.id) || { command: '', args: {} },
        }));
        const stepErrors = (run.steps || []).filter((s) => s.error).map((s) => `${s.command}: ${s.error}`);
        const record = recordFromSpec(spec, { goal, warnings: stepErrors, engineWarning: notes[0]?.message || '' });
        return {
            kind: 'result',
            result: { ...base, title, record, artifacts, warnings: st.warnings },
            opening: { spec, status: st.status, chips: [netChip, ...st.chips], note: spec.note?.text ? spec.note.text : null, netLine, run },
        };
    } catch (e) {
        return { kind: 'notice', text: `This link's view could not be opened (${e?.message || e}); the net is open on its own.` };
    }
}

/**
 * The strip drawn over an opened link's result: the status chips, the
 * assistant's note under its label, the saved-version line and (when the view
 * could not be shown whole) a button that closes the pane to leave the net.
 * Every string is escaped; the note is text, never HTML.
 */
export function linkStripHtml(opening) {
    const chips = (opening?.chips || []).map((c) => `<span class="pv-prov-chip pv-link-chip${c.tone === 'warn' ? ' pv-prov-warn' : c.tone === 'ok' ? ' pv-link-ok' : ''}" data-status="${esc(c.id)}">${esc(c.text)}</span>`).join(' ');
    const note = opening?.note ? `<p class="pv-link-note"><span class="pv-prov-chip pv-prov-ast" data-link-note-label>${esc(NOTE_LABEL)}</span> <span data-link-note>${esc(opening.note)}</span></p>` : '';
    const alone = ['unreproducible', 'refused', 'partial'].includes(opening?.status)
        ? ' <button type="button" class="pv-btn pv-btn-sm" data-act="net-alone">Open the net alone</button>' : '';
    return `<div class="pv-link-status" data-link-status data-status="${esc(opening?.status || '')}">
    <div class="pv-link-chips">${chips}${alone}</div>${note}
    <p class="pv-result-dim pv-link-net">${esc(opening?.netLine || '')}</p>
</div>`;
}

// ---- making a link ----

/**
 * The link that reproduces a record's view, or why there is none.
 *
 *   saved net      origin/?cid=<cid>#view=<payload>      (cid given)
 *   small net      origin/?data=<permalink>#view=...      (no cid; the link fits MAX_LINK_CHARS)
 *   else           {ok: false, needsSave: true}           "Save to get a link"
 *
 * The record's calls are replayed first (on a sandbox, in a Worker, the same
 * path an opened link takes) to get the expect digests and to know that the
 * link will open: a record whose calls a link may not run, that fail, or that
 * run past the limits gets no link and a reason.
 * @param {Object} o
 * @param {Object} o.record a provenance record
 * @param {Object} o.model the net, as the editor holds it
 * @param {string|null} [o.cid] the CID of this net, when it is saved
 * @param {string} [o.origin]
 * @param {Function} [o.replay] default replayInWorker
 * @param {{registry: string, app: string}} [o.versions] default defaultVersions()
 * @param {number} [o.rounding]
 * @returns {Promise<{ok: true, url: string, kind: 'saved'|'unsaved', spec: Object}|{ok: false, reason: string, needsSave?: boolean}>}
 */
export async function buildShareLink({ record, model, cid = null, origin = '', replay = replayInWorker, versions = defaultVersions(), rounding = DEFAULT_ROUNDING } = {}) {
    try {
        if (!record || !Array.isArray(record.calls) || !record.calls.length) return { ok: false, reason: 'there is no view to link to yet: run something first' };
        const draft = specFromRecord({ ...record, versions, net: { ...(record.net || {}), cid: cid || undefined } }, { expect: { artifacts: [], rounding } });
        const check = validateViewSpec(draft, undefined, { model });
        if (check.errors.length) return { ok: false, reason: `this view could not be opened from a link: ${check.errors[0]}` };
        if (check.refused.length) return { ok: false, reason: `this view could not be opened from a link: ${list(check.refused)} may not be run from a link` };
        const run = await replay(draft, model, { versions });
        if (run.timedOut) return { ok: false, reason: `this view takes too long to reproduce for a link (${(run.errors || [])[0] || 'timed out'})` };
        if ((run.errors || []).length && !run.steps?.length) return { ok: false, reason: `this view could not be reproduced for a link: ${run.errors[0]}` };
        const failed = (run.steps || []).find((s) => s.error);
        if (failed || run.notReproducible?.length || run.refused?.length || run.mutated) {
            return { ok: false, reason: `this view could not be reproduced for a link: ${failed ? `${failed.command}: ${failed.error}` : run.notReproducible?.length ? `${list(run.notReproducible)} is not a command here` : 'a call was refused'}` };
        }
        const spec = { ...draft, expect: { artifacts: (run.artifacts || []).map((a) => a.digest), rounding } };
        const payload = await encodeView(spec);
        if (cid) {
            const url = linkFor({ origin, cid, payload });
            return linkFits(url) ? { ok: true, url, kind: 'saved', spec } : { ok: false, reason: `the link is ${url.length} characters, over the ${MAX_LINK_CHARS} that survive being shared: this view has too many calls to carry in a link` };
        }
        const url = linkFor({ origin, data: permalinkData(model), payload });
        if (linkFits(url)) return { ok: true, url, kind: 'unsaved', spec };
        return { ok: false, needsSave: true, reason: 'Save to get a link: this net is not saved and is too big to travel inside one' };
    } catch (e) {
        return { ok: false, reason: `the link could not be made: ${e?.message || e}` };
    }
}

/**
 * The build revision /health reports (X-Build-Revision), or 'unknown': what
 * `app` in a spec's engine means. Never throws; a server without the header,
 * a network failure and a refusal all read as unknown.
 * @param {typeof fetch} [fetchImpl]
 */
export async function appRevision(fetchImpl = globalThis.fetch) {
    try {
        const r = await fetchImpl('/health', { method: 'GET', cache: 'no-store' });
        const rev = r?.headers?.get?.('X-Build-Revision');
        return rev ? String(rev).slice(0, 12) : 'unknown';
    } catch {
        return 'unknown';
    }
}

/** The text of the privacy line the Share dialog carries (design 14.6): no access control is implied. */
export const SHARE_PRIVACY = 'Anyone who has a link can read the net it names: possessing the net\'s ID (its CID) is the only check. A link to a view is exactly as private as that ID, and deleting the net breaks the link.';

/** A short label for the net a link names, for dialogs. */
export function netLabel(cid) {
    return cid ? `net ${shortCid(cid)}` : 'this net (carried in the link)';
}
