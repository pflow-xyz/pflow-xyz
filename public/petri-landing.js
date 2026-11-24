// petri-landing.js — the names a chat session can start under, and the words kept across a sign-in.
//
// pflow.xyz no longer has a landing page: / opens straight into the IDE (docs/ide-shell.md), and the page's hero chat,
// which sent a first message to the server's Gemini proxy, is gone with it. What stays is what the Ask pane
// (petri-chat-ui.js) still imports: the route ids and their modes, and keepPending/takePending, which carry typed
// words across the GitHub round trip in this tab only.

/**
 * The sessions a link can name. `mode` is the Assistant's (petri-chat-ui.js). `auto` is what happens when nothing
 * is forced: the hero's only route, and not a mode anyone is offered. `design` is the old name of `build`, kept
 * as an alias because /?route=design links exist in the wild.
 */
export const ROUTES = [
  { id: 'auto', label: 'Ask', mode: 'auto' },
  { id: 'build', label: 'Build', mode: 'build' },
  { id: 'design', alias: 'build' },
  { id: 'analyse', label: 'Analyse', mode: 'analyse' },
  { id: 'explain', label: 'Explain', mode: 'explain' },
];

/** A route by id, an alias resolved to the route it names; null for an id that is neither. */
export function routeById(id) {
  const r = ROUTES.find((x) => x.id === id);
  return r?.alias ? ROUTES.find((x) => x.id === r.alias) || null : r || null;
}

/**
 * The session a URL asks for: /?route=build (or the old /?route=design) opens the editor with the Assistant in that
 * mode (also with ?cid=, a stored net). Null for no route or an unknown one, which includes the destinations that
 * are not modes (explore, compose).
 */
export function routeFromSearch(search) {
  let id = null;
  try { id = new URLSearchParams(search).get('route'); } catch { return null; }
  const r = routeById(id);
  return r && r.mode ? r : null;
}

const PENDING = 'pflow_landing_pending';

/** The words kept across the GitHub round trip, in this tab only. Read once. */
export function takePending(store) {
  try {
    const raw = store.getItem(PENDING);
    if (raw === null) return null;
    store.removeItem(PENDING);
    const p = JSON.parse(raw);
    const r = routeById(p?.route);
    return r?.mode ? { route: r.id, message: String(p.message || '') } : null;
  } catch { return null; }
}

export function keepPending(store, pending) {
  try { store.setItem(PENDING, JSON.stringify(pending)); return true; } catch { return false; }
}
