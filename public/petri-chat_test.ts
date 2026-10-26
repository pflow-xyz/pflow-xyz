import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ChatSession, diffNets } from "./petri-chat.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { buildManifest, commandId, decodeCall, summarizeResult, toolName } from "./petri-tools.js";

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
