// petri-shell-views.js — the views the shell ships with, as registry entries (petri-shell.js ViewRegistry).
//
// Each entry is {type, kind, dock, title, render(host, payload, ctx)}. `ctx` is what a view may touch, and nothing else:
//
//   ctx.net.get()                the canvas's net (a JSON-LD clone)
//   ctx.net.set(net, {origin})   load a net onto the canvas through the strict gate (file.load_json); rejects on a bad net
//   ctx.execute(id, args)        run a registry command (pflow's `sim.ode`, `analysis.check`, ...); the result's
//                                `artifact` is an id, ctx.artifact(id) the object (render it with petri-results.js)
//   ctx.on('net', fn)            the canvas's net changed; returns an unsubscribe function
//   ctx.diagnostics              {set(source, items), get(), on(fn)}: one list the Diagnostics panel shows, fed by
//                                anyone: the engine's checks, the notation panel's parse errors and advice
//                                item = {severity: 'error'|'warn'|'info', message, nodes?: string[], line?, col?}
//   ctx.reveal(evt)              open another view (the same `show` event an MCP push sends)
//   ctx.solver()                 the petri-solver.js module, for plots
//   ctx.highlight(ids)           mark places or transitions on the canvas
//   ctx.close()                  close this view
//
// A view returns nothing, or {update(payload), dispose()}. It must read the live net when `payload` carries none (the
// layout is stored without payloads, so a reloaded panel is empty until it reads the canvas).
//
// No view here uses an inline handler or an inline style: every listener is addEventListener, every look is a class in
// petri-shell.css. That is what lets the page run under a strict Content-Security-Policy (docs/ide-shell.md).

/**
 * Set an element's markup from a string this repo produced (petri-results.js, the solver's SVG plotter), without a
 * style attribute reaching the parser. Those renderers write `style="..."` into their SVG, which a page with
 * style-src-attr 'none' refuses at parse time. Each one is moved to a data attribute first and then applied through the
 * CSSOM (el.style.cssText), which that policy allows. The result looks the same under either policy.
 */
export function setMarkup(el, markup) {
    el.innerHTML = String(markup).replace(/(\s)style\s*=\s*"([^"]*)"/g, '$1data-pf-css="$2"');
    for (const n of el.querySelectorAll('[data-pf-css]')) {
        n.style.cssText = n.getAttribute('data-pf-css');
        n.removeAttribute('data-pf-css');
    }
}

/** Build an element: h('button', {class: 'x', text: 'Run', on: {click: fn}}, ...children). */
export function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'text') el.textContent = v;
        else if (k === 'html') setMarkup(el, v); // only ever markup this repo produced (petri-results.js escapes its data)
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else if (k === 'class') el.className = v;
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
}

const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 };

function status(host, text, cls = '') {
    let el = host.querySelector(':scope > .pf-status');
    if (!el) { el = h('p', { class: 'pf-status', role: 'status' }); host.prepend(el); }
    el.className = `pf-status ${cls}`.trim();
    el.textContent = text;
}

/** Run a command and draw its artifact (or its report) into `out`. Never throws: a refusal is a line of text. */
export async function runInto(ctx, out, id, args = {}) {
    out.replaceChildren(h('p', { class: 'pf-status', role: 'status', text: 'Running…' }));
    try {
        const result = await ctx.execute(id, args);
        const art = result?.artifact ? ctx.artifact(result.artifact) : null;
        const R = await import('./petri-results.js');
        const shown = art ?? { id: id, title: id, source: { command: id, args }, data: { kind: 'report', ...(typeof result === 'object' && result ? result : { result }) } };
        const solver = shown.data.kind === 'timeseries' ? await ctx.solver() : null;
        const drawn = R.renderArtifact(solver, shown);
        out.replaceChildren(h('div', { class: 'pf-artifact', html: drawn.svg || drawn.html || '' }));
        R.wireArtifact(out, shown, (cid, a) => ctx.execute(cid, a), (m) => status(out, m, 'pf-err'));
        return { result, art: shown };
    } catch (e) {
        out.replaceChildren(h('p', { class: 'pf-status pf-err', role: 'alert', text: e?.message || String(e) }));
        return null;
    }
}

