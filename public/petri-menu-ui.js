// petri-menu-ui.js — the editor's top bar: the Ask input, the File / View / Help menus, the Tools button and the host
// of the problems chip (docs/design/agent-first-analysis.md sections 3 and 8, Step 5). It replaces the hamburger's 25
// entries; the hamburger itself stays behind ?ui=classic for one release and in a standalone component (petri-view.js
// _createHamburgerMenu decides, petri-menu.js uiMode).
//
// What is in the bar, left to right:
//   Ask        one input. Enter (or the button) hands the words to view._openChat({mode: 'auto', message}); the Ask pane
//              (petri-chat-ui.js) does the rest, and what it does for a person who cannot chat (signed out, not allowed,
//              no chat: design section 9) is its own. Focusing the input opens nothing, and nothing is sent from here,
//              so there is no request for a signed-out person to be refused. The input lets go of the words only once
//              the pane has them in a form it can send (petri-menu.js askTaken): a person who cannot chat keeps what they
//              typed where they can see it.
//   File View Help
//              real menus (the ARIA menu button pattern): a button with aria-haspopup and aria-expanded, a popover with
//              role=menu whose rows take focus one at a time (arrow keys, Home, End, type-ahead), Escape closes and
//              returns focus to the button, a click outside closes. The entries are petri-menu.js menuModel, built when
//              the menu opens, so they always reflect who is signed in and what /api/files/status said. On a bar too
//              narrow for three buttons (a container query in petri-view.css) one "⋯" button holds all three.
//   Tools      petri-palette-ui.js toolsButton, always visible, with its Cmd-K hint; the chord is bound here, once.
//   problems   a host element: petri-view.js _mountProblems puts the "N problems" chip in it.
//   account    petri-view.js _createTopRightButton puts the Login / user button last in the bar.
//
// The view builds the bar once the editor is on screen (petri-view.js _createAppBar), not at page load: pflow.xyz holds the
// editor hidden behind the landing page, and a visitor who only reads that fetches none of this and has no Cmd-K. It is
// built after the JSON editor, but goes FIRST in the root: the bar is absolutely positioned, so its place in the DOM does
// nothing for the layout and everything for the Tab order, where Ace (which keeps Tab for indenting) would otherwise stand
// between the start of the page and every control in it.
//
// The popovers hang off <body>, not the bar: the Ask pane and the dialogs are stacked above the bar, and a menu opened
// from it must be above them. They are fixed to the viewport and placed from the button's rectangle on open.
//
// Thin on purpose: what the menus hold, how the arrow keys step and what Enter hands on are petri-menu.js, with tests.

import { ASK_PLACEHOLDER, MENU_LABELS, MENU_ORDER, askSubmit, askTaken, classicHref, flattenMenus, isFocusable, menuModel, menuStep, triggerKey, typeahead } from './petri-menu.js';
import { bindPaletteKey, toolsButton } from './petri-palette-ui.js';
import { isPaletteChord } from './petri-palette.js';

const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The view method an action runs (no arguments). Every id petri-menu.js menuModel can produce is here or in SPECIAL; a
 * test reads petri-view.js and holds each name to a method it has.
 */
export const METHOD_OF = {
    save: '_saveToPermalink',
    delete: '_deleteData',
    'account-save': '_showAccountSaveDialog',
    'account-open': '_showAccountFilesDialog',
    share: '_showShareDialog',
    gist: '_saveAsGist',
    diagrams: '_showMyDiagramsDialog',
    details: '_showEditDetailsDialog',
    download: 'downloadJSON',
    logout: '_logout',
    login: '_loginWithGitHub',
    layout: '_showLayoutAlgorithmsDialog',
    display: '_showDisplaySettingsDialog',
    app: '_openAppView',
    help: '_showHelpDialog',
};

