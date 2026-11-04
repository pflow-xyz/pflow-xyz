import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ChatSession, GOAL_ANSWER_MAX, ODE_BOUND_RULE } from "./petri-chat.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { ENGINE_OVERRIDES } from "./petri-tools.js";
import { footerHtml, mcpCallText } from "./petri-provenance.js";
import { specFromRecord } from "./petri-viewspec.js";
import { loadEngine } from "./petri-wasm.js";

// The scripted eval of the Ask core (docs/design/agent-first-analysis.md, Step 2): parity/ask/goal-cases.json
// (44 questions on six of the repo's nets) through ChatSession on the goals toolset, with a scripted post() that
// answers each case the way a correct model would: the case's own run_goal call (or an ask_user card, for the six
// ambiguous ones), then a one-line summary.
//
// WHAT THIS PROVES: the plumbing. For every case, in CI, with no model:
//   - the goal's plan ran on the SANDBOX (the live net is untouched, the artifacts are in the editor's store), and
//     ran the engine sim.recommend picked for the net (the case's `engine`);
//   - no step was refused on the expected path, and an engine_override counts only because the case's text names the
//     engine (the same call with words that do not is ignored, and the model is told);
//   - a goal case costs exactly 2 model calls (the tool call, the summary), an ambiguous case 1 (the card);
//   - the result carries a record the footer can draw, copy as an MCP call and turn into a view spec;
//   - the body the server would receive is within its limits (the net summary the case file holds, the toolset);
//   - what goes back to the model after run_goal is compact: under GOAL_ANSWER_MAX, and never the caveat;
//   - an engine override the words earn is still declined when the ODE cannot finish the net (average-3, below).
//
// WHAT IT DOES NOT PROVE: that a model picks the right goal, fills the right inputs or asks when it should. That is
// goal-selection accuracy, measured live with cmd/webserver/llm_goal_eval_test.go (the same cases file):
//
//   PFLOW_LLM_EVAL=1 GEMINI_API_KEY=... go test ./cmd/webserver/ -run TestLLMGoalEvalLive -count=1 -v
//   (PFLOW_LLM_GOAL_EVAL_MODEL=goal PFLOW_LLM_GOAL_MODEL=... to try the cheaper goal model)
//
// Reads (all inside the directories `make test-js` already allows): parity/ask, and the nets' files in parity/ssa,
// parity/native/fixtures and examples/showcase.

const root = (p: string) => new URL(`../${p}`, import.meta.url);
const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const doc = JSON.parse(await Deno.readTextFile(root("parity/ask/goal-cases.json")));
const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const goalManifest = JSON.parse(await Deno.readTextFile(new URL("./llm-goal-tools.json", import.meta.url)));
const fullManifest = JSON.parse(await Deno.readTextFile(new URL("./llm-tools.json", import.meta.url)));

// the server's limits (cmd/webserver/llm_turn.go): a net summary over 24 KB, a body over 256 KB, over 80 messages are refused
const MAX_NET_SUMMARY = 24 << 10;
const MAX_BODY = 256 << 10;

// the goals whose plan never runs the ODE, the SSA or the SDE: their record names no engine
const ENGINE_FREE = new Set(["stuck", "can_happen", "unbounded", "conserved", "same_net", "best_play"]);
// the goals whose plan always runs the SSA, whatever sim.recommend says (a spread, a with-and-without pair of seeded runs)
const ALWAYS_SSA = new Set(["risk", "one_more"]);
// the goals whose plan branches on sim.recommend's engine: the command of the branch each engine gets
const BRANCH: Record<string, Record<string, string>> = {
    average: { ode: "sim.ode", ssa: "sim.ssa" },
    knob: { ode: "analysis.diagnose", ssa: "analysis.diagnose_ssa" },
    best_setting: { ode: "opt.rate_scan", ssa: "sim.compare" },
};

// The one case that asks for the ODE against the recommendation on a net the ODE cannot finish (average-3: "use the
// ODE" on the café, which has inhibitor and read arcs and capacities). Measured: sim.ode on that net takes 7 s for
// t_end 0.5 and does not answer in 70 s for t_end 2 (the step size collapses at the gates), and a running command
// cannot be interrupted. The person's words earn the override, so the guard honours it; ChatSession then tries the
// integration under a budget first (odeFinishes) and declines the step when the trial runs out: the model is told so,
// nothing runs, and the same question without the override is answered by the SSA. The real engine does all of it:
// there is no stand-in. The case is counted in the totals but is not one of the answers whose size is measured.
const ODE_DECLINED = new Set(["average-3"]);

