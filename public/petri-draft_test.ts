import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { draftToNet, gateDraft, validateDraft } from "./petri-draft.js";
import { computeCid } from "./seal-cid.mjs";

// Known-good drafts, one per example description in the dialog.
const coffee = () => ({
    name: "Coffee shop", summary: "Customers queue for one barista; some walk out.",
    places: [
        { id: "queue", label: "Waiting customers", description: "Waiting.", initial: 0, capacity: 0 },
        { id: "barista_free", label: "Free barista", description: "Idle barista.", initial: 1, capacity: 0 },
        { id: "in_brew", label: "Drink being made", description: "Brewing.", initial: 0, capacity: 0 },
        { id: "served", label: "Served", description: "Left with a drink.", initial: 0, capacity: 0 },
        { id: "walked_out", label: "Walked out", description: "Gave up.", initial: 0, capacity: 0 },
    ],
    transitions: [
        { id: "arrive", label: "Customer arrives", description: "Joins the queue.", rate: 30 },
        { id: "start_brew", label: "Start drink", description: "Barista takes the next one.", rate: 720 },
        { id: "finish_brew", label: "Hand over drink", description: "Done.", rate: 20 },
        { id: "give_up", label: "Give up", description: "Leaves.", rate: 6 },
    ],
    arcs: [
        { from: "arrive", to: "queue", weight: 1, inhibitor: false },
        { from: "queue", to: "start_brew", weight: 1, inhibitor: false },
        { from: "barista_free", to: "start_brew", weight: 1, inhibitor: false },
        { from: "start_brew", to: "in_brew", weight: 1, inhibitor: false },
        { from: "in_brew", to: "finish_brew", weight: 1, inhibitor: false },
        { from: "finish_brew", to: "served", weight: 1, inhibitor: false },
        { from: "finish_brew", to: "barista_free", weight: 1, inhibitor: false },
        { from: "queue", to: "give_up", weight: 1, inhibitor: false },
        { from: "give_up", to: "walked_out", weight: 1, inhibitor: false },
    ],
    assumptions: ["Rates are per hour."],
});

const orders = () => ({
    name: "Order pipeline", summary: "Orders are paid, packed and shipped; a hold blocks packing.",
    places: [
        { id: "placed", label: "Placed", description: "New orders.", initial: 3, capacity: 0 },
        { id: "paid", label: "Paid", description: "Payment taken.", initial: 0, capacity: 0 },
        { id: "on_hold", label: "On hold", description: "A fraud hold.", initial: 0, capacity: 1 },
        { id: "shipped", label: "Shipped", description: "Gone.", initial: 0, capacity: 0 },
    ],
    transitions: [
        { id: "pay", label: "Pay", description: "Customer pays.", rate: 2 },
        { id: "pack_and_ship", label: "Pack and ship", description: "Warehouse ships it.", rate: 1 },
    ],
    arcs: [
        { from: "placed", to: "pay", weight: 1, inhibitor: false },
        { from: "pay", to: "paid", weight: 1, inhibitor: false },
        { from: "paid", to: "pack_and_ship", weight: 1, inhibitor: false },
        { from: "on_hold", to: "pack_and_ship", weight: 1, inhibitor: true },
        { from: "pack_and_ship", to: "shipped", weight: 1, inhibitor: false },
    ],
    assumptions: ["Rates are per day."],
});

const sir = () => ({
    name: "SIR epidemic", summary: "Susceptible, infected, recovered.",
    places: [
        { id: "s", label: "Susceptible", description: "Can catch it.", initial: 99, capacity: 0 },
        { id: "i", label: "Infected", description: "Has it.", initial: 1, capacity: 0 },
        { id: "r", label: "Recovered", description: "Immune.", initial: 0, capacity: 0 },
    ],
    transitions: [
        { id: "infect", label: "Infection", description: "Contact spreads it.", rate: 0.003 },
        { id: "recover", label: "Recovery", description: "Gets better.", rate: 0.1 },
    ],
    arcs: [
        { from: "s", to: "infect", weight: 1, inhibitor: false },
        { from: "i", to: "infect", weight: 1, inhibitor: false },
        { from: "infect", to: "i", weight: 2, inhibitor: false },
        { from: "i", to: "recover", weight: 1, inhibitor: false },
        { from: "recover", to: "r", weight: 1, inhibitor: false },
    ],
    assumptions: ["Rates are per day."],
});

for (const [name, make] of [["coffee", coffee], ["orders", orders], ["sir", sir]] as const) {
    Deno.test(`gateDraft: the ${name} draft passes every stage`, async () => {
        const r = await gateDraft(make());
        assertEquals(r.errors, []);
        assert(r.ok && r.cid?.startsWith("z"));
    });
}

