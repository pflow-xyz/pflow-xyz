class PetriView extends HTMLElement {
    // Base58 alphabet for base58btc encoding
    _base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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
        this._labelEditMode = false;
        this._selectedNodes = new Set(); // for group-select mode
        this._boxSelect = null; // for bounding box selection: {startX, startY, endX, endY}

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

        // fire queue to serialize rapid transition clicks
        this._fireQueue = [];
        this._processingFires = false;

        this._lastFireAt = Object.create(null);
        this._fireDebounceMs = 600; // milliseconds

        // layout orientation (vertical by default, horizontal when toggled)
        this._layoutHorizontal = false;

        // Supabase support (backend mode)
        this._supabase = null;
        this._user = null;
        this._supabaseUrl = null;
        this._supabaseKey = null;
        this._supabaseInitialized = false;
        this._supabaseAuthSubscription = null;
        this._supabaseInitializing = false;

        // UI buttons
        this._hamburgerMenu = null;
        this._hamburgerDropdown = null;
        this._topRightButton = null;
        
        // Original CID from URL (for revert functionality)
        this._originalCid = null;
        
        // ODE Simulation
        this._simulationDialog = null;
        this._solverModule = null;
    }

    // observe compact flag and json editor toggle
    static get observedAttributes() {
        return ['data-compact', 'data-json-editor', 'data-backend', 'data-layout-horizontal', 'supabase-url', 'supabase-key'];
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

            // Initialize Supabase if attributes are set
            if (newValue !== null) {
                this._initSupabase();
            }
        }
        if ((name === 'supabase-url' || name === 'supabase-key') && this.isConnected) {
            // Re-initialize Supabase with new config
            if (this.hasAttribute('data-backend')) {
                this._initSupabase();
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

    // ---------------- Supabase Integration ----------------
    async _initSupabase() {
        if (!this.hasAttribute('data-backend')) return;

        const supabaseUrl = this.getAttribute('supabase-url');
        const supabaseKey = this.getAttribute('supabase-key');

        // Check if credentials have changed
        if (this._supabaseInitialized &&
            this._supabaseUrl === supabaseUrl &&
            this._supabaseKey === supabaseKey) {
            return; // Skip if same credentials
        }

        // Prevent concurrent initializations
        if (this._supabaseInitializing) {
            return;
        }

        if (!supabaseUrl || !supabaseKey) {
            console.log('Supabase credentials not configured. Login feature will be disabled.');
            return;
        }

        try {
            this._supabaseInitializing = true;

            // Clean up existing subscription if any
            if (this._supabaseAuthSubscription) {
                this._supabaseAuthSubscription.subscription.unsubscribe();
                this._supabaseAuthSubscription = null;
            }

            // Dynamically import Supabase
            const {createClient} = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');

            this._supabase = createClient(supabaseUrl, supabaseKey);
            this._supabaseUrl = supabaseUrl;
            this._supabaseKey = supabaseKey;
            this._supabaseInitialized = true;

            // Listen for auth state changes and store the subscription
            this._supabaseAuthSubscription = this._supabase.auth.onAuthStateChange(async (event, session) => {
                if (session?.user) {
                    this._user = session.user;
                    this._updateMenuForAuth();
                } else {
                    this._user = null;
                    this._updateMenuForAuth();
                }
            });

            // Check current session
            const {data: {session}} = await this._supabase.auth.getSession();
            if (session?.user) {
                this._user = session.user;
                this._updateMenuForAuth();
            }
        } catch (err) {
            console.error('Failed to initialize Supabase:', err);
        } finally {
            this._supabaseInitializing = false;
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
        if (!this._supabase) {
            alert('Supabase is not configured. Please set supabase-url and supabase-key attributes.');
            return;
        }

        try {
            const {error} = await this._supabase.auth.signInWithOAuth({
                provider: 'github',
                options: {
                    redirectTo: window.location.origin + window.location.pathname,
                    scopes: 'gist'
                }
            });
            if (error) {
                console.error('Login error:', error);
                alert('Login failed: ' + error.message);
            }
        } catch (err) {
            console.error('Login exception:', err);
            alert('Login failed: ' + (err.message || String(err)));
        }
    }

    async _logout() {
        if (!this._supabase) return;

        const {error} = await this._supabase.auth.signOut();
        if (error) {
            console.error('Logout error:', error);
            alert('Logout failed: ' + error.message);
        }
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

        // Hide fallback toolbar when ACE loads
        if (this._editorToolbar) {
            this._editorToolbar.style.display = 'none';
        }

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
                alert('Download failed: ' + (err && err.message ? err.message : String(err)));
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
        this._aceEditorContainer = editorWrapper;
    }

    // Encode bytes to base58btc
    _encodeBase58(bytes) {
        const alphabet = this._base58Alphabet;
        let num = 0n;

        // Convert bytes to big integer
        for (let i = 0; i < bytes.length; i++) {
            num = num * 256n + BigInt(bytes[i]);
        }

        // Convert to base58
        let encoded = '';
        while (num > 0n) {
            const remainder = num % 58n;
            num = num / 58n;
            encoded = alphabet[Number(remainder)] + encoded;
        }

        // Add leading 1s for leading zero bytes
        for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
            encoded = '1' + encoded;
        }

        return encoded;
    }

    // Compute SHA256 hash using Web Crypto API
    async _sha256(data) {
        const encoder = new TextEncoder();
        const bytes = typeof data === 'string' ? encoder.encode(data) : data;
        const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
        return new Uint8Array(hashBuffer);
    }

    // Create CIDv1 bytes with multicodec and multihash
    _createCIDv1Bytes(codec, hash) {
        // CIDv1 format: <version><codec><multihash>
        // version = 0x01
        // codec = 0x0129 (dag-json) = [0x01, 0x29] in varint encoding
        // multihash = <hash-type><hash-length><hash-bytes>
        //   hash-type = 0x12 (sha2-256)
        //   hash-length = 0x20 (32 bytes)

        const version = 0x01;
        const codecBytes = codec === 0x0129 ? [0x01, 0x29] : [codec];
        const hashType = 0x12; // sha2-256
        const hashLength = hash.length;

        const cidBytes = new Uint8Array(1 + codecBytes.length + 2 + hash.length);
        let offset = 0;

        cidBytes[offset++] = version;
        for (const b of codecBytes) {
            cidBytes[offset++] = b;
        }
        cidBytes[offset++] = hashType;
        cidBytes[offset++] = hashLength;
        for (let i = 0; i < hash.length; i++) {
            cidBytes[offset++] = hash[i];
        }

        return cidBytes;
    }

    // Canonicalize JSON document to deterministic string
    _canonicalizeJSON(doc) {
        // Simple canonical JSON serialization
        // Sort object keys recursively and use consistent formatting
        const canonicalize = (obj) => {
            if (obj === null || typeof obj !== 'object') {
                return JSON.stringify(obj);
            }

            if (Array.isArray(obj)) {
                return '[' + obj.map(item => canonicalize(item)).join(',') + ']';
            }

            // Sort keys and build object
            const keys = Object.keys(obj).sort();
            const pairs = keys.map(key => {
                return JSON.stringify(key) + ':' + canonicalize(obj[key]);
            });
            return '{' + pairs.join(',') + '}';
        };

        return canonicalize(doc);
    }

    // Compute CID for a JSON-LD document
    async _computeCidForJsonLd(doc) {
        // 1. Canonicalize the JSON document
        const canonical = this._canonicalizeJSON(doc);

        // 2. Compute SHA256 hash
        const hash = await this._sha256(canonical);

        // 3. Create CIDv1 with dag-json codec (0x0129)
        const cidBytes = this._createCIDv1Bytes(0x0129, hash);

        // 4. Encode as base58btc (prepend 'z' for base58btc multibase)
        const base58 = this._encodeBase58(cidBytes);
        const cid = 'z' + base58;

        return cid;
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
        overlay.className = 'pv-url-dialog-overlay';
        this._applyStyles(overlay, {
            position: 'fixed',
            left: '0',
            top: '0',
            right: '0',
            bottom: '0',
            background: 'rgba(0, 0, 0, 0.5)',
            zIndex: 2147483646,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
        });

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-url-dialog';
        this._applyStyles(dialog, {
            background: '#fff',
            borderRadius: '8px',
            padding: '20px',
            maxWidth: '600px',
            width: '100%',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
            maxHeight: '80vh',
            overflow: 'auto'
        });

        // Title
        const title = document.createElement('h3');
        title.textContent = 'Open JSON-LD from URL';
        this._applyStyles(title, {
            margin: '0 0 16px 0',
            fontSize: '18px',
            fontWeight: 'bold'
        });
        dialog.appendChild(title);

        // URL input
        const urlLabel = document.createElement('label');
        urlLabel.textContent = 'URL:';
        this._applyStyles(urlLabel, {
            display: 'block',
            marginBottom: '6px',
            fontSize: '14px',
            fontWeight: '500'
        });
        dialog.appendChild(urlLabel);

        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.placeholder = 'https://pflow.xyz/ld/data/test.jsonld';
        this._applyStyles(urlInput, {
            width: '100%',
            padding: '8px',
            fontSize: '14px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            boxSizing: 'border-box',
            marginBottom: '16px'
        });
        dialog.appendChild(urlInput);

        // Headers section
        const headersLabel = document.createElement('label');
        headersLabel.textContent = 'Custom Headers (optional):';
        this._applyStyles(headersLabel, {
            display: 'block',
            marginBottom: '8px',
            fontSize: '14px',
            fontWeight: '500'
        });
        dialog.appendChild(headersLabel);

        const headersContainer = document.createElement('div');
        this._applyStyles(headersContainer, {
            marginBottom: '16px'
        });
        dialog.appendChild(headersContainer);

        // Array to track header inputs
        const headerRows = [];

        const addHeaderRow = (key = '', value = '') => {
            const row = document.createElement('div');
            this._applyStyles(row, {
                display: 'flex',
                gap: '8px',
                marginBottom: '8px',
                alignItems: 'center'
            });

            const keyInput = document.createElement('input');
            keyInput.type = 'text';
            keyInput.placeholder = 'Header name';
            this._applyStyles(keyInput, {
                flex: '1',
                padding: '6px',
                fontSize: '13px',
                border: '1px solid #ccc',
                borderRadius: '4px'
            });
            keyInput.value = key;

            const valueInput = document.createElement('input');
            valueInput.type = 'text';
            valueInput.placeholder = 'Header value';
            this._applyStyles(valueInput, {
                flex: '1',
                padding: '6px',
                fontSize: '13px',
                border: '1px solid #ccc',
                borderRadius: '4px'
            });
            valueInput.value = value;

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.type = 'button';
            this._applyStyles(removeBtn, {
                padding: '6px 10px',
                border: '1px solid #ccc',
                borderRadius: '4px',
                background: '#f5f5f5',
                cursor: 'pointer',
                fontSize: '14px'
            });
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
        this._applyStyles(addHeaderBtn, {
            padding: '6px 12px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            background: '#f5f5f5',
            cursor: 'pointer',
            fontSize: '13px',
            marginBottom: '16px'
        });
        addHeaderBtn.addEventListener('click', () => addHeaderRow());
        dialog.appendChild(addHeaderBtn);

        // Buttons
        const buttonContainer = document.createElement('div');
        this._applyStyles(buttonContainer, {
            display: 'flex',
            gap: '10px',
            justifyContent: 'flex-end'
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.type = 'button';
        this._applyStyles(cancelBtn, {
            padding: '8px 16px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            background: '#f5f5f5',
            cursor: 'pointer',
            fontSize: '14px'
        });
        cancelBtn.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });

        const loadBtn = document.createElement('button');
        loadBtn.textContent = 'Load';
        loadBtn.type = 'button';
        this._applyStyles(loadBtn, {
            padding: '8px 16px',
            border: '1px solid #007bff',
            borderRadius: '4px',
            background: '#007bff',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '14px'
        });
        loadBtn.addEventListener('click', async () => {
            const url = urlInput.value.trim();
            if (!url) {
                alert('Please enter a URL');
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
                    alert('The fetched document is not valid JSON-LD. Please ensure the URL points to a valid JSON-LD document.');
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
                alert('Failed to load URL: ' + errorMsg + '\n\nNote: CORS restrictions may prevent loading from some URLs. The server must include appropriate Access-Control-Allow-Origin headers.');
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
        this._applyStyles(toolbar, {
            display: 'flex',
            gap: '6px',
            padding: '6px 8px',
            background: 'rgba(255, 255, 255, 0.95)',
            borderBottom: '1px solid #ddd',
            alignItems: 'center',
            flexWrap: 'wrap'
        });

        const makeToolbarBtn = (text, title) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = text;
            btn.title = title;
            this._applyStyles(btn, {
                padding: '6px 10px',
                borderRadius: '4px',
                border: '1px solid #ccc',
                background: '#fff',
                cursor: 'pointer',
                fontSize: '12px',
                fontFamily: 'system-ui, Arial'
            });
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
        textarea.className = 'pv-json-textarea';
        this._applyStyles(textarea, {
            width: '100%',
            flex: '1 1 auto',
            boxSizing: 'border-box',
            resize: 'none',
            fontFamily: 'monospace',
            fontSize: '13px',
            padding: '8px',
            borderRadius: '0',
            border: 'none',
            borderTop: '1px solid #ddd'
        });
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

        // Reset to 50/50 split on orientation change
        this._canvasContainer.style.flex = '0 0 50%';
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

    // ---------------- divider handling ----------------
    _initDividerPosition() {
        // Try to load saved position from localStorage
        try {
            const saved = localStorage.getItem('pv-divider-position');
            if (saved) {
                const pos = JSON.parse(saved);
                if (pos && typeof pos.canvasFlex === 'string') {
                    this._canvasContainer.style.flex = pos.canvasFlex;
                    return;
                }
            }
        } catch {
            // ignore
        }

        // Default: 50/50 split
        this._canvasContainer.style.flex = '0 0 50%';
    }

    _saveDividerPosition() {
        try {
            const pos = {
                canvasFlex: this._canvasContainer.style.flex
            };
            localStorage.setItem('pv-divider-position', JSON.stringify(pos));
        } catch {
            // ignore
        }
    }

    _setupDividerDrag() {
        if (!this._divider) return;

        let isDragging = false;

        const onPointerDown = (e) => {
            if (e.button !== 0) return; // left button only
            e.preventDefault();
            isDragging = true;
            this._divider.setPointerCapture(e.pointerId);

            // Update cursor based on current layout
            document.body.style.cursor = this._layoutHorizontal ? 'col-resize' : 'row-resize';
        };

        const onPointerMove = (e) => {
            if (!isDragging) return;

            const rootRect = this._root.getBoundingClientRect();

            if (this._layoutHorizontal) {
                // Horizontal layout (side-by-side)
                const offsetX = e.clientX - rootRect.left;
                const minSize = 200;
                const maxSize = rootRect.width - 200 - 8; // account for divider
                const clamped = Math.max(minSize, Math.min(maxSize, offsetX));
                this._canvasContainer.style.flex = `0 0 ${clamped}px`;
            } else {
                // Vertical layout (stacked)
                const offsetY = e.clientY - rootRect.top;
                const minSize = 150;
                const maxSize = rootRect.height - 150 - 8; // account for divider
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

        // Clean up Supabase auth subscription
        if (this._supabaseAuthSubscription) {
            this._supabaseAuthSubscription.subscription.unsubscribe();
            this._supabaseAuthSubscription = null;
        }

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
            alert('Download failed: ' + (err && err.message ? err.message : String(err)));
        }
    }

    async _saveToPermalink() {
        const isBackendMode = this.hasAttribute('data-backend');

        // In backend mode with authenticated user, save to server
        if (isBackendMode && this._supabaseInitialized && this._user) {
            try {
                // Get the session token for authentication
                const {data: {session}} = await this._supabase.auth.getSession();
                const authToken = session?.access_token;

                if (!authToken) {
                    alert('Please log in to save data');
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
                    alert(`Save failed: ${response.statusText}`);
                    return;
                }

                const result = await response.json();
                const cid = result.cid;

                console.log('Save successful! CID:', cid);

                // Update URL with CID instead of data parameter
                const url = new URL(window.location.origin + window.location.pathname);
                url.searchParams.set('cid', cid);
                window.history.pushState({}, '', url.toString());

                alert('Saved successfully! CID: ' + cid);
            } catch (err) {
                console.error('Failed to save to server:', err);
                alert('Failed to save to server: ' + (err && err.message ? err.message : String(err)));
            }
            return;
        }

        // Default behavior: Save to permalink (update URL with data parameter)
        try {
            this._updatePermalinkURL();

            // Show feedback to user
            const currentUrl = window.location.href;

            // Copy to clipboard if available
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(currentUrl).then(() => {
                    alert('Permalink saved! URL copied to clipboard.\n\n' + currentUrl);
                }).catch(() => {
                    alert('Permalink saved!\n\n' + currentUrl);
                });
            } else {
                alert('Permalink saved!\n\n' + currentUrl);
            }
        } catch (err) {
            console.error('Failed to save permalink:', err);
            alert('Failed to save permalink: ' + (err && err.message ? err.message : String(err)));
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
                // Check if user is authenticated and get session token
                if (!this._supabaseInitialized || !this._user) {
                    alert('You must be logged in to delete documents from the server.');
                    return;
                }

                const {data: {session}} = await this._supabase.auth.getSession();
                const authToken = session?.access_token;

                if (!authToken) {
                    alert('Authentication required. Please log in.');
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
                        alert('Authentication required. Please log in.');
                    } else if (response.status === 403) {
                        alert('You do not have permission to delete this document. Only the author can delete it.');
                    } else if (response.status === 404) {
                        alert('Document not found on server.');
                    } else {
                        const errorText = await response.text().catch(() => '');
                        const statusMsg = response.statusText || `HTTP ${response.status}`;
                        alert(`Failed to delete document: ${statusMsg}${errorText ? '\n' + errorText : ''}`);
                    }
                    return;
                }

                // Successfully deleted from server
                console.log('Document deleted from server:', cid);
            } catch (err) {
                console.error('Failed to delete from server:', err);
                alert('Failed to delete document from server: ' + (err && err.message ? err.message : String(err)));
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
                // Get the session token for authentication
                const {data: {session}} = await this._supabase.auth.getSession();
                const authToken = session?.access_token;

                if (!authToken) {
                    alert('Please log in to share data');
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
                    alert(`Failed to save before sharing: ${response.statusText}`);
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
                alert('Failed to save document: ' + (err && err.message ? err.message : String(err)));
                return;
            }
        }

        // Generate markdown snippet
        const currentUrl = window.location.origin;
        const svgUrl = `${currentUrl}/img/${cid}.svg`;
        const docUrl = `${currentUrl}/?cid=${cid}`;
        const markdown = `[![pflow](${svgUrl})](${docUrl})`;

        // Create modal overlay
        const overlay = document.createElement('div');
        this._applyStyles(overlay, {
            position: 'fixed',
            left: '0',
            top: '0',
            right: '0',
            bottom: '0',
            background: 'rgba(0, 0, 0, 0.5)',
            zIndex: 2147483646,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
        });

        // Create dialog
        const dialog = document.createElement('div');
        this._applyStyles(dialog, {
            background: '#fff',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '600px',
            width: '100%',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)'
        });

        // Title
        const title = document.createElement('h3');
        title.textContent = 'Share Your Petri Net';
        this._applyStyles(title, {
            margin: '0 0 16px 0',
            fontSize: '20px',
            fontWeight: 'bold',
            color: '#333'
        });
        dialog.appendChild(title);

        // Description
        const description = document.createElement('p');
        description.textContent = 'Copy the markdown snippet below to share your Petri net:';
        this._applyStyles(description, {
            margin: '0 0 12px 0',
            fontSize: '14px',
            color: '#666'
        });
        dialog.appendChild(description);

        // Markdown textarea
        const textarea = document.createElement('textarea');
        textarea.value = markdown;
        textarea.readOnly = true;
        this._applyStyles(textarea, {
            width: '100%',
            height: '80px',
            padding: '10px',
            fontSize: '13px',
            fontFamily: 'monospace',
            border: '1px solid #ddd',
            borderRadius: '4px',
            resize: 'vertical',
            boxSizing: 'border-box'
        });
        dialog.appendChild(textarea);

        // Image URL label
        const imageUrlLabel = document.createElement('p');
        imageUrlLabel.textContent = 'Image URL:';
        this._applyStyles(imageUrlLabel, {
            margin: '16px 0 8px 0',
            fontSize: '14px',
            fontWeight: '500',
            color: '#333'
        });
        dialog.appendChild(imageUrlLabel);

        // Image URL textarea
        const imageUrlTextarea = document.createElement('textarea');
        imageUrlTextarea.value = svgUrl;
        imageUrlTextarea.readOnly = true;
        this._applyStyles(imageUrlTextarea, {
            width: '100%',
            height: '50px',
            padding: '10px',
            fontSize: '13px',
            fontFamily: 'monospace',
            border: '1px solid #ddd',
            borderRadius: '4px',
            resize: 'vertical',
            boxSizing: 'border-box'
        });
        dialog.appendChild(imageUrlTextarea);

        // Image URL copy button container
        const imageUrlButtonContainer = document.createElement('div');
        this._applyStyles(imageUrlButtonContainer, {
            marginTop: '8px',
            display: 'flex',
            justifyContent: 'flex-end'
        });

        // Image URL copy button
        const copyImageUrlButton = document.createElement('button');
        copyImageUrlButton.textContent = 'Copy Image URL';
        copyImageUrlButton.type = 'button';
        this._applyStyles(copyImageUrlButton, {
            padding: '6px 12px',
            fontSize: '13px',
            fontWeight: '500',
            color: '#fff',
            background: '#2a6fb8',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
        });
        copyImageUrlButton.addEventListener('click', () => {
            imageUrlTextarea.select();
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(svgUrl).then(() => {
                    copyImageUrlButton.textContent = 'Copied!';
                    setTimeout(() => {
                        copyImageUrlButton.textContent = 'Copy Image URL';
                    }, 2000);
                }).catch(() => {
                    document.execCommand('copy');
                    copyImageUrlButton.textContent = 'Copied!';
                    setTimeout(() => {
                        copyImageUrlButton.textContent = 'Copy Image URL';
                    }, 2000);
                });
            } else {
                document.execCommand('copy');
                copyImageUrlButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyImageUrlButton.textContent = 'Copy Image URL';
                }, 2000);
            }
        });
        imageUrlButtonContainer.appendChild(copyImageUrlButton);
        dialog.appendChild(imageUrlButtonContainer);

        // Preview section
        const previewLabel = document.createElement('p');
        previewLabel.textContent = 'Preview:';
        this._applyStyles(previewLabel, {
            margin: '16px 0 8px 0',
            fontSize: '14px',
            fontWeight: '500',
            color: '#333'
        });
        dialog.appendChild(previewLabel);

        const previewContainer = document.createElement('div');
        this._applyStyles(previewContainer, {
            padding: '12px',
            background: '#f6f8fa',
            borderRadius: '4px',
            textAlign: 'center',
            border: '1px solid #e1e4e8'
        });
        
        const previewLink = document.createElement('a');
        previewLink.href = docUrl;
        previewLink.target = '_blank';
        previewLink.rel = 'noopener noreferrer';
        
        const previewImg = document.createElement('img');
        previewImg.src = svgUrl;
        previewImg.alt = 'Petri Net Preview';
        this._applyStyles(previewImg, {
            maxWidth: '100%',
            height: 'auto',
            display: 'block',
            margin: '0 auto'
        });
        
        previewLink.appendChild(previewImg);
        previewContainer.appendChild(previewLink);
        dialog.appendChild(previewContainer);

        // Button container
        const buttonContainer = document.createElement('div');
        this._applyStyles(buttonContainer, {
            marginTop: '20px',
            display: 'flex',
            gap: '10px',
            justifyContent: 'flex-end'
        });

        // Copy button
        const copyButton = document.createElement('button');
        copyButton.textContent = 'Copy to Clipboard';
        copyButton.type = 'button';
        this._applyStyles(copyButton, {
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: '500',
            color: '#fff',
            background: '#2a6fb8',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
        });
        copyButton.addEventListener('click', () => {
            textarea.select();
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(markdown).then(() => {
                    copyButton.textContent = 'Copied!';
                    setTimeout(() => {
                        copyButton.textContent = 'Copy to Clipboard';
                    }, 2000);
                }).catch(() => {
                    document.execCommand('copy');
                    copyButton.textContent = 'Copied!';
                    setTimeout(() => {
                        copyButton.textContent = 'Copy to Clipboard';
                    }, 2000);
                });
            } else {
                document.execCommand('copy');
                copyButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyButton.textContent = 'Copy to Clipboard';
                }, 2000);
            }
        });
        buttonContainer.appendChild(copyButton);

        // Close button
        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        closeButton.type = 'button';
        this._applyStyles(closeButton, {
            padding: '8px 16px',
            fontSize: '14px',
            fontWeight: '500',
            color: '#333',
            background: '#f6f8fa',
            border: '1px solid #ddd',
            borderRadius: '4px',
            cursor: 'pointer'
        });
        
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
        overlay.appendChild(dialog);

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
                // Get the session token for authentication
                const {data: {session}} = await this._supabase.auth.getSession();
                const authToken = session?.access_token;

                if (!authToken) {
                    alert('Please log in to save as Gist');
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
                    alert(`Failed to save before creating Gist: ${response.statusText}`);
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
                alert('Failed to save document: ' + (err && err.message ? err.message : String(err)));
                return;
            }
        }

        // Generate markdown content
        const currentUrl = window.location.origin;
        const svgUrl = `${currentUrl}/img/${cid}.svg`;
        const docUrl = `${currentUrl}/?cid=${cid}`;
        const markdown = `[![pflow](${svgUrl})](${docUrl})`;

        try {
            // Get GitHub OAuth token from Supabase session
            const {data: {session}} = await this._supabase.auth.getSession();
            
            if (!session || !session.provider_token) {
                alert('GitHub authentication required. Please log out and log in again to grant Gist permissions.');
                return;
            }

            const githubToken = session.provider_token;

            // Create Gist via GitHub API
            const gistResponse = await fetch('https://api.github.com/gists', {
                method: 'POST',
                headers: {
                    'Accept': 'application/vnd.github+json',
                    'Authorization': `Bearer ${githubToken}`,
                    'X-GitHub-Api-Version': '2022-11-28'
                },
                body: JSON.stringify({
                    description: `Petri net diagram - CID: ${cid}`,
                    public: true,
                    files: {
                        [`${cid}.md`]: {
                            content: markdown
                        }
                    }
                })
            });

            if (!gistResponse.ok) {
                const errorData = await gistResponse.json().catch(() => ({}));
                console.error('Gist creation failed:', errorData);
                
                if (gistResponse.status === 401 || gistResponse.status === 404) {
                    alert('GitHub authentication failed or expired. Please log out and log in again to grant Gist permissions.\n\nNote: Make sure to authorize the GitHub provider with gist scope when logging in.');
                } else {
                    alert(`Failed to create Gist: ${errorData.message || gistResponse.statusText}`);
                }
                return;
            }

            const gistData = await gistResponse.json();
            const gistUrl = gistData.html_url;

            // Show success message with Gist URL
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(gistUrl).then(() => {
                    alert(`Gist created successfully!\nURL copied to clipboard.\n\n${gistUrl}`);
                }).catch(() => {
                    alert(`Gist created successfully!\n\n${gistUrl}`);
                });
            } else {
                alert(`Gist created successfully!\n\n${gistUrl}`);
            }

            // Optionally open the Gist in a new tab
            window.open(gistUrl, '_blank', 'noopener,noreferrer');
        } catch (err) {
            console.error('Failed to create Gist:', err);
            alert('Failed to create Gist: ' + (err && err.message ? err.message : String(err)));
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
        const cap = Number.isFinite(n) ? n : Infinity;
        // Treat capacity=0 as unlimited (Infinity)
        return cap === 0 ? Infinity : cap;
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
        // For colored Petri nets, return the full weight vector
        if (arc.weight == null) return [1];
        if (!Array.isArray(arc.weight)) return [Number(arc.weight) || 1];
        return arc.weight.map(w => Number(w) || 0);
    }

    _marking() {
        const marks = {};
        for (const [pid, p] of Object.entries(this._model.places)) {
            // Return the full vector of token counts (one per color)
            marks[pid] = Array.isArray(p.initial) 
                ? p.initial.map(v => Number(v) || 0)
                : [Number(p.initial || 0)];
        }
        return marks;
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
        const p = this._model.places[pid];
        if (!p) return [Infinity];
        // Return the full capacity vector (one per color)
        const arr = Array.isArray(p.capacity) ? p.capacity : [Number(p.capacity || Infinity)];
        return arr.map(cap => {
            const c = Number(cap);
            // Only non-finite values are treated as unlimited (Infinity)
            // capacity=0 means zero capacity (useful for colored nets)
            return Number.isFinite(c) ? c : Infinity;
        });
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
            const w = this._getArcWeight(a);
            const tokens = marks[a.source] ?? [0];

            if (a.inhibitTransition) {
                // input inhibitor: transition disabled while source place has enough tokens of ANY color >= weight
                for (let i = 0; i < Math.max(w.length, tokens.length); i++) {
                    const wVal = w[i] ?? 0;
                    const tVal = tokens[i] ?? 0;
                    if (wVal > 0 && tVal >= wVal) return false;
                }
                // inhibitor doesn't consume tokens
                continue;
            }

            // normal input arc must have enough tokens of EACH color
            for (let i = 0; i < Math.max(w.length, tokens.length); i++) {
                const wVal = w[i] ?? 0;
                const tVal = tokens[i] ?? 0;
                if (tVal < wVal) return false;
            }
        }

        // output arcs (transition -> place)
        const outArcs = this._outArcsOf(tid);
        for (const a of outArcs) {
            const toPlace = this._model.places[a.target];
            if (!toPlace) continue;
            const w = this._getArcWeight(a);
            const tokens = marks[a.target] ?? [0];

            if (a.inhibitTransition) {
                // output inhibitor: transition disabled until target place has enough tokens
                for (let i = 0; i < Math.max(w.length, tokens.length); i++) {
                    const wVal = w[i] ?? 0;
                    const tVal = tokens[i] ?? 0;
                    if (wVal > 0 && tVal < wVal) return false;
                }
                // inhibitor doesn't produce tokens, skip capacity check
                continue;
            }

            // output capacity must not overflow (check each color separately)
            const cap = this._capacityOf(a.target);
            for (let i = 0; i < Math.max(w.length, tokens.length, cap.length); i++) {
                const wVal = w[i] ?? 0;
                const tVal = tokens[i] ?? 0;
                const capVal = cap[i] ?? Infinity;
                if (tVal + wVal > capVal) return false;
            }
        }

        return true;
    }

    _fire(tid) {
        const marks = this._marking();
        if (!this._enabled(tid, marks)) {
            this.dispatchEvent(new CustomEvent('transition-fired-blocked', {detail: {id: tid}}));
            return false;
        }
        
        // Process input arcs (consume tokens)
        for (const a of this._inArcsOf(tid)) {
            const isPlace = !!this._model.places[a.source];
            if (!isPlace) continue;
            if (a.inhibitTransition) continue; // inhibitor arcs don't consume tokens
            
            const w = this._getArcWeight(a);
            const tokens = marks[a.source] ?? [0];
            
            // Element-wise subtraction: tokens[i] -= w[i] for each color i
            marks[a.source] = tokens.map((t, i) => Math.max(0, t - (w[i] ?? 0)));
        }
        
        // Process output arcs (produce tokens)
        for (const a of this._outArcsOf(tid)) {
            const isPlace = !!this._model.places[a.target];
            if (!isPlace) continue;
            if (a.inhibitTransition) continue; // inhibitor arcs don't produce tokens
            
            const w = this._getArcWeight(a);
            const tokens = marks[a.target] ?? [0];
            
            // Element-wise addition: tokens[i] += w[i] for each color i
            // Ensure result array is at least as long as the weight vector
            const maxLen = Math.max(tokens.length, w.length);
            marks[a.target] = Array.from({length: maxLen}, (_, i) => 
                (tokens[i] ?? 0) + (w[i] ?? 0)
            );
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
        this._updateSelectionHighlights();
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
            this._onPlaceClick(id, ev);
        });
        el.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._onPlaceContext(id, ev);
        });
        // Add hover event handlers to show token breakdown
        el.addEventListener('mouseenter', () => {
            this._showTokenBreakdown(id, el);
        });
        el.addEventListener('mouseleave', () => {
            this._hideTokenBreakdown(id);
        });
        // Do not begin drag when in add-token, add-arc, delete or label-edit modes
        handle.addEventListener('pointerdown', (ev) => {
            // Skip drag when shift is held (for multi-select)
            if (ev.shiftKey && (this._mode === 'select' || this._mode === 'add-token' || this._mode === 'delete')) {
                return;
            }
            if (this._selectedNodes.size > 0 && this._selectedNodes.has(id) && this._mode === 'select') {
                // In select mode with selected nodes, drag all selected nodes
                this._beginGroupDrag(ev, id);
            } else if (this._mode !== 'add-token' && this._mode !== 'add-arc' && this._mode !== 'delete' && !this._labelEditMode) {
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
            this._onTransitionClick(id, ev);
        });
        el.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._onTransitionContext(id, ev);
        });
        // Do not begin drag when in add-arc, delete or label-edit modes
        el.addEventListener('pointerdown', (ev) => {
            // Skip drag when shift is held (for multi-select)
            if (ev.shiftKey && (this._mode === 'select' || this._mode === 'delete')) {
                return;
            }
            if (this._selectedNodes.size > 0 && this._selectedNodes.has(id) && this._mode === 'select') {
                // In select mode with selected nodes, drag all selected nodes
                this._beginGroupDrag(ev, id);
            } else if (this._mode !== 'add-arc' && this._mode !== 'delete' && !this._labelEditMode) {
                this._beginDrag(ev, id, 'transition');
            }
        });

        this._stage.appendChild(el);
        this._nodes[id] = el;
    }

    _createWeightBadge(arc, idx) {
        const w = (() => {
            if (arc.weight == null) return 1;
            if (Array.isArray(arc.weight)) {
                // For colored Petri nets, find the first non-zero weight
                for (const weight of arc.weight) {
                    const val = Number(weight) || 0;
                    if (val > 0) return val;
                }
                return 1; // Default to 1 if all weights are zero
            }
            return Number(arc.weight) || 1;
        })();
        const badge = document.createElement('div');
        badge.className = 'pv-weight';
        badge.style.pointerEvents = 'auto';
        badge.dataset.arc = String(idx);
        badge.textContent = w > 1 ? `${w}` : '1';
        this._applyStyles(badge, {position: 'absolute'});

        // mark inhibitor badges so CSS can target them
        if (arc.inhibitTransition) {
            badge.classList.add('pv-weight-inhibit');
            badge.title = (badge.title ? badge.title + ' ' : '') + 'inhibitor';
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

    // ---------------- UI event handlers ----------------
    _onPlaceClick(id, ev) {
        const p = this._model.places[id];
        if (!p) return;

        // Handle label-edit mode first
        if (this._labelEditMode) {
            this._openLabelEditor(id, p.label || id);
            return;
        }

        // Handle shift+click for group selection in compatible modes
        if (ev.shiftKey && (this._mode === 'select' || this._mode === 'add-token' || this._mode === 'delete')) {
            this._toggleNodeSelection(id);
            return;
        }

        // Clear selection on regular click in compatible modes (unless clicking a selected node)
        if (!ev.shiftKey && (this._mode === 'select' || this._mode === 'add-token' || this._mode === 'delete')) {
            if (!this._selectedNodes.has(id)) {
                this._clearSelection();
            }
        }

        if (this._mode === 'select') return;
        if (this._mode === 'add-token') {
            const arr = Array.isArray(p.initial) ? p.initial : [Number(p.initial || 0)];
            arr[0] = (Number(arr[0]) || 0) + 1;
            p.initial = arr;
            this._syncLD();
            this._pushHistory();
            this._renderTokens();
            this._updateTransitionStates();
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
            this._updateTransitionStates();
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

// NEW: drain the queue in strict order, exactly once at a time
    async _drainFireQueue() {
        // if already draining, just bail; the running drain will pick up new items
        if (this._processingFires) return;
        this._processingFires = true;

        try {
            while (this._fireQueue.length > 0) {
                const tid = this._fireQueue.shift();
                const el = this._nodes[tid];
                if (el) el.classList.add('pv-firing');

                // IMPORTANT: take the marking *at fire time*, not cached
                // _fire() already:
                //   - checks _enabled() using fresh marking
                //   - updates marks
                //   - redraws tokens/arcs
                //   - dispatches events
                this._fire(tid);

                if (el) el.classList.remove('pv-firing');

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

        // Handle shift+click for group selection in compatible modes
        if (ev.shiftKey && (this._mode === 'select' || this._mode === 'delete')) {
            this._toggleNodeSelection(id);
            return;
        }

        // Clear selection on regular click in compatible modes (unless clicking a selected node)
        if (!ev.shiftKey && (this._mode === 'select' || this._mode === 'delete')) {
            if (!this._selectedNodes.has(id)) {
                this._clearSelection();
            }
        }

        // normal edit behaviors
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
                const cur = this._getArcWeight(a);
                // Display weight vector as comma-separated values
                const curStr = cur.join(',');
                const ans = prompt('Arc weight (comma-separated for colored nets, e.g., "1,0,0")', curStr);
                if (ans && ans.trim()) {
                    // Parse comma-separated values into an array
                    const values = ans.split(',').map(v => {
                        const num = Number(v.trim());
                        return Number.isNaN(num) ? 0 : Math.max(0, Math.floor(num));
                    });
                    // Ensure at least one positive value
                    if (values.some(v => v > 0)) {
                        a.weight = values;
                        this._normalizeModel();
                        this._renderUI();
                        this._syncLD();
                        this._pushHistory();
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
        if (this._mode === 'add-token') {
            const cur = this._getArcWeight(a);
            // Decrement the first non-zero weight in the vector
            const newWeight = cur.map(w => {
                const val = Number(w) || 0;
                return val > 0 ? Math.max(0, val - 1) : 0;
            });
            // Ensure at least one weight is 1 if all became 0
            if (newWeight.every(w => w === 0)) {
                newWeight[0] = 1;
            }
            a.weight = newWeight;
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
        this._renderUI();
        this._syncLD();
        this._pushHistory();
        
        // Dispatch events for each deleted node
        for (const id of ids) {
            this.dispatchEvent(new CustomEvent('node-deleted', {detail: {id}}));
        }
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
            {mode: 'label-edit', label: '\u{1D4D0}', title: 'Edit Labels (7)', toggle: true},
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

        this._canvasContainer.appendChild(this._menu);
        this._root.addEventListener('click', (ev) => this._onRootClick(ev));

        // Ensure the menu reflects the current mode (e.g. default 'select') right after creation
        this._updateMenuActive();
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
            this._syncLD(true);
            this._pushHistory();

            // Show feedback to user
            alert(`Reverted to revision ${this._originalCid}`);
        } catch (err) {
            console.error('Failed to revert to original CID:', err);
            alert('Failed to revert to original revision: ' + (err && err.message ? err.message : String(err)));
        }
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
            if (btn.dataset.toggle === 'true') {
                // For toggle buttons, highlight based on toggle state
                btn.style.background = this._labelEditMode ? 'rgba(0,0,0,0.08)' : 'transparent';
            } else {
                // For regular mode buttons
                btn.style.background = (btn.dataset.mode === this._mode) ? 'rgba(0,0,0,0.08)' : 'transparent';
            }
        });
        // Update node highlights
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
            alert(error);
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

    _beginGroupDrag(ev, clickedId) {
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
            const offset = isPlace ? 40 : 15;
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
            this._draw();
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

            this._renderUI();
            this._syncLD();
            this._pushHistory();
            this.dispatchEvent(new CustomEvent('group-moved', {detail: {ids: Array.from(this._selectedNodes)}}));
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    }

    _beginCanvasGroupDrag(ev) {
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
            const offset = isPlace ? 40 : 15;
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
            this._draw();
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

            this._renderUI();
            this._syncLD();
            this._pushHistory();
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
        // Use diagram bounds with padding, but at least viewport size
        const padding = 100;
        const w = Math.max(viewportW, bounds.maxX + padding);
        const h = Math.max(viewportH, bounds.maxY + padding);
        
        this._canvas.width = Math.floor(w * this._dpr);
        this._canvas.height = Math.floor(h * this._dpr);
        this._canvas.style.width = `${w}px`;
        this._canvas.style.height = `${h}px`;
        this._ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
        this._draw();
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
        this._updateScaleMeter();
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
        
        ctx.lineWidth = 1;

        const arcs = this._model.arcs || [];
        const marks = this._marking(); // current marking to evaluate arc/transition state

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
            
            // Transform back to untransformed stage coordinates
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
            const active = !!this._enabled(relatedTransitionId, marks);

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
                badge.style.left = `${Math.round(bx - offX)}px`;
                badge.style.top = `${Math.round(by - offY)}px`;
                
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

        // bounding box selection preview
        if (this._boxSelect) {
            const minX = Math.min(this._boxSelect.startX, this._boxSelect.endX);
            const maxX = Math.max(this._boxSelect.startX, this._boxSelect.endX);
            const minY = Math.min(this._boxSelect.startY, this._boxSelect.endY);
            const maxY = Math.max(this._boxSelect.startY, this._boxSelect.endY);

            // Convert to untransformed stage coordinates for drawing
            const x1 = (minX - viewTx) / scale;
            const y1 = (minY - viewTy) / scale;
            const x2 = (maxX - viewTx) / scale;
            const y2 = (maxY - viewTy) / scale;

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

        this._canvasContainer.appendChild(container);
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

    // ---------------- help dialog ----------------
    _showHelpDialog() {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pv-help-dialog-overlay';
        this._applyStyles(overlay, {
            position: 'fixed',
            left: '0',
            top: '0',
            right: '0',
            bottom: '0',
            background: 'rgba(0, 0, 0, 0.5)',
            zIndex: 2147483646,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
        });

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-help-dialog';
        this._applyStyles(dialog, {
            background: '#fff',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '700px',
            width: '100%',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
            maxHeight: '85vh',
            overflow: 'auto'
        });

        // Title
        const title = document.createElement('h2');
        title.textContent = 'Help: Petri Net Editor';
        this._applyStyles(title, {
            margin: '0 0 16px 0',
            fontSize: '22px',
            fontWeight: 'bold',
            color: '#333'
        });
        dialog.appendChild(title);

        // Help content
        const content = document.createElement('div');
        this._applyStyles(content, {
            fontSize: '14px',
            lineHeight: '1.6',
            color: '#444'
        });

        content.innerHTML = `
            <h3 style="margin: 16px 0 8px 0; font-size: 16px; font-weight: 600; color: #000;">What are Petri Nets?</h3>
            <p style="margin: 0 0 12px 0;">
                Petri nets are a formal model for representing state machines. They consist of <strong>places</strong> (circles) 
                that hold tokens, <strong>transitions</strong> (rectangles) that fire to move tokens, and <strong>arcs</strong> (arrows) 
                that connect them. When a transition fires, it consumes tokens from input places and produces tokens in output places.
            </p>

            <h3 style="margin: 16px 0 8px 0; font-size: 16px; font-weight: 600; color: #000;">Controls & Features</h3>
            
            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Toolbar Buttons:</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
                <li><strong>⛶ Select:</strong> Default mode for panning and selecting elements</li>
                <li><strong>◯ Place:</strong> Click to add places (token holders)</li>
                <li><strong>▢ Transition:</strong> Click to add transitions (firing elements)</li>
                <li><strong>→ Arc:</strong> Click source then target to create connections. Right-click the target to create an inhibitor arc (prevents transition from firing when place has tokens)</li>
                <li><strong>• Token:</strong> Click places to add/remove tokens</li>
                <li><strong>🗑 Delete:</strong> Click elements to remove them</li>
                <li><strong>𝓐 Label:</strong> Click elements to edit their labels</li>
                <li><strong>▶ Play:</strong> Start/stop automatic simulation</li>
            </ul>

            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Mouse Actions:</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
                <li><strong>Left-click transition:</strong> Fire it manually (if enabled)</li>
                <li><strong>Right-click place:</strong> Add or remove tokens</li>
                <li><strong>Right-click arc:</strong> Change arc weight</li>
                <li><strong>Drag elements:</strong> Reposition places and transitions</li>
                <li><strong>Mouse wheel:</strong> Zoom in/out</li>
                <li><strong>Space + drag:</strong> Pan the canvas</li>
            </ul>

            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Selection & Multi-Select:</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
                <li><strong>Shift + click node:</strong> Add/remove individual nodes from selection (in Select, Token, and Delete modes)</li>
                <li><strong>Shift + drag on canvas:</strong> Draw a bounding box to select all nodes within it. A dashed orange rectangle shows the selection area as you drag</li>
                <li><strong>Selected nodes:</strong> Highlighted with orange outline and shadow. Can be dragged together or deleted as a group</li>
            </ul>

            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Keyboard Shortcuts:</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
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
            </ul>

            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Other Features:</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
                <li><strong>JSON Editor:</strong> Toggle to edit the model as JSON-LD</li>
                <li><strong>Scale Meter:</strong> Shows current zoom level (right side)</li>
                <li><strong>Download:</strong> Export your Petri net as JSON</li>
                <li><strong>Auto-save:</strong> Changes are saved to browser localStorage</li>
            </ul>

            <h3 style="margin: 16px 0 8px 0; font-size: 16px; font-weight: 600; color: #000;">ODE Simulation</h3>
            <p style="margin: 0 0 12px 0;">
                The ODE (Ordinary Differential Equation) simulator models continuous-time behavior of Petri nets using mass action kinetics. 
                Access it from the hamburger menu: <strong>🧮 Simulate (ODE)</strong>
            </p>
            
            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Key Features:</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
                <li><strong>Transition Rates:</strong> Set rate constants for each transition (default is 1.0)</li>
                <li><strong>Rate=0 for Optimization:</strong> Setting a transition's rate to 0 disables it, useful for:
                    <ul style="margin: 4px 0 4px 20px;">
                        <li>Knapsack problems: Exclude items to find optimal solutions</li>
                        <li>Resource allocation: Test different configurations</li>
                        <li>Sensitivity analysis: Identify which transitions improve objectives</li>
                    </ul>
                </li>
                <li><strong>Tsit5 Solver:</strong> High-accuracy 5th order Runge-Kutta method with adaptive time stepping</li>
                <li><strong>Interactive Plotting:</strong> Select which places to visualize and view real-time SVG plots</li>
                <li><strong>Configurable Parameters:</strong> Adjust time span, dt, absolute/relative tolerances</li>
            </ul>
            
            <p style="margin: 0 0 12px 0;">
                <strong>Example:</strong> In a knapsack problem with limited capacity, setting rate=0 for a transition effectively 
                removes that item from consideration. This frees up capacity for other transitions, potentially increasing the total 
                value if the excluded item had a poor value-to-weight ratio.
            </p>

            <h3 style="margin: 16px 0 8px 0; font-size: 16px; font-weight: 600; color: #000;">Layout Algorithms</h3>
            <p style="margin: 0 0 12px 0;">
                Use the <strong>🎨 Layout Algorithms</strong> menu to automatically arrange your Petri net nodes:
            </p>
            
            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Available Layouts:</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
                <li><strong>⚛️ Force-Atlas 2:</strong> Physics-based force-directed layout. Creates natural-looking graphs with even spacing. 
                Nodes repel each other while connected nodes are pulled together, creating an organic arrangement. 
                Best for general-purpose visualization and exploring graph structure.</li>
                
                <li><strong>📊 Hierarchical:</strong> Simple top-to-bottom layered layout using topological sorting. 
                Works well for linear workflows and simple directed acyclic graphs (DAGs). 
                Nodes with no incoming edges are placed at the top, and each subsequent layer contains nodes whose predecessors have been placed. 
                <em>Note: May place all nodes on one level if the graph contains cycles.</em></li>
                
                <li><strong>🔷 Layered (DAG):</strong> Advanced hierarchical layout that handles complex graphs and cycles. 
                Uses cycle-breaking to convert cyclic graphs into DAGs, then applies layered layout. 
                Identifies feedback edges (back edges that create cycles) and ignores them during layout, 
                placing nodes in clear hierarchical layers. Best for large, complex Petri nets with cycles.</li>
                
                <li><strong>➡️ Horizontal DAG:</strong> Left-to-right hierarchical layout for directed acyclic graphs. 
                Similar to Layered (DAG) but arranges nodes horizontally instead of vertically. 
                Ideal for visualizing process flows, pipelines, and workflows that naturally progress from left to right. 
                Handles cycles using the same feedback edge breaking algorithm.</li>
                
                <li><strong>⭕ Circular:</strong> Arranges all nodes evenly spaced around a circle. 
                Good for visualizing cyclic relationships and symmetric structures. 
                Makes it easy to see all nodes at once and identify connection patterns.</li>
            </ul>
            
            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Which Layout to Choose?</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
                <li><strong>Simple linear workflow:</strong> Use Hierarchical</li>
                <li><strong>Complex workflow with cycles:</strong> Use Layered (DAG) or Horizontal DAG</li>
                <li><strong>Process flows/pipelines:</strong> Use Horizontal DAG for left-to-right orientation</li>
                <li><strong>Explore structure/connections:</strong> Use Force-Atlas 2</li>
                <li><strong>Cyclic or symmetric patterns:</strong> Use Circular</li>
            </ul>
        `;

        dialog.appendChild(content);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Close';
        closeBtn.type = 'button';
        this._applyStyles(closeBtn, {
            marginTop: '20px',
            padding: '10px 24px',
            fontSize: '14px',
            fontWeight: '500',
            background: '#007bff',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'background 0.2s'
        });
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = '#0056b3';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = '#007bff';
        });
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

    // ---------------- ODE simulation dialog ----------------
    async _showSimulationDialog() {
        // Load solver module dynamically
        if (!this._solverModule) {
            try {
                this._solverModule = await import('./petri-solver.js');
            } catch (err) {
                alert('Failed to load simulation module: ' + err.message);
                console.error('Failed to load petri-solver.js:', err);
                return;
            }
        }

        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pv-simulation-dialog-overlay';
        this._applyStyles(overlay, {
            position: 'fixed',
            left: '0',
            top: '0',
            right: '0',
            bottom: '0',
            background: 'rgba(0, 0, 0, 0.5)',
            zIndex: 2147483646,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
        });

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-simulation-dialog';
        this._applyStyles(dialog, {
            background: '#fff',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '900px',
            width: '100%',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
            maxHeight: '90vh',
            overflow: 'auto',
            display: 'flex',
            flexDirection: 'column'
        });

        // Title
        const title = document.createElement('h2');
        title.textContent = 'ODE Simulation';
        this._applyStyles(title, {
            margin: '0 0 16px 0',
            fontSize: '22px',
            fontWeight: 'bold',
            color: '#333'
        });
        dialog.appendChild(title);

        // Description
        const desc = document.createElement('p');
        desc.textContent = 'Simulate the Petri net using ordinary differential equations (ODE solver). Configure simulation parameters and select which places to plot.';
        this._applyStyles(desc, {
            margin: '0 0 20px 0',
            fontSize: '14px',
            color: '#555',
            lineHeight: '1.5'
        });
        dialog.appendChild(desc);

        // Controls container
        const controlsContainer = document.createElement('div');
        this._applyStyles(controlsContainer, {
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '20px',
            marginBottom: '20px'
        });
        dialog.appendChild(controlsContainer);

        // Left column - Simulation parameters
        const leftColumn = document.createElement('div');
        controlsContainer.appendChild(leftColumn);

        // Time parameters
        const timeSection = document.createElement('div');
        this._applyStyles(timeSection, {
            marginBottom: '16px'
        });
        leftColumn.appendChild(timeSection);

        const timeTitle = document.createElement('h3');
        timeTitle.textContent = 'Time Parameters';
        this._applyStyles(timeTitle, {
            margin: '0 0 8px 0',
            fontSize: '16px',
            fontWeight: '600',
            color: '#333'
        });
        timeSection.appendChild(timeTitle);

        const timeStartLabel = document.createElement('label');
        timeStartLabel.textContent = 'Start Time:';
        this._applyStyles(timeStartLabel, {
            display: 'block',
            fontSize: '13px',
            marginBottom: '4px',
            color: '#444'
        });
        timeSection.appendChild(timeStartLabel);

        const timeStartInput = document.createElement('input');
        timeStartInput.type = 'number';
        timeStartInput.value = '0';
        timeStartInput.step = '0.1';
        this._applyStyles(timeStartInput, {
            width: '100%',
            padding: '6px',
            fontSize: '13px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            marginBottom: '8px'
        });
        timeSection.appendChild(timeStartInput);

        const timeEndLabel = document.createElement('label');
        timeEndLabel.textContent = 'End Time:';
        this._applyStyles(timeEndLabel, {
            display: 'block',
            fontSize: '13px',
            marginBottom: '4px',
            color: '#444'
        });
        timeSection.appendChild(timeEndLabel);

        const timeEndInput = document.createElement('input');
        timeEndInput.type = 'number';
        timeEndInput.value = '10';
        timeEndInput.step = '0.1';
        this._applyStyles(timeEndInput, {
            width: '100%',
            padding: '6px',
            fontSize: '13px',
            border: '1px solid #ccc',
            borderRadius: '4px'
        });
        timeSection.appendChild(timeEndInput);

        // Solver options
        const solverSection = document.createElement('div');
        this._applyStyles(solverSection, {
            marginBottom: '16px'
        });
        leftColumn.appendChild(solverSection);

        const solverTitle = document.createElement('h3');
        solverTitle.textContent = 'Solver Options';
        this._applyStyles(solverTitle, {
            margin: '0 0 8px 0',
            fontSize: '16px',
            fontWeight: '600',
            color: '#333'
        });
        solverSection.appendChild(solverTitle);

        const dtLabel = document.createElement('label');
        dtLabel.textContent = 'Initial Time Step (dt):';
        this._applyStyles(dtLabel, {
            display: 'block',
            fontSize: '13px',
            marginBottom: '4px',
            color: '#444'
        });
        solverSection.appendChild(dtLabel);

        const dtInput = document.createElement('input');
        dtInput.type = 'number';
        dtInput.value = '0.01';
        dtInput.step = '0.001';
        this._applyStyles(dtInput, {
            width: '100%',
            padding: '6px',
            fontSize: '13px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            marginBottom: '8px'
        });
        solverSection.appendChild(dtInput);

        const abstolLabel = document.createElement('label');
        abstolLabel.textContent = 'Absolute Tolerance:';
        this._applyStyles(abstolLabel, {
            display: 'block',
            fontSize: '13px',
            marginBottom: '4px',
            color: '#444'
        });
        solverSection.appendChild(abstolLabel);

        const abstolInput = document.createElement('input');
        abstolInput.type = 'number';
        abstolInput.value = '1e-6';
        abstolInput.step = '1e-7';
        this._applyStyles(abstolInput, {
            width: '100%',
            padding: '6px',
            fontSize: '13px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            marginBottom: '8px'
        });
        solverSection.appendChild(abstolInput);

        const reltolLabel = document.createElement('label');
        reltolLabel.textContent = 'Relative Tolerance:';
        this._applyStyles(reltolLabel, {
            display: 'block',
            fontSize: '13px',
            marginBottom: '4px',
            color: '#444'
        });
        solverSection.appendChild(reltolLabel);

        const reltolInput = document.createElement('input');
        reltolInput.type = 'number';
        reltolInput.value = '1e-3';
        reltolInput.step = '1e-4';
        this._applyStyles(reltolInput, {
            width: '100%',
            padding: '6px',
            fontSize: '13px',
            border: '1px solid #ccc',
            borderRadius: '4px'
        });
        solverSection.appendChild(reltolInput);

        // Right column - Variable selection and rates
        const rightColumn = document.createElement('div');
        controlsContainer.appendChild(rightColumn);

        // Variables to plot
        const variablesSection = document.createElement('div');
        this._applyStyles(variablesSection, {
            marginBottom: '16px'
        });
        rightColumn.appendChild(variablesSection);

        const variablesTitle = document.createElement('h3');
        variablesTitle.textContent = 'Places to Plot';
        this._applyStyles(variablesTitle, {
            margin: '0 0 8px 0',
            fontSize: '16px',
            fontWeight: '600',
            color: '#333'
        });
        variablesSection.appendChild(variablesTitle);

        const variablesContainer = document.createElement('div');
        this._applyStyles(variablesContainer, {
            maxHeight: '150px',
            overflow: 'auto',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '8px',
            background: '#fafafa'
        });
        variablesSection.appendChild(variablesContainer);

        // Add checkboxes for each place
        const placeCheckboxes = {};
        const placeLabels = Object.keys(this._model.places || {});
        if (placeLabels.length === 0) {
            const noPlaces = document.createElement('p');
            noPlaces.textContent = 'No places in the model';
            this._applyStyles(noPlaces, {
                margin: '0',
                fontSize: '13px',
                color: '#999',
                fontStyle: 'italic'
            });
            variablesContainer.appendChild(noPlaces);
        } else {
            placeLabels.forEach((label, idx) => {
                const checkboxWrapper = document.createElement('div');
                this._applyStyles(checkboxWrapper, {
                    marginBottom: '6px',
                    display: 'flex',
                    alignItems: 'center'
                });

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.id = 'var-' + label;
                checkbox.checked = idx < 5; // Check first 5 by default
                checkbox.value = label;
                this._applyStyles(checkbox, {
                    marginRight: '8px',
                    cursor: 'pointer'
                });
                checkboxWrapper.appendChild(checkbox);
                placeCheckboxes[label] = checkbox;

                const checkboxLabel = document.createElement('label');
                checkboxLabel.textContent = label;
                checkboxLabel.htmlFor = 'var-' + label;
                this._applyStyles(checkboxLabel, {
                    fontSize: '13px',
                    cursor: 'pointer',
                    color: '#444'
                });
                checkboxWrapper.appendChild(checkboxLabel);

                variablesContainer.appendChild(checkboxWrapper);
            });
        }

        // Transition rates
        const ratesSection = document.createElement('div');
        rightColumn.appendChild(ratesSection);

        const ratesTitle = document.createElement('h3');
        ratesTitle.textContent = 'Transition Rates';
        this._applyStyles(ratesTitle, {
            margin: '0 0 8px 0',
            fontSize: '16px',
            fontWeight: '600',
            color: '#333'
        });
        ratesSection.appendChild(ratesTitle);

        const ratesContainer = document.createElement('div');
        this._applyStyles(ratesContainer, {
            maxHeight: '150px',
            overflow: 'auto',
            border: '1px solid #ccc',
            borderRadius: '4px',
            padding: '8px',
            background: '#fafafa'
        });
        ratesSection.appendChild(ratesContainer);

        const transitionRateInputs = {};
        const transitionLabels = Object.keys(this._model.transitions || {});
        if (transitionLabels.length === 0) {
            const noTransitions = document.createElement('p');
            noTransitions.textContent = 'No transitions in the model';
            this._applyStyles(noTransitions, {
                margin: '0',
                fontSize: '13px',
                color: '#999',
                fontStyle: 'italic'
            });
            ratesContainer.appendChild(noTransitions);
        } else {
            transitionLabels.forEach(label => {
                const rateWrapper = document.createElement('div');
                this._applyStyles(rateWrapper, {
                    marginBottom: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                });

                const rateLabel = document.createElement('label');
                rateLabel.textContent = label + ':';
                this._applyStyles(rateLabel, {
                    fontSize: '13px',
                    color: '#444',
                    flex: '1',
                    marginRight: '8px'
                });
                rateWrapper.appendChild(rateLabel);

                const rateInput = document.createElement('input');
                rateInput.type = 'number';
                rateInput.value = '1.0';
                rateInput.step = '0.1';
                rateInput.min = '0';
                this._applyStyles(rateInput, {
                    width: '80px',
                    padding: '4px',
                    fontSize: '13px',
                    border: '1px solid #ccc',
                    borderRadius: '4px'
                });
                rateWrapper.appendChild(rateInput);
                transitionRateInputs[label] = rateInput;

                ratesContainer.appendChild(rateWrapper);
            });
        }

        // Plot area
        const plotContainer = document.createElement('div');
        this._applyStyles(plotContainer, {
            marginTop: '20px',
            padding: '16px',
            border: '1px solid #ddd',
            borderRadius: '8px',
            background: '#f9f9f9',
            minHeight: '400px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
        });
        dialog.appendChild(plotContainer);

        const plotPlaceholder = document.createElement('p');
        plotPlaceholder.textContent = 'Click "Run Simulation" to generate plot';
        this._applyStyles(plotPlaceholder, {
            margin: '0',
            fontSize: '14px',
            color: '#999',
            fontStyle: 'italic'
        });
        plotContainer.appendChild(plotPlaceholder);

        // Buttons container
        const buttonsContainer = document.createElement('div');
        this._applyStyles(buttonsContainer, {
            marginTop: '20px',
            display: 'flex',
            gap: '12px',
            justifyContent: 'flex-end'
        });
        dialog.appendChild(buttonsContainer);

        // Run simulation button
        const runButton = document.createElement('button');
        runButton.textContent = 'Run Simulation';
        runButton.type = 'button';
        this._applyStyles(runButton, {
            padding: '10px 20px',
            fontSize: '14px',
            fontWeight: '600',
            color: '#fff',
            background: '#0366d6',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer'
        });
        runButton.addEventListener('click', () => {
            this._runODESimulation({
                timeStartInput,
                timeEndInput,
                dtInput,
                abstolInput,
                reltolInput,
                placeCheckboxes,
                transitionRateInputs,
                plotContainer,
                runButton
            });
        });
        buttonsContainer.appendChild(runButton);

        // Close button
        const closeButton = document.createElement('button');
        closeButton.textContent = 'Close';
        closeButton.type = 'button';
        this._applyStyles(closeButton, {
            padding: '10px 20px',
            fontSize: '14px',
            fontWeight: '600',
            color: '#333',
            background: '#f3f3f3',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer'
        });
        closeButton.addEventListener('click', () => {
            document.body.removeChild(overlay);
        });
        buttonsContainer.appendChild(closeButton);

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // Close on overlay click
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                document.body.removeChild(overlay);
            }
        });

        this._simulationDialog = overlay;
    }

    async _runODESimulation(params) {
        const {
            timeStartInput,
            timeEndInput,
            dtInput,
            abstolInput,
            reltolInput,
            placeCheckboxes,
            transitionRateInputs,
            plotContainer,
            runButton
        } = params;

        try {
            // Disable run button during simulation
            runButton.disabled = true;
            runButton.textContent = 'Running...';

            // Get selected variables
            const selectedVars = [];
            for (const [label, checkbox] of Object.entries(placeCheckboxes)) {
                if (checkbox.checked) {
                    selectedVars.push(label);
                }
            }

            if (selectedVars.length === 0) {
                alert('Please select at least one place to plot');
                return;
            }

            // Get transition rates
            const rates = {};
            for (const [label, input] of Object.entries(transitionRateInputs)) {
                rates[label] = parseFloat(input.value) || 1.0;
            }

            // Parse simulation parameters
            const tstart = parseFloat(timeStartInput.value) || 0;
            const tend = parseFloat(timeEndInput.value) || 10;
            const dt = parseFloat(dtInput.value) || 0.01;
            const abstol = parseFloat(abstolInput.value) || 1e-6;
            const reltol = parseFloat(reltolInput.value) || 1e-3;

            // Create Petri net from model
            const net = this._solverModule.fromJSON(this._model);
            const initialState = this._solverModule.setState(net);

            // Create ODE problem
            const prob = new this._solverModule.ODEProblem(
                net,
                initialState,
                [tstart, tend],
                rates
            );

            // Solve
            const sol = this._solverModule.solve(prob, this._solverModule.Tsit5(), {
                dt: dt,
                abstol: abstol,
                reltol: reltol,
                adaptive: true
            });

            // Generate plot
            const plotResult = this._solverModule.SVGPlotter.plotSolution(sol, selectedVars, {
                title: 'Petri Net ODE Simulation',
                xlabel: 'Time',
                ylabel: 'Token Count',
                width: plotContainer.offsetWidth - 32 || 800,
                height: 400
            });

            // Display plot
            plotContainer.innerHTML = plotResult.svg;
            plotResult.setupInteractivity();

            // Show success message
            console.log('Simulation completed successfully');
            console.log('Final state:', sol.getFinalState());

        } catch (err) {
            console.error('Simulation error:', err);
            alert('Simulation failed: ' + err.message);
            plotContainer.innerHTML = '<p style="color: red; margin: 0;">Simulation failed: ' + err.message + '</p>';
        } finally {
            // Re-enable run button
            runButton.disabled = false;
            runButton.textContent = 'Run Simulation';
        }
    }

    // ---------------- layout algorithms dialog ----------------
    _showLayoutAlgorithmsDialog() {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'pv-layout-dialog-overlay';
        this._applyStyles(overlay, {
            position: 'fixed',
            left: '0',
            top: '0',
            right: '0',
            bottom: '0',
            background: 'rgba(0, 0, 0, 0.5)',
            zIndex: 2147483646,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px'
        });

        // Create dialog
        const dialog = document.createElement('div');
        dialog.className = 'pv-layout-dialog';
        this._applyStyles(dialog, {
            background: '#fff',
            borderRadius: '8px',
            padding: '24px',
            maxWidth: '500px',
            width: '100%',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
            maxHeight: '85vh',
            overflow: 'auto'
        });

        // Title
        const title = document.createElement('h2');
        title.textContent = 'Layout Algorithms';
        this._applyStyles(title, {
            margin: '0 0 16px 0',
            fontSize: '22px',
            fontWeight: 'bold',
            color: '#333'
        });
        dialog.appendChild(title);

        // Description
        const desc = document.createElement('p');
        desc.textContent = 'Apply a layout algorithm to automatically arrange your Petri net nodes:';
        this._applyStyles(desc, {
            margin: '0 0 16px 0',
            fontSize: '14px',
            color: '#666'
        });
        dialog.appendChild(desc);

        // Layout options container
        const optionsContainer = document.createElement('div');
        this._applyStyles(optionsContainer, {
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
        });

        const createLayoutButton = (name, description, iconEmoji, onClick) => {
            const button = document.createElement('button');
            button.type = 'button';
            this._applyStyles(button, {
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                padding: '16px',
                background: '#f8f9fa',
                border: '2px solid #e1e4e8',
                borderRadius: '8px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                textAlign: 'left'
            });

            const header = document.createElement('div');
            this._applyStyles(header, {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                marginBottom: '8px'
            });

            const icon = document.createElement('span');
            icon.textContent = iconEmoji;
            this._applyStyles(icon, {
                fontSize: '20px'
            });
            header.appendChild(icon);

            const nameEl = document.createElement('span');
            nameEl.textContent = name;
            this._applyStyles(nameEl, {
                fontSize: '16px',
                fontWeight: '600',
                color: '#333'
            });
            header.appendChild(nameEl);

            button.appendChild(header);

            const descEl = document.createElement('div');
            descEl.textContent = description;
            this._applyStyles(descEl, {
                fontSize: '13px',
                color: '#666',
                lineHeight: '1.4'
            });
            button.appendChild(descEl);

            button.addEventListener('mouseenter', () => {
                button.style.background = '#e9ecef';
                button.style.borderColor = '#007bff';
            });
            button.addEventListener('mouseleave', () => {
                button.style.background = '#f8f9fa';
                button.style.borderColor = '#e1e4e8';
            });
            button.addEventListener('click', () => {
                onClick();
                document.body.removeChild(overlay);
            });

            return button;
        };

        // Add layout algorithm buttons
        const forceAtlasBtn = createLayoutButton(
            'Force-Atlas 2',
            'Physics-based force-directed layout that creates natural-looking graphs with even spacing',
            '⚛️',
            () => this._applyForceAtlas2Layout()
        );
        optionsContainer.appendChild(forceAtlasBtn);

        const hierarchicalBtn = createLayoutButton(
            'Hierarchical',
            'Arranges nodes in layers from top to bottom, ideal for simple linear workflows',
            '📊',
            () => this._applyHierarchicalLayout()
        );
        optionsContainer.appendChild(hierarchicalBtn);

        const dagBtn = createLayoutButton(
            'Layered (DAG)',
            'Advanced hierarchical layout that handles complex graphs and cycles by breaking feedback edges',
            '🔷',
            () => this._applySugiyamaLayout()
        );
        optionsContainer.appendChild(dagBtn);

        const horizontalDagBtn = createLayoutButton(
            'Horizontal DAG',
            'Left-to-right hierarchical layout for DAGs, ideal for process flows and pipelines',
            '➡️',
            () => this._applyHorizontalDagLayout()
        );
        optionsContainer.appendChild(horizontalDagBtn);

        const circularBtn = createLayoutButton(
            'Circular',
            'Arranges all nodes in a circle, good for visualizing cyclic relationships',
            '⭕',
            () => this._applyCircularLayout()
        );
        optionsContainer.appendChild(circularBtn);

        dialog.appendChild(optionsContainer);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'Cancel';
        closeBtn.type = 'button';
        this._applyStyles(closeBtn, {
            marginTop: '20px',
            padding: '10px 24px',
            fontSize: '14px',
            fontWeight: '500',
            background: '#6c757d',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'background 0.2s'
        });
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = '#5a6268';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = '#6c757d';
        });
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

    _applyForceAtlas2Layout() {
        // Save state for undo
        this._pushHistory();

        // Get all nodes (places and transitions)
        const nodes = [];
        const nodeMap = new Map();
        
        // Add places
        for (const [id, place] of Object.entries(this._model.places || {})) {
            const node = { id, x: place.x || 0, y: place.y || 0, type: 'place' };
            nodes.push(node);
            nodeMap.set(id, node);
        }
        
        // Add transitions
        for (const [id, transition] of Object.entries(this._model.transitions || {})) {
            const node = { id, x: transition.x || 0, y: transition.y || 0, type: 'transition' };
            nodes.push(node);
            nodeMap.set(id, node);
        }

        if (nodes.length === 0) return;

        // Build edge list from arcs
        const edges = [];
        for (const arc of (this._model.arcs || [])) {
            const source = nodeMap.get(arc.source);
            const target = nodeMap.get(arc.target);
            if (source && target) {
                edges.push({ source, target });
            }
        }

        // Force-Atlas 2 parameters
        const iterations = 500;
        const gravity = 0.5;
        const scalingRatio = 50;
        const edgeWeightInfluence = 1.0;

        // Initialize velocities
        nodes.forEach(node => {
            node.vx = 0;
            node.vy = 0;
        });

        // Run simulation
        for (let iter = 0; iter < iterations; iter++) {
            // Calculate repulsive forces (all pairs)
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const n1 = nodes[i];
                    const n2 = nodes[j];
                    const dx = n2.x - n1.x;
                    const dy = n2.y - n1.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                    
                    // Repulsion force (inverse square)
                    const force = scalingRatio * scalingRatio / dist;
                    const fx = (dx / dist) * force;
                    const fy = (dy / dist) * force;
                    
                    n1.vx -= fx;
                    n1.vy -= fy;
                    n2.vx += fx;
                    n2.vy += fy;
                }
            }

            // Calculate attractive forces (edges)
            for (const edge of edges) {
                const dx = edge.target.x - edge.source.x;
                const dy = edge.target.y - edge.source.y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                
                // Attraction force (proportional to distance)
                const force = (dist / scalingRatio) * edgeWeightInfluence;
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                
                edge.source.vx += fx;
                edge.source.vy += fy;
                edge.target.vx -= fx;
                edge.target.vy -= fy;
            }

            // Apply gravity toward center
            const centerX = nodes.reduce((sum, n) => sum + n.x, 0) / nodes.length;
            const centerY = nodes.reduce((sum, n) => sum + n.y, 0) / nodes.length;
            
            for (const node of nodes) {
                const dx = centerX - node.x;
                const dy = centerY - node.y;
                node.vx += dx * gravity;
                node.vy += dy * gravity;
            }

            // Update positions with damping
            const damping = 0.5;
            for (const node of nodes) {
                node.x += node.vx * damping;
                node.y += node.vy * damping;
                node.vx *= 0.9; // velocity decay
                node.vy *= 0.9;
            }
        }

        // Find bounds and scale to reasonable size
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const node of nodes) {
            minX = Math.min(minX, node.x);
            maxX = Math.max(maxX, node.x);
            minY = Math.min(minY, node.y);
            maxY = Math.max(maxY, node.y);
        }

        const width = maxX - minX || 1;
        const height = maxY - minY || 1;
        const targetWidth = 800;
        const targetHeight = 600;
        const scale = Math.min(targetWidth / width, targetHeight / height);

        // Apply positions back to model
        for (const node of nodes) {
            const scaledX = Math.round((node.x - minX) * scale + 100);
            const scaledY = Math.round((node.y - minY) * scale + 100);
            
            if (node.type === 'place') {
                this._model.places[node.id].x = scaledX;
                this._model.places[node.id].y = scaledY;
            } else {
                this._model.transitions[node.id].x = scaledX;
                this._model.transitions[node.id].y = scaledY;
            }
        }

        // Ensure all coordinates are non-negative
        this._normalizeNodePositions(100);

        // Update the view
        this._renderUI();
        this._syncLD();
    }

    _applyHierarchicalLayout() {
        // Save state for undo
        this._pushHistory();

        // Get all nodes
        const nodes = new Map();
        for (const [id, place] of Object.entries(this._model.places || {})) {
            nodes.set(id, { id, type: 'place', level: -1, inDegree: 0, outDegree: 0 });
        }
        for (const [id, transition] of Object.entries(this._model.transitions || {})) {
            nodes.set(id, { id, type: 'transition', level: -1, inDegree: 0, outDegree: 0 });
        }

        if (nodes.size === 0) return;

        // Build adjacency information
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
                nodes.get(arc.source).outDegree++;
                nodes.get(arc.target).inDegree++;
            }
        }

        // Topological sort to assign levels (Kahn's algorithm)
        const queue = [];
        const inDegreeMap = new Map();
        
        for (const [id, node] of nodes) {
            inDegreeMap.set(id, node.inDegree);
            if (node.inDegree === 0) {
                node.level = 0;
                queue.push(id);
            }
        }

        while (queue.length > 0) {
            const currentId = queue.shift();
            const currentLevel = nodes.get(currentId).level;

            for (const targetId of outgoing.get(currentId)) {
                const targetNode = nodes.get(targetId);
                inDegreeMap.set(targetId, inDegreeMap.get(targetId) - 1);
                
                if (inDegreeMap.get(targetId) === 0) {
                    targetNode.level = currentLevel + 1;
                    queue.push(targetId);
                }
            }
        }

        // Assign level 0 to any remaining unassigned nodes (cycles)
        for (const [id, node] of nodes) {
            if (node.level === -1) {
                node.level = 0;
            }
        }

        // Group nodes by level
        const levels = new Map();
        let maxLevel = 0;
        for (const [id, node] of nodes) {
            if (!levels.has(node.level)) {
                levels.set(node.level, []);
            }
            levels.get(node.level).push(node);
            maxLevel = Math.max(maxLevel, node.level);
        }

        // Layout parameters
        const levelHeight = 150;
        const nodeSpacing = 100;
        const startX = 100;
        const startY = 100;

        // Position nodes
        for (let level = 0; level <= maxLevel; level++) {
            const nodesAtLevel = levels.get(level) || [];
            const levelWidth = nodesAtLevel.length * nodeSpacing;
            const startXForLevel = startX + (800 - levelWidth) / 2;

            nodesAtLevel.forEach((node, index) => {
                const x = Math.round(startXForLevel + index * nodeSpacing);
                const y = Math.round(startY + level * levelHeight);

                if (node.type === 'place') {
                    this._model.places[node.id].x = x;
                    this._model.places[node.id].y = y;
                } else {
                    this._model.transitions[node.id].x = x;
                    this._model.transitions[node.id].y = y;
                }
            });
        }

        // Ensure all coordinates are non-negative
        this._normalizeNodePositions(100);

        // Update the view
        this._renderUI();
        this._syncLD();
    }

    _applySugiyamaLayout() {
        // Save state for undo
        this._pushHistory();

        // Get all nodes
        const nodes = new Map();
        for (const [id, place] of Object.entries(this._model.places || {})) {
            nodes.set(id, { id, type: 'place', level: -1, inDegree: 0, outDegree: 0 });
        }
        for (const [id, transition] of Object.entries(this._model.transitions || {})) {
            nodes.set(id, { id, type: 'transition', level: -1, inDegree: 0, outDegree: 0 });
        }

        if (nodes.size === 0) return;

        // Build adjacency information
        const outgoing = new Map();
        const incoming = new Map();
        for (const [id] of nodes) {
            outgoing.set(id, []);
            incoming.set(id, []);
        }

        const edges = [];
        for (const arc of (this._model.arcs || [])) {
            if (nodes.has(arc.source) && nodes.has(arc.target)) {
                edges.push({ source: arc.source, target: arc.target });
                outgoing.get(arc.source).push(arc.target);
                incoming.get(arc.target).push(arc.source);
                nodes.get(arc.source).outDegree++;
                nodes.get(arc.target).inDegree++;
            }
        }

        // Phase 1: Break cycles using DFS to identify back edges
        const visited = new Set();
        const recursionStack = new Set();
        const backEdges = new Set();
        
        const dfs = (nodeId) => {
            visited.add(nodeId);
            recursionStack.add(nodeId);
            
            for (const targetId of outgoing.get(nodeId)) {
                if (!visited.has(targetId)) {
                    dfs(targetId);
                } else if (recursionStack.has(targetId)) {
                    // Back edge found (creates a cycle)
                    backEdges.add(`${nodeId}->${targetId}`);
                }
            }
            
            recursionStack.delete(nodeId);
        };

        // Run DFS from all unvisited nodes
        for (const [id] of nodes) {
            if (!visited.has(id)) {
                dfs(id);
            }
        }

        // Phase 2: Assign levels using modified topological sort (ignoring back edges)
        const queue = [];
        const inDegreeMap = new Map();
        
        for (const [id, node] of nodes) {
            let effectiveInDegree = 0;
            for (const sourceId of incoming.get(id)) {
                const edgeKey = `${sourceId}->${id}`;
                if (!backEdges.has(edgeKey)) {
                    effectiveInDegree++;
                }
            }
            inDegreeMap.set(id, effectiveInDegree);
            if (effectiveInDegree === 0) {
                node.level = 0;
                queue.push(id);
            }
        }

        let maxLevel = 0;
        while (queue.length > 0) {
            const currentId = queue.shift();
            const currentLevel = nodes.get(currentId).level;
            maxLevel = Math.max(maxLevel, currentLevel);

            for (const targetId of outgoing.get(currentId)) {
                const edgeKey = `${currentId}->${targetId}`;
                if (!backEdges.has(edgeKey)) {
                    const targetNode = nodes.get(targetId);
                    inDegreeMap.set(targetId, inDegreeMap.get(targetId) - 1);
                    
                    if (inDegreeMap.get(targetId) === 0) {
                        targetNode.level = currentLevel + 1;
                        queue.push(targetId);
                    }
                }
            }
        }

        // Assign remaining nodes (part of strongly connected components)
        // Place them at the level after the maximum level found
        for (const [id, node] of nodes) {
            if (node.level === -1) {
                node.level = maxLevel + 1;
            }
        }

        // Phase 3: Group nodes by level
        const levels = new Map();
        maxLevel = 0;
        for (const [id, node] of nodes) {
            if (!levels.has(node.level)) {
                levels.set(node.level, []);
            }
            levels.get(node.level).push(node);
            maxLevel = Math.max(maxLevel, node.level);
        }

        // Phase 4: Position nodes
        const levelHeight = 150;
        const nodeSpacing = 100;
        const startY = 100;

        for (let level = 0; level <= maxLevel; level++) {
            const nodesAtLevel = levels.get(level) || [];
            const levelWidth = nodesAtLevel.length * nodeSpacing;
            const startXForLevel = 100 - levelWidth / 2;

            nodesAtLevel.forEach((node, index) => {
                const x = Math.round(startXForLevel + index * nodeSpacing + 500);
                const y = Math.round(startY + level * levelHeight);

                if (node.type === 'place') {
                    this._model.places[node.id].x = x;
                    this._model.places[node.id].y = y;
                } else {
                    this._model.transitions[node.id].x = x;
                    this._model.transitions[node.id].y = y;
                }
            });
        }

        // Ensure all coordinates are non-negative
        this._normalizeNodePositions(100);

        // Update the view
        this._renderUI();
        this._syncLD();
    }

    _applyHorizontalDagLayout() {
        // Save state for undo
        this._pushHistory();

        // Get all nodes
        const nodes = new Map();
        for (const [id, place] of Object.entries(this._model.places || {})) {
            nodes.set(id, { id, type: 'place', level: -1, inDegree: 0, outDegree: 0 });
        }
        for (const [id, transition] of Object.entries(this._model.transitions || {})) {
            nodes.set(id, { id, type: 'transition', level: -1, inDegree: 0, outDegree: 0 });
        }

        if (nodes.size === 0) return;

        // Build adjacency information
        const outgoing = new Map();
        const incoming = new Map();
        for (const [id] of nodes) {
            outgoing.set(id, []);
            incoming.set(id, []);
        }

        const edges = [];
        for (const arc of (this._model.arcs || [])) {
            if (nodes.has(arc.source) && nodes.has(arc.target)) {
                edges.push({ source: arc.source, target: arc.target });
                outgoing.get(arc.source).push(arc.target);
                incoming.get(arc.target).push(arc.source);
                nodes.get(arc.source).outDegree++;
                nodes.get(arc.target).inDegree++;
            }
        }

        // Phase 1: Break cycles using DFS to identify back edges
        const visited = new Set();
        const recursionStack = new Set();
        const backEdges = new Set();
        
        const dfs = (nodeId) => {
            visited.add(nodeId);
            recursionStack.add(nodeId);
            
            for (const targetId of outgoing.get(nodeId)) {
                if (!visited.has(targetId)) {
                    dfs(targetId);
                } else if (recursionStack.has(targetId)) {
                    // Back edge found (creates a cycle)
                    backEdges.add(`${nodeId}->${targetId}`);
                }
            }
            
            recursionStack.delete(nodeId);
        };

        // Run DFS from all unvisited nodes
        for (const [id] of nodes) {
            if (!visited.has(id)) {
                dfs(id);
            }
        }

        // Phase 2: Assign levels using modified topological sort (ignoring back edges)
        const queue = [];
        const inDegreeMap = new Map();
        
        for (const [id, node] of nodes) {
            let effectiveInDegree = 0;
            for (const sourceId of incoming.get(id)) {
                const edgeKey = `${sourceId}->${id}`;
                if (!backEdges.has(edgeKey)) {
                    effectiveInDegree++;
                }
            }
            inDegreeMap.set(id, effectiveInDegree);
            if (effectiveInDegree === 0) {
                node.level = 0;
                queue.push(id);
            }
        }

        let maxLevel = 0;
        while (queue.length > 0) {
            const currentId = queue.shift();
            const currentLevel = nodes.get(currentId).level;
            maxLevel = Math.max(maxLevel, currentLevel);

            for (const targetId of outgoing.get(currentId)) {
                const edgeKey = `${currentId}->${targetId}`;
                if (!backEdges.has(edgeKey)) {
                    const targetNode = nodes.get(targetId);
                    inDegreeMap.set(targetId, inDegreeMap.get(targetId) - 1);
                    
                    if (inDegreeMap.get(targetId) === 0) {
                        targetNode.level = currentLevel + 1;
                        queue.push(targetId);
                    }
                }
            }
        }

        // Assign remaining nodes (part of strongly connected components)
        // Place them at the level after the maximum level found
        for (const [id, node] of nodes) {
            if (node.level === -1) {
                node.level = maxLevel + 1;
            }
        }

        // Phase 3: Group nodes by level
        const levels = new Map();
        maxLevel = 0;
        for (const [id, node] of nodes) {
            if (!levels.has(node.level)) {
                levels.set(node.level, []);
            }
            levels.get(node.level).push(node);
            maxLevel = Math.max(maxLevel, node.level);
        }

        // Phase 4: Position nodes (HORIZONTAL: levels go left-to-right)
        const levelWidth = 150;  // horizontal spacing between levels
        const nodeSpacing = 100; // vertical spacing within a level
        const startX = 100;

        for (let level = 0; level <= maxLevel; level++) {
            const nodesAtLevel = levels.get(level) || [];
            const levelHeight = nodesAtLevel.length * nodeSpacing;
            const startYForLevel = 100 - levelHeight / 2;

            nodesAtLevel.forEach((node, index) => {
                const x = Math.round(startX + level * levelWidth);
                const y = Math.round(startYForLevel + index * nodeSpacing + 400);

                if (node.type === 'place') {
                    this._model.places[node.id].x = x;
                    this._model.places[node.id].y = y;
                } else {
                    this._model.transitions[node.id].x = x;
                    this._model.transitions[node.id].y = y;
                }
            });
        }

        // Ensure all coordinates are non-negative
        this._normalizeNodePositions(100);

        // Update the view
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
        this._applyStyles(menuBtn, {
            position: 'absolute',
            top: '10px',
            left: '10px',
            width: '40px',
            height: '40px',
            borderRadius: '6px',
            border: 'none',
            background: 'rgba(255, 255, 255, 0.9)',
            boxShadow: '0 2px 6px rgba(0, 0, 0, 0.15)',
            cursor: 'pointer',
            fontSize: '20px',
            zIndex: 1300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
            transition: 'background 0.2s'
        });

        // Use left-side panel in backend mode, dropdown otherwise
        let menuContainer;
        if (isBackendMode) {
            // Create overlay for left-side panel
            menuContainer = document.createElement('div');
            menuContainer.className = 'pv-hamburger-overlay';
            menuContainer.style.display = 'none';
            this._applyStyles(menuContainer, {
                position: 'fixed',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                background: 'rgba(0, 0, 0, 0.5)',
                zIndex: 1299,
                display: 'none'
            });

            // Create left panel
            const panel = document.createElement('div');
            panel.className = 'pv-hamburger-panel';
            this._applyStyles(panel, {
                position: 'fixed',
                top: '0',
                left: '0',
                width: '300px',
                height: '100%',
                background: '#fff',
                boxShadow: '2px 0 8px rgba(0,0,0,0.1)',
                display: 'flex',
                flexDirection: 'column',
                zIndex: 1300
            });

            // Panel header - use full width for hamburger menu button
            const header = document.createElement('div');
            this._applyStyles(header, {
                // Left padding of 60px = 16px (left position) + 32px (button width) + 12px (margin)
                padding: '16px 16px 16px 60px',
                borderBottom: '1px solid #e1e4e8',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                position: 'relative'
            });

            // Hamburger button inside the panel on the left
            const panelMenuBtn = document.createElement('button');
            panelMenuBtn.type = 'button';
            panelMenuBtn.innerHTML = '☰';
            panelMenuBtn.title = 'Close Menu';
            this._applyStyles(panelMenuBtn, {
                position: 'absolute',
                left: '16px',
                top: '50%',
                transform: 'translateY(-50%)',
                width: '32px',
                height: '32px',
                borderRadius: '4px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontSize: '18px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#586069'
            });
            panelMenuBtn.addEventListener('click', () => {
                menuContainer.style.display = 'none';
            });
            header.appendChild(panelMenuBtn);

            const title = document.createElement('h3');
            title.textContent = 'Menu';
            this._applyStyles(title, {
                margin: '0',
                fontSize: '18px',
                fontWeight: 'bold'
            });
            header.appendChild(title);

            const closeBtn = document.createElement('button');
            closeBtn.textContent = '×';
            closeBtn.type = 'button';
            this._applyStyles(closeBtn, {
                background: 'transparent',
                border: 'none',
                fontSize: '28px',
                cursor: 'pointer',
                padding: '0',
                lineHeight: '1',
                color: '#586069'
            });
            closeBtn.addEventListener('click', () => {
                menuContainer.style.display = 'none';
            });
            header.appendChild(closeBtn);

            panel.appendChild(header);

            // Panel content
            const content = document.createElement('div');
            this._applyStyles(content, {
                padding: '8px 0',
                flex: '1 1 auto',
                overflow: 'auto'
            });
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
            this._applyStyles(menuContainer, {
                position: 'absolute',
                top: '55px',
                left: '10px',
                minWidth: '180px',
                background: 'rgba(255, 255, 255, 0.98)',
                borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
                zIndex: 1300,
                padding: '6px 0',
                userSelect: 'none'
            });
            menuContainer._menuContent = menuContainer;
        }

        const makeMenuItem = (text, onClick, icon = null) => {
            const item = document.createElement('div');
            item.className = 'pv-menu-item';
            this._applyStyles(item, {
                padding: '10px 16px',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: 'system-ui, Arial',
                transition: 'background 0.15s',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
            });

            if (icon) {
                const iconEl = document.createElement('span');
                iconEl.innerHTML = icon;
                this._applyStyles(iconEl, {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '16px',
                    height: '16px'
                });
                item.appendChild(iconEl);
            }

            const textEl = document.createElement('span');
            textEl.textContent = text;
            item.appendChild(textEl);

            item.addEventListener('mouseenter', () => {
                item.style.background = 'rgba(0, 0, 0, 0.05)';
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent';
            });
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
            const saveText = (this._supabaseInitialized && this._user)
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
            if (this._supabaseInitialized && this._user) {
                const shareItem = makeMenuItem('🔗 Share', async () => {
                    await this._showShareDialog();
                });
                menuContainer._menuContent.appendChild(shareItem);

                // Add Save As Gist button (only for logged-in users)
                const saveAsGistItem = makeMenuItem('📝 Save As Gist', async () => {
                    await this._saveAsGist();
                });
                menuContainer._menuContent.appendChild(saveAsGistItem);
            }

            // Add separator
            const separator = document.createElement('div');
            this._applyStyles(separator, {
                height: '1px',
                background: '#e1e4e8',
                margin: '8px 0'
            });
            menuContainer._menuContent.appendChild(separator);

            // Add Login/Logout if Supabase is configured
            if (this._supabaseInitialized) {
                if (this._user) {
                    // Show user info and logout button
                    const userInfo = document.createElement('div');
                    this._applyStyles(userInfo, {
                        padding: '10px 16px',
                        fontSize: '13px',
                        color: '#586069',
                        borderBottom: '1px solid #e1e4e8'
                    });
                    const userEmail = this._user.email || this._user.user_metadata?.user_name || 'User';
                    userInfo.textContent = `Logged in as: ${userEmail}`;
                    menuContainer._menuContent.appendChild(userInfo);

                    const logoutItem = makeMenuItem('🚪 Logout', () => {
                        this._logout();
                    });
                    menuContainer._menuContent.appendChild(logoutItem);

                    // Add separator
                    const separator2 = document.createElement('div');
                    this._applyStyles(separator2, {
                        height: '1px',
                        background: '#e1e4e8',
                        margin: '8px 0'
                    });
                    menuContainer._menuContent.appendChild(separator2);
                } else {
                    // Show login button
                    const loginItem = makeMenuItem('🔑 Login with GitHub', () => {
                        this._loginWithGitHub();
                    });
                    menuContainer._menuContent.appendChild(loginItem);

                    // Add separator
                    const separator2 = document.createElement('div');
                    this._applyStyles(separator2, {
                        height: '1px',
                        background: '#e1e4e8',
                        margin: '8px 0'
                    });
                    menuContainer._menuContent.appendChild(separator2);
                }
            }
        }

        // Standard menu items
        const simulationItem = makeMenuItem('🧮 Simulate (ODE)', () => {
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

        const downloadItem = makeMenuItem('📥 Download JSON', () => {
            this.downloadJSON();
        });
        menuContainer._menuContent.appendChild(downloadItem);

        const helpItem = makeMenuItem('❓ Help', () => {
            this._showHelpDialog();
        });
        menuContainer._menuContent.appendChild(helpItem);

        const githubItem = makeMenuItem('GitHub', () => {
            window.open('https://github.com/pflow-xyz/pflow-xyz', '_blank', 'noopener,noreferrer');
        }, '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>');
        menuContainer._menuContent.appendChild(githubItem);

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

        menuBtn.addEventListener('mouseenter', () => {
            menuBtn.style.background = 'rgba(255, 255, 255, 1)';
        });
        menuBtn.addEventListener('mouseleave', () => {
            menuBtn.style.background = 'rgba(255, 255, 255, 0.9)';
        });

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
        if (isBackendMode && this._supabaseInitialized && this._user) {
            // Show username if logged in
            const username = this._user.user_metadata?.user_name ||
                this._user.email?.split('@')[0] ||
                'User';
            button.innerHTML = `👤 ${username}`;
            button.title = `Logged in as ${this._user.email || username}`;
        } else if (isBackendMode && this._supabaseInitialized) {
            // Show login button if not logged in
            button.innerHTML = '🔑 Login';
            button.title = 'Login with GitHub';
        } else {
            // In standard mode or when Supabase not initialized, don't show the button
            return;
        }

        this._applyStyles(button, {
            position: 'absolute',
            top: '10px',
            right: '10px',
            height: '40px',
            padding: '0 16px',
            borderRadius: '6px',
            border: 'none',
            background: 'rgba(255, 255, 255, 0.9)',
            boxShadow: '0 2px 6px rgba(0, 0, 0, 0.15)',
            cursor: 'pointer',
            fontSize: '14px',
            fontFamily: 'system-ui, Arial',
            zIndex: 1300,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            userSelect: 'none',
            transition: 'background 0.2s',
            whiteSpace: 'nowrap'
        });

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

        button.addEventListener('mouseenter', () => {
            button.style.background = 'rgba(255, 255, 255, 1)';
        });
        button.addEventListener('mouseleave', () => {
            button.style.background = 'rgba(255, 255, 255, 0.9)';
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

        // Reset canvas container to full size
        if (this._canvasContainer) {
            this._canvasContainer.style.flex = '1 1 auto';
        }

        // Reset layout to default
        this._layoutHorizontal = false;
        this._root.classList.remove('pv-layout-horizontal');

        this._jsonEditor = null;
        this._jsonEditorTextarea = null;
        this._editingJson = false;

        // Remove the attribute to keep state consistent
        this.removeAttribute('data-json-editor');

        // Trigger resize
        this._onResize();
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
            this._applyViewTransform();
            this._draw();
        }, {passive: false});

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
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === ' ') this._spaceDown = false;
        });

        // panning pointer down/move/up
        this._canvasContainer.addEventListener('pointerdown', (e) => {
            // If so, allow left-button drag to pan even without modifiers.
            const interactiveSelector = '.pv-node, .pv-weight, .pv-menu, .pv-json-editor, .pv-scale-meter, .pv-json-textarea, .pv-tool, .pv-play, .pv-layout-divider';
            const clickedInteractive = !!e.target.closest && e.target.closest(interactiveSelector);
            const leftButton = e.button === 0;

            // Check for shift+click on canvas (not on elements) to start bounding box selection
            if (e.shiftKey && leftButton && !clickedInteractive && (this._mode === 'select' || this._mode === 'add-token' || this._mode === 'delete')) {
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

            // Check if we have selected nodes and clicking on canvas (not shift, not on elements)
            // In this case, start a canvas-based group drag instead of panning
            if (!e.shiftKey && leftButton && !clickedInteractive && this._selectedNodes.size > 0 && this._mode === 'select') {
                e.preventDefault();
                this._beginCanvasGroupDrag(e);
                return;
            }

            const isPan = this._spaceDown || e.button === 1 || e.altKey || e.ctrlKey || e.metaKey || (leftButton && !clickedInteractive);

            if (isPan) {
                e.preventDefault();
                // Safety: ensure we're not in a conflicting state
                if (this._boxSelect) {
                    this._boxSelect = null;
                }
                
                // Clear selection when panning starts (since orange highlight will not be visible)
                if (this._selectedNodes.size > 0) {
                    this._clearSelection();
                }
                
                // start panning
                this._panning = {
                    x: e.clientX,
                    y: e.clientY,
                    tx: this._view.tx,
                    ty: this._view.ty,
                    pointerId: e.pointerId
                };
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
            
            if (!this._panning) return;
            this._view.tx = this._panning.tx + (e.clientX - this._panning.x);
            this._view.ty = this._panning.ty + (e.clientY - this._panning.y);
            this._applyViewTransform();
            this._draw();
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

}

customElements.define('petri-view', PetriView);
export {PetriView};