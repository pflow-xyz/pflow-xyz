// petri-tab.js — the page side of tab push (docs/design/tab-push.md), with no DOM and no model.
//
// A signed-in page registers as a tab (POST /api/tab), reads a stream of events (GET /api/tab/{id}/events: SSE
// framing read with fetch, because EventSource cannot send the bearer token), and reports what it shows. A Claude
// client connected to /mcp pushes `show`, `stop` and `get` events with pflow_show, pflow_tab_stop and pflow_tab_get,
// and the teaching verbs (`level`, `highlight`, `annotate`, `focus`, `tour`, `tour_control`) with pflow_level,
// pflow_highlight, pflow_annotate, pflow_focus and pflow_tour. Those go to the IDE shell's one entry,
// window.pflowShell.dispatch (docs/ide-shell.md); the page answers each pushed event on /reply with what it did.
//
//   parseFrames   SSE bytes in, events out (the same ~40 lines BeatScript's site has: a candidate for one shared module)
//   viewCalls     a view name and its params in, the registry calls that make the view out
//   planShow      a `show` event in, what the page should do out: validated here again, because the server's check
//                 is not this page's trust boundary
//   buildReport   what the page says it shows, bounded (256 KiB on the server)
//   TabLink       registers, streams, reconnects, answers; it asks the host (the editor) to do everything visible
//
// An analysis view is not run by this module: planShow hands back a ViewSpec for petri-link-open.js openLinkedView,
// which replays it on a sandbox in a Worker under the same allowlist and bounds as an opened #view= link. A push
// therefore cannot edit the net by running a command; the only thing that changes the canvas is the explicit load,
// and the host keeps what it replaced.
import { buildViewSpec } from './petri-viewspec.js';

export const VIEWS = Object.freeze(['canvas', 'plot', 'reachability', 'invariants', 'categorical', 'notation']);
export const COMPOSE_VIEWS = Object.freeze(['cospan', 'spiders', 'operad', 'string', 'flat', 'boundaries', 'lens', 'incidence', 'process', 'laws']);
export const MAX_NET_BYTES = 256 << 10;
export const MAX_REPORT_BYTES = 256 << 10;
export const MAX_SOURCE_BYTES = 64 << 10;
export const MAX_NOTE = 1000;
const MAX_MARKING_PLACES = 200;
const CID_RE = /^[A-Za-z0-9]{8,200}$/;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** The event types the server sends for the shell's teaching verbs (cmd/webserver/tabs_teach.go). */
export const TEACH_TYPES = Object.freeze(['level', 'highlight', 'annotate', 'focus', 'tour', 'tour_control']);

/**
 * The shell event a teaching push stands for: the server carries the verb's fields in `params` (the hub's event
 * shape is shared with BeatScript and unchanged), the shell takes them at the top level. Null for anything else.
 */
export function teachEvent(ev) {
    if (!isObj(ev) || !TEACH_TYPES.includes(ev.type)) return null;
    const p = isObj(ev.params) ? ev.params : {};
    const { type: _t, request_id: _r, ...fields } = p;
    return { ...fields, type: ev.type, ...(typeof ev.request_id === 'string' ? { request_id: ev.request_id } : {}) };
}

/**
 * Split SSE text into events. Feed it the decoded chunks as they arrive: it returns the complete events and the
 * unfinished tail to prepend to the next chunk. A frame is `event: <name>\ndata: <json>\n\n`; the event is the JSON
 * object, its `type` is the frame's name when the data has none. A comment line (": ...") and a frame whose data is
 * not JSON are skipped.
 * @param {string} text
 * @returns {{events: Object[], rest: string}}
 */
export function parseFrames(text) {
    const events = [];
    const parts = text.replace(/\r\n/g, '\n').split('\n\n');
    const rest = parts.pop() ?? '';
    for (const part of parts) {
        let name = '';
        const data = [];
        for (const line of part.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) name = line.slice(6).trim();
            else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        try {
            const ev = JSON.parse(data.join('\n'));
            if (!isObj(ev)) continue;
            if (!ev.type && name) ev.type = name;
            events.push(ev);
        } catch { /* a damaged frame is skipped, the stream goes on */ }
    }
    return { events, rest };
}

