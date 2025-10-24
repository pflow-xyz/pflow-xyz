class PetriView extends HTMLElement {
    constructor() {
        super();
        // DOM & rendering
        this._root = null;
        this._stage = null;
        this._canvas = null;
        this._ctx = null;
        this._dpr = window.devicePixelRatio || 1;

        // model & script node
        this._model = {};
        this._ldScript = null;

        // nodes / badges mapping
        this._nodes = {}; // id -> DOM node
        this._weights = []; // badge elements

        // editor & menu
        this._menu = null;
        this._menuPlayBtn = null;
        this._jsonEditor = null;
        this._jsonEditorTextarea = null;
        this._jsonEditorTimer = null;
        this._editingJson = false;

        // editing state
        this._mode = 'select';
        this._arcDraft = null;
        this._mouse = {x: 0, y: 0};

        // pan/zoom
        this._view = {scale: 1, tx: 0, ty: 0};
        this._panning = null;
        this._spaceDown = false;
        this._minScale = 0.5;
        this._maxScale = 2.5;
        this._scaleMeter = null;
        this._initialView = null;

        // sim & history
        this._simRunning = false;
        this._prevMode = null;
        this._history = [];
        this._redo = [];

        this._ro = null;
    }

    // observe compact flag and json editor toggle
    static get observedAttributes() {
        return ['data-compact', 'data-json-editor'];
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'data-json-editor' && this.isConnected) {
            if (newValue !== null) this._createJsonEditor();
            else this._removeJsonEditor();
        }
    }

    _loadScript(src) {
        return new Promise((resolve, reject) => {
            if (window.ace) return resolve();
            if (document.querySelector(`script[src="${src}"]`)) {
                // already injected but maybe not ready
                const check = () => window.ace ? resolve() : setTimeout(check, 50);
                return check();
            }
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = (e) => reject(e);
            document.head.appendChild(s);
        });
    }

    // Updated _initAceEditor and _createJsonEditor in `public/petri-view.js`

    async _initAceEditor() {
        if (!this._jsonEditorTextarea || this._aceEditor) return;
        const aceCdn = 'https://cdnjs.cloudflare.com/ajax/libs/ace/1.4.14/ace.js';
        try {
            await this._loadScript(aceCdn);
        } catch {
            return; // fail back to textarea if Ace can't load
        }

        // keep textarea for integration but hide it visually
        this._jsonEditorTextarea.style.display = 'none';

        // simple toolbar with Find + Download + Fullscreen (CSS-only) + Close
        const toolbar = document.createElement('div');
        toolbar.className = 'pv-ace-toolbar';
        this._applyStyles(toolbar, {
            display: 'flex',
            gap: '6px',
            padding: '6px 4px',
            alignItems: 'center',
            background: 'transparent'
        });

        const makeBtn = (txt, title) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = txt;
            b.title = title;
            this._applyStyles(b, {
                padding: '6px 8px',
                borderRadius: '6px',
                border: '1px solid #ddd',
                background: '#fff',
                cursor: 'pointer',
                fontSize: '12px'
            });
            return b;
        };

        const findBtn = makeBtn('🔍 Find', 'Open find ( Ace searchbox )');
        const dlBtn = makeBtn('📥 Download', 'Download current JSON');
        const fsBtn = makeBtn('🔳 Full ⤢', 'Toggle fullscreen');
        const closeBtn = makeBtn('❌ Close', 'Close editor'); // moved close into ace toolbar
        toolbar.appendChild(findBtn);
        toolbar.appendChild(dlBtn);
        toolbar.appendChild(fsBtn);
        toolbar.appendChild(closeBtn);

        // container for Ace
        const editorWrapper = document.createElement('div');
        editorWrapper.className = 'pv-ace-editor-wrapper';
        this._applyStyles(editorWrapper, {
            width: '100%',
            flex: '1 1 auto',
            minHeight: '120px',
            boxSizing: 'border-box',
            borderRadius: '6px',
            border: '1px solid #ccc',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
        });

        const editorDiv = document.createElement('div');
        editorDiv.className = 'pv-ace-editor';
        this._applyStyles(editorDiv, {width: '100%', flex: '1 1 auto', minHeight: '120px'});

        editorWrapper.appendChild(toolbar);
        editorWrapper.appendChild(editorDiv);
        this._jsonEditorTextarea.parentNode.insertBefore(editorWrapper, this._jsonEditorTextarea.nextSibling);

        // init ace
        const editor = window.ace.edit(editorDiv);
        editor.setTheme('ace/theme/textmate');
        editor.session.setMode('ace/mode/json');

        // base options
        const opts = {
            fontSize: '13px',
            showPrintMargin: false,
            wrap: true,
            useWorker: true
        };

        // enable autocompletion/snippets only if language_tools is present
        try {
            if (window.ace && ace.require && ace.require('ace/ext/language_tools')) {
                // only set these flags when the language_tools extension is available
                opts.enableBasicAutocompletion = false;
                opts.enableLiveAutocompletion = false;
                opts.enableSnippets = false;
            }
        } catch {
            // language_tools not available — skip those options to avoid warnings
        }

        editor.setOptions(opts);

        // initial content
        editor.session.setValue(this._jsonEditorTextarea.value || '');

        // keep textarea in sync and reuse existing input logic
        const applyChange = () => {
            const txt = editor.session.getValue();
            if (this._jsonEditorTextarea.value !== txt) this._jsonEditorTextarea.value = txt;
            this._onJsonEditorInput(false);
        };
        editor.session.on('change', () => applyChange());

        // wire find button
        findBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                editor.execCommand('find');
            } catch {
                alert('Find command unavailable');
            }
        });

        // wire download button: download current editor text as JSON file
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            try {
                const txt = editor.session.getValue();
                const blob = new Blob([txt], {type: 'application/json'});
                const a = document.createElement('a');
                const filename = (this.getAttribute('id') || 'petri-net') + '.json';
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                a.click();
                URL.revokeObjectURL(a.href);
            } catch (err) {
                alert('Download failed: ' + (err && err.message ? err.message : String(err)));
            }
        });

        // wire close button moved into ace toolbar
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._removeJsonEditor();
        });

        // CSS-only fullscreen: apply fixed overlay to container (does NOT call Fullscreen API)
        const applyCssFullscreen = (container, on) => {
            if (!container) return;
            if (on) {
                // save previous inline styles
                container._prevFull = {
                    position: container.style.position || '',
                    left: container.style.left || '',
                    top: container.style.top || '',
                    right: container.style.right || '',
                    bottom: container.style.bottom || '',
                    width: container.style.width || '',
                    height: container.style.height || '',
                    zIndex: container.style.zIndex || '',
                    padding: container.style.padding || '',
                    boxSizing: container.style.boxSizing || '',
                    borderRadius: container.style.borderRadius || '',
                    overflow: container.style.overflow || ''
                };
                // cover viewport without using Fullscreen API
                Object.assign(container.style, {
                    position: 'fixed',
                    left: '0',
                    top: '0',
                    right: '0',
                    bottom: '0',
                    width: '100vw',
                    height: '100vh',
                    zIndex: 2147483647,
                    padding: '12px',
                    boxSizing: 'border-box',
                    borderRadius: '0',
                    overflow: 'auto'
                });
                // prevent body scroll behind overlay
                try {
                    document.documentElement.style.overflow = 'hidden';
                    document.body.style.overflow = 'hidden';
                } catch {
                }
                container._fsOn = true;
            } else {
                if (container._prevFull) {
                    Object.assign(container.style, container._prevFull);
                    container._prevFull = null;
                }
                try {
                    document.documentElement.style.overflow = '';
                    document.body.style.overflow = '';
                } catch {
                }
                container._fsOn = false;
            }
        };

        // wire fullscreen button (CSS-only toggle)
        fsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const container = this._jsonEditor || editorWrapper;
            if (!container) return;
            const now = !!container._fsOn;
            applyCssFullscreen(container, !now);
            fsBtn.textContent = (!now) ? '🔳 Exit ⤢' : '🔳 Full ⤢';
            // allow layout to settle then resize/focus ace
            setTimeout(() => {
                try {
                    editor.resize();
                    editor.focus();
                } catch {
                }
            }, 80);
        });

        // store refs for cleanup
        this._aceEditor = editor;
        this._aceEditorContainer = editorWrapper;
    }

    _createJsonEditor() {
        if (this._jsonEditor) return;
        const container = document.createElement('div');
        container.className = 'pv-json-editor';
        this._applyStyles(container, {
            position: 'fixed',
            left: '10px',
            right: '10px',
            bottom: '10px',
            height: '45%',
            minHeight: '160px',
            maxHeight: '70%',
            padding: '12px',
            background: 'rgba(250,250,250,0.98)',
            zIndex: 100,
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            overflow: 'auto',
            borderRadius: '8px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.08)'
        });

        // Removed the JSON Editor title and header close button per request.

        const textarea = document.createElement('textarea');
        textarea.className = 'pv-json-textarea';
        this._applyStyles(textarea, {
            width: '100%',
            flex: '1 1 auto',
            boxSizing: 'border-box',
            resize: 'vertical',
            fontFamily: 'monospace',
            fontSize: '13px',
            padding: '8px',
            borderRadius: '6px',
            border: '1px solid #ccc'
        });
        textarea.spellcheck = false;
        container.appendChild(textarea);

        const hostDoc = this.ownerDocument || document;
        hostDoc.body.appendChild(container);

        this._jsonEditor = container;
        this._jsonEditorTextarea = textarea;
        this._editingJson = false;
        this._jsonEditorTimer = null;
        this._updateJsonEditor();
        textarea.addEventListener('input', () => this._onJsonEditorInput());
        textarea.addEventListener('blur', () => this._onJsonEditorInput(true));
        this._initAceEditor().catch(() => {/* ignore */
        });
    }

    // ---------------- lifecycle ----------------
    connectedCallback() {
        if (this._root) return;
        this._buildRoot();
        this._ldScript = this.querySelector('script[type="application/ld+json"]');
        this._loadModelFromScriptOrAutosave();
        this._normalizeModel();
        this._renderUI();
        this._applyViewTransform();
        this._initialView = {...this._view};
        this._pushHistory(true);
        this._createMenu();
        this._createScaleMeter();
        if (this.hasAttribute('data-json-editor')) this._createJsonEditor();

        this._ro = new ResizeObserver(() => this._onResize());
        this._ro.observe(this._root);

        window.addEventListener('load', () => this._onResize());
        this._wireRootEvents();
    }

    disconnectedCallback() {
        if (this._ro) this._ro.disconnect();
        if (this._jsonEditorTimer) {
            clearTimeout(this._jsonEditorTimer);
            this._jsonEditorTimer = null;
        }
        if (this._jsonEditor) this._removeJsonEditor();
    }

    // ---------------- public API ----------------
    setModel(m) {
        this._model = m || {};
        this._normalizeModel();
        this._renderUI();
        this._syncLD();
        this._pushHistory();
    }

    getModel() {
        return this._model;
    }

    exportJSON() {
        return JSON.parse(JSON.stringify(this._model));
    }

    importJSON(json) {
        this.setModel(json);
    }

    saveToScript() {
        this._syncLD(true);
    }

    downloadJSON(filename = 'petri-net.json') {
        const blob = new Blob([this._stableStringify(this._model)], {type: 'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // ---------------- utilities ----------------
    _safeParse(text) {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    _stableStringify(obj, space = 2) {
        const seen = new WeakSet();
        const sortObj = (o) => {
            if (o === null || typeof o !== 'object') return o;
            if (seen.has(o)) return undefined;
            seen.add(o);
            if (Array.isArray(o)) return o.map(sortObj);
            const out = {};
            for (const k of Object.keys(o).sort()) out[k] = sortObj(o[k]);
            return out;
        };
        return JSON.stringify(sortObj(obj), null, space);
    }

    _applyStyles(el, styles = {}) {
        Object.assign(el.style, styles);
    }

    _genId(prefix) {
        const base = prefix + Date.now().toString(36);
        let id = base;
        let i = 0;
        while ((this._model.places && this._model.places[id]) || (this._model.transitions && this._model.transitions[id])) {
            id = base + '-' + (++i);
        }
        return id;
    }

    _capacityOf(pid) {
        const p = this._model.places[pid];
        if (!p) return Infinity;
        const arr = Array.isArray(p.capacity) ? p.capacity : [p.capacity];
        const v = arr[0];
        if (v === Infinity) return Infinity;
        const n = Number(v);
        return Number.isFinite(n) ? n : Infinity;
    }

    _isCapacityPath(pathArr) {
        // crude but effective: ...places.<id>.capacity[...]
        const i = pathArr.indexOf('places');
        return i >= 0 && pathArr[i + 2] === 'capacity';
    }

    _stableStringify(obj, space = 2) {
        const seen = new WeakSet();
        const path = [];

        const sortObj = (o) => {
            if (o === null || typeof o !== 'object') return o;
            if (seen.has(o)) return undefined;
            seen.add(o);
            if (Array.isArray(o)) {
                return o.map((v, idx) => {
                    path.push(String(idx));
                    const out = sortObj(v);
                    path.pop();
                    // convert Infinity in capacity arrays to null for JSON-LD friendliness
                    if (out === Infinity && this._isCapacityPath(path)) return null;
                    return out;
                });
            }
            const out = {};
            for (const k of Object.keys(o).sort()) {
                path.push(k);
                let v = sortObj(o[k]);
                // If Infinity sits directly in a capacity prop
                if (v === Infinity && this._isCapacityPath(path)) v = null;
                out[k] = v;
                path.pop();
            }
            return out;
        };

        return JSON.stringify(sortObj(obj), null, space);
    }


    // ---------------- model normalization ----------------
    _normalizeModel() {
        const m = this._model || (this._model = {});
        m['@context'] ||= 'https://pflow.xyz/schema';
        m['@type'] ||= 'PetriNet';
        m['@version'] ||= '1.1'; // <-- added default version
        m.token ||= ['https://pflow.xyz/tokens/black'];
        m.places ||= {};
        m.transitions ||= {};
        m.arcs ||= [];

        for (const [id, p] of Object.entries(m.places)) {
            p['@type'] ||= 'Place';

            // offsets/coords
            p.offset = Number.isFinite(p.offset) ? Number(p.offset) : Number(p.offset ?? 0);
            p.x = Number.isFinite(p.x) ? Number(p.x) : Number(p.x || 0);
            p.y = Number.isFinite(p.y) ? Number(p.y) : Number(p.y || 0);

            // initial: allow 0, coerce safely
            if (!Array.isArray(p.initial)) p.initial = [p.initial];
            p.initial = p.initial.map(v => {
                const n = (typeof v === 'string' && v.trim() === '') ? 0 : Number(v);
                return Number.isFinite(n) ? n : 0;
            });

            // capacity: null/undefined => Infinity (unbounded). Preserve 0.
            if (!Array.isArray(p.capacity)) p.capacity = [p.capacity];
            p.capacity = p.capacity.map(v => {
                if (v === null || v === undefined) return Infinity; // explicit unbounded
                const n = Number(v);
                return Number.isFinite(n) ? n : Infinity;
            });
        }


        for (const [id, t] of Object.entries(m.transitions)) {
            t['@type'] ||= 'Transition';
            t.x = Number(t.x || 0);
            t.y = Number(t.y || 0);
        }
        for (const a of m.arcs) {
            a['@type'] ||= 'Arrow';
            if (a.weight == null) a.weight = [1];
            if (!Array.isArray(a.weight)) a.weight = [Number(a.weight) || 1];
            a.inhibitTransition = !!a.inhibitTransition;
        }
    }

    _loadModelFromScriptOrAutosave() {
        if (this._ldScript && this._ldScript.textContent) {
            const parsed = this._safeParse(this._ldScript.textContent);
            this._model = parsed || {};
            return;
        }
        try {
            const saved = localStorage.getItem(this._getStorageKey());
            if (saved) this._model = JSON.parse(saved);
        } catch {
        }
    }

    // ---------------- persistence & history ----------------
    _syncLD(force = false) {
        try {
            localStorage.setItem(this._getStorageKey(), this._stableStringify(this._model));
        } catch {
        }

        if (!this._ldScript) {
            // still update editor if present
            this._updateJsonEditor();
            return;
        }
        const pretty = !this.hasAttribute('data-compact');
        const text = pretty ? this._stableStringify(this._model, 2) : JSON.stringify(this._model);
        if (force || this._ldScript.textContent !== text) {
            this._ldScript.textContent = text;
            this.dispatchEvent(new CustomEvent('jsonld-updated', {detail: {json: this.exportJSON()}}));
        }
        this._updateJsonEditor();
    }

    _pushHistory(seed = false) {
        const snap = this._stableStringify(this._model);
        if (seed && this._history.length === 0) {
            this._history.push(snap);
            return;
        }
        const last = this._history[this._history.length - 1];
        if (snap !== last) {
            this._history.push(snap);
            if (this._history.length > 2000) this._history.shift(); // cap
            this._redo.length = 0;
        }
    }

    _undoAction() {
        if (this._history.length < 2) return;
        const cur = this._history.pop();
        this._redo.push(cur);
        const prev = this._history[this._history.length - 1];
        this._model = JSON.parse(prev);
        this._renderUI();
        this._syncLD();
    }

    _redoAction() {
        if (!this._redo.length) return;
        const nxt = this._redo.pop();
        this._history.push(nxt);
        this._model = JSON.parse(nxt);
        this._renderUI();
        this._syncLD();
    }

    // ---------------- marking & firing ----------------
    _marking() {
        const marks = {};
        for (const [pid, p] of Object.entries(this._model.places)) {
            const sum = (Array.isArray(p.initial) ? p.initial : [Number(p.initial || 0)])
                .reduce((s, v) => s + (Number(v) || 0), 0);
            marks[pid] = sum;
        }
        return marks;
    }

    _setMarking(marks) {
        for (const [pid, count] of Object.entries(marks)) {
            const p = this._model.places[pid];
            if (!p) continue;
            const arr = Array.isArray(p.initial) ? p.initial : [Number(p.initial || 0)];
            arr[0] = Math.max(0, Number(count) || 0);
            p.initial = arr;
        }
        this._syncLD();
        this._pushHistory();
    }

    _capacityOf(pid) {
        const p = this._model.places[pid];
        if (!p) return Infinity;
        const arr = Array.isArray(p.capacity) ? p.capacity : [Number(p.capacity || Infinity)];
        return Number.isFinite(arr[0]) ? arr[0] : Infinity;
    }

    _inArcsOf(tid) {
        return (this._model.arcs || []).filter(a => a.target === tid);
    }

    _outArcsOf(tid) {
        return (this._model.arcs || []).filter(a => a.source === tid);
    }

    _enabled(tid, marks) {
        marks = marks || this._marking();

        // input arcs (place -> transition)
        const inArcs = this._inArcsOf(tid);
        for (const a of inArcs) {
            const fromPlace = this._model.places[a.source];
            if (!fromPlace) continue;
            const w = Number(a.weight?.[0] ?? 1);
            const tokens = marks[a.source] ?? 0;

            if (a.inhibitTransition) {
                // input inhibitor: transition disabled while source place tokens >= weight
                if (tokens >= w) return false;
                // inhibitor doesn't consume tokens
                continue;
            }

            // normal input arc must have enough tokens
            if (tokens < w) return false;
        }

        // output arcs (transition -> place)
        const outArcs = this._outArcsOf(tid);
        for (const a of outArcs) {
            const toPlace = this._model.places[a.target];
            if (!toPlace) continue;
            const w = Number(a.weight?.[0] ?? 1);
            const tokens = marks[a.target] ?? 0;

            if (a.inhibitTransition) {
                // output inhibitor: transition disabled until target place tokens >= weight
                if (tokens < w) return false;
                // still fall through to capacity check for produced tokens
            }

            // output capacity must not overflow
            const cap = this._capacityOf(a.target);
            const cur = marks[a.target] ?? 0;
            if (cur + w > cap) return false;
        }

        return true;
    }

    _fire(tid) {
        const marks = this._marking();
        if (!this._enabled(tid, marks)) {
            this.dispatchEvent(new CustomEvent('transition-fired-blocked', {detail: {id: tid}}));
            return false;
        }
        for (const a of this._inArcsOf(tid)) {
            const isPlace = !!this._model.places[a.source];
            if (!isPlace) continue;
            const w = Number(a.weight?.[0] ?? 1);
            if (!a.inhibitTransition) marks[a.source] = Math.max(0, (marks[a.source] || 0) - w);
        }
        for (const a of this._outArcsOf(tid)) {
            const isPlace = !!this._model.places[a.target];
            if (!isPlace) continue;
            const w = Number(a.weight?.[0] ?? 1);
            marks[a.target] = (marks[a.target] || 0) + w;
        }
        this._setMarking(marks);
        this._renderTokens();
        this._updateTransitionStates();
        this._draw();
        this.dispatchEvent(new CustomEvent('marking-changed', {detail: {marks}}));
        this.dispatchEvent(new CustomEvent('transition-fired-success', {detail: {id: tid}}));
        return true;
    }

    // ---------------- UI building ----------------
    _buildRoot() {
        this._root = document.createElement('div');
        this._root.className = 'pv-root';
        this._applyStyles(this._root, {position: 'relative', width: '100%', height: '100%'});
        this.appendChild(this._root);

        this._stage = document.createElement('div');
        this._stage.className = 'pv-stage';
        this._applyStyles(this._stage, {
            position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', transformOrigin: '0 0'
        });
        this._root.appendChild(this._stage);

        this._canvas = document.createElement('canvas');
        this._canvas.className = 'pv-canvas';
        this._applyStyles(this._canvas, {position: 'absolute', left: '0', top: '0'});
        this._stage.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d');
    }

    _renderUI() {
        // remove old dom nodes and badges
        for (const n of Object.values(this._nodes)) n.remove();
        this._nodes = {};
        for (const b of this._weights) b.remove();
        this._weights = [];

        const places = this._model.places || {};
        const transitions = this._model.transitions || {};
        const arcs = this._model.arcs || [];

        for (const [id, p] of Object.entries(places)) this._createPlaceElement(id, p);
        for (const [id, t] of Object.entries(transitions)) this._createTransitionElement(id, t);
        arcs.forEach((arc, idx) => this._createWeightBadge(arc, idx));

        this._renderTokens();
        this._updateTransitionStates();
        this._onResize();
        this._syncLD();
        this._updateArcDraftHighlight();
        this._updateMenuActive();
    }

    _createPlaceElement(id, p) {
        const el = document.createElement('div');
        el.className = 'pv-node pv-place';
        el.dataset.id = id;
        this._applyStyles(el, {position: 'absolute', left: `${(p.x || 0) - 40}px`, top: `${(p.y || 0) - 40}px`});

        const handle = document.createElement('div');
        handle.className = 'pv-place-handle';
        const inner = document.createElement('div');
        inner.className = 'pv-place-inner';
        const label = document.createElement('div');
        label.className = 'pv-label';
        label.textContent = id;

        el.appendChild(handle);
        el.appendChild(inner);
        el.appendChild(label);

        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._onPlaceClick(id, ev);
        });
        el.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._onPlaceContext(id, ev);
        });
        // Do not begin drag when in add-token, add-arc or delete modes
        handle.addEventListener('pointerdown', (ev) => {
            if (this._mode !== 'add-token' && this._mode !== 'add-arc' && this._mode !== 'delete') {
                this._beginDrag(ev, id, 'place');
            }
        });

        this._stage.appendChild(el);
        this._nodes[id] = el;
    }

    _createTransitionElement(id, t) {
        const el = document.createElement('div');
        el.className = 'pv-node pv-transition';
        el.dataset.id = id;
        this._applyStyles(el, {position: 'absolute', left: `${(t.x || 0) - 15}px`, top: `${(t.y || 0) - 15}px`});
        const label = document.createElement('div');
        label.className = 'pv-label';
        label.textContent = id;
        el.appendChild(label);

        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._onTransitionClick(id, ev);
        });
        el.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._onTransitionContext(id, ev);
        });
        // Do not begin drag when in add-arc or delete modes
        el.addEventListener('pointerdown', (ev) => {
            if (this._mode !== 'add-arc' && this._mode !== 'delete') {
                this._beginDrag(ev, id, 'transition');
            }
        });

        this._stage.appendChild(el);
        this._nodes[id] = el;
    }

    _createWeightBadge(arc, idx) {
        const w = (() => {
            if (arc.weight == null) return 1;
            if (Array.isArray(arc.weight)) return Number(arc.weight[0]) || 1;
            return Number(arc.weight) || 1;
        })();
        const badge = document.createElement('div');
        badge.className = 'pv-weight';
        badge.style.pointerEvents = 'auto';
        badge.dataset.arc = String(idx);
        badge.textContent = w > 1 ? `${w}` : '1';
        this._applyStyles(badge, {position: 'absolute'});

        badge.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._onBadgeClick(badge, ev);
        });
        badge.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._onBadgeContext(badge, ev);
        });

        this._stage.appendChild(badge);
        this._weights.push(badge);
    }

    // ---------------- UI event handlers ----------------
    _onPlaceClick(id, ev) {
        const p = this._model.places[id];
        if (!p) return;
        if (this._mode === 'select') return;
        if (this._mode === 'add-token') {
            const arr = Array.isArray(p.initial) ? p.initial : [Number(p.initial || 0)];
            arr[0] = (Number(arr[0]) || 0) + 1;
            p.initial = arr;
            this._syncLD();
            this._pushHistory();
            this._renderTokens();
            this._draw();
            return;
        }
        if (this._mode === 'add-arc') {
            this._arcNodeClicked(id);
            return;
        }
        if (this._mode === 'delete') {
            this._deleteNode(id);

        }
    }

    _onPlaceContext(id, ev) {
        const p = this._model.places[id];
        if (!p) return;
        if (this._mode === 'add-token') {
            const arr = Array.isArray(p.initial) ? p.initial : [Number(p.initial || 0)];
            arr[0] = Math.max(0, (Number(arr[0]) || 0) - 1);
            p.initial = arr;
            this._syncLD();
            this._pushHistory();
            this._renderTokens();
            this._draw();
            return;
        }
        if (this._mode === 'add-arc') {
            this._arcNodeClicked(id, {inhibit: true});
            return;
        }
        if (this._mode === 'delete') {
            this._deleteNode(id);

        }
    }

    _onTransitionClick(id, ev) {
        // Only allow firing when simulation (play) is running
        if (this._simRunning) {
            const el = this._nodes[id];
            this.dispatchEvent(new CustomEvent('transition-fired', {detail: {id}}));
            el.animate([{transform: 'scale(1)'}, {transform: 'scale(1.06)'}, {transform: 'scale(1)'}], {duration: 250});
            this._fire(id);
            return;
        }
        // Preserve other behaviors (arc creation / deletion) regardless of simulation state
        if (this._mode === 'add-arc') {
            this._arcNodeClicked(id);
            return;
        }
        if (this._mode === 'delete') {
            this._deleteNode(id);
        }
    }

    _onTransitionContext(id, ev) {
        if (this._mode === 'add-arc') {
            this._arcNodeClicked(id, {inhibit: true});
            return;
        }
        if (this._mode === 'delete') {
            this._deleteNode(id);

        }
    }

    _onBadgeClick(badge) {
        const i = Number(badge.dataset.arc);
        const a = this._model.arcs && this._model.arcs[i];
        if (!a) return;

        if (this._mode === 'delete') {
            this._model.arcs = (this._model.arcs || []).filter((_, j) => j !== i);
            this._normalizeModel();
            this._renderUI();
            this._syncLD();
            this._pushHistory();
            return;
        }

        // Allow editing in select and add-token modes
        if (this._mode === 'select' || this._mode === 'add-token') {
            try {
                const cur = Number(a.weight?.[0] || 1);
                const ans = prompt('Arc weight (positive integer)', String(cur));
                const parsed = Number(ans);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    a.weight = [Math.floor(parsed)];
                    this._normalizeModel();
                    this._renderUI();
                    this._syncLD();
                    this._pushHistory();
                }
            } catch {
            }
        }
    }

    _onBadgeContext(badge) {
        const i = Number(badge.dataset.arc);
        const a = this._model.arcs && this._model.arcs[i];
        if (!a) return;
        if (this._mode === 'add-token') {
            const cur = Number(a.weight?.[0] || 1);
            const nw = Math.max(1, cur - 1);
            a.weight = [nw];
            this._normalizeModel();
            this._renderUI();
            this._syncLD();
            this._pushHistory();
            return;
        }
        if (this._mode === 'delete') {
            this._model.arcs = (this._model.arcs || []).filter((_, j) => j !== i);
            this._normalizeModel();
            this._renderUI();
            this._syncLD();
            this._pushHistory();
        }
    }

    // ---------------- node deletion ----------------
    _deleteNode(id) {
        if (!this._model) return;
        let changed = false;
        if (this._model.places && this._model.places[id]) {
            delete this._model.places[id];
            changed = true;
        }
        if (this._model.transitions && this._model.transitions[id]) {
            delete this._model.transitions[id];
            changed = true;
        }
        if (!changed) return;
        this._model.arcs = (this._model.arcs || []).filter(a => a.source !== id && a.target !== id);
        if (this._arcDraft && this._arcDraft.source === id) this._arcDraft = null;
        this._normalizeModel();
        this._renderUI();
        this._syncLD();
        this._pushHistory();
        this.dispatchEvent(new CustomEvent('node-deleted', {detail: {id}}));
    }

    // ---------------- editing menu & modes ----------------

    _createMenu() {
        if (this._menu) this._menu.remove();
        this._menu = document.createElement('div');
        this._menu.className = 'pv-menu';
        this._applyStyles(this._menu, {
            position: 'absolute', bottom: '10px', left: '50%', transform: 'translateX(-50%)',
            display: 'flex', gap: '8px', padding: '6px 8px', background: 'rgba(255,255,255,0.9)',
            borderRadius: '8px', boxShadow: '0 2px 6px rgba(0,0,0,0.15)', zIndex: 1200, alignItems: 'center',
            userSelect: 'none', fontSize: '14px'
        });

        const tools = [
            {mode: 'select', label: '\u26F6', title: 'Select / Fire (1)'},
            {mode: 'add-place', label: '\u25EF', title: 'Add Place (2)'},
            {mode: 'add-transition', label: '\u25A2', title: 'Add Transition (3)'},
            {mode: 'add-arc', label: '\u2192', title: 'Add Arc (4)'},
            {mode: 'add-token', label: '\u2022', title: 'Add / Remove Tokens (5)'},
            {mode: 'delete', label: '\u{1F5D1}', title: 'Delete element (6)'},
        ];

        tools.forEach(t => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pv-tool';
            btn.textContent = t.label;
            btn.title = t.title;
            this._applyStyles(btn, {
                width: '36px',
                height: '36px',
                borderRadius: '6px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: '16px'
            });
            btn.dataset.mode = t.mode;
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._setMode(t.mode);
            });
            this._menu.appendChild(btn);
        });

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'pv-play';
        playBtn.textContent = this._simRunning ? '⏸' : '▶';
        playBtn.title = this._simRunning ? 'Stop simulation' : 'Start simulation';
        this._applyStyles(playBtn, {
            width: '44px',
            height: '36px',
            borderRadius: '6px',
            border: 'none',
            background: 'linear-gradient(180deg,#fff,#f3f3f3)',
            cursor: 'pointer',
            fontSize: '16px'
        });
        playBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._setSimulation(!this._simRunning);
        });
        this._menu.appendChild(playBtn);
        this._menuPlayBtn = playBtn;

        this._root.appendChild(this._menu);
        this._root.addEventListener('click', (ev) => this._onRootClick(ev));

        // Ensure the menu reflects the current mode (e.g. default 'select') right after creation
        this._updateMenuActive();
    }

    _setMode(mode) {
        if (this._simRunning && mode !== 'select') return;
        this._mode = mode;
        if (mode !== 'add-arc' && this._arcDraft) {
            this._arcDraft = null;
            this._updateArcDraftHighlight();
        }
        this._updateMenuActive();
    }

    _updateMenuActive() {
        if (!this._menu) return;
        this._menu.querySelectorAll('.pv-tool').forEach(btn => {
            btn.style.background = (btn.dataset.mode === this._mode) ? 'rgba(0,0,0,0.08)' : 'transparent';
        });
    }

    _onRootClick(ev) {
        if (ev.target.closest('.pv-node') || ev.target.closest('.pv-weight') || ev.target.closest('.pv-menu')) return;
        const rect = this._stage.getBoundingClientRect();
        const x = Math.round(ev.clientX - rect.left);
        const y = Math.round(ev.clientY - rect.top);
        if (this._mode === 'add-place') {
            const id = this._genId('p');
            this._model.places[id] = {'@type': 'Place', x, y, initial: [0], capacity: [Infinity]};
            this._normalizeModel();
            this._renderUI();
            this._syncLD();
            this._pushHistory();
        } else if (this._mode === 'add-transition') {
            const id = this._genId('t');
            this._model.transitions[id] = {'@type': 'Transition', x, y};
            this._normalizeModel();
            this._renderUI();
            this._syncLD();
            this._pushHistory();
        }
    }

    _setSimulation(running) {
        if (running === !!this._simRunning) return;
        if (running) {
            this._prevMode = this._mode;
            this._simRunning = true;
            this._setMode('select');
            if (this._menuPlayBtn) {
                this._menuPlayBtn.textContent = '⏸';
                this._menuPlayBtn.title = 'Stop simulation';
            }
            if (this._menu) {
                this._menu.querySelectorAll('.pv-tool').forEach(btn => {
                    btn.disabled = true;
                    btn.style.opacity = '0.5';
                    btn.style.cursor = 'default';
                });
            }
            this._root.classList.add('pv-simulating');
            this.dispatchEvent(new CustomEvent('simulation-started'));
        } else {
            this._simRunning = false;
            if (this._menuPlayBtn) {
                this._menuPlayBtn.textContent = '▶';
                this._menuPlayBtn.title = 'Start simulation';
            }
            if (this._menu) {
                this._menu.querySelectorAll('.pv-tool').forEach(btn => {
                    btn.disabled = false;
                    btn.style.opacity = '';
                    btn.style.cursor = '';
                });
            }
            this._root.classList.remove('pv-simulating');
            this._setMode(this._prevMode || 'select');
            this._prevMode = null;
            this.dispatchEvent(new CustomEvent('simulation-stopped'));
        }
    }

    // ---------------- dragging ----------------
    _snap(n, g = 10) {
        return Math.round(n / g) * g;
    }

    _beginDrag(ev, id, kind) {
        // Prevent dragging while simulation (play) is running
        if (this._simRunning) return;

        ev.preventDefault();
        const el = this._nodes[id];
        if (!el) return;
        try {
            el.setPointerCapture(ev.pointerId);
        } catch {
        }

        // set grabbing cursor during element drag (apply to element and body)
        try {
            el.style.cursor = 'grabbing';
            document.body.style.cursor = 'grabbing';
        } catch { /* ignore */
        }

        const startLeft = parseFloat(el.style.left) || 0;
        const startTop = parseFloat(el.style.top) || 0;
        const startX = ev.clientX, startY = ev.clientY;
        const scale = this._view.scale || 1;
        const offset = kind === 'place' ? 40 : 15;
        let currentLeft = startLeft, currentTop = startTop;

        const move = (e) => {
            const dxLocal = (e.clientX - startX) / scale;
            const dyLocal = (e.clientY - startY) / scale;
            let newLeft = startLeft + dxLocal;
            let newTop = startTop + dyLocal;
            currentLeft = newLeft;
            currentTop = newTop;
            const minLeft = -offset, minTop = -offset;
            if (newLeft < minLeft) {
                newLeft = minLeft;
                currentLeft = newLeft;
            }
            if (newTop < minTop) {
                newTop = minTop;
                currentTop = newTop;
            }
            el.style.left = `${newLeft}px`;
            el.style.top = `${newTop}px`;
            if (kind === 'place') {
                // update model coords while dragging (keeps visual responsive)
                const x = Math.round((newLeft + offset));
                const y = Math.round((newTop + offset));
                const p = this._model.places[id];
                if (p) {
                    p.x = x;
                    p.y = y;
                }
            } else {
                const x = Math.round((newLeft + offset));
                const y = Math.round((newTop + offset));
                const t = this._model.transitions[id];
                if (t) {
                    t.x = x;
                    t.y = y;
                }
            }
            this._draw();
        };

        const up = (e) => {
            try {
                el.releasePointerCapture(ev.pointerId);
            } catch {
            }
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);

            // restore cursor
            try {
                el.style.cursor = '';
                document.body.style.cursor = '';
            } catch { /* ignore */
            }

            if (kind === 'place') {
                // snap to grid and persist
                const nx = this._snap(currentLeft + offset);
                const ny = this._snap(currentTop + offset);
                const p = this._model.places[id];
                if (p) {
                    p.x = nx;
                    p.y = ny;
                }
            } else {
                const nx = this._snap(currentLeft + offset);
                const ny = this._snap(currentTop + offset);
                const t = this._model.transitions[id];
                if (t) {
                    t.x = nx;
                    t.y = ny;
                }
            }
            this._renderUI();
            this._syncLD();
            this._pushHistory();
            this.dispatchEvent(new CustomEvent('node-moved', {detail: {id, kind}}));
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }

    // ---------------- drawing ----------------
    _onResize() {
        const rect = this._root.getBoundingClientRect();
        const w = Math.max(300, Math.floor(rect.width));
        const h = Math.max(200, Math.floor(rect.height));
        this._canvas.width = Math.floor(w * this._dpr);
        this._canvas.height = Math.floor(h * this._dpr);
        this._canvas.style.width = `${w}px`;
        this._canvas.style.height = `${h}px`;
        this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
        this._draw();
    }

    _applyViewTransform() {
        if (!this._stage) return;
        const {tx, ty, scale} = this._view;
        this._stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        this._updateScaleMeter();
    }

    _draw() {
        const ctx = this._ctx;
        const rootRect = this._root.getBoundingClientRect();
        const width = this._canvas.width / this._dpr;
        const height = this._canvas.height / this._dpr;
        ctx.clearRect(0, 0, width, height);
        ctx.lineWidth = 1;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const scale = this._view.scale || 1;
        const viewTx = this._view.tx || 0;
        const viewTy = this._view.ty || 0;

        const arcs = this._model.arcs || [];
        arcs.forEach((arc, idx) => {
            const srcEl = this._nodes[arc.source];
            const trgEl = this._nodes[arc.target];
            if (!srcEl || !trgEl) return;
            const srcRect = srcEl.getBoundingClientRect();
            const trgRect = trgEl.getBoundingClientRect();
            const sxScreen = (srcRect.left + srcRect.width / 2) - rootRect.left;
            const syScreen = (srcRect.top + srcRect.height / 2) - rootRect.top;
            const txScreen = (trgRect.left + trgRect.width / 2) - rootRect.left;
            const tyScreen = (trgRect.top + trgRect.height / 2) - rootRect.top;
            const sx = (sxScreen - viewTx) / scale;
            const sy = (syScreen - viewTy) / scale;
            const tx = (txScreen - viewTx) / scale;
            const ty = (tyScreen - viewTy) / scale;

            const srcIsPlace = srcEl.classList.contains('pv-place');
            const trgIsPlace = trgEl.classList.contains('pv-place');
            const padPlace = 16 + 2;
            const padTransition = 15 + 2;
            const padSrc = srcIsPlace ? padPlace : padTransition;
            const padTrg = trgIsPlace ? padPlace : padTransition;

            const dx = tx - sx, dy = ty - sy;
            const dist = Math.hypot(dx, dy) || 1;
            const ux = dx / dist, uy = dy / dist;
            const ahSize = 8;
            const inhibitRadius = 6;
            const tipOffset = arc.inhibitTransition ? (inhibitRadius + 2) : (ahSize * 0.9);
            const ex = sx + ux * padSrc, ey = sy + uy * padSrc;
            const fx = tx - ux * (padTrg + tipOffset), fy = ty - uy * (padTrg + tipOffset);

            if (arc.inhibitTransition) {
                ctx.strokeStyle = '#c0392b';
                ctx.setLineDash([6, 4]);
            } else {
                ctx.strokeStyle = '#000000';
                ctx.setLineDash([]);
            }

            ctx.beginPath();
            ctx.moveTo(ex, ey);
            ctx.lineTo(fx, fy);
            ctx.stroke();

            const tpx = fx, tpy = fy;
            if (arc.inhibitTransition) {
                ctx.beginPath();
                ctx.fillStyle = '#c0392b';
                ctx.setLineDash([]);
                ctx.arc(tpx, tpy, inhibitRadius, 0, Math.PI * 2);
                ctx.fill();
                ctx.beginPath();
                ctx.fillStyle = '#ffffff';
                ctx.arc(tpx, tpy, 2.5, 0, Math.PI * 2);
                ctx.fill();
            } else {
                const leftx = tpx - ux * ahSize - uy * (ahSize * 0.6);
                const lefty = tpy - uy * ahSize + ux * (ahSize * 0.6);
                const rightx = tpx - ux * ahSize + uy * (ahSize * 0.6);
                const righty = tpy - uy * ahSize - ux * (ahSize * 0.6);
                ctx.beginPath();
                ctx.fillStyle = '#000000';
                ctx.setLineDash([]);
                ctx.moveTo(tpx, tpy);
                ctx.lineTo(leftx, lefty);
                ctx.lineTo(rightx, righty);
                ctx.closePath();
                ctx.fill();
            }

            const bx = (ex + fx) / 2;
            const by = (ey + fy) / 2;
            const badge = this._stage.querySelector(`.pv-weight[data-arc="${idx}"]`);
            if (badge) {
                badge.style.left = `${bx - 12}px`;
                badge.style.top = `${by - 10}px`;
            }
        });

        // live arc draft preview
        if (this._arcDraft && this._arcDraft.source) {
            const srcEl = this._nodes[this._arcDraft.source];
            if (srcEl) {
                const srcRect = srcEl.getBoundingClientRect();
                const sxScreen = (srcRect.left + srcRect.width / 2) - rootRect.left;
                const syScreen = (srcRect.top + srcRect.height / 2) - rootRect.top;
                const sx = (sxScreen - viewTx) / scale;
                const sy = (syScreen - viewTy) / scale;
                const mx = (this._mouse.x - viewTx) / scale;
                const my = (this._mouse.y - viewTy) / scale;
                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = '#666';
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(mx, my);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
    }

    // ---------------- tokens & transitions states ----------------
    _renderTokens() {
        for (const [id, el] of Object.entries(this._nodes)) {
            if (!el.classList.contains('pv-place')) continue;
            el.querySelectorAll('.pv-token, .pv-token-dot').forEach(n => n.remove());
            const p = this._model.places[id];
            const tokenCount = Array.isArray(p.initial) ? p.initial.reduce((s, v) => s + (Number(v) || 0), 0) : Number(p.initial || 0);
            if (tokenCount > 1) {
                const token = document.createElement('div');
                token.className = 'pv-token';
                token.textContent = '' + tokenCount;
                el.appendChild(token);
            } else if (tokenCount === 1) {
                const dot = document.createElement('div');
                dot.className = 'pv-token-dot';
                el.appendChild(dot);
            }
            const cap = this._capacityOf(id);
            el.toggleAttribute('data-cap-full', Number.isFinite(cap) && tokenCount >= cap);
        }
    }

    _updateTransitionStates() {
        const marks = this._marking();
        for (const [id, el] of Object.entries(this._nodes)) {
            if (!el.classList.contains('pv-transition')) continue;
            const on = this._enabled(id, marks);
            el.classList.toggle('pv-active', !!on);
        }
    }

    // ---------------- arc creation UX ----------------
    _arcNodeClicked(id, opts = {}) {
        if (!this._arcDraft || !this._arcDraft.source) {
            this._arcDraft = {source: id};
            this._updateArcDraftHighlight();
            this._draw();
            return;
        }
        const source = this._arcDraft.source;
        const target = id;
        const srcEl = this._nodes[source], trgEl = this._nodes[target];
        if (srcEl && trgEl) {
            const srcIsPlace = srcEl.classList.contains('pv-place');
            const trgIsPlace = trgEl.classList.contains('pv-place');
            if (srcIsPlace === trgIsPlace) {
                this._flashInvalidArc(srcEl);
                this._flashInvalidArc(trgEl);
                this._arcDraft = null;
                this._updateArcDraftHighlight();
                this._draw();
                return;
            }
        }
        if (source === target) {
            this._arcDraft = null;
            this._updateArcDraftHighlight();
            this._draw();
            return;
        }
        let w = 1;
        try {
            const ans = prompt('Arc weight (positive integer)', '1');
            const parsed = Number(ans);
            if (!Number.isNaN(parsed) && parsed > 0) w = Math.floor(parsed);
        } catch {
        }
        this._model.arcs = this._model.arcs || [];
        const inhibit = !!opts.inhibit;
        this._model.arcs.push({'@type': 'Arrow', source, target, weight: [w], inhibitTransition: inhibit});
        this._arcDraft = null;
        this._normalizeModel();
        this._renderUI();
        this._syncLD();
        this._pushHistory();
    }

    _updateArcDraftHighlight() {
        for (const el of Object.values(this._nodes)) el.classList.toggle('pv-arc-src', false);
        if (this._arcDraft && this._arcDraft.source) {
            const srcEl = this._nodes[this._arcDraft.source];
            if (srcEl) srcEl.classList.toggle('pv-arc-src', true);
        }
    }

    _flashInvalidArc(el) {
        if (!el) return;
        el.classList.add('pv-invalid');
        setTimeout(() => el.classList.remove('pv-invalid'), 350);
    }

    // ---------------- scale meter ----------------
    _createScaleMeter() {
        if (this._scaleMeter) this._scaleMeter.remove();
        const min = this._minScale || 0.5, max = this._maxScale || 2.5;

        const container = document.createElement('div');
        container.className = 'pv-scale-meter';
        this._applyStyles(container, {
            position: 'absolute',
            right: '10px',
            top: '50%',
            transform: 'translateY(-50%)',
            width: '52px',
            height: '160px',
            padding: '8px',
            background: 'rgba(255,255,255,0.94)',
            borderRadius: '10px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            zIndex: 3000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '8px',
            userSelect: 'none',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial'
        });

        const label = document.createElement('div');
        label.className = 'pv-scale-label';
        this._applyStyles(label, {fontSize: '12px', color: '#333', lineHeight: '1'});
        container.appendChild(label);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'pv-scale-reset';
        resetBtn.type = 'button';
        resetBtn.textContent = '1x';
        this._applyStyles(resetBtn, {
            width: '36px',
            height: '20px',
            borderRadius: '6px',
            border: '1px solid #ddd',
            background: '#fff',
            cursor: 'pointer',
            fontSize: '12px',
            color: '#333',
            marginBottom: '4px',
            padding: '0'
        });
        resetBtn.title = 'Reset scale to 1x';
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._view.scale = 1;
            const rootRect = this._root?.getBoundingClientRect();
            if (this._initialView && typeof this._initialView.tx === 'number' && typeof this._initialView.ty === 'number') {
                this._view.tx = this._initialView.tx;
                this._view.ty = this._initialView.ty;
            } else if (rootRect) {
                this._view.tx = Math.round(rootRect.width / 2);
                this._view.ty = Math.round(rootRect.height / 2);
            }
            this._initialView = {...this._view};
            this._applyViewTransform();
            this._draw();
            this._updateScaleMeter();
        });
        container.appendChild(resetBtn);

        const track = document.createElement('div');
        track.className = 'pv-scale-track';
        this._applyStyles(track, {
            position: 'relative',
            width: '10px',
            flex: '1 1 auto',
            height: '100%',
            background: '#eee',
            borderRadius: '6px',
            overflow: 'hidden',
            alignSelf: 'center'
        });
        const fill = document.createElement('div');
        fill.className = 'pv-scale-fill';
        this._applyStyles(fill, {
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            bottom: '0',
            width: '10px',
            height: '0%',
            background: 'linear-gradient(180deg,#4A90E2,#2A6FB8)',
            borderRadius: '6px'
        });
        track.appendChild(fill);
        const thumb = document.createElement('div');
        thumb.className = 'pv-scale-thumb';
        this._applyStyles(thumb, {
            position: 'absolute',
            left: '50%',
            transform: 'translate(-50%, 50%)',
            bottom: '0%',
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            background: '#fff',
            border: '2px solid #2a6fb8',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
        });
        track.appendChild(thumb);
        container.appendChild(track);

        const legend = document.createElement('div');
        this._applyStyles(legend, {
            width: '100%',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '10px',
            color: '#666'
        });
        const minEl = document.createElement('span');
        minEl.textContent = `${min}x`;
        const maxEl = document.createElement('span');
        maxEl.textContent = `${max}x`;
        legend.appendChild(minEl);
        legend.appendChild(maxEl);
        container.appendChild(legend);

        // pointer interactions
        let dragging = false;
        const setScaleFromClientY = (clientY) => {
            const rect = track.getBoundingClientRect();
            let pos = (rect.bottom - clientY) / rect.height;
            pos = Math.max(0, Math.min(1, pos));
            const s = min + pos * (max - min);
            this._view.scale = Math.round(s * 100) / 100;
            this._applyViewTransform();
            this._draw();
            this._updateScaleMeter();
        };
        track.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            dragging = true;
            track.setPointerCapture(e.pointerId);
            setScaleFromClientY(e.clientY);
        });
        track.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            setScaleFromClientY(e.clientY);
        });
        track.addEventListener('pointerup', (e) => {
            dragging = false;
            try {
                track.releasePointerCapture(e.pointerId);
            } catch {
            }
        });
        track.addEventListener('pointercancel', () => {
            dragging = false;
        });

        this._root.appendChild(container);
        this._scaleMeter = container;
        this._scaleMeter._label = label;
        this._scaleMeter._fill = fill;
        this._scaleMeter._thumb = thumb;
        this._scaleMeter._track = track;
        this._updateScaleMeter();
    }

    _updateScaleMeter() {
        if (!this._scaleMeter) return;
        const min = this._minScale || 0.5, max = this._maxScale || 2.5;
        const s = (this._view && this._view.scale) ? Number(this._view.scale) : 1;
        const frac = Math.max(0, Math.min(1, (s - min) / (max - min)));
        const pct = Math.round(frac * 100);
        this._scaleMeter._fill.style.height = `${pct}%`;
        this._scaleMeter._thumb.style.bottom = `${pct}%`;
        this._scaleMeter._label.textContent = `${s.toFixed(2)}x`;
    }

    _removeJsonEditor() {
        if (!this._jsonEditor) return;
        if (this._jsonEditorTimer) {
            clearTimeout(this._jsonEditorTimer);
            this._jsonEditorTimer = null;
        }
        try {
            // destroy ace if present
            if (this._aceEditor) {
                try {
                    this._aceEditor.destroy();
                } catch {
                }
                try {
                    this._aceEditorContainer.remove();
                } catch {
                }
                this._aceEditor = null;
                this._aceEditorContainer = null;
            }
            this._jsonEditor.remove();
        } catch {
        }
        this._jsonEditor = null;
        this._jsonEditorTextarea = null;
        this._editingJson = false;
    }

    _updateJsonEditor() {
        if (this._editingJson) return;
        const pretty = !this.hasAttribute('data-compact');
        const text = pretty ? this._stableStringify(this._model, 2) : JSON.stringify(this._model);
        if (this._aceEditor) {
            // avoid clobbering user's edits
            if (!this._editingJson && this._aceEditor.session.getValue() !== text) {
                this._aceEditor.session.setValue(text, -1); // -1 keeps cursor/undo state intact
                if (this._jsonEditorTextarea) this._jsonEditorTextarea.value = text;
                if (this._jsonEditorTextarea) this._jsonEditorTextarea.style.borderColor = '#ccc';
            }
            return;
        }
        if (this._jsonEditorTextarea && this._jsonEditorTextarea.value !== text) {
            this._jsonEditorTextarea.value = text;
            this._jsonEditorTextarea.style.borderColor = '#ccc';
        }
    }


    _onJsonEditorInput(flush = false) {
        if (!this._jsonEditorTextarea && !this._aceEditor) return;
        this._editingJson = true;
        if (this._jsonEditorTimer) {
            clearTimeout(this._jsonEditorTimer);
            this._jsonEditorTimer = null;
        }
        const applyEdit = () => {
            const txt = this._aceEditor ? this._aceEditor.session.getValue() : this._jsonEditorTextarea.value;
            try {
                const parsed = JSON.parse(txt);
                this._editingJson = false;
                this._model = parsed || {};
                this._normalizeModel();
                this._renderUI();
                this._syncLD(true);
                this._pushHistory();
                if (this._jsonEditorTextarea) this._jsonEditorTextarea.style.borderColor = '#ccc';
            } catch (err) {
                if (this._jsonEditorTextarea) this._jsonEditorTextarea.style.borderColor = '#c0392b';
                // keep editing flag true until parse succeeds
            }
        };
        if (flush) {
            applyEdit();
            return;
        }
        this._jsonEditorTimer = setTimeout(() => {
            this._jsonEditorTimer = null;
            applyEdit();
        }, 700);
    }

    // ---------------- global root events (mouse, wheel, pan, keys) ----------------
    _wireRootEvents() {
        // mouse tracking for arc draft
        this._root.addEventListener('pointermove', (e) => {
            const r = this._root.getBoundingClientRect();
            this._mouse.x = Math.round(e.clientX - r.left);
            this._mouse.y = Math.round(e.clientY - r.top);
            if (this._arcDraft) this._draw();
        });

        // wheel zoom
        this._root.addEventListener('wheel', (e) => {
            e.preventDefault();
            const r = this._root.getBoundingClientRect();
            const mx = e.clientX - r.left, my = e.clientY - r.top;
            const prev = this._view.scale;
            const next = Math.max(this._minScale, Math.min(this._maxScale, prev * (e.deltaY < 0 ? 1.1 : 0.9)));
            if (next === prev) return;
            this._view.tx = mx - (mx - this._view.tx) * (next / prev);
            this._view.ty = my - (my - this._view.ty) * (next / prev);
            this._view.scale = next;
            this._applyViewTransform();
            this._draw();
        }, {passive: false});

        window.addEventListener('keydown', (e) => {
            if (e.key === ' ') this._spaceDown = true;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) this._redoAction(); else this._undoAction();
            }

            if (e.key && e.key.toLowerCase() === 'x') {
                e.preventDefault();
                this._setSimulation(!this._simRunning);
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                this._setMode('select');
                if (this._simRunning) {
                    this._setSimulation(false);
                    return;
                }
                if (this._arcDraft) {
                    this._arcDraft = null;
                    this._updateArcDraftHighlight();
                    this._draw();
                }
                return;
            }

            const map = {
                '1': 'select',
                '2': 'add-place',
                '3': 'add-transition',
                '4': 'add-arc',
                '5': 'add-token',
                '6': 'delete'
            };
            if (map[e.key]) this._setMode(map[e.key]);
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === ' ') this._spaceDown = false;
        });

        // panning pointer down/move/up
        this._root.addEventListener('pointerdown', (e) => {
            // If so, allow left-button drag to pan even without modifiers.
            const interactiveSelector = '.pv-node, .pv-weight, .pv-menu, .pv-json-editor, .pv-scale-meter, .pv-json-textarea, .pv-tool, .pv-play';
            const clickedInteractive = !!e.target.closest && e.target.closest(interactiveSelector);
            const leftButton = e.button === 0;

            const isPan = this._spaceDown || e.button === 1 || e.altKey || e.ctrlKey || e.metaKey || (leftButton && !clickedInteractive);

            if (isPan) {
                e.preventDefault();
                // start panning
                this._panning = {
                    x: e.clientX,
                    y: e.clientY,
                    tx: this._view.tx,
                    ty: this._view.ty,
                    pointerId: e.pointerId
                };
                // set grabbing cursor during pan (apply to root and body to ensure coverage)
                try {
                    this._root.style.cursor = 'grabbing';
                    document.body.style.cursor = 'grabbing';
                } catch { /* ignore */
                }

                // capture pointer on root so we receive move/up outside it
                try {
                    if (this._root.setPointerCapture) this._root.setPointerCapture(e.pointerId);
                } catch { /* ignore */
                }
            }
        });

        this._root.addEventListener('pointermove', (e) => {
            if (!this._panning) return;
            this._view.tx = this._panning.tx + (e.clientX - this._panning.x);
            this._view.ty = this._panning.ty + (e.clientY - this._panning.y);
            this._applyViewTransform();
            this._draw();
        });

        const endPan = (e) => {
            if (!this._panning) return;
            // release pointer capture if set
            try {
                if (this._root.releasePointerCapture) this._root.releasePointerCapture(this._panning.pointerId ?? e.pointerId);
            } catch { /* ignore */
            }

            this._panning = null;
            // restore cursor
            try {
                this._root.style.cursor = '';
                document.body.style.cursor = '';
            } catch { /* ignore */
            }

            // optionally push history or dispatch event if needed
            // this._pushHistory();
        };

        this._root.addEventListener('pointerup', endPan);
        this._root.addEventListener('pointercancel', endPan);
    }

    _wireRootEvents() {
        // mouse tracking for arc draft
        this._root.addEventListener('pointermove', (e) => {
            const r = this._root.getBoundingClientRect();
            this._mouse.x = Math.round(e.clientX - r.left);
            this._mouse.y = Math.round(e.clientY - r.top);
            if (this._arcDraft) this._draw();
        });

        // wheel zoom
        this._root.addEventListener('wheel', (e) => {
            e.preventDefault();
            const r = this._root.getBoundingClientRect();
            const mx = e.clientX - r.left, my = e.clientY - r.top;
            const prev = this._view.scale;
            const next = Math.max(this._minScale, Math.min(this._maxScale, prev * (e.deltaY < 0 ? 1.1 : 0.9)));
            if (next === prev) return;
            this._view.tx = mx - (mx - this._view.tx) * (next / prev);
            this._view.ty = my - (my - this._view.ty) * (next / prev);
            this._view.scale = next;
            this._applyViewTransform();
            this._draw();
        }, {passive: false});

        window.addEventListener('keydown', (e) => {
            if (e.key === ' ') this._spaceDown = true;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                if (e.shiftKey) this._redoAction(); else this._undoAction();
            }

            if (e.key && e.key.toLowerCase() === 'x') {
                e.preventDefault();
                this._setSimulation(!this._simRunning);
                return;
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                this._setMode('select');
                if (this._simRunning) {
                    this._setSimulation(false);
                    return;
                }
                if (this._arcDraft) {
                    this._arcDraft = null;
                    this._updateArcDraftHighlight();
                    this._draw();
                }
                return;
            }

            const map = {
                '1': 'select',
                '2': 'add-place',
                '3': 'add-transition',
                '4': 'add-arc',
                '5': 'add-token',
                '6': 'delete'
            };
            if (map[e.key]) this._setMode(map[e.key]);
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === ' ') this._spaceDown = false;
        });

        // panning pointer down/move/up
        this._root.addEventListener('pointerdown', (e) => {
            // If so, allow left-button drag to pan even without modifiers.
            const interactiveSelector = '.pv-node, .pv-weight, .pv-menu, .pv-json-editor, .pv-scale-meter, .pv-json-textarea, .pv-tool, .pv-play';
            const clickedInteractive = !!e.target.closest && e.target.closest(interactiveSelector);
            const leftButton = e.button === 0;

            const isPan = this._spaceDown || e.button === 1 || e.altKey || e.ctrlKey || e.metaKey || (leftButton && !clickedInteractive);

            if (isPan) {
                e.preventDefault();
                // start panning
                this._panning = {
                    x: e.clientX,
                    y: e.clientY,
                    tx: this._view.tx,
                    ty: this._view.ty,
                    pointerId: e.pointerId
                };
                // set grabbing cursor during pan (apply to root and body to ensure coverage)
                try {
                    this._root.style.cursor = 'grabbing';
                    document.body.style.cursor = 'grabbing';
                } catch { /* ignore */
                }

                // capture pointer on root so we receive move/up outside it
                try {
                    if (this._root.setPointerCapture) this._root.setPointerCapture(e.pointerId);
                } catch { /* ignore */
                }
            }
        });

        this._root.addEventListener('pointermove', (e) => {
            if (!this._panning) return;
            this._view.tx = this._panning.tx + (e.clientX - this._panning.x);
            this._view.ty = this._panning.ty + (e.clientY - this._panning.y);
            this._applyViewTransform();
            this._draw();
        });

        const endPan = (e) => {
            if (!this._panning) return;
            // release pointer capture if set
            try {
                if (this._root.releasePointerCapture) this._root.releasePointerCapture(this._panning.pointerId ?? e.pointerId);
            } catch { /* ignore */
            }

            this._panning = null;
            // restore cursor
            try {
                this._root.style.cursor = '';
                document.body.style.cursor = '';
            } catch { /* ignore */
            }

            // optionally push history or dispatch event if needed
            // this._pushHistory();
        };

        this._root.addEventListener('pointerup', endPan);
        this._root.addEventListener('pointercancel', endPan);
    }

    _getStorageKey() {
        const id = this.getAttribute('id') || this.getAttribute('name') || '';
        return `petri-view:last${id ? ':' + id : ''}`;
    }

}

customElements.define('petri-view', PetriView);
export {PetriView};