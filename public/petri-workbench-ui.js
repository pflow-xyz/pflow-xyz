// petri-workbench-ui.js — the Simulate dialog: the simulation workbench
// (ROADMAP phase 3). Stochastic runs (SSA, SDE), which knob matters
// (diagnose), a two-rate heatmap, "what if one more", SSA-vs-ODE crosscheck,
// equilibrium and a Monte Carlo optimiser.
//
// Each tab is a form for one registry command; the dialog only collects
// arguments and renders the artifacts that come back, so everything here is
// also what the Assistant and an MCP client can call. The banner says which
// engine suits this net and why (sim.recommend, from
// docs/engine-selection.md). <petri-view> loads this when the dialog opens.

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Field kinds: num, int, place, transition, places (checkboxes), transitions
// (checkboxes with min/max), select (fixed options), bool.
const TABS = [
    {
        id: 'stochastic', label: 'Stochastic', hint: 'Seeded runs with their spread: the same seed always gives the same answer.',
        fields: [
            { name: 'engine', kind: 'select', options: [['sim.ssa', 'SSA (discrete, exact)'], ['sim.sde', 'SDE (continuous noise)']] },
            { name: 't_end', kind: 'num', value: (r) => r.t_end },
            { name: 'runs', kind: 'int', value: () => 20 },
            { name: 'seed', kind: 'int', value: () => 1 },
            { name: 'points', kind: 'int', value: () => 101 },
        ],
        command: (f) => f.engine,
        args: (f) => ({ t_end: f.t_end, runs: f.runs, seed: f.seed, points: f.points }),
    },
    {
        id: 'influence', label: 'Which knob matters', hint: 'Each rate at ×(1 ± delta) and one more token in each place, ranked against an SSA noise floor.',
        fields: [
            { name: 'observable', kind: 'place', optional: true, blank: 'the sinks (default)' },
            { name: 't_end', kind: 'num', value: (r) => r.t_end },
            { name: 'delta', kind: 'num', value: () => 0.5 },
            { name: 'noise', kind: 'bool', value: () => true },
        ],
        command: () => 'analysis.diagnose',
        args: (f) => ({ ...(f.observable ? { observable: f.observable } : {}), t_end: f.t_end, delta: f.delta, noise: f.noise }),
    },
    {
        id: 'whatif', label: 'What if one more', hint: 'The same seeded runs with and without one more token in a place: the difference, with its spread.',
        fields: [
            { name: 'place', kind: 'place' },
            { name: 'hours', kind: 'num', value: (r) => r.t_end },
            { name: 'realizations', kind: 'int', value: () => 16 },
            { name: 'seed', kind: 'int', value: () => 7 },
        ],
        command: () => 'sim.compare',
        args: (f, view) => {
            const cur = (view.getModel().places[f.place]?.initial || [0]).reduce((a, b) => a + b, 0);
            const base = { hours: f.hours, realizations: f.realizations, seed: f.seed };
            return { seed: f.seed, scenarios: [{ name: 'as is', ...base }, { name: `one more ${f.place}`, ...base, marking: { [f.place]: cur + 1 } }] };
        },
    },
    {
        id: 'heatmap', label: 'Two-rate heatmap', hint: 'One place\'s value at t_end over a grid of two transitions\' rates.',
        fields: [
            { name: 'param_x', kind: 'transition' }, { name: 'x_from', kind: 'num', value: () => 0.1 }, { name: 'x_to', kind: 'num', value: () => 2 },
            { name: 'param_y', kind: 'transition', second: true }, { name: 'y_from', kind: 'num', value: () => 0.1 }, { name: 'y_to', kind: 'num', value: () => 2 },
            { name: 'observable', kind: 'place' }, { name: 'steps', kind: 'int', value: () => 10 }, { name: 't_end', kind: 'num', value: (r) => r.t_end },
        ],
        command: () => 'opt.heatmap',
        args: (f) => ({ ...f }),
    },
    {
        id: 'optimize', label: 'Optimize', hint: 'Monte Carlo over the chosen rates; the samples no other beats on every objective are the Pareto front.',
        fields: [
            { name: 'parameters', kind: 'transitions' },
            { name: 'maximize', kind: 'place' },
            { name: 'minimize', kind: 'place', optional: true, blank: '(none)' },
            { name: 'samples', kind: 'int', value: () => 200 },
            { name: 'seed', kind: 'int', value: () => 42 },
            { name: 't_end', kind: 'num', value: (r) => r.t_end },
        ],
        command: () => 'opt.optimize',
        args: (f) => {
            if (!f.parameters.length) throw new Error('Tick at least one transition to vary.');
            const objectives = [{ place: f.maximize, sense: 'max' }];
            if (f.minimize) objectives.push({ place: f.minimize, sense: 'min' });
            return { parameters: f.parameters, objectives, samples: f.samples, seed: f.seed, t_end: f.t_end };
        },
    },
    {
        id: 'crosscheck', label: 'SSA vs ODE', hint: 'The SSA ensemble mean against the ODE, and the conservation laws checked along both.',
        fields: [{ name: 't_end', kind: 'num', value: (r) => Math.min(168, r.t_end) }, { name: 'runs', kind: 'int', value: () => 24 }, { name: 'seed', kind: 'int', value: () => 1 }],
        command: () => 'sim.crosscheck',
        args: (f) => ({ ...f }),
    },
    {
        id: 'equilibrium', label: 'Equilibrium', hint: 'Integrate the ODE until it stops moving, or give up at t_max.',
        fields: [{ name: 't_max', kind: 'num', value: () => 1000 }, { name: 'tolerance', kind: 'num', value: () => 1e-6 }],
        command: () => 'sim.equilibrium',
        args: (f) => ({ ...f }),
    },
];