// parity/ssa's files are sim.pflow.xyz's model shape; the editor's is what the registry takes (scripts/gen-goal-cases.mjs's loader)
function simToEditor(m: any) {
    const places: any = {}, transitions: any = {};
    for (const p of m.places) places[p.id] = { initial: [p.initial || 0], capacity: [p.capacity || 0], x: 0, y: 0 };
    for (const t of m.transitions) transitions[t.id] = { x: 0, y: 0, ...(t.rate !== undefined ? { rate: t.rate } : {}) };
    const arcs = m.arcs.map((a: any) => ({ source: a.from, target: a.to, weight: [a.weight || 1], ...(a.type === "inhibitor" ? { inhibit: true } : {}) }));
    return { name: m.name, places, transitions, arcs };
}
async function netOf(name: string) {
    const entry = doc.nets[name];
    const file = JSON.parse(await Deno.readTextFile(root(entry.file)));
    return entry.format === "sim" ? simToEditor(file.model) : file;
}

/** The model of the case file: scripted replies in the Gemini message shape, the bodies it was sent kept. */
function scripted(replies: any[]) {
    const sent: any[] = [];
    const post = async (body: any) => {
        sent.push(structuredClone(body));
        const r = replies.shift() ?? { reply: "done" };
        const parts = [...(r.reply ? [{ text: r.reply }] : []), ...(r.tool_calls || []).map((c: any) => ({ functionCall: { name: c.name, args: c.args || {} } }))];
        return { message: { role: "model", parts: parts.length ? parts : [{ text: "" }] }, remaining_today: 20, ...r };
    };
    return { post, sent };
}

// The case file lists the inputs a scorer requires (llm_goal_eval_test.go tolerates more). On the tic-tac-toe fixture the
// search meets positions where a win claim (x_win_anti) is enabled beside the other side's moves, and game.move refuses
// those unless `auto` names the claims as firing on their own: a correct model passes it too, from the transition names.
// Reported to the integrator: sides and reward alone fail on this net, in the browser.
const ALSO_PASSED: Record<string, any> = { best_play: { auto: ["x_win_", "o_win_"] } };

/** The first accepted call of a case, as the server would hand it over: run_goal with the inputs as JSON in a string. */
function goalCall(c: any, extra: any = {}) {
    const args: any = { goal_id: c.goal };
    const inputs = { ...(c.inputs || {}), ...(ALSO_PASSED[c.goal] || {}) };
    if (Object.keys(inputs).length) args.inputs = JSON.stringify(inputs);
    if (c.engine_override) args.engine_override = c.engine_override;
    return { name: "run_goal", args: { ...args, ...extra } };
}

const sizes: Array<{ id: string; goal: string; bytes: number }> = [];
let goalCases = 0, askCases = 0, modelCalls = 0, declined = 0;

function session(live: any, replies: any[]) {
    const { post, sent } = scripted(replies);
    const chat: any = new ChatSession({ live, manifest: goalManifest, allManifest: fullManifest, goals: catalog, post, mode: "analyse" });
    return { chat, sent };
}

