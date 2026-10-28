// sources_test.ts — the page's citations and bibliography, offline.
//
// public/compose/sources.js turns a cite ({repo, path, from, to, note}) into a
// label and a GitHub link, and a bibliography key into a reference. Both degrade
// silently on a bad input: citeLabel() prints "@?" for a repo it cannot resolve,
// citeURL() returns null (the same as for the private ontology repo), bibLabel()
// falls back to the bare key, bibURL() to null, and lens.js filters its own keys
// with `.filter((k) => BIB[k])`. Nothing on the page would say a source went
// missing. This test is the check, and it is offline: the facts come from the
// vendored wasm (render.js setup), the cites from drawing every view.
//
// What is collected (a dangling reference anywhere in it fails):
//   * every inspector info the views attach with ctx.hover(), for every view x
//     example x state of the parity contract (render.js STATES), plus the
//     palette's own (info.pieceInfo / slotInfo / linkKindInfo, app.js);
//   * every view's convention panel (cites, bib);
//   * every cite and bib array anywhere in the facts and constants model.js holds;
//   * every bibliography key written as a literal in public/compose/ (a static
//     scan, because a key behind a state the contract does not reach, or one
//     lens.js filters out when missing, would not be drawn above).
//
// What is NOT checked: that the cited lines say what the note says (the sources
// are other repos), and that a link's revision exists on GitHub (offline).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EXAMPLES, renderManifest, setup, STATES, VIEW_IDS } from "./render.js";
import * as sources from "../../public/compose/sources.js";
import * as model from "../../public/compose/model.js";
import * as info from "../../public/compose/info.js";

const { bibLabel, bibURL, citeLabel, citeURL } = sources;
const BIB: Record<string, any> = sources.BIB; // filled by model.loadFacts() in setup()
const REPOS: Record<string, any> = sources.REPOS;

await setup();

type Seen<T> = Map<string, { value: T; where: string; count: number }>;
const cites: Seen<any> = new Map();
const bibRefs: Seen<string> = new Map();
const note = <T>(m: Seen<T>, key: string, value: T, where: string) => {
    const e = m.get(key);
    if (e) e.count++; else m.set(key, { value, where, count: 1 });
};
const citeKey = (c: any) => `${c.repo}|${c.rev ?? ""}|${c.path}|${c.from}|${c.to}`;
const addCite = (c: any, where: string) => note(cites, citeKey(c), c, where);
const addBib = (k: string, where: string) => note(bibRefs, k, k, where);
const addInfo = (i: any, where: string) => {
    if (!i) return;
    for (const c of i.cites || []) addCite(c, where);
    for (const k of i.bib || []) addBib(k, where);
};

/** Every cite object ({repo, path, from, ...}) and `bib` array below a value. */
function walk(v: any, where: string, seen = new WeakSet<object>()) {
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) { for (const x of v) walk(x, where, seen); return; }
    if (typeof v.repo === "string" && typeof v.path === "string" && "from" in v) addCite(v, where);
    if (Array.isArray(v.bib)) for (const k of v.bib) if (typeof k === "string") addBib(k, where);
    for (const x of Object.values(v)) walk(x, where, seen);
}

// 1. every hover of every view x example x state
let hovers = 0;
for (const example of EXAMPLES) {
    for (const stateId of Object.keys(STATES)) {
        for (const view of VIEW_IDS) {
            await renderManifest(view, example, stateId, { hover: (_node: unknown, i: unknown) => { hovers++; addInfo(i, `${example}/${view}/${stateId} hover`); } });
        }
    }
}

// 2. every convention panel
const views: Record<string, any> = {};
for (const id of VIEW_IDS) {
    views[id] = (await import(`../../public/compose/views/${id}.js`)).default;
    addInfo(views[id].convention, `${id} convention`);
}

