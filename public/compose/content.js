// Model content (pflow-native docs/composition-documents.md §3): what a model means, in data keyed by
// the model's own element ids, so a view reads it instead of hard-coding it per example. The entries come
// from the registry (content.get, through model.js); this module only reads what it is handed, so a
// different model draws its own prose or none.
//
// Honesty rules, held here so no view has to remember them (content_test.ts):
//  - a judgment reads as a judgment wherever it is shown: text() says so when the entry does not;
//  - a check is only ever marked by what content.check returned (the panel, content-panel.js): an unrun
//    check is not ticked, and a check claim is not a result;
//  - an entry whose element ids do not resolve against the open model is dormant and is not shown.

/** The kinds the panel lists, in its order. A `scenario` is not listed: the Process view and the lens test draw it. */
export const KINDS = [['finding', 'Findings'], ['caveat', 'Caveats'], ['judgment', 'Judgment'], ['note', 'Notes']];

/** An entry's text as a reader meets it: a judgment says it is one. */
export function entryText(e) {
  const t = e?.text || '';
  if (!t || e.kind !== 'judgment' || /\bjudg(e?)ment\b/i.test(t)) return t;
  return `Judgment: ${t}`;
}

/** What a check claims, or null: the check's own words, never a result. */
export function claimOf(e) {
  if (!e?.check) return null;
  if (typeof e.check === 'object') return e.check.claim || null; // content.get's form; a document holds it as text
  try { return JSON.parse(e.check).claim || null; } catch { return null; }
}

/** The empty reader of a model that has no content, or none readable. */
const NONE = { source: 'none', total: 0, dormant: 0, entries: [] };

/**
 * Reads one content.get result: {source, total, dormant, entries}. `source` is `none` for a bare model.
 * text(id) is '' when the open model has no such entry, or the entry is dormant: a view draws nothing then.
 */
export function contentReader(raw) {
  const c = raw && Array.isArray(raw.entries) ? raw : NONE;
  const byId = new Map(c.entries.map((e) => [e.id, e]));
  return {
    source: c.source || 'none',
    bare: !c.entries.length,
    dormant: c.dormant || 0,
    total: c.total ?? c.entries.length,
    entries: c.entries,
    entry: (id) => byId.get(id) || null,
    text: (id) => entryText(byId.get(id)),
    title: (id) => byId.get(id)?.title || '',
    /** A view's convention-example: the text it shows for this model in its convention panel. */
    example: (view) => c.entries.find((e) => e.kind === 'convention-example' && (e.views || []).includes(view))?.text || '',
    /** The panel's entries for a view: an entry that names the view or no view, by kind. */
    groups: (view) => KINDS.map(([kind, label]) => ({
      kind, label,
      entries: c.entries.filter((e) => e.kind === kind && (!e.views?.length || e.views.includes(view))),
    })).filter((g) => g.entries.length),
  };
}
