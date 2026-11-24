// petri-shell-boot.js — mounts the IDE shell (docs/ide-shell.md). The shell is on by default: pflow.xyz opens straight
// into it. A visitor who opted out (?shell=0, remembered) gets the classic editor layout, and downloads none of the
// shell's modules: they load only when the flag is on.
import { shellEnabled } from './petri-shell.js';

let storage = null;
try { storage = globalThis.localStorage; } catch { /* storage blocked: the query alone decides */ }

if (shellEnabled(location.search, storage)) {
    const wrapper = document.getElementById('editor-wrapper');
    if (wrapper) {
        import('./petri-shell-ui.js').then(({ mountShell }) => mountShell(wrapper, { storage })).catch((e) => {
            console.error('shell failed to start; the classic editor is unchanged', e);
            wrapper.classList.remove('pf-shell');
        });
    }
}
