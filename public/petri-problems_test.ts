import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyGate, checkModel, chipHtml, mountProblemsChip, problemsListHtml, ProblemsMonitor, summarize } from "./petri-problems.js";
import { validateNet } from "./petri-validate.js";
import { createHeadlessHost, Registry } from "./petri-commands.js";

// ---- fixtures ---------------------------------------------------------------

// parity/ssa/sir.json is go-pflow's portable list format (validateNet refuses it: "keyed by id"), so the clean net
// is that same SIR model written in the editor's format.
const portable = JSON.parse(await Deno.readTextFile(new URL("../parity/ssa/sir.json", import.meta.url)));

function editorNet(model: any): any {
    const places: any = {};
    const transitions: any = {};
    model.places.forEach((p: any, i: number) => {
        places[p.id] = { "@type": "Place", initial: [p.initial ?? 0], capacity: [0], x: 40 + i * 120, y: 40, offset: 0 };
    });
    model.transitions.forEach((t: any, i: number) => {
        transitions[t.id] = { "@type": "Transition", x: 100 + i * 120, y: 120, rate: t.rate };
    });
    return {
        "@context": "https://pflow.xyz/schema",
        "@type": "PetriNet",
        "@version": "1.1",
        token: ["https://pflow.xyz/tokens/black"],
        places,
        transitions,
        arcs: model.arcs.map((a: any) => ({ "@type": "Arrow", source: a.from, target: a.to, weight: [a.weight ?? 1], inhibitTransition: false })),
    };
}

const sir = () => editorNet(portable.model);

function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object") {
        Object.freeze(o);
        for (const v of Object.values(o as any)) deepFreeze(v);
    }
    return o;
}

// ---- summarize --------------------------------------------------------------

Deno.test("summarize: a clean net is ok, with the exact shape", () => {
    const empty: any = { level: "ok", count: 0, errors: 0, warnings: 0, repaired: 0, items: [], label: "No problems" };
    assertEquals(summarize({ report: { kind: "report", ok: true, errors: [], warnings: [], cid: "zabc" } }), empty);
    // nothing checked yet is also nothing to say
    assertEquals(summarize({}), empty);
    assertEquals(summarize(), empty);
    assertEquals(summarize({ report: null, loadCheck: null }), empty);
});

Deno.test("summarize: warnings alone are problems at level warn", () => {
    const n = sir();
    n.places.lonely = { initial: [0], capacity: [0], x: 0, y: 0 };
    n.places.queue = { initial: [0], capacity: [0], x: 0, y: 0 };
    const v = validateNet(n);
    assertEquals(v.errors, []);
    assertEquals(v.warnings.length, 2);
    const s = summarize({ report: { errors: v.errors, warnings: v.warnings } });
    assertEquals(s.level, "warn");
    assertEquals([s.count, s.errors, s.warnings, s.repaired], [2, 0, 2, 0]);
    assertEquals(s.label, "2 problems");
    assertEquals(s.items.map((i: any) => i.severity), ["warning", "warning"]);
    assertEquals(s.items.map((i: any) => i.where).sort(), ["places.lonely", "places.queue"]);
    assert(s.items.every((i: any) => /no arc touches/.test(i.message)));
});

Deno.test("summarize: real validateNet errors for malformed nets — a missing place, a shared id, a negative marking", () => {
    const missing = sir();
    missing.arcs.push({ source: "recover", target: "nowhere", weight: [1] });
    const shared = sir();
    shared.transitions.S = { x: 0, y: 0 }; // an id used by a place and a transition
    const negative = sir();
    negative.places.S.initial = [-1];

    const cases: Array<[any, string, RegExp]> = [
        [missing, "arcs[5].target", /"nowhere" is not a declared place or transition/],
        [shared, "transitions.S", /also a place/],
        [negative, "places.S.initial[0]", /not a non-negative integer/],
    ];
    for (const [net, where, message] of cases) {
        const v = validateNet(net);
        assert(!v.ok);
        const s = summarize({ report: { errors: v.errors, warnings: v.warnings } });
        assertEquals(s.level, "error");
        assertEquals(s.errors, v.errors.length);
        assertEquals(s.count, v.errors.length + v.warnings.length);
        const hit = s.items.find((i: any) => i.where === where);
        assert(hit, `an item at ${where} in ${JSON.stringify(s.items)}`);
        assertEquals(hit.severity, "error");
        assert(message.test(hit.message), hit.message);
    }
});

