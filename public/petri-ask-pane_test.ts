import { assert, assertEquals, assertFalse, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    announcement, availableGoals, cardForm, cardModel, changeControl, digestsOf, draftError, editSettings, emptyCanvas, goalCard, isStaleResult,
    notThatText, patchForChange, patchFromEdit, proposalFromDraft, retryingPoster, routeCards, sameEvidence, sendPlan, setRate, toolsInfo, withChange, gateOf,
} from "./petri-ask-pane.js";
import { askState } from "./petri-ask.js";
import { ChatSession } from "./petri-chat.js";
import { modelKey } from "./petri-engine-guard.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { readValues } from "./petri-schema-form.js";
import { applyGate, summarize } from "./petri-problems.js";
import { loadEngine } from "./petri-wasm.js";
import { DRAFT_EXAMPLES, applyDraftProposal, gateDraftResult, requestDraft } from "./petri-draft-ui.js";

const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const goalManifest = JSON.parse(await Deno.readTextFile(new URL("./llm-goal-tools.json", import.meta.url)));
const fullManifest = JSON.parse(await Deno.readTextFile(new URL("./llm-tools.json", import.meta.url)));

/** An SIR net with a sink (recovered) and a rate on each transition: nothing gating, so the recommender says ODE for a net this small. Word ids, so the router can name them. */
function sir() {
    return {
        places: {
            susceptible: { initial: [9], capacity: [0], x: 0, y: 0 }, infected: { initial: [1], capacity: [0], x: 100, y: 0 }, recovered: { initial: [0], capacity: [0], x: 200, y: 0 },
        },
        transitions: { infect: { x: 50, y: 0, rate: 0.1 }, recover: { x: 150, y: 0, rate: 0.05 } },
        arcs: [
            { source: "susceptible", target: "infect", weight: [1] }, { source: "infected", target: "infect", weight: [1] }, { source: "infect", target: "infected", weight: [2] },
            { source: "infected", target: "recover", weight: [1] }, { source: "recover", target: "recovered", weight: [1] },
        ],
    };
}

function session(net: any = sir(), o: any = {}) {
    const live: any = new Registry(createHeadlessHost(net));
    const post = async () => { throw new Error("no model in these tests"); };
    const chat: any = new ChatSession({ live, manifest: goalManifest, allManifest: fullManifest, goals: catalog, post, mode: "analyse", ...o });
    return { chat, live };
}
const runGoal = async (chat: any, goal_id: string, inputs: any, userText = "") => {
    const entry = await chat.runCall({ name: "run_goal", args: { goal_id, inputs: JSON.stringify(inputs) } }, 0, { userText });
    if (!entry.ok) throw new Error(entry.error);
    return entry.result;
};

// ---- what a message does ----

const agent = askState({ enabled: true, chat: true, signed_in: true, remaining_today: 5, toolsets: ["goals"] });
const signedOut = askState({ enabled: true, chat: true, signed_in: false });

Deno.test("sendPlan: the agent when it can be asked, the router when not, Describe for a first build message on an empty canvas, nothing for blank", () => {
    const base = { ask: agent, intent: null, canvasEmpty: false, started: false, text: "  how bad can it get?  " };
    assertEquals(sendPlan(base), { do: "agent", text: "how bad can it get?" });
    assertEquals(sendPlan({ ...base, text: "   " }).do, "nothing");
    assertEquals(sendPlan({ ...base, ask: signedOut }).do, "route");
    // Describe: the canvas is empty, the intent is build, and it is the first message
    assertEquals(sendPlan({ ...base, intent: "build", canvasEmpty: true }).do, "draft");
    // ... not on a net that has something, not for analyse, not once the conversation has started, not when the model cannot be asked
    assertEquals(sendPlan({ ...base, intent: "build", canvasEmpty: false }).do, "agent");
    assertEquals(sendPlan({ ...base, intent: "analyse", canvasEmpty: true }).do, "agent");
    assertEquals(sendPlan({ ...base, intent: "build", canvasEmpty: true, started: true }).do, "agent");
    assertEquals(sendPlan({ ...base, intent: "build", canvasEmpty: true, ask: signedOut }).do, "route");
    // the intent is not known before the message in auto mode (the server labels it in the same call): the agent builds
    assertEquals(sendPlan({ ...base, intent: null, canvasEmpty: true }).do, "agent");
});

