// native_parity_test.ts — pflow-native run natively vs the same commands in the
// vendored wasm (public/vendor/pflow-native-wasm).
//
// parity/native/goldens.json is written by parity/native/gen (Rust, pflow-native
// pinned at the commit the wasm was built from; `make native-goldens`): every
// case of cases.json, run natively as the wasm Engine runs it (load the
// fixture, then each step). This test replays the goldens' own inputs through
// the wasm engine and compares what comes back:
//
//   - strings, booleans, nulls, array lengths and key sets: exact;
//   - integers: exact; any number with a fraction on either side: relative
//     tolerance (default 1e-9, a case may set another and say why) — the two
//     builds use different libm paths, so transcendental results may differ in
//     the last bits;
//   - keys named in a step's `ignore` are skipped, at any depth, for that step
//     only (the signing key of a receipt is generated per session).
//
// Every command the page exposes (NATIVE_COMMANDS) must have at least one
// golden case that succeeds, so adding one to scripts/sync-native-wasm.mjs
// without a case fails here.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadEngine } from "../../public/petri-wasm.js";
import { diff } from "./diff.ts";
import { NATIVE_COMMANDS } from "../../public/vendor/pflow-native-wasm/commands.js";

const gz = await Deno.readFile(new URL("../../public/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
const wasm = new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const { glue } = await loadEngine({ bytes: wasm });

const goldens = JSON.parse(await Deno.readTextFile(new URL("./goldens.json", import.meta.url)));
const cases = JSON.parse(await Deno.readTextFile(new URL("./cases.json", import.meta.url)));
const lock = JSON.parse(await Deno.readTextFile(new URL("../../pflow-native-wasm.lock", import.meta.url)));

const DEFAULT_TOL = 1e-9;

Deno.test("diff: integers exact, fractions by tolerance, ignored keys skipped", () => {
    const none = new Set<string>();
    assertEquals(diff({ a: 1, b: [1.5, "x"] }, { a: 1, b: [1.5, "x"] }, "$", 1e-9, none), []);
    assertEquals(diff({ a: 1 }, { a: 2 }, "$", 1e-9, none).length, 1);
    assertEquals(diff({ a: 0.1 + 0.2 }, { a: 0.3 }, "$", 1e-9, none), []);
    assertEquals(diff({ a: 1.0 }, { a: 1.001 }, "$", 1e-9, none).length, 1);
    assertEquals(diff({ a: 3 }, { a: 3.0000000000000004 }, "$", 1e-9, none), []);
    assertEquals(diff({ a: 1, k: "x" }, { a: 1, k: "y" }, "$", 1e-9, new Set(["k"])), []);
    assertEquals(diff({ a: 1 }, { a: 1, b: 2 }, "$", 1e-9, none).length, 1);
    assertEquals(diff([1, 2], [1], "$", 1e-9, none).length, 1);
});

Deno.test("goldens: written from these cases, at the commit the wasm was built from", () => {
    assertEquals(goldens.pflow_native, lock.commit, "goldens.json was generated against a different pflow-native than the vendored wasm; re-run `make native-goldens`");
    assertEquals(goldens.cases.map((c: any) => c.name), cases.cases.map((c: any) => c.name), "cases.json changed since goldens.json was generated; re-run `make native-goldens`");
    for (const [i, c] of cases.cases.entries()) {
        assertEquals(goldens.cases[i].steps.map((s: any) => s.command), c.steps.map((s: any) => s.command), c.name);
    }
});

Deno.test("coverage: every exposed command has a golden case that succeeds", () => {
    const ok = new Set<string>();
    for (const c of goldens.cases) for (const s of c.steps) if (!s.error) ok.add(s.command);
    const missing = NATIVE_COMMANDS.map((s: any) => s.id).filter((id: string) => !ok.has(id));
    assertEquals(missing, [], `no successful golden case for: ${missing.join(", ")} (add one to parity/native/cases.json and run \`make native-goldens\`)`);
});

const parse = (s: string) => JSON.parse(s);

function listArtifacts(engine: any): any[] {
    return parse(engine.execute("artifact.list", "{}"));
}

for (const g of goldens.cases) {
    Deno.test(`native == wasm: ${g.name}`, async () => {
        const engine = new glue.Engine();
        engine.load(await Deno.readTextFile(new URL(`../${g.fixture}`, import.meta.url)));
        const seen = new Set<string>();
        const problems: string[] = [];
        for (const [i, step] of g.steps.entries()) {
            const where = `${g.name} step ${i} ${step.command}`;
            let result: unknown, error: string | undefined;
            try {
                result = parse(engine.execute(step.command, step.args === undefined ? "" : JSON.stringify(step.args)));
            } catch (e) {
                error = String((e as Error)?.message ?? e);
            }
            const arts: Record<string, unknown> = {};
            for (const a of listArtifacts(engine)) {
                if (seen.has(a.id)) continue;
                seen.add(a.id);
                arts[a.id] = parse(parse(engine.execute("export.artifact", JSON.stringify({ id: a.id, format: "json" }))));
            }
            if (step.generate_only) continue; // run on both sides so ids line up; compared on neither
            const tol = step.tolerance ?? DEFAULT_TOL;
            const ignore = new Set<string>(step.ignore ?? []);
            if (step.error !== undefined) {
                if (error !== step.error) problems.push(`${where}: error ${JSON.stringify(step.error)} != ${JSON.stringify(error ?? "(no error)")}`);
                continue;
            }
            if (error !== undefined) { problems.push(`${where}: wasm threw ${JSON.stringify(error)}, native succeeded`); continue; }
            problems.push(...diff(step.result, result, `${where} result`, tol, ignore));
            problems.push(...diff(step.artifacts ?? {}, arts, `${where} artifacts`, tol, ignore));
        }
        const doc = parse(engine.execute("file.export_json", JSON.stringify({ rates: true })));
        const lastTol = g.steps.reduce((t: number, s: any) => Math.max(t, s.tolerance ?? 0), 0) || DEFAULT_TOL;
        problems.push(...diff(g.doc, doc, `${g.name} document`, lastTol, new Set()));
        assert(problems.length === 0, `\n${problems.slice(0, 25).join("\n")}${problems.length > 25 ? `\n… and ${problems.length - 25} more` : ""}`);
    });
}