/** Actions that are not one method call. */
const SPECIAL = {
    'json-editor': (view) => {
        if (view.hasAttribute('data-json-editor')) view.removeAttribute('data-json-editor');
        else view.setAttribute('data-json-editor', '');
    },
    classic: () => { window.location.assign(classicHref(window.location.href)); },
};

/** Every action id the bar can run. */
export const ACTION_IDS = [...Object.keys(METHOD_OF), ...Object.keys(SPECIAL)];

const GITHUB_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>';

function el(tag, className, attrs = {}) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
}

let popSeq = 0;

/**
 * Build the bar into the view's root. Returns {element, problemsHost, refresh, closeMenus, destroy}.
 * @param {any} view the <petri-view> (its _root, _openChat, _user, _authInitialized, _filesStatus, ...)
 */
export function mountAppBar(view) {
    const bar = el('div', 'pv-appbar', { role: 'group', 'aria-label': 'Ask, menus and tools' });

    // ---- Ask ----
    const form = el('form', 'pv-ask', { role: 'search', 'aria-label': 'Ask' });
    form.noValidate = true;
    const input = el('input', 'pv-ask-input', {
        type: 'text', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'send',
        placeholder: ASK_PLACEHOLDER, 'aria-label': 'Ask about this net, or say what to change',
        'data-palette-key': 'ok', // Cmd-K here still opens Tools (petri-palette-ui.js isTextFieldTarget)
    });
    const go = el('button', 'pv-ask-go', { type: 'submit', 'aria-label': 'Ask' });
    go.innerHTML = '<span class="pv-ask-go-text">Ask</span><span class="pv-ask-go-icon" aria-hidden="true">→</span>';
    form.append(input, go);
    let asking = false;
    // Did the pane take the words? Only if the person can send them (askTaken): a signed-out person's pane has a hidden form,
    // and the words in it are out of sight. /api/llm/status is the answer the pane has: a pane being opened fetches it afresh,
    // one already open has the last.
    const paneTookWords = async () => {
        try { return askTaken(await view._llmStatus?.()); } catch { return false; }
    };
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (asking) return;
        asking = true;
        try {
            const plan = askSubmit(input.value);
            const opened = await view._openChat(plan);
            // A pane that would not open, or that cannot use the words, leaves them here. Words typed since Enter stay too.
            if (opened !== false && plan.message && input.value.trim() === plan.message && await paneTookWords()) input.value = '';
        } finally {
            asking = false;
        }
    });

    // ---- menus ----
    const menus = el('div', 'pv-appbar-menus');
    const buttons = new Map();
    const makeTrigger = (id, label, className) => {
        const b = el('button', `pv-appbar-btn ${className}`, { type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-menu': id });
        b.innerHTML = id === 'more'
            ? '<span aria-hidden="true">⋯</span><span class="pv-sr-only">Menu</span>'
            : `${esc(label)} <span class="pv-appbar-caret" aria-hidden="true">▾</span>`;
        buttons.set(id, b);
        return b;
    };
    for (const id of MENU_ORDER) menus.appendChild(makeTrigger(id, MENU_LABELS[id], 'pv-appmenu-btn'));
    const more = makeTrigger('more', 'Menu', 'pv-appmenu-more');

    const tools = toolsButton(view);
    tools.classList.add('pv-appbar-tools');
    const problemsHost = el('span', 'pv-appbar-problems');

    bar.append(form, menus, more, tools, problemsHost);
    view._root.prepend(bar); // first, for the Tab order (see the header); it is out of the flow, so the layout does not move

    // ---- the popover ----
    // The open menu: its entries that are rows (an action or a link), those rows as elements, and how to take it down.
    /** @type {null | {id: string, button: HTMLElement, pop: HTMLElement, entries: any[], rows: HTMLElement[], cleanup: () => void}} */
    let openMenu = null;

    const state = () => menuModel({
        authenticated: !!(view._authInitialized && view._user),
        user: view._user,
        filesEnabled: view._filesEnabled === true,
        backend: true,
        version: view.constructor?.VERSION,
    });
    const entriesFor = (id) => (id === 'more' ? flattenMenus(state()) : state()[id] || []);

    function renderEntries(pop, entries) {
        pop.textContent = '';
        const rows = [];
        for (const e of entries) {
            if (e.kind === 'separator') {
                pop.appendChild(el('div', 'pv-hamburger-separator', { role: 'separator' }));
            } else if (e.kind === 'heading') {
                pop.appendChild(el('div', 'pv-appmenu-head', { role: 'presentation' })).textContent = e.label;
            } else if (e.kind === 'info') {
                pop.appendChild(el('div', 'pv-hamburger-user-info', { role: 'presentation' })).textContent = e.text;
            } else if (e.id === 'version') {
                const a = el('a', 'pv-menu-version', { role: 'menuitem', tabindex: '-1', href: e.href, target: '_blank', rel: 'noopener noreferrer', title: e.title || '' });
                a.textContent = e.label;
                a.dataset.id = e.id;
                a.dataset.label = e.label;
                pop.appendChild(a);
                rows.push(a);
            } else {
                const b = el('button', 'pv-menu-item', { type: 'button', role: 'menuitem', tabindex: '-1', 'data-id': e.id, 'data-label': e.label });
                if (e.title) b.title = e.title;
                if (e.icon) {
                    const i = el('span', 'pv-menu-item-icon', { 'aria-hidden': 'true' });
                    if (e.icon === 'github') i.innerHTML = GITHUB_SVG;
                    else i.textContent = e.icon;
                    b.appendChild(i);
                }
                b.appendChild(el('span')).textContent = e.label;
                pop.appendChild(b);
                rows.push(b);
            }
        }
        return rows;
    }

    function place(pop, button) {
        const r = button.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const narrow = window.matchMedia?.('(max-width: 760px)').matches;
        pop.style.maxHeight = '';
        pop.style.width = '';
        if (narrow) {
            pop.style.left = '8px';
            pop.style.width = `${vw - 16}px`;
        } else {
            const w = Math.min(pop.offsetWidth, vw - 16);
            pop.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
        }
        const top = r.bottom + 4;
        pop.style.top = `${top}px`;
        pop.style.maxHeight = `${Math.max(120, vh - top - 8)}px`;
    }

    function close(restoreFocus = true) {
        if (!openMenu) return;
        const m = openMenu;
        openMenu = null;
        m.cleanup();
        m.pop.remove();
        m.button.setAttribute('aria-expanded', 'false');
        m.button.removeAttribute('aria-controls');
        if (restoreFocus) m.button.focus();
    }

    function focusRow(i) {
        if (!openMenu || i < 0) return;
        openMenu.rows[i]?.focus();
    }

    function open(id, which = 'first') {
        const button = buttons.get(id);
        if (!button) return;
        close(false);
        const entries = entriesFor(id);
        const pop = el('div', 'pv-appmenu-pop', { role: 'menu', id: `pv-appmenu-${++popSeq}`, 'aria-label': id === 'more' ? 'Menu' : MENU_LABELS[id] });
        const rows = renderEntries(pop, entries);
        document.body.appendChild(pop);
        place(pop, button);
        button.setAttribute('aria-expanded', 'true');
        button.setAttribute('aria-controls', pop.id);

        const onKey = (e) => {
            if (isPaletteChord(e)) {
                close(true); // Tools opens over where the menu was: focus goes back to its button first (the chord goes on up to bindPaletteKey)
                return;
            }
            e.stopPropagation(); // the editor's own keys (1-9, x, Space, Delete) stay out of a menu
            const mine = openMenu?.rows || [];
            const at = mine.indexOf(document.activeElement);
            if (e.key === 'Escape') {
                e.preventDefault();
                close(true);
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                focusRow(menuStep(mine.map(() => true), at, e.key));
            } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && id !== 'more') {
                e.preventDefault();
                const order = MENU_ORDER;
                const next = order[(order.indexOf(id) + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
                open(next, 'first');
            } else if (e.key === 'Tab') {
                close(true); // focus is on the button again, and the browser's own Tab goes on from there
            } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
                focusRow(typeahead(mine.map((r) => ({ label: r.dataset.label, focusable: true })), at, e.key));
            }
        };
        const onClick = (e) => {
            const row = e.target.closest?.('[role="menuitem"]');
            if (!row) return;
            if (row.tagName === 'A') { close(false); return; } // a real link: the browser follows it
            e.stopPropagation();
            // The live list, not the one this menu opened with: refresh() redraws the rows when the files status or the
            // sign-in arrives late, and a row that was not in the first list is in this one.
            const entry = openMenu?.entries.find((x) => x.id === row.dataset.id);
            close(true);
            if (entry) runEntry(entry);
        };
        const onOutside = (e) => {
            if (pop.contains(e.target) || button.contains(e.target)) return;
            close(false);
        };
        const onResize = () => close(false);
        pop.addEventListener('keydown', onKey);
        pop.addEventListener('click', onClick);
        document.addEventListener('pointerdown', onOutside, true);
        window.addEventListener('resize', onResize);
        openMenu = {
            id, button, pop, entries: entries.filter(isFocusable), rows,
            cleanup: () => {
                pop.removeEventListener('keydown', onKey);
                pop.removeEventListener('click', onClick);
                document.removeEventListener('pointerdown', onOutside, true);
                window.removeEventListener('resize', onResize);
            },
        };
        focusRow(which === 'last' ? rows.length - 1 : 0);
    }

    function runEntry(entry) {
        if (entry.kind === 'link') {
            window.open(entry.href, '_blank', entry.href.startsWith('/') ? 'noopener' : 'noopener,noreferrer');
            return;
        }
        const run = SPECIAL[entry.id];
        const method = METHOD_OF[entry.id];
        Promise.resolve().then(() => {
            if (run) return run(view);
            if (typeof view[method] !== 'function') throw new Error(`${entry.label} is not available here`);
            return view[method]();
        }).catch((err) => view._toast(`${entry.label}: ${err?.message || err}`, 'error'));
    }

    for (const [id, button] of buttons) {
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (openMenu?.id === id) close(true);
            else open(id, 'first');
        });
        button.addEventListener('keydown', (e) => {
            const which = triggerKey(e.key);
            // Enter and Space are a click already (above); the arrows open the menu on the first or the last row.
            if (which && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                e.stopPropagation();
                open(id, which);
            } else if (e.key === 'Escape' && openMenu?.id === id) {
                e.stopPropagation();
                close(true);
            }
        });
    }

    // ---- what the menus depend on ----
    // The account lines of File and the server's files are read when a menu opens; a menu already open is redrawn when
    // the answer to /api/files/status comes in late.
    function refresh() {
        if (!openMenu) return;
        const { id, pop } = openMenu;
        const at = openMenu.rows.indexOf(document.activeElement);
        const entries = entriesFor(id);
        const rows = renderEntries(pop, entries);
        openMenu.rows = rows;
        openMenu.entries = entries.filter(isFocusable);
        place(pop, openMenu.button);
        if (at >= 0) rows[Math.min(at, rows.length - 1)]?.focus();
    }
    view._filesStatus?.().then((s) => {
        view._filesEnabled = !!s?.enabled;
        refresh();
    }).catch(() => {});

    // ---- Tools ----
    if (!view._unbindPaletteKey) view._unbindPaletteKey = bindPaletteKey(view);

    function destroy() {
        close(false);
        view._unbindPaletteKey?.();
        view._unbindPaletteKey = null;
        bar.remove();
    }

    return { element: bar, input, problemsHost, refresh, closeMenus: () => close(false), destroy };
}
