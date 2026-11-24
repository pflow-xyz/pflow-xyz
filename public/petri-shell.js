// petri-shell.js — the IDE shell's core: a registry of view types, the layout of the docks, and the one entry point
// every result goes through (docs/ide-shell.md). No DOM, no network, no model: deno tests it directly
// (petri-shell_test.ts), and petri-shell-ui.js draws what it decides.
//
// The idea in four lines. A VIEW TYPE is a name plus a declared kind: a `panel` that lives in a dock (left, center,
// right, bottom) or a `modal` that opens over everything. open(evt) takes a `show` event (the shape the MCP tab-push
// run delivers: docs/design/tab-push.md) or the same object built by a local action, finds the view type, and opens it
// where it declared. A new view is one registry entry; the layout code never learns its name.
//
// Rules this file keeps:
//   * An event naming a type nobody registered still shows: a generic `result` modal with its note and params, so a
//     newer MCP server's view degrades to text instead of failing.
//   * A pushed net is NEVER part of the persisted layout. The layout stores only which panels are open and where; a
//     reload reopens them empty and each one reads the live canvas (a private push is held in memory, nowhere else).
//   * Caps match tab-push: a net of at most 256 KiB, a note of at most 1000 characters.

export const DOCKS = Object.freeze(['left', 'center', 'right', 'bottom']);
export const KINDS = Object.freeze(['panel', 'modal']);
/** The width below which every dock folds into one tab bar (petri-shell.css uses the same number). */
export const PHONE_MAX = 760;
/**
 * How much of the machinery a person sees. `outcome`: a question and its answer in plain words, no Petri-net terms.
 * `model`: the net itself (canvas, notation, outline, simulation). `math`: the structure underneath (invariants,
 * reachability, categorical views). A view declares its level; the shell shows only views at or above... at or below the
 * level it is set to (outcome shows outcome views; math shows all). Stepping DOWN a level means asking for more detail.
 */
export const LEVELS = Object.freeze(['outcome', 'model', 'math']);
export const levelIndex = (l) => LEVELS.indexOf(l);
export const MAX_TARGETS = 50;
export const MAX_STEPS = 30;
export const LAYOUT_KEY = 'pflow_shell_layout';
export const MAX_NET_BYTES = 256 << 10;
export const MAX_NOTE = 1000;

const TYPE_RE = /^[a-z][a-z0-9-]{0,39}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// The registry of view types
// ---------------------------------------------------------------------------

/**
 * A view type's declaration:
 *   type       lower-case name, the same string an MCP `show` event carries as `view`
 *   kind       'panel' | 'modal'
 *   dock       panels only: where it opens by default ('left' | 'center' | 'right' | 'bottom')
 *   title      the tab or dialog heading
 *   singleton  panels only, default true: opening it again reuses the panel (and replaces its payload)
 *   live       default true: with no net in the event the view reads the canvas's current net
 *   render     (host: HTMLElement, payload, ctx) => void | {update?(payload), dispose?()}   (the UI layer calls it)
 *   summary    optional (payload) => string for the shell's state() (what an agent may read back)
 *   level      'outcome' | 'model' (default) | 'math': the least detail at which the view is shown (see LEVELS)
 *   pinned     the canvas only: already on the page, never placed in a dock
 */
export class ViewRegistry {
    constructor() { this.defs = new Map(); }

    register(def) {
        if (!isObj(def)) throw new TypeError('a view type is an object');
        const { type, kind } = def;
        if (typeof type !== 'string' || !TYPE_RE.test(type)) throw new TypeError(`view type ${JSON.stringify(type)}: lower-case letters, digits and hyphens, starting with a letter`);
        if (!KINDS.includes(kind)) throw new TypeError(`view ${type}: kind must be one of ${KINDS.join(', ')}`);
        if (kind === 'panel' && !DOCKS.includes(def.dock)) throw new TypeError(`view ${type}: dock must be one of ${DOCKS.join(', ')}`);
        if (typeof def.render !== 'function') throw new TypeError(`view ${type}: render(host, payload, ctx) is required`);
        if (def.level !== undefined && !LEVELS.includes(def.level)) throw new TypeError(`view ${type}: level must be one of ${LEVELS.join(', ')}`);
        const full = Object.freeze({ singleton: true, live: true, title: type, level: 'model', ...def });
        this.defs.set(type, full);
        return full;
    }

