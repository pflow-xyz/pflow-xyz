// petri-results.js — render artifacts (petri-commands.js) by kind.
//
// Every data-producing command stores an artifact in pflow-native's shape,
// {id, title, source, data: {kind, ...}}; this module turns one into markup.
// It returns strings (SVG and HTML), never touches the DOM, and is shared by
// the Analysis dialog, the Results list and, later, the chat's tool panel, so
// a result looks the same wherever it was asked for.
//
// Kinds rendered here: timeseries (lines, markers, or a phase plot of two of
// its series), report, table, matrix, sets, trace and graph. A kind without a
// renderer yet falls back to its JSON, so a new producer is never invisible.
//
// Interactive pieces carry data attributes the caller wires to registry
// commands, so a click does what an agent's call would:
//   data-show-set="<index>"   artifact.show_set {id, index}  (highlight on the net)
//   data-goto-step="<index>"  sim.goto {id, step}            (load a trace step)
//   data-goto-node="<id>"     sim.goto {id, node}            (load a graph state)
// wireArtifact(container, art, execute) does that wiring.

const escHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fmt = (v) => (typeof v === 'number' ? String(+v.toPrecision(6)) : v === null || v === undefined ? '' : String(v));

/** The MCP tools/call params that re-run an artifact's command. */
export function mcpCall(art) {
    return { name: art.source.command, arguments: art.source.args || {} };
}