function runPanel(title, run, makeFields) {
    return (host, payload, ctx) => {
        const out = h('div', { class: 'pf-out' });
        const go = () => run(ctx, out, form.values());
        const form = simpleForm(makeFields());
        host.replaceChildren(h('div', { class: 'pf-toolbar' }, form.el, h('button', { class: 'pf-btn', type: 'button', text: 'Run', on: { click: go } })), out);
        const params = payload?.params || {};
        form.fill(params);
        // A push opens the view already run (that is what "show me the plot" means); a plain open waits for Run.
        if (payload?.auto) go();
        else out.replaceChildren(h('p', { class: 'pf-empty', text: `${title}: press Run to compute it for the net on the canvas.` }));
    };
}

function numberField(name, label, value, { min = 1, step = 'any' } = {}) {
    const input = h('input', { class: 'pf-input', type: 'number', min, step, value, 'aria-label': label, name });
    return { name, input, label: h('label', { class: 'pf-field' }, h('span', { text: label }), input) };
}

function simpleForm(fields) {
    return {
        el: h('div', { class: 'pf-fields' }, fields.map((f) => f.label)),
        values: () => Object.fromEntries(fields.map((f) => [f.name, +f.input.value]).filter(([, v]) => Number.isFinite(v) && v > 0)),
        fill: (p) => { for (const f of fields) if (p[f.name] !== undefined && Number.isFinite(+p[f.name])) f.input.value = String(+p[f.name]); },
    };
}

// ---------------------------------------------------------------------------

const nodeIds = (net) => ({
    places: Object.keys(net?.places || {}),
    transitions: Object.keys(net?.transitions || {}),
});

const outline = {
    type: 'outline', kind: 'panel', dock: 'left', title: 'Outline',
    summary: () => 'places and transitions of the canvas net',
    render(host, _payload, ctx) {
        const draw = () => {
            const net = ctx.net.get();
            const { places, transitions } = nodeIds(net);
            const list = (title, ids, cls) => h('section', { class: 'pf-group' },
                h('h3', { class: 'pf-h', text: `${title} (${ids.length})` }),
                h('ul', { class: 'pf-list' }, ids.map((id) => h('li', {}, h('button', {
                    class: `pf-node ${cls}`, type: 'button', text: net[cls === 'place' ? 'places' : 'transitions'][id]?.label || id, title: id,
                    on: { click: () => ctx.highlight([id]) },
                })))));
            host.replaceChildren(list('Places', places, 'place'), list('Transitions', transitions, 'transition'));
            if (!places.length && !transitions.length) host.replaceChildren(h('p', { class: 'pf-empty', text: 'The canvas is empty. Add a place or a transition, or open a model from the File menu.' }));
        };
        draw();
        const off = ctx.on('net', draw);
        return { dispose: off };
    },
};

const diagnostics = {
    type: 'diagnostics', kind: 'panel', dock: 'bottom', title: 'Diagnostics',
    summary: () => 'problems from the engine checks and from other panels',
    render(host, _payload, ctx) {
        const engine = []; // items from analysis.check / analysis.behaviour
        let timer = 0, token = 0;
        const draw = () => {
            const items = [...engine, ...ctx.diagnostics.get()].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));
            const head = h('p', { class: 'pf-status', role: 'status', text: items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : 'Nothing to report.' });
            const list = h('ul', { class: 'pf-diag' }, items.map((it) => h('li', { class: `pf-diag-item pf-${it.severity}` },
                h('span', { class: 'pf-sev', text: it.severity }),
                h('button', { class: 'pf-link', type: 'button', text: it.message, on: { click: () => it.nodes?.length && ctx.highlight(it.nodes) } }),
                it.source ? h('span', { class: 'pf-src', text: it.source + (it.line ? `:${it.line}${it.col ? ':' + it.col : ''}` : '') }) : null)));
            host.replaceChildren(head, list);
        };
        const check = async () => {
            const mine = ++token;
            try {
                const c = await ctx.execute('analysis.check', {});
                const b = await ctx.execute('analysis.behaviour', {});
                if (mine !== token) return;
                engine.length = 0;
                for (const e of c.errors || []) engine.push({ severity: 'error', message: typeof e === 'string' ? e : (e.message || JSON.stringify(e)), source: 'check' });
                for (const w of c.warnings || []) engine.push({ severity: 'warn', message: typeof w === 'string' ? w : (w.message || JSON.stringify(w)), source: 'check' });
                for (const f of b.findings || []) engine.push({ severity: f.category === 'deadlock' || f.category === 'unbounded' ? 'warn' : 'info', message: f.message, nodes: f.nodes, source: f.category });
            } catch (e) {
                engine.length = 0;
                engine.push({ severity: 'info', message: `checks unavailable: ${e?.message || e}`, source: 'shell' });
            }
            draw();
        };
        const later = () => { clearTimeout(timer); timer = setTimeout(check, 500); };
        draw();
        check();
        const offNet = ctx.on('net', later);
        const offDiag = ctx.diagnostics.on(draw);
        return { dispose() { offNet(); offDiag(); clearTimeout(timer); token++; } };
    },
};

