// petri-problems.js — the automatic "problems" indicator that replaces the Check net menu entry.
//
// Design: docs/design/agent-first-analysis.md, section 3 (menu) and section 7 (inventory): Check net "runs on load
// and before every Apply; shows as a 'N problems' chip by the title, click for the list. No menu entry". The command
// analysis.check is unchanged (it is still a registry command and an MCP tool); this module is a quiet second caller
// of the same code (petri-validate.js validateNet + smokeCheck), so the chip and the command can never disagree.
//
// What is here
//   summarize({report, loadCheck})   pure: an analysis.check report plus what the editor repaired at load -> one
//                                    summary {level, count, errors, warnings, repaired, items, label}
//   checkModel(model, {registry})    async: that summary for ANY net, read-only (the live document is never touched)
//   ProblemsMonitor                  re-checks the live net after a burst of edits, drops results that went stale
//   applyGate(summary)               what an Apply does about problems: show them first, never refuse
//
// Severities, in the order they are listed: 'error' (a problem in the net as it is now), 'repaired' (a problem the
// incoming document had, which normalizeModel fixed quietly on load: the net you see is not the net you were given),
// 'warning' (legal but usually a mistake). Levels: 'error' if there is any error; else 'warn' if there is any repair
// or warning (a repair is already fixed, so it does not make the net broken, but it is worth a look); else 'ok'.
//
// No DOM in the pure part: deno tests it directly. petri-validate.js is loaded on demand, as analysis.check does, so
// summarize and the monitor work in a build that does not ship it (a check then reports that it could not run).

/**
 * @typedef {'error'|'repaired'|'warning'} Severity
 * @typedef {{severity: Severity, where: string, message: string}} ProblemItem
 * @typedef {{level: 'ok'|'warn'|'error', count: number, errors: number, warnings: number, repaired: number,
 *            items: ProblemItem[], label: string}} ProblemsSummary
 */

const NET = '(net)';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The chip text: "No problems", "1 problem", "3 problems". */
function labelFor(count) {
    return count === 0 ? 'No problems' : plural(count, 'problem');
}

// A validateNet / smokeCheck issue is {path, message}; an empty path is the net itself (reportHtml's "(net)").
function toItems(list, severity) {
    if (!Array.isArray(list)) return [];
    const items = [];
    for (const raw of list) {
        if (typeof raw === 'string') {
            items.push({ severity, where: NET, message: raw });
        } else if (raw && typeof raw === 'object') {
            items.push({
                severity,
                where: typeof raw.path === 'string' && raw.path !== '' ? raw.path : NET,
                message: String(raw.message ?? ''),
            });
        }
    }
    return items;
}

// The report analysis.check stores is {kind: 'report', errors, warnings, ok, cid}. Its command result has the same
// fields, and the artifact wraps them in `data`; take any of the three.
function reportData(report) {
    if (report && Array.isArray(report.errors)) return report;
    if (report && report.data && Array.isArray(report.data.errors)) return report.data;
    return null;
}

/**
 * One summary of what is wrong with a net. Pure and deterministic; reads its arguments, changes nothing.
 *
 * @param {Object} [input]
 * @param {Object|null} [input.report] analysis.check's report ({errors, warnings, ...}), its artifact or its result;
 *   null when the net has not been checked yet
 * @param {{errors?: Array<{path?: string, message: string}>}|null} [input.loadCheck] petri-view's `_loadCheck`: what
 *   validateNet found wrong in the document as it arrived. Those are the things normalizeModel repaired, so they
 *   count as 'repaired' items. (Its warnings are not counted: every older net would carry defaults warnings.)
 * @returns {ProblemsSummary}
 */
export function summarize({ report = null, loadCheck = null } = {}) {
    const data = reportData(report);
    const errors = toItems(data && data.errors, 'error');
    const repaired = toItems(loadCheck && loadCheck.errors, 'repaired');
    const warnings = toItems(data && data.warnings, 'warning');
    const count = errors.length + repaired.length + warnings.length;
    return {
        level: errors.length ? 'error' : (repaired.length || warnings.length) ? 'warn' : 'ok',
        count,
        errors: errors.length,
        warnings: warnings.length,
        repaired: repaired.length,
        items: [...errors, ...repaired, ...warnings],
        label: labelFor(count),
    };
}

// A check that could not run is a problem the person should see, never a quiet "No problems".
function failedSummary(e) {
    const why = (e && e.message) || String(e);
    return summarize({ report: { errors: [{ path: '', message: `the check could not run: ${why}` }], warnings: [] } });
}

/**
 * Check any net the way analysis.check does (validateNet, then, if that found no error, the engine smoke check) and
 * summarize it. Read-only: the net is copied before anything else happens, so `model` is never changed, an edit made
 * while the engines run is not seen, and nothing is committed or stored (no artifact lands in Results).
 *
 * `model` is the net to check: a raw document, or a live editor model (its Infinity capacities are copied as null,
 * which is how analysis.check reads them too). When `model` is null or undefined and a `registry` is given, the
 * registry's own document is checked: pass the Assistant's sandbox registry to check the pending net BEFORE Apply.
 *
 * It never rejects: a net that cannot be copied or checked comes back as an error item saying so.
 *
 * @param {*} model
 * @param {{registry?: {host: {getModel: () => *}}}} [opts]
 * @returns {Promise<ProblemsSummary>}
 */
