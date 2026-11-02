import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ENGINE_NEEDS, EngineGuard, checkEngine, engineNeeded, isEdit, modelKey, needsGuard, overrideAllowed, refusalText } from "./petri-engine-guard.js";
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
    // the knob goal's twin is named; a command with no SSA twin just says which engine
    assert(checkEngine("analysis.diagnose", hardRec).message.includes("Use analysis.diagnose_ssa."));
    assert(checkEngine("opt.fit", hardRec).message.endsWith("The engine recommends the SSA."));
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

// ---- macro.play: the engine runs stored command steps by itself, so the guard reads them first ----
//
// The review finding: macro.define + macro.play ran analysis.diagnose on the
// SIR-with-capacity net inside the native engine, past the guard (it logged
// only macro.define and macro.play, and the verdict was ok with needs null).

/** Define a macro, run fn, and forget it (macros are session state of the shared engine). */
async function withMacros(r: any, defs: Record<string, any[]>, fn: () => Promise<void>) {
    for (const [name, steps] of Object.entries(defs)) await r.execute("macro.define", { name, steps });
    try { await fn(); } finally { for (const name of Object.keys(defs)) await r.execute("macro.delete", { name }).catch(() => {}); }
}
const diag = { command: "analysis.diagnose", args: { observable: "R", t_end: 5, noise: false } };
const ode = { command: "sim.ode", args: { t_end: 5 } };
const ssa = { command: "sim.ssa", args: { t_end: 5, runs: 2 } };
// A macro's steps are the engine's own commands (macro.define refuses a JS-only id such as analysis.diagnose_ssa).
/** Did the engine really run the one step (a curve stores an artifact, a ranking returns its knobs)? */
const ranOnce = (out: any) => out?.results?.length === 1 && !!(out.results[0].artifact || out.results[0].knobs);

Deno.test("macro.play: the audit says it is checked through its steps, not listed in the table", () => {
    assert(needsGuard("macro.play", { name: "m" }));
    assert(needsGuard("macro.play"));
    assert(needsGuard("sim.ode") && needsGuard("sim.scenario", { scenario: { engine: "ode" } }));
    assertFalse(needsGuard("sim.ssa") || needsGuard("net.info") || needsGuard("sim.scenario", { scenario: { hours: 5 } }));
    assertEquals(engineNeeded("macro.play"), null, "it needs no single engine; its steps do");
    assert(isEdit("macro.play", {}) && isEdit("net.add_arc", {}) && !isEdit("sim.ode", {}));
});

Deno.test("macro.play: a stored analysis.diagnose is refused on the gated net, with nothing run (the review's repro)", async () => {
    const r = reg(gated());
    await withMacros(r, { m: [diag] }, async () => {
        const ran = counted(r);
        const g = new EngineGuard(r);
        const v = await g.check("macro.play", { name: "m" });
        assertEquals(v.verdict, "refuse");
        assertEquals([v.needs, v.recommended], ["ode", "ssa"]);
        assert(v.rule?.includes("Rule 1"), String(v.rule));
        assert(v.message.includes('macro.play "m"') && v.message.includes('step 1 of macro "m"') && v.message.includes("analysis.diagnose"), v.message);
        assert(v.message.includes("capacity on I") && v.message.includes("Nothing ran") && v.message.includes("analysis.diagnose_ssa"), v.message);
        assertFalse(ran.includes("macro.play") || ran.includes("analysis.diagnose"), `the guard only read: ${ran}`);
        assertEquals(ran, ["macro.get", "sim.recommend"]);
        // the control: the engine itself is not guarded, and it ranks on the ODE (the bug the guard closes)
        const out = await r.execute("macro.play", { name: "m" });
        assert(ranOnce(out) && out.results[0].baseline !== undefined, "the unguarded play ran the ODE ranking");
    });
});

Deno.test("macro.play: a macro with no engine-dependent step is ok, and asks for no recommendation", async () => {
    const r = reg(gated());
    await withMacros(r, { quiet: [ssa, ssa], empty: [] }, async () => {
        const ran = counted(r);
        const g = new EngineGuard(r);
        for (const name of ["quiet", "empty"]) {
            const v = await g.check("macro.play", { name });
            assertEquals(v.verdict, "ok", name);
            assertEquals(v.needs, null);
        }
        assertEquals(ran.filter((id) => id === "sim.recommend").length, 0);
    });
});

Deno.test("macro.play: on a large net the same macro is ok and runs; on the small net the ranking is refused and the curve warns", async () => {
    await withMacros(reg(large()), { rank: [diag], curve: [ode] }, async () => {
        const r = reg(large());
        const g = new EngineGuard(r);
        for (const name of ["rank", "curve"]) {
            assertEquals((await g.check("macro.play", { name })).verdict, "ok", name);
            assert(ranOnce(await r.execute("macro.play", { name })), name);
        }
    });
    const r = reg(small());
    await withMacros(r, { rank: [diag], curve: [ode], both: [ode, diag] }, async () => {
        const g = new EngineGuard(r);
        const curve = await g.check("macro.play", { name: "curve" });
        assertEquals(curve.verdict, "warn");
        assert(curve.message.startsWith('step 1 of macro "curve" (sim.ode): ODE on a net where the engine recommends SSA'), curve.message);
        assert(curve.rule?.includes("Rule 2"));
        const rank = await g.check("macro.play", { name: "rank" });
        assertEquals(rank.verdict, "refuse");
        assert(rank.rule?.includes("Rule 2") && rank.message.includes("analysis.diagnose_ssa"), rank.message);
        // one refused step refuses the whole play, wherever it is
        const both = await g.check("macro.play", { name: "both" });
        assertEquals(both.verdict, "refuse");
        assert(both.message.includes('step 2 of macro "both" (analysis.diagnose)'), both.message);
    });
});

