import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CommandError, Registry, conserves, createHeadlessHost } from "./petri-commands.js";
import { ChatSession, nextStepIn } from "./petri-chat.js";
import { validateNet } from "./petri-validate.js";
import { loadEngine } from "./petri-wasm.js";

const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });
const manifest = JSON.parse(await Deno.readTextFile(new URL("./llm-tools.json", import.meta.url)));

const reg = (m?: any): any => new Registry(createHeadlessHost(m));
const net = (places: any, transitions: any, arcs: any[]) => ({ places, transitions, arcs });
const P = (n = 0) => ({ initial: [n], capacity: [0], x: 0, y: 0 });
const T = (rate?: number) => ({ x: 0, y: 0, ...(rate !== undefined ? { rate } : {}) });
const A = (source: string, target: string, w = 1) => ({ source, target, weight: [w] });

// ---- analysis.behaviour (sim's checks) ----

Deno.test("behaviour: a deadlock with a replayable trace; dead transitions and empty places when exhaustive", async () => {
    const r = reg(net({ a: P(1), b: P(0), never: P(0) }, { go: T(), stuck: T() }, [A("a", "go"), A("go", "b"), A("never", "stuck"), A("stuck", "a")]));
    const out = await r.execute("analysis.behaviour");
    assert(out.exhaustive);
    const cats = Object.fromEntries(out.findings.map((f: any) => [f.category, f]));
    assertEquals(cats.dead_transition.nodes, ["stuck"]);
    assertEquals(cats.unreachable_place.nodes, ["never"]);
    assert(cats.deadlock && out.trace);
    await r.execute("sim.goto", { id: out.trace });
    assertEquals((await r.execute("sim.enabled")).enabled, []);
});

Deno.test("behaviour: unbounded growth stops the search, and 'never' claims are dropped", async () => {
    const r = reg(net({ q: P(0) }, { arrive: T(), never: T() }, [A("arrive", "q"), A("q", "never", 5000)]));
    const out = await r.execute("analysis.behaviour", { unbounded_tokens: 50 });
    assert(!out.exhaustive);
    assertEquals(out.findings.map((f: any) => f.category), ["unbounded"]);
});

Deno.test("behaviour: disconnected parts", async () => {
    const r = reg(net({ a: P(1), b: P(0), x: P(1), y: P(0) }, { t: T(), u: T() }, [A("a", "t"), A("t", "b"), A("x", "u"), A("u", "y")]));
    const out = await r.execute("analysis.behaviour");
    assert(out.findings.some((f: any) => f.category === "disconnected"));
});

// ---- goals and the defect weight ----

Deno.test("goals: set, validated, and refused when malformed", async () => {
    const r = reg(net({ a: P(2), b: P(0) }, { t: T() }, [A("a", "t"), A("t", "b")]));
    await r.execute("net.set_goals", { goals: [{ label: "all moved", to: { b: 2 } }] });
    assertEquals(r.host.getModel().goals, [{ label: "all moved", to: { b: 2 } }]);
    assertEquals(validateNet(JSON.parse(JSON.stringify(r.host.getModel()))).errors, []);
    await assertRejects(() => r.execute("net.set_goals", { goals: [{ to: { nowhere: 1 } }] }), CommandError, "not a place");
    const bad = JSON.parse(JSON.stringify(r.host.getModel()));
    bad.goals = [{ to: { b: -1 } }];
    assert(validateNet(bad).errors.some((e: any) => e.path === "goals[0].to.b"));
    await r.execute("net.set_goals", { goals: [] });
    assert(!("goals" in r.host.getModel()));
});

Deno.test("defects: 0 for a clean net; unreachable goals, empty siphons and lost laws each count", async () => {
    const clean = reg(net({ a: P(2), b: P(0) }, { t: T() }, [A("a", "t"), A("t", "b")]));
    await clean.execute("net.set_goals", { goals: [{ to: { b: 2 } }] });
    assertEquals((await clean.execute("analysis.defects")).weight, 0);

    await clean.execute("net.set_goals", { goals: [{ label: "too many", to: { b: 3 } }] });
    const d1 = await clean.execute("analysis.defects", { baseline_laws: [{ a: 1, b: 1 }] });
    assertEquals(d1.unreachable_goals, ["too many"]);
    assertEquals(d1.lost_laws, []); // a + b is still conserved
    assertEquals(d1.weight, 1);

    // a transition that destroys tokens breaks a + b; an empty place feeding a transition is an empty siphon
    const broken = reg(net({ a: P(2), b: P(0), fuel: P(0) }, { t: T(), leak: T(), burn: T() }, [A("a", "t"), A("t", "b"), A("b", "leak"), A("fuel", "burn"), A("burn", "b")]));
    const d2 = await broken.execute("analysis.defects", { baseline_laws: [{ a: 1, b: 1 }] });
    assertEquals(d2.lost_laws, ["a + b"]);
    assert(d2.unmarked_siphons.some((s: string[]) => s.includes("fuel")));
    assert(d2.weight >= 2);
});

Deno.test("conserves: a weighted sum against the incidence", () => {
    const m: any = { places: { a: {}, b: {} }, transitions: { t: {} }, arcs: [{ source: "a", target: "t", weight: [2] }, { source: "t", target: "b", weight: [1] }] };
    assert(conserves(m, { a: 1, b: 2 }));
    assert(!conserves(m, { a: 1, b: 1 }));
});

