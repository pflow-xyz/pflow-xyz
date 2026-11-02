// petri-menu.js — the pure part of the editor's top bar and of the Tools palette's hand-over to the results pane
// (docs/design/agent-first-analysis.md sections 3, 7, 8 and 9). No DOM, no network, no model: deno tests it directly,
// and petri-menu-ui.js (the bar) and petri-palette-ui.js (the dialog) are thin layers over it.
//
// What is here
//   the palette's `open` option    parseOpen, findOpenEntry, prefillModel, openTargetFromRecord: "open this command (or
//                                  goal) straight on its form, with these arguments filled in". The result footer's
//                                  "Open in Tools" is the main caller (petri-view.js _openPaletteFor).
//   the hand-over                  resultFromOutcome, showsInline: the palette's outcome ({kind, title, goal, inputs,
//                                  calls, steps, artifacts: ids, error, warnings}) as a result of the shape
//                                  petri-results-pane.js documents (artifact OBJECTS, a provenance record, source
//                                  'palette'), so a palette run lands where an Ask result lands, with the same footer.
//                                  showsInline says when a run is better left in the palette: nothing ran, so there is
//                                  no result to show, and the form with the error beside it is where the person fixes it.
//
// Nothing here asks a model for anything.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// A plain-data copy (what JSON can carry); {} for a value that is not an object or cannot be copied.
function plainArgs(v) {
    if (!isObj(v)) return {};
    try {
        const c = JSON.parse(JSON.stringify(v));
        return isObj(c) ? c : {};
    } catch {
        return {};
    }
}

// ---------------------------------------------------------------------------
// The palette's open option
// ---------------------------------------------------------------------------

/**
 * `open` as openPalette takes it, made safe: {id, args?, kind?} (`command` is accepted for `id`, as a provenance
 * call writes it) -> {id, kind, args}, or null when there is no id. `kind` is 'goal', 'command' or null (either);
 * `args` is a plain copy, {} when absent or not an object.
 * @param {*} open
 * @returns {{id: string, kind: 'goal'|'command'|null, args: Object}|null}
 */
export function parseOpen(open) {
    if (!isObj(open)) return null;
    const raw = typeof open.id === 'string' && open.id.trim() ? open.id : (typeof open.command === 'string' ? open.command : '');
    const id = raw.trim();
    if (!id) return null;
    return { id, kind: open.kind === 'goal' || open.kind === 'command' ? open.kind : null, args: plainArgs(open.args) };
}

/**
 * The palette entry an `open` names: a goal or a command (a classic tool has no form to open). With no `kind`, a
 * command wins over a goal of the same id (command ids have a dot, goal ids never do, so it does not arise today).
 * @param {{kind: string, id: string}[]} index petri-palette.js buildIndex's entries
 * @param {*} open
 * @returns {*|null}
 */
export function findOpenEntry(index, open) {
    const p = parseOpen(open);
    if (!p) return null;
    const hits = (index || []).filter((e) => e && e.id === p.id && (e.kind === 'goal' || e.kind === 'command'));
    if (p.kind) return hits.find((e) => e.kind === p.kind) || null;
    return hits.find((e) => e.kind === 'command') || hits[0] || null;
}

/**
 * A form model (petri-schema-form.js formModel / goalFormModel) with `args` filled in as the fields' defaults, so the
 * form opens as it was last run. The model is not changed: the fields are copied. A field a goal marks required
 * stays required (the value is only a default); an argument with no field is reported in `ignored` rather than
 * dropped without a word.
 * @param {{fields: any[], noForm: string|null}} model
 * @param {Object} [args]
 * @returns {{model: {fields: any[], noForm: string|null}, ignored: string[]}}
 */
export function prefillModel(model, args = {}) {
    const given = plainArgs(args);
    const fields = (model?.fields || []).map((f) => (own(given, f.name) && given[f.name] !== undefined ? { ...f, default: given[f.name] } : { ...f }));
    const known = new Set(fields.map((f) => f.name));
    const ignored = Object.keys(given).filter((k) => !known.has(k));
    return { model: { ...model, fields }, ignored };
}

/**
 * What "Open in Tools" opens for a provenance record: its first call, with the arguments it ran with. null when the
 * record has no call to open.
 * @param {{calls?: {command?: string, id?: string, args?: Object}[]}|null|undefined} record
 * @returns {{id: string, kind: 'command', args: Object}|null}
 */
export function openTargetFromRecord(record) {
    const c = record?.calls?.[0];
    const id = c && (c.command ?? c.id);
    if (typeof id !== 'string' || !id) return null;
    return { id, kind: 'command', args: plainArgs(c.args) };
}

// ---------------------------------------------------------------------------
// The hand-over to the results pane
// ---------------------------------------------------------------------------

const first0 = (steps) => steps.find((s) => s && s.command)?.command || '';

/**
 * Whether a palette run is better left in the palette than handed to the results pane: it failed outright (an error,
 * no call that ran, nothing stored). A failed command has no answer to show; the form it was run from, with the error
 * beside it, is where it gets fixed and run again. A goal that got part of the way (a step ran, or stored something)
 * is a result with warnings, so it goes on.
 * @param {{error?: string|null, calls?: any[], artifacts?: any[]}} outcome
 * @returns {boolean}
 */
export function showsInline(outcome) {
    return !!outcome?.error && !(outcome.calls || []).length && !(outcome.artifacts || []).length;
}

/**
 * The palette's outcome as a result for petri-results-pane.js showResult: the artifact objects the run stored (looked
 * up in `registry`), a provenance record (a goal run's calls and assumptions, or the one command that was run), the
 * goal, and the warnings (a refused step, an engine override, the error that stopped a goal part way). `source` is
 * 'palette', and there is no `answer`: nothing here is model text.
 * @param {*} outcome petri-palette.js outcomeOf's result
 * @param {{registry: {artifact: (id: string) => any}, net?: {cid?: string, revision?: number|string}, versions?: Object}} ctx
 * @returns {Promise<any>}
 */
export async function resultFromOutcome(outcome, { registry, net = {}, versions } = {}) {
    const P = await import('./petri-provenance.js');
    const o = outcome || {};
    const steps = Array.isArray(o.steps) ? o.steps : [];
    const goal = o.goal && o.goal.id ? o.goal : null;
    let record;
    if (goal) {
        record = P.recordFromGoalRun(goal, { ok: !o.error, steps }, { inputs: o.inputs || {}, net, versions });
    } else {
        const first = steps.find((s) => s && s.command) || (o.calls || [])[0];
        record = first
            ? P.recordFromCall({ command: first.command, args: first.args ?? {} }, { net, versions, warnings: o.error ? [String(o.error)] : [] })
            : P.provenance({ net, versions, warnings: o.error ? [String(o.error)] : [] });
    }
    const artifacts = [];
    for (const id of o.artifacts || []) {
        try {
            const a = registry.artifact(id);
            if (a) artifacts.push(a);
        } catch { /* evicted from the store since */ }
    }
    const warnings = [];
    for (const w of [...(o.warnings || []), ...(o.error ? [o.error] : [])]) {
        const t = String(w?.message ?? w);
        if (t && !warnings.includes(t)) warnings.push(t);
    }
    return {
        title: o.title || goal?.question || first0(steps) || 'Result',
        source: 'palette',
        goal: goal ? { id: String(goal.id), question: String(goal.question ?? '') } : null,
        record,
        artifacts,
        registry,
        answer: null,
        warnings,
        stale: false,
    };
}