Deno.test("emptyCanvas: no places and no transitions", () => {
    assert(emptyCanvas({ places: {}, transitions: {}, arcs: [] }));
    assert(emptyCanvas(undefined));
    assertFalse(emptyCanvas({ places: { A: {} }, transitions: {} }));
    assertFalse(emptyCanvas({ places: {}, transitions: { t: {} } }));
});

Deno.test("retryingPoster: a transient failure is tried once more, the second failure is thrown as it was; 4xx and 429 are not retried", async () => {
    const down = Object.assign(new Error("the model took too long"), { status: 504 });
    let calls = 0;
    const slept: number[] = [];
    const retried: string[] = [];
    const flaky = retryingPoster(async () => { if (++calls === 1) throw down; return { ok: true }; }, { sleep: async (ms: number) => { slept.push(ms); }, onRetry: (e: Error) => retried.push(e.message) });
    assertEquals(await flaky({}), { ok: true });
    assertEquals([calls, slept.length, retried], [2, 1, ["the model took too long"]]);

    calls = 0;
    const dead = retryingPoster(async () => { calls++; throw down; }, { sleep: async () => {} });
    await assertRejects(() => dead({}), Error, "took too long");
    assertEquals(calls, 2, "once more, not forever");

    for (const status of [400, 401, 403, 429]) {
        calls = 0;
        const p = retryingPoster(async () => { calls++; throw Object.assign(new Error("x"), { status, retryAfter: 17 }); }, { sleep: async () => {} });
        await assertRejects(() => p({}));
        assertEquals(calls, 1, `status ${status} is not retried here`);
    }
    // no status at all (the network) is transient
    calls = 0;
    const net = retryingPoster(async () => { if (++calls === 1) throw new TypeError("Failed to fetch"); return 1; }, { sleep: async () => {} });
    assertEquals(await net({}), 1);
});

Deno.test("draftError: a failed draft call is the error askState reads", () => {
    const e = draftError({ error: "daily limit", status: 429, retryAfter: 7200, reset: "2026-11-03T00:00:00Z" });
    assertEquals([e.message, e.status, (e as any).retryAfter, (e as any).reset], ["daily limit", 429, 7200, "2026-11-03T00:00:00Z"]);
    const status = { enabled: true, chat: true, signed_in: true, remaining_today: 3 };
    assertEquals(askState(status, { error: e }).state, "quota");
    assertEquals(askState(status, { error: draftError({ error: "x", status: 500 }) }).state, "upstream");
    assertEquals(askState(status, { error: draftError({ error: "sign in", status: 401 }) }).state, "signed-out");
});

// ---- cards for the router ----

Deno.test("routeCards: the words name a place: the card proposes it as an assumption and fills the form with it; what is missing is the form", () => {
    const model = createHeadlessHost(sir()).getModel();
    const cards = routeCards(catalog, model, "which knob matters for recovered people?");
    const knob = cards.find((c) => c.goal.id === "knob")!;
    assertEquals(knob.inputs, { observable: "recovered" });
    assertEquals(knob.assumed.map((a: any) => a.text), ["the outcome to watch = recovered (taken from your words)"]);
    assert(knob.ready, "the observable is optional, so nothing is missing");
    // the inferred value is in the form as its default, so the select shows it and the person can change it
    assertEquals(knob.form.fields.map((f: any) => [f.name, f.default]), [["observable", "recovered"]]);

    const one = goalCard(catalog.goals.find((g: any) => g.id === "one_more"), model, "");
    assertFalse(one.ready, "one_more needs a place");
    assertEquals(one.missing.map((i: any) => i.name), ["place"]);
    assertEquals(one.form.fields.map((f: any) => f.name), ["place"]);

    // a goal with defaults only needs no form
    const risk = goalCard(catalog.goals.find((g: any) => g.id === "risk"), model);
    assert(risk.ready);
    assertEquals(risk.form.fields, []);
    // best_setting: the transition is required, the max rate has a default and is left out of the form
    const best = goalCard(catalog.goals.find((g: any) => g.id === "best_setting"), model);
    assertEquals(best.form.fields.map((f: any) => f.name), ["transition"]);
});

Deno.test("cardForm: a goal with no form keeps its reason", () => {
    const unavailable = catalog.goals.find((g: any) => g.available === false);
    const c = goalCard(unavailable, createHeadlessHost(sir()).getModel());
    assert(c.form.noForm, "data_match has no form and says why");
    assertEquals(cardForm({ form: { fields: [], noForm: "x" }, missing: [], inputs: {} }).noForm, "x");
});