// 3. the palette's own hovers (app.js), and 4. the facts and constants of model.js
for (const p of model.PIECES) addInfo(info.pieceInfo(p.name), `palette piece ${p.name}`);
for (const s of model.SLOTS) addInfo(info.slotInfo(s.id), `palette slot ${s.id}`);
for (const k of Object.keys(model.LINK_KINDS)) addInfo(info.linkKindInfo(k), `palette link kind ${k}`);
for (const [name, v] of Object.entries(model)) if (typeof v === "object") walk(v, `model.${name}`);

// 5. the literals: bibliography keys written in the source of public/compose/
const staticKeys = new Map<string, string>(); // key -> first file:line
async function scan(dir: URL, rel = "") {
    for await (const e of Deno.readDir(dir)) {
        if (e.isDirectory) { await scan(new URL(`${e.name}/`, dir), `${rel}${e.name}/`); continue; }
        if (!e.name.endsWith(".js") || e.name.endsWith("_test.js") || `${rel}${e.name}` === "sources.js") continue;
        const lines = (await Deno.readTextFile(new URL(e.name, dir))).split("\n");
        lines.forEach((line, n) => {
            // `bib: [...]`, `x.bib = [...]`, `const BIB = [...]`, `BIB_ORDERS = [...]`, `BIBKEYS = [...]`
            const m = /(?:\bbib\s*[:=]|\bBIB\w*\s*=)(.*)$/.exec(line);
            if (!m) return;
            for (const arr of m[1].matchAll(/\[([^\[\]]*)\]/g)) {
                for (const q of arr[1].matchAll(/['"]([^'"]+)['"]/g)) if (!staticKeys.has(q[1])) staticKeys.set(q[1], `${rel}${e.name}:${n + 1}`);
            }
        });
    }
}
await scan(new URL("../../public/compose/", import.meta.url));
for (const [k, at] of staticKeys) addBib(k, `${at} (literal)`);

// --- the collection is not vacuous -------------------------------------------------------

Deno.test("sources: the collection reaches every view, many hovers, many cites and the literals", () => {
    assertEquals(VIEW_IDS.length, 10);
    assert(hovers > 1000, `${hovers} hovers`);
    assert(cites.size > 100, `${cites.size} distinct cites`);
    assert(staticKeys.size >= 10, `${staticKeys.size} bibliography keys found as literals`);
    // lens.js filters its keys against BIB; the scan reads them before the filter
    assert(staticKeys.has("ghani-hedges") && staticKeys.has("cybercat"), "lens.js BIBKEYS not scanned");
});

// --- cites ------------------------------------------------------------------------------

const privateRepos = new Set(Object.values<any>(REPOS).filter((r) => !r.url).map((r) => r.name));

Deno.test("sources: the repos the registry gives are known, with a revision, a link or an explicit private marker", () => {
    assert(Object.keys(REPOS).length >= 5, "the registry's repos were not loaded");
    for (const [key, r] of Object.entries<any>(REPOS)) {
        assert(typeof r.name === "string" && r.name, `${key}: no name`);
        assert(/^[0-9a-f]{7,40}$/.test(r.rev), `${key}: revision ${JSON.stringify(r.rev)}`);
        // a repo with no url is private (the ontology): its cites name the file and line, with no link
        if (r.url) assertEquals(r.url, `https://github.com/pflow-xyz/${r.name}/blob/${r.rev}/`, key);
    }
    assertEquals([...privateRepos].sort(), ["ontology-pflow-xyz"]);
});

