import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { COMPOSE_VIEWS, MAX_NET_BYTES, TEACH_TYPES, TabLink, VIEWS, buildReport, checkParams, clampResult, netOk, overlayUrl, parseFrames, planShow, teachEvent, viewCalls } from "./petri-tab.js";
import { Shell, ViewRegistry } from "./petri-shell.js";
import { registerBuiltins } from "./petri-shell-views.js";
import { replayViewSpec, validateViewSpec } from "./petri-viewspec.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { loadEngine } from "./petri-wasm.js";

const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const net = (): any => ({
    places: { a: { initial: [3], capacity: [0], x: 0, y: 0 }, b: { initial: [0], capacity: [0], x: 100, y: 0 } },
    transitions: { t: { x: 50, y: 0, rate: 0.5 } },
    arcs: [{ source: "a", target: "t", weight: [1] }, { source: "t", target: "b", weight: [1] }],
});

Deno.test("parseFrames: whole frames, a tail kept for the next chunk, comments and damage skipped", () => {
    const a = parseFrames('event: hello\ndata: {"type":"hello","tab":"x"}\n\nevent: sh');
    assertEquals(a.events, [{ type: "hello", tab: "x" }]);
    assertEquals(a.rest, "event: sh");
    const b = parseFrames(a.rest + 'ow\ndata: {"view":"plot"}\n\n: comment\n\ndata: not json\n\nevent: ping\r\ndata: {}\r\n\r\n');
    assertEquals(b.events, [{ view: "plot", type: "show" }, { type: "ping" }]); // the frame's name fills a missing type
    assertEquals(b.rest, "");
    assertEquals(parseFrames("data: [1]\n\n").events, []); // not an object
});

Deno.test("checkParams mirrors the server's limits", () => {
    assertEquals(checkParams("plot", { t_end: 5, engine: "ssa", runs: 10 }).ok, true);
    for (const [view, p] of [["plot", { t_end: -1 }], ["plot", { engine: "x" }], ["plot", { max_states: 5 }], ["reachability", { max_states: 0 }],
        ["reachability", { max_states: 20001 }], ["invariants", { kind: "q" }], ["categorical", { name: "nope" }], ["plot", { points: 2.5 }], ["canvas", { t_end: 1 }]] as const) {
        assertEquals(checkParams(view, p).ok, false, `${view} ${JSON.stringify(p)}`);
    }
    assertEquals(checkParams("plot", null).ok, true);
    assertEquals(checkParams("plot", [] as any).ok, false);
});

Deno.test("every analysis view's calls are valid and replay on the real engine", async () => {
    for (const view of ["plot", "reachability", "invariants"]) {
        for (const params of view === "plot" ? [{}, { engine: "ssa", runs: 5, seed: 3, t_end: 4 }, { t_end: 2, points: 20 }] : [{}]) {
            const s = planShow({ type: "show", view, net: net(), params });
            assert(s.ok, JSON.stringify(s));
            assert(s.spec && s.loadNet);
            const live = new Registry(createHeadlessHost(net())) as any;
            const check = validateViewSpec(s.spec, live, { model: net() });
            assertEquals([check.errors, check.refused, check.unknown], [[], [], []], `${view} ${JSON.stringify(params)}`);
            const run = await replayViewSpec(s.spec, live);
            assertEquals((run.errors || []).length, 0, `${view}: ${run.errors}`);
            assert(run.steps.length > 0 && !(run.steps[0] as any).error, `${view}: ${JSON.stringify(run.steps[0])}`);
        }
    }
});

Deno.test("planShow: canvas and notation load the net and run nothing; categorical opens the composition page", () => {
    const c = planShow({ type: "show", view: "canvas", net: net(), cid: "bafytest1234" });
    assertEquals([c.ok, c.loadNet, c.spec, c.cid], [true, true, null, "bafytest1234"]);
    const n = planShow({ type: "show", view: "notation", net: net(), params: { source: "net x {}" } });
    assertEquals([n.ok, n.source, n.spec], [true, "net x {}", null]);
    const k = planShow({ type: "show", view: "categorical", cid: "bafycomp1234", params: { name: "operad" } }, { origin: "https://pflow.xyz" });
    assertEquals([k.ok, k.loadNet, k.net, k.overlay], [true, false, null, "https://pflow.xyz/compose.html?cid=bafycomp1234#view=operad"]);
    assertEquals(planShow({ type: "show", view: "categorical", cid: "bafycomp1234" }).overlay, overlayUrl("bafycomp1234", "cospan"));
    assert(COMPOSE_VIEWS.includes("cospan"));
});

