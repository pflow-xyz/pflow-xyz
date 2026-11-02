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
//   - artifacts land in the editor's own store, so they show up in Results;
//   - a command whose answer depends on the engine is checked against the
//     net's own recommendation first (petri-engine-guard.js): a refusal is
//     the tool's error answer, so the model reads why and nothing ran.
//
// post(body) is injected: the UI passes a fetch to /api/llm/turn, tests a
// scripted model.
import { Registry, createHeadlessHost } from './petri-commands.js';
import { decodeCall, summarizeResult } from './petri-tools.js';
import { EngineGuard, isEdit, needsGuard, refusalText } from './petri-engine-guard.js';

// isEdit (which commands change the document, or the token game's marking,
// which lives in it: they make the sandbox differ from the live net) lives in
// the engine guard, which reads the same rule to judge a macro's steps; it is
// exported from here too, for the packages that gate on it.
export { isEdit };
// Commands that act on the canvas: always the live registry.
const VIEW = new Set(['view.highlight', 'view.clear_highlight', 'view.fit', 'artifact.show_set']);

export const MODES = ['auto', 'build', 'analyse', 'explain'];

// 'auto' lets the server label each message (intent and sentiment); the
// label picks one of the three real modes for that message's tool loop.

// sim's interview steps (pkg/builder): the server adds each step's guidance
// to the build mode's brief. The model ends a reply with "Next: <step>" when
// a step is complete; only a forward move is taken.
export const STEPS = ['describe', 'structure', 'rates', 'validate', 'preview', 'done'];

/** The step a reply asks to move to, or null. */
export function nextStepIn(text, current) {
    const m = /\bNext:\s*(describe|structure|rates|validate|preview|done)\b/i.exec(String(text || ''));
    if (!m) return null;
    const to = m[1].toLowerCase();
    return STEPS.indexOf(to) > STEPS.indexOf(current) ? to : null;
}

function checksText(report) {
    if (!report.findings.length) return `Checks after your edits (the engine's): none failed (${report.exhaustive ? 'every reachable marking explored' : report.note}).`;
    return `Checks after your edits (the engine's, not yours to dispute; fix them or say why they are intended):\n`
        + report.findings.map((f) => `- ${f.category}: ${f.message}`).join('\n')
        + (report.exhaustive ? '' : `\n(${report.note})`);
}

/**
 * The manifest's tools a mode can run: all of them, but for explain, which refuses an edit (runCall). A tool that edits
 * only when asked to (opt.fit with apply) stays, since it runs without edits there.
 * @returns {Array<{name: string, command: string, description: string}>}
 */
export function toolsFor(manifest, mode) {
    return mode === 'explain' ? manifest.tools.filter((t) => !isEdit(t.command, {})) : manifest.tools;
}

