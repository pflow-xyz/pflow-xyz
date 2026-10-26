import { assert, assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadEngine } from "./petri-wasm.js";
import { COMMANDS, CommandError, Registry, createHeadlessHost, nativeCommands } from "./petri-commands.js";
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

// Arguments the snapshot drops on purpose (they read or write the host's files):
// scripts/sync-native-wasm.mjs STRIP_ARGS.
const STRIPPED: Record<string, string[]> = { "export.svg": ["path"], "data.load_log": ["path"] };

Deno.test("vendor: the snapshot specs match the engine's own", async () => {
    const { engine } = await loadEngine();
    const live = JSON.parse(engine.listCommands(""));
    for (const s of NATIVE_COMMANDS as any[]) {
        const l = live.find((c: any) => c.id === s.id);
        const dropped = STRIPPED[s.id] || [];
        const keep = (o: any) => Object.fromEntries(Object.entries(o.properties || {}).filter(([k]) => !dropped.includes(k)));
        assertEquals(s.args.properties, keep(l.args), s.id);
        assertEquals(s.args.required, (l.args.required || []).filter((k: string) => !dropped.includes(k)), s.id);
        assertEquals(s.help, l.help, s.id);
    }
});

Deno.test("vendor: no exposed native id is a JS command's id, and the registry refuses a duplicate", () => {
    const js = new Set(COMMANDS.map((c: any) => c.id));
    assertEquals(NATIVE_COMMANDS.map((c: any) => c.id).filter((id: string) => js.has(id)), []);
    const dup = nativeCommands([{ ...(NATIVE_COMMANDS as any[])[0], id: "net.info" }]);
    assertThrows(() => new Registry(createHeadlessHost(), [...COMMANDS, ...dup]), Error, "registered twice: net.info");
});

