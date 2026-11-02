// petri-menu.js — the pure part of the editor's top bar and of the Tools palette's hand-over to the results pane
// (docs/design/agent-first-analysis.md sections 3, 7, 8 and 9, Steps 4 and 5). No DOM, no network, no model: deno tests
// it directly, and petri-menu-ui.js (the bar) and petri-palette-ui.js (the dialog) are thin layers over it.
//
// What is here
//   the bar                        uiMode (the new bar, or the old hamburger behind ?ui=classic), menuModel (the entries
//                                  of File, View and Help, with the conditions the old hamburger had on sign-in and on
//                                  /api/files/status), flattenMenus (the same entries as one overflow menu on a narrow
//                                  bar), askSubmit (what Enter in the Ask input hands to the Ask pane), and the keyboard
//                                  of a menu (menuStep, typeahead, triggerKey).
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
// Removed as menu entries, and where each one went (the old hamburger keeps them all behind ?ui=classic):
//   Describe a process, Draft notes, Assistant      the Ask input (the Ask pane, mode build for the empty-canvas prompt)
//   Analysis, Simulate, Structure, Components,
//   Results, What do you want to know?, Check net   Tools > Classic tools (petri-palette-ui.js classicTools: the same
//                                                   dialogs); the questions are also Tools > Questions and the Ask input
//   Check net                                       the problems chip (petri-problems.js), whose list has a Details button
//   App view                                        View > Open as app
//   Composition Views                               View > Compose
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
// Which UI: the bar, or the old hamburger
// ---------------------------------------------------------------------------

export const UI_BAR = 'bar';
export const UI_CLASSIC = 'classic';

/**
 * Which menu the editor shows. The bar (Ask, File, View, Help, Tools, the problems chip) needs the server (the Ask
 * pane and the palette's results pane are served with it), so a standalone component, one with no data-backend, keeps
 * the single hamburger it has always had; and ?ui=classic keeps it for the one release the design promises
 * (agent-first-analysis.md, Step 5). petri-view.js _uiMode makes the same decision in three lines (it cannot import
 * this module before the page has chosen a menu); a smoke holds the two together.
 * @param {{backend?: boolean, search?: string}} [o] backend: the component has data-backend; search: location.search
 * @returns {'bar'|'classic'}
 */
export function uiMode({ backend = false, search = '' } = {}) {
    if (!backend) return UI_CLASSIC;
    let v = null;
    try {
        v = new URLSearchParams(String(search ?? '')).get('ui');
    } catch { /* an unreadable query is no choice */ }
    return v === UI_CLASSIC ? UI_CLASSIC : UI_BAR;
}

/**
 * The address of the page with ?ui=classic set, everything else (the model in `data` or `cid`, the hash) kept; the
 * href itself when it cannot be read as a URL.
 * @param {string} href
 * @returns {string}
 */
export function classicHref(href) {
    try {
        const u = new URL(String(href));
        u.searchParams.set('ui', UI_CLASSIC);
        return u.toString();
    } catch {
        return String(href ?? '');
    }
}

// ---------------------------------------------------------------------------
// The menus
// ---------------------------------------------------------------------------

export const MENU_ORDER = ['file', 'view', 'help'];
export const MENU_LABELS = { file: 'File', view: 'View', help: 'Help' };
export const ASK_PLACEHOLDER = 'Ask about this net, or say what to change...';

export const LINKS = {
    sim: 'https://sim.pflow.xyz',
    book: 'https://book.pflow.xyz',
    native: 'https://github.com/pflow-xyz/pflow-native',
    github: 'https://github.com/pflow-xyz/pflow-xyz',
    compose: '/compose.html',
};

/** The release page of a version, so a bug report can name the exact build it came from. */
export const releaseHref = (version) => `https://github.com/pflow-xyz/pflow-xyz/releases/tag/v${version}`;

/**
 * The name the account line shows, as the hamburger did: the email, else the user name, else "User".
 * @param {{email?: string, user_metadata?: {user_name?: string}}|null|undefined} user
 */
export function userLine(user) {
    return user?.email || user?.user_metadata?.user_name || 'User';
}