const num = (v, lo, hi, integer) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && (!integer || Number.isInteger(v));

/**
 * The checked params of a view, or an error. The same limits as the server's tool (tabs.go tabParams).
 * @returns {{ok: true, params: Object}|{ok: false, error: string}}
 */
export function checkParams(view, params) {
    const p = params == null ? {} : params;
    if (!isObj(p)) return { ok: false, error: 'params must be an object' };
    const allowed = { plot: ['t_end', 'points', 'runs', 'seed', 'engine'], reachability: ['max_states'], invariants: ['kind'], categorical: ['name'], notation: ['source'], canvas: [] }[view] || [];
    for (const k of Object.keys(p)) if (!allowed.includes(k)) return { ok: false, error: `params.${k} is not a parameter of ${view}` };
    const checks = [['t_end', 1e-9, 10000, false], ['points', 2, 200, true], ['runs', 1, 200, true], ['seed', 0, 2 ** 53, true], ['max_states', 1, 20000, true]];
    for (const [k, lo, hi, int] of checks) if (k in p && !num(p[k], lo, hi, int)) return { ok: false, error: `params.${k} must be a number in [${lo}, ${hi}]` };
    if ('engine' in p && p.engine !== 'ode' && p.engine !== 'ssa') return { ok: false, error: 'params.engine must be "ode" or "ssa"' };
    if ('kind' in p && p.kind !== 'p' && p.kind !== 't') return { ok: false, error: 'params.kind must be "p" or "t"' };
    if ('name' in p && !COMPOSE_VIEWS.includes(p.name)) return { ok: false, error: `params.name must be one of ${COMPOSE_VIEWS.join(', ')}` };
    if ('source' in p && (typeof p.source !== 'string' || p.source.length > MAX_SOURCE_BYTES)) return { ok: false, error: 'params.source must be text' };
    return { ok: true, params: p };
}

/**
 * The registry calls behind an analysis view, fully resolved (a ViewSpec writes its arguments, so a later change
 * here does not change what a saved link shows). Null for a view that runs nothing.
 */
export function viewCalls(view, params = {}) {
    const p = params || {};
    const pick = (keys) => Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));
    switch (view) {
        case 'plot':
            if (p.engine === 'ssa') return [{ command: 'sim.ssa', args: { t_end: 10, ...pick(['t_end', 'runs', 'seed', 'points']) } }];
            return [{ command: 'sim.ode', args: { t_end: 10, ...pick(['t_end', 'points']) } }];
        case 'reachability': return [{ command: 'analysis.reachability', args: { max_states: 2000, ...pick(['max_states']) } }];
        case 'invariants': return [{ command: 'analysis.invariants', args: { kind: 'p', ...pick(['kind']) } }];
        default: return null;
    }
}

/** The composition page's link for a stored composition (public/compose/links.js: ?cid=<cid>#view=<id>). */
export function overlayUrl(cid, name, origin = '') {
    return `${origin}/compose.html?cid=${encodeURIComponent(cid)}#view=${encodeURIComponent(name)}`;
}

/** Whether a value is a net the editor could hold: object-keyed places and transitions, arcs as a list. */
export function netOk(net) {
    if (!isObj(net)) return 'the net is not a JSON object';
    for (const k of ['places', 'transitions']) if (net[k] != null && !isObj(net[k])) return `net.${k} must be an object keyed by id`;
    if (net.arcs != null && !Array.isArray(net.arcs)) return 'net.arcs must be a list';
    if (JSON.stringify(net).length > MAX_NET_BYTES) return `the net is over ${MAX_NET_BYTES} bytes`;
    return '';
}

/**
 * What the page does with a `show` event. Never throws.
 *   {ok: false, error}
 *   {ok: true, view, net, cid, loadNet, spec, overlay, source, note}
 * `loadNet` is true when the canvas should take the net first (every view but categorical); `spec` is a ViewSpec
 * for openLinkedView when the view is an analysis; `overlay` is the composition page's URL for categorical.
 */
