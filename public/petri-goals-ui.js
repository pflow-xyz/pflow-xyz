// petri-goals-ui.js — "What do you want to know?": the goal advisor without
// an LLM (ROADMAP phase 5). Pick a goal (or type it, and the catalog's
// phrases rank the goals), give any inputs it asks for, see the plan as the
// commands it will run, run it, and read each result with the answer's shape
// and its caveat. Works signed out. When the Assistant is on, "Ask the
// Assistant instead" hands the question to its analyse mode.

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function openGoals(view) {
    const [goalsMod, R, reg, status] = await Promise.all([
        import('./petri-goals.js'), import('./petri-results.js'), view.commands(), view._llmStatus().catch(() => ({})),
    ]);
    if (!view._solverModule) view._solverModule = await import('./petri-solver.js');
    const catalog = await goalsMod.loadGoals();
    const m = view.getModel();
    const places = Object.keys(m.places || {});
    const transitions = Object.keys(m.transitions || {});

    const overlay = document.createElement('div');
    overlay.className = 'pv-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pv-modal-dialog pv-modal-dialog-xl pv-goals-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'What do you want to know?');
    dialog.innerHTML = `
        <div class="pv-dialog-header">
            <h2 class="pv-dialog-header-title">What do you want to know?</h2>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
        </div>
        <input type="search" class="pv-goals-search" placeholder="In your words, e.g. “can it get stuck?”, “what if I had one more barista?”">
        ${status.enabled && status.chat ? '<button type="button" class="pv-btn" data-act="ask">Ask the Assistant instead</button>' : ''}
        <div class="pv-goals-list"></div>
        <div class="pv-goals-detail"></div>
        <div class="pv-structure-status" aria-live="polite"></div>
        <div class="pv-structure-results"></div>
        <div class="pv-btn-container"><button type="button" class="pv-btn" data-act="close">Close</button></div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const $ = (s) => dialog.querySelector(s);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    dialog.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
    $('[data-act="ask"]')?.addEventListener('click', async () => {
        const q = $('.pv-goals-search').value.trim();
        close();
        const panel = await view._openChat({ mode: 'analyse' });
        const input = document.querySelector('.pv-chat-input');
        if (input && q) input.value = q;
        return panel;
    });

    const inputHtml = (i) => {
        const id = `goal-in-${i.name}`;
        const lab = `<label for="${id}">${esc(i.label)}${i.optional ? ' (optional)' : ''}</label>`;
        if (i.kind === 'place' || i.kind === 'transition') {
            const list = i.kind === 'place' ? places : transitions;
            return `${lab} <select id="${id}" data-in="${esc(i.name)}">${i.optional ? '<option value="">(default)</option>' : ''}${list.map((p) => `<option>${esc(p)}</option>`).join('')}</select>`;
        }
        if (i.kind === 'number') return `${lab} <input id="${id}" type="number" step="any" data-in="${esc(i.name)}" value="${esc(i.default ?? '')}">`;
        if (i.kind === 'json') return `${lab} <textarea id="${id}" rows="2" spellcheck="false" data-in="${esc(i.name)}" placeholder="${esc(i.example ?? '')}">${esc(i.default === undefined ? '' : JSON.stringify(i.default))}</textarea>`;
        if (i.kind === 'marking') {
            return `<fieldset><legend>${esc(i.label)}</legend>${places.map((p) => `<label>${esc(p)} <input type="number" min="0" step="1" data-mark="${esc(p)}"></label>`).join(' ')}</fieldset>`;
        }
        return '';
    };

    const showGoal = (g) => {
        $('.pv-structure-results').innerHTML = '';
        $('.pv-structure-status').textContent = '';
        const plan = g.plan.map((s) => `<li><code>${esc(s.command)}</code> <span class="pv-result-dim">${esc(JSON.stringify(s.args))}</span></li>`).join('');
        $('.pv-goals-detail').innerHTML = `
            <h3>${esc(g.question)}</h3>
            <p><strong>The answer looks like:</strong> ${esc(g.answer)}</p>
            <p class="pv-goals-caveat"><strong>Caveat:</strong> ${esc(g.caveat)}</p>
            ${g.available === false ? '' : `
                <div class="pv-goals-inputs">${(g.inputs || []).map((i) => `<div>${inputHtml(i)}</div>`).join('')}</div>
                <details><summary>The plan (${g.plan.length} command${g.plan.length === 1 ? '' : 's'})</summary><ol>${plan}</ol></details>
                <button type="button" class="pv-btn pv-btn-primary" data-act="run">Run</button>`}`;
        $('[data-act="run"]')?.addEventListener('click', () => run(g));
    };

    const run = async (g) => {
        const inputs = {};
        dialog.querySelectorAll('[data-in]').forEach((el) => {
            inputs[el.dataset.in] = el.type === 'number' ? (el.value === '' ? '' : parseFloat(el.value)) : el.value;
        });
        const mark = {};
        dialog.querySelectorAll('[data-mark]').forEach((el) => { if (el.value !== '') mark[el.dataset.mark] = parseInt(el.value, 10); });
        for (const i of g.inputs || []) if (i.kind === 'marking') inputs[i.name] = Object.keys(mark).length ? mark : '';
        const res = $('.pv-structure-results');
        res.innerHTML = '';
        const btn = $('[data-act="run"]');
        btn.disabled = true;
        $('.pv-structure-status').textContent = 'Running…';
        try {
            const out = await goalsMod.runGoal(reg, g, inputs, (step) => {
                const sec = document.createElement('section');
                if (step.error) {
                    sec.innerHTML = `<h4><code>${esc(step.command)}</code> failed</h4><p>${esc(step.error)}</p>`;
                    res.appendChild(sec);
                    return;
                }
                const head = step.result?.why || step.result?.summary || step.result?.verdict || (step.result?.answer ? `answer: ${step.result.answer}` : '');
                sec.innerHTML = `<h4><code>${esc(step.command)}</code></h4>${head ? `<p>${esc(head)}</p>` : ''}`;
                res.appendChild(sec); // in the document before the plots wire their hover
                for (const id of step.artifacts || []) {
                    const art = reg.artifact(id);
                    const box = document.createElement('div');
                    const r = R.renderArtifact(view._solverModule, art);
                    box.innerHTML = `<div class="pv-result-dim">${esc(art.title)} · ${esc(art.id)}</div>${r.svg || ''}${r.html}`;
                    sec.appendChild(box);
                    if (r.plotData) view._solverModule.SVGPlotter.setupInteractivity(r.plotData);
                    R.wireArtifact(box, art, (cid, cargs) => reg.execute(cid, cargs), (msg) => { $('.pv-structure-status').textContent = msg; });
                }
            });
            $('.pv-structure-status').textContent = out.ok ? `Done. Remember: ${g.caveat}` : 'Stopped at the failing step.';
        } catch (e) {
            $('.pv-structure-status').textContent = e.message;
        } finally {
            btn.disabled = false;
        }
    };

    const list = (goals) => {
        $('.pv-goals-list').innerHTML = goals.map((g) => `<button type="button" class="pv-btn pv-goals-item${g.available === false ? ' pv-goals-off' : ''}" data-goal="${esc(g.id)}">${esc(g.question)}</button>`).join('')
            || '<p class="pv-result-dim">No goal matches those words; try fewer, or pick from the full list (clear the box).</p>';
        dialog.querySelectorAll('[data-goal]').forEach((b) => b.addEventListener('click', () => showGoal(catalog.goals.find((g) => g.id === b.dataset.goal))));
    };
    list(catalog.goals);
    $('.pv-goals-search').addEventListener('input', (e) => {
        const hits = goalsMod.matchGoals(catalog, e.target.value);
        list(hits);
        if (hits.length && e.target.value.trim()) showGoal(hits[0]);
    });
    $('.pv-goals-search').focus();
}
