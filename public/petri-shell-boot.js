// petri-shell-boot.js — switches the IDE shell on behind a flag (docs/ide-shell.md). Without ?shell=1 (or the choice it
// remembers) this does nothing but check the flag, and the page is the editor it always was. The shell's own modules load
// only when the flag is on, so a visitor who never opts in downloads none of them.
import { shellEnabled } from './petri-shell.js';

let storage = null;
try { storage = globalThis.localStorage; } catch { /* storage blocked: the query alone decides */ }

if (shellEnabled(location.search, storage)) {
    const wrapper = document.getElementById('editor-wrapper');
    if (wrapper) {
        // An explicit ?shell=1 is a request to see the editor, not the landing page.
        if (new URLSearchParams(location.search).get('shell') === '1') globalThis.pflowShowEditor?.();
        import('./petri-shell-ui.js').then(({ mountShell }) => mountShell(wrapper, { storage })).catch((e) => {
            console.error('shell failed to start; the classic editor is unchanged', e);
            wrapper.classList.remove('pf-shell');
        });
    }
}