for (const c of doc.cases.filter((x: any) => x.goal !== "ask_user")) {
    Deno.test(`eval ${c.id} (${c.goal} on ${c.net}): "${c.text}"`, async () => {
        goalCases++;
        const goal = catalog.goals.find((g: any) => g.id === c.goal);
        const live: any = new Registry(createHeadlessHost(await netOf(c.net)) as any);
        assertEquals((await live.execute("sim.recommend")).engine, c.engine, "the case file's engine is sim.recommend's");
        const before = JSON.stringify(live.host.getModel());
        const { chat, sent } = session(live, [{ reply: "Running that.", tool_calls: [goalCall(c)] }, { reply: "Here is what the evidence shows." }]);
        const events: any[] = [];
        const out = await chat.send(c.text, (e: any) => events.push(e));
        modelCalls += sent.length;

        if (ODE_DECLINED.has(c.id)) {
            declined++;
            // two model calls as for any goal: the call, and the summary after the refusal
            assertEquals([sent.length, out.rounds], [2, 2]);
            const e = chat.calls[0];
            assertFalse(e.ok);
            assertEquals(e.refused.rule, ODE_BOUND_RULE);
            assert(e.error.startsWith("refused: Not run: the ODE did not finish this net") && e.error.includes("without engine_override"), e.error);
            assertEquals(e.result, undefined, "no result, no answer to quote");
            // the refusal is the tool's answer: the model reads why and what to do
            const told = sent[1].messages.at(-1).parts[0].functionResponse;
            assertEquals(told.name, "run_goal");
            assert(JSON.stringify(told.response).includes("The SSA reads this net exactly"), JSON.stringify(told.response));
            // nothing ran and nothing changed
            assertEquals(live.artifacts().length, 0);
            assertEquals(JSON.stringify(live.host.getModel()), before);
            assertFalse(chat.pending);
            assertEquals(events.filter((x) => x.type === "goal").length, 0, "no result card");
            // the same question without the override: the plan runs what the recommendation says, the SSA
            const control = new ChatSession({ live, manifest: goalManifest, goals: catalog, post: async () => ({}), mode: "analyse" });
            control.messages.push({ role: "user", parts: [{ text: "Show me the typical behaviour of the café." }] });
            const same = await control.runCall(goalCall(c, { engine_override: undefined }));
            assert(same.ok, same.error);
            assertEquals([same.result.record.engine.name, same.result.record.engine.overridden], ["SSA", undefined]);
            return;
        }

        // the call is one the server's manifest accepts
        const declared = goalManifest.tools.find((t: any) => t.name === "run_goal");
        assert(declared.parameters.properties.goal_id.enum.includes(c.goal));
        if (c.engine_override) assert(ENGINE_OVERRIDES.includes(c.engine_override));

        // exactly the tool call and the summary
        assertEquals(sent.length, 2, "two model calls");
        assertEquals(out.rounds, 2);
        assertEquals(out.reply, "Here is what the evidence shows.");
        for (const b of sent) {
            assertEquals([b.toolset, b.mode], ["goals", "analyse"]);
            assert(JSON.stringify(b).length < MAX_BODY, `${JSON.stringify(b).length} bytes`);
            assert(JSON.stringify(b.net).length < MAX_NET_SUMMARY);
            assert(b.messages.length <= 80);
        }
        assertEquals(JSON.parse(JSON.stringify(sent[0].net)), doc.nets[c.net].info, "the editor sends the net.info the case file holds");
        assertEquals(sent[0].messages[0].parts[0].text, c.text);

        // the plan ran on the sandbox: the live net is as it was, the artifacts are in the editor's store
        assertEquals(JSON.stringify(live.host.getModel()), before, "the live net is untouched");
        assertFalse(chat.pending, "a goal edits nothing");
        const entry = chat.calls[0];
        assert(entry.ok, entry.error);
        assertEquals([entry.name, entry.kind, entry.goal.id], ["run_goal", "goal", c.goal]);
        assertEquals(events.filter((e) => e.type === "goal").map((e) => e.entry), [entry]);
        const r = entry.result;
        assertEquals(live.artifacts().length, r.artifacts.length, "the artifacts are in the editor's store (Results shows them)");
        assert(r.artifacts.length > 0, "a goal shows evidence");

        // no refusal on the expected path; every step the plan ran, ran
        assertEquals(entry.refused, undefined);
        assertFalse(r.steps.some((s: any) => s.refused || s.error), JSON.stringify(r.steps.find((s: any) => s.error)));
        const ran = r.steps.filter((s: any) => !s.skipped).map((s: any) => s.command);
        assert(ran.length > 0 && ran.length <= goal.plan.length);
        assertEquals(r.record.calls.map((x: any) => x.command), ran, "the record is the calls that ran");

        // the inputs the case expects reached the plan as given, and none had to be guessed
        for (const [k, v] of Object.entries<any>(c.inputs || {})) assertEquals(r.inputs[k], v, `input ${k}`);
        assertFalse(r.assumed.some((a: any) => a.how === "inferred"), "the model named every input");

        // the engine: the one sim.recommend picked (the SSA for the goals that always run it), or the person's own
        // (and only because the text names it)
        const overrideApplies = c.engine_override === "ode" && ran.includes("sim.ode");
        if (ENGINE_FREE.has(c.goal)) {
            assertEquals(r.record.engine, null, "a plan with no engine step claims no engine");
        } else if (overrideApplies) {
            assertEquals(r.record.engine.name, "ODE");
            assert(r.record.engine.overridden && r.record.engine.warning, "the override is shown, never silent");
            assertEquals(entry.override, "ode");
            assert(r.warnings[0].startsWith("ODE on a net with"), r.warnings[0]);
            assert(r.record.engine.reason.startsWith(`sim.recommend advised ${c.engine.toUpperCase()}`), r.record.engine.reason);
        } else if (ALWAYS_SSA.has(c.goal)) {
            assertEquals(r.record.engine.name, "SSA");
            assertFalse(!!r.record.engine.overridden, "the SSA by design is not an override");
            assertEquals(r.record.engine.warning, undefined);
            if (c.engine === "ode") assert(r.record.engine.reason.includes("by design"), r.record.engine.reason);
        } else {
            assertEquals(r.record.engine.name.toLowerCase(), c.engine, "the engine sim.recommend picked");
            assertFalse(!!r.record.engine.overridden);
            assertEquals(ran.filter((x: string) => Object.values(BRANCH[c.goal]).includes(x)), [BRANCH[c.goal][c.engine]], "the branch of that engine ran, and no other");
        }
        if (overrideApplies) assertEquals(ran.filter((x: string) => x === "sim.ssa").length, 0, "the ODE branch ran instead of the SSA's");
        if (c.engine_override === "sde") {
            assertEquals(entry.override, "sde");
            assertEquals(entry.overrideUnused, "sde", "no goal has an SDE step: said so, not pretended");
            assert(r.warnings.some((w: string) => w.startsWith("You asked for the SDE")));
        }
        if (!c.engine_override) {
            assertEquals([entry.override, entry.overrideIgnored, r.warnings.length], [undefined, undefined, 0]);
        }

        // a result the footer can draw, copy and turn into a link
        const rec = r.record;
        assertEquals([rec.goal.id, rec.caveat, r.caveat], [c.goal, goal.caveat, goal.caveat]);
        assert(/^\d+:/.test(rec.net.revision));
        const html = footerHtml(rec, { open: true });
        assert(html.includes("How this was computed") && html.includes(`<b>${c.goal}</b>`) && ran.every((x: string) => html.includes(x)), "the footer names the goal and every call");
        assert(Array.isArray(JSON.parse(mcpCallText(rec))) || JSON.parse(mcpCallText(rec)).name, "the MCP call parses");
        assertEquals(specFromRecord(rec, { view: c.goal }).calls.length, rec.calls.length);
        assertEquals(r.followUps.length >= 2, true);

        // what the model read back: compact, the engine decision, no caveat
        const back = sent[1].messages.at(-1).parts[0].functionResponse;
        assertEquals(back.name, "run_goal");
        const bytes = JSON.stringify(back.response).length;
        sizes.push({ id: c.id, goal: c.goal, bytes });
        assert(bytes < GOAL_ANSWER_MAX, `${c.id}: ${bytes} bytes`);
        assertFalse(JSON.stringify(back.response).includes(goal.caveat.slice(0, 40)), "the caveat is the interface's");
        assertEquals(back.response.goal, c.goal);
        if (!ENGINE_FREE.has(c.goal)) assertEquals([back.response.engine.name, back.response.engine.overridden], [r.record.engine.name, r.record.engine.overridden]);
        // the model's summary carried no number the evidence lacks
        assertEquals(r.answer, { by: "assistant", text: "Here is what the evidence shows." });
        assertEquals(r.warnings.filter((w: string) => w.includes("none of the results")), []);

        // an engine_override the person's words do not earn is ignored, and the model is told (a control for the above)
        const control = new ChatSession({ live, manifest: goalManifest, goals: catalog, post: async () => ({}), mode: "analyse" });
        control.messages.push({ role: "user", parts: [{ text: c.engine_override ? "Please run it." : c.text }] });
        const same = await control.runCall(goalCall(c, { engine_override: c.engine_override || "ode" }));
        assert(same.ok, same.error);
        assertEquals(same.overrideIgnored, c.engine_override || "ode", "the model's override on its own initiative does not count");
        assertEquals(same.override, undefined);
        assert(same.response.notes.some((n: string) => n.includes("was not applied")));
        if (!ENGINE_FREE.has(c.goal)) assertEquals(same.result.record.engine.name, ALWAYS_SSA.has(c.goal) ? "SSA" : c.engine.toUpperCase(), "the plan ran what the recommendation says");
    });
}

