// The ten views' ids and tab labels, apart from their modules: the page draws
// its tabs (and reads #view=) before any view is loaded, because app.js imports
// a view's module on first use (loadView). No imports here, so state.js, ctx.js
// and app.js can all take it without a cycle. load-budget_test.ts holds
// VIEW_META equal to what each module exports as `title` and `short`.

export const VIEW_IDS = ['cospan', 'spiders', 'operad', 'string', 'flat', 'boundaries', 'lens', 'incidence', 'process', 'laws'];

export const VIEW_META = {
  cospan: { title: 'Open Petri nets as cospans', short: 'Cospans' },
  spiders: { title: 'Sync points as spiders (ZX-style)', short: 'Spiders' },
  operad: { title: 'Wiring diagrams (operad nesting)', short: 'Operad' },
  string: { title: 'String diagram', short: 'String' },
  flat: { title: 'The flattened net', short: 'Flat net' },
  boundaries: { title: 'Nets with boundaries', short: 'Boundaries' },
  lens: { title: 'Open games / lenses (analogy)', short: 'Lenses' },
  incidence: { title: 'Incidence matrices', short: 'Incidence' },
  process: { title: 'Runs as processes', short: 'Processes' },
  laws: { title: 'Composition laws (checked by Chyp)', short: 'Laws' },
};