Deno.test("vendor: the path arguments are not accepted (no file access from the page)", async () => {
    const r: any = new Registry(createHeadlessHost(sir()));
    await assertRejects(() => r.execute("export.svg", { path: "/tmp/x.svg" }), CommandError, 'unknown argument "path"');
    await assertRejects(() => r.execute("data.load_log", { path: "/tmp/x.csv" }), CommandError, 'unknown argument "path"');
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

// ---- phase 3: the simulation workbench ----

// The same seed gives the same numbers in the browser's SSA (petri-ssa.js)
// and pflow-native's (wasm): the ROADMAP's phase-3 exit check, on the shared
// coffee-shop golden converted to the editor's format.
const golden = JSON.parse(await Deno.readTextFile(new URL("../parity/ssa/coffeeshop.json", import.meta.url)));
function editorNet(sim: any) {
    const places: any = {}, transitions: any = {};
    for (const p of sim.places) places[p.id] = { initial: [p.initial ?? 0], capacity: [p.capacity ?? 0], x: 0, y: 0 };
    // REVIEW: transitions in sorted-id order. pflow-native's SSA visits
    // transitions sorted by id, while petri-ssa.js and go-pflow's portable
    // goldens use document order, so the two agree to the bit only when the
    // document order is sorted. A pflow-native follow-up
    // (docs/workbench-progress.md, phase 3); this test pins agreement for
    // sorted nets so a second divergence cannot hide behind the first.
    for (const t of [...sim.transitions].sort((x: any, y: any) => (x.id < y.id ? -1 : 1))) transitions[t.id] = { x: 0, y: 0, ...(t.rate !== undefined ? { rate: t.rate } : {}) };
    const arcs = sim.arcs.map((a: any) => ({ source: a.from, target: a.to, weight: [a.weight ?? 1], inhibitTransition: a.type === "inhibitor" }));
    return { "@context": "https://pflow.xyz/schema", "@type": "PetriNet", token: ["https://pflow.xyz/tokens/black"], places, transitions, arcs };
}
Deno.test({ name: "parity: JS sim.ssa and pflow-native's sim.ssa agree to the bit on one seed (coffee-shop golden)", fn: async () => {
    const net = editorNet(golden.model);
    const r: any = new Registry(createHeadlessHost(net));
    const js = await r.execute("sim.ssa", { t_end: 8, runs: 5, seed: 42, points: 60 });
    const { engine } = await loadEngine();
    engine.load(JSON.stringify(JSON.parse(JSON.stringify(r.host.getModel()))));
    const native = JSON.parse(engine.execute("sim.ssa", JSON.stringify({ t_end: 8, runs: 5, seed: 42, points: 60 })));
    const nativeArt = JSON.parse(JSON.parse(engine.execute("export.artifact", JSON.stringify({ id: native.artifact, format: "json" }))));
    const jsArt = r.artifact(js.artifact);
    for (const s of jsArt.data.series) {
        const n = nativeArt.data.series.find((x: any) => x.name === s.name);
        assert(n, `native has no series ${s.name}`);
        assertEquals(s.values, n.values, s.name);
    }
}});

Deno.test("phase 3: diagnose gives a tornado; heatmap and optimize give their kinds", async () => {
    const r = reg();
    const d = await r.execute("analysis.diagnose", { observable: "R", t_end: 10, noise: false });
    assert(d.artifact || d.bars || d.report);
    const bars = r.artifacts().find((a: any) => a.data.kind === "bars");
    assert(bars && bars.data.bars.length > 0);
    const h = await r.execute("opt.heatmap", { param_x: "infect", param_y: "recover", x_from: 0.01, x_to: 0.1, y_from: 0.05, y_to: 0.5, observable: "R", steps: 4 });
    const hm = r.artifacts().find((a: any) => a.data.kind === "heatmap");
    assertEquals(hm.data.z.length, 4);
    await r.execute("opt.optimize", { parameters: [{ transition: "recover", min: 0.05, max: 0.5 }], objectives: [{ place: "R", sense: "max" }], samples: 20, seed: 1 });
    assert(r.artifacts().some((a: any) => a.data.kind === "scatter"));
    assert(h !== null);
});

Deno.test("phase 3: compare (what if one more), crosscheck and equilibrium run", async () => {
    const r = reg();
    const cmp = await r.execute("sim.compare", { seed: 7, scenarios: [{ name: "as is", hours: 5, realizations: 4 }, { name: "one more I", hours: 5, realizations: 4, marking: { I: 2 } }] });
    assert(cmp !== null);
    assert(r.artifacts().some((a: any) => a.data.kind === "timeseries" && a.data.series.some((s: any) => s.group === "one more I")));
    await r.execute("sim.crosscheck", { t_end: 5, runs: 4, seed: 1 });
    const eq = await r.execute("sim.equilibrium", { t_max: 500 });
    assert(eq !== null);
});

// ---- the browser-safe rest of the registry ----

// Registry with JS artifact ids from a1000 up, so any engine id (a1, a2, …)
// that leaks into a result is recognisable.
const reg2 = (net: any = sir()): any => new Registry(createHeadlessHost(net), undefined, { store: { items: [], next: 1000 } });
function leaks(o: unknown, path = ""): string[] {
    if (typeof o === "string") return /^a\d{1,3}$/.test(o) ? [`${path}=${o}`] : [];
    if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => leaks(v, `${path}.${k}`));
    return [];
}
const mut = (): any => { const n = sir(); for (const t of Object.values(n.transitions) as any[]) t.rate = 0.1; return n; };

Deno.test("native: sim.run loads the marking it ended on, like sim.fire", async () => {
    const r = reg2(mut());
    const out = await r.execute("sim.run", { steps: 5, seed: 3 });
    assertEquals(out.fired, ["recover"]);
    assertEquals((await r.execute("sim.marking")).marking, { S: [9], I: [0], R: [1] });
    await r.execute("sim.reset");
    assertEquals((await r.execute("sim.marking")).marking, { S: [9], I: [1], R: [0] });
});

Deno.test("native: export.svg returns {svg}", async () => {
    const out = await reg2().execute("export.svg");
    assert(out.svg.startsWith("<svg"));
});

Deno.test("native: data.* chain through registry artifacts, and no engine id leaks", async () => {
    const r = reg2(mut());
    const gen = await r.execute("data.generate", { cases: 6, seed: 2, max_steps: 20 });
    assertEquals(gen.artifact, "a1000");
    assertEquals(gen.export.args.id, "a1000"); // the engine's own pointer is rewritten too
    const info = await r.execute("data.log_info", { log: gen.artifact });
    assertEquals(info.cases, 6);
    const conf = await r.execute("data.conformance", { log: gen.artifact });
    assert(conf.fitness > 0);
    const rep = await r.execute("data.replay", { log: gen.artifact });
    assert(rep.events === 24 || rep.events > 0);
    const cal = await r.execute("data.calibrate", { log: gen.artifact });
    assertEquals(Object.keys(cal.learned_rates).sort(), ["infect", "recover"]);
    for (const out of [gen, info, conf, rep, cal]) assertEquals(leaks(out), []);
    // a log typed in
    const csv = "case_id,activity,timestamp\nc1,infect,2026-01-01T00:00:00Z\nc1,recover,2026-01-01T01:00:00Z\n";
    const lg = await r.execute("data.load_log", { text: csv });
    assertEquals((await r.execute("data.log_info", { log: lg.artifact })).events, 2);
    // an artifact that is not there is a CommandError naming the ones that are
    await assertRejects(() => r.execute("data.log_info", { log: "a7" }), CommandError, "no artifact");
});

Deno.test("native: data.calibrate with apply sets the learned rates as one undo step; data.discover replaces the net", async () => {
    const r = reg2(mut());
    const gen = await r.execute("data.generate", { cases: 8, seed: 3, max_steps: 30 });
    const before = r.host.getModel().transitions.infect.rate;
    await r.execute("data.calibrate", { log: gen.artifact });
    assertEquals(r.host.getModel().transitions.infect.rate, before); // not applied
    await r.execute("data.calibrate", { log: gen.artifact, apply: true });
    assert(r.host.getModel().transitions.infect.rate !== before);
    r.host.undo();
    assertEquals(r.host.getModel().transitions.infect.rate, before);
    const found = await r.execute("data.discover", { log: gen.artifact });
    assertEquals(leaks(found), []);
    assert(Object.keys(r.host.getModel().places).length === found.places);
    assert(!("S" in r.host.getModel().places));
    r.host.undo();
    assert("S" in r.host.getModel().places);
});

Deno.test("native: opt.fit reads a registry timeseries and recovers a rate; apply commits it", async () => {
    const net: any = sir();
    net.transitions.infect.rate = 0.08; net.transitions.recover.rate = 0.2;
    const r = reg2(net);
    const ode = await r.execute("sim.ode", { t_end: 20, points: 21 });
    r.host.commit({ ...r.host.getModel(), transitions: { ...r.host.getModel().transitions, infect: { ...r.host.getModel().transitions.infect, rate: 0.03 } } });
    const fit = await r.execute("opt.fit", { data: ode.artifact, parameters: ["infect"], max_iters: 200 });
    assertEquals(leaks(fit), []);
    assert(Math.abs(fit.fitted_rates.infect - 0.08) < 5e-3, JSON.stringify(fit.fitted_rates));
    assertEquals(r.host.getModel().transitions.infect.rate, 0.03); // not applied
    await r.execute("opt.fit", { data: ode.artifact, parameters: ["infect"], max_iters: 200, apply: true });
    assert(Math.abs(r.host.getModel().transitions.infect.rate - 0.08) < 5e-3);
});

Deno.test("native: provenance.check_witness checks a trace artifact from analysis.reach, and a bad trace", async () => {
    const r = reg2();
    const reach = await r.execute("analysis.reach", { to: { R: 10 } });
    const ok = await r.execute("provenance.check_witness", { artifact: reach.trace });
    assertEquals(ok.verdict, "valid");
    assertEquals(leaks(ok), []);
    const bad = await r.execute("provenance.check_witness", { trace: ["recover", "recover"] });
    assertEquals(bad.verdict, "invalid");
});

Deno.test("native: file.open_example replaces the document, file.seal sets @id, net.layout and net.set_colors edit", async () => {
    const r = reg2();
    assert((await r.execute("file.examples")).includes("tic-tac-toe"));
    const made = await r.execute("file.open_example", { name: "tic-tac-toe" });
    assertEquals(made.places, 31);
    const m = r.host.getModel();
    assertEquals(Object.keys(m.places).length, 31);
    assert(!("S" in m.places)); // replaced, not merged
    const sealed = await r.execute("file.seal");
    assertEquals(r.host.getModel()["@id"], sealed.cid);
    const before = JSON.stringify(Object.values(r.host.getModel().places).map((p: any) => [p.x, p.y]));
    await r.execute("net.layout", { algorithm: "circular" });
    assert(JSON.stringify(Object.values(r.host.getModel().places).map((p: any) => [p.x, p.y])) !== before);
    r.host.undo(); // one undo step
    assertEquals(JSON.stringify(Object.values(r.host.getModel().places).map((p: any) => [p.x, p.y])), before);
    await r.execute("net.set_colors", { token: ["red", "blue"] });
    assertEquals(r.host.getModel().token, ["https://pflow.xyz/tokens/red", "https://pflow.xyz/tokens/blue"]);
    await r.execute("net.set_colors", { token: [] });
    assertEquals(r.host.getModel().token, ["https://pflow.xyz/tokens/black"]);
    await assertRejects(() => r.execute("file.open_example", { name: "nope" }), CommandError, "no example");
});

Deno.test("native: an edit keeps the editor's name, description and goals (net.layout), a replace does not", async () => {
    const net: any = sir();
    net.name = "My SIR"; net.description = "kept";
    const r = reg2(net);
    await r.execute("net.layout", { algorithm: "grid" });
    assertEquals(r.host.getModel().name, "My SIR");
    assertEquals(r.host.getModel().description, "kept");
    await r.execute("file.open_example", { name: "sir" });
    assert(r.host.getModel().name !== "My SIR");
});

Deno.test("native: sim.evaluate and opt.distill need a game and say so; on tic-tac-toe they rank moves", async () => {
    const r = reg2();
    await assertRejects(() => r.execute("sim.evaluate"), CommandError, "objective");
    await assertRejects(() => r.execute("opt.distill"), CommandError, "turn-based game");
    await r.execute("file.open_example", { name: "tic-tac-toe" });
    const ev = await r.execute("sim.evaluate", { player: "x", depth: 6, rollouts: 5 });
    assertEquals(ev.moves.length, 9);
    assertEquals(leaks(ev), []);
    const di = await r.execute("opt.distill", { games: 3, positions: 4, iters: 3, realizations: 3 });
    assert(di.multipliers.moves > 0);
});

Deno.test("native: provenance.verify_receipt verifies a receipt, and refuses a non-receipt", async () => {
    const { engine } = await loadEngine();
    const r = reg2();
    engine.load(JSON.stringify(JSON.parse(JSON.stringify(r.host.getModel()))));
    const made = JSON.parse(engine.execute("sim.receipt", JSON.stringify({ scenario: { hours: 4, realizations: 4, seed: 3 } })));
    const out = await r.execute("provenance.verify_receipt", { receipt: made });
    assertEquals(out.verdict, "valid");
    assertEquals(out.signatureValid, true);
    await assertRejects(() => r.execute("provenance.verify_receipt", { receipt: {} }), CommandError, "not a receipt");
});

Deno.test("native: the chat's tool manifest has the new commands, and not export.svg", async () => {
    const manifest = JSON.parse(await Deno.readTextFile(new URL("./llm-tools.json", import.meta.url)));
    const names = new Set(manifest.tools.map((t: any) => t.command));
    for (const id of ["sim.run", "opt.fit", "data.generate", "net.layout", "file.open_example"]) assert(names.has(id), id);
    assert(!names.has("export.svg"));
});