export function planShow(ev, { origin = '' } = {}) {
    try {
        if (!isObj(ev) || ev.type !== 'show') return { ok: false, error: 'not a show event' };
        const view = ev.view;
        if (!VIEWS.includes(view)) return { ok: false, error: `unknown view ${JSON.stringify(String(view).slice(0, 40))}` };
        const note = typeof ev.note === 'string' ? ev.note.slice(0, MAX_NOTE) : '';
        const cid = typeof ev.cid === 'string' && ev.cid ? ev.cid : null;
        if (cid && !CID_RE.test(cid)) return { ok: false, error: 'the CID is not well formed' };
        const pc = checkParams(view, ev.params);
        if (!pc.ok) return { ok: false, error: pc.error };
        if (view === 'categorical') {
            if (!cid) return { ok: false, error: 'a categorical view needs a stored composition cid' };
            const name = pc.params.name || 'cospan';
            return { ok: true, view, net: null, cid, loadNet: false, spec: null, overlay: overlayUrl(cid, name, origin), source: '', note };
        }
        const bad = netOk(ev.net);
        if (bad) return { ok: false, error: bad };
        const calls = viewCalls(view, pc.params);
        const spec = calls ? buildViewSpec({ net: null, view, calls, note: note || null }) : null;
        return { ok: true, view, net: ev.net, cid, loadNet: true, spec, overlay: '', source: view === 'notation' ? (pc.params.source || '') : '', note };
    } catch (e) {
        return { ok: false, error: `the event could not be read (${e && e.message ? e.message : e})` };
    }
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const sumTokens = (v) => (Array.isArray(v) ? v.reduce((a, b) => a + (Number(b) || 0), 0) : Number(v) || 0);

async function digest(text) {
    try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return 'sha256:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch { return ''; }
}

/**
 * What the page says it shows. A bounded summary, not the net, unless `includeNet`: the marking is capped at
 * 200 places and the whole report at MAX_REPORT_BYTES (the net is dropped first when it does not fit).
 * @param {{model: Object|null, cid?: string|null, view?: string, results?: Array<{title: string, status?: string}>, dirty?: boolean, note?: string}} snap
 * @param {{includeNet?: boolean}} [o]
 * @returns {Promise<any>}
 */
export async function buildReport(snap, { includeNet = false } = {}) {
    /** @type {Object} */
    const m = isObj(snap.model) ? snap.model : {};
    const places = isObj(m.places) ? m.places : {};
    const ids = Object.keys(places);
    const marking = {};
    for (const id of ids.slice(0, MAX_MARKING_PLACES)) marking[id] = sumTokens(places[id]?.initial);
    const r = {
        cid: snap.cid || '',
        view: snap.view || 'canvas',
        places: ids.length,
        transitions: isObj(m.transitions) ? Object.keys(m.transitions).length : 0,
        arcs: Array.isArray(m.arcs) ? m.arcs.length : 0,
        marking,
        net_hash: await digest(JSON.stringify(m)),
        results: (snap.results || []).slice(0, 20).map((x) => ({ title: String(x.title || '').slice(0, 200), ...(x.status ? { status: String(x.status).slice(0, 200) } : {}) })),
        dirty: !!snap.dirty,
    };
    if (snap.note) r.note = String(snap.note).slice(0, MAX_NOTE);
    if (Array.isArray(snap.panels)) r.panels = snap.panels.slice(0, 50);
    if (isObj(snap.shell)) {
        // The shell's state(): ids and types only, never a net (petri-shell.js), so it may travel.
        const sh = snap.shell;
        r.shell = { level: String(sh.level || ''), tour: isObj(sh.tour) ? { title: String(sh.tour.title || '').slice(0, 80), step: Number(sh.tour.step) || 0, of: Number(sh.tour.of) || 0 } : null, modal: isObj(sh.modal) ? { id: String(sh.modal.id), type: String(sh.modal.type) } : null, highlights: Array.isArray(sh.highlights) ? sh.highlights.slice(0, 50).map(String) : [] };
    }
    if (includeNet) {
        r.net = m;
        if (JSON.stringify(r).length > MAX_REPORT_BYTES - 1024) { delete r.net; r.net_omitted = 'over the report limit'; }
    }
    return r;
}

/**
 * What the shell answered, bounded and plain (never a payload).
 * @param {any} res
 * @returns {Record<string, any>}
 */
export function clampResult(res) {
    if (!isObj(res)) return { ok: false };
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(res).slice(0, 20)) {
        if (typeof v === 'string') out[k] = v.slice(0, 300);
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v;
    }
    out.ok = res.ok === true;
    return out;
}