Deno.test("summarize: errors are listed first, then repairs, then warnings", () => {
    const s = summarize({
        report: { errors: [{ path: "a", message: "e1" }], warnings: [{ path: "b", message: "w1" }] },
        loadCheck: { errors: [{ path: "c", message: "r1" }] },
    });
    assertEquals(s.items, [
        { severity: "error", where: "a", message: "e1" },
        { severity: "repaired", where: "c", message: "r1" },
        { severity: "warning", where: "b", message: "w1" },
    ]);
    assertEquals([s.errors, s.repaired, s.warnings, s.count], [1, 1, 1, 3]);
    assertEquals(s.level, "error");
});

Deno.test("summarize: what the editor repaired at load counts, at level warn when nothing else is wrong", () => {
    // The incoming document, as petri-view's _checkIncoming sees it before normalizeModel clamps it.
    const incoming = sir();
    incoming.places.S.capacity = [500];
    incoming.places.S.initial = [990 + 600];
    const loadCheck = validateNet(incoming);
    assertEquals(loadCheck.errors.length, 1);
    // The live net is the repaired one: clean now.
    const s = summarize({ report: { errors: [], warnings: [] }, loadCheck });
    assertEquals(s.level, "warn");
    assertEquals([s.count, s.errors, s.warnings, s.repaired], [1, 0, 0, 1]);
    assertEquals(s.label, "1 problem");
    assertEquals(s.items.length, 1);
    assertEquals(s.items[0].severity, "repaired");
    assertEquals(s.items[0].where, "places.S.initial[0]");
    assert(/exceeds capacity/.test(s.items[0].message));
    // Only the load check's errors count: its warnings (defaults the editor fills) do not.
    const bare = validateNet({ places: {}, transitions: {}, arcs: [] });
    assert(bare.warnings.length > 0);
    assertEquals(summarize({ loadCheck: bare }).count, 0);
    // Repairs alone, without any report yet
    assertEquals(summarize({ loadCheck }).count, 1);
});

Deno.test("summarize: the label pluralises", () => {
    const issues = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `p${i}`, message: "m" }));
    const label = (n: number) => summarize({ report: { errors: issues(n), warnings: [] } }).label;
    assertEquals([0, 1, 2, 3, 11].map(label), ["No problems", "1 problem", "2 problems", "3 problems", "11 problems"]);
});

Deno.test("summarize: an empty path is the net itself, and any of the three report shapes is read", () => {
    const data = { kind: "report", ok: false, errors: [{ path: "", message: "a net is a JSON object" }], warnings: [], cid: null };
    const direct = summarize({ report: data });
    assertEquals(direct.items[0].where, "(net)");
    // analysis.check's command result carries the artifact id beside the same fields; the artifact wraps them in data
    assertEquals(summarize({ report: { artifact: "a1", ...data } }), direct);
    assertEquals(summarize({ report: { id: "a1", title: "Check net", data } }), direct);
    // not a report at all: nothing to say, no throw
    assertEquals(summarize({ report: { kind: "table", columns: [] } }).count, 0);
    assertEquals(summarize({ report: "oops" as any }).count, 0);
});

Deno.test("summarize: is pure — deterministic and it changes nothing", () => {
    const input: any = deepFreeze({
        report: { errors: [{ path: "a", message: "e" }], warnings: [{ path: "", message: "w" }] },
        loadCheck: { errors: [{ path: "c", message: "r" }] },
    });
    const a = summarize(input);
    const b = summarize(input);
    assertEquals(a, b);
    assertNotEquals(a.items, input.report.errors); // fresh objects, not the caller's
});

// ---- checkModel -------------------------------------------------------------

Deno.test("checkModel: a clean net has no problems, and the net is not touched", async () => {
    const net = deepFreeze(sir()); // any write would throw: the module is strict
    const s = await checkModel(net);
    assertEquals(s, { level: "ok", count: 0, errors: 0, warnings: 0, repaired: 0, items: [], label: "No problems" });
});

Deno.test("checkModel: a broken net reports every problem, and the net is not touched", async () => {
    const net: any = sir();
    net.arcs.push({ source: "recover", target: "nowhere", weight: [1] });
    net.places.S.initial = [-3];
    net.places.lonely = { initial: [0], capacity: [0], x: 0, y: 0 };
    const before = JSON.stringify(net);
    deepFreeze(net);
    const s = await checkModel(net);
    assertEquals(JSON.stringify(net), before);
    assertEquals(s.level, "error");
    assertEquals(s.errors, 2);
    assert(s.items.some((i: any) => i.severity === "error" && i.where === "arcs[5].target"));
    assert(s.items.some((i: any) => i.severity === "error" && i.where === "places.S.initial[0]"));
    // validateNet's shape warnings only run when there are no errors, so there is none here
    assertEquals(s.warnings, 0);
    assertEquals(s.label, "2 problems");
});