    has(type) { return this.defs.has(type); }
    get(type) { return this.defs.get(type) || null; }

    /** What the registry offers, for a `hello` event, the palette and the docs: sorted by type. */
    types() {
        return [...this.defs.values()]
            .map((d) => ({ type: d.type, kind: d.kind, level: d.level, ...(d.kind === 'panel' ? { dock: d.dock } : {}), title: d.title }))
            .sort((a, b) => a.type.localeCompare(b.type));
    }
}

// ---------------------------------------------------------------------------
// Planning an open: a `show` event in, what to open out (pure)
// ---------------------------------------------------------------------------

/** The id of a panel instance: the type for a singleton, `type:n` for the nth of a kind that may repeat. */
export function instanceId(def, n = 0) {
    return def.singleton === false && n > 0 ? `${def.type}:${n}` : def.type;
}

const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

/**
 * Decide what an event opens. Returns {ok:true, plan} or {ok:false, error}. The plan:
 *   {type, def, kind, dock, payload: {net?, cid?, params, note, request_id}, fallback}
 * `fallback` is true when the type was not registered and the generic `result` modal stands in for it.
 */
export function planOpen(registry, evt) {
    if (!isObj(evt)) return { ok: false, error: 'an event is an object' };
    const view = evt.view;
    if (typeof view !== 'string' || !TYPE_RE.test(view)) return { ok: false, error: 'view: a lower-case name' };
    if (evt.params !== undefined && !isObj(evt.params)) return { ok: false, error: 'params: an object' };
    if (evt.net !== undefined) {
        if (!isObj(evt.net)) return { ok: false, error: 'net: an object' };
        if (JSON.stringify(evt.net).length > MAX_NET_BYTES) return { ok: false, error: `net: more than ${MAX_NET_BYTES >> 10} KiB` };
    }
    if (evt.cid !== undefined && (typeof evt.cid !== 'string' || evt.cid.length > 128)) return { ok: false, error: 'cid: a string' };
    if (evt.net !== undefined && evt.cid !== undefined) return { ok: false, error: 'net or cid, not both' };
    const params = isObj(evt.params) ? evt.params : {};
    const note = clip(evt.note, MAX_NOTE);
    // `auto`: the event asks for a result (an MCP push, or a local action with settings), so a view runs at once; a plain
    // open of a panel waits for the person to press Run.
    const auto = evt.request_id !== undefined || evt.net !== undefined || evt.cid !== undefined || Object.keys(params).length > 0;
    const payload = { auto, params, note, ...(evt.net !== undefined ? { net: evt.net } : {}), ...(evt.cid !== undefined ? { cid: evt.cid } : {}), ...(typeof evt.request_id === 'string' ? { request_id: evt.request_id.slice(0, 64) } : {}) };
    let def = registry.get(view);
    let fallback = false;
    if (!def) {
        def = registry.get('result');
        if (!def) return { ok: false, error: `no view type ${view}` };
        fallback = true;
        payload.title = view;
        payload.text = note || JSON.stringify(params, null, 2).slice(0, MAX_NOTE);
    }
    return { ok: true, plan: { type: def.type, def, kind: def.kind, dock: def.kind === 'panel' ? def.dock : null, payload, fallback } };
}

// ---------------------------------------------------------------------------
// The layout (pure, serialisable, no payloads)
// ---------------------------------------------------------------------------

