// petri-chat.js — the editor's assistant: the tool loop, with no DOM.
//
// A ChatSession holds one conversation with /api/llm/turn and runs the tools
// the model asks for, which are registry commands (petri-tools.js maps
// names). The model never touches the live document:
//
//   - edits run in a SANDBOX registry over a copy of the net; the person sees
//     the pending change as a diff and applies it as one undo step, or
//     discards it (ROADMAP phase 4, "Edits are previews until applied");
//   - queries and analyses run in the sandbox too, so the model can check its
//     own edits before the person applies them;
//   - view commands (highlight, show a set, fit) act on the live canvas;
//   - artifacts land in the editor's own store, so they show up in Results.
//
// post(body) is injected: the UI passes a fetch to /api/llm/turn, tests a
// scripted model.
import { Registry, createHeadlessHost } from './petri-commands.js';
import { decodeCall, summarizeResult } from './petri-tools.js';

// Commands that change the document (or the token game's marking, which
// lives in it): they make the sandbox differ from the live net.
const EDITS = new Set(['file.new', 'edit.undo', 'edit.redo', 'edit.delete', 'sim.fire', 'sim.reset', 'sim.set_rate', 'sim.goto']);
const isEdit = (id) => EDITS.has(id) || (id.startsWith('net.') && id !== 'net.info');
// Commands that act on the canvas: always the live registry.
const VIEW = new Set(['view.highlight', 'view.clear_highlight', 'view.fit', 'artifact.show_set']);

export const MODES = ['build', 'analyse', 'explain'];

export class ChatSession {
    /**
     * @param {Object} o
     * @param {Registry} o.live      the editor's registry
     * @param {Object} o.manifest    public/llm-tools.json
     * @param {(body: Object) => Promise<Object>} o.post   one /api/llm/turn call
     * @param {string} [o.mode]
     * @param {number} [o.maxRounds] model calls per message at most (default 6)
     */
    constructor({ live, manifest, post, mode = 'analyse', maxRounds = 6 }) {
        this.live = live;
        this.manifest = manifest;
        this.post = post;
        this.mode = mode;
        this.maxRounds = maxRounds;
        this.messages = [];
        /** {round, name, command, args, ok, result?, error?, artifacts: string[], ms} */
        this.calls = [];
        this.pending = false;
        this._reseed();
    }

    _reseed() {
        const host = createHeadlessHost(structuredClone(this.live.host.getModel()));
        this.sandbox = new Registry(host, undefined, { store: this.live._store });
        this.pending = false;
    }

    /** The sandbox's net (what the model sees and edits). */
    model() {
        return this.sandbox.host.getModel();
    }

    setMode(mode) {
        if (!MODES.includes(mode)) throw new Error(`mode must be ${MODES.join(', ')}`);
        this.mode = mode;
    }

    async _netSummary() {
        const info = await this.sandbox.execute('net.info');
        const s = JSON.stringify(info);
        return s.length <= 20000 ? info : { note: 'net too large to summarise in full', places: info.places.length, transitions: info.transitions.length, arcs: info.arcs.length };
    }

    /** Run one model call's tool call. Never throws: a failure is the tool's answer. */
    async runCall(call, round = 0) {
        const t0 = Date.now();
        const entry = { round, name: call.name, args: call.args || {}, ok: false, artifacts: [] };
        try {
            const [id, args] = decodeCall(this.manifest, call);
            entry.command = id;
            entry.args = args;
            if (this.mode === 'explain' && isEdit(id)) throw new Error('explain mode does not edit; switch to build to change the net');
            if (!this.pending && !VIEW.has(id)) this._reseed();
            const reg = VIEW.has(id) ? this.live : this.sandbox;
            const before = new Set(reg.artifacts().map((a) => a.id));
            entry.result = await reg.execute(id, args);
            entry.ok = true;
            entry.artifacts = reg.artifacts().filter((a) => !before.has(a.id)).map((a) => a.id);
            if (isEdit(id)) this.pending = true;
        } catch (e) {
            entry.error = e.message || String(e);
        }
        entry.ms = Date.now() - t0;
        this.calls.push(entry);
        return entry;
    }

    _responseFor(entry) {
        if (!entry.ok) return { name: entry.name, response: { error: entry.error } };
        const arts = entry.artifacts.map((id) => this.live._store.items.find((a) => a.id === id)).filter(Boolean);
        const payload = summarizeResult(entry.result, arts);
        if (this.pending && isEdit(entry.command)) payload.note = 'previewed in the sandbox; the person applies or discards it';
        return { name: entry.name, response: payload };
    }

