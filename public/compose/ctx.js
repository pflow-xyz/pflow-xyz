// The ctx a view's render(ctx) gets (VIEWS.md in the prototype): the example,
// what just changed, the composition and plan as the registry holds them, and
// the drawing helpers. Shared by the page (app.js) and the headless parity
// test (parity/composition-views/), which passes no-op snap/hover.

import { state, actions, activeSubnets, subnetsById, orderLinks, flatOrders, planInfo } from './state.js';
import { el, svg, svgRoot, curve, textWidth } from './dom.js';
import * as theme from './theme.js';
import * as info from './info.js';
import { PATTERNS, LINK_KINDS, IDIOMS, SCENARIOS, portKey, SLOTS, PIECES, pieceByName, CONNECT4_EXACT_CITE } from './model.js';

export function connect4Summary(net) {
  if (!net) return null;
  const places = Object.keys(net.places), transitions = Object.keys(net.transitions);
  const drops = transitions.filter((t) => /_play_/.test(t));
  const auto = transitions.filter((t) => !/_play_/.test(t));
  return { name: net.name, description: net.description, places: places.length, transitions: transitions.length, arcs: net.arcs.length, drops: drops.length, other: auto.length };
}

/**
 * @param {Element} root   where the view draws
 * @param {{snap, hover, manifest, connect4, rerender}} o
 */
export function makeCtx(root, o) {
  const byId = subnetsById();
  return {
    root,
    example: state.example,
    event: state.event,
    orders: {
      subnets: activeSubnets(), byId, links: orderLinks(), flat: flatOrders(),
      instances: state.orders.instances, extras: state.orders.extras, prefer: state.orders.prefer,
      patterns: PATTERNS, linkKinds: LINK_KINDS, idioms: IDIOMS, scenarios: SCENARIOS, portKey,
    },
    plan: { ...planInfo(), slots: SLOTS, pieces: PIECES, pieceByName, exampleCite: CONNECT4_EXACT_CITE },
    connect4: { net: o.connect4, summary: connect4Summary(o.connect4) },
    snap: o.snap, hover: o.hover, actions, theme, info,
    receipts: {},
    /** Record a drawn element in the scene manifest (manifest.js). */
    emit: (kind, id, attrs) => o.manifest.emit(kind, id, attrs),
    /** Redraw this view (for its own toggles); the model does not change. */
    rerender: o.rerender || (() => actions.rerender()),
    svg, el, svgRoot, curve, textWidth,
    /** A banner above the drawing: level 'na' (not applicable), 'honesty', 'warn'. */
    note(text, level = 'honesty') {
      const n = el('div', { class: `stage-note ${level}` }, text);
      const notes = root.querySelectorAll(':scope > .stage-note');
      if (notes.length) notes[notes.length - 1].after(n); else root.prepend(n);
    },
  };
}

export { VIEW_IDS } from './views-meta.js';