Deno.test("planShow refuses what it cannot show, and never throws", () => {
    const bad: any[] = [
        null, "x", { type: "stop" }, { type: "show", view: "nope", net: net() }, { type: "show", view: "plot" },
        { type: "show", view: "plot", net: { places: [] } }, { type: "show", view: "plot", net: { arcs: {} } },
        { type: "show", view: "plot", net: net(), cid: "../x" }, { type: "show", view: "categorical", net: net() },
        { type: "show", view: "plot", net: net(), params: { t_end: 1e9 } },
        { type: "show", view: "plot", net: { ...net(), pad: "x".repeat(MAX_NET_BYTES) } },
    ];
    for (const ev of bad) assertEquals(planShow(ev).ok, false, JSON.stringify(ev)?.slice(0, 80));
    assertEquals(netOk(net()), "");
    assertEquals(VIEWS.length, 6);
});

Deno.test("a pushed view cannot edit the net: the calls are on the replay allowlist and nothing else", () => {
    for (const view of ["plot", "reachability", "invariants"]) {
        for (const c of viewCalls(view, {})!) assert(/^(sim|analysis)\./.test(c.command), c.command);
    }
    assertEquals(viewCalls("canvas"), null);
});

Deno.test("buildReport: a bounded summary, the net only when asked", async () => {
    const r = await buildReport({ model: net(), cid: "c", view: "plot", results: [{ title: "Plot", status: "ran" }], dirty: true });
    assertEquals([r.places, r.transitions, r.arcs, r.marking, r.dirty, r.cid, r.view], [2, 1, 2, { a: 3, b: 0 }, true, "c", "plot"]);
    assertStringIncludes(r.net_hash, "sha256:");
    assertEquals("net" in r, false);
    assertEquals((await buildReport({ model: net() }, { includeNet: true })).net.places.a.initial, [3]);
    const many: any = { places: {}, transitions: {}, arcs: [] };
    for (let i = 0; i < 500; i++) many.places["p" + i] = { initial: [1] };
    assertEquals(Object.keys((await buildReport({ model: many })).marking).length, 200);
    const huge: any = { places: { a: { initial: [1], pad: "x".repeat(300000) } } };
    const h = await buildReport({ model: huge }, { includeNet: true });
    assertEquals([("net" in h), h.net_omitted], [false, "over the report limit"]);
});

// ---- TabLink against a fake server ----

function fakeServer() {
    const log: any[] = [];
    const streams: Array<(s: string) => void> = [];
    const closers: Array<() => void> = [];
    const enc = new TextEncoder();
    const fetchImpl = async (url: string, init: any = {}) => {
        const method = init.method || "GET";
        log.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
        if (url.endsWith("/api/tab") && method === "POST") return new Response(JSON.stringify({ id: "tab1", user: "github:1" }), { status: 200 });
        if (url.endsWith("/events")) {
            let ctrl: ReadableStreamDefaultController;
            const body = new ReadableStream({ start(c) { ctrl = c; } });
            streams.push((s) => ctrl.enqueue(enc.encode(s)));
            closers.push(() => ctrl.close());
            init.signal?.addEventListener("abort", () => { try { ctrl.error(new DOMException("aborted", "AbortError")); } catch { /* closed */ } });
            return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
        }
        return new Response(null, { status: 204 });
    };
    return { fetchImpl, log, streams, closers };
}

const frame = (ev: any) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
const settle = async (cond: () => boolean) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); assert(cond(), "condition never held"); };

function fakeHost() {
    const calls: any[] = [];
    let model: any = net();
    const host = {
        calls,
        snapshot: () => ({ model, cid: null, view: "canvas", results: [], dirty: false }),
        loadNet: (n: any, o: any) => { model = n; calls.push(["loadNet", Object.keys(n.places), o.cid]); },
        runSpec: async (spec: any) => { calls.push(["runSpec", spec.view, spec.calls[0].command]); },
        openOverlay: (u: string) => calls.push(["overlay", u]),
        setNotation: (s: string) => calls.push(["notation", s]),
        closeViews: () => calls.push(["close"]),
        notice: (t: string) => calls.push(["notice", t]),
        onState: (s: string) => calls.push(["state", s]),
    };
    return host;
}

