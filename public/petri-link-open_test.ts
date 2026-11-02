import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    NOTE_LABEL, STATUS, appRevision, buildShareLink, engineNotes, engineSentence, linkStripHtml, openLinkedView, statusesOf,
} from "./petri-link-open.js";
import { DEFAULT_ROUNDING, MAX_LINK_CHARS, buildViewSpec, decodePermalinkData, decodeView, encodeView, expectFor, parseLocation, replayViewSpec, sandboxRegistry, validateViewSpec } from "./petri-viewspec.js";
import { defaultVersions, footerHtml, provenance, recordFromGoalRun, recordFromSpec } from "./petri-provenance.js";
import { runGoal } from "./petri-goals.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { loadEngine } from "./petri-wasm.js";

const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const goalById = (id: string) => catalog.goals.find((g: any) => g.id === id);

const sir = (): any => ({
    places: { S: { initial: [45], capacity: [0], x: 0, y: 0 }, I: { initial: [5], capacity: [0], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
    transitions: { infect: { x: 50, y: 0, rate: 0.01 }, recover: { x: 150, y: 0, rate: 0.1 } },
    arcs: [
        { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
        { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
        { source: "recover", target: "R", weight: [1] },
    ],
});
const CID = "z4EBG9jTestNetCid";
const call = (command: string, args: Record<string, unknown> = {}) => ({ command, args });
const NOW = defaultVersions({ app: "rev-now" });

// The replay a page does in a Worker, in this thread: same validation, same sandbox, same result shape.
// (replayInWorker returns the artifacts' data as `artifactData`; replayViewSpec does too.)
const inThread = (spec: any, model: any, o: any = {}): Promise<any> => replayViewSpec(spec, sandboxRegistry(model), { versions: o.versions });

// A recorded view: the conserved-quantities goal run for real, its digests taken.
async function recorded(extra: any = {}): Promise<any> {
    const goal = goalById("conserved");
    const reg: any = new Registry(createHeadlessHost(sir()));
    const out = await runGoal(reg, goal, {});
    assert(out.ok);
    const record = recordFromGoalRun(goal, out, { net: { cid: CID, revision: 0 }, versions: NOW });
    const draft = buildViewSpec({ net: CID, view: goal.id, calls: record.calls, engine: NOW, ...extra });
    const first = await inThread(draft, sir());
    const spec = { ...draft, expect: await expectFor(first.artifactData) };
    const run = await inThread(spec, sir()); // the run an opener gets: its drift is against the digests
    assertEquals(run.drift.matched.length, spec.expect.artifacts.length);
    return { goal, record, spec, run };
}
const loc = async (spec: any, search = `?cid=${CID}`) => ({ search, hash: `#view=${await encodeView(spec)}` });
const open = async (spec: any, o: any = {}): Promise<any> => openLinkedView({
    location: o.location ?? await loc(spec), model: o.model ?? sir(), netCid: o.netCid === undefined ? CID : o.netCid,
    ...(o.netSource === undefined ? {} : { netSource: o.netSource }),
    registry: sandboxRegistry(o.model ?? sir()), replay: o.replay ?? inThread, getVersions: o.getVersions ?? (async () => NOW), goals: o.goals ?? catalog,
    ...(o.versionsWaitMs === undefined ? {} : { versionsWaitMs: o.versionsWaitMs }),
});

// ---------------------------------------------------------------------------
// recordFromSpec
// ---------------------------------------------------------------------------

Deno.test("recordFromSpec: the spec's calls, the versions that made it, its net and its note", async () => {
    const { spec } = await recorded({ note: "Two quantities hold." });
    const r = recordFromSpec(spec, { goal: { id: "conserved", question: "Is anything conserved?", caveat: "c" } });
    assertEquals(r.calls, spec.calls);
    assertEquals(r.goal, { id: "conserved", question: "Is anything conserved?" });
    assertEquals(r.net, { cid: CID, revision: 0 });
    assertEquals(r.versions, spec.engine);
    assertEquals(r.note, { by: "assistant", text: "Two quantities hold." });
    assertEquals(r.caveat, "c");
    assertEquals(r.engine, null, "analysis.invariants runs no ODE, SSA or SDE");
    // a command that runs an engine names it, and says where the choice came from
    const sim = recordFromSpec(buildViewSpec({ net: CID, view: "x", calls: [call("sim.ssa", { t_end: 5, runs: 2, seed: 1 })], engine: NOW }));
    assertEquals(sim.engine, { name: "SSA", reason: "as recorded in the link" });
    // no engine in the spec: the footer says unknown, not this build's
    const bare = recordFromSpec({ calls: [call("sim.ode")], net: null, note: null });
    assertEquals(bare.versions, { registry: "unknown", app: "unknown" });
    assertEquals(bare.net.cid, undefined);
    // a refused link's note is left out
    assertEquals(recordFromSpec(spec, { withNote: false }).note, null);
    // and the footer draws it
    const html = footerHtml(r);
    assertStringIncludes(html, "analysis.invariants");
    assertStringIncludes(html, "Two quantities hold.");
});

Deno.test("recordFromSpec: a malformed call is dropped rather than thrown on (the spec may be untrusted)", () => {
    const r = recordFromSpec({ calls: [null, { args: {} }, { command: "sim.ode", args: { t_end: 1 } }, { id: "sim.ssa" }] });
    assertEquals(r.calls.map((c: any) => c.command), ["sim.ode", "sim.ssa"]);
    assertEquals(recordFromSpec({}).calls, []);
});

// ---------------------------------------------------------------------------
// opening a link
// ---------------------------------------------------------------------------

Deno.test("openLinkedView: no #view= is none; a compose-page hash is none", async () => {
    const base = { model: sir(), netCid: CID, registry: sandboxRegistry(sir()), replay: inThread };
    assertEquals((await openLinkedView({ ...base, location: { search: `?cid=${CID}`, hash: "" } })).kind, "none");
    assertEquals((await openLinkedView({ ...base, location: { search: "", hash: "#view=cospan&ex=orders" } })).kind, "none");
    assertEquals((await openLinkedView({ ...base, location: { search: "?cid=x", hash: "#access_token=abc" } })).kind, "none");
    assertEquals((await openLinkedView({ ...base, location: undefined as any })).kind, "none");
});

Deno.test("openLinkedView: a good link reproduces: every digest matched, no model call, the note under its label", async () => {
    const { spec } = await recorded({ note: "Two quantities hold." });
    const o = await open(spec);
    assertEquals(o.kind, "result");
    assertEquals(o.opening.status, "reproduced");
    assertEquals(o.opening.chips.map((c: any) => c.text), [STATUS.saved, STATUS.reproduced]);
    assertEquals(o.result.source, "link");
    assertEquals(o.result.title, "Is anything conserved?");
    assertEquals(o.result.warnings, []);
    assertEquals(o.result.stale, false);
    assertEquals(o.result.record.calls, spec.calls);
    assertEquals(o.result.record.net.cid, CID);
    assertEquals(o.result.artifacts.length, spec.expect.artifacts.length);
    // artifacts are the objects showResult draws: id, title, data and the call that made them
    const a = o.result.artifacts[0];
    assertEquals([typeof a.id, typeof a.title, typeof a.data.kind, a.source.command], ["string", "string", "string", "analysis.invariants"]);
    assert(spec.expect.artifacts.length >= 1, "the goal files at least one result");
    // the strip: chips, the note labelled, the saved-version line
    const html = linkStripHtml(o.opening);
    assertStringIncludes(html, STATUS.saved);
    assertStringIncludes(html, STATUS.reproduced);
    assertStringIncludes(html, NOTE_LABEL.replace("'", "&#39;"));
    assertStringIncludes(html, "Two quantities hold.");
    assertStringIncludes(html, "This is a saved version of the net");
    assert(!html.includes("net-alone"), "a view that reproduced has no 'open the net alone'");
});

Deno.test("openLinkedView: a view that is not a goal has no question: the title says the view", async () => {
    const draft = buildViewSpec({ net: CID, view: "trajectories", calls: [call("sim.ode", { t_end: 10 })], engine: NOW });
    const run = await inThread(draft, sir());
    const spec = { ...draft, expect: await expectFor(run.artifactData) };
    const o = await open(spec);
    assertEquals([o.kind, o.result.title, o.result.goal], ["result", "View: trajectories", null]);
    assertEquals(o.opening.status, "reproduced");
});

Deno.test("openLinkedView: a link with no digests runs and says there is nothing to compare, not 'reproduced'", async () => {
    const { spec } = await recorded();
    const bare = { ...spec, expect: { artifacts: [], rounding: DEFAULT_ROUNDING } };
    const o = await open(bare);
    assertEquals(o.opening.status, "ran");
    assertEquals(o.opening.chips.map((c: any) => c.id), ["saved", "ran"]);
    assert(!o.opening.chips.some((c: any) => c.text === STATUS.reproduced));
});

Deno.test("openLinkedView: a changed digest says it differs, with both engine versions and both digests; the new result is shown", async () => {
    const { spec } = await recorded();
    const flip = (d: string) => d.replace(/.$/, d.endsWith("0") ? "1" : "0");
    const tampered = { ...spec, expect: { ...spec.expect, artifacts: [flip(spec.expect.artifacts[0]), ...spec.expect.artifacts.slice(1)] } };
    const made = { registry: "pflow-native 0.7.0 wasm aaaaaaa", app: "rev-old" };
    const o = await open({ ...tampered, engine: made });
    assertEquals(o.opening.status, "differs");
    assertEquals(o.opening.chips.map((c: any) => c.id), ["saved", "differs"]);
    const w = o.result.warnings.join("\n");
    assertStringIncludes(w, STATUS.differs);
    assertStringIncludes(w, "pflow-native 0.7.0 wasm aaaaaaa");
    assertStringIncludes(w, "app rev-old");
    assertStringIncludes(w, NOW.registry);
    assertStringIncludes(w, "app rev-now");
    assertStringIncludes(w, "saved sha256:");
    assertStringIncludes(w, "now sha256:");
    assertStringIncludes(w, "not the saved one");
    assertEquals(o.result.artifacts.length, spec.expect.artifacts.length, "the new result is shown, not hidden");
    assertEquals(o.opening.run.drift.differed.length, 1, "only the tampered digest differs");
    // the same engine on both sides is said too, so the notice never blames an upgrade that did not happen
    const same = await open({ ...tampered, engine: NOW });
    assertStringIncludes(same.result.warnings.join(""), "Both ran");
    assertStringIncludes(engineSentence(null, NOW), "does not name");
});

Deno.test("openLinkedView: more or fewer results than the link remembers is a difference, not a match", async () => {
    const { spec } = await recorded();
    const n = spec.expect.artifacts.length;
    const more = { ...spec, expect: { ...spec.expect, artifacts: [...spec.expect.artifacts, spec.expect.artifacts[0]] } };
    const o = await open(more);
    assertEquals(o.opening.status, "differs");
    assertStringIncludes(o.result.warnings.join(""), `result ${n + 1}: saved sha256:`);
    assertStringIncludes(o.result.warnings.join(""), "now none");
    const fewer = { ...spec, expect: { ...spec.expect, artifacts: spec.expect.artifacts.slice(0, n - 1).concat(n > 1 ? [] : []) } };
    if (n > 1) {
        const f = await open(fewer);
        assertEquals(f.opening.status, "differs");
        assertStringIncludes(f.result.warnings.join(""), `remembers ${n - 1} result`);
    }
});

Deno.test("openLinkedView: a command this app does not have is 'not reproducible here'; the note and calls stay, the rest runs", async () => {
    const { spec } = await recorded({ note: "Look at the siphons." });
    const odd = { ...spec, calls: [call("analysis.teleport", { to: "mars" }), ...spec.calls] };
    const o = await open(odd);
    assertEquals(o.kind, "result");
    assertEquals(o.opening.status, "unreproducible");
    assert(o.opening.chips.some((c: any) => c.text === STATUS.unreproducible));
    assertStringIncludes(o.result.warnings.join(""), '"analysis.teleport"');
    assertEquals(o.result.record.calls.map((c: any) => c.command), ["analysis.teleport", "analysis.invariants"], "the calls are all listed in the footer");
    assertEquals(o.result.record.note?.text, "Look at the siphons.", "the note is kept");
    assertEquals(o.result.artifacts.length, spec.expect.artifacts.length, "the call this app has still ran");
    assertStringIncludes(linkStripHtml(o.opening), 'data-act="net-alone"');
});

Deno.test("openLinkedView: a call that fails is partial and the error is the engine's, naming the place", async () => {
    const draft = buildViewSpec({ net: CID, view: "one_more", calls: [call("sim.what_if", { place: "queue", delta: 1, t_end: 5, runs: 2, seed: 1 })], engine: NOW });
    const o = await open(draft);
    assertEquals(o.opening.status, "partial");
    assertEquals(o.opening.chips.map((c: any) => c.id), ["saved", "partial"]);
    const w = o.result.warnings.join("");
    assertStringIncludes(w, "partial: sim.what_if did not run");
    assertStringIncludes(w, "queue");
    assertEquals(o.result.artifacts.length, 0);
    assert(o.result.record.warnings.some((x: string) => x.includes("queue")), "the footer lists it too");
});

Deno.test("openLinkedView: any command a link may not run refuses the whole link; nothing runs, the net is untouched, the note is not shown", async () => {
    for (const bad of ["edit.delete", "net.add_place", "store.put", "file.save", "file.write", "model.delete", "note.add", "export.svg"]) {
        const model = sir();
        const before = JSON.stringify(model);
        let ran = 0;
        const { spec } = await recorded({ note: "Trust me." });
        const evil = { ...spec, calls: [spec.calls[0], call(bad, { id: "S" })] };
        const o = await open(evil, { model, replay: (s: any, m: any, x: any) => { ran++; return inThread(s, m, x); } });
        assertEquals(o.kind, "result", bad);
        assertEquals(o.opening.status, "refused", bad);
        assertEquals(ran, 0, `${bad}: nothing ran, not even the harmless call`);
        assertEquals(o.result.artifacts, []);
        assertStringIncludes(o.result.warnings.join(""), `"${bad}"`);
        assertStringIncludes(o.result.warnings.join(""), "Nothing was run");
        assertEquals(o.result.record.note, null, "an untrusted note is not shown");
        assertEquals(o.opening.note, null);
        assertEquals(o.result.record.calls.length, 2, "what the link asked for is listed");
        assertEquals(JSON.stringify(model), before, "the net was not touched");
        assert(!linkStripHtml(o.opening).includes("Trust me."));
    }
});

Deno.test("openLinkedView: a garbage, oversized or too-new payload is a one-line notice; a spec out of bounds too", async () => {
    const base = { model: sir(), netCid: CID, registry: sandboxRegistry(sir()), replay: inThread };
    for (const hash of ["#view=not-a-payload", "#view=AAAA", `#view=${"A".repeat(70000)}`, "#view=%%%"]) {
        const o: any = await openLinkedView({ ...base, location: { search: `?cid=${CID}`, hash } });
        assertEquals(o.kind, "notice", hash.slice(0, 20));
        assert(!o.text.includes("\n"), "one line");
        assertStringIncludes(o.text, "the net is open on its own");
    }
    const { spec } = await recorded();
    const newer = await open({ ...spec, specVersion: 99 });
    assertEquals(newer.kind, "notice");
    assertStringIncludes(newer.text, "newer");
    const huge = await open({ ...spec, calls: [call("sim.ssa", { t_end: 1, runs: 100000, seed: 1 })] });
    assertEquals(huge.kind, "notice");
    assertStringIncludes(huge.text, "runs");
    const noCalls = await open({ ...spec, calls: [] });
    assertEquals(noCalls.kind, "notice");
});

Deno.test("openLinkedView: a net that did not load is never replayed on whatever the editor holds; a net-less link says so", async () => {
    const { spec } = await recorded();
    const lost = await open(spec, { netCid: null });
    assertEquals(lost.kind, "notice");
    assertStringIncludes(lost.text, "could not be loaded");
    assertStringIncludes(lost.text, "removed by its author");
    const other = await open(spec, { netCid: "z4EBG9jSomethingElse" });
    assertEquals(other.kind, "notice");
    const none = await open(spec, { location: { search: "", hash: `#view=${await encodeView(spec)}` } });
    assertEquals(none.kind, "notice");
    assertStringIncludes(none.text, "names no net");
});

Deno.test("openLinkedView: a ?data= link carries its net: no CID is claimed, and the chip says so", async () => {
    const { spec } = await recorded();
    const data = encodeURIComponent(JSON.stringify(sir()));
    const o = await open({ ...spec, net: null }, { location: { search: `?data=${encodeURIComponent(data)}`, hash: `#view=${await encodeView(spec)}` }, netCid: null });
    assertEquals(o.kind, "result");
    assertEquals(o.opening.chips[0].text, STATUS.carried);
    assertEquals(o.result.record.net.cid, undefined);
    assertStringIncludes(linkStripHtml(o.opening), "travels inside this link");
});

Deno.test("openLinkedView: a replay that cannot start, or stops, is a notice or a partial, not a throw", async () => {
    const { spec } = await recorded();
    const dead = await open(spec, { replay: async () => ({ ok: false, errors: ["could not start the replay worker: no"], steps: [], artifacts: [], artifactData: [], drift: { matched: [], differed: [], unchecked: [] }, notReproducible: [], refused: [], deferred: [], partial: false, mutated: false, timedOut: null }) });
    assertEquals(dead.kind, "notice");
    assertStringIncludes(dead.text, "could not start");
    const slow = await open(spec, { replay: async () => ({ ok: false, errors: ["the replay did not finish in 120 s; stopped"], steps: [], artifacts: [], artifactData: [], drift: { matched: [], differed: [], unchecked: [] }, notReproducible: [], refused: [], deferred: [], partial: true, mutated: false, timedOut: { scope: "total", ms: 120000, index: 0, command: "sim.ssa" } }) });
    assertEquals(slow.kind, "result");
    assertEquals(slow.opening.status, "partial");
    assertStringIncludes(slow.result.warnings.join(""), "did not finish");
    const boom = await open(spec, { replay: async () => { throw new Error("boom"); } });
    assertEquals(boom.kind, "notice");
    assertStringIncludes(boom.text, "boom");
});

Deno.test("openLinkedView: the sandbox's net comes back changed (mutated): refused, and said", async () => {
    const { spec, run } = await recorded();
    const o = await open(spec, { replay: async () => ({ ...run, mutated: true }) });
    assertEquals(o.opening.status, "refused");
    assertStringIncludes(o.result.warnings.join(""), "Nothing was applied to your net");
});

Deno.test("openLinkedView: it makes no request of its own: no fetch, so no /api/llm", async () => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = ((u: any) => { seen.push(String(u)); return Promise.reject(new Error("no network in this test")); }) as any;
    try {
        const { spec } = await recorded();
        const o = await open(spec);
        assertEquals(o.kind, "result");
        await open({ ...spec, calls: [call("edit.delete", {})] });
        await open(spec, { location: { search: `?cid=${CID}`, hash: "#view=bad" } });
        assertEquals(seen, []);
    } finally { globalThis.fetch = real; }
});

Deno.test("engineNotes: an ODE call on a net the engine says SSA for carries the guard's chip, even where a plan would be refused", async () => {
    // 50 tokens: the soft rule. sim.ode only warns; analysis.diagnose would be refused in a plan, and here shows the chip.
    const small = await engineNotes([call("sim.ode", { t_end: 5 }), call("analysis.diagnose", { observable: "R", t_end: 5 }), call("sim.ssa", { t_end: 5 })], sandboxRegistry(sir()));
    assertEquals(small.map((n) => n.command), ["sim.ode"].concat(small.length > 1 ? ["analysis.diagnose"] : []));
    assertStringIncludes(small[0].message, "ODE on a net where the engine recommends SSA");
    assertStringIncludes(small[0].message, "only 50 tokens");
    assert(!small.some((n) => n.message.includes("Nothing ran")), "the chip's text, not the refusal's");
    // the SSA needs nothing; a call that uses no engine has nothing to look at
    assertEquals(await engineNotes([call("sim.ssa", { t_end: 5 }), call("analysis.invariants", { kind: "p" })], sandboxRegistry(sir())), []);
    // a big net the ODE suits: nothing to say
    const big = sir();
    big.places.S.initial = [5000];
    assertEquals(await engineNotes([call("sim.ode", { t_end: 5 })], sandboxRegistry(big)), []);
    // hard rule: an inhibitor arc, and the ODE would silently model an unconstrained system
    const gated = sir();
    gated.places.S.initial = [5000];
    gated.arcs.push({ source: "R", target: "infect", weight: [1], inhibitTransition: true });
    const hard = await engineNotes([call("sim.ode", { t_end: 5 })], sandboxRegistry(gated));
    assertEquals(hard.length, 1);
    assertStringIncludes(hard[0].message, "ODE on a net with");
    // never throws: a registry that cannot say, or no calls
    assertEquals(await engineNotes([call("sim.ode")], { execute: async () => { throw new Error("no"); } }), []);
    assertEquals(await engineNotes(undefined as any, sandboxRegistry(sir())), []);
});

Deno.test("openLinkedView: an ODE view of a net the engine says SSA for opens with the caution, in the warnings and on the footer's engine", async () => {
    const draft = buildViewSpec({ net: CID, view: "average", calls: [call("sim.ode", { t_end: 5 })], engine: NOW });
    const first = await inThread(draft, sir());
    const spec = { ...draft, expect: await expectFor(first.artifactData) };
    const o = await open(spec);
    assertEquals(o.opening.status, "reproduced", "the view still reproduces");
    assertStringIncludes(o.result.warnings.join(""), "engine caution: ODE on a net where the engine recommends SSA");
    assertEquals(o.result.record.engine.name, "ODE");
    assertStringIncludes(o.result.record.engine.warning, "engine recommends SSA");
    assertStringIncludes(footerHtml(o.result.record), "pv-prov-warn");
    // a view that needs no engine has no caution
    const plain = await recorded();
    assertEquals((await open(plain.spec)).result.warnings, []);
});

Deno.test("linkStripHtml: everything the link says is escaped", () => {
    const html = linkStripHtml({
        status: "unreproducible", note: '<img src=x onerror=alert(1)>"\'&', netLine: "<b>line</b>",
        chips: [{ id: 'x"><script>', text: "<script>alert(2)</script>", tone: "warn" }],
    });
    assert(!html.includes("<script>") && !html.includes("<img") && !html.includes("<b>line"));
    assertStringIncludes(html, "&lt;img src=x onerror=alert(1)&gt;");
    assertStringIncludes(html, "pv-prov-warn");
    assertStringIncludes(linkStripHtml(null), "data-link-status");
});

Deno.test("statusesOf: priority, and a deferred view command is mentioned, not hidden", async () => {
    const { spec, run } = await recorded();
    const st = statusesOf(spec, run, NOW);
    assertEquals([st.status, st.warnings], ["reproduced", []]);
    const deferred = statusesOf(spec, { ...run, deferred: [{ command: "view.highlight", args: {} }, { command: "view.highlight", args: {} }] }, NOW);
    assertEquals(deferred.status, "reproduced");
    assertEquals(deferred.warnings, ['Not run here: "view.highlight" need the canvas.']);
});

// ---------------------------------------------------------------------------
// making a link
// ---------------------------------------------------------------------------

async function parts(url: string): Promise<any> {
    const u = new URL(url);
    const l = parseLocation({ search: u.search, hash: u.hash });
    return { u, l, decoded: await decodeView(l.viewPayload!, { net: l.cid }) };
}

Deno.test("buildShareLink: a saved net gives /?cid=...#view=, and it opens to the same view with every digest matching", async () => {
    const { record } = await recorded();
    const r: any = await buildShareLink({ record, model: sir(), cid: CID, origin: "https://pflow.xyz", replay: inThread, versions: NOW });
    assertEquals(r.ok, true);
    assertEquals(r.kind, "saved");
    assert(r.url.startsWith(`https://pflow.xyz/?cid=${CID}#view=`), r.url);
    const { l, decoded } = await parts(r.url);
    assertEquals(l.cid, CID);
    assertEquals(decoded.ok, true);
    assertEquals(decoded.spec.engine, NOW, "the engine versions are this build's");
    assertEquals(decoded.spec.calls, record.calls);
    assertEquals(decoded.spec.view, "conserved");
    assertEquals(decoded.spec.expect.rounding, DEFAULT_ROUNDING);
    assertEquals(decoded.spec.expect.artifacts.length, 2, "the conserved goal files two results");
    // opened in a fresh page, it reproduces
    const o: any = await openLinkedView({ location: { search: `?cid=${CID}`, hash: new URL(r.url).hash }, model: sir(), netCid: CID, registry: sandboxRegistry(sir()), replay: inThread, getVersions: async () => NOW, goals: catalog });
    assertEquals(o.opening.status, "reproduced");
});

Deno.test("buildShareLink: an unsaved small net carries itself in ?data=; and that link opens too", async () => {
    const { record } = await recorded();
    const model = sir();
    const r: any = await buildShareLink({ record, model, cid: null, origin: "https://pflow.xyz", replay: inThread, versions: NOW });
    assertEquals([r.ok, r.kind], [true, "unsaved"]);
    assert(r.url.length <= MAX_LINK_CHARS, `${r.url.length}`);
    const { u, l, decoded } = await parts(r.url);
    assertEquals(l.cid, null);
    assertEquals(decodePermalinkData(l.data!), model, "the net round-trips through the permalink");
    assertEquals(decoded.spec.net, null);
    const o: any = await openLinkedView({ location: { search: u.search, hash: u.hash }, model, netCid: null, registry: sandboxRegistry(model), replay: inThread, getVersions: async () => NOW });
    assertEquals(o.opening.status, "reproduced");
    assertEquals(o.opening.chips[0].text, STATUS.carried);
});

Deno.test("buildShareLink: an unsaved net too big to carry says 'Save to get a link'; a saved one still links", async () => {
    const { record } = await recorded();
    const big = sir();
    for (let i = 0; i < 400; i++) big.places[`p${i}`] = { initial: [0], capacity: [0], x: i, y: i };
    const r: any = await buildShareLink({ record, model: big, cid: null, replay: inThread, versions: NOW });
    assertEquals([r.ok, r.needsSave], [false, true]);
    assertStringIncludes(r.reason, "Save to get a link");
    const saved: any = await buildShareLink({ record, model: big, cid: CID, replay: inThread, versions: NOW });
    assertEquals([saved.ok, saved.kind], [true, "saved"]);
});

Deno.test("buildShareLink: a record a link may not run, one that fails, or an empty one gets a reason and no link", async () => {
    const model = sir();
    const edit = provenance({ calls: [call("edit.delete", { id: "S" })], net: { cid: CID } });
    const a: any = await buildShareLink({ record: edit, model, cid: CID, replay: inThread, versions: NOW });
    assertEquals(a.ok, false);
    assertStringIncludes(a.reason, "edit.delete");
    const bad = provenance({ calls: [call("sim.what_if", { place: "nope", delta: 1, t_end: 5, runs: 2, seed: 1 })], net: { cid: CID } });
    const b: any = await buildShareLink({ record: bad, model, cid: CID, replay: inThread, versions: NOW });
    assertEquals(b.ok, false);
    assertStringIncludes(b.reason, "sim.what_if");
    const c: any = await buildShareLink({ record: provenance({}), model, cid: CID, replay: inThread, versions: NOW });
    assertEquals(c.ok, false);
    assertStringIncludes(c.reason, "run something first");
    const d: any = await buildShareLink({ record: undefined as any, model, cid: CID });
    assertEquals(d.ok, false);
    const huge: any = await buildShareLink({ record: provenance({ calls: [call("sim.ssa", { t_end: 1, runs: 100000, seed: 1 })] }), model, cid: CID, replay: inThread, versions: NOW });
    assertEquals(huge.ok, false);
    const slow: any = await buildShareLink({ record: provenance({ calls: [call("sim.ode", { t_end: 5 })] }), model, cid: CID, versions: NOW, replay: async () => ({ errors: ["too slow"], steps: [], artifacts: [], timedOut: { scope: "total" } }) });
    assertEquals(slow.ok, false);
    assertStringIncludes(slow.reason, "too long");
    const boom: any = await buildShareLink({ record: provenance({ calls: [call("sim.ode", { t_end: 5 })] }), model, cid: CID, versions: NOW, replay: async () => { throw new Error("boom"); } });
    assertEquals(boom.ok, false);
    assertStringIncludes(boom.reason, "boom");
});

Deno.test("buildShareLink: the link's note is the record's, and a link made from a link differs only by what changed", async () => {
    const { record } = await recorded();
    const noted = { ...record, note: { by: "assistant", text: "It is conserved." } };
    const r: any = await buildShareLink({ record: noted, model: sir(), cid: CID, origin: "https://pflow.xyz", replay: inThread, versions: NOW });
    const { decoded } = await parts(r.url);
    assertEquals(decoded.spec.note, { by: "assistant", text: "It is conserved." });
    const again: any = await buildShareLink({ record: noted, model: sir(), cid: CID, origin: "https://pflow.xyz", replay: inThread, versions: NOW });
    assertEquals(again.url, r.url, "the same view makes the same link");
    const other: any = await buildShareLink({ record: noted, model: sir(), cid: "z4EBG9jOther", origin: "https://pflow.xyz", replay: inThread, versions: NOW });
    assertNotEquals(other.url, r.url);
});

// ---------------------------------------------------------------------------
// review findings: a stalled /health, a ?data= that did not decode, a net that is not the one the view was made on
// ---------------------------------------------------------------------------

Deno.test("openLinkedView: a build version that never arrives does not hold the link open: the replay runs, and the app reads unknown", async () => {
    const { spec } = await recorded();
    const t0 = Date.now();
    const o = await open(spec, { getVersions: () => new Promise(() => {}), versionsWaitMs: 30 });
    assertEquals(o.kind, "result");
    assertEquals(o.opening.status, "reproduced", "the digests do not depend on the app revision");
    assert(Date.now() - t0 < 5000, "it waited for the version only as long as it was told to");
    // a version lookup that fails is the same as one that does not come
    const failed = await open(spec, { getVersions: () => Promise.reject(new Error("health is down")) });
    assertEquals(failed.kind, "result");
    assertEquals(failed.opening.status, "reproduced");
});

Deno.test("openLinkedView: the replay starts without waiting for the build version", async () => {
    const { spec } = await recorded();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // the version is held until the replay has been started: if the opener awaited it first, this would wait out versionsWaitMs
    const t0 = Date.now();
    const o = await open(spec, {
        versionsWaitMs: 60000,
        getVersions: async () => { await gate; return NOW; },
        replay: (s: any, m: any, ro: any) => { release(); return inThread(s, m, ro); },
    });
    assertEquals(o.kind, "result");
    assert(Date.now() - t0 < 30000, "the replay was not gated on the version");
});

Deno.test("openLinkedView: a ?data= the editor could not decode is never replayed on the net it fell back to", async () => {
    const { spec } = await recorded();
    const hash = `#view=${await encodeView(spec)}`;
    // the editor kept its default net (netSource 'other'): "Net carried in the link" would be a lie
    const cut = await open(spec, { location: { search: "?data=%7B%22data%22%3A%7B%22places%22%3A%7B%22A%22%3A", hash }, netCid: null, netSource: "other" });
    assertEquals(cut.kind, "notice");
    assertStringIncludes(cut.text, "could not be read");
    assertStringIncludes(cut.text, "net is open on its own");
    // ?cid=X&data=<garbage>: the editor loaded X, but the link said the net was the data
    const both = await open(spec, { location: { search: `?cid=${CID}&data=%7Bbroken`, hash }, netCid: CID, netSource: "cid" });
    assertEquals(both.kind, "notice");
    assertStringIncludes(both.text, "could not be read");
    // the data decoded: the view is replayed on it, and the chip says the net was carried
    const fine = await open({ ...spec, net: null }, { location: { search: `?data=${encodeURIComponent(encodeURIComponent(JSON.stringify(sir())))}`, hash }, netCid: null, netSource: "data" });
    assertEquals(fine.kind, "result");
    assertEquals(fine.opening.chips[0].text, STATUS.carried);
});

Deno.test("engineSentence / statusesOf: a net that travels in the link may be what differs, and the saved-net wording is unchanged", async () => {
    // saved net: a CID is immutable, so the engine alone is blamed (and nothing about the net is said)
    assertEquals(engineSentence(NOW, NOW), `Both ran ${NOW.registry}, app rev-now; the same engine now gives another answer.`);
    assertEquals(engineSentence(NOW, NOW, { netSaved: true }), engineSentence(NOW, NOW));
    // carried net: the same engine on both sides no longer proves the engine changed
    const carried = engineSentence(NOW, NOW, { netSaved: false });
    assertStringIncludes(carried, `Both ran ${NOW.registry}`);
    assertStringIncludes(carried, "not the net the view was made on");
    assert(!carried.includes("the same engine now gives another answer."), carried);
    const other = engineSentence({ registry: "pflow-native 0.7.0", app: "a" }, NOW, { netSaved: false });
    assertStringIncludes(other, "may also differ from the net the view was made on");
    assert(!engineSentence({ registry: "pflow-native 0.7.0", app: "a" }, NOW).includes("may also differ"));
    // the status's warning carries it
    const { spec, run } = await recorded();
    const tampered = { ...spec, expect: { ...spec.expect, artifacts: spec.expect.artifacts.map((d: string) => d.replace(/.$/, d.endsWith("0") ? "1" : "0")) } };
    const drifted = await inThread(tampered, sir());
    assertStringIncludes(statusesOf(tampered, drifted, NOW, { netSaved: false }).warnings.join(" "), "not the net the view was made on");
    assertStringIncludes(statusesOf(tampered, drifted, NOW).warnings.join(" "), "the same engine now gives another answer");
    assertEquals(run.drift.differed.length, 0);
});

Deno.test("openLinkedView: a differing view on a carried net does not blame the engine alone; a saved net still does", async () => {
    const { spec } = await recorded();
    const tampered = { ...spec, expect: { ...spec.expect, artifacts: spec.expect.artifacts.map((d: string) => d.replace(/.$/, d.endsWith("0") ? "1" : "0")) } };
    const hash = `#view=${await encodeView({ ...tampered, engine: NOW })}`;
    const data = encodeURIComponent(encodeURIComponent(JSON.stringify(sir())));
    const carried = await open({ ...tampered, engine: NOW, net: null }, { location: { search: `?data=${data}`, hash }, netCid: null, netSource: "data" });
    assertEquals(carried.opening.status, "differs");
    assertStringIncludes(carried.result.warnings.join(" "), "not the net the view was made on");
    // both a CID and a carried copy (an address copied after an edit, from before the editor dropped the #view=): said on the net line
    const edited = await open({ ...tampered, engine: NOW, net: null }, { location: { search: `?cid=${CID}&data=${data}`, hash }, netCid: CID, netSource: "data" });
    assertEquals(edited.opening.chips[0].text, STATUS.carried);
    assertStringIncludes(edited.opening.netLine, "names a saved net");
    assertStringIncludes(edited.opening.netLine, "may have been edited");
    const saved = await open({ ...tampered, engine: NOW });
    assertStringIncludes(saved.result.warnings.join(" "), "the same engine now gives another answer");
    assert(!saved.result.warnings.join(" ").includes("not the net the view was made on"));
});

Deno.test("appRevision: a /health that never answers is unknown after the timeout, whether or not the fetch honours the abort", async () => {
    const t0 = Date.now();
    // a fetch that ignores its signal and never settles
    assertEquals(await appRevision((() => new Promise(() => {})) as any, { timeoutMs: 30 }), "unknown");
    // one that honours it (the request is cancelled, not left open)
    let aborted = false;
    const honours = (_u: any, init: any) => new Promise((_res, rej) => { init.signal.addEventListener("abort", () => { aborted = true; rej(new DOMException("aborted", "AbortError")); }); });
    assertEquals(await appRevision(honours as any, { timeoutMs: 30 }), "unknown");
    assert(aborted, "the stalled request was aborted");
    assert(Date.now() - t0 < 5000);
    // an answer in time is still read
    const quick = async () => new Response("{}", { headers: { "X-Build-Revision": "abcdef0123456789" } });
    assertEquals(await appRevision(quick as any, { timeoutMs: 1000 }), "abcdef012345");
});

Deno.test("appRevision: the X-Build-Revision header, shortened; unknown when there is none or the request fails", async () => {
    const ok = (h: Record<string, string>) => async () => new Response("{}", { headers: h });
    assertEquals(await appRevision(ok({ "X-Build-Revision": "4f40f7d0123456789abcdef" }) as any), "4f40f7d01234");
    assertEquals(await appRevision(ok({}) as any), "unknown");
    assertEquals(await appRevision((async () => { throw new Error("offline"); }) as any), "unknown");
    assertEquals(await appRevision(undefined as any), "unknown");
});

Deno.test("a spec made by Copy link validates against the registry the page has", async () => {
    const { record } = await recorded();
    const r: any = await buildShareLink({ record, model: sir(), cid: CID, replay: inThread, versions: NOW });
    const v = validateViewSpec(r.spec, new Registry(createHeadlessHost(sir())), { model: sir() });
    assertEquals([v.ok, v.errors, v.refused, v.unknown], [true, [], [], []]);
});
