// The view registry: every view the page can show, apart from its module. The page
// draws its tabs, its number keys and its index from this list, and reads #view=
// against it, before any view is loaded (app.js imports a view on first use), so
// there are no imports here and state.js, ctx.js and app.js can all take it without
// a cycle. (registry.js is another thing: pflow-native's command registry.)
//
// Adding a view is one entry here and one stored file; compose/VIEWS.md has the
// format and the steps. Nothing else in the page names a view. load-budget_test.ts
// holds each module's `title` and `short` equal to its entry, and
// views_registry_test.ts holds what a view says it consumes to what it reads.

const ENTRIES = [
  { id: 'cospan', short: 'Cospans', title: 'Open Petri nets as cospans', parity: true },
  { id: 'spiders', short: 'Spiders', title: 'Sync points as spiders (ZX-style)', parity: true },
  { id: 'operad', short: 'Operad', title: 'Wiring diagrams (operad nesting)', aliases: ['wiring'], parity: true },
  { id: 'string', short: 'String', title: 'String diagram', parity: true },
  { id: 'flat', short: 'Flat net', title: 'The flattened net', parity: true },
  { id: 'boundaries', short: 'Boundaries', title: 'Nets with boundaries', parity: true },
  { id: 'lens', short: 'Lenses', title: 'Open games / lenses (analogy)', aliases: ['lenses'], parity: true },
  { id: 'incidence', short: 'Incidence', title: 'Incidence matrices', parity: true },
  { id: 'process', short: 'Processes', title: 'Runs as processes', aliases: ['runs'], parity: true },
  { id: 'laws', short: 'Laws', title: 'Composition laws (checked by Chyp)', parity: true },
];

/** How a stored view is shown (stored-view.js). `module` is an ES module whose default export draws itself. */
export const VIEW_KINDS = ['module', 'image', 'video', 'html', 'text', 'json', 'file'];

export const VIEWS = ENTRIES.map((e) => ({ kind: 'module', src: `views/${e.id}.js`, aliases: [], parity: false, ...e }));
export const VIEW_IDS = VIEWS.map((v) => v.id);
export const VIEW_META = Object.fromEntries(VIEWS.map((v) => [v.id, v]));

/** The page's index of all views: linkable like a view, but not an entry (it is drawn from the entries). */
export const INDEX_VIEW = { id: 'index', short: 'All views', title: 'All views, with their links' };

export const EXAMPLES = [{ id: 'orders', label: 'orders' }, { id: 'connect4', label: 'connect-4' }];

/** A view id, an old or informal name for one, or the index, as the view's id; null for anything else. */
export function resolveView(name, views = VIEWS) {
  if (name === INDEX_VIEW.id) return name;
  return views.find((v) => v.id === name || v.aliases.includes(name))?.id ?? null;
}

/** The number key of the view at position i (from 0): 1..9, then 0 for the tenth; later views have none. */
export const viewKey = (i) => (i < 9 ? String(i + 1) : i === 9 ? '0' : null);

const STORED_AT = /^(?!\/|.*\.\.)[\w./-]+$|^https:\/\/cdn\.stackdump\.com\/ipfs\/[\w./-]+$/;

/** What is wrong with a registry entry, in words (none: a view the page can show). */
export function entryProblems(e) {
  const out = [];
  if (!/^[a-z0-9-]+$/.test(e.id || '')) out.push('its id must be lower-case letters, digits and hyphens: a link names it');
  if (e.id === INDEX_VIEW.id) out.push(`the id "${INDEX_VIEW.id}" is the page's index`);
  if (!e.short || !e.title) out.push('it needs a short label and a title');
  if (!VIEW_KINDS.includes(e.kind)) out.push(`no kind "${e.kind}" (${VIEW_KINDS.join(', ')})`);
  if (e.kind === 'module' && !/^views\/[\w/-]+\.js$/.test(e.src || '')) out.push('a module is stored under views/');
  if (e.kind !== 'module' && !STORED_AT.test(e.src || '')) out.push('a stored file is a path under compose/ or a cdn.stackdump.com/ipfs/ URL');
  if (e.kind !== 'module') {
    if (!e.source) out.push('a stored file says where it came from (source)');
    if (!e.convention?.summary) out.push('a stored file says what it shows (convention.summary)');
    if (!e.convention?.honesty?.length) out.push('a stored file says what in it is judgment (convention.honesty)');
    if (!Array.isArray(e.consumes)) out.push('a stored file says what it consumes (consumes; [] if nothing)');
  }
  return out;
}

/** What is wrong with a loaded view, in words: the page does not show one that cannot say where it comes from. */
export function viewProblems(v) {
  const c = v.convention || {};
  const out = [];
  if (!c.summary) out.push('it has no convention.summary');
  if (!c.honesty?.length) out.push('it marks no judgment (convention.honesty)');
  if (!c.bib?.length && !c.cites?.length && !v.source) out.push('it has no provenance (convention.bib, convention.cites or source)');
  if (!Array.isArray(v.consumes)) out.push('it does not say what it consumes (consumes)');
  return out;
}
