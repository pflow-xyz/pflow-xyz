import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    defaultVersions, footerHtml, isStale, mcpCallText, normalizeCalls, provenance, recordFromCall, recordFromGoalRun, rerun, shortCid, wireFooter, FOOTER_ACTS, WASM_BUILD, ENGINE_FREE, engineOf,
} from "./petri-provenance.js";
import { runGoal } from "./petri-goals.js";
import { REPLAY_ALLOWLIST } from "./petri-viewspec.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { NATIVE_VERSION } from "./vendor/pflow-native-wasm/commands.js";
import { CDN } from "./vendor/pflow-native-wasm/cdn.js";

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const goalById = (id: string) => catalog.goals.find((g: any) => g.id === id);

// SIR with rates: 50 tokens, so sim.recommend says SSA.
const sir = () => ({
    places: { S: { initial: [45], capacity: [0], x: 0, y: 0 }, I: { initial: [5], capacity: [0], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
    transitions: { infect: { x: 50, y: 0, rate: 0.01 }, recover: { x: 150, y: 0, rate: 0.1 } },
    arcs: [
        { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
        { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
        { source: "recover", target: "R", weight: [1] },
    ],
});
const registry = () => new Registry(createHeadlessHost(sir())) as any;

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

const HOSTILE = `<img src=x onerror="alert(1)">'&"</details><script>boom()</script>`;

Deno.test("provenance: a plain record with every field, args copied, defaults filled", () => {
    const args = { t_end: 42, runs: 20, seed: 1 };
    const r = provenance({
        goal: { id: "risk", question: "How bad can it get?", extra: "dropped" } as any,
        calls: [{ command: "sim.recommend", args: {} }, { command: "sim.ssa", args }],
        engine: { name: "SSA", reason: "capacities", overridden: false, warning: "" },
        assumed: [{ key: "runs", text: "runs = 20", change: "runs" }],
        caveat: "Twenty runs give a spread.",
        net: { cid: "zb2rhk3abcdefg", revision: 4 },
        note: "It overflows in 7 of 20.",
    });
    assertEquals(r.goal, { id: "risk", question: "How bad can it get?" });
    assertEquals(r.calls, [{ command: "sim.recommend", args: {} }, { command: "sim.ssa", args }]);
    args.runs = 99;
    assertEquals(r.calls[1].args.runs, 20, "the record holds a copy, not the caller's object");
    assertEquals(r.engine, { name: "SSA", reason: "capacities" });
    assertEquals(r.assumed, [{ key: "runs", text: "runs = 20", change: "runs" }]);
    assertEquals(r.net, { cid: "zb2rhk3abcdefg", revision: 4 });
    assertEquals(r.versions, { registry: `pflow-native ${NATIVE_VERSION} wasm ${CDN.sha256.slice(0, 7)}`, app: "unknown" });
    assertEquals(r.note, { by: "assistant", text: "It overflows in 7 of 20." });
    assertEquals(JSON.parse(JSON.stringify(r)), r, "plain data: JSON round trip is the identity");

    const bare = provenance();
    assertEquals([bare.goal, bare.engine, bare.note, bare.calls, bare.assumed, bare.caveat, bare.warnings], [null, null, null, [], [], "", []]);
    assertEquals(bare.net, { revision: 0 });
});

Deno.test("provenance: calls accept id for command, refuse a call with neither", () => {
    assertEquals(normalizeCalls([{ id: "sim.ode", args: { t_end: 5 } }]), [{ command: "sim.ode", args: { t_end: 5 } }]);
    assertEquals(normalizeCalls([{ command: "sim.marking" }]), [{ command: "sim.marking", args: {} }]);
    assertThrows(() => normalizeCalls([{ args: {} }]), TypeError, "no command");
});

Deno.test("defaultVersions names pflow-native by its version and the wasm build, and takes a commit and the app", () => {
    const wasm = CDN.sha256.slice(0, 7);
    assertEquals(WASM_BUILD, wasm);
    assertEquals(defaultVersions(), { registry: `pflow-native ${NATIVE_VERSION} wasm ${wasm}`, app: "unknown" });
    assertEquals(defaultVersions({ commit: "d0f4a477c0e0e2c861363b7b4c53bc9388b82d84", app: "abc123" }), { registry: `pflow-native ${NATIVE_VERSION} d0f4a47 wasm ${wasm}`, app: "abc123" });
    assertEquals(defaultVersions({ registry: "js" }).registry, "js");
});

Deno.test("the registry version the footer reports is the one pflow-native-wasm.lock pins, down to the wasm build", async () => {
    const lock = JSON.parse(await Deno.readTextFile(new URL("../pflow-native-wasm.lock", import.meta.url)));
    assertEquals(lock.version, NATIVE_VERSION);
    // NATIVE_VERSION stayed "0.8.0" across many wasm builds; the build id is what changes on a re-vendor
    assertEquals(lock.files["pflow_native_wasm_bg.wasm"], CDN.sha256);
    assertEquals(defaultVersions().registry.split(" ").at(-1), lock.files["pflow_native_wasm_bg.wasm"].slice(0, 7), "the id the footer carries is the locked wasm's");
    const head = (await Deno.readTextFile(new URL("./vendor/pflow-native-wasm/commands.js", import.meta.url))).split("\n")[0];
    assertStringIncludes(head, lock.commit, "commands.js was generated from the locked commit");
});

Deno.test("footerHtml: collapsed by default, open on request; the rows of the design, in order", () => {
    const r = provenance({
        goal: { id: "risk", question: "How bad can it get? What's the spread?" },
        calls: [{ command: "sim.recommend", args: {} }, { command: "sim.ssa", args: { t_end: 42, runs: 20, seed: 1 } }],
        engine: { name: "SSA", reason: "recommended: this net has capacities (rule 1)" },
        assumed: [{ key: "t_end", text: "t_end = 42 from sim.recommend" }],
        caveat: "Twenty runs give a spread, not a tail probability.",
        net: { cid: "zb2rhxxxxxxxxxxk3", revision: 2 },
    });
    const closed = footerHtml(r);
    assert(closed.startsWith("<details"), closed);
    assert(!/<details[^>]*\sopen/.test(closed), "collapsed by default");
    assert(/<details[^>]*\sopen/.test(footerHtml(r, { open: true })), "open when asked");
    assertStringIncludes(closed, "How this was computed");
    const labels = [...closed.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]);
    assertEquals(labels, ["Goal", "Engine", "Calls", "Assumed", "Caveat", "Version"]);
    assertStringIncludes(closed, "<code>sim.ssa</code>");
    assertStringIncludes(closed, "Twenty runs give a spread, not a tail probability.");
    assertStringIncludes(closed, "zb2rh…k3");
    assertStringIncludes(closed, `pflow-native ${NATIVE_VERSION} wasm ${WASM_BUILD}`);
    const acts = [...closed.matchAll(/<button[^>]*data-act="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
    assertEquals(acts, [["rerun", "Rerun"], ["edit", "Edit settings"], ["mcp", "Copy MCP call"], ["link", "Copy link"], ["tools", "Open in Tools"]]);
    assertEquals(FOOTER_ACTS.map(([a]) => a), ["rerun", "edit", "mcp", "link", "tools"]);
});

Deno.test("footerHtml: no goal means no Goal row (a palette or Classic run); empty rows are left out", () => {
    const r = recordFromCall({ command: "sim.ode", args: { t_end: 5 } });
    const html = footerHtml(r);
    const labels = [...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]);
    assertEquals(labels, ["Calls", "Version"]);
    assertStringIncludes(html, "net unsaved");
});

Deno.test("footerHtml: the engine row shows the warning chip text; the stale chip is optional", () => {
    const r = provenance({ calls: [{ command: "analysis.diagnose", args: {} }], engine: { name: "ODE", reason: "chosen", overridden: true, warning: "this net has capacities; the ODE ignores them" } });
    const html = footerHtml(r);
    assertStringIncludes(html, `<span class="pv-prov-chip pv-prov-warn">this net has capacities; the ODE ignores them</span>`);
    assertStringIncludes(html, "overridden");
    assert(!footerHtml(r).includes("net changed since"));
    assertStringIncludes(footerHtml(r, { stale: true }), "net changed since");
});

Deno.test("footerHtml: hostile text in the goal, the args, the note and the rest is escaped everywhere", () => {
    const r = provenance({
        goal: { id: HOSTILE, question: HOSTILE },
        calls: [{ command: HOSTILE, args: { place: HOSTILE, nested: { [HOSTILE]: HOSTILE } } }],
        engine: { name: HOSTILE, reason: HOSTILE, warning: HOSTILE },
        assumed: [{ key: HOSTILE, text: HOSTILE, change: HOSTILE }],
        caveat: HOSTILE,
        net: { cid: HOSTILE + HOSTILE, revision: HOSTILE },
        versions: { registry: HOSTILE, app: HOSTILE },
        note: HOSTILE,
        warnings: [HOSTILE],
    });
    for (const open of [false, true]) {
        const html = footerHtml(r, { open, stale: true });
        for (const bad of ["<img", "<script", "</details><", 'onerror="', "<script>boom"]) {
            // the only tags in the output are the footer's own
            assert(!html.includes(bad), `${bad} leaked: ${html}`);
        }
        const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
        assertEquals([...tags].sort(), ["b", "button", "code", "dd", "details", "div", "dl", "dt", "li", "ol", "span", "summary", "ul"]);
        assertStringIncludes(html, "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    }
});

Deno.test("footerHtml: a long argument list is cut for display and kept whole in the title", () => {
    const places = Array.from({ length: 200 }, (_, i) => `place_${i}`);
    const html = footerHtml(provenance({ calls: [{ command: "sim.ode", args: { places } }] }));
    assertStringIncludes(html, "…</code>");
    assertStringIncludes(html, "place_199");
});

Deno.test("mcpCallText: one call is an object, several an array, as the editor's Copy MCP call writes it", () => {
    const one = provenance({ calls: [{ command: "sim.ssa", args: { t_end: 5, seed: 3 } }] });
    assertEquals(mcpCallText(one), JSON.stringify({ name: "sim.ssa", arguments: { t_end: 5, seed: 3 } }, null, 2));
    const two = provenance({ calls: [{ command: "sim.recommend", args: {} }, { command: "sim.ssa", args: { runs: 2 } }] });
    assertEquals(JSON.parse(mcpCallText(two)), [{ name: "sim.recommend", arguments: {} }, { name: "sim.ssa", arguments: { runs: 2 } }]);
    assertEquals(mcpCallText(provenance()), "[]");
});

Deno.test("recordFromGoalRun: the risk goal on a net with 50 tokens", async () => {
    const reg = registry();
    const goal = goalById("risk");
    const run = await runGoal(reg, goal, {});
    assert(run.ok);
    const r = recordFromGoalRun(goal, run, { net: { cid: "zb2rhabcdefghij", revision: 3 }, versions: defaultVersions({ app: "rev1" }) });
    assertEquals(r.goal, { id: "risk", question: goal.question });
    assertEquals(r.calls.map((c: any) => c.command), ["sim.recommend", "sim.ssa"]);
    const rec = run.steps[0].result;
    assertEquals(r.calls[1].args, { t_end: rec.t_end, runs: 20, seed: 1 });
    assertEquals(r.engine, { name: "SSA", reason: rec.why });
    assertEquals(r.caveat, goal.caveat);
    const keys = r.assumed.map((a: any) => a.key);
    assertEquals(keys, ["t_end", "runs", "seed"]);
    assertEquals(r.assumed[0].text, `t_end = ${rec.t_end} from sim.recommend`);
    assertEquals(r.assumed[1].text, "runs = 20 (set by the risk goal)");
    assertEquals(r.net, { cid: "zb2rhabcdefghij", revision: 3 });
    assertEquals(r.versions.app, "rev1");
    assertEquals(r.note, null);
    // a record is plain data and carries the answer's shape, not its numbers
    assertEquals(JSON.parse(JSON.stringify(r)), r);
});

Deno.test("recordFromGoalRun: a step that did not run is not a call; the engine used is named against the recommendation", async () => {
    const reg = registry();
    const goal = goalById("knob");
    const run = await runGoal(reg, goal, { observable: "R" });
    assert(run.ok);
    assert(run.steps.some((s: any) => s.skipped), "the ODE diagnosis is skipped on an SSA net");
    const r = recordFromGoalRun(goal, run, { inputs: { observable: "R" } });
    assertEquals(r.calls.map((c: any) => c.command), ["sim.recommend", "analysis.diagnose_ssa"]);
    assertEquals(r.engine?.name, "SSA");
    assertEquals(r.engine?.overridden, undefined);
    // the typed observable is the person's, not an assumption; the recommendation's horizon and seed are
    assertEquals(r.assumed.map((a: any) => a.key), ["t_end", "runs", "seed"]);
    assertEquals(r.assumed.find((a: any) => a.key === "seed")?.text, `seed = 1 from sim.recommend`);
});

Deno.test("recordFromGoalRun: an engine that differs from the recommendation is flagged, a refused or failed step is not a call", () => {
    const goal = goalById("average");
    const run = {
        ok: false,
        steps: [
            { index: 0, command: "sim.recommend", args: {}, result: { engine: "ssa", why: "capacities", t_end: 10, seed: 1 } },
            { index: 1, command: "sim.ode", args: { t_end: 10 }, result: {}, artifacts: ["a1"] },
        ],
    };
    const r = recordFromGoalRun(goal, run);
    assertEquals(r.engine, { name: "ODE", reason: "sim.recommend advised SSA: capacities", overridden: true, warning: "ran ODE although sim.recommend says SSA" });
    const run2 = {
        ok: false,
        steps: [
            { index: 0, command: "sim.recommend", args: {}, result: { engine: "ssa", why: "w", t_end: 10 } },
            { index: 1, command: "sim.ode", args: { t_end: "x" }, refused: "the engine guard: capacities", warning: "refused by rule 1" },
            { index: 2, command: "sim.ode", args: {}, error: "boom" },
        ],
    };
    const r2 = recordFromGoalRun(goal, run2);
    assertEquals(r2.calls.map((c: any) => c.command), ["sim.recommend"]);
    assertEquals(r2.engine?.warning, "refused by rule 1");
    assertEquals(r2.warnings, ["sim.ode: boom"]);
});

Deno.test("recordFromCall: one call by hand has no goal; a chat entry works as is", () => {
    const r = recordFromCall({ command: "sim.ssa", name: "run_simulation", args: { seed: 5 }, ok: true } as any, { net: { revision: 9 } });
    assertEquals(r.goal, null);
    assertEquals(r.calls, [{ command: "sim.ssa", args: { seed: 5 } }]);
    assertEquals(r.net, { revision: 9 });
    assertThrows(() => recordFromCall({ args: {} } as any), TypeError);
});

Deno.test("rerun repeats the recorded calls exactly: a seeded SSA twice gives the same bytes", async () => {
    const reg = registry();
    const goal = goalById("risk");
    const record = recordFromGoalRun(goal, await runGoal(reg, goal, {}));
    const again = await rerun(reg, record);
    const third = await rerun(reg, record);
    assertEquals(again.map((e: any) => e.command), ["sim.recommend", "sim.ssa"]);
    assert(again.every((e: any) => !e.error));
    const art = (steps: any[]) => reg.artifact(steps[1].artifacts[0]);
    assertNotEquals(art(again).id, art(third).id, "each run files its own artifact");
    assertEquals(await sha(JSON.stringify(art(again).data)), await sha(JSON.stringify(art(third).data)));
    // and it is the original run's answer too
    const first = reg.artifacts()[0];
    assertEquals(JSON.stringify(first.data), JSON.stringify(art(again).data));
    // nothing was re-resolved: the arguments are the recorded ones
    assertEquals(again[1].args, record.calls[1].args);
});

Deno.test("rerun on a changed net stops at the call that fails, by name, and reports it", async () => {
    const reg = registry();
    const record = provenance({ calls: [{ command: "sim.marking", args: {} }, { command: "sim.ode", args: { places: ["queue"] } }, { command: "sim.marking", args: {} }] });
    const steps: any[] = [];
    const out = await rerun(reg, record, { onStep: (e: any) => steps.push(e.command) });
    assertEquals(out.length, 2, "stopped at the second call");
    assert(out[1].error?.includes("queue"), out[1].error);
    assertEquals(steps, ["sim.marking", "sim.ode"]);
    assertEquals(out[0].artifacts, []);
});

Deno.test("isStale compares the record's net revision with the current one; shortCid keeps ends", () => {
    const r = provenance({ net: { revision: 3 } });
    assert(!isStale(r, 3));
    assert(isStale(r, 4));
    assertEquals(shortCid("zb2rhabcdefghijk3"), "zb2rh…k3");
    assertEquals(shortCid("short"), "short");
    assertEquals(shortCid(undefined), "");
});

// ---- wireFooter, with just enough of a DOM ----

function fakeFooter() {
    const listeners: Array<(ev: any) => void> = [];
    const box: any = { id: "footer" };
    const root: any = {
        addEventListener: (_t: string, fn: any) => listeners.push(fn),
        removeEventListener: (_t: string, fn: any) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
        contains: (n: any) => n === box || n === root,
    };
    const button = (act: string, inside = true, field?: string) => {
        const b: any = {
            dataset: { act, ...(field ? { field } : {}) },
            closest: (sel: string) => (sel === "[data-act]" ? b : sel === "[data-prov]" ? (inside ? box : null) : null),
        };
        return b;
    };
    const click = (b: any) => listeners.slice().forEach((fn) => fn({ target: b }));
    return { root, button, click, listeners };
}

Deno.test("wireFooter: each button calls its handler with the record; missing handlers do nothing; unbinding stops it", () => {
    const { root, button, click, listeners } = fakeFooter();
    const record = provenance({ calls: [{ command: "sim.ode", args: {} }] });
    const seen: string[] = [];
    const handlers: any = {};
    for (const [act] of FOOTER_ACTS) if (act !== "tools") handlers[act] = (r: any, o: any) => { assertEquals(r, record); seen.push(act + (o.field ? `:${o.field}` : "")); };
    const off = wireFooter(root, record, handlers);
    assertEquals(listeners.length, 1);
    for (const [act] of FOOTER_ACTS) click(button(act));
    click(button("edit", true, "runs"));
    assertEquals(seen, ["rerun", "edit", "mcp", "link", "edit:runs"], "tools has no handler: a no-op, not an error");
    click(button("discard")); // somebody else's data-act
    click(button("rerun", false)); // outside any footer (the chat's own Rerun)
    click({ closest: () => null }); // not a button at all
    assertEquals(seen.length, 5);
    off();
    assertEquals(listeners.length, 0);
    click(button("rerun"));
    assertEquals(seen.length, 5);
});

Deno.test("wireFooter works with no handlers at all", () => {
    const { root, button, click } = fakeFooter();
    wireFooter(root, provenance());
    click(button("rerun"));
});

// ---- review round: the engine named is the engine that ran; one click, one handler ----

Deno.test("best_setting runs the ODE; the footer says ODE and that the recommender advised SSA, not the other way round", async () => {
    const reg = registry();
    const goal = goalById("best_setting");
    const inputs = { observable: "R", transition: "recover" };
    const run = await runGoal(reg, goal, inputs);
    assert(run.ok);
    assertEquals(run.steps.map((s: any) => s.command), ["sim.recommend", "opt.rate_scan"]);
    assertEquals(run.steps[0].result.engine, "ssa", "50 tokens: the recommender says SSA");
    const r = recordFromGoalRun(goal, run, { inputs });
    assertEquals(r.engine?.name, "ODE", "opt.rate_scan integrates the mass-action ODE");
    assertEquals(r.engine?.overridden, true);
    assertEquals(r.engine?.warning, "ran ODE although sim.recommend says SSA");
    assertStringIncludes(r.engine?.reason ?? "", "sim.recommend advised SSA");
    const row = footerHtml(r).match(/<dt>Engine<\/dt><dd>(.*?)<\/dd>/s)?.[1] ?? "";
    assertStringIncludes(row, "<b>ODE</b>");
    assertStringIncludes(row, "overridden");
    assert(!row.includes("<b>SSA</b>"), row);
});

Deno.test("every command a link may replay either names the engine it runs or is listed as running none", () => {
    for (const id of REPLAY_ALLOWLIST) {
        const named = engineOf(id, {});
        const free = ENGINE_FREE.includes(id);
        assert(named !== null || free, `${id}: add it to ENGINE_OF or ENGINE_FREE (petri-provenance.js), or the footer will name the recommender's engine for it`);
        assert(!(named !== null && free), `${id} is in both`);
    }
    for (const id of ENGINE_FREE) assert(REPLAY_ALLOWLIST.includes(id), `${id} is in ENGINE_FREE and not replayable`);
    assertEquals(engineOf("opt.rate_scan"), "ODE");
    assertEquals(engineOf("opt.heatmap"), "ODE");
    assertEquals(engineOf("sim.equilibrium"), "ODE");
    assertEquals(engineOf("sim.crosscheck"), "ODE+SSA");
    assertEquals([engineOf("sim.scenario", { scenario: {} }), engineOf("sim.scenario", { scenario: '{"engine":"ode"}' })], ["SSA", "ODE"], "a scenario names its own engine, ssa by default");
    assertEquals(engineOf("sim.compare", { scenarios: [{ engine: "ode" }, { engine: "ssa" }] }), "ODE+SSA");
    assertEquals(engineOf("analysis.verify"), null);
    assertEquals(engineOf("constructor"), null);
    assertEquals(engineOf("toString"), null, "a name on Object.prototype is not an engine");
});

Deno.test("recordFromGoalRun: the engine of a call is the engine used, including a two-engine call, and none when no call runs one", () => {
    const goal = goalById("average");
    const rec = { index: 0, command: "sim.recommend", args: {}, result: { engine: "ssa", why: "50 tokens", t_end: 10, seed: 1 } };
    // crosscheck runs both: the recommended one is among them, so nothing is overridden
    const both = recordFromGoalRun(goal, { ok: true, steps: [rec, { index: 1, command: "sim.crosscheck", args: {}, result: {}, artifacts: [] }] });
    assertEquals(both.engine, { name: "ODE+SSA", reason: "50 tokens" });
    // no call runs an engine: the recommendation is shown as advice, labelled, never as what ran
    const none = recordFromGoalRun(goal, { ok: true, steps: [rec, { index: 1, command: "analysis.verify", args: {}, result: {}, artifacts: [] }] });
    assertEquals(none.engine, { name: "SSA", reason: "50 tokens", recommendedOnly: true });
    assertEquals(JSON.parse(JSON.stringify(none)), none);
    const html = footerHtml(none);
    assertStringIncludes(html, "recommended, not run");
    assertStringIncludes(footerHtml(both), "<b>ODE+SSA</b>");
    assert(!footerHtml(both).includes("overridden"));
    // nothing recommended and nothing run: no engine row at all
    const bare = recordFromGoalRun(goal, { ok: true, steps: [{ index: 0, command: "analysis.verify", args: {}, result: {}, artifacts: [] }] });
    assertEquals(bare.engine, null);
    assert(!footerHtml(bare).includes("<dt>Engine</dt>"));
});

Deno.test("wireFooter: a pane that holds several footers answers a click once, for the footer it came from", () => {
    const recA = provenance({ calls: [{ command: "sim.ode", args: { t_end: 1 } }] });
    const recB = provenance({ calls: [{ command: "sim.ssa", args: { seed: 7 } }] });
    const idOf = (html: string) => /data-prov-id="([^"]+)"/.exec(html)?.[1];
    const a = idOf(footerHtml(recA));
    const b = idOf(footerHtml(recB));
    assert(a && b && a !== b, "each record's footer has its own id");
    assertEquals(idOf(footerHtml(recA)), a, "and the same record keeps it");
    assertEquals(idOf(footerHtml(recA, { id: "mine" })), "mine");

    const { root, click, listeners } = fakeFooter();
    const boxes: Record<string, any> = { [a!]: { dataset: { provId: a } }, [b!]: { dataset: { provId: b } } };
    root.contains = (n: any) => n === root || Object.values(boxes).includes(n);
    const button = (act: string, id: string) => {
        const btn: any = { dataset: { act }, closest: (sel: string) => (sel === "[data-act]" ? btn : sel === "[data-prov]" ? boxes[id] : null) };
        return btn;
    };
    const seen: string[] = [];
    wireFooter(root, recA, { rerun: (r: any) => seen.push("A:" + r.calls[0].command) });
    wireFooter(root, recB, { rerun: (r: any) => seen.push("B:" + r.calls[0].command), mcp: (r: any) => seen.push("B-mcp") });
    assertEquals(listeners.length, 2);
    click(button("rerun", b!));
    assertEquals(seen, ["B:sim.ssa"], "Rerun in footer B runs B's calls only");
    click(button("rerun", a!));
    assertEquals(seen, ["B:sim.ssa", "A:sim.ode"]);
    click(button("mcp", a!));
    assertEquals(seen.length, 2, "A has no mcp handler: B's is not borrowed");

    // by hand: an id given to both ties a footer to a copy of its record
    const copy = JSON.parse(JSON.stringify(recA));
    const { root: root2, click: click2 } = fakeFooter();
    const box2: any = { dataset: { provId: "card-7" } };
    root2.contains = (n: any) => n === root2 || n === box2;
    const hits: string[] = [];
    wireFooter(root2, copy, { rerun: () => hits.push("copy") }, { id: "card-7" });
    wireFooter(root2, recB, { rerun: () => hits.push("B") });
    click2({ dataset: { act: "rerun" }, closest: (sel: string) => (sel === "[data-act]" ? { dataset: { act: "rerun" }, closest: (x: string) => (x === "[data-prov]" ? box2 : null) } : sel === "[data-prov]" ? box2 : null) });
    assertEquals(hits, ["copy"]);
});