/** A plain HTML table. */
export function tableHtml(columns, rows, { numeric = true } = {}) {
    return `<table class="pv-analysis-table"><thead><tr>${columns.map((h) => `<th>${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric && i ? ' class="pv-num"' : ''}>${escHtml(fmt(c))}</td>`).join('')}</tr>`).join('')
    }</tbody></table>`;
}

/**
 * Plot a timeseries artifact with the solver's SVGPlotter.
 *
 * @param {Object} solver  the petri-solver.js module (for SVGPlotter)
 * @param {Object} art     a timeseries artifact
 * @param {Object} [o]
 * @param {'lines'|'markers'|'phase'} [o.mode]
 * @param {string} [o.x]   phase mode: the series on the x axis
 * @param {string} [o.y]   phase mode: the series on the y axis
 * @param {string} [o.yLabel]
 * @returns {{svg: string, plotData: Object}}
 */
export function plotTimeSeries(solver, art, o = {}) {
    const d = art.data;
    const mode = o.mode || 'lines';
    const P = solver.SVGPlotter;
    if (mode === 'phase') {
        const byName = (n) => d.series.find((s) => s.name === n && !s.group);
        const sx = byName(o.x), sy = byName(o.y);
        if (!sx || !sy) throw new Error(`phase plot needs series ${o.x} and ${o.y}`);
        const plotter = new P(o.width || 860, o.height || 460, { hoverMode: 'point', clampYZero: false });
        plotter.setTitle(o.title || `Phase: ${o.y} vs ${o.x}`).setXLabel(o.x).setYLabel(o.y);
        plotter.addSeries(sx.values, sy.values, 'trajectory');
        const last = sx.values.length - 1;
        plotter.addSeries([sx.values[0]], [sy.values[0]], 'start', null, { markers: true });
        plotter.addSeries([sx.values[last]], [sy.values[last]], 'end', null, { markers: true });
        return { svg: plotter.render(), plotData: plotter.lastPlotData };
    }
    const plotter = new P(o.width || 860, o.height || 420);
    plotter.setTitle(o.title || art.title).setXLabel(d.x_label).setYLabel(o.yLabel || 'Token count');
    for (const s of d.series) {
        plotter.addSeries(d.x, s.values, s.group || s.name, null, mode === 'markers' ? { markers: true } : {});
    }
    return { svg: plotter.render(), plotData: plotter.lastPlotData };
}

/** A report artifact (analysis.validate's shape, or any object) as HTML. */
export function reportHtml(art) {
    const d = art.data;
    if (Array.isArray(d.errors) && Array.isArray(d.warnings)) {
        const rows = (issues) => issues.map((i) => [i.path || '(net)', i.message]);
        const verdict = d.ok
            ? `No errors${d.cid ? `; it seals as <code>${escHtml(d.cid)}</code>` : ''}.`
            : `${d.errors.length} error${d.errors.length === 1 ? '' : 's'}.`;
        return `<p>${verdict}</p>`
            + (d.errors.length ? `<h3>Errors (${d.errors.length})</h3>${tableHtml(['Where', 'What'], rows(d.errors), { numeric: false })}` : '')
            + (d.warnings.length ? `<h3>Warnings (${d.warnings.length})</h3>${tableHtml(['Where', 'What'], rows(d.warnings), { numeric: false })}` : '');
    }
    return genericReportHtml(d);
}

// A report from any producer: its headline fields first (summary, verdict,
// answer), then every scalar as a row, and lists and objects as compact JSON.
function genericReportHtml(d) {
    const head = ['summary', 'verdict', 'answer', 'reads'].filter((k) => typeof d[k] === 'string');
    const rows = [];
    for (const [k, v] of Object.entries(d)) {
        if (k === 'kind' || head.includes(k)) continue;
        const shown = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
        rows.push([k, shown]);
    }
    return head.map((k) => `<p><strong>${escHtml(k)}:</strong> ${escHtml(d[k])}</p>`).join('')
        + tableHtml(['Field', 'Value'], rows, { numeric: false });
}

function matrixHtml(d) {
    const rows = d.rows.map((r, i) => [r, ...d.values[i]]);
    return tableHtml(['', ...d.cols], rows);
}

function setsHtml(d) {
    if (!d.sets.length) return '<p>No sets.</p>';
    return `<ol class="pv-result-sets">${d.sets.map((set, i) => `
        <li><button type="button" class="pv-btn" data-show-set="${i}" title="Highlight on the net">Show</button>
            <strong>${escHtml(set.label || set.nodes.join(', '))}</strong>
            ${set.weights ? ` <span class="pv-result-dim">${escHtml(Object.entries(set.weights).map(([n, w]) => `${w}·${n}`).join(' + '))}</span>` : ''}
            ${set.note ? `<div class="pv-result-dim">${escHtml(set.note)}</div>` : ''}</li>`).join('')}</ol>`;
}

const markingText = (m) => Object.entries(m || {}).map(([p, v]) => `${p}=${[].concat(v).join('/')}`).join(' ');

function traceHtml(d) {
    return `<ol class="pv-result-trace" start="0">${d.steps.map((st, i) => `
        <li><button type="button" class="pv-btn" data-goto-step="${i}" title="Load this marking onto the net">Go</button>
            ${i === 0 && !st.transition ? '<em>start</em>' : `fire <strong>${escHtml(st.transition)}</strong>`}
            <span class="pv-result-dim">${escHtml(markingText(st.marking))}</span></li>`).join('')}</ol>`;
}

// A layered drawing of a reachability graph (nodes carry data.depth). Past
// MAX_GRAPH states it lists the notable states instead.
const MAX_GRAPH = 400;

function graphHtml(d) {
    const nodes = d.nodes || [];
    const notable = nodes.filter((n) => n.data && (n.data.initial || n.data.deadlock || n.data.terminal));
    const list = `<p class="pv-result-dim">${nodes.length} states, ${(d.edges || []).length} edges.</p>`
        + (notable.length ? `<ul class="pv-result-states">${notable.slice(0, 50).map((n) => `
            <li><button type="button" class="pv-btn" data-goto-node="${escHtml(n.id)}">Go</button>
                ${escHtml(n.id)} ${n.data.initial ? '<em>initial</em>' : ''} ${n.data.deadlock ? '<strong>deadlock</strong>' : n.data.terminal ? '<em>terminal</em>' : ''}
                <span class="pv-result-dim">${escHtml(n.label)}</span></li>`).join('')}</ul>` : '');
    if (nodes.length === 0 || nodes.length > MAX_GRAPH) return list;
    const layers = new Map();
    for (const n of nodes) {
        const depth = n.data && Number.isFinite(n.data.depth) ? n.data.depth : 0;
        if (!layers.has(depth)) layers.set(depth, []);
        layers.get(depth).push(n);
    }
    const dx = 120, dy = 70, r = 14;
    const width = Math.max(...[...layers.values()].map((l) => l.length)) * dx + dx;
    const height = (Math.max(...layers.keys()) + 1) * dy + dy;
    const pos = new Map();
    for (const [depth, layer] of layers) {
        layer.forEach((n, i) => pos.set(n.id, { x: (i + 1) * dx - dx / 2 + (width - layer.length * dx) / 2, y: depth * dy + dy / 2 + 10 }));
    }
    const edges = (d.edges || []).filter((e) => pos.has(e.source) && pos.has(e.target)).map((e) => {
        const a = pos.get(e.source), b = pos.get(e.target);
        return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="pv-graph-edge"><title>${escHtml(e.label)}</title></line>`;
    }).join('');
    const circles = nodes.map((n) => {
        const p = pos.get(n.id);
        const cls = n.data?.deadlock ? 'pv-graph-node pv-graph-dead' : n.data?.initial ? 'pv-graph-node pv-graph-initial' : 'pv-graph-node';
        return `<g data-goto-node="${escHtml(n.id)}" class="pv-graph-hit"><circle cx="${p.x}" cy="${p.y}" r="${r}" class="${cls}"><title>${escHtml(`${n.id}: ${n.label}`)}</title></circle>`
            + `<text x="${p.x}" y="${p.y + r + 12}" text-anchor="middle" class="pv-graph-label">${escHtml(n.label.length > 18 ? n.label.slice(0, 17) + '…' : n.label)}</text></g>`;
    }).join('');
    return `<svg class="pv-result-graph" viewBox="0 0 ${width} ${height}" width="${Math.min(width, 860)}" role="img" aria-label="reachability graph">${edges}${circles}</svg>` + list;
}

