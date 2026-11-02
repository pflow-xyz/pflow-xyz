import { assert, assertEquals, assertFalse, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ChatSession, GOAL_ANSWER_MAX, diffNets, goalAnswer, isEdit, isGoalManifest, prepareGoalInputs, toolsFor } from "./petri-chat.js";
import { artifactDigest } from "./petri-viewspec.js";
import { panelFrame } from "./petri-panel-frame.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { buildManifest, commandId, decodeCall, summarizeResult, toolName } from "./petri-tools.js";
import { loadEngine } from "./petri-wasm.js";

// The engine guard's tests run native commands (analysis.diagnose, sim.what_if): the wasm engine, as petri-goals_test.ts loads it.
const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const manifest = JSON.parse(await Deno.readTextFile(new URL("./llm-tools.json", import.meta.url)));

Deno.test("tools: public/llm-tools.json is what the registry generates (run scripts/gen-llm-tools.mjs)", () => {
    const host: any = createHeadlessHost();
    host.capabilities = new Set(["view"]);
    assertEquals(buildManifest(new (Registry as any)(host).list()), manifest);
});

Deno.test("tools: names map to command ids and back", () => {
    for (const t of manifest.tools) {
        assertEquals(commandId(t.name), t.command);
        assertEquals(toolName(t.command), t.name);
        assert(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(t.name), t.name);
    }
    assert(!manifest.tools.some((t: any) => t.command === "file.load_json"));
});