export const DEFAULT_SIZES = Object.freeze({ left: 240, right: 340, bottom: 280 });
export const SIZE_LIMITS = Object.freeze({ left: [160, 560], right: [220, 720], bottom: [120, 720] });

export function emptyLayout() {
    return { v: 1, docks: { left: [], center: [], right: [], bottom: [] }, active: { left: null, center: null, right: null, bottom: null }, sizes: { ...DEFAULT_SIZES }, phone: 'canvas', level: 'model' };
}

const clamp = (n, [lo, hi]) => Math.min(hi, Math.max(lo, Math.round(n)));

/** A layout read from storage, made safe: unknown docks, types and sizes are dropped, never trusted. */
export function sanitizeLayout(raw, registry) {
    const out = emptyLayout();
    if (!isObj(raw) || raw.v !== 1) return out;
    const seen = new Set();
    for (const dock of DOCKS) {
        const list = isObj(raw.docks) && Array.isArray(raw.docks[dock]) ? raw.docks[dock] : [];
        for (const item of list.slice(0, 12)) {
            if (!isObj(item) || typeof item.id !== 'string' || typeof item.type !== 'string') continue;
            const def = registry.get(item.type);
            if (!def || def.kind !== 'panel' || seen.has(item.id) || levelIndex(def.level) > levelIndex(LEVELS.includes(raw.level) ? raw.level : 'model')) continue;
            seen.add(item.id);
            out.docks[dock].push({ id: item.id, type: item.type });
        }
        const act = isObj(raw.active) ? raw.active[dock] : null;
        out.active[dock] = out.docks[dock].some((p) => p.id === act) ? act : (out.docks[dock][0]?.id ?? null);
    }
    for (const k of Object.keys(DEFAULT_SIZES)) {
        const n = isObj(raw.sizes) ? Number(raw.sizes[k]) : NaN;
        if (Number.isFinite(n)) out.sizes[k] = clamp(n, SIZE_LIMITS[k]);
    }
    out.level = LEVELS.includes(raw.level) ? raw.level : 'model';
    out.phone = typeof raw.phone === 'string' && (raw.phone === 'canvas' || seen.has(raw.phone)) ? raw.phone : 'canvas';
    return out;
}

export function findPanel(layout, id) {
    for (const dock of DOCKS) {
        const p = layout.docks[dock].find((q) => q.id === id);
        if (p) return { ...p, dock };
    }
    return null;
}

/** Put a panel in a dock (or reveal it where it is) and make it that dock's active tab. */
export function openPanel(layout, { id, type, dock }) {
    const next = structuredClone(layout);
    const at = findPanel(next, id);
    if (at) {
        next.active[at.dock] = id;
        next.phone = id;
        return next;
    }
    next.docks[dock].push({ id, type });
    next.active[dock] = id;
    next.phone = id;
    return next;
}

export function closePanel(layout, id) {
    const next = structuredClone(layout);
    const at = findPanel(next, id);
    if (!at) return next;
    const list = next.docks[at.dock];
    const i = list.findIndex((p) => p.id === id);
    list.splice(i, 1);
    if (next.active[at.dock] === id) next.active[at.dock] = (list[i] || list[i - 1] || null)?.id ?? null;
    if (next.phone === id) next.phone = 'canvas';
    return next;
}

export function movePanel(layout, id, dock) {
    if (!DOCKS.includes(dock)) return layout;
    const at = findPanel(layout, id);
    if (!at || at.dock === dock) return layout;
    const next = closePanel(layout, id);
    next.docks[dock].push({ id, type: at.type });
    next.active[dock] = id;
    next.phone = id;
    return next;
}

export function resizeDock(layout, dock, px) {
    if (!SIZE_LIMITS[dock]) return layout;
    const next = structuredClone(layout);
    next.sizes[dock] = clamp(px, SIZE_LIMITS[dock]);
    return next;
}

