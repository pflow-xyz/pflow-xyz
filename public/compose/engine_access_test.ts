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
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import * as registry from "./registry.js";
import { liveCommand, liveScenario, loadFacts, SCENARIOS } from "./model.js";
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

const gz = await Deno.readFile(new URL("../vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
const bytes = new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const engines: any = await registry.init({ bytes });
loadFacts();
start();

Deno.test("engine access: liveScenario(id) is bundle.run {scenario: id} on the live engine, result for result", () => {
    assert(SCENARIOS.length >= 3, `${SCENARIOS.length} scenarios`);
    for (const s of SCENARIOS) {
        // (the engine numbers the artifact a run stores, a1, a2, ...; the page clears it and never reads the id)
        const { artifact: _a, ...via } = liveScenario(s.id);
        const { artifact: _b, ...direct } = engines.live.call("bundle.run", { scenario: s.id });
        assertEquals(via, direct, s.id);
        assertEquals(via.id, s.id);
        assert(Array.isArray(via.steps) && Array.isArray(via.expect), s.id);
    }
});

Deno.test("engine access: liveScenario refuses what the call refuses, with the same message", () => {
    let direct = "";
    try { engines.live.call("bundle.run", { scenario: "no-such-scenario" }); } catch (e) { direct = (e as Error).message; }
    assert(direct, "the registry accepted an unknown scenario");
    assertThrows(() => liveScenario("no-such-scenario"), Error, direct);
});

Deno.test("engine access: liveCommand is the live engine's call", () => {
    assertEquals(liveCommand("bundle.state"), engines.live.call("bundle.state"));
    assertThrows(() => liveCommand("bundle.no_such_command"), Error);
});