Deno.test("macro.play: every guarded command in a macro is held to the table, as a direct call is", async () => {
    const r = reg(gated());
    const args = await samples(reg(large()));
    const defs: Record<string, any[]> = {};
    for (const id of Object.keys(ENGINE_NEEDS)) defs[`m_${id.replace(".", "_")}`] = [{ command: id, args: args[id] }];
    await withMacros(r, defs, async () => {
        const g = new EngineGuard(r);
        for (const id of Object.keys(ENGINE_NEEDS)) {
            const v = await g.check("macro.play", { name: `m_${id.replace(".", "_")}` });
            assertEquals(v.verdict, "refuse", id);
            assertEquals(v.needs, (ENGINE_NEEDS as any)[id].needs, id);
            assert(v.message.includes(id) && v.message.includes("Nothing ran"), id);
        }
    });
});

Deno.test("macro.play: a nested macro.play is expanded, the default macro is \"last\", and the recommendation is asked once", async () => {
    const r = reg(gated());
    await withMacros(r, { inner: [ssa, diag], outer: [ssa, { command: "macro.play", args: { name: "inner" } }], last: [ode, ode, ode] }, async () => {
        const ran = counted(r);
        const g = new EngineGuard(r);
        const v = await g.check("macro.play", { name: "outer" });
        assertEquals(v.verdict, "refuse");
        assert(v.message.includes('macro.play "outer"') && v.message.includes('step 2 of macro "inner" (analysis.diagnose)'), v.message);
        const d = await g.check("macro.play", {});
        assertEquals(d.verdict, "refuse", "no name: the macro named last");
        assert(d.message.includes('macro.play "last"'), d.message);
        assertEquals(ran.filter((id) => id === "sim.recommend").length, 1);
    });
});

Deno.test("macro.play: a macro the guard cannot read to the end is refused, not trusted unseen", async () => {
    const r = reg(large()); // a net where every engine is fine: only the unreadable macro can be the reason
    const deep: Record<string, any[]> = {};
    for (let i = 0; i < 8; i++) deep[`d${i}`] = [i < 7 ? { command: "macro.play", args: { name: `d${i + 1}` } } : ode];
    const long = Array.from({ length: 201 }, () => ssa);
    await withMacros(r, {
        loop: [{ command: "macro.play", args: { name: "loop" } }],
        a: [{ command: "macro.play", args: { name: "b" } }], b: [{ command: "macro.play", args: { name: "a" } }],
        rewrite: [{ command: "macro.define", args: { name: "late", steps: [ode] } }, { command: "macro.play", args: { name: "late" } }],
        long, ...deep,
    }, async () => {
        const g = new EngineGuard(r);
        const refused = async (name: string, why: string) => {
            const v = await g.check("macro.play", { name });
            assertEquals(v.verdict, "refuse", name);
            assertEquals([v.needs, v.rule], [null, null], name);
            assert(v.message.includes("cannot be checked") && v.message.includes(why) && v.message.includes("Nothing ran"), `${name}: ${v.message}`);
        };
        await refused("loop", "plays itself");
        await refused("a", "a → b → a");
        await refused("d0", "nest more than");
        await refused("long", "more than 200 steps");
        await refused("rewrite", "changes the macro table");
        await refused("nope", 'macro.get "nope" failed');
        // an override would not have changed it, so none is said to have been ignored
        const asked = await g.check("macro.play", { name: "loop" }, { override: "ode", userText: "go on" });
        assertEquals(asked.overrideIgnored, undefined);
        assertFalse(asked.message.includes("engine_override"));
        assertEquals((await g.check("macro.play", { name: "loop" }, { override: "ode", userText: "use the ODE" })).verdict, "refuse", "naming the engine does not make a macro readable");
    });
    // the same macro list on a net where it is fine: a macro that only reads is ok even when it plays another
    await withMacros(r, { one: [ssa], two: [{ command: "macro.play", args: { name: "one" } }, ssa] }, async () => {
        assertEquals((await new EngineGuard(r).check("macro.play", { name: "two" })).verdict, "ok");
    });
});

