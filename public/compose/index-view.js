// The index of all views (#view=index): every entry of the view registry with its
// links, what it consumes, its sources and what in it is judgment. All of that is
// read from the views themselves, nothing is written here; a view that failed to
// load is listed as failed. Reachable by its own tab, the bar above the stage and V.

import { citeLabel, citeURL, bibLabel, bibURL } from './sources.js';
import { VIEWS, INDEX_VIEW, EXAMPLES, viewKey } from './views-meta.js';

/**
 * @param {{views: Map, load: (id: string) => Promise, linkTo: (id: string, ex: string) => string, copy: (hash: string, button: Element) => void}} d
 *   linkTo is the hash that opens a view on an example; copy puts its full URL on the clipboard.
 */
export function makeIndexView({ views, load, linkTo, copy }) {
  return {
    ...INDEX_VIEW,
    noToolbar: true,
    consumes: [],
    convention: {
      summary: 'Every view on this page, with a link to each view on each example. The links open the composition on this page as it is now: its links, instances and plan travel in the link when they are not the default ones.',
      honesty: ['Read from the view registry and from each view: what each consumes, its sources and its judgment are the views\' own words, and a test holds "reads" to what a view reads while it draws.'],
    },
    render(ctx) {
      const { el } = ctx;
      const pending = VIEWS.filter((v) => !views.has(v.id));
      // Every view's sources are in its module; if some are not loaded yet, draw what is known and draw again.
      if (pending.length) Promise.all(pending.map((v) => load(v.id))).then(() => ctx.rerender());
      const anchor = (id, ex, label) => el('a', { href: linkTo(id, ex) }, label);
      const sources = (c) => [
        ...(c.bib || []).map((k) => { const u = bibURL(k); return u ? el('a', { href: u, target: '_blank', rel: 'noopener' }, bibLabel(k)) : bibLabel(k); }),
        ...(c.cites || []).map((ct) => { const u = citeURL(ct); return u ? el('a', { href: u, target: '_blank', rel: 'noopener' }, citeLabel(ct)) : citeLabel(ct); }),
      ];
      const list = (items) => (items.length ? el('ul', {}, items.map((x) => el('li', {}, x))) : null);
      const rows = VIEWS.map((m, i) => {
        const v = views.get(m.id);
        const c = v?.convention || {};
        const examples = EXAMPLES.filter((ex) => !m.examples || m.examples.includes(ex.id));
        const consumes = v?.consumes || [];
        const src = v?.source ? [`Source: ${v.source}`, ...sources(c)] : sources(c);
        return el('tr', { id: `index-${m.id}`, class: v?.broken ? 'broken' : '' },
          el('td', { class: 'num' }, String(i + 1), viewKey(i) ? el('kbd', {}, viewKey(i)) : null),
          el('th', { scope: 'row' }, m.title, ' ', el('span', { class: 'muted' }, `(${m.kind === 'module' ? `#view=${m.id}` : `${m.kind} file, #view=${m.id}`})`),
            v?.broken ? el('p', { class: 'warn' }, c.summary) : el('p', { class: 'muted' }, v ? c.summary : 'Loading…')),
          el('td', { class: 'links' }, examples.map((ex) => el('div', {},
            anchor(m.id, ex.id, ex.label), ' ',
            el('button', { class: 'btn', 'aria-label': `Copy the link to ${m.short} on ${ex.label}`, onclick: (e) => copy(linkTo(m.id, ex.id), e.currentTarget) }, 'Copy')))),
          el('td', { class: 'reads' }, consumes.length ? list(consumes.map((x) => el('code', {}, x))) : (v && !v.broken ? 'nothing from the registry' : '')),
          el('td', { class: 'prov' },
            src.length ? el('details', {}, el('summary', {}, `Sources (${src.length})`), list(src)) : null,
            c.honesty?.length ? el('details', {}, el('summary', {}, `Judgment and caveats (${c.honesty.length})`), list(c.honesty)) : null),
        );
      });
      ctx.root.append(el('div', { class: 'view-index' },
        el('h3', {}, `All views (${VIEWS.length})`),
        el('table', {},
          el('thead', {}, el('tr', {}, ['#', 'View', 'Links', 'Reads', 'Sources and judgment'].map((t) => el('th', { scope: 'col' }, t)))),
          el('tbody', {}, rows))));
    },
  };
}