Deno.test("tools: Gemini's schema subset (no unions, no additionalProperties)", () => {
    const walk = (s: any, path: string) => {
        assert(!Array.isArray(s.type), `${path}: union type`);
        assert(!("additionalProperties" in s), `${path}: additionalProperties`);
        if (s.type === "object") for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${path}.${k}`);
        if (s.items) walk(s.items, `${path}[]`);
    };
    for (const t of manifest.tools) if (t.parameters) walk(t.parameters, t.name);
});

Deno.test("tools: JSON-string arguments are parsed back", () => {
    const [id, args] = decodeCall(manifest, { name: "analysis_reach", args: { to: '{"R": 10}' } });
    assertEquals(id, "analysis.reach");
    assertEquals(args, { to: { R: 10 } });
});

Deno.test("tools: long series go back to the model compacted", () => {
    const art = { id: "a1", title: "ODE", data: { kind: "timeseries", x_label: "time", x: [...Array(600).keys()], series: [{ name: "S", values: [...Array(600).keys()].map((i) => 600 - i) }] } };
    const s: any = summarizeResult({ final: { S: 1 } }, [art]);
    assertEquals(s.artifacts[0].series[0].values, { n: 600, first: 600, last: 1, min: 1, max: 600 });
    assert(JSON.stringify(s).length < 600);
});

// ---- the loop ----

function sir() {
    return {
        places: { S: { initial: [9], capacity: [0], x: 0, y: 0 }, I: { initial: [1], capacity: [0], x: 100, y: 0 } },
        transitions: { infect: { x: 50, y: 0 } },
        arcs: [{ source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] }, { source: "infect", target: "I", weight: [2] }],
    };
}

/** A scripted model: each call returns the next reply; records what it was sent. */
function scripted(replies: any[]) {
    const sent: any[] = [];
    const post = async (body: any) => {
        sent.push(structuredClone(body));
        const r = replies.shift() ?? { reply: "done", tool_calls: [] };
        return { message: { role: "model", parts: [{ text: r.reply || "" }] }, remaining_today: 9, ...r };
    };
    return { post, sent };
}

const live = (): any => new Registry(createHeadlessHost(sir()));

Deno.test("chat: an edit is a preview until applied, then one undo step", async () => {
    const reg = live();
    const { post, sent } = scripted([
        { reply: "Adding recovery.", tool_calls: [
            { name: "net_add_place", args: { x: 200, y: 0, id: "R", label: "Recovered" } },
            { name: "net_add_transition", args: { x: 150, y: 0, id: "recover", rate: 0.1 } },
            { name: "net_add_arc", args: { source: "I", target: "recover" } },
            { name: "net_add_arc", args: { source: "recover", target: "R" } },
        ] },
        { reply: "Checked.", tool_calls: [{ name: "analysis_check", args: {} }] },
        { reply: "Done: R collects recovered people.", tool_calls: [] },
    ]);
    const chat = new ChatSession({ live: reg, manifest, post, mode: "build" });
    const out = await chat.send("add recovery");
    assertEquals(out.reply, "Done: R collects recovered people.");
    assertEquals(out.rounds, 3);
    assert(chat.pending);
    assertEquals(Object.keys(reg.host.getModel().places), ["S", "I"]); // live untouched
    const d = chat.diff();
    assertEquals(d.added, ["place R", "transition recover"]);
    assertEquals(d.arcsAdded.length, 2);
    // the check ran on the sandbox, so it saw the edits
    const check = chat.calls.find((c: any) => c.command === "analysis.check");
    assert(check.ok && check.result.ok);
    // the function responses went back in order, with the edit note
    const toolTurn = sent[1].messages[sent[1].messages.length - 1];
    assertEquals(toolTurn.parts.filter((p: any) => p.functionResponse).length, 4);
    assert(toolTurn.parts[0].functionResponse.response.note.includes("sandbox"));
    // build mode: the engine's behaviour checks follow the edit round
    assert(toolTurn.parts.some((p: any) => typeof p.text === "string" && p.text.startsWith("Checks after your edits")));
    // the net summary sent with round 2 already shows the sandbox's edits
    assertEquals(sent[1].net.places.map((p: any) => p.id), ["S", "I", "R"]);

    assert(chat.apply());
    assertEquals(Object.keys(reg.host.getModel().places), ["S", "I", "R"]);
    assertEquals(reg.host.getModel().transitions.recover.rate, 0.1);
    reg.host.undo();
    assertEquals(Object.keys(reg.host.getModel().places), ["S", "I"]); // one step
});

Deno.test("chat: discard drops the sandbox; explain mode refuses edits", async () => {
    const reg = live();
    const { post } = scripted([{ tool_calls: [{ name: "net_add_place", args: { x: 0, y: 0 } }] }, { reply: "ok" }]);
    const chat = new ChatSession({ live: reg, manifest, post, mode: "build" });
    await chat.send("add a place");
    assert(chat.pending);
    chat.discard();
    assert(!chat.pending && chat.diff().empty);

    const s2 = scripted([{ tool_calls: [{ name: "net_add_place", args: { x: 0, y: 0 } }] }, { reply: "ok" }]);
    const ex = new ChatSession({ live: reg, manifest, post: s2.post, mode: "explain" });
    await ex.send("what is S?");
    assert(!ex.calls[0].ok && /explain mode does not edit/.test(ex.calls[0].error));
    assert(!ex.pending);
});

Deno.test("chat: native commands that edit the net or the marking count as edits (explain mode refuses them)", async () => {
    const reg = live();
    const edits = [["sim_run", {}], ["file_open_example", { name: "sir" }], ["net_layout", { algorithm: "grid" }], ["file_seal", {}],
        ["data_calibrate", { log: "a1", apply: true }], ["opt_fit", { data: "a1", apply: true }]];
    for (const [name, args] of edits) {
        const s = scripted([{ tool_calls: [{ name, args }] }, { reply: "ok" }]);
        const ex = new ChatSession({ live: reg, manifest, post: s.post, mode: "explain" });
        await ex.send("go");
        assert(!ex.calls[0].ok && /explain mode does not edit/.test(ex.calls[0].error), String(name));
    }
    // without apply, opt.fit only reads (it fails here for want of data, not for editing)
    const s = scripted([{ tool_calls: [{ name: "opt_fit", args: { data: "a1" } }] }, { reply: "ok" }]);
    const ex = new ChatSession({ live: reg, manifest, post: s.post, mode: "explain" });
    await ex.send("go");
    assert(!/explain mode does not edit/.test(String(ex.calls[0].error)));
});

Deno.test("chat: tool errors and server refusals go back to the model as errors", async () => {
    const reg = live();
    const { post, sent } = scripted([
        { tool_calls: [{ name: "sim_fire", args: { id: "nope" } }], refused: [{ name: "rm_rf", reason: "not a tool of this editor" }] },
        { reply: "sorry" },
    ]);
    const chat = new ChatSession({ live: reg, manifest, post });
    await chat.send("fire nope");
    const parts = sent[1].messages[sent[1].messages.length - 1].parts;
    assert(/not a place or transition/.test(parts[0].functionResponse.response.error));
    assertEquals(parts[1].functionResponse.response.error, "refused: not a tool of this editor");
});

Deno.test("chat: analyses land in the editor's artifact store; the loop stops at maxRounds", async () => {
    const reg = live();
    const loop = Array.from({ length: 10 }, () => ({ tool_calls: [{ name: "sim_ode", args: { t_end: 1 } }] }));
    const { post } = scripted(loop);
    const chat = new ChatSession({ live: reg, manifest, post, maxRounds: 3 });
    const out = await chat.send("run it forever");
    assertEquals(out.rounds, 3);
    assert(out.stopped);
    assertEquals(reg.artifacts().length, 3); // shared store
    assert(!chat.pending); // runs are not edits
});

Deno.test("diffNets: rates, markings and arcs", () => {
    const a: any = sir(), b: any = sir();
    b.transitions.infect.rate = 2;
    b.places.S.initial = [8];
    b.arcs.pop();
    const d = diffNets(a, b);
    assertEquals(d.changed, ["place S: initial [9] → [8]", "transition infect: rate null → 2"]);
    assertEquals(d.arcsRemoved, ["infect → I ×[2]"]);
});

Deno.test("chat: auto labels the first round, then the tool loop runs in the chosen mode", async () => {
    const reg = live();
    const { post, sent } = scripted([
        { reply: "Looking.", mode: "explain", auto: { mode: "explain", sentiment: "confused", confidence: 0.9 }, tool_calls: [
            { name: "net_add_place", args: { x: 0, y: 50, id: "Z" } },
        ] },
        { reply: "I did not edit.", tool_calls: [] },
    ]);
    const chat = new ChatSession({ live: reg, manifest, post, mode: "auto" });
    const events: any[] = [];
    await chat.send("what is S?", (e: any) => events.push(e));
    assertEquals(sent[0].mode, "auto");
    assertEquals(sent[0].prev_mode, undefined);
    assertEquals(sent[1].mode, "explain"); // later rounds carry the resolved mode
    assertEquals(events.find((e) => e.type === "auto").sentiment, "confused");
    // explain never edits, even though the model asked
    const add = chat.calls.find((c: any) => c.name === "net_add_place");
    assert(!add.ok && add.error.includes("explain mode does not edit"));
    // the next message labels again and tells the server where the conversation was
    await chat.send("ok");
    assertEquals(sent[2].mode, "auto");
    assertEquals(sent[2].prev_mode, "explain");
});

Deno.test("chat: auto stays read-only until the server has labelled a message", () => {
    const chat = new ChatSession({ live: live(), manifest, post: async () => ({}), mode: "auto" });
    assertEquals(chat.effectiveMode, "analyse");
});

Deno.test("panel frame: stops above the run bar, below the editor's top chrome", () => {
    assertEquals(panelFrame({ visibleTop: 0, visibleHeight: 664, barTop: 606 }), { top: 64, height: 534, short: false });
});

Deno.test("panel frame: with no run bar showing, stops at the bottom of what can be seen", () => {
    assertEquals(panelFrame({ visibleTop: 0, visibleHeight: 664 }), { top: 64, height: 592, short: false });
});

Deno.test("panel frame: a keyboard takes the bottom; the run bar under it no longer matters, and the top chrome gives way", () => {
    assertEquals(panelFrame({ visibleTop: 0, visibleHeight: 300, barTop: 606 }), { top: 8, height: 284, short: true });
});

Deno.test("panel frame: follows the browser panning the page to the box", () => {
    assertEquals(panelFrame({ visibleTop: 90, visibleHeight: 300, barTop: 606 }), { top: 98, height: 284, short: true });
    // the bar scrolled off above what can be seen does not count either
    assertEquals(panelFrame({ visibleTop: 90, visibleHeight: 300, barTop: 40 }), { top: 98, height: 284, short: true });
});

Deno.test("panel frame: never a negative height", () => {
    assertEquals(panelFrame({ visibleTop: 0, visibleHeight: 10 }).height, 0);
});

Deno.test("chat: the tools a mode can use, as the panel counts them", async () => {
    const manifest = JSON.parse(await Deno.readTextFile(new URL("./llm-tools.json", import.meta.url)));
    const commands = (mode: string) => toolsFor(manifest, mode).map((t: any) => t.command);
    for (const mode of ["auto", "build", "analyse"]) assertEquals(commands(mode).length, manifest.tools.length, mode);
    const explain = commands("explain");
    assert(explain.length > 0 && explain.length < manifest.tools.length);
    for (const edit of ["net.add_place", "sim.fire", "edit.undo", "file.new"]) assert(!explain.includes(edit), edit);
    for (const read of ["net.info", "analysis.check", "sim.ode", "view.highlight"]) assert(explain.includes(read), read);
});

Deno.test("chat: a short 429 after tools ran is waited out and retried with the same messages (no 'continue' needed)", async () => {
    const reg = live();
    const replies: any[] = [{ tool_calls: [{ name: "analysis_verify", args: { properties: [{ kind: "deadlock-free" }] } }] }, "limit", { reply: "Deadlock-free." }];
    const sent: any[] = [];
    const post = async (body: any) => {
        sent.push(structuredClone(body));
        const r = replies.shift();
        if (r === "limit") throw Object.assign(new Error("too many requests; slow down (try again in 17 s)"), { status: 429, retryAfter: 17 });
        return r;
    };
    const slept: number[] = [];
    const events: any[] = [];
    const chat = new ChatSession({ live: reg, manifest, post, mode: "analyse", sleep: async (ms: number) => { slept.push(ms); } });
    const out = await chat.send("is it safe?", (e: any) => events.push(e));
    assertEquals(out.reply, "Deadlock-free.");
    assertEquals(slept, [18000]);
    assert(events.some((e) => e.type === "wait" && e.seconds === 17));
    // the retry carries the tool result the failed call was about to send
    assertEquals(sent[2].messages.length, sent[1].messages.length);
    assertEquals(chat.calls.length, 1, "the tool did not run twice");
});

Deno.test("chat: a daily 429 (hours) is not waited out", async () => {
    const post = async () => { throw Object.assign(new Error("daily limit"), { status: 429, retryAfter: 7200 }); };
    const chat = new ChatSession({ live: live(), manifest, post, mode: "analyse", sleep: async () => { throw new Error("must not sleep"); } });
    let err: any;
    try { await chat.send("hi"); } catch (e) { err = e; }
    assertEquals(err?.status, 429);
});

// ---- the engine guard in front of the model's tool calls ----
//
// The live-test failure: analysis.diagnose ran the ODE although sim.recommend
// said SSA. A tool call that names a command the net's recommendation rules
// out is refused as the tool's answer, so the model reads why.

const rated = (net: any) => { net.transitions.infect.rate = 0.1; return net; };
const gatedNet = () => { const n: any = rated(sir()); n.places.I.capacity = [5]; return n; }; // 10 tokens + a capacity: Rule 1
const smallNet = () => rated(sir()); // 10 tokens, nothing gating: Rule 2
const largeNet = () => { const n: any = rated(sir()); n.places.S.initial = [900]; n.places.I.initial = [100]; return n; };

/** What every registry executes while fn runs. */
async function recording(fn: () => Promise<void>) {
    const ids: string[] = [];
    const real = (Registry as any).prototype.execute;
    (Registry as any).prototype.execute = function (id: string, a: any) { ids.push(id); return real.call(this, id, a); };
    try { await fn(); } finally { (Registry as any).prototype.execute = real; }
    return ids;
}

Deno.test("chat guard: a command the net's recommendation rules out is refused, and the refusal reaches the model", async () => {
    const reg: any = new Registry(createHeadlessHost(gatedNet()));
    const { post, sent } = scripted([
        { reply: "Running the ODE.", tool_calls: [{ name: "sim_ode", args: { t_end: 5 } }, { name: "analysis_diagnose", args: { observable: "I" } }] },
        { reply: "The ODE would misread this net; I need the SSA." },
    ]);
    const chat = new ChatSession({ live: reg, manifest, post, mode: "analyse" });
    const out = await chat.send("simulate this");
    assertEquals(out.reply, "The ODE would misread this net; I need the SSA.");
    for (const entry of chat.calls) {
        assertEquals(entry.ok, false, entry.command);
        assert(entry.error.startsWith("refused: "), entry.error);
        assert(entry.refused.rule.includes("docs/engine-selection.md Rule 1"), entry.refused.rule);
        assertEquals(entry.refused.recommended, "ssa");
        assertEquals(entry.artifacts, []);
    }
    assertEquals(reg.artifacts().length, 0, "nothing ran");
    assertEquals(chat.model().places.S.initial, [9]);
    // what the model reads back
    const answers = sent[1].messages.at(-1).parts.map((p: any) => p.functionResponse);
    assertEquals(answers.map((a: any) => a.name), ["sim_ode", "analysis_diagnose"]);
    for (const a of answers) {
        const e = a.response.error;
        assert(e.startsWith("refused: "), e);
        assert(e.includes("capacity on I") && e.includes("Nothing ran") && e.includes("Rule 1") && e.includes("SSA"), e);
        // the plain tools have no override: final, and the person's other doors are named
        assert(e.includes("no override") && e.includes("classic dialogs") && !e.includes("engine_override"), e);
    }
    assert(answers[1].response.error.includes("analysis.diagnose_ssa"));
});

Deno.test("chat guard: the soft rule runs sim.ode with a warning the model is told to repeat, and refuses the ranking", async () => {
    const reg: any = new Registry(createHeadlessHost(smallNet()));
    const { post, sent } = scripted([
        { tool_calls: [{ name: "sim_ode", args: { t_end: 5 } }, { name: "analysis_diagnose", args: { observable: "I" } }, { name: "analysis_diagnose_ssa", args: { observable: "I", runs: 4, noise: false } }] },
        { reply: "done" },
    ]);
    const chat = new ChatSession({ live: reg, manifest, post, mode: "analyse" });
    await chat.send("how does it go?");
    const [ode, diag, ssa] = chat.calls;
    assert(ode.ok && ode.warning.startsWith("ODE on a net where the engine recommends SSA"), ode.warning);
    assertEquals(ode.artifacts.length, 1);
    assertEquals(diag.ok, false);
    assert(diag.refused.rule.includes("Rule 2") && diag.error.includes("analysis.diagnose_ssa"));
    assert(ssa.ok && ssa.warning === undefined, "the SSA twin is not held to anything");
    const answers = sent[1].messages.at(-1).parts.map((p: any) => p.functionResponse.response);
    assert(answers[0].warning.includes("the engine recommends SSA") && answers[0].warning.includes("Say so"), answers[0].warning);
    assert(answers[1].error.startsWith("refused: "));
    assertEquals(answers[2].warning, undefined);
});

Deno.test("chat guard: a large unconstrained net runs the ODE commands without a word", async () => {
    const reg: any = new Registry(createHeadlessHost(largeNet()));
    const { post } = scripted([{ tool_calls: [{ name: "sim_ode", args: { t_end: 5 } }, { name: "analysis_diagnose", args: { observable: "I", noise: false } }] }, { reply: "done" }]);
    const chat = new ChatSession({ live: reg, manifest, post, mode: "analyse" });
    await chat.send("how does it go?");
    for (const c of chat.calls) assert(c.ok && c.warning === undefined && c.refused === undefined, `${c.command}: ${c.error}`);
    assertEquals(chat.calls.map((c: any) => c.artifacts.length > 0), [true, true]);
});

Deno.test("chat guard: sim.recommend runs once per net revision, and again after the sandbox is edited", async () => {
    const reg: any = new Registry(createHeadlessHost(gatedNet()));
    const chat = new ChatSession({ live: reg, manifest, post: async () => ({}), mode: "build" });
    const asks = async (n: number) => (await recording(async () => { for (let i = 0; i < n; i++) await chat.runCall({ name: "sim_ode", args: {} }); })).filter((id) => id === "sim.recommend").length;
    assertEquals(await asks(3), 1);
    assert(chat.calls.every((c: any) => c.refused));
    // an edit in the sandbox (the capacity goes) is a new revision; so does the next one
    const ids = await recording(async () => {
        await chat.runCall({ name: "net_set_place", args: { id: "I", capacity: 0 } });
        const v = await chat.runCall({ name: "sim_ode", args: { t_end: 2 } });
        assert(v.ok && v.warning.includes("ODE on a net where"), `${v.error}`); // 10 tokens, nothing gating now
        await chat.runCall({ name: "sim_ode", args: { t_end: 3 } });
    });
    assertEquals(ids.filter((id) => id === "sim.recommend").length, 1);
    assert(chat.pending);
    assertEquals(chat.model().places.I.capacity, [Infinity], "the sandbox lost its capacity");
    assertEquals(reg.host.getModel().places.I.capacity, [5], "the live net is untouched until Apply");
});

Deno.test("chat guard: unguarded commands never trigger a recommend call", async () => {
    const reg: any = new Registry(createHeadlessHost(gatedNet()));
    const chat = new ChatSession({ live: reg, manifest, post: async () => ({}), mode: "analyse" });
    const ids = await recording(async () => {
        for (const c of [{ name: "net_info", args: {} }, { name: "sim_ssa", args: { t_end: 2 } }, { name: "analysis_diagnose_ssa", args: { observable: "I", runs: 2, noise: false } },
            { name: "sim_what_if", args: { place: "I", runs: 2, t_end: 2 } }, { name: "sim_marking", args: {} }, { name: "sim_recommend", args: {} }]) {
            const e = await chat.runCall(c);
            assert(e.ok, `${c.name}: ${e.error}`);
        }
    });
    assertEquals(ids.filter((id) => id === "sim.recommend").length, 1, "only the model's own call");
});

Deno.test("chat guard: the model can pass an override, but it counts only when the person's last message names the engine", async () => {
    const reg: any = new Registry(createHeadlessHost(gatedNet()));
    const chat = new ChatSession({ live: reg, manifest, post: async () => ({}), mode: "analyse" });
    const say = (text: string) => chat.messages.push({ role: "user", parts: [{ text }] });
    const call = { name: "sim_ode", args: { t_end: 2 } };

    say("run the ODE on it, I know what I'm doing");
    const yes = await chat.runCall(call, 1, { override: "ode", canOverride: true });
    assert(yes.ok, yes.error);
    assertEquals(yes.warning, "ODE on a net with capacity on I; the engine recommends SSA");
    assertEquals(yes.override, "ode");
    assertEquals(yes.artifacts.length, 1);
    assert((chat._responseFor(yes).response as any).warning.startsWith("ODE on a net with capacity on I"));

    // the next message does not name it: the model's override on its own initiative is ignored, and it is told how it works
    say("and now the rest");
    const no = await chat.runCall(call, 1, { override: "ode", canOverride: true });
    assertEquals(no.ok, false);
    assert(no.error.includes("was not applied") && no.error.includes('engine_override: "ode"') && no.error.includes("names the engine"), no.error);
    // no override passed, though the person named the engine: still refused
    say("use the ODE");
    assertEquals((await chat.runCall(call, 1)).ok, false);
    // an override for another engine does not unlock it
    assertEquals((await chat.runCall(call, 1, { override: "sde", canOverride: true })).ok, false);

    // a tool tool-answer message between is not the person's words
    chat.messages.push({ role: "model", parts: [{ text: "ok" }] }, { role: "user", parts: [{ functionResponse: { name: "x", response: {} } }, { text: "Checks after your edits: use the ODE" }] });
    assertEquals(chat._lastUserText(), "use the ODE");
    say("fine, whatever");
    assertEquals(chat._lastUserText(), "fine, whatever");

    // the Tools panel's Rerun of a call the person's words once earned stays theirs
    say("something else entirely");
    const again = await chat.rerun(yes);
    assert(again.ok, again.error);
    assertEquals(again.warning, yes.warning);
    // a rerun of a refused call is refused again
    assertEquals((await chat.rerun(no)).ok, false);
});

Deno.test("chat guard: explain mode still refuses edits first; opt.fit with apply is an edit and is guarded too", async () => {
    const reg: any = new Registry(createHeadlessHost(gatedNet()));
    const explain = new ChatSession({ live: reg, manifest, post: async () => ({}), mode: "explain" });
    const e = await explain.runCall({ name: "opt_fit", args: { data: "a1", apply: true } });
    assert(e.error.includes("explain mode does not edit"), e.error);
    const chat = new ChatSession({ live: reg, manifest, post: async () => ({}), mode: "build" });
    const f = await chat.runCall({ name: "opt_fit", args: { data: "a1", apply: true } });
    assert(f.error.startsWith("refused: ") && f.error.includes("opt.fit"), f.error);
    assertFalse(chat.pending, "nothing was applied");
});

Deno.test("chat: isEdit is exported, for the packages that gate on it", () => {
    assertEquals(isEdit("net.add_place", {}), true);
    assertEquals(isEdit("sim.fire", {}), true);
    assertEquals(isEdit("opt.fit", { apply: true }), true);
    assertEquals(isEdit("opt.fit", {}), false);
    assertEquals(isEdit("sim.ode", {}), false);
    assertEquals(isEdit("net.info", {}), false);
});

// ---- macro.play goes through the guard like the commands it holds ----
//
// The review finding: macro.play replays stored command steps inside the
// native engine, so a stored analysis.diagnose ran on the gated net past the
// guard. macro_play is in the model's manifest (the person's macros, replayed).

async function withMacros(reg: any, defs: Record<string, any[]>, fn: () => Promise<void>) {
    for (const [name, steps] of Object.entries(defs)) await reg.execute("macro.define", { name, steps });
    try { await fn(); } finally { for (const name of Object.keys(defs)) await reg.execute("macro.delete", { name }).catch(() => {}); }
}
const diagStep = { command: "analysis.diagnose", args: { observable: "I", t_end: 5, noise: false } };
const odeStep = { command: "sim.ode", args: { t_end: 5 } };

Deno.test("chat guard: macro_play of a stored analysis.diagnose is refused on a gated net, and the refusal reaches the model", async () => {
    const reg: any = new Registry(createHeadlessHost(gatedNet()));
    await withMacros(reg, { rank: [diagStep] }, async () => {
        const { post, sent } = scripted([{ tool_calls: [{ name: "macro_play", args: { name: "rank" } }] }, { reply: "I need the SSA for this." }]);
        const chat = new ChatSession({ live: reg, manifest, post, mode: "build" });
        let out: any;
        const ids = await recording(async () => { out = await chat.send("replay my rank macro"); });
        assertEquals(out.reply, "I need the SSA for this.");
        const [entry] = chat.calls;
        assertEquals([entry.command, entry.ok], ["macro.play", false]);
        assert(entry.error.startsWith("refused: macro.play"), entry.error);
        assert(entry.error.includes('step 1 of macro "rank" (analysis.diagnose)') && entry.error.includes("capacity on I") && entry.error.includes("Nothing ran"), entry.error);
        assert(entry.refused.rule.includes("Rule 1"), entry.refused.rule);
        assertEquals(entry.refused.recommended, "ssa");
        assert(entry.error.includes("no override") && !entry.error.includes("engine_override"), "the plain tool is final");
        assertFalse(ids.includes("macro.play") || ids.includes("analysis.diagnose"), `the engine never ran it: ${ids}`);
        assertEquals(reg.artifacts().length, 0);
        assertFalse(chat.pending, "nothing was applied");
        const answer = sent[1].messages.at(-1).parts[0].functionResponse;
        assertEquals(answer.name, "macro_play");
        assert(answer.response.error.startsWith("refused: macro.play"), answer.response.error);
    });
});

Deno.test("chat guard: macro_play runs on a large net, warns on a small one, and the person's words lift a refusal", async () => {
    await withMacros(new Registry(createHeadlessHost(largeNet())) as any, { rank: [diagStep], curve: [odeStep] }, async () => {
        const large: any = new Registry(createHeadlessHost(largeNet()));
        const chat = new ChatSession({ live: large, manifest, post: async () => ({}), mode: "analyse" });
        for (const name of ["rank", "curve"]) {
            const e = await chat.runCall({ name: "macro_play", args: { name } });
            assert(e.ok && e.warning === undefined && e.refused === undefined, `${name}: ${e.error}`);
        }
        const small: any = new Registry(createHeadlessHost(smallNet()));
        const soft = new ChatSession({ live: small, manifest, post: async () => ({}), mode: "build" });
        const curve = await soft.runCall({ name: "macro_play", args: { name: "curve" } });
        assert(curve.ok && curve.warning.startsWith('step 1 of macro "curve" (sim.ode): ODE on a net where the engine recommends SSA'), `${curve.warning} ${curve.error}`);
        assert((soft._responseFor(curve).response as any).warning.includes("Say so"));
        const rank = await soft.runCall({ name: "macro_play", args: { name: "rank" } });
        assert(!rank.ok && rank.refused.rule.includes("Rule 2"), rank.error);

        const gated: any = new Registry(createHeadlessHost(gatedNet()));
        const hard = new ChatSession({ live: gated, manifest, post: async () => ({}), mode: "build" });
        hard.messages.push({ role: "user", parts: [{ text: "replay the curve with the ODE, I know the net has a capacity" }] });
        const yes = await hard.runCall({ name: "macro_play", args: { name: "curve" } }, 1, { override: "ode", canOverride: true });
        assert(yes.ok, yes.error);
        assertEquals(yes.override, "ode");
        assert(yes.warning.includes("ODE on a net with capacity on I"), yes.warning);
        hard.messages.push({ role: "user", parts: [{ text: "now the other one" }] });
        const no = await hard.runCall({ name: "macro_play", args: { name: "curve" } }, 1, { override: "ode", canOverride: true });
        assert(!no.ok && no.error.includes("was not applied") && no.error.includes('engine_override: "ode"'), no.error);
    });
});

Deno.test("chat guard: a macro the guard cannot read is refused, with no override on offer; macro_list and macro_get are not guarded", async () => {
    const reg: any = new Registry(createHeadlessHost(largeNet()));
    await withMacros(reg, { loop: [{ command: "macro.play", args: { name: "loop" } }] }, async () => {
        const chat = new ChatSession({ live: reg, manifest, post: async () => ({}), mode: "build" });
        for (const [name, why] of [["loop", "plays itself"], ["nope", 'macro.get "nope" failed']]) {
            const e = await chat.runCall({ name: "macro_play", args: { name } }, 1, { canOverride: true });
            assertFalse(e.ok, name);
            assert(e.error.startsWith("refused: macro.play") && e.error.includes(why) && e.error.includes("Nothing ran"), e.error);
            assert(!e.error.includes('engine_override: "'), e.error);
        }
        const ids = await recording(async () => {
            for (const c of [{ name: "macro_list", args: {} }, { name: "macro_get", args: { name: "loop" } }]) assert((await chat.runCall(c)).ok, c.name);
        });
        assertEquals(ids.filter((id) => id === "sim.recommend").length, 0);
    });
});


// ---- the goal toolset (docs/design/agent-first-analysis.md 4.2 to 4.4) ----
//
// The model sees goal-level tools; the session runs them. Every test drives a
// scripted post(): what the server would send back, as the model would send it
// (run_goal's inputs as JSON in a string).

const goalManifest = JSON.parse(await Deno.readTextFile(new URL("./llm-goal-tools.json", import.meta.url)));
const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));

/** A scripted model whose messages are the Gemini ones: the reply's text, then a functionCall part for each tool call. */
function scriptedGoals(replies: any[]) {
    const sent: any[] = [];
    const post = async (body: any) => {
        sent.push(structuredClone(body));
        const r = replies.shift() ?? { reply: "done", tool_calls: [] };
        const parts = [...(r.reply ? [{ text: r.reply }] : []), ...(r.tool_calls || []).map((c: any) => ({ functionCall: { name: c.name, args: c.args || {} } }))];
        return { message: { role: "model", parts: parts.length ? parts : [{ text: "" }] }, remaining_today: 9, ...r };
    };
    return { post, sent };
}

/** A session on the goal toolset over `net`; replies are the scripted model's. */
function goalSession(net: any, replies: any[], o: any = {}) {
    const { post, sent } = scriptedGoals(replies);
    const reg: any = new Registry(createHeadlessHost(net));
    const chat: any = new ChatSession({ live: reg, manifest: goalManifest, allManifest: manifest, goals: o.goals || catalog, post, mode: "analyse", ...o.session });
    return { chat, reg, sent };
}
const run = (goal_id: string, inputs?: any, extra: any = {}) => ({
    name: "run_goal", args: { goal_id, ...(inputs === undefined ? {} : { inputs: typeof inputs === "string" ? inputs : JSON.stringify(inputs) }), ...extra },
});
const answers = (sent: any[], i: number) => sent[i].messages.at(-1).parts.map((p: any) => p.functionResponse).filter(Boolean);
const bytes = (v: any) => JSON.stringify(v).length;

Deno.test("goals: a session built on the goal manifest declares the toolset in every body; the full manifest alone is the old 'all' surface", async () => {
    assert(isGoalManifest(goalManifest) && !isGoalManifest(manifest));
    const g = goalSession(smallNet(), [{ tool_calls: [run("conserved")] }, { reply: "Yes: S+I." }]);
    assertEquals(g.chat.toolset, "goals");
    await g.chat.send("is anything conserved?");
    assertEquals(g.sent.map((b: any) => b.toolset), ["goals", "goals"]);
    // the old surface: no toolset field at all, the full manifest, and a goal-manifest option it cannot use
    const { post, sent } = scripted([{ reply: "ok" }]);
    const old: any = new ChatSession({ live: live(), manifest, post });
    await old.send("hi");
    assertEquals(old.toolset, "all");
    assert(!("toolset" in sent[0]));
    assertEquals(old.tools.length, manifest.tools.length);
    assertEquals(g.chat.tools.length, goalManifest.tools.length);
    // the goals toolset needs the catalog, and 'all' on a goal manifest needs the full one
    let err: any;
    try { new ChatSession({ live: live(), manifest: goalManifest, post }); } catch (e) { err = e; }
    assert(/goal catalog/.test(err?.message));
    err = undefined;
    try { new ChatSession({ live: live(), manifest: goalManifest, goals: catalog, toolset: "all", post }); } catch (e) { err = e; }
    assert(/full manifest/.test(err?.message));
    assertEquals(new ChatSession({ live: live(), manifest: goalManifest, goals: catalog, toolset: "all", allManifest: manifest, post }).toolset, "all");
});

Deno.test("goals: explain mode keeps the pseudo-tools and drops the direct edit tools", () => {
    const names = (mode: string) => toolsFor(goalManifest, mode).map((t: any) => t.name);
    assertEquals(names("analyse").length, goalManifest.tools.length);
    const explain = names("explain");
    for (const keep of ["run_goal", "ask_user", "command_schema", "run_command", "open_view", "net_info", "analysis_check", "view_highlight"]) assert(explain.includes(keep), keep);
    for (const drop of ["net_add_place", "net_add_arc", "sim_set_rate", "edit_delete", "edit_undo"]) assert(!explain.includes(drop), drop);
});

Deno.test("run_goal: runs the plan on the sandbox, keeps a record and the artifacts, answers the model compactly (two model calls)", async () => {
    const { chat, reg, sent } = goalSession(smallNet(), [
        { reply: "Looking at the spread.", tool_calls: [run("risk")] },
        { reply: "The infection grows in every run." },
    ]);
    const events: any[] = [];
    const out = await chat.send("How bad can the outbreak get?", (e: any) => events.push(e));
    assertEquals([out.reply, out.rounds, sent.length], ["The infection grows in every run.", 2, 2]);
    const goalEvents = events.filter((e) => e.type === "goal");
    assertEquals(goalEvents.length, 1);
    const entry = goalEvents[0].entry;
    assert(entry.ok && entry.kind === "goal" && entry.name === "run_goal");
    const r = entry.result;
    assertEquals([r.title, r.source, r.goal], ["How bad can it get? What's the spread?", "ask", { id: "risk", question: "How bad can it get? What's the spread?" }]);
    assertEquals(r.caveat, catalog.goals.find((g: any) => g.id === "risk").caveat);
    assertEquals(r.answerShape, catalog.goals.find((g: any) => g.id === "risk").answer);
    assertEquals(r.artifacts.length, 1);
    assertEquals(r.artifacts[0].data.kind, "timeseries");
    assertEquals(r.artifacts[0].id, entry.artifacts[0]);
    assert(reg.artifacts().some((a: any) => a.id === r.artifacts[0].id), "the artifact is in the editor's store, so Results shows it");
    assertEquals(r.steps.map((s: any) => s.command), ["sim.recommend", "sim.ssa"]);
    // a record the footer can draw: the goal, resolved calls, the engine and why, the net revision
    const rec = r.record;
    assertEquals(rec.goal.id, "risk");
    assertEquals(rec.calls.map((c: any) => c.command), ["sim.recommend", "sim.ssa"]);
    assertEquals([rec.calls[1].args.runs, rec.calls[1].args.seed], [20, 1]);
    assertEquals(rec.engine.name, "SSA");
    assert(rec.engine.reason.length > 0);
    assert(/^\d+:/.test(rec.net.revision), String(rec.net.revision));
    assertEquals(rec.versions.registry.startsWith("pflow-native"), true);
    assertEquals(rec.caveat, r.caveat);
    // the plan's assumptions are listed, as text and as a structure
    assert(r.assumed.some((a: any) => /t_end = .* from sim\.recommend/.test(a.text)), JSON.stringify(r.assumed));
    assert(r.assumed.some((a: any) => a.how === "plan" && /runs = 20/.test(a.text)));
    assertEquals(r.assumed.map((a: any) => a.text), rec.assumed.map((a: any) => a.text));
    // what went back to the model: the evidence and the engine, never the caveat
    const [back] = answers(sent, 1);
    assertEquals(back.name, "run_goal");
    const a = back.response;
    assertEquals([a.goal, a.engine.name, a.steps.map((s: any) => s.command)], ["risk", "SSA", ["sim.ssa"]]);
    assert(!JSON.stringify(a).includes(r.caveat.slice(0, 40)), "the caveat is the interface's");
    assert(bytes(a) < GOAL_ANSWER_MAX, `${bytes(a)} bytes`);
    // nothing about the sandbox changed
    assertFalse(chat.pending);
    assertEquals(chat.calls.length, 1);
});

Deno.test("run_goal: a place or transition the net does not have is a tool error naming the ones it has, and nothing runs", async () => {
    const { chat, reg, sent } = goalSession(smallNet(), [
        { tool_calls: [run("knob", { observable: "Infected" })] },
        { tool_calls: [run("one_more", { place: "s" }), run("best_setting", { transition: "heal" })] },
        { reply: "I see." },
    ]);
    await chat.send("which knob matters for the infected?");
    assertEquals(reg.artifacts().length, 0, "nothing ran");
    const [a] = answers(sent, 1);
    assert(a.response.error.includes('"Infected" is not a place of this net') && a.response.error.includes("S, I") && a.response.error.includes("Nothing ran"), a.response.error);
    const [b, c] = answers(sent, 2);
    assert(b.response.error.includes("Did you mean S?"), b.response.error);
    assert(c.response.error.includes("transitions are: infect"), c.response.error);
    assertEquals(chat.calls.map((e: any) => e.ok), [false, false, false]);
    // an unknown goal, an input that is not an object
    const g = goalSession(smallNet(), []);
    assert((await g.chat.runCall({ name: "run_goal", args: { goal_id: "teleport" } })).error.includes("The goals are: stuck"));
    assert((await g.chat.runCall({ name: "run_goal", args: { goal_id: "data_match" } })).error.includes("is not a goal you can run"));
    assert((await g.chat.runCall({ name: "run_goal", args: { goal_id: "knob", inputs: "[1]" } })).error.includes("JSON object"));
    assert((await g.chat.runCall({ name: "run_goal", args: { goal_id: "knob", inputs: "{oops" } })).error.includes("not valid JSON"));
});

Deno.test("run_goal: a blank place input is inferred from the person's own words and recorded as an assumption with a Change", async () => {
    const { chat, sent } = goalSession(smallNet(), [{ tool_calls: [run("knob")] }, { reply: "The infection rate." }]);
    const events: any[] = [];
    await chat.send("What should I change to make the infection spread more slowly?", (e: any) => events.push(e));
    const r = events.find((e) => e.type === "goal").entry.result;
    assertEquals(r.inputs.observable, "I");
    const a = r.assumed.find((x: any) => x.key === "observable");
    assertEquals([a.how, a.value, a.label], ["inferred", "I", "the outcome to watch"]);
    assertEquals(a.change.input, "observable");
    assertEquals(a.change.options, ["S", "I"]);
    assertEquals(a.change.kind, "place");
    // the footer's copy of it: text and the call argument to change
    const f = r.record.assumed.find((x: any) => x.key === "observable");
    assertEquals(f.change, "observable");
    assert(f.text.includes("taken from your words"));
    // the call the plan made carries it
    assertEquals(r.record.calls.find((c: any) => c.command === "analysis.diagnose_ssa").args.observable, "I");
    assert(answers(sent, 1)[0].response.assumed.some((t: string) => t.includes("the outcome to watch = I")));
});

Deno.test("run_goal: a required input the words cannot supply is the tool's error (with the choices); a failing step names the way out", async () => {
    const { chat, reg } = goalSession(smallNet(), []);
    const one = await chat.runCall(run("one_more"));
    assertFalse(one.ok);
    assert(one.error.includes("one_more needs place") && one.error.includes("Choices: S, I") && one.error.includes("ask_user"), one.error);
    const reach = await chat.runCall(run("can_happen"));
    assert(reach.error.includes("JSON object of place") && reach.error.includes("e.g."), reach.error);
    // knob on a net with no sink and no named outcome: the step fails; the model is told what to pass
    const knob = await chat.runCall(run("knob"));
    assertFalse(knob.ok);
    assert(knob.error.includes("no sink to watch") && knob.error.includes("inputs.observable") && knob.error.includes("S, I"), knob.error);
    assertEquals(reg.artifacts().length, 0);
});

Deno.test("run_goal: defaults the goal fills are assumptions with a Change that names the input", async () => {
    const { chat } = goalSession(smallNet(), []);
    const e = await chat.runCall(run("best_setting", { transition: "infect" }));
    assert(e.ok, e.error);
    const r = e.result;
    assertEquals(r.inputs, { transition: "infect", max_rate: 2 });
    const d = r.assumed.find((a: any) => a.how === "default");
    assert(d.text.includes("(default for best_setting)"), d.text);
    assertEquals(d.change.input, "max_rate");
    assertEquals(d.change.kind, "number");
    assertEquals(d.change.default, 2);
    // the SSA branch takes it inside its scenarios, not as an argument of its own: no call argument to point at
    assertEquals(d.change.arg, null);
    assertEquals(r.record.assumed.find((a: any) => a.key === d.key).change, "max_rate");
    // the ODE branch takes it as an argument ("to"), which is what Edit settings can change
    const big = goalSession(largeNet(), []);
    const ode = await big.chat.runCall(run("best_setting", { transition: "infect" }));
    assert(ode.ok, ode.error);
    const bd = ode.result.assumed.find((a: any) => a.how === "default");
    assertEquals([bd.key, bd.change.input, bd.change.arg], ["to", "max_rate", "to"]);
    assertEquals(ode.result.record.assumed.find((a: any) => a.key === "to").change, "to");
    assertEquals(ode.result.record.engine.name, "ODE");
    // a value the person gave is not an assumption
    const given = await chat.runCall(run("best_setting", { transition: "infect", max_rate: "3" }));
    assert(given.ok && !given.result.assumed.some((a: any) => a.how === "default"));
    assertEquals(given.result.inputs.max_rate, 3);
});

Deno.test("prepareGoalInputs: kinds are checked against the net; unknown inputs are dropped, not run", () => {
    const net: any = { places: { S: {}, I: {} }, transitions: { infect: {} }, arcs: [] };
    const goal = (id: string) => catalog.goals.find((g: any) => g.id === id);
    assertEquals((prepareGoalInputs(goal("knob"), { observable: "I", surprise: 1 }, net) as any).ignored, ["surprise"]);
    assert((prepareGoalInputs(goal("can_happen"), { to: { R: 1 } }, net) as any).error.includes('"R" is not a place'));
    assert((prepareGoalInputs(goal("can_happen"), { to: "[1]" }, net) as any).error.includes("JSON object of place"));
    assertEquals((prepareGoalInputs(goal("can_happen"), { to: '{"I": 3}' }, net) as any).inputs.to, { I: 3 });
    assert((prepareGoalInputs(goal("best_setting"), { transition: "infect", max_rate: "fast" }, net) as any).error.includes("is not a number"));
    // an optional place left blank is noted, not guessed
    const blank: any = prepareGoalInputs(goal("knob"), {}, net, "what matters here?");
    assertEquals(blank.assumed.map((a: any) => a.how), ["unnamed"]);
    assertEquals(blank.inputs, {});
    // json inputs travel as the model sent them
    const play: any = prepareGoalInputs(goal("best_play"), { sides: '{"x_":1}', reward: { w: 1 } }, net);
    assertEquals([play.inputs.sides, play.inputs.reward], ['{"x_":1}', { w: 1 }]);
});

// A goal made for the test: its one step is an ODE command whatever the net says, which the engine guard refuses on a net with a capacity.
const odeOnly = { id: "ode_only", question: "Which knob, by the ODE?", inputs: [], plan: [{ command: "analysis.diagnose", args: { observable: "I", noise: false } }], answer: "a ranking", caveat: "the ODE ranks" };
const withOdeOnly = { ...catalog, goals: [...catalog.goals, odeOnly] };

Deno.test("run_goal: the engine guard refuses a plan step the net's recommendation rules out; the refusal reaches the model and names the override", async () => {
    const { chat, reg, sent } = goalSession(gatedNet(), [{ tool_calls: [run("ode_only")] }, { reply: "I cannot rank this on the ODE." }], { goals: withOdeOnly });
    const events: any[] = [];
    await chat.send("which knob matters?", (e: any) => events.push(e));
    const [entry] = chat.calls;
    assertFalse(entry.ok);
    assert(entry.refused.rule.includes("Rule 1"), entry.refused.rule);
    assertEquals(entry.refused.recommended, "ssa");
    assertEquals(reg.artifacts().length, 0, "nothing ran");
    assertFalse(events.some((e) => e.type === "goal"), "a refused run shows no result");
    const e = answers(sent, 1)[0].response.error;
    assert(e.startsWith("refused: ") && e.includes("capacity on I") && e.includes("Nothing ran"), e);
    assert(e.includes('engine_override: "ode"') && e.includes("names the engine"), e);
    // the model passes the override the person did not ask for: still refused, and told why
    const again = await chat.runCall(run("ode_only", undefined, { engine_override: "ode" }));
    assertFalse(again.ok);
    assert(again.error.includes("was not applied"), again.error);
});

Deno.test("run_goal: an engine_override counts only when the person's message names the engine; then the plan's ODE branch runs with a warning chip", async () => {
    const { chat, sent } = goalSession(gatedNet(), [
        { tool_calls: [run("average", undefined, { engine_override: "ode" })] },
        { reply: "Done, on the ODE as you asked." },
    ]);
    const events: any[] = [];
    await chat.send("Use the ODE to show me the typical behaviour.", (e: any) => events.push(e));
    const r = events.find((e) => e.type === "goal").entry.result;
    assertEquals(r.steps.map((s: any) => [s.command, !!s.skipped]), [["sim.recommend", false], ["sim.ode", false], ["sim.ssa", true]]);
    assertEquals(r.record.engine.name, "ODE");
    assert(r.record.engine.overridden);
    assert(r.record.engine.reason.startsWith("sim.recommend advised SSA"), r.record.engine.reason);
    assert(r.warnings[0].startsWith("ODE on a net with capacity on I; the engine recommends SSA"), r.warnings[0]);
    assertEquals(r.record.engine.warning, r.warnings[0]);
    const a = answers(sent, 1)[0].response;
    assertEquals(a.engine.overridden, true);
    assert(a.warnings[0].includes("the engine recommends SSA"));
    assertEquals(chat.calls[0].override, "ode");
    // the model's override on its own initiative: ignored, the plan runs what the recommendation says, and the model is told
    const own = goalSession(gatedNet(), [{ tool_calls: [run("average", undefined, { engine_override: "ode" })] }, { reply: "SSA it is." }]);
    await own.chat.send("What happens on average?");
    const ran = own.chat.calls[0];
    assert(ran.ok, ran.error);
    assertEquals(ran.result.record.engine.name, "SSA");
    assertFalse(ran.result.record.engine.overridden);
    assertEquals(ran.overrideIgnored, "ode");
    assert(answers(own.sent, 1)[0].response.notes[0].includes("was not applied"));
});

Deno.test("run_goal: an override that changes nothing in the plan says so (no goal has an SDE step)", async () => {
    const { chat, sent } = goalSession(smallNet(), [{ tool_calls: [run("risk", undefined, { engine_override: "sde" })] }, { reply: "Here is the spread (stochastic runs)." }]);
    await chat.send("Give me the spread using the SDE.");
    const e = chat.calls[0];
    assert(e.ok, e.error);
    assertEquals(e.result.record.engine.name, "SSA");
    assertEquals(e.overrideUnused, "sde");
    assert(e.result.warnings[0].includes("You asked for the SDE") && e.result.warnings[0].includes("ran what the plan runs"), e.result.warnings[0]);
    assertEquals(answers(sent, 1)[0].response.notes, e.result.warnings);
    assert(e.result.record.warnings.includes(e.result.warnings[0]), "the footer says it too");
});

Deno.test("run_goal: a goal with no engine step has no engine row; a pending sandbox is what the plan runs on", async () => {
    const { chat } = goalSession(smallNet(), []);
    const stuck = await chat.runCall(run("stuck"));
    assert(stuck.ok, stuck.error);
    assertEquals(stuck.result.record.engine, null);
    assertEquals(stuck.result.onProposal, false);
    // edits are in the sandbox: the next goal runs on them, and says its record's revision is the sandbox's
    const before = stuck.result.record.net.revision;
    await chat.runCall({ name: "net_add_place", args: { x: 0, y: 0, id: "Z" } });
    assert(chat.pending);
    const after = await chat.runCall(run("conserved"));
    assert(after.ok, after.error);
    assert(after.result.record.net.revision !== before);
    chat.netCid = "zb2rhTest";
    assertEquals((await chat.runCall(run("conserved"))).result.record.net.cid, "zb2rhTest");
});

// ---- ask_user ----

const ask = (question: string, options: string[], default_option?: string) => ({ name: "ask_user", args: { question, options, ...(default_option ? { default_option } : {}) } });

Deno.test("ask_user: ends the loop on a card; answer() posts the choice as the tool result and the loop goes on", async () => {
    const { chat, sent } = goalSession(smallNet(), [
        { reply: "I need one thing.", tool_calls: [ask("Which place do you mean?", ["S", "I"], "I")] },
        { tool_calls: [run("one_more", { place: "I" })] },
        { reply: "One more infected person speeds it up." },
    ]);
    const events: any[] = [];
    const first = await chat.send("What if I had one more?", (e: any) => events.push(e));
    assertEquals(first.asked, { question: "Which place do you mean?", options: ["S", "I"], default_option: "I", callName: "ask_user", round: 1 });
    assertEquals(first.reply, "I need one thing.");
    assertEquals(sent.length, 1, "exactly one model call for an ask");
    assertEquals(events.find((e) => e.type === "ask").card, first.asked);
    assertEquals(chat.calls[0].asked, first.asked);
    // the question waits: the conversation ends on the model's call
    assert(chat.messages.at(-1).parts.some((p: any) => p.functionCall));
    const done = await chat.answer("S", (e: any) => events.push(e));
    assertEquals(done.reply, "One more infected person speeds it up.");
    const resumed = sent[1].messages.at(-1).parts;
    assertEquals(resumed.length, 1);
    assertEquals(resumed[0].functionResponse, { name: "ask_user", response: { answer: "S" } });
    assertEquals(sent[1].toolset, "goals");
    assertEquals(sent[1].mode, "analyse");
    assert(events.some((e) => e.type === "answered" && e.answer.answer === "S"));
    assertEquals(chat.calls.map((c: any) => c.name), ["ask_user", "run_goal"]);
    assertEquals(chat.calls[0].answer, { answer: "S" });
    await assertRejects(() => chat.answer("S"), Error, "no question is waiting");
});

Deno.test("ask_user: a second ask in one turn is refused with a tool error that tells the model to proceed", async () => {
    const { chat, sent } = goalSession(smallNet(), [
        { tool_calls: [ask("Which place?", ["S", "I"])] },
        { tool_calls: [ask("Are you sure?", ["yes", "no"])] },
        { tool_calls: [run("one_more", { place: "I" })] },
        { reply: "Went ahead with I." },
    ]);
    await chat.send("What if I had one more?");
    const out = await chat.answer("I");
    assertEquals(out.reply, "Went ahead with I.");
    const refusal = answers(sent, 2)[0].response.error;
    assert(refusal.includes("already asked") && refusal.includes("go ahead with your best assumption") && refusal.includes("state the assumption"), refusal);
    assertEquals(sent.length, 4);
    // two asks in one reply: the first is the card, the second is refused; other calls wait for the answer
    const two = goalSession(smallNet(), [{ tool_calls: [ask("First?", ["a", "b"]), ask("Second?", ["c", "d"]), run("stuck"), { name: "view_fit", args: {} }] }, { reply: "ok" }]);
    const r = await two.chat.send("hm");
    assertEquals(r.asked?.question, "First?");
    await two.chat.answer({ other: "neither" });
    const back = answers(two.sent, 1);
    assertEquals(back.map((b: any) => b.name), ["ask_user", "ask_user", "run_goal", "view_fit"]);
    assertEquals(back[0].response, { answer: "neither", other: true });
    assert(back[1].response.error.includes("already asked"));
    assert(back[2].response.error.includes("not run") && back[3].response.error.includes("not run"));
    assertEquals(two.chat.calls.filter((c: any) => c.name === "run_goal").length, 0, "the goal did not run before the answer");
    // a new message is a new turn: one ask again
    const next = goalSession(smallNet(), [{ tool_calls: [ask("Q1?", ["a", "b"])] }, { reply: "done" }, { tool_calls: [ask("Q2?", ["a", "b"])] }]);
    await next.chat.send("one");
    await next.chat.answer("a");
    assertEquals((await next.chat.send("two")).asked?.question, "Q2?");
});

Deno.test("ask_user: 'you decide' takes the model's default and keeps it as an assumption on the next result; 'other' is the person's words", async () => {
    const { chat, sent } = goalSession(smallNet(), [
        { tool_calls: [ask("Which place?", ["S", "I", "elsewhere"], "I")] },
        { tool_calls: [run("one_more", { place: "I" })] },
        { reply: "Done." },
    ]);
    const events: any[] = [];
    await chat.send("what if I had one more?");
    await chat.answer({ decide: true }, (e: any) => events.push(e));
    assertEquals(sent[1].messages.at(-1).parts[0].functionResponse.response, { answer: "I", decided: "model" });
    const r = events.find((e) => e.type === "goal").entry.result;
    const decided = r.assumed.find((a: any) => a.how === "decided");
    assertEquals([decided.value, decided.question], ["I", "Which place?"]);
    assert(decided.text.includes("You left") && decided.text.includes("I took I"), decided.text);
    assert(r.record.assumed.some((a: any) => a.text === decided.text), "the footer lists it too");
    // it is used up: the result after it does not repeat it
    const again = await chat.runCall(run("stuck"));
    assertFalse(again.result.assumed.some((a: any) => a.how === "decided"));
    // with no default the first option is taken
    const g = goalSession(smallNet(), [{ tool_calls: [ask("Which?", ["S", "I"])] }, { reply: "ok" }]);
    await g.chat.send("?");
    await g.chat.answer({ decide: true });
    assertEquals(g.sent[1].messages.at(-1).parts[0].functionResponse.response, { answer: "S", decided: "model" });
    // a typed answer, and a string that is not one of the options, are 'other'
    const o = goalSession(smallNet(), [{ tool_calls: [ask("Which?", ["S", "I"])] }, { reply: "ok" }]);
    await o.chat.send("?");
    await o.chat.answer("the queue, use the ODE");
    assertEquals(o.sent[1].messages.at(-1).parts[0].functionResponse.response, { answer: "the queue, use the ODE", other: true });
    // the typed words are the person's own: they can name an engine, and the next goal infers a place from them
    assertEquals(o.chat._lastUserText(), "the queue, use the ODE");
});

Deno.test("ask_user: a message typed while the card is open is its 'Other' answer; a bad card is the tool's error", async () => {
    const { chat, sent } = goalSession(smallNet(), [{ tool_calls: [ask("Which?", ["S", "I"])] }, { reply: "Understood." }]);
    await chat.send("what if I had one more?");
    const out = await chat.send("the infected ones");
    assertEquals(out.reply, "Understood.");
    assertEquals(sent[1].messages.at(-1).parts[0].functionResponse.response, { answer: "the infected ones", other: true });
    assertEquals(sent[1].mode, "analyse");
    const g = goalSession(smallNet(), []);
    for (const bad of [{ question: "", options: ["a", "b"] }, { question: "Q?", options: ["only"] }, { question: "Q?", options: ["a", "a"] }, { question: "Q?", options: ["a", "b", "c", "d", "e"] }]) {
        const e = await g.chat.runCall({ name: "ask_user", args: bad });
        assertFalse(e.ok);
        assert(e.error.includes("2 to 4 different options"), e.error);
    }
    // a default that is not an option is dropped
    const e = await g.chat.runCall(ask("Q?", ["a", "b"], "c"));
    assertEquals(e.asked.default_option, null);
    await assertRejects(async () => { const s = goalSession(smallNet(), [{ tool_calls: [ask("Q?", ["a", "b"])] }]); await s.chat.send("x"); await s.chat.answer(7 as any); }, TypeError);
});

// ---- command_schema, run_command, open_view and the direct tools ----

Deno.test("command_schema: a command's JSON Schema and help from the index; anything outside it is an error", async () => {
    const { chat } = goalSession(smallNet(), []);
    const e = await chat.runCall({ name: "command_schema", args: { id: "sim.ssa" } });
    assert(e.ok, e.error);
    assertEquals(e.response.id, "sim.ssa");
    assert(e.response.help.length > 10 && e.response.args.properties.t_end, JSON.stringify(e.response).slice(0, 200));
    assert(bytes(e.response) < 6000);
    // a direct tool's command is reachable too; a command the manifest excludes, or that writes the library, is not
    assert((await chat.runCall({ name: "command_schema", args: { id: "net.add_place" } })).ok);
    for (const id of ["file.load_json", "model.save", "store.put", "no.such"]) {
        const x = await chat.runCall({ name: "command_schema", args: { id } });
        assertFalse(x.ok, id);
        assert(x.error.includes("is not a command of the command index"), x.error);
    }
    assert((await chat.runCall({ name: "command_schema", args: { id: "sim_ssa" } })).error.includes("did you mean sim.ssa?"));
});

Deno.test("run_command: runCall's path for the long tail: sandbox, artifacts, the id must be in the index", async () => {
    const { chat, reg, sent } = goalSession(smallNet(), [
        { tool_calls: [{ name: "run_command", args: { id: "sim.ssa", args: JSON.stringify({ t_end: 2, runs: 2, seed: 3 }) } }] },
        { reply: "Two runs." },
    ]);
    const events: any[] = [];
    await chat.send("simulate a couple of runs", (e: any) => events.push(e));
    const entry = chat.calls[0];
    assert(entry.ok && entry.kind === "command", entry.error);
    assertEquals([entry.command, entry.commandArgs, entry.args.id], ["sim.ssa", { t_end: 2, runs: 2, seed: 3 }, "sim.ssa"]);
    assertEquals(entry.artifacts.length, 1);
    assertEquals(reg.artifacts().length, 1);
    // the result a pane can stack: no goal, no caveat, a record of the one call
    const shown = events.find((e) => e.type === "command").entry.shown;
    assertEquals([shown.goal, shown.caveat, shown.record.calls[0].command, shown.record.goal, shown.composed], [null, "", "sim.ssa", null, true]);
    assertEquals(shown.record.engine.name, "SSA");
    assertEquals(shown.artifacts[0].id, entry.artifacts[0]);
    assertEquals(answers(sent, 1)[0].name, "run_command");
    assertEquals(answers(sent, 1)[0].response.artifacts.length, 1);
    // the sandbox is untouched by a read
    assertFalse(chat.pending);
    // not in the index: the tool's error, and nothing is run
    const bad = await chat.runCall({ name: "run_command", args: { id: "file.load_json", args: "{}" } });
    assertFalse(bad.ok);
    assert(bad.error.includes("command index"), bad.error);
    assert((await chat.runCall({ name: "run_command", args: { id: "sim.ssa", args: "[1]" } })).error.includes("JSON object"));
    assert((await chat.runCall({ name: "run_command", args: { id: "sim.ssa", args: JSON.stringify({ bogus: 1 }) } })).error.length > 0);
});

Deno.test("run_command: explain mode refuses an edit; build mode makes the sandbox pending; the direct tools are plain commands", async () => {
    const ex = goalSession(smallNet(), [], { session: { mode: "explain" } });
    const fire = await ex.chat.runCall({ name: "run_command", args: { id: "sim.fire", args: JSON.stringify({ id: "infect" }) } });
    assertFalse(fire.ok);
    assert(fire.error.includes("explain mode does not edit"), fire.error);
    assertFalse(ex.chat.pending);
    // the direct edit tool is refused in explain mode too, and run_goal / ask_user are not edits
    assert((await ex.chat.runCall({ name: "net_add_place", args: { x: 0, y: 0 } })).error.includes("explain mode does not edit"));
    assert((await ex.chat.runCall(run("stuck"))).ok);
    const b = goalSession(smallNet(), [{ tool_calls: [{ name: "net_add_place", args: { x: 9, y: 9, id: "Q" } }, { name: "run_command", args: { id: "sim.fire", args: JSON.stringify({ id: "infect" }) } }] }, { reply: "ok" }], { session: { mode: "build" } });
    await b.chat.send("add a place and fire");
    assert(b.chat.pending);
    assertEquals(Object.keys(b.chat.model().places), ["S", "I", "Q"]);
    assertEquals(Object.keys(b.reg.host.getModel().places), ["S", "I"], "the live net is untouched until Apply");
    // build mode: the engine's checks follow an edit round, as before
    assert(b.sent[1].messages.at(-1).parts.some((p: any) => typeof p.text === "string" && p.text.startsWith("Checks after your edits")));
    assertEquals(b.chat.diff().added, ["place Q"]);
    assert(b.chat.apply());
    assertEquals(Object.keys(b.reg.host.getModel().places), ["S", "I", "Q"]);
});

Deno.test("run_command: the guard applies, with an engine_override the person's words must earn", async () => {
    const { chat, reg } = goalSession(gatedNet(), []);
    const msg = (text: string) => chat.messages.push({ role: "user", parts: [{ text }] });
    msg("simulate it");
    const call = (extra: any = {}) => ({ name: "run_command", args: { id: "sim.ode", args: JSON.stringify({ t_end: 2 }), ...extra } });
    const no = await chat.runCall(call());
    assertFalse(no.ok);
    assert(no.error.startsWith("refused: ") && no.error.includes("capacity on I") && no.error.includes('engine_override: "ode"'), no.error);
    assert(no.refused.rule.includes("Rule 1"));
    assertEquals(reg.artifacts().length, 0);
    assertFalse((await chat.runCall(call({ engine_override: "ode" }))).ok, "the person did not name the ODE");
    msg("run the ODE anyway");
    const yes = await chat.runCall(call({ engine_override: "ode" }));
    assert(yes.ok, yes.error);
    assertEquals(yes.warning, "ODE on a net with capacity on I; the engine recommends SSA");
    assertEquals(yes.override, "ode");
    assertEquals(yes.shown.record.engine.overridden, true);
    assertEquals(yes.shown.warnings, [yes.warning]);
    // the Tools panel's Rerun of that entry keeps the override the person's words earned
    msg("something else");
    assert((await chat.rerun(yes)).ok);
});

Deno.test("run_command composing analysis with no goal is logged by id (composed); a goal in the turn means nothing is logged", async () => {
    const compose = (calls: any[]) => calls.map((c) => ({ name: "run_command", args: { id: c[0], args: JSON.stringify(c[1] || {}) } }));
    const { chat } = goalSession(smallNet(), [
        { tool_calls: compose([["analysis.siphons"], ["sim.ssa", { t_end: 1, runs: 1 }]]) },
        { tool_calls: compose([["analysis.invariants", { kind: "p" }], ["net.info"]]) },
        { reply: "Composed." },
    ]);
    const events: any[] = [];
    await chat.send("how are the siphons and the average related?", (e: any) => events.push(e));
    assertEquals(events.filter((e) => e.type === "composed").map((e) => e.ids), [["analysis.siphons", "sim.ssa", "analysis.invariants"]]);
    assertEquals(chat.composedLog, [["analysis.siphons", "sim.ssa", "analysis.invariants"]]);
    assert(JSON.stringify(chat.composedLog).indexOf("siphons and the average") < 0, "ids only, no text");
    // with a goal that ran, the turn is not composed work
    const g = goalSession(smallNet(), [{ tool_calls: [run("stuck"), ...compose([["analysis.siphons"]])] }, { reply: "ok" }]);
    const ev: any[] = [];
    await g.chat.send("can it get stuck?", (e: any) => ev.push(e));
    assertEquals(g.chat.composedLog, []);
    assertFalse(ev.some((e) => e.type === "composed"));
    // edits and the direct tools are not composition
    const e = goalSession(smallNet(), [{ tool_calls: [...compose([["sim.fire", { id: "infect" }]]), { name: "net_info", args: {} }] }, { reply: "ok" }], { session: { mode: "build" } });
    await e.chat.send("fire it");
    assertEquals(e.chat.composedLog, []);
});

Deno.test("open_view: tells the interface which view to open and answers the model; an unknown view is the tool's error", async () => {
    const { chat, sent } = goalSession(smallNet(), [{ tool_calls: [{ name: "open_view", args: { view: "structure" } }, { name: "open_view", args: { view: "settings" } }] }, { reply: "Opened Structure." }]);
    const events: any[] = [];
    await chat.send("let me look at the structure myself", (e: any) => events.push(e));
    assertEquals(events.filter((e) => e.type === "open_view"), [{ type: "open_view", view: "structure" }]);
    const [ok, bad] = answers(sent, 1);
    assertEquals(ok.response, { opened: "structure" });
    assert(bad.response.error.includes("view must be one of analysis, simulate, structure"));
    assertFalse(chat.pending);
});

// ---- the toolset fallback ----

Deno.test("toolset: a server without the goals toolset (400) is asked again as 'all', once, and the old surface takes over", async () => {
    const sent: any[] = [];
    const replies: any[] = [{ tool_calls: [{ name: "sim_ssa", args: { t_end: 1, runs: 1 } }] }, { reply: "Ran it." }, { reply: "Again." }];
    const post = async (body: any) => {
        sent.push(structuredClone(body));
        if (body.toolset === "goals") throw Object.assign(new Error("toolset goals is not available on this server"), { status: 400 });
        const r = replies.shift();
        return { message: { role: "model", parts: [{ text: r.reply || "" }] }, ...r };
    };
    const chat: any = new ChatSession({ live: live(), manifest: goalManifest, allManifest: manifest, goals: catalog, post, mode: "analyse" });
    const events: any[] = [];
    const out = await chat.send("simulate", (e: any) => events.push(e));
    assertEquals(out.reply, "Ran it.");
    assertEquals(events.filter((e) => e.type === "toolset").map((e) => e.toolset), ["all"]);
    assertEquals(sent.map((b) => b.toolset), ["goals", undefined, undefined]);
    assertEquals(chat.toolset, "all");
    assertEquals(chat.tools.length, manifest.tools.length);
    assertEquals(chat.calls[0].command, "sim.ssa", "decoded with the full manifest");
    // the fall back is for good: no second attempt at the goals toolset
    await chat.send("again");
    assertEquals(sent.at(-1).toolset, undefined);
    assertEquals(events.filter((e) => e.type === "toolset").length, 1);
    // without the full manifest the error stands; so does any other 400
    const lone: any = new ChatSession({ live: live(), manifest: goalManifest, goals: catalog, post, mode: "analyse" });
    await assertRejects(() => lone.send("x"), Error, "toolset goals is not available");
    const other: any = new ChatSession({ live: live(), manifest: goalManifest, allManifest: manifest, goals: catalog, mode: "analyse", post: async () => { throw Object.assign(new Error("net summary over 24576 bytes"), { status: 400 }); } });
    await assertRejects(() => other.send("x"), Error, "net summary");
    assertEquals(other.toolset, "goals");
});

// ---- the intent ----

Deno.test("intent: the server's label shows as a chip; force() makes the next message the person's own label (no classifier); resend() asks again under another intent", async () => {
    const { chat, sent } = goalSession(smallNet(), [
        { reply: "Looking.", mode: "analyse", auto: { mode: "analyse", sentiment: "neutral", confidence: 0.9 } },
        { reply: "Building." },
        { reply: "Again, labelled." },
    ], { session: { mode: "auto" } });
    assertEquals(chat.intent, null);
    const events: any[] = [];
    await chat.send("make it bigger", (e: any) => events.push(e));
    assertEquals(chat.intent, "analyse");
    assertEquals(events.filter((e) => e.type === "intent"), [{ type: "intent", mode: "analyse", forced: false, sentiment: "neutral", confidence: 0.9 }]);
    assertEquals([sent[0].mode, sent[0].toolset], ["auto", "goals"]);
    // "Not what I meant": the same message, build this time
    chat.force("design");
    assertEquals(chat.intent, "build");
    events.length = 0;
    await chat.send("make it bigger", (e: any) => events.push(e));
    assertEquals([sent[1].mode, sent[1].prev_mode, sent[1].step], ["build", undefined, "describe"]);
    assertEquals(events.filter((e) => e.type === "intent"), [{ type: "intent", mode: "build", forced: true }]);
    assertEquals(chat.intent, "build");
    assertEquals(chat.effectiveMode, "build");
    // forcing is for one message: the next is labelled by the server again, told where the conversation was
    await chat.send("and now?");
    assertEquals([sent[2].mode, sent[2].prev_mode], ["auto", "build"]);
    assertEquals(chat.intent, "build", "the scripted server sent no label, so the forced one stands");
    for (const bad of ["auto", "plan", ""]) assert((() => { try { chat.force(bad); } catch (e: any) { return /intent must be/.test(e.message); } return false; })(), bad);
    chat.force(null);
    // on a session with a fixed mode, force is for the next message and the mode comes back
    const fixed = goalSession(smallNet(), [{ reply: "a" }, { reply: "b" }], { session: { mode: "analyse" } });
    fixed.chat.force("explain");
    await fixed.chat.send("one");
    await fixed.chat.send("two");
    assertEquals(fixed.sent.map((b: any) => b.mode), ["explain", "analyse"]);
    assertEquals(fixed.chat.intent, "analyse");
});

Deno.test("resend: the last message again under the other intent; the replies, tool calls and edits of the first attempt are dropped", async () => {
    const { chat, reg, sent } = goalSession(smallNet(), [
        { reply: "Adding.", tool_calls: [{ name: "net_add_place", args: { x: 0, y: 0, id: "Z" } }] },
        { reply: "Done adding." },
        { reply: "S is the susceptible people." },
    ], { session: { mode: "auto" } });
    chat.mode = "build"; // the scripted server does not label; the first attempt ran as build
    await chat.send("what is S?");
    assert(chat.pending);
    assertEquals(chat.calls.length, 1);
    chat.mode = "auto";
    const before = chat.messages.length;
    const out = await chat.resend("explain");
    assertEquals(out.reply, "S is the susceptible people.");
    assertEquals(sent.at(-1).mode, "explain");
    assertEquals(chat.messages.length, 2, "the user message and the one reply; the first attempt is gone");
    assert(chat.messages.length < before);
    assertEquals(chat.calls.length, 0);
    assertFalse(chat.pending);
    assertEquals(Object.keys(chat.model().places), ["S", "I"], "the sandbox is back to where the message found it");
    assertEquals(chat.intent, "explain");
    assertEquals(reg.host.getModel().places.Z, undefined);
    // the first message's own text, once
    assertEquals(chat.messages.filter((m: any) => m.role === "user").length, 1);
    await assertRejects(async () => goalSession(smallNet(), []).chat.resend("build"), Error, "no message to resend");
});

// ---- Describe's fold: a described net as the pending change ----

Deno.test("proposeNet: a gated draft is the pending change; diff / apply / discard are every edit's; the proposal waits with it", async () => {
    const { chat, reg } = goalSession(smallNet(), [{ reply: "Looking at the draft." }]);
    const draft: any = rated(sir());
    draft.places.R = { initial: [0], capacity: [0], x: 200, y: 0 };
    draft.transitions.recover = { x: 150, y: 0, rate: 0.1 };
    draft.arcs.push({ source: "I", target: "recover", weight: [1] }, { source: "recover", target: "R", weight: [1] });
    const d = chat.proposeNet(draft, { notes: ["R collects the recovered"], assumptions: [{ text: "recovery takes 10 days" }] });
    assert(chat.pending);
    assertEquals(d.added, ["place R", "transition recover"]);
    assertEquals(chat.proposal, { notes: ["R collects the recovered"], assumptions: [{ text: "recovery takes 10 days" }] });
    assertEquals(Object.keys(reg.host.getModel().places), ["S", "I"], "the live net is untouched");
    // the conversation goes on over the proposed net: the model's net summary shows it, and goals run on it
    const e = await chat.runCall(run("conserved"));
    assert(e.ok && e.result.onProposal, e.error);
    const sentNet = goalSession(smallNet(), [{ reply: "ok" }]);
    sentNet.chat.proposeNet(draft);
    await sentNet.chat.send("check the draft");
    assertEquals(sentNet.sent[0].net.places.map((p: any) => p.id), ["S", "I", "R"]);
    assert(sentNet.chat.pending, "sending does not reseed a pending proposal");
    // discard drops net and notes
    chat.discard();
    assertFalse(chat.pending);
    assertEquals(chat.proposal, null);
    assert(chat.diff().empty);
    // apply commits it as one undo step and clears the notes
    chat.proposeNet(draft, { notes: ["n"] });
    assert(chat.apply());
    assertEquals(chat.proposal, null);
    assertEquals(Object.keys(reg.host.getModel().places), ["S", "I", "R"]);
    reg.host.undo();
    assertEquals(Object.keys(reg.host.getModel().places), ["S", "I"]);
    // a net that is not one is refused
    let err: any;
    try { chat.proposeNet({ name: "x" } as any); } catch (x) { err = x; }
    assert(err instanceof TypeError);
});

// ---- the footer's Rerun and Edit settings ----

Deno.test("rerunResult: the same settings reproduce the artifacts byte for byte (seeded SSA); a new result beside the old one", async () => {
    const { chat } = goalSession(smallNet(), []);
    const first = (await chat.runCall(run("risk"))).result;
    const again = await chat.rerunResult(first);
    assert(again.id !== first.id && again.rerunOf === first.id);
    assertEquals(again.record.calls, first.record.calls);
    assertEquals(again.artifacts.length, 1);
    assert(again.artifacts[0].id !== first.artifacts[0].id, "a fresh artifact");
    assertEquals(await artifactDigest(again.artifacts[0]), await artifactDigest(first.artifacts[0]));
    assertEquals([again.goal, again.caveat, again.title, again.answerShape], [first.goal, first.caveat, first.title, first.answerShape]);
    assertEquals(again.edited, false);
    assertEquals(again.record.assumed.map((a: any) => a.text), first.record.assumed.map((a: any) => a.text), "nothing was edited, nothing is added");
    assertEquals(again.record.engine.name, "SSA");
    assertEquals(again.stale, false);
    // the first result is left alone
    assertEquals(first.record.calls[1].args.runs, 20);
});

Deno.test("rerunResult: edited settings run unguarded, are recorded as the person's edit, and change the artifacts", async () => {
    const { chat } = goalSession(smallNet(), []);
    const first = (await chat.runCall(run("risk"))).result;
    const edited = await chat.rerunResult(first, { args: { "sim.ssa": { runs: 3, seed: 9 } } });
    assertEquals(edited.record.calls[1].args.runs, 3);
    assertEquals(edited.record.calls[1].args.seed, 9);
    assertEquals(edited.record.calls[1].args.t_end, first.record.calls[1].args.t_end, "the rest is as recorded");
    assertEquals(edited.edited, true);
    const note = edited.record.assumed.at(-1);
    assertEquals(note.key, "settings");
    assert(note.text.startsWith("Settings edited by you: sim.ssa:") && note.text.includes("runs 20 → 3") && note.text.includes("seed 1 → 9"), note.text);
    assertEquals(edited.assumed.at(-1).text, note.text);
    assert(await artifactDigest(edited.artifacts[0]) !== await artifactDigest(first.artifacts[0]));
    assertEquals(edited.record.goal, first.record.goal);
    assertEquals(edited.record.caveat, first.record.caveat);
    // by index, an array, an unset key
    assertEquals((await chat.rerunResult(first, { args: { 1: { runs: 2 } } })).record.calls[1].args.runs, 2);
    assertEquals((await chat.rerunResult(first, { args: [undefined, { runs: 4 }] })).record.calls[1].args.runs, 4);
    // a setting the command refuses throws, naming the call
    await assertRejects(() => chat.rerunResult(first, { args: { "sim.ssa": { runs: -5 } } }), Error, "sim.ssa");
    await assertRejects(() => chat.rerunResult({} as any), TypeError);
    // the net changed since: the same calls on the net as it is now, said so
    const live2 = (chat.live as any).host;
    live2.commit({ ...live2.getModel(), places: { ...live2.getModel().places, Z: { initial: [0], capacity: [0], x: 0, y: 0 } } }, "edit");
    const later = await chat.rerunResult(first);
    assert(later.record.assumed.some((a: any) => a.text.includes("net has changed since")), JSON.stringify(later.record.assumed));
    assert(later.record.net.revision !== first.record.net.revision);
});

Deno.test("rerunResult: unguarded, but an engine the net's recommendation advises against still carries the guard's chip", async () => {
    const { chat } = goalSession(gatedNet(), []);
    const first = (await chat.runCall(run("risk"))).result;
    assertEquals(first.warnings, []);
    // the person edits the Simulate call into ODE terms: here a command result for the ODE on a net with a capacity
    chat.messages.push({ role: "user", parts: [{ text: "run the ODE, I know" }] });
    const ode = await chat.runCall({ name: "run_command", args: { id: "sim.ode", args: JSON.stringify({ t_end: 2 }), engine_override: "ode" } });
    assert(ode.ok, ode.error);
    const redo = await chat.rerunResult(ode.shown, { args: { 0: { t_end: 3 } } });
    assertEquals(redo.record.calls[0].args.t_end, 3);
    assert(redo.warnings[0].startsWith("ODE on a net with capacity on I; the engine recommends SSA"), redo.warnings[0]);
    assertEquals([redo.record.engine.name, redo.record.engine.overridden, redo.record.engine.warning], ["ODE", true, redo.warnings[0]]);
    assertEquals(redo.composed, true);
    // a plain rerun of a clean result adds no chip
    const clean = await chat.rerunResult(first);
    assertEquals(clean.warnings, []);
});

Deno.test("goalAnswer: stays under the byte bound however large the steps are, and never carries the caveat", () => {
    const big = { kind: "table", columns: ["a", "b"], rows: Array.from({ length: 40 }, (_, i) => [i, "x".repeat(200)]) };
    const art = (id: string) => ({ id, title: id, data: big, source: {} });
    const steps = [0, 1, 2, 3].map((i) => ({ index: i, command: "analysis.verify", args: { n: "y".repeat(500) }, result: { rows: Array.from({ length: 60 }, (_, k) => ({ k, text: "z".repeat(100) })) }, artifacts: [`a${i}`] }));
    const goal = catalog.goals[0];
    const record: any = { engine: { name: "SSA", reason: "because" } };
    const a = goalAnswer({ goal, record, steps, artifact: art, warnings: ["w"], assumed: [{ text: "t = 1" }] });
    assert(bytes(a) <= GOAL_ANSWER_MAX, `${bytes(a)}`);
    assertEquals(a.steps.length, 4);
    assertEquals([a.engine.name, a.warnings, a.assumed], ["SSA", ["w"], ["t = 1"]]);
    assertFalse(JSON.stringify(a).includes(goal.caveat.slice(0, 30)));
    // small answers are left whole
    const small = goalAnswer({ goal, record, steps: [{ index: 0, command: "sim.recommend", args: {}, result: { engine: "ssa" }, artifacts: [] }], artifact: art });
    assertEquals(small.steps, [], "sim.recommend is folded into engine");
});
