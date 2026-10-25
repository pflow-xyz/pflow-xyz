import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchGoals, missingInputs, resolveArgs, runGoal } from "./petri-goals.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
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

const inputsFor: Record<string, any> = {
    can_happen: { to: { R: 10 } },
    knob: { observable: "R" },
    one_more: { place: "I" },
    best_setting: { transition: "recover", max_rate: 1 },
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
        const r: any = new Registry(createHeadlessHost(sir()));
        const out = await runGoal(r, goal, inputsFor[goal.id] || {});
        assert(out.ok, JSON.stringify(out.steps.find((s: any) => s.error)));
        assertEquals(out.steps.length, goal.plan.length);
        assert(goal.answer && goal.caveat, "every goal states its answer and caveat");
    });
}

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
];
for (const [text, want] of paraphrases) {
    Deno.test(`routing: "${text}" → ${want}`, () => {
        assertEquals(matchGoals(catalog, text)[0]?.id, want);
    });
}
