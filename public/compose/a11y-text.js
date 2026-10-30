// What the page says about itself in words, for people who do not see its colours:
// accessible names of ports, slots and pieces, the one-line announcement of each
// state change, the glyph that carries a port's schema, and the dash patterns that
// tell the link kinds apart. Pure: no DOM; every input is data the page already
// holds (state.js, model.js). Nothing here decides a rule.

/** A short code per port schema, drawn on the port's dot (colour is not the only carrier). */
export const SCHEMA_CODE = {
  'queue:items': 'I',
  'queue:payload': 'P',
  resource: 'R',
  account: 'A',
  'saga:outcome': 'S',
};

/** The code of a schema: the table's, else the first letter after the colon, else '?'. */
export function schemaCode(schema) {
  if (!schema) return '';
  if (SCHEMA_CODE[schema]) return SCHEMA_CODE[schema];
  const tail = String(schema).replace(/^.*:/, '');
  return (tail.charAt(0) || '?').toUpperCase();
}

const DIR_WORD = { in: 'in', out: 'out', inout: 'in/out', observe: 'observe' };

/** The spoken name of a port: where it is, which way it faces, what it is on, its schema. */
export function portLabel(subnetId, port) {
  const dir = DIR_WORD[port.kind] || port.kind || '';
  const on = port.target === 'transition' ? 'transition' : 'place';
  return `${subnetId}:${port.id}, ${dir ? `${dir} ` : ''}port on a ${on}, ${port.target === 'transition' || !port.schema ? 'no schema' : `schema ${port.schema}`}`;
}

/** The spoken name of a plan slot. */
export function slotLabel(slot, id = slot && slot.id) {
  if (!slot) return `${id} slot`;
  return `${slot.label} slot${slot.designed ? ' (designed, not built)' : ''}`;
}

/** The spoken name of a palette piece. */
export function pieceLabel(piece) {
  const status = piece.status === 'built' ? '' : `, ${piece.status}`;
  return `${piece.name}, ${String(piece.kind || '').toLowerCase()} piece${status}`;
}

const EXAMPLE_WORD = { orders: 'orders, workers and payment composition', connect4: 'Connect-4 exact search plan' };

/** The name of a view's drawing. */
export function viewLabel(view, example, index = 0, total = 0) {
  const n = index && total ? `View ${index} of ${total}: ` : '';
  return `${n}${view.title || view.id}, ${EXAMPLE_WORD[example] || example}`;
}

/** The sentence for one state change (state.js `event`), spoken once through the live region. */
export function eventText(ev) {
  if (!ev) return '';
  const end = (e) => `${e.subnet}:${e.port}`;
  switch (ev.type) {
    case 'link-added': {
      const l = ev.link;
      const passed = (ev.rule && ev.rule.passed || []).map((p) => p.text).join('; ');
      const warn = (ev.rule && ev.rule.warnings || []).map((w) => w.code).join(', ');
      return `Link created: ${l.kind} link ${end(l.from)} to ${end(l.to)}.${passed ? ` ${passed}.` : ''}${warn ? ` Warnings: ${warn}.` : ''}${ev.idiom ? ` This is the ${ev.idiom.key} idiom.` : ''}`;
    }
    case 'link-removed': return ev.link ? `Link removed: ${ev.link.kind} link ${end(ev.link.from)} to ${end(ev.link.to)}.` : 'Link removed.';
    case 'links-reset': return 'Links reset to the three event idioms.';
    case 'links-cleared': return 'All links cleared.';
    case 'instance-added': return `Instance ${ev.id} added.`;
    case 'instance-removed': return `Instance ${ev.id} removed.`;
    case 'piece-added': return `Piece ${ev.name} placed in the ${ev.slot} slot: pflow-rs accepts the plan.`;
    case 'piece-removed': return `Piece removed from the ${ev.slot} slot.`;
    case 'piece-moved': return `Piece moved in the ${ev.slot} slot.`;
    case 'mode': return `Plan mode ${ev.mode}.`;
    case 'plan-reset': return 'Plan reset to plan connect4 exact.';
    case 'refused': return `Refused: ${ev.error && ev.error.message || 'the registry refused the edit'}`;
    default: return '';
  }
}

/**
 * The dash of each link kind, made distinct. The registry's styles (RenderDOT:
 * token dashed, data dotted, event bold, guard dashed) give token and guard the
 * same dash; the glyph and colour told them apart. Guard gets a dash-dot so a
 * wire is readable without colour. Mutates and returns `styles`.
 */
export function distinctDashes(styles) {
  const t = styles && styles.token, g = styles && styles.guard;
  if (t && g && g.dash && g.dash === t.dash) g.dash = '8 3 1.5 3';
  return styles;
}

/** Stable keys for a list of titles: the title, then title#2, title#3 for repeats. */
export function uniqueKeys(titles) {
  const seen = new Map();
  return titles.map((t) => {
    const n = (seen.get(t) || 0) + 1;
    seen.set(t, n);
    return n === 1 ? t : `${t}#${n}`;
  });
}

/**
 * The key of the same thing in its first drawing: `port:orders:in#2` -> `port:orders:in`. Where a redraw
 * no longer has the second drawing of a thing (a linked port leaves the outer interface), focus goes to
 * the thing's other drawing rather than out of the diagram.
 */
export function firstDrawing(key) {
  return String(key).replace(/#\d+$/, '');
}

/** What a view key says while link mode is on (a number key, [ or ], V, E): the view keys stand aside (app.js), and a key that did nothing, silently, would look like a broken page. */
export const VIEW_KEYS_OFF = 'Linking is on, so the view keys are off. Escape cancels linking.';

// --- failures, and the shell while a view loads ----------------------------------------------------------

/** The first non-empty line of an error's message (or of a string): what a person is told. The stack is for the console and the details. */
export function firstLine(e) {
  const m = e && typeof e === 'object' ? (e.message || e.name) : e;
  return String(m ?? '').split('\n').map((l) => l.trim()).find(Boolean) || 'unknown error';
}

const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

/** What the page says when the registry (the wasm) did not load: one line, said first; the stack stays available. */
export function registryFailureText(e) {
  return sentence(`The registry did not load: ${firstLine(e)}`);
}

/** What the stage and the live region say when the view shown is a broken one (its module failed to load, loader.js brokenView). */
export function brokenViewText(view) {
  return sentence(`The ${view.short || view.title || view.id} view failed to load: ${firstLine(view.broken)}`);
}

/** A broken view's tab: its visible words, then what is wrong (the tab carries a class only otherwise). */
export function brokenTabLabel(visible) {
  return `${visible} (failed to load)`;
}

/**
 * Does drawing a view deserve the view's name in speech? `lastKey` is the view|example last drawn (before the first
 * drawing: the one the page started on), `key` the one drawn now. Yes when the person moved (a tab, a number key,
 * an example button, also while the page was still loading and the first drawing is the first thing to show it), and
 * for a broken view the first time, so a page that opens on one is not silent. Not for a redraw of the same view.
 */
export function viewNews({ lastKey, drawn, key, broken = false }) {
  return lastKey !== key || (!drawn && broken);
}

/** Say a status line once: `said` is the last one said (null at first); returns the text to say, or '' when it is the same again. */
export function newStatus(said, text) {
  return text && text !== said ? text : '';
}