    /**
     * Send the person's message and run the loop until the model answers
     * without tools, or maxRounds model calls. onEvent receives
     * {type: 'reply' | 'call' | 'round' | 'quota', ...} as it happens.
     * @returns {Promise<{reply: string, rounds: number, stopped?: string}>}
     */
    async send(text, onEvent = () => {}) {
        if (!this.pending) this._reseed();
        this.messages.push({ role: 'user', parts: [{ text }] });
        let reply = '';
        for (let round = 1; round <= this.maxRounds; round++) {
            onEvent({ type: 'round', round });
            const resp = await this.post({ mode: this.mode, net: await this._netSummary(), messages: this.messages });
            if (resp.remaining_today !== undefined) onEvent({ type: 'quota', remaining: resp.remaining_today, reset: resp.reset });
            this.messages.push(resp.message && resp.message.parts?.length ? resp.message : { role: 'model', parts: [{ text: resp.reply || '…' }] });
            if (resp.reply) {
                reply = resp.reply;
                onEvent({ type: 'reply', text: resp.reply });
            }
            const calls = resp.tool_calls || [];
            const refused = resp.refused || [];
            if (!calls.length && !refused.length) return { reply, rounds: round };
            const parts = [];
            for (const c of calls) {
                const entry = await this.runCall(c, round);
                onEvent({ type: 'call', entry });
                parts.push({ functionResponse: this._responseFor(entry) });
            }
            for (const r of refused) parts.push({ functionResponse: { name: r.name, response: { error: `refused: ${r.reason}` } } });
            this.messages.push({ role: 'user', parts });
        }
        return { reply, rounds: this.maxRounds, stopped: `stopped after ${this.maxRounds} model calls; ask to continue` };
    }

    /** What applying would change: nodes, arcs, rates and the marking. */
    diff() {
        return diffNets(this.live.host.getModel(), this.model());
    }

    /** Commit the sandbox's net to the editor as one undo step. */
    apply() {
        if (!this.pending) return false;
        this.live.host.commit(structuredClone(this.model()), 'assistant edits');
        this._reseed();
        return true;
    }

    discard() {
        this._reseed();
    }

    /** Re-run one logged call by hand (the Tools panel's Rerun). */
    rerun(entry) {
        return this.runCall({ name: entry.name, args: entry.args }, entry.round);
    }
}

/**
 * A structural diff of two editor nets.
 * @returns {{added: string[], removed: string[], changed: string[], arcsAdded: string[], arcsRemoved: string[], empty: boolean}}
 */
export function diffNets(a, b) {
    const nodes = (m) => new Map([...Object.entries(m.places || {}).map(([k, v]) => [k, ['place', v]]), ...Object.entries(m.transitions || {}).map(([k, v]) => [k, ['transition', v]])]);
    const na = nodes(a), nb = nodes(b);
    const added = [], removed = [], changed = [];
    for (const [id, [kind]] of nb) if (!na.has(id)) added.push(`${kind} ${id}`);
    for (const [id, [kind]] of na) if (!nb.has(id)) removed.push(`${kind} ${id}`);
    const fields = ['label', 'initial', 'capacity', 'rate', 'description'];
    for (const [id, [kind, vb]] of nb) {
        if (!na.has(id)) continue;
        const va = na.get(id)[1];
        const diffs = fields.filter((f) => JSON.stringify(va[f] ?? null) !== JSON.stringify(vb[f] ?? null))
            .map((f) => `${f} ${JSON.stringify(va[f] ?? null)} → ${JSON.stringify(vb[f] ?? null)}`);
        if (diffs.length) changed.push(`${kind} ${id}: ${diffs.join(', ')}`);
    }
    const arc = (x) => `${x.source} → ${x.target}${x.inhibitTransition ? ' (inhibit)' : ''} ×${JSON.stringify(x.weight)}`;
    const aa = new Set((a.arcs || []).map(arc)), ab = new Set((b.arcs || []).map(arc));
    const arcsAdded = [...ab].filter((x) => !aa.has(x)), arcsRemoved = [...aa].filter((x) => !ab.has(x));
    const meta = ['name', 'description'].filter((k) => (a[k] ?? null) !== (b[k] ?? null)).map((k) => `net ${k}`);
    changed.push(...meta);
    return { added, removed, changed, arcsAdded, arcsRemoved, empty: !added.length && !removed.length && !changed.length && !arcsAdded.length && !arcsRemoved.length };
}
