// petri-shell-ui.js — draws the shell (petri-shell.js decides): the docks, the tab strips, the splitters, the modal
// window, the command palette and the phone tab bar, around the <petri-view> that is already on the page.
//
// The editor is NOT moved. #editor-wrapper becomes a CSS grid and the docks are added to it as siblings, so the 9000-line
// component keeps its element, its state and its listeners. Everything the shell draws is built with createElement and
// addEventListener and styled by classes in petri-shell.css: no inline handler, no inline style, no eval.
//
// <pf-dock> is the one custom element: a tab strip and a body for one dock, rendered from the shell's layout.
//
// What other code uses (window.pflowShell, installed by mountShell):
//   open(evt)       any event (petri-shell.js Shell.dispatch): `show` {view, net|cid, params, note, request_id} by default,
//                   or {type: 'level'|'highlight'|'annotate'|'focus'|'tour'|'tour_control'|'stop', ...}
//   dispatch(evt)   the same, under the name that says what it does
//   close(id?)      close one view; with no id, a push's `stop`: the modal and every panel a push opened
//   state()         {panels, modal, views} for a tab report (ids and types only, never a net)
//   registry        register({type, kind, ...}) adds or replaces a view type (the notation panel does this)
//   diagnostics     {set(source, items), get(), on(fn)}
//   ready           a promise: resolves when the shell is mounted

import { DOCKS, LAYOUT_KEY, LEVELS, PHONE_MAX, Shell, ViewRegistry, emptyLayout, filterCommands, parseTarget } from './petri-shell.js';
import { h, registerBuiltins } from './petri-shell-views.js';
import { notationView } from './petri-shell-notation.js';
import { registerGuide } from './petri-shell-guide.js';

const WIDE_SPLIT = '(min-width: 1100px)';
const PHONE = `(max-width: ${PHONE_MAX}px)`;

// ---------------------------------------------------------------------------
// Diagnostics: one list anyone may publish into
// ---------------------------------------------------------------------------

function createDiagnostics() {
    const bySource = new Map();
    const subs = new Set();
    return {
        set(source, items) {
            const list = (Array.isArray(items) ? items : []).slice(0, 200).map((i) => ({
                severity: ['error', 'warn', 'info'].includes(i?.severity) ? i.severity : 'info',
                message: String(i?.message ?? '').slice(0, 500),
                source,
                ...(Array.isArray(i?.nodes) ? { nodes: i.nodes.map(String).slice(0, 50) } : {}),
                ...(Number.isInteger(i?.line) ? { line: i.line } : {}),
                ...(Number.isInteger(i?.col) ? { col: i.col } : {}),
            }));
            if (list.length) bySource.set(source, list); else bySource.delete(source);
            for (const fn of subs) fn();
        },
        get: () => [...bySource.values()].flat(),
        on(fn) { subs.add(fn); return () => subs.delete(fn); },
    };
}

// ---------------------------------------------------------------------------
// <pf-dock>
// ---------------------------------------------------------------------------

class PfDock extends HTMLElement {
    connectedCallback() {
        this.setAttribute('role', 'region');
        this.setAttribute('aria-label', `${this.dataset.dock} panels`);
    }
}
if (!customElements.get('pf-dock')) customElements.define('pf-dock', PfDock);

// ---------------------------------------------------------------------------

/**
 * Mount the shell on the editor wrapper. Resolves to the controller (also window.pflowShell).
 * @param {HTMLElement} wrapper  #editor-wrapper, with a <petri-view> child
 * @param {{storage?: Storage|null, view?: HTMLElement}} [o]
 */