Deno.test("checkModel: the engine smoke check runs when validateNet finds no error, and warnings still come through", async () => {
    const net: any = sir();
    net.places.lonely = { initial: [0], capacity: [0], x: 0, y: 0 };
    const s = await checkModel(net);
    assertEquals(s.level, "warn");
    assertEquals([s.errors, s.warnings], [0, 1]);
    assertEquals(s.items[0].where, "places.lonely");
});

Deno.test("checkModel: a live editor model (normalized, Infinity capacities) is clean, as analysis.check finds it", async () => {
    const live: any = createHeadlessHost(sir()).getModel();
    assertEquals(live.places.S.capacity, [Infinity]);
    assertEquals((await checkModel(live)).count, 0);
});

Deno.test("checkModel: checks the net as it was when called, not as it is when the engines finish", async () => {
    const net: any = sir();
    const pending = checkModel(net);
    net.places.S.initial = [-1]; // the person keeps editing
    net.arcs.push({ source: "S", target: "nowhere", weight: [1] });
    assertEquals((await pending).count, 0);
    assertEquals((await checkModel(net)).level, "error");
});

Deno.test("checkModel: with no model, a registry's own document is checked (the Assistant's sandbox), read-only", async () => {
    const sandbox = new Registry(createHeadlessHost(sir()));
    const host = sandbox.host as any; // an arc to a place that does not exist: the registry's edit commands refuse it, a raw commit does not
    host.commit({ ...host.getModel(), arcs: [...host.getModel().arcs, { source: "recover", target: "nowhere", weight: [1], inhibitTransition: false }] });
    const docBefore = JSON.stringify(host.getModel());
    const artifactsBefore = sandbox.artifacts().length;
    const s = await checkModel(null, { registry: sandbox });
    assertEquals(s.level, "error");
    assert(s.items.some((i: any) => /"nowhere" is not a declared/.test(i.message)));
    assertEquals(JSON.stringify(host.getModel()), docBefore); // nothing committed
    assertEquals(sandbox.artifacts().length, artifactsBefore); // nothing stored in Results
    // an explicit model wins over the registry's
    assertEquals((await checkModel(sir(), { registry: sandbox })).count, 0);
});

Deno.test("checkModel: agrees with analysis.check, the command it mirrors", async () => {
    const warn: any = sir();
    warn.places.lonely = { initial: [0], capacity: [0], x: 0, y: 0 };
    const broken: any = sir();
    broken.arcs.push({ source: "recover", target: "nowhere", weight: [1] });
    broken.places.S.initial = [-1];
    for (const net of [sir(), warn, broken]) {
        const reg = new Registry(createHeadlessHost(net));
        const out = await reg.execute("analysis.check");
        const viaCommand = summarize({ report: reg.artifact(out.artifact).data });
        assertEquals(await checkModel(null, { registry: reg }), viaCommand);
        assertEquals(await checkModel(reg.host.getModel()), viaCommand);
    }
});

Deno.test("checkModel: never rejects — a bad input is an error item", async () => {
    for (const bad of [null, undefined, "net", 3, []]) {
        const s = await checkModel(bad as any);
        assertEquals(s.level, "error", String(bad));
        assertEquals(s.items[0].where, "(net)");
    }
    const cyclic: any = {};
    cyclic.self = cyclic;
    const c = await checkModel(cyclic);
    assertEquals(c.level, "error");
    assert(/could not run/.test(c.items[0].message), c.items[0].message);
});

Deno.test("checkModel: loadCheck adds what was repaired at load to the same summary", async () => {
    const incoming = sir();
    incoming.places.S.capacity = [500];
    incoming.places.S.initial = [1590];
    const loadCheck = validateNet(incoming);
    const live = createHeadlessHost(incoming).getModel(); // normalized: clamped to 500, so clean now
    const plain = await checkModel(live);
    assertEquals(plain.count, 0);
    const s = await checkModel(live, { loadCheck });
    assertEquals([s.level, s.repaired, s.count], ["warn", 1, 1]);
    assertEquals(s.items[0].severity, "repaired");
    // and through the monitor, as petri-view will wire it
    const m = new ProblemsMonitor({ getModel: () => live, check: (net: any) => checkModel(net, { loadCheck }) });
    assertEquals((await m.run())!.repaired, 1);
});

// ---- ProblemsMonitor --------------------------------------------------------