function jsonHtml(v) {
    return `<pre class="pv-result-json">${escHtml(JSON.stringify(v, null, 2))}</pre>`;
}

/**
 * Any artifact as {svg?, plotData?, html}: the default view of its kind.
 * @param {Object} solver petri-solver.js (needed for timeseries)
 */
export function renderArtifact(solver, art, o = {}) {
    const d = art.data;
    if (d.kind === 'timeseries') {
        const plot = plotTimeSeries(solver, art, o);
        return { ...plot, html: '' };
    }
    if (d.kind === 'report') return { html: reportHtml(art) };
    if (d.kind === 'table') return { html: tableHtml(d.columns, d.rows) };
    if (d.kind === 'matrix') return { html: matrixHtml(d) };
    if (d.kind === 'sets') return { html: setsHtml(d) };
    if (d.kind === 'trace') return { html: traceHtml(d) };
    if (d.kind === 'graph') return { html: graphHtml(d) };
    return { html: jsonHtml(d) };
}

/**
 * Wire an artifact's interactive pieces inside `container` to registry
 * commands. `execute(id, args)` is the registry's (or the element's).
 * `onError(message)` reports a refused command.
 */
export function wireArtifact(container, art, execute, onError = () => {}) {
    const run = (id, args) => execute(id, args).catch((e) => onError(e.message || String(e)));
    container.querySelectorAll('[data-show-set]').forEach((el) => el.addEventListener('click', () =>
        run('artifact.show_set', { id: art.id, index: +el.dataset.showSet })));
    container.querySelectorAll('[data-goto-step]').forEach((el) => el.addEventListener('click', () =>
        run('sim.goto', { id: art.id, step: +el.dataset.gotoStep })));
    container.querySelectorAll('[data-goto-node]').forEach((el) => el.addEventListener('click', () =>
        run('sim.goto', { id: art.id, node: el.dataset.gotoNode })));
}