// ---- sim's components, through the engine, edit the net ----

Deno.test("compose.fuse adds a component as one undo step, fused onto an existing place", async () => {
    const r = reg(net({ queue: P(0) }, {}, []));
    const out = await r.execute("compose.fuse", { component: "service", attach: { queue: "queue" } });
    const m = r.host.getModel();
    for (const id of out.places) assert(id in m.places, id);
    assertEquals(m.transitions.service_pickup.rate, 720);
    assert(m.arcs.some((a: any) => a.source === "queue" && a.target === "service_pickup"));
    assertEquals(m.token, ["https://pflow.xyz/tokens/black"]); // the editor's token list survives
    await r.execute("edit.undo");
    assertEquals(Object.keys(r.host.getModel().places), ["queue"]);
});

// ---- the interview ----

Deno.test("nextStepIn: forward moves only, closed vocabulary", () => {
    assertEquals(nextStepIn("Got it. Next: structure", "describe"), "structure");
    assertEquals(nextStepIn("next: Rates", "structure"), "rates");
    assertEquals(nextStepIn("Next: describe", "rates"), null);
    assertEquals(nextStepIn("Next: dancing", "describe"), null);
    assertEquals(nextStepIn("no marker", "describe"), null);
});

/** A scripted model; records what it is sent. */
function scripted(replies: any[]) {
    const sent: any[] = [];
    const post = async (body: any) => {
        sent.push(structuredClone(body));
        const r = replies.shift() ?? { reply: "done", tool_calls: [] };
        return { message: { role: "model", parts: [{ text: r.reply || " " }] }, ...r };
    };
    return { post, sent };
}

// The phase-6 exit check: from a description, through the interview, to a
// net with no failing check and a defect weight of 0, applied as one step.
Deno.test("interview: description → structure → rates → validate → preview → done, defect weight 0", async () => {
    const live = reg();
    const { post, sent } = scripted([
        { reply: "A help desk: tickets arrive, one of two agents works each, some customers give up. Next: structure" },
        { reply: "Arrivals into a queue, a two-agent service, patience to a walked-out sink.", tool_calls: [
            { name: "net_add_place", args: { x: 100, y: 100, id: "queue", label: "Waiting tickets" } },
            { name: "compose_fuse", args: { component: "arrivals", attach: '{"queue": "queue"}' } },
            { name: "compose_fuse", args: { component: "service", attach: '{"queue": "queue"}', params: '{"staff": 2, "per_hour": 4}' } },
            { name: "net_add_place", args: { x: 300, y: 300, id: "walked_out", label: "Walked out" } },
            { name: "net_add_transition", args: { x: 200, y: 300, id: "give_up", label: "Give up" } },
            { name: "net_add_arc", args: { source: "queue", target: "give_up" } },
            { name: "net_add_arc", args: { source: "give_up", target: "walked_out" } },
        ] },
        { reply: "Structure done. Next: rates" },
        { reply: "Patience about 10 minutes.", tool_calls: [
            { name: "sim_set_rate", args: { id: "give_up", rate: 6 } },
            { name: "net_set_goals", args: { goals: [{ label: "someone served", to: { service_served: 1 } }] } },
        ] },
        { reply: "Rates set. Next: validate" },
        { reply: "", tool_calls: [{ name: "analysis_check", args: {} }, { name: "analysis_defects", args: {} }] },
        { reply: "Clean: no errors and defect weight 0. Next: preview" },
        { reply: "", tool_calls: [{ name: "sim_recommend", args: {} }] },
        { reply: "Looks like a busy desk. Apply the pending edits. Next: done" },
    ]);
    const chat: any = new ChatSession({ live, manifest, post, mode: "build", maxRounds: 3 });
    const events: any[] = [];
    await chat.send("we run a help desk", (e: any) => events.push(e));
    assertEquals(chat.step, "structure");
    await chat.send("arrivals, two agents, people give up", (e: any) => events.push(e));
    assertEquals(chat.step, "rates");
    // the engine's checks went back to the model after the edit round
    const after = sent[2].messages[sent[2].messages.length - 1].parts;
    assert(after.some((p: any) => typeof p.text === "string" && p.text.startsWith("Checks after your edits")));
    assert(events.some((e) => e.type === "checks"));
    // and the step travelled with every build-mode call
    assertEquals(sent.map((b: any) => b.step), ["describe", "structure", "structure"]);
    await chat.send("about 10 minutes patience");
    assertEquals(chat.step, "validate");
    await chat.send("check it");
    assertEquals(chat.step, "preview");
    await chat.send("preview please");
    assertEquals(chat.step, "done");

    const check = chat.calls.find((c: any) => c.command === "analysis.check");
    assert(check.ok && check.result.ok, JSON.stringify(check.result?.errors));
    const defects = chat.calls.find((c: any) => c.command === "analysis.defects");
    assertEquals(defects.result.weight, 0, JSON.stringify(defects.result));
    const behaviour = await chat.sandbox.execute("analysis.behaviour");
    assertEquals(behaviour.findings.filter((f: any) => f.category !== "unbounded").map((f: any) => f.category), []);

    const w: any = await chat.weights();
    assertEquals(w.after.weight, 0);
    assert(!w.worse);
    assert(chat.apply());
    assert("service_pickup" in live.host.getModel().transitions);
    live.host.undo();
    assertEquals(Object.keys(live.host.getModel().places), []); // one step back to the empty net
});