// ---------------------------------------------------------------------------
// The link
// ---------------------------------------------------------------------------

export const BACKOFF_MS = Object.freeze([1000, 2000, 5000, 15000]);

/**
 * The page's end of the channel. `host` is the editor:
 *   snapshot()                      {model, cid, view, results, dirty}: what is shown now
 *   loadNet(net, {cid})             put the net on the canvas (the host keeps what it replaced)
 *   runSpec(spec, net)              Promise: replay a ViewSpec through openLinkedView and show the result card
 *   openOverlay(url)                show the composition page over the editor
 *   setNotation(source, net)        hand text to the notation panel, if there is one
 *   shellOpen(ev) / shellClose(id)  optional: an IDE shell takes the event as it is (its answer, or false when there is no
 *                                   shell); snapshot() may add `panels` and `shell` (the shell's state(): ids and types)
 *   shellDispatch(evt)              optional: the shell's dispatch for a teaching verb (its answer, or false: no shell)
 *   closeViews()                    close result cards and overlays, cancel a running replay
 *   notice(text, {kind})            one line for the person
 *   onState(state)                  'linking' | 'linked' | 'reconnecting' | 'off' | 'refused'
 */
export class TabLink {
    /** @param {{host: Object, token: string, fetchImpl?: Function, base?: string, origin?: string, backoff?: readonly number[], wait?: (ms: number) => Promise<void>}} o */
    constructor({ host, token, fetchImpl, base = '', origin = '', backoff = BACKOFF_MS, wait }) {
        this.host = host;
        this.token = token;
        this.f = fetchImpl || ((...a) => globalThis.fetch(...a));
        this.base = base;
        this.origin = origin;
        this.backoff = backoff;
        this.wait = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.id = null;
        this.stopped = true;
        this.abort = null;
        this.loop = null;
    }

    _h(extra = {}) { return { Authorization: `Bearer ${this.token}`, ...extra }; }

    /** Register and start streaming. Resolves once the tab is registered (the loop goes on in the background). */
    async start() {
        this.stopped = false;
        this.host.onState?.('linking');
        const r = await this._register();
        if (!r) return false;
        this.loop = this._run();
        return true;
    }

    async _register() {
        const res = await this.f(`${this.base}/api/tab`, { method: 'POST', headers: this._h() });
        if (res.status === 401 || res.status === 403) { this._off('refused', 'The link needs you signed in to pflow.xyz.'); return false; }
        if (!res.ok) { this._off('refused', `The link could not start (${res.status}).`); return false; }
        const body = await res.json();
        this.id = body.id;
        return true;
    }

    _off(state, text) {
        this.stopped = true;
        this.host.onState?.(state);
        if (text) this.host.notice?.(text, { kind: 'warn' });
    }

    /** Stop streaming and unlink the tab on the server (best effort). */
    async stop() {
        const id = this.id;
        this.stopped = true;
        try { this.abort?.abort(); } catch { /* already closed */ }
        this.id = null;
        this.host.onState?.('off');
        if (id) { try { await this.f(`${this.base}/api/tab/${id}`, { method: 'DELETE', headers: this._h() }); } catch { /* the sweeper takes it */ } }
    }