const item = (id, label, icon, extra = {}) => ({ kind: 'item', id, label, icon, ...extra });
const link = (id, label, icon, href, extra = {}) => ({ kind: 'link', id, label, icon, href, ...extra });
const SEP = Object.freeze({ kind: 'separator' });

/**
 * The entries of the three menus. Every entry the old hamburger had that is still a menu entry is here with the
 * condition it had; nothing about saving, sharing or signing in behaves differently.
 *
 * An entry is one of
 *   {kind: 'item', id, label, icon, title?}          runs the action called `id` (petri-menu-ui.js ACTIONS)
 *   {kind: 'link', id, label, icon, href, title?}    opens `href` in a new tab
 *   {kind: 'info', text}                             a line that is not an action (who is signed in)
 *   {kind: 'separator'}
 *
 * File     Save (to the server when signed in, else a permalink), Delete, Save to / Open from my account (only when
 *          /api/files/status says this server keeps them), Share, Save As Gist, My Diagrams, Edit Details (signed in
 *          only), Download JSON, then the account: who is signed in and Logout, or Login with GitHub.
 * View     Layout Algorithms, Display Settings, Toggle JSON editor, Open as app, and Compose (the composition page
 *          ships with the server only).
 * Help     Help, Sim, Book, Native App, GitHub, "Classic menu (this release)" (the way back to the old hamburger),
 *          and the version, which links to its release.
 *
 * `backend` false is what a standalone component could offer (no account, no server files, no Compose, no way back to
 * a menu it never left): that component keeps the old hamburger, so this is the contract rather than a second UI.
 *
 * @param {{authenticated?: boolean, user?: any, filesEnabled?: boolean, backend?: boolean, version?: string}} [o]
 *   authenticated: signed in (petri-view's _authInitialized && _user); filesEnabled: /api/files/status said enabled
 * @returns {{file: any[], view: any[], help: any[]}}
 */
export function menuModel({ authenticated = false, user = null, filesEnabled = false, backend = false, version = '' } = {}) {
    const file = [];
    if (backend) {
        file.push(item('save', authenticated ? 'Save to Server' : 'Save Permalink', '💾'));
        file.push(item('delete', 'Delete', '🗑️'));
        if (filesEnabled) {
            file.push(item('account-save', 'Save to my account…', '☁️'));
            file.push(item('account-open', 'Open from my account…', '🗂️'));
        }
        if (authenticated) {
            file.push(item('share', 'Share', '🔗'));
            file.push(item('gist', 'Save As Gist', '📝'));
            file.push(item('diagrams', 'My Diagrams', '📂'));
            file.push(item('details', 'Edit Details', '✏️'));
        }
    }
    file.push(item('download', 'Download JSON', '📥'));
    if (backend) {
        file.push(SEP);
        if (authenticated) {
            file.push({ kind: 'info', text: `Logged in as: ${userLine(user)}` });
            file.push(item('logout', 'Logout', '🚪'));
        } else {
            file.push(item('login', 'Login with GitHub', '🔑'));
        }
    }

    const view = [
        item('layout', 'Layout Algorithms', '🎨'),
        item('display', 'Display Settings', '⚙'),
        item('json-editor', 'Toggle JSON editor', '📝'),
        item('app', 'Open as app', '📱', { title: 'The App view: this net as an app, in the roles it derives' }),
    ];
    if (backend) {
        view.push(link('compose', 'Compose', '🧩', LINKS.compose, {
            title: "One composition drawn in ten conventions; every rule decided by pflow-native's registry",
        }));
    }

    const help = [
        item('help', 'Help', '❓'),
        link('sim', 'Sim — Run & Check', '📊', LINKS.sim),
        link('book', 'Book', '📖', LINKS.book),
        link('native', 'Native App', '🖥', LINKS.native),
        link('github', 'GitHub', 'github', LINKS.github),
    ];
    if (backend) {
        help.push(SEP);
        help.push(item('classic', 'Classic menu (this release)', '☰', { title: 'The single hamburger menu, as it was. Kept for one release.' }));
    }
    if (version) {
        help.push(link('version', `v${version}`, null, releaseHref(version), { title: `pflow-xyz v${version} — view release notes` }));
    }
    return { file, view, help };
}

