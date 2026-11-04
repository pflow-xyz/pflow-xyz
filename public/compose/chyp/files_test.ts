// files_test.ts — the integrity of what the Laws view ships and runs.
//
// laws-live.js imports vendor/chyp-rs-wasm/ and runs it on the theories here without looking at a hash; the theories'
// sha256s in assets/chyp/index.json are only shown by the view (laws.js provenance()), never asserted. So a bundle
// edited in place, a file dropped or added, or a theory changed without re-exporting its results would all go
// unnoticed. This test is the check: every sha256 the records carry is recomputed from the file served here. A failure
// means the vendored copy is no longer the one the records describe (re-vendor with scripts/sync-chyp-wasm.mjs /
// re-export with chyp_headless, never edit the hash to match).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const COMPOSE = new URL("../", import.meta.url);
const CHYP = new URL("./", import.meta.url);
const VENDOR = new URL("../../vendor/chyp-rs-wasm/", import.meta.url);
const CHYP_COMMIT = "3d2848361e261b07a86daaacf70b2b4b018affcf";
const THEORIES = ["driver-wrap.chyp", "filter-meet.chyp", "orderer-monoid.chyp", "sync-spiders.chyp"];

const json = async (url: URL) => JSON.parse(await Deno.readTextFile(url));
const hash = async (b: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (url: URL) => hash(await Deno.readFile(url));

const index = await json(new URL("assets/chyp/index.json", COMPOSE));
const lock = await json(new URL("../../../chyp-rs-wasm.lock", import.meta.url));

// Every file below a directory, as paths relative to it, in a stable order.
async function walk(dir: URL, prefix = ""): Promise<string[]> {
    const out: string[] = [];
    for await (const e of Deno.readDir(dir)) {
        if (e.isDirectory) out.push(...await walk(new URL(`${e.name}/`, dir), `${prefix}${e.name}/`));
        else out.push(`${prefix}${e.name}`);
    }
    return out.sort();
}

Deno.test("chyp/: the theories, the licence and the README, and no Python", async () => {
    assertEquals(await walk(CHYP), [...THEORIES, "LICENSE-chyp", "README.md", "files_test.ts"].sort());
});

Deno.test("chyp-rs-wasm.lock: the vendored files are the ones the lock names, and nothing else is there", async () => {
    assertEquals(lock.upstream.commit, CHYP_COMMIT);
    assert(/^[0-9a-f]{40}$/.test(lock.commit), `lock.commit is not a commit: ${lock.commit}`);
    const stored = Object.keys(lock.files).filter((f) => f !== "chyp_rs_bg.wasm");
    assertEquals(await walk(VENDOR), [...stored].sort());
    for (const f of stored) assertEquals(await sha256(new URL(f, VENDOR)), lock.files[f], `${f}: sha256 differs from the lock`);
});

// Same rule as pflow-native's: the server answers a request for the .wasm from these two (cmd/webserver/wasm.go).
Deno.test("chyp-rs-wasm.lock: the .gz and the .br both decompress to the wasm the lock names", async () => {
    for (const [file, format] of [["chyp_rs_bg.wasm.gz", "gzip"]] as const) {
        const body = new Blob([await Deno.readFile(new URL(file, VENDOR))]).stream().pipeThrough(new DecompressionStream(format));
        const wasm = new Uint8Array(await new Response(body).arrayBuffer());
        assertEquals(wasm.length, lock.bytes.wasm);
        assertEquals(await hash(wasm), lock.files["chyp_rs_bg.wasm"]);
    }
    // DecompressionStream has no brotli: node:zlib does. A computed specifier, as petri-wasm_test.ts: a literal one
    // makes Deno want @types/node to type-check.
    const { brotliDecompressSync } = await import(`node:${"zlib"}`);
    const wasm = brotliDecompressSync(await Deno.readFile(new URL("chyp_rs_bg.wasm.br", VENDOR)));
    assertEquals(await hash(new Uint8Array(wasm)), lock.files["chyp_rs_bg.wasm"]);
});

Deno.test("vendor/chyp-rs-wasm: the licence and notices ship with it, and name Chyp", async () => {
    const notice = await Deno.readTextFile(new URL("NOTICE.txt", VENDOR));
    assert(/Chyp/.test(notice) && /Aleks Kissinger/.test(notice), "NOTICE does not name Chyp and its author");
    assert(/Apache License/.test(await Deno.readTextFile(new URL("LICENSE.txt", VENDOR))));
});

Deno.test("assets/chyp/index.json: the Chyp commit is the port's upstream and every theory's sha256 is the .chyp file's", async () => {
    assertEquals(index.chyp.commit, CHYP_COMMIT);
    assertEquals(index.ok, true);
    assertEquals(index.theories.map((t: any) => `${t.name}.chyp`).sort(), THEORIES, "index.json names other theories");
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
        assertEquals(doc.provenance.chyp.commit, CHYP_COMMIT, `${t.name}: the export was made with another Chyp`);
    }
});