    async _run() {
        let failures = 0;
        while (!this.stopped) {
            let gotHello = false;
            try {
                this.abort = new AbortController();
                const res = await this.f(`${this.base}/api/tab/${this.id}/events`, { headers: this._h({ Accept: 'text/event-stream' }), signal: this.abort.signal });
                if (res.status === 401 || res.status === 403) { this._off('refused', 'The link was refused: sign in again.'); return; }
                if (res.status === 404) { if (!(await this._register())) return; continue; } // the tab was swept: a new one
                if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    const { events, rest } = parseFrames(buf);
                    buf = rest;
                    for (const ev of events) {
                        if (ev.type === 'hello') { gotHello = true; failures = 0; this.host.onState?.('linked', { id: this.id }); }
                        await this.handle(ev);
                    }
                }
            } catch (e) {
                if (this.stopped) return;
            }
            if (this.stopped) return;
            this.host.onState?.('reconnecting');
            if (!gotHello) failures++;
            await this.wait(this.backoff[Math.min(failures, this.backoff.length - 1)]);
        }
    }

    /** Handle one event from the server. Exposed for tests. */
    async handle(ev) {
        try {
            switch (ev.type) {
                case 'show': await this._show(ev); break;
                case 'stop': if (!this.host.shellClose?.(ev.request_id)) this.host.closeViews?.(); await this.report(); break;
                case 'get': await this._reply(ev); break;
                default: {
                    const evt = teachEvent(ev);
                    if (evt) await this._teach(ev, evt);
                    break; // hello, ping, and anything a later server adds
                }
            }
        } catch (e) {
            this.host.notice?.(`A pushed view failed (${e && e.message ? e.message : e}).`, { kind: 'warn' });
        }
    }

    async _show(ev) {
        // An IDE shell (window.pflowShell, docs/ide-shell.md) takes the unchanged event; without one the page's own path runs.
        const shown = this.host.shellOpen?.(ev);
        if (shown) { await this.answer(ev.request_id, isObj(shown) ? shown : { ok: true }); return; }
        const plan = planShow(ev, { origin: this.origin });
        if (!plan.ok) {
            this.host.notice?.(`Claude pushed something this page cannot show: ${plan.error}.`, { kind: 'warn' });
            await this.answer(ev.request_id, { ok: false, error: plan.error }, { note: `refused: ${plan.error}` });
            return;
        }
        if (plan.loadNet) this.host.loadNet(plan.net, { cid: plan.cid });
        if (plan.source) this.host.setNotation?.(plan.source, plan.net);
        if (plan.overlay) this.host.openOverlay(plan.overlay);
        await this.answer(ev.request_id, { ok: true, view: plan.view }); // before the replay, which may take a while
        if (plan.spec) await this.host.runSpec(plan.spec, plan.net);
        await this.report();
    }

    async _teach(ev, evt) {
        const res = this.host.shellDispatch?.(evt);
        const result = isObj(res) ? res : { ok: false, error: 'this page has no IDE shell: open pflow.xyz with ?shell=1' };
        if (!isObj(res)) this.host.notice?.('Claude sent a step of a walkthrough, which needs the IDE shell (?shell=1).', { kind: 'warn' });
        await this.answer(ev.request_id, result);
    }

    /**
     * Answer a pushed event: the report, plus `result` (what the shell or the page did with it), posted on /reply under
     * the event's request_id, which is where the MCP tool waits (tabhub PushAwait). With no request_id, a plain report.
     */
    async answer(requestId, result, extra = {}) {
        if (this.stopped || !this.id) return;
        if (typeof requestId !== 'string' || !requestId) { await this.report(extra); return; }
        const state = { ...(await buildReport(this.host.snapshot())), ...extra, result: clampResult(result) };
        await this.f(`${this.base}/api/tab/${this.id}/reply`, { method: 'POST', headers: this._h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ request_id: requestId, state }) });
    }

    async _reply(ev) {
        const wantNet = !!(ev.params && ev.params.net);
        const state = await buildReport(this.host.snapshot(), { includeNet: wantNet });
        await this.f(`${this.base}/api/tab/${this.id}/reply`, { method: 'POST', headers: this._h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ request_id: ev.request_id, state }) });
    }

    /** Tell the server what is shown now. */
    async report(extra = {}) {
        if (this.stopped || !this.id) return;
        const rep = { ...(await buildReport(this.host.snapshot())), ...extra };
        await this.f(`${this.base}/api/tab/${this.id}/report`, { method: 'POST', headers: this._h({ 'Content-Type': 'application/json' }), body: JSON.stringify(rep) });
    }
}
