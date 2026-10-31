// The model behind /compose.html?cid=<cid>: what the object store holds under
// that CID, said once, with the identity rule applied in the browser.
//
// GET /?cid=<composition> redirects here (the editor cannot open a bundle). The
// panel shows the composition's parts and links, its flat net (the server's
// /img/<cid>.svg, drawn with go-pflow's Flatten) and its CID, which it
// recomputes with public/model-cid.mjs: the same rule as Go's internal/model,
// held to it by parity/model/golden.json.
//
// It does not load the composition into the registry. The vendored wasm has
// bundle.load since pflow-native d0f4a47, but this page does not call it yet:
// the views keep drawing the built-in example and the panel says so.

import { el } from './dom.js';

/** The cid in ?cid=, or null. */
export function cidFromLocation(loc = globalThis.location) {
  try { return new URLSearchParams(loc.search).get('cid') || null; } catch { return null; }
}

/** What the page shows of a stored document; pure, so it can be tested without a DOM. */
export function summarize(doc) {
  const kind = doc?.['@type'] === 'PetriNetBundle' ? 'composition' : doc?.['@type'] === 'SearchPlan' ? 'plan' : 'net';
  const out = { kind, name: typeof doc?.name === 'string' ? doc.name : '', parts: [], links: [] };
  if (kind === 'composition') {
    out.description = typeof doc.description === 'string' ? doc.description : '';
    out.parts = (Array.isArray(doc.subnets) ? doc.subnets : []).map((s) => ({
      id: s?.id ?? '',
      netType: s?.net_type ?? '',
      cid: typeof s?.cid === 'string' ? s.cid : null, // a stored net; else the part is written inline
      pattern: typeof s?.pattern === 'string' ? s.pattern : '',
      params: typeof s?.params === 'string' ? s.params : '',
    }));
    out.links = (Array.isArray(doc.links) ? doc.links : []).map((l) => ({
      id: l?.id ?? '',
      kind: l?.kind ?? '',
      from: end(l?.from),
      to: end(l?.to),
    }));
  } else if (kind === 'plan') {
    out.modelCid = typeof doc.model_cid === 'string' ? doc.model_cid : '';
  } else {
    out.places = Object.keys(doc?.places || {}).length;
    out.transitions = Object.keys(doc?.transitions || {}).length;
  }
  return out;
}

function end(e) {
  if (!e) return '';
  const where = e.port ?? e.place ?? e.transition ?? '';
  return where ? `${e.subnet}:${where}` : String(e.subnet ?? '');
}

/** Fetch the stored object. Throws with the server's status on failure. */
export async function fetchModel(cid, fetchFn = globalThis.fetch) {
  const r = await fetchFn(`/o/${encodeURIComponent(cid)}`);
  if (!r.ok) throw new Error(r.status === 404 ? `No object ${cid} in the store.` : `The store answered ${r.status}.`);
  return r.json();
}

/**
 * Recompute the model CID in the browser (the vendored jsonld bundle loads
 * only here, not on a plain visit to the page). Resolves to {cid, sealed,
 * reduced, kind}.
 */
export async function verify(doc) {
  const { identify } = await import('../model-cid.mjs');
  return identify(doc);
}

const short = (c) => (c.length > 22 ? `${c.slice(0, 12)}…${c.slice(-8)}` : c);

/** Fill `box` with the model panel for `cid`. Never throws: a failure is said in the panel. */
export async function showModel(box, cid, deps = {}) {
  const get = deps.fetchModel || fetchModel;
  const check = deps.verify || verify;
  box.replaceChildren(el('h3', {}, 'Model'), el('p', { class: 'muted' }, `Loading ${short(cid)}…`));
  let doc;
  try { doc = await get(cid); } catch (e) {
    box.replaceChildren(el('h3', {}, 'Model'), el('p', { class: 'warn' }, String(e.message || e)),
      el('p', { class: 'small' }, el('a', { href: '/' }, 'Back to the editor')));
    return null;
  }
  const m = summarize(doc);
  const rows = [
    el('p', { class: 'small' }, el('b', {}, m.kind), m.name ? ` · ${m.name}` : '', ' ', el('code', { title: cid }, short(cid))),
  ];
  if (m.kind === 'composition') {
    rows.push(
      el('p', { class: 'small' }, `${m.parts.length} parts, ${m.links.length} links. Each part keeps its own CID; changing a link changes only this one.`),
      el('ul', { class: 'small' }, m.parts.map((p) => el('li', {},
        el('b', {}, p.id), p.netType ? ` (${p.netType})` : '', ' · ',
        p.cid ? el('a', { href: `/?cid=${p.cid}`, title: 'open this net in the editor' }, `net ${short(p.cid)}`) : 'inline net (no CID of its own)',
        p.pattern ? ` · built by ${p.pattern}` : '')),
      ),
      m.links.length ? el('ul', { class: 'small' }, m.links.map((l) => el('li', {}, el('b', {}, l.kind), ` ${l.from} → ${l.to}`))) : null,
      el('img', { src: `/img/${cid}.svg`, alt: `${m.name || 'composition'}: the flat net`, class: 'model-flat', loading: 'lazy' }),
      el('p', { class: 'small muted' },
        'The views below still draw the built-in orders / workers / payment example: this page does not open a stored composition in its views yet.'),
    );
  } else if (m.kind === 'plan') {
    rows.push(el('p', { class: 'small' }, 'A search plan for the model ', el('a', { href: `/compose.html?cid=${m.modelCid}` }, short(m.modelCid)), '.'));
  } else {
    rows.push(
      el('p', { class: 'small' }, `A net: ${m.places} places, ${m.transitions} transitions. A single net is a model, with the CID it has always had.`),
      el('p', { class: 'small' }, el('a', { href: `/?cid=${cid}` }, 'Open it in the editor')),
    );
  }
  const idLine = el('p', { class: 'small muted' }, 'Checking the CID in your browser…');
  rows.push(idLine);
  box.replaceChildren(el('h3', {}, 'Model'), ...rows.filter(Boolean)); // replaceChildren(null) would write the text "null"
  try {
    const id = await check(doc);
    const same = id.cid === cid || id.sealed === cid;
    idLine.textContent = same
      ? `✓ The CID recomputes in this browser${id.reduced ? ` (a bare wrapper: it is the net ${short(id.cid)})` : ''}.`
      : `✗ This browser computes ${short(id.cid)}, not ${short(cid)}: the stored object does not match its CID.`;
    idLine.className = same ? 'small muted' : 'small warn';
  } catch (e) {
    idLine.textContent = `Could not check the CID here: ${e.message || e}`;
    idLine.className = 'small warn';
  }
  return doc;
}
