// Where every fact on this page comes from.
//
// A source is a file at a revision; a cite is a source plus a line range and a
// note. Repos on GitHub get a link to the exact lines; the ontology repo is
// private, so its cites name the file and line and give the term's IRI instead.
// Nothing here is fetched at run time: the page reads only this repo.

// The repos and the bibliography come from the registry (bundle.ontology's
// `repos` and `bib`, serialized from the prototype's sources.js; every field was
// checked against arXiv / doi.org / GitHub on 2026-10-27, see the prototype's
// data/receipts/citations.json). setSources() fills them at start-up.
export const REPOS = {};
export const BIB = {};

export function setSources(repos, bib) {
  Object.assign(REPOS, repos || {});
  Object.assign(BIB, bib || {});
}

// A cite from the registry names its repo by name and revision (a link
// verdict's "passed" checks: {repo: "go-pflow", rev, path, from, to, note});
// one from the page names a REPOS key. Both are labelled and linked.
function repoOf(c) {
  if (REPOS[c.repo]) return REPOS[c.repo];
  const byName = Object.values(REPOS).find((r) => r.name === c.repo && (!c.rev || r.rev === c.rev));
  if (byName) return byName;
  const gh = { 'go-pflow': 'pflow-xyz/go-pflow', 'pflow-rs': 'pflow-xyz/pflow-rs', 'pflow-xyz': 'pflow-xyz/pflow-xyz', 'pflow-native': 'pflow-xyz/pflow-native' }[c.repo];
  return { name: c.repo, rev: c.rev || '?', url: gh && c.rev ? `https://github.com/${gh}/blob/${c.rev}/` : null };
}

/** A cite: repo key, path, first and last line (1-based, inclusive), note. */
export function cite(repo, path, from, to = from, note = '') {
  return { repo, path, from, to, note };
}

/** "go-pflow metamodel/queue.go:131-137 @69257b3" */
export function citeLabel(c) {
  const r = repoOf(c);
  const lines = c.from ? (c.to && c.to !== c.from ? `:${c.from}-${c.to}` : `:${c.from}`) : '';
  return `${r.name} ${c.path}${lines} @${r.rev}`;
}

/** A GitHub link to the cited lines, or null for a private repo. */
export function citeURL(c) {
  const r = repoOf(c);
  if (!r.url) return null;
  const lines = c.from ? (c.to && c.to !== c.from ? `#L${c.from}-L${c.to}` : `#L${c.from}`) : '';
  return r.url + c.path + lines;
}

export function bibLabel(key) {
  const b = BIB[key];
  if (!b) return key;
  if (b.site) return `${b.title} (${b.site})`;
  const venue = b.venue ? ` ${b.venue}.` : '';
  const ids = [b.arxiv && `arXiv:${b.arxiv}`, b.doi && `doi:${b.doi}`].filter(Boolean).join(', ');
  return `${b.authors}. "${b.title}."${venue} ${b.year}. ${ids}`;
}

export function bibURL(key) {
  const b = BIB[key];
  if (!b) return null;
  if (b.site) return b.site;
  if (b.arxiv) return `https://arxiv.org/abs/${b.arxiv}`;
  if (b.doi) return `https://doi.org/${b.doi}`;
  return null;
}
