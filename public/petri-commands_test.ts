import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { COMMANDS, CommandError, Registry, createHeadlessHost, exportArtifact } from "./petri-commands.js";
import * as solver from "./petri-solver.js";

// The JSDoc types are loose (Object); tests read the host and specs as any.
const reg = (model?: any): any => new Registry(createHeadlessHost(model));

// The phase-0 exit criterion: the editor's work driven headless through the
// registry alone — load, edit, run the ODE, export.
Deno.test("registry: load, edit, run the ODE and export, headless", async () => {
    const r = reg();
    await r.execute("file.load_json", {
        json: {
            "@context": "https://pflow.xyz/schema", "@type": "PetriNet", token: ["https://pflow.xyz/tokens/black"],
            places: { S: { initial: [99], capacity: [0], x: 0, y: 0 }, I: { initial: [1], capacity: [0], x: 100, y: 0 } },
            transitions: { infect: { x: 50, y: 0 } },
            arcs: [
                { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
                { source: "infect", target: "I", weight: [2] },
            ],
        },
    });
    const { id: R } = await r.execute("net.add_place", { x: 200, y: 0, id: "R", label: "Recovered" });
    await r.execute("net.add_transition", { x: 150, y: 0, id: "recover" });
    await r.execute("net.add_arc", { source: "I", target: "recover" });
    await r.execute("net.add_arc", { source: "recover", target: R });
    await r.execute("sim.set_rate", { id: "infect", rate: 0.01 });
    await r.execute("sim.set_rate", { id: "recover", rate: 0.1 });

    const run = await r.execute("sim.ode", { t_end: 50 });
    assert(run.artifact);
    const total = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    assertEquals(Math.round(total(run.final)), 100); // S + I + R is conserved
    assert(run.final.R > 50);

    const csv = await r.execute("export.artifact", { id: run.artifact });
    assert(csv.content.startsWith("time,S,I,R\n"));
    assert(csv.filename.endsWith(".csv"));

    const json = await r.execute("file.export_json");
    assertEquals(json.json.transitions.infect.rate, 0.01);
    assertEquals(json.json.places.R.capacity, [null]); // unbounded, as saved
    assertEquals(r.journal.map((s: any) => s.command), [
        "file.load_json", "net.add_place", "net.add_transition", "net.add_arc", "net.add_arc",
        "sim.set_rate", "sim.set_rate", "sim.ode",
    ]); // queries (export.*) are not journalled
});

Deno.test("registry: sim.ode matches a direct petri-solver run", async () => {
    const net = {
        places: { a: { initial: [10], capacity: [0], x: 0, y: 0 }, b: { initial: [0], capacity: [0], x: 0, y: 0 } },
        transitions: { t: { x: 0, y: 0, rate: 0.3 } },
        arcs: [{ source: "a", target: "t", weight: [1] }, { source: "t", target: "b", weight: [1] }],
    };
    const r = reg(net);
    const out = await r.execute("sim.ode", { t_end: 5 });
    const pn = solver.fromJSON(r.host.getModel());
    const sol = solver.solve(new solver.ODEProblem(pn, solver.setState(pn), [0, 5], solver.setRates(pn, { t: 0.3 })), solver.Tsit5(),
        { dt: 0.01, abstol: 1e-6, reltol: 1e-3, adaptive: true });
    assertEquals(out.final, sol.getFinalState());
});

Deno.test("registry: arguments are checked against the schema, by name", async () => {
    const r = reg();
    await assertRejects(() => r.execute("net.add_place", { x: 1 }), CommandError, 'missing argument "y"');
    await assertRejects(() => r.execute("net.add_place", { x: 1, y: 2, colour: 3 }), CommandError, 'unknown argument "colour"');
    await assertRejects(() => r.execute("net.add_place", { x: "1", y: 2 }), CommandError, "expected number");
    await assertRejects(() => r.execute("sim.ode", { method: "rk4" }), CommandError, "only tsit5");
    await assertRejects(() => r.execute("net.add", {}), CommandError, "unknown command");
});

Deno.test("registry: a refused edit leaves the document and history untouched", async () => {
    const r = reg();
    await r.execute("net.add_place", { x: 0, y: 0, capacity: 2 });
    const before = JSON.stringify(r.host.getModel());
    await assertRejects(() => r.execute("net.set_place", { id: "p0", initial: 3 }), CommandError, "exceed capacity");
    await assertRejects(() => r.execute("net.add_arc", { source: "p0", target: "p0" }), CommandError, "both places");
    assertEquals(JSON.stringify(r.host.getModel()), before);
    await r.execute("edit.undo");
    assertEquals(Object.keys(r.host.getModel().places), []); // one undo step back to empty
});

Deno.test("registry: the token game", async () => {
    const r = reg({
        places: { a: { initial: [1], capacity: [0], x: 0, y: 0 }, b: { initial: [0], capacity: [0], x: 0, y: 0 } },
        transitions: { t: { x: 0, y: 0 } },
        arcs: [{ source: "a", target: "t", weight: [1] }, { source: "t", target: "b", weight: [1] }],
    });
    assertEquals((await r.execute("sim.enabled")).enabled, ["t"]);
    const fired = await r.execute("sim.fire", { id: "t" });
    assertEquals(fired.marking, { a: [0], b: [1] });
    await assertRejects(() => r.execute("sim.fire", { id: "t" }), CommandError, "not enabled");
    await r.execute("sim.reset");
    assertEquals((await r.execute("sim.marking")).marking, { a: [1], b: [0] });
});

Deno.test("registry: rename keeps arcs and order; delete removes touching arcs", async () => {
    const r = reg({
        places: { a: { initial: [0], capacity: [0], x: 0, y: 0 }, b: { initial: [0], capacity: [0], x: 0, y: 0 } },
        transitions: { t: { x: 0, y: 0 } },
        arcs: [{ source: "a", target: "t", weight: [1] }, { source: "t", target: "b", weight: [1] }],
    });
    await r.execute("net.rename", { id: "a", new_id: "queue" });
    assertEquals(Object.keys(r.host.getModel().places), ["queue", "b"]);
    assertEquals(r.host.getModel().arcs[0].source, "queue");
    await assertRejects(() => r.execute("net.rename", { id: "b", new_id: "t" }), CommandError, "already used");
    await r.execute("edit.delete", { ids: ["t"] });
    assertEquals(r.host.getModel().arcs, []);
});

Deno.test("registry: file.load_json refuses a net the check rejects, unless repair", async () => {
    const r = reg();
    const bad = { places: { p: { initial: [5], capacity: [2], x: 0, y: 0 } }, transitions: {}, arcs: [] };
    await assertRejects(() => r.execute("file.load_json", { json: bad }), CommandError, "exceeds capacity");
    const out = await r.execute("file.load_json", { json: bad, repair: true });
    assertEquals(out.errors.length, 1);
    assertEquals(r.host.getModel().places.p.initial, [2]); // clamped, as the editor always has
});

Deno.test("registry: rate scan and sweep store time-series artifacts", async () => {
    const r = reg({
        places: { a: { initial: [10], capacity: [0], x: 0, y: 0 }, b: { initial: [0], capacity: [0], x: 0, y: 0 } },
        transitions: { t: { x: 0, y: 0 } },
        arcs: [{ source: "a", target: "t", weight: [1] }, { source: "t", target: "b", weight: [1] }],
    });
    const scan = await r.execute("opt.rate_scan", { transition: "t", from: 0, to: 1, steps: 3, t_end: 5 });
    const s = (await r.execute("artifact.get", { id: scan.artifact })).artifact;
    assertEquals(s.data.x, [0, 0.5, 1]);
    assertEquals(s.data.series.map((x: any) => x.name), ["a", "b"]);
    assertEquals(s.data.series[0].values[0], 10); // rate 0: nothing moves

    const sweep = await r.execute("opt.sweep", { transition: "t", place: "b", from: 0.1, to: 0.3, steps: 2, points: 11 });
    const w = (await r.execute("artifact.get", { id: sweep.artifact })).artifact;
    assertEquals(w.data.x.length, 11);
    assertEquals(w.data.series.map((x: any) => x.group), ["k=0.1", "k=0.3"]);
    assert(exportArtifact(w).content.startsWith("time,b (k=0.1),b (k=0.3)\n"));
    assertEquals((await r.execute("artifact.list")).artifacts.map((a: any) => a.kind), ["timeseries", "timeseries"]);
});

Deno.test("registry: analysis.check stores a report and exports it as CSV", async () => {
    const r = reg({ places: { p: { initial: [0], capacity: [0], x: 0, y: 0 } }, transitions: {}, arcs: [] });
    const out = await r.execute("analysis.check");
    assert(out.ok);
    assert(out.cid.startsWith("z"));
    assertEquals(out.warnings.map((w: any) => w.path), ["places.p"]);
    const csv = await r.execute("export.artifact", { id: out.artifact });
    assert(csv.content.startsWith("severity,path,message\nwarning,places.p,"));
});

Deno.test("registry: a command that needs a view is listed as unavailable headless", async () => {
    const r = reg();
    assertEquals(r.describe("view.fit").available, false);
    await assertRejects(() => r.execute("view.fit"), CommandError, "needs a host with a view");
});

Deno.test("registry: every spec is well formed and its id is pflow-native's form", () => {
    const ids = new Set();
    for (const s of COMMANDS as any[]) {
        assert(/^[a-z]+\.[a-z_]+$/.test(s.id), s.id);
        assert(!ids.has(s.id), `duplicate ${s.id}`);
        ids.add(s.id);
        assertEquals(s.args.type, "object", s.id);
        assertEquals(s.args.additionalProperties, false, s.id);
        for (const k of s.args.required) assert(k in s.args.properties, `${s.id}: required ${k} undeclared`);
        assert(s.help.length > 10, s.id);
    }
});

Deno.test("registry: listeners see every call, success or failure", async () => {
    const r = reg();
    const seen: any[] = [];
    r.onExecute((e: any) => seen.push([e.id, e.ok]));
    await r.execute("net.add_place", { x: 0, y: 0 });
    await r.execute("sim.fire", { id: "nope" }).catch(() => {});
    assertEquals(seen, [["net.add_place", true], ["sim.fire", false]]);
});

Deno.test("registry: sim.ssa is seeded and banded; sim.sde refuses a gated net; sim.recommend explains", async () => {
    const net = {
        places: { S: { initial: [9], capacity: [0], x: 0, y: 0 }, I: { initial: [1], capacity: [0], x: 0, y: 0 } },
        transitions: { infect: { x: 0, y: 0, rate: 0.5 } },
        arcs: [{ source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] }, { source: "infect", target: "I", weight: [2] }],
    };
    const r = reg(net);
    const a = await r.execute("sim.ssa", { t_end: 5, runs: 4, seed: 3, points: 6 });
    const b = await r.execute("sim.ssa", { t_end: 5, runs: 4, seed: 3, points: 6 });
    assertEquals(a.final, b.final); // same seed, same answer
    const art = r.artifact(a.artifact);
    assertEquals(art.data.x.length, 6);
    assert(Array.isArray(art.data.series[0].band));
    assertEquals(art.meta.engine, "ssa");
    const rec = await r.execute("sim.recommend");
    assertEquals(rec.engine, "ssa"); // 10 tokens: small counts
    assert(/small/.test(rec.why));

    // I grows, so its capacity is reachable: a post-firing bound the SDE cannot express.
    const gated = reg({ ...net, places: { ...net.places, I: { initial: [1], capacity: [5], x: 0, y: 0 } } });
    await assertRejects(() => gated.execute("sim.sde", { t_end: 1 }), CommandError, "capacity");
    assert((await gated.execute("sim.recommend")).gating.length === 1);
});
