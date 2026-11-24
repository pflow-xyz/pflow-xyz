// SPDX-License-Identifier: MIT
// petri-shell-notation.js — the IDE shell's notation panel: the net on the canvas as pflow notation text
// (docs/pflow-notation.md), editable, with line-level diagnostics. It registers over the shell's stand-in
// (`type: 'notation'`, petri-shell-views.js), which is the contract in docs/ide-shell.md section 5.
//
// The text is rendered by the server's Go notation package, the notation's executable spec, through one endpoint
// (cmd/webserver/notation.go, POST /api/notation): {net} -> {text, lossy, nodes, diagnostics} and
// {text} -> {net, cid, nodes, diagnostics}. The page carries no second parser, so the browser and the server cannot
// disagree about what a text means. The endpoint stores and logs nothing.
//
//   targets   node:<id> lights every line that mentions the id (and scrolls to its declaration), line:<n> and
//             range:<a>-<b> light lines: the same ids the canvas and the MCP verbs use
//   payload   params.source (an MCP `show` of view notation with text): that text is shown instead of the canvas's,
//             until the canvas changes
//   edit      Edit turns the listing into a text box; Apply compiles it and loads the net through ctx.net.set (the
//             strict gate, one undo step); a text with an error is not applied, and its errors are on their lines
//   advise    the advisor's third tier (go-pflow's verifier on the server, bounded), shown as line diagnostics
//
// No inline handler and no inline style (docs/ide-shell.md section 6): elements come from h(), looks from classes.

import { h } from './petri-shell-views.js';

const IDENT = /"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*/g;