const plot = {
    type: 'plot', kind: 'panel', dock: 'bottom', level: 'outcome', title: 'Simulation',
    summary: () => 'ODE time series of the canvas net',
    render: runPanel('Simulation', (ctx, out, v) => runInto(ctx, out, 'sim.ode', v), () => [
        numberField('t_end', 'End time', 10), numberField('points', 'Points', 200, { min: 2, step: 1 }),
    ]),
};

const invariants = {
    type: 'invariants', kind: 'panel', dock: 'bottom', level: 'math', title: 'Invariants',
    summary: () => 'place and transition invariants of the canvas net',
    render(host, payload, ctx) {
        const kind = payload?.params?.kind === 't' ? 't' : 'p';
        const out = h('div', { class: 'pf-out' });
        const sel = h('select', { class: 'pf-input', 'aria-label': 'Which invariants', name: 'kind' },
            h('option', { value: 'p', text: 'Place invariants' }), h('option', { value: 't', text: 'Transition invariants' }));
        sel.value = kind;
        const go = () => runInto(ctx, out, 'analysis.invariants', { kind: sel.value });
        host.replaceChildren(h('div', { class: 'pf-toolbar' }, sel, h('button', { class: 'pf-btn', type: 'button', text: 'Run', on: { click: go } })), out);
        if (payload?.auto) go(); else out.replaceChildren(h('p', { class: 'pf-empty', text: 'Invariants: press Run to compute them for the net on the canvas.' }));
    },
};

const reachability = {
    type: 'reachability', kind: 'panel', dock: 'bottom', level: 'math', title: 'Reachability',
    summary: () => 'the reachable markings of the canvas net',
    render: runPanel('Reachability', (ctx, out, v) => runInto(ctx, out, 'analysis.reachability', v), () => [
        numberField('max_states', 'Max states', 1000, { min: 10, step: 1 }),
    ]),
};

/**
 * A stand-in for the notation panel (run 19a75ca7 registers the real one over it): the net as plain lines, one per
 * element. It also shows how a view takes part in targets: `line:<n>`, `range:<a>-<b>` and `node:<id>` highlight lines.
 */
const notation = {
    type: 'notation', kind: 'panel', dock: 'center', level: 'model', title: 'Notation',
    summary: () => 'the net in pflow notation',
    render(host, _payload, ctx) {
        const box = h('div', { class: 'pf-code pf-lines', tabindex: '0', role: 'group', 'aria-label': 'Net as text (read-only prototype listing)' });
        let lines = [], marked = [];
        const draw = () => {
            const net = ctx.net.get();
            lines = [];
            for (const [id, p] of Object.entries(net?.places || {})) lines.push({ text: `place ${id}${p.initial ? ` = ${[].concat(p.initial).join(',')}` : ''}${p.capacity ? ` cap ${[].concat(p.capacity).join(',')}` : ''}`, ids: [id] });
            for (const id of Object.keys(net?.transitions || {})) lines.push({ text: `transition ${id}`, ids: [id] });
            for (const a of net?.arcs || []) lines.push({ text: `${a.source} ${a.inhibitTransition ? '-o' : '->'} ${a.target}${a.weight && [].concat(a.weight)[0] !== 1 ? ` x${[].concat(a.weight).join(',')}` : ''}`, ids: [a.source, a.target] });
            paint();
        };
        const hit = (ln, i) => marked.some((t) => (t.kind === 'line' && t.line === i + 1) || (t.kind === 'range' && i + 1 >= t.from && i + 1 <= t.to) || (t.kind === 'node' && ln.ids.includes(t.id)));
        const paint = () => {
            box.replaceChildren(...(lines.length ? lines : [{ text: '(empty net)', ids: [] }]).map((ln, i) => h('div', { class: hit(ln, i) ? 'pf-line pf-hl' : 'pf-line', text: ln.text, 'data-line': i + 1 })));
        };
        draw();
        host.replaceChildren(h('p', { class: 'pf-note', text: 'Prototype listing. The notation editor registers itself as this view type.' }), box);
        const offNet = ctx.on('net', draw);
        const offHl = ctx.on('highlight', (ev) => { marked = ev.targets.map(ctx.parseTarget).filter(Boolean); paint(); });
        return { dispose() { offNet(); offHl(); } };
    },
};