Deno.test("availableGoals: the cards the empty state offers are the goals that can run here; best_play only for a net that is a game", async () => {
    const ids = availableGoals(catalog).map((g: any) => g.id);
    assert(ids.includes("risk") && ids.includes("stuck"));
    assertFalse(ids.includes("data_match"));
    const sirModel = createHeadlessHost(sir()).getModel();
    assertFalse(availableGoals(catalog, sirModel).some((g: any) => g.id === "best_play"), "not a game: no best play");
    assert(availableGoals(catalog, sirModel).some((g: any) => g.id === "risk"));
    const ttt = JSON.parse(await Deno.readTextFile(new URL("../parity/native/fixtures/game-tic-tac-toe.jsonld", import.meta.url)).catch(() => "null"));
    if (ttt) assert(availableGoals(catalog, createHeadlessHost(ttt).getModel()).some((g: any) => g.id === "best_play"), "a game: best play");
    // the router leaves it out too ("which move is best" on an SIR net)
    assertFalse(routeCards(catalog, sirModel, "which move wins with best play?").some((c) => c.goal.id === "best_play"));
});

// ---- a result as a card ----

Deno.test("cardModel: who said what; 'I answered' and Not that only for a goal the model chose; the engine override and the stray number are chips", async () => {
    const { chat } = session();
    const result = await runGoal(chat, "knob", { observable: "recovered" });
    const asModel = { ...result, pickedBy: "assistant", answer: { by: "assistant", text: "The infection rate matters most.", stray: ["42"] } };
    const m = cardModel(asModel, { catalog, latest: true });
    assertEquals(m.answered, "I answered: “Which setting matters most?”".replace("Which setting matters most?", result.goal.question));
    assert(m.notThat);
    assertEquals(m.answer, { by: "assistant", text: "The infection rate matters most." });
    assert(m.chips.some((c: any) => c.kind === "stray" && c.text === "a number in this reply is not in the results" && c.title.includes("42")));
    // ChatSession's own warning about the same numbers is not a second chip
    const withWarning = cardModel({ ...asModel, warnings: ["The assistant's text has a number that is in none of the results: 42.", "another"] }, { catalog });
    assertEquals(withWarning.chips.map((c: any) => [c.kind, c.text]), [["warn", "another"], ["stray", "a number in this reply is not in the results"]]);
    assertEquals(m.followUps.map((f: any) => f.id), result.followUps.slice(0, 3));
    assert(m.followUps.every((f: any) => f.question.length > 3));
    assertEquals(m.engine?.name, result.record.engine?.name);
    assert(m.caveat.length > 0 && m.answerShape.length > 0, "the caveat and the shape come from the catalogue, not the model");

    // the person ran this card themselves: it is titled by its question and nobody "answered"
    const mine = cardModel({ ...result, pickedBy: "you" }, { catalog, latest: true });
    assertEquals([mine.answered, mine.notThat, mine.answer], ["", false, null]);
    // not the latest turn's: Not that is gone
    assertFalse(cardModel(asModel, { catalog, latest: false }).notThat);
    // no answer, no stray
    assertEquals(cardModel({ ...result, answer: null }, { catalog }).chips.filter((c: any) => c.kind === "stray"), []);

    // an engine override is a chip with the engine's own warning
    const overridden = { ...result, record: { ...result.record, engine: { ...result.record.engine, overridden: true, warning: "ODE on a net with capacity on I; the engine recommends SSA" } }, warnings: ["ODE on a net with capacity on I; the engine recommends SSA"] };
    const o = cardModel(overridden, { catalog });
    assertEquals(o.chips.map((c: any) => c.kind), ["override", "warn"]);
    assert(o.chips[0].title.includes("recommends SSA"));
});