for (const c of doc.cases.filter((x: any) => x.goal === "ask_user")) {
    // what the person would pick, and the goal the answer leads to (the cases are the ambiguous ones, so this is the case author's reading)
    const lead: Record<string, [string, string]> = {
        "ask-1": ["one_more", "place"], "ask-2": ["one_more", "place"], "ask-3": ["best_setting", "transition"],
        "ask-4": ["best_setting", "transition"], "ask-5": ["can_happen", "place"], "ask-6": ["can_happen", "place"],
    };
    Deno.test(`eval ${c.id} (ask_user on ${c.net}): "${c.text}"`, async () => {
        askCases++;
        const info = doc.nets[c.net].info;
        const [goal, kind] = lead[c.id];
        const ids: string[] = (kind === "place" ? info.places : info.transitions).map((x: any) => x.id);
        const options = ids.slice(0, 3);
        const live: any = new Registry(createHeadlessHost(await netOf(c.net)) as any);
        const inputs = goal === "can_happen" ? { to: { [options[0]]: 1 } } : goal === "best_setting" ? { transition: options[0] } : { place: options[0] };
        const { chat, sent } = session(live, [
            { reply: "Which one do you mean?", tool_calls: [{ name: "ask_user", args: { question: "Which one do you mean?", options, default_option: options[0] } }] },
            { tool_calls: [{ name: "run_goal", args: { goal_id: goal, inputs: JSON.stringify(inputs) } }] },
            { reply: "Done." },
        ]);
        const events: any[] = [];
        const first = await chat.send(c.text, (e: any) => events.push(e));

        // exactly one model call, ending on the card; nothing ran
        assertEquals(sent.length, 1);
        modelCalls += 1;
        assertEquals(first.asked.options, options);
        assert(first.asked.options.length >= 2 && first.asked.options.length <= 4);
        assert(first.asked.options.every((o: string) => ids.includes(o)), "the options are the net's own ids");
        assertEquals(events.filter((e) => e.type === "ask").map((e) => e.card), [first.asked]);
        assertEquals(live.artifacts().length, 0, "a question runs nothing");
        assertEquals(chat.calls.map((x: any) => x.name), ["ask_user"]);

        // the answer resumes the loop: the goal runs on the person's pick, in two more calls
        const done = await chat.answer(options[0], (e: any) => events.push(e));
        modelCalls += 2;
        assertEquals(sent.length, 3);
        assertEquals(done.reply, "Done.");
        const r = events.find((e) => e.type === "goal").entry.result;
        assertEquals(r.goal.id, goal);
        assertFalse(r.assumed.some((a: any) => a.how === "decided" || a.how === "inferred"), "the person chose; nothing was assumed for them");
        assertEquals(sent[1].messages.at(-1).parts[0].functionResponse.response, { answer: options[0] });
        assertFalse(chat.pending);
    });
}

