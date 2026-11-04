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
    // Component text comes from sim's registry and names its tools (`sim_calibrate`, `diagnose`). Say what they do.
    const PLAIN = { diagnose: 'the influence check', calibrate: 'calibration' };
    const plain = (t) => String(t ?? '')
        .replace(/`/g, '')
        .replace(/\b(?:sim|mcp)_([a-z][a-z_]*)\b/g, (_, n) => PLAIN[n] || n.replace(/_/g, ' '))
        .replace(/\bdiagnose\b/g, PLAIN.diagnose);
    // The place a port most likely means: same name, then a name containing it, then one that names its role.
    const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
    const guess = (port) => {
        const all = places(), n = norm(port.name), r = norm(port.role || '');
        return all.find((x) => norm(x) === n) || all.find((x) => n && (norm(x).includes(n) || n.includes(norm(x)) && norm(x).length > 2))
            || (r && all.find((x) => norm(x).includes(r))) || '';
    };

    const overlay = document.createElement('div');
    overlay.className = 'pv-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pv-modal-dialog pv-modal-dialog-xl pv-components-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Components');
    dialog.innerHTML = `
        <div class="pv-dialog-header">
            <h2 class="pv-dialog-header-title">Components</h2>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
        </div>
        <p class="pv-result-dim">Parts that already follow the modelling discipline. Fuse a port onto a place you have, or let it make a new one.</p>
        <div class="pv-goals-list">${list.map((c) => `<button type="button" class="pv-btn" data-comp="${esc(c.name)}" title="${esc(plain(c.description))}">${esc(c.name)}</button>`).join('')}</div>
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
        dialog.querySelectorAll('[data-comp]').forEach((b) => {
            const on = b.dataset.comp === c.name;
            b.classList.toggle('pv-active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        const box = dialog.querySelector('.pv-components-detail');
        box.innerHTML = `
            <h3>${esc(c.name)}</h3><p>${esc(plain(c.description))}</p>
            ${(c.discipline || []).length ? `<ul class="pv-result-dim">${c.discipline.map((d) => `<li>${esc(plain(d))}</li>`).join('')}</ul>` : ''}
            <div class="pv-goals-inputs">
                ${(c.ports || []).map((p) => `<div><label>port <strong>${esc(p.name)}</strong> (${esc(p.role)}) <select data-port="${esc(p.name)}"><option value="">a new place</option>${places().map((x) => `<option${x === guess(p) ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label> <span class="pv-result-dim">${esc(plain(p.description))}</span></div>`).join('')}
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
