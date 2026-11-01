// petri-panel-frame.js — where a docked panel (the Assistant, the App view) goes on a phone.
//
// CSS alone cannot place it. A software keyboard and a browser's toolbars shrink only what can be seen, not the layout
// viewport that position:fixed is measured from, so `bottom: 16px` lands behind them; and the editor's run bar sits at
// the bottom of the screen above the panels' stacking level. So the frame is computed from window.visualViewport and
// handed to the panel's phone rules in petri-view.css as --pv-panel-top and --pv-panel-height, with .pv-panel-short
// when there is little room. Those rules are gated by the phone media query: a desktop window ignores all of this.

// In CSS pixels. PANEL_TOP is the panels' top: below the editor's top chrome.
const PANEL_TOP = 64;
const PANEL_GAP = 8;
const PANEL_SHORT_BELOW = 480;

/**
 * The frame, in the coordinates of position:fixed. Short (the keyboard is up, or a landscape phone): the panel gives up
 * the room it leaves for the editor's top chrome. Pure, so it can be tested without a browser.
 *
 * @param {{ visibleTop: number, visibleHeight: number, barTop?: number|null }} seen what is on screen; barTop is the
 *   top of the run bar when there is one showing
 * @returns {{ top: number, height: number, short: boolean }}
 */
export function panelFrame({ visibleTop, visibleHeight, barTop = null }) {
    const visibleBottom = visibleTop + visibleHeight;
    const short = visibleHeight < PANEL_SHORT_BELOW;
    const top = visibleTop + (short ? PANEL_GAP : PANEL_TOP);
    const floor = barTop !== null && barTop > visibleTop && barTop < visibleBottom ? barTop : visibleBottom;
    return { top, height: Math.max(0, floor - PANEL_GAP - top), short };
}

/**
 * Keep the panel on panelFrame while it is open; ends itself when the panel leaves the page.
 *
 * @param {HTMLElement} view the <petri-view>, for its run bar
 * @param {HTMLElement} panel
 * @param {{ around?: (apply: () => void) => void }} [opts] around wraps each change of frame, for a panel with
 *   something to keep in place across it
 */
export function fitPanel(view, panel, { around = (apply) => apply() } = {}) {
    const stops = new AbortController();
    const { signal } = stops;
    let resized = null;
    const stop = () => { stops.abort(); resized?.disconnect(); };
    const fit = () => {
        if (!panel.isConnected) { stop(); return; }
        const vv = window.visualViewport;
        // A pinch zoom is the reader's: the panel stays laid out for the page, and they pan to it.
        const seen = vv && vv.scale < 1.01 ? { visibleTop: vv.offsetTop, visibleHeight: vv.height } : { visibleTop: 0, visibleHeight: window.innerHeight };
        const bar = view.querySelector('.pv-run-bar')?.getBoundingClientRect();
        const { top, height, short } = panelFrame({ ...seen, barTop: bar?.height ? bar.top : null });
        around(() => {
            panel.style.setProperty('--pv-panel-top', `${top}px`);
            panel.style.setProperty('--pv-panel-height', `${height}px`);
            panel.classList.toggle('pv-panel-short', short);
        });
    };
    window.visualViewport?.addEventListener('resize', fit, { signal });
    window.visualViewport?.addEventListener('scroll', fit, { signal });
    window.addEventListener('resize', fit, { signal });
    if (window.ResizeObserver) {
        resized = new ResizeObserver(fit); // the run bar grows a row in edit mode
        const bar = view.querySelector('.pv-run-bar');
        if (bar) resized.observe(bar);
    }
    fit();
}
