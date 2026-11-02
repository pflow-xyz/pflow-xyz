import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { inferPlace, matchGoals, missingInputs, resolveArgs, runGoal } from "./petri-goals.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { ENGINE_NEEDS } from "./petri-engine-guard.js";
import { loadEngine } from "./petri-wasm.js";

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

// The fixture every goal runs on: SIR with rates.
const sir = () => ({
    places: { S: { initial: [45], capacity: [0], x: 0, y: 0 }, I: { initial: [5], capacity: [0], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
    transitions: { infect: { x: 50, y: 0, rate: 0.01 }, recover: { x: 150, y: 0, rate: 0.1 } },
    arcs: [
        { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
        { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
        { source: "recover", target: "R", weight: [1] },
    ],
});

// A goal that needs another kind of net names its own fixture: best_play
// needs a two-sided game, so it runs on pflow-native's tic-tac-toe (a
// byte-identical copy in parity/native/fixtures/).
const ttt = JSON.parse(await Deno.readTextFile(new URL("../parity/native/fixtures/tic-tac-toe.json", import.meta.url)));
const fixtureFor: Record<string, () => any> = { best_play: () => structuredClone(ttt) };

const inputsFor: Record<string, any> = {
    can_happen: { to: { R: 10 } },
    knob: { observable: "R" },
    one_more: { place: "I" },
    best_setting: { transition: "recover", max_rate: 1 },
    // JSON text, as the picker passes it
    best_play: { sides: '{"x_": 1, "o_": -1}', reward: '{"win_x": 1, "win_o": -1}', auto: '["x_win_", "o_win_"]' },
};

for (const goal of catalog.goals) {
    if (goal.available === false) {
        Deno.test(`goal ${goal.id}: marked unavailable, and running it says why`, async () => {
            const r: any = new Registry(createHeadlessHost(sir()));
            await assertRejects(() => runGoal(r, goal), Error, "Not in the browser");
        });
        continue;
    }
    Deno.test(`goal ${goal.id}: "${goal.question}" runs end to end`, async () => {
        const r: any = new Registry(createHeadlessHost((fixtureFor[goal.id] || sir)()));
        const out = await runGoal(r, goal, inputsFor[goal.id] || {});
        assert(out.ok, JSON.stringify(out.steps.find((s: any) => s.error)));
        assertEquals(out.steps.length, goal.plan.length);
        assert(goal.answer && goal.caveat, "every goal states its answer and caveat");
    });
}

Deno.test("goal best_play: tic-tac-toe is a draw, a best move is X's, nothing is fired; the caveat qualifies it", async () => {
    const goal = catalog.goals.find((g: any) => g.id === "best_play");
    const r: any = new Registry(createHeadlessHost(fixtureFor.best_play()));
    const before = (await r.execute("sim.marking")).marking;
    const out = await runGoal(r, goal, inputsFor.best_play);
    const m = out.steps[0].result;
    assertEquals([m.value, m.exact], [0, true]);
    assert(String(m.transition).startsWith("x_play_"), m.transition);
    assertEquals(out.steps[0].artifacts, [m.artifact], "the result is filed as a Report");
    assertEquals((await r.execute("sim.marking")).marking, before);
    // blank optional inputs drop their arguments; a plan as text is parsed, the budget passed on
    const blank = await runGoal(r, goal, { ...inputsFor.best_play, plan: "  " });
    assert(blank.ok, JSON.stringify(blank.steps[0]));
    assertEquals(blank.steps[0].args.plan, undefined);
    const planned = await runGoal(r, goal, { ...inputsFor.best_play, plan: '{"mode": "play"}', nodes: 50 });
    assert(planned.ok, JSON.stringify(planned.steps[0]));
    assertEquals(planned.steps[0].args.plan, { mode: "play" });
    assertEquals([planned.steps[0].result.exact, planned.steps[0].result.budget], [false, 50]);
    await assertRejects(() => runGoal(r, goal, { ...inputsFor.best_play, sides: "{x_: 1}" }), Error, "not valid JSON");
    await assertRejects(() => runGoal(r, goal, { reward: inputsFor.best_play.reward, sides: "  " }), Error, "needs who moves");
    for (const words of ["deterministic", "node budget", "\"ode\"", "a best move, not the best move", "freezes the tab"]) assert(goal.caveat.includes(words), words);
    // past the budget a "play" plan guesses (the run above): the answer must not claim it is always null
    assert(goal.answer.includes("\"play\"") && goal.answer.includes("guess"), goal.answer);
});

Deno.test("goals: every plan names a registry command", () => {
    const r: any = new Registry(createHeadlessHost(sir()));
    const ids = new Set(r.list().map((s: any) => s.id));
    for (const g of catalog.goals) for (const s of g.plan) assert(ids.has(s.command), `${g.id}: ${s.command}`);
});

Deno.test("goals: references resolve; a blank optional input drops the argument", () => {
    const ctx = { inputs: { observable: "", place: "I" }, results: [{ t_end: 50 }] };
    assertEquals(resolveArgs({ observable: "$input.observable", t_end: "$step0.t_end", place: "$input.place" }, ctx), { t_end: 50, place: "I" });
    const goal = catalog.goals.find((g: any) => g.id === "one_more");
    assertEquals(missingInputs(goal, {}).map((i: any) => i.name), ["place"]);
});

// The no-LLM router: the picker's search box. These paraphrases stand in
// for the slice-1 "llm-eval" routing check until a live key is available.
const paraphrases: Array<[string, string]> = [
    ["will my process ever deadlock?", "stuck"],
    ["could we end up with nobody left", "can_happen"],
    ["does the queue pile up forever", "unbounded"],
    ["what stays the same no matter what", "conserved"],
    ["what happens on average over a day", "average"],
    ["what's the worst case, how uncertain is this", "risk"],
    ["which lever has the biggest effect", "knob"],
    ["what if I had one more barista", "one_more"],
    ["what's the optimal service rate", "best_setting"],
    ["does my event log match", "data_match"],
    ["is this the same as the other model, just renamed", "same_net"],
    ["if both players play perfectly, who wins?", "best_play"],
];
for (const [text, want] of paraphrases) {
    Deno.test(`routing: "${text}" → ${want}`, () => {
        assertEquals(matchGoals(catalog, text)[0]?.id, want);
    });
}

// ---- the coffee-shop feedback: the outcome, the engine, the sink ----

const coffee = () => {
    const P = (n: number) => ({ initial: [n], capacity: [0], x: 0, y: 0 });
    return {
        "@context": "https://pflow.xyz/schema", "@type": "PetriNet", token: ["https://pflow.xyz/tokens/black"],
        places: { queue: P(0), baristas_free: P(2), in_service: P(0), served: P(0), abandoned: P(0) },
        transitions: { customer_arrives: { x: 0, y: 0, rate: 1 }, start_service: { x: 0, y: 0, rate: 1 }, finish_service: { x: 0, y: 0, rate: 0.5 }, walk_out: { x: 0, y: 0, rate: 0.1 } },
        arcs: [
            { source: "customer_arrives", target: "queue", weight: [1] }, { source: "queue", target: "start_service", weight: [1] },
            { source: "baristas_free", target: "start_service", weight: [1] }, { source: "start_service", target: "in_service", weight: [1] },
            { source: "in_service", target: "finish_service", weight: [1] }, { source: "finish_service", target: "served", weight: [1] },
            { source: "finish_service", target: "baristas_free", weight: [1] }, { source: "queue", target: "walk_out", weight: [1] },
            { source: "walk_out", target: "abandoned", weight: [1] },
        ],
    };
};

Deno.test("inferPlace: 'walkouts' names the walk_out transition, so the outcome is abandoned", () => {
    const m: any = coffee();
    assertEquals(inferPlace(m, "which knob matters most for walkouts?"), "abandoned");
    assertEquals(inferPlace(m, "how long is the queue"), "queue");
    assertEquals(inferPlace(m, "what if I had one more barista"), "baristas_free");
    assertEquals(inferPlace(m, "which knob matters?"), "");
});

Deno.test("knob goal: sim.recommend says ssa, so the SSA diagnosis runs and the ODE one is skipped", async () => {
    const goal = catalog.goals.find((g: any) => g.id === "knob");
    const r: any = new Registry(createHeadlessHost(coffee()));
    const seen: string[] = [];
    const out = await runGoal(r, goal, { observable: "abandoned" }, (s: any) => seen.push(`${s.command}${s.skipped ? " (skipped)" : ""}`));
    assert(out.ok, JSON.stringify(out.steps.find((s: any) => s.error)));
    assertEquals(seen, ["sim.recommend", "analysis.diagnose (skipped)", "analysis.diagnose_ssa"]);
    assertEquals(out.steps[0].result.engine, "ssa");
    const d = out.steps[2].result;
    assertEquals(d.engine, "ssa");
    // a sink cannot move another place: +1 served is exactly 0
    assertEquals(d.knobs.find((k: any) => k.name === "+1 served").influence, 0);
    // one more barista lowers walkouts by more than the noise floor allows to call inert
    const b = d.knobs.find((k: any) => k.name === "+1 baristas_free");
    assert(b.influence < 0, JSON.stringify(b));
});

Deno.test("knob goal: a large unconstrained net still gets the ODE diagnosis", async () => {
    const goal = catalog.goals.find((g: any) => g.id === "knob");
    const net: any = sir();
    net.places.S.initial = [900];
    const r: any = new Registry(createHeadlessHost(net));
    const seen: string[] = [];
    const out = await runGoal(r, goal, { observable: "R" }, (s: any) => seen.push(`${s.command}${s.skipped ? " (skipped)" : ""}`));
    assert(out.ok, JSON.stringify(out.steps.find((s: any) => s.error)));
    assertEquals(seen, ["sim.recommend", "analysis.diagnose", "analysis.diagnose_ssa (skipped)"]);
});

Deno.test("what-if: the table gains a Δ row (the card promises the difference in every place's final mean)", async () => {
    const r: any = new Registry(createHeadlessHost(coffee()));
    const out = await r.execute("sim.what_if", { place: "baristas_free" });
    const rows = r.artifact(out.table).data.rows;
    assertEquals(rows.length, 3);
    assert(String(rows[2][0]).startsWith("Δ"), rows[2][0]);
    const cols = r.artifact(out.table).data.columns;
    const i = cols.indexOf("baristas_free");
    assert(Math.abs(rows[2][i] - (rows[1][i] - rows[0][i])) < 1e-4, JSON.stringify(rows));
});

// ---- the engine guard in front of the plans ----
//
// The live-test failure: analysis.diagnose ran the ODE although sim.recommend
// said SSA, because the net has capacities. The plan runner now refuses an
// engine-dependent step the net's own recommendation rules out.

const gatedSir = () => { const n: any = sir(); n.places.I.capacity = [60]; return n; }; // 50 tokens + a capacity: Rule 1
const largeSir = () => { const n: any = sir(); n.places.S.initial = [900]; n.places.I.initial = [100]; return n; }; // 1000 tokens, nothing gating
const ranOn = (r: any) => { const ran: string[] = []; r.onExecute((e: any) => ran.push(e.id)); return ran; };
const goalById = (id: string) => catalog.goals.find((g: any) => g.id === id);
const executed = (out: any) => out.steps.filter((s: any) => !s.skipped).map((s: any) => s.command);
// The commands that are the ODE or the SDE whatever their arguments (sim.scenario and sim.compare are
// guarded only when a scenario asks for engine "ode"; the SSA ones the goals use do not).
const ODE_COMMANDS = Object.entries(ENGINE_NEEDS).filter(([, e]: any) => e.needs !== "ssa" && !e.when).map(([id]) => id);

Deno.test("guard: knob goal on SIR-with-capacity runs the SSA diagnosis and never analysis.diagnose", async () => {
    const r: any = new Registry(createHeadlessHost(gatedSir()));
    const ran = ranOn(r);
    const out = await runGoal(r, goalById("knob"), { observable: "R" });
    assert(out.ok, JSON.stringify(out.steps.find((s: any) => s.error)));
    assert(ran.includes("analysis.diagnose_ssa"));
    assert(!ran.includes("analysis.diagnose"), "the ODE ranking never ran");
    assertEquals(out.steps[0].result.gating, ["capacity on I"]);
    assertEquals(out.steps.filter((s: any) => s.refused || s.warning).length, 0, "the plan does not trip its own guard");
});

Deno.test("guard: a plan that runs analysis.diagnose unconditionally is refused on SIR-with-capacity, and nothing ran", async () => {
    // the plan the live test ran: recommend, then the ODE ranking whatever it said
    const bad = { id: "bad_knob", question: "?", inputs: [], plan: [{ command: "sim.recommend", args: {} }, { command: "analysis.diagnose", args: { observable: "R", t_end: "$step0.t_end" } }, { command: "analysis.verify", args: { properties: [{ kind: "bounded" }] } }] };
    const r: any = new Registry(createHeadlessHost(gatedSir()));
    const ran = ranOn(r);
    const seen: any[] = [];
    const out = await runGoal(r, bad, {}, (s: any) => seen.push(s));
    assertEquals(out.ok, false);
    assertEquals(out.steps.length, 2, "the plan stopped at the refusal");
    const refused = out.steps[1];
    assertEquals(refused.command, "analysis.diagnose");
    assert(refused.refused.rule.includes("Rule 1") && refused.refused.rule.includes("docs/engine-selection.md"));
    assertEquals(refused.refused.recommended, "ssa");
    assert(refused.refused.message.includes("Nothing ran") && refused.refused.message.includes("analysis.diagnose_ssa"));
    assert(refused.error.startsWith("refused: "), "callers that only read errors still see it");
    assertEquals(refused.result, undefined);
    assertEquals(seen.at(-1), refused, "reported through onStep");
    assert(!ran.includes("analysis.diagnose") && !ran.includes("analysis.verify"), `ran: ${ran}`);
    assertEquals(r.artifacts().length, 0);
    // the control: without the guard the old plan runs the ODE ranking, which is the bug
    const r2: any = new Registry(createHeadlessHost(gatedSir()));
    const ran2 = ranOn(r2);
    const unguarded = await runGoal(r2, bad, {}, () => {}, { guard: false });
    assert(unguarded.ok && ran2.includes("analysis.diagnose"));
});

Deno.test("guard: average on a gated net is the SSA's ensemble mean, not the ODE; a large net keeps the ODE", async () => {
    const goal = goalById("average");
    const r: any = new Registry(createHeadlessHost(gatedSir()));
    const ran = ranOn(r);
    const out = await runGoal(r, goal, {});
    assert(out.ok);
    assertEquals(executed(out), ["sim.recommend", "sim.ssa"]);
    assert(!ran.includes("sim.ode"));
    assertEquals(out.steps[2].result.runs, 20, "an ensemble: the mean of 20 seeded runs");
    assertEquals(out.steps[2].args, { t_end: out.steps[0].result.t_end, runs: 20, seed: 1 });
    const band = r.artifact(out.steps[2].result.artifact).data.series[0].band;
    assert(Array.isArray(band), "with its ±1 sd band");

    const big: any = new Registry(createHeadlessHost(largeSir()));
    const ranBig = ranOn(big);
    const out2 = await runGoal(big, goal, {});
    assertEquals(executed(out2), ["sim.recommend", "sim.ode"]);
    assert(!ranBig.includes("sim.ssa"));
});

Deno.test("guard: best_setting scans the rate on the SSA when the engine says SSA, on the ODE otherwise", async () => {
    const goal = goalById("best_setting");
    const inputs = { transition: "recover", max_rate: 1 };
    const r: any = new Registry(createHeadlessHost(gatedSir()));
    const ran = ranOn(r);
    const out = await runGoal(r, goal, inputs);
    assert(out.ok, JSON.stringify(out.steps.find((s: any) => s.error)));
    assertEquals(executed(out), ["sim.recommend", "sim.compare"]);
    assert(!ran.includes("opt.rate_scan"));
    // five rates from 0 to the maximum, one shared seed, the same horizon and runs
    const scenarios = out.steps[2].args.scenarios;
    assertEquals(scenarios.map((s: any) => s.rates.recover), [0, 0.25, 0.5, 0.75, 1]);
    assertEquals(new Set(scenarios.map((s: any) => s.hours)).size, 1);
    assertEquals(out.steps[2].args.seed, 1);
    const table = r.artifact(out.steps[2].result.table).data;
    assertEquals(table.rows.length, 5);
    assertEquals(table.rows.map((row: any) => row[0]), ["rate 0% of max", "rate 25% of max", "rate 50% of max", "rate 75% of max", "rate 100% of max"]);
    // the scale follows the person's maximum
    const wide = await runGoal(r, goal, { transition: "recover", max_rate: 4 });
    assertEquals(wide.steps[2].args.scenarios.map((s: any) => s.rates.recover), [0, 1, 2, 3, 4]);

    const big: any = new Registry(createHeadlessHost(largeSir()));
    const ranBig = ranOn(big);
    const out2 = await runGoal(big, goal, inputs);
    assertEquals(executed(out2), ["sim.recommend", "opt.rate_scan"]);
    assert(!ranBig.includes("sim.compare"));
});

Deno.test("guard: no shipped goal runs an ODE or SDE command on a gated or a small net, and none trips its own guard", async () => {
    for (const [label, net] of [["gated", gatedSir], ["small", sir]] as Array<[string, () => any]>) {
        for (const goal of catalog.goals) {
            if (goal.available === false || goal.id === "best_play") continue;
            const r: any = new Registry(createHeadlessHost(net()));
            const ran = ranOn(r);
            const out = await runGoal(r, goal, inputsFor[goal.id] || {});
            assert(out.ok, `${label} ${goal.id}: ${JSON.stringify(out.steps.find((s: any) => s.error))}`);
            const odes = ran.filter((id) => ODE_COMMANDS.includes(id));
            assertEquals(odes, [], `${label} ${goal.id} ran ${odes}`);
            assertEquals(out.steps.filter((s: any) => s.refused || s.warning).length, 0, `${label} ${goal.id}`);
        }
    }
    // and on a large unconstrained net the goals that have an ODE step run it, unwarned
    for (const id of ["average", "best_setting", "knob"]) {
        const r: any = new Registry(createHeadlessHost(largeSir()));
        const ran = ranOn(r);
        const out = await runGoal(r, goalById(id), inputsFor[id] || {});
        assert(out.ok && ran.some((c) => ODE_COMMANDS.includes(c)), id);
        assertEquals(out.steps.filter((s: any) => s.refused || s.warning).length, 0, id);
    }
});

Deno.test("guard: sim.recommend runs once per goal run, whether the plan or the guard asks for it", async () => {
    const r: any = new Registry(createHeadlessHost(largeSir()));
    const ran = ranOn(r);
    const goal = goalById("knob");
    await runGoal(r, goal, { observable: "R" });
    assertEquals(ran.filter((id) => id === "sim.recommend").length, 1, "the plan's own run is the guard's");
    // a plan that never asks: the guard asks, once, for however many steps need it
    const quiet = { id: "q", question: "?", inputs: [], plan: [{ command: "sim.ode", args: { t_end: 2 } }, { command: "opt.sweep", args: { transition: "recover", place: "R", from: 0.05, to: 0.1, steps: 2, t_end: 2 } }] };
    const r2: any = new Registry(createHeadlessHost(largeSir()));
    const ran2 = ranOn(r2);
    const out = await runGoal(r2, quiet, {});
    assert(out.ok);
    assertEquals(ran2.filter((id) => id === "sim.recommend").length, 1);
    // goals that need no engine never ask
    const r3: any = new Registry(createHeadlessHost(largeSir()));
    const ran3 = ranOn(r3);
    await runGoal(r3, goalById("conserved"), {});
    await runGoal(r3, goalById("risk"), {}); // plan-run recommend only
    assertEquals(ran3.filter((id) => id === "sim.recommend").length, 1);
});

Deno.test("guard: the soft rule warns for sim.ode and refuses analysis.diagnose", async () => {
    const r: any = new Registry(createHeadlessHost(sir())); // 50 tokens, nothing gating
    const curve = { id: "c", question: "?", inputs: [], plan: [{ command: "sim.ode", args: { t_end: 5 } }] };
    const out = await runGoal(r, curve, {});
    assert(out.ok);
    assert(out.steps[0].warning.startsWith("ODE on a net where the engine recommends SSA"), out.steps[0].warning);
    assertEquals(out.steps[0].refused, undefined);
    assert(out.steps[0].result.final, "it ran");

    const ranking = { id: "k", question: "?", inputs: [], plan: [{ command: "analysis.diagnose", args: { observable: "R" } }] };
    const ran = ranOn(r);
    const out2 = await runGoal(r, ranking, {});
    assertEquals(out2.ok, false);
    assert(out2.steps[0].refused.rule.includes("Rule 2"), out2.steps[0].refused.rule);
    assert(!ran.includes("analysis.diagnose"));
});

Deno.test("guard: an override counts only when the person's own words name the engine, and the result carries the warning", async () => {
    const plan = { id: "o", question: "?", inputs: [], plan: [{ command: "sim.ode", args: { t_end: 5 } }] };
    const run = (opts: any) => runGoal(new Registry(createHeadlessHost(gatedSir())) as any, plan, {}, () => {}, opts);
    const yes = await run({ override: "ode", userText: "run it on the ODE please" });
    assert(yes.ok);
    assertEquals(yes.steps[0].warning, "ODE on a net with capacity on I; the engine recommends SSA");
    assert(yes.steps[0].result.final);
    // the model passes the override, the person never asked for it: refused
    for (const opts of [{ override: "ode", userText: "simulate it" }, { override: "ode" }, { userText: "use the ODE" }, {}, { override: "ode", userText: "not the ODE" }, { override: "sde", userText: "use the SDE" }]) {
        const no = await run(opts);
        assertEquals(no.ok, false, JSON.stringify(opts));
        assert(no.steps[0].refused.message.includes("Nothing ran"), JSON.stringify(opts));
    }
});

Deno.test("guard: opts.guard replaces the guard and opts.guard === false turns it off", async () => {
    const plan = { id: "g", question: "?", inputs: [], plan: [{ command: "net.info", args: {} }, { command: "sim.ode", args: { t_end: 5 } }] };
    const calls: string[] = [];
    const strict = { check: async (id: string) => { calls.push(id); return id === "sim.ode" ? { verdict: "refuse", rule: "r", message: "no way", recommended: "ssa" } : { verdict: "ok" }; } };
    const r: any = new Registry(createHeadlessHost(largeSir()));
    const out = await runGoal(r, plan, {}, () => {}, { guard: strict });
    assertEquals(out.ok, false);
    assertEquals(calls, ["net.info", "sim.ode"]);
    assertEquals(out.steps[1].refused, { rule: "r", message: "no way", recommended: "ssa" });
    // off: the gated net's ODE runs, as it did before the guard
    const g: any = new Registry(createHeadlessHost(gatedSir()));
    assert((await runGoal(g, plan, {}, () => {}, { guard: false })).ok);
});

Deno.test("goals: a reference to a number may be scaled, and an object key may be a reference", () => {
    const ctx = { inputs: { t: "recover", top: 2, typed: "3", blank: "", obj: { a: 1 } }, results: [{ t_end: 40 }] };
    assertEquals(resolveArgs({ rates: { "$input.t": "$input.top*0.25" } }, ctx), { rates: { recover: 0.5 } });
    assertEquals(resolveArgs({ a: "$input.typed*2", b: "$step0.t_end*0.5", c: "$input.top*1" }, ctx), { a: 6, b: 20, c: 2 });
    assertEquals(resolveArgs({ a: "$input.blank*2", b: 1 }, ctx), { b: 1 }, "a blank optional input drops it");
    assertEquals(resolveArgs({ "$input.blank": 1, b: 2 }, ctx), { b: 2 });
    let msg = "";
    try { resolveArgs({ a: "$input.t*2" }, ctx); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("not a number"), msg);
    msg = "";
    try { resolveArgs({ "$input.obj": 1 }, ctx); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("key"), msg);
    // not a scaled reference: left to the old rules
    msg = "";
    try { resolveArgs({ a: "$nope.x*2" }, ctx); } catch (e) { msg = (e as Error).message; }
    assert(msg.includes("unknown reference"), msg);
});

Deno.test("guard: a plan step that replays a stored macro is held to the table's rules, and nothing ran (macro.play is not a way around the guard)", async () => {
    const rank = { name: "goal_rank", steps: [{ command: "analysis.diagnose", args: { observable: "R", t_end: 5, noise: false } }] };
    const plan = (name: string) => ({ id: "replay", question: "?", inputs: [], plan: [{ command: "sim.recommend", args: {} }, { command: "macro.play", args: { name } }] });
    const r: any = new Registry(createHeadlessHost(gatedSir()));
    await r.execute("macro.define", rank);
    try {
        const ran = ranOn(r);
        const seen: any[] = [];
        const out = await runGoal(r, plan("goal_rank"), {}, (s: any) => seen.push(s));
        assertEquals(out.ok, false);
        const refused = out.steps[1];
        assertEquals(refused.command, "macro.play");
        assert(refused.refused.rule.includes("Rule 1") && refused.refused.message.includes('step 1 of macro "goal_rank" (analysis.diagnose)'), refused.refused.message);
        assertEquals(refused.refused.recommended, "ssa");
        assert(refused.error.startsWith("refused: "));
        assertEquals(refused.result, undefined);
        assertEquals(seen.at(-1), refused, "reported through onStep");
        assert(!ran.includes("macro.play") && !ran.includes("analysis.diagnose"), `ran: ${ran}`);
        assertEquals(r.artifacts().length, 0);
        // the control: the unguarded plan replays the macro, which is the bypass
        const r2: any = new Registry(createHeadlessHost(gatedSir()));
        const unguarded = await runGoal(r2, plan("goal_rank"), {}, () => {}, { guard: false });
        assert(unguarded.ok && unguarded.steps[1].result.results[0].baseline !== undefined);
        // a large net replays it, with no chip
        const big: any = new Registry(createHeadlessHost(largeSir()));
        const fine = await runGoal(big, plan("goal_rank"), {});
        assert(fine.ok, JSON.stringify(fine.steps.at(-1)));
        assertEquals(fine.steps.filter((s: any) => s.refused || s.warning).length, 0);
    } finally {
        await r.execute("macro.delete", { name: "goal_rank" });
    }
});
