// petri-analysis-ui.js — the Structure dialog: pflow-native's structural
// analyses (invariants, siphons and traps, verify, reach, the reachability
// graph, incidence, canonical id, classes, validation) on the open net.
//
// Every button is one registry command (petri-commands.js); the native ones
// run in the wasm engine (petri-wasm.js), which loads on the first click. The
// dialog collects arguments and renders the artifacts that come back
// (petri-results.js), wiring their Show / Go buttons to artifact.show_set and
// sim.goto so a result points at the canvas. <petri-view> imports this only
// when the dialog is opened.

const ORDER = [
    'analysis.check', 'analysis.validate', 'analysis.invariants', 'analysis.siphons', 'analysis.verify',
    'analysis.reach', 'analysis.reachability', 'analysis.incidence', 'analysis.canonical', 'analysis.classify',
];

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function openStructureDialog(view) {
    const [reg, R, wasm] = await Promise.all([view.commands(), import('./petri-results.js'), import('./petri-wasm.js')]);
    if (!view._solverModule) view._solverModule = await import('./petri-solver.js');
    const specs = reg.list().filter((s) => ORDER.includes(s.id)).sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    const places = Object.keys(view.getModel().places || {});

    const overlay = document.createElement('div');
    overlay.className = 'pv-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pv-modal-dialog pv-modal-dialog-xl pv-structure-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Structure');
    dialog.innerHTML = `
        <div class="pv-dialog-header">
            <h2 class="pv-dialog-header-title">Structure</h2>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
        </div>
        <p class="pv-result-dim">What the net can and cannot do, from its arcs and its marking, before any simulation.
           These run in pflow-native's engine (wasm, about 1.6 MB, loaded on first use).</p>
        <div class="pv-structure-buttons">
            ${specs.map((s) => `<button type="button" class="pv-btn" data-cmd="${esc(s.id)}" title="${esc(s.help)}">${esc(s.label)}</button>`).join('')}
        </div>
        <details class="pv-structure-reach">
            <summary>Reach a marking: target counts (blank = any)</summary>
            <div class="pv-structure-targets">${places.map((p) => `<label>${esc(p)} <input type="number" min="0" step="1" data-target="${esc(p)}"></label>`).join('')}</div>
        </details>
        <div class="pv-structure-status" aria-live="polite"></div>
        <div class="pv-structure-results"></div>
        <div class="pv-btn-container">
            <button type="button" class="pv-btn" data-act="clear">Clear highlight</button>
            <button type="button" class="pv-btn" data-act="reset" title="Back to the marking before any Go">Reset marking</button>
            <button type="button" class="pv-btn" data-act="close">Close</button>
        </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const $ = (s) => dialog.querySelector(s);
    const status = (m) => { $('.pv-structure-status').textContent = m; };
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    dialog.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
    $('[data-act="clear"]').addEventListener('click', () => reg.execute('view.clear_highlight').catch(() => {}));
    $('[data-act="reset"]').addEventListener('click', () => reg.execute('sim.reset').catch((e) => status(e.message)));

    const argsFor = (id) => {
        if (id !== 'analysis.reach') return {};
        const to = {};
        dialog.querySelectorAll('[data-target]').forEach((i) => { if (i.value !== '') to[i.dataset.target] = Math.max(0, parseInt(i.value, 10) || 0); });
        if (!Object.keys(to).length) throw new Error('Reach needs at least one target count (open "Reach a marking").');
        return { to };
    };

    dialog.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.cmd;
        const spec = specs.find((s) => s.id === id);
        let args;
        try { args = argsFor(id); } catch (e) { status(e.message); $('.pv-structure-reach').open = true; return; }
        dialog.querySelectorAll('[data-cmd]').forEach((x) => { x.disabled = true; });
        status(spec.native && !wasm.engineState.loaded ? `Loading the analysis engine, then running ${spec.label}…` : `Running ${spec.label}…`);
        const before = new Set(reg.artifacts().map((a) => a.id));
        try {
            const out = await reg.execute(id, args);
            const made = reg.artifacts().filter((a) => !before.has(a.id));
            status('');
            const headline = out.summary || out.verdict || (out.answer ? `answer: ${out.answer}` : '') || '';
            const view_ = $('.pv-structure-results');
            view_.innerHTML = `<h3>${esc(spec.label)}</h3>${headline ? `<p>${esc(headline)}</p>` : ''}`
                + made.map((a) => `<section data-art="${esc(a.id)}"><h4>${esc(a.title)} <span class="pv-result-dim">${esc(a.data.kind)} · ${esc(a.id)}</span>
                    <button type="button" class="pv-btn" data-mcp="${esc(a.id)}" title="Copy the tools/call that re-runs this">Copy MCP call</button></h4>
                    <div class="pv-structure-art"></div></section>`).join('');
            for (const a of made) {
                const sec = view_.querySelector(`[data-art="${CSS.escape(a.id)}"]`);
                const box = sec.querySelector('.pv-structure-art');
                const r = R.renderArtifact(view._solverModule, a);
                box.innerHTML = (r.svg || '') + r.html;
                if (r.plotData) view._solverModule.SVGPlotter.setupInteractivity(r.plotData);
                R.wireArtifact(box, a, (cid, cargs) => reg.execute(cid, cargs), (m) => status(m));
                sec.querySelector('[data-mcp]').addEventListener('click', () => view._copyMcpCall(a));
            }
            if (!made.length) view_.innerHTML += R.reportHtml({ data: { kind: 'report', ...out } });
        } catch (e) {
            status(`${spec.label} failed: ${e.message}`);
        } finally {
            dialog.querySelectorAll('[data-cmd]').forEach((x) => { x.disabled = false; });
        }
    }));
    overlay.tabIndex = -1;
    overlay.focus();
}