Deno.test("cardModel: the assumptions are the result's, tagged by whose they are, each with the control that changes it", async () => {
    const { chat } = session();
    const result = await runGoal(chat, "knob", {}, "which knob matters for recovered people?");
    const m = cardModel({ ...result, pickedBy: "assistant" }, { catalog });
    const inferred = m.assumed.find((a: any) => a.how === "inferred")!;
    assertEquals([inferred.by, inferred.text], ["engine", "I took the outcome to watch to be recovered."]);
    assertEquals(inferred.change, { kind: "select", input: "observable", options: ["susceptible", "infected", "recovered"], value: "recovered", optional: false });

    // the model's pick on "you decide" is the assistant's, and not the person's to change here
    const decided = cardModel({ ...result, assumed: [{ key: "decided", how: "decided", question: "Which place?", value: "I", text: "You left “Which place?” to me; I took I." }] }, { catalog }).assumed[0];
    assertEquals([decided.by, decided.change], ["assistant", null]);
});

Deno.test("changeControl: a select for a place or a transition, a number box for a number, none for a marking, an edit or a plan's own value", () => {
    assertEquals(changeControl({ how: "inferred", value: "R", change: { input: "observable", kind: "place", options: ["S", "R"] } }), { kind: "select", input: "observable", options: ["S", "R"], value: "R", optional: false });
    assertEquals(changeControl({ how: "unnamed", change: { input: "observable", kind: "place", options: ["S", "R"] } })?.optional, true);
    assertEquals(changeControl({ how: "default", value: 2, change: { input: "max_rate", kind: "number", options: null, default: 2, arg: "to" } }), { kind: "number", input: "max_rate", value: 2 });
    assertEquals(changeControl({ how: "default", change: { input: "max_rate", kind: "number", default: 3 } })?.value, 3);
    assertEquals(changeControl({ how: "inferred", change: { input: "to", kind: "marking" } }), null);
    assertEquals(changeControl({ how: "plan", text: "t_end = 50 from sim.recommend" }), null);
    assertEquals(changeControl({ how: "decided", text: "x" }), null);
    assertEquals(changeControl(undefined), null);
});

Deno.test("isStaleResult: the revision against the net now; a pending result against the sandbox; no key says nothing", () => {
    const r = { record: { net: { revision: "10:abc" } } };
    assertFalse(isStaleResult(r, { liveKey: "10:abc", sandboxKey: "zz" }));
    assert(isStaleResult(r, { liveKey: "11:abd", sandboxKey: "10:abc" }));
    // made on a pending change: the sandbox is the net it ran on
    assertFalse(isStaleResult({ ...r, onPending: true }, { liveKey: "other", sandboxKey: "10:abc" }));
    assert(isStaleResult({ ...r, onPending: true }, { liveKey: "10:abc", sandboxKey: "other" }));
    // the palette's results carry no key (revision 0): never stale
    assertFalse(isStaleResult({ record: { net: { revision: 0 } } }, { liveKey: "10:abc" }));
    assertFalse(isStaleResult({ record: {} }, { liveKey: "10:abc" }));
    assertFalse(isStaleResult(r, {}));
});

Deno.test("isStaleResult: a real result is fresh on the net it ran on and stale after an edit", async () => {
    const { chat, live } = session();
    const result = await runGoal(chat, "average", {});
    const key = () => modelKey(createHeadlessHost(structuredClone(live.host.getModel())).getModel());
    assertFalse(isStaleResult(result, { liveKey: key() }), "the key the pane computes is the key the result carries");
    const edited = structuredClone(live.host.getModel());
    edited.transitions.infect.rate = 0.5;
    live.host.commit(edited, "edit");
    assert(isStaleResult(result, { liveKey: key() }));
});

// ---- Change ----

Deno.test("patchForChange: the plan's own references say which call argument takes the input; a rerun with the patch gives the person's value", async () => {
    const { chat } = session();
    const goal = catalog.goals.find((g: any) => g.id === "knob");
    const result = await runGoal(chat, "knob", { observable: "infected" });
    const patch = patchForChange(result, goal, { input: "observable", kind: "place" }, "recovered")!;
    assertEquals(patch.length, result.record.calls.length);
    const at = result.record.calls.findIndex((c: any) => c.command.startsWith("analysis.diagnose"));
    assertEquals(patch[at], { observable: "recovered" });
    assertEquals(patch.filter((p: any, i: number) => i !== at), patch.map(() => undefined).slice(1), "sim.recommend takes nothing from the input");

    const again = await chat.rerunResult(result, { args: patch });
    assertEquals(again.record.calls[at].args.observable, "recovered");
    assertEquals(result.record.calls[at].args.observable, "infected", "the first result is not touched");
    // the same patch works on a rerun's result, whose steps no longer carry the plan's indices
    const third = patchForChange(again, goal, { input: "observable", kind: "place" }, "susceptible")!;
    assertEquals(third[at], { observable: "susceptible" });
    assertEquals((await chat.rerunResult(again, { args: third })).record.calls[at].args.observable, "susceptible");
});