export async function openWorkbench(view, { tab } = {}) {
    const [reg, R] = await Promise.all([view.commands(), import('./petri-results.js')]);
    if (!view._solverModule) view._solverModule = await import('./petri-solver.js');
    const m = view.getModel();
    const places = Object.keys(m.places || {});
    const transitions = Object.keys(m.transitions || {});
    if (!places.length || !transitions.length) {
        view._toast('Add at least one place and one transition first', 'error');
        return;
    }
    const rec = await reg.execute('sim.recommend');

    const field = (t, f) => {
        const id = `wb-${t.id}-${f.name}`;
        const lab = `<label for="${id}">${esc(f.name.replace(/_/g, ' '))}</label>`;
        const opts = (list, sel) => list.map((v) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(v)}</option>`).join('');
        switch (f.kind) {
            case 'num': case 'int':
                return `${lab}<input id="${id}" data-f="${f.name}" data-kind="${f.kind}" type="number" step="${f.kind === 'int' ? 1 : 'any'}" value="${esc(f.value(rec))}">`;
            case 'bool':
                return `${lab}<input id="${id}" data-f="${f.name}" data-kind="bool" type="checkbox"${f.value(rec) ? ' checked' : ''}>`;
            case 'select':
                return `${lab}<select id="${id}" data-f="${f.name}" data-kind="select">${f.options.map(([v, l]) => `<option value="${esc(v)}"${(f.name === 'engine' && v === (rec.engine === 'ssa' ? 'sim.ssa' : 'sim.sde')) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
            case 'place': case 'transition': {
                const list = f.kind === 'place' ? places : transitions;
                const sel = f.second ? list[1] ?? list[0] : list[0];
                return `${lab}<select id="${id}" data-f="${f.name}" data-kind="select">${f.optional ? `<option value="">${esc(f.blank)}</option>` : ''}${opts(list, f.optional ? null : sel)}</select>`;
            }
            case 'transitions':
                return `<fieldset data-f="${f.name}" data-kind="transitions"><legend>vary these rates (min … max)</legend>${transitions.map((t) =>
                    `<label><input type="checkbox" data-t="${esc(t)}"> ${esc(t)}</label> <input type="number" step="any" data-min="${esc(t)}" value="0.1"> … <input type="number" step="any" data-max="${esc(t)}" value="2"><br>`).join('')}</fieldset>`;
            default:
                return '';
        }
    };

    const overlay = document.createElement('div');
    overlay.className = 'pv-modal-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pv-modal-dialog pv-modal-dialog-xl pv-workbench-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', 'Simulate');
    dialog.innerHTML = `
        <div class="pv-dialog-header">
            <h2 class="pv-dialog-header-title">Simulate</h2>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
        </div>
        <p class="pv-workbench-rec"><strong>Suggested engine: ${esc(rec.engine.toUpperCase())}.</strong> ${esc(rec.why)}</p>
        <div class="pv-analysis-tabs" role="tablist">${TABS.map((t) => `<button type="button" role="tab" class="pv-analysis-tab" data-tab="${t.id}">${esc(t.label)}</button>`).join('')}</div>
        <p class="pv-analysis-hint"></p>
        ${TABS.map((t) => `<form class="pv-workbench-form" data-form="${t.id}" hidden>${t.fields.map((f) => `<div class="pv-workbench-field">${field(t, f)}</div>`).join('')}</form>`).join('')}
        <div class="pv-btn-container">
            <button type="button" class="pv-btn pv-btn-primary" data-act="run">Run</button>
            <button type="button" class="pv-btn" data-act="close">Close</button>
        </div>
        <div class="pv-structure-status" aria-live="polite"></div>
        <div class="pv-structure-results"></div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const $ = (s) => dialog.querySelector(s);
    const status = (msg) => { $('.pv-structure-status').textContent = msg; };
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    dialog.querySelectorAll('[data-act="close"]').forEach((b) => b.addEventListener('click', close));

    let current = TABS.find((t) => t.id === tab) || TABS[0];
    const show = (t) => {
        current = t;
        dialog.querySelectorAll('.pv-analysis-tab').forEach((b) => b.classList.toggle('pv-active', b.dataset.tab === t.id));
        dialog.querySelectorAll('[data-form]').forEach((f) => { f.hidden = f.dataset.form !== t.id; });
        $('.pv-analysis-hint').textContent = t.hint;
    };
    dialog.querySelectorAll('.pv-analysis-tab').forEach((b) => b.addEventListener('click', () => show(TABS.find((t) => t.id === b.dataset.tab))));
    show(current);

    const read = (form) => {
        const f = {};
        form.querySelectorAll('[data-f]').forEach((el) => {
            const k = el.dataset.f;
            switch (el.dataset.kind) {
                case 'num': f[k] = parseFloat(el.value); break;
                case 'int': f[k] = parseInt(el.value, 10); break;
                case 'bool': f[k] = el.checked; break;
                case 'transitions':
                    f[k] = [...el.querySelectorAll('[data-t]')].filter((c) => c.checked).map((c) => ({
                        transition: c.dataset.t,
                        min: parseFloat(el.querySelector(`[data-min="${CSS.escape(c.dataset.t)}"]`).value),
                        max: parseFloat(el.querySelector(`[data-max="${CSS.escape(c.dataset.t)}"]`).value),
                    }));
                    break;
                default: f[k] = el.value;
            }
        });
        return f;
    };

    $('[data-act="run"]').addEventListener('click', async () => {
        const runBtn = $('[data-act="run"]');
        let id, args;
        try {
            const f = read(dialog.querySelector(`[data-form="${current.id}"]`));
            id = current.command(f);
            args = current.args(f, view);
        } catch (e) {
            status(e.message);
            return;
        }
        runBtn.disabled = true;
        const spec = reg.list().find((s) => s.id === id);
        status(spec?.native ? `Running ${spec.label} (pflow-native engine)…` : `Running ${spec?.label || id}…`);
        const before = new Set(reg.artifacts().map((a) => a.id));
        try {
            const out = await reg.execute(id, args);
            const made = reg.artifacts().filter((a) => !before.has(a.id));
            status('');
            const res = $('.pv-structure-results');
            const headline = out.summary || out.verdict || out.reading || '';
            res.innerHTML = (headline ? `<p>${esc(headline)}</p>` : '')
                + made.map((a) => `<section data-art="${esc(a.id)}"><h4>${esc(a.title)} <span class="pv-result-dim">${esc(a.data.kind)} · ${esc(a.id)}</span>
                    <button type="button" class="pv-btn" data-mcp="${esc(a.id)}">Copy MCP call</button></h4><div class="pv-structure-art"></div></section>`).join('');
            for (const a of made) {
                const sec = res.querySelector(`[data-art="${CSS.escape(a.id)}"]`);
                const box = sec.querySelector('.pv-structure-art');
                const r = R.renderArtifact(view._solverModule, a);
                box.innerHTML = (r.svg || '') + r.html;
                if (r.plotData) view._solverModule.SVGPlotter.setupInteractivity(r.plotData);
                R.wireArtifact(box, a, (cid, cargs) => reg.execute(cid, cargs), (msg) => status(msg));
                sec.querySelector('[data-mcp]').addEventListener('click', () => view._copyMcpCall(a));
            }
            if (!made.length) res.innerHTML += R.reportHtml({ data: { kind: 'report', ...out } });
        } catch (e) {
            status(`${spec?.label || id} failed: ${e.message}`);
        } finally {
            runBtn.disabled = false;
        }
    });
    overlay.tabIndex = -1;
    overlay.focus();
}
