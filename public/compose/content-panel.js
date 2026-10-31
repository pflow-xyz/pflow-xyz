// The model-content panel under the convention text (pflow-native's crates/app/src/modelcontent.rs, as
// docs/composition-documents.md §3.6 describes it): what the open model lacks, then its entries for this
// view by kind, each with its title, text, check claim and cites. "Run checks" asks the registry, one
// entry per tick so a long run does not hold the page; the mark is what content.check returned, so an
// unrun check is not ticked, and a check that fails says so. A scenario entry is not listed (the Process
// view and the lens test draw it).

import { el } from './dom.js';
import { announce } from './a11y-bus.js';
import { bibLabel, bibURL, citeLabel, citeURL } from './sources.js';
import { claimOf, entryText } from './content.js';

function citeItem(c) {
  if (c.bib) { const u = bibURL(c.bib); return el('li', {}, u ? el('a', { href: u, target: '_blank', rel: 'noopener' }, bibLabel(c.bib)) : bibLabel(c.bib)); }
  const u = citeURL(c);
  return el('li', {}, u ? el('a', { href: u, target: '_blank', rel: 'noopener' }, citeLabel(c)) : el('span', { title: 'not linked' }, citeLabel(c)));
}

function entryRow(e, marks) {
  const claim = claimOf(e);
  const mark = marks.get(e.id);
  return el('details', { class: `content-entry content-${e.kind}`, 'data-entry': e.id },
    el('summary', {},
      el('span', { class: 'content-kind' }, e.kind),
      ' ', e.title || e.id,
      mark ? el('span', { class: mark.ok ? 'content-pass' : 'content-fail' }, mark.ok ? ' ✓ check passed' : ' ✗ check failed') : null),
    el('p', {}, entryText(e)),
    claim ? el('p', { class: 'small muted' }, `Check, not yet a result: ${claim}`) : null,
    e.cites?.length ? el('ul', { class: 'insp-cites' }, e.cites.map(citeItem)) : null);
}

/**
 * Fill `box`. `d`: reader (content.js), lacks (bundle.state's missing), view (id), runCheck(id) -> {ok, claim, steps},
 * state (a Map kept across redraws: entry id -> verdict), rerender().
 */
export function renderContentPanel(box, d) {
  const { reader, lacks, view, marks } = d;
  const groups = reader.groups(view);
  const shown = groups.flatMap((g) => g.entries);
  const checkable = shown.filter((e) => e.check);
  const kids = [el('h3', { id: 'content-h' }, 'Model content')];
  const missing = lacks.filter((m) => m.code !== 'NO_CONTENT');
  if (reader.bare) kids.push(el('p', { class: 'small' }, 'This model has no content attached: no findings, notes or convention examples, only what the views derive from the net.'));
  if (reader.dormant) kids.push(el('p', { class: 'small muted' }, `${reader.dormant} of ${reader.total} entries are dormant: they name something this model no longer has.`));
  if (missing.length) kids.push(el('details', { class: 'content-lacks' }, el('summary', {}, `What this model lacks (${missing.length})`), el('ul', { class: 'small' }, missing.map((m) => el('li', {}, m.text)))));
  for (const g of groups) kids.push(el('h4', { class: 'content-kind-h' }, `${g.label} (${g.entries.length})`), ...g.entries.map((e) => entryRow(e, marks)));
  if (checkable.length) {
    const status = el('span', { class: 'small muted' }, ''); // spoken at the end through the page's one live region
    const run = el('button', { class: 'btn', type: 'button', onclick: () => runChecks(checkable, d, run, status) }, `Run checks (${checkable.length})`);
    kids.push(el('p', {}, run, ' ', status));
  }
  box.replaceChildren(...kids);
}

function runChecks(entries, d, button, status) {
  let i = 0, failed = 0;
  button.disabled = true;
  const step = () => {
    if (i >= entries.length) {
      const text = `${entries.length - failed} of ${entries.length} checks passed`;
      announce(failed ? `${text}, ${failed} failed.` : `${text}.`);
      d.rerender();
      return;
    }
    const e = entries[i++];
    let v;
    try { v = d.runCheck(e.id); } catch (err) { v = { ok: false, error: String(err?.message || err) }; }
    d.marks.set(e.id, { ok: !!v?.ok });
    if (!v?.ok) failed++;
    status.textContent = `${i} of ${entries.length}…`;
    setTimeout(step, 0);
  };
  step();
}