Deno.test("patchForChange: a number goes in as a number, scaled where the plan scales it; the nested scenario list is not reachable (null)", async () => {
    const { chat } = session();
    const goal = catalog.goals.find((g: any) => g.id === "best_setting");
    const result = await runGoal(chat, "best_setting", { transition: "infect", max_rate: 2 });
    const patch = patchForChange(result, goal, { input: "max_rate", kind: "number" }, "3");
    if (result.record.calls.some((c: any) => c.command === "opt.rate_scan")) {
        const at = result.record.calls.findIndex((c: any) => c.command === "opt.rate_scan");
        assertEquals(patch![at], { to: 3 }, "'3' is read as the number 3");
    } else {
        // on the SSA branch the max rate is inside each scenario's rates: no top-level argument takes it
        assertEquals(patch, null);
    }
    // a transition input reaches opt.rate_scan's transition (ODE branch) and nothing at the top level of sim.compare
    await assertRejects(async () => patchForChange(result, goal, { input: "max_rate", kind: "number" }, "lots"), Error, "not a number");
    // a model the plan has no reference for
    assertEquals(patchForChange(result, goal, { input: "nonesuch", kind: "place" }, "R"), null);
    assertEquals(patchForChange({ record: { calls: [] } }, goal, { input: "x" }, 1), null);
});

Deno.test("patchForChange: a scaled reference ($input.max_rate*0.5) multiplies", () => {
    const goal = { plan: [{ command: "sim.x", args: { a: "$input.m*0.5", b: "$input.m", c: "$input.other", d: 5 } }] };
    const result = { record: { calls: [{ command: "sim.x", args: { a: 1, b: 2, c: "Z", d: 5 } }] } };
    assertEquals(patchForChange(result, goal, { input: "m", kind: "number" }, 10), [{ a: 5, b: 10 }]);
});

Deno.test("withChange: the new result's row and inputs say the person's value; the 'Settings edited' note is dropped from the card (the record keeps it)", async () => {
    const { chat } = session();
    const goal = catalog.goals.find((g: any) => g.id === "knob");
    const result = await runGoal(chat, "knob", {}, "which knob matters for recovered people?");
    const row = result.assumed.find((a: any) => a.how === "inferred");
    const patch = patchForChange(result, goal, row.change, "susceptible")!;
    const again = withChange(await chat.rerunResult(result, { args: patch }), row, "susceptible");
    assertEquals(again.inputs.observable, "susceptible");
    const mine = again.assumed.find((a: any) => a.how === "edited");
    assertEquals(mine.text, "the outcome to watch = susceptible (changed by you)");
    assertFalse(again.assumed.some((a: any) => a.key === "settings"), "no second line saying the same");
    assert(again.record.assumed.some((a: any) => a.key === "settings" && /observable recovered → susceptible/.test(a.text)), "the record still says the settings were edited");
    assertEquals(cardModel(again, { catalog }).assumed.find((a: any) => a.how === "edited").change?.kind, "select", "and it can be changed again");
});

// ---- Rerun ----

Deno.test("sameEvidence: a seeded rerun has the same artifacts by digest; another seed does not", async () => {
    const { chat } = session();
    const result = await runGoal(chat, "risk", {});
    const again = await chat.rerunResult(result);
    assert(result.artifacts.length > 0);
    assertEquals((await digestsOf(result)).length, result.artifacts.length);
    assert(await sameEvidence(result, again), "same calls, same seed: the same bytes");
    const ssa = result.record.calls.findIndex((c: any) => c.command === "sim.ssa");
    const other = await chat.rerunResult(result, { args: { [ssa]: { seed: 99 } } });
    assertFalse(await sameEvidence(result, other));
    assertFalse(await sameEvidence(result, { artifacts: [] }));
});

// ---- Edit settings ----

