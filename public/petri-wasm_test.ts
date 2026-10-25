import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadEngine } from "./petri-wasm.js";
import { CommandError, Registry, createHeadlessHost } from "./petri-commands.js";
import { NATIVE_COMMANDS, NATIVE_VERSION } from "./vendor/pflow-native-wasm/commands.js";

// The vendored shim is stored gzip-only; decompress it the way a browser's
// Content-Encoding: gzip would.
const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
const wasm = new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
await loadEngine({ bytes: wasm });

const hex = async (b: Uint8Array<ArrayBuffer> | Uint8Array) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.test("vendor: the bundle matches pflow-native-wasm.lock", async () => {
    const lock = JSON.parse(await Deno.readTextFile(new URL("../pflow-native-wasm.lock", import.meta.url)));
    const glue = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm.js", import.meta.url));
    assertEquals(await hex(glue), lock.files["pflow_native_wasm.js"]);
    assertEquals(await hex(gz), lock.files["pflow_native_wasm_bg.wasm.gz"]);
    assertEquals(await hex(wasm), lock.files["pflow_native_wasm_bg.wasm"]);
    assertEquals(NATIVE_VERSION, lock.version);
    assertEquals(NATIVE_COMMANDS.map((c: any) => c.id), lock.exposed);
});

Deno.test("vendor: the snapshot specs match the engine's own", async () => {
    const { engine } = await loadEngine();
    const live = JSON.parse(engine.listCommands(""));
    for (const s of NATIVE_COMMANDS as any[]) {
        const l = live.find((c: any) => c.id === s.id);
        assertEquals(s.args, l.args, s.id);
        assertEquals(s.help, l.help, s.id);
    }
});

const sir = () => ({
    "@context": "https://pflow.xyz/schema", "@type": "PetriNet", token: ["https://pflow.xyz/tokens/black"],
    places: { S: { initial: [9], capacity: [0], x: 0, y: 0 }, I: { initial: [1], capacity: [0], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
    transitions: { infect: { x: 50, y: 0 }, recover: { x: 150, y: 0 } },
    arcs: [
        { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
        { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
        { source: "recover", target: "R", weight: [1] },
    ],
});

const reg = (): any => new Registry(createHeadlessHost(sir()));

Deno.test("native: invariants land as JS artifacts, ids rewritten", async () => {
    const r = reg();
    const out = await r.execute("analysis.invariants");
    assertEquals(out.p_invariants[0].expression, "S + I + R = 10");
    const sets = r.artifact(out.sets);
    assertEquals(sets.data.kind, "sets");
    assertEquals(sets.data.sets[0].nodes, ["S", "I", "R"]);
    assertEquals(sets.source.command, "analysis.invariants");
    assert(out.matrices.every((id: string) => r.artifact(id).data.kind === "matrix"));
    const shown = await r.execute("artifact.show_set", { id: out.sets, index: 0 });
    assertEquals(shown.set.label, "S + I + R = 10");
});

Deno.test("native: verify refutes deadlock-freedom; sim.goto replays the counterexample", async () => {
    const r = reg();
    const out = await r.execute("analysis.verify");
    const dl = out.verdicts.find((v: any) => v.property.kind === "deadlock-free");
    assertEquals(dl.status, "refuted");
    const trace = r.artifact(dl.trace);
    assertEquals(trace.data.kind, "trace");
    const last = trace.data.steps.length - 1;
    const went = await r.execute("sim.goto", { id: dl.trace, step: last });
    assertEquals(went.marking, { S: [9], I: [0], R: [1] });
    assertEquals((await r.execute("sim.enabled")).enabled, []); // the deadlock
    await r.execute("sim.reset");
    assertEquals((await r.execute("sim.marking")).marking, { S: [9], I: [1], R: [0] });
});

Deno.test("native: reach gives a shortest trace", async () => {
    const r = reg();
    const out = await r.execute("analysis.reach", { to: { R: 10 } });
    assertEquals(out.answer, "yes");
    assertEquals(r.artifact(out.trace).data.steps.length, 20); // the start plus 19 firings
});

Deno.test("native: the reachability graph, and goto on one of its states", async () => {
    const r = reg();
    const out = await r.execute("analysis.reachability");
    assertEquals(out.states, 65);
    const g = r.artifact(out.graph);
    assertEquals(g.data.kind, "graph");
    const dead = out.deadlocks[0];
    await r.execute("sim.goto", { id: out.graph, node: dead });
    assertEquals((await r.execute("sim.enabled")).enabled, []);
});

Deno.test("native: incidence, siphons, canonical, classify and validate run", async () => {
    const r = reg();
    const inc = await r.execute("analysis.incidence");
    assertEquals(inc.incidence, [[-1, 0], [1, -1], [0, 1]]);
    assertEquals(r.artifact(inc.artifact).data.kind, "matrix");
    const sip = await r.execute("analysis.siphons");
    assert(Array.isArray(sip.minimal_siphons));
    const can = await r.execute("analysis.canonical");
    assertEquals(typeof can.canonical_id, "string");
    await r.execute("analysis.classify");
    const val = await r.execute("analysis.validate");
    assert(val !== null);
});

Deno.test("native: argument errors come back as CommandErrors, by name", async () => {
    const r = reg();
    await assertRejects(() => r.execute("analysis.reach", { too: { R: 1 } }), CommandError, 'unknown argument "too"');
    await assertRejects(() => r.execute("analysis.reach", { to: { nowhere: 1 } }), CommandError);
});

Deno.test("native: a capacity-bounded net loads (unbounded capacities travel as null)", async () => {
    const net: any = sir();
    net.places.R.capacity = [3];
    const r: any = new Registry(createHeadlessHost(net));
    const out = await r.execute("analysis.reach", { to: { R: 4 } });
    assertEquals(out.answer, "no");
});
