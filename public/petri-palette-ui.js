// petri-palette-ui.js — the command palette: Cmd-K / Ctrl-K, or the Tools
// button. The deterministic escape hatch of docs/design/agent-first-analysis.md
// (section 8): search the questions people ask and every registry command, open
// a form generated from the command's JSON Schema (or the goal's inputs), run
// it, read the result. No model is involved anywhere, so it works signed out,
// off the allow-list, over quota and when the model is down.
//
// The logic is in petri-palette.js (index, search, keyboard steps, the runners
// that say what happened) and petri-schema-form.js (the forms); this file only
// draws the dialog and wires the events.
//
// Running goes through the registry, view.commands(), for a command, and
// through runGoal (petri-goals.js) for a goal, so whatever guard the plan
// runner has applies here too. The outcome ({kind, title, goal, calls, steps,
// artifacts, error, warnings}) goes to onResult when the caller gave one (the
// palette then closes: the caller's results pane takes over), and is drawn in
// the dialog otherwise, with the renderer the goals dialog uses.
//
// Accessibility: role=dialog and aria-modal, a focus trap, Escape closes, the
// search box is a combobox (aria-activedescendant over a listbox, Up / Down /
// PageUp / PageDown / Enter), every form control is labelled and described,
// errors are role=alert, the live region says how many results there are.

import { usesCommandKey } from './petri-clipboard.js';
import {
    buildIndex, isPaletteChord, prefixLabel, previewJson, runCommandOutcome, runGoalOutcome, searchIndex,
    shortcutHint, stepActive, stepHeadline, trapTarget,
} from './petri-palette.js';
import { formModel, goalFormModel, readForm, renderFormHtml, showFormErrors } from './petri-schema-form.js';

const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const MAX_RESULTS = 60;
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

// The palette that is open, if any: one at a time.
let current = null;
let opening = null;
let counter = 0;

// The dialogs the menu used to open, as the palette's "Classic tools" entries.
// A method the view lacks (an older vendored petri-view.js) is left out.
/** @type {[string, string, string, string[]][]} id, title, the view's method, search words */
const CLASSIC = [
    ['classic.analysis', 'Analysis (ODE, scans, phase)', '_showSimulationDialog', ['ode', 'rate scan', 'sweep', 'phase plot']],
    ['classic.simulate', 'Simulate (stochastic, influence, what-if)', '_openWorkbench', ['ssa', 'sde', 'influence', 'heatmap', 'optimize']],
    ['classic.structure', 'Structure (invariants, verify, reach)', '_openStructureDialog', ['invariants', 'siphons', 'reachability graph']],
    ['classic.check', 'Check net', '_showCheckDialog', ['validate', 'problems']],
    ['classic.results', 'Results', '_showResultsDialog', ['artifacts', 'export', 'csv']],
    ['classic.components', 'Components', '_openComponents', ['palette', 'fuse']],
    ['classic.goals', 'What do you want to know?', '_openGoals', ['questions', 'goals']],
];

/**
 * The classic dialogs this view has, as {id, title, subtitle, keywords, open}.
 * @param {any} view
 * @returns {{id: string, title: string, subtitle: string, keywords: string[], open: () => any}[]}
 */
export function classicTools(view) {
    return CLASSIC.filter(([, , method]) => typeof view?.[method] === 'function')
        .map(([id, title, method, keywords]) => ({
            id, title, subtitle: 'Classic dialog', keywords, open: () => view[method](),
        }));
}

const NON_TEXT_INPUT = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image']);

/**
 * Whether a key event is aimed at somewhere the person is typing text: a
 * textarea, a text-like input or a contenteditable (looking through shadow
 * roots). A checkbox or a button is not.
 */
export function isTextFieldTarget(e) {
    let t = null;
    try {
        t = (typeof e?.composedPath === 'function' && e.composedPath()[0]) || e?.target || null;
    } catch {
        t = e?.target || null;
    }
    if (!t) return false;
    if (t.tagName === 'TEXTAREA' || t.isContentEditable === true) return true;
    return t.tagName === 'INPUT' && !NON_TEXT_INPUT.has(String(t.type || 'text').toLowerCase());
}