Deno.test("TabLink: registers with the bearer token, shows pushes, answers get, and stops", async () => {
    const srv = fakeServer();
    const host = fakeHost();
    const link = new TabLink({ host, token: "tok", fetchImpl: srv.fetchImpl as any, wait: async () => {} });
    assertEquals(await link.start(), true);
    assertEquals(srv.log[0], { method: "POST", url: "/api/tab", body: undefined, auth: "Bearer tok" });
    await settle(() => srv.streams.length === 1);
    srv.streams[0](frame({ type: "hello", tab: "tab1", views: [...VIEWS] }));
    await settle(() => host.calls.some((c: any) => c[0] === "state" && c[1] === "linked"));

    // split mid-frame: the tail is kept
    const show = frame({ type: "show", view: "reachability", net: { ...net(), places: { z: { initial: [1] } } }, cid: "bafycid1234", params: { max_states: 10 } });
    srv.streams[0](show.slice(0, 20));
    srv.streams[0](show.slice(20));
    await settle(() => host.calls.some((c: any) => c[0] === "runSpec"));
    assertEquals(host.calls.filter((c: any) => c[0] === "loadNet" || c[0] === "runSpec"), [["loadNet", ["z"], "bafycid1234"], ["runSpec", "reachability", "analysis.reachability"]]);
    await settle(() => srv.log.some((e) => e.url.endsWith("/report")));
    const rep = srv.log.find((e) => e.url.endsWith("/report"));
    assertEquals([rep.body.places, rep.auth], [1, "Bearer tok"]);

    srv.streams[0](frame({ type: "get", request_id: "r1", params: { net: true } }));
    await settle(() => srv.log.some((e) => e.url.endsWith("/reply")));
    const reply = srv.log.find((e) => e.url.endsWith("/reply"));
    assertEquals([reply.body.request_id, reply.body.state.net.places.z.initial], ["r1", [1]]);

    srv.streams[0](frame({ type: "stop" }));
    await settle(() => host.calls.some((c: any) => c[0] === "close"));

    // a bad push is refused on the page with one line, and reported
    srv.streams[0](frame({ type: "show", view: "plot", net: { places: [] } }));
    await settle(() => host.calls.some((c: any) => c[0] === "notice"));
    assertStringIncludes(host.calls.find((c: any) => c[0] === "notice")[1], "cannot show");

    await link.stop();
    assertEquals(srv.log.at(-1).method, "DELETE");
    assertEquals(host.calls.at(-1), ["state", "off"]);
});

Deno.test("TabLink: a dropped stream reconnects to the same tab; a swept tab gets a new one; 401 turns the link off", async () => {
    const srv = fakeServer();
    const host = fakeHost();
    const link = new TabLink({ host, token: "tok", fetchImpl: srv.fetchImpl as any, wait: async () => {} });
    await link.start();
    await settle(() => srv.streams.length === 1);
    srv.streams[0](frame({ type: "hello", tab: "tab1" }));
    srv.closers[0]();
    await settle(() => srv.streams.length === 2);
    assertEquals(srv.log.filter((e) => e.url === "/api/tab/tab1/events").length, 2);
    assert(host.calls.some((c: any) => c[0] === "state" && c[1] === "reconnecting"));
    await link.stop();

    let status = 200;
    const f401 = async (url: string, init: any = {}) => {
        if (url.endsWith("/api/tab")) return new Response(JSON.stringify({ id: "t" }), { status: status === 200 ? 200 : status });
        return new Response(null, { status });
    };
    const h2 = fakeHost();
    const l2 = new TabLink({ host: h2, token: "bad", fetchImpl: f401 as any, wait: async () => {} });
    status = 401;
    assertEquals(await l2.start(), false);
    assert(h2.calls.some((c: any) => c[0] === "state" && c[1] === "refused"));
});

Deno.test("TabLink: an IDE shell takes the event unchanged; stop goes to it; panels reach the report", async () => {
    const srv = fakeServer();
    const host: any = fakeHost();
    const seen: any[] = [];
    host.shellOpen = (ev: any) => { seen.push(["open", ev.view, ev.request_id]); return true; };
    host.shellClose = (id: any) => { seen.push(["close", id]); return true; };
    host.snapshot = () => ({ model: net(), view: "plot", panels: [{ id: "plot", type: "plot", dock: "bottom" }] });
    const link = new TabLink({ host, token: "t", fetchImpl: srv.fetchImpl as any, wait: async () => {} });
    await link.start();
    await settle(() => srv.streams.length === 1);
    srv.streams[0](frame({ type: "show", view: "plot", net: net(), request_id: "q1" }));
    srv.streams[0](frame({ type: "stop", request_id: "q2" }));
    await settle(() => seen.length === 2);
    assertEquals(seen, [["open", "plot", "q1"], ["close", "q2"]]);
    assertEquals(host.calls.filter((c: any) => c[0] === "loadNet" || c[0] === "runSpec" || c[0] === "close"), []); // the page's own path did not run
    await settle(() => srv.log.some((e) => e.url.endsWith("/report") && e.body.panels));
    await link.stop();
});

