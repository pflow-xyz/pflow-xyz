// files_test.ts — the integrity of what the Laws view ships and runs.
//
// laws-live.js fetches chyp/files.json and writes every listed file into
// Pyodide's file system without looking at a hash; the theories' sha256s in
// assets/chyp/index.json are only shown by the view (laws.js provenance()), never
// asserted. So a Chyp module edited in place, a file dropped or added without
// updating the list, or a theory changed without re-exporting its results would
// all go unnoticed. This test is the check: every sha256 the three records carry
// is recomputed from the file served here, and the shipped set equals the listed
// set. A failure means the vendored copy is no longer the one the records
// describe (re-vendor from Chyp / re-export with chyp_headless, never edit the
// hash to match).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const COMPOSE = new URL("../", import.meta.url);
const CHYP = new URL("./", import.meta.url);
const PY = new URL("./py/", import.meta.url);

const json = async (url: URL) => JSON.parse(await Deno.readTextFile(url));
const sha256 = async (url: URL) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(url)))].map((x) => x.toString(16).padStart(2, "0")).join("");

const files = await json(new URL("files.json", CHYP));
const index = await json(new URL("assets/chyp/index.json", COMPOSE));

// Every file below a directory, as paths relative to it, in a stable order.
async function walk(dir: URL, prefix = ""): Promise<string[]> {
    const out: string[] = [];
    for await (const e of Deno.readDir(dir)) {
        if (e.isDirectory) out.push(...await walk(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`));
        else out.push(`${prefix}${e.name}`);
    }
    return out.sort();
}

Deno.test("chyp/files.json: 24 Python files at Chyp 3d28483, no path listed twice", () => {
    assertEquals(files.chyp_commit, "3d2848361e261b07a86daaacf70b2b4b018affcf");
    assertEquals(files.python.length, 24);
    const paths = files.python.map((f: any) => f.path);
    assertEquals(new Set(paths).size, paths.length, "a path is listed twice");
    for (const f of files.python) assert(/^[0-9a-f]{64}$/.test(f.sha256), `${f.path}: sha256 is not 64 hex digits`);
});

// laws-live.js stops at the first file it cannot fetch, and production's nginx serves a static file only
// for the extensions VIEWS.md lists: chyp/py.typed, listed here until 2026-10-31, was a 404 that stopped
// the live check on pflow.xyz while it worked against make run.
Deno.test("chyp/files.json: production serves every listed file's type", () => {
    for (const f of files.python) assert(f.path.endsWith(".py"), `${f.path}: not a type nginx serves`);
    for (const t of files.theories) assert(t.endsWith(".chyp"), `${t}: not a type nginx serves`);
});

Deno.test("chyp/files.json: every listed Python file exists and its sha256 is the file's", async () => {
    for (const f of files.python) {
        let actual: string | null = null;
        try { actual = await sha256(new URL(`py/${f.path}`, CHYP)); } catch { /* reported below */ }
        assert(actual !== null, `${f.path}: listed in files.json but not in chyp/py/`);
        assertEquals(actual, f.sha256, `${f.path}: sha256 differs from files.json`);
    }
});

/**
 * The files below chyp/ (paths relative to it) that files.json does not account for: any Python source,
 * wherever it sits (a .py in a __pycache__ or a dot directory is still a .py), and anything else under py/
 * but bytecode (.pyc, which an interpreter run in a checkout leaves in __pycache__ and git ignores).
 * Outside py/ the other files are the theories (checked below), the licence, the README and the lists.
 */
function unlisted(shipped: string[], listed: string[]): string[] {
    const ok = new Set(listed.map((p) => `py/${p}`));
    return shipped.filter((p) => {
        if (ok.has(p)) return false;
        if (p.endsWith(".py")) return true;
        return p.startsWith("py/") && !p.endsWith(".pyc");
    });
}

Deno.test("chyp/files.json: nothing is shipped in chyp/ that the list does not name", async () => {
    // The whole directory, every depth, dot and cache directories included: laws-live.js writes the listed files
    // into Pyodide and nothing else, so a Python file the list does not name would be served but never run.
    const shipped = await walk(CHYP);
    const listed = files.python.map((f: any) => f.path).sort();
    assertEquals(unlisted(shipped, listed), [], "files in chyp/ that files.json does not list (laws-live.js would never write them into Pyodide)");
    // and the other way round: what py/ holds (bytecode apart) is exactly the list
    assertEquals(shipped.filter((p) => p.startsWith("py/") && !p.endsWith(".pyc")), listed.map((p: string) => `py/${p}`).sort());
});

Deno.test("chyp/files.json: the unlisted-file check sees a .py at any depth, in cache and dot directories", () => {
    const listed = ["chyp/term.py", "chyp_headless/run.py"];
    const base = ["files.json", "README.md", "LICENSE-chyp", "files_test.ts", "a.chyp", "py/chyp/term.py", "py/chyp_headless/run.py"];
    assertEquals(unlisted(base, listed), []);
    // bytecode an interpreter leaves behind is not a source
    assertEquals(unlisted([...base, "py/chyp/__pycache__/term.cpython-312.pyc"], listed), []);
    // but none of these is allowed
    for (const extra of [
        "py/chyp/__pycache__/term.py", // a source in a cache directory (the first version of this check skipped __pycache__)
        "py/chyp/__pycache__/sub/deep/x.py",
        "py/.hidden/x.py",
        "py/chyp/.cache/term.py",
        ".hidden/x.py",
        "__pycache__/x.py",
        "x.py", // beside files.json
        "py/chyp/extra.py",
        "py/chyp/data.json", // anything else under py/
        "py/chyp/__pycache__/notes.txt",
    ]) assertEquals(unlisted([...base, extra], listed), [extra], extra);
    // a listed path in the wrong place is unlisted too
    assertEquals(unlisted([...base, "py/chyp_headless/term.py"], listed), ["py/chyp_headless/term.py"]);
});

Deno.test("chyp/files.json: the four theories are the .chyp files in chyp/, and each exists", async () => {
    assertEquals(files.theories.length, 4);
    for (const t of files.theories) {
        assert(t.endsWith(".chyp"), t);
        assert((await Deno.stat(new URL(t, CHYP))).isFile, `${t}: listed in files.json but missing`);
    }
    const onDisk = (await walk(CHYP)).filter((p) => !p.includes("/") && p.endsWith(".chyp"));
    assertEquals([...files.theories].sort(), onDisk, "a .chyp file in chyp/ that files.json does not list, or the reverse");
});

Deno.test("assets/chyp/index.json: the Chyp commit agrees with files.json and every theory's sha256 is the .chyp file's", async () => {
    assertEquals(index.chyp.commit, files.chyp_commit);
    assertEquals(index.ok, true);
    assertEquals(index.theories.map((t: any) => `${t.name}.chyp`).sort(), [...files.theories].sort(), "index.json and files.json name different theories");
    for (const t of index.theories) {
        // `source` is relative to public/compose/ ("chyp/<name>.chyp")
        assertEquals(t.source, `chyp/${t.name}.chyp`);
        assertEquals(await sha256(new URL(t.source, COMPOSE)), t.sha256, `${t.name}: sha256 differs from index.json`);
        assertEquals(t.file, `${t.name}.json`);
    }
});

Deno.test("assets/chyp/<theory>.json: the export was made from the theory shipped here", async () => {
    // laws.js provenance() shows this comparison as a note; here it is an assertion.
    for (const t of index.theories) {
        const doc = await json(new URL(`assets/chyp/${t.file}`, COMPOSE));
        const src = doc.provenance.source;
        assertEquals(src.path, t.source, `${t.name}: the export names another source file`);
        assertEquals(src.sha256, t.sha256, `${t.name}: the export was made from a different version of the theory (stale)`);
        assertEquals(doc.provenance.chyp.commit, files.chyp_commit, `${t.name}: the export was made with another Chyp`);
    }
});