/**
 * Open the palette. Resolves to a handle {close, focus, setQuery} once the
 * dialog is up; a palette that is already open is focused instead.
 * @param {any} view the <petri-view> (commands(), getModel())
 * @param {{onResult?: (outcome: any) => any, initialQuery?: string}} [opts]
 */
export async function openPalette(view, { onResult, initialQuery = '' } = {}) {
    if (current) {
        if (initialQuery) current.setQuery(initialQuery);
        current.focus();
        return current;
    }
    opening ||= build(view, { onResult, initialQuery }).finally(() => { opening = null; });
    return opening;
}

async function build(view, { onResult, initialQuery }) {
    const opener = globalThis.document?.activeElement; // focus goes back here on close
    const [reg, R, goalsMod] = await Promise.all([view.commands(), import('./petri-results.js'), import('./petri-goals.js')]);
    let catalog = { goals: [] };
    try {
        catalog = await goalsMod.loadGoals();
    } catch { /* the questions are the nice part; the commands do not need them */ }
    const specs = reg.list();
    const classic = classicTools(view);
    const index = buildIndex({ specs, goals: catalog, classic });
    const uid = `pvpal${++counter}`;

    const overlay = document.createElement('div');
    overlay.className = 'pv-modal-overlay pv-palette-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pv-modal-dialog pv-modal-dialog-xl pv-palette';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', 'Tools');
    dialog.innerHTML = `
        <div class="pv-dialog-header">
            <h2 class="pv-dialog-header-title">Tools</h2>
            <button type="button" class="pv-dialog-close-icon" data-act="close" aria-label="Close" title="Close (Esc)">×</button>
        </div>
        <div class="pv-palette-pane" data-pane="list">
            <input type="text" class="pv-palette-search" role="combobox" aria-expanded="true" aria-autocomplete="list"
                aria-controls="${uid}-list" aria-label="Search tools" autocomplete="off" spellcheck="false"
                placeholder="Search: can it get stuck, stochastic, which engine, add place…">
            <div class="pv-palette-list" id="${uid}-list" role="listbox" aria-label="Tools"></div>
            <p class="pv-palette-hint pv-result-dim">Up and Down to move, Enter to open, Esc to close. Everything here runs without a model.</p>
            <div class="pv-palette-live" role="status" aria-live="polite"></div>
        </div>
        <div class="pv-palette-pane" data-pane="form" hidden></div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const $ = (s) => dialog.querySelector(s);
    const input = $('.pv-palette-search');
    const list = $('.pv-palette-list');
    const live = $('.pv-palette-live');
    const listPane = $('[data-pane="list"]');
    const formPane = $('[data-pane="form"]');
    let visible = [];
    let active = -1;
    let closed = false;

    // ---- the list ----

    const headingOf = (e) => (e.kind === 'command' ? `${e.section} · ${prefixLabel(e.subgroup)}` : e.section);

    const flags = (e) => {
        const f = [];
        if (!e.available) f.push(e.kind === 'goal' ? 'not in the browser yet' : 'not available here');
        else if (!e.form && e.kind === 'command') f.push('no form');
        if (e.kind === 'command' && e.coveredBy.length) {
            const g = (catalog.goals || []).find((x) => x.id === e.coveredBy[0]);
            if (g) f.push(`also answers “${g.question}”`);
        }
        return f.map((t) => `<span class="pv-palette-flag">${esc(t)}</span>`).join('');
    };

    const rowHtml = (e, n, tag) => `<div class="pv-palette-item${e.available ? '' : ' pv-palette-off'}" role="option" id="${uid}-o${n}" aria-selected="false" data-i="${n}">`
        + `<span class="pv-palette-title">${esc(e.title)}</span>`
        // an unavailable question's subtitle is its caveat, a paragraph: the flag and the form say it
        + (e.subtitle && !(e.kind === 'goal' && !e.available) ? `<span class="pv-palette-sub">${esc(e.subtitle)}</span>` : '')
        + (tag ? `<span class="pv-palette-tag">${esc(tag)}</span>` : '')
        + flags(e) + '</div>';

    function renderList() {
        const q = input.value.trim();
        if (!visible.length) {
            list.innerHTML = `<p class="pv-palette-empty pv-result-dim">No tool matches “${esc(q)}”. Try fewer words, or clear the box to browse.</p>`;
            return;
        }
        if (q) {
            // Ranked by relevance, so no headings: each row says what it is.
            list.innerHTML = visible.map((e, n) => rowHtml(e, n, e.kind === 'goal' ? 'question' : e.kind === 'classic' ? 'classic' : e.subgroup)).join('');
            return;
        }
        let html = '';
        let heading = null;
        let g = 0;
        visible.forEach((e, n) => {
            const h = headingOf(e);
            if (h !== heading) {
                if (heading !== null) html += '</div>';
                html += `<div role="group" aria-labelledby="${uid}-g${g}"><div class="pv-palette-head" role="presentation" id="${uid}-g${g++}">${esc(h)}</div>`;
                heading = h;
            }
            html += rowHtml(e, n, '');
        });
        list.innerHTML = `${html}</div>`;
    }

    function setActive(i) {
        const rows = list.querySelectorAll('[role="option"]');
        if (rows[active]) rows[active].setAttribute('aria-selected', 'false');
        active = i;
        if (i >= 0 && rows[i]) {
            rows[i].setAttribute('aria-selected', 'true');
            input.setAttribute('aria-activedescendant', rows[i].id);
            rows[i].scrollIntoView?.({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function refresh() {
        const q = input.value.trim();
        visible = searchIndex(index, q, { limit: q ? MAX_RESULTS : Infinity });
        renderList();
        active = -1;
        setActive(visible.length ? 0 : -1);
        live.textContent = visible.length ? `${visible.length} result${visible.length === 1 ? '' : 's'}` : 'No results';
    }

    // ---- the form ----

    const statusEl = () => formPane.querySelector('.pv-structure-status');

    function showList() {
        formPane.hidden = true;
        formPane.innerHTML = '';
        listPane.hidden = false;
        input.focus();
    }

    async function showOutcome(outcome, resultsEl) {
        resultsEl.innerHTML = '';
        const arts = [];
        for (const step of outcome.steps) {
            if (step.skipped) continue; // a step the plan chose not to run
            const sec = document.createElement('section');
            if (step.error) {
                sec.innerHTML = `<h4><code>${esc(step.command)}</code> failed</h4><p>${esc(step.error)}</p>`;
                resultsEl.appendChild(sec);
                continue;
            }
            const head = stepHeadline(step);
            sec.innerHTML = `<h4><code>${esc(step.command)}</code></h4>${head ? `<p>${esc(head)}</p>` : ''}`;
            resultsEl.appendChild(sec); // in the document before the plots wire their hover
            for (const id of step.artifacts || []) {
                try {
                    arts.push([sec, reg.artifact(id)]);
                } catch { /* evicted from the store since */ }
            }
            if (!(step.artifacts || []).length && step.result !== undefined) {
                const pre = document.createElement('pre');
                pre.className = 'pv-result-json';
                pre.textContent = previewJson(step.result);
                sec.appendChild(pre);
            }
        }
        if (arts.length && !view._solverModule) view._solverModule = await import('./petri-solver.js');
        for (const [sec, art] of arts) {
            const box = document.createElement('div');
            const r = R.renderArtifact(view._solverModule, art);
            box.innerHTML = `<div class="pv-result-dim">${esc(art.title)} · ${esc(art.id)}</div>${r.svg || ''}${r.html}`;
            sec.appendChild(box);
            if (r.plotData) view._solverModule.SVGPlotter.setupInteractivity(r.plotData);
            R.wireArtifact(box, art, (cid, cargs) => reg.execute(cid, cargs), (msg) => { statusEl().textContent = msg; });
        }
        for (const w of outcome.warnings) {
            const p = document.createElement('p');
            p.className = 'pv-goals-caveat';
            p.textContent = w;
            resultsEl.prepend(p);
        }
        if (outcome.error && !outcome.steps.some((s) => s.error)) {
            const p = document.createElement('p');
            p.className = 'pv-form-summary';
            p.textContent = outcome.error;
            resultsEl.appendChild(p);
        }
    }

    function showForm(entry) {
        const goal = entry.kind === 'goal' ? (catalog.goals || []).find((g) => g.id === entry.id) : null;
        const spec = entry.kind === 'command' ? specs.find((s) => s.id === entry.id) : null;
        const m = view.getModel?.() || {};
        const places = Object.keys(m.places || {});
        const transitions = Object.keys(m.transitions || {});
        const model = goal ? goalFormModel(goal) : formModel(spec.args);
        if (goal) {
            // Read the outcome off the search, as the goals dialog reads it off the question.
            const typed = input.value.trim();
            const found = typed ? goalsMod.inferPlace(m, typed) : '';
            if (found && places.includes(found)) {
                for (const f of model.fields) {
                    if (f.kind === 'place' && f.default === undefined) {
                        f.default = found;
                        f.help = `${f.help ? `${f.help} · ` : ''}from your search`;
                    }
                }
            }
        }
        const plan = goal && goal.plan?.length
            ? `<details><summary>The plan (${goal.plan.length} command${goal.plan.length === 1 ? '' : 's'})</summary><ol>${goal.plan.map((s) => `<li><code>${esc(s.command)}</code> <span class="pv-result-dim">${esc(JSON.stringify(s.args))}</span></li>`).join('')}</ol></details>`
            : '';
        const about = goal
            ? `<p><strong>The answer looks like:</strong> ${esc(goal.answer)}</p><p class="pv-goals-caveat"><strong>Caveat:</strong> ${esc(goal.caveat)}</p>`
            : `<p>${esc(spec.help || '')}</p>`
            + (entry.coveredBy.length ? `<p class="pv-result-dim">A question runs this command for you: ${entry.coveredBy.map((id) => esc((catalog.goals.find((g) => g.id === id) || {}).question || id)).join('; ')}.</p>` : '');
        const blocked = !entry.available
            ? `<p class="pv-goals-caveat">${goal ? esc(goal.caveat) : 'This command needs the editor view, which this host does not have.'}</p>`
            : '';
        const canRun = entry.available && !model.noForm;
        formPane.innerHTML = `
            <button type="button" class="pv-btn pv-btn-sm" data-act="back">← All tools</button>
            <h3 class="pv-palette-form-title">${esc(entry.title)}</h3>
            <p class="pv-palette-form-sub">${goal ? 'Question' : `<code>${esc(entry.id)}</code>`}</p>
            ${about}
            ${blocked}
            ${plan}
            <form class="pv-palette-form" novalidate>
                ${renderFormHtml(model, { esc, places, transitions, idPrefix: `${uid}-f` })}
                <div class="pv-form-summary" role="alert" hidden></div>
                <div class="pv-btn-container"><button type="submit" class="pv-btn pv-btn-primary" data-act="run"${canRun ? '' : ' disabled'}>Run</button></div>
            </form>
            <div class="pv-structure-status" role="status" aria-live="polite"></div>
            <div class="pv-structure-results"></div>`;
        listPane.hidden = true;
        formPane.hidden = false;
        formPane.querySelector('[data-act="back"]').addEventListener('click', showList);
        const form = formPane.querySelector('form');
        const summary = formPane.querySelector('.pv-form-summary');
        const results = formPane.querySelector('.pv-structure-results');
        const runBtn = formPane.querySelector('[data-act="run"]');
        form.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            if (!canRun || runBtn.disabled) return;
            const { args, errors } = readForm(form, model);
            showFormErrors(form, errors);
            summary.hidden = !errors.length;
            summary.textContent = errors.length ? `${errors.length === 1 ? 'One entry needs' : `${errors.length} entries need`} fixing before this can run.` : '';
            if (errors.length) {
                form.querySelector('[aria-invalid="true"]')?.focus();
                return;
            }
            runBtn.disabled = true;
            statusEl().textContent = 'Running…';
            results.innerHTML = '';
            let outcome;
            try {
                outcome = goal
                    ? await runGoalOutcome(reg, goal, args, goalsMod.runGoal)
                    : await runCommandOutcome(reg, spec.id, args, { title: spec.label });
            } finally {
                runBtn.disabled = false;
            }
            if (closed) return;
            if (onResult) {
                try {
                    await onResult(outcome);
                    close();
                    return;
                } catch (e) {
                    statusEl().textContent = `The result could not be shown: ${e?.message || e}`;
                }
            }
            await showOutcome(outcome, results);
            statusEl().textContent = outcome.error ? `Stopped: ${outcome.error}` : (goal ? `Done. Remember: ${goal.caveat}` : 'Done.');
        });
        (form.querySelector('[data-field]') || runBtn).focus();
    }

    function openEntry(entry) {
        if (!entry) return;
        if (entry.kind === 'classic') {
            const c = classic.find((x) => x.id === entry.id);
            close();
            c?.open();
            return;
        }
        showForm(entry);
    }

    // ---- events ----

    function close() {
        if (closed) return;
        closed = true;
        overlay.remove();
        if (current === handle) current = null;
        try {
            if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
        } catch { /* the opener is gone */ }
    }

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    dialog.querySelector('[data-act="close"]').addEventListener('click', close);
    overlay.addEventListener('keydown', (e) => {
        // The editor's own shortcuts (x runs the simulation, Delete deletes, Cmd-Z undoes) stay out of the dialog.
        e.stopPropagation();
        if (e.key === 'Escape' || isPaletteChord(e)) {
            e.preventDefault();
            close();
            return;
        }
        if (e.key === 'Tab') {
            const els = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && !el.closest('[hidden]'));
            const to = trapTarget(els.length, els.indexOf(document.activeElement), e.shiftKey);
            if (to !== null) {
                e.preventDefault();
                els[to].focus();
            }
        }
    });
    input.addEventListener('input', refresh);
    input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(e.key)) {
            e.preventDefault();
            setActive(stepActive(visible.length, active, e.key));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            openEntry(visible[active]);
        }
    });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // clicking a row keeps the caret in the search box
    list.addEventListener('click', (e) => {
        const row = e.target.closest?.('[role="option"]');
        if (row) openEntry(visible[+row.dataset.i]);
    });
    list.addEventListener('mousemove', (e) => {
        const row = e.target.closest?.('[role="option"]');
        if (row && +row.dataset.i !== active) setActive(+row.dataset.i);
    });

    const handle = {
        close,
        element: dialog,
        focus: () => { if (!formPane.hidden) showList(); else input.focus(); },
        setQuery: (q) => { if (!formPane.hidden) showList(); input.value = q; refresh(); },
    };
    current = handle;
    input.value = initialQuery;
    refresh();
    input.focus();
    return handle;
}

/**
 * Install the Cmd-K / Ctrl-K handler. The chord opens the palette (and closes
 * it again when it is open); preventDefault is for that chord only, and the
 * chord is left alone while the person is typing in a text field that is not
 * the palette, so a field keeps whatever Ctrl-K means to it.
 * @param {any} view
 * @param {Document} [doc]
 * @returns {() => void} unbind
 */
export function bindPaletteKey(view, doc = document) {
    const onKey = (e) => {
        if (!isPaletteChord(e) || e.defaultPrevented) return;
        if (current) {
            e.preventDefault();
            current.close();
            return;
        }
        if (isTextFieldTarget(e)) return;
        e.preventDefault();
        openPalette(view).catch((err) => view._toast?.(`Tools are not available here: ${err.message}`, 'error'));
    };
    doc.addEventListener('keydown', onKey);
    return () => doc.removeEventListener('keydown', onKey);
}

/**
 * The visible "Tools" button, with the shortcut beside it (⌘K on a Mac, Ctrl K
 * elsewhere). Opens the palette.
 * @param {any} view
 * @returns {HTMLButtonElement}
 */
export function toolsButton(view) {
    const hint = shortcutHint(usesCommandKey());
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pv-btn pv-btn-sm pv-tools-btn';
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-keyshortcuts', hint.aria);
    b.title = `Tools: every command, no model needed (${hint.text})`;
    b.innerHTML = `<span class="pv-tools-label">Tools</span> <kbd class="pv-tools-kbd" aria-hidden="true">${esc(hint.text)}</kbd>`;
    b.addEventListener('click', () => {
        openPalette(view).catch((err) => view._toast?.(`Tools are not available here: ${err.message}`, 'error'));
    });
    return b;
}
