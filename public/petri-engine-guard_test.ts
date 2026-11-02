import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ENGINE_NEEDS, EngineGuard, checkEngine, engineNeeded, modelKey, overrideAllowed, refusalText } from "./petri-engine-guard.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { loadEngine } from "./petri-wasm.js";

const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

// The nets the guard decides on: SIR, three ways.
//   gated  50 tokens and a capacity on I: Rule 1, the hard rule (the live-test net's kind)
//   small  50 tokens, nothing gating: Rule 2, the soft rule
//   large  1000 tokens, nothing gating: the ODE is fine
function sir({ S = 45, I = 5, cap = 0 } = {}) {
    return {
        places: { S: { initial: [S], capacity: [0], x: 0, y: 0 }, I: { initial: [I], capacity: [cap], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
        transitions: { infect: { x: 50, y: 0, rate: 0.01 }, recover: { x: 150, y: 0, rate: 0.1 } },
        arcs: [
            { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
            { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
            { source: "recover", target: "R", weight: [1] },
        ],
    };
}
const gated = () => sir({ cap: 60 });
const small = () => sir();
const large = () => sir({ S: 900, I: 100 });
const reg = (net: any): any => new Registry(createHeadlessHost(net));

/** Count what a registry runs, by command id. */
function counted(r: any) {
    const ran: string[] = [];
    r.onExecute((e: any) => ran.push(e.id));
    return ran;
}

// One call of every guarded command that a net of this shape can run, with
// the arguments that keep it quick. opt.fit needs data: a series from a run.
async function samples(r: any): Promise<Record<string, any>> {
    const series = await r.execute("sim.ode", { t_end: 5 });
    return {
        "sim.ode": { t_end: 5 },
        "sim.sde": { t_end: 5, runs: 2 },
        "opt.rate_scan": { transition: "recover", from: 0.05, to: 0.2, steps: 3, t_end: 5 },
        "opt.sweep": { transition: "recover", place: "R", from: 0.05, to: 0.2, steps: 3, t_end: 5 },
        "analysis.diagnose": { observable: "R", t_end: 5, noise: false },
        "sim.equilibrium": { t_max: 50 },
        "opt.heatmap": { param_x: "infect", param_y: "recover", observable: "R", x_from: 0, x_to: 0.02, y_from: 0.05, y_to: 0.2, steps: 2, t_end: 5 },
        "opt.optimize": { parameters: [{ transition: "infect", min: 0, max: 0.02 }], objectives: [{ place: "R", sense: "max" }], samples: 2, t_end: 5 },
        "opt.fit": { data: series.artifact, parameters: ["recover"], max_iters: 3 },
        "sim.scenario": { scenario: { hours: 5, engine: "ode" } },
        "sim.compare": { scenarios: [{ name: "a", hours: 5, engine: "ode" }] },
    };
}

// ---- the table ----

Deno.test("table: every entry is a registry command, with a valid need and soft rule", () => {
    const ids = new Set(reg(small()).list().map((s: any) => s.id));
    for (const [id, e] of Object.entries(ENGINE_NEEDS) as Array<[string, any]>) {
        assert(ids.has(id), `${id} is not a registry command`);
        assert(["ode", "sde", "ssa"].includes(e.needs), `${id}: needs ${e.needs}`);
        assert(["refuse", "warn"].includes(e.onSoft), `${id}: onSoft ${e.onSoft}`);
    }
    // the audit: what integrates the ODE or the SDE, or ranks and scans on top of it
    for (const id of ["sim.ode", "sim.sde", "analysis.diagnose", "opt.rate_scan", "opt.sweep", "opt.heatmap", "opt.optimize", "opt.fit", "sim.equilibrium"]) {
        assert(engineNeeded(id), `${id} should be guarded`);
    }
    // the SSA reads every net, so nothing that needs only the SSA is in the table
    for (const id of ["sim.ssa", "analysis.diagnose_ssa", "sim.what_if", "sim.evaluate", "opt.distill", "data.generate", "sim.recommend", "net.info", "analysis.verify"]) {
        assertEquals(engineNeeded(id), null, id);
    }
    assert(Object.values(ENGINE_NEEDS).every((e: any) => e.needs !== "ssa"));
});

Deno.test("table: the ranking is refused on a small net, the curves only warn", () => {
    assertEquals(engineNeeded("analysis.diagnose"), { needs: "ode", onSoft: "refuse" });
    assertEquals(engineNeeded("sim.ode"), { needs: "ode", onSoft: "warn" });
    assertEquals(engineNeeded("sim.sde"), { needs: "sde", onSoft: "warn" });
});

Deno.test("table: a scenario needs the ODE only when it asks for engine ode", () => {
    assertEquals(engineNeeded("sim.scenario", { scenario: { hours: 5 } }), null);
    assertEquals(engineNeeded("sim.scenario", { scenario: { engine: "ssa" } }), null);
    assertEquals(engineNeeded("sim.scenario", { scenario: { engine: "ode" } })?.needs, "ode");
    assertEquals(engineNeeded("sim.scenario", { scenario: '{"engine": "ODE"}' })?.needs, "ode"); // a string holding one
    assertEquals(engineNeeded("sim.scenario", { scenario: "not json" }), null);
    assertEquals(engineNeeded("sim.compare", { scenarios: [{ name: "a" }, { name: "b" }] }), null);
    assertEquals(engineNeeded("sim.compare", { scenarios: [{ name: "a" }, { name: "b", engine: "ode" }] })?.needs, "ode");
    assertEquals(engineNeeded("sim.compare", { scenarios: JSON.stringify([{ engine: "ode" }]) })?.needs, "ode");
    assertEquals(engineNeeded("sim.compare", {}), null);
});

// ---- checkEngine (pure) ----

const hardRec = { engine: "ssa", why: "...", gating: ["capacity on I"], tokens: 50 };
const softRec = { engine: "ssa", why: "...", gating: [], tokens: 50 };
const odeRec = { engine: "ode", why: "...", gating: [], tokens: 1000 };

Deno.test("checkEngine hard rule: every ODE and SDE command is refused, naming the rule, that nothing ran, and the engine to use", () => {
    for (const [id, e] of Object.entries(ENGINE_NEEDS) as Array<[string, any]>) {
        const v = checkEngine(id, hardRec);
        assertEquals(v.verdict, "refuse", id);
        assertEquals([v.needs, v.recommended], [e.needs, "ssa"], id);
        assert(v.rule?.includes("docs/engine-selection.md") && v.rule.includes("Rule 1"), `${id}: ${v.rule}`);
        assert(v.message.includes("Nothing ran"), id);
        assert(v.message.includes("capacity on I"), `${id}: names the constraint`);
        assert(v.message.includes("SSA"), `${id}: names the engine to use`);
        assert(v.message.includes("Rule 1"), id);
    }
    // the knob goal's twin is named
    assert(checkEngine("analysis.diagnose", hardRec).message.includes("analysis.diagnose_ssa"));
});

Deno.test("checkEngine hard rule: the override must name the command's own engine, and then it is a warning chip", () => {
    const v = checkEngine("sim.ode", hardRec, { override: "ode" });
    assertEquals(v.verdict, "warn");
    assertEquals(v.message, "ODE on a net with capacity on I; the engine recommends SSA");
    assert(v.overridden);
    // an SDE command is not unlocked by an ODE override, nor an ODE one by an SDE override
    assertEquals(checkEngine("sim.sde", hardRec, { override: "ode" }).verdict, "refuse");
    assertEquals(checkEngine("sim.ode", hardRec, { override: "sde" }).verdict, "refuse");
    assertEquals(checkEngine("sim.ode", hardRec, { override: "ssa" }).verdict, "refuse");
    assertEquals(checkEngine("sim.sde", hardRec, { override: "sde" }).verdict, "warn");
    // never silence: every guarded command comes back as a warn, not an ok
    for (const [id, e] of Object.entries(ENGINE_NEEDS) as Array<[string, any]>) assertEquals(checkEngine(id, hardRec, { override: e.needs }).verdict, "warn", id);
});

Deno.test("checkEngine soft rule: sim.ode warns, analysis.diagnose is refused, and an override turns the refusal into a warning", () => {
    const warn = checkEngine("sim.ode", softRec);
    assertEquals(warn.verdict, "warn");
    assert(warn.message.startsWith("ODE on a net where the engine recommends SSA"), warn.message);
    assert(warn.rule?.includes("Rule 2"));
    assertFalse(warn.overridden);

    const refuse = checkEngine("analysis.diagnose", softRec);
    assertEquals(refuse.verdict, "refuse");
    assert(refuse.rule?.includes("Rule 2") && refuse.message.includes("Rule 2") && refuse.message.includes("Nothing ran"));
    assert(refuse.message.includes("50 tokens") && refuse.message.includes("analysis.diagnose_ssa"), refuse.message);

    const over = checkEngine("analysis.diagnose", softRec, { override: "ode" });
    assertEquals(over.verdict, "warn");
    assert(over.message.startsWith("ODE on a net where the engine recommends SSA"));
    assert(over.overridden);

    // every command that only warns on the soft rule does
    for (const [id, e] of Object.entries(ENGINE_NEEDS) as Array<[string, any]>) assertEquals(checkEngine(id, softRec).verdict, e.onSoft === "refuse" ? "refuse" : "warn", id);
});

Deno.test("checkEngine: a recommendation of ode, an unguarded command or nothing to check against is ok", () => {
    for (const id of Object.keys(ENGINE_NEEDS)) assertEquals(checkEngine(id, odeRec).verdict, "ok", id);
    for (const id of ["sim.ssa", "net.info", "analysis.diagnose_ssa", "no.such"]) {
        assertEquals(checkEngine(id, hardRec).verdict, "ok", id);
        assertEquals(checkEngine(id, hardRec).needs, null);
    }
    assertEquals(checkEngine("sim.ode", undefined).verdict, "ok");
    assertEquals(checkEngine("sim.ode", null).verdict, "ok");
    // a scenario that does not ask for the ODE is not held to the rule
    assertEquals(checkEngine("sim.scenario", hardRec, { args: { scenario: { hours: 5 } } }).verdict, "ok");
    assertEquals(checkEngine("sim.scenario", hardRec, { args: { scenario: { engine: "ode" } } }).verdict, "refuse");
});

Deno.test("table: it cannot be edited at run time (a guard that a call can switch off is not one)", () => {
    assert(Object.isFrozen(ENGINE_NEEDS));
    let threw = false;
    try { (ENGINE_NEEDS as any)["sim.ode"] = { needs: "ssa", onSoft: "warn" }; } catch { threw = true; }
    assert(threw || engineNeeded("sim.ode")?.needs === "ode");
    assertEquals(engineNeeded("sim.ode")?.needs, "ode");
});

Deno.test("refusalText: tells the model why, that nothing ran, and which door is open", () => {
    const v = checkEngine("sim.ode", hardRec);
    const final = refusalText(v);
    assert(final.startsWith("refused: "));
    assert(final.includes(v.message) && final.includes("no override") && final.includes("classic dialogs") && final.includes("do not retry"));
    assertFalse(final.includes("engine_override"));
    const open = refusalText(v, { canOverride: true });
    assert(open.includes('engine_override: "ode"') && open.includes("names the engine"));
});

// ---- the person's words ----

Deno.test("overrideAllowed: only the person's own words naming the engine count", () => {
    for (const t of ["use the ODE", "run the ode anyway", "I want the mean-field answer", "please use the mean field model", "solve the differential equations", "an ODE please", "ODEs are fine here", "try the rate equations"]) {
        assert(overrideAllowed(t, "ode"), t);
    }
    for (const t of ["", "run it", "yes", "which knob matters?", "what is the mode of the queue", "use the code", "stochastic differential equation", "use the SSA"]) {
        assertFalse(overrideAllowed(t, "ode"), t);
    }
    for (const t of ["use the SDE", "a Langevin model please", "the stochastic differential equation"]) assert(overrideAllowed(t, "sde"), t);
    for (const t of ["use the ODE", "run it", "ssde"]) assertFalse(overrideAllowed(t, "sde"), t);
    for (const t of ["use the SSA", "Gillespie please", "a stochastic simulation"]) assert(overrideAllowed(t, "ssa"), t);
    // wrong inputs
    assertFalse(overrideAllowed(undefined as any, "ode"));
    assertFalse(overrideAllowed("use the ODE", "ode2"));
    assertFalse(overrideAllowed("use the ODE", undefined as any));
});

Deno.test("overrideAllowed: a negated mention is not a request", () => {
    for (const t of ["don't use the ODE", "do not use the ODE", "not the ODE, the SSA", "use the SSA instead of the ODE", "I'd rather not run the ODE", "without the ODE", "never the ode", "no need for the ODE"]) {
        assertFalse(overrideAllowed(t, "ode"), t);
    }
    assert(overrideAllowed("use the SSA instead of the ODE", "ssa"));
    // the negation is local: another sentence's "not" does not cancel the request
    assert(overrideAllowed("I am not sure what that does. Use the ODE.", "ode"));
    assert(overrideAllowed("Not the SSA; use the ODE", "ode"));
});

// ---- the guard, on real nets ----

Deno.test("guard: sim.recommend runs once per net revision however many guarded calls follow, and again after an edit", async () => {
    const r = reg(gated());
    const ran = counted(r);
    const g = new EngineGuard(r);
    const recs = () => ran.filter((id) => id === "sim.recommend").length;
    assertEquals(recs(), 0, "nothing runs until a guarded command asks");
    for (let i = 0; i < 4; i++) assertEquals((await g.check("sim.ode", {})).verdict, "refuse");
    await g.check("analysis.diagnose", {});
    await g.check("opt.rate_scan", {});
    assertEquals(recs(), 1);
    // a second guard over the same registry has its own cache; one guard does not re-ask
    assertEquals((await g.recommendation()).engine, "ssa");
    assertEquals(recs(), 1);
    // an edit that lifts the capacity changes the net: ask again, and the answer changes
    await r.execute("net.set_place", { id: "I", capacity: 0 });
    assertEquals((await g.check("sim.ode", {})).verdict, "warn", "50 tokens, nothing gating: the soft rule");
    assertEquals(recs(), 2);
    await g.check("sim.ode", {});
    await g.check("analysis.diagnose", {});
    assertEquals(recs(), 2);
    // more tokens: large and unconstrained, the ODE is fine
    await r.execute("net.add_tokens", { id: "S", delta: 900 });
    assertEquals((await g.check("sim.ode", {})).verdict, "ok");
    assertEquals(recs(), 3);
    // a command that leaves the net as it was (nothing to reset) is not a new revision
    await r.execute("sim.reset");
    await g.check("sim.ode", {});
    assertEquals(recs(), 3);
});

Deno.test("guard: unguarded commands never trigger a recommend call", async () => {
    const r = reg(gated());
    const ran = counted(r);
    const g = new EngineGuard(r);
    for (const id of ["net.info", "sim.ssa", "analysis.diagnose_ssa", "sim.what_if", "analysis.verify", "sim.recommend", "no.such.command"]) {
        const v = await g.check(id, {});
        assertEquals(v.verdict, "ok", id);
    }
    // a scenario that does not name the ODE is unguarded too
    assertEquals((await g.check("sim.scenario", { scenario: { hours: 5 } })).verdict, "ok");
    assertEquals(ran, []);
});

Deno.test("guard: a function can stand for the registry (the chat's sandbox is replaced between calls)", async () => {
    let current = reg(gated());
    const g = new EngineGuard(() => current);
    assertEquals((await g.check("sim.ode", {})).verdict, "refuse");
    current = reg(large());
    assertEquals((await g.check("sim.ode", {})).verdict, "ok", "another net, another key");
});

Deno.test("guard: a recommend that fails is the call's error, not a silent pass; the failure is not cached", async () => {
    const r = reg(gated());
    let boom = true;
    const real = r.execute.bind(r);
    r.execute = (id: string, a: any) => (id === "sim.recommend" && boom ? Promise.reject(new Error("recommend down")) : real(id, a));
    const g = new EngineGuard(r);
    let msg = "";
    try { await g.check("sim.ode", {}); } catch (e) { msg = (e as Error).message; }
    assertEquals(msg, "recommend down");
    boom = false;
    assertEquals((await g.check("sim.ode", {})).verdict, "refuse");
});

Deno.test("guard: prime() takes a recommendation a plan ran itself, for this revision only", async () => {
    const r = reg(gated());
    const ran = counted(r);
    const g = new EngineGuard(r);
    g.prime(await r.execute("sim.recommend"));
    assertEquals((await g.check("sim.ode", {})).verdict, "refuse");
    assertEquals(ran.filter((id) => id === "sim.recommend").length, 1);
    await r.execute("net.set_place", { id: "I", capacity: 0 });
    await g.check("sim.ode", {});
    assertEquals(ran.filter((id) => id === "sim.recommend").length, 2);
    g.prime({ nonsense: true }); // not a recommendation: ignored
    g.prime(null);
});

Deno.test("guard: the override is honoured only when the person's own words name the engine, and then it is a warning", async () => {
    const r = reg(gated());
    const g = new EngineGuard(r);
    const ok = await g.check("sim.ode", {}, { override: "ode", userText: "please use the ODE for this" });
    assertEquals(ok.verdict, "warn");
    assert(ok.message.includes("the engine recommends SSA") && ok.overridden);
    // the model passes engine_override, the person never named it: refused, and it says why
    for (const userText of ["run the simulation", "", undefined]) {
        const no = await g.check("sim.ode", {}, { override: "ode", userText: userText as any });
        assertEquals(no.verdict, "refuse", String(userText));
        assertEquals(no.overrideIgnored, "ode");
        assert(no.message.includes("was not applied") && no.message.includes("Nothing ran"));
    }
    // no override passed: nothing to ignore
    assertEquals((await g.check("sim.ode", {}, { userText: "use the ODE" })).verdict, "refuse", "naming the engine is not passing the override");
    assertEquals((await g.check("sim.ode", {}, { userText: "use the ODE" })).overrideIgnored, undefined);
    // a negated mention does not unlock it
    assertEquals((await g.check("sim.ode", {}, { override: "ode", userText: "do not use the ODE" })).verdict, "refuse");
    // the override names the engine of the command: an SDE request does not unlock the ODE
    assertEquals((await g.check("sim.ode", {}, { override: "sde", userText: "use the SDE" })).verdict, "refuse");
    // case is not significant
    assertEquals((await g.check("sim.ode", {}, { override: "ODE", userText: "use the ode" })).verdict, "warn");
});

Deno.test("guard: modelKey changes with any edit and not otherwise", async () => {
    const r = reg(small());
    const k0 = modelKey(r.host.getModel());
    assertEquals(modelKey(r.host.getModel()), k0);
    assertEquals(modelKey(structuredClone(r.host.getModel())), k0);
    await r.execute("sim.set_rate", { id: "infect", rate: 0.02 });
    const k1 = modelKey(r.host.getModel());
    assert(k1 !== k0);
    await r.execute("net.add_tokens", { id: "S", delta: 1 });
    assert(modelKey(r.host.getModel()) !== k1);
});

// ---- a test per guarded command: refused on the gated net, runs on a large one ----

Deno.test("each guarded command: refused on the SIR-with-capacity net, nothing runs; warned or refused on the small one; runs on the large one", async () => {
    const pre = await samples(reg(large())); // the arguments only need the net's ids
    const ids = Object.keys(ENGINE_NEEDS);
    assertEquals(Object.keys(pre).sort(), [...ids].sort(), "an example call for every entry");

    // gated: refused for all, and the engine never sees the call
    {
        const r = reg(gated());
        const args = await samples(reg(large()));
        const ran = counted(r);
        const g = new EngineGuard(r);
        for (const id of ids) {
            const v = await g.check(id, args[id]);
            assertEquals(v.verdict, "refuse", id);
            assert(v.message.includes("Nothing ran"), id);
        }
        assertEquals(ran, ["sim.recommend"], "only the recommendation ran");
    }
    // small: 50 tokens and nothing gating, the soft rule per command
    {
        const r = reg(small());
        const args = await samples(reg(large()));
        const g = new EngineGuard(r);
        for (const [id, e] of Object.entries(ENGINE_NEEDS) as Array<[string, any]>) {
            assertEquals((await g.check(id, args[id])).verdict, e.onSoft === "refuse" ? "refuse" : "warn", id);
        }
    }
    // large: the guard lets each through, and each really runs
    {
        const r = reg(large());
        const args = await samples(r);
        const g = new EngineGuard(r);
        for (const id of ids) {
            assertEquals((await g.check(id, args[id])).verdict, "ok", id);
            const out = await r.execute(id, args[id]);
            assert(out && typeof out === "object", id);
        }
    }
});

Deno.test("each guarded command: with the person's override on the gated net it runs and carries the chip", async () => {
    const r = reg(gated());
    const g = new EngineGuard(r);
    const args = await samples(reg(large()));
    for (const [id, e] of Object.entries(ENGINE_NEEDS) as Array<[string, any]>) {
        const v = await g.check(id, args[id], { override: e.needs, userText: `use the ${e.needs.toUpperCase()}` });
        assertEquals(v.verdict, "warn", id);
        assert(v.message.includes("the engine recommends SSA"), id);
    }
});
