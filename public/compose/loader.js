// How the composition page loads (docs/compose-load-budget.md), apart from the DOM:
// the view loader and the start-up sequence, with every effect passed in, so a test
// can drive them (parity/composition-views/loader_test.ts). app.js wires the real ones.

import { brokenViewText } from './a11y-text.js';

/**
 * A view that says why it could not be loaded (a failed import, or a module with no default export): the stage
 * carries the message (the side card alone is out of the way of a reader who stays on the tab).
 */
export function brokenView(id, meta, why) {
  const view = { id, ...meta, broken: String(why), convention: { summary: `View ${id} failed to load: ${why}` }, render(ctx) { ctx.note(brokenViewText(view), 'warn'); } };
  return view;
}

/**
 * The views by id, each imported on first use. `importModule(id)` does the loading and stays in
 * app.js, relative to it. A failed import, and a module whose default export is missing, are kept as
 * a broken view: a view is never undefined once it is in `views`, so a render that waits for it
 * cannot wait for ever.
 */
export function createViewLoader({ importModule, meta }) {
  const views = new Map();   // id -> the view, once its module is loaded
  const loading = new Map(); // id -> the import in flight
  function load(id) {
    if (views.has(id)) return Promise.resolve(views.get(id));
    if (!loading.has(id)) {
      loading.set(id, new Promise((resolve) => resolve(importModule(id))).then(
        (m) => m?.default ?? brokenView(id, meta[id], 'its module has no default export'),
        (e) => brokenView(id, meta[id], e),
      ).then((v) => { views.set(id, v); loading.delete(id); return v; }));
    }
    return loading.get(id);
  }
  return { views, load };
}

/** The view a number key selects: 1..9, and 0 for the tenth. */
export function keyView(key, viewIds) {
  if (!/^[0-9]$/.test(key)) return null; // KeyboardEvent.key: one digit
  const n = key === '0' ? 10 : Number(key);
  return n <= viewIds.length ? viewIds[n - 1] : null;
}

/**
 * The page's start-up. Until the registry (the wasm) is ready, a tab, a key or a link only moves the
 * selection, in the order it happened: the tabs are repainted and the selected view's module is fetched
 * (preloadView; nothing evaluates it, because a view reads the ontology facts when its module is
 * evaluated, so evaluation waits for loadFacts()). Nothing renders before the registry and the view exist,
 * and when they do, what was selected last is what is drawn.
 *
 * `d` holds the effects: state, subscribe, actions, readHash, viewIds (the page's store), initRegistry,
 * loadFacts, start (the registry), loadView, preloadView(id, priority), fetchAlongside() (a promise for
 * what is fetched together with the wasm), renderShell(text), render, ready, failed(error), mark(name),
 * and optionally preloadDelay (ms, default 300).
 *
 * Phases: loading -> ready, or failed (the registry did not load: the page shows why and stays still).
 */
export function createStartup(d) {
  let phase = 'loading';
  let soon = null;
  const shell = () => d.renderShell('Loading pflow-native\'s registry (wasm)…');
  // The first fetch of a view module is the page's first view (a deep link, or the default): at once, at the
  // browser's own priority, beside the wasm. A selection made while loading (keys, tabs, links) fetches its view
  // only when it has held still for `preloadDelay` ms, and at low priority: pressing 1..9 in a burst fetches
  // the last view, not nine (231 KB in front of the wasm; on HTTP/1.1 a priority does not hold the others back,
  // so the delay is what does). Without it the view is fetched when the registry is ready.
  const preloadSoon = () => {
    clearTimeout(soon);
    soon = setTimeout(() => { soon = null; d.preloadView(d.state.view, 'low'); }, d.preloadDelay ?? 300);
  };
  const changed = () => { shell(); preloadSoon(); };
  const quiet = () => { clearTimeout(soon); soon = null; };
  let offShell = () => {};
  return {
    phase: () => phase,
    onHashChange() {
      d.readHash();
      if (phase === 'ready') d.render(); else if (phase === 'loading') changed();
    },
    onKey(e) {
      if (phase === 'failed' || e.target?.closest?.('input, textarea')) return;
      const view = keyView(e.key, d.viewIds);
      if (view) d.actions.setView(view);
      if (e.key === 'e') d.actions.setExample(d.state.example === 'orders' ? 'connect4' : 'orders');
    },
    /** Resolves true when the first view is drawn, false when the registry failed. */
    async run() {
      offShell = d.subscribe(changed);
      shell();
      d.preloadView(d.state.view, 'auto');
      d.mark('compose:shell');
      const alongside = d.fetchAlongside();
      try {
        await d.initRegistry();
        d.loadFacts();
        d.start();
        d.mark('compose:registry-ready');
      } catch (e) {
        phase = 'failed';
        offShell();
        quiet();
        d.failed(e);
        return false;
      }
      offShell();
      quiet();
      await Promise.all([d.loadView(d.state.view), alongside]); // the facts are in: evaluate the view
      d.subscribe(d.render);
      phase = 'ready';
      d.ready();
      d.render();
      return true;
    },
  };
}