// Fake timers: nothing sleeps. advance(ms) fires what has come due, in order.
function fakeTimers() {
    let now = 0;
    let nextId = 1;
    const pending = new Map<number, { at: number; fn: () => void }>();
    return {
        setTimer: (fn: () => void, ms: number) => { const id = nextId++; pending.set(id, { at: now + ms, fn }); return id; },
        clearTimer: (id: number) => { pending.delete(id); },
        advance(ms: number) {
            now += ms;
            for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
                if (t.at <= now && pending.has(id)) { pending.delete(id); t.fn(); }
            }
        },
        get waiting() { return pending.size; },
    };
}

const okSummary = () => summarize({});
const errSummary = (...paths: string[]) => summarize({ report: { errors: paths.map((path) => ({ path, message: "bad" })), warnings: [] } });
const tick = () => new Promise<void>((r) => queueMicrotask(r)); // let promise continuations run, without a timer

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

Deno.test("monitor: a burst of edits runs one check, on the last model", async () => {
    const t = fakeTimers();
    let model: any = { v: 0 };
    const seen: any[] = [];
    const changes: any[] = [];
    const m = new ProblemsMonitor({
        getModel: () => model,
        check: async (mm: any) => { seen.push(mm); return okSummary(); },
        onChange: (s: any) => changes.push(s),
        setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    for (let v = 1; v <= 5; v++) { model = { v }; m.schedule(); t.advance(100); } // never quiet for 400 ms
    assertEquals(seen.length, 0);
    assertEquals(t.waiting, 1);
    assert(m.state.checking);
    t.advance(400);
    await tick(); await tick();
    assertEquals(seen, [{ v: 5 }]);
    assertEquals(changes.length, 1);
    assertEquals(t.waiting, 0);
    assert(!m.state.checking);
    assertEquals(m.state.summary, okSummary());
});

Deno.test("monitor: delayMs sets the quiet time", () => {
    const t = fakeTimers();
    let ran = 0;
    const m = new ProblemsMonitor({ getModel: () => ({}), check: async () => { ran++; return okSummary(); }, delayMs: 50, setTimer: t.setTimer, clearTimer: t.clearTimer });
    m.schedule();
    t.advance(49);
    assertEquals(ran, 0);
    t.advance(1);
    assertEquals(ran, 1);
});

Deno.test("monitor: run() checks now, cancels the waiting check, and resolves to the summary", async () => {
    const t = fakeTimers();
    let ran = 0;
    const m = new ProblemsMonitor({ getModel: () => ({}), check: async () => { ran++; return errSummary("a"); }, setTimer: t.setTimer, clearTimer: t.clearTimer });
    m.schedule();
    const s = await m.run();
    assertEquals(ran, 1);
    assertEquals(s, errSummary("a"));
    assertEquals(t.waiting, 0); // the scheduled check was folded into this one
    t.advance(1000);
    assertEquals(ran, 1);
    assertEquals(m.state, { summary: s, checking: false });
});

Deno.test("monitor: onChange fires only when the summary changes", async () => {
    const t = fakeTimers();
    const results = [errSummary("a"), errSummary("a"), okSummary()];
    const changes: any[] = [];
    const m = new ProblemsMonitor({
        getModel: () => ({}), check: async () => results.shift()!,
        onChange: (s: any) => changes.push(s.label), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    await m.run(); await m.run(); await m.run();
    assertEquals(changes, ["1 problem", "No problems"]);
});

Deno.test("monitor: a result that went stale while the check ran is dropped", async () => {
    const t = fakeTimers();
    const first = deferred<any>();
    const second = deferred<any>();
    const queue = [first, second];
    const changes: any[] = [];
    const m = new ProblemsMonitor({
        getModel: () => ({}), check: () => queue.shift()!.promise,
        onChange: (s: any) => changes.push(s), setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    const run1 = m.run();                 // checking the net as it was
    m.schedule();                          // ...the person edits meanwhile
    first.resolve(errSummary("old"));
    assertEquals(await run1, null);        // dropped: nothing accepted yet
    assertEquals(m.state.summary, null);
    assertEquals(changes, []);
    t.advance(400);                        // the scheduled check runs on the new net
    second.resolve(okSummary());
    await tick(); await tick();
    assertEquals(m.state.summary, okSummary());
    assertEquals(changes, [okSummary()]);
});

Deno.test("monitor: when two checks overlap, the older one finishing last does not overwrite the newer", async () => {
    const a = deferred<any>();
    const b = deferred<any>();
    const queue = [a, b];
    const changes: string[] = [];
    const m = new ProblemsMonitor({ getModel: () => ({}), check: () => queue.shift()!.promise, onChange: (s: any) => changes.push(s.label) });
    const runA = m.run();
    const runB = m.run();
    b.resolve(errSummary("new"));
    assertEquals(await runB, errSummary("new"));
    a.resolve(errSummary("x", "y", "z"));
    // the stale run resolves to the latest accepted summary, not its own
    assertEquals(await runA, errSummary("new"));
    assertEquals(m.state.summary, errSummary("new"));
    assertEquals(changes, ["1 problem"]);
    assert(!m.state.checking);
});

Deno.test("monitor: a check that throws is an error item, not a silent All clear, and the monitor keeps working", async () => {
    let fail = true;
    const m = new ProblemsMonitor({ getModel: () => ({}), check: async () => { if (fail) throw new Error("boom"); return okSummary(); } });
    const bad = await m.run();
    assertEquals(bad!.level, "error");
    assert(/could not run: boom/.test(bad!.items[0].message));
    fail = false;
    assertEquals((await m.run())!.level, "ok");
    // a check that returns nothing is the same
    const n = new ProblemsMonitor({ getModel: () => ({}), check: (async () => undefined) as any });
    assertEquals((await n.run())!.level, "error");
});

Deno.test("monitor: with no net yet there is nothing to check", async () => {
    let ran = 0;
    const m = new ProblemsMonitor({ getModel: () => undefined, check: async () => { ran++; return okSummary(); } });
    assertEquals(await m.run(), null);
    assertEquals(ran, 0);
    const throws = new ProblemsMonitor({ getModel: () => { throw new Error("not ready"); }, check: async () => { ran++; return okSummary(); } });
    assertEquals(await throws.run(), null);
    assertEquals(ran, 0);
});

Deno.test("monitor: destroy() cancels the timer and drops a check still running", async () => {
    const t = fakeTimers();
    const pending = deferred<any>();
    let changes = 0;
    const m = new ProblemsMonitor({ getModel: () => ({}), check: () => pending.promise, onChange: () => { changes++; }, setTimer: t.setTimer, clearTimer: t.clearTimer });
    m.schedule();
    assertEquals(t.waiting, 1);
    m.destroy();
    assertEquals(t.waiting, 0);
    m.schedule(); // after destroy: nothing is set
    assertEquals(t.waiting, 0);
    const mid = new ProblemsMonitor({ getModel: () => ({}), check: () => pending.promise, onChange: () => { changes++; } });
    const run = mid.run();
    mid.destroy();
    pending.resolve(errSummary("late"));
    assertEquals(await run, null);
    assertEquals(changes, 0);
    assertEquals(await mid.run(), null); // run() after destroy does not check
});

Deno.test("monitor: subscribe() adds a listener, and its unsubscribe removes it; a throwing listener breaks nothing", async () => {
    const got: string[] = [];
    const results = [errSummary("a"), okSummary()];
    const m = new ProblemsMonitor({ getModel: () => ({}), check: async () => results.shift()! });
    m.subscribe(() => { throw new Error("listener bug"); });
    const off = m.subscribe((s: any) => got.push(s.label));
    await m.run();
    off();
    await m.run();
    assertEquals(got, ["1 problem"]);
    assertEquals(m.state.summary, okSummary());
});

Deno.test("monitor: needs getModel, and works end to end with the real checkModel", async () => {
    let threw = false;
    try { new ProblemsMonitor({} as any); } catch { threw = true; }
    assert(threw);
    const t = fakeTimers();
    let net: any = sir();
    const m = new ProblemsMonitor({ getModel: () => net, setTimer: t.setTimer, clearTimer: t.clearTimer });
    assertEquals((await m.run())!.label, "No problems");
    net = { ...sir(), arcs: [...sir().arcs, { source: "S", target: "nowhere", weight: [1] }] };
    m.schedule();
    t.advance(400);
    for (let i = 0; i < 50 && m.state.checking; i++) await new Promise((r) => setTimeout(r, 0)); // the real engines, a few ticks
    assertEquals(m.state.summary!.level, "error");
});

// ---- applyGate --------------------------------------------------------------

Deno.test("applyGate: errors in the pending net are allowed through, but the list is shown first", () => {
    const g = applyGate(errSummary("a", "b"));
    assertEquals(g.block, false); // the person decides
    assertEquals(g.warn, true);   // ...after seeing the problems
    assert(/2 errors/.test(g.message), g.message);
    assert(/still apply/.test(g.message), g.message);
    assertEquals(applyGate(errSummary("a")).message.includes("1 error in"), true);
    // never blocks, however bad
    assertEquals(applyGate(errSummary(...Array.from({ length: 500 }, (_, i) => `p${i}`))).block, false);
});

Deno.test("applyGate: nothing to warn about for a clean net, warnings, repairs, or no summary", () => {
    const quiet = { block: false, warn: false, message: "" };
    assertEquals(applyGate(okSummary()), quiet);
    assertEquals(applyGate(null), quiet);
    assertEquals(applyGate(summarize({ report: { errors: [], warnings: [{ path: "x", message: "w" }] } })), quiet);
    assertEquals(applyGate(summarize({ loadCheck: { errors: [{ path: "x", message: "r" }] } })), quiet);
});

Deno.test("applyGate: gates the summary checkModel gives for a pending sandbox net", async () => {
    const sandbox = new Registry(createHeadlessHost(sir()));
    const host = sandbox.host as any;
    host.commit({ ...host.getModel(), arcs: [...host.getModel().arcs, { source: "S", target: "nowhere", weight: [1], inhibitTransition: false }] });
    const gate = applyGate(await checkModel(null, { registry: sandbox }));
    assertEquals([gate.block, gate.warn], [false, true]);
    assertEquals(applyGate(await checkModel(sir())).warn, false);
});

// ---- the chip and the list --------------------------------------------------

const threeProblems = () => summarize({
    report: {
        errors: [{ path: "arcs[5].target", message: '"nowhere" is not a declared place or transition' }],
        warnings: [{ path: "places.lonely", message: "no arc touches this place" }],
    },
    loadCheck: { errors: [{ path: "places.S.initial[0]", message: "1590 exceeds capacity 500; the editor would clamp it to 500" }] },
});

Deno.test("chipHtml: a button with a dot and the label, the first problem in its title", () => {
    const html = chipHtml(threeProblems());
    assert(/<button type="button" role="button" class="pv-problems-chip" data-level="error"/.test(html), html);
    assert(html.includes('aria-label="3 problems, open the list"'), html);
    assert(html.includes('<span class="pv-problems-label">3 problems</span>'), html);
    assert(html.includes('class="pv-problems-dot" aria-hidden="true"'), html);
    // the first problem is the first error; the rest are counted
    assert(html.includes('title="Error: arcs[5].target: &quot;nowhere&quot; is not a declared place or transition (and 2 more)"'), html);
});

Deno.test("chipHtml: a polite status region announces changes", () => {
    const html = chipHtml(summarize({}));
    assert(/<span class="pv-problems-live" role="status" aria-live="polite" aria-atomic="true"><\/span>/.test(html), html);
    // empty at render: mountProblemsChip fills it when a result changes
    assert(html.includes('data-level="ok"') && html.includes("No problems</span>") && html.includes('aria-label="No problems, open the list"'));
});

Deno.test("chipHtml: one problem is singular; warn level; repaired and net-level wording", () => {
    const one = chipHtml(summarize({ report: { errors: [], warnings: [{ path: "", message: "nothing is enabled at the initial marking" }] } }));
    assert(one.includes('data-level="warn"') && one.includes('aria-label="1 problem, open the list"'), one);
    assert(one.includes('title="Warning: nothing is enabled at the initial marking"'), one); // no "(net):" for the net itself
    const rep = chipHtml(summarize({ loadCheck: { errors: [{ path: "places.S.initial[0]", message: "clamped" }] } }));
    assert(rep.includes('title="Repaired on load: places.S.initial[0]: clamped"'), rep);
});

Deno.test("chipHtml: before the first check the chip says so, and everything from the net is escaped", () => {
    const pending = chipHtml(null);
    assert(pending.includes('data-level="pending"') && pending.includes("Checking…"), pending);
    const evil = summarize({ report: { errors: [{ path: 'x"><img src=x onerror=alert(1)>', message: `<script>alert('x')</script>` }], warnings: [] } });
    const html = chipHtml(evil);
    assert(!html.includes("<img") && !html.includes("<script"), html);
    assert(html.includes("&lt;script&gt;") && html.includes("&quot;&gt;&lt;img"), html);
    // a crafted level cannot break out of the attribute
    assert(chipHtml({ ...evil, level: 'x" onclick="y' } as any).includes('data-level="error"'));
});

Deno.test("problemsListHtml: where and message per problem, the kind named, the breakdown said", () => {
    const html = problemsListHtml(threeProblems());
    assert(html.includes('<p class="pv-problems-summary">3 problems: 1 error, 1 repaired on load, 1 warning.</p>'), html);
    const rows = [...html.matchAll(/<li class="pv-problem" data-severity="(\w+)"><span class="pv-problem-kind">([^<]+)<\/span><code class="pv-problem-where">([^<]*)<\/code><span class="pv-problem-message">([^<]*)<\/span><\/li>/g)];
    assertEquals(rows.map((r) => [r[1], r[2], r[3]]), [
        ["error", "Error", "arcs[5].target"],
        ["repaired", "Repaired on load", "places.S.initial[0]"],
        ["warning", "Warning", "places.lonely"],
    ]);
    assert(rows[0][4].includes("&quot;nowhere&quot; is not a declared place"));
    assert(html.includes('data-level="error"'));
});

Deno.test("problemsListHtml: uses the caller's escaper, escapes by default, and a clean net or no summary have a sentence", () => {
    const calls: string[] = [];
    const html = problemsListHtml(threeProblems(), { esc: (s: string) => { calls.push(s); return `[${s}]`; } });
    assert(html.includes("[arcs[5].target]") && html.includes("[places.lonely]"), html);
    assert(calls.includes("no arc touches this place"));
    const evil = problemsListHtml(summarize({ report: { errors: [{ path: "<b>", message: "<i>" }], warnings: [] } }));
    assert(!evil.includes("<b>") && !evil.includes("<i>") && evil.includes("&lt;b&gt;"), evil);
    assert(problemsListHtml(summarize({})).includes("No problems found in this net."));
    assert(problemsListHtml(null).includes("Not checked yet."));
    // a hand-made item cannot invent a severity class
    const odd = problemsListHtml({ ...threeProblems(), items: [{ severity: 'x" onmouseover="y', where: "w", message: "m" }] } as any);
    assert(odd.includes('data-severity="error"') && !odd.includes("onmouseover"), odd);
});

Deno.test("problemsListHtml: a long list is capped, and says how many are not shown", () => {
    const warnings = Array.from({ length: 250 }, (_, i) => ({ path: `places.p${i}`, message: "no arc touches this place" }));
    const html = problemsListHtml(summarize({ report: { errors: [], warnings } }));
    assertEquals((html.match(/<li class="pv-problem"/g) || []).length, 200);
    assert(html.includes("and 50 more not shown"));
    assert(html.includes("250 problems: 250 warnings."));
});

// A stand-in for the few DOM members mountProblemsChip uses; no parsing.
function fakeNode() {
    const attrs = new Map<string, string>();
    const handlers = new Set<() => unknown>();
    return {
        textContent: "",
        attrs,
        setAttribute: (k: string, v: string) => { attrs.set(k, String(v)); },
        addEventListener: (_t: string, fn: () => unknown) => { handlers.add(fn); },
        removeEventListener: (_t: string, fn: () => unknown) => { handlers.delete(fn); },
        listeners: () => handlers.size,
        click: () => Promise.all([...handlers].map((fn) => fn())),
    };
}

function fakeHost() {
    const nodes = { ".pv-problems-chip": fakeNode(), ".pv-problems-label": fakeNode(), ".pv-problems-live": fakeNode() } as Record<string, ReturnType<typeof fakeNode>>;
    const asked: string[] = [];
    return {
        innerHTML: "",
        nodes,
        asked,
        querySelector(sel: string) { asked.push(sel); return nodes[sel] ?? null; },
    };
}

Deno.test("mountProblemsChip: renders the chip, finds its parts, and updates them in place", () => {
    const host = fakeHost();
    const chip = mountProblemsChip(host as any, { state: { summary: null } });
    // every part it looks for is in the markup chipHtml produced
    for (const sel of host.asked) assert(host.innerHTML.includes(`class="${sel.slice(1)}"`), `${sel} in ${host.innerHTML}`);
    assert(host.innerHTML.includes("Checking…"));
    chip.update(threeProblems());
    const { ".pv-problems-chip": btn, ".pv-problems-label": label } = host.nodes;
    assertEquals(label.textContent, "3 problems");
    assertEquals(btn.attrs.get("data-level"), "error");
    assertEquals(btn.attrs.get("aria-label"), "3 problems, open the list");
    assert(btn.attrs.get("title")!.startsWith("Error: arcs[5].target:"));
    chip.update(summarize({}));
    assertEquals(label.textContent, "No problems");
    assertEquals(btn.attrs.get("data-level"), "ok");
    assertEquals(btn.attrs.get("title"), "No problems found in this net");
});

Deno.test("mountProblemsChip: the live region speaks when the count or level changes, not on every keystroke", () => {
    const host = fakeHost();
    const chip = mountProblemsChip(host as any, { state: { summary: null } });
    const live = host.nodes[".pv-problems-live"];
    chip.update(summarize({}));
    assertEquals(live.textContent, ""); // a clean net on load says nothing
    chip.update(errSummary("a", "b"));
    assert(live.textContent.startsWith("2 problems. Error: a: bad"), live.textContent);
    const said = live.textContent;
    chip.update(errSummary("c", "d")); // different problems, same count: quiet
    assertEquals(live.textContent, said);
    chip.update(errSummary("c"));
    assert(live.textContent.startsWith("1 problem."), live.textContent);
    chip.update(summarize({}));
    assertEquals(live.textContent, "No problems");
    // first result already has problems: that is worth saying
    const host2 = fakeHost();
    mountProblemsChip(host2 as any, { state: { summary: null } }).update(errSummary("x"));
    assert(host2.nodes[".pv-problems-live"].textContent.startsWith("1 problem."));
});

Deno.test("mountProblemsChip: follows the monitor, and a click opens the list with the latest summary", async () => {
    const host = fakeHost();
    const results = [errSummary("a", "b"), summarize({})];
    const monitor = new ProblemsMonitor({ getModel: () => ({}), check: async () => results.shift()! });
    const opened: any[] = [];
    mountProblemsChip(host as any, monitor, { onOpen: (s: any) => opened.push(s) });
    await monitor.run();
    assertEquals(host.nodes[".pv-problems-label"].textContent, "2 problems");
    await host.nodes[".pv-problems-chip"].click();
    assertEquals(opened.map((s) => s.label), ["2 problems"]);
    await monitor.run();
    assertEquals(host.nodes[".pv-problems-label"].textContent, "No problems");
    await host.nodes[".pv-problems-chip"].click();
    assertEquals(opened.map((s) => s.label), ["2 problems", "No problems"]);
});

Deno.test("mountProblemsChip: a click before the first result checks first; with no net it opens with null", async () => {
    const host = fakeHost();
    let ran = 0;
    const monitor = new ProblemsMonitor({ getModel: () => ({}), check: async () => { ran++; return errSummary("a"); } });
    const opened: any[] = [];
    mountProblemsChip(host as any, monitor, { onOpen: (s: any) => opened.push(s) });
    await host.nodes[".pv-problems-chip"].click();
    assertEquals(ran, 1);
    assertEquals(opened[0].label, "1 problem");
    const host2 = fakeHost();
    const none = new ProblemsMonitor({ getModel: () => undefined });
    const opened2: any[] = [];
    mountProblemsChip(host2 as any, none, { onOpen: (s: any) => opened2.push(s) });
    await host2.nodes[".pv-problems-chip"].click();
    assertEquals(opened2, [null]);
});

Deno.test("mountProblemsChip: destroy() unhooks the click, unsubscribes from the monitor and empties the host", async () => {
    const host = fakeHost();
    const monitor = new ProblemsMonitor({ getModel: () => ({}), check: async () => errSummary("a") });
    const opened: any[] = [];
    const chip = mountProblemsChip(host as any, monitor, { onOpen: (s: any) => opened.push(s) });
    const btn = host.nodes[".pv-problems-chip"];
    assertEquals(btn.listeners(), 1);
    chip.destroy();
    assertEquals(btn.listeners(), 0);
    assertEquals(host.innerHTML, "");
    await monitor.run(); // no longer reaches the chip
    assertEquals(host.nodes[".pv-problems-label"].textContent, "");
    chip.update(errSummary("z")); // a late update is ignored
    assertEquals(host.nodes[".pv-problems-label"].textContent, "");
    assertEquals(opened, []);
});

Deno.test("mountProblemsChip: works with update() alone, for a caller that does its own wiring", () => {
    const host = fakeHost();
    const chip = mountProblemsChip(host as any, null as any);
    chip.update(errSummary("a"));
    assertEquals(host.nodes[".pv-problems-label"].textContent, "1 problem");
});

Deno.test("the chip and the list have styles: every class the markup uses has a rule in petri-view.css", async () => {
    const css = await Deno.readTextFile(new URL("./petri-view.css", import.meta.url));
    const used = new Set<string>();
    for (const html of [chipHtml(threeProblems()), problemsListHtml(threeProblems()), problemsListHtml(null), problemsListHtml(summarize({}))]) {
        for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => used.add(c));
    }
    used.add("pv-problems-more"); // only past the cap
    for (const c of used) assert(new RegExp(`\\.${c}\\b`).test(css), `.${c} has no rule in petri-view.css`);
    // the three levels and the three severities are styled
    for (const level of ["ok", "warn", "error", "pending"]) assert(css.includes(`.pv-problems-chip[data-level="${level}"]`), level);
    for (const sev of ["error", "repaired", "warning"]) assert(css.includes(`.pv-problem[data-severity="${sev}"]`), sev);
});
