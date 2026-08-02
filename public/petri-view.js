import * as Sim from './petri-sim.js';
import {computeCid} from './seal-cid.mjs';

// Mode capabilities - defines what actions each tool mode allows
const MODE_CAPS = {
    'select': {
        canDragNode: true,
        canGroupDrag: true,
        canMultiSelect: true,
        canBoxSelect: true,
        canEditWeight: true,
        canFireTransition: true,
    },
    'add-place': {
        canCreatePlace: true,
        canDragNode: true,
        canGroupDrag: true,
        canMultiSelect: true,
        canBoxSelect: true,
    },
    'add-transition': {
        canCreateTransition: true,
        canDragNode: true,
        canGroupDrag: true,
        canMultiSelect: true,
        canBoxSelect: true,
    },
    'add-arc': {
        canCreateArc: true,
        canLongPressInhibitor: true,
        canDragNode: true,
        canGroupDrag: true,
        canMultiSelect: true,
        canBoxSelect: true,
    },
    'add-token': {
        canMultiSelect: true,
        canBoxSelect: true,
        canEditWeight: true,
        canModifyTokens: true,
        canDragNode: true,
        canGroupDrag: true,
    },
    'delete': {
        canMultiSelect: true,
        canBoxSelect: true,
        canDeleteOnClick: true,
    },
};