export async function checkModel(model, { registry } = {}) {
    let doc;
    try {
        const source = model ?? (registry && registry.host && registry.host.getModel());
        // Synchronous, before the first await: a later edit cannot leak into this check.
        doc = source === undefined ? undefined : JSON.parse(JSON.stringify(source));
    } catch (e) {
        return failedSummary(e);
    }
    try {
        const { validateNet, smokeCheck } = await import('./petri-validate.js');
        const r = validateNet(doc);
        const smoke = r.ok ? await smokeCheck(doc) : null;
        return summarize({ report: { errors: [...r.errors, ...(smoke ? smoke.errors : [])], warnings: r.warnings } });
    } catch (e) {
        return failedSummary(e);
    }
}

const sameSummary = (a, b) => !!a && !!b && a.level === b.level && a.count === b.count
    && JSON.stringify(a.items) === JSON.stringify(b.items);

/**
 * Keeps a ProblemsSummary of a live net up to date without blocking edits.
 *
 *   schedule()   an edit happened: check again after `delayMs` of quiet. A burst of edits runs one check, on the
 *                model as it is when the timer fires (the last one wins).
 *   run()        check now (on load, before an Apply); resolves to the summary
 *   state        {summary, checking}: the latest accepted summary (null before the first) and whether a check is
 *                waiting or running
 *   subscribe(fn) fn(summary) on each accepted result that differs from the last; returns an unsubscribe
 *   destroy()    stop: cancels the timer and drops anything still running
 *
 * A result is stale when a newer schedule() or run() started after the check that produced it: the model has
 * moved on, so the result is dropped (not stored, nobody is told). The run() that was dropped resolves to the
 * latest accepted summary instead. Timers are injectable so tests never sleep.
 */
export class ProblemsMonitor {
    /**
     * @param {Object} o
     * @param {() => *} o.getModel the live net, read when a check starts
     * @param {(model: *) => Promise<ProblemsSummary>} [o.check]
     * @param {(summary: ProblemsSummary) => void} [o.onChange]
     * @param {number} [o.delayMs] quiet time before a scheduled check (default 400)
     * @param {(fn: () => void, ms: number) => *} [o.setTimer]
     * @param {(handle: *) => void} [o.clearTimer]
     */
    constructor({ getModel, check = checkModel, onChange, delayMs = 400, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
        if (typeof getModel !== 'function') throw new TypeError('ProblemsMonitor needs getModel()');
        this._getModel = getModel;
        this._check = check;
        this._delayMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 400;
        // Called as plain functions: the browser's setTimeout refuses to run with a monitor as `this`.
        this._setTimer = (fn, ms) => setTimer(fn, ms);
        this._clearTimer = (handle) => clearTimer(handle);
        this._listeners = new Set(typeof onChange === 'function' ? [onChange] : []);
        this._timer = null;
        this._gen = 0;
        this._inflight = 0;
        this._summary = null;
        this._destroyed = false;
    }

    get state() {
        return { summary: this._summary, checking: this._timer !== null || this._inflight > 0 };
    }

    subscribe(fn) {
        this._listeners.add(fn);
        return () => { this._listeners.delete(fn); };
    }

    /** An edit happened. Many calls in a burst run one check. */
    schedule() {
        if (this._destroyed) return;
        this._gen++; // a check already running is about a net that has since changed
        this._cancelTimer();
        this._timer = this._setTimer(() => {
            this._timer = null;
            this.run();
        }, this._delayMs);
    }

    /**
     * Check the net now. Resolves to the new summary, or, when a newer check supersedes this one (or the monitor was
     * destroyed, or there is no net yet), to the latest accepted summary, which is null before the first. Never rejects.
     * @returns {Promise<ProblemsSummary|null>}
     */
    async run() {
        if (this._destroyed) return this._summary;
        this._cancelTimer(); // this check covers the one that was waiting
        let model;
        try { model = this._getModel(); } catch { model = undefined; }
        if (model === null || model === undefined) return this._summary;
        const gen = ++this._gen;
        this._inflight++;
        let summary;
        try {
            summary = await this._check(model);
            if (!summary || typeof summary !== 'object') throw new Error('the check returned nothing');
        } catch (e) {
            summary = failedSummary(e);
        } finally {
            this._inflight--;
        }
        if (this._destroyed || gen !== this._gen) return this._summary; // stale: the net changed while it ran
        const changed = !sameSummary(this._summary, summary);
        this._summary = summary;
        if (changed) {
            for (const fn of [...this._listeners]) {
                try { fn(summary); } catch { /* a listener never breaks the monitor */ }
            }
        }
        return summary;
    }

    destroy() {
        this._destroyed = true;
        this._cancelTimer();
        this._listeners.clear();
    }

    _cancelTimer() {
        if (this._timer !== null) {
            this._clearTimer(this._timer);
            this._timer = null;
        }
    }
}

/**
 * What an Apply does about problems in the net it would apply (the Assistant's pending sandbox net, run through
 * checkModel just before the Apply button acts).
 *
 * THE CHOICE: an Apply with errors is ALLOWED. `block` is always false. The edit is the person's, they may be
 * building toward a valid net in several steps, and a net with errors is still a net they can see, fix and undo (an
 * Apply is one undo step). What is not allowed is applying without knowing: with errors, `warn` is true and the
 * caller shows the problems list first (the same list the chip opens), with Apply still available in it. Warnings
 * and repairs do not interrupt an Apply (an unfinished net is full of "nothing is enabled" and unconnected nodes);
 * the chip shows them.
 *
 * @param {ProblemsSummary|null} summary
 * @returns {{block: false, warn: boolean, message: string}} message is '' when there is nothing to warn about
 */
export function applyGate(summary) {
    const n = summary && Number.isFinite(summary.errors) ? summary.errors : 0;
    if (n === 0) return { block: false, warn: false, message: '' };
    return {
        block: false,
        warn: true,
        message: `This leaves ${plural(n, 'error')} in the net. Look at the list first; you can still apply.`,
    };
}