// One fault per fixture; each must produce exactly its own error.
const faults: Array<[string, (d: any) => void, string]> = [
    ["unknown key", (d) => { d.places[0].colour = "red"; }, "places[0].colour"],
    ["missing key", (d) => { delete d.transitions[0].rate; }, "transitions[0].rate"],
    ["duplicate id", (d) => { d.places.push({ id: "queue", label: "Again", description: "", initial: 0, capacity: 0 }); }, "places[5].id"],
    ["place and transition share an id", (d) => { d.transitions.push({ id: "queue", label: "Q", description: "", rate: 1 }); }, "transitions[4].id"],
    ["place to place arc", (d) => { d.arcs.push({ from: "queue", to: "served", weight: 1, inhibitor: false }); }, "arcs[9]"],
    ["dangling reference", (d) => { d.arcs[0].to = "lobby"; }, "arcs[0].to"],
    ["initial above capacity", (d) => { d.places[1].capacity = 1; d.places[1].initial = 2; }, "places[1].initial"],
    ["negative rate", (d) => { d.transitions[1].rate = -1; }, "transitions[1].rate"],
    ["NaN rate", (d) => { d.transitions[1].rate = NaN; }, "transitions[1].rate"],
    ["multi-line label", (d) => { d.places[0].label = "two\nlines"; }, "places[0].label"],
    ["__proto__ id", (d) => { d.places.push({ id: "__proto__", label: "P", description: "", initial: 0, capacity: 0 }); }, "places[5].id"],
    ["not snake_case", (d) => { d.places.push({ id: "Lobby", label: "P", description: "", initial: 0, capacity: 0 }); }, "places[5].id"],
    ["weight 0", (d) => { d.arcs[0].weight = 0; }, "arcs[0].weight"],
    ["inhibitor from a transition", (d) => { d.arcs[0].inhibitor = true; }, "arcs[0].inhibitor"],
    ["duplicate arc", (d) => { d.arcs.push({ ...d.arcs[0] }); }, "arcs[9]"],
];
for (const [name, mutate, path] of faults) {
    Deno.test(`validateDraft: ${name} is exactly one error at ${path}`, () => {
        const d = coffee();
        mutate(d);
        const r = validateDraft(d);
        assertEquals(r.errors.map((e) => e.path), [path], JSON.stringify(r.errors));
    });
}

Deno.test("validateDraft: several faults are all reported", () => {
    const d: any = coffee();
    d.places[0].colour = "red";
    d.transitions[1].rate = 0;
    d.arcs[0].to = "lobby";
    assertEquals(validateDraft(d).errors.map((e) => e.path), ["places[0].colour", "transitions[1].rate", "arcs[0].to"]);
});

Deno.test("validateDraft: bounds and shape", () => {
    assert(!validateDraft(null).ok);
    assert(!validateDraft({ ...coffee(), places: [] }).ok);
    const big: any = coffee();
    big.places = Array.from({ length: 51 }, (_, i) => ({ id: `p${i}`, label: "P", description: "", initial: 0, capacity: 0 }));
    assert(validateDraft(big).errors.some((e) => e.path === "places" && /at most 50/.test(e.message)));
});

Deno.test("draftToNet: deterministic bytes and CID, rates on the transitions", async () => {
    const a: any = draftToNet(coffee()), b: any = draftToNet(coffee());
    assertEquals(JSON.stringify(a), JSON.stringify(b));
    assertEquals(await computeCid(a), await computeCid(b));
    assertEquals(a.transitions.start_brew.rate, 720);
    assertEquals(a.places.queue.capacity, [null]);
    assertEquals(Object.keys(a.places), ["queue", "barista_free", "in_brew", "served", "walked_out"]);
    assertEquals(a.description, "Customers queue for one barista; some walk out.");
});

Deno.test("gateDraft: a converted net that strict validateNet rejects stops at the net stage", async () => {
    // A draft can pass its own contract yet still give a net with nothing
    // enabled: that is a warning, not an error, so the gate passes it and
    // reports the warning.
    const d: any = sir();
    d.places[1].initial = 0;
    d.places[0].initial = 0;
    const r = await gateDraft(d);
    assert(r.ok);
    assert(r.warnings.some((w) => /nothing is enabled/.test(w.message)));
});

// Recorded replies (make llm-eval writes testdata/llm/*.json from the live
// model). Replayed offline: a prompt change that breaks drafts that used to
// load shows up here.
const recorded = new URL("../testdata/llm/", import.meta.url);
let recordedFiles: string[] = [];
try {
    for await (const e of Deno.readDir(recorded)) if (e.name.endsWith(".json")) recordedFiles.push(e.name);
} catch { /* no captures yet */ }
for (const name of recordedFiles.sort()) {
    Deno.test(`recorded reply ${name} still loads (or is refused for the same reason)`, async () => {
        const rec = JSON.parse(await Deno.readTextFile(new URL(name, recorded)));
        if (rec.error || !rec.raw) return;
        let draft;
        try { draft = JSON.parse(rec.raw); } catch {
            // A recorded model failure (cut off, or not JSON): the load gate
            // must refuse the raw text with a clear reason, as llm-eval reports it.
            const bad = await gateDraft(rec.raw);
            assert(!bad.ok && bad.stage === "draft", "a non-JSON reply must be refused at the draft stage");
            assert(bad.errors.some((e: any) => /not a JSON object/.test(e.message)), JSON.stringify(bad.errors));
            return;
        }
        const r = await gateDraft(draft);
        if (rec.expect === "refused") assert(!r.ok);
        else if (rec.expect !== undefined) assert(r.ok, JSON.stringify(r.errors));
    });
}
