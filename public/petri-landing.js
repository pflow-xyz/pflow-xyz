// petri-landing.js — the landing page opens on a chat: say what you are working on, and it routes you
// into a session. First slice of docs/landing-chat.md: the in-page Assistant (petri-chat-ui.js, the
// GitHub-gated Gemini proxy) docked beside the canvas. The chat is the existing one: nothing here talks to
// a model. Pairing an MCP client with a tab is a later slice.
//
// The route is a suggestion, never a lock: Design, Analyse and Explain are the Assistant's modes, which it
// can change per message; Auto lets the server label the message; Explore is the composition page, which
// needs no sign-in. A person who cannot chat is told so before typing, and shown the connector instead of
// a chat that would answer 401.

/** The sessions the page offers. `mode` is the Assistant's (petri-chat-ui.js); `href` leaves for another page. */
export const ROUTES = [
  { id: 'auto', label: 'Let it decide', mode: 'auto', hint: 'Starts a session and picks build, analyse or explain from what you say.' },
  { id: 'design', label: 'Design', mode: 'build', hint: 'Build a net with the assistant, beside the canvas. Edits wait for your Apply.' },
  { id: 'analyse', label: 'Analyse', mode: 'analyse', hint: 'Ask what a net does. Results come from the engines, and the replies are the assistant\'s.' },
  { id: 'explore', label: 'Explore', href: '/compose.html', hint: 'See one composition in ten conventions, then build your own. No sign-in.' },
  { id: 'explain', label: 'Explain', mode: 'explain', hint: 'Ask about Petri nets or this net. It does not edit.' },
];

export const routeById = (id) => ROUTES.find((r) => r.id === id) || null;

/**
 * What the page can offer, from /api/llm/status: `chat` (signed in and allowed), `sign-in` (the chat is
 * on, this person is not signed in), `not-allowed` (signed in, not on PFLOW_LLM_ALLOW), `off` (no chat on this
 * server, or the status could not be read).
 */
export function landingState(status) {
  if (!status?.enabled || !status.chat) return 'off';
  if (!status.signed_in) return 'sign-in';
  return status.allowed === false ? 'not-allowed' : 'chat';
}

/**
 * What a submit does. A route that leaves leaves whoever you are; one that opens the Assistant needs a chat, or a
 * sign-in first (the words wait in the tab), or falls back to the editor, carrying nothing.
 *   {do: 'navigate', href} | {do: 'chat', mode, message} | {do: 'login', pending: {route, message}} | {do: 'editor'}
 */
export function planSubmit(routeId, text, status) {
  const route = routeById(routeId) || ROUTES[0];
  const message = String(text || '').trim();
  if (route.href) return { do: 'navigate', href: route.href };
  switch (landingState(status)) {
    case 'chat': return { do: 'chat', mode: route.mode, message };
    case 'sign-in': return { do: 'login', pending: { route: route.id, message } };
    default: return { do: 'editor' };
  }
}

/** What the page says under the prompt, for a state: {text, send (the button), connector (show the connector link)}. */
export function stateWords(state, status) {
  switch (state) {
    case 'chat': {
      const left = status?.remaining_today;
      return { text: `${left === undefined ? 'Signed in.' : `${left} model calls left today.`} Replies are Gemini's; results are the engines'.`, send: 'Start', connector: false };
    }
    case 'sign-in':
      return { text: 'The assistant uses Gemini, so it needs a GitHub sign-in for a fair-use limit. What you typed waits in this tab.', send: 'Sign in with GitHub and start', connector: true };
    case 'not-allowed':
      return { text: 'The assistant is limited to a list of accounts for now, and this one is not on it. The editor and your own client still work.', send: 'Open the editor', connector: true };
    default:
      return { text: 'The assistant is not available here. The editor and your own client still work.', send: 'Open the editor', connector: true };
  }
}

/**
 * The session a URL asks for: /?route=design opens the editor with the Assistant in that mode (also with ?cid=, a
 * stored net). Null for no route, an unknown one, or one that is another page.
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
    return routeById(p?.route)?.mode ? { route: p.route, message: String(p.message || '') } : null;
  } catch { return null; }
}

export function keepPending(store, pending) {
  try { store.setItem(PENDING, JSON.stringify(pending)); return true; } catch { return false; }
}

async function readStatus(view) {
  try { return await view._llmStatus(true); } catch { return null; }
}

/** Wire the page. Runs on every visit to `/`; the landing form exists whether or not it is the one shown. */
export async function initLanding({ doc = document, win = window } = {}) {
  await win.customElements.whenDefined('petri-view');
  const view = doc.querySelector('petri-view');
  if (!view) return;
  const showEditor = () => win.pflowShowEditor?.();

  // Back from GitHub with something typed, or a link that names a session.
  const pending = takePending(win.sessionStorage);
  const linked = routeFromSearch(win.location.search);
  if (pending || linked) {
    showEditor();
    await view._openChat({ mode: routeById(pending?.route)?.mode || linked.mode, message: pending?.message || '' });
    return;
  }

  const form = doc.getElementById('landing-chat');
  if (!form || form.closest('#landing')?.style.display === 'none') return;
  const input = doc.getElementById('landing-chat-input');
  const say = doc.getElementById('landing-chat-state');
  const send = doc.getElementById('landing-chat-send');
  const hint = doc.getElementById('landing-chat-hint');
  const connector = doc.getElementById('landing-chat-connector');
  const chosen = () => form.querySelector('input[name="route"]:checked')?.value || 'auto';

  let status = null;
  const paint = () => {
    const route = routeById(chosen());
    hint.textContent = route.hint;
    if (route.href) {
      say.textContent = '';
      send.textContent = 'Explore';
      connector.hidden = true;
      return;
    }
    const words = stateWords(landingState(status), status);
    say.textContent = words.text;
    send.textContent = words.send;
    connector.hidden = !words.connector;
  };
  form.addEventListener('change', paint);
  paint();
  status = await readStatus(view);
  paint();

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const plan = planSubmit(chosen(), input.value, status);
    if (plan.do === 'navigate') { win.location.href = plan.href; return; }
    if (plan.do === 'login') {
      keepPending(win.sessionStorage, plan.pending);
      view._loginWithGitHub();
      return;
    }
    showEditor();
    if (plan.do === 'chat') await view._openChat({ mode: plan.mode, message: plan.message });
  });
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && document.getElementById?.('landing-chat')) initLanding();