/** The outcome-level centre: what the agent has said, in plain words. At this level there is no canvas. */
const answer = {
    type: 'answer', kind: 'panel', dock: 'center', level: 'outcome', title: 'Answer',
    summary: () => 'plain-language narration of what is on screen',
    render(host, _payload, ctx) {
        const draw = () => {
            const s = ctx.shell;
            const items = [];
            if (s.tour?.say) items.push(h('p', { class: 'pf-say', text: s.tour.say }));
            for (const a of s.annotations) items.push(h('p', { class: 'pf-say', text: a.text }));
            host.replaceChildren(h('h3', { class: 'pf-h', text: 'Answer' }),
                ...(items.length ? items : [h('p', { class: 'pf-empty', text: 'Nothing has been explained yet. Ask Claude a question about the model, or step down a level to see the model itself.' })]));
        };
        draw();
        return { dispose: ctx.on('narration', draw) };
    },
};

const categorical = {
    type: 'categorical', kind: 'modal', level: 'math', title: 'Categorical view',
    summary: () => 'a composition view (cospan, operad, string, ...)',
    render(host, payload, ctx) {
        const name = typeof payload?.params?.name === 'string' && /^[a-z][a-z-]{0,30}$/.test(payload.params.name) ? payload.params.name : 'cospan';
        if (!payload?.cid || !/^[A-Za-z0-9]{8,128}$/.test(payload.cid)) {
            host.replaceChildren(h('p', { class: 'pf-status pf-err', role: 'alert', text: 'A categorical view needs a stored composition (a cid). A net that was only pushed is not stored, and the composition page reads stored models only.' }));
            return;
        }
        const frame = h('iframe', { class: 'pf-frame', title: `Composition view: ${name}`, src: `/compose.html?cid=${encodeURIComponent(payload.cid)}#view=${encodeURIComponent(name)}`, referrerpolicy: 'same-origin' });
        host.replaceChildren(frame);
        void ctx;
    },
};

const result = {
    type: 'result', kind: 'modal', level: 'outcome', title: 'Result',
    summary: () => 'text from an action or a push',
    render(host, payload) {
        host.replaceChildren(
            h('h3', { class: 'pf-h', text: payload?.title || 'Result' }),
            h('pre', { class: 'pf-code', tabindex: '0', text: payload?.text || payload?.note || '' }));
    },
};

const settings = {
    type: 'settings', kind: 'modal', level: 'outcome', title: 'Shell settings',
    summary: () => 'layout and the view types the shell knows',
    render(host, _payload, ctx) {
        const types = ctx.shell.registry.types();
        host.replaceChildren(
            h('p', {}, h('button', { class: 'pf-btn', type: 'button', text: 'Reset layout', on: { click: () => ctx.resetLayout() } }), ' ',
                h('a', { class: 'pf-btn', href: '?shell=0', text: 'Use the classic layout' })),
            h('h3', { class: 'pf-h', text: 'View types' }),
            h('table', { class: 'pv-analysis-table' }, h('thead', {}, h('tr', {}, ['type', 'kind', 'dock', 'title'].map((c) => h('th', { text: c })))),
                h('tbody', {}, types.map((t) => h('tr', {}, [t.type, t.kind, t.dock || '', t.title].map((c) => h('td', { text: c })))))));
    },
};

/** The canvas is the editor itself (<petri-view>, already on the page): it has an entry so an event can name it, and `pinned` says it is never placed in a dock. */
const canvas = {
    type: 'canvas', kind: 'panel', dock: 'center', title: 'Canvas', pinned: true,
    summary: () => 'the Petri net editor',
    render() {},
};

export const BUILTIN_VIEWS = [canvas, notation, answer, outline, diagnostics, plot, invariants, reachability, categorical, result, settings];

export function registerBuiltins(registry) {
    for (const v of BUILTIN_VIEWS) registry.register(v);
    return registry;
}