export async function mountShell(wrapper, { storage = globalThis.localStorage, view = wrapper.querySelector('petri-view') } = {}) {
    await customElements.whenDefined('petri-view');
    const registry = registerBuiltins(new ViewRegistry());
    registry.register(notationView); // the real notation panel over the stand-in (POST /api/notation)
    registerGuide(registry); // the Examples and Connect windows, in the place of the old landing page
    let stored = null;
    try { stored = JSON.parse(storage?.getItem(LAYOUT_KEY) || 'null'); } catch { /* a bad value is the default layout */ }
    const shell = new Shell({ registry, layout: stored });
    const diagnostics = createDiagnostics();
    const mq = { phone: matchMedia(PHONE), split: matchMedia(WIDE_SPLIT) };
    /** @type {Map<string, {el: HTMLElement, inst: any, off: Function[]}>} mounted panels */
    const mounted = new Map();
    let reg = null;
    const netSubs = new Set();

    // ----- the editor, as ctx sees it
    const registryOf = async () => (reg ||= await view.commands());
    const execute = async (id, args = {}) => (await registryOf()).execute(id, args);
    view.addEventListener('jsonld-updated', () => { for (const fn of netSubs) fn(); });
    let solver = null;
    const newCtx = (id, offs) => ({
        shell,
        net: { get: () => view.exportJSON(), set: async (net, o = {}) => { await execute('file.load_json', { json: net }); return o; } },
        execute,
        artifact: (aid) => reg?.artifact(aid),
        parseTarget,
        on: (ev, fn) => {
            let off = () => {};
            if (ev === 'net') { netSubs.add(fn); off = () => netSubs.delete(fn); }
            else {
                // 'highlight' (targets changed), 'narration' (an annotation or a tour step), 'level'
                const kinds = { highlight: ['highlight'], narration: ['annotate', 'tour'], level: ['level'] }[ev];
                if (kinds) off = shell.subscribe((e) => { if (kinds.includes(e.kind)) fn(e); });
            }
            offs.push(off);
            return off;
        },
        diagnostics,
        reveal: (evt) => api.open(evt),
        solver: async () => (solver ||= await import('./petri-solver.js')),
        highlight: (ids) => execute('view.highlight', { nodes: ids, label: '' }).catch(() => {}),
        close: () => shell.close(id),
        resetLayout: () => { try { storage?.removeItem(LAYOUT_KEY); } catch { /* none */ } location.reload(); },
    });

    // ----- the skeleton
    wrapper.classList.add('pf-shell');
    const docks = {};
    for (const dock of DOCKS) {
        const el = document.createElement('pf-dock');
        el.dataset.dock = dock;
        el.classList.add('pf-dock');
        el.append(h('div', { class: 'pf-bar' }, h('div', { class: 'pf-tabs', role: 'tablist', 'aria-label': `${dock} panels` })), h('div', { class: 'pf-bodies' }));
        docks[dock] = el;
        wrapper.append(el);
    }
    // Splitters: a separator you drag or move with the arrow keys.
    for (const dock of ['left', 'right', 'bottom']) {
        const horizontal = dock === 'bottom';
        const sep = h('div', { class: `pf-sep pf-sep-${dock}`, role: 'separator', tabindex: '0', 'aria-orientation': horizontal ? 'horizontal' : 'vertical', 'aria-label': `Resize the ${dock} panel` });
        const set = (px) => shell.resize(dock, px);
        sep.addEventListener('keydown', (e) => {
            const step = e.shiftKey ? 64 : 16;
            const grow = dock === 'left' ? 'ArrowRight' : dock === 'right' ? 'ArrowLeft' : 'ArrowUp';
            const shrink = dock === 'left' ? 'ArrowLeft' : dock === 'right' ? 'ArrowRight' : 'ArrowDown';
            if (e.key === grow) { set(shell.layout.sizes[dock] + step); e.preventDefault(); }
            else if (e.key === shrink) { set(shell.layout.sizes[dock] - step); e.preventDefault(); }
        });
        sep.addEventListener('pointerdown', (e) => {
            sep.setPointerCapture(e.pointerId);
            const box = wrapper.getBoundingClientRect();
            const move = (m) => set(dock === 'left' ? m.clientX - box.left : dock === 'right' ? box.right - m.clientX : box.bottom - m.clientY);
            const up = () => { sep.removeEventListener('pointermove', move); sep.removeEventListener('pointerup', up); };
            sep.addEventListener('pointermove', move);
            sep.addEventListener('pointerup', up);
            e.preventDefault();
        });
        docks[dock].append(sep);
    }

    // The center bar: home, the commands button, and a live notice (a push replaced the canvas: Undo).
    const notice = h('p', { class: 'pf-notice', role: 'status', hidden: true });
    const cmdBtn = h('button', { class: 'pf-btn pf-cmd', type: 'button', title: 'Command palette (Ctrl+Shift+P)', text: 'Commands', on: { click: () => openPalette() } });
    const levelBtns = LEVELS.map((lv) => h('button', { class: 'pf-lvl', type: 'button', role: 'radio', 'data-level': lv, text: lv[0].toUpperCase() + lv.slice(1), title: lv === 'outcome' ? 'Plain-language answers only' : lv === 'model' ? 'The net, its notation and simulation' : 'Invariants, reachability, categorical views', on: { click: () => shell.setLevel(lv) } }));
    const levelBar = h('div', { class: 'pf-levels', role: 'radiogroup', 'aria-label': 'Level of detail' }, ...levelBtns);
    const guideBtn = (view, text, title) => h('button', { class: 'pf-btn pf-guide', type: 'button', 'data-view': view, title, text, on: { click: () => api.open({ view }) } });
    docks.center.querySelector('.pf-bar').append(h('div', { class: 'pf-center-tools' }, notice, levelBar,
        guideBtn('examples', 'Examples', 'Open an example model'), guideBtn('connect', 'Connect Claude', 'Connect your own Claude, and where to read more'), cmdBtn));
    // The narration strip: what an agent says (a tour step, an annotation), with the tour's controls.
    const narText = h('p', { class: 'pf-nar-text', role: 'status' });
    const narCtl = h('span', { class: 'pf-nar-ctl' });
    const narration = h('div', { class: 'pf-narration', hidden: true }, narText, narCtl);
    wrapper.append(narration);
    function drawNarration() {
        const t = shell.tour;
        const lines = [t?.say, ...shell.annotations.map((a) => a.text)].filter(Boolean);
        narration.hidden = !(t || lines.length);
        narText.textContent = lines.slice(-3).join(' ');
        narCtl.replaceChildren();
        if (t) {
            narCtl.append(h('span', { class: 'pf-nar-step', text: `${t.title}: step ${t.i + 1} of ${t.steps.length}` }),
                h('button', { class: 'pf-btn', type: 'button', text: 'Back', disabled: t.i === 0, on: { click: () => shell.tourBack() } }),
                h('button', { class: 'pf-btn', type: 'button', text: t.i === t.steps.length - 1 ? 'Finish' : 'Next', on: { click: () => (t.i === t.steps.length - 1 ? shell.tourEnd() : shell.tourNext()) } }),
                h('button', { class: 'pf-btn', type: 'button', text: 'End tour', on: { click: () => shell.tourEnd() } }));
        } else if (lines.length) {
            narCtl.append(h('button', { class: 'pf-btn', type: 'button', text: 'Dismiss', on: { click: () => { shell.annotations = []; shell.emit({ kind: 'annotate', id: '', text: '' }); } } }));
        }
    }
    const phonebar = h('nav', { class: 'pf-phonebar', 'aria-label': 'Panels' });
    wrapper.append(phonebar);

    const say = (text, action) => {
        notice.hidden = !text;
        notice.replaceChildren(text || '');
        if (text && action) notice.append(' ', h('button', { class: 'pf-link', type: 'button', text: action.label, on: { click: () => { action.run(); notice.hidden = true; } } }));
    };

    // ----- keeping the DOM in step with the layout
    const titleOf = (type) => registry.get(type)?.title ?? type;
    const isPhone = () => mq.phone.matches;

    function shownIds() {
        const L = shell.layout;
        const ids = new Set();
        if (isPhone()) {
            if (L.phone !== 'canvas') ids.add(L.phone);
            else if (L.level === 'outcome' && L.active.center) ids.add(L.active.center);
            return ids;
        }
        for (const dock of DOCKS) if (L.active[dock]) ids.add(L.active[dock]);
        return ids;
    }

    function canvasShown() {
        const L = shell.layout;
        if (L.level === 'outcome') return false;
        if (isPhone()) return L.phone === 'canvas';
        return !L.active.center || mq.split.matches;
    }

    function ensureMounted(id, payload) {
        const panel = shell.panels.get(id);
        if (!panel) return;
        const def = registry.get(panel.type);
        if (!def) return;
        let m = mounted.get(id);
        if (m && payload !== undefined) {
            if (m.inst?.update) { m.inst.update(payload); return; }
            unmount(id);
            m = null;
        }
        if (m) return;
        const body = h('div', { class: 'pf-panel', role: 'tabpanel', 'data-id': id });
        const offs = [];
        const ctx = newCtx(id, offs);
        let inst;
        try { inst = def.render(body, payload ?? panel.payload ?? null, ctx); } catch (e) { body.replaceChildren(h('p', { class: 'pf-status pf-err', role: 'alert', text: `${def.title}: ${e?.message || e}` })); }
        mounted.set(id, { el: body, inst, offs });
        docks[panelDock(id)].querySelector('.pf-bodies').append(body);
    }

    function unmount(id) {
        const m = mounted.get(id);
        if (!m) return;
        try { m.inst?.dispose?.(); } catch { /* a view's cleanup must not break the shell */ }
        for (const off of m.offs) off();
        m.el.remove();
        mounted.delete(id);
    }

    const panelDock = (id) => DOCKS.find((d) => shell.layout.docks[d].some((p) => p.id === id));

    function sync() {
        const L = shell.layout;
        const shown = shownIds();
        for (const id of [...mounted.keys()]) if (!panelDock(id)) unmount(id);
        const phone = isPhone();
        for (const dock of DOCKS) {
            const el = docks[dock];
            const list = L.docks[dock];
            el.dataset.empty = list.length || dock === 'center' ? '' : '1';
            if (!list.length && dock !== 'center') el.setAttribute('hidden', ''); else el.removeAttribute('hidden');
            const tabs = el.querySelector('.pf-tabs');
            const items = [];
            if (dock === 'center' && L.level !== 'outcome') {
                items.push(tab('canvas', 'Canvas', !L.active.center, false));
            }
            for (const p of list) items.push(tab(p.id, titleOf(p.type), L.active[dock] === p.id, true));
            tabs.replaceChildren(...items);
            for (const p of list) if (shown.has(p.id)) ensureMounted(p.id);
            for (const p of list) { const m = mounted.get(p.id); if (m) { m.el.toggleAttribute('data-shown', shown.has(p.id)); m.el.setAttribute('aria-labelledby', `pf-tab-${p.id}`); } }
        }
        wrapper.dataset.canvas = canvasShown() ? 'shown' : 'hidden';
        wrapper.dataset.level = L.level;
        for (const b of levelBtns) b.setAttribute('aria-checked', String(b.dataset.level === L.level));
        drawNarration();
        wrapper.dataset.split = !phone && mq.split.matches && L.active.center ? '1' : '';
        wrapper.dataset.phone = phone ? '1' : '';
        for (const dock of ['left', 'right', 'bottom']) {
            wrapper.style.setProperty(`--pf-${dock}`, !phone && L.docks[dock].length ? `${L.sizes[dock]}px` : '0px');
            const sep = docks[dock].querySelector('.pf-sep');
            sep.setAttribute('aria-valuenow', String(L.sizes[dock]));
        }
        // phone bar: canvas, every open panel, and the commands button
        phonebar.replaceChildren(
            ...(L.level === 'outcome' ? [] : [pbtn('canvas', 'Canvas', L.phone === 'canvas')]),
            ...DOCKS.flatMap((d) => L.docks[d]).map((p) => pbtn(p.id, titleOf(p.type), L.phone === p.id)),
            h('button', { class: 'pf-pbtn', type: 'button', text: '⋯', 'aria-label': 'Commands', on: { click: () => openPalette() } }));
        try { storage?.setItem(LAYOUT_KEY, shell.persist()); } catch { /* no storage */ }
    }

    function tab(id, title, active, closable) {
        const t = h('button', { class: 'pf-tab', role: 'tab', id: `pf-tab-${id}`, type: 'button', 'aria-selected': String(active), text: title, on: { click: () => shell.activate(id) } });
        if (!closable) return t;
        return h('span', { class: 'pf-tabwrap' }, t, h('button', { class: 'pf-tabclose', type: 'button', 'aria-label': `Close ${title}`, text: '×', on: { click: () => shell.close(id) } }));
    }
    const pbtn = (id, title, active) => h('button', { class: 'pf-pbtn', type: 'button', text: title, 'aria-current': active ? 'page' : false, on: { click: () => shell.activate(id) } });

    // ----- the modal window
    const dialog = h('dialog', { class: 'pf-modal', 'aria-labelledby': 'pf-modal-title' });
    const modalTitle = h('h2', { class: 'pf-modal-title', id: 'pf-modal-title' });
    const modalBody = h('div', { class: 'pf-modal-body' });
    dialog.append(h('header', { class: 'pf-modal-head' }, modalTitle, h('button', { class: 'pf-btn', type: 'button', text: 'Close', on: { click: () => shell.close() } })), modalBody);
    wrapper.append(dialog);
    let modalOffs = [], modalInst = null;
    // dialog.close() fires its `close` event a task later: a modal replaced by another must not close the new one.
    let ignoreClose = 0;
    const closeModalDom = () => {
        try { modalInst?.dispose?.(); } catch { /* ignore */ }
        for (const off of modalOffs) off();
        modalOffs = []; modalInst = null;
        modalBody.replaceChildren();
        if (dialog.open) { ignoreClose++; dialog.close(); }
    };
    dialog.addEventListener('close', () => {
        if (ignoreClose) { ignoreClose--; return; }
        if (shell.modal) shell.close(shell.modal.id);
    });
    // The editor listens for Escape on the document and may swallow it, which would cancel the dialog's own handling.
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); shell.close(); } });

    // ----- palette
    const palette = h('dialog', { class: 'pf-palette', 'aria-label': 'Command palette' });
    const pinput = h('input', { class: 'pf-input pf-pinput', type: 'text', placeholder: 'Type a command', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pf-plist', 'aria-autocomplete': 'list', autocomplete: 'off', spellcheck: 'false' });
    const plist = h('ul', { class: 'pf-plist', id: 'pf-plist', role: 'listbox' });
    palette.append(pinput, plist);
    wrapper.append(palette);
    let pitems = [], pcur = 0;
    const extra = () => [
        { id: 'tools', label: 'Tools… (every editor command)', group: 'Editor', run: { tools: true } },
        { id: 'check', label: 'Open Diagnostics', group: 'Panels', run: { open: { view: 'diagnostics' } } },
        ...LEVELS.map((lv) => ({ id: `level.${lv}`, label: `Level of detail: ${lv}`, group: 'Level', run: { level: lv } })),
    ];
    const allCommands = () => {
        const seen = new Set();
        return [...extra(), ...shell.commands()].filter((c) => !seen.has(c.id) && seen.add(c.id));
    };
    function drawPalette() {
        pitems = filterCommands(allCommands(), pinput.value).slice(0, 40);
        pcur = Math.min(pcur, Math.max(0, pitems.length - 1));
        plist.replaceChildren(...pitems.map((c, i) => h('li', { class: 'pf-pitem', role: 'option', id: `pf-p${i}`, 'aria-selected': String(i === pcur), on: { click: () => runCommand(c) } },
            h('span', { text: c.label }), h('span', { class: 'pf-pgroup', text: c.group }))));
        pinput.setAttribute('aria-activedescendant', pitems.length ? `pf-p${pcur}` : '');
    }
    function openPalette() { pinput.value = ''; pcur = 0; drawPalette(); if (!palette.open) palette.showModal(); pinput.focus(); }
    function runCommand(c) {
        if (palette.open) palette.close();
        const r = c.run || {};
        if (r.open) api.open(r.open);
        else if (r.level) shell.setLevel(r.level);
        else if (r.move) shell.move(r.move.id, r.move.dock);
        else if (r.close) shell.close(r.close.id);
        else if (r.reset) ctxReset();
        else if (r.tools) view._openPalette?.();
    }
    const ctxReset = () => { try { storage?.removeItem(LAYOUT_KEY); } catch { /* none */ } location.reload(); };
    pinput.addEventListener('input', () => { pcur = 0; drawPalette(); });
    pinput.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { pcur = Math.min(pitems.length - 1, pcur + 1); drawPalette(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { pcur = Math.max(0, pcur - 1); drawPalette(); e.preventDefault(); }
        else if (e.key === 'Enter' && pitems[pcur]) { runCommand(pitems[pcur]); e.preventDefault(); }
    });
    palette.addEventListener('click', (e) => { if (e.target === palette) palette.close(); });
    palette.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); palette.close(); } });
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) { e.preventDefault(); openPalette(); }
    });

    // ----- what happens when the shell opens something
    shell.subscribe(async (ev) => {
        if (ev.kind === 'open') {
            const payload = ev.payload;
            const def = registry.get(ev.type);
            // A pushed net goes on the canvas first, through the same strict gate a loaded file passes. The previous net is one Undo away.
            if (payload?.net && def && def.live !== false && ev.type !== 'result' && !ev.fallback) {
                try {
                    await execute('file.load_json', { json: payload.net });
                    say('Claude put a net on the canvas.', { label: 'Undo', run: () => execute('edit.undo').catch(() => {}) });
                } catch (e) { say(`The pushed net was refused: ${e?.message || e}`); }
            } else if (payload?.cid && def?.live !== false && ev.type !== 'categorical' && !ev.fallback) {
                say('A stored net (cid) was named; open it with ?cid= to load it.');
            }
            if (ev.modal) {
                closeModalDom();
                modalTitle.textContent = (ev.fallback ? ev.payload?.title : null) || def.title;
                const offs = modalOffs;
                try { modalInst = def.render(modalBody, payload, newCtx(ev.id, offs)); } catch (e) { modalBody.replaceChildren(h('p', { class: 'pf-status pf-err', role: 'alert', text: String(e?.message || e) })); }
                if (!dialog.open) dialog.showModal();
                return;
            }
            if (!ev.pinned) { ensureMountedAfterLayout(ev.id, payload); }
        } else if (ev.kind === 'close' && ev.modal) {
            closeModalDom();
        } else if (ev.kind === 'level') {
            // At the outcome level there is no canvas: the Answer panel is the centre.
            if (ev.level === 'outcome') { shell.open({ view: 'answer' }); mountAnswerNow(); }
            say(`Level of detail: ${ev.level}.`);
        } else if (ev.kind === 'refused') {
            const evt = ev.evt;
            say(`Claude wants to show ${registry.get(ev.view)?.title ?? ev.view}, which needs the ${ev.needs} level.`, { label: `Step down to ${ev.needs}`, run: () => { shell.setLevel(ev.needs); shell.dispatch(evt); } });
        } else if (ev.kind === 'highlight') {
            const nodes = ev.targets.map(parseTarget).filter((t) => t?.kind === 'node').map((t) => t.id);
            (nodes.length ? execute('view.highlight', { nodes, label: ev.label || '' }) : execute('view.clear_highlight', {})).catch(() => {});
            if (nodes.length && shell.layout.level !== 'outcome' && !canvasShown()) { /* the notation panel shows the same targets */ }
        }
        sync();
    });

    function mountAnswerNow() { sync(); ensureMounted('answer'); sync(); }

    // A panel's DOM exists only once sync() has placed it in a dock; open() changed the layout first, so mount now.
    function ensureMountedAfterLayout(id, payload) {
        sync();
        ensureMounted(id, payload ?? null);
        sync();
    }

    for (const q of Object.values(mq)) q.addEventListener('change', sync);
    sync();

    const api = {
        version: 1,
        registry,
        shell,
        diagnostics,
        open: (evt) => shell.dispatch(evt),
        dispatch: (evt) => shell.dispatch(evt),
        close: (id) => (typeof id === 'string' && (shell.modal?.id === id || shell.panels.has(id)) ? shell.close(id) : shell.stop() > 0),
        state: () => shell.state(),
        ready: Promise.resolve(),
    };
    api.ready = Promise.resolve(api);
    globalThis.pflowShell = api;
    wrapper.dispatchEvent(new CustomEvent('pflow-shell-ready', { bubbles: true }));
    return api;
}

export { emptyLayout };