/**
 * The three menus as one list, each under a heading: the overflow menu of a bar too narrow for three buttons.
 * @param {{file: any[], view: any[], help: any[]}} model
 * @returns {any[]} entries, plus {kind: 'heading', label}
 */
export function flattenMenus(model) {
    const out = [];
    for (const id of MENU_ORDER) {
        const entries = model?.[id] || [];
        if (!entries.length) continue;
        out.push({ kind: 'heading', label: MENU_LABELS[id] });
        out.push(...entries);
    }
    return out;
}

/** Whether a menu entry can take focus (an action or a link): not a line of text, a heading or a separator. */
export const isFocusable = (entry) => entry?.kind === 'item' || entry?.kind === 'link';

// ---------------------------------------------------------------------------
// The Ask input
// ---------------------------------------------------------------------------

/**
 * What Enter in the Ask input (or its button) hands to view._openChat: the server labels the intent (mode `auto`),
 * and the words go along when there are any. Empty words still open the pane, which then offers what to ask, so the
 * input is never one that does nothing. Whether the person can chat is the pane's question (design section 9: what it
 * does with the words signed out, off the allow-list and with no chat is the Ask pane's), not this one's: nothing is
 * sent from here.
 * @param {*} value the input's text
 * @returns {{mode: 'auto', message?: string}}
 */
export function askSubmit(value) {
    const message = typeof value === 'string' ? value.trim() : '';
    return message ? { mode: 'auto', message } : { mode: 'auto' };
}

// ---------------------------------------------------------------------------
// A menu's keyboard (the ARIA menu button pattern)
// ---------------------------------------------------------------------------

/**
 * The next row for an arrow key in an open menu: ArrowDown and ArrowUp move to the next and previous row that can take
 * focus and wrap round, Home and End go to the first and last; a key that moves nothing returns `current`. From no row
 * (-1) ArrowDown goes to the first, ArrowUp to the last.
 * @param {boolean[]} focusable one flag per row
 * @param {number} current the focused row, -1 for none
 * @param {string} key
 * @returns {number}
 */
export function menuStep(focusable, current, key) {
    const n = focusable.length;
    const rows = focusable.map((ok, i) => (ok ? i : -1)).filter((i) => i >= 0);
    if (!rows.length) return -1;
    switch (key) {
    case 'Home': return rows[0];
    case 'End': return rows[rows.length - 1];
    case 'ArrowDown': {
        for (let k = 1; k <= n; k++) { const i = (current + k + n) % n; if (focusable[i]) return i; }
        return current;
    }
    case 'ArrowUp': {
        if (current < 0) return rows[rows.length - 1];
        for (let k = 1; k <= n; k++) { const i = (current - k + n) % n; if (focusable[i]) return i; }
        return current;
    }
    default: return current;
    }
}

/**
 * Type-ahead: the next focusable row after `current` whose label starts with the typed character (wrapping round),
 * or -1 when none does. Case-insensitive; emoji icons are not part of a label.
 * @param {{label?: string, focusable?: boolean}[]} rows
 * @param {number} current
 * @param {string} ch one character
 * @returns {number}
 */
export function typeahead(rows, current, ch) {
    const c = String(ch ?? '').toLowerCase();
    if (c.length !== 1 || !rows.length) return -1;
    const n = rows.length;
    for (let k = 1; k <= n; k++) {
        const i = (current + k + n) % n;
        const r = rows[i];
        if (r?.focusable && String(r.label ?? '').trim().toLowerCase().startsWith(c)) return i;
    }
    return -1;
}

/**
 * What a key does on a menu's button: 'first' (open the menu on its first row: Enter, Space, ArrowDown), 'last'
 * (ArrowUp), or null (the key is not the button's).
 * @param {string} key
 * @returns {'first'|'last'|null}
 */
export function triggerKey(key) {
    if (key === 'ArrowUp') return 'last';
    if (key === 'ArrowDown' || key === 'Enter' || key === ' ') return 'first';
    return null;
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