Deno.test("macro.play: a step that may change the net's gating before a guarded step is refused, because the recommendation is for the net as it is now", async () => {
    // the hole: on a net where the ODE is right, a macro adds an inhibitor arc and then runs sim.ode on a net it has just gated
    const addGate = { command: "net.add_arc", args: { source: "S", target: "recover", inhibit: true } };
    const probe = reg(large());
    await withMacros(probe, { sneaky: [addGate, ode] }, async () => {
        await probe.execute("macro.play", { name: "sneaky" });
        assert((await probe.execute("sim.recommend")).gating.length > 0, "the unguarded play left the net gated and ran the ODE on it");
    });

    const r = reg(large());
    const setRate = { command: "sim.set_rate", args: { id: "recover", rate: 0.2 } };
    await withMacros(r, {
        sneaky: [addGate, ode],
        rank: [{ command: "net.add_tokens", args: { id: "S", delta: -890 } }, diag],
        tame: [setRate, ode],
        label: [{ command: "net.set_label", args: { id: "S", label: "susceptible" } }, { command: "net.move", args: { id: "S", x: 5, y: 5 } }, diag],
        ssaOnly: [addGate, ssa],
        later: [ode, addGate],
        fit: [{ command: "opt.fit", args: { data: "a1", parameters: ["recover"], apply: true } }, ode],
        unknown: [{ command: "edit.select_all", args: {} }, ode], // the engine's own command, one the page's registry does not have
    }, async () => {
        const g = new EngineGuard(r);
        const sneaky = await g.check("macro.play", { name: "sneaky" });
        assertEquals(sneaky.verdict, "refuse");
        assertEquals(sneaky.needs, "ode");
        assert(sneaky.message.includes('step 1 of macro "sneaky" (net.add_arc) can change the net before sim.ode runs'), sneaky.message);
        assert(sneaky.message.includes("one at a time") && sneaky.message.includes("Nothing ran"), sneaky.message);
        // tokens decide Rule 2 as the arcs decide Rule 1
        assertEquals((await g.check("macro.play", { name: "rank" })).verdict, "refuse");
        // a rate, a label or a position cannot change the recommendation, and neither can a fit that writes rates
        for (const name of ["tame", "label", "fit"]) assertEquals((await g.check("macro.play", { name })).verdict, "ok", name);
        // no guarded step after the edit, or only before it: nothing to doubt
        for (const name of ["ssaOnly", "later"]) assertEquals((await g.check("macro.play", { name })).verdict, "ok", name);
        // a command the registry does not know may be an engine-only edit
        const unknown = await g.check("macro.play", { name: "unknown" });
        assertEquals(unknown.verdict, "refuse");
        assert(unknown.message.includes('step 1 of macro "unknown" (edit.select_all) can change the net'), unknown.message);
        // the person naming the engine lifts it, as for any refusal: a chip, not silence
        const asked = await g.check("macro.play", { name: "sneaky" }, { override: "ode", userText: "run the ODE" });
        assertEquals(asked.verdict, "warn");
        assert(asked.message.includes("ODE was asked for") && asked.message.includes("net.add_arc"), asked.message);
        // the model's override alone does not
        assertEquals((await g.check("macro.play", { name: "sneaky" }, { override: "ode", userText: "go on" })).verdict, "refuse");
    });
});

Deno.test("macro.play: the override works through a macro as for a direct call, and an ignored one is said", async () => {
    const r = reg(gated());
    await withMacros(r, { m: [ode, diag] }, async () => {
        const g = new EngineGuard(r);
        const yes = await g.check("macro.play", { name: "m" }, { override: "ode", userText: "please use the ODE" });
        assertEquals(yes.verdict, "warn");
        assert(yes.overridden);
        assert(yes.message.includes('step 1 of macro "m" (sim.ode): ODE on a net with capacity on I') && yes.message.includes('step 2 of macro "m" (analysis.diagnose): ODE on a net with'), yes.message);
        const no = await g.check("macro.play", { name: "m" }, { override: "ode", userText: "run the simulation" });
        assertEquals(no.verdict, "refuse");
        assertEquals(no.overrideIgnored, "ode");
        assert(no.message.includes("was not applied"));
        // the wrong engine does not unlock it
        assertEquals((await g.check("macro.play", { name: "m" }, { override: "sde", userText: "use the SDE" })).verdict, "refuse");
    });
});

Deno.test("macro.play: a refusal with no engine behind it offers no engine_override", () => {
    const v = { verdict: "refuse", needs: null, message: 'macro.play "m" cannot be checked against the engine rules, so it is not run: it plays itself. Nothing ran.' };
    for (const canOverride of [false, true]) {
        const t = refusalText(v as any, { canOverride });
        assert(t.startsWith("refused: macro.play") && t.includes("Nothing ran"), t);
        assertFalse(t.includes('engine_override: "') || t.includes("?"), t);
    }
});

Deno.test("macro.play: a recommend that fails is the call's error, as for a direct call", async () => {
    const r = reg(gated());
    await withMacros(r, { m: [ode] }, async () => {
        const real = r.execute.bind(r);
        r.execute = (id: string, a: any) => (id === "sim.recommend" ? Promise.reject(new Error("recommend down")) : real(id, a));
        let msg = "";
        try { await new EngineGuard(r).check("macro.play", { name: "m" }); } catch (e) { msg = (e as Error).message; }
        assertEquals(msg, "recommend down");
    });
});
