// petri-draft-ui.js — "Describe a process, get a draft net" (guided modelling,
// slice 1). The dialog, the call to /api/llm/draft, the load gate
// (petri-draft.js) and the Draft notes panel.
//
// <petri-view> imports this only after /api/llm/status says drafting is
// enabled, so a vendored copy of the component (bitwrap-io), which has no
// /api/llm/* routes, never loads it. It drives the component through the same
// methods the component's own UI uses (setModel, the Sugiyama layout, the
// selection), so a draft lands as one undoable model change.
//
// Wording rule: the gate's verdicts are labelled "Check"; the summary and
// assumptions are labelled "Gemini's draft notes". No LLM output is presented
// as an engine result.

const DRAFT_KEY = 'pflow_draft_description';
const MAX = 2000;

const EXAMPLES = [
    ['Coffee shop', 'A coffee shop with two baristas. Customers arrive, queue, order, and leave once served or after waiting too long.'],
    ['Order pipeline', 'Online orders are placed, paid, packed and shipped. A fraud hold stops an order from being packed until it is cleared.'],
    ['Epidemic', 'An SIR epidemic in a town of 1000 people: susceptible people catch it from infected people, and infected people recover with immunity.'],
];

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function modal(title, ariaLabel) {
    const overlay = document.createElement('div');
    overlay.className = 'pv-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pv-modal-dialog pv-modal-dialog-wide pv-draft-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', ariaLabel || title);
    overlay.appendChild(dialog);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    return { overlay, dialog, close };
}

const isEmpty = (m) => !Object.keys(m.places || {}).length && !Object.keys(m.transitions || {}).length;

