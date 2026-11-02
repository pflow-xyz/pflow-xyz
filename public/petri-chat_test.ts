import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ChatSession, diffNets, isEdit, toolsFor } from "./petri-chat.js";
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