Deno.test("sources: every cite resolves to a repo and a revision, with a link unless the repo is private", () => {
    const bad: string[] = [];
    for (const { value: c, where } of cites.values()) {
        const label = citeLabel(c);
        const at = `${where}: ${label}`;
        if (typeof c.path !== "string" || !c.path || c.path.startsWith("/")) { bad.push(`${at} (path)`); continue; }
        const rev = /@([0-9a-f]{7,40})$/.exec(label)?.[1];
        if (!rev) { bad.push(`${at} (no revision: the repo ${JSON.stringify(c.repo)} did not resolve)`); continue; }
        // a falsy `from` (0 or null) cites the whole file: citeLabel and citeURL print no range for it
        if (c.from && !(Number.isInteger(c.from) && c.from >= 1 && Number.isInteger(c.to || c.from) && (c.to || c.from) >= c.from)) {
            bad.push(`${at} (lines ${c.from}-${c.to})`); continue;
        }
        const url = citeURL(c);
        if (url === null) {
            const name = label.split(" ")[0];
            if (!privateRepos.has(name)) bad.push(`${at} (no link, and ${name} is not a private repo)`);
        } else {
            const lines = !c.from ? "" : c.to && c.to !== c.from ? `#L${c.from}-L${c.to}` : `#L${c.from}`;
            if (!url.startsWith("https://github.com/pflow-xyz/") || !url.endsWith(`/blob/${rev}/${c.path}${lines}`)) bad.push(`${at} (link ${url})`);
        }
    }
    assertEquals(bad, [], `${bad.length} of ${cites.size} cites do not resolve`);
});

// --- bibliography -------------------------------------------------------------------------

Deno.test("sources: every bibliography key a view, a convention panel or the source names exists in BIB", () => {
    assert(bibRefs.size >= 12, `${bibRefs.size} distinct keys referenced`);
    const missing = [...bibRefs.values()].filter(({ value: k }) => !BIB[k]).map(({ value: k, where }) => `${k} (${where})`);
    assertEquals(missing, [], "bibliography keys with no entry (bibLabel would print the bare key)");
    for (const { value: k, where } of bibRefs.values()) {
        assert(bibLabel(k) !== k, `${k} (${where}): bibLabel fell back to the key`);
        assert(bibURL(k), `${k} (${where}): no link`);
    }
});

Deno.test("sources: every BIB entry has a title, a way to find it, and the fields bibLabel prints", () => {
    const keys = Object.keys(BIB);
    assert(keys.length >= 17, `${keys.length} entries`);
    for (const k of keys) {
        const b = BIB[k];
        assert(typeof b.title === "string" && b.title.trim(), `${k}: no title`);
        assert(b.arxiv || b.doi || b.site, `${k}: none of arxiv, doi, site`);
        if (b.arxiv) assert(/^\d{4}\.\d{4,5}$/.test(b.arxiv), `${k}: arxiv ${b.arxiv}`);
        if (b.doi) assert(/^10\.\d{4,9}\/\S+$/.test(b.doi), `${k}: doi ${b.doi}`);
        if (b.site) assert(/^https:\/\/\S+$/.test(b.site), `${k}: site ${b.site}`);
        // A site entry is printed as "title (site)": no authors or year. Every other entry
        // is printed as a paper, which needs both.
        if (!b.site) {
            assert(typeof b.authors === "string" && b.authors.trim(), `${k}: no authors`);
            assert(Number.isInteger(b.year) && b.year >= 1900 && b.year <= 2100, `${k}: year ${b.year}`);
        } else {
            assertEquals(bibURL(k), b.site, k);
            assert(bibLabel(k).startsWith(b.title), k);
        }
        if (b.arxiv && b.year !== undefined) {
            // the year printed is the publication year, never before the preprint's own
            assert(b.year >= 2000 + Number(b.arxiv.slice(0, 2)), `${k}: year ${b.year} is before arXiv:${b.arxiv}`);
        }
        if (!b.site) {
            const label = bibLabel(k);
            assert(label.includes(b.title) && label.includes(String(b.year)), `${k}: ${label}`);
            assertEquals(bibURL(k), b.arxiv ? `https://arxiv.org/abs/${b.arxiv}` : `https://doi.org/${b.doi}`, k);
        }
    }
});

Deno.test("sources: the bibliography entries nothing cites are exactly the ones expected", () => {
    const unused = Object.keys(BIB).filter((k) => !bibRefs.has(k));
    // psv-normal-forms (Patterson, Spivak, Vagner: wiring diagrams as normal forms)
    // is in the registry's bib and no view, convention panel or literal names it. This
    // is not a failure of the page; it is pinned so that citing it (or dropping it from
    // the ontology) is a visible change here, in the same commit.
    assertEquals(unused, ["psv-normal-forms"]);
});