/** Open the Describe dialog. `view` is the <petri-view> element. */
export async function openDraftDialog(view, { description } = {}) {
    const status = await view._llmStatus(true);
    const { overlay, dialog, close } = modal('Describe a process');
    let saved = description ?? '';
    try { saved ||= sessionStorage.getItem(DRAFT_KEY) || ''; } catch { /* storage may be blocked */ }

    if (!status.signed_in) {
        dialog.innerHTML = `
            <div class="pv-dialog-header">
                <h2 class="pv-dialog-header-title">Describe a process</h2>
                <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
            </div>
            <p>Describe a process in words and get a first Petri net to read and edit.
               Drafting uses Gemini, so it needs a GitHub sign-in to apply a fair-use limit.</p>
            <textarea class="pv-draft-text" rows="5" maxlength="${MAX}" placeholder="What happens, who or what is involved, and what you want to know">${esc(saved)}</textarea>
            <div class="pv-btn-container">
                <button type="button" class="pv-btn pv-btn-primary" data-act="login">🔑 Login with GitHub</button>
                <button type="button" class="pv-btn" data-act="close">Cancel</button>
            </div>`;
        document.body.appendChild(overlay);
        dialog.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
        dialog.querySelector('[data-act="login"]').addEventListener('click', () => {
            // The OAuth round trip reloads the page; keep what was typed.
            try { sessionStorage.setItem(DRAFT_KEY, dialog.querySelector('.pv-draft-text').value); } catch { /* ignore */ }
            view._loginWithGitHub();
        });
        return;
    }

    const replacing = !isEmpty(view.getModel());
    dialog.innerHTML = `
        <div class="pv-dialog-header">
            <h2 class="pv-dialog-header-title">Describe a process</h2>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
        </div>
        <p>Say what happens, who or what is involved, and what you want to know. Gemini drafts a net;
           the editor checks it before it touches the canvas.</p>
        <textarea class="pv-draft-text" rows="6" maxlength="${MAX}">${esc(saved)}</textarea>
        <div class="pv-draft-row">
            <span class="pv-draft-count"></span>
            <span class="pv-draft-quota">${status.remaining_today ?? '?'} draft${status.remaining_today === 1 ? '' : 's'} left today</span>
        </div>
        <div class="pv-draft-examples">Try: ${EXAMPLES.map(([t], i) => `<button type="button" class="pv-btn pv-draft-example" data-ex="${i}">${esc(t)}</button>`).join(' ')}</div>
        ${replacing ? '<p class="pv-draft-note">This replaces the current net. Undo brings it back. <button type="button" class="pv-btn" data-act="download">Download it first</button></p>' : ''}
        <div class="pv-draft-progress" aria-live="polite"></div>
        <div class="pv-draft-result"></div>
        <div class="pv-btn-container">
            <button type="button" class="pv-btn pv-btn-primary" data-act="generate">Generate</button>
            <button type="button" class="pv-btn" data-act="close">Cancel</button>
        </div>`;
    document.body.appendChild(overlay);
    const $ = (s) => dialog.querySelector(s);
    const text = $('.pv-draft-text');
    const count = () => { $('.pv-draft-count').textContent = `${text.value.length} / ${MAX}`; };
    text.addEventListener('input', count);
    count();
    dialog.querySelectorAll('.pv-draft-example').forEach((b) => b.addEventListener('click', () => {
        text.value = EXAMPLES[+b.dataset.ex][1];
        count();
    }));
    $('[data-act="download"]')?.addEventListener('click', () => view.downloadJSON());

    let controller = null;
    const cancel = () => { controller?.abort(); close(); };
    dialog.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', cancel));
    const progress = (msg) => { $('.pv-draft-progress').textContent = msg; };
    const gen = $('[data-act="generate"]');

    gen.addEventListener('click', async () => {
        const desc = text.value.trim();
        if (!desc) { progress('Describe a process first.'); return; }
        try { sessionStorage.setItem(DRAFT_KEY, desc); } catch { /* ignore */ }
        gen.disabled = true;
        $('.pv-draft-result').innerHTML = '';
        controller = new AbortController();
        progress('Asking Gemini…');
        let body;
        try {
            const res = await fetch('/api/llm/draft', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${view._authToken}` },
                body: JSON.stringify({ description: desc }),
                signal: controller.signal,
            });
            body = await res.json().catch(() => ({}));
            if (!res.ok) {
                const wait = res.status === 429 && body.retry_after_s ? ` Try again in ${body.retry_after_s < 120 ? `${body.retry_after_s} s` : `${Math.round(body.retry_after_s / 3600)} h`}.` : '';
                progress(`${body.error || `The request failed (${res.status}).`}${wait}`);
                gen.disabled = false;
                return;
            }
        } catch (e) {
            if (e.name !== 'AbortError') progress(`The request failed: ${e.message}`);
            gen.disabled = false;
            return;
        }
        $('.pv-draft-quota').textContent = `${body.remaining_today} draft${body.remaining_today === 1 ? '' : 's'} left today`;
        progress('Checking the draft…');
        const { gateDraft, formatIssueList } = await loadGate();
        const gate = await gateDraft(body.draft);
        if (!gate.ok) {
            progress('');
            $('.pv-draft-result').innerHTML = `
                <h3>Check: the draft was not loaded (${gate.errors.length} problem${gate.errors.length === 1 ? '' : 's'})</h3>
                ${formatIssueList(gate.errors)}
                <details><summary>Show raw reply</summary><pre class="pv-result-json">${esc(JSON.stringify(body.draft, null, 2))}</pre></details>
                <p>Try again spends another draft; or edit the description first.</p>`;
            gen.textContent = 'Try again';
            gen.disabled = false;
            return;
        }
        close();
        loadDraft(view, desc, body.draft, gate);
    });
    text.focus();
}

let gateModule = null;
async function loadGate() {
    if (!gateModule) {
        const m = await import('./petri-draft.js');
        const { formatIssue } = await import('./petri-validate.js');
        gateModule = {
            gateDraft: m.gateDraft,
            formatIssueList: (issues) => `<ul class="pv-draft-issues">${issues.map((i) => `<li><code>${esc(formatIssue(i))}</code></li>`).join('')}</ul>`,
        };
    }
    return gateModule;
}

/** Put a gated draft on the canvas as one undoable change and show its notes. */
export function loadDraft(view, description, draft, gate) {
    view.setModel(gate.net); // normalizes, renders, refits, pushes history: Undo restores the previous net
    view._applySugiyamaLayout?.();
    view._renderUI?.();
    view._refit?.();
    view._syncLD?.();
    view._draftNotes = { description, draft, warnings: gate.warnings };
    showDraftNotes(view);
}

/** The Draft notes side panel: summary, assumptions, a legend that points at the canvas, rates. */
export function showDraftNotes(view) {
    const notes = view._draftNotes;
    if (!notes) return;
    document.querySelector('.pv-draft-notes')?.remove();
    const { draft } = notes;
    const panel = document.createElement('aside');
    panel.className = 'pv-draft-notes';
    panel.setAttribute('aria-label', 'Draft notes');
    const legend = (items, kind) => items.map((n) => `
        <li><button type="button" class="pv-draft-locate" data-id="${esc(n.id)}" title="Select and centre on the canvas">
            <strong>${esc(n.label)}</strong></button> <span class="pv-draft-kind">${kind}</span> ${esc(n.description)}</li>`).join('');
    panel.innerHTML = `
        <div class="pv-draft-notes-head">
            <h3>Gemini's draft notes</h3>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close">×</button>
        </div>
        <p>${esc(draft.summary)}</p>
        <h4>Assumptions</h4>
        <ul>${draft.assumptions.map((a) => `<li>${esc(a)}</li>`).join('') || '<li>None stated.</li>'}</ul>
        <h4>What each part stands for</h4>
        <ul class="pv-draft-legend">${legend(draft.places, 'place')}${legend(draft.transitions, 'transition')}</ul>
        <h4>Rates</h4>
        <p class="pv-draft-small">Now on each transition (Analysis uses them):
            ${draft.transitions.map((t) => `${esc(t.id)} = ${esc(t.rate)}`).join(', ')}</p>
        ${notes.warnings.length ? `<h4>Check: warnings</h4><ul>${notes.warnings.map((w) => `<li><code>${esc(w.path)}</code> ${esc(w.message)}</li>`).join('')}</ul>` : ''}
        <div class="pv-btn-container">
            <button type="button" class="pv-btn" data-act="regenerate" title="A new draft from the same description (spends one)">Regenerate</button>
        </div>`;
    document.body.appendChild(panel);
    panel.querySelector('[data-act="close"]').addEventListener('click', () => panel.remove());
    panel.querySelector('[data-act="regenerate"]').addEventListener('click', () => {
        panel.remove();
        openDraftDialog(view, { description: notes.description });
    });
    panel.querySelectorAll('.pv-draft-locate').forEach((b) => b.addEventListener('click', () => {
        const id = b.dataset.id;
        view._clearSelection?.();
        view._selectedNodes?.add(id);
        view._updateSelectionHighlights?.();
        view._centerOnNode?.(id);
    }));
}