export class ChatSession {
    /**
     * @param {Object} o
     * @param {Registry} o.live      the editor's registry
     * @param {Object} o.manifest    public/llm-tools.json
     * @param {(body: Object) => Promise<Object>} o.post   one /api/llm/turn call
     * @param {string} [o.mode]
     * @param {number} [o.maxRounds] model calls per message at most (default 6)
     * @param {(ms: number) => Promise<void>} [o.sleep] how a 429's wait is spent (tests pass a fake)
     * @param {number} [o.maxWaitS] the longest 429 advice worth waiting out, in seconds (default 90)
     */
    constructor({ live, manifest, post, mode = 'analyse', maxRounds = 6, step = 'describe', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxWaitS = 90 }) {
        this.sleep = sleep;
        this.maxWaitS = maxWaitS;
        this.live = live;
        this.manifest = manifest;
        this.post = post;
        this.mode = mode;
        /** In auto mode: the mode the last message resolved to (analyse, the read-only one, until one has). */
        this.resolved = null;
        this.step = step;
        this.maxRounds = maxRounds;
        /** The engine guard, over whichever sandbox is current. */
        this.guard = new EngineGuard(() => this.sandbox);
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

    /** The mode the tools run under: the chosen one, or auto's latest label. */
    get effectiveMode() {
        return this.mode === 'auto' ? (this.resolved || 'analyse') : this.mode;
    }

    /** What the assistant can use right now; `calls` is what it has used. */
    get tools() {
        return toolsFor(this.manifest, this.effectiveMode);
    }

    async _netSummary() {
        const info = await this.sandbox.execute('net.info');
        const s = JSON.stringify(info);
        return s.length <= 20000 ? info : { note: 'net too large to summarise in full', places: info.places.length, transitions: info.transitions.length, arcs: info.arcs.length };
    }

    /**
     * One /api/llm/turn call. A 429 that advises a short wait (the per-minute
     * limit: "try again in 17 s") is waited out and retried here, with the
     * same messages, so a turn whose tools already ran (and spent calls) is
     * not dropped and the person does not have to type "continue". A daily
     * limit (hours) is not waited out: it is thrown as is.
     */
    async _post(body, onEvent) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.post(body);
            } catch (e) {
                const s = e.retryAfter;
                if (e.status !== 429 || !(s > 0) || s > this.maxWaitS || attempt >= 3) throw e;
                onEvent({ type: 'wait', seconds: s, attempt: attempt + 1 });
                await this.sleep((s + 1) * 1000);
            }
        }
    }

    /** The person's latest typed message (not a tool answer), or ''. */
    _lastUserText() {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role !== 'user' || (m.parts || []).some((p) => p.functionResponse)) continue;
            const text = (m.parts || []).filter((p) => typeof p.text === 'string').map((p) => p.text).join('\n');
            if (text) return text;
        }
        return '';
    }

    /**
     * Run one model call's tool call. Never throws: a failure is the tool's
     * answer. A command whose answer depends on the engine goes through the
     * engine guard first: when the net's recommendation rules the engine out,
     * the answer is "refused: <why>" and nothing runs; when it runs on a
     * caution, entry.warning carries the chip's text.
     * @param {{name: string, args?: Object}} call
     * @param {number} [round]
     * @param {Object} [opts]
     * @param {string} [opts.override]  the engine the model asks for against the recommendation (a run_goal / run_command
     *   engine_override); honoured only when the person's latest message names that engine
     * @param {boolean} [opts.canOverride]  the interface this call came through offers an engine_override, so the refusal
     *   tells the model it can pass one. The plain tools have none: there the refusal is final
     * @param {string} [opts.userText]  the person's words, when not their latest message (a rerun)
     * @returns {Promise<any>} the logged call: {round, name, command, args, ok, result?, error?, refused?, warning?, override?, artifacts, ms}
     */
    async runCall(call, round = 0, opts = {}) {
        const t0 = Date.now();
        const entry = { round, name: call.name, args: call.args || {}, ok: false, artifacts: [] };
        try {
            const [id, args] = decodeCall(this.manifest, call);
            entry.command = id;
            entry.args = args;
            if (this.effectiveMode === 'explain' && isEdit(id, args)) throw new Error('explain mode does not edit; switch to build to change the net');
            if (!this.pending && !VIEW.has(id)) this._reseed();
            if (!VIEW.has(id) && needsGuard(id, args)) {
                const userText = opts.userText ?? this._lastUserText();
                const v = await this.guard.check(id, args, { override: opts.override, userText });
                if (v.verdict === 'refuse') {
                    entry.refused = { rule: v.rule, message: v.message, recommended: v.recommended };
                    throw new Error(refusalText(v, { canOverride: !!opts.canOverride }));
                }
                if (v.verdict === 'warn') {
                    entry.warning = v.message;
                    if (v.overridden) {
                        entry.override = v.needs;
                        entry.overrideText = userText;
                    }
                }
            }
            const reg = VIEW.has(id) ? this.live : this.sandbox;
            const before = new Set(reg.artifacts().map((a) => a.id));
            entry.result = await reg.execute(id, args);
            entry.ok = true;
            entry.artifacts = reg.artifacts().filter((a) => !before.has(a.id)).map((a) => a.id);
            if (isEdit(id, args)) this.pending = true;
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
        if (entry.warning) payload.warning = `${entry.warning}. Say so when you report this result.`;
        if (this.pending && isEdit(entry.command, entry.args)) payload.note = 'previewed in the sandbox; the person applies or discards it';
        return { name: entry.name, response: payload };
    }

    /**
     * Send the person's message and run the loop until the model answers
     * without tools, or maxRounds model calls. onEvent receives
     * {type: 'reply' | 'call' | 'round' | 'quota' | 'auto' | 'wait', ...} as it happens.
     * @param {string} text
     * @param {(e: Object) => void} [onEvent]
     * @returns {Promise<{reply: string, rounds: number, stopped?: string}>}
     */
    async send(text, onEvent = () => {}) {
        if (!this.pending) this._reseed();
        this.messages.push({ role: 'user', parts: [{ text }] });
        let reply = '';
        for (let round = 1; round <= this.maxRounds; round++) {
            onEvent({ type: 'round', round });
            // Auto asks the server to label the message on the first round only;
            // later rounds (tool results) carry the mode it chose.
            const labelling = this.mode === 'auto' && round === 1;
            const body = { mode: labelling ? 'auto' : this.effectiveMode, net: await this._netSummary(), messages: this.messages };
            if (labelling && this.resolved) body.prev_mode = this.resolved;
            if (labelling || this.effectiveMode === 'build') body.step = this.step;
            const resp = await this._post(body, onEvent);
            if (labelling && resp.auto) {
                this.resolved = resp.auto.mode;
                onEvent({ type: 'auto', ...resp.auto });
            }
            if (resp.remaining_today !== undefined) onEvent({ type: 'quota', remaining: resp.remaining_today, reset: resp.reset });
            this.messages.push(resp.message && resp.message.parts?.length ? resp.message : { role: 'model', parts: [{ text: resp.reply || '…' }] });
            if (resp.reply) {
                reply = resp.reply;
                onEvent({ type: 'reply', text: resp.reply });
                const to = this.effectiveMode === 'build' ? nextStepIn(resp.reply, this.step) : null;
                if (to) {
                    this.step = to;
                    onEvent({ type: 'step', step: to });
                }
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
            // Build mode: after a round that edited the net, the engine's
            // behaviour checks go back with the tool results (sim's builder
            // feeds its checks back the same way).
            if (this.effectiveMode === 'build' && this.calls.some((e) => e.round === round && e.ok && isEdit(e.command, e.args))) {
                try {
                    const report = await this.sandbox.execute('analysis.behaviour');
                    this.lastChecks = report;
                    onEvent({ type: 'checks', report });
                    parts.push({ text: checksText(report) });
                } catch { /* the checks are advice; never stop the loop */ }
            }
            this.messages.push({ role: 'user', parts });
        }
        return { reply, rounds: this.maxRounds, stopped: `stopped after ${this.maxRounds} model calls; ask to continue` };
    }

    /**
     * The refinement gate (sim's defect weight) for the live net and the
     * sandbox: dead transitions, unmarked siphons, unreachable goals, and,
     * for the sandbox, the live net's conservation laws it no longer keeps.
     * @returns {Promise<{before: Object, after: Object, worse: boolean}>}
     */
    async weights() {
        const inv = await this.live.execute('analysis.invariants', { kind: 'p' }).catch(() => null);
        const laws = (inv?.p_invariants || []).map((p) => p.coefficients);
        const before = await this.live.execute('analysis.defects', {});
        const after = await this.sandbox.execute('analysis.defects', { baseline_laws: laws });
        return { before, after, worse: after.weight > before.weight };
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
        // An override the person's words once earned (entry.override) is theirs still.
        const again = entry.override ? { override: entry.override, userText: entry.overrideText } : {};
        return this.runCall({ name: entry.name, args: entry.args }, entry.round, again);
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