// ---------------------------------------------------------------------------
// Targets: how an event points at something (shared with the notation panel and the MCP verbs)
// ---------------------------------------------------------------------------

/**
 * `node:<id>` a place or transition on the canvas (and its line in the notation), `line:<n>` and `range:<a>-<b>` lines of
 * the notation text, `panel:<id>` an open panel, `view:<type>` a view type (opens it). Anything else is null.
 */
export function parseTarget(t) {
    if (typeof t !== 'string' || t.length > 200) return null;
    const m = /^(node|line|range|panel|view):(.+)$/.exec(t);
    if (!m) return null;
    const [, kind, rest] = m;
    if (kind === 'node') return rest.length <= 128 ? { kind, id: rest } : null;
    if (kind === 'line') return /^[1-9]\d{0,5}$/.test(rest) ? { kind, line: +rest } : null;
    if (kind === 'range') { const r = /^([1-9]\d{0,5})-([1-9]\d{0,5})$/.exec(rest); return r && +r[1] <= +r[2] ? { kind, from: +r[1], to: +r[2] } : null; }
    if (kind === 'panel') return TYPE_RE.test(rest.split(':')[0]) ? { kind, id: rest } : null;
    return TYPE_RE.test(rest) ? { kind, type: rest } : null;
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

/**
 * The shell's state machine. It decides; subscribers (petri-shell-ui.js) draw.
 * Events to subscribers: {kind:'open'|'close'|'move'|'activate'|'resize', id, ...}.
 *
 * `open(evt)` returns {ok, id?, type?, kind?, fallback?, error?}; it never throws on a bad event (an MCP push must get
 * an answer, not an exception).
 */
export class Shell {
    constructor({ registry = new ViewRegistry(), layout = null } = {}) {
        this.registry = registry;
        this.layout = layout ? sanitizeLayout(layout, registry) : emptyLayout();
        /** @type {Map<string, {id: string, type: string, payload: any}>} open panels, with the payload they were opened with (memory only) */
        this.panels = new Map();
        /** @type {{id: string, type: string, payload: any}|null} */
        this.modal = null;
        this.subs = new Set();
        /** @type {{id: string, target: string|null, text: string}[]} the narration an agent attached (annotate) */
        this.annotations = [];
        /** @type {string[]} what is highlighted now (target ids) */
        this.highlights = [];
        /** @type {{title: string, steps: any[], i: number, say?: string}|null} */
        this.tour = null;
        for (const p of Object.values(this.layout.docks).flat()) this.panels.set(p.id, { id: p.id, type: p.type, payload: null });
    }

    subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
    emit(ev) { for (const fn of this.subs) fn(ev, this); }

    open(evt) {
        const planned = planOpen(this.registry, evt);
        if (!planned.ok) return planned;
        const { plan } = planned;
        const { def, payload } = plan;
        if (levelIndex(def.level) > levelIndex(this.level)) {
            // Not refused silently: the person is told, and the shell offers the step down (petri-shell-ui.js).
            this.emit({ kind: 'refused', view: def.type, needs: def.level, evt });
            return { ok: false, error: `${def.title} is a ${def.level}-level view and the shell is at the ${this.level} level`, needs: def.level, level: this.level };
        }
        if (plan.kind === 'modal') {
            if (this.modal) this.emit({ kind: 'close', id: this.modal.id, modal: true, replaced: true });
            this.modal = { id: def.type, type: def.type, payload };
            this.emit({ kind: 'open', id: def.type, type: def.type, modal: true, payload, fallback: plan.fallback });
            return { ok: true, id: def.type, type: def.type, kind: 'modal', fallback: plan.fallback };
        }
        if (def.pinned) {
            // The canvas: already on the page, never placed in a dock. Opening it reveals it.
            this.layout = { ...this.layout, phone: 'canvas', active: { ...this.layout.active, center: null } };
            this.emit({ kind: 'open', id: def.type, type: def.type, pinned: true, payload });
            return { ok: true, id: def.type, type: def.type, kind: 'panel', dock: 'center', fallback: false };
        }
        const id = def.singleton === false && findPanel(this.layout, def.type) ? this.#nextId(def) : instanceId(def);
        this.layout = openPanel(this.layout, { id, type: def.type, dock: plan.dock });
        const at = findPanel(this.layout, id);
        this.panels.set(id, { id, type: def.type, payload });
        this.emit({ kind: 'open', id, type: def.type, dock: at.dock, payload, fallback: plan.fallback });
        return { ok: true, id, type: def.type, kind: 'panel', dock: at.dock, fallback: plan.fallback };
    }

    #nextId(def) {
        let n = 1;
        while (this.panels.has(instanceId(def, n))) n++;
        return instanceId(def, n);
    }

    /** Close one panel or the modal by id; with no id, the modal if there is one. Returns whether anything closed. */
    close(id) {
        if (id === undefined || id === null) {
            if (this.modal) id = this.modal.id;
            else return false;
        }
        if (this.modal && this.modal.id === id) {
            this.modal = null;
            this.emit({ kind: 'close', id, modal: true });
            return true;
        }
        if (!this.panels.has(id) || !findPanel(this.layout, id)) return false;
        this.layout = closePanel(this.layout, id);
        this.panels.delete(id);
        this.emit({ kind: 'close', id });
        return true;
    }

    /** An MCP `stop`: the modal and every panel a push opened go; the canvas, and panels the person opened by hand, stay. */
    stop() {
        let n = 0;
        if (this.close()) n++;
        for (const p of [...this.panels.values()]) if (p.payload?.auto && this.close(p.id)) n++;
        return n;
    }

    move(id, dock) {
        const before = findPanel(this.layout, id);
        if (!before) return false;
        this.layout = movePanel(this.layout, id, dock);
        this.emit({ kind: 'move', id, dock });
        return true;
    }

    activate(id) {
        const at = findPanel(this.layout, id);
        if (id !== 'canvas' && !at) return false;
        if (at) this.layout = openPanel(this.layout, { id, type: at.type, dock: at.dock });
        else this.layout = { ...this.layout, phone: 'canvas', active: { ...this.layout.active, center: null } };
        this.emit({ kind: 'activate', id });
        return true;
    }

    resize(dock, px) {
        this.layout = resizeDock(this.layout, dock, px);
        this.emit({ kind: 'resize', dock, px: this.layout.sizes[dock] });
    }

    get level() { return this.layout.level; }

    /**
     * Set the abstraction level. Panels and the modal above the new level close (their state is cheap to recompute and
     * a view the level does not allow must not linger). Returns whether the level is now `level`.
     */
    setLevel(level) {
        if (!LEVELS.includes(level)) return false;
        this.layout = { ...this.layout, level };
        const cut = levelIndex(level);
        if (this.modal && levelIndex(this.registry.get(this.modal.type)?.level ?? 'model') > cut) this.close();
        for (const p of Object.values(this.layout.docks).flat()) {
            if (levelIndex(this.registry.get(p.type)?.level ?? 'model') > cut) this.close(p.id);
        }
        this.emit({ kind: 'level', level });
        return true;
    }

    /** Mark targets on the canvas and in the notation (see parseTarget). `[]` clears. */
    highlight(targets, label = '') {
        const list = (Array.isArray(targets) ? targets : []).filter((t) => parseTarget(t)).slice(0, MAX_TARGETS);
        this.highlights = list;
        this.emit({ kind: 'highlight', targets: list, label: clip(label, 200) });
        return list.length;
    }

    /** Attach a line of narration, optionally to a target. Empty text removes the annotation with that id. */
    annotate({ id, target = null, text = '' }) {
        const key = typeof id === 'string' && id ? id.slice(0, 40) : `a${this.annotations.length + 1}`;
        const t = clip(text, MAX_NOTE);
        this.annotations = this.annotations.filter((a) => a.id !== key);
        if (t) this.annotations.push({ id: key, target: target && parseTarget(target) ? target : null, text: t });
        this.annotations = this.annotations.slice(-20);
        this.emit({ kind: 'annotate', id: key, target, text: t });
        if (t && target && parseTarget(target)) this.highlight([target]);
        return key;
    }

    /**
     * A tour: an ordered list of events (any event dispatch() takes, but a tour), each with an optional `say` line of
     * narration. Starting one runs step 1; the person (or the agent) moves with tourGo / tourNext / tourBack / tourEnd.
     */
    startTour({ title = 'Tour', steps }) {
        if (!Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS) return { ok: false, error: `steps: 1 to ${MAX_STEPS} events` };
        for (const st of steps) {
            if (!isObj(st) || st.type === 'tour') return { ok: false, error: 'a step is an event, and not a tour' };
        }
        this.tour = { title: clip(String(title), 80), steps: steps.map((st) => structuredClone(st)), i: -1 };
        this.tourGo(0);
        return { ok: true, steps: steps.length };
    }

    tourGo(i) {
        const t = this.tour;
        if (!t || i < 0 || i >= t.steps.length) return false;
        t.i = i;
        const step = t.steps[i];
        t.say = clip(step.say, MAX_NOTE);
        this.emit({ kind: 'tour', title: t.title, step: i + 1, of: t.steps.length, say: clip(step.say, MAX_NOTE) });
        const { say: _say, ...evt } = step;
        if (Object.keys(evt).length) this.dispatch(evt);
        return true;
    }

    tourNext() { return this.tour ? this.tourGo(this.tour.i + 1) : false; }
    tourBack() { return this.tour ? this.tourGo(this.tour.i - 1) : false; }
    tourEnd() {
        if (!this.tour) return false;
        this.tour = null;
        this.emit({ kind: 'tour', ended: true });
        return true;
    }

    /**
     * The one entry for every event an agent or a local action sends. `type` defaults to `show`:
     *   show       open a view                   {view, net|cid, params, note, request_id}
     *   level      set the abstraction level     {level}
     *   highlight  mark targets                  {targets: [...], label?}   (empty targets clear)
     *   annotate   narrate, optionally at a target {id?, target?, text}
     *   focus      bring a target into view      {target}   (panel:<id> or view:<type> opens/activates; node:/line: highlights)
     *   tour       start a guided sequence       {title?, steps: [event + say, ...]}
     *   tour_control  {action: 'next'|'back'|'end'}
     *   stop       close what a push opened
     * Returns {ok, ...}; never throws on a bad event.
     */
    dispatch(evt) {
        if (!isObj(evt)) return { ok: false, error: 'an event is an object' };
        const type = evt.type ?? 'show';
        switch (type) {
            case 'show': return this.open(evt);
            case 'level': return LEVELS.includes(evt.level) ? { ok: this.setLevel(evt.level), level: this.level } : { ok: false, error: `level: one of ${LEVELS.join(', ')}` };
            case 'highlight': return { ok: true, count: this.highlight(evt.targets ?? (evt.target ? [evt.target] : []), evt.label) };
            case 'annotate': return typeof evt.text === 'string' ? { ok: true, id: this.annotate(evt) } : { ok: false, error: 'text: a string' };
            case 'focus': {
                const t = parseTarget(evt.target);
                if (!t) return { ok: false, error: 'target: node:<id>, line:<n>, range:<a>-<b>, panel:<id> or view:<type>' };
                if (t.kind === 'panel') return { ok: this.activate(t.id), id: t.id };
                if (t.kind === 'view') return this.open({ view: t.type });
                this.highlight([evt.target]);
                return { ok: true };
            }
            case 'tour': return this.startTour(evt);
            case 'tour_control': {
                const ok = { next: () => this.tourNext(), back: () => this.tourBack(), end: () => this.tourEnd() }[evt.action]?.();
                return { ok: !!ok };
            }
            case 'stop': return { ok: true, closed: this.stop() };
            default: return { ok: false, error: `unknown event type ${JSON.stringify(String(type).slice(0, 40))}` };
        }
    }

    /** What an agent may read back (merged into a tab push's `report`): ids and types only, never payloads. */
    state() {
        const panels = Object.entries(this.layout.docks).flatMap(([dock, list]) => list.map((p) => ({ id: p.id, type: p.type, dock, active: this.layout.active[dock] === p.id })));
        return { shell: 1, level: this.level, tour: this.tour ? { title: this.tour.title, step: this.tour.i + 1, of: this.tour.steps.length } : null, panels, modal: this.modal ? { id: this.modal.id, type: this.modal.type } : null, highlights: this.highlights.slice(), views: this.registry.types().map((v) => v.type) };
    }

    /** The layout as it may be stored: ids, types, docks, sizes. No payload is in it, so no pushed net can be. */
    persist() { return JSON.stringify(this.layout); }

    /** Palette entries for the shell's own actions: open each view, move a panel, reset the layout. */
    commands() {
        const out = [];
        for (const v of this.registry.types()) {
            out.push({ id: `view.open.${v.type}`, label: `Open ${v.title}`, group: v.kind === 'modal' ? 'Windows' : 'Panels', run: { open: { view: v.type } } });
        }
        for (const [dock, list] of Object.entries(this.layout.docks)) {
            for (const p of list) {
                for (const to of DOCKS) {
                    if (to !== dock && to !== 'center') out.push({ id: `view.move.${p.id}.${to}`, label: `Move ${this.registry.get(p.type)?.title ?? p.type} to ${to}`, group: 'Layout', run: { move: { id: p.id, dock: to } } });
                }
                out.push({ id: `view.close.${p.id}`, label: `Close ${this.registry.get(p.type)?.title ?? p.type}`, group: 'Layout', run: { close: { id: p.id } } });
            }
        }
        out.push({ id: 'view.reset', label: 'Reset layout', group: 'Layout', run: { reset: true } });
        return out;
    }
}

