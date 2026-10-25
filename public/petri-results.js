// petri-results.js — render artifacts (petri-commands.js) by kind.
//
// Every data-producing command stores an artifact in pflow-native's shape,
// {id, title, source, data: {kind, ...}}; this module turns one into markup.
// It returns strings (SVG and HTML), never touches the DOM, and is shared by
// the Analysis dialog, the Results list and, later, the chat's tool panel, so
// a result looks the same wherever it was asked for.
//
// Kinds rendered here: timeseries (lines, markers, or a phase plot of two of
// its series, with ±sd bands as dashed bounds), report, table, matrix, sets,
// trace, graph, bars (a tornado when bars carry lo/hi), heatmap and scatter
// (Pareto points highlighted). A kind without a
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
    // Groups (a swept rate, a scenario) are labelled "name (group)" when there
    // is more than one name, so overlays stay readable.
    const names = new Set(d.series.map((s) => s.name));
    d.series.forEach((s) => {
        const label = s.group ? (names.size > 1 ? `${s.name} (${s.group})` : s.group) : s.name;
        plotter.addSeries(d.x, s.values, label, null, mode === 'markers' ? { markers: true } : {});
        if (Array.isArray(s.band)) {
            // mean ± 1 sd, drawn as dashed bounds in the series' colour
            const color = plotter.series[plotter.series.length - 1].color;
            plotter.addSeries(d.x, s.values.map((v, i) => v + s.band[i]), `${label} +1 sd`, color, { dash: '3,3' });
            plotter.addSeries(d.x, s.values.map((v, i) => Math.max(0, v - s.band[i])), `${label} −1 sd`, color, { dash: '3,3' });
        }
    });
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

// A ranked bar chart; a tornado when bars carry lo/hi (diagnose's influence).
function barsHtml(d) {
    const bars = d.bars || [];
    if (!bars.length) return '<p>No bars.</p>';
    const ext = Math.max(1e-12, ...bars.flatMap((b) => [Math.abs(b.value), Math.abs(b.lo ?? 0), Math.abs(b.hi ?? 0)]));
    const W = 560, rowH = 22, labelW = 200, mid = labelW + (W - labelW) / 2, half = (W - labelW) / 2 - 10;
    const x = (v) => mid + (v / ext) * half;
    const rows = bars.map((b, i) => {
        const y = i * rowH + 6;
        const lo = b.lo ?? Math.min(0, b.value), hi = b.hi ?? Math.max(0, b.value);
        const x0 = x(Math.min(lo, hi)), x1 = x(Math.max(lo, hi));
        return `<text x="${labelW - 6}" y="${y + 12}" text-anchor="end" class="pv-bars-label">${escHtml(b.name)}</text>`
            + `<rect x="${x0.toFixed(1)}" y="${y}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${rowH - 8}" class="pv-bars-bar"><title>${escHtml(`${b.name}: ${fmt(b.value)}${b.lo !== undefined ? ` (${fmt(b.lo)} … ${fmt(b.hi)})` : ''}`)}</title></rect>`
            + `<text x="${W - 4}" y="${y + 12}" text-anchor="end" class="pv-bars-value">${escHtml(fmt(b.value))}</text>`;
    }).join('');
    const h = bars.length * rowH + 24;
    return `<svg class="pv-result-bars" viewBox="0 0 ${W + 50} ${h}" width="${W + 50}" role="img" aria-label="${escHtml(d.value_label || 'bars')}">`
        + `<line x1="${mid}" y1="0" x2="${mid}" y2="${h - 18}" class="pv-bars-axis"/>${rows}`
        + `<text x="${mid}" y="${h - 4}" text-anchor="middle" class="pv-bars-label">${escHtml(d.value_label || '')}</text></svg>`;
}

// A grid of values: a colour per cell (the viz ramp tokens), the value on hover.
function heatmapHtml(d) {
    const z = d.z || [];
    const vals = z.flat().filter((v) => Number.isFinite(v));
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const cell = Math.max(8, Math.min(36, Math.floor(480 / Math.max(d.xs.length, d.ys.length))));
    const left = 60, top = 10;
    const cells = [];
    z.forEach((row, iy) => row.forEach((v, ix) => {
        const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
        cells.push(`<rect x="${left + ix * cell}" y="${top + (d.ys.length - 1 - iy) * cell}" width="${cell}" height="${cell}" style="fill: var(--pv-accent); fill-opacity: ${(0.08 + 0.92 * t).toFixed(3)}"><title>${escHtml(`${d.x_label}=${fmt(d.xs[ix])}, ${d.y_label}=${fmt(d.ys[iy])}: ${fmt(v)}`)}</title></rect>`);
    }));
    const W = left + d.xs.length * cell + 10, H = top + d.ys.length * cell + 40;
    return `<svg class="pv-result-heatmap" viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="heatmap">${cells.join('')}`
        + `<text x="${left}" y="${H - 20}" class="pv-bars-label">${escHtml(d.x_label)}: ${escHtml(fmt(d.xs[0]))} … ${escHtml(fmt(d.xs[d.xs.length - 1]))}</text>`
        + `<text x="${left}" y="${H - 6}" class="pv-bars-label">${escHtml(d.y_label)}: ${escHtml(fmt(d.ys[0]))} (bottom) … ${escHtml(fmt(d.ys[d.ys.length - 1]))}</text></svg>`
        + `<p class="pv-result-dim">Darker is higher: ${escHtml(fmt(lo))} … ${escHtml(fmt(hi))}.</p>`;
}

// Points, with the highlighted ones (the Pareto front) drawn solid.
function scatterHtml(d) {
    const pts = d.points || [];
    if (!pts.length) return '<p>No points.</p>';
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const W = 520, H = 320, m = 40;
    const sx = (v) => m + (x1 > x0 ? (v - x0) / (x1 - x0) : 0.5) * (W - 2 * m);
    const sy = (v) => H - m - (y1 > y0 ? (v - y0) / (y1 - y0) : 0.5) * (H - 2 * m);
    const hl = new Set(d.highlight || []);
    const dots = pts.map((p, i) => `<circle cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(1)}" r="${hl.has(i) ? 5 : 3}" class="${hl.has(i) ? 'pv-scatter-front' : 'pv-scatter-pt'}"><title>${escHtml(`#${i}: ${fmt(p[0])}, ${fmt(p[1])}`)}</title></circle>`).join('');
    return `<svg class="pv-result-scatter" viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="scatter">`
        + `<line x1="${m}" y1="${H - m}" x2="${W - m}" y2="${H - m}" class="pv-bars-axis"/><line x1="${m}" y1="${m}" x2="${m}" y2="${H - m}" class="pv-bars-axis"/>${dots}`
        + `<text x="${W / 2}" y="${H - 8}" text-anchor="middle" class="pv-bars-label">${escHtml(d.x_label)}</text>`
        + `<text x="12" y="${H / 2}" text-anchor="middle" class="pv-bars-label" transform="rotate(-90 12 ${H / 2})">${escHtml(d.y_label)}</text></svg>`
        + (hl.size ? `<p class="pv-result-dim">${hl.size} point(s) on the Pareto front, drawn larger.</p>` : '');
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
    if (d.kind === 'bars') return { html: barsHtml(d) };
    if (d.kind === 'heatmap') return { html: heatmapHtml(d) };
    if (d.kind === 'scatter') return { html: scatterHtml(d) };
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
