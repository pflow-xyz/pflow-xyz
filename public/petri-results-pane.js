// petri-results-pane.js — where a result lands (docs/design/agent-first-analysis.md sections 4.5 and 6).
//
// Every way of getting a result (the Ask pane's goals, the Tools palette, an opened link) hands it to
// showResult(view, result), so a result looks the same wherever it came from: the answer, the evidence, and the
// "How this was computed" footer with its five actions. This module is the one place that knows how.
//
// STATUS: the first version, a modal dialog with the evidence and the footer. The Ask pane work replaces it with the
// docked session list (the Results dialog's successor); the contract below is what callers rely on and stays.
//
// A result:
//   {
//     title:     string                    what was asked or run, in words
//     source:    'ask' | 'palette' | 'link' | 'classic'
//     goal:      {id, question} | null
//     record:    a petri-provenance.js record (provenance() / recordFromGoalRun() / recordFromCall())
//     artifacts: Array<{id, title, data, source}>   the artifact OBJECTS the calls stored (not ids)
//     registry:  the Registry that holds them and that "Rerun" / "Edit settings" run on (a sandbox, never the live net)
//     answer:    {by: 'assistant', text} | null     model text, always labelled as the assistant's
//     warnings:  string[]                  a refused step, an engine override, a drift notice
//     stale:     boolean                   the net changed since the result was made
//   }

import { footerHtml, wireFooter } from './petri-provenance.js';

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Show a result. Resolves to {close, element}. `view` is the <petri-view>; the footer's actions call the view's
 * optional hooks when it has them: view._copyMcpCall, view._copyViewLink(record), view._openPaletteFor(record).
 */
export async function showResult(view, result) {
    const R = await import('./petri-results.js');
    if (!view._solverModule) view._solverModule = await import('./petri-solver.js');
    const overlay = document.createElement('div');
    overlay.className = 'pv-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pv-modal-dialog pv-modal-dialog-xl pv-result-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', result.title || 'Result');
    dialog.innerHTML = `
        <div class="pv-dialog-header">
            <h2 class="pv-dialog-header-title">${esc(result.title || 'Result')}</h2>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
        </div>
        ${result.stale ? '<p class="pv-result-dim">The net has changed since this result was made.</p>' : ''}
        ${(result.warnings || []).map((w) => `<p class="pv-engine-warn">${esc(w)}</p>`).join('')}
        ${result.answer?.text ? `<p><span class="pv-prov-chip pv-prov-ast">assistant</span> ${esc(result.answer.text)}</p>` : ''}
        <div class="pv-result-evidence"></div>
        ${footerHtml(result.record, { open: true, stale: !!result.stale })}
        <div class="pv-btn-container"><button type="button" class="pv-btn" data-act="close">Close</button></div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const evidence = dialog.querySelector('.pv-result-evidence');
    for (const art of result.artifacts || []) {
        const box = document.createElement('div');
        const r = R.renderArtifact(view._solverModule, art);
        box.innerHTML = `<div class="pv-result-dim">${esc(art.title)} · ${esc(art.id)}</div>${r.svg || ''}${r.html}`;
        evidence.appendChild(box);
        if (r.plotData) view._solverModule.SVGPlotter.setupInteractivity(r.plotData);
        R.wireArtifact(box, art, (id, a) => result.registry.execute(id, a), (m) => view._toast(m, 'error'));
    }
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    dialog.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));
    const first = result.record?.calls?.[0];
    wireFooter(dialog, result.record, {
        mcp: () => view._copyMcpCall({ source: { command: first?.command, args: first?.args || {} } }),
        link: (rec) => (view._copyViewLink ? view._copyViewLink(rec) : view._toast('Copy link is not available here')),
        tools: (rec) => (view._openPaletteFor ? view._openPaletteFor(rec) : view._toast('Open in Tools is not available here')),
        rerun: () => view._toast('Rerun arrives with the Ask pane'),
        edit: () => view._toast('Edit settings arrives with the Ask pane'),
    });
    overlay.tabIndex = -1;
    overlay.focus();
    return { close, element: dialog };
}
