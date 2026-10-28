// engine_access_test.ts — who may ask the engine.
//
// The composition views take every answer from pflow-native's registry (the
// vendored wasm, registry.js) and re-implement none of it. For that to stay
// checkable, the engines are reached from one place: model.js asks (facts,
// Flatten, scenario runs, the token game, the lens test, plans), and hands the
// store (state.js) the one call it needs to edit what is open (liveCommand,
// flattenLive). A view that imported registry.js and called a command itself
// would be a rule the model does not know about. Two parts:
//
//   1. a lint of the source: which modules under public/compose/ import
//      registry.js (and the wasm shim behind it), and that no view calls a
//      registry command by name;
//   2. the seams model.js adds for the two views that used to call the engine
//      themselves (flat.js and process.js ran bundle.run {scenario}) behave
//      exactly like the call they replace.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as registry from "./registry.js";
import { defaultLinks, liveCommand, liveScenario, loadFacts, SCENARIOS } from "./model.js";
import { start } from "./state.js";

const COMPOSE = new URL("./", import.meta.url);

// --- 1. the lint ---------------------------------------------------------------------------

async function walk(dir: URL, rel = ""): Promise<string[]> {
    const out: string[] = [];
    for await (const e of Deno.readDir(dir)) {
        if (e.isDirectory) out.push(...await walk(new URL(`${e.name}/`, dir), `${rel}${e.name}/`));
        else if (e.name.endsWith(".js")) out.push(`${rel}${e.name}`);
    }
    return out.sort();
}