// ---- the teaching verbs: the frames the Go server sends (testdata/tab-teach/frames.json, written by
// cmd/webserver/tabs_teach_test.go TestTabTeachEndToEnd) replayed through TabLink into the real shell core ----

Deno.test("teachEvent: a verb's params become the shell event, the type and request id win", () => {
    assertEquals(teachEvent({ type: "level", request_id: "r", params: { level: "math", type: "show", request_id: "x" } }), { level: "math", type: "level", request_id: "r" });
    assertEquals(teachEvent({ type: "tour_control", params: { action: "next" } }), { action: "next", type: "tour_control" });
    assertEquals(teachEvent({ type: "show", view: "plot" }), null);
    assertEquals(teachEvent({ type: "level", params: [1] }), { type: "level" });
    assert(TEACH_TYPES.includes("tour"));
});

Deno.test("clampResult: plain fields only, ok is a boolean", () => {
    assertEquals(clampResult({ ok: true, id: "plot", nested: { a: 1 }, n: 2 }), { ok: true, id: "plot", n: 2 });
    assertEquals(clampResult({ ok: "yes" }), { ok: false });
    assertEquals(clampResult(null), { ok: false });
});

Deno.test("end to end: the server's push of a net, level math, a highlight and a two-step tour land in a shell", async () => {
    const golden = JSON.parse(await Deno.readTextFile(new URL("../testdata/tab-teach/frames.json", import.meta.url)));
    assertEquals(golden.map((e: any) => [e.type, e.view]), [["show", "canvas"], ["level", undefined], ["show", "notation"], ["highlight", undefined], ["tour", undefined], ["tour_control", undefined]]);
    const shell = new Shell({ registry: registerBuiltins(new ViewRegistry()) });
    const srv = fakeServer();
    const host: any = fakeHost();
    host.shellOpen = (ev: any) => shell.dispatch(ev);
    host.shellDispatch = (ev: any) => shell.dispatch(ev);
    host.shellClose = (id: any) => shell.close(id);
    host.snapshot = () => ({ model: net(), view: "canvas", panels: shell.state().panels, shell: shell.state() });
    const link = new TabLink({ host, token: "t", fetchImpl: srv.fetchImpl as any, wait: async () => {} });
    await link.start();
    await settle(() => srv.streams.length === 1);
    const replies = () => srv.log.filter((e) => e.url.endsWith("/reply"));
    const states: any[] = [];
    for (const [i, ev] of golden.entries()) {
        srv.streams[0](frame(ev));
        await settle(() => replies().length === i + 1);
        states.push(structuredClone(shell.state()));
    }
    const res = replies().map((e) => [e.body.request_id, e.body.state.result.ok]);
    assertEquals(res, [["r1", true], ["r2", true], ["r3", true], ["r4", true], ["r5", true], ["r6", true]]);
    // after the push the shell shows the canvas, at the default level
    assertEquals(states[0].level, "model");
    // level math
    assertEquals(states[1].level, "math");
    assertEquals(replies()[1].body.state.shell.level, "math");
    // the notation panel opens in the centre
    assert(states[2].panels.some((p: any) => p.type === "notation" && p.dock === "center"), JSON.stringify(states[2].panels));
    // the transition is highlighted
    assertEquals(states[3].highlights, ["node:move"]);
    // the tour's first step highlights pushedA and says so
    assertEquals(states[4].tour, { title: "How tokens move", step: 1, of: 2 });
    assertEquals(states[4].highlights, ["node:pushedA"]);
    // next: step 2 opens the invariants panel, which the math level allows
    assertEquals(states[5].tour, { title: "How tokens move", step: 2, of: 2 });
    assert(states[5].panels.some((p: any) => p.type === "invariants"), JSON.stringify(states[5].panels));
    assertEquals(host.calls.filter((c: any) => c[0] === "notice"), []);
    await link.stop();
});

Deno.test("a teaching verb on a page without the shell is answered, not dropped", async () => {
    const srv = fakeServer();
    const host: any = fakeHost();
    const link = new TabLink({ host, token: "t", fetchImpl: srv.fetchImpl as any, wait: async () => {} });
    await link.start();
    await settle(() => srv.streams.length === 1);
    srv.streams[0](frame({ type: "level", request_id: "q9", params: { level: "math" } }));
    await settle(() => srv.log.some((e) => e.url.endsWith("/reply")));
    const r = srv.log.find((e) => e.url.endsWith("/reply"));
    assertEquals([r.body.request_id, r.body.state.result.ok], ["q9", false]);
    assertStringIncludes(r.body.state.result.error, "?shell=1");
    await link.stop();
});
