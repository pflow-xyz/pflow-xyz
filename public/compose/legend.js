// The page's legend: what each link kind and port schema looks like WITHOUT its colour.
//
// A link kind is told by its glyph first and its stroke second. The glyphs (◆ token, ▷ data,
// ⊗ event, ⊘ guard) and the strokes token dashed, data dotted, event bold are go-pflow
// RenderDOT's (metamodel/composedot.go:28-33). RenderDOT draws guard dashed too, the same as
// token, so this page draws guard dash-dot (a11y-text.js distinctDashes) to keep the four
// apart. The views do not all follow the legend's strokes: some draw their own dashes for what
// they show (the exceptions are listed below and in ACCESSIBILITY.md), so a stroke is a
// second channel and never the only one. Ports carry their schema as a letter on the dot
// (a11y.js schemaBadges). The views' own legends keep their drawings; this one is the one
// place that lists all of it, in text too, and what the lit and refused states look like
// while linking.

import { el, svg } from './dom.js';
import { LINK_STYLE } from './model.js';
import { SCHEMA_CODE } from './a11y-text.js';
import { schemaColor } from './theme.js';

// RenderDOT's words for each kind (composedot.go:28-33; guard is dashed there, dash-dot here), and the stroke they stand for.
const KINDS = [
  ['token', 'dashed', 'a resource coupling: two places become one'],
  ['data', 'dotted', 'a read-only observation of a place'],
  ['event', 'bold', 'fires together: a transition fusion'],
  ['guard', 'dash-dot', 'gates a transition on a place'],
];
const SCHEMAS = ['queue:items', 'queue:payload', 'resource', 'account', 'saga:outcome'];

function kindSample(kind) {
  const st = LINK_STYLE[kind];
  return svg('svg', { width: 46, height: 14, viewBox: '0 0 46 14', 'aria-hidden': 'true', class: 'lg-sample' },
    svg('line', { x1: 2, y1: 7, x2: 44, y2: 7, stroke: st.color, 'stroke-width': kind === 'event' ? 3 : 1.8, 'stroke-dasharray': st.dash || null }));
}

function schemaSample(schema) {
  const col = schemaColor(schema);
  return svg('svg', { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', class: 'lg-sample' },
    svg('circle', { cx: 8, cy: 8, r: 6.5, fill: col, stroke: '#fff', 'stroke-width': 1 }),
    svg('text', { x: 8, y: 11, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#fff' }, SCHEMA_CODE[schema]));
}

/** Fill `box` with the legend. Call once the facts are loaded (LINK_STYLE is the registry's). */
export function renderLegend(box) {
  if (!box || !LINK_STYLE.token) return;
  box.replaceChildren(
    el('h3', { id: 'legend-h' }, 'Legend: kinds and schemas without colour'),
    el('h4', {}, 'Link kinds'),
    el('p', { class: 'small muted' }, 'Read the glyph first (◆ token, ▷ data, ⊗ event, ⊘ guard), the stroke second: the strokes below are this page\'s, and some views draw their own. Cospans and Boundaries draw event ghost links as thin dashes, not bold, and the Spiders, String and Boundaries legends draw their guard and token swatches with other dashes.'),
    el('ul', { class: 'lg-list' }, KINDS.map(([kind, stroke, what]) => el('li', {},
      kindSample(kind),
      el('span', { class: 'lg-glyph', 'aria-hidden': 'true' }, LINK_STYLE[kind].glyph),
      el('span', {}, el('b', {}, kind), ` link: ${stroke} line, ${what}`)))),
    el('h4', {}, 'Port schemas'),
    el('p', { class: 'small muted' }, 'A place port\'s dot carries a letter for its schema. A transition port is a square and has none.'),
    el('ul', { class: 'lg-list lg-schemas' }, SCHEMAS.map((s) => el('li', {}, schemaSample(s), el('span', {}, el('code', {}, SCHEMA_CODE[s]), ` ${s}`)))),
    el('h4', {}, 'While linking'),
    el('ul', { class: 'lg-list' },
      el('li', {}, el('span', { class: 'lg-state lg-lit', 'aria-hidden': 'true' }), el('span', {}, 'lit, glowing: a legal target. The band follows the pointer or the focused target.')),
      el('li', {}, el('span', { class: 'lg-state lg-dim', 'aria-hidden': 'true' }), el('span', {}, 'faded: refused. Hover it, or press R in link mode, to hear the registry say why.')),
      el('li', {}, el('span', { class: 'lg-state lg-ring', 'aria-hidden': 'true' }), el('span', {}, 'double ring: the thing the keyboard is on.'))),
  );
}
