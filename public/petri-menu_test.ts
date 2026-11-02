import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    findOpenEntry, openTargetFromRecord, parseOpen, prefillModel, resultFromOutcome, showsInline,
} from "./petri-menu.js";
import { buildIndex, outcomeOf, runCommandOutcome, runGoalOutcome } from "./petri-palette.js";
import { formModel, goalFormModel, readValues } from "./petri-schema-form.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { runGoal } from "./petri-goals.js";
import { footerHtml, provenance } from "./petri-provenance.js";
import { loadEngine } from "./petri-wasm.js";
import { bindPaletteKey, isTextFieldTarget } from "./petri-palette-ui.js";

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const sir = () => ({
    places: { S: { initial: [45], capacity: [0], x: 0, y: 0 }, I: { initial: [5], capacity: [0], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
    transitions: { infect: { x: 50, y: 0, rate: 0.01 }, recover: { x: 150, y: 0, rate: 0.1 } },
    arcs: [
        { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
        { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
        { source: "recover", target: "R", weight: [1] },
    ],
});
const registry = () => new Registry(createHeadlessHost(sir()));
const specs: any[] = registry().list();
const index = buildIndex({ specs, goals: catalog, classic: [{ id: "classic.results", title: "Results", open() {} }] });

// ---- the palette's open option ----

Deno.test("parseOpen: an id and plain args; `command` stands for `id`; anything else is null", () => {
    assertEquals(parseOpen({ id: "sim.ssa", args: { runs: 5 } }), { id: "sim.ssa", kind: null, args: { runs: 5 } });
    assertEquals(parseOpen({ command: "sim.ode", args: { t_end: 10 } }), { id: "sim.ode", kind: null, args: { t_end: 10 } }, "a provenance call writes `command`");
    assertEquals(parseOpen({ id: "  sim.ssa  " })?.id, "sim.ssa", "trimmed");
    assertEquals(parseOpen({ id: "risk", kind: "goal" })?.kind, "goal");
    assertEquals(parseOpen({ id: "risk", kind: "nonsense" })?.kind, null);
    for (const bad of [null, undefined, "sim.ssa", 3, [], {}, { id: "" }, { id: "  " }, { id: 5 }, { args: { a: 1 } }]) assertEquals(parseOpen(bad as any), null, JSON.stringify(bad));
    assertEquals(parseOpen({ id: "x", args: [1, 2] })?.args, {}, "args that are not an object are dropped");
    assertEquals(parseOpen({ id: "x", args: "nope" })?.args, {});
});

Deno.test("parseOpen: the args are a copy, so the form cannot change the caller's record", () => {
    const args = { nested: { a: 1 }, list: [1, 2] };
    const p = parseOpen({ id: "x", args })!;
    (p.args as any).nested.a = 99;
    (p.args as any).list.push(3);
    assertEquals(args, { nested: { a: 1 }, list: [1, 2] });
    // values JSON cannot carry are not a crash
    const cyc: any = {};
    cyc.self = cyc;
    assertEquals(parseOpen({ id: "x", args: cyc })?.args, {});
});

Deno.test("findOpenEntry: a command or a goal, never a classic tool, and a command wins a tie", () => {
    assertEquals(findOpenEntry(index, { id: "sim.ssa" })?.kind, "command");
    assertEquals(findOpenEntry(index, { id: "sim.ssa" })?.id, "sim.ssa");
    const goal = catalog.goals[0];
    assertEquals(findOpenEntry(index, { id: goal.id })?.kind, "goal");
    assertEquals(findOpenEntry(index, { id: "classic.results" }), null, "a classic dialog has no form to open");
    assertEquals(findOpenEntry(index, { id: "no.such.command" }), null);
    assertEquals(findOpenEntry(index, null), null);
    assertEquals(findOpenEntry([], { id: "sim.ssa" }), null);
    // a tie: kind decides when given, a command otherwise
    const tie = [{ kind: "goal", id: "dup" }, { kind: "command", id: "dup" }];
    assertEquals(findOpenEntry(tie, { id: "dup" })?.kind, "command");
    assertEquals(findOpenEntry(tie, { id: "dup", kind: "goal" })?.kind, "goal");
    assertEquals(findOpenEntry([{ kind: "goal", id: "only" }], { id: "only", kind: "command" }), null);
});

Deno.test("prefillModel: a command's form opens with the arguments it was run with", () => {
    const spec = specs.find((s) => s.id === "sim.ssa")!;
    const base = formModel(spec.args);
    const { model, ignored } = prefillModel(base, { runs: 5, t_end: 20, seed: 7 });
    const by = (m: any, n: string) => m.fields.find((f: any) => f.name === n);
    assertEquals(by(model, "runs").default, 5);
    assertEquals(by(model, "t_end").default, 20);
    assertEquals(by(model, "seed").default, 7);
    assertEquals(ignored, []);
    // the model it was given is untouched
    assert(by(base, "runs").default !== 5 || spec.args.properties.runs.default === 5);
    assertEquals(model.fields.length, base.fields.length);
    // read back, the filled form gives the same arguments
    const raw: any = {};
    for (const f of model.fields) if (f.default !== undefined) raw[f.name] = f.default;
    const { args, errors } = readValues(model, raw);
    assertEquals(errors, []);
    assertEquals(args.runs, 5);
    assertEquals(args.t_end, 20);
});

Deno.test("prefillModel: a goal's inputs, and arguments the form has no field for are reported, not lost", () => {
    const goal = catalog.goals.find((g: any) => (g.inputs || []).some((i: any) => i.kind === "place"))!;
    const input = goal.inputs.find((i: any) => i.kind === "place");
    const base = goalFormModel(goal);
    const { model, ignored } = prefillModel(base, { [input.name]: "R", mystery: 1 });
    assertEquals(model.fields.find((f: any) => f.name === input.name).default, "R");
    assertEquals(ignored, ["mystery"]);
    // required stays required: the value is a default, not a decision
    assertEquals(model.fields.find((f: any) => f.name === input.name).required, base.fields.find((f: any) => f.name === input.name).required);
    // an unavailable goal has no form, and stays that way
    const none = prefillModel({ fields: [], noForm: "not here" }, { a: 1 });
    assertEquals(none.model.noForm, "not here");
    assertEquals(none.ignored, ["a"]);
    assertEquals(prefillModel(base, undefined as any).ignored, []);
    assertEquals(prefillModel(null as any, { a: 1 }).model.fields, []);
});

Deno.test("openTargetFromRecord: the first call, with its arguments", () => {
    const rec = provenance({ calls: [{ command: "sim.recommend", args: {} }, { command: "sim.ssa", args: { t_end: 42, runs: 20, seed: 1 } }] });
    assertEquals(openTargetFromRecord(rec), { id: "sim.recommend", kind: "command", args: {} });
    const one = provenance({ calls: [{ command: "sim.ssa", args: { t_end: 42, runs: 20, seed: 1 } }] });
    assertEquals(openTargetFromRecord(one), { id: "sim.ssa", kind: "command", args: { t_end: 42, runs: 20, seed: 1 } });
    assertEquals(openTargetFromRecord(provenance({})), null, "no call");
    assertEquals(openTargetFromRecord(null), null);
    assertEquals(openTargetFromRecord({ calls: [{}] } as any), null);
    // what it hands back opens: it parses, and names a command the registry has
    const t = openTargetFromRecord(one)!;
    assertEquals(parseOpen(t)?.id, "sim.ssa");
    assert(findOpenEntry(index, t));
});

// ---- the hand-over to the results pane ----

Deno.test("showsInline: only a run that failed outright stays in the palette", () => {
    assertEquals(showsInline({ error: "x: bad", calls: [], artifacts: [] }), true);
    assertEquals(showsInline({ error: "x: bad", calls: [{ command: "a", args: {} }], artifacts: [] }), false, "a step ran");
    assertEquals(showsInline({ error: "x: bad", calls: [], artifacts: ["a1"] }), false, "something was stored");
    assertEquals(showsInline({ error: null, calls: [], artifacts: [] }), false, "no error");
    assertEquals(showsInline(undefined as any), false);
});

Deno.test("resultFromOutcome: a command run becomes a result with the artifact object and a one-call record", async () => {
    const reg = registry();
    const outcome = await runCommandOutcome(reg, "sim.ssa", { t_end: 10, runs: 3, seed: 1 }, { title: "Run SSA" });
    assertEquals(outcome.error, null);
    assert(outcome.artifacts.length >= 1);
    const r = await resultFromOutcome(outcome, { registry: reg, net: { cid: "zb2rhExample", revision: "rev1" } });
    assertEquals(r.source, "palette");
    assertEquals(r.title, "Run SSA");
    assertEquals(r.goal, null);
    assertEquals(r.answer, null, "nothing here is model text");
    assertEquals(r.stale, false);
    assert(r.registry === reg);
    assertEquals(r.artifacts.length, outcome.artifacts.length);
    for (const a of r.artifacts) assert(a && typeof a === "object" && typeof a.id === "string" && a.data, "an artifact OBJECT, not an id");
    assertEquals(r.artifacts.map((a: any) => a.id), outcome.artifacts);
    assertEquals(r.record.calls, [{ command: "sim.ssa", args: { t_end: 10, runs: 3, seed: 1 } }]);
    assertEquals(r.record.goal, null);
    assertEquals(r.record.net, { cid: "zb2rhExample", revision: "rev1" });
    assertEquals(r.warnings, []);
    // the pane draws a footer from the record: the call is in it
    assert(footerHtml(r.record).includes("sim.ssa"));
});

Deno.test("resultFromOutcome: a goal run keeps its goal, its resolved calls and what it assumed", async () => {
    const reg = registry();
    const goal = catalog.goals.find((g: any) => g.id === "risk") || catalog.goals.find((g: any) => g.available !== false && !(g.inputs || []).some((i: any) => !i.optional && i.default === undefined))!;
    const inputs: any = {};
    for (const i of goal.inputs || []) if (i.kind === "place") inputs[i.name] = "I";
    const outcome = await runGoalOutcome(reg, goal, inputs, runGoal);
    const r = await resultFromOutcome(outcome, { registry: reg, net: { revision: "r" } });
    assertEquals(r.source, "palette");
    assertEquals(r.goal, { id: goal.id, question: goal.question });
    assertEquals(r.title, goal.question);
    assertEquals(r.record.goal, { id: goal.id, question: goal.question });
    assertEquals(r.record.calls.map((c: any) => c.command), outcome.calls.map((c: any) => c.command));
    assert(r.record.calls.length >= 1);
    assertEquals(r.record.caveat, goal.caveat);
    assertEquals(r.artifacts.map((a: any) => a.id), outcome.artifacts);
    // a goal whose plan the engine guard refused is a result with the refusal in its warnings, not a crash
    assert(Array.isArray(r.warnings));
});

Deno.test("resultFromOutcome: an error becomes a warning, and a vanished artifact is skipped", async () => {
    const reg = registry();
    const outcome = outcomeOf({
        kind: "command", title: "Run SSA",
        steps: [{ index: 0, command: "sim.ssa", args: { t_end: 1 }, error: "boom", artifacts: [] }],
    });
    assertEquals(outcome.error, "sim.ssa: boom");
    const r = await resultFromOutcome(outcome, { registry: reg });
    assertEquals(r.warnings, ["sim.ssa: boom"]);
    assertEquals(r.record.calls, [{ command: "sim.ssa", args: { t_end: 1 } }], "the call the person made is what Open in Tools reopens");
    assert(r.record.warnings.includes("sim.ssa: boom"));
    // an artifact id the registry no longer has
    const gone = { ...outcome, error: null, artifacts: ["a-does-not-exist"] };
    const r2 = await resultFromOutcome(gone, { registry: reg });
    assertEquals(r2.artifacts, []);
    // an artifact lookup that throws
    const r3 = await resultFromOutcome({ ...gone }, { registry: { artifact: () => { throw new Error("evicted"); } } as any });
    assertEquals(r3.artifacts, []);
    // nothing at all in the outcome: a record with no calls, a title, no crash
    const r4 = await resultFromOutcome({} as any, { registry: reg });
    assertEquals(r4.record.calls, []);
    assertEquals(r4.title, "Result");
    assertEquals(r4.artifacts, []);
});

Deno.test("resultFromOutcome: the record's first call opens a form filled with what was run", async () => {
    const reg = registry();
    const outcome = await runCommandOutcome(reg, "sim.ssa", { t_end: 12, runs: 4, seed: 9 }, { title: "Run SSA" });
    const r = await resultFromOutcome(outcome, { registry: reg });
    const t = openTargetFromRecord(r.record)!;
    const entry = findOpenEntry(index, t)!;
    assertEquals(entry.kind, "command");
    const spec = specs.find((s) => s.id === entry.id)!;
    const { model, ignored } = prefillModel(formModel(spec.args), parseOpen(t)!.args);
    assertEquals(ignored, []);
    const raw: any = {};
    for (const f of model.fields) if (f.default !== undefined) raw[f.name] = f.default;
    const back = readValues(model, raw);
    assertEquals(back.errors, []);
    assertEquals(back.args, { t_end: 12, runs: 4, seed: 9 }, "Open in Tools, then Run, repeats the call");
});

// ---- how the editor reaches the palette ----

Deno.test("bindPaletteKey: installed once per view and document, and the chord goes through view._openPalette", async () => {
    const listeners: any[] = [];
    const doc: any = {
        addEventListener: (_t: string, fn: any) => listeners.push(fn),
        removeEventListener: (_t: string, fn: any) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    };
    const opened: any[] = [];
    const view = { _openPalette: async (o: any) => { opened.push(o); } };
    const unbind = bindPaletteKey(view, doc);
    const again = bindPaletteKey(view, doc);
    assertEquals(listeners.length, 1, "a second call adds no second listener (it would toggle the palette shut again)");
    assert(unbind === again, "and hands back the same unbind");
    const chord = { key: "k", ctrlKey: true, target: { tagName: "BODY" }, defaultPrevented: false, preventDefault() {} };
    listeners[0](chord);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(opened.length, 1, "the chord opened it through the view");
    // another view on the same document is its own binding
    const other = { _openPalette: async () => {} };
    bindPaletteKey(other, doc);
    assertEquals(listeners.length, 2);
    unbind();
    assertEquals(listeners.length, 1);
    const rebound = bindPaletteKey(view, doc);
    assertEquals(listeners.length, 2, "after unbind it can be bound again");
    rebound();
});

Deno.test("isTextFieldTarget: a field that asks for the chord (the Ask input) is not a text field to it", () => {
    assertEquals(isTextFieldTarget({ target: { tagName: "INPUT", type: "text", dataset: { paletteKey: "ok" } } }), false);
    assertEquals(isTextFieldTarget({ target: { tagName: "INPUT", type: "text", dataset: {} } }), true);
    assertEquals(isTextFieldTarget({ target: { tagName: "TEXTAREA", dataset: { paletteKey: "no" } } }), true, "only 'ok' opts out");
});