// ---------------------------------------------------------------------------
// The palette's filter: a subsequence match, ranked (pure)
// ---------------------------------------------------------------------------

/** Score of `query` against `label`: -1 for no match; prefix and word-start matches rank first. */
export function matchScore(query, label) {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    const l = label.toLowerCase();
    if (l.startsWith(q)) return 1000 - l.length;
    const at = l.indexOf(q);
    if (at >= 0) return 800 - at - l.length / 100;
    let i = 0, gaps = 0, last = -1;
    for (let j = 0; j < l.length && i < q.length; j++) {
        if (l[j] === q[i]) { if (last >= 0 && j !== last + 1) gaps++; last = j; i++; }
    }
    return i === q.length ? 400 - gaps * 10 - l.length / 100 : -1;
}

export function filterCommands(commands, query) {
    return commands
        .map((c) => ({ c, s: matchScore(query, c.label) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s || a.c.label.localeCompare(b.c.label))
        .map((x) => x.c);
}

// ---------------------------------------------------------------------------
// Whether the shell is on (a flag, off by default)
// ---------------------------------------------------------------------------

/**
 * `?shell=1` turns it on for this browser (remembered), `?shell=0` turns it off again; with neither, the remembered
 * choice. `store` is localStorage or null (no storage: the query alone decides, for this visit).
 */
export function shellEnabled(search, store) {
    const q = new URLSearchParams(search).get('shell');
    try {
        if (q === '1') { store?.setItem('pflow_shell', '1'); return true; }
        if (q === '0') { store?.removeItem('pflow_shell'); return false; }
        return store?.getItem('pflow_shell') === '1';
    } catch {
        return q === '1';
    }
}