Deno.test("editSettings: a form per call that has arguments, prefilled from the call; patchFromEdit is what changed", async () => {
    const { chat, live } = session();
    const result = await runGoal(chat, "risk", {});
    const forms = editSettings(result.record, (id: string) => live.describe(id));
    const ssa = forms.find((f) => f.command === "sim.ssa")!;
    assert(ssa, "sim.ssa has arguments");
    assertFalse(forms.some((f) => f.command === "sim.recommend"), "a call with nothing to set has no form");
    const runs = ssa.model.fields.find((f: any) => f.name === "runs");
    assertEquals(runs.default, 20, "prefilled with what it ran with");

    // the form read back unchanged: nothing to patch
    const raw: any = {};
    for (const f of ssa.model.fields) if (f.default !== undefined) raw[f.name] = typeof f.default === "string" ? f.default : JSON.stringify(f.default);
    const values = readValues(ssa.model, raw);
    assertEquals(values.errors, []);
    assertEquals(patchFromEdit(ssa.recorded, ssa.model, values.args), null);
    // runs 20 -> 40, seed blanked
    raw.runs = "40";
    raw.seed = "";
    const edited = readValues(ssa.model, raw);
    assertEquals(patchFromEdit(ssa.recorded, ssa.model, edited.args), { runs: 40, seed: undefined });
    const at = result.record.calls.findIndex((c: any) => c.command === "sim.ssa");
    const again = await chat.rerunResult(result, { args: { [at]: { runs: 40, seed: undefined } } });
    assertEquals(again.record.calls[at].args.runs, 40);
    assertFalse("seed" in again.record.calls[at].args);

    // a command the registry does not know says so
    const odd = editSettings({ calls: [{ command: "nonesuch.cmd", args: { a: 1 } }] }, (id: string) => live.describe(id));
    assertEquals(odd[0].model.noForm, "this command is not known here");
});

// ---- Describe's notes, assumptions and rates ----

Deno.test("proposalFromDraft: the summary and legend are notes, the assumptions and every rate are lines; setRate edits a rate in place", () => {
    const draft = {
        summary: "A coffee shop.", assumptions: ["Customers arrive one at a time."],
        places: [{ id: "queue", label: "Queue", description: "people waiting" }],
        transitions: [{ id: "serve", label: "Serve", description: "a barista serves", rate: 2.5 }, { id: "leave", label: "Leave", description: "gives up", rate: 0.1 }],
    };
    const p = proposalFromDraft(draft);
    assertEquals(p.notes.map((n: any) => [n.kind, n.id ?? null]), [["summary", null], ["place", "queue"], ["transition", "serve"], ["transition", "leave"]]);
    assertEquals(p.assumptions.map((a: any) => a.kind), ["text", "rate", "rate"]);
    assertEquals(p.assumptions[1], { kind: "rate", transition: "serve", label: "Serve", value: 2.5 });

    const set: any = setRate(p, "serve", "4");
    assertEquals(set.value, 4);
    assertEquals(set.proposal.assumptions[1].value, 4);
    assertEquals(p.assumptions[1].value, 2.5, "the proposal given is not changed");
    assertEquals(set.proposal.assumptions[2].value, 0.1);
    for (const bad of ["", "abc", "-1", "NaN", "Infinity"]) assert((setRate(p, "serve", bad) as any).error, `"${bad}" is not a rate`);
    assertEquals(proposalFromDraft({}), { notes: [], assumptions: [] });
});

// ---- the problems gate ----

Deno.test("gateOf: the view's own gate first, in any of its shapes; else the check on the sandbox; the person still decides", async () => {
    const chat: any = { model: () => ({ marker: 1 }), sandbox: { id: "sandbox" } };
    const bad = summarize({ report: { errors: [{ path: "arcs[0]", message: "points nowhere" }], warnings: [] } });
    const P: any = { checkModel: async (_m: any, o: any) => { assertEquals(o.registry, chat.sandbox); return bad; }, applyGate };
    // no hook: petri-problems.js checks the sandbox
    const plain = await gateOf({}, chat, P);
    assertEquals([plain.warn, plain.summary.errors], [true, 1]);
    assert(plain.message.includes("1 error"));
    // a hook answering a summary
    assertEquals((await gateOf({ _problemsGate: async (m: any) => { assertEquals(m, { marker: 1 }); return bad; } }, chat, P)).warn, true);
    // a hook answering the gate alone
    const only = await gateOf({ _problemsGate: () => ({ warn: false, message: "" }) }, chat, { ...P, checkModel: async () => { throw new Error("not asked"); } });
    assertEquals([only.warn, only.summary], [false, null]);
    // a hook answering both
    const both = await gateOf({ _problemsGate: () => ({ summary: bad, gate: { warn: true, message: "look first" } }) }, chat, P);
    assertEquals([both.warn, both.message, both.summary.errors], [true, "look first", 1]);
    // a hook that throws falls back to the check
    assertEquals((await gateOf({ _problemsGate: () => { throw new Error("boom"); } }, chat, P)).warn, true);
    // a clean net does not warn
    const clean = await gateOf({}, chat, { ...P, checkModel: async () => summarize({ report: { errors: [], warnings: [] } }) });
    assertEquals([clean.warn, clean.message], [false, ""]);
});