Deno.test("eval: the cases are the 44 of the case file, and what they cost in model calls and in bytes back", () => {
    assertEquals(goalCases, doc.cases.filter((c: any) => c.goal !== "ask_user").length);
    assertEquals(askCases, 6);
    assertEquals(goalCases + askCases, doc.cases.length);
    assertEquals(sizes.length, goalCases - declined);
    assertEquals(declined, ODE_DECLINED.size);
    // 2 calls per goal case, 1 per ambiguous case up to the card (and 2 more once answered)
    assertEquals(modelCalls, goalCases * 2 + askCases * 3);
    const bytes = sizes.map((s) => s.bytes).sort((a, b) => a - b);
    const mean = Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length);
    const worst = sizes.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    const perGoal: Record<string, number> = {};
    for (const s of sizes) perGoal[s.goal] = Math.max(perGoal[s.goal] || 0, s.bytes);
    console.log(`goal cases ${goalCases}: ${goalCases * 2} model calls (2 each); ambiguous ${askCases}: 1 each up to the card`);
    console.log(`run_goal answer to the model, JSON characters: min ${bytes[0]}, median ${bytes[bytes.length >> 1]}, mean ${mean}, max ${worst.bytes} (${worst.id}); bound ${GOAL_ANSWER_MAX}`);
    console.log(`largest per goal: ${Object.entries(perGoal).map(([g, b]) => `${g} ${b}`).join(", ")}`);
    assert(worst.bytes < GOAL_ANSWER_MAX);
});
