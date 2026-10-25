// petri-components-ui.js — the component palette: sim's calibration
// discipline as ready-made parts (arrivals, service, hazard, inventory,
// decision, mailbox, datastore) and pflow-compose's templates, added with
// compose.fuse (pflow-native's engine). Each port can be fused onto a place
// already in the net, so "arrivals into my queue, served by two agents" is
// two clicks, and the wiring rules come with the part, not the reviewer.

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function openComponents(view) {
    const reg = await view.commands();
    const dialogStatus = (msg) => { const el = document.querySelector('.pv-components-dialog .pv-structure-status'); if (el) el.textContent = msg; };
    let comps;
    try {
        comps = await reg.execute('compose.components');
    } catch (e) {
        view._toast('Components are not available here: ' + e.message, 'error');
        return;
    }
    const list = Array.isArray(comps) ? comps : comps.components || [];
    const places = () => Object.keys(view.getModel().places || {});

    const overlay = document.createElement('div');
    overlay.className = 'pv-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pv-modal-dialog pv-modal-dialog-wide pv-components-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Components');
    dialog.innerHTML = `
        <div class="pv-dialog-header">
            <h2 class="pv-dialog-header-title">Components</h2>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
        </div>
        <p class="pv-result-dim">Parts that already follow the modelling discipline. Fuse a port onto a place you have, or let it make a new one.</p>
        <div class="pv-goals-list">${list.map((c) => `<button type="button" class="pv-btn" data-comp="${esc(c.name)}" title="${esc(c.description || '')}">${esc(c.name)}</button>`).join('')}</div>
        <div class="pv-components-detail"></div>
        <div class="pv-structure-status" aria-live="polite"></div>
        <div class="pv-btn-container"><button type="button" class="pv-btn" data-act="close">Close</button></div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    dialog.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));

    const show = (c) => {
        const box = dialog.querySelector('.pv-components-detail');
        box.innerHTML = `
            <h3>${esc(c.name)}</h3><p>${esc(c.description || '')}</p>
            ${(c.discipline || []).length ? `<ul class="pv-result-dim">${c.discipline.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
            <div class="pv-goals-inputs">
                ${(c.ports || []).map((p) => `<div><label>port <strong>${esc(p.name)}</strong> (${esc(p.role)}) <select data-port="${esc(p.name)}"><option value="">a new place</option>${places().map((x) => `<option>${esc(x)}</option>`).join('')}</select></label> <span class="pv-result-dim">${esc(p.description || '')}</span></div>`).join('')}
                ${(c.params || []).map((p) => `<div><label>${esc(p.name)} <input type="number" step="any" data-param="${esc(p.name)}" value="${esc(p.default)}"></label> <span class="pv-result-dim">${esc(p.description || '')}</span></div>`).join('')}
                <div><label>prefix <input type="text" data-prefix value="${esc(c.name.replace(/[^a-z0-9_]/gi, '_'))}"></label></div>
            </div>
            <button type="button" class="pv-btn pv-btn-primary" data-act="add">Add to the net</button>`;
        box.querySelector('[data-act="add"]').addEventListener('click', async () => {
            const attach = {};
            box.querySelectorAll('[data-port]').forEach((s) => { if (s.value) attach[s.dataset.port] = s.value; });
            const params = {};
            box.querySelectorAll('[data-param]').forEach((i) => { if (i.value !== '') params[i.dataset.param] = parseFloat(i.value); });
            const prefix = box.querySelector('[data-prefix]').value.trim();
            try {
                const out = await reg.execute('compose.fuse', { component: c.name, attach, params, ...(prefix ? { prefix } : {}) });
                dialogStatus(`Added ${out.places?.length ?? 0} place(s) and ${out.transitions?.length ?? 0} transition(s). Undo removes them.`);
                view._refit?.();
            } catch (e) {
                dialogStatus(e.message);
            }
        });
    };
    dialog.querySelectorAll('[data-comp]').forEach((b) => b.addEventListener('click', () => show(list.find((c) => c.name === b.dataset.comp))));
}