// ---- the Tools section ----

Deno.test("toolsInfo: the goal toolset's count and the note that points at Tools; the old surface's; signed out; explain", () => {
    const goals = toolsInfo({ toolset: "goals", tools: goalManifest.tools, manifest: goalManifest, runs: 0, state: "agent", shortcut: "⌘K" });
    assertEquals(goals.count, `${goalManifest.tools.length} available, none run yet`);
    assert(goals.note.includes(`The other ${goalManifest.command_index.length} commands`) && goals.note.includes("Tools (⌘K)"), goals.note);
    assert(goals.showRuns);
    assertEquals(toolsInfo({ toolset: "goals", tools: goalManifest.tools, manifest: goalManifest, runs: 3, state: "agent" }).count, `${goalManifest.tools.length} available, 3 run`);

    const all = toolsInfo({ toolset: "all", tools: fullManifest.tools, manifest: fullManifest, runs: 0, state: "agent" });
    assertEquals([all.count, all.note], [`${fullManifest.tools.length} available, none run yet`, ""]);

    const out = toolsInfo({ toolset: "all", tools: fullManifest.tools, manifest: fullManifest, runs: 0, state: "signed-out" });
    assertEquals([out.count, out.note, out.showRuns], [`${fullManifest.tools.length} after sign-in`, "Sign in and the assistant can use these on your net.", false]);
    // a signed-out visitor who ran a card has runs to show
    assert(toolsInfo({ toolset: "goals", tools: goalManifest.tools, manifest: goalManifest, runs: 1, state: "signed-out" }).showRuns);

    const explain = toolsInfo({ toolset: "all", tools: fullManifest.tools.slice(0, 100), manifest: fullManifest, runs: 0, state: "agent", mode: "explain" });
    assert(explain.note.startsWith("Explain mode does not edit"), explain.note);
});

Deno.test("notThatText and announcement", async () => {
    assertEquals(notThatText("how bad can it get? ", "What is the average?"), "how bad can it get?\n\n(Not “What is the average?”: choose a different goal for this.)");
    const { chat } = session();
    const result = await runGoal(chat, "risk", {});
    const a = announcement({ ...result, warnings: ["ran ODE although sim.recommend says SSA"] });
    assert(a.startsWith(`Result: ${result.goal.question}.`) && a.includes("Engine: SSA.") && a.includes("Warning: ran ODE"), a);
    assertEquals(announcement({ title: "Run ODE" }), "Result: Run ODE.");
});

// ---- Describe's call, gate and Apply (petri-draft-ui.js), which the pane and the dialog share ----

/** What fetch answers for /api/llm/draft while fn runs. */
async function withFetch(answer: (url: string, opts: any) => Promise<Response>, fn: () => Promise<void>) {
    const real = globalThis.fetch;
    (globalThis as any).fetch = (u: any, o: any) => answer(String(u), o);
    try { await fn(); } finally { (globalThis as any).fetch = real; }
}
const jsonRes = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.test("requestDraft: the draft comes back; an HTTP failure or a dropped connection is an answer, not an exception", async () => {
    const view = { _authToken: "tok" };
    let seen: any = null;
    await withFetch(async (u, o) => { seen = { u, o }; return jsonRes({ draft: { name: "x" }, remaining_today: 4 }); }, async () => {
        const got: any = await requestDraft(view, "a coffee shop");
        assertEquals([got.ok, got.draft.name, got.remaining_today], [true, "x", 4]);
        assertEquals(seen.u, "/api/llm/draft");
        assertEquals(seen.o.headers.Authorization, "Bearer tok");
        assertEquals(JSON.parse(seen.o.body), { description: "a coffee shop" });
    });
    await withFetch(async () => jsonRes({ error: "daily limit", retry_after_s: 7200, reset: "2026-11-03T06:30:00Z" }, 429), async () => {
        const got: any = await requestDraft(view, "x");
        assertEquals([got.ok, got.status, got.retryAfter, got.reset], [false, 429, 7200, "2026-11-03T06:30:00Z"]);
        assertEquals(got.error, "daily limit Try again in 2 h.");
        // and the pane reads it as the quota
        assertEquals(askState({ enabled: true, chat: true, signed_in: true, remaining_today: 3 }, { error: draftError(got) }).state, "quota");
    });
    await withFetch(async () => jsonRes({}, 500), async () => {
        const got: any = await requestDraft(view, "x");
        assertEquals([got.ok, got.status, got.error], [false, 500, "The request failed (500)."]);
    });
    await withFetch(async () => { throw new TypeError("Failed to fetch"); }, async () => {
        const got: any = await requestDraft(view, "x");
        assertEquals([got.ok, got.aborted, got.status, got.error], [false, false, undefined, "The request failed: Failed to fetch"]);
    });
    await withFetch(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); }, async () => {
        assertEquals(((await requestDraft(view, "x")) as any).aborted, true);
    });
});