// ── Web Component (browser only) ──────────────────────────────────
let PetriView;
if (typeof HTMLElement !== 'undefined') {
PetriView = class PetriView extends HTMLElement {

    // Bumped when the default split changes, so a stored value from an older
    // layout is ignored rather than pinning returning visitors to it.
    // v3: the narrow default changed from a `calc(100% - handle)` basis to
    // `1 1 0` when the run bar joined the same flex column. A restored v2 value
    // would claim the whole root and push the bar off the bottom of the screen.
    static DIVIDER_KEY = 'pv-divider-position-v3';

    // Shown in the hamburger menu footer. Must match "version" in package.json,
    // which a release commit bumps alongside the annotated git tag — there is no
    // build step for this file, so the value cannot be injected. `make
    // test-version` fails the build if the two ever drift.
    static VERSION = '1.24.0';

    constructor() {
        super();
        // DOM & rendering
        this._root = null;
        this._stage = null;
        this._canvas = null;
        this._ctx = null;
        this._dpr = window.devicePixelRatio || 1;
        this._canvasOffset = {x: 0, y: 0}; // offset for negative coordinates

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
        this._syncingEditor = false; // flag to prevent change handler during programmatic updates

        // editing state
        this._mode = 'select';
        this._arcDraft = null;
        this._mouse = {x: 0, y: 0};
        this._labelEditMode = false;
        this._selectedNodes = new Set(); // for group-select mode
        this._boxSelect = null; // for bounding box selection: {startX, startY, endX, endY}

        // pan/zoom
        this._view = {scale: 1, tx: 0, ty: 0};
        this._panning = null;
        this._panPending = null; // pending pan until movement threshold exceeded
        this._panThreshold = 10; // pixels before pan activates
        this._spaceDown = false;
        // _minScale is a floor, not a constant. 0.5 is the desktop default, but a
        // model wider than the viewport cannot be fitted at 0.5 — the tic-tac-toe
        // net spans ~1600 world px, which needs ~0.24 on a 390px phone.
        // _recomputeScaleFloor() lowers it per model; it never raises it above 0.5.
        this._minScale = 0.5;
        this._maxScale = 2.5;
        this._scaleMeter = null;
        this._initialView = null;
        // Once the user has navigated deliberately, stop re-fitting under them.
        this._userHasPanned = false;
        this._didInitialFit = false;
        this._fitting = false; // re-entrancy guard: fitToView() calls _draw()

        // sim & history
        this._simRunning = false;
        this._prevMode = null;
        this._history = [];
        this._redo = [];

        // render batching to prevent race conditions with rapid actions
        this._updateScheduled = false;
        this._createdOnPointerUp = false; // prevent double-creation from click event
        this._dragOccurred = false; // prevent click action after drag

        this._ro = null;

        // fire queue to serialize rapid transition clicks
        this._fireQueue = [];
        this._processingFires = false;

        this._lastFireAt = Object.create(null);
        this._fireDebounceMs = 0; // no cooldown

        // layout orientation (vertical by default, horizontal when toggled)
        this._layoutHorizontal = false;

        // Authentication support (backend mode)
        this._user = null;
        this._authToken = null;
        this._authInitialized = false;
        this._authInitializing = false;

        // UI buttons
        this._hamburgerMenu = null;
        this._hamburgerDropdown = null;
        this._topRightButton = null;
        
        // Original CID from URL (for revert functionality)
        this._originalCid = null;
        
        // ODE Simulation
        this._simulationDialog = null;
        this._solverModule = null;
        
        // Display settings (persisted to localStorage)
        this._displaySettings = {
            hideUniformWeights: true, // hide weight badges when all arcs have weight 1
        };
        this._loadDisplaySettings();

        // Long-press support for touch/pen devices (for inhibitor arcs)
        this._longPressTimer = null;
        this._longPressThreshold = 500; // ms to trigger long-press
        this._longPressTriggered = false;
        this._longPressStartX = 0;
        this._longPressStartY = 0;
        this._longPressMoveThreshold = 15; // pixels of movement allowed
    }

    // observe compact flag and json editor toggle
    static get observedAttributes() {
        return ['data-compact', 'data-json-editor', 'data-backend', 'data-layout-horizontal'];
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'data-json-editor' && this.isConnected) {
            if (newValue !== null) this._createJsonEditor();
            else this._removeJsonEditor();
        }
        if (name === 'data-backend' && this.isConnected) {
            // Re-create hamburger menu with new mode
            if (this._hamburgerMenu) {
                this._hamburgerMenu.remove();
                this._hamburgerDropdown.remove();
                this._hamburgerMenu = null;
                this._hamburgerDropdown = null;
            }
            this._createHamburgerMenu();

            // Initialize authentication if in backend mode
            if (newValue !== null) {
                this._initAuth();
            }
        }
        if (name === 'data-layout-horizontal' && this.isConnected) {
            // Update layout orientation based on attribute
            const shouldBeHorizontal = newValue !== null;
            if (this._root && this._layoutHorizontal !== shouldBeHorizontal) {
                this._setLayout(shouldBeHorizontal);
            }
        }
    }

    // ---------------- Authentication Integration ----------------
    async _initAuth() {
        if (!this.hasAttribute('data-backend')) return;

        // Prevent concurrent initializations
        if (this._authInitializing) {
            return;
        }

        // Skip if already initialized
        if (this._authInitialized) {
            return;
        }

        try {
            this._authInitializing = true;

            // Check for access token in URL fragment (from OAuth callback)
            const hash = window.location.hash;
            if (hash && hash.includes('access_token=')) {
                const params = new URLSearchParams(hash.substring(1));
                const token = params.get('access_token');
                if (token) {
                    // Store the token
                    this._authToken = token;
                    localStorage.setItem('pflow_auth_token', token);
                    
                    // Clean up URL
                    window.history.replaceState({}, document.title, window.location.pathname + window.location.search);
                }
            }

            // Try to load token from localStorage
            if (!this._authToken) {
                this._authToken = localStorage.getItem('pflow_auth_token');
            }

            // Validate token and get user info
            if (this._authToken) {
                await this._fetchUserInfo();
            }

            this._authInitialized = true;
            this._updateMenuForAuth();
        } catch (err) {
            console.error('Failed to initialize authentication:', err);
            // Clear invalid token
            this._authToken = null;
            localStorage.removeItem('pflow_auth_token');
        } finally {
            this._authInitializing = false;
        }
    }

    async _fetchUserInfo() {
        if (!this._authToken) return;

        try {
            const response = await fetch('/auth/user', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this._authToken}`,
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.user) {
                    this._user = {
                        id: data.user.id,
                        email: data.user.email,
                        user_metadata: {
                            user_name: data.user.user_name,
                            full_name: data.user.full_name,
                        }
                    };
                } else {
                    // Token is invalid
                    this._user = null;
                    this._authToken = null;
                    localStorage.removeItem('pflow_auth_token');
                }
            } else {
                // Token is invalid
                this._user = null;
                this._authToken = null;
                localStorage.removeItem('pflow_auth_token');
            }
        } catch (err) {
            console.error('Failed to fetch user info:', err);
            this._user = null;
            this._authToken = null;
            localStorage.removeItem('pflow_auth_token');
        }
    }

    _updateMenuForAuth() {
        // Re-create hamburger menu to reflect authentication state
        if (this._hamburgerMenu) {
            this._hamburgerMenu.remove();
            this._hamburgerDropdown.remove();
            this._hamburgerMenu = null;
            this._hamburgerDropdown = null;
        }
        this._createHamburgerMenu();

        // Re-create top-right button to reflect authentication state
        if (this._topRightButton) {
            this._topRightButton.remove();
            this._topRightButton = null;
        }
        this._createTopRightButton();
    }

    async _loginWithGitHub() {
        // Redirect to GitHub OAuth via backend
        window.location.href = '/auth/github';
    }

    async _logout() {
        // Clear local auth state
        this._user = null;
        this._authToken = null;
        localStorage.removeItem('pflow_auth_token');
        
        // Update UI
        this._updateMenuForAuth();
    }

    // Updated _initAceEditor and _createJsonEditor in `public/petri-view.js`

    _loadScript(src, globalVar = 'ace') {
        return new Promise((resolve, reject) => {
            if (window[globalVar]) return resolve();
            if (document.querySelector(`script[src="${src}"]`)) {
                // already injected but maybe not ready
                const check = () => window[globalVar] ? resolve() : setTimeout(check, 50);
                return check();
            }
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = (e) => reject(e);
            document.head.appendChild(s);
        });
    }

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

        const makeBtn = (txt, title) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = txt;
            b.title = title;
            b.className = 'pv-ace-toolbar-btn';
            return b;
        };

        const findBtn = makeBtn('🔍 Find', 'Open find ( Ace searchbox )');
        const openUrlBtn = makeBtn('🌐 Open URL', 'Load JSON-LD from URL');
        const dlBtn = makeBtn('📥 Download', 'Download current JSON');
        const fsBtn = makeBtn('🔳 Full ⤢', 'Toggle fullscreen');
        const layoutToggleBtn = makeBtn('⇄', 'Toggle horizontal/vertical layout');
        const closeBtn = makeBtn('❌ Close', 'Close editor'); // moved close into ace toolbar
        toolbar.appendChild(findBtn);
        toolbar.appendChild(openUrlBtn);
        toolbar.appendChild(dlBtn);
        toolbar.appendChild(fsBtn);
        toolbar.appendChild(layoutToggleBtn);
        
        // Add revert button if we loaded from a CID
        if (this._originalCid) {
            // Show last 8 characters of CID
            const shortCid = this._originalCid.slice(-8);
            const revertBtn = makeBtn(`⟲ ${shortCid}`, `Revert to revision ${this._originalCid}`);
            revertBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                await this._revertToOriginalCid();
            });
            toolbar.appendChild(revertBtn);
        }
        
        toolbar.appendChild(closeBtn);

        // container for Ace
        const editorWrapper = document.createElement('div');
        editorWrapper.className = 'pv-ace-editor-wrapper';

        const editorDiv = document.createElement('div');
        editorDiv.className = 'pv-ace-editor';

        editorWrapper.appendChild(toolbar);
        editorWrapper.appendChild(editorDiv);
        this._jsonEditorTextarea.parentNode.insertBefore(editorWrapper, this._jsonEditorTextarea.nextSibling);

        // Hide fallback toolbar when ACE loads
        if (this._editorToolbar) {
            this._editorToolbar.style.display = 'none';
        }

        // init ace
        const editor = window.ace.edit(editorDiv);
        editor.setTheme(this._aceTheme());
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
                this._toast('Find command unavailable', 'error');
            }
        });

        // wire Open URL button: show dialog to load JSON-LD from URL
        openUrlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._showOpenUrlDialog(editor);
        });

        // wire download button: compute CID, inject @id, download as {cid}.jsonld
        dlBtn.addEventListener('click', async (e) => {
            e.stopPropagation();

            // Disable button and show loading state
            const originalText = dlBtn.textContent;
            dlBtn.disabled = true;
            dlBtn.textContent = '⏳ Computing CID...';

            try {
                const txt = editor.session.getValue();
                let doc;
                try {
                    doc = JSON.parse(txt);
                } catch (parseErr) {
                    throw new Error('Invalid JSON: ' + (parseErr.message || String(parseErr)));
                }

                // Compute CID from the document (without @id to avoid self-reference)
                // Remove any existing @id before computing CID for consistency
                const {'@id': _, ...docForCid} = doc;
                const cid = await this._computeCidForJsonLd(docForCid);

                // Inject @id with CID
                const docWithId = {...doc, '@id': cid};

                // Create download blob
                const blob = new Blob([JSON.stringify(docWithId, null, 2)], {
                    type: 'application/ld+json'
                });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${cid}.jsonld`;
                a.click();
                URL.revokeObjectURL(a.href);
            } catch (err) {
                this._toast('Download failed: ' + (err && err.message ? err.message : String(err)), 'error');
            } finally {
                // Restore button state
                dlBtn.disabled = false;
                dlBtn.textContent = originalText;
            }
        });

        // wire close button moved into ace toolbar
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._removeJsonEditor();
        });

        // wire layout toggle button
        layoutToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleLayout();
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
        this._watchColorScheme();
        this._aceEditorContainer = editorWrapper;
    }

    // Compute the canonical CIDv1 for a JSON-LD document.
    //
    // Delegates to the shared seal-cid module (public/seal-cid.mjs) so the editor
    // and the Go server (internal/seal.SealJSONLD) produce byte-identical CIDs.
    // This replaced an inline implementation that (a) canonicalized via naive
    // key-sorting instead of URDNA2015 and (b) mis-encoded the dag-json codec
    // varint as [0x01,0x29] instead of [0xA9,0x02] — both of which made the
    // editor's CID disagree with the stored CID. Parity is enforced by this
    // repo's CID parity test against parity/golden.json. computeCid() strips
    // the top-level @id itself, so callers may pass the full document.
    async _computeCidForJsonLd(doc) {
        return computeCid(doc);
    }

    // Validate if the given document is valid JSON-LD
    async _isValidJsonLd(doc) {
        // Use basic structural validation
        return this._basicJsonLdValidation(doc);
    }

    // Basic JSON-LD validation (fallback when jsonld library is not available)
    _basicJsonLdValidation(doc) {
        if (!doc || typeof doc !== 'object') {
            return false;
        }
        // Check for JSON-LD indicators: @context, @graph, @id, or @type
        return !!(doc['@context'] || doc['@graph'] || doc['@id'] || doc['@type']);
    }

    // Fetch URL with custom headers
    async _fetchWithHeaders(url, headers = {}) {
        const res = await fetch(url, {
            method: 'GET',
            headers,
            mode: 'cors',
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Fetch failed: ${res.status} ${res.statusText}${text ? ' - ' + text : ''}`);
        }
        const json = await res.json();
        return json;
    }

    // Show dialog to open URL with optional headers
    _showOpenUrlDialog(editor) {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pv-url-dialog-overlay pv-modal-overlay';

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-url-dialog pv-modal-dialog';

        // Title
        const title = document.createElement('h3');
        title.textContent = 'Open JSON-LD from URL';
        title.className = 'pv-url-dialog-title';
        dialog.appendChild(title);

        // URL input
        const urlLabel = document.createElement('label');
        urlLabel.textContent = 'URL:';
        urlLabel.className = 'pv-label';
        dialog.appendChild(urlLabel);

        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.placeholder = 'https://pflow.xyz/ld/data/test.jsonld';
        urlInput.className = 'pv-input';
        urlInput.style.marginBottom = '16px';
        dialog.appendChild(urlInput);

        // Headers section
        const headersLabel = document.createElement('label');
        headersLabel.textContent = 'Custom Headers (optional):';
        headersLabel.className = 'pv-label';
        dialog.appendChild(headersLabel);

        const headersContainer = document.createElement('div');
        headersContainer.className = 'pv-headers-container';
        dialog.appendChild(headersContainer);

        // Array to track header inputs
        const headerRows = [];

        const addHeaderRow = (key = '', value = '') => {
            const row = document.createElement('div');
            row.className = 'pv-header-row';

            const keyInput = document.createElement('input');
            keyInput.type = 'text';
            keyInput.placeholder = 'Header name';
            keyInput.className = 'pv-header-input';
            keyInput.value = key;

            const valueInput = document.createElement('input');
            valueInput.type = 'text';
            valueInput.placeholder = 'Header value';
            valueInput.className = 'pv-header-input';
            valueInput.value = value;

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.type = 'button';
            removeBtn.className = 'pv-header-remove-btn';
            removeBtn.addEventListener('click', () => {
                headersContainer.removeChild(row);
                const idx = headerRows.indexOf(row);
                if (idx > -1) headerRows.splice(idx, 1);
            });

            row.appendChild(keyInput);
            row.appendChild(valueInput);
            row.appendChild(removeBtn);
            headersContainer.appendChild(row);
            headerRows.push({row, keyInput, valueInput});
            return row;
        };

        // Add initial empty header row
        addHeaderRow();

        // Add header button
        const addHeaderBtn = document.createElement('button');
        addHeaderBtn.textContent = '+ Add Header';
        addHeaderBtn.type = 'button';
        addHeaderBtn.className = 'pv-add-header-btn';
        addHeaderBtn.addEventListener('click', () => addHeaderRow());
        dialog.appendChild(addHeaderBtn);

        // Buttons
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'pv-btn-container';

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.type = 'button';
        cancelBtn.className = 'pv-btn';
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });

        const loadBtn = document.createElement('button');
        loadBtn.textContent = 'Load';
        loadBtn.type = 'button';
        loadBtn.className = 'pv-btn pv-btn-primary';
        loadBtn.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            if (!url) {
                this._toast('Please enter a URL', 'error');
                return;
            }

            // Collect headers
            const headers = {};
            headerRows.forEach(({keyInput, valueInput}) => {
                const k = keyInput.value.trim();
                const v = valueInput.value.trim();
                if (k && v) {
                    headers[k] = v;
                }
            });

            // Show loading state
            loadBtn.disabled = true;
            loadBtn.textContent = 'Loading...';

            try {
                // Fetch the URL
                const json = await this._fetchWithHeaders(url, headers);

                // Validate JSON-LD
                const isValid = await this._isValidJsonLd(json);
                if (!isValid) {
                    this._toast('The fetched document is not valid JSON-LD. Please ensure the URL points to a valid JSON-LD document.', 'error');
                    loadBtn.disabled = false;
                    loadBtn.textContent = 'Load';
                    return;
                }

                // Load into editor
                const jsonStr = JSON.stringify(json, null, 2);
                if (editor) {
                    editor.session.setValue(jsonStr);
                } else if (this._jsonEditorTextarea) {
                    this._jsonEditorTextarea.value = jsonStr;
                    this._onJsonEditorInput(false);
                }

                // Close dialog
                document.body.removeChild(overlay);
            } catch (err) {
                const errorMsg = err && err.message ? err.message : String(err);
                this._toast('Failed to load URL: ' + errorMsg + '\n\nNote: CORS restrictions may prevent loading from some URLs. The server must include appropriate Access-Control-Allow-Origin headers.', 'error');
                loadBtn.disabled = false;
                loadBtn.textContent = 'Load';
            }
        });

        buttonContainer.appendChild(cancelBtn);
        buttonContainer.appendChild(loadBtn);
        dialog.appendChild(buttonContainer);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Focus URL input
        urlInput.focus();

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    _createJsonEditor() {
        if (this._jsonEditor) return;
        if (!this._root) return; // Safety check

        const container = document.createElement('div');
        container.className = 'pv-json-editor';

        // Create editor toolbar (fallback, always visible)
        const toolbar = document.createElement('div');
        toolbar.className = 'pv-editor-toolbar';

        const makeToolbarBtn = (text, title) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = text;
            btn.title = title;
            btn.className = 'pv-editor-toolbar-btn';
            return btn;
        };

        const downloadBtn = makeToolbarBtn('📥 Download', 'Download JSON');
        downloadBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.downloadJSON();
        });
        toolbar.appendChild(downloadBtn);

        const layoutToggleBtn = makeToolbarBtn('⇄', 'Toggle horizontal/vertical layout');
        layoutToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleLayout();
        });
        toolbar.appendChild(layoutToggleBtn);

        const closeBtn = makeToolbarBtn('✖ Close', 'Close editor');
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.removeAttribute('data-json-editor');
        });
        toolbar.appendChild(closeBtn);

        container.appendChild(toolbar);
        this._editorToolbar = toolbar;

        const textarea = document.createElement('textarea');
        textarea.className = 'pv-json-textarea pv-editor-textarea';
        textarea.spellcheck = false;
        container.appendChild(textarea);

        // Add container to the root layout
        this._root.appendChild(container);

        // Show the divider
        this._divider.style.display = 'flex';

        this._jsonEditor = container;
        this._jsonEditorTextarea = textarea;
        this._editingJson = false;
        this._jsonEditorTimer = null;

        // Initialize divider position from localStorage or default
        this._initDividerPosition();

        // Setup divider drag handlers
        this._setupDividerDrag();

        this._updateJsonEditor();
        textarea.addEventListener('input', () => this._onJsonEditorInput());
        textarea.addEventListener('blur', () => this._onJsonEditorInput(true));
        this._initAceEditor().catch(() => {/* ignore */
        });

        // Trigger resize to adjust canvas and editor
        this._onResize();
        // Ensure menu is repositioned back to canvas container
        this._repositionMenu();
    }

    // ---------------- layout toggle ----------------
    _setLayout(horizontal) {
        this._layoutHorizontal = horizontal;

        if (this._layoutHorizontal) {
            this._root.classList.add('pv-layout-horizontal');
            // Update attribute to reflect current state
            this.setAttribute('data-layout-horizontal', '');
        } else {
            this._root.classList.remove('pv-layout-horizontal');
            // Remove attribute when switching back to vertical
            this.removeAttribute('data-layout-horizontal');
        }

        // Reset the split on orientation change (same default as first load)
        this._canvasContainer.style.flex = this._defaultCanvasFlex();
        this._saveDividerPosition();

        // Update divider cursor and aria
        this._updateDividerOrientation();

        // Trigger resize
        this._onResize();
        if (this._aceEditor) {
            try {
                this._aceEditor.resize();
            } catch {
                // ignore
            }
        }
    }

    _toggleLayout() {
        this._setLayout(!this._layoutHorizontal);
    }

    _updateDividerOrientation() {
        if (!this._divider) return;

        if (this._layoutHorizontal) {
            this._divider.style.cursor = 'col-resize';
            this._divider.setAttribute('aria-orientation', 'vertical');
        } else {
            this._divider.style.cursor = 'row-resize';
            this._divider.setAttribute('aria-orientation', 'horizontal');
        }
    }

    // ---------------- theme ----------------

    // Mirrors the CSS resolution order exactly: an explicit data-theme on
    // <html> wins, otherwise the OS preference decides. Ace paints itself in
    // JS and cannot read our custom properties, so it has to be told.
    _isDarkTheme() {
        try {
            const attr = document.documentElement.getAttribute('data-theme');
            if (attr === 'dark') return true;
            if (attr === 'light') return false;
            return typeof window.matchMedia === 'function'
                && window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch {
            return false;
        }
    }

    _aceTheme() {
        return this._isDarkTheme() ? 'ace/theme/tomorrow_night' : 'ace/theme/textmate';
    }

    // Follow the OS switching mid-session rather than only at load.
    _watchColorScheme() {
        if (this._colorSchemeWatched) return;
        this._colorSchemeWatched = true;
        try {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const onChange = () => {
                if (this._aceEditor) {
                    try {
                        this._aceEditor.setTheme(this._aceTheme());
                    } catch {
                        // ignore
                    }
                }
            };
            if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
            else if (typeof mq.addListener === 'function') mq.addListener(onChange);
        } catch {
            // ignore
        }
    }

    // ---------------- divider handling ----------------

    // Small-viewport test, matching the @media breakpoint in petri-view.css.
    // Kept in one place so the JS defaults and the CSS never disagree.
    // Height matters as well as width: a phone in landscape is 844x390, which
    // is wider than the width breakpoint but leaves each pane under 200px.
    _isNarrowViewport() {
        try {
            return typeof window !== 'undefined'
                && typeof window.matchMedia === 'function'
                && window.matchMedia('(max-width: 760px), (max-height: 520px)').matches;
        } catch {
            return false;
        }
    }

    // Narrow says "little room"; coarse says "fingers". Behaviour that would be
    // wrong on a mouse — auto-starting the simulation, panning over nodes — needs
    // both, because the narrow query also matches a short embedded component.
    _isTouchDevice() {
        try {
            return typeof window !== 'undefined'
                && typeof window.matchMedia === 'function'
                && window.matchMedia('(pointer: coarse)').matches;
        } catch {
            return false;
        }
    }

    // A 50/50 split leaves the graph roughly 400px tall on a phone, which is
    // not enough to work in. On a narrow screen the JSON pane therefore starts
    // collapsed to its drag handle; the graph is what the page is for. This is
    // only the DEFAULT — a saved divider position still wins, and dragging or
    // tapping the handle opens the pane.
    _defaultCanvasFlex() {
        if (this._isNarrowViewport() && !this._layoutHorizontal) {
            // Take the slack rather than claiming a fixed share. The column now
            // holds the canvas, the divider, the collapsed JSON pane AND the run
            // bar, and a `calc(100% - ...)` basis has to predict all of their
            // heights — get it wrong and the bar is pushed off the bottom.
            // Growing from zero is exact by construction; the narrow CSS pins the
            // JSON pane to `flex: 0 0 auto` so it cannot compete for the slack.
            return '1 1 0';
        }
        return '0 0 50%';
    }

    // Tap (as opposed to drag) on the handle toggles the pane open/closed.
    _toggleEditorPane() {
        if (!this._canvasContainer || !this._jsonEditor) return;
        // Measure the JSON pane itself. Deriving it from the canvas as
        // `root - canvas` used to work, but the run bar and fireable sheet are now
        // siblings in the same column, so that difference is never under the
        // threshold and the pane could no longer be opened.
        const jsonPx = this._jsonEditor.getBoundingClientRect().height;
        const collapsed = jsonPx < 60;
        if (this._isNarrowViewport() && !this._layoutHorizontal) {
            // On a phone the canvas grows into the slack, so the pane is what gets
            // sized — and it is sized by a class, not inline flex, because
            // collapsing it also means zeroing its height, padding and overflow.
            // Clear any inline basis a previous divider drag left behind, so the
            // tap falls back to the class's default share.
            this._jsonEditor.style.flex = '';
            this._root.classList.toggle('pv-json-open', collapsed);
        } else {
            this._canvasContainer.style.flex = collapsed ? '0 0 50%' : this._defaultCanvasFlex();
        }
        this._saveDividerPosition();
        requestAnimationFrame(() => {
            this._onResize();
            if (this._aceEditor) {
                try {
                    this._aceEditor.resize();
                } catch {
                    // ignore
                }
            }
        });
    }

    _initDividerPosition() {
        // Reset height/minHeight that may have been set when editor was closed
        this._canvasContainer.style.height = '';
        this._canvasContainer.style.minHeight = '';

        // Try to load saved position from localStorage.
        // The key is versioned: a value saved before the small-screen default
        // existed would otherwise pin returning visitors to the old desktop
        // split forever, which is exactly the layout the default now avoids.
        // A position is also only restored into the viewport class it was
        // saved from, so a desktop split does not carry onto a phone.
        try {
            const saved = localStorage.getItem(PetriView.DIVIDER_KEY);
            if (saved) {
                const pos = JSON.parse(saved);
                if (pos && typeof pos.canvasFlex === 'string'
                    && !!pos.narrow === this._isNarrowViewport()) {
                    this._canvasContainer.style.flex = pos.canvasFlex;
                    return;
                }
            }
        } catch {
            // ignore
        }

        // Default: 50/50 on desktop, collapsed editor on a narrow screen
        this._canvasContainer.style.flex = this._defaultCanvasFlex();
    }

    _saveDividerPosition() {
        try {
            const pos = {
                canvasFlex: this._canvasContainer.style.flex,
                narrow: this._isNarrowViewport()
            };
            localStorage.setItem(PetriView.DIVIDER_KEY, JSON.stringify(pos));
        } catch {
            // ignore
        }
    }

    _setupDividerDrag() {
        if (!this._divider) return;

        let isDragging = false;
        let dragOrigin = null;

        const onPointerDown = (e) => {
            if (e.button !== 0) return; // left button only
            e.preventDefault();
            isDragging = true;
            dragOrigin = {x: e.clientX, y: e.clientY};
            this._divider.setPointerCapture(e.pointerId);

            // Update cursor based on current layout
            document.body.style.cursor = this._layoutHorizontal ? 'col-resize' : 'row-resize';
        };

        const onPointerMove = (e) => {
            if (!isDragging) return;

            const rootRect = this._root.getBoundingClientRect();

            // On a narrow screen the pane must be able to collapse fully, or
            // the drag cannot reach the state the editor starts in.
            const narrow = this._isNarrowViewport();
            const paneMin = narrow ? 0 : (this._layoutHorizontal ? 200 : 150);

            if (this._layoutHorizontal) {
                // Horizontal layout (side-by-side)
                const dividerPx = this._divider.offsetWidth || 8;
                const offsetX = e.clientX - rootRect.left;
                const minSize = narrow ? 120 : 200;
                const maxSize = rootRect.width - paneMin - dividerPx;
                const clamped = Math.max(minSize, Math.min(maxSize, offsetX));
                this._canvasContainer.style.flex = `0 0 ${clamped}px`;
            } else if (narrow) {
                // Vertical, narrow: the canvas grows into the slack and the JSON
                // pane is what carries an explicit size, so the drag has to size
                // the PANE. Sizing the canvas here (as the desktop branch does)
                // could only ever shrink the canvas — the pane stayed pinned at
                // height 0 by .pv-json-open, so it never opened and the gap it
                // left pushed the run bar off the bottom.
                const dividerPx = this._divider.offsetHeight || 8;
                const barPx = (this._runBar && this._runBar.offsetHeight) || 0;
                const available = rootRect.height - dividerPx - barPx;
                const paneH = Math.max(0, Math.min(available - 120, rootRect.bottom - barPx - e.clientY - dividerPx));
                const open = paneH > 60;
                this._root.classList.toggle('pv-json-open', open);
                this._jsonEditor.style.flex = open ? `0 0 ${Math.round(paneH)}px` : '';
            } else {
                // Vertical layout (stacked)
                const dividerPx = this._divider.offsetHeight || 8;
                const offsetY = e.clientY - rootRect.top;
                const minSize = narrow ? 120 : 150;
                const maxSize = rootRect.height - paneMin - dividerPx;
                const clamped = Math.max(minSize, Math.min(maxSize, offsetY));
                this._canvasContainer.style.flex = `0 0 ${clamped}px`;
            }

            // Trigger resize for canvas and ace editor
            requestAnimationFrame(() => {
                this._onResize();
                if (this._aceEditor) {
                    try {
                        this._aceEditor.resize();
                    } catch {
                        // ignore
                    }
                }
            });
        };

        const onPointerUp = (e) => {
            if (!isDragging) return;
            isDragging = false;

            try {
                this._divider.releasePointerCapture(e.pointerId);
            } catch {
                // ignore
            }

            // Restore cursor
            document.body.style.cursor = '';

            // A press that never moved is a tap, not a resize: toggle the pane
            // so the collapsed default is reachable without a precise drag.
            const moved = dragOrigin
                ? Math.hypot(e.clientX - dragOrigin.x, e.clientY - dragOrigin.y)
                : Infinity;
            dragOrigin = null;
            if (moved < 6) {
                this._toggleEditorPane();
                return;
            }

            // Save position
            this._saveDividerPosition();
        };

        this._divider.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);

        // Set initial divider orientation
        this._updateDividerOrientation();
    }

    // ---------------- lifecycle ----------------
    async connectedCallback() {
        if (this._root) return;
        this._buildRoot();
        this._ldScript = this.querySelector('script[type="application/ld+json"]');
        await this._loadModelFromScriptOrAutosave();
        this._normalizeModel();
        this._renderUI();
        // Frame the model before snapshotting _initialView, so the scale meter's
        // "1x" reset button restores the fit rather than 1.00x-at-origin.
        this._recomputeScaleFloor();
        this.fitToView();
        this._applyViewTransform();
        this._initialView = {...this._view};
        this._pushHistory(true);
        this._createMenu();
        this._createScaleMeter();
        this._createHamburgerMenu();
        this._createTopRightButton();
        
        // Initialize layout orientation from attribute
        if (this.hasAttribute('data-layout-horizontal')) {
            this._layoutHorizontal = true;
            this._root.classList.add('pv-layout-horizontal');
            this._updateDividerOrientation();
        }
        
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

        // Clean up hamburger menu
        if (this._hamburgerMenu) {
            this._hamburgerMenu.remove();
            this._hamburgerMenu = null;
        }
        if (this._hamburgerDropdown) {
            this._hamburgerDropdown.remove();
            this._hamburgerDropdown = null;
        }

        // Clean up top-right button
        if (this._topRightButton) {
            this._topRightButton.remove();
            this._topRightButton = null;
        }
    }

    // ---------------- public API ----------------
    setModel(m) {
        this._model = m || {};
        this._normalizeModel();
        this._renderUI();
        this._refit(); // a different model entirely — frame it
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

    async downloadJSON() {
        try {
            const doc = this._model;

            // Compute CID from the document (without @id to avoid self-reference)
            const {'@id': _, ...docForCid} = doc;
            const cid = await this._computeCidForJsonLd(docForCid);

            // Inject @id with CID
            const docWithId = {...doc, '@id': cid};

            // Create download blob
            const blob = new Blob([JSON.stringify(docWithId, null, 2)], {
                type: 'application/ld+json'
            });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${cid}.jsonld`;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (err) {
            this._toast('Download failed: ' + (err && err.message ? err.message : String(err)), 'error');
        }
    }

    async _saveToPermalink() {
        const isBackendMode = this.hasAttribute('data-backend');

        // In backend mode with authenticated user, save to server
        if (isBackendMode && this._authInitialized && this._user) {
            try {
                // Get the auth token
                const authToken = this._authToken;

                if (!authToken) {
                    this._toast('Please log in to save data', 'error');
                    return;
                }

                // Use canonical JSON encoding
                const canonicalData = JSON.stringify(this._model);

                // POST to /api/save
                const response = await fetch('/api/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`,
                    },
                    body: canonicalData
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('Save failed with status', response.status, errorText);
                    this._toast(`Save failed: ${response.statusText}`, 'error');
                    return;
                }

                const result = await response.json();
                const cid = result.cid;

                console.log('Save successful! CID:', cid);

                // Update URL with CID instead of data parameter
                const url = new URL(window.location.origin + window.location.pathname);
                url.searchParams.set('cid', cid);
                window.history.pushState({}, '', url.toString());

                this._toast('Saved successfully! CID: ' + cid);
            } catch (err) {
                console.error('Failed to save to server:', err);
                this._toast('Failed to save to server: ' + (err && err.message ? err.message : String(err)), 'error');
            }
            return;
        }

        // Default behavior: Save to permalink (update URL with data parameter)
        try {
            this._updatePermalinkURL();

            // Show feedback to user
            const currentUrl = window.location.href;

            // Copy to clipboard if available
            this._copyToClipboard(currentUrl,
                () => this._toast('Permalink saved! URL copied to clipboard.\n\n' + currentUrl),
                () => this._toast('Permalink saved!\n\n' + currentUrl)
            );
        } catch (err) {
            console.error('Failed to save permalink:', err);
            this._toast('Failed to save permalink: ' + (err && err.message ? err.message : String(err)), 'error');
        }
    }

    async _deleteData() {
        // Check if we have a CID in the URL (document loaded from server)
        const urlParams = new URLSearchParams(window.location.search);
        const cid = urlParams.get('cid');
        const isBackendMode = this.hasAttribute('data-backend');

        // If there's a CID, we need to delete from the server
        if (cid && isBackendMode) {
            if (!confirm('Are you sure you want to delete this document from the server? This cannot be undone.')) {
                return;
            }

            try {
                // Check if user is authenticated and get auth token
                if (!this._authInitialized || !this._user) {
                    this._toast('You must be logged in to delete documents from the server.', 'error');
                    return;
                }

                const authToken = this._authToken;

                if (!authToken) {
                    this._toast('Authentication required. Please log in.', 'error');
                    return;
                }

                // Send DELETE request to server
                const response = await fetch(`/o/${cid}`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${authToken}`,
                    },
                });

                if (!response.ok) {
                    if (response.status === 401) {
                        this._toast('Authentication required. Please log in.', 'error');
                    } else if (response.status === 403) {
                        this._toast('You do not have permission to delete this document. Only the author can delete it.', 'error');
                    } else if (response.status === 404) {
                        this._toast('Document not found on server.', 'error');
                    } else {
                        const errorText = await response.text().catch(() => '');
                        const statusMsg = response.statusText || `HTTP ${response.status}`;
                        this._toast(`Failed to delete document: ${statusMsg}${errorText ? '\n' + errorText : ''}`, 'error');
                    }
                    return;
                }

                // Successfully deleted from server
                console.log('Document deleted from server:', cid);
            } catch (err) {
                console.error('Failed to delete from server:', err);
                this._toast('Failed to delete document from server: ' + (err && err.message ? err.message : String(err)), 'error');
                return;
            }
        } else {
            // Local clear only - confirm with different message
            if (!confirm('Are you sure you want to clear all data? This cannot be undone.')) {
                return;
            }
        }

        // Reset to empty model
        this._model = {
            '@context': 'https://pflow.xyz/schema',
            '@type': 'PetriNet',
            '@version': '1.1',
            'token': ['https://pflow.xyz/tokens/black'],
            'places': {},
            'transitions': {},
            'arcs': []
        };

        this._normalizeModel();
        this._renderUI();
        this._syncLD(true);
        this._pushHistory();

        // Clear URL parameters if in backend mode
        if (isBackendMode) {
            const url = new URL(window.location.href);
            url.searchParams.delete('data');
            url.searchParams.delete('cid');
            window.history.replaceState({}, '', url.toString());
        }

        // Dispatch event
        this.dispatchEvent(new CustomEvent('data-deleted'));
    }

    async _showShareDialog() {
        // First, ensure the document is saved
        const urlParams = new URLSearchParams(window.location.search);
        let cid = urlParams.get('cid');
        
        // If no CID in URL, we need to save first
        if (!cid) {
            try {
                // Get the auth token
                const authToken = this._authToken;

                if (!authToken) {
                    this._toast('Please log in to share data', 'error');
                    return;
                }

                // Save the document
                const canonicalData = JSON.stringify(this._model);

                const response = await fetch('/api/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`,
                    },
                    body: canonicalData
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('Save failed with status', response.status, errorText);
                    this._toast(`Failed to save before sharing: ${response.statusText}`, 'error');
                    return;
                }

                const result = await response.json();
                cid = result.cid;

                // Update URL with CID
                const url = new URL(window.location.origin + window.location.pathname);
                url.searchParams.set('cid', cid);
                window.history.pushState({}, '', url.toString());
            } catch (err) {
                console.error('Failed to save before sharing:', err);
                this._toast('Failed to save document: ' + (err && err.message ? err.message : String(err)), 'error');
                return;
            }
        }

        // Generate markdown snippet
        const currentUrl = window.location.origin;
        const svgUrl = `${currentUrl}/img/${cid}.svg`;
        const docUrl = `${currentUrl}/?cid=${cid}`;
        const markdown = `[![pflow](${svgUrl})](${docUrl})`;

        // Create modal overlay
        const { overlay, dialog } = this._createModalOverlay({});

        // Title
        const title = document.createElement('h3');
        title.textContent = 'Share Your Petri Net';
        title.className = 'pv-modal-title';
        dialog.appendChild(title);

        // Description
        const description = document.createElement('p');
        description.textContent = 'Copy the markdown snippet below to share your Petri net:';
        description.className = 'pv-modal-description';
        dialog.appendChild(description);

        // Markdown textarea
        const textarea = document.createElement('textarea');
        textarea.value = markdown;
        textarea.readOnly = true;
        textarea.className = 'pv-share-textarea';
        dialog.appendChild(textarea);

        // Image URL label
        const imageUrlLabel = document.createElement('p');
        imageUrlLabel.textContent = 'Image URL:';
        imageUrlLabel.className = 'pv-label';
        imageUrlLabel.style.margin = '16px 0 8px 0';
        dialog.appendChild(imageUrlLabel);

        // Image URL textarea
        const imageUrlTextarea = document.createElement('textarea');
        imageUrlTextarea.value = svgUrl;
        imageUrlTextarea.readOnly = true;
        imageUrlTextarea.className = 'pv-share-textarea';
        imageUrlTextarea.style.height = '50px';
        dialog.appendChild(imageUrlTextarea);

        // Image URL copy button container
        const imageUrlButtonContainer = document.createElement('div');
        imageUrlButtonContainer.className = 'pv-btn-container';
        imageUrlButtonContainer.style.marginTop = '8px';

        // Image URL copy button
        const copyImageUrlButton = document.createElement('button');
        copyImageUrlButton.textContent = 'Copy Image URL';
        copyImageUrlButton.type = 'button';
        copyImageUrlButton.className = 'pv-btn pv-btn-primary pv-btn-sm';
        copyImageUrlButton.addEventListener('click', () => {
            imageUrlTextarea.select();
            const showCopied = () => {
                copyImageUrlButton.textContent = 'Copied!';
                setTimeout(() => { copyImageUrlButton.textContent = 'Copy Image URL'; }, 2000);
            };
            this._copyToClipboard(svgUrl, showCopied, () => {
                document.execCommand('copy');
                showCopied();
            });
        });
        imageUrlButtonContainer.appendChild(copyImageUrlButton);
        dialog.appendChild(imageUrlButtonContainer);

        // Preview section
        const previewLabel = document.createElement('p');
        previewLabel.textContent = 'Preview:';
        previewLabel.className = 'pv-label';
        previewLabel.style.margin = '16px 0 8px 0';
        dialog.appendChild(previewLabel);

        const previewContainer = document.createElement('div');
        previewContainer.className = 'pv-share-preview-container';

        const previewLink = document.createElement('a');
        previewLink.href = docUrl;
        previewLink.target = '_blank';
        previewLink.rel = 'noopener noreferrer';

        const previewImg = document.createElement('img');
        previewImg.src = svgUrl;
        previewImg.alt = 'Petri Net Preview';
        previewImg.className = 'pv-share-preview-img';

        previewLink.appendChild(previewImg);
        previewContainer.appendChild(previewLink);
        dialog.appendChild(previewContainer);

        // Button container
        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'pv-btn-container';
        buttonContainer.style.marginTop = '20px';

        // Copy button
        const copyButton = document.createElement('button');
        copyButton.textContent = 'Copy to Clipboard';
        copyButton.type = 'button';
        copyButton.className = 'pv-btn pv-btn-primary';
        copyButton.addEventListener('click', () => {
            textarea.select();
            const showCopied = () => {
                copyButton.textContent = 'Copied!';
                setTimeout(() => { copyButton.textContent = 'Copy to Clipboard'; }, 2000);
            };
            this._copyToClipboard(markdown, showCopied, () => {
                document.execCommand('copy');
                showCopied();
            });
        });
        buttonContainer.appendChild(copyButton);

        // Close button
        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        closeButton.type = 'button';
        closeButton.className = 'pv-btn';

        // Helper function to safely close the dialog
        const closeDialog = () => {
            if (overlay.parentNode) {
                document.body.removeChild(overlay);
            }
            document.removeEventListener('keydown', handleEscape);
        };
        
        closeButton.addEventListener('click', closeDialog);
        buttonContainer.appendChild(closeButton);

        dialog.appendChild(buttonContainer);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeDialog();
            }
        });

        // Close on Escape key
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                closeDialog();
            }
        };
        document.addEventListener('keydown', handleEscape);

        document.body.appendChild(overlay);
        
        // Auto-select the textarea for easy copying
        textarea.select();
    }

    async _saveAsGist() {
        // First, ensure the document is saved and we have a CID
        const urlParams = new URLSearchParams(window.location.search);
        let cid = urlParams.get('cid');
        
        // If no CID in URL, we need to save first
        if (!cid) {
            try {
                // Get the auth token
                const authToken = this._authToken;

                if (!authToken) {
                    this._toast('Please log in to save as Gist', 'error');
                    return;
                }

                // Save the document
                const canonicalData = JSON.stringify(this._model);

                const response = await fetch('/api/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`,
                    },
                    body: canonicalData
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('Save failed with status', response.status, errorText);
                    this._toast(`Failed to save before creating Gist: ${response.statusText}`, 'error');
                    return;
                }

                const result = await response.json();
                cid = result.cid;

                // Update URL with CID
                const url = new URL(window.location.origin + window.location.pathname);
                url.searchParams.set('cid', cid);
                window.history.pushState({}, '', url.toString());
            } catch (err) {
                console.error('Failed to save before creating Gist:', err);
                this._toast('Failed to save document: ' + (err && err.message ? err.message : String(err)), 'error');
                return;
            }
        }

        // Generate markdown content
        const currentUrl = window.location.origin;
        const svgUrl = `${currentUrl}/img/${cid}.svg`;
        const docUrl = `${currentUrl}/?cid=${cid}`;
        const markdown = `[![pflow](${svgUrl})](${docUrl})`;

        // Create gist via GitHub API
        const authToken = this._authToken;
        if (!authToken) {
            this._toast('Please log in to create a Gist', 'error');
            return;
        }

        try {
            const gistResponse = await fetch('https://api.github.com/gists', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    description: 'pflow Petri net diagram',
                    public: true,
                    files: {
                        [`${cid}.md`]: {
                            content: markdown
                        }
                    }
                })
            });

            if (!gistResponse.ok) {
                const errorText = await gistResponse.text();
                console.error('Gist creation failed:', gistResponse.status, errorText);
                this._toast(`Failed to create Gist: ${gistResponse.statusText}`, 'error');
                return;
            }

            const gistResult = await gistResponse.json();
            const gistUrl = gistResult.html_url;

            // Open the gist in a new tab
            window.open(gistUrl, '_blank');
        } catch (err) {
            console.error('Failed to create Gist:', err);
            this._toast('Failed to create Gist: ' + (err && err.message ? err.message : String(err)), 'error');
        }
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

    _copyToClipboard(text, onSuccess, onFallback) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(onSuccess).catch(onFallback || onSuccess);
        } else if (onFallback) {
            onFallback();
        } else {
            onSuccess();
        }
    }

    _getNodeOffset(kind) {
        return kind === 'place' ? 40 : 15;
    }

    _createModalOverlay(options = {}) {
        const { className, dialogClass } = options;
        const overlay = document.createElement('div');
        overlay.className = className ? `${className}-overlay pv-modal-overlay` : 'pv-modal-overlay';

        const dialog = document.createElement('div');
        dialog.className = dialogClass
            ? `${className || ''} pv-modal-dialog ${dialogClass}`.trim()
            : `${className || ''} pv-modal-dialog`.trim();
        overlay.appendChild(dialog);

        return { overlay, dialog };
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

    _isCapacityPath(pathArr) {
        // crude but effective: ...places.<id>.capacity[...]
        const i = pathArr.indexOf('places');
        return i >= 0 && pathArr[i + 2] === 'capacity';
    }

    _stableStringify(obj, space = 2) {
        const seen = new WeakSet();
        const path = [];

        // Priority order for top-level keys (JSON-LD keywords first, then metadata, then content)
        const keyPriority = [
            '@context', '@type', '@id', '@version',
            'name', 'description', 'author',
            'token', 'places', 'transitions', 'arcs'
        ];

        const sortKeys = (keys, isTopLevel) => {
            if (!isTopLevel) {
                return keys.sort();
            }
            // Sort by priority order, then alphabetically for unlisted keys
            return keys.sort((a, b) => {
                const aIdx = keyPriority.indexOf(a);
                const bIdx = keyPriority.indexOf(b);
                if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
                if (aIdx !== -1) return -1;
                if (bIdx !== -1) return 1;
                return a.localeCompare(b);
            });
        };

        const sortObj = (o, isTopLevel = false) => {
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
            for (const k of sortKeys(Object.keys(o), isTopLevel)) {
                path.push(k);
                let v = sortObj(o[k]);
                // If Infinity sits directly in a capacity prop
                if (v === Infinity && this._isCapacityPath(path)) v = null;
                out[k] = v;
                path.pop();
            }
            return out;
        };

        return JSON.stringify(sortObj(obj, true), null, space);
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

            // capacity: null/undefined/0 => Infinity (unbounded).
            // capacity=0 means unbounded per standard Petri net convention.
            if (!Array.isArray(p.capacity)) p.capacity = [p.capacity];
            p.capacity = p.capacity.map(v => {
                if (v === null || v === undefined) return Infinity;
                const n = Number(v);
                if (!Number.isFinite(n) || n === 0) return Infinity;
                return n;
            });

            // Validate: initial tokens should not exceed capacity for each color
            // Clamp initial tokens to capacity to fix invalid states
            const maxLen = Math.max(p.initial.length, p.capacity.length);
            while (p.initial.length < maxLen) p.initial.push(0);
            while (p.capacity.length < maxLen) p.capacity.push(Infinity);
            
            for (let i = 0; i < maxLen; i++) {
                const cap = p.capacity[i];
                if (Number.isFinite(cap) && p.initial[i] > cap) {
                    console.warn(`Place ${id}: initial[${i}]=${p.initial[i]} exceeds capacity[${i}]=${cap}. Clamping to capacity.`);
                    p.initial[i] = cap;
                }
            }
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
            // Vector components preserve explicit 0 ("this color is not
            // involved") — the engine contract petri-sim.js:getArcWeight and
            // the parity suite rely on; only a scalar weight of 0 defaults to 1
            // (handled above).
            a.weight = a.weight.map(w => {
                const n = Number(w);
                return Number.isFinite(n) && n >= 0 ? n : 1;
            });
            a.inhibitTransition = !!a.inhibitTransition;
        }
    }

    async _loadModelFromScriptOrAutosave() {
        // Check for permalink data first (highest priority)
        const urlParams = new URLSearchParams(window.location.search);
        const encodedData = urlParams.get('data');
        if (encodedData && this.hasAttribute('data-backend')) {
            const permalinkData = this._decodePermalinkData(encodedData);
            if (permalinkData) {
                this._model = permalinkData.data || {};
                return;
            }
        }

        // Check for CID parameter in backend mode
        const cid = urlParams.get('cid');
        if (cid && this.hasAttribute('data-backend')) {
            try {
                const response = await fetch(`/o/${cid}`);
                if (response.ok) {
                    const data = await response.json();
                    this._model = data || {};
                    // Store the original CID for revert functionality
                    this._originalCid = cid;
                    return;
                } else {
                    console.error(`Failed to load data from CID: ${response.status} ${response.statusText}`);
                }
            } catch (err) {
                console.error('Failed to load data from CID:', err);
            }
        }

        // Next, check script tag
        if (this._ldScript && this._ldScript.textContent) {
            const parsed = this._safeParse(this._ldScript.textContent);
            this._model = parsed || {};
            return;
        }

        // Finally, check localStorage
        try {
            const saved = localStorage.getItem(this._getStorageKey());
            if (saved) this._model = JSON.parse(saved);
        } catch {
        }
    }

    _decodePermalinkData(encodedData) {
        // Decode URL-encoded JSON data (handles multiple levels of encoding)
        if (!encodedData) return null;

        // Check size limit (max 1MB of encoded data)
        if (encodedData.length > 1024 * 1024) {
            console.error('Permalink data exceeds size limit');
            return null;
        }

        try {
            let decodedData = encodedData;
            let iterations = 0;
            const maxIterations = 10; // Prevent infinite loop

            // Keep decoding until we can't decode anymore or get valid JSON
            while (iterations < maxIterations) {
                try {
                    const nextDecoded = decodeURIComponent(decodedData);
                    // If decoding doesn't change the string, we're done
                    if (nextDecoded === decodedData) {
                        break;
                    }
                    decodedData = nextDecoded;
                    iterations++;

                    // Try to parse as JSON - if successful, we're done
                    JSON.parse(decodedData);
                    break;
                } catch (jsonErr) {
                    // Not valid JSON yet, continue decoding if possible
                }
            }

            const data = JSON.parse(decodedData);
            return {
                jsonString: JSON.stringify(data, null, 2),
                data: data
            };
        } catch (err) {
            console.error('Failed to parse permalink data:', err);
            return null;
        }
    }

    _updatePermalinkURL() {
        // Update the URL with current model data (only in backend mode)
        if (!this.hasAttribute('data-backend')) return;

        try {
            const jsonString = JSON.stringify(this._model);
            const encodedData = encodeURIComponent(jsonString);
            const url = new URL(window.location.href);
            url.searchParams.set('data', encodedData);

            // Update URL without reloading the page
            window.history.replaceState({}, '', url.toString());
        } catch (err) {
            console.error('Failed to update permalink URL:', err);
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
            // Update permalink URL in backend mode
            this._updatePermalinkURL();
            return;
        }

        // Update script tag to sync with current model
        const pretty = !this.hasAttribute('data-compact');
        const text = pretty ? this._stableStringify(this._model, 2) : JSON.stringify(this._model);
        if (force || this._ldScript.textContent !== text) {
            this._ldScript.textContent = text;
            this.dispatchEvent(new CustomEvent('jsonld-updated', {detail: {json: this.exportJSON()}}));
        }

        this._updateJsonEditor();
        // Update permalink URL in backend mode
        this._updatePermalinkURL();
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
    _getArcWeight(arc) {
        return Sim.getArcWeight(arc);
    }

    _marking() {
        return Sim.marking(this._model);
    }

    _setMarking(marks) {
        for (const [pid, tokenVector] of Object.entries(marks)) {
            const p = this._model.places[pid];
            if (!p) continue;
            // Update all elements of the initial array (all token colors)
            p.initial = Array.isArray(tokenVector)
                ? tokenVector.map(v => Math.max(0, Number(v) || 0))
                : [Math.max(0, Number(tokenVector) || 0)];
        }
        this._syncLD();
        this._pushHistory();
    }

    _capacityOf(pid) {
        return Sim.capacityOf(this._model, pid);
    }

    _inArcsOf(tid) {
        return Sim.inArcsOf(this._model, tid);
    }

    _outArcsOf(tid) {
        return Sim.outArcsOf(this._model, tid);
    }

    _enabled(tid, marks) {
        return Sim.enabled(this._model, tid, marks || this._marking());
    }

    _fire(tid) {
        const marks = this._marking();
        const newMarks = Sim.fire(this._model, tid, marks);
        if (!newMarks) {
            this.dispatchEvent(new CustomEvent('transition-fired-blocked', {detail: {id: tid}}));
            return false;
        }
        this._setMarking(newMarks);
        this._stepCount = (this._stepCount || 0) + 1;
        this._renderTokens();
        this._updateTransitionStates();
        this._draw();
        this._refreshRunUI?.();
        this.dispatchEvent(new CustomEvent('marking-changed', {detail: {marks: newMarks}}));
        this.dispatchEvent(new CustomEvent('transition-fired-success', {detail: {id: tid}}));
        return true;
    }

    // The marking ↺ restores to. Captured once per model, not once per run: a
    // baseline that moves every time the simulation is resumed is not a baseline.
    // `force` is for the paths that genuinely replace the model.
    _captureRunBaseline(force = false) {
        if (!force && this._sessionStartMarking) return;
        this._sessionStartMarking = JSON.parse(JSON.stringify(this._marking()));
        this._stepCount = 0;
    }

    // Restore the marking captured when the run started. Firing writes straight
    // into p.initial, so without this the model you handed someone is consumed by
    // the first few taps and the only way back is Ctrl+Z — which no phone has.
    _resetMarking() {
        if (!this._sessionStartMarking) return;
        this._setMarking(JSON.parse(JSON.stringify(this._sessionStartMarking)));
        this._stepCount = 0;
        this._renderTokens();
        this._updateTransitionStates();
        this._draw();
        this._refreshRunUI?.();
        this.dispatchEvent(new CustomEvent('marking-changed', {detail: {marks: this._marking()}}));
    }

    // ---------------- UI building ----------------
    _buildRoot() {
        this._root = document.createElement('div');
        this._root.className = 'pv-root';
        this.appendChild(this._root);

        // Canvas container (left/top pane)
        this._canvasContainer = document.createElement('div');
        this._canvasContainer.className = 'pv-canvas-container';
        this._root.appendChild(this._canvasContainer);

        this._stage = document.createElement('div');
        this._stage.className = 'pv-stage';
        this._canvasContainer.appendChild(this._stage);

        this._canvas = document.createElement('canvas');
        this._canvas.className = 'pv-canvas';
        this._stage.appendChild(this._canvas);
        this._ctx = this._canvas.getContext('2d');

        // Divider (will be shown when editor is active)
        this._divider = document.createElement('div');
        this._divider.className = 'pv-layout-divider';
        this._divider.style.display = 'none';
        this._divider.setAttribute('role', 'separator');
        this._divider.setAttribute('aria-orientation', 'vertical');
        this._divider.setAttribute('tabindex', '0');
        this._root.appendChild(this._divider);

        // JSON editor container (right/bottom pane, created later if needed)
        this._jsonEditorContainer = null;
    }

    // Schedule sync+render for next animation frame to batch rapid updates
    _scheduleUpdate() {
        if (this._updateScheduled) return;
        this._updateScheduled = true;
        requestAnimationFrame(() => {
            this._updateScheduled = false;
            this._syncLD();
            this._renderUI();
        });
    }

    // Aliases for compatibility
    _scheduleSync() { this._scheduleUpdate(); }
    _scheduleRender() { this._scheduleUpdate(); }

    _renderUI() {
        const places = this._model.places || {};
        const transitions = this._model.transitions || {};
        const arcs = this._model.arcs || [];

        // Track which node IDs are in the current model
        const currentNodeIds = new Set([...Object.keys(places), ...Object.keys(transitions)]);

        // Remove nodes that no longer exist in model
        for (const id of Object.keys(this._nodes)) {
            if (!currentNodeIds.has(id)) {
                this._nodes[id].remove();
                delete this._nodes[id];
            }
        }

        // Create or update places
        for (const [id, p] of Object.entries(places)) {
            if (this._nodes[id]) {
                this._updatePlaceElement(id, p);
            } else {
                this._createPlaceElement(id, p);
            }
        }

        // Create or update transitions
        for (const [id, t] of Object.entries(transitions)) {
            if (this._nodes[id]) {
                this._updateTransitionElement(id, t);
            } else {
                this._createTransitionElement(id, t);
            }
        }

        // For badges, use source->target as stable key
        const arcKeyToIdx = new Map();
        arcs.forEach((arc, idx) => {
            arcKeyToIdx.set(`${arc.source}->${arc.target}`, idx);
        });

        // Build map of existing badges by their arc key
        const existingBadges = new Map();
        for (const b of this._weights) {
            const key = b.dataset.arcKey;
            if (key) existingBadges.set(key, b);
        }

        // Remove badges for arcs that no longer exist
        for (const [key, badge] of existingBadges) {
            if (!arcKeyToIdx.has(key)) {
                badge.remove();
                existingBadges.delete(key);
            }
        }

        // Create or update badges
        this._weights = [];
        arcs.forEach((arc, idx) => {
            const key = `${arc.source}->${arc.target}`;
            const existing = existingBadges.get(key);
            if (existing) {
                this._updateWeightBadge(existing, arc, idx);
                this._weights.push(existing);
            } else {
                this._createWeightBadge(arc, idx, key);
            }
        });

        // Hide all weight badges when every arc has weight 1 (and setting is on)
        const hideWeights = this._shouldHideWeights();
        for (const b of this._weights) {
            b.style.display = hideWeights ? 'none' : '';
        }

        this._renderTokens();
        this._updateTransitionStates();
        this._onResize();
        this._updateArcDraftHighlight();
        this._updateMenuActive();
        this._updateSelectionHighlights();
        this._draw(); // ensure arc draft and other canvas elements are rendered

        // Only the FIRST render frames the diagram. _renderUI() is the generic
        // re-render reached from _scheduleUpdate(), so it also runs after every
        // node drag, arc creation and token edit — reframing there would rescale
        // the canvas out from under someone who is editing. Model-replacing paths
        // (revert-to-CID, importJSON, setModel) call _refit() explicitly instead.
        if (!this._didInitialFit) {
            this._recomputeScaleFloor();
            this.fitToView();
        }
        this._refreshRunUI?.();
    }

    _updatePlaceElement(id, p) {
        const el = this._nodes[id];
        if (!el) return;
        // Update position
        el.style.left = `${(p.x || 0) - 40}px`;
        el.style.top = `${(p.y || 0) - 40}px`;
        // Update label
        const label = el.querySelector('.pv-label');
        if (label) {
            const newLabel = p.label || id;
            if (label.textContent !== newLabel) {
                label.textContent = newLabel;
            }
        }
    }

    _updateTransitionElement(id, t) {
        const el = this._nodes[id];
        if (!el) return;
        // Update position
        el.style.left = `${(t.x || 0) - 15}px`;
        el.style.top = `${(t.y || 0) - 15}px`;
        // Update label
        const label = el.querySelector('.pv-label');
        if (label) {
            const newLabel = t.label || id;
            if (label.textContent !== newLabel) {
                label.textContent = newLabel;
            }
        }
    }

    _updateWeightBadge(badge, arc, idx) {
        // Update arc index
        badge.dataset.arc = String(idx);
        // Update weight display
        const w = this._getBadgeWeight(arc);
        const newText = w > 1 ? `${w}` : '1';
        if (badge.textContent !== newText) {
            badge.textContent = newText;
        }
        // Update inhibitor state
        const isInhibitor = !!arc.inhibitTransition;
        const wasInhibitor = badge.classList.contains('pv-weight-inhibit');
        if (isInhibitor !== wasInhibitor) {
            badge.classList.toggle('pv-weight-inhibit', isInhibitor);
            if (isInhibitor) {
                badge.title = 'inhibitor';
                badge.dataset.inhibit = '1';
            } else {
                badge.title = '';
                delete badge.dataset.inhibit;
            }
        }
    }

    _getBadgeWeight(arc) {
        if (arc.weight == null) return 1;
        if (Array.isArray(arc.weight)) {
            for (const weight of arc.weight) {
                const val = Number(weight) || 0;
                if (val > 0) return val;
            }
            return 1;
        }
        return Number(arc.weight) || 1;
    }

    /** True when every arc weight is 0 or 1, so badges add no information. */
    _allWeightsUniform() {
        for (const arc of (this._model.arcs || [])) {
            const w = this._getBadgeWeight(arc);
            if (w > 1) return false;
        }
        return true;
    }

    /** Whether weight badges should be hidden for the current model. */
    _shouldHideWeights() {
        return this._displaySettings.hideUniformWeights && this._allWeightsUniform();
    }

    // ---------------- Display settings persistence ----------------

    _loadDisplaySettings() {
        try {
            const raw = localStorage.getItem('pv-display-settings');
            if (raw) {
                const saved = JSON.parse(raw);
                Object.assign(this._displaySettings, saved);
            }
        } catch { /* ignore bad data */ }
    }

    _saveDisplaySettings() {
        try {
            localStorage.setItem('pv-display-settings', JSON.stringify(this._displaySettings));
        } catch { /* quota exceeded, etc. */ }
    }

    // ---------------- Display Settings dialog ----------------

    _showDisplaySettingsDialog() {
        const { overlay, dialog } = this._createModalOverlay({
            className: 'pv-display-settings',
            dialogClass: ''
        });

        const title = document.createElement('h2');
        title.style.cssText = 'margin:0 0 16px;font-size:22px;font-weight:bold;color:#333';
        title.textContent = 'Display Settings';
        dialog.appendChild(title);

        const desc = document.createElement('p');
        desc.style.cssText = 'margin:0 0 16px;font-size:14px;color:#666';
        desc.textContent = 'Configure how the Petri net is displayed:';
        dialog.appendChild(desc);

        // --- Toggle helper ---
        const makeToggle = (label, description, key) => {
            const row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 0;cursor:pointer;border-bottom:1px solid #eee';

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.checked = !!this._displaySettings[key];
            toggle.style.cssText = 'width:18px;height:18px;cursor:pointer;flex-shrink:0';

            const textWrap = document.createElement('div');
            const labelEl = document.createElement('div');
            labelEl.style.cssText = 'font-size:14px;font-weight:500;color:#333';
            labelEl.textContent = label;
            textWrap.appendChild(labelEl);

            if (description) {
                const descEl = document.createElement('div');
                descEl.style.cssText = 'font-size:12px;color:#888;margin-top:2px';
                descEl.textContent = description;
                textWrap.appendChild(descEl);
            }

            row.appendChild(toggle);
            row.appendChild(textWrap);

            toggle.addEventListener('change', () => {
                this._displaySettings[key] = toggle.checked;
                this._saveDisplaySettings();
                this._scheduleRender();
            });

            return row;
        };

        dialog.appendChild(makeToggle(
            'Hide uniform weights',
            'Hide arc weight badges when every arc has weight 1',
            'hideUniformWeights'
        ));

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = 'Close';
        closeBtn.style.cssText = 'margin-top:20px;padding:8px 24px;border:1px solid #ddd;border-radius:6px;background:#f5f5f5;cursor:pointer;font-size:14px';
        closeBtn.addEventListener('click', () => overlay.remove());
        dialog.appendChild(closeBtn);

        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
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
        label.textContent = p.label || id;

        el.appendChild(handle);
        el.appendChild(inner);
        el.appendChild(label);

        // Add double-click event handler to label
        label.addEventListener('dblclick', (ev) => {
            ev.stopPropagation();
            // Toggle into label-edit mode if not already
            if (!this._labelEditMode) {
                this._setMode('label-edit');
            }
            // Open label editor
            this._openLabelEditor(id, p.label || id);
        });

        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            // Skip click if long-press was triggered (for touch devices)
            if (this._longPressTriggered) {
                this._longPressTriggered = false;
                return;
            }
            this._onPlaceClick(id, ev);
        });
        el.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._onPlaceContext(id, ev);
        });
        // Long-press support for touch/pen devices (triggers context menu action)
        el.addEventListener('pointerdown', (ev) => {
            if ((ev.pointerType === 'touch' || ev.pointerType === 'pen') && this._modeCan('canLongPressInhibitor')) {
                this._startLongPress(() => {
                    if (navigator.vibrate) navigator.vibrate(50);
                    this._onPlaceContext(id, null);
                }, ev.clientX, ev.clientY);
            }
        });
        el.addEventListener('pointerup', () => {
            this._cancelLongPress();
        });
        el.addEventListener('pointercancel', () => {
            this._cancelLongPress();
        });
        el.addEventListener('pointermove', (ev) => {
            if (ev.pointerType === 'touch' || ev.pointerType === 'pen') {
                this._cancelLongPressIfMoved(ev.clientX, ev.clientY);
            }
        });
        // Add hover event handlers to show token breakdown
        el.addEventListener('mouseenter', () => {
            this._showTokenBreakdown(id, el);
        });
        el.addEventListener('mouseleave', () => {
            this._hideTokenBreakdown(id);
        });
        // Handle drag initiation
        handle.addEventListener('pointerdown', (ev) => {
            // Skip drag when shift is held (for multi-select)
            if (ev.shiftKey && this._canMultiSelect()) {
                return;
            }
            if (this._selectedNodes.size > 0 && this._selectedNodes.has(id) && this._modeCan('canGroupDrag')) {
                this._beginGroupDrag(ev, id);
            } else if (this._canDragNode()) {
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
        label.textContent = t.label || id;
        el.appendChild(label);

        // Add double-click event handler to label
        label.addEventListener('dblclick', (ev) => {
            ev.stopPropagation();
            // Toggle into label-edit mode if not already
            if (!this._labelEditMode) {
                this._setMode('label-edit');
            }
            // Open label editor
            this._openLabelEditor(id, t.label || id);
        });

        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            // Skip click if long-press was triggered (for touch devices)
            if (this._longPressTriggered) {
                this._longPressTriggered = false;
                return;
            }
            this._onTransitionClick(id, ev);
        });
        el.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._onTransitionContext(id, ev);
        });
        // Long-press support for touch/pen devices (triggers context menu action)
        el.addEventListener('pointerdown', (ev) => {
            if ((ev.pointerType === 'touch' || ev.pointerType === 'pen') && this._modeCan('canLongPressInhibitor')) {
                this._startLongPress(() => {
                    if (navigator.vibrate) navigator.vibrate(50);
                    this._onTransitionContext(id, null);
                }, ev.clientX, ev.clientY);
            }
            // Skip drag when shift is held (for multi-select)
            if (ev.shiftKey && this._canMultiSelect()) {
                return;
            }
            if (this._selectedNodes.size > 0 && this._selectedNodes.has(id) && this._modeCan('canGroupDrag')) {
                this._beginGroupDrag(ev, id);
            } else if (this._canDragNode()) {
                this._beginDrag(ev, id, 'transition');
            }
        });
        el.addEventListener('pointerup', () => {
            this._cancelLongPress();
        });
        el.addEventListener('pointercancel', () => {
            this._cancelLongPress();
        });
        el.addEventListener('pointermove', (ev) => {
            if (ev.pointerType === 'touch' || ev.pointerType === 'pen') {
                this._cancelLongPressIfMoved(ev.clientX, ev.clientY);
            }
        });

        this._stage.appendChild(el);
        this._nodes[id] = el;
    }

    _createWeightBadge(arc, idx, arcKey) {
        const w = this._getBadgeWeight(arc);
        const badge = document.createElement('div');
        badge.className = 'pv-weight';
        badge.style.pointerEvents = 'auto';
        badge.dataset.arc = String(idx);
        badge.dataset.arcKey = arcKey || `${arc.source}->${arc.target}`;
        badge.textContent = w > 1 ? `${w}` : '1';
        this._applyStyles(badge, {position: 'absolute'});

        // mark inhibitor badges so CSS can target them
        if (arc.inhibitTransition) {
            badge.classList.add('pv-weight-inhibit');
            badge.title = 'inhibitor';
            badge.dataset.inhibit = '1';
        }

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

    // ---------------- Long-press support for touch/pen devices ----------------
    _startLongPress(callback, x, y) {
        this._cancelLongPress();
        this._longPressTriggered = false;
        this._longPressStartX = x;
        this._longPressStartY = y;
        this._longPressTimer = setTimeout(() => {
            this._longPressTriggered = true;
            callback();
        }, this._longPressThreshold);
    }

    _cancelLongPress() {
        if (this._longPressTimer) {
            clearTimeout(this._longPressTimer);
            this._longPressTimer = null;
        }
    }

    _cancelLongPressIfMoved(x, y) {
        if (!this._longPressTimer) return;
        const dx = x - this._longPressStartX;
        const dy = y - this._longPressStartY;
        if (dx * dx + dy * dy > this._longPressMoveThreshold * this._longPressMoveThreshold) {
            this._cancelLongPress();
        }
    }

    // ---------------- UI event handlers ----------------
    _onPlaceClick(id, ev) {
        const p = this._model.places[id];
        if (!p) return;

        // Handle label-edit mode first
        if (this._labelEditMode) {
            this._openLabelEditor(id, p.label || id);
            return;
        }

        // Handle shift+click for group selection
        if (ev.shiftKey && this._canMultiSelect()) {
            this._toggleNodeSelection(id);
            return;
        }

        // Clear selection on regular click (unless clicking a selected node)
        if (!ev.shiftKey && this._canMultiSelect()) {
            if (!this._selectedNodes.has(id)) {
                this._clearSelection();
            }
        }

        // Mode-specific actions
        // Skip token modification if drag occurred (user was repositioning, not clicking)
        if (this._modeCan('canModifyTokens')) {
            if (this._dragOccurred) {
                this._dragOccurred = false;
                return;
            }
            const arr = Array.isArray(p.initial) ? p.initial : [Number(p.initial || 0)];
            arr[0] = (Number(arr[0]) || 0) + 1;
            p.initial = arr;
            this._pushHistory();
            this._scheduleSync();
            this._renderTokens();
            this._updateTransitionStates();
            this._draw();
            return;
        }
        if (this._modeCan('canCreateArc')) {
            if (this._dragOccurred) {
                this._dragOccurred = false;
                return;
            }
            this._arcNodeClicked(id);
            return;
        }
        if (this._modeCan('canDeleteOnClick')) {
            this._deleteNode(id);
            return;
        }
    }

    _onPlaceContext(id, ev) {
        const p = this._model.places[id];
        if (!p) return;

        if (this._modeCan('canModifyTokens')) {
            const arr = Array.isArray(p.initial) ? p.initial : [Number(p.initial || 0)];
            arr[0] = Math.max(0, (Number(arr[0]) || 0) - 1);
            p.initial = arr;
            this._pushHistory();
            this._scheduleSync();
            this._renderTokens();
            this._updateTransitionStates();
            this._draw();
            return;
        }
        if (this._modeCan('canCreateArc')) {
            this._arcNodeClicked(id, {inhibit: true});
            return;
        }
        if (this._modeCan('canDeleteOnClick')) {
            this._deleteNode(id);
            return;
        }
    }

// NEW: drain the queue in strict order, exactly once at a time
    async _drainFireQueue() {
        // if already draining, just bail; the running drain will pick up new items
        if (this._processingFires) return;
        this._processingFires = true;

        try {
            while (this._fireQueue.length > 0) {
                const tid = this._fireQueue.shift();
                const el = this._nodes[tid];
                if (el) {
                    // restartable flash: long enough to be seen, removal is
                    // async so it doesn't stall the queue
                    el.classList.remove('pv-firing');
                    void el.offsetWidth; // restart the CSS animation
                    el.classList.add('pv-firing');
                    clearTimeout(el._pvFiringTimer);
                    el._pvFiringTimer = setTimeout(() => el.classList.remove('pv-firing'), 240);
                }

                // IMPORTANT: take the marking *at fire time*, not cached
                // _fire() already:
                //   - checks _enabled() using fresh marking
                //   - updates marks
                //   - redraws tokens/arcs
                //   - dispatches events
                this._fire(tid);

                // allow the browser a microtask to flush layout/paint
                // before we possibly mutate again
                await Promise.resolve();
            }
        } finally {
            this._processingFires = false;
        }
    }

    _enqueueFire(tid) {
        if (!tid) return;
        // push the request
        this._fireQueue.push(tid);
        // kick off the drain (if not already running)
        this._drainFireQueue();
    }

    _onTransitionClick(id, ev) {

        if (this._simRunning) {
            const now = performance.now();
            const last = this._lastFireAt[id] || 0;
            if (now - last < this._fireDebounceMs) return; // ignore spammy double-click
            this._lastFireAt[id] = now;

            this._enqueueFire(id);
            return;
        }

        // Handle label-edit mode
        if (this._labelEditMode) {
            const t = this._model.transitions[id];
            if (t) {
                this._openLabelEditor(id, t.label || id);
            }
            return;
        }

        // Handle shift+click for group selection
        if (ev.shiftKey && this._canMultiSelect()) {
            this._toggleNodeSelection(id);
            return;
        }

        // Clear selection on regular click (unless clicking a selected node)
        if (!ev.shiftKey && this._canMultiSelect()) {
            if (!this._selectedNodes.has(id)) {
                this._clearSelection();
            }
        }

        // Mode-specific actions
        if (this._modeCan('canCreateArc')) {
            if (this._dragOccurred) {
                this._dragOccurred = false;
                return;
            }
            this._arcNodeClicked(id);
            return;
        }
        if (this._modeCan('canDeleteOnClick')) {
            this._deleteNode(id);
            return;
        }
    }

    _onTransitionContext(id, ev) {
        if (this._modeCan('canCreateArc')) {
            this._arcNodeClicked(id, {inhibit: true});
            return;
        }
        if (this._modeCan('canDeleteOnClick')) {
            this._deleteNode(id);
            return;
        }
    }

    _onBadgeClick(badge) {
        const i = Number(badge.dataset.arc);
        const a = this._model.arcs && this._model.arcs[i];
        if (!a) return;
        if (this._simRunning) return;

        if (this._modeCan('canDeleteOnClick')) {
            this._model.arcs = (this._model.arcs || []).filter((_, j) => j !== i);
            this._normalizeModel();
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
            return;
        }

        // Toggle inhibitor flag when in arc mode
        if (this._modeCan('canCreateArc')) {
            a.inhibitTransition = !a.inhibitTransition;
            this._normalizeModel();
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
            return;
        }

        // Allow editing arc weights
        if (this._modeCan('canEditWeight')) {
            try {
                const cur = this._getArcWeight(a);
                const curStr = cur.join(',');
                const ans = prompt('Arc weight (comma-separated for colored nets, e.g., "1,0,0")', curStr);
                if (ans && ans.trim()) {
                    const values = ans.split(',').map(v => {
                        const num = Number(v.trim());
                        return Number.isNaN(num) ? 0 : Math.max(0, Math.floor(num));
                    });
                    if (values.some(v => v > 0)) {
                        a.weight = values;
                        this._normalizeModel();
                        this._pushHistory();
                        this._scheduleSync();
                        this._scheduleRender();
                    }
                }
            } catch {
            }
        }
    }

    _onBadgeContext(badge) {
        const i = Number(badge.dataset.arc);
        const a = this._model.arcs && this._model.arcs[i];
        if (!a) return;

        if (this._modeCan('canModifyTokens')) {
            const cur = this._getArcWeight(a);
            const newWeight = cur.map(w => {
                const val = Number(w) || 0;
                return val > 0 ? Math.max(0, val - 1) : 0;
            });
            if (newWeight.every(w => w === 0)) {
                newWeight[0] = 1;
            }
            a.weight = newWeight;
            this._normalizeModel();
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
            return;
        }
        if (this._modeCan('canDeleteOnClick')) {
            this._model.arcs = (this._model.arcs || []).filter((_, j) => j !== i);
            this._normalizeModel();
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
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
        this._pushHistory();
        this._scheduleSync();
        this._scheduleRender();
        this.dispatchEvent(new CustomEvent('node-deleted', {detail: {id}}));
    }

    _deleteNodes(ids) {
        if (!this._model || !ids || ids.length === 0) return;
        let changed = false;

        // Delete all nodes from the model
        for (const id of ids) {
            if (this._model.places && this._model.places[id]) {
                delete this._model.places[id];
                changed = true;
            }
            if (this._model.transitions && this._model.transitions[id]) {
                delete this._model.transitions[id];
                changed = true;
            }
        }

        if (!changed) return;

        // Filter arcs connected to any deleted node
        const idsSet = new Set(ids);
        this._model.arcs = (this._model.arcs || []).filter(a => !idsSet.has(a.source) && !idsSet.has(a.target));

        // Clear arc draft if it references any deleted node
        if (this._arcDraft && idsSet.has(this._arcDraft.source)) {
            this._arcDraft = null;
        }

        // Only render/sync/history once after all deletions
        this._normalizeModel();
        this._pushHistory();
        this._scheduleSync();
        this._scheduleRender();

        // Dispatch events for each deleted node
        for (const id of ids) {
            this.dispatchEvent(new CustomEvent('node-deleted', {detail: {id}}));
        }
    }

    // ---------------- editing menu & modes ----------------

    // Bound once, not per _createMenu() call: the menu is rebuilt whenever the
    // viewport crosses the narrow breakpoint, and re-adding the listener each
    // time would fire _onRootClick once per crossing.
    _bindRootClick() {
        if (this._rootClickBound) return;
        this._rootClickBound = true;
        this._root.addEventListener('click', (ev) => this._onRootClick(ev));
    }

    _createMenu() {
        if (this._menu) {
            this._menu.remove();
            // Null it, not just detach it. _setSimulation and _repositionMenu both
            // branch on `this._menu`, so a stale reference after a resize into the
            // narrow layout has them operating on a detached element while the
            // run bar's real buttons go untouched.
            this._menu = null;
        }
        if (this._runBar) {
            this._runBar.remove();
            this._runBar = null;
        }
        if (this._isNarrowViewport()) {
            this._createRunBar();
            return;
        }
        this._menu = document.createElement('div');
        this._menu.className = 'pv-menu pv-mode-menu';
        // Position dynamically since it needs absolute positioning
        this._menu.style.bottom = '10px';
        this._menu.style.left = '50%';
        this._menu.style.transform = 'translateX(-50%)';
        this._menu.appendChild(this._buildToolRow());

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'pv-play pv-play-btn';
        playBtn.textContent = this._simRunning ? '⏸' : '▶';
        playBtn.title = this._simRunning ? 'Stop simulation' : 'Start simulation';
        playBtn.style.width = '44px'; // Slightly wider for play button
        playBtn.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._setSimulation(!this._simRunning);
        });
        this._menu.appendChild(playBtn);
        this._menuPlayBtn = playBtn;

        this._canvasContainer.appendChild(this._menu);
        this._bindRootClick();

        // Ensure the menu reflects the current mode (e.g. default 'select') right after creation
        this._updateMenuActive();
    }

    // The seven edit-mode buttons, shared by the desktop pill and the phone run
    // bar's Edit drawer. Returns a fragment so both callers can place it.
    // _updateMenuActive() and _setSimulation() find these by class, so the buttons
    // must keep `pv-tool` and `data-mode` regardless of which parent they land in.
    _buildToolRow() {
        const frag = document.createDocumentFragment();
        const tools = [
            {mode: 'select', label: '\u26F6', title: 'Select / Fire (1)'},
            {mode: 'add-place', label: '\u25EF', title: 'Add Place (2)'},
            {mode: 'add-transition', label: '\u25A2', title: 'Add Transition (3)'},
            {mode: 'add-arc', label: '\u2192', title: 'Add Arc (4)'},
            {mode: 'add-token', label: '\u2022', title: 'Add / Remove Tokens (5)'},
            {mode: 'delete', label: '\u{1F5D1}', title: 'Delete element (6)'},
            {mode: 'label-edit', label: '\u{1D4D0}', title: 'Edit Labels (7)', toggle: true},
        ];

        tools.forEach(t => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pv-tool pv-mode-btn';
            btn.textContent = t.label;
            btn.title = t.title;
            btn.dataset.mode = t.mode;
            if (t.toggle) {
                btn.dataset.toggle = 'true';
            }
            btn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (t.toggle) {
                    this._toggleLabelEditMode();
                } else {
                    // If delete mode button is clicked and items are selected, delete them
                    if (t.mode === 'delete' && this._selectedNodes && this._selectedNodes.size > 0) {
                        this._deleteNodes(Array.from(this._selectedNodes));
                        this._clearSelection();
                    } else {
                        this._setMode(t.mode);
                    }
                }
            });
            frag.appendChild(btn);
        });
        return frag;
    }

    // ---------------- phone run bar ----------------
    // A docked bar answering the two questions a presenter has: "show me the whole
    // thing" and "what can I fire next". Edit tools live behind the Edit toggle —
    // still one tap away, but no longer the default surface.
    //
    // It is a child of _root, not _canvasContainer: the mode pill is positioned
    // against the canvas *pane*, which is why it lands mid-screen once the JSON
    // pane opens (the deployed page always sets data-json-editor).
    _createRunBar() {
        const bar = document.createElement('div');
        bar.className = 'pv-menu pv-run-bar';

        const mkBtn = (cls, text, title, onClick) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = `pv-run-btn ${cls}`;
            b.textContent = text;
            b.title = title;
            b.setAttribute('aria-label', title);
            b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                onClick();
            });
            return b;
        };

        const main = document.createElement('div');
        main.className = 'pv-run-main';

        main.appendChild(mkBtn('pv-run-fit', '⛶', 'Fit diagram to screen', () => {
            this._userHasPanned = false;
            this._recomputeScaleFloor();
            this.fitToView();
        }));

        const playBtn = mkBtn('pv-run-play', '▶', 'Run / pause', () => {
            this._setSimulation(!this._simRunning);
        });
        main.appendChild(playBtn);
        this._menuPlayBtn = playBtn;

        // The fireable sheet's trigger. Tapping it lists every enabled transition
        // by name, which is the only way to find one on a net that does not fit.
        const fireBtn = mkBtn('pv-run-fire', 'Fireable', 'Show transitions that can fire now', () => {
            this._toggleFireSheet();
        });
        main.appendChild(fireBtn);
        this._runFireBtn = fireBtn;

        const step = document.createElement('span');
        step.className = 'pv-run-step';
        main.appendChild(step);
        this._runStepEl = step;

        main.appendChild(mkBtn('pv-run-reset', '↺', 'Reset to the starting marking', () => {
            this._resetMarking();
        }));

        main.appendChild(mkBtn('pv-run-edit', '✎', 'Show editing tools', () => {
            const open = bar.classList.toggle('pv-run-editing');
            // Editing and simulation are mutually exclusive: _setMode() refuses any
            // mode but 'select' while running, and every drag path early-returns.
            // Only resume what this drawer itself paused, and only on a touch
            // device — closing the drawer must not start a simulation that was
            // never running (which is the state on a narrow desktop window).
            if (open && this._simRunning) {
                this._drawerPausedSim = true;
                this._setSimulation(false);
            } else if (!open && this._drawerPausedSim) {
                this._drawerPausedSim = false;
                this._setSimulation(true);
            }
        }));

        bar.appendChild(main);

        const tools = document.createElement('div');
        tools.className = 'pv-run-tools';
        tools.appendChild(this._buildToolRow());
        bar.appendChild(tools);

        this._root.appendChild(bar);
        this._runBar = bar;
        this._bindRootClick();

        this._createFireSheet();
        // Default to running: tapping a transition only fires inside
        // `if (this._simRunning)`, so without this a tap on a phone does nothing.
        // It also disables node dragging for free via the _simRunning early-returns.
        //
        // Requires a coarse pointer as well as a narrow viewport. _isNarrowViewport()
        // also matches max-height:520px, which a short <petri-view> embedded in a
        // desktop page satisfies — and silently starting a simulation there would
        // change behaviour for the repos that vendor this component.
        // Unconditionally, so ↺ works even where the auto-start below does not.
        this._captureRunBaseline();
        if (this._isTouchDevice()) this._setSimulation(true);
        this._updateMenuActive();
        this._refreshRunUI();
    }

    // Scrolling list of currently-enabled transitions. Mounted next to the run bar
    // rather than inside it so its own scroll container is not clipped by the bar.
    _createFireSheet() {
        if (this._fireSheet) this._fireSheet.remove();
        const sheet = document.createElement('div');
        sheet.className = 'pv-fire-sheet';
        sheet.hidden = true;
        const list = document.createElement('div');
        list.className = 'pv-fire-list';
        sheet.appendChild(list);
        // Mounted inside the bar and positioned above it, so opening the sheet
        // does not resize the canvas pane or disturb the divider split.
        (this._runBar || this._root).appendChild(sheet);
        this._fireSheet = sheet;
        this._fireList = list;
    }

    _toggleFireSheet(force) {
        if (!this._fireSheet) return;
        const show = force === undefined ? this._fireSheet.hidden : force;
        this._fireSheet.hidden = !show;
        this._runBar?.classList.toggle('pv-fire-open', show);
        if (show) this._renderFireList();
    }

    _renderFireList() {
        if (!this._fireList) return;
        const ids = this._enabledIds || [];
        this._fireList.textContent = '';
        if (!ids.length) {
            const empty = document.createElement('div');
            empty.className = 'pv-fire-empty';
            empty.textContent = 'Nothing can fire — the net is dead in this marking. Tap ↺ to reset.';
            this._fireList.appendChild(empty);
            return;
        }
        for (const id of ids) {
            const t = (this._model.transitions || {})[id] || {};
            const row = document.createElement('div');
            row.className = 'pv-fire-row';

            const fire = document.createElement('button');
            fire.type = 'button';
            fire.className = 'pv-fire-name';
            fire.textContent = t.label || id;
            // _enqueueFire, never _fire: it keeps the debounce and queue draining
            // that the canvas tap path relies on.
            fire.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._enqueueFire(id);
            });
            row.appendChild(fire);

            const locate = document.createElement('button');
            locate.type = 'button';
            locate.className = 'pv-fire-locate';
            locate.textContent = '◎';
            locate.title = `Centre ${t.label || id} in view`;
            locate.setAttribute('aria-label', `Centre ${t.label || id} in view`);
            locate.addEventListener('click', (ev) => {
                ev.stopPropagation();
                this._centerOnNode(id);
            });
            row.appendChild(locate);

            this._fireList.appendChild(row);
        }
    }

    // Single refresh point for everything the run bar displays. Called from _fire,
    // _setSimulation, _resetMarking and _renderUI; a no-op on desktop.
    _refreshRunUI() {
        if (!this._runBar) return;
        const n = (this._enabledIds || []).length;
        if (this._runFireBtn) {
            this._runFireBtn.textContent = `Fireable (${n})`;
            this._runFireBtn.classList.toggle('pv-run-dead', n === 0);
        }
        if (this._runStepEl) {
            this._runStepEl.textContent = `${this._stepCount || 0} fired`;
        }
        if (this._menuPlayBtn) {
            this._menuPlayBtn.textContent = this._simRunning ? '⏸' : '▶';
            this._menuPlayBtn.title = this._simRunning ? 'Pause' : 'Run';
        }
        if (this._fireSheet && !this._fireSheet.hidden) this._renderFireList();
    }

    async _revertToOriginalCid() {
        if (!this._originalCid) return;

        try {
            const response = await fetch(`/o/${this._originalCid}`);
            if (!response.ok) {
                throw new Error(`Failed to load revision: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            this._model = data || {};
            this._normalizeModel();
            this._renderUI();
            this._refit(); // a different revision — frame it
            this._syncLD(true);
            this._pushHistory();

            // Show feedback to user
            this._toast(`Reverted to revision ${this._originalCid}`);
        } catch (err) {
            console.error('Failed to revert to original CID:', err);
            this._toast('Failed to revert to original revision: ' + (err && err.message ? err.message : String(err)), 'error');
        }
    }

    _setMode(mode) {
        if (this._simRunning && mode !== 'select') return;
        this._mode = mode;
        // Turn off label edit mode when switching to any tool
        if (this._labelEditMode) {
            this._labelEditMode = false;
        }
        if (mode !== 'add-arc' && this._arcDraft) {
            this._arcDraft = null;
            this._updateArcDraftHighlight();
        }
        this._updateMenuActive();
    }

    // Mode capability helpers
    _modeCan(capability) {
        const caps = MODE_CAPS[this._mode];
        return caps && caps[capability] === true;
    }

    _canDragNode() {
        return this._modeCan('canDragNode') && !this._labelEditMode;
    }

    _canMultiSelect() {
        return this._modeCan('canMultiSelect');
    }

    _canBoxSelect() {
        return this._modeCan('canBoxSelect');
    }

    _updateMenuActive() {
        // The tool buttons live in the desktop pill OR the phone run bar's edit
        // drawer. Keying off `this._menu` alone left mode highlighting and the
        // label-edit affordance dead on phones.
        const host = this._menu || this._runBar;
        host?.querySelectorAll('.pv-tool').forEach(btn => {
            const on = btn.dataset.toggle === 'true'
                ? this._labelEditMode
                : btn.dataset.mode === this._mode;
            btn.classList.toggle('pv-active', on);
        });
        // Update node highlights — independent of which surface is mounted.
        this._updateLabelEditHighlights();
    }

    _toggleLabelEditMode() {
        this._labelEditMode = !this._labelEditMode;
        this._updateMenuActive();
    }

    _updateLabelEditHighlights() {
        if (!this._nodes) return;
        for (const [id, el] of Object.entries(this._nodes)) {
            const isPlaceOrTransition = el.classList.contains('pv-place') || el.classList.contains('pv-transition');
            if (isPlaceOrTransition) {
                el.classList.toggle('pv-label-editable', this._labelEditMode);
            }
        }
    }

    _clearSelection() {
        this._selectedNodes.clear();
        this._updateSelectionHighlights();
    }

    _toggleNodeSelection(id) {
        if (this._selectedNodes.has(id)) {
            this._selectedNodes.delete(id);
        } else {
            this._selectedNodes.add(id);
        }
        this._updateSelectionHighlights();
    }

    _updateSelectionHighlights() {
        if (!this._nodes) return;
        for (const [id, el] of Object.entries(this._nodes)) {
            const isPlaceOrTransition = el.classList.contains('pv-place') || el.classList.contains('pv-transition');
            if (isPlaceOrTransition) {
                el.classList.toggle('pv-group-selected', this._selectedNodes.has(id));
            }
        }
    }

    _selectNodesInBox() {
        if (!this._boxSelect) return;
        
        const rootRect = this._canvasContainer ? this._canvasContainer.getBoundingClientRect() : this._root.getBoundingClientRect();
        const scale = this._view.scale || 1;
        const viewTx = this._view.tx || 0;
        const viewTy = this._view.ty || 0;

        // Calculate bounding box in screen coordinates
        const minX = Math.min(this._boxSelect.startX, this._boxSelect.endX);
        const maxX = Math.max(this._boxSelect.startX, this._boxSelect.endX);
        const minY = Math.min(this._boxSelect.startY, this._boxSelect.endY);
        const maxY = Math.max(this._boxSelect.startY, this._boxSelect.endY);

        // Check each node to see if it's inside the bounding box
        for (const [id, el] of Object.entries(this._nodes)) {
            const isPlaceOrTransition = el.classList.contains('pv-place') || el.classList.contains('pv-transition');
            if (!isPlaceOrTransition) continue;

            // Get node's position in screen coordinates
            const nodeRect = el.getBoundingClientRect();
            const nodeCenterX = (nodeRect.left + nodeRect.width / 2) - rootRect.left;
            const nodeCenterY = (nodeRect.top + nodeRect.height / 2) - rootRect.top;

            // Check if node center is inside the bounding box
            if (nodeCenterX >= minX && nodeCenterX <= maxX && nodeCenterY >= minY && nodeCenterY <= maxY) {
                this._selectedNodes.add(id);
            }
        }

        this._updateSelectionHighlights();
    }

    _validateLabel(text) {
        if (!text || text.trim().length === 0) {
            return 'Label cannot be empty';
        }
        if (text.length > 100) {
            return 'Label must be 100 characters or fewer';
        }
        if (/[\r\n]/.test(text)) {
            return 'Label must be a single line';
        }
        return null; // valid
    }

    _openLabelEditor(id, currentLabel) {
        const input = prompt('Edit label', currentLabel || id);
        if (input === null) return; // user cancelled

        const newLabel = input.trim();
        const error = this._validateLabel(newLabel);

        if (error) {
            this._toast(error);
            return;
        }

        // Update the label in the model
        this._updateNodeLabel(id, newLabel);
    }

    _updateNodeLabel(id, newLabel) {
        // Check if it's a place or transition
        if (this._model.places && this._model.places[id]) {
            this._model.places[id].label = newLabel;
        } else if (this._model.transitions && this._model.transitions[id]) {
            this._model.transitions[id].label = newLabel;
        } else {
            return; // node not found
        }

        // Update the DOM element
        const el = this._nodes[id];
        if (el) {
            const labelEl = el.querySelector('.pv-label');
            if (labelEl) {
                labelEl.textContent = newLabel;
            }
        }

        // Persist the change
        this._syncLD();
        this._pushHistory();
    }


    _onRootClick(ev) {
        // Skip if already created on pointerup (prevents double-creation)
        if (this._createdOnPointerUp) {
            this._createdOnPointerUp = false;
            return;
        }
        if (ev.target.closest('.pv-node') || ev.target.closest('.pv-weight') || ev.target.closest('.pv-menu')) return;
        const rect = this._stage.getBoundingClientRect();
        const x = Math.round(ev.clientX - rect.left);
        const y = Math.round(ev.clientY - rect.top);

        if (this._modeCan('canCreatePlace')) {
            const id = this._genId('p');
            this._model.places[id] = {'@type': 'Place', x, y, initial: [0], capacity: [Infinity]};
            this._normalizeModel();
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
        } else if (this._modeCan('canCreateTransition')) {
            const id = this._genId('t');
            this._model.transitions[id] = {'@type': 'Transition', x, y};
            this._normalizeModel();
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
        }
    }

    _setSimulation(running) {
        if (running === !!this._simRunning) return;
        if (running) {
            this._prevMode = this._mode;
            this._simRunning = true;
            // Snapshot the marking so ↺ can put the model back. Firing writes
            // straight into p.initial, so the starting state is otherwise lost.
            //
            // Only if we do not already have one. A pause/resume — or opening and
            // closing the ✎ drawer, which does the same round trip — would
            // otherwise re-baseline to the already-fired marking, silently turning
            // ↺ into a no-op and losing the model the presenter started with.
            // _captureRunBaseline() is the single place that resets it.
            this._captureRunBaseline();
            this._setMode('select');
            if (this._menuPlayBtn) {
                this._menuPlayBtn.textContent = '⏸';
                this._menuPlayBtn.title = 'Stop simulation';
            }
            (this._menu || this._runBar)?.querySelectorAll('.pv-tool').forEach(btn => { btn.disabled = true; });
            this._root.classList.add('pv-simulating');
            this.dispatchEvent(new CustomEvent('simulation-started'));
        } else {
            this._simRunning = false;
            if (this._menuPlayBtn) {
                this._menuPlayBtn.textContent = '▶';
                this._menuPlayBtn.title = 'Start simulation';
            }
            (this._menu || this._runBar)?.querySelectorAll('.pv-tool').forEach(btn => { btn.disabled = false; });
            this._root.classList.remove('pv-simulating');
            this._setMode(this._prevMode || 'select');
            this._prevMode = null;
            this.dispatchEvent(new CustomEvent('simulation-stopped'));
        }
        this._refreshRunUI?.();
    }

    // ---------------- dragging ----------------
    _snap(n, g = 10) {
        return Math.round(n / g) * g;
    }

    _beginDrag(ev, id, kind) {
        // Prevent dragging while simulation (play) is running
        if (this._simRunning) return;
        // A second finger is already down: this is a pinch, not a drag.
        if (this._activeTouches && this._activeTouches.size > 1) return;

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
        const offset = this._getNodeOffset(kind);
        let currentLeft = startLeft, currentTop = startTop;
        const dragThreshold = 5; // pixels before drag counts as intentional

        const move = (e) => {
            const dxLocal = (e.clientX - startX) / scale;
            const dyLocal = (e.clientY - startY) / scale;
            // Mark drag as occurred if movement exceeds threshold
            if (Math.abs(dxLocal) > dragThreshold || Math.abs(dyLocal) > dragThreshold) {
                this._dragOccurred = true;
            }
            let newLeft = startLeft + dxLocal;
            let newTop = startTop + dyLocal;
            currentLeft = newLeft;
            currentTop = newTop;
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
            this._onResize(); // expand canvas if node dragged past edge
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
            this._normalizeCoordinates(); // shift all nodes if any went negative
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
            this.dispatchEvent(new CustomEvent('node-moved', {detail: {id, kind}}));
            this._activeNodeDrag = null;
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);

        // Published so a pinch starting on top of this node can abandon the drag.
        // Restores the pre-drag position and deliberately does NOT persist: a
        // gesture meant to zoom must not mutate the model being presented.
        this._activeNodeDrag = {
            cancel: () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', up);
                window.removeEventListener('pointercancel', up);
                try {
                    el.releasePointerCapture(ev.pointerId);
                } catch { /* ignore */ }
                try {
                    el.style.cursor = '';
                    document.body.style.cursor = '';
                } catch { /* ignore */ }
                el.style.left = `${startLeft}px`;
                el.style.top = `${startTop}px`;
                const node = kind === 'place' ? this._model.places[id] : this._model.transitions[id];
                if (node) {
                    node.x = Math.round(startLeft + offset);
                    node.y = Math.round(startTop + offset);
                }
                this._dragOccurred = false;
                this._activeNodeDrag = null;
                this._draw();
            },
        };
    }

    _normalizeCoordinates() {
        // Find minimum coordinates across all nodes
        const places = this._model.places || {};
        const transitions = this._model.transitions || {};
        let minX = Infinity, minY = Infinity;

        for (const p of Object.values(places)) {
            if (p.x !== undefined) minX = Math.min(minX, p.x);
            if (p.y !== undefined) minY = Math.min(minY, p.y);
        }
        for (const t of Object.values(transitions)) {
            if (t.x !== undefined) minX = Math.min(minX, t.x);
            if (t.y !== undefined) minY = Math.min(minY, t.y);
        }

        // If any coordinates are negative, shift everything to make them positive
        const padding = 50; // minimum distance from origin
        const shiftX = minX < padding ? padding - minX : 0;
        const shiftY = minY < padding ? padding - minY : 0;

        if (shiftX > 0 || shiftY > 0) {
            for (const p of Object.values(places)) {
                if (p.x !== undefined) p.x += shiftX;
                if (p.y !== undefined) p.y += shiftY;
            }
            for (const t of Object.values(transitions)) {
                if (t.x !== undefined) t.x += shiftX;
                if (t.y !== undefined) t.y += shiftY;
            }
        }
    }

    _beginGroupDrag(ev, clickedId) {
        if (this._activeTouches && this._activeTouches.size > 1) return;
        // Prevent dragging while simulation (play) is running
        if (this._simRunning) return;

        ev.preventDefault();
        
        const scale = this._view.scale || 1;
        const startX = ev.clientX;
        const startY = ev.clientY;

        // Store initial positions for all selected nodes
        const initialPositions = new Map();
        for (const id of this._selectedNodes) {
            const el = this._nodes[id];
            if (!el) continue;

            const isPlace = el.classList.contains('pv-place');
            const offset = this._getNodeOffset(isPlace ? 'place' : 'transition');
            const node = isPlace ? this._model.places[id] : this._model.transitions[id];
            if (node) {
                initialPositions.set(id, {
                    x: node.x || 0,
                    y: node.y || 0,
                    offset: offset,
                    isPlace: isPlace,
                    element: el
                });
            }
        }

        // Set grabbing cursor
        try {
            document.body.style.cursor = 'grabbing';
        } catch { /* ignore */ }

        const move = (e) => {
            const dxLocal = (e.clientX - startX) / scale;
            const dyLocal = (e.clientY - startY) / scale;

            // Update all selected nodes
            for (const [id, initial] of initialPositions) {
                const newX = initial.x + dxLocal;
                const newY = initial.y + dyLocal;
                
                // Update element position (subtract offset for rendering)
                initial.element.style.left = `${newX - initial.offset}px`;
                initial.element.style.top = `${newY - initial.offset}px`;
                
                // Update model
                const node = initial.isPlace ? this._model.places[id] : this._model.transitions[id];
                if (node) {
                    node.x = Math.round(newX);
                    node.y = Math.round(newY);
                }
            }
            this._onResize(); // expand canvas if nodes dragged past edge
        };

        const up = (e) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);

            // Restore cursor
            try {
                document.body.style.cursor = '';
            } catch { /* ignore */ }

            // Snap all nodes to grid and finalize
            for (const [id, initial] of initialPositions) {
                const node = initial.isPlace ? this._model.places[id] : this._model.transitions[id];
                if (node) {
                    node.x = this._snap(node.x);
                    node.y = this._snap(node.y);
                }
            }

            this._normalizeCoordinates(); // shift all nodes if any went negative
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
            this.dispatchEvent(new CustomEvent('group-moved', {detail: {ids: Array.from(this._selectedNodes)}}));
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }

    _beginCanvasGroupDrag(ev) {
        // Prevent dragging while simulation (play) is running
        if (this._simRunning) return;
        if (this._activeTouches && this._activeTouches.size > 1) return;

        ev.preventDefault();
        
        const scale = this._view.scale || 1;
        const startX = ev.clientX;
        const startY = ev.clientY;

        // Store initial positions for all selected nodes
        const initialPositions = new Map();
        for (const id of this._selectedNodes) {
            const el = this._nodes[id];
            if (!el) continue;

            const isPlace = el.classList.contains('pv-place');
            const offset = this._getNodeOffset(isPlace ? 'place' : 'transition');
            const node = isPlace ? this._model.places[id] : this._model.transitions[id];
            if (node) {
                initialPositions.set(id, {
                    x: node.x || 0,
                    y: node.y || 0,
                    offset: offset,
                    isPlace: isPlace,
                    element: el
                });
            }
        }

        // Set grabbing cursor
        try {
            document.body.style.cursor = 'grabbing';
            this._canvasContainer.style.cursor = 'grabbing';
        } catch { /* ignore */ }

        // capture pointer on canvas container so we receive move/up outside it
        try {
            if (this._canvasContainer.setPointerCapture) this._canvasContainer.setPointerCapture(ev.pointerId);
        } catch { /* ignore */ }

        const move = (e) => {
            const dxLocal = (e.clientX - startX) / scale;
            const dyLocal = (e.clientY - startY) / scale;

            // Update all selected nodes
            for (const [id, initial] of initialPositions) {
                const newX = initial.x + dxLocal;
                const newY = initial.y + dyLocal;
                
                // Update element position (subtract offset for rendering)
                initial.element.style.left = `${newX - initial.offset}px`;
                initial.element.style.top = `${newY - initial.offset}px`;
                
                // Update model
                const node = initial.isPlace ? this._model.places[id] : this._model.transitions[id];
                if (node) {
                    node.x = Math.round(newX);
                    node.y = Math.round(newY);
                }
            }
            this._onResize(); // expand canvas if nodes dragged past edge
        };

        const up = (e) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);

            // release pointer capture if set
            try {
                if (this._canvasContainer.releasePointerCapture) this._canvasContainer.releasePointerCapture(ev.pointerId);
            } catch { /* ignore */ }

            // Restore cursor
            try {
                document.body.style.cursor = '';
                this._canvasContainer.style.cursor = '';
            } catch { /* ignore */ }

            // Snap all nodes to grid and finalize
            for (const [id, initial] of initialPositions) {
                const node = initial.isPlace ? this._model.places[id] : this._model.transitions[id];
                if (node) {
                    node.x = this._snap(node.x);
                    node.y = this._snap(node.y);
                }
            }

            this._normalizeCoordinates(); // shift all nodes if any went negative
            this._pushHistory();
            this._scheduleSync();
            this._scheduleRender();
            this.dispatchEvent(new CustomEvent('group-moved', {detail: {ids: Array.from(this._selectedNodes)}}));
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }

    // ---------------- drawing ----------------
    _onResize() {
        // Use canvas container rect instead of root rect
        const rect = this._canvasContainer ? this._canvasContainer.getBoundingClientRect() : this._root.getBoundingClientRect();
        const viewportW = Math.max(300, Math.floor(rect.width));
        const viewportH = Math.max(200, Math.floor(rect.height));

        // Calculate bounds of all nodes in the diagram
        const bounds = this._calculateDiagramBounds();

        // Canvas should be large enough to contain the entire diagram bounds
        // Account for negative coordinates by positioning canvas with negative margin
        const padding = 100;

        // If nodes are at negative coordinates, extend canvas to cover that area
        const extraLeft = bounds.minX < 0 ? -bounds.minX + padding : 0;
        const extraTop = bounds.minY < 0 ? -bounds.minY + padding : 0;

        // Store offset for use in _draw() and element positioning
        this._canvasOffset = { x: extraLeft, y: extraTop };

        const w = Math.max(viewportW, bounds.maxX + padding) + extraLeft;
        const h = Math.max(viewportH, bounds.maxY + padding) + extraTop;

        this._canvas.width = Math.floor(w * this._dpr);
        this._canvas.height = Math.floor(h * this._dpr);
        this._canvas.style.width = `${w}px`;
        this._canvas.style.height = `${h}px`;
        // Position canvas to cover negative coordinate space
        this._canvas.style.marginLeft = `-${extraLeft}px`;
        this._canvas.style.marginTop = `-${extraTop}px`;
        this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
        this._draw();

        // _createMenu() branches on the viewport, but only ran once at connect.
        // Rotating a tablet or dragging a desktop window across 760px would
        // otherwise leave the wrong control surface in place — a floating edit
        // pill on a phone, or a docked run bar on a desktop.
        const narrow = this._isNarrowViewport();
        if (this._menuIsNarrow !== undefined && this._menuIsNarrow !== narrow) {
            this._menuIsNarrow = narrow;
            this._createMenu();
        } else if (this._menuIsNarrow === undefined) {
            this._menuIsNarrow = narrow;
        }
        // Rotating the phone changes what "fits", so re-derive the floor and
        // reframe. Strictly on a VIEWPORT change, never on a bounds change:
        // _onResize() is also called from every pointermove of a node drag
        // ("expand canvas if node dragged past edge"), and re-fitting there
        // rescales the diagram under the pointer while the drag's own
        // pointer->world mapping still uses the scale captured at drag start —
        // the node visibly decouples from the finger.
        const vw = Math.round(viewportW), vh = Math.round(viewportH);
        const viewportChanged = this._lastViewport?.w !== vw || this._lastViewport?.h !== vh;
        this._lastViewport = {w: vw, h: vh};
        const gestureInFlight = !!(this._activeNodeDrag || this._panning || this._pinchState);
        if (viewportChanged && !this._fitting && !gestureInFlight) {
            this._recomputeScaleFloor();
            if (!this._userHasPanned) this.fitToView();
        }
        // Reposition menu to stay above editor (iPad fix)
        this._repositionMenu();
    }

    _calculateDiagramBounds() {
        const places = this._model.places || {};
        const transitions = this._model.transitions || {};
        
        let minX = 0, minY = 0, maxX = 0, maxY = 0;
        let hasNodes = false;
        
        // Check all places
        for (const p of Object.values(places)) {
            if (p.x !== undefined && p.y !== undefined) {
                const x = p.x || 0;
                const y = p.y || 0;
                minX = hasNodes ? Math.min(minX, x - 40) : x - 40;
                minY = hasNodes ? Math.min(minY, y - 40) : y - 40;
                maxX = hasNodes ? Math.max(maxX, x + 40) : x + 40;
                maxY = hasNodes ? Math.max(maxY, y + 40) : y + 40;
                hasNodes = true;
            }
        }
        
        // Check all transitions
        for (const t of Object.values(transitions)) {
            if (t.x !== undefined && t.y !== undefined) {
                const x = t.x || 0;
                const y = t.y || 0;
                minX = hasNodes ? Math.min(minX, x - 15) : x - 15;
                minY = hasNodes ? Math.min(minY, y - 15) : y - 15;
                maxX = hasNodes ? Math.max(maxX, x + 15) : x + 15;
                maxY = hasNodes ? Math.max(maxY, y + 15) : y + 15;
                hasNodes = true;
            }
        }
        
        return { minX, minY, maxX, maxY, hasNodes };
    }

    _applyViewTransform() {
        if (!this._stage) return;
        const {tx, ty, scale} = this._view;
        this._stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        // Publish the inverse scale so CSS can keep touch targets a constant size
        // in device pixels while the stage shrinks, and expose coarse level-of-detail
        // buckets so labels can drop out before they collide into mush.
        if (this._root) {
            this._root.style.setProperty('--pv-inv-scale', String(1 / (scale || 1)));
            this._root.classList.toggle('pv-lod-min', scale < 0.35);
            this._root.classList.toggle('pv-lod-mid', scale >= 0.35 && scale < 0.7);
        }
        this._updateScaleMeter();
    }

    // ---------------- fit to view ----------------
    // The viewport the diagram has to fit into, in CSS px.
    _fitViewport() {
        const el = this._canvasContainer || this._root;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return null;
        return r;
    }

    // Scale at which the whole diagram fits the viewport with `padding` px to spare.
    //
    // _calculateDiagramBounds() sizes the canvas, so it measures node bodies only.
    // Node labels are absolutely positioned *below* the node and are not in that
    // box — fitting to the raw bounds clips the bottom row of labels. LABEL_PAD
    // is the world-space allowance for them.
    _fitScale(padding = 24) {
        const raw = this._calculateDiagramBounds();
        if (!raw.hasNodes) return null;
        const rect = this._fitViewport();
        if (!rect) return null;
        const LABEL_PAD = 28;
        const bounds = {...raw, maxY: raw.maxY + LABEL_PAD};
        const w = Math.max(1, bounds.maxX - bounds.minX);
        const h = Math.max(1, bounds.maxY - bounds.minY);
        const availW = Math.max(1, rect.width - padding * 2);
        const availH = Math.max(1, rect.height - padding * 2);
        return {fit: Math.min(availW / w, availH / h), bounds, rect};
    }

    // Lower the zoom floor to whatever this model actually needs. Only ever
    // loosens the clamp: a model that already fits keeps the 0.5 desktop floor.
    _recomputeScaleFloor() {
        const m = this._fitScale();
        if (!m) return;
        this._minScale = Math.max(0.05, Math.min(0.5, m.fit * 0.85));
    }

    // Frame the whole diagram. Never zooms past 1x — a two-node model should not
    // balloon to fill a phone screen.
    fitToView({padding = 24} = {}) {
        if (this._fitting) return;
        const m = this._fitScale(padding);
        if (!m) return;
        this._fitting = true;
        try {
            // Never zoom past 1x, and on a mouse never auto-shrink past 0.5x: a
            // tall model fits a desktop pane at ~0.14x, which is unreadable, and a
            // desktop user has a scroll wheel and a whole screen to navigate with.
            // The floor only binds the automatic fit — _minScale is still lowered,
            // so zooming out further by hand remains possible.
            const auto = this._isTouchDevice() ? 0 : 0.5;
            const scale = Math.max(this._minScale, Math.max(auto, Math.min(this._maxScale, Math.min(1, m.fit))));
            const {bounds, rect} = m;
            // Centre the bounds box. _canvasOffset is the negative-coordinate shim
            // _onResize() applies to the canvas, so the stage origin is already
            // shifted by it; the fit has to account for the same offset.
            const off = this._canvasOffset || {x: 0, y: 0};
            const cx = (bounds.minX + bounds.maxX) / 2 + off.x;
            const cy = (bounds.minY + bounds.maxY) / 2 + off.y;
            this._view.scale = scale;
            this._view.tx = rect.width / 2 - cx * scale;
            this._view.ty = rect.height / 2 - cy * scale;
            this._applyViewTransform();
            this._draw();
            this._didInitialFit = true;
        } finally {
            this._fitting = false;
        }
    }

    // Reframe for a model the user did not have on screen before. Called from the
    // paths that REPLACE the model wholesale — not from _renderUI(), which also
    // runs after ordinary edits where reframing would fight the user.
    _refit() {
        this._userHasPanned = false;
        this._recomputeScaleFloor();
        this.fitToView();
        // A different model means a different starting marking for ↺.
        this._captureRunBaseline(true);
        this._refreshRunUI?.();
    }

    // Bring one node to the centre without changing zoom — used by the fireable
    // sheet so tapping a row shows you where that transition lives.
    _centerOnNode(id) {
        const node = (this._model.places || {})[id] || (this._model.transitions || {})[id];
        if (!node || node.x === undefined) return;
        const rect = this._fitViewport();
        if (!rect) return;
        const off = this._canvasOffset || {x: 0, y: 0};
        const scale = this._view.scale || 1;
        this._view.tx = rect.width / 2 - ((node.x || 0) + off.x) * scale;
        this._view.ty = rect.height / 2 - ((node.y || 0) + off.y) * scale;
        this._userHasPanned = true;
        this._applyViewTransform();
    }

    // ---------------- token color helpers ----------------
    // Color dictionary mapping common color names to hex values
    _getColorDictionary() {
        return {
            'black': '#000000',
            'red': '#dc3545',
            'blue': '#007bff',
            'green': '#28a745',
            'yellow': '#ffc107',
            'orange': '#fd7e14',
            'purple': '#6f42c1',
            'pink': '#e83e8c',
            'brown': '#8b4513',
            'cyan': '#17a2b8',
            'gray': '#6c757d',
            'grey': '#6c757d',
            'white': '#ffffff'
        };
    }

    // Extract color from token URL or hex color string
    _extractColor(tokenUrl) {
        if (!tokenUrl) return null;
        
        // Check if it's already a hex color
        if (tokenUrl.startsWith('#')) {
            return tokenUrl;
        }
        
        // Extract color name from URL like "https://pflow.xyz/tokens/red"
        const match = tokenUrl.match(/\/tokens\/([a-zA-Z0-9]+)$/i);
        if (match) {
            const colorName = match[1].toLowerCase();
            const colorDict = this._getColorDictionary();
            return colorDict[colorName] || null;
        }
        
        return null;
    }

    // Calculate contrasting text color (black or white) based on background color brightness
    _getContrastingTextColor(bgColor) {
        if (!bgColor) return '#000000';
        
        // Remove # if present
        const color = bgColor.startsWith('#') ? bgColor.substring(1) : bgColor;
        
        // Parse RGB values
        const r = parseInt(color.substring(0, 2), 16);
        const g = parseInt(color.substring(2, 4), 16);
        const b = parseInt(color.substring(4, 6), 16);
        
        // Calculate relative luminance using the formula from WCAG
        // https://www.w3.org/WAI/GL/wiki/Relative_luminance
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        
        // Return black text for light backgrounds, white for dark backgrounds
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    // Determine arc color based on weight array and token colors
    _getArcColor(arc, active) {
        const tokens = this._model.token || [];
        const weight = arc.weight || [1];
        
        // Find which token colors are used (non-zero weights)
        const usedColors = [];
        for (let i = 0; i < weight.length; i++) {
            const w = Number(weight[i] || 0);
            if (w > 0 && i < tokens.length) {
                const color = this._extractColor(tokens[i]);
                if (color) {
                    usedColors.push(color);
                }
            }
        }
        
        // If no token colors found, use default behavior
        if (usedColors.length === 0) {
            return active ? '#2a6fb8' : '#cfcfcf';
        }
        
        // If only one token color, use it
        if (usedColors.length === 1) {
            return active ? usedColors[0] : this._lightenColor(usedColors[0], 0.6);
        }
        
        // If multiple colors, blend them or use the first one
        // For simplicity, we'll use the first color
        return active ? usedColors[0] : this._lightenColor(usedColors[0], 0.6);
    }

    // Lighten a color by a factor (0-1)
    _lightenColor(hex, factor) {
        // Convert hex to RGB
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        
        // Lighten by moving toward white
        const newR = Math.round(r + (255 - r) * factor);
        const newG = Math.round(g + (255 - g) * factor);
        const newB = Math.round(b + (255 - b) * factor);
        
        // Convert back to hex
        return '#' + 
            newR.toString(16).padStart(2, '0') + 
            newG.toString(16).padStart(2, '0') + 
            newB.toString(16).padStart(2, '0');
    }

    // Group arcs by node pairs to detect multiple arcs between same nodes
    _groupArcsByNodePair(arcs) {
        const groups = new Map();
        
        arcs.forEach((arc, idx) => {
            // Create a key for the node pair (order matters for direction)
            const key = `${arc.source}->${arc.target}`;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key).push(idx);
        });
        
        return groups;
    }

    // Calculate curve offset for an arc based on its position in a group
    _getArcCurveOffset(arc, arcIdx, arcGroups) {
        const key = `${arc.source}->${arc.target}`;
        const reverseKey = `${arc.target}->${arc.source}`;
        
        const group = arcGroups.get(key) || [];
        const reverseGroup = arcGroups.get(reverseKey) || [];
        
        // If there's only one arc in this direction and no reverse arc, no curve needed
        if (group.length === 1 && reverseGroup.length === 0) {
            return 0;
        }
        
        // Find this arc's position in its group
        const posInGroup = group.indexOf(arcIdx);
        if (posInGroup === -1) return 0;
        
        // Calculate curve offset
        const totalArcs = group.length;
        const baseOffset = 30; // Base curve offset in pixels
        
        if (reverseGroup.length > 0) {
            // Bidirectional case: curve away from each other
            // Arcs in one direction curve one way, arcs in reverse curve the other way
            if (totalArcs === 1) {
                // Single arc in this direction, curve it
                return baseOffset;
            } else {
                // Multiple arcs in this direction, spread them out
                // Calculate offset so arcs form layers
                const layerOffset = baseOffset * (1 + posInGroup);
                return layerOffset;
            }
        } else {
            // Multiple arcs in same direction, no reverse arcs
            // Spread them in alternating directions to form shells
            if (totalArcs === 2) {
                // Two arcs: one curves left, one curves right
                return posInGroup === 0 ? baseOffset : -baseOffset;
            } else {
                // Three or more arcs: alternate and increase radius
                // Pattern: 0, +offset, -offset, +2*offset, -2*offset, ...
                if (posInGroup === 0) return 0;
                const layer = Math.ceil(posInGroup / 2);
                const direction = posInGroup % 2 === 1 ? 1 : -1;
                return direction * baseOffset * layer;
            }
        }
    }

    _draw() {
        const ctx = this._ctx;
        const rootRect = this._canvasContainer ? this._canvasContainer.getBoundingClientRect() : this._root.getBoundingClientRect();
        const width = this._canvas.width / this._dpr;
        const height = this._canvas.height / this._dpr;
        ctx.clearRect(0, 0, width, height);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const scale = this._view.scale || 1;
        const viewTx = this._view.tx || 0;
        const viewTy = this._view.ty || 0;

        // Canvas offset for negative coordinates (canvas positioned with negative margins)
        const offsetX = this._canvasOffset?.x || 0;
        const offsetY = this._canvasOffset?.y || 0;

        ctx.lineWidth = 1;

        const arcs = this._model.arcs || [];
        const marks = this._marking(); // current marking to evaluate arc/transition state

        // Enablement is per TRANSITION but was being evaluated per ARC below, and
        // each Sim.enabled() call filters the whole arc list — O(arcs x arcs) per
        // frame, which on a 118-arc model is ~14k comparisons and 118 throwaway
        // arrays for a value that only depends on `marks`. Hoisted here.
        // Recomputed every _draw() on purpose: _setMarking mutates p.initial in
        // place, so a set cached on `this` would go stale after a fire.
        const enabledSet = new Set();
        for (const tid of Object.keys(this._model.transitions || {})) {
            if (Sim.enabled(this._model, tid, marks)) enabledSet.add(tid);
        }

        // Group arcs by node pairs to calculate curve offsets
        const arcGroups = this._groupArcsByNodePair(arcs);

        arcs.forEach((arc, idx) => {
            const srcEl = this._nodes[arc.source];
            const trgEl = this._nodes[arc.target];
            if (!srcEl || !trgEl) return;

            // Get screen coordinates and convert to root-relative coordinates
            const srcRect = srcEl.getBoundingClientRect();
            const trgRect = trgEl.getBoundingClientRect();
            const sxScreen = (srcRect.left + srcRect.width / 2) - rootRect.left;
            const syScreen = (srcRect.top + srcRect.height / 2) - rootRect.top;
            const txScreen = (trgRect.left + trgRect.width / 2) - rootRect.left;
            const tyScreen = (trgRect.top + trgRect.height / 2) - rootRect.top;

            // Transform back to untransformed stage coordinates, adding offset for negative coords
            // Canvas is positioned with negative margins, so we add offset to canvas coords
            const sx = (sxScreen - viewTx) / scale + offsetX;
            const sy = (syScreen - viewTy) / scale + offsetY;
            const tx = (txScreen - viewTx) / scale + offsetX;
            const ty = (tyScreen - viewTy) / scale + offsetY;

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
            
            // Calculate curve offset for this arc
            const curveOffset = this._getArcCurveOffset(arc, idx, arcGroups);
            
            // Calculate start and end points, accounting for curve
            let ex, ey, fx, fy;
            if (curveOffset !== 0) {
                // For curved arcs, adjust the start/end points to account for the curve
                ex = sx + ux * padSrc;
                ey = sy + uy * padSrc;
                fx = tx - ux * (padTrg + tipOffset);
                fy = ty - uy * (padTrg + tipOffset);
            } else {
                // For straight arcs, use original logic
                ex = sx + ux * padSrc;
                ey = sy + uy * padSrc;
                fx = tx - ux * (padTrg + tipOffset);
                fy = ty - uy * (padTrg + tipOffset);
            }

            // Determine the related transition id for this arc so we can color by its enabled state
            const relatedTransitionId = srcIsPlace ? arc.target : arc.source;
            const active = enabledSet.has(relatedTransitionId);

            // Get arc color based on token colors
            const arcColor = this._getArcColor(arc, active);
            ctx.strokeStyle = arcColor;
            ctx.fillStyle = arcColor;

            // draw the main line (curved or straight)
            ctx.beginPath();
            ctx.moveTo(ex, ey);
            
            if (curveOffset !== 0) {
                // Draw a quadratic Bézier curve
                // Calculate control point perpendicular to the line
                const midX = (ex + fx) / 2;
                const midY = (ey + fy) / 2;
                // Perpendicular vector: rotate direction vector 90 degrees
                const perpX = -uy;
                const perpY = ux;
                const controlX = midX + perpX * curveOffset;
                const controlY = midY + perpY * curveOffset;
                ctx.quadraticCurveTo(controlX, controlY, fx, fy);
            } else {
                // Draw a straight line
                ctx.lineTo(fx, fy);
            }
            ctx.stroke();

            // Calculate direction at the end point for arrowhead
            let endDirX = ux, endDirY = uy;
            if (curveOffset !== 0) {
                // For quadratic Bézier curve, calculate the tangent at the end point
                const midX = (ex + fx) / 2;
                const midY = (ey + fy) / 2;
                const perpX = -uy;
                const perpY = ux;
                const controlX = midX + perpX * curveOffset;
                const controlY = midY + perpY * curveOffset;
                // Tangent at end point: direction from control point to end point
                const tdx = fx - controlX;
                const tdy = fy - controlY;
                const tDist = Math.hypot(tdx, tdy) || 1;
                endDirX = tdx / tDist;
                endDirY = tdy / tDist;
            }
            
            const tpx = fx, tpy = fy;
            if (arc.inhibitTransition) {
                // draw inhibitor circle at the tip (works for both place-target and transition-target inhibitors)
                ctx.beginPath();
                ctx.lineWidth = 1.3;
                ctx.fillStyle = '#fff';
                ctx.strokeStyle = arcColor;
                ctx.arc(tpx, tpy, inhibitRadius, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.lineWidth = 1;
            } else {
                // draw normal arrowhead using the end direction
                const ahx = tpx + (-endDirX * ahSize - endDirY * ahSize * 0.45);
                const ahy = tpy + (-endDirY * ahSize + endDirX * ahSize * 0.45);
                const bhx = tpx + (-endDirX * ahSize + endDirY * ahSize * 0.45);
                const bhy = tpy + (-endDirY * ahSize - endDirX * ahSize * 0.45);
                ctx.beginPath();
                ctx.moveTo(tpx, tpy);
                ctx.lineTo(ahx, ahy);
                ctx.lineTo(bhx, bhy);
                ctx.closePath();
                ctx.fillStyle = arcColor;
                ctx.fill();
            }

            // position weight badge if present
            let bx, by;
            if (curveOffset !== 0) {
                // For quadratic Bézier curves, position badge on the curve at t=0.5
                const midX = (ex + fx) / 2;
                const midY = (ey + fy) / 2;
                const perpX = -uy;
                const perpY = ux;
                const controlX = midX + perpX * curveOffset;
                const controlY = midY + perpY * curveOffset;
                // Quadratic Bézier point at t=0.5: B(t) = (1-t)²*P0 + 2(1-t)t*P1 + t²*P2
                const t = 0.5;
                bx = (1-t)*(1-t)*ex + 2*(1-t)*t*controlX + t*t*fx;
                by = (1-t)*(1-t)*ey + 2*(1-t)*t*controlY + t*t*fy;
            } else {
                // For straight arcs, use midpoint
                bx = (ex + fx) / 2;
                by = (ey + fy) / 2;
            }
            const badge = this._stage.querySelector(`.pv-weight[data-arc="${idx}"]`);
            if (badge) {
                const offX = (badge.offsetWidth || 20) / 2;
                const offY = (badge.offsetHeight || 20) / 2;
                // Badge is DOM element relative to stage, so subtract canvas offset
                badge.style.left = `${Math.round(bx - offX - offsetX)}px`;
                badge.style.top = `${Math.round(by - offY - offsetY)}px`;
                
                // Set badge background and border color based on arc color
                const bgColor = active ? this._lightenColor(arcColor, 0.85) : '#fafafa';
                badge.style.background = bgColor;
                badge.style.borderColor = arcColor;
                badge.style.color = active ? arcColor : '#999';
            }
        });

        // live arc draft preview
        if (this._arcDraft && this._arcDraft.source) {
            const srcEl = this._nodes[this._arcDraft.source];
            if (srcEl) {
                const srcRect = srcEl.getBoundingClientRect();
                const sxScreen = (srcRect.left + srcRect.width / 2) - rootRect.left;
                const syScreen = (srcRect.top + srcRect.height / 2) - rootRect.top;
                const sx = (sxScreen - viewTx) / scale + offsetX;
                const sy = (syScreen - viewTy) / scale + offsetY;
                const mx = (this._mouse.x - viewTx) / scale + offsetX;
                const my = (this._mouse.y - viewTy) / scale + offsetY;

                ctx.setLineDash([4, 4]);
                ctx.strokeStyle = '#666';
                ctx.beginPath();
                ctx.moveTo(sx, sy);
                ctx.lineTo(mx, my);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // bounding box selection preview
        if (this._boxSelect) {
            const minX = Math.min(this._boxSelect.startX, this._boxSelect.endX);
            const maxX = Math.max(this._boxSelect.startX, this._boxSelect.endX);
            const minY = Math.min(this._boxSelect.startY, this._boxSelect.endY);
            const maxY = Math.max(this._boxSelect.startY, this._boxSelect.endY);

            // Convert to untransformed stage coordinates for drawing, with offset
            const x1 = (minX - viewTx) / scale + offsetX;
            const y1 = (minY - viewTy) / scale + offsetY;
            const x2 = (maxX - viewTx) / scale + offsetX;
            const y2 = (maxY - viewTy) / scale + offsetY;

            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = 'rgba(255, 165, 0, 0.8)';
            ctx.fillStyle = 'rgba(255, 165, 0, 0.1)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.rect(x1, y1, x2 - x1, y2 - y1);
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineWidth = 1;
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
            const cap = Sim.scalarCapacityOf(this._model, id);
            el.toggleAttribute('data-cap-full', Number.isFinite(cap) && tokenCount >= cap);
            // Lets the level-of-detail rules keep a label on places that hold
            // tokens even when every other label is dropped.
            el.toggleAttribute('data-marked', tokenCount > 0);
        }
    }

    // Also publishes the enabled set as this._enabledIds. The green `pv-active`
    // fill is the only enablement cue today, and it is invisible for any node
    // outside the viewport — which on a fitted 34-transition net is most of them.
    _updateTransitionStates() {
        const marks = this._marking();
        const enabled = [];
        for (const [id, el] of Object.entries(this._nodes)) {
            if (!el.classList.contains('pv-transition')) continue;
            const on = this._enabled(id, marks);
            el.classList.toggle('pv-active', !!on);
            if (on) enabled.push(id);
        }
        enabled.sort();
        this._enabledIds = enabled;
        return enabled;
    }

    // ---------------- token breakdown on hover ----------------
    _showTokenBreakdown(placeId, placeEl) {
        const p = this._model.places[placeId];
        if (!p) return;
        
        const tokens = this._model.token || [];
        const initial = Array.isArray(p.initial) ? p.initial : [p.initial || 0];
        
        // Count how many different token colors have non-zero counts
        const nonZeroColors = [];
        for (let i = 0; i < initial.length; i++) {
            const count = Number(initial[i] || 0);
            if (count > 0 && i < tokens.length) {
                nonZeroColors.push({
                    index: i,
                    count: count,
                    color: this._extractColor(tokens[i]) || '#000000',
                    tokenUrl: tokens[i]
                });
            }
        }
        
        // Only show breakdown if there are multiple token colors
        if (nonZeroColors.length <= 1) return;
        
        // Remove any existing breakdown
        this._hideTokenBreakdown(placeId);
        
        // Create breakdown container
        const breakdown = document.createElement('div');
        breakdown.className = 'pv-token-breakdown';
        breakdown.dataset.placeId = placeId;
        
        // Calculate positions in a circle around the place
        const radius = 50; // Distance from center
        const angleStep = (2 * Math.PI) / nonZeroColors.length;
        const startAngle = -Math.PI / 2; // Start at top
        
        nonZeroColors.forEach((tokenInfo, idx) => {
            const angle = startAngle + (angleStep * idx);
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            
            const tokenDiv = document.createElement('div');
            tokenDiv.className = 'pv-token-breakdown-item';
            tokenDiv.style.left = `${x}px`;
            tokenDiv.style.top = `${y}px`;
            
            // Create inner circle with color
            const circle = document.createElement('div');
            circle.className = 'pv-token-breakdown-circle';
            circle.style.backgroundColor = tokenInfo.color;
            circle.style.borderColor = tokenInfo.color;
            
            // Create count label
            const countLabel = document.createElement('div');
            countLabel.className = 'pv-token-breakdown-count';
            countLabel.textContent = tokenInfo.count;
            // Set background color to match the token color
            countLabel.style.backgroundColor = tokenInfo.color;
            // Use contrasting text color based on background
            countLabel.style.color = this._getContrastingTextColor(tokenInfo.color);
            
            tokenDiv.appendChild(circle);
            tokenDiv.appendChild(countLabel);
            breakdown.appendChild(tokenDiv);
        });
        
        placeEl.appendChild(breakdown);
    }

    _hideTokenBreakdown(placeId) {
        // Remove breakdown from all places if placeId is not specified
        const selector = placeId 
            ? `.pv-token-breakdown[data-place-id="${placeId}"]`
            : '.pv-token-breakdown';
        document.querySelectorAll(selector).forEach(el => el.remove());
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
        this._pushHistory();
        this._scheduleSync();
        this._scheduleRender();
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

        const label = document.createElement('div');
        label.className = 'pv-scale-label';
        container.appendChild(label);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'pv-scale-reset';
        resetBtn.type = 'button';
        resetBtn.textContent = 'fit';
        resetBtn.title = 'Fit the whole diagram to the view';
        resetBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Reframing is what people actually want from this button; on a model
            // wider than the viewport, snapping to 1.00x-at-origin just loses them.
            this._userHasPanned = false;
            this._recomputeScaleFloor();
            this.fitToView();
            this._initialView = {...this._view};
            this._updateScaleMeter();
        });
        container.appendChild(resetBtn);

        const track = document.createElement('div');
        track.className = 'pv-scale-track';
        const fill = document.createElement('div');
        fill.className = 'pv-scale-fill';
        track.appendChild(fill);
        const thumb = document.createElement('div');
        thumb.className = 'pv-scale-thumb';
        track.appendChild(thumb);
        container.appendChild(track);

        const legend = document.createElement('div');
        legend.className = 'pv-scale-legend';
        const minEl = document.createElement('span');
        const maxEl = document.createElement('span');
        maxEl.textContent = `${max}x`;
        legend.appendChild(minEl);
        legend.appendChild(maxEl);
        container.appendChild(legend);

        // pointer interactions. The mapping is logarithmic: _minScale is now
        // model-derived and can be as low as 0.05, and a linear track would spend
        // 90% of its length on scales below 1x.
        let dragging = false;
        const setScaleFromClientY = (clientY) => {
            const rect = track.getBoundingClientRect();
            let pos = (rect.bottom - clientY) / rect.height;
            pos = Math.max(0, Math.min(1, pos));
            const lo = Math.log(this._minScale || 0.5), hi = Math.log(this._maxScale || 2.5);
            const s = Math.exp(lo + pos * (hi - lo));
            this._view.scale = Math.round(s * 100) / 100;
            this._userHasPanned = true;
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

        this._canvasContainer.appendChild(container);
        this._scaleMeter = container;
        this._scaleMeter._label = label;
        this._scaleMeter._fill = fill;
        this._scaleMeter._thumb = thumb;
        this._scaleMeter._track = track;
        this._scaleMeter._minLegend = minEl;
        this._updateScaleMeter();
    }

    _updateScaleMeter() {
        if (!this._scaleMeter) return;
        // Read the floor live — _recomputeScaleFloor() moves it per model, so the
        // values captured when the meter was built go stale on the first load.
        const min = this._minScale || 0.5, max = this._maxScale || 2.5;
        const s = (this._view && this._view.scale) ? Number(this._view.scale) : 1;
        const lo = Math.log(min), hi = Math.log(max);
        const frac = hi > lo ? (Math.log(Math.max(min, Math.min(max, s))) - lo) / (hi - lo) : 0;
        const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100);
        this._scaleMeter._fill.style.height = `${pct}%`;
        this._scaleMeter._thumb.style.bottom = `${pct}%`;
        this._scaleMeter._label.textContent = `${s.toFixed(2)}x`;
        if (this._scaleMeter._minLegend) {
            this._scaleMeter._minLegend.textContent = `${min < 0.1 ? min.toFixed(2) : min.toFixed(min < 0.5 ? 2 : 1)}x`;
        }
    }

    // ---------------- help dialog ----------------
    _showHelpDialog() {
        // Create modal overlay
        const { overlay, dialog } = this._createModalOverlay({
            className: 'pv-help-dialog',
            dialogClass: 'pv-modal-dialog-wide'
        });

        // Title
        const title = document.createElement('h2');
        title.className = 'pv-help-title';
        title.textContent = 'Help: Petri Net Editor';
        dialog.appendChild(title);

        // Help content
        const content = document.createElement('div');
        content.className = 'pv-help-content';

        content.innerHTML = `
            <h3>What are Petri Nets?</h3>
            <p>
                Petri nets are a formal model for representing state machines. They consist of <strong>places</strong> (circles)
                that hold tokens, <strong>transitions</strong> (rectangles) that fire to move tokens, and <strong>arcs</strong> (arrows)
                that connect them. When a transition fires, it consumes tokens from input places and produces tokens in output places.
            </p>

            <h3>📖 Book</h3>
            <p>
                <strong>Petri Nets as a Universal Abstraction</strong> — a practitioner's guide to modeling with pflow.
                Read it at <a href="https://book.pflow.xyz" target="_blank" style="color: #4a90d9;">book.pflow.xyz</a>.
            </p>

            <h3>🚀 Petri Pilot</h3>
            <p>
                <strong>Petri Pilot</strong> generates full-stack apps from Petri net models.
                Try 14 live demos at <a href="https://pilot.pflow.xyz" target="_blank" style="color: #4a90d9;">pilot.pflow.xyz</a>
                — games, workflows, protocols, biochemical models, and optimization problems.
            </p>

            <h3>Controls & Features</h3>

            <h4>Toolbar Buttons:</h4>
            <ul>
                <li><strong>⛶ Select:</strong> Default mode for panning and selecting elements</li>
                <li><strong>◯ Place:</strong> Click to add places (token holders)</li>
                <li><strong>▢ Transition:</strong> Click to add transitions (firing elements)</li>
                <li><strong>→ Arc:</strong> Click source then target to create connections. Right-click (or long-press on touch) the target to create an inhibitor arc. Click an arc's midpoint to toggle inhibitor</li>
                <li><strong>• Token:</strong> Click places to add/remove tokens</li>
                <li><strong>🗑 Delete:</strong> Click elements to remove them</li>
                <li><strong>𝓐 Label:</strong> Click elements to edit their labels</li>
                <li><strong>▶ Play:</strong> Start/stop automatic simulation</li>
            </ul>

            <h4>Mouse Actions:</h4>
            <ul>
                <li><strong>Left-click transition:</strong> Fire it manually (if enabled)</li>
                <li><strong>Right-click place:</strong> Add or remove tokens</li>
                <li><strong>Right-click arc:</strong> Change arc weight</li>
                <li><strong>Drag elements:</strong> Reposition places and transitions</li>
                <li><strong>Mouse wheel:</strong> Zoom in/out</li>
                <li><strong>Space + drag:</strong> Pan the canvas</li>
            </ul>

            <h4>Touch Actions (iPad/Tablet):</h4>
            <ul>
                <li><strong>Tap:</strong> Click on elements</li>
                <li><strong>Drag:</strong> Move elements or pan the canvas</li>
                <li><strong>Long-press (hold 0.5s):</strong> Creates inhibitor arcs in Arc mode (works with touch and Apple Pencil)</li>
                <li><strong>Pinch:</strong> Zoom in/out (if browser supports)</li>
            </ul>

            <h4>Selection & Multi-Select:</h4>
            <ul>
                <li><strong>Shift + click node:</strong> Add/remove individual nodes from selection (in Select, Token, and Delete modes)</li>
                <li><strong>Shift + drag on canvas:</strong> Draw a bounding box to select all nodes within it. A dashed orange rectangle shows the selection area as you drag</li>
                <li><strong>Selected nodes:</strong> Highlighted with orange outline and shadow. Can be dragged together or deleted as a group</li>
            </ul>

            <h4>Keyboard Shortcuts:</h4>
            <ul>
                <li><strong>Ctrl/Cmd + Z:</strong> Undo last action</li>
                <li><strong>Ctrl/Cmd + Shift + Z:</strong> Redo previously undone action</li>
                <li><strong>Delete or Backspace:</strong> Delete all selected nodes</li>
                <li><strong>Escape:</strong> Cancel current operation (arc draft, bounding box selection)</li>
                <li><strong>Space (hold):</strong> Enable pan mode temporarily</li>
                <li><strong>X:</strong> Start/stop automatic simulation</li>
                <li><strong>1:</strong> Switch to Select mode</li>
                <li><strong>2:</strong> Switch to Add Place mode</li>
                <li><strong>3:</strong> Switch to Add Transition mode</li>
                <li><strong>4:</strong> Switch to Add Arc mode</li>
                <li><strong>5:</strong> Switch to Add Token mode</li>
                <li><strong>6:</strong> Switch to Delete mode</li>
                <li><strong>7:</strong> Toggle Label Edit mode</li>
                <li><strong>8:</strong> Start/stop simulation (same as X)</li>
                <li><strong>9:</strong> Open the Analysis workbench</li>
            </ul>

            <h4>Other Features:</h4>
            <ul>
                <li><strong>JSON Editor:</strong> Toggle to edit the model as JSON-LD</li>
                <li><strong>Scale Meter:</strong> Shows current zoom level (right side)</li>
                <li><strong>Download:</strong> Export your Petri net as JSON</li>
                <li><strong>Auto-save:</strong> Changes are saved to browser localStorage</li>
            </ul>

            <h3>Analysis Workbench</h3>
            <p>
                Continuous-time math tools for the current model, computed in the browser with the same
                mass-action semantics and Tsit5 solver options as go-pflow and Petri Pilot.
                Open it from the hamburger menu (<strong>🧮 Analysis</strong>) or press <strong>9</strong>.
            </p>

            <h4>Tabs:</h4>
            <ul>
                <li><strong>Simulate:</strong> Integrate the ODE over time; interactive plot (hover for values,
                click legend entries to toggle series) plus an initial/final/Δ table</li>
                <li><strong>Rate Scan:</strong> Sweep one transition's rate over a range and plot each run's
                steady state — how equilibria respond to a parameter</li>
                <li><strong>Sweep:</strong> Overlay one place's full trajectory across rate values</li>
                <li><strong>Phase Plot:</strong> Plot one place against another along the trajectory</li>
            </ul>

            <h4>Results:</h4>
            <ul>
                <li><strong>CSV / JSON:</strong> Download the raw series behind any plot</li>
                <li><strong>Copy MCP call:</strong> Copies the equivalent Petri Pilot MCP <code>tools/call</code>
                payload (petri_ode, petri_rate_scan, petri_ode_sweep, petri_phase_plot) so an AI assistant —
                or <code>curl https://pilot.pflow.xyz/mcp</code> — can reproduce the analysis</li>
                <li><strong>Rate=0 disables a transition:</strong> useful for knapsack-style exclusion tests
                and quick sensitivity checks</li>
            </ul>

            <h3>Layout Algorithms</h3>
            <p>
                Use the <strong>🎨 Layout Algorithms</strong> menu to automatically arrange your Petri net nodes:
            </p>

            <h4>Available Layouts:</h4>
            <ul>
                <li><strong>📊 Sugiyama:</strong> Layered layout with cycle-breaking and crossing minimization.
                Produces clean hierarchical arrangements ideal for workflows and directed graphs.
                Handles cycles by identifying and breaking feedback edges.</li>

                <li><strong>⊞ Grid:</strong> Arranges nodes on a grid sorted by connectivity.
                Good for dense nets where you want a compact, organized view of all nodes.</li>

                <li><strong>⇄ Bipartite:</strong> Places on the left, transitions on the right, sorted to minimize crossings.
                Leverages the natural bipartite structure of Petri nets for clear separation of places and transitions.</li>

                <li><strong>⭕ Circular:</strong> Arranges all nodes evenly spaced around a circle.
                Good for visualizing cyclic relationships and symmetric structures.
                Makes it easy to see all nodes at once and identify connection patterns.</li>

                <li><strong>🧵 String Diagram:</strong> Monoidal string diagram layout where transitions are boxes
                and places are wires. Transitions are layered top-to-bottom by dependency; places are positioned
                along the wires between their source and target transitions.</li>
            </ul>

            <h4>Which Layout to Choose?</h4>
            <ul>
                <li><strong>Workflows and pipelines:</strong> Use Sugiyama</li>
                <li><strong>Dense or complex nets:</strong> Use Grid</li>
                <li><strong>Clear place/transition separation:</strong> Use Bipartite</li>
                <li><strong>Cyclic or symmetric patterns:</strong> Use Circular</li>
                <li><strong>Category theory / monoidal view:</strong> Use String Diagram</li>
            </ul>
        `;

        dialog.appendChild(content);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'pv-help-close-btn';
        closeBtn.textContent = 'Close';
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        dialog.appendChild(closeBtn);

        document.body.appendChild(overlay);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // ---------------- Petri Pilot dialog ----------------
    _showPetriPilotDialog() {
        // Create modal overlay
        const { overlay, dialog } = this._createModalOverlay({
            className: 'pv-help-dialog',
            dialogClass: 'pv-modal-dialog'
        });

        // Title
        const title = document.createElement('h2');
        title.className = 'pv-help-title';
        title.textContent = '🚀 Petri Pilot';
        dialog.appendChild(title);

        // Content
        const content = document.createElement('div');
        content.className = 'pv-help-content';

        content.innerHTML = `
            <h3>What is Petri Pilot?</h3>
            <p>
                <strong>Petri Pilot</strong> generates full-stack applications from Petri net models —
                event-sourced Go backends, ES modules frontends, GraphQL APIs, and SQLite persistence.
                Design visually, generate code, run instantly.
            </p>

            <h3>Live Demos</h3>
            <p>Every demo is a running app generated from a Petri net model:</p>
            <ul style="column-count: 2; column-gap: 24px;">
                <li><a href="https://pilot.pflow.xyz/tic-tac-toe/" target="_blank" style="color: #4a90d9;">Tic-Tac-Toe</a> — state machines, ODE analysis</li>
                <li><a href="https://pilot.pflow.xyz/zk-tic-tac-toe/" target="_blank" style="color: #4a90d9;">ZK Tic-Tac-Toe</a> — zero-knowledge proofs</li>
                <li><a href="https://pilot.pflow.xyz/coffeeshop/" target="_blank" style="color: #4a90d9;">Coffee Shop</a> — capacity, weighted arcs</li>
                <li><a href="https://pilot.pflow.xyz/texas-holdem/" target="_blank" style="color: #4a90d9;">Texas Hold'em</a> — roles, guards, event sourcing</li>
                <li><a href="https://pilot.pflow.xyz/knapsack/" target="_blank" style="color: #4a90d9;">Knapsack</a> — optimization, mass-action kinetics</li>
                <li><a href="https://pilot.pflow.xyz/predator-prey/" target="_blank" style="color: #4a90d9;">Predator-Prey</a> — Lotka-Volterra dynamics</li>
                <li><a href="https://pilot.pflow.xyz/dining-philosophers/" target="_blank" style="color: #4a90d9;">Dining Philosophers</a> — deadlock, mutual exclusion</li>
                <li><a href="https://pilot.pflow.xyz/loan-approval/" target="_blank" style="color: #4a90d9;">Loan Approval</a> — multi-stage workflow</li>
                <li><a href="https://pilot.pflow.xyz/tcp-handshake/" target="_blank" style="color: #4a90d9;">TCP Handshake</a> — protocol state machines</li>
                <li><a href="https://pilot.pflow.xyz/thermostat/" target="_blank" style="color: #4a90d9;">Thermostat</a> — feedback loops, control</li>
                <li><a href="https://pilot.pflow.xyz/producer-consumer/" target="_blank" style="color: #4a90d9;">Producer-Consumer</a> — buffered channels</li>
                <li><a href="https://pilot.pflow.xyz/hiring-pipeline/" target="_blank" style="color: #4a90d9;">Hiring Pipeline</a> — multi-phase tracking</li>
                <li><a href="https://pilot.pflow.xyz/enzyme-kinetics/" target="_blank" style="color: #4a90d9;">Enzyme Kinetics</a> — Michaelis-Menten</li>
                <li><a href="https://pilot.pflow.xyz/stoplight/" target="_blank" style="color: #4a90d9;">Stoplight</a> — cyclic state machines</li>
            </ul>

            <h3>MCP Integration</h3>
            <p>
                Use Petri Pilot tools via <strong>MCP</strong> from AI assistants —
                validate, simulate, analyze, and generate full-stack apps from models.
            </p>
        `;

        dialog.appendChild(content);

        // Button container
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; gap: 12px; justify-content: center; margin-top: 20px;';

        // Visit Petri Pilot button
        const visitBtn = document.createElement('button');
        visitBtn.className = 'pv-help-close-btn';
        visitBtn.style.cssText = 'background: #4a9eda; color: white;';
        visitBtn.textContent = 'Visit Petri Pilot →';
        visitBtn.type = 'button';
        visitBtn.addEventListener('click', () => {
            window.open('https://pilot.pflow.xyz', '_blank', 'noopener,noreferrer');
        });
        buttonContainer.appendChild(visitBtn);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'pv-help-close-btn';
        closeBtn.textContent = 'Close';
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        buttonContainer.appendChild(closeBtn);

        dialog.appendChild(buttonContainer);

        document.body.appendChild(overlay);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // ---------------- Analysis workbench (ODE + math tools) ----------------
    //
    // One tabbed dialog for the continuous-math tools, computed client-side
    // with petri-solver.js. Tabs mirror petri-pilot's MCP tools (petri_ode,
    // petri_rate_scan, petri_ode_sweep, petri_phase_plot) — the solver options
    // match pilot's JSParityOptions, so a result here is reproducible via MCP,
    // and "Copy MCP call" emits the equivalent tools/call payload.

    _escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /**
     * Non-blocking notification, replaces window.alert throughout the editor.
     * kind: 'info' | 'success' | 'error'
     */
    _toast(message, kind = 'info', ms = 4500) {
        let host = document.querySelector('.pv-toast-host');
        if (!host) {
            host = document.createElement('div');
            host.className = 'pv-toast-host';
            host.setAttribute('aria-live', 'polite');
            document.body.appendChild(host);
        }
        const el = document.createElement('div');
        el.className = 'pv-toast' + (kind !== 'info' ? ' pv-toast-' + kind : '');
        el.textContent = String(message);
        el.addEventListener('click', () => el.remove());
        host.appendChild(el);
        while (host.children.length > 4) host.firstChild.remove();
        setTimeout(() => {
            el.classList.add('pv-toast-out');
            setTimeout(() => el.remove(), 300);
        }, ms);
    }

    _downloadFile(filename, text, mime = 'text/plain') {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * Convert the JSON-LD model to petri-pilot's flat schema (v1), the format
     * its MCP tools accept. Color vectors are summed — pilot's math tools are
     * scalar; the note field flags it when information was folded.
     */
    _pilotModelJSON() {
        const m = this._model;
        const out = {
            name: (document.title || 'pflow-model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pflow-model',
            places: [],
            transitions: [],
            arcs: [],
        };
        let folded = false;
        for (const [id, p] of Object.entries(m.places || {})) {
            const init = Array.isArray(p.initial) ? p.initial : [p.initial || 0];
            if (init.length > 1) folded = true;
            out.places.push({ id, initial: init.reduce((a, b) => a + (b || 0), 0), x: p.x || 0, y: p.y || 0 });
        }
        for (const [id, t] of Object.entries(m.transitions || {})) {
            out.transitions.push({ id, x: t.x || 0, y: t.y || 0 });
        }
        for (const a of (m.arcs || [])) {
            const w = Array.isArray(a.weight) ? a.weight : [a.weight || 1];
            if (w.length > 1) folded = true;
            const arc = { from: a.source, to: a.target, weight: w.reduce((x, y) => x + (y || 0), 0) || 1 };
            if (a.inhibitTransition) arc.inhibit = true;
            out.arcs.push(arc);
        }
        if (folded) out.description = 'Exported from pflow.xyz; multi-color token vectors were summed to scalars.';
        return out;
    }

    /** JSON-RPC tools/call payload for pilot.pflow.xyz/mcp. */
    _pilotCall(tool, args) {
        return JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: tool, arguments: { model: JSON.stringify(this._pilotModelJSON()), ...args } },
        }, null, 2);
    }

    /** Solve the current model's ODE once. Options default to JS/Go parity values. */
    _odeSolve(rates, tspan, opts = {}, customState = null) {
        const m = this._solverModule;
        const net = m.fromJSON(this._model);
        const initialState = m.setState(net, customState);
        const prob = new m.ODEProblem(net, initialState, tspan, m.setRates(net, rates));
        const sol = m.solve(prob, m.Tsit5(), {
            dt: opts.dt ?? 0.01,
            abstol: opts.abstol ?? 1e-6,
            reltol: opts.reltol ?? 1e-3,
            adaptive: true,
        });
        return { net, sol };
    }

    /** Uniform-stride downsample keeping first and last, for plotting only. */
    _downsample(arr, limit = 600) {
        if (arr.length <= limit) return arr.map((_, i) => i);
        const idx = [];
        const stride = (arr.length - 1) / (limit - 1);
        for (let i = 0; i < limit; i++) idx.push(Math.round(i * stride));
        return idx;
    }

    async _showSimulationDialog() {
        // Load solver module dynamically
        if (!this._solverModule) {
            try {
                this._solverModule = await import('./petri-solver.js');
            } catch (err) {
                this._toast('Failed to load solver module: ' + err.message, 'error');
                console.error('Failed to load petri-solver.js:', err);
                return;
            }
        }

        const placeIds = Object.keys(this._model.places || {});
        const transitionIds = Object.keys(this._model.transitions || {});
        if (placeIds.length === 0 || transitionIds.length === 0) {
            this._toast('Add at least one place and one transition before running analysis', 'error');
            return;
        }

        // Session-sticky parameters (survive close/reopen, not reload)
        if (!this._analysisState) {
            this._analysisState = {
                tab: 'simulate',
                tend: 10,
                scanTend: 50,
                rates: {},
                selected: null,          // places to plot; null = default (first 8)
                scanTransition: transitionIds[0],
                range: { start: 0.1, stop: 2, n: 9 },
                sweepObservable: placeIds[0],
                phaseX: placeIds[0],
                phaseY: placeIds[1] || placeIds[0],
                dt: 0.01, abstol: 1e-6, reltol: 1e-3,
            };
        }
        const st = this._analysisState;
        for (const t of transitionIds) if (!(t in st.rates)) st.rates[t] = 1.0;
        if (!st.selected) st.selected = placeIds.slice(0, 8);
        st.selected = st.selected.filter(p => placeIds.includes(p));
        if (!placeIds.includes(st.phaseX)) st.phaseX = placeIds[0];
        if (!placeIds.includes(st.phaseY)) st.phaseY = placeIds[1] || placeIds[0];
        if (!transitionIds.includes(st.scanTransition)) st.scanTransition = transitionIds[0];
        if (!placeIds.includes(st.sweepObservable)) st.sweepObservable = placeIds[0];

        const esc = (s) => this._escHtml(s);
        const overlay = document.createElement('div');
        overlay.className = 'pv-modal-overlay pv-analysis-overlay';

        const TABS = [
            { id: 'simulate', label: 'Simulate', hint: 'Integrate the mass-action ODE over time (Tsit5).' },
            { id: 'scan', label: 'Rate Scan', hint: 'Sweep one transition rate; plot each steady state.' },
            { id: 'sweep', label: 'Sweep', hint: 'Overlay one place\'s trajectory across rate values.' },
            { id: 'phase', label: 'Phase Plot', hint: 'Trajectory of one place against another.' },
        ];

        const dialog = document.createElement('div');
        dialog.className = 'pv-modal-dialog pv-analysis-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-label', 'Analysis');
        dialog.innerHTML = `
            <div class="pv-dialog-header">
                <h2 class="pv-dialog-header-title">Analysis</h2>
                <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close (Esc)">×</button>
            </div>
            <div class="pv-analysis-tabs" role="tablist">
                ${TABS.map(t => `<button type="button" role="tab" class="pv-analysis-tab" data-tab="${t.id}">${t.label}</button>`).join('')}
            </div>
            <p class="pv-analysis-hint"></p>
            <div class="pv-analysis-body">
                <div class="pv-analysis-controls">
                    <div class="pv-analysis-section" data-show="simulate scan sweep phase">
                        <h3>Time</h3>
                        <div class="pv-analysis-row">
                            <!-- The caption is wrapped so it is ONE flex item: the
                                 label is inline-flex with a gap, and a bare
                                 "t<sub>end</sub>" splits into two items, rendering
                                 as "t end" with a gap down the middle. -->
                            <label><span>t<sub>end</sub></span> <input type="number" data-f="tend" step="1" min="0.1" value="${st.tend}"></label>
                        </div>
                    </div>
                    <div class="pv-analysis-section" data-show="scan sweep">
                        <h3>Swept transition</h3>
                        <select data-f="scanTransition">
                            ${transitionIds.map(t => `<option value="${esc(t)}"${t === st.scanTransition ? ' selected' : ''}>${esc(t)}</option>`).join('')}
                        </select>
                        <div class="pv-analysis-row pv-analysis-range">
                            <label>from <input type="number" data-f="rangeStart" step="0.1" value="${st.range.start}"></label>
                            <label>to <input type="number" data-f="rangeStop" step="0.1" value="${st.range.stop}"></label>
                            <label>steps <input type="number" data-f="rangeN" step="1" min="2" max="25" value="${st.range.n}"></label>
                        </div>
                    </div>
                    <div class="pv-analysis-section" data-show="sweep">
                        <h3>Observed place</h3>
                        <select data-f="sweepObservable">
                            ${placeIds.map(p => `<option value="${esc(p)}"${p === st.sweepObservable ? ' selected' : ''}>${esc(p)}</option>`).join('')}
                        </select>
                    </div>
                    <div class="pv-analysis-section" data-show="phase">
                        <h3>Axes</h3>
                        <label class="pv-analysis-stack">x axis
                            <select data-f="phaseX">${placeIds.map(p => `<option value="${esc(p)}"${p === st.phaseX ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
                        </label>
                        <label class="pv-analysis-stack">y axis
                            <select data-f="phaseY">${placeIds.map(p => `<option value="${esc(p)}"${p === st.phaseY ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select>
                        </label>
                    </div>
                    <div class="pv-analysis-section" data-show="simulate scan">
                        <h3>Places to plot</h3>
                        <div class="pv-analysis-checklist">
                            ${placeIds.map(p => `<label><input type="checkbox" data-place="${esc(p)}"${st.selected.includes(p) ? ' checked' : ''}> ${esc(p)}</label>`).join('')}
                        </div>
                    </div>
                    <div class="pv-analysis-section" data-show="simulate scan sweep phase">
                        <h3>Transition rates</h3>
                        <div class="pv-analysis-rates">
                            ${transitionIds.map(t => `<label>${esc(t)} <input type="number" data-rate="${esc(t)}" step="0.1" min="0" value="${st.rates[t]}"></label>`).join('')}
                        </div>
                    </div>
                    <details class="pv-analysis-section pv-analysis-advanced" data-show="simulate scan sweep phase">
                        <summary>Solver options</summary>
                        <div class="pv-analysis-row">
                            <label>dt <input type="number" data-f="dt" step="0.001" value="${st.dt}"></label>
                            <label>abstol <input type="number" data-f="abstol" step="1e-7" value="${st.abstol}"></label>
                            <label>reltol <input type="number" data-f="reltol" step="1e-4" value="${st.reltol}"></label>
                        </div>
                    </details>
                </div>
                <div class="pv-analysis-main">
                    <div class="pv-analysis-plot"><p class="pv-analysis-placeholder">Press Run — results render here</p></div>
                    <div class="pv-analysis-results"></div>
                </div>
            </div>
            <div class="pv-btn-container pv-analysis-actions">
                <button type="button" class="pv-btn pv-btn-primary" data-act="run">Run</button>
                <button type="button" class="pv-btn" data-act="csv" disabled>CSV</button>
                <button type="button" class="pv-btn" data-act="json" disabled>JSON</button>
                <button type="button" class="pv-btn" data-act="mcp" title="Copy the equivalent petri-pilot MCP tools/call payload">Copy MCP call</button>
                <button type="button" class="pv-btn" data-act="gist" disabled>Export to Gist</button>
                <button type="button" class="pv-btn" data-act="close">Close</button>
            </div>`;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        this._simulationDialog = overlay;

        const $ = (sel) => dialog.querySelector(sel);
        const $$ = (sel) => Array.from(dialog.querySelectorAll(sel));
        const plotEl = $('.pv-analysis-plot');
        const resultsEl = $('.pv-analysis-results');
        const runBtn = $('[data-act="run"]');
        const csvBtn = $('[data-act="csv"]');
        const jsonBtn = $('[data-act="json"]');
        const gistBtn = $('[data-act="gist"]');
        let lastResult = null; // {csv, json, filename}

        const close = () => {
            overlay.remove();
            this._simulationDialog = null;
        };
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
        $$('[data-act="close"]').forEach(b => b.addEventListener('click', close));

        const readState = () => {
            st.tend = Math.max(0.1, parseFloat($('[data-f="tend"]').value) || 10);
            st.dt = parseFloat($('[data-f="dt"]').value) || 0.01;
            st.abstol = parseFloat($('[data-f="abstol"]').value) || 1e-6;
            st.reltol = parseFloat($('[data-f="reltol"]').value) || 1e-3;
            st.scanTransition = $('[data-f="scanTransition"]').value;
            st.range = {
                start: parseFloat($('[data-f="rangeStart"]').value) || 0,
                stop: parseFloat($('[data-f="rangeStop"]').value) || 1,
                n: Math.min(25, Math.max(2, parseInt($('[data-f="rangeN"]').value, 10) || 9)),
            };
            st.sweepObservable = $('[data-f="sweepObservable"]').value;
            st.phaseX = $('[data-f="phaseX"]').value;
            st.phaseY = $('[data-f="phaseY"]').value;
            st.selected = $$('[data-place]').filter(c => c.checked).map(c => c.dataset.place);
            for (const inp of $$('[data-rate]')) {
                const v = parseFloat(inp.value);
                st.rates[inp.dataset.rate] = isNaN(v) ? 1.0 : v;
            }
        };

        const showTab = (tabId) => {
            st.tab = tabId;
            $$('.pv-analysis-tab').forEach(b => {
                const on = b.dataset.tab === tabId;
                b.classList.toggle('pv-active', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            $('.pv-analysis-hint').textContent = TABS.find(t => t.id === tabId).hint;
            $$('[data-show]').forEach(el => {
                el.style.display = el.dataset.show.split(' ').includes(tabId) ? '' : 'none';
            });
            gistBtn.style.display = tabId === 'simulate' ? '' : 'none';
        };
        $$('.pv-analysis-tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
        showTab(st.tab);

        const resultsTable = (headers, rows) => {
            resultsEl.innerHTML = `<table class="pv-analysis-table"><thead><tr>${
                headers.map(h => `<th>${esc(h)}</th>`).join('')
            }</tr></thead><tbody>${
                rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="pv-num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')
            }</tbody></table>`;
        };
        const toCSV = (headers, rows) =>
            [headers, ...rows].map(r => r.map(c => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\n');
        const fmt = (v) => typeof v === 'number' ? +v.toPrecision(6) : v;

        const renderPlot = (plotter) => {
            const result = { svg: plotter.render(), plotData: plotter.lastPlotData };
            plotEl.innerHTML = result.svg;
            this._solverModule.SVGPlotter.setupInteractivity(result.plotData);
            return result;
        };

        const runners = {
            simulate: () => {
                if (st.selected.length === 0) throw new Error('Select at least one place to plot');
                const { net, sol } = this._odeSolve(st.rates, [0, st.tend], st);
                const P = this._solverModule.SVGPlotter;
                const plotter = new P(860, 420);
                plotter.setTitle('ODE simulation · Tsit5').setXLabel('Time').setYLabel('Token count');
                const keep = this._downsample(sol.t);
                for (const v of st.selected) {
                    const y = sol.getVariable(v);
                    plotter.addSeries(keep.map(i => sol.t[i]), keep.map(i => y[i]), v);
                }
                const plotResult = renderPlot(plotter);
                const initial = this._solverModule.setState(net);
                const final = sol.getFinalState();
                const rows = Object.keys(final).map(p => [p, fmt(initial[p] ?? 0), fmt(final[p]), fmt(final[p] - (initial[p] ?? 0))]);
                resultsTable(['Place', 'Initial', 'Final', 'Δ'], rows);
                // Feed the Gist exporter (kept API: reads this._lastODESimulation)
                this._lastODESimulation = {
                    svg: plotResult.svg, selectedVars: st.selected, rates: { ...st.rates },
                    tstart: 0, tend: st.tend, dt: st.dt, abstol: st.abstol, reltol: st.reltol,
                    solution: sol, net,
                };
                if (this._authInitialized && this._user) gistBtn.disabled = false;
                const headers = ['t', ...st.selected];
                const series = st.selected.map(v => sol.getVariable(v));
                const csvRows = sol.t.map((t, i) => [t, ...series.map(s => s[i])]);
                return {
                    csv: toCSV(headers, csvRows),
                    json: { tool: 'petri_ode', tspan: [0, st.tend], rates: st.rates, t: sol.t, series: Object.fromEntries(st.selected.map((v, i) => [v, series[i]])), final },
                    filename: 'ode-simulation',
                };
            },
            scan: () => {
                if (st.selected.length === 0) throw new Error('Select at least one place to observe');
                const values = [];
                for (let i = 0; i < st.range.n; i++) {
                    values.push(st.range.start + (st.range.stop - st.range.start) * i / (st.range.n - 1));
                }
                const finals = values.map(v => {
                    const { sol } = this._odeSolve({ ...st.rates, [st.scanTransition]: v }, [0, st.scanTend ?? Math.max(50, st.tend)], st);
                    return sol.getFinalState();
                });
                const P = this._solverModule.SVGPlotter;
                const plotter = new P(860, 420);
                plotter.setTitle(`Steady state vs rate(${st.scanTransition})`).setXLabel(`rate(${st.scanTransition})`).setYLabel('Token count');
                for (const p of st.selected) {
                    plotter.addSeries(values, finals.map(f => f[p] ?? 0), p, null, { markers: true });
                }
                renderPlot(plotter);
                resultsTable([`rate(${st.scanTransition})`, ...st.selected],
                    values.map((v, i) => [fmt(v), ...st.selected.map(p => fmt(finals[i][p] ?? 0))]));
                return {
                    csv: toCSV([`rate`, ...st.selected], values.map((v, i) => [v, ...st.selected.map(p => finals[i][p] ?? 0)])),
                    json: { tool: 'petri_rate_scan', transition: st.scanTransition, values, observables: st.selected, results: finals },
                    filename: `rate-scan-${st.scanTransition}`,
                };
            },
            sweep: () => {
                const values = [];
                for (let i = 0; i < st.range.n; i++) {
                    values.push(st.range.start + (st.range.stop - st.range.start) * i / (st.range.n - 1));
                }
                const P = this._solverModule.SVGPlotter;
                const plotter = new P(860, 420);
                plotter.setTitle(`${st.sweepObservable} across rate(${st.scanTransition})`).setXLabel('Time').setYLabel(st.sweepObservable);
                const trajectories = [];
                for (const v of values) {
                    const { sol } = this._odeSolve({ ...st.rates, [st.scanTransition]: v }, [0, st.tend], st);
                    const y = sol.getVariable(st.sweepObservable);
                    const keep = this._downsample(sol.t);
                    plotter.addSeries(keep.map(i => sol.t[i]), keep.map(i => y[i]), `k=${+v.toPrecision(3)}`);
                    trajectories.push({ rate: v, final: y[y.length - 1] });
                }
                renderPlot(plotter);
                resultsTable([`rate(${st.scanTransition})`, `${st.sweepObservable} final`],
                    trajectories.map(tr => [fmt(tr.rate), fmt(tr.final)]));
                return {
                    csv: toCSV(['rate', 'final'], trajectories.map(tr => [tr.rate, tr.final])),
                    json: { tool: 'petri_ode_sweep', transition: st.scanTransition, observable: st.sweepObservable, trajectories },
                    filename: `sweep-${st.scanTransition}-${st.sweepObservable}`,
                };
            },
            phase: () => {
                const { sol } = this._odeSolve(st.rates, [0, st.tend], st);
                const xs = sol.getVariable(st.phaseX);
                const ys = sol.getVariable(st.phaseY);
                const keep = this._downsample(xs);
                const P = this._solverModule.SVGPlotter;
                const plotter = new P(860, 460, { hoverMode: 'point', clampYZero: false });
                plotter.setTitle(`Phase: ${st.phaseY} vs ${st.phaseX}`).setXLabel(st.phaseX).setYLabel(st.phaseY);
                plotter.addSeries(keep.map(i => xs[i]), keep.map(i => ys[i]), 'trajectory');
                // start / end markers as tiny series
                plotter.addSeries([xs[0]], [ys[0]], 'start', null, { markers: true });
                plotter.addSeries([xs[xs.length - 1]], [ys[ys.length - 1]], 'end', null, { markers: true });
                renderPlot(plotter);
                resultsTable(['', st.phaseX, st.phaseY], [
                    ['start', fmt(xs[0]), fmt(ys[0])],
                    ['end', fmt(xs[xs.length - 1]), fmt(ys[ys.length - 1])],
                ]);
                return {
                    csv: toCSV(['t', st.phaseX, st.phaseY], sol.t.map((t, i) => [t, xs[i], ys[i]])),
                    json: { tool: 'petri_phase_plot', placeX: st.phaseX, placeY: st.phaseY, t: sol.t, x: xs, y: ys },
                    filename: `phase-${st.phaseX}-${st.phaseY}`,
                };
            },
        };

        runBtn.addEventListener('click', async () => {
            readState();
            runBtn.disabled = true;
            runBtn.textContent = 'Running…';
            await new Promise(r => setTimeout(r, 10)); // let the button repaint
            try {
                lastResult = runners[st.tab]();
                csvBtn.disabled = false;
                jsonBtn.disabled = false;
            } catch (err) {
                console.error('Analysis error:', err);
                this._toast('Analysis failed: ' + err.message, 'error');
                plotEl.innerHTML = `<p class="pv-analysis-error">${this._escHtml(err.message)}</p>`;
                resultsEl.innerHTML = '';
            } finally {
                runBtn.disabled = false;
                runBtn.textContent = 'Run';
            }
        });

        csvBtn.addEventListener('click', () => {
            if (lastResult) this._downloadFile(lastResult.filename + '.csv', lastResult.csv, 'text/csv');
        });
        jsonBtn.addEventListener('click', () => {
            if (lastResult) this._downloadFile(lastResult.filename + '.json', JSON.stringify(lastResult.json, null, 2), 'application/json');
        });
        gistBtn.addEventListener('click', () => this._exportODESimulationToGist({}));
        $('[data-act="mcp"]').addEventListener('click', () => {
            readState();
            const calls = {
                simulate: () => this._pilotCall('petri_ode', { rates: JSON.stringify(st.rates), tspan: `[0,${st.tend}]` }),
                scan: () => this._pilotCall('petri_rate_scan', {
                    transition: st.scanTransition,
                    range: `[${st.range.start},${st.range.stop},${st.range.n}]`,
                    observables: JSON.stringify(st.selected),
                    fixed_rates: JSON.stringify(st.rates),
                }),
                sweep: () => this._pilotCall('petri_ode_sweep', {
                    transition: st.scanTransition,
                    observable: st.sweepObservable,
                    range: `[${st.range.start},${st.range.stop},${st.range.n}]`,
                    fixed_rates: JSON.stringify(st.rates),
                    tspan: `[0,${st.tend}]`,
                }),
                phase: () => this._pilotCall('petri_phase_plot', {
                    place_x: st.phaseX, place_y: st.phaseY,
                    rates: JSON.stringify(st.rates), tspan: `[0,${st.tend}]`,
                }),
            };
            const payload = calls[st.tab]();
            navigator.clipboard.writeText(payload).then(
                () => this._toast('MCP tools/call payload copied — POST it to https://pilot.pflow.xyz/mcp'),
                () => this._toast('Clipboard unavailable', 'error'),
            );
        });

        dialog.tabIndex = -1;
        dialog.focus();
    }

    async _exportODESimulationToGist(params) {
        // Check if simulation has been run
        if (!this._lastODESimulation) {
            this._toast('Please run a simulation first before exporting to Gist', 'error');
            return;
        }

        // Check if authenticated
        if (!this._authInitialized || !this._user) {
            this._toast('GitHub authentication required. Please log in to export to Gist.', 'error');
            return;
        }

        // First, ensure the document is saved and we have a CID
        const urlParams = new URLSearchParams(window.location.search);
        let cid = urlParams.get('cid');
        
        // If no CID in URL, we need to save first
        if (!cid) {
            try {
                // Get the auth token
                const authToken = this._authToken;

                if (!authToken) {
                    this._toast('Please log in to save the diagram before exporting', 'error');
                    return;
                }

                // Save the document
                const canonicalData = JSON.stringify(this._model);

                const response = await fetch('/api/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${authToken}`,
                    },
                    body: canonicalData
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('Save failed with status', response.status, errorText);
                    this._toast(`Failed to save before creating Gist: ${response.statusText}`, 'error');
                    return;
                }

                const result = await response.json();
                cid = result.cid;

                // Update URL with CID
                const url = new URL(window.location.origin + window.location.pathname);
                url.searchParams.set('cid', cid);
                window.history.pushState({}, '', url.toString());
            } catch (err) {
                console.error('Failed to save before creating Gist:', err);
                this._toast('Failed to save document: ' + (err && err.message ? err.message : String(err)), 'error');
                return;
            }
        }

        // Generate simulation details markdown for manual Gist creation
        const sim = this._lastODESimulation;
        const currentUrl = window.location.origin;
        const svgUrl = `${currentUrl}/img/${cid}.svg`;
        const docUrl = `${currentUrl}/?cid=${cid}`;
        const diagramMarkdown = `[![pflow](${svgUrl})](${docUrl})`;

        // Generate description with simulation parameters and results
        let description = '# Petri Net ODE Simulation Results\n\n';
        description += diagramMarkdown + '\n\n';
        
        // Add simulation parameters
        description += '## Simulation Parameters\n\n';
        description += `- **Time Span**: ${sim.tstart} to ${sim.tend}\n`;
        description += `- **Initial Step**: ${sim.dt}\n`;
        description += `- **Absolute Tolerance**: ${sim.abstol}\n`;
        description += `- **Relative Tolerance**: ${sim.reltol}\n`;
        description += `- **Solver**: Tsit5 (5th order Runge-Kutta)\n\n`;

        // Add place information
        description += '## Places\n\n';
        const placeEntries = Array.from(sim.net.places);
        if (placeEntries.length > 0) {
            description += '| Place | Initial Tokens | Capacity |\n';
            description += '|-------|----------------|----------|\n';
            for (const [id, place] of placeEntries) {
                const initial = place.initial.reduce((a, b) => a + b, 0);
                const capacity = place.capacity && place.capacity.length > 0 && place.capacity[0] !== 0 
                    ? place.capacity[0] 
                    : '∞';
                const label = place.label || id;
                description += `| ${label} | ${initial} | ${capacity} |\n`;
            }
            description += '\n';
        }

        // Add transition rates
        description += '## Transition Rates\n\n';
        const rateEntries = Object.entries(sim.rates);
        if (rateEntries.length > 0) {
            description += '| Transition | Rate |\n';
            description += '|------------|------|\n';
            for (const [id, rate] of rateEntries) {
                const transition = sim.net.transitions.get(id);
                const label = transition?.label || id;
                description += `| ${label} | ${rate} |\n`;
            }
            description += '\n';
        }

        // Add plotted variables
        description += '## Plotted Variables\n\n';
        description += sim.selectedVars.map(v => `- ${v}`).join('\n');
        description += '\n\n';

        // Add final state
        description += '## Final State\n\n';
        const finalState = sim.solution.getFinalState();
        description += '| Place | Final Tokens |\n';
        description += '|-------|-------------|\n';
        for (const [id, place] of placeEntries) {
            const label = place.label || id;
            if (finalState[id] !== undefined) {
                const finalValue = finalState[id].toFixed(4);
                description += `| ${label} | ${finalValue} |\n`;
            }
        }
        description += '\n\n';

        description += '---\n';
        description += '*Generated by [pflow-xyz](https://pflow.xyz) ODE Simulation*\n';

        // Create gist via GitHub API
        const authToken = this._authToken;
        if (!authToken) {
            this._toast('Please log in to export to Gist', 'error');
            return;
        }

        try {
            const gistResponse = await fetch('https://api.github.com/gists', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${authToken}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    description: 'pflow ODE Simulation Results',
                    public: true,
                    files: {
                        [`${cid}.md`]: {
                            content: description
                        }
                    }
                })
            });

            if (!gistResponse.ok) {
                const errorText = await gistResponse.text();
                console.error('Gist creation failed:', gistResponse.status, errorText);
                this._toast(`Failed to create Gist: ${gistResponse.statusText}`, 'error');
                return;
            }

            const gistResult = await gistResponse.json();
            const gistUrl = gistResult.html_url;

            // Open the gist in a new tab
            window.open(gistUrl, '_blank');
        } catch (err) {
            console.error('Failed to create Gist:', err);
            this._toast('Failed to create Gist: ' + (err && err.message ? err.message : String(err)), 'error');
        }
    }

    /**
     * Evaluate objective function for optimization
     * Returns the final value of target place given transition rates
     */

    // ---------------- layout algorithms dialog ----------------
    _showLayoutAlgorithmsDialog() {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pv-layout-overlay';

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-layout-dialog';

        // Title
        const title = document.createElement('h2');
        title.className = 'pv-layout-dialog-title';
        title.textContent = 'Layout Algorithms';
        dialog.appendChild(title);

        // Description
        const desc = document.createElement('p');
        desc.className = 'pv-layout-dialog-desc';
        desc.textContent = 'Apply a layout algorithm to automatically arrange your Petri net nodes:';
        dialog.appendChild(desc);

        // Layout options container
        const optionsContainer = document.createElement('div');
        optionsContainer.className = 'pv-layout-options';

        const createLayoutButton = (name, description, iconEmoji, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'pv-layout-option';

            const header = document.createElement('div');
            header.className = 'pv-layout-option-header';

            const icon = document.createElement('span');
            icon.className = 'pv-layout-option-icon';
            icon.textContent = iconEmoji;
            header.appendChild(icon);

            const nameEl = document.createElement('span');
            nameEl.className = 'pv-layout-option-name';
            nameEl.textContent = name;
            header.appendChild(nameEl);

            button.appendChild(header);

            const descEl = document.createElement('div');
            descEl.className = 'pv-layout-option-desc';
            descEl.textContent = description;
            button.appendChild(descEl);

            button.addEventListener('click', () => {
                onClick();
                document.body.removeChild(overlay);
            });

            return button;
        };

        // Add layout algorithm buttons
        optionsContainer.appendChild(createLayoutButton(
            'Sugiyama',
            'Layered layout with cycle-breaking and crossing minimization, ideal for workflows',
            '📊',
            () => this._applySugiyamaLayout()
        ));

        optionsContainer.appendChild(createLayoutButton(
            'Grid',
            'Arranges nodes on a grid sorted by connectivity, good for dense nets',
            '⊞',
            () => this._applyGridLayout()
        ));

        optionsContainer.appendChild(createLayoutButton(
            'Bipartite',
            'Places on the left, transitions on the right, sorted to minimize crossings',
            '⇄',
            () => this._applyBipartiteLayout()
        ));

        optionsContainer.appendChild(createLayoutButton(
            'Circular',
            'Arranges all nodes in a circle, good for visualizing cyclic relationships',
            '⭕',
            () => this._applyCircularLayout()
        ));

        optionsContainer.appendChild(createLayoutButton(
            'String Diagram',
            'Monoidal layout: transitions as boxes, places as wires flowing top-to-bottom',
            '🧵',
            () => this._showStringDiagramModal()
        ));

        dialog.appendChild(optionsContainer);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'pv-layout-close-btn';
        closeBtn.textContent = 'Cancel';
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        dialog.appendChild(closeBtn);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // ---------------- layout algorithm implementations ----------------

    /**
     * Normalize node positions to ensure all coordinates are >= minMargin
     * @param {number} minMargin - Minimum margin from 0 (default: 100)
     */
    _normalizeNodePositions(minMargin = 100) {
        // Find current bounds
        let minX = Infinity, minY = Infinity;
        
        for (const place of Object.values(this._model.places || {})) {
            if (place.x !== undefined) minX = Math.min(minX, place.x);
            if (place.y !== undefined) minY = Math.min(minY, place.y);
        }
        
        for (const transition of Object.values(this._model.transitions || {})) {
            if (transition.x !== undefined) minX = Math.min(minX, transition.x);
            if (transition.y !== undefined) minY = Math.min(minY, transition.y);
        }
        
        // Calculate offset needed to ensure minimum margin
        const offsetX = minX < minMargin ? minMargin - minX : 0;
        const offsetY = minY < minMargin ? minMargin - minY : 0;
        
        // Apply offset if needed
        if (offsetX > 0 || offsetY > 0) {
            for (const place of Object.values(this._model.places || {})) {
                if (place.x !== undefined) place.x += offsetX;
                if (place.y !== undefined) place.y += offsetY;
            }
            
            for (const transition of Object.values(this._model.transitions || {})) {
                if (transition.x !== undefined) transition.x += offsetX;
                if (transition.y !== undefined) transition.y += offsetY;
            }
        }
    }

    _applySugiyamaLayout() {
        this._pushHistory();

        const nodes = new Map();
        for (const [id] of Object.entries(this._model.places || {})) {
            nodes.set(id, { id, type: 'place', level: -1 });
        }
        for (const [id] of Object.entries(this._model.transitions || {})) {
            nodes.set(id, { id, type: 'transition', level: -1 });
        }
        if (nodes.size === 0) return;

        // Build adjacency lists
        const outgoing = new Map();
        const incoming = new Map();
        for (const [id] of nodes) {
            outgoing.set(id, []);
            incoming.set(id, []);
        }
        for (const arc of (this._model.arcs || [])) {
            if (nodes.has(arc.source) && nodes.has(arc.target)) {
                outgoing.get(arc.source).push(arc.target);
                incoming.get(arc.target).push(arc.source);
            }
        }

        // Phase 1: DFS cycle-breaking
        const visited = new Set();
        const onStack = new Set();
        const backEdges = new Set();
        const dfs = (id) => {
            visited.add(id);
            onStack.add(id);
            for (const t of outgoing.get(id)) {
                if (!visited.has(t)) dfs(t);
                else if (onStack.has(t)) backEdges.add(`${id}->${t}`);
            }
            onStack.delete(id);
        };
        for (const [id] of nodes) {
            if (!visited.has(id)) dfs(id);
        }

        // Phase 2: Longest-path level assignment (ignoring back edges)
        for (const [id] of nodes) {
            let effectiveIn = 0;
            for (const src of incoming.get(id)) {
                if (!backEdges.has(`${src}->${id}`)) effectiveIn++;
            }
            if (effectiveIn === 0) nodes.get(id).level = 0;
        }
        let changed = true;
        while (changed) {
            changed = false;
            for (const [id, node] of nodes) {
                if (node.level < 0) continue;
                for (const t of outgoing.get(id)) {
                    if (backEdges.has(`${id}->${t}`)) continue;
                    const newLevel = node.level + 1;
                    if (newLevel > nodes.get(t).level) {
                        nodes.get(t).level = newLevel;
                        changed = true;
                    }
                }
            }
        }
        for (const [, node] of nodes) {
            if (node.level < 0) node.level = 0;
        }

        // Group by level
        const levels = new Map();
        let maxLevel = 0;
        for (const [, node] of nodes) {
            if (!levels.has(node.level)) levels.set(node.level, []);
            levels.get(node.level).push(node);
            maxLevel = Math.max(maxLevel, node.level);
        }

        // Phase 3: Barycenter crossing minimization (4 passes, 2 sweeps each)
        const posOf = new Map();
        for (let lvl = 0; lvl <= maxLevel; lvl++) {
            (levels.get(lvl) || []).forEach((n, i) => posOf.set(n.id, i));
        }

        for (let pass = 0; pass < 4; pass++) {
            // Down sweep
            for (let lvl = 1; lvl <= maxLevel; lvl++) {
                const layer = levels.get(lvl) || [];
                const bary = new Map();
                for (const node of layer) {
                    let sum = 0, count = 0;
                    for (const src of incoming.get(node.id)) {
                        if (backEdges.has(`${src}->${node.id}`)) continue;
                        if (nodes.get(src).level === lvl - 1) {
                            sum += posOf.get(src);
                            count++;
                        }
                    }
                    bary.set(node.id, count > 0 ? sum / count : posOf.get(node.id));
                }
                layer.sort((a, b) => bary.get(a.id) - bary.get(b.id));
                layer.forEach((n, i) => posOf.set(n.id, i));
            }
            // Up sweep
            for (let lvl = maxLevel - 1; lvl >= 0; lvl--) {
                const layer = levels.get(lvl) || [];
                const bary = new Map();
                for (const node of layer) {
                    let sum = 0, count = 0;
                    for (const tgt of outgoing.get(node.id)) {
                        if (backEdges.has(`${node.id}->${tgt}`)) continue;
                        if (nodes.get(tgt).level === lvl + 1) {
                            sum += posOf.get(tgt);
                            count++;
                        }
                    }
                    bary.set(node.id, count > 0 ? sum / count : posOf.get(node.id));
                }
                layer.sort((a, b) => bary.get(a.id) - bary.get(b.id));
                layer.forEach((n, i) => posOf.set(n.id, i));
            }
        }

        // Phase 4: Assign coordinates
        const levelSpacing = 150;
        const nodeSpacing = 120;
        const startY = 100;

        for (let lvl = 0; lvl <= maxLevel; lvl++) {
            const layer = levels.get(lvl) || [];
            const totalWidth = (layer.length - 1) * nodeSpacing;
            const startX = 400 - totalWidth / 2;

            layer.forEach((node, i) => {
                const x = Math.round(startX + i * nodeSpacing);
                const y = Math.round(startY + lvl * levelSpacing);
                if (node.type === 'place') {
                    this._model.places[node.id].x = x;
                    this._model.places[node.id].y = y;
                } else {
                    this._model.transitions[node.id].x = x;
                    this._model.transitions[node.id].y = y;
                }
            });
        }

        this._normalizeNodePositions(100);
        this._renderUI();
        this._syncLD();
    }

    _applyGridLayout() {
        this._pushHistory();

        const places = Object.keys(this._model.places || {});
        const transitions = Object.keys(this._model.transitions || {});
        const totalNodes = places.length + transitions.length;
        if (totalNodes === 0) return;

        // Compute degree for each node
        const degree = {};
        for (const arc of (this._model.arcs || [])) {
            degree[arc.source] = (degree[arc.source] || 0) + 1;
            degree[arc.target] = (degree[arc.target] || 0) + 1;
        }

        // Collect all nodes with type
        const nodeList = [];
        for (const id of places) nodeList.push({ id, type: 'place', degree: degree[id] || 0 });
        for (const id of transitions) nodeList.push({ id, type: 'transition', degree: degree[id] || 0 });

        // Sort by degree descending
        nodeList.sort((a, b) => b.degree - a.degree);

        // Grid parameters
        const cols = Math.ceil(Math.sqrt(totalNodes));
        const spacing = 120;
        const rows = Math.ceil(totalNodes / cols);
        const totalWidth = (cols - 1) * spacing;
        const totalHeight = (rows - 1) * spacing;
        const offsetX = 400 - totalWidth / 2;
        const offsetY = 300 - totalHeight / 2;

        for (let i = 0; i < nodeList.length; i++) {
            const node = nodeList[i];
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = Math.round(offsetX + col * spacing);
            const y = Math.round(offsetY + row * spacing);

            if (node.type === 'place') {
                this._model.places[node.id].x = x;
                this._model.places[node.id].y = y;
            } else {
                this._model.transitions[node.id].x = x;
                this._model.transitions[node.id].y = y;
            }
        }

        this._normalizeNodePositions(100);
        this._renderUI();
        this._syncLD();
    }

    _applyBipartiteLayout() {
        this._pushHistory();

        const placeIds = Object.keys(this._model.places || {});
        const transitionIds = Object.keys(this._model.transitions || {});
        if (placeIds.length + transitionIds.length === 0) return;

        // Build neighbor map (regardless of arc direction)
        const neighbors = {};
        for (const arc of (this._model.arcs || [])) {
            if (!neighbors[arc.source]) neighbors[arc.source] = [];
            if (!neighbors[arc.target]) neighbors[arc.target] = [];
            neighbors[arc.source].push(arc.target);
            neighbors[arc.target].push(arc.source);
        }

        // Working copies
        const places = placeIds.slice();
        const transitions = transitionIds.slice();

        // Assign initial positions
        const posOf = {};
        places.forEach((id, i) => posOf[id] = i);
        transitions.forEach((id, i) => posOf[id] = i);

        // Barycenter sort: 4 iterations alternating columns
        for (let iter = 0; iter < 4; iter++) {
            // Sort transitions by barycenter of neighboring places
            const tBary = {};
            for (const id of transitions) {
                let sum = 0, count = 0;
                for (const nb of (neighbors[id] || [])) {
                    if (this._model.places && this._model.places[nb]) {
                        sum += posOf[nb];
                        count++;
                    }
                }
                tBary[id] = count > 0 ? sum / count : posOf[id];
            }
            transitions.sort((a, b) => tBary[a] - tBary[b]);
            transitions.forEach((id, i) => posOf[id] = i);

            // Sort places by barycenter of neighboring transitions
            const pBary = {};
            for (const id of places) {
                let sum = 0, count = 0;
                for (const nb of (neighbors[id] || [])) {
                    if (this._model.transitions && this._model.transitions[nb]) {
                        sum += posOf[nb];
                        count++;
                    }
                }
                pBary[id] = count > 0 ? sum / count : posOf[id];
            }
            places.sort((a, b) => pBary[a] - pBary[b]);
            places.forEach((id, i) => posOf[id] = i);
        }

        // Assign coordinates
        const colGap = 300;
        const vSpacing = 120;
        const leftX = 250;
        const rightX = leftX + colGap;
        const centerY = 300;

        const placeHeight = (places.length - 1) * vSpacing;
        const transHeight = (transitions.length - 1) * vSpacing;
        const placeStartY = centerY - placeHeight / 2;
        const transStartY = centerY - transHeight / 2;

        places.forEach((id, i) => {
            this._model.places[id].x = leftX;
            this._model.places[id].y = Math.round(placeStartY + i * vSpacing);
        });
        transitions.forEach((id, i) => {
            this._model.transitions[id].x = rightX;
            this._model.transitions[id].y = Math.round(transStartY + i * vSpacing);
        });

        this._normalizeNodePositions(100);
        this._renderUI();
        this._syncLD();
    }

    _applyCircularLayout() {
        // Save state for undo
        this._pushHistory();

        // Get all nodes
        const nodes = [];
        for (const id of Object.keys(this._model.places || {})) {
            nodes.push({ id, type: 'place' });
        }
        for (const id of Object.keys(this._model.transitions || {})) {
            nodes.push({ id, type: 'transition' });
        }

        if (nodes.length === 0) return;

        // Layout parameters
        const centerX = 500;
        const centerY = 400;
        const radius = Math.min(300, 50 + nodes.length * 15);

        // Position nodes in a circle
        nodes.forEach((node, index) => {
            const angle = (2 * Math.PI * index) / nodes.length - Math.PI / 2; // Start at top
            const x = Math.round(centerX + radius * Math.cos(angle));
            const y = Math.round(centerY + radius * Math.sin(angle));

            if (node.type === 'place') {
                this._model.places[node.id].x = x;
                this._model.places[node.id].y = y;
            } else {
                this._model.transitions[node.id].x = x;
                this._model.transitions[node.id].y = y;
            }
        });

        // Ensure all coordinates are non-negative
        this._normalizeNodePositions(100);

        // Update the view
        this._renderUI();
        this._syncLD();
    }

    async _showStringDiagramModal() {
        await import('./diagram-viewer.js');

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#fff;border-radius:12px;padding:20px;max-width:90vw;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.3);';

        // Header with title and close button
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
        const title = document.createElement('h2');
        title.textContent = 'String Diagram';
        title.style.cssText = 'margin:0;font-size:1.2em;';
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u00d7';
        closeBtn.style.cssText = 'border:none;background:none;font-size:1.5em;cursor:pointer;padding:4px 8px;';
        closeBtn.addEventListener('click', () => document.body.removeChild(overlay));
        header.appendChild(title);
        header.appendChild(closeBtn);
        dialog.appendChild(header);

        // SVG container using <diagram-viewer>
        const svgContainer = document.createElement('div');
        svgContainer.style.cssText = 'overflow:auto;flex:1;min-height:200px;';
        const viewer = document.createElement('diagram-viewer');
        viewer.model = this._model;
        svgContainer.appendChild(viewer);
        dialog.appendChild(svgContainer);

        // Download button
        const downloadBtn = document.createElement('button');
        downloadBtn.textContent = 'Download SVG';
        downloadBtn.style.cssText = 'margin-top:12px;padding:8px 16px;border:1px solid #ccc;border-radius:6px;background:#f5f5f5;cursor:pointer;align-self:flex-end;';
        downloadBtn.addEventListener('click', () => {
            const svgContent = viewer.svgString;
            const blob = new Blob([svgContent], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'string-diagram.svg';
            a.click();
            URL.revokeObjectURL(url);
        });
        dialog.appendChild(downloadBtn);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) document.body.removeChild(overlay);
        });
    }

    _applyStringDiagramLayout() {
        this._pushHistory();

        const transitionIds = Object.keys(this._model.transitions || {});
        const placeIds = Object.keys(this._model.places || {});
        if (transitionIds.length + placeIds.length === 0) return;

        // Phase 1: Build transition-only DAG mediated by places
        // For each place, find input transitions (T→P) and output transitions (P→T)
        const placeInputs = {};  // place -> [transitions that feed into it]
        const placeOutputs = {}; // place -> [transitions it feeds into]
        for (const id of placeIds) {
            placeInputs[id] = [];
            placeOutputs[id] = [];
        }
        for (const arc of (this._model.arcs || [])) {
            if (this._model.transitions && this._model.transitions[arc.source] &&
                this._model.places && this._model.places[arc.target]) {
                // T → P arc
                placeInputs[arc.target].push(arc.source);
            }
            if (this._model.places && this._model.places[arc.source] &&
                this._model.transitions && this._model.transitions[arc.target]) {
                // P → T arc
                placeOutputs[arc.source].push(arc.target);
            }
        }

        // Build transition-to-transition edges (through places)
        const tOutgoing = {};
        const tIncoming = {};
        for (const id of transitionIds) {
            tOutgoing[id] = [];
            tIncoming[id] = [];
        }
        for (const pid of placeIds) {
            for (const src of placeInputs[pid]) {
                for (const tgt of placeOutputs[pid]) {
                    if (src !== tgt) {
                        tOutgoing[src].push(tgt);
                        tIncoming[tgt].push(src);
                    }
                }
            }
        }

        // Phase 2: DFS cycle-breaking on transition graph
        const visited = new Set();
        const onStack = new Set();
        const backEdges = new Set();
        const dfs = (id) => {
            visited.add(id);
            onStack.add(id);
            for (const t of tOutgoing[id]) {
                if (!visited.has(t)) dfs(t);
                else if (onStack.has(t)) backEdges.add(`${id}->${t}`);
            }
            onStack.delete(id);
        };
        for (const id of transitionIds) {
            if (!visited.has(id)) dfs(id);
        }

        // Phase 3: Longest-path layer assignment for transitions
        const tLevel = {};
        for (const id of transitionIds) tLevel[id] = -1;

        // Sources: transitions with no non-back incoming edges
        for (const id of transitionIds) {
            let effectiveIn = 0;
            for (const src of tIncoming[id]) {
                if (!backEdges.has(`${src}->${id}`)) effectiveIn++;
            }
            if (effectiveIn === 0) tLevel[id] = 0;
        }

        let changed = true;
        while (changed) {
            changed = false;
            for (const id of transitionIds) {
                if (tLevel[id] < 0) continue;
                for (const t of tOutgoing[id]) {
                    if (backEdges.has(`${id}->${t}`)) continue;
                    const newLevel = tLevel[id] + 1;
                    if (newLevel > tLevel[t]) {
                        tLevel[t] = newLevel;
                        changed = true;
                    }
                }
            }
        }
        for (const id of transitionIds) {
            if (tLevel[id] < 0) tLevel[id] = 0;
        }

        // Group transitions by layer
        const layers = new Map();
        let maxLayer = 0;
        for (const id of transitionIds) {
            const lvl = tLevel[id];
            if (!layers.has(lvl)) layers.set(lvl, []);
            layers.get(lvl).push(id);
            maxLayer = Math.max(maxLayer, lvl);
        }

        // Phase 4: Barycenter crossing minimization on transition layers
        const posOf = {};
        for (let lvl = 0; lvl <= maxLayer; lvl++) {
            (layers.get(lvl) || []).forEach((id, i) => posOf[id] = i);
        }

        for (let pass = 0; pass < 4; pass++) {
            // Down sweep
            for (let lvl = 1; lvl <= maxLayer; lvl++) {
                const layer = layers.get(lvl) || [];
                const bary = {};
                for (const id of layer) {
                    let sum = 0, count = 0;
                    for (const src of tIncoming[id]) {
                        if (backEdges.has(`${src}->${id}`)) continue;
                        if (tLevel[src] === lvl - 1) {
                            sum += posOf[src];
                            count++;
                        }
                    }
                    bary[id] = count > 0 ? sum / count : posOf[id];
                }
                layer.sort((a, b) => bary[a] - bary[b]);
                layer.forEach((id, i) => posOf[id] = i);
            }
            // Up sweep
            for (let lvl = maxLayer - 1; lvl >= 0; lvl--) {
                const layer = layers.get(lvl) || [];
                const bary = {};
                for (const id of layer) {
                    let sum = 0, count = 0;
                    for (const tgt of tOutgoing[id]) {
                        if (backEdges.has(`${id}->${tgt}`)) continue;
                        if (tLevel[tgt] === lvl + 1) {
                            sum += posOf[tgt];
                            count++;
                        }
                    }
                    bary[id] = count > 0 ? sum / count : posOf[id];
                }
                layer.sort((a, b) => bary[a] - bary[b]);
                layer.forEach((id, i) => posOf[id] = i);
            }
        }

        // Phase 5: Assign transition coordinates
        const layerSpacing = 180;
        const boxSpacing = 120;
        const startY = 100;

        for (let lvl = 0; lvl <= maxLayer; lvl++) {
            const layer = layers.get(lvl) || [];
            const totalWidth = (layer.length - 1) * boxSpacing;
            const startX = 400 - totalWidth / 2;

            layer.forEach((id, i) => {
                this._model.transitions[id].x = Math.round(startX + i * boxSpacing);
                this._model.transitions[id].y = Math.round(startY + lvl * layerSpacing);
            });
        }

        // Phase 6: Position places along wires
        for (const pid of placeIds) {
            const inputs = placeInputs[pid];
            const outputs = placeOutputs[pid];

            if (inputs.length > 0 && outputs.length > 0) {
                // Place on the wire: midpoint between avg source and avg target layers
                let srcLayerSum = 0, srcXSum = 0;
                for (const t of inputs) {
                    srcLayerSum += tLevel[t];
                    srcXSum += this._model.transitions[t].x;
                }
                let tgtLayerSum = 0, tgtXSum = 0;
                for (const t of outputs) {
                    tgtLayerSum += tLevel[t];
                    tgtXSum += this._model.transitions[t].x;
                }
                const avgSrcLayer = srcLayerSum / inputs.length;
                const avgTgtLayer = tgtLayerSum / outputs.length;
                const avgSrcX = srcXSum / inputs.length;
                const avgTgtX = tgtXSum / outputs.length;

                const midLayer = (avgSrcLayer + avgTgtLayer) / 2;
                this._model.places[pid].x = Math.round((avgSrcX + avgTgtX) / 2);
                this._model.places[pid].y = Math.round(startY + midLayer * layerSpacing);
            } else if (inputs.length > 0) {
                // Output boundary: place below its source transitions
                let srcXSum = 0, srcLayerMax = 0;
                for (const t of inputs) {
                    srcXSum += this._model.transitions[t].x;
                    srcLayerMax = Math.max(srcLayerMax, tLevel[t]);
                }
                this._model.places[pid].x = Math.round(srcXSum / inputs.length);
                this._model.places[pid].y = Math.round(startY + (srcLayerMax + 0.5) * layerSpacing);
            } else if (outputs.length > 0) {
                // Input boundary: place above its target transitions
                let tgtXSum = 0, tgtLayerMin = maxLayer;
                for (const t of outputs) {
                    tgtXSum += this._model.transitions[t].x;
                    tgtLayerMin = Math.min(tgtLayerMin, tLevel[t]);
                }
                this._model.places[pid].x = Math.round(tgtXSum / outputs.length);
                this._model.places[pid].y = Math.round(startY + (tgtLayerMin - 0.5) * layerSpacing);
            } else {
                // Disconnected: place at bottom
                this._model.places[pid].x = 400;
                this._model.places[pid].y = Math.round(startY + (maxLayer + 1.5) * layerSpacing);
            }
        }

        this._normalizeNodePositions(100);
        this._renderUI();
        this._syncLD();
    }

    // ---------------- My Diagrams Dialog ----------------
    async _showMyDiagramsDialog() {
        if (!this._authToken) {
            this._toast('Please log in to view your diagrams', 'error');
            return;
        }

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pv-diagrams-overlay';

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-diagrams-dialog';

        // Title
        const title = document.createElement('h2');
        title.className = 'pv-diagrams-title';
        title.textContent = 'My Diagrams';
        dialog.appendChild(title);

        // Loading state
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'pv-diagrams-loading';
        loadingDiv.textContent = 'Loading diagrams...';
        dialog.appendChild(loadingDiv);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Fetch diagrams
        try {
            const response = await fetch('/api/diagrams', {
                headers: {
                    'Authorization': `Bearer ${this._authToken}`
                }
            });

            if (!response.ok) {
                throw new Error('Failed to fetch diagrams');
            }

            const data = await response.json();
            const diagrams = data.diagrams || [];

            // Remove loading
            loadingDiv.remove();

            if (diagrams.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.className = 'pv-diagrams-empty';
                emptyDiv.textContent = 'No diagrams saved yet. Save your current diagram to see it here!';
                dialog.appendChild(emptyDiv);
            } else {
                // Create grid for diagrams
                const grid = document.createElement('div');
                grid.className = 'pv-diagrams-grid';

                for (const diagram of diagrams) {
                    const card = document.createElement('div');
                    card.className = 'pv-diagram-card';

                    // Thumbnail using SVG endpoint
                    const thumbnail = document.createElement('div');
                    thumbnail.className = 'pv-diagram-thumbnail';
                    const img = document.createElement('img');
                    img.src = `/img/${diagram.cid}.svg`;
                    img.alt = diagram.name || 'Petri Net';
                    img.onerror = () => {
                        img.style.display = 'none';
                        thumbnail.textContent = '🔷';
                        thumbnail.style.fontSize = '40px';
                        thumbnail.style.color = '#ccc';
                    };
                    thumbnail.appendChild(img);
                    card.appendChild(thumbnail);

                    // Info section
                    const info = document.createElement('div');
                    info.className = 'pv-diagram-info';

                    const nameEl = document.createElement('div');
                    nameEl.className = 'pv-diagram-name';
                    nameEl.textContent = diagram.name || 'Untitled';
                    nameEl.style.cursor = 'pointer';
                    nameEl.title = 'Click to edit name';
                    nameEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._showEditDiagramDetailsDialog(diagram, nameEl, descEl);
                    });
                    info.appendChild(nameEl);

                    const descEl = document.createElement('div');
                    descEl.className = 'pv-diagram-desc';
                    descEl.textContent = diagram.description || 'Add description...';
                    descEl.style.cursor = 'pointer';
                    if (!diagram.description) {
                        descEl.style.fontStyle = 'italic';
                        descEl.style.color = '#959da5';
                    }
                    descEl.title = 'Click to edit description';
                    descEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this._showEditDiagramDetailsDialog(diagram, nameEl, descEl);
                    });
                    info.appendChild(descEl);

                    const dateEl = document.createElement('div');
                    dateEl.className = 'pv-diagram-date';
                    const date = new Date(diagram.createdAt);
                    dateEl.textContent = date.toLocaleDateString();
                    info.appendChild(dateEl);

                    card.appendChild(info);

                    // Actions
                    const actions = document.createElement('div');
                    actions.className = 'pv-diagram-actions';

                    const openBtn = document.createElement('button');
                    openBtn.className = 'pv-diagram-action-btn pv-diagram-action-btn-open';
                    openBtn.textContent = 'Open';
                    openBtn.type = 'button';
                    openBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        window.location.href = `/?cid=${diagram.cid}`;
                    });
                    actions.appendChild(openBtn);

                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'pv-diagram-action-btn pv-diagram-action-btn-delete';
                    deleteBtn.textContent = 'Delete';
                    deleteBtn.type = 'button';
                    deleteBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        if (confirm(`Delete "${diagram.name || 'this diagram'}"?`)) {
                            try {
                                const delResponse = await fetch(`/o/${diagram.cid}`, {
                                    method: 'DELETE',
                                    headers: {
                                        'Authorization': `Bearer ${this._authToken}`
                                    }
                                });
                                if (delResponse.ok) {
                                    card.remove();
                                    // Check if grid is empty
                                    if (grid.children.length === 0) {
                                        grid.remove();
                                        const emptyDiv = document.createElement('div');
                                        emptyDiv.className = 'pv-diagrams-empty';
                                        emptyDiv.textContent = 'No diagrams saved yet.';
                                        dialog.insertBefore(emptyDiv, dialog.querySelector('button'));
                                    }
                                } else {
                                    this._toast('Failed to delete diagram', 'error');
                                }
                            } catch (err) {
                                this._toast('Failed to delete diagram: ' + err.message, 'error');
                            }
                        }
                    });
                    actions.appendChild(deleteBtn);

                    card.appendChild(actions);
                    grid.appendChild(card);
                }

                dialog.appendChild(grid);
            }
        } catch (err) {
            loadingDiv.textContent = 'Failed to load diagrams: ' + err.message;
            loadingDiv.style.color = '#cb2431';
        }

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'pv-diagrams-close-btn';
        closeBtn.textContent = 'Close';
        closeBtn.type = 'button';
        closeBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        dialog.appendChild(closeBtn);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // ---------------- Edit Remote Diagram Details Dialog ----------------
    async _showEditDiagramDetailsDialog(diagram, nameEl, descEl) {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pv-edit-diagram-overlay';

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-edit-diagram-dialog';

        // Title
        const title = document.createElement('h2');
        title.className = 'pv-edit-diagram-title';
        title.textContent = 'Edit Diagram Details';
        dialog.appendChild(title);

        // Name field
        const nameLabel = document.createElement('label');
        nameLabel.className = 'pv-edit-diagram-label';
        nameLabel.textContent = 'Name';
        dialog.appendChild(nameLabel);

        const nameInput = document.createElement('input');
        nameInput.className = 'pv-edit-diagram-input';
        nameInput.type = 'text';
        nameInput.value = diagram.name || '';
        nameInput.placeholder = 'Enter diagram name';
        dialog.appendChild(nameInput);

        // Description field
        const descLabel = document.createElement('label');
        descLabel.className = 'pv-edit-diagram-label';
        descLabel.textContent = 'Description';
        dialog.appendChild(descLabel);

        const descInput = document.createElement('textarea');
        descInput.className = 'pv-edit-diagram-textarea';
        descInput.value = diagram.description || '';
        descInput.placeholder = 'Enter diagram description';
        descInput.rows = 3;
        dialog.appendChild(descInput);

        // Buttons
        const btnContainer = document.createElement('div');
        btnContainer.className = 'pv-edit-diagram-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'pv-edit-diagram-btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        btnContainer.appendChild(cancelBtn);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'pv-edit-diagram-btn-save';
        saveBtn.textContent = 'Save';
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', async () => {
            const newName = nameInput.value.trim();
            const newDescription = descInput.value.trim();

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';

            try {
                // Fetch the full diagram
                const response = await fetch(`/o/${diagram.cid}`);
                if (!response.ok) {
                    throw new Error('Failed to fetch diagram');
                }
                const diagramData = await response.json();

                // Update name and description
                if (newName) {
                    diagramData.name = newName;
                } else {
                    delete diagramData.name;
                }

                if (newDescription) {
                    diagramData.description = newDescription;
                } else {
                    delete diagramData.description;
                }

                // Remove @id so we get a new CID
                delete diagramData['@id'];

                // Save back to server
                const saveResponse = await fetch('/api/save', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this._authToken}`
                    },
                    body: JSON.stringify(diagramData)
                });

                if (!saveResponse.ok) {
                    throw new Error('Failed to save diagram');
                }

                const saveResult = await saveResponse.json();

                // Update local references
                diagram.name = newName;
                diagram.description = newDescription;
                diagram.cid = saveResult.cid;

                // Update the UI elements
                nameEl.textContent = newName || 'Untitled';
                descEl.textContent = newDescription || 'Add description...';
                descEl.style.color = newDescription ? '#586069' : '#959da5';
                descEl.style.fontStyle = newDescription ? 'normal' : 'italic';

                document.body.removeChild(overlay);
            } catch (err) {
                this._toast('Failed to save: ' + err.message, 'error');
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
            }
        });
        btnContainer.appendChild(saveBtn);

        dialog.appendChild(btnContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Focus name input
        nameInput.focus();
        nameInput.select();

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });

        // Handle Enter key
        nameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                descInput.focus();
            }
        });
    }

    // ---------------- Edit Details Dialog ----------------
    _showEditDetailsDialog() {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pv-edit-diagram-overlay';

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-edit-diagram-dialog';

        // Title
        const title = document.createElement('h2');
        title.className = 'pv-edit-diagram-title';
        title.textContent = 'Edit Diagram Details';
        dialog.appendChild(title);

        // Name field
        const nameLabel = document.createElement('label');
        nameLabel.className = 'pv-edit-diagram-label';
        nameLabel.textContent = 'Name';
        dialog.appendChild(nameLabel);

        const nameInput = document.createElement('input');
        nameInput.className = 'pv-edit-diagram-input';
        nameInput.type = 'text';
        nameInput.value = this._model.name || '';
        nameInput.placeholder = 'Enter diagram name';
        dialog.appendChild(nameInput);

        // Description field
        const descLabel = document.createElement('label');
        descLabel.className = 'pv-edit-diagram-label';
        descLabel.textContent = 'Description';
        dialog.appendChild(descLabel);

        const descInput = document.createElement('textarea');
        descInput.className = 'pv-edit-diagram-textarea';
        descInput.value = this._model.description || '';
        descInput.placeholder = 'Enter diagram description';
        descInput.rows = 3;
        dialog.appendChild(descInput);

        // Buttons
        const btnContainer = document.createElement('div');
        btnContainer.className = 'pv-edit-diagram-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'pv-edit-diagram-btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        btnContainer.appendChild(cancelBtn);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'pv-edit-diagram-btn-save';
        saveBtn.textContent = 'Save';
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', () => {
            const name = nameInput.value.trim();
            const description = descInput.value.trim();

            if (name) {
                this._model.name = name;
            } else {
                delete this._model.name;
            }

            if (description) {
                this._model.description = description;
            } else {
                delete this._model.description;
            }

            this._syncLD();
            this._pushHistory();
            document.body.removeChild(overlay);
        });
        btnContainer.appendChild(saveBtn);

        dialog.appendChild(btnContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Focus name input
        nameInput.focus();

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });
    }

    // ---------------- hamburger menu ----------------
    _createHamburgerMenu() {
        if (this._hamburgerMenu) return;
        if (!this._root) return; // Safety check

        const isBackendMode = this.hasAttribute('data-backend');

        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'pv-hamburger-btn';
        menuBtn.innerHTML = '☰';
        menuBtn.title = 'Menu';

        // Use left-side panel in backend mode, dropdown otherwise
        let menuContainer;
        if (isBackendMode) {
            // Create overlay for left-side panel
            menuContainer = document.createElement('div');
            menuContainer.className = 'pv-hamburger-overlay';
            menuContainer.style.display = 'none';

            // Create left panel
            const panel = document.createElement('div');
            panel.className = 'pv-hamburger-panel';

            // Panel header
            const header = document.createElement('div');
            header.className = 'pv-hamburger-header';

            // Hamburger button inside the panel on the left
            const panelMenuBtn = document.createElement('button');
            panelMenuBtn.type = 'button';
            panelMenuBtn.className = 'pv-hamburger-header-btn';
            panelMenuBtn.innerHTML = '☰';
            panelMenuBtn.title = 'Close Menu';
            panelMenuBtn.addEventListener('click', () => {
                menuContainer.style.display = 'none';
            });
            header.appendChild(panelMenuBtn);

            const title = document.createElement('h3');
            title.className = 'pv-hamburger-title';
            title.textContent = 'Menu';
            header.appendChild(title);

            const closeBtn = document.createElement('button');
            closeBtn.className = 'pv-hamburger-close-btn';
            closeBtn.textContent = '×';
            closeBtn.type = 'button';
            closeBtn.addEventListener('click', () => {
                menuContainer.style.display = 'none';
            });
            header.appendChild(closeBtn);

            panel.appendChild(header);

            // Panel content
            const content = document.createElement('div');
            content.className = 'pv-hamburger-content';
            panel.appendChild(content);

            menuContainer.appendChild(panel);
            menuContainer._menuContent = content;

            // Close on overlay click
            menuContainer.addEventListener('click', (e) => {
                if (e.target === menuContainer) {
                    menuContainer.style.display = 'none';
                }
            });
        } else {
            // Use dropdown for standard mode
            menuContainer = document.createElement('div');
            menuContainer.className = 'pv-hamburger-dropdown';
            menuContainer.style.display = 'none';
            menuContainer._menuContent = menuContainer;
        }

        const makeMenuItem = (text, onClick, icon = null) => {
            const item = document.createElement('div');
            item.className = 'pv-menu-item';

            if (icon) {
                const iconEl = document.createElement('span');
                iconEl.className = 'pv-menu-item-icon';
                iconEl.innerHTML = icon;
                item.appendChild(iconEl);
            }

            const textEl = document.createElement('span');
            textEl.textContent = text;
            item.appendChild(textEl);
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                onClick();
                menuContainer.style.display = 'none';
            });
            return item;
        };

        // Add menu items based on mode
        if (isBackendMode) {
            // Backend mode: Save button text changes based on auth state
            const saveText = (this._authInitialized && this._user)
                ? '💾 Save to Server'
                : '💾 Save Permalink';

            const saveItem = makeMenuItem(saveText, () => {
                this._saveToPermalink();
            });
            menuContainer._menuContent.appendChild(saveItem);

            const deleteItem = makeMenuItem('🗑️ Delete', async () => {
                await this._deleteData();
            });
            menuContainer._menuContent.appendChild(deleteItem);

            // Add Share button (only for logged-in users)
            if (this._authInitialized && this._user) {
                const shareItem = makeMenuItem('🔗 Share', async () => {
                    await this._showShareDialog();
                });
                menuContainer._menuContent.appendChild(shareItem);

                // Add Save As Gist button (only for logged-in users)
                const saveAsGistItem = makeMenuItem('📝 Save As Gist', async () => {
                    await this._saveAsGist();
                });
                menuContainer._menuContent.appendChild(saveAsGistItem);

                // Add My Diagrams button (only for logged-in users)
                const myDiagramsItem = makeMenuItem('📂 My Diagrams', async () => {
                    await this._showMyDiagramsDialog();
                });
                menuContainer._menuContent.appendChild(myDiagramsItem);

                // Add Edit Details button (only for logged-in users)
                const editDetailsItem = makeMenuItem('✏️ Edit Details', () => {
                    this._showEditDetailsDialog();
                });
                menuContainer._menuContent.appendChild(editDetailsItem);
            }

            // Add separator
            const separator = document.createElement('div');
            separator.className = 'pv-hamburger-separator';
            menuContainer._menuContent.appendChild(separator);

            // Add Login/Logout if in backend mode
            if (this._authInitialized) {
                if (this._user) {
                    // Show user info and logout button
                    const userInfo = document.createElement('div');
                    userInfo.className = 'pv-hamburger-user-info';
                    const userEmail = this._user.email || this._user.user_metadata?.user_name || 'User';
                    userInfo.textContent = `Logged in as: ${userEmail}`;
                    menuContainer._menuContent.appendChild(userInfo);

                    const logoutItem = makeMenuItem('🚪 Logout', () => {
                        this._logout();
                    });
                    menuContainer._menuContent.appendChild(logoutItem);

                    // Add separator
                    const separator2 = document.createElement('div');
                    separator2.className = 'pv-hamburger-separator';
                    menuContainer._menuContent.appendChild(separator2);
                } else {
                    // Show login button
                    const loginItem = makeMenuItem('🔑 Login with GitHub', () => {
                        this._loginWithGitHub();
                    });
                    menuContainer._menuContent.appendChild(loginItem);

                    // Add separator
                    const separator2 = document.createElement('div');
                    separator2.className = 'pv-hamburger-separator';
                    menuContainer._menuContent.appendChild(separator2);
                }
            } else {
                // Auth not yet initialized, show login button
                const loginItem = makeMenuItem('🔑 Login with GitHub', () => {
                    this._loginWithGitHub();
                });
                menuContainer._menuContent.appendChild(loginItem);

                // Add separator
                const separator2 = document.createElement('div');
                separator2.className = 'pv-hamburger-separator';
                menuContainer._menuContent.appendChild(separator2);
            }
        }

        // Standard menu items
        const simulationItem = makeMenuItem('🧮 Analysis (ODE, scans, phase)', () => {
            this._showSimulationDialog();
        });
        menuContainer._menuContent.appendChild(simulationItem);
        
        const layoutAlgoItem = makeMenuItem('🎨 Layout Algorithms', () => {
            this._showLayoutAlgorithmsDialog();
        });
        menuContainer._menuContent.appendChild(layoutAlgoItem);

        const toggleEditorItem = makeMenuItem('📝 Toggle Editor', () => {
            if (this.hasAttribute('data-json-editor')) {
                this.removeAttribute('data-json-editor');
            } else {
                this.setAttribute('data-json-editor', '');
            }
        });
        menuContainer._menuContent.appendChild(toggleEditorItem);

        const displaySettingsItem = makeMenuItem('⚙ Display Settings', () => {
            this._showDisplaySettingsDialog();
        });
        menuContainer._menuContent.appendChild(displaySettingsItem);

        const downloadItem = makeMenuItem('📥 Download JSON', () => {
            this.downloadJSON();
        });
        menuContainer._menuContent.appendChild(downloadItem);

        const helpItem = makeMenuItem('❓ Help', () => {
            this._showHelpDialog();
        });
        menuContainer._menuContent.appendChild(helpItem);

        const petriPilotItem = makeMenuItem('🚀 Petri Pilot', () => {
            this._showPetriPilotDialog();
        });
        menuContainer._menuContent.appendChild(petriPilotItem);

        const codeToFlowItem = makeMenuItem('🔄 Code to Flow', () => {
            window.open('https://pilot.pflow.xyz/code-to-flow/', '_blank', 'noopener,noreferrer');
        });
        menuContainer._menuContent.appendChild(codeToFlowItem);

        const bookItem = makeMenuItem('📖 Book', () => {
            window.open('https://book.pflow.xyz', '_blank', 'noopener,noreferrer');
        });
        menuContainer._menuContent.appendChild(bookItem);

        const githubItem = makeMenuItem('GitHub', () => {
            window.open('https://github.com/pflow-xyz/pflow-xyz', '_blank', 'noopener,noreferrer');
        }, '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>');
        menuContainer._menuContent.appendChild(githubItem);

        // Version footer. Links to the matching release tag so a bug report can
        // name the exact build it came from.
        const version = document.createElement('a');
        version.className = 'pv-menu-version';
        version.textContent = `v${PetriView.VERSION}`;
        version.href = `https://github.com/pflow-xyz/pflow-xyz/releases/tag/v${PetriView.VERSION}`;
        version.target = '_blank';
        version.rel = 'noopener,noreferrer';
        version.title = `pflow-xyz v${PetriView.VERSION} — view release notes`;
        menuContainer._menuContent.appendChild(version);

        // Toggle menu on button click
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = menuContainer.style.display !== 'none';
            menuContainer.style.display = isVisible ? 'none' : (isBackendMode ? 'block' : 'block');
        });

        // Close dropdown when clicking outside (only for non-backend mode)
        if (!isBackendMode) {
            const closeDropdown = (e) => {
                if (!menuBtn.contains(e.target) && !menuContainer.contains(e.target)) {
                    menuContainer.style.display = 'none';
                }
            };
            document.addEventListener('click', closeDropdown);
        }

        this._root.appendChild(menuBtn);
        if (isBackendMode) {
            // Append to body for full-screen overlay
            document.body.appendChild(menuContainer);
        } else {
            this._root.appendChild(menuContainer);
        }

        this._hamburgerMenu = menuBtn;
        this._hamburgerDropdown = menuContainer;
    }

    // ---------------- top-right user/login button ----------------
    _createTopRightButton() {
        if (this._topRightButton) return;
        if (!this._root) return;

        const isBackendMode = this.hasAttribute('data-backend');

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pv-top-right-btn';

        // Determine button content based on login state
        if (isBackendMode && this._authInitialized && this._user) {
            // Show username if logged in
            const username = this._user.user_metadata?.user_name ||
                this._user.email?.split('@')[0] ||
                'User';
            button.innerHTML = `👤 ${username}`;
            button.title = `Logged in as ${this._user.email || username}`;
        } else if (isBackendMode && this._authInitialized) {
            // Show login button if not logged in
            button.innerHTML = '🔑 Login';
            button.title = 'Login with GitHub';
        } else if (isBackendMode) {
            // Auth not yet initialized in backend mode, show login button
            button.innerHTML = '🔑 Login';
            button.title = 'Login with GitHub';
        } else {
            // In standard mode, don't show the button
            return;
        }

        button.addEventListener('click', (e) => {
            e.stopPropagation();
            if (this._user) {
                // If logged in, show logout option
                this._logout();
            } else {
                // If not logged in, trigger login
                this._loginWithGitHub();
            }
        });

        this._root.appendChild(button);
        this._topRightButton = button;
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

        // Hide the divider
        if (this._divider) {
            this._divider.style.display = 'none';
        }

        // Reset canvas container to full size. On a narrow viewport it must GROW
        // into the slack rather than claim 100%: the run bar is a sibling in the
        // same flex column, and an inline height:100% (which no stylesheet rule
        // can outrank) pushed it clean off the bottom of the screen.
        if (this._canvasContainer) {
            if (this._isNarrowViewport()) {
                this._canvasContainer.style.flex = '1 1 0';
                this._canvasContainer.style.height = '';
                this._canvasContainer.style.minHeight = '';
            } else {
                this._canvasContainer.style.flex = '1 1 100%';
                this._canvasContainer.style.height = '100%';
                this._canvasContainer.style.minHeight = '100%';
            }
        }

        // Reset layout to default
        this._layoutHorizontal = false;
        this._root.classList.remove('pv-layout-horizontal');

        this._jsonEditor = null;
        this._jsonEditorTextarea = null;
        this._editingJson = false;

        // Remove the attribute to keep state consistent
        this.removeAttribute('data-json-editor');

        // Force layout reflow then resize (fixes iPad Chrome/Safari flex issues)
        void this._canvasContainer?.offsetHeight;
        this._onResize();
        // Multiple resize attempts for iPad browsers
        requestAnimationFrame(() => {
            this._onResize();
            this._repositionMenu();
        });
        setTimeout(() => {
            this._onResize();
            this._repositionMenu();
        }, 100);
        setTimeout(() => this._repositionMenu(), 300);
    }

    _repositionMenu() {
        // Explicitly reposition menu based on editor state (iPad fix)
        if (!this._menu || !this._canvasContainer) return;

        if (this._jsonEditor) {
            // Editor is open - menu in canvasContainer with absolute positioning
            if (this._menu.parentElement !== this._canvasContainer) {
                this._canvasContainer.appendChild(this._menu);
            }
            this._menu.style.position = 'absolute';
            this._menu.style.bottom = '10px';
        } else {
            // Editor is closed - use fixed positioning relative to viewport (iPad fix)
            if (this._menu.parentElement !== this._root) {
                this._root.appendChild(this._menu);
            }
            this._menu.style.position = 'fixed';
            this._menu.style.bottom = '17px'; // extra padding for iPad home indicator
        }
    }

    _updateJsonEditor() {
        if (this._editingJson) return;
        // Cancel any pending editor timer to prevent stale updates
        if (this._jsonEditorTimer) {
            clearTimeout(this._jsonEditorTimer);
            this._jsonEditorTimer = null;
        }
        const pretty = !this.hasAttribute('data-compact');
        const text = pretty ? this._stableStringify(this._model, 2) : JSON.stringify(this._model);
        if (this._aceEditor) {
            // avoid clobbering user's edits
            if (!this._editingJson && this._aceEditor.session.getValue() !== text) {
                this._syncingEditor = true; // prevent change handler from re-parsing
                this._aceEditor.session.setValue(text, -1); // -1 keeps cursor/undo state intact
                this._syncingEditor = false;
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
        // Skip if this is a programmatic update, not a user edit
        if (this._syncingEditor) return;
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
    // Tear down an in-flight one-finger pan without disturbing box-select or the
    // create-on-tap pending state. Shared by the pinch takeover and endPinch.
    _cancelSinglePointerGesture() {
        this._panning = null;
        this._panPending = null;
        try {
            this._canvasContainer.style.cursor = '';
            document.body.style.cursor = '';
        } catch { /* ignore */ }
    }

    // Double-tap zooms in on the tapped point; a second double-tap (or a two-finger
    // tap) reframes. This is the gesture people try first on a diagram, and without
    // it the only way to zoom on a phone is a two-finger pinch.
    _handleTapGesture(e, wasPinching) {
        const t = e.changedTouches && e.changedTouches[0];
        if (!t) return;
        if (wasPinching) {
            // Lifting out of a pinch is not a tap.
            this._lastTap = null;
            return;
        }
        // Taps on a node belong to the node — firing a transition twice in a row is
        // the single most common thing to do while presenting, and treating the
        // second tap as a double-tap both swallowed the fire and threw the zoom.
        // Double-tap zoom applies to empty canvas only.
        if (t.target?.closest?.('.pv-node, .pv-weight, .pv-menu, .pv-run-bar, .pv-fire-sheet')) {
            this._lastTap = null;
            return;
        }
        const now = e.timeStamp || 0;
        const prev = this._lastTap;
        this._lastTap = {x: t.clientX, y: t.clientY, t: now};
        if (!prev) return;
        if (now - prev.t > 300) return;
        if (Math.hypot(t.clientX - prev.x, t.clientY - prev.y) > 24) return;

        this._lastTap = null;
        e.preventDefault?.();
        const fitScale = this._fitScale()?.fit;
        const atFit = fitScale != null && this._view.scale <= Math.min(1, fitScale) * 1.05;
        if (!atFit) {
            // Already zoomed in — the second double-tap is "show me everything".
            this._userHasPanned = false;
            this.fitToView();
            return;
        }
        const r = this._canvasContainer.getBoundingClientRect();
        const mx = t.clientX - r.left, my = t.clientY - r.top;
        const prevScale = this._view.scale;
        const next = Math.min(this._maxScale, prevScale * 2.5);
        if (next === prevScale) return;
        this._view.tx = mx - (mx - this._view.tx) * (next / prevScale);
        this._view.ty = my - (my - this._view.ty) * (next / prevScale);
        this._view.scale = next;
        this._userHasPanned = true;
        this._applyViewTransform();
    }

    _wireRootEvents() {
        // mouse tracking for arc draft
        this._canvasContainer.addEventListener('pointermove', (e) => {
            const r = this._canvasContainer.getBoundingClientRect();
            this._mouse.x = Math.round(e.clientX - r.left);
            this._mouse.y = Math.round(e.clientY - r.top);
            if (this._arcDraft) this._draw();
        });

        // wheel zoom
        this._canvasContainer.addEventListener('wheel', (e) => {
            e.preventDefault();
            const r = this._canvasContainer.getBoundingClientRect();
            const mx = e.clientX - r.left, my = e.clientY - r.top;
            const prev = this._view.scale;
            const next = Math.max(this._minScale, Math.min(this._maxScale, prev * (e.deltaY < 0 ? 1.1 : 0.9)));
            if (next === prev) return;
            this._view.tx = mx - (mx - this._view.tx) * (next / prev);
            this._view.ty = my - (my - this._view.ty) * (next / prev);
            this._view.scale = next;
            this._userHasPanned = true;
            // No _draw(): the canvas is a child of the transformed stage, so the
            // CSS transform has already moved the drawn arcs. Redrawing here cost
            // ~4.5ms/frame on a 118-arc model for zero visual difference.
            this._applyViewTransform();
        }, {passive: false});

        // pinch-to-zoom and two-finger pan for touch devices
        this._activeTouches = new Map();
        this._pinchState = null;

        this._canvasContainer.addEventListener('touchstart', (e) => {
            for (const touch of e.changedTouches) {
                this._activeTouches.set(touch.identifier, {x: touch.clientX, y: touch.clientY});
            }
            if (this._activeTouches.size === 2) {
                e.preventDefault();
                // A pinch always begins as a one-finger pointerdown, which has
                // already started a pan and possibly a node drag. Both write to the
                // same state the pinch is about to own — leaving them live makes the
                // diagram jitter and silently moves whatever node the first finger
                // happened to land on. Tear both down before taking over.
                this._cancelSinglePointerGesture();
                this._activeNodeDrag?.cancel();
                const touches = Array.from(this._activeTouches.values());
                const dx = touches[1].x - touches[0].x;
                const dy = touches[1].y - touches[0].y;
                const dist = Math.hypot(dx, dy);
                const r = this._canvasContainer.getBoundingClientRect();
                const cx = (touches[0].x + touches[1].x) / 2 - r.left;
                const cy = (touches[0].y + touches[1].y) / 2 - r.top;
                this._pinchState = {
                    initialDist: dist,
                    initialScale: this._view.scale,
                    initialTx: this._view.tx,
                    initialTy: this._view.ty,
                    initialCx: cx,
                    initialCy: cy
                };
            }
        }, {passive: false});

        this._canvasContainer.addEventListener('touchmove', (e) => {
            for (const touch of e.changedTouches) {
                if (this._activeTouches.has(touch.identifier)) {
                    this._activeTouches.set(touch.identifier, {x: touch.clientX, y: touch.clientY});
                }
            }
            if (this._pinchState && this._activeTouches.size === 2) {
                e.preventDefault();
                const touches = Array.from(this._activeTouches.values());
                const dx = touches[1].x - touches[0].x;
                const dy = touches[1].y - touches[0].y;
                const dist = Math.hypot(dx, dy);
                const r = this._canvasContainer.getBoundingClientRect();
                const cx = (touches[0].x + touches[1].x) / 2 - r.left;
                const cy = (touches[0].y + touches[1].y) / 2 - r.top;

                // Calculate new scale
                const scaleRatio = dist / this._pinchState.initialDist;
                const newScale = Math.max(this._minScale, Math.min(this._maxScale,
                    this._pinchState.initialScale * scaleRatio));

                // Calculate pan offset from pinch center movement
                const panDx = cx - this._pinchState.initialCx;
                const panDy = cy - this._pinchState.initialCy;

                // Apply zoom centered on pinch midpoint plus pan
                const prev = this._pinchState.initialScale;
                const zoomCx = this._pinchState.initialCx;
                const zoomCy = this._pinchState.initialCy;
                this._view.tx = zoomCx - (zoomCx - this._pinchState.initialTx) * (newScale / prev) + panDx;
                this._view.ty = zoomCy - (zoomCy - this._pinchState.initialTy) * (newScale / prev) + panDy;
                this._view.scale = newScale;
                this._userHasPanned = true;

                this._applyViewTransform();
            }
        }, {passive: false});

        const endPinch = (e) => {
            // Sticky for the whole gesture, not just this event: _pinchState is
            // nulled on the FIRST finger's touchend, so reading it when the last
            // finger lifts would report "not a pinch" and arm a double-tap.
            if (this._pinchState) this._gestureWasPinch = true;
            const wasPinching = !!this._gestureWasPinch;
            for (const touch of e.changedTouches) {
                this._activeTouches.delete(touch.identifier);
            }
            if (this._activeTouches.size < 2) {
                this._pinchState = null;
                // Do NOT hand the surviving finger back to the pan handler: its
                // _panning origin is from before the pinch, so resuming would snap
                // the view by the lifted finger's whole offset. Pan resumes on the
                // next clean touchdown.
                if (wasPinching) this._cancelSinglePointerGesture();
            }
            if (this._activeTouches.size === 0) {
                this._handleTapGesture(e, wasPinching);
                this._gestureWasPinch = false;
            }
        };
        this._canvasContainer.addEventListener('touchend', endPinch, {passive: false});
        this._canvasContainer.addEventListener('touchcancel', endPinch, {passive: false});

        window.addEventListener('keydown', (e) => {
            // Check if user is typing in an input/textarea to avoid interfering
            const activeEl = document.activeElement;
            const isTyping = activeEl && (
                activeEl.tagName === 'INPUT' ||
                activeEl.tagName === 'TEXTAREA' ||
                activeEl.isContentEditable
            );

            if (e.key === ' ') this._spaceDown = true;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
                if (!isTyping) {
                    e.preventDefault();
                    if (e.shiftKey) this._redoAction(); else this._undoAction();
                }
            }

            if (e.key && e.key.toLowerCase() === 'x') {
                if (!isTyping) {
                    e.preventDefault();
                    this._setSimulation(!this._simRunning);
                    return;
                }
            }

            if (e.key === 'Escape') {
                e.preventDefault();
                // Exit label-edit mode if active
                if (this._labelEditMode) {
                    this._labelEditMode = false;
                }
                // If currently drawing an arc, clear the draft but stay in add-arc mode
                if (this._arcDraft) {
                    this._arcDraft = null;
                    this._updateArcDraftHighlight();
                    this._draw();
                    return;
                }
                // If not drawing an arc, proceed with mode change
                this._setMode('select');
                // Blur any focused button to remove focus outline
                if (document.activeElement && document.activeElement.classList.contains('pv-tool')) {
                    document.activeElement.blur();
                }
                if (this._simRunning) {
                    this._setSimulation(false);
                    return;
                }
                // Cancel bounding box selection if active
                if (this._boxSelect) {
                    // release pointer capture if set
                    try {
                        if (this._canvasContainer.releasePointerCapture) this._canvasContainer.releasePointerCapture(this._boxSelect.pointerId);
                    } catch { /* ignore */
                    }
                    this._boxSelect = null;
                    this._draw();
                }
                // Clear selected nodes if any are selected
                if (this._selectedNodes && this._selectedNodes.size > 0) {
                    this._clearSelection();
                }
                return;
            }

            // Handle Backspace/Delete to delete selected nodes without changing mode
            if ((e.key === 'Backspace' || e.key === 'Delete') && !isTyping) {
                if (this._selectedNodes && this._selectedNodes.size > 0) {
                    e.preventDefault();
                    // Delete all selected nodes at once (batch operation)
                    this._deleteNodes(Array.from(this._selectedNodes));
                    // Clear selection after deletion
                    this._clearSelection();
                    return;
                }
            }

            const map = {
                '1': 'select',
                '2': 'add-place',
                '3': 'add-transition',
                '4': 'add-arc',
                '5': 'add-token',
                '6': 'delete'
            };
            if (map[e.key] && !isTyping) this._setMode(map[e.key]);

            // 7 = toggle label editor, 8 = toggle play/pause, 9 = analysis
            if (e.key === '7' && !isTyping) {
                e.preventDefault();
                this._toggleLabelEditMode();
            }
            if (e.key === '8' && !isTyping) {
                e.preventDefault();
                this._setSimulation(!this._simRunning);
            }
            if (e.key === '9' && !isTyping && !this._simulationDialog) {
                e.preventDefault();
                this._showSimulationDialog();
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === ' ') this._spaceDown = false;
        });

        // panning pointer down/move/up
        this._canvasContainer.addEventListener('pointerdown', (e) => {
            // If so, allow left-button drag to pan even without modifiers.
            const chromeSelector = '.pv-menu, .pv-json-editor, .pv-scale-meter, .pv-json-textarea, .pv-tool, .pv-play, .pv-layout-divider, .pv-run-bar, .pv-fire-sheet';
            // On touch, a place's hit area is the 80x80 box plus a 72x72 handle —
            // far bigger than the 32px circle drawn — so a finger in apparently
            // empty space grabs a node and the diagram refuses to pan. When
            // presenting (narrow viewport or sim running), let a *moved* finger pan
            // from anywhere, including over nodes. The pan still goes through the
            // _panPending threshold below, so a stationary tap on a node still
            // dispatches its click and fires the transition.
            // Requires _simRunning, i.e. presenting mode — NOT merely a narrow
            // viewport. While editing, a finger on a node must reach _beginDrag;
            // letting the container also claim the gesture moved the node at twice
            // the finger's speed, and capturing the pointer here stole the pointerup
            // that add-arc and long-press depend on.
            const panOverNodes = e.pointerType === 'touch' && this._simRunning;
            const interactiveSelector = panOverNodes
                ? chromeSelector
                : `.pv-node, .pv-weight, ${chromeSelector}`;
            const clickedInteractive = !!e.target.closest && e.target.closest(interactiveSelector);
            const leftButton = e.button === 0;

            // Check for shift+click on canvas (not on elements) to start bounding box selection
            if (e.shiftKey && leftButton && !clickedInteractive && this._canBoxSelect()) {
                e.preventDefault();
                // Safety: ensure we're not in a conflicting state
                if (this._panning) {
                    this._panning = null;
                    try {
                        this._canvasContainer.style.cursor = '';
                        document.body.style.cursor = '';
                    } catch { /* ignore */
                    }
                }
                const r = this._canvasContainer.getBoundingClientRect();
                this._boxSelect = {
                    startX: e.clientX - r.left,
                    startY: e.clientY - r.top,
                    endX: e.clientX - r.left,
                    endY: e.clientY - r.top,
                    pointerId: e.pointerId
                };
                // capture pointer on canvas container so we receive move/up outside it
                try {
                    if (this._canvasContainer.setPointerCapture) this._canvasContainer.setPointerCapture(e.pointerId);
                } catch { /* ignore */
                }
                return;
            }

            // A second finger is already down — the pinch handler owns the view.
            if (this._activeTouches && this._activeTouches.size > 1) return;

            // Check if we have selected nodes and clicking on canvas (not shift, not on elements)
            // In this case, start a canvas-based group drag instead of panning
            if (!e.shiftKey && leftButton && !clickedInteractive && this._selectedNodes.size > 0 && this._modeCan('canGroupDrag')) {
                e.preventDefault();
                this._beginCanvasGroupDrag(e);
                return;
            }

            // In modes that create elements on click, use threshold-based pan
            const createsOnClick = this._modeCan('canCreatePlace') || this._modeCan('canCreateTransition');
            const isPan = this._spaceDown || e.button === 1 || e.altKey || e.ctrlKey || e.metaKey || (leftButton && !clickedInteractive);

            if (isPan) {
                e.preventDefault();
                // Safety: ensure we're not in a conflicting state
                if (this._boxSelect) {
                    this._boxSelect = null;
                }

                const panState = {
                    x: e.clientX,
                    y: e.clientY,
                    tx: this._view.tx,
                    ty: this._view.ty,
                    pointerId: e.pointerId
                };

                // If in a mode that creates on click — or if this is a touch that may
                // still turn out to be a tap on a node — start as pending (threshold-based)
                if ((createsOnClick || panOverNodes) && leftButton && !this._spaceDown && !e.altKey && !e.ctrlKey && !e.metaKey && e.button !== 1) {
                    this._panPending = panState;
                    // capture pointer so we receive move/up events
                    try {
                        if (this._canvasContainer.setPointerCapture) this._canvasContainer.setPointerCapture(e.pointerId);
                    } catch { /* ignore */
                    }
                } else {
                    // Clear selection when panning starts (since orange highlight will not be visible)
                    if (this._selectedNodes.size > 0) {
                        this._clearSelection();
                    }
                    // start panning immediately
                    this._panning = panState;
                    // set grabbing cursor during pan (apply to canvas container and body to ensure coverage)
                    try {
                        this._canvasContainer.style.cursor = 'grabbing';
                        document.body.style.cursor = 'grabbing';
                    } catch { /* ignore */
                    }
                    // capture pointer on canvas container so we receive move/up outside it
                    try {
                        if (this._canvasContainer.setPointerCapture) this._canvasContainer.setPointerCapture(e.pointerId);
                    } catch { /* ignore */
                    }
                }
            }
        });

        this._canvasContainer.addEventListener('pointermove', (e) => {
            // Handle bounding box selection drag
            if (this._boxSelect) {
                const r = this._canvasContainer.getBoundingClientRect();
                this._boxSelect.endX = e.clientX - r.left;
                this._boxSelect.endY = e.clientY - r.top;
                this._draw();
                return;
            }

            // Check if pending pan should activate (threshold exceeded)
            if (this._panPending) {
                const dx = e.clientX - this._panPending.x;
                const dy = e.clientY - this._panPending.y;
                if (dx * dx + dy * dy > this._panThreshold * this._panThreshold) {
                    // Promote to actual panning
                    if (this._selectedNodes.size > 0) {
                        this._clearSelection();
                    }
                    this._panning = this._panPending;
                    this._panPending = null;
                    try {
                        this._canvasContainer.style.cursor = 'grabbing';
                        document.body.style.cursor = 'grabbing';
                    } catch { /* ignore */
                    }
                }
            }

            // Two fingers down: the pinch handler owns the view transform. Without
            // this guard both handlers write tx/ty from different anchors each
            // frame and the diagram jitters through every pinch.
            if (this._pinchState) return;

            if (!this._panning) return;
            this._view.tx = this._panning.tx + (e.clientX - this._panning.x);
            this._view.ty = this._panning.ty + (e.clientY - this._panning.y);
            this._userHasPanned = true;
            this._applyViewTransform();
        });

        const endPan = (e) => {
            // Handle end of bounding box selection
            if (this._boxSelect) {
                // release pointer capture if set
                try {
                    if (this._canvasContainer.releasePointerCapture) this._canvasContainer.releasePointerCapture(this._boxSelect.pointerId ?? e.pointerId);
                } catch { /* ignore */
                }

                // Find nodes inside the bounding box
                this._selectNodesInBox();
                this._boxSelect = null;
                this._draw(); // redraw to clear the bounding box
                return;
            }

            // Clear pending pan (threshold not exceeded) - create element directly
            if (this._panPending) {
                const pending = this._panPending;
                try {
                    if (this._canvasContainer.releasePointerCapture) this._canvasContainer.releasePointerCapture(pending.pointerId ?? e.pointerId);
                } catch { /* ignore */
                }
                this._panPending = null;
                try {
                    this._canvasContainer.style.cursor = '';
                    document.body.style.cursor = '';
                } catch { /* ignore */
                }

                // Create element at the original pointer position (don't rely on click event)
                const rect = this._stage.getBoundingClientRect();
                const x = Math.round(pending.x - rect.left);
                const y = Math.round(pending.y - rect.top);

                if (this._modeCan('canCreatePlace')) {
                    const id = this._genId('p');
                    this._model.places[id] = {'@type': 'Place', x, y, initial: [0], capacity: [Infinity]};
                    this._normalizeModel();
                    this._pushHistory();
                    this._scheduleSync();
                    this._scheduleRender();
                    this._createdOnPointerUp = true;
                } else if (this._modeCan('canCreateTransition')) {
                    const id = this._genId('t');
                    this._model.transitions[id] = {'@type': 'Transition', x, y};
                    this._normalizeModel();
                    this._pushHistory();
                    this._scheduleSync();
                    this._scheduleRender();
                    this._createdOnPointerUp = true;
                }
                return;
            }

            if (!this._panning) return;
            // release pointer capture if set
            try {
                if (this._canvasContainer.releasePointerCapture) this._canvasContainer.releasePointerCapture(this._panning.pointerId ?? e.pointerId);
            } catch { /* ignore */
            }

            this._panning = null;
            // restore cursor
            try {
                this._canvasContainer.style.cursor = '';
                document.body.style.cursor = '';
            } catch { /* ignore */
            }

            // optionally push history or dispatch event if needed
            // this._pushHistory();
        };

        this._canvasContainer.addEventListener('pointerup', endPan);
        this._canvasContainer.addEventListener('pointercancel', endPan);
    }

    _getStorageKey() {
        const id = this.getAttribute('id') || this.getAttribute('name') || '';
        return `petri-view:last${id ? ':' + id : ''}`;
    }

};

customElements.define('petri-view', PetriView);
}

export {PetriView};