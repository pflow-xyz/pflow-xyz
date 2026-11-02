import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    buildIndex, isPaletteChord, outcomeOf, prefixLabel, previewJson, runCommandOutcome, runGoalOutcome,
    searchIndex, shortcutHint, stepActive, stepHeadline, trapTarget,
} from "./petri-palette.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { runGoal } from "./petri-goals.js";
import { loadEngine } from "./petri-wasm.js";
import { bindPaletteKey, classicTools, isTextFieldTarget } from "./petri-palette-ui.js";

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
// sim.what_if and the other pflow-native commands run in the vendored wasm (as petri-goals_test.ts loads it).
const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });
const specs: any[] = new Registry(createHeadlessHost()).list();
const classic = [
    { id: "classic.structure", title: "Structure (invariants, verify, reach)", keywords: ["invariants", "siphons"], open() {} },
    { id: "classic.workbench", title: "Simulate (stochastic, influence, what-if)", open() {} },
    { id: "classic.results", title: "Results", subtitle: "Every result this session", open() {} },
];
const index = buildIndex({ specs, goals: catalog, classic });
const ids = (xs: any[]) => xs.map((e) => e.id);
const find = (id: string) => index.find((e: any) => e.id === id)!;

// The fixture every goal runs on: SIR with rates (as petri-goals_test.ts).
const sir = () => ({
    places: { S: { initial: [45], capacity: [0], x: 0, y: 0 }, I: { initial: [5], capacity: [0], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
    transitions: { infect: { x: 50, y: 0, rate: 0.01 }, recover: { x: 150, y: 0, rate: 0.1 } },
    arcs: [
        { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
        { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
        { source: "recover", target: "R", weight: [1] },
    ],
});

// ---- the index ----

Deno.test("buildIndex: goals first in catalog order, then commands by prefix, then the classic tools", () => {
    const kinds = index.map((e: any) => e.kind);
    const nGoals = catalog.goals.length;
    assertEquals(kinds.slice(0, nGoals), Array(nGoals).fill("goal"));
    assertEquals(ids(index.slice(0, nGoals)), catalog.goals.map((g: any) => g.id));
    assertEquals(kinds.slice(nGoals, nGoals + specs.length), Array(specs.length).fill("command"));
    assertEquals(ids(index.slice(-3)), classic.map((c) => c.id));
    assertEquals(index.length, nGoals + specs.length + classic.length);
    // commands: prefix order, then id
    const cmds = index.filter((e: any) => e.kind === "command");
    const keys = cmds.map((e: any) => [e.subgroup, e.id]);
    assertEquals(keys, [...keys].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    assertEquals(new Set(cmds.map((e: any) => e.subgroup)).size, 18, "eighteen prefixes in the registry today");
});

Deno.test("buildIndex: entries carry the contract's fields", () => {
    for (const e of index) {
        for (const k of ["kind", "id", "title", "subtitle", "group", "keywords", "form", "noFormReason"]) assert(k in e, `${e.id}.${k}`);
        assert(e.title, e.id);
        assert(Array.isArray(e.keywords));
        assertEquals(typeof e.form, "boolean");
        assertEquals(e.form, e.noFormReason === null, e.id);
    }
    // a goal: titled by its question, grouped by it
    const stuck = find("stuck");
    assertEquals([stuck.kind, stuck.title, stuck.group, stuck.section], ["goal", "Can it get stuck?", "Can it get stuck?", "Questions"]);
    assertEquals(stuck.subtitle, "analysis.verify · analysis.siphons");
    assert(stuck.keywords.includes("deadlock"));
    // a command: the registry label as the title, the id as the subtitle, under All commands by prefix
    const ssa = find("sim.ssa");
    assertEquals([ssa.kind, ssa.title, ssa.subtitle, ssa.group, ssa.subgroup], ["command", "Run SSA", "sim.ssa", "All commands", "sim"]);
    assertEquals(ssa.form, true);
    // a classic tool: under Classic tools, no form, and it says why
    const c = find("classic.results");
    assertEquals([c.kind, c.title, c.subtitle, c.group, c.form, c.noFormReason], ["classic", "Results", "Every result this session", "Classic tools", false, "opens its own dialog"]);
    assertEquals(find("classic.structure").subtitle, "Classic tool");
});

Deno.test("buildIndex: unavailable commands and ones a goal covers stay listed, flagged", () => {
    for (const id of ["view.fit", "view.highlight", "view.clear_highlight"]) {
        assertEquals(find(id).available, false, id);
        assert(index.includes(find(id)));
    }
    assertEquals(find("sim.ssa").available, true);
    assertEquals(find("analysis.verify").coveredBy, ["stuck", "unbounded"]);
    assertEquals(find("sim.ssa").coveredBy, ["risk"]);
    assert(find("sim.recommend").coveredBy.length >= 4);
    assertEquals(find("net.add_place").coveredBy, []);
    // a covered command finds its goal's words
    assert(find("sim.ssa").keywords.includes("worst case"));
    // a goal that is not available here has no form and says why
    const data = find("data_match");
    assertEquals([data.available, data.form], [false, false]);
    assertEquals(data.noFormReason, catalog.goals.find((g: any) => g.id === "data_match").caveat);
    assert(data.subtitle.includes("Not in the browser"));
});

Deno.test("buildIndex: every exposed command has a form or an explicit reason (the live registry)", () => {
    const cmds = index.filter((e: any) => e.kind === "command");
    assertEquals(cmds.length, specs.length);
    assertEquals(ids(cmds).sort(), specs.map((s) => s.id).sort(), "no command lost, none added");
    for (const e of cmds) {
        assert(e.form === true || (typeof e.noFormReason === "string" && e.noFormReason.length > 0), `${e.id} has neither a form nor a reason`);
    }
    assert(specs.length >= 130);
});

Deno.test("buildIndex: the catalog or its goals array, no goals, no classic", () => {
    assertEquals(ids(buildIndex({ specs, goals: catalog.goals })), ids(buildIndex({ specs, goals: catalog })));
    assertEquals(buildIndex({ specs }).filter((e: any) => e.kind !== "command"), []);
    assertEquals(buildIndex(), []);
    assertEquals(buildIndex({ specs: [{ id: "x", args: { type: "object", properties: {}, required: [] } }] }).map((e: any) => [e.title, e.subgroup]), [["x", ""]], "no label: the id; no dot: no prefix");
    const bad = buildIndex({ specs: [{ id: "a.b", label: "B", args: undefined }] })[0];
    assertEquals([bad.form, typeof bad.noFormReason], [false, "string"]);
    assertEquals(prefixLabel("sim"), "Simulate");
    assertEquals(prefixLabel("zed"), "Zed");
    assertEquals(prefixLabel(""), "Other");
});

Deno.test("buildIndex: the same set in any order gives the same commands in the same order", () => {
    const shuffled = [...specs].reverse();
    const a = buildIndex({ specs, goals: catalog, classic });
    const b = buildIndex({ specs: shuffled, goals: catalog, classic });
    assertEquals(ids(a), ids(b));
    // and a query ranks them the same
    assertEquals(ids(searchIndex(a, "sim")), ids(searchIndex(b, "sim")));
});

// ---- search ----

Deno.test("searchIndex: an empty query is the whole index in order", () => {
    assertEquals(searchIndex(index, ""), index);
    assertEquals(searchIndex(index, "   "), index);
    assertEquals(searchIndex(index, undefined as any), index);
    assert(searchIndex(index, "") !== index, "a copy");
    assertEquals(ids(searchIndex(index, "").slice(0, 3)), ["stuck", "can_happen", "unbounded"]);
    assertEquals(searchIndex(index, "", { limit: 5 }).length, 5);
});

Deno.test("searchIndex: 'stoch' finds sim.ssa and the risk goal", () => {
    const hits = ids(searchIndex(index, "stoch"));
    assert(hits.includes("sim.ssa"), hits.join());
    assert(hits.includes("risk"), hits.join());
    assert(hits.includes("sim.sde") || hits.includes("sim.what_if"));
    assert(hits.indexOf("risk") < 15 && hits.indexOf("sim.ssa") < 15);
});

Deno.test("searchIndex: 'engine' finds sim.recommend first", () => {
    const hits = ids(searchIndex(index, "engine"));
    assertEquals(hits[0], "sim.recommend");
    assertEquals(ids(searchIndex(index, "ENGINE")), hits, "case does not matter");
});

Deno.test("searchIndex: a typo, a missing letter or a skeleton still finds it", () => {
    for (const q of ["recomend", "recommned", "recommand", "sim.recomend", "rcmnd", "recommend engin", "wich engine", "whcih engine"]) {
        const hits = ids(searchIndex(index, q));
        assertEquals(hits[0], "sim.recommend", `${q} -> ${hits.slice(0, 3)}`);
    }
    assertEquals(ids(searchIndex(index, "deadlok"))[0], "stuck", "a typo in a goal's phrase finds the goal");
    // and noise finds nothing
    assertEquals(searchIndex(index, "zzzqqq"), []);
    assertEquals(searchIndex(index, "xq"), []);
});

Deno.test("searchIndex: ids, labels, help and phrases all match", () => {
    assertEquals(ids(searchIndex(index, "sim.ssa"))[0], "sim.ssa", "a whole id");
    assertEquals(ids(searchIndex(index, "sim.ss"))[0], "sim.ssa", "part of an id");
    assertEquals(ids(searchIndex(index, "run ssa"))[0], "sim.ssa", "the label");
    assert(ids(searchIndex(index, "gillespie")).includes("sim.ssa"), "a word only the help has");
    assertEquals(ids(searchIndex(index, "deadlock"))[0], "stuck", "a goal's phrase");
    assertEquals(ids(searchIndex(index, "worst case"))[0], "risk", "the goal ahead of the command it runs");
    assert(ids(searchIndex(index, "worst case")).includes("sim.ssa"));
    assert(ids(searchIndex(index, "event log")).some((id: string) => id.startsWith("data.")), "a prefix's name");
    // classic tools are searchable
    assertEquals(ids(searchIndex(index, "invariants")).filter((id: string) => id.startsWith("classic.")), ["classic.structure"]);
    assertEquals(ids(searchIndex(index, "structure"))[0], "classic.structure");
});

Deno.test("searchIndex: a spoken question finds its goal", () => {
    const first = (q: string) => ids(searchIndex(index, q))[0];
    assertEquals(first("can it get stuck?"), "stuck");
    assertEquals(first("what if I had one more barista"), "one_more");
    assertEquals(first("which knob matters most"), "knob");
    assertEquals(first("how bad can it get"), "risk");
    // a word about the person's own net, or one the catalog does not know: the rest of the question still finds the goal
    assertEquals(first("can it get stuck forever"), "stuck");
    assertEquals(first("one more barista"), "one_more");
    // two words must both match
    assertEquals(searchIndex(index, "stuck barista"), []);
    // a stop word alone is still a query
    assert(searchIndex(index, "what is it").length >= 0);
});

Deno.test("searchIndex: deterministic, and ties keep index order", () => {
    for (const q of ["sim", "engine", "stoch", "net", "a", "model"]) {
        assertEquals(ids(searchIndex(index, q)), ids(searchIndex(index, q)), q);
    }
    // equal matches: the field with fewer words first ("sim.ssa" before "sim.set_rate"), then the index's order (prefix, id)
    const sim = searchIndex(index, "sim").filter((e: any) => e.id.startsWith("sim.")).map((e: any) => e.id);
    const words = (id: string) => id.split(/[^a-z0-9]+/).length;
    assertEquals(sim, [...sim].sort((a, b) => words(a) - words(b) || (a < b ? -1 : a > b ? 1 : 0)));
    assertEquals(ids(searchIndex(index, "ssa")).slice(0, 2), ["sim.ssa", "analysis.diagnose_ssa"], "the shorter id first");
    assertEquals(searchIndex(index, "stoch", { limit: 3 }).length, 3);
    // the goal is ahead of a command that matches no better
    const both = ids(searchIndex(index, "average"));
    assert(both.indexOf("average") < both.indexOf("sim.ode") || !both.includes("sim.ode"));
});

// ---- keyboard ----

Deno.test("stepActive: arrows wrap, the pages stop at the ends, an empty list has no row", () => {
    assertEquals(stepActive(0, -1, "ArrowDown"), -1);
    assertEquals(stepActive(5, -1, "ArrowDown"), 0);
    assertEquals(stepActive(5, 4, "ArrowDown"), 0);
    assertEquals(stepActive(5, 0, "ArrowUp"), 4);
    assertEquals(stepActive(5, -1, "ArrowUp"), 4);
    assertEquals(stepActive(5, 2, "ArrowUp"), 1);
    assertEquals([stepActive(20, 7, "Home"), stepActive(20, 7, "End")], [7, 7], "the caret keys are the search box's");
    assertEquals([stepActive(20, 7, "PageDown"), stepActive(20, 15, "PageDown"), stepActive(20, 3, "PageUp")], [15, 19, 0]);
    assertEquals(stepActive(5, 2, "a"), 2);
});

Deno.test("trapTarget: Tab wraps at the ends and otherwise lets the browser move", () => {
    assertEquals(trapTarget(0, -1, false), null);
    assertEquals(trapTarget(4, 3, false), 0);
    assertEquals(trapTarget(4, 0, true), 3);
    assertEquals(trapTarget(4, 1, false), null);
    assertEquals(trapTarget(4, 2, true), null);
    assertEquals([trapTarget(4, -1, false), trapTarget(4, -1, true)], [0, 3], "focus that escaped is brought back");
    assertEquals(trapTarget(1, 0, false), 0);
});

Deno.test("isPaletteChord: Cmd-K or Ctrl-K, nothing else", () => {
    assert(isPaletteChord({ key: "k", metaKey: true }));
    assert(isPaletteChord({ key: "K", ctrlKey: true }));
    assert(!isPaletteChord({ key: "k" }));
    assert(!isPaletteChord({ key: "k", ctrlKey: true, metaKey: true }));
    assert(!isPaletteChord({ key: "k", ctrlKey: true, shiftKey: true }));
    assert(!isPaletteChord({ key: "k", ctrlKey: true, altKey: true }));
    assert(!isPaletteChord({ key: "j", ctrlKey: true }));
    assert(!isPaletteChord({ ctrlKey: true }));
    assert(!isPaletteChord(null));
    assertEquals(shortcutHint(true), { text: "⌘K", aria: "Meta+K" });
    assertEquals(shortcutHint(false), { text: "Ctrl K", aria: "Control+K" });
});

// ---- running ----

Deno.test("outcomeOf: calls are the steps that ran and succeeded; artifacts and warnings are deduplicated", () => {
    const o = outcomeOf({
        kind: "goal", title: "T", goal: { id: "g" }, inputs: { a: 1 },
        steps: [
            { index: 0, command: "a", args: { x: 1 }, result: {}, artifacts: ["a1"] },
            { index: 1, command: "b", skipped: "only when" },
            { index: 2, command: "c", args: {}, result: {}, artifacts: ["a1", "a2"] },
            { index: 3, command: "d", args: { y: 2 }, error: "nope" },
        ],
        warnings: ["w", new Error("w"), "v"],
    });
    assertEquals(o.calls, [{ command: "a", args: { x: 1 } }, { command: "c", args: {} }]);
    assertEquals(o.artifacts, ["a1", "a2"]);
    assertEquals(o.error, "d: nope");
    assertEquals(o.warnings, ["w", "v"]);
    assertEquals([o.kind, o.title, o.goal, o.inputs], ["goal", "T", { id: "g" }, { a: 1 }]);
    const ok = outcomeOf({ kind: "command", title: "x" });
    assertEquals([ok.calls, ok.steps, ok.artifacts, ok.error, ok.warnings, ok.goal], [[], [], [], null, [], null]);
});

Deno.test("runCommandOutcome: a command's result, its artifacts and its call", async () => {
    const reg: any = new Registry(createHeadlessHost(sir()));
    const o = await runCommandOutcome(reg, "sim.ode", { t_end: 5 }, { title: "Run ODE" });
    assertEquals([o.kind, o.title, o.error, o.goal], ["command", "Run ODE", null, null]);
    assertEquals(o.calls, [{ command: "sim.ode", args: { t_end: 5 } }]);
    assertEquals(o.artifacts.length, 1);
    assertEquals(reg.artifact(o.artifacts[0]).source.command, "sim.ode");
    assertEquals(o.steps[0].artifacts, o.artifacts);
    // a command with no artifact still has its result
    const m = await runCommandOutcome(reg, "sim.marking", {});
    assertEquals([m.artifacts, m.error, m.title], [[], null, "sim.marking"]);
    assert(m.steps[0].result);
});

Deno.test("runCommandOutcome: a refusal is an error in the outcome, not an exception", async () => {
    const reg: any = new Registry(createHeadlessHost(sir()));
    const bad = await runCommandOutcome(reg, "sim.fire", { id: "nope" });
    assertEquals(bad.calls, []);
    assert(bad.error!.startsWith("sim.fire: "), bad.error!);
    const wrong = await runCommandOutcome(reg, "sim.ssa", { runs: 9999 });
    assert(wrong.error!.includes("must be ≤ 200"), wrong.error!);
    const unknown = await runCommandOutcome(reg, "no.such", {});
    assert(unknown.error!.includes("unknown command"));
    // the net is untouched by a refused edit
    assertEquals(Object.keys(reg.host.getModel().places).length, 3);
});

Deno.test("runCommandOutcome: an edit changes the net as one undo step", async () => {
    const reg: any = new Registry(createHeadlessHost(sir()));
    const o = await runCommandOutcome(reg, "net.add_place", { x: 5, y: 5, id: "Z" });
    assertEquals(o.error, null);
    assert(reg.host.getModel().places.Z);
    assert((await runCommandOutcome(reg, "edit.undo", {})).error === null);
    assert(!reg.host.getModel().places.Z);
});

Deno.test("runGoalOutcome: a goal runs through runGoal and the outcome names the calls it made", async () => {
    const reg: any = new Registry(createHeadlessHost(sir()));
    const goal = catalog.goals.find((g: any) => g.id === "risk");
    const seen: string[] = [];
    const o = await runGoalOutcome(reg, goal, {}, runGoal, (s: any) => seen.push(s.command));
    assertEquals(seen, ["sim.recommend", "sim.ssa"]);
    assertEquals([o.kind, o.title, o.goal, o.error], ["goal", "How bad can it get? What's the spread?", goal, null]);
    assertEquals(o.calls.map((c: any) => c.command), ["sim.recommend", "sim.ssa"]);
    assertEquals(o.calls[1].args.runs, 20);
    assertEquals(o.calls[1].args.seed, 1);
    assert(o.artifacts.length >= 1);
    assert(o.steps.every((s: any) => !s.error));
    assertEquals(o.warnings, []);

    // inputs reach the plan
    const more = await runGoalOutcome(reg, catalog.goals.find((g: any) => g.id === "one_more"), { place: "I" }, runGoal);
    assertEquals(more.error, null);
    assertEquals(more.inputs, { place: "I" });
    assertEquals(more.calls.find((c: any) => c.command === "sim.what_if")!.args.place, "I");
});

Deno.test("runGoalOutcome: a goal that cannot run, a missing input and a failing step are errors in the outcome", async () => {
    const reg: any = new Registry(createHeadlessHost(sir()));
    const data = await runGoalOutcome(reg, catalog.goals.find((g: any) => g.id === "data_match"), {}, runGoal);
    assert(data.error!.includes("Not in the browser"));
    assertEquals(data.steps, []);
    const need = await runGoalOutcome(reg, catalog.goals.find((g: any) => g.id === "one_more"), {}, runGoal);
    assert(need.error!.startsWith("needs "), need.error!);
    const failing = await runGoalOutcome(reg, catalog.goals.find((g: any) => g.id === "one_more"), { place: "nope" }, runGoal);
    assert(failing.error!.startsWith("sim.what_if: "), failing.error!);
    assertEquals(failing.calls.map((c: any) => c.command), ["sim.recommend"]);
    // a guard that refuses, and warnings a runner reports, come through
    const guarded = await runGoalOutcome(reg, { question: "Q", plan: [] }, {}, async () => ({ ok: false, steps: [], error: "the engine guard refused sim.ode" }));
    assertEquals(guarded.error, "the engine guard refused sim.ode");
    const warned = await runGoalOutcome(reg, { question: "Q", plan: [] }, {}, async () => ({ ok: true, warnings: ["capacity: the ODE ignores it"], steps: [{ index: 0, command: "x", args: {}, warnings: [new Error("slow")] }] }));
    assertEquals(warned.warnings, ["capacity: the ODE ignores it", "slow"]);
    assertEquals((await runGoalOutcome(reg, { question: "Q", plan: [] }, {}, async () => ({ ok: false, steps: [] }))).error, "the plan stopped");
});

Deno.test("stepHeadline and previewJson", () => {
    assertEquals(stepHeadline({ result: { why: "because", summary: "s" } }), "because");
    assertEquals(stepHeadline({ result: { summary: "s" } }), "s");
    assertEquals(stepHeadline({ result: { verdict: "bounded" } }), "bounded");
    assertEquals(stepHeadline({ result: { answer: 42 } }), "answer: 42");
    assertEquals(stepHeadline({ result: { answer: { a: 1 } } }), "");
    assertEquals([stepHeadline({}), stepHeadline(null), stepHeadline({ result: "x" })], ["", "", ""]);
    assertEquals(previewJson({ a: 1 }), '{\n  "a": 1\n}');
    assertEquals(previewJson(undefined), "");
    assert(previewJson("x".repeat(100), 10).endsWith("more characters)"));
    const cyc: any = {};
    cyc.self = cyc;
    assertEquals(typeof previewJson(cyc), "string");
});

// ---- the dialog's pure edges (petri-palette-ui.js); the dialog itself needs a DOM and is checked in Chrome ----

Deno.test("classicTools: the dialogs this view has, each opening its own", () => {
    const opened: string[] = [];
    const view = {
        _openStructureDialog: () => opened.push("structure"), _showResultsDialog: () => opened.push("results"),
        _openGoals: () => opened.push("goals"), _notADialog: () => {},
    };
    const tools = classicTools(view);
    assertEquals(tools.map((t: any) => t.id), ["classic.structure", "classic.results", "classic.goals"]);
    assertEquals(tools.map((t: any) => t.title), ["Structure (invariants, verify, reach)", "Results", "What do you want to know?"]);
    tools.forEach((t: any) => t.open());
    assertEquals(opened, ["structure", "results", "goals"]);
    assertEquals(classicTools({}), [], "an older petri-view.js with none of them");
    assertEquals(classicTools(null), []);
    // and they index as Classic tools
    const idx = buildIndex({ specs, goals: catalog, classic: tools });
    assertEquals(idx.filter((e: any) => e.kind === "classic").length, 3);
});

Deno.test("isTextFieldTarget: text fields yes, buttons and checkboxes no, through shadow roots too", () => {
    const on = (t: any) => isTextFieldTarget({ target: t });
    assert(on({ tagName: "TEXTAREA" }));
    assert(on({ tagName: "INPUT", type: "text" }));
    assert(on({ tagName: "INPUT", type: "search" }));
    assert(on({ tagName: "INPUT" }), "no type is text");
    assert(on({ tagName: "INPUT", type: "number" }));
    assert(on({ tagName: "DIV", isContentEditable: true }));
    assert(!on({ tagName: "INPUT", type: "checkbox" }));
    assert(!on({ tagName: "INPUT", type: "button" }));
    assert(!on({ tagName: "BODY" }));
    assert(!isTextFieldTarget({}));
    assert(isTextFieldTarget({ target: { tagName: "BODY" }, composedPath: () => [{ tagName: "INPUT", type: "text" }] }));
});

Deno.test("bindPaletteKey: the chord opens it, other keys and text fields are left alone, unbind removes it", async () => {
    let handler: any = null;
    const doc: any = {
        addEventListener: (type: string, fn: any) => { assertEquals(type, "keydown"); handler = fn; },
        removeEventListener: (type: string, fn: any) => { assertEquals([type, fn], ["keydown", handler]); handler = null; },
    };
    const asked: string[] = [];
    const toasts: string[] = [];
    // a view with no registry: opening fails after asking for it, and says so
    const view = { commands: async () => { asked.push("commands"); throw new Error("no registry here"); }, _toast: (m: string) => toasts.push(m) };
    const unbind = bindPaletteKey(view, doc);
    assert(handler, "a keydown handler is installed");
    const press = (e: any) => {
        const ev = { key: "k", ctrlKey: true, target: { tagName: "BODY" }, defaultPrevented: false, ...e, prevented: false, preventDefault() { this.prevented = true; } };
        handler(ev);
        return ev;
    };
    const settle = () => new Promise((r) => setTimeout(r, 20));

    assertEquals(press({ key: "j" }).prevented, false, "another key");
    assertEquals(press({ key: "k", ctrlKey: false }).prevented, false, "no modifier");
    assertEquals(press({ shiftKey: true }).prevented, false, "another chord");
    assertEquals(press({ target: { tagName: "INPUT", type: "text" } }).prevented, false, "typing in a text field");
    assertEquals(press({ target: { tagName: "TEXTAREA" } }).prevented, false, "typing in a textarea");
    assertEquals(press({ defaultPrevented: true }).prevented, false, "someone else took it");
    await settle();
    assertEquals(asked, [], "nothing opened for any of those");

    assertEquals(press({ target: { tagName: "BODY" } }).prevented, true, "the chord on the page");
    assertEquals(press({ key: "K", metaKey: true, ctrlKey: false, target: { tagName: "INPUT", type: "checkbox" } }).prevented, true, "Cmd-K, from a checkbox");
    await settle();
    assertEquals(asked.length >= 1, true, "it asked the view for the registry");
    assert(toasts.every((m) => m === "Tools are not available here: no registry here"), toasts.join());
    assert(toasts.length >= 1);

    unbind();
    assertEquals(handler, null);
});
