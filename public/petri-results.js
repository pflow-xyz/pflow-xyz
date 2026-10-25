// petri-results.js — render artifacts (petri-commands.js) by kind.
//
// Every data-producing command stores an artifact in pflow-native's shape,
// {id, title, source, data: {kind, ...}}; this module turns one into markup.
// It returns strings (SVG and HTML), never touches the DOM, and is shared by
// the Analysis dialog, the Results list and, later, the chat's tool panel, so
// a result looks the same wherever it was asked for.
//
// Kinds rendered here: timeseries (lines, markers, or a phase plot of two of
// its series), report, table. A kind without a renderer yet falls back to
// its JSON, so a new producer is never invisible. Later phases add matrix,
// sets, graph, trace, bars, heatmap and scatter as their producers land.

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
    return jsonHtml(d);
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
    return { html: jsonHtml(d) };
}
