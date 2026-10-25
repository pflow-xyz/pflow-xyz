// petri-appview-ui.js — the App view: the net as an operator's console,
// docked beside the net (ROADMAP phase 7).
//
// sim.pflow.xyz presents a model as an app whose controls are the questions
// an operator asks; this is that console, built from the same derivation
// (petri-roles.js, sim's deriveRoles), with one difference that is this
// site's whole point: the net stays on screen, and every control shows — and
// on hover highlights — the places and transitions it touches, so the console
// teaches the design rather than hiding it.
//
// Controls: pools ("how many on shift"), arrival rates, patience, service
// rates. Disruptions derived from the roles, grouped by the question they
// ask. Run: a seeded sim.scenario with the overrides and disruptions merged
// (applyDisruptions), its results, and its assumptions and caveats verbatim
// (the "trust" screen). A net that declares views gets one tab per view,
// each showing only its places and transitions.

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const fmt = (v) => (typeof v === 'number' ? String(+v.toPrecision(4)) : String(v));

export async function openAppView(view) {
    document.querySelector('.pv-appview')?.remove();
    const [reg, rolesMod, R] = await Promise.all([view.commands(), import('./petri-roles.js'), import('./petri-results.js')]);
    if (!view._solverModule) view._solverModule = await import('./petri-solver.js');
    const net = view.getModel();
    if (!Object.keys(net.places || {}).length) {
        view._toast('The app view needs a net', 'error');
        return;
    }
    const rec = await reg.execute('sim.recommend').catch(() => ({ t_end: 8 }));
    const horizon = Math.min(168, Math.max(1, rec.t_end || 8));
    const { roles, disruptions } = rolesMod.rolesOf(net, horizon);
    const name = (id) => rolesMod.labelFor(roles, id);
    const views = Array.isArray(net.views) ? net.views : [];

    const panel = document.createElement('aside');
    panel.className = 'pv-appview';
    panel.setAttribute('aria-label', 'App view');
    document.body.appendChild(panel);
    let current = null; // a view id, or null for everything
    const overrides = { marking: {}, rates: {} };

    const inView = (id) => {
        if (!current) return true;
        const v = views.find((x) => x.id === current);
        return !v || (v.places || []).includes(id) || (v.transitions || []).includes(id) || (!(v.places || []).length && !(v.transitions || []).length);
    };
    const touches = (ids) => `<span class="pv-appview-touch">touches ${ids.map(esc).join(', ')}</span>`;

    const row = (kind, id, labelText, value, nodes, opts = {}) => inView(id) ? `
        <div class="pv-appview-row" data-hl="${esc(nodes.join(','))}">
            <label>${esc(labelText)} ${touches(nodes)}</label>
            <input type="number" min="0" step="${opts.step ?? 'any'}" data-${kind}="${esc(id)}" value="${esc(fmt(value))}">
        </div>` : '';

    // A heading only over rows the current view shows.
    const section = (title, rows) => (rows.join('').trim() ? `<h4>${esc(title)}</h4>${rows.join('')}` : '');

    const render = () => {
        const groups = rolesMod.groupDisruptions(disruptions.filter((d) => {
            const ids = [...Object.keys(d.marking || {}), ...Object.keys(d.rates || {}), ...Object.keys(d.schedule || {}), ...(d.amount ? [d.amount.place] : [])];
            return ids.some(inView);
        }));
        panel.innerHTML = `
            <div class="pv-chat-head"><strong>App view</strong>
                <button type="button" class="pv-btn" data-act="share" title="Copy the net in sim.pflow.xyz's model shape">Copy for sim</button>
                <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close">×</button></div>
            <p class="pv-result-dim">The questions this net lets an operator ask, derived from its shape. Hover a control to see what it touches.</p>
            ${views.length ? `<div class="pv-appview-views"><button type="button" class="pv-btn${current ? '' : ' pv-active'}" data-view="">All</button>${views.map((v) => `<button type="button" class="pv-btn${current === v.id ? ' pv-active' : ''}" data-view="${esc(v.id)}" title="${esc(v.prompt || '')}">${esc(v.title || v.id)}${v.role ? ` · ${esc(v.role)}` : ''}</button>`).join('')}</div>` : ''}
            ${section('What if I had more…', roles.pools.map((p) => row('pool', p.id, name(p.id), overrides.marking[p.id] ?? p.initial, p.members || [p.id], { step: 1 })))}
            ${section('How fast work arrives', roles.sources.map((s) => row('rate', s.id, name(s.id), overrides.rates[s.id] ?? s.rate, [s.id])))}
            ${section('How soon people give up', roles.losses.map((l) => row('rate', l.id, name(l.id), overrides.rates[l.id] ?? l.rate, [l.id])))}
            ${section('How fast each step is done', roles.services.map((s) => row('rate', s.id, name(s.id), overrides.rates[s.id] ?? s.rate, [s.id])))}
            ${roles.delayed.length ? `<p class="pv-result-dim">No rate control for ${roles.delayed.map(esc).join(', ')}: fixed durations.</p>` : ''}
            ${groups.length ? `<h4>What if…</h4>${groups.map((g) => `<details${disruptions.length <= 12 ? ' open' : ''}><summary>${esc(g.question)} <span class="pv-result-dim">${g.items.length}</span></summary>
                ${g.items.map((d) => `<div class="pv-appview-row" title="${esc(d.description)}"><label><input type="checkbox" data-disrupt="${esc(d.id)}"> ${esc(d.label)}</label>${d.amount ? `<input type="number" min="0" max="${d.amount.max}" value="${d.amount.default}" data-amount="${esc(d.id)}">` : ''}</div>`).join('')}</details>`).join('')}` : ''}
            <h4>Run</h4>
            <div class="pv-appview-row"><label>hours</label><input type="number" min="1" max="168" data-run="hours" value="${horizon}"></div>
            <div class="pv-appview-row"><label>runs</label><input type="number" min="1" max="200" data-run="realizations" value="16"></div>
            <div class="pv-appview-row"><label>seed</label><input type="number" min="0" data-run="seed" value="7"></div>
            <button type="button" class="pv-btn pv-btn-primary" data-act="run">Run the day</button>
            <div class="pv-structure-status" aria-live="polite"></div>
            <div class="pv-appview-results"></div>`;
        wire();
    };

    const wire = () => {
        const $ = (s) => panel.querySelector(s);
        $('[data-act="close"]').addEventListener('click', () => { reg.execute('view.clear_highlight').catch(() => {}); panel.remove(); });
        $('[data-act="share"]').addEventListener('click', async () => {
            const out = await reg.execute('file.export_sim');
            view._copyToClipboard(JSON.stringify(out.model, null, 2), () => view._toast('Copied: paste into sim.pflow.xyz (sim_create_model)'), () => view._toast('Copy failed'));
        });
        panel.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { current = b.dataset.view || null; render(); }));
        panel.querySelectorAll('[data-hl]').forEach((r) => {
            r.addEventListener('mouseenter', () => reg.execute('view.highlight', { nodes: r.dataset.hl.split(',').filter(Boolean) }).catch(() => {}));
            r.addEventListener('mouseleave', () => reg.execute('view.clear_highlight').catch(() => {}));
        });
        panel.querySelectorAll('[data-pool]').forEach((i) => i.addEventListener('change', () => { overrides.marking[i.dataset.pool] = Math.max(0, parseInt(i.value, 10) || 0); }));
        panel.querySelectorAll('[data-rate]').forEach((i) => i.addEventListener('change', () => { overrides.rates[i.dataset.rate] = Math.max(0, parseFloat(i.value) || 0); }));
        $('[data-act="run"]').addEventListener('click', run);
    };

    const run = async () => {
        const $ = (s) => panel.querySelector(s);
        const status = (m) => { $('.pv-structure-status').textContent = m; };
        const num = (k) => parseFloat(panel.querySelector(`[data-run="${k}"]`).value);
        // A pool control with members (a fungible set) sets each member.
        const marking = {};
        for (const [id, n] of Object.entries(overrides.marking)) {
            const p = roles.pools.find((x) => x.id === id);
            for (const m of (p?.members || [id])) marking[m] = p?.members ? Math.round(n / p.members.length) : n;
        }
        const active = [...panel.querySelectorAll('[data-disrupt]:checked')].map((c) => {
            const d = disruptions.find((x) => x.id === c.dataset.disrupt);
            const amt = panel.querySelector(`[data-amount="${CSS.escape(d.id)}"]`);
            return d.amount && amt ? { ...d, amount: { ...d.amount, value: parseInt(amt.value, 10) || 0 } } : d;
        });
        const scenario = rolesMod.applyDisruptions({
            name: active.length ? active.map((d) => d.label).join(' + ') : 'as is',
            hours: num('hours'), realizations: num('realizations'), seed: num('seed'),
            ...(Object.keys(marking).length ? { marking } : {}), ...(Object.keys(overrides.rates).length ? { rates: { ...overrides.rates } } : {}),
        }, active);
        $('[data-act="run"]').disabled = true;
        status('Running…');
        const before = new Set(reg.artifacts().map((a) => a.id));
        try {
            const out = await reg.execute('sim.scenario', { scenario });
            status('');
            const s = out.summary || {};
            const outcomes = roles.terminals.filter((t) => s.final && t in s.final);
            const res = $('.pv-appview-results');
            res.innerHTML = `
                ${outcomes.length ? `<h4>Outcomes after ${fmt(s.hours)} h (${s.realizations} runs, seed ${s.seed})</h4>${outcomes.map((t) => `<div class="pv-appview-row" data-hl="${esc(t)}"><span>${esc(name(t))}</span><strong>${fmt(s.final[t])} ± ${fmt(s.finalStdDev?.[t] ?? 0)}</strong></div>`).join('')}` : ''}
                ${(s.contended || []).length ? `<p>Busiest resource: <strong>${esc(name(s.contended[0].place))}</strong>, holding up ${esc(s.contended[0].blocking.join(', '))} ${fmt(100 * s.contended[0].fraction)}% of the time.</p>` : ''}
                <h4>What this assumes</h4><ul class="pv-result-dim">${[...(s.assumptions || []), ...(s.caveats || [])].map((x) => `<li>${esc(x)}</li>`).join('') || '<li>No caveats reported.</li>'}</ul>
                <div class="pv-appview-art"></div>`;
            const box = res.querySelector('.pv-appview-art');
            for (const a of reg.artifacts().filter((x) => !before.has(x.id) && x.data.kind === 'timeseries')) {
                const r = R.renderArtifact(view._solverModule, a, { width: 380, height: 240 });
                box.insertAdjacentHTML('beforeend', `<div class="pv-result-dim">${esc(a.title)} · ${esc(a.id)}</div>${r.svg || ''}`);
                if (r.plotData) view._solverModule.SVGPlotter.setupInteractivity(r.plotData);
            }
            res.querySelectorAll('[data-hl]').forEach((r) => {
                r.addEventListener('mouseenter', () => reg.execute('view.highlight', { nodes: [r.dataset.hl] }).catch(() => {}));
                r.addEventListener('mouseleave', () => reg.execute('view.clear_highlight').catch(() => {}));
            });
        } catch (e) {
            status(e.message);
        } finally {
            $('[data-act="run"]').disabled = false;
        }
    };

    render();
    return panel;
}
