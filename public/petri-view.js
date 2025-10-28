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
        this._labelEditMode = false;

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
        const openUrlBtn = makeBtn('🌐 Open URL', 'Load JSON-LD from URL');
        const dlBtn = makeBtn('📥 Download', 'Download current JSON');
        const fsBtn = makeBtn('🔳 Full ⤢', 'Toggle fullscreen');
        const closeBtn = makeBtn('❌ Close', 'Close editor'); // moved close into ace toolbar
        toolbar.appendChild(findBtn);
        toolbar.appendChild(openUrlBtn);
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
                const { '@id': _, ...docForCid } = doc;
                const cid = await this._computeCidForJsonLd(docForCid);
                
                // Inject @id with ipfs:// scheme
                const docWithId = { ...doc, '@id': `ipfs://${cid}` };
                
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

    // Base58 alphabet for base58btc encoding
    _base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

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

        // Create layout toggle button
        this._createLayoutToggle();

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
    _createLayoutToggle() {
        if (this._layoutToggle) return;
        
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'pv-layout-toggle';
        toggle.title = 'Toggle horizontal/vertical layout';
        toggle.textContent = '⇄'; // swap icon
        
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleLayout();
        });
        
        this._root.appendChild(toggle);
        this._layoutToggle = toggle;
    }

    _toggleLayout() {
        this._layoutHorizontal = !this._layoutHorizontal;
        
        if (this._layoutHorizontal) {
            this._root.classList.add('pv-layout-horizontal');
        } else {
            this._root.classList.remove('pv-layout-horizontal');
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
        this._createHamburgerMenu();
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

    async downloadJSON() {
        try {
            const doc = this._model;
            
            // Compute CID from the document (without @id to avoid self-reference)
            const { '@id': _, ...docForCid } = doc;
            const cid = await this._computeCidForJsonLd(docForCid);
            
            // Inject @id with ipfs:// scheme
            const docWithId = { ...doc, '@id': `ipfs://${cid}` };
            
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
                // inhibitor doesn't produce tokens, skip capacity check
                continue;
            }

            // output capacity must not overflow (only for normal arcs that produce tokens)
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
            if (!a.inhibitTransition) marks[a.target] = (marks[a.target] || 0) + w;
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

        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this._onPlaceClick(id, ev);
        });
        el.addEventListener('contextmenu', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this._onPlaceContext(id, ev);
        });
        // Do not begin drag when in add-token, add-arc, delete or label-edit modes
        handle.addEventListener('pointerdown', (ev) => {
            if (this._mode !== 'add-token' && this._mode !== 'add-arc' && this._mode !== 'delete' && !this._labelEditMode) {
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
            if (this._mode !== 'add-arc' && this._mode !== 'delete' && !this._labelEditMode) {
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
                    this._setMode(t.mode);
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

    // ---------------- drawing ----------------
    _onResize() {
        // Use canvas container rect instead of root rect
        const rect = this._canvasContainer ? this._canvasContainer.getBoundingClientRect() : this._root.getBoundingClientRect();
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
        const rootRect = this._canvasContainer ? this._canvasContainer.getBoundingClientRect() : this._root.getBoundingClientRect();
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
        const marks = this._marking(); // current marking to evaluate arc/transition state

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

            // Determine the related transition id for this arc so we can color by its enabled state
            const relatedTransitionId = srcIsPlace ? arc.target : arc.source;
            const active = !!this._enabled(relatedTransitionId, marks);

            // set stroke/fill based on active state
            ctx.strokeStyle = active ? '#2a6fb8' : '#cfcfcf';
            ctx.fillStyle = active ? '#2a6fb8' : '#cfcfcf';

            // draw the main line
            ctx.beginPath();
            ctx.moveTo(ex, ey);
            ctx.lineTo(fx, fy);
            ctx.stroke();

            const tpx = fx, tpy = fy;
            if (arc.inhibitTransition) {
                // draw inhibitor circle at the tip (works for both place-target and transition-target inhibitors)
                ctx.beginPath();
                ctx.lineWidth = 1.3;
                ctx.fillStyle = '#fff';
                ctx.strokeStyle = active ? '#2a6fb8' : '#cfcfcf';
                ctx.arc(tpx, tpy, inhibitRadius, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.lineWidth = 1;
            } else {
                // draw normal arrowhead
                const ahx = tpx + (-ux * ahSize - uy * ahSize * 0.45);
                const ahy = tpy + (-uy * ahSize + ux * ahSize * 0.45);
                const bhx = tpx + (-ux * ahSize + uy * ahSize * 0.45);
                const bhy = tpy + (-uy * ahSize - ux * ahSize * 0.45);
                ctx.beginPath();
                ctx.moveTo(tpx, tpy);
                ctx.lineTo(ahx, ahy);
                ctx.lineTo(bhx, bhy);
                ctx.closePath();
                ctx.fillStyle = ctx.strokeStyle;
                ctx.fill();
            }

            // position weight badge if present
            const bx = (ex + fx) / 2;
            const by = (ey + fy) / 2;
            const badge = this._stage.querySelector(`.pv-weight[data-arc="${idx}"]`);
            if (badge) {
                const offX = (badge.offsetWidth || 20) / 2;
                const offY = (badge.offsetHeight || 20) / 2;
                badge.style.left = `${Math.round(bx - offX)}px`;
                badge.style.top = `${Math.round(by - offY)}px`;
                // give badge a subtle tint and border (same treatment for both normal and inhibitor arcs)
                if (arc.inhibitTransition) {
                    badge.style.background = active ? '#e8f0fb' : '#fafafa';
                    badge.style.borderColor = active ? '#2a6fb8' : '#ddd';
                } else {
                    badge.style.background = active ? '#e8f0fb' : '#fafafa';
                    badge.style.borderColor = active ? '#2a6fb8' : '#ddd';
                }
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

            <h4 style="margin: 12px 0 6px 0; font-size: 14px; font-weight: 600;">Other Features:</h4>
            <ul style="margin: 6px 0 12px 20px; padding: 0;">
                <li><strong>JSON Editor:</strong> Toggle to edit the model as JSON-LD</li>
                <li><strong>Scale Meter:</strong> Shows current zoom level (right side)</li>
                <li><strong>Undo/Redo:</strong> Use Ctrl+Z/Ctrl+Y</li>
                <li><strong>Download:</strong> Export your Petri net as JSON</li>
                <li><strong>Auto-save:</strong> Changes are saved to browser localStorage</li>
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

    // ---------------- hamburger menu ----------------
    _createHamburgerMenu() {
        if (this._hamburgerMenu) return;
        
        const menuBtn = document.createElement('button');
        menuBtn.type = 'button';
        menuBtn.className = 'pv-hamburger-btn';
        menuBtn.innerHTML = '☰';
        menuBtn.title = 'Menu';
        this._applyStyles(menuBtn, {
            position: 'absolute',
            top: '10px',
            right: '10px',
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

        const dropdown = document.createElement('div');
        dropdown.className = 'pv-hamburger-dropdown';
        dropdown.style.display = 'none';
        this._applyStyles(dropdown, {
            position: 'absolute',
            top: '55px',
            right: '10px',
            minWidth: '180px',
            background: 'rgba(255, 255, 255, 0.98)',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.2)',
            zIndex: 1300,
            padding: '6px 0',
            userSelect: 'none'
        });

        const makeMenuItem = (text, onClick) => {
            const item = document.createElement('div');
            item.className = 'pv-menu-item';
            item.textContent = text;
            this._applyStyles(item, {
                padding: '10px 16px',
                cursor: 'pointer',
                fontSize: '14px',
                fontFamily: 'system-ui, Arial',
                transition: 'background 0.15s'
            });
            item.addEventListener('mouseenter', () => {
                item.style.background = 'rgba(0, 0, 0, 0.05)';
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = 'transparent';
            });
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                onClick();
                dropdown.style.display = 'none';
            });
            return item;
        };

        // Add menu items
        const toggleEditorItem = makeMenuItem('📝 Toggle Editor', () => {
            if (this.hasAttribute('data-json-editor')) {
                this.removeAttribute('data-json-editor');
            } else {
                this.setAttribute('data-json-editor', '');
            }
        });
        dropdown.appendChild(toggleEditorItem);

        const downloadItem = makeMenuItem('📥 Download JSON', () => {
            this.downloadJSON();
        });
        dropdown.appendChild(downloadItem);

        const helpItem = makeMenuItem('❓ Help', () => {
            this._showHelpDialog();
        });
        dropdown.appendChild(helpItem);

        const githubItem = makeMenuItem('🔗 GitHub', () => {
            window.open('https://github.com/pflow-xyz/pflow-xyz', '_blank', 'noopener,noreferrer');
        });
        dropdown.appendChild(githubItem);

        // Toggle dropdown on button click
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isVisible = dropdown.style.display !== 'none';
            dropdown.style.display = isVisible ? 'none' : 'block';
        });

        // Close dropdown when clicking outside
        const closeDropdown = (e) => {
            if (!menuBtn.contains(e.target) && !dropdown.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        };
        document.addEventListener('click', closeDropdown);

        menuBtn.addEventListener('mouseenter', () => {
            menuBtn.style.background = 'rgba(255, 255, 255, 1)';
        });
        menuBtn.addEventListener('mouseleave', () => {
            menuBtn.style.background = 'rgba(255, 255, 255, 0.9)';
        });

        this._root.appendChild(menuBtn);
        this._root.appendChild(dropdown);
        
        this._hamburgerMenu = menuBtn;
        this._hamburgerDropdown = dropdown;
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
        
        // Remove layout toggle button
        if (this._layoutToggle) {
            try {
                this._layoutToggle.remove();
            } catch {
            }
            this._layoutToggle = null;
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