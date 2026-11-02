import { assert, assertEquals, assertNotEquals, assertStringIncludes, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    BOUNDS, DEFAULT_ROUNDING, MAX_LINK_CHARS, REPLAY_ALLOWLIST, SPEC_VERSION, artifactDigest, buildViewSpec, checkBounds, decodePermalinkData, decodeView, editsNet,
    encodeView, expectFor, linkFits, linkFor, parseLocation, permalinkData, replayAllowed, replayViewSpec, sandboxRegistry, specFromRecord, validateViewSpec, writesState,
} from "./petri-viewspec.js";
import { defaultVersions, footerHtml, provenance, recordFromGoalRun } from "./petri-provenance.js";
import { runGoal } from "./petri-goals.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { NATIVE_COMMANDS } from "./vendor/pflow-native-wasm/commands.js";
import { loadEngine } from "./petri-wasm.js";

const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const goalById = (id: string) => catalog.goals.find((g: any) => g.id === id);

// SIR with rates: 50 tokens, so sim.recommend says SSA.
const sir = (): any => ({
    places: { S: { initial: [45], capacity: [0], x: 0, y: 0 }, I: { initial: [5], capacity: [0], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
    transitions: { infect: { x: 50, y: 0, rate: 0.01 }, recover: { x: 150, y: 0, rate: 0.1 } },
    arcs: [
        { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
        { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
        { source: "recover", target: "R", weight: [1] },
    ],
});
const live = () => new Registry(createHeadlessHost(sir())) as any;
const replay: (spec: any, registry: any, o?: any) => Promise<any> = replayViewSpec;
const call = (command: string, args: Record<string, unknown> = {}) => ({ command, args });
const spec2 = () => buildViewSpec({ net: "zb2rhk3", view: "risk", calls: [call("sim.recommend"), call("sim.ssa", { t_end: 42, runs: 20, seed: 1 })] });

// ---------------------------------------------------------------------------
// building
// ---------------------------------------------------------------------------

Deno.test("buildViewSpec: the shape of design 14.1, with defaults", () => {
    const s = spec2();
    assertEquals(Object.keys(s), ["@type", "specVersion", "net", "view", "calls", "engine", "expect", "note", "parents"]);
    assertEquals([s["@type"], s.specVersion, SPEC_VERSION, s.net, s.view], ["ViewSpec", 1, 1, "zb2rhk3", "risk"]);
    assertEquals(s.engine, defaultVersions());
    assertEquals(s.expect, { artifacts: [], rounding: DEFAULT_ROUNDING });
    assertEquals([s.note, s.parents], [null, []]);
    const n = buildViewSpec({ calls: [call("sim.ode")], note: "It settles.", parents: ["zb2parent"], engine: { registry: "js", app: "x" }, expect: { artifacts: [], rounding: 6 } });
    assertEquals([n.net, n.view, n.note, n.parents, n.engine, n.expect.rounding], [null, "custom", { by: "assistant", text: "It settles." }, ["zb2parent"], { registry: "js", app: "x" }, 6]);
    assertEquals(validateViewSpec(s, live()).ok, true);
    // a note longer than the limit is cut to it, so the spec stays valid
    const long = buildViewSpec({ calls: [call("sim.ode")], note: "x".repeat(BOUNDS.maxNote + 500) });
    assertEquals(long.note?.text.length, BOUNDS.maxNote);
    assert(long.note?.text.endsWith("…"));
    assertEquals(validateViewSpec(long, live()).ok, true);
    assertEquals(buildViewSpec({ calls: [call("sim.ode")], note: { text: "" } }).note, null);
    assertThrows(() => buildViewSpec({ calls: [{ args: {} } as any] }), TypeError);
});

Deno.test("specFromRecord: a provenance record becomes a spec; the goal names the view", () => {
    const rec = provenance({ goal: { id: "risk", question: "q" }, calls: [call("sim.ssa", { seed: 1 })], net: { cid: "zb2rhk3", revision: 2 }, note: "n", versions: { registry: "pflow-native 0.8.0", app: "rev9" } });
    const s = specFromRecord(rec);
    assertEquals([s.net, s.view, s.calls, s.note, s.engine], ["zb2rhk3", "risk", rec.calls, { by: "assistant", text: "n" }, { registry: "pflow-native 0.8.0", app: "rev9" }]);
    assertEquals(specFromRecord(provenance({ calls: [call("sim.ode")] })).view, "custom");
    assertEquals(specFromRecord(rec, { view: "knob-ranking", parents: ["zb2p"] }).view, "knob-ranking");
});

// ---------------------------------------------------------------------------
// the allowlist
// ---------------------------------------------------------------------------

Deno.test("replayAllowed: the read-only families replay", () => {
    for (const id of ["analysis.verify", "analysis.diagnose", "analysis.check", "sim.ode", "sim.ssa", "sim.sde", "sim.what_if", "sim.recommend", "sim.marking", "sim.enabled",
        "opt.rate_scan", "opt.heatmap", "opt.optimize", "game.value", "game.move", "view.highlight", "view.fit", "compose.components", "compose.diff",
        "plan.check", "bundle.validate", "bundle.flatten", "bundle.run", "bundle.lens"]) {
        assert(replayAllowed(id), id);
    }
    assert(replayAllowed("opt.fit", {}) && replayAllowed("opt.distill") && replayAllowed("opt.fit", { apply: false }), "fit and distill read unless applied");
});

Deno.test("replayAllowed: the named refusals", () => {
    const refused = [
        // edits to the net and the token game's marking
        "edit.undo", "edit.redo", "edit.delete", "net.add_place", "net.add_arc", "net.info", "net.layout", "net.set_colors", "file.new", "file.load_json", "file.open", "file.open_example",
        "sim.fire", "sim.reset", "sim.set_rate", "sim.goto", "sim.run", "compose.fuse", "compose.extend", "macro.play", "model.open", "store.open", "data.discover",
        // writes
        "file.save", "file.write", "file.delete", "file.seal", "export.artifact", "export.svg", "model.save", "model.delete", "store.put", "store.delete", "note.add", "note.clear",
        "macro.define", "system.create", "system.set_port", "system.bind", "system.run", "data.calibrate",
        // not listed: deny by default, and not even real commands
        "artifact.show_set", "provenance.check_witness", "analysis.nonexistent_tomorrow", "sim.nonexistent_tomorrow", "", "constructor", "__proto__", "sim.ode ", "SIM.ODE",
    ];
    for (const id of refused) assert(!replayAllowed(id), `${id} must not replay`);
    // with apply, the commands that edit only then
    assert(!replayAllowed("opt.fit", { apply: true }) && !replayAllowed("opt.distill", { apply: true }) && !replayAllowed("data.calibrate", { apply: true }));
    for (const bad of [undefined, null, 5, {}, [], ["sim.ode"]]) assert(!replayAllowed(bad as any));
});

Deno.test("replayAllowed: the full sweep over the live registry, with the edit-detection rule", () => {
    const reg = live();
    const specs = reg.list();
    assert(specs.length > 120, `the registry has ${specs.length} commands`);
    const native = new Map(NATIVE_COMMANDS.map((s: any) => [s.id, s]));
    const jsWriters = /^(file|edit|net|export)\./; // the account-file, document and export commands of the JS registry
    let denied = 0;
    for (const s of specs) {
        const n: any = native.get(s.id);
        const flagged = jsWriters.test(s.id) || s.writesState || (n && (n.edits || n.setsMarking || n.writesState))
            || ["file.new", "edit.undo", "edit.redo", "edit.delete", "sim.fire", "sim.reset", "sim.set_rate", "sim.goto"].includes(s.id);
        if (flagged) {
            denied++;
            assert(!replayAllowed(s.id), `${s.id} edits or writes and must not replay`);
            assert(!replayAllowed(s.id, { apply: true }), `${s.id} with apply`);
        }
        if (n?.editsOnApply) assert(!replayAllowed(s.id, { apply: true }), `${s.id} with apply edits`);
        if (n?.editsOnCurrent) assert(!replayAllowed(s.id, {}), `${s.id} on the open net edits`);
        // whatever replays is neither an edit nor a write, by the same rule the Assistant's explain mode uses
        if (replayAllowed(s.id)) {
            assert(!editsNet(s.id, {}) && !writesState(s.id) && !s.writesState, s.id);
        }
    }
    assert(denied > 60, `${denied} edit or write commands checked`);
    // and nothing outside the allowed families replays, whatever the registry holds
    const prefixes = new Set(REPLAY_ALLOWLIST.map((id) => id.split(".")[0]));
    assertEquals([...prefixes].sort(), ["analysis", "bundle", "compose", "game", "opt", "plan", "sim", "view"]);
    for (const s of specs) if (replayAllowed(s.id)) assert(prefixes.has(s.id.split(".")[0]), s.id);
    // the registry commands that do replay are the ones meant to
    const replayable = specs.filter((s: any) => replayAllowed(s.id)).map((s: any) => s.id);
    for (const id of ["sim.ode", "sim.ssa", "sim.recommend", "analysis.verify", "analysis.check", "opt.rate_scan", "game.value", "view.highlight"]) assert(replayable.includes(id), id);
    for (const id of REPLAY_ALLOWLIST) assert(!/^(edit|net|file|store|export|model|note|macro|system)\./.test(id), id);
});

// ---------------------------------------------------------------------------
// bounds
// ---------------------------------------------------------------------------

Deno.test("bounds: the numbers are /mcp's, and a typical view is inside them", () => {
    assertEquals(BOUNDS.ceilings.runs, 200);
    assertEquals(BOUNDS.ceilings.t_end, 10000);
    assertEquals(BOUNDS.ceilings.max_states, 20000);
    assertEquals(BOUNDS.ceilings.nodes, 10_000_000);
    assertEquals(BOUNDS.ceilings.memo, 1 << 21);
    assertEquals([BOUNDS.maxCalls, BOUNDS.callTimeoutMs, BOUNDS.minTolerance, BOUNDS.maxSDESteps, BOUNDS.totalSteps], [12, 60_000, 1e-12, 50_000, 1_000_000]);
    const ok = checkBounds([call("sim.recommend"), call("sim.ssa", { t_end: 42, runs: 20, seed: 1 })]);
    assertEquals([ok.ok, ok.errors, ok.work], [true, [], 21]);
    // exactly at each ceiling is allowed, one past is not
    for (const [k, cap] of Object.entries(BOUNDS.ceilings)) {
        assert(checkBounds([call("sim.ssa", { [k]: cap })]).errors.filter((e) => e.includes("over the limit")).length === 0, `${k} = ${cap} is allowed`);
        const over = checkBounds([call("sim.ssa", { [k]: cap + 1 })]);
        assert(!over.ok && over.errors.some((e) => e.includes(k) && e.includes("over the limit")), `${k} = ${cap + 1}: ${over.errors}`);
    }
});

Deno.test("bounds: tolerance floor, SDE steps, call count, argument size, nesting and total work", () => {
    assert(!checkBounds([call("opt.optimize", { abstol: 1e-13 })]).ok);
    assert(!checkBounds([call("opt.optimize", { reltol: 0 })]).ok);
    assert(checkBounds([call("opt.optimize", { abstol: 1e-12, reltol: 1e-3 })]).ok);
    assert(!checkBounds([call("sim.sde", { t_end: 100, dt: 1e-6 })]).ok, "10^8 steps");
    assert(checkBounds([call("sim.sde", { t_end: 100, dt: 0.01 })]).ok, "10^4 steps");
    const many = Array.from({ length: BOUNDS.maxCalls }, () => call("sim.marking"));
    assert(checkBounds(many).ok);
    assert(!checkBounds([...many, call("sim.marking")]).ok, "13 calls");
    assert(!checkBounds([call("sim.ode", { places: Array.from({ length: 4000 }, (_, i) => `place_number_${i}`) })]).ok, "arguments over 16 KB");
    let deep: any = 1;
    for (let i = 0; i < 20; i++) deep = { a: deep };
    assert(!checkBounds([call("game.value", { plan: deep })]).ok, "nesting");
    // 11 calls of 200 runs x 500 points is over the work budget, 10 is not
    const heavy = () => call("sim.ssa", { runs: 200, points: 500 });
    assert(checkBounds(Array.from({ length: 10 }, heavy)).ok);
    const over = checkBounds(Array.from({ length: 11 }, heavy));
    assert(!over.ok && over.errors.some((e) => e.includes("budget")), over.errors.join());
    assertEquals(checkBounds([call("opt.heatmap", { steps: 40 })]).work, 1600);
    assertEquals(checkBounds([call("opt.heatmap", { x_steps: 10, y_steps: 20 })]).work, 200);
});

Deno.test("bounds: a limit hidden in an argument that holds JSON text, or nested, is found", () => {
    const scenario = JSON.stringify({ hours: 8, realizations: 100000, marking: { S: 5 } });
    const a = checkBounds([call("sim.scenario", { scenario })]);
    assert(!a.ok && a.errors.some((e) => e.includes("realizations")), a.errors.join());
    const b = checkBounds([call("sim.compare", { scenarios: [{ hours: 8, realizations: 4 }, { hours: 1e9, realizations: 4 }] })]);
    assert(!b.ok && b.errors.some((e) => e.includes("hours")), b.errors.join());
    const c = checkBounds([call("game.value", { plan: { drivers: [{ budget: { nodes: 1e12 } }] } })]);
    assert(!c.ok && c.errors.some((e) => e.includes("nodes")), c.errors.join());
    assert(checkBounds([call("game.value", { plan: '{"mode": "play", "drivers": [{"budget": {"nodes": 5000}}]}' })]).ok);
    assert(!checkBounds("nope" as any).ok);
    assert(!checkBounds([call("opt.sweep", { values: [1, 1e999] })]).ok, "a number past the double range is not finite");
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

Deno.test("validateViewSpec: a good spec; unknown commands are not errors, refused ones are listed", () => {
    const reg = live();
    assertEquals(validateViewSpec(spec2(), reg), { ok: true, errors: [], refused: [], unknown: [] });
    const withUnknown = { ...spec2(), calls: [...spec2().calls, call("bundle.flatten", {})] };
    const u = validateViewSpec(withUnknown, reg);
    assertEquals([u.ok, u.errors, u.refused, u.unknown], [true, [], [], ["bundle.flatten"]]);
    const refusing = { ...spec2(), calls: [call("sim.ssa", { seed: 1 }), call("net.add_place", { x: 1, y: 1 }), call("file.save", { name: "a.json" }), call("edit.nope")] };
    const r = validateViewSpec(refusing, reg);
    assertEquals([r.ok, r.errors, r.refused, r.unknown], [false, [], ["net.add_place", "file.save", "edit.nope"], []]);
    assertEquals(validateViewSpec(spec2()).unknown, [], "no registry: nothing to compare with");
});

Deno.test("validateViewSpec: shape errors, each named", () => {
    const reg = live();
    const bad = (mutate: (s: any) => any, includes: string) => {
        const s = spec2();
        const out = mutate(s) ?? s;
        const v = validateViewSpec(out, reg);
        assert(!v.ok && v.errors.some((e) => e.includes(includes)), `${includes}: ${JSON.stringify(v)}`);
    };
    for (const nonObject of [null, 5, "x", [], undefined]) assertEquals(validateViewSpec(nonObject as any, reg).ok, false);
    bad((s) => { s["@type"] = "Other"; }, "@type");
    bad((s) => { delete s.specVersion; }, "specVersion");
    bad((s) => { s.specVersion = 1.5; }, "specVersion");
    bad((s) => { s.specVersion = 2; }, "newer");
    bad((s) => { s.net = 5; }, "net");
    bad((s) => { s.view = ""; }, "view");
    bad((s) => { s.view = "x".repeat(81); }, "view");
    bad((s) => { s.calls = "sim.ode"; }, "calls");
    bad((s) => { s.calls = []; }, "empty");
    bad((s) => { s.calls = Array.from({ length: 13 }, () => call("sim.marking")); }, "at most 12");
    bad((s) => { s.calls[0] = "sim.ode"; }, "not an object");
    bad((s) => { s.calls[0] = { args: {} }; }, "not a command id");
    bad((s) => { s.calls[0] = call("Sim.Ode"); }, "not a command id");
    bad((s) => { s.calls[0] = call("sim.ode; rm -rf"); }, "not a command id");
    bad((s) => { s.calls[0] = { command: "sim.ode", args: [1] }; }, "arguments must be an object");
    bad((s) => { s.calls[1].args.runs = 5000; }, "over the limit");
    bad((s) => { s.engine = { registry: 5, app: "x" }; }, "engine");
    bad((s) => { s.expect = { artifacts: ["md5:abc"], rounding: 9 }; }, "expect.artifacts");
    bad((s) => { s.expect = { artifacts: [], rounding: 0 }; }, "rounding");
    bad((s) => { s.expect = { artifacts: Array(65).fill("sha256:" + "0".repeat(64)) }; }, "expect.artifacts");
    bad((s) => { s.parents = Array(17).fill("zb2"); }, "parents");
    bad((s) => { s.parents = [5]; }, "parents");
    // the same spec with the aliases and omissions the format allows is fine
    const lenient = { specVersion: 1, view: "v", calls: [{ id: "sim.marking" }], engine: null, expect: undefined, note: null, parents: undefined };
    assertEquals(validateViewSpec(lenient, reg).ok, true);
});

Deno.test("validateViewSpec: the note is text from the assistant, and short", () => {
    const reg = live();
    const withNote = (note: any) => validateViewSpec({ ...spec2(), note }, reg);
    assertEquals(withNote({ by: "assistant", text: `<script>alert(1)</script> & "quotes"` }).ok, true, "hostile text is still just text; the footer escapes it");
    assertEquals(withNote(null).ok, true);
    for (const note of [{ by: "engine", text: "x" }, { by: "assistant", text: { html: "<b>x</b>" } }, { by: "assistant", text: 5 }, { text: "no author" }, "bare string", [1]]) {
        assertEquals(withNote(note).ok, false, JSON.stringify(note));
    }
    assertEquals(withNote({ by: "assistant", text: "x".repeat(BOUNDS.maxNote) }).ok, true);
    assertEquals(withNote({ by: "assistant", text: "x".repeat(BOUNDS.maxNote + 1) }).ok, false);
    // and shown through the footer it is escaped
    const note = `<img src=x onerror=alert(1)>`;
    const html = footerHtml(provenance({ calls: [call("sim.ode")], note }));
    assert(!html.includes("<img") && html.includes("&lt;img"));
});

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

Deno.test("encodeView and decodeView: a round trip, and a typical two-call spec is small", async () => {
    const reg = live();
    const s = spec2();
    s.expect = await expectFor([{ data: { a: 1 } }, { data: { b: [0.5, 2] } }]);
    const payload = await encodeView(s);
    assert(/^[A-Za-z0-9_-]+$/.test(payload), "base64url, safe in a fragment");
    assert(payload.length < 1024, `the payload is ${payload.length} characters`);
    const back: any = await decodeView(payload, { net: s.net });
    assert(back.ok, back.error);
    assertEquals(back.spec, s);
    assertEquals(validateViewSpec(back.spec, reg).ok, true);
    // the CID is not in the payload: it travels in the query
    const text = new TextDecoder().decode(await (async () => {
        const raw = Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (payload.length % 4)) % 4)), (c) => c.charCodeAt(0));
        return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    })());
    assert(!text.includes("zb2rhk3") && !text.includes("@type"), text);
    // a spec with a note and parents, and nothing else, survives too
    const lean = buildViewSpec({ net: null, view: "v", calls: [call("sim.ode", { t_end: 5 })], note: "n", parents: ["zb2a", "zb2b"] });
    const l: any = await decodeView(await encodeView(lean));
    assertEquals(l.spec, lean);
    // a long note and unicode survive
    const wide = buildViewSpec({ view: "v", calls: [call("sim.ode")], note: "ünïcödé — 日本語 ✓ ".repeat(50) });
    assertEquals(((await decodeView(await encodeView(wide))) as any).spec, wide);
});

Deno.test("decodeView: damaged, oversized and hostile payloads are refused without throwing", async () => {
    const cases: Array<[string, any]> = [
        ["empty", ""], ["not a string", 5], ["undefined", undefined], ["null", null],
        ["not base64url", "abc def!"], ["padding", "abcd=="], ["plus and slash", "ab+/cd"], ["length 1 mod 4", "abcde"],
        ["base64 of text, not deflate", btoa("hello, this is not a deflate stream at all").replaceAll("=", "")],
        ["truncated", (await encodeView(spec2())).slice(0, 20)],
        ["too long to be a view", "A".repeat(BOUNDS.maxEncodedChars + 1)],
    ];
    for (const [name, text] of cases) {
        const r: any = await decodeView(text);
        assertEquals(r.ok, false, name);
        assert(typeof r.error === "string" && r.error.length > 0, name);
    }
    const compress = async (bytes: Uint8Array) => {
        const out = new Uint8Array(await new Response(new Blob([bytes as BufferSource]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
        let s = ""; for (const b of out) s += String.fromCharCode(b);
        return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    };
    const enc = new TextEncoder();
    for (const [name, body] of [["not JSON", "{nope"], ["an array", "[1,2]"], ["a number", "7"], ["null", "null"], ["a string", '"x"']] as const) {
        const r: any = await decodeView(await compress(enc.encode(body)));
        assertEquals(r.ok, false, name);
    }
    const bad = new Uint8Array([0xff, 0xfe, 0xfd]);
    assertEquals(((await decodeView(await compress(bad))) as any).ok, false, "invalid UTF-8");
    // a deflate bomb: 24 MB of zeros is a few dozen KB on the wire, and must not be inflated
    const bomb = await compress(new Uint8Array(24 * 1024 * 1024));
    assert(bomb.length < BOUNDS.maxEncodedChars, `the bomb is ${bomb.length} characters`);
    const t0 = performance.now();
    const r: any = await decodeView(bomb);
    assertEquals(r.ok, false);
    assertStringIncludes(r.error, "too large");
    assert(performance.now() - t0 < 5000, "gave up early");
    // a spec just over the inflated cap
    const fat = JSON.stringify({ specVersion: 1, view: "v", calls: [], note: { by: "assistant", text: "x".repeat(BOUNDS.maxInflatedBytes) } });
    assertEquals(((await decodeView(await compress(enc.encode(fat)))) as any).ok, false);
});

Deno.test("decodeView: whatever it accepts still goes through validateViewSpec, and __proto__ is only a key", async () => {
    const reg = live();
    const compress = async (text: string) => {
        const out = new Uint8Array(await new Response(new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
        let s = ""; for (const b of out) s += String.fromCharCode(b);
        return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    };
    const hostile = '{"specVersion":1,"view":"v","calls":[{"command":"sim.ode","args":{"__proto__":{"polluted":true},"t_end":5}}],"constructor":{"prototype":{"x":1}}}';
    const d: any = await decodeView(await compress(hostile));
    assert(d.ok);
    assertEquals(({} as any).polluted, undefined);
    assertEquals(({} as any).x, undefined);
    assertEquals(validateViewSpec(d.spec, reg).ok, true, "the shape is fine; the registry refuses the argument when it runs");
    const run = await replay(d.spec, sandboxRegistry(sir()), {});
    assertEquals(run.partial, true);
    assertStringIncludes(run.steps[0].error, "__proto__");
    assertEquals(({} as any).polluted, undefined);
    // not a spec at all: decodes, validation says so
    const odd: any = await decodeView(await compress('{"hello":"world"}'));
    assert(odd.ok);
    assertEquals(validateViewSpec(odd.spec, reg).ok, false);
});

Deno.test("linkFor and parseLocation: /?cid=#view=, the unsaved /?data=#view=, and every old link still means what it did", async () => {
    const payload = await encodeView(spec2());
    const link = linkFor({ origin: "https://pflow.xyz", cid: "zb2rhk3abc", payload });
    assertEquals(link, `https://pflow.xyz/?cid=zb2rhk3abc#view=${payload}`);
    const u = new URL(link);
    assertEquals(parseLocation({ search: u.search, hash: u.hash }), { cid: "zb2rhk3abc", data: null, viewPayload: payload, route: null, specCid: null });
    assertEquals(linkFor({ origin: "https://pflow.xyz/", cid: "zb2" }), "https://pflow.xyz/?cid=zb2", "no payload: the net's own link");
    assertThrows(() => linkFor({ origin: "https://pflow.xyz", payload }), TypeError);
    assertEquals(linkFor({ origin: "http://localhost:8081", cid: "a&b=c#d", payload: "xyz" }), "http://localhost:8081/?cid=a%26b%3Dc%23d#view=xyz", "a hostile cid cannot add parameters");

    // links that exist today, with and without a hash, mean what they meant
    const none = { cid: null, data: null, viewPayload: null, route: null, specCid: null };
    assertEquals(parseLocation({ search: "", hash: "" }), none);
    assertEquals(parseLocation({}), none);
    assertEquals(parseLocation({ search: "?cid=zb2old" }), { ...none, cid: "zb2old" });
    assertEquals(parseLocation({ search: "cid=zb2old", hash: "#" }), { ...none, cid: "zb2old" });
    assertEquals(parseLocation({ search: "?cid=zb2old&utm_source=x", hash: "#section" }), { ...none, cid: "zb2old" });
    assertEquals(parseLocation({ search: "?cid=" }), none, "an empty cid is no cid, as the loader's truthiness check reads it");
    assertEquals(parseLocation({ search: "?route=design&cid=zb2x" }), { ...none, cid: "zb2x", route: "design" });
    assertEquals(parseLocation({ search: "?v=zb2spec" }), { ...none, specCid: "zb2spec" });
    // the compose page's hash is not ours
    assertEquals(parseLocation({ search: "", hash: "#view=cospan&ex=orders" }).viewPayload, null);
    assertEquals(parseLocation({ search: "", hash: "#view=laws&ex=connect4&plan=eyJ4IjoxfQ" }).viewPayload, null);
    assertEquals(parseLocation({ search: "", hash: "#view=cospan" }).viewPayload, "cospan", "a bare id is returned; decodeView refuses it");
    assertEquals(((await decodeView("cospan")) as any).ok, false);
    assertEquals(parseLocation({ search: "?cid=x", hash: "#other=1" }).viewPayload, null);
});

Deno.test("the unsaved-net form: ?data= as the editor writes it, with a view on the hash", async () => {
    const model = sir();
    model.places.S.label = "100% sûre & <b>bold</b>";
    // exactly what petri-view.js _updatePermalinkURL does
    const editor = new URL("https://pflow.xyz/");
    editor.searchParams.set("data", encodeURIComponent(JSON.stringify(model)));
    const fromEditor = parseLocation({ search: editor.search, hash: "" });
    assertEquals(fromEditor.cid, null);
    assertEquals(fromEditor.data, permalinkData(model), "the same string the editor's loader sees");
    assertEquals(decodePermalinkData(fromEditor.data!), model);

    const payload = await encodeView(spec2());
    const link = linkFor({ origin: "https://pflow.xyz", data: permalinkData(model), payload });
    const u = new URL(link);
    const got = parseLocation({ search: u.search, hash: u.hash });
    assertEquals([got.cid, got.viewPayload, got.data], [null, payload, permalinkData(model)]);
    assertEquals(decodePermalinkData(got.data!), model);
    assertEquals(linkFits("https://pflow.xyz/?cid=x"), true);
    assertEquals(linkFits("x".repeat(MAX_LINK_CHARS + 1)), false);
    // a data permalink and a cid together: both are reported, the editor decides (data first)
    assertEquals(parseLocation({ search: `?data=${encodeURIComponent(permalinkData(model))}&cid=zb2c` }).cid, "zb2c");
});

Deno.test("decodePermalinkData: as the editor's loader, but it cannot hang on a stray percent sign", () => {
    assertEquals(decodePermalinkData(encodeURIComponent('{"a":1}')), { a: 1 });
    assertEquals(decodePermalinkData(encodeURIComponent(encodeURIComponent('{"a":1}'))), { a: 1 }, "decoded until it is JSON");
    assertEquals(decodePermalinkData('{"name":"100%"}'), { name: "100%" }, "the loader spins forever on this one");
    assertEquals(decodePermalinkData('{"name":"%E0%A4%A"}'), { name: "%E0%A4%A" });
    for (const bad of ["", null, undefined, "nope", "[1]", "7", "%7B", "x".repeat(1024 * 1024 + 1)]) assertEquals(decodePermalinkData(bad as any), null, String(bad).slice(0, 12));
});

// ---------------------------------------------------------------------------
// digests
// ---------------------------------------------------------------------------

Deno.test("artifactDigest: canonical (key order does not matter) and rounded to the stated digits", async () => {
    const d = (data: any, rounding?: number) => artifactDigest({ data }, rounding === undefined ? undefined : { rounding });
    assertEquals(await d({ a: 1, b: [1, 2] }), await d({ b: [1, 2], a: 1 }));
    assert((await d({ a: 1 })).startsWith("sha256:") && /^sha256:[0-9a-f]{64}$/.test(await d({ a: 1 })));
    assertNotEquals(await d({ a: 1 }), await d({ a: 2 }));
    assertNotEquals(await d({ a: [1, 2] }), await d({ a: [2, 1] }));
    // 9 significant digits by default: noise below that does not change it, a real change does
    assertEquals(await d({ x: 0.1 + 0.2 }), await d({ x: 0.3 }));
    assertEquals(await d({ x: 1.0000000001 }), await d({ x: 1.0000000002 }));
    assertNotEquals(await d({ x: 1.0000000001 }, 12), await d({ x: 1.0000000002 }, 12));
    assertNotEquals(await d({ x: 1.001 }), await d({ x: 1.002 }));
    assertEquals(await d({ x: 123456789012 }), await d({ x: 123456789012 }), "integers are exact");
    assertNotEquals(await d({ x: 123456789012 }), await d({ x: 123456789013 }));
    assertEquals(await d({ 10: "a", 2: "b" }), await d({ 2: "b", 10: "a" }), "integer-like keys sort like the rest");
    assertEquals(await d({ x: -0 }), await d({ x: 0 }));
    assertNotEquals(await d({ x: NaN }), await d({ x: Infinity }));
    assertEquals(await d(undefined), await d(null));
    assertEquals(await d({ a: 1, b: undefined }), await d({ a: 1 }));
    assertEquals(DEFAULT_ROUNDING, 9);
    // the digest covers the data only: a title or an id does not move it
    assertEquals(await artifactDigest({ id: "a1", title: "x", data: { k: 1 } } as any), await artifactDigest({ id: "a9", title: "y", data: { k: 1 } } as any));
});

Deno.test("artifactDigest: the engine's own artifact ids inside native data are not part of the digest", async () => {
    const d = (data: any) => artifactDigest({ data });
    // pflow-native names companion artifacts by its session counter ("trace": "a1", then "a5"); runNative leaves them in the data
    assertEquals(await d({ verdicts: [{ trace: "a1" }], traces: ["a1"] }), await d({ verdicts: [{ trace: "a5" }], traces: ["a5"] }));
    assertEquals(await d({ graph: "a11", artifacts: { bars: "a3", x: "a4" } }), await d({ graph: "a2", artifacts: { bars: "a9", x: "a8" } }));
    // but a name that looks like an id is a name
    assertNotEquals(await d({ series: [{ name: "a1", values: [1] }] }), await d({ series: [{ name: "a5", values: [1] }] }));
    assertNotEquals(await d({ places: ["a1"] }), await d({ places: ["a5"] }));
    assertNotEquals(await d({ trace: "alpha" }), await d({ trace: "beta" }), "only a<digits> is an id");
});

Deno.test("artifactDigest: the same native analysis in two engine sessions has one digest", async () => {
    const digests: string[] = [];
    for (let i = 0; i < 3; i++) {
        const reg = live();
        await reg.execute("analysis.verify", { properties: [{ kind: "deadlock-free" }] });
        await reg.execute("analysis.reachability", { max_states: 200 });
        digests.push((await Promise.all(reg.artifacts().map((a: any) => artifactDigest(a)))).join());
    }
    assertEquals(digests[0], digests[1]);
    assertEquals(digests[1], digests[2]);
});

Deno.test("a seeded SSA run twice gives identical digests, and a different seed does not", async () => {
    const reg = live();
    const run = async (seed: number) => {
        const r = await reg.execute("sim.ssa", { t_end: 20, runs: 4, seed });
        return artifactDigest(reg.artifact(r.artifact));
    };
    const a = await run(1);
    assertEquals(a, await run(1));
    assertNotEquals(a, await run(2));
});

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

// Run a goal on a live registry and record it as a spec with expectations.
async function recorded(goalId: string, inputs: Record<string, unknown> = {}) {
    const reg = live();
    const goal = goalById(goalId);
    const run = await runGoal(reg, goal, inputs);
    assert(run.ok, JSON.stringify(run.steps.find((s: any) => s.error)));
    const record = recordFromGoalRun(goal, run, { inputs, net: { cid: "zb2rhrecorded", revision: 1 } });
    const arts = run.steps.flatMap((s: any) => (s.artifacts || []).map((id: string) => reg.artifact(id)));
    const spec = specFromRecord(record, { expect: await expectFor(arts) });
    return { spec, arts, record };
}

Deno.test("replay of a recorded spec reproduces every digest exactly, on a sandbox, with no model", async () => {
    const { spec, arts } = await recorded("risk");
    assert(arts.length >= 1);
    assertEquals(spec.expect.artifacts.length, arts.length);
    const realFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (() => { fetched++; return Promise.reject(new Error("no network")); }) as any;
    try {
        const sandbox = sandboxRegistry(sir());
        const seen: number[] = [];
        const r = await replay(spec, sandbox, { onStep: (s: any) => seen.push(s.index) });
        assertEquals(fetched, 0, "replay never fetches, /api/llm included");
        assertEquals([r.ok, r.partial, r.mutated, r.errors, r.refused, r.notReproducible, r.deferred], [true, false, false, [], [], [], []]);
        assertEquals(seen, [0, 1]);
        assertEquals(r.steps.map((s: any) => s.command), ["sim.recommend", "sim.ssa"]);
        assertEquals(r.artifacts.map((a: any) => a.digest), spec.expect.artifacts, "digests reproduce exactly");
        assertEquals([r.drift.matched.length, r.drift.differed, r.drift.unchecked], [arts.length, [], []]);
        assertEquals(r.engine, { made: spec.engine, now: defaultVersions(), same: true });
        assert(r.artifacts[0].title.startsWith("SSA to t="));
        // and again: the same
        const again = await replay(spec, sandboxRegistry(sir()), {});
        assertEquals(again.artifacts.map((a: any) => a.digest), r.artifacts.map((a: any) => a.digest));
    } finally {
        globalThis.fetch = realFetch;
    }
});

Deno.test("replay reproduces an ODE goal and a native analysis goal too", async () => {
    for (const [id, inputs] of [["average", {}], ["stuck", {}], ["conserved", {}]] as const) {
        const { spec, arts } = await recorded(id, inputs);
        assert(arts.length > 0, `${id} files artifacts`);
        const r = await replay(spec, sandboxRegistry(sir()));
        assertEquals(r.ok, true, id);
        assertEquals([r.drift.differed, r.drift.unchecked, r.drift.matched.length], [[], [], arts.length], id);
    }
});

Deno.test("a tampered expect digest lands in drift.differed, the rest still match", async () => {
    const { spec } = await recorded("risk");
    const first = spec.expect.artifacts[0] as string;
    spec.expect.artifacts[0] = first.slice(0, -4) + (first.endsWith("0000") ? "1111" : "0000");
    const r = await replay(spec, sandboxRegistry(sir()));
    assertEquals(r.drift.differed.length, 1);
    assertEquals(r.drift.differed[0].index, 0);
    assertEquals(r.drift.differed[0].expected, spec.expect.artifacts[0]);
    assertEquals(r.drift.differed[0].actual, r.artifacts[0].digest);
    assertEquals(r.drift.matched.length, r.artifacts.length - 1);
    assertEquals(r.ok, true, "it ran to the end: drift is reported, not a failure of the replay");
    // fewer expectations than artifacts: the extra ones are unchecked; more: they differ
    const none = await replay({ ...spec, expect: { artifacts: [], rounding: 9 } }, sandboxRegistry(sir()));
    assertEquals([none.drift.unchecked.length, none.drift.matched.length], [r.artifacts.length, 0]);
    const extra = await replay({ ...spec, expect: { artifacts: [...r.artifacts.map((a: any) => a.digest), "sha256:" + "a".repeat(64)], rounding: 9 } }, sandboxRegistry(sir()));
    assertEquals(extra.drift.differed.length, 1);
    assertEquals(extra.drift.differed[0].id, null);
});

Deno.test("a rounding stated in expect is the one used", async () => {
    const reg = live();
    const r = await reg.execute("sim.ode", { t_end: 5 });
    const art = reg.artifact(r.artifact);
    const expect = await expectFor([art], { rounding: 6 });
    assertEquals(expect.rounding, 6);
    const spec = buildViewSpec({ view: "v", calls: [call("sim.ode", { t_end: 5 })], expect });
    const run = await replay(spec, sandboxRegistry(sir()));
    assertEquals([run.drift.matched.length, run.drift.differed.length], [1, 0]);
    assertNotEquals(expect.artifacts[0], (await expectFor([art], { rounding: 9 })).artifacts[0], "the rounding is part of what is hashed");
    // the same spec claiming another rounding is judged by that one
    const other = await replay({ ...spec, expect: { ...spec.expect, rounding: 9 } }, sandboxRegistry(sir()));
    assertEquals(other.drift.differed.length, 1);
});

Deno.test("an unknown command is not reproducible here: listed, skipped, the rest runs, nothing crashes", async () => {
    const spec = buildViewSpec({ view: "v", calls: [call("bundle.flatten", {}), call("sim.ssa", { t_end: 5, seed: 1 }), call("sim.removed_in_2027", {})] });
    const v = validateViewSpec(spec, sandboxRegistry(sir()));
    assertEquals([v.unknown, v.refused], [["bundle.flatten"], ["sim.removed_in_2027"]], "the second is not on the allowlist, so it is refused, not unknown");
    const r = await replay(spec, sandboxRegistry(sir()));
    assertEquals(r.notReproducible, ["bundle.flatten"]);
    assertEquals(r.refused, ["sim.removed_in_2027"]);
    assertEquals(r.partial, true);
    assertEquals(r.ok, false);
    assertEquals(r.steps.map((s: any) => [s.command, !!s.skipped, !!s.refused, !!s.error]), [["bundle.flatten", true, false, false], ["sim.ssa", false, false, false], ["sim.removed_in_2027", false, true, false]]);
    assertEquals(r.artifacts.length, 1, "the call that could run, ran");
    assertStringIncludes(r.steps[0].skipped, "not reproducible here");
    // an expectation after a call that did not run cannot be matched to an artifact: unchecked, not differed
    const withExpect = { ...spec, expect: { artifacts: ["sha256:" + "b".repeat(64), "sha256:" + "c".repeat(64)], rounding: 9 } };
    const r2 = await replay(withExpect, sandboxRegistry(sir()));
    assertEquals([r2.drift.differed, r2.drift.matched], [[], []]);
    assertEquals(r2.drift.unchecked.length, 2);
});

Deno.test("a call naming a place that no longer exists fails by name and marks the replay partial, not wrong", async () => {
    // the same view, on the net with place I removed
    const spec2p = buildViewSpec({
        view: "v",
        calls: [call("sim.ode", { t_end: 5, places: ["S", "I"] }), call("sim.what_if", { place: "I", delta: 1, t_end: 5, runs: 2 }), call("sim.ssa", { t_end: 5, seed: 1, places: ["S"] })],
    });
    const model: any = sir();
    delete model.places.I;
    model.arcs = model.arcs.filter((a: any) => a.source !== "I" && a.target !== "I");
    const r = await replay(spec2p, sandboxRegistry(model));
    assertEquals(r.partial, true);
    assertEquals(r.ok, false);
    assertEquals(r.steps.map((s: any) => !!s.error), [true, true, false], "the call that does not name I still ran");
    assertStringIncludes(r.steps[0].error, '"I" is not a place');
    assert(r.steps[1].error.includes("I"), r.steps[1].error);
    assertEquals(r.artifacts.length, 1);
    assertEquals(r.refused, []);
});

Deno.test("replay runs on the sandbox it is given: the original net is untouched, and edits are refused, not run", async () => {
    const model = sir();
    const before = JSON.stringify(model);
    const sandbox = sandboxRegistry(model);
    const sandboxBefore = JSON.stringify(sandbox.host.getModel());
    const spec = buildViewSpec({
        view: "v",
        calls: [
            call("sim.ssa", { t_end: 5, seed: 1 }),
            call("net.add_place", { x: 5, y: 5, id: "evil" }), call("net.add_arc", { source: "S", target: "infect", weight: 9 }), call("edit.delete", { ids: ["S"] }),
            call("sim.fire", { id: "infect" }), call("sim.reset"), call("sim.set_rate", { id: "infect", rate: 99 }), call("sim.goto", { id: "a1", step: 1 }), call("sim.run", { steps: 5 }),
            call("file.save", { name: "x.json" }), call("file.new"), call("store.put", {}), call("export.artifact", { id: "a1", name: "o.csv" }), call("model.save", {}),
            call("opt.fit", { apply: true }), call("data.calibrate", { apply: true }), call("compose.fuse", {}),
        ],
    });
    // 12 calls at most: split the sweep in two specs
    const first = { ...spec, calls: spec.calls.slice(0, 12) };
    const second = { ...spec, calls: spec.calls.slice(12) };
    for (const part of [first, second]) {
        const r = await replay(part, sandbox);
        assertEquals(r.errors, []);
        assertEquals(r.mutated, false);
        const ran = r.steps.filter((s: any) => !s.refused && !s.skipped);
        assert(ran.every((s: any) => s.command === "sim.ssa"), "only the SSA ran");
        assertEquals(r.refused.length, part.calls.length - ran.length);
    }
    assertEquals(JSON.stringify(model), before, "the caller's model object is untouched");
    assertEquals(JSON.stringify(sandbox.host.getModel()), sandboxBefore, "no edit reached even the sandbox");
    assert(!("evil" in sandbox.host.getModel().places));
    assertEquals(sandbox.host.getModel().transitions.infect.rate, 0.01);
    // the sandbox is a copy: editing it does not touch the model it was made from
    sandbox.host.commit({ ...sandbox.host.getModel(), name: "changed" });
    assertEquals(JSON.stringify(model), before);
});

Deno.test("replay: a malformed spec or one over the bounds runs nothing", async () => {
    const sandbox = sandboxRegistry(sir());
    const heavy = buildViewSpec({ view: "v", calls: [call("sim.marking"), call("sim.ssa", { runs: 5000 })] });
    const r = await replay(heavy, sandbox);
    assertEquals([r.ok, r.steps, r.artifacts], [false, [], []]);
    assert(r.errors.some((e: string) => e.includes("runs")), r.errors.join());
    assertEquals(sandbox.artifacts().length, 0);
    const bad = await replay({ specVersion: 9, view: "v", calls: [call("sim.marking")] }, sandbox);
    assertEquals([bad.ok, bad.steps.length], [false, 0]);
    for (const junk of [null, 5, "x", {}, []]) assertEquals((await replay(junk as any, sandbox)).ok, false);
});

Deno.test("replay: a view command waits for the canvas (deferred), it is neither refused nor a failure", async () => {
    const spec = buildViewSpec({ view: "v", calls: [call("sim.ssa", { t_end: 5, seed: 1 }), call("view.highlight", { nodes: ["S"] })] });
    const r = await replay(spec, sandboxRegistry(sir()));
    assertEquals([r.ok, r.partial, r.refused, r.notReproducible], [true, false, [], []]);
    assertEquals(r.deferred, [{ command: "view.highlight", args: { nodes: ["S"] } }]);
    assertStringIncludes(r.steps[1].deferred, "canvas");
});

// A registry with just enough of the real one's surface, for what the real one will not do.
function fakeRegistry(over: { execute: (id: string, a: any) => Promise<any>; model?: () => any }) {
    return {
        host: { getModel: over.model || (() => ({ places: {} })) },
        list: () => [{ id: "sim.ode", available: true }, { id: "sim.ssa", available: true }],
        artifacts: () => [],
        artifact: () => { throw new Error("none"); },
        execute: over.execute,
    } as any;
}

Deno.test("replay: a call that does not settle in time is given up on, and the rest goes on", async () => {
    const spec = buildViewSpec({ view: "v", calls: [call("sim.ode"), call("sim.ssa")] });
    let n = 0;
    const reg = fakeRegistry({ execute: () => (n++ === 0 ? new Promise(() => {}) : Promise.resolve({ ok: true })) });
    const t0 = performance.now();
    const r = await replay(spec, reg, { timeoutMs: 30 });
    assert(performance.now() - t0 < 2000);
    assertEquals(r.steps.map((s: any) => !!s.error), [true, false]);
    assertStringIncludes(r.steps[0].error, "did not finish");
    assertEquals(r.partial, true);
    assertEquals(BOUNDS.callTimeoutMs, 60_000, "the default is /mcp's 60 s");
});

Deno.test("replay: the tripwire says so when a sandbox's net changed, whatever did it", async () => {
    let model: any = { places: { a: 1 } };
    const reg = fakeRegistry({ model: () => model, execute: async () => { model = { places: { a: 2 } }; return {}; } });
    const r = await replay(buildViewSpec({ view: "v", calls: [call("sim.ode")] }), reg);
    assertEquals([r.mutated, r.ok], [true, false]);
});

Deno.test("replay: the engine the link was made with is compared with this build's", async () => {
    const spec = buildViewSpec({ view: "v", calls: [call("sim.marking")], engine: { registry: "pflow-native 0.1.0", app: "old" } });
    const r = await replay(spec, sandboxRegistry(sir()));
    assertEquals([r.engine.same, r.engine.made, r.engine.now.registry], [false, { registry: "pflow-native 0.1.0", app: "old" }, defaultVersions().registry]);
    const same = await replay(spec, sandboxRegistry(sir()), { versions: { registry: "pflow-native 0.1.0", app: "new" } });
    assertEquals(same.engine.same, true);
});

Deno.test("replay: errors from a command are the registry's own, and a link cannot widen an argument past its schema", async () => {
    const spec = buildViewSpec({ view: "v", calls: [call("sim.ssa", { t_end: 5, seed: -1 }), call("sim.ssa", { t_end: 5, nope: 1 }), call("sim.ssa", { t_end: "five" })] });
    const r = await replay(spec, sandboxRegistry(sir()));
    assertEquals(r.steps.map((s: any) => !!s.error), [true, true, true]);
    assertStringIncludes(r.steps[1].error, 'unknown argument "nope"');
    assertEquals(r.partial, true);
});