Deno.test("gateDraftResult: a good draft passes the load gate with its net; a bad one is refused and listed", async () => {
    const good = {
        name: "Shop", summary: "People queue.", assumptions: ["One at a time."],
        places: [{ id: "queue", label: "Queue", description: "waiting", initial: 0, capacity: 0 }, { id: "done", label: "Done", description: "served", initial: 0, capacity: 0 }],
        transitions: [{ id: "arrive", label: "Arrive", description: "arrives", rate: 1 }, { id: "serve", label: "Serve", description: "served", rate: 2 }],
        arcs: [{ from: "arrive", to: "queue", weight: 1, inhibitor: false }, { from: "queue", to: "serve", weight: 1, inhibitor: false }, { from: "serve", to: "done", weight: 1, inhibitor: false }],
    };
    const ok = await gateDraftResult(good);
    assert(ok.gate.ok, JSON.stringify(ok.gate.errors));
    assertEquals(Object.keys(ok.gate.net.places), ["queue", "done"]);
    assertEquals(ok.issuesHtml, "");
    // the same gate: an id the contract refuses
    const bad = await gateDraftResult({ ...good, places: [{ ...good.places[0], id: "Bad Id" }, good.places[1]] });
    assertFalse(bad.gate.ok);
    assert(bad.issuesHtml.includes("<li><code>") && bad.gate.errors.length > 0);
    // what the pane puts in the pending card is made from the same draft
    assertEquals(proposalFromDraft(good).assumptions.filter((a: any) => a.kind === "rate").map((a: any) => [a.transition, a.value]), [["arrive", 1], ["serve", 2]]);
    assertEquals(DRAFT_EXAMPLES.length, 3);
});

Deno.test("applyDraftProposal: one undo step (the layout takes the commit's place in the history), the notes kept; nothing pending is false", () => {
    const history: string[] = ["empty"];
    const view: any = {
        _history: history,
        _applySugiyamaLayout() { history.push("laid out"); },
        _renderUI() {}, _refit() {}, _syncLD() {},
    };
    const chat: any = { applied: 0, apply() { history.push("committed"); this.applied++; return true; } };
    const notes = { description: "a shop", draft: {}, warnings: [] };
    assert(applyDraftProposal(view, chat, notes));
    assertEquals(history, ["empty", "laid out"], "the grid it began as is not a step of its own");
    assertEquals(view._draftNotes, notes);
    // a layout that changes nothing adds no step, and nothing is squashed
    const h2: string[] = ["empty"];
    const v2: any = { _history: h2, _applySugiyamaLayout() {}, _renderUI() {}, _refit() {}, _syncLD() {} };
    assert(applyDraftProposal(v2, { apply() { h2.push("committed"); return true; } }, notes));
    assertEquals(h2, ["empty", "committed"]);
    // nothing pending: nothing happens
    const v3: any = { _history: ["empty"], _applySugiyamaLayout() { throw new Error("no layout"); } };
    assertFalse(applyDraftProposal(v3, { apply: () => false }, notes));
    assertEquals(v3._draftNotes, undefined);
    // a view with no history array and no layout (a vendored copy) still applies
    assert(applyDraftProposal({}, { apply: () => true }, notes));
});