/** Every module specifier a source imports: static, side-effect, re-export and dynamic. */
function specifiers(src: string): string[] {
    const out: string[] = [];
    for (const m of src.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
    for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
    for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
    return out;
}

/** What a specifier written in `file` resolves to, without the extension (so './registry' counts too). */
function target(file: string, spec: string): string | null {
    try { return new URL(spec, new URL(file, COMPOSE)).href.replace(/\.js$/, ""); } catch { return null; }
}

const files = await walk(COMPOSE);
const sources: Record<string, string> = {};
for (const f of files) sources[f] = await Deno.readTextFile(new URL(f, COMPOSE));

/** The files that import `module` (a path under public/, without extension), as written or extensionless. */
function importersOf(module: string): string[] {
    const want = new URL(module, new URL("../", COMPOSE)).href;
    return files.filter((f) => specifiers(sources[f]).some((s) => target(f, s) === want));
}

Deno.test("engine access: the scan sees the composition's modules and finds the imports it should", () => {
    assert(files.includes("model.js") && files.includes("views/flat.js") && files.includes("views/process.js"), files.join(", "));
    assert(files.filter((f) => f.startsWith("views/")).length >= 10);
    // the scan is not blind: model.js does import the registry, and most views import model.js
    assert(importersOf("compose/registry").includes("model.js"));
    assert(importersOf("compose/model").filter((f) => f.startsWith("views/")).length >= 8);
    // the matcher takes the spellings a module can write
    assertEquals(specifiers(`import { a,\n  b } from '../registry.js';\nimport * as r from "./registry";\nexport { x } from './registry.js';\nimport './registry.js';\nconst m = await import('../registry.js');`).length, 5);
    assertEquals(target("views/x.js", "../registry.js"), target("state.js", "./registry"));
});

Deno.test("engine access: no view imports registry.js", () => {
    const offenders = files.filter((f) => f.startsWith("views/") && specifiers(sources[f]).some((s) => target(f, s) === target("registry.js", "./registry.js")));
    assertEquals(offenders, [], "a view reaches the engine itself; add a question to model.js and call that");
});

Deno.test("engine access: no view names a registry command to call", () => {
    // engines.live.call('bundle.run', ...), anything.call("plan.check", ...). Prose that mentions a command is fine.
    const call = /\.call\(\s*['"`](?:bundle|plan|sim|analysis|session|game|ode|workbench)\.[a-z_]+['"`]/;
    const offenders = files.filter((f) => f.startsWith("views/") && call.test(sources[f]));
    assertEquals(offenders, [], "a view calls a registry command directly");
});

Deno.test("engine access: only model.js and the page's loader import registry.js", () => {
    // model.js asks. app.js loads the wasm (registry.init) and prints the engine's version: it asks nothing.
    // state.js, the store, used to import it for its edit commands and now goes through liveCommand/flattenLive.
    assertEquals(importersOf("compose/registry"), ["app.js", "model.js"]);
});

Deno.test("engine access: nothing but registry.js imports the wasm shim", () => {
    assertEquals(importersOf("petri-wasm"), ["registry.js"]);
});

// --- 2. the seams ---------------------------------------------------------------------------
//
// model.js's liveScenario/liveCommand must be registry.js's wrapped call on the live engine, not the
// raw engine behind it: the wrapper is what turns a refusal into a Refusal (state.js's refused(e)
// reads e.errors) and clears the artifact a bundle.run/.flatten/.lens/... stores. A seam that went
// round it would return the same results and pass an equality test, so these tests look at the
// refusals and at the engine's artifact list as well.

const gz = await Deno.readFile(new URL("../vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
const bytes = new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const engines: any = await registry.init({ bytes });
loadFacts();
start();

/** What a call throws (null if it returns). */
function thrown(f: () => unknown): any {
    try { f(); } catch (e) { return e; }
    return null;
}

/** The artifacts the live engine holds right now (read on the raw engine: the wrapper would not clear them). */
function artifacts(): any[] {
    const r = engines.live.raw.call("artifact.list", {});
    return Array.isArray(r) ? r : r.artifacts;
}

/** The same refusal, from the seam and from the direct (wrapped) call: a Refusal with the registry's errors. */
function assertSameRefusal(via: any, direct: any, command: string) {
    assert(direct instanceof registry.Refusal, "the direct call did not refuse");
    assert(via instanceof registry.Refusal, `the seam threw ${via?.constructor?.name}, not a Refusal: ${via?.message}`);
    assertEquals(via.command, command);
    assertEquals(via.message, direct.message);
    assertEquals(via.errors, direct.errors);
    assert(via.errors.length > 0);
}

Deno.test("engine access: liveScenario(id) is bundle.run {scenario: id} on the live engine, result for result", () => {
    assert(SCENARIOS.length >= 3, `${SCENARIOS.length} scenarios`);
    engines.live.raw.call("artifact.clear", {});
    for (const s of SCENARIOS) {
        // (the engine numbers the artifact a run stores, a1, a2, ...; the page clears it and never reads the id)
        const { artifact: _a, ...via } = liveScenario(s.id);
        assertEquals(artifacts(), [], `${s.id}: liveScenario left its run in the live engine`);
        const { artifact: _b, ...direct } = engines.live.call("bundle.run", { scenario: s.id });
        assertEquals(via, direct, s.id);
        assertEquals(via.id, s.id);
        assert(Array.isArray(via.steps) && Array.isArray(via.expect), s.id);
    }
});

Deno.test("engine access: liveScenario refuses what the call refuses, as the same Refusal", () => {
    const direct = thrown(() => engines.live.call("bundle.run", { scenario: "no-such-scenario" }));
    const via = thrown(() => liveScenario("no-such-scenario"));
    assertSameRefusal(via, direct, "bundle.run");
    assertEquals(artifacts(), []);
});

Deno.test("engine access: liveCommand is the live engine's call, arguments and all", () => {
    assertEquals(liveCommand("bundle.state"), engines.live.call("bundle.state"));
    // arguments reach the engine: bundle.run needs its scenario, bundle.candidates its port
    // (a seam that dropped them would throw "pass `scenario` or `script`" / "missing required argument")
    const s = SCENARIOS[0].id;
    const { artifact: _a, ...run } = liveCommand("bundle.run", { scenario: s });
    const { artifact: _b, ...directRun } = engines.live.call("bundle.run", { scenario: s });
    assertEquals(run, directRun);
    assertEquals(run.id, s);
    const from = defaultLinks()[0].from;
    assertEquals(liveCommand("bundle.candidates", { from }), engines.live.call("bundle.candidates", { from }));
    assert(liveCommand("bundle.candidates", { from }).candidates.length > 0);
});

Deno.test("engine access: liveCommand clears the artifact a command stores, like the wrapped call", () => {
    engines.live.raw.call("artifact.clear", {});
    liveCommand("bundle.run", { scenario: SCENARIOS[0].id });
    liveCommand("bundle.flatten");
    assertEquals(artifacts(), [], "liveCommand left an artifact in the live engine");
});

Deno.test("engine access: liveCommand refuses as a Refusal, with the registry's codes in errors", () => {
    // state.js reads e.errors (refused(e)); a bare Error from the raw engine has none.
    const dup = defaultLinks()[0]; // already in the composition: the page rule PAGE_DUPLICATE
    const args = { kind: dup.kind, from: dup.from, to: dup.to };
    const before = engines.live.call("bundle.state");
    const direct = thrown(() => engines.live.call("bundle.add_link", args));
    const via = thrown(() => liveCommand("bundle.add_link", args));
    assertSameRefusal(via, direct, "bundle.add_link");
    assertEquals(via.errors.map((e: any) => e.code), ["PAGE_DUPLICATE"]);
    assertEquals(engines.live.call("bundle.state"), before, "a refused link changed the composition");
    // an unknown command, and a known one without its arguments
    assertSameRefusal(thrown(() => liveCommand("bundle.no_such_command")), thrown(() => engines.live.call("bundle.no_such_command")), "bundle.no_such_command");
    assertSameRefusal(thrown(() => liveCommand("bundle.run")), thrown(() => engines.live.call("bundle.run")), "bundle.run");
});
