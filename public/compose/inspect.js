// Hover inspector: every drawn piece names the ontology concept it stands for
// and where that fact comes from.
//
// info = {
//   title,                         // what it is, in a few words
//   concept: {iri, types: []},     // ontology term (IRI) and its classes, e.g. ns:PatternPort
//   definition,                    // the ontology's own words, if any
//   facts: [[label, value]],       // kind, schema, net kind, initial marking ...
//   cites: [cite],                 // file:line@rev (sources.js cite())
//   bib: [key],                    // papers (sources.js BIB)
//   caveats: [text],               // ns:caveat, verbatim
//   note,                          // anything the view must add (e.g. "analogy of shape only")
// }

import { el } from './dom.js';
import { citeLabel, citeURL, bibLabel, bibURL } from './sources.js';

let panel, tip;
let pinned = null;

export function initInspector(panelEl) {
  panel = panelEl;
  tip = document.createElement('div');
  tip.className = 'hover-tip';
  document.body.appendChild(tip);
  clear();
}

function short(iri) {
  return iri
    .replace('https://ontology.pflow.xyz/ns#', 'ns:')
    .replace('https://ontology.pflow.xyz/pattern/', 'pat:')
    .replace('https://ontology.pflow.xyz/linkkind/', 'lk:');
}

export function renderInfo(info) {
  const c = info.concept;
  return el('div', { class: 'insp' },
    el('div', { class: 'insp-title' }, info.title || ''),
    c && el('div', { class: 'insp-concept' },
      el('code', { title: c.iri }, short(c.iri)),
      c.types && c.types.length ? el('span', { class: 'insp-types' }, ' a ', c.types.join(', ')) : null,
      c.iri.includes('/pattern/') || c.iri.includes('/linkkind/') ? el('span', { class: 'insp-unserved', title: 'Pattern and link-kind IRIs are minted in ns/patterns.ttl but not yet served at ontology.pflow.xyz' }, ' (IRI not yet served)') : null),
    info.definition && el('p', { class: 'insp-def' }, info.definition),
    info.facts && info.facts.length ? el('dl', { class: 'insp-facts' }, info.facts.map(([k, v]) => [el('dt', {}, k), el('dd', {}, String(v))])) : null,
    info.note && el('p', { class: 'insp-note' }, info.note),
    info.caveats && info.caveats.length ? el('details', { class: 'insp-caveats' }, el('summary', {}, `caveats (${info.caveats.length}, ns:caveat)`), el('ul', {}, info.caveats.map((t) => el('li', {}, t)))) : null,
    info.cites && info.cites.length ? el('ul', { class: 'insp-cites' }, info.cites.map((ct) => {
      const url = citeURL(ct);
      const label = citeLabel(ct);
      return el('li', {}, url ? el('a', { href: url, target: '_blank', rel: 'noopener' }, label) : el('span', { title: 'private repo: file and line only' }, label), ct.note ? el('span', { class: 'insp-cite-note' }, ` — ${ct.note}`) : null);
    })) : null,
    info.bib && info.bib.length ? el('ul', { class: 'insp-bib' }, info.bib.map((k) => {
      const url = bibURL(k);
      return el('li', {}, url ? el('a', { href: url, target: '_blank', rel: 'noopener' }, bibLabel(k)) : bibLabel(k));
    })) : null,
  );
}

function show(info, e) {
  if (!pinned) {
    panel.replaceChildren(renderInfo(info));
  }
  tip.replaceChildren(el('b', {}, info.title || ''), el('code', {}, info.concept ? ` ${short(info.concept.iri)}` : ''));
  tip.className = 'hover-tip show';
  move(e);
}
function move(e) {
  tip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - 320)}px`;
  tip.style.top = `${e.clientY + 16}px`;
}
function hide() { tip.className = 'hover-tip'; }

export function clear() {
  pinned = null;
  panel.replaceChildren(el('p', { class: 'muted' }, 'Hover any box, port, wire, spider or slot to see the ontology concept it stands for and the source line that says so. Click to pin.'));
}

/** Attach inspector info to an element (SVG or HTML). */
export function hover(node, info) {
  node.classList.add('inspectable');
  node.addEventListener('pointerenter', (e) => show(info, e));
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', hide);
  node.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    pinned = null;
    panel.replaceChildren(renderInfo(info));
    pinned = info;
    panel.querySelector('.insp')?.classList.add('pinned');
  });
}