/** The ids a line names: bare names and quoted strings (unquoted), with a trailing `# comment` ignored. */
export function lineTokens(line) {
    const code = line.replace(/(^|\s)#.*$/, '');
    const out = new Set();
    for (const m of code.matchAll(IDENT)) {
        const t = m[0];
        if (t.startsWith('"')) { try { out.add(JSON.parse(t)); } catch { /* not a string */ } } else out.add(t);
    }
    return out;
}

/** 1-based numbers of the lines that mention `id`. */
export function linesMentioning(text, id) {
    const out = [];
    String(text).split('\n').forEach((ln, i) => { if (lineTokens(ln).has(id)) out.push(i + 1); });
    return out;
}

/** Whether line `n` (1-based) is lit by the parsed targets, given the text's lines. */
export function lineLit(targets, n, tokens) {
    return targets.some((t) => (t.kind === 'line' && t.line === n) || (t.kind === 'range' && n >= t.from && n <= t.to) || (t.kind === 'node' && tokens.has(t.id)));
}

/** POST /api/notation. Resolves to the answer, or rejects with the server's words. */
export async function notationRequest(body, { fetchImpl = (...a) => globalThis.fetch(...a), base = '' } = {}) {
    const res = await fetchImpl(`${base}/api/notation`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let out = null;
    try { out = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error(out?.error || `the notation service answered ${res.status}`);
    return out;
}

/** The endpoint's diagnostics in the shape ctx.diagnostics takes. */
export function toShellDiagnostics(diags) {
    return (Array.isArray(diags) ? diags : []).map((d) => ({
        severity: ['error', 'warn', 'info'].includes(d.severity) ? d.severity : 'info',
        message: d.help ? `${d.message} (${d.help})` : String(d.message || ''),
        ...(Number.isInteger(d.line) ? { line: d.line } : {}),
        ...(Number.isInteger(d.col) ? { col: d.col } : {}),
        ...(Array.isArray(d.nodes) && d.nodes.length ? { nodes: d.nodes } : {}),
    }));
}

export const notationView = {
    type: 'notation', kind: 'panel', dock: 'center', level: 'model', title: 'Notation',
    summary: () => 'the net in pflow notation',
    render(host, payload, ctx, { request = notationRequest } = {}) {
        let text = '', nodes = {}, diags = [], lossy = [], given = false;
        let marked = [], editing = false, token = 0, timer = 0, advise = false;
        const status = h('p', { class: 'pf-status', role: 'status' });
        const box = h('div', { class: 'pf-code pf-lines pf-notation', tabindex: '0', role: 'group', 'aria-label': 'The net in pflow notation' });
        const area = h('textarea', { class: 'pf-code pf-input pf-notation-edit', 'aria-label': 'Edit the net as pflow notation', spellcheck: 'false', hidden: true });
        const editBtn = h('button', { class: 'pf-btn', type: 'button', text: 'Edit', on: { click: () => setEditing(true) } });
        const applyBtn = h('button', { class: 'pf-btn', type: 'button', text: 'Apply', hidden: true, on: { click: () => apply() } });
        const cancelBtn = h('button', { class: 'pf-btn', type: 'button', text: 'Cancel', hidden: true, on: { click: () => { setEditing(false); paint(); } } });
        const adviseBox = h('input', { type: 'checkbox', 'aria-label': 'Run the advisor (deadlock, boundedness, liveness, invariants)', on: { change: () => { advise = adviseBox.checked; refresh(); } } });
        const adviseLbl = h('label', { class: 'pf-field pf-inline', title: "go-pflow's verifier, on the server, bounded at 2000 states" }, adviseBox, h('span', { text: 'Advisor' }));
        host.replaceChildren(h('div', { class: 'pf-toolbar' }, editBtn, applyBtn, cancelBtn, adviseLbl), status, box, area);

        const publish = () => ctx.diagnostics.set('notation', toShellDiagnostics(diags));
        const byLine = () => {
            const m = new Map();
            for (const d of diags) if (Number.isInteger(d.line)) { const prev = m.get(d.line); if (!prev || (prev.severity !== 'error' && d.severity === 'error')) m.set(d.line, d); }
            return m;
        };
        const say = () => {
            const errs = diags.filter((d) => d.severity === 'error').length;
            const bits = [given ? 'Text Claude sent (the canvas is unchanged).' : 'The net on the canvas.'];
            if (errs) bits.push(`${errs} error${errs === 1 ? '' : 's'}.`);
            if (lossy.length) bits.push(`Not shown in the notation: ${lossy.slice(0, 3).join('; ')}${lossy.length > 3 ? ' …' : ''}.`);
            status.className = errs ? 'pf-status pf-err' : 'pf-status';
            status.textContent = bits.join(' ');
        };
        function paint() {
            const lines = (text || '').replace(/\n$/, '').split('\n');
            const dl = byLine();
            let first = null;
            box.replaceChildren(...lines.map((ln, i) => {
                const n = i + 1;
                const lit = marked.length && lineLit(marked, n, lineTokens(ln));
                const d = dl.get(n);
                const cls = ['pf-line', lit ? 'pf-hl' : '', d ? `pf-line-${d.severity}` : ''].filter(Boolean).join(' ');
                const el = h('div', { class: cls, 'data-line': n, title: d ? `${d.severity}: ${d.message}` : null },
                    h('span', { class: 'pf-lnum', 'aria-hidden': 'true', text: String(n) }), h('span', { class: 'pf-ltext', text: ln || ' ' }));
                if (lit && !first) first = el;
                return el;
            }));
            // Scroll to the declaration of a node target, else to the first lit line.
            const node = marked.find((t) => t.kind === 'node' && nodes[t.id]);
            const at = node ? box.querySelector(`[data-line="${nodes[node.id]}"]`) : first;
            at?.scrollIntoView?.({ block: 'nearest' });
            say();
        }
        async function refresh() {
            if (editing) return;
            const mine = ++token;
            try {
                const out = given
                    ? await request({ text, advise })
                    : await request({ net: ctx.net.get(), advise });
                if (mine !== token || editing) return;
                if (!given) { text = out.text || ''; lossy = out.lossy || []; }
                nodes = out.nodes || {};
                diags = out.diagnostics || [];
            } catch (e) {
                if (mine !== token) return;
                diags = [{ severity: 'info', message: `notation unavailable: ${e?.message || e}`, line: 1, col: 1 }];
            }
            publish();
            paint();
        }
        function setEditing(on) {
            editing = on;
            area.hidden = !on; box.hidden = on;
            editBtn.hidden = on; applyBtn.hidden = !on; cancelBtn.hidden = !on;
            if (on) { area.value = text; area.focus(); }
        }
        async function apply() {
            const src = area.value;
            const mine = ++token;
            status.className = 'pf-status';
            status.textContent = 'Compiling…';
            try {
                const out = await request({ text: src, advise });
                if (mine !== token) return;
                diags = out.diagnostics || [];
                nodes = out.nodes || {};
                publish();
                if (!out.net) { text = src; say(); status.textContent += ' Not applied: fix the errors marked on their lines.'; return; }
                await ctx.net.set(out.net, { origin: 'notation' });
                given = false; text = src;
                setEditing(false);
                refresh();
            } catch (e) {
                status.className = 'pf-status pf-err';
                status.textContent = `Not applied: ${e?.message || e}`;
            }
        }
        function take(p) {
            const src = p?.params?.source;
            given = typeof src === 'string' && src.length > 0;
            if (given) { text = src; lossy = []; }
        }

        take(payload);
        paint();
        refresh();
        const offNet = ctx.on('net', () => { given = false; clearTimeout(timer); timer = setTimeout(refresh, 300); });
        const offHl = ctx.on('highlight', (ev) => { marked = (ev.targets || []).map(ctx.parseTarget).filter(Boolean); if (!editing) paint(); });
        marked = (ctx.shell?.highlights || []).map(ctx.parseTarget).filter(Boolean);
        return {
            update(p) { take(p); refresh(); },
            dispose() { offNet(); offHl(); clearTimeout(timer); token++; ctx.diagnostics.set('notation', []); },
        };
    },
};
