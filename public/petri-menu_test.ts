import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    ASK_PLACEHOLDER, MENU_ORDER, askSubmit, askTaken, classicHref, findOpenEntry, flattenMenus, isFocusable, menuModel, menuStep,
    openTargetFromRecord, parseOpen, prefillModel, releaseHref, resultFromOutcome, showsInline, triggerKey, typeahead,
    uiMode, userLine,
} from "./petri-menu.js";
import { ACTION_IDS, METHOD_OF } from "./petri-menu-ui.js";
import { buildIndex, outcomeOf, runCommandOutcome, runGoalOutcome } from "./petri-palette.js";
import { formModel, goalFormModel, readValues } from "./petri-schema-form.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { runGoal } from "./petri-goals.js";
import { footerHtml, provenance } from "./petri-provenance.js";
import { loadEngine } from "./petri-wasm.js";
import { bindPaletteKey, isTextFieldTarget } from "./petri-palette-ui.js";

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const sir = () => ({
    places: { S: { initial: [45], capacity: [0], x: 0, y: 0 }, I: { initial: [5], capacity: [0], x: 100, y: 0 }, R: { initial: [0], capacity: [0], x: 200, y: 0 } },
    transitions: { infect: { x: 50, y: 0, rate: 0.01 }, recover: { x: 150, y: 0, rate: 0.1 } },
    arcs: [
        { source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] },
        { source: "infect", target: "I", weight: [2] }, { source: "I", target: "recover", weight: [1] },
        { source: "recover", target: "R", weight: [1] },
    ],
});
const registry = () => new Registry(createHeadlessHost(sir()));
const specs: any[] = registry().list();
const index = buildIndex({ specs, goals: catalog, classic: [{ id: "classic.results", title: "Results", open() {} }] });

// ---- the palette's open option ----

Deno.test("parseOpen: an id and plain args; `command` stands for `id`; anything else is null", () => {
    assertEquals(parseOpen({ id: "sim.ssa", args: { runs: 5 } }), { id: "sim.ssa", kind: null, args: { runs: 5 } });
    assertEquals(parseOpen({ command: "sim.ode", args: { t_end: 10 } }), { id: "sim.ode", kind: null, args: { t_end: 10 } }, "a provenance call writes `command`");
    assertEquals(parseOpen({ id: "  sim.ssa  " })?.id, "sim.ssa", "trimmed");
    assertEquals(parseOpen({ id: "risk", kind: "goal" })?.kind, "goal");
    assertEquals(parseOpen({ id: "risk", kind: "nonsense" })?.kind, null);
    for (const bad of [null, undefined, "sim.ssa", 3, [], {}, { id: "" }, { id: "  " }, { id: 5 }, { args: { a: 1 } }]) assertEquals(parseOpen(bad as any), null, JSON.stringify(bad));
    assertEquals(parseOpen({ id: "x", args: [1, 2] })?.args, {}, "args that are not an object are dropped");
    assertEquals(parseOpen({ id: "x", args: "nope" })?.args, {});
});

Deno.test("parseOpen: the args are a copy, so the form cannot change the caller's record", () => {
    const args = { nested: { a: 1 }, list: [1, 2] };
    const p = parseOpen({ id: "x", args })!;
    (p.args as any).nested.a = 99;
    (p.args as any).list.push(3);
    assertEquals(args, { nested: { a: 1 }, list: [1, 2] });
    // values JSON cannot carry are not a crash
    const cyc: any = {};
    cyc.self = cyc;
    assertEquals(parseOpen({ id: "x", args: cyc })?.args, {});
});

Deno.test("findOpenEntry: a command or a goal, never a classic tool, and a command wins a tie", () => {
    assertEquals(findOpenEntry(index, { id: "sim.ssa" })?.kind, "command");
    assertEquals(findOpenEntry(index, { id: "sim.ssa" })?.id, "sim.ssa");
    const goal = catalog.goals[0];
    assertEquals(findOpenEntry(index, { id: goal.id })?.kind, "goal");
    assertEquals(findOpenEntry(index, { id: "classic.results" }), null, "a classic dialog has no form to open");
    assertEquals(findOpenEntry(index, { id: "no.such.command" }), null);
    assertEquals(findOpenEntry(index, null), null);
    assertEquals(findOpenEntry([], { id: "sim.ssa" }), null);
    // a tie: kind decides when given, a command otherwise
    const tie = [{ kind: "goal", id: "dup" }, { kind: "command", id: "dup" }];
    assertEquals(findOpenEntry(tie, { id: "dup" })?.kind, "command");
    assertEquals(findOpenEntry(tie, { id: "dup", kind: "goal" })?.kind, "goal");
    assertEquals(findOpenEntry([{ kind: "goal", id: "only" }], { id: "only", kind: "command" }), null);
});

Deno.test("prefillModel: a command's form opens with the arguments it was run with", () => {
    const spec = specs.find((s) => s.id === "sim.ssa")!;
    const base = formModel(spec.args);
    const { model, ignored } = prefillModel(base, { runs: 5, t_end: 20, seed: 7 });
    const by = (m: any, n: string) => m.fields.find((f: any) => f.name === n);
    assertEquals(by(model, "runs").default, 5);
    assertEquals(by(model, "t_end").default, 20);
    assertEquals(by(model, "seed").default, 7);
    assertEquals(ignored, []);
    // the model it was given is untouched
    assert(by(base, "runs").default !== 5 || spec.args.properties.runs.default === 5);
    assertEquals(model.fields.length, base.fields.length);
    // read back, the filled form gives the same arguments
    const raw: any = {};
    for (const f of model.fields) if (f.default !== undefined) raw[f.name] = f.default;
    const { args, errors } = readValues(model, raw);
    assertEquals(errors, []);
    assertEquals(args.runs, 5);
    assertEquals(args.t_end, 20);
});

Deno.test("prefillModel: a goal's inputs, and arguments the form has no field for are reported, not lost", () => {
    const goal = catalog.goals.find((g: any) => (g.inputs || []).some((i: any) => i.kind === "place"))!;
    const input = goal.inputs.find((i: any) => i.kind === "place");
    const base = goalFormModel(goal);
    const { model, ignored } = prefillModel(base, { [input.name]: "R", mystery: 1 });
    assertEquals(model.fields.find((f: any) => f.name === input.name).default, "R");
    assertEquals(ignored, ["mystery"]);
    // required stays required: the value is a default, not a decision
    assertEquals(model.fields.find((f: any) => f.name === input.name).required, base.fields.find((f: any) => f.name === input.name).required);
    // an unavailable goal has no form, and stays that way
    const none = prefillModel({ fields: [], noForm: "not here" }, { a: 1 });
    assertEquals(none.model.noForm, "not here");
    assertEquals(none.ignored, ["a"]);
    assertEquals(prefillModel(base, undefined as any).ignored, []);
    assertEquals(prefillModel(null as any, { a: 1 }).model.fields, []);
});

Deno.test("openTargetFromRecord: the first call, with its arguments", () => {
    const rec = provenance({ calls: [{ command: "sim.recommend", args: {} }, { command: "sim.ssa", args: { t_end: 42, runs: 20, seed: 1 } }] });
    assertEquals(openTargetFromRecord(rec), { id: "sim.recommend", kind: "command", args: {} });
    const one = provenance({ calls: [{ command: "sim.ssa", args: { t_end: 42, runs: 20, seed: 1 } }] });
    assertEquals(openTargetFromRecord(one), { id: "sim.ssa", kind: "command", args: { t_end: 42, runs: 20, seed: 1 } });
    assertEquals(openTargetFromRecord(provenance({})), null, "no call");
    assertEquals(openTargetFromRecord(null), null);
    assertEquals(openTargetFromRecord({ calls: [{}] } as any), null);
    // what it hands back opens: it parses, and names a command the registry has
    const t = openTargetFromRecord(one)!;
    assertEquals(parseOpen(t)?.id, "sim.ssa");
    assert(findOpenEntry(index, t));
});

// ---- the hand-over to the results pane ----

Deno.test("showsInline: only a run that failed outright stays in the palette", () => {
    assertEquals(showsInline({ error: "x: bad", calls: [], artifacts: [] }), true);
    assertEquals(showsInline({ error: "x: bad", calls: [{ command: "a", args: {} }], artifacts: [] }), false, "a step ran");
    assertEquals(showsInline({ error: "x: bad", calls: [], artifacts: ["a1"] }), false, "something was stored");
    assertEquals(showsInline({ error: null, calls: [], artifacts: [] }), false, "no error");
    assertEquals(showsInline(undefined as any), false);
});

Deno.test("resultFromOutcome: a command run becomes a result with the artifact object and a one-call record", async () => {
    const reg = registry();
    const outcome = await runCommandOutcome(reg, "sim.ssa", { t_end: 10, runs: 3, seed: 1 }, { title: "Run SSA" });
    assertEquals(outcome.error, null);
    assert(outcome.artifacts.length >= 1);
    const r = await resultFromOutcome(outcome, { registry: reg, net: { cid: "zb2rhExample", revision: "rev1" } });
    assertEquals(r.source, "palette");
    assertEquals(r.title, "Run SSA");
    assertEquals(r.goal, null);
    assertEquals(r.answer, null, "nothing here is model text");
    assertEquals(r.stale, false);
    assert(r.registry === reg);
    assertEquals(r.artifacts.length, outcome.artifacts.length);
    for (const a of r.artifacts) assert(a && typeof a === "object" && typeof a.id === "string" && a.data, "an artifact OBJECT, not an id");
    assertEquals(r.artifacts.map((a: any) => a.id), outcome.artifacts);
    assertEquals(r.record.calls, [{ command: "sim.ssa", args: { t_end: 10, runs: 3, seed: 1 } }]);
    assertEquals(r.record.goal, null);
    assertEquals(r.record.net, { cid: "zb2rhExample", revision: "rev1" });
    assertEquals(r.warnings, []);
    // the pane draws a footer from the record: the call is in it
    assert(footerHtml(r.record).includes("sim.ssa"));
});

Deno.test("resultFromOutcome: a goal run keeps its goal, its resolved calls and what it assumed", async () => {
    const reg = registry();
    const goal = catalog.goals.find((g: any) => g.id === "risk") || catalog.goals.find((g: any) => g.available !== false && !(g.inputs || []).some((i: any) => !i.optional && i.default === undefined))!;
    const inputs: any = {};
    for (const i of goal.inputs || []) if (i.kind === "place") inputs[i.name] = "I";
    const outcome = await runGoalOutcome(reg, goal, inputs, runGoal);
    const r = await resultFromOutcome(outcome, { registry: reg, net: { revision: "r" } });
    assertEquals(r.source, "palette");
    assertEquals(r.goal, { id: goal.id, question: goal.question });
    assertEquals(r.title, goal.question);
    assertEquals(r.record.goal, { id: goal.id, question: goal.question });
    assertEquals(r.record.calls.map((c: any) => c.command), outcome.calls.map((c: any) => c.command));
    assert(r.record.calls.length >= 1);
    assertEquals(r.record.caveat, goal.caveat);
    assertEquals(r.artifacts.map((a: any) => a.id), outcome.artifacts);
    // a goal whose plan the engine guard refused is a result with the refusal in its warnings, not a crash
    assert(Array.isArray(r.warnings));
});

Deno.test("resultFromOutcome: an error becomes a warning, and a vanished artifact is skipped", async () => {
    const reg = registry();
    const outcome = outcomeOf({
        kind: "command", title: "Run SSA",
        steps: [{ index: 0, command: "sim.ssa", args: { t_end: 1 }, error: "boom", artifacts: [] }],
    });
    assertEquals(outcome.error, "sim.ssa: boom");
    const r = await resultFromOutcome(outcome, { registry: reg });
    assertEquals(r.warnings, ["sim.ssa: boom"]);
    assertEquals(r.record.calls, [{ command: "sim.ssa", args: { t_end: 1 } }], "the call the person made is what Open in Tools reopens");
    assert(r.record.warnings.includes("sim.ssa: boom"));
    // an artifact id the registry no longer has
    const gone = { ...outcome, error: null, artifacts: ["a-does-not-exist"] };
    const r2 = await resultFromOutcome(gone, { registry: reg });
    assertEquals(r2.artifacts, []);
    // an artifact lookup that throws
    const r3 = await resultFromOutcome({ ...gone }, { registry: { artifact: () => { throw new Error("evicted"); } } as any });
    assertEquals(r3.artifacts, []);
    // nothing at all in the outcome: a record with no calls, a title, no crash
    const r4 = await resultFromOutcome({} as any, { registry: reg });
    assertEquals(r4.record.calls, []);
    assertEquals(r4.title, "Result");
    assertEquals(r4.artifacts, []);
});

Deno.test("resultFromOutcome: the record's first call opens a form filled with what was run", async () => {
    const reg = registry();
    const outcome = await runCommandOutcome(reg, "sim.ssa", { t_end: 12, runs: 4, seed: 9 }, { title: "Run SSA" });
    const r = await resultFromOutcome(outcome, { registry: reg });
    const t = openTargetFromRecord(r.record)!;
    const entry = findOpenEntry(index, t)!;
    assertEquals(entry.kind, "command");
    const spec = specs.find((s) => s.id === entry.id)!;
    const { model, ignored } = prefillModel(formModel(spec.args), parseOpen(t)!.args);
    assertEquals(ignored, []);
    const raw: any = {};
    for (const f of model.fields) if (f.default !== undefined) raw[f.name] = f.default;
    const back = readValues(model, raw);
    assertEquals(back.errors, []);
    assertEquals(back.args, { t_end: 12, runs: 4, seed: 9 }, "Open in Tools, then Run, repeats the call");
});

// ---- how the editor reaches the palette ----

Deno.test("bindPaletteKey: installed once per view and document, and the chord goes through view._openPalette", async () => {
    const listeners: any[] = [];
    const doc: any = {
        addEventListener: (_t: string, fn: any) => listeners.push(fn),
        removeEventListener: (_t: string, fn: any) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    };
    const opened: any[] = [];
    const view = { _openPalette: async (o: any) => { opened.push(o); } };
    const unbind = bindPaletteKey(view, doc);
    const again = bindPaletteKey(view, doc);
    assertEquals(listeners.length, 1, "a second call adds no second listener (it would toggle the palette shut again)");
    assert(unbind === again, "and hands back the same unbind");
    const chord = { key: "k", ctrlKey: true, target: { tagName: "BODY" }, defaultPrevented: false, preventDefault() {} };
    listeners[0](chord);
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(opened.length, 1, "the chord opened it through the view");
    // another view on the same document is its own binding
    const other = { _openPalette: async () => {} };
    bindPaletteKey(other, doc);
    assertEquals(listeners.length, 2);
    unbind();
    assertEquals(listeners.length, 1);
    const rebound = bindPaletteKey(view, doc);
    assertEquals(listeners.length, 2, "after unbind it can be bound again");
    rebound();
});

Deno.test("isTextFieldTarget: a field that asks for the chord (the Ask input) is not a text field to it", () => {
    assertEquals(isTextFieldTarget({ target: { tagName: "INPUT", type: "text", dataset: { paletteKey: "ok" } } }), false);
    assertEquals(isTextFieldTarget({ target: { tagName: "INPUT", type: "text", dataset: {} } }), true);
    assertEquals(isTextFieldTarget({ target: { tagName: "TEXTAREA", dataset: { paletteKey: "no" } } }), true, "only 'ok' opts out");
});

// ---- which UI ----

Deno.test("uiMode: the bar needs the server, and ?ui=classic keeps the old hamburger", () => {
    assertEquals(uiMode({ backend: true, search: "" }), "bar");
    assertEquals(uiMode({ backend: true, search: "?cid=zb2rh" }), "bar");
    assertEquals(uiMode({ backend: true, search: "?ui=classic" }), "classic");
    assertEquals(uiMode({ backend: true, search: "?data=%7B%7D&ui=classic" }), "classic");
    assertEquals(uiMode({ backend: true, search: "?ui=bar" }), "bar");
    assertEquals(uiMode({ backend: true, search: "?ui=" }), "bar");
    assertEquals(uiMode({ backend: true, search: "?ui=CLASSIC" }), "bar", "exact, so a typo is not a mode");
    // a standalone component (no data-backend, e.g. a page that vendors petri-view.js) is classic whatever the URL says
    assertEquals(uiMode({ backend: false, search: "" }), "classic");
    assertEquals(uiMode({ backend: false, search: "?ui=bar" }), "classic");
    assertEquals(uiMode({}), "classic");
    assertEquals(uiMode({ backend: true, search: undefined as any }), "bar");
});

Deno.test("classicHref: sets ui=classic and keeps the model and the hash", () => {
    assertEquals(classicHref("https://pflow.xyz/"), "https://pflow.xyz/?ui=classic");
    assertEquals(classicHref("https://pflow.xyz/?cid=zb2rh#view=abc"), "https://pflow.xyz/?cid=zb2rh&ui=classic#view=abc");
    assertEquals(classicHref("https://pflow.xyz/?ui=bar&data=%7B%7D"), "https://pflow.xyz/?ui=classic&data=%7B%7D");
    assertEquals(new URL(classicHref("https://pflow.xyz/?data=%7B%22a%22%3A1%7D")).searchParams.get("data"), '{"a":1}');
    assertEquals(classicHref("not a url"), "not a url", "an unreadable address is left alone");
});

// ---- the menus ----

const ids = (entries: any[]) => entries.filter((e) => e.id).map((e) => e.id);
const labels = (entries: any[]) => entries.filter((e) => e.label).map((e) => e.label);
const SIGNED_OUT = { authenticated: false, user: null, filesEnabled: false, backend: true, version: "1.2.3" };
const SIGNED_IN = { authenticated: true, user: { email: "me@example.com" }, filesEnabled: true, backend: true, version: "1.2.3" };

Deno.test("menuModel: signed out, no server files", () => {
    const m = menuModel(SIGNED_OUT);
    assertEquals(ids(m.file), ["save", "delete", "download", "login"]);
    assertEquals(labels(m.file), ["Save Permalink", "Delete", "Download JSON", "Login with GitHub"]);
    assertEquals(ids(m.view), ["layout", "display", "json-editor", "app", "compose"]);
    assertEquals(labels(m.view), ["Layout Algorithms", "Display Settings", "Toggle JSON editor", "Open as app", "Compose"]);
    assertEquals(ids(m.help), ["help", "sim", "book", "native", "github", "classic", "version"]);
    assertEquals(labels(m.help), ["Help", "Sim — Run & Check", "Book", "Native App", "GitHub", "Classic menu (this release)", "v1.2.3"]);
    assertEquals(m.file.some((e: any) => e.kind === "info"), false, "no account line when nobody is signed in");
});

Deno.test("menuModel: signed in, with server files", () => {
    const m = menuModel(SIGNED_IN);
    assertEquals(ids(m.file), ["save", "delete", "account-save", "account-open", "share", "gist", "diagrams", "details", "download", "logout"]);
    assertEquals(labels(m.file), [
        "Save to Server", "Delete", "Save to my account…", "Open from my account…", "Share", "Save As Gist", "My Diagrams", "Edit Details",
        "Download JSON", "Logout",
    ]);
    const info = m.file.find((e: any) => e.kind === "info");
    assertEquals(info.text, "Logged in as: me@example.com");
    // the user line comes after the separator and before Logout, as in the hamburger
    const kinds = m.file.map((e: any) => e.kind);
    assertEquals(kinds.slice(-3), ["separator", "info", "item"]);
});

Deno.test("menuModel: every condition of the old hamburger, one at a time", () => {
    const only = (o: any) => menuModel({ ...SIGNED_OUT, ...o });
    // /api/files/status
    assertEquals(ids(only({ filesEnabled: true }).file).includes("account-save"), true);
    assertEquals(ids(only({ filesEnabled: true }).file).includes("account-open"), true);
    assertEquals(ids(only({ filesEnabled: false }).file).includes("account-save"), false);
    // signed in: Share, Save As Gist, My Diagrams, Edit Details, and the Save entry's wording
    for (const id of ["share", "gist", "diagrams", "details"]) {
        assertEquals(ids(only({ authenticated: false }).file).includes(id), false, `${id} signed out`);
        assertEquals(ids(only({ authenticated: true, user: {} }).file).includes(id), true, `${id} signed in`);
    }
    assertEquals(labels(only({ authenticated: true, user: {} }).file)[0], "Save to Server");
    assertEquals(labels(only({ authenticated: false }).file)[0], "Save Permalink");
    // signed in and signed out each have exactly one of Login and Logout
    assertEquals(ids(only({ authenticated: true, user: {} }).file).filter((i) => i === "login" || i === "logout"), ["logout"]);
    assertEquals(ids(only({ authenticated: false }).file).filter((i) => i === "login" || i === "logout"), ["login"]);
    // the files do not depend on the account, nor the account on the files
    assertEquals(ids(only({ authenticated: true, user: {}, filesEnabled: false }).file).includes("account-save"), false);
    assertEquals(ids(only({ authenticated: false, filesEnabled: true }).file).includes("share"), false);
    // no version, no footer link
    assertEquals(ids(only({ version: "" }).help).includes("version"), false);
});

Deno.test("menuModel: the user line is the email, else the user name, else User", () => {
    assertEquals(userLine({ email: "a@b.c", user_metadata: { user_name: "abc" } }), "a@b.c");
    assertEquals(userLine({ email: "", user_metadata: { user_name: "abc" } }), "abc");
    assertEquals(userLine({ user_metadata: {} }), "User");
    assertEquals(userLine(null), "User");
    assertEquals(menuModel({ ...SIGNED_IN, user: { user_metadata: { user_name: "octocat" } } }).file.find((e: any) => e.kind === "info").text, "Logged in as: octocat");
});

Deno.test("menuModel: a standalone component's contract has no account, no server files, no Compose and no way back", () => {
    const m = menuModel({ backend: false, authenticated: true, user: { email: "x@y" }, filesEnabled: true, version: "1.2.3" });
    assertEquals(ids(m.file), ["download"]);
    assertEquals(ids(m.view), ["layout", "display", "json-editor", "app"]);
    assertEquals(ids(m.help), ["help", "sim", "book", "native", "github", "version"]);
    assertEquals(menuModel().file.map((e: any) => e.id), ["download"]);
});

Deno.test("menuModel: links carry their address, the classic link is an action, the version links to its release", () => {
    const m = menuModel(SIGNED_OUT);
    const by = (list: any[], id: string) => list.find((e: any) => e.id === id);
    assertEquals(by(m.help, "sim").href, "https://sim.pflow.xyz");
    assertEquals(by(m.help, "book").href, "https://book.pflow.xyz");
    assertEquals(by(m.help, "native").href, "https://github.com/pflow-xyz/pflow-native");
    assertEquals(by(m.help, "github").href, "https://github.com/pflow-xyz/pflow-xyz");
    assertEquals(by(m.help, "version").href, releaseHref("1.2.3"));
    assertEquals(releaseHref("1.2.3"), "https://github.com/pflow-xyz/pflow-xyz/releases/tag/v1.2.3");
    assertEquals(by(m.view, "compose").href, "/compose.html");
    assertEquals(by(m.help, "classic").kind, "item", "an action, not a link: it reloads with ?ui=classic");
    for (const list of [m.file, m.view, m.help]) {
        for (const e of list) {
            if (e.kind === "link") assert(typeof e.href === "string" && e.href, e.id);
            if (e.kind === "item" || e.kind === "link") assert(e.label && e.id, JSON.stringify(e));
        }
    }
});

Deno.test("menuModel: the Classic menu link is in Help and nowhere else", () => {
    const m = menuModel(SIGNED_IN);
    for (const name of ["file", "view"] as const) assert(!ids(m[name]).includes("classic"), name);
    assertEquals(ids(m.help).filter((i) => i === "classic").length, 1);
});

Deno.test("menuModel: none of the removed entries is a menu entry any more", () => {
    const all = [SIGNED_OUT, SIGNED_IN].flatMap((o) => { const m = menuModel(o); return [...m.file, ...m.view, ...m.help]; });
    const text = all.map((e: any) => `${e.label || ""} ${e.text || ""}`).join(" | ");
    for (const gone of ["Describe a process", "Draft notes", "Assistant", "Analysis", "Simulate", "Structure", "Components", "Results", "What do you want to know", "Check net"]) {
        assert(!text.includes(gone), `${gone} is not a menu entry`);
    }
    // 25 entries in one panel became three menus: none of them is a long list
    for (const o of [SIGNED_OUT, SIGNED_IN]) for (const list of Object.values(menuModel(o))) assert((list as any[]).length <= 12, `${(list as any[]).length} rows`);
});

Deno.test("every action a menu entry runs is one the bar can run, and the view has the method", async () => {
    const entries = [SIGNED_OUT, SIGNED_IN, { ...SIGNED_IN, filesEnabled: false }].flatMap((o) => { const m = menuModel(o); return [...m.file, ...m.view, ...m.help]; });
    const items = new Set(entries.filter((e: any) => e.kind === "item").map((e: any) => e.id));
    for (const id of items) assert(ACTION_IDS.includes(id as string), `${id} has no action in petri-menu-ui.js`);
    for (const id of ACTION_IDS) assert(items.has(id), `${id} is an action no menu entry names`);
    const view = await Deno.readTextFile(new URL("./petri-view.js", import.meta.url));
    for (const [id, method] of Object.entries(METHOD_OF)) {
        assert(new RegExp(`^\\s+(async\\s+)?${method}\\(`, "m").test(view), `${id}: petri-view.js has no ${method}()`);
    }
    // the bar's three ways to reach the Ask pane, the palette and the problems chip exist on the view too
    for (const method of ["_openChat", "_openPalette", "_openPaletteFor", "_showProblems", "_problemsGate", "_mountProblems", "_uiMode", "_createAppBar"]) {
        assert(new RegExp(`^\\s+(async\\s+)?${method}\\(`, "m").test(view), `petri-view.js has no ${method}()`);
    }
});

// The browser holds these (scripts/menu-smoke.ts: "reaching the bar...", "a menu that is open when..."); `make test-js` does
// not run a browser, so the three one-line causes of the three regressions the review found are held here too.
Deno.test("the bar's source: first in the root, a click reads the live list, the JSON editor starts below the bar", async () => {
    const ui = await Deno.readTextFile(new URL("./petri-menu-ui.js", import.meta.url));
    assert(/view\._root\.prepend\(bar\)/.test(ui), "the bar is prepended to the root: Tab reaches it before Ace, which keeps Tab for indenting");
    assert(!/_root\.appendChild\(bar\)/.test(ui), "and is not appended after the JSON editor");
    assert(/const entry = openMenu\?\.entries\.find\(/.test(ui), "a click on a row looks it up in the open menu's current entries, which refresh() replaces");
    assert(/askTaken\(/.test(ui), "the Ask input lets go of the words only when askTaken says the pane has them");
    const css = await Deno.readTextFile(new URL("./petri-view.css", import.meta.url));
    const rule = css.match(/petri-view\[data-ui="bar"\] \.pv-root\.pv-layout-horizontal \.pv-json-editor\s*\{([^}]*)\}/);
    assert(rule, "side by side, the bar's JSON editor has a rule of its own");
    assert(/padding-top:\s*(5[0-9]|[6-9][0-9])px/.test(rule![1]), "that clears the bar (10px + 40px): the editor's toolbar is not under it");
});

Deno.test("flattenMenus: the three menus as one list under headings, in order", () => {
    const m = menuModel(SIGNED_IN);
    const flat = flattenMenus(m);
    const heads = flat.filter((e: any) => e.kind === "heading").map((e: any) => e.label);
    assertEquals(heads, ["File", "View", "Help"]);
    assertEquals(MENU_ORDER, ["file", "view", "help"]);
    assertEquals(flat.length, m.file.length + m.view.length + m.help.length + 3);
    assertEquals(flat[0], { kind: "heading", label: "File" });
    assertEquals(ids(flat), [...ids(m.file), ...ids(m.view), ...ids(m.help)]);
    assertEquals(flattenMenus({ file: [], view: [], help: [] } as any), []);
    assertEquals(flattenMenus(null as any), []);
});

// ---- the Ask input ----

Deno.test("askSubmit: the words go to the Ask pane with the intent left to the server; empty words still open it", () => {
    assertEquals(askSubmit("  can it get stuck?  "), { mode: "auto", message: "can it get stuck?" });
    assertEquals(askSubmit(""), { mode: "auto" });
    assertEquals(askSubmit("   "), { mode: "auto" });
    assertEquals(askSubmit(undefined), { mode: "auto" });
    assertEquals(askSubmit(42 as any), { mode: "auto" });
    assertEquals(askSubmit("a\nb"), { mode: "auto", message: "a\nb" });
    assertEquals(ASK_PLACEHOLDER, "Ask about this net, or say what to change...");
});

Deno.test("askTaken: the input lets go of the words only when the person can send them from the pane", () => {
    assertEquals(askTaken({ enabled: true, chat: true, signed_in: true, allowed: true }), true);
    // signed out: the pane shows the sign-in note and hides its form, so the words would be out of sight
    assertEquals(askTaken({ enabled: true, chat: true, signed_in: false }), false);
    // a server with no chat, or with the assistant off, has no form to send from
    assertEquals(askTaken({ enabled: true, chat: false, signed_in: true }), false);
    assertEquals(askTaken({ enabled: false, chat: true, signed_in: true }), false);
    assertEquals(askTaken({ enabled: false }), false);
    // not knowing is not a yes: the words stay where the person can read them
    for (const unknown of [undefined, null, {}, "ok", 1, []]) assertEquals(askTaken(unknown as any), false, JSON.stringify(unknown));
});

// ---- a menu's keyboard ----

Deno.test("menuStep: arrows wrap, Home and End go to the ends, rows that cannot take focus are skipped", () => {
    const all = [true, true, true];
    assertEquals(menuStep(all, 0, "ArrowDown"), 1);
    assertEquals(menuStep(all, 2, "ArrowDown"), 0, "wraps down");
    assertEquals(menuStep(all, 0, "ArrowUp"), 2, "wraps up");
    assertEquals(menuStep(all, -1, "ArrowDown"), 0, "from nothing, down is the first");
    assertEquals(menuStep(all, -1, "ArrowUp"), 2, "from nothing, up is the last");
    assertEquals(menuStep(all, 1, "Home"), 0);
    assertEquals(menuStep(all, 1, "End"), 2);
    assertEquals(menuStep(all, 1, "PageDown"), 1, "another key moves nothing");
    const gaps = [false, true, false, true, false];
    assertEquals(menuStep(gaps, -1, "ArrowDown"), 1);
    assertEquals(menuStep(gaps, 1, "ArrowDown"), 3);
    assertEquals(menuStep(gaps, 3, "ArrowDown"), 1, "past the last it wraps over the gaps");
    assertEquals(menuStep(gaps, 1, "ArrowUp"), 3);
    assertEquals(menuStep(gaps, 0, "Home"), 1);
    assertEquals(menuStep(gaps, 0, "End"), 3);
    assertEquals(menuStep([false, false], 0, "ArrowDown"), -1, "nothing can take focus");
    assertEquals(menuStep([], -1, "ArrowDown"), -1);
    assertEquals(menuStep([true], 0, "ArrowDown"), 0);
    assertEquals(menuStep([true], 0, "ArrowUp"), 0);
});

Deno.test("typeahead: the next row whose label starts with the letter, wrapping, case-insensitive", () => {
    const rows = [{ label: "Save Permalink", focusable: true }, { label: "Delete", focusable: true }, { label: "Download JSON", focusable: true }, { label: "Login with GitHub", focusable: true }];
    assertEquals(typeahead(rows, 0, "d"), 1);
    assertEquals(typeahead(rows, 1, "d"), 2, "again: the next one");
    assertEquals(typeahead(rows, 2, "D"), 1, "wraps, any case");
    assertEquals(typeahead(rows, 0, "s"), 0, "only itself: stays");
    assertEquals(typeahead(rows, 0, "z"), -1);
    assertEquals(typeahead(rows, 0, "ab"), -1, "one character at a time");
    assertEquals(typeahead(rows, 0, ""), -1);
    assertEquals(typeahead([], -1, "a"), -1);
    assertEquals(typeahead([{ label: "Delete", focusable: false }], -1, "d"), -1);
    assertEquals(typeahead([{ label: "  Delete" , focusable: true }], -1, "d"), 0, "leading space is not part of a label");
});

Deno.test("triggerKey and isFocusable", () => {
    assertEquals(triggerKey("ArrowDown"), "first");
    assertEquals(triggerKey("Enter"), "first");
    assertEquals(triggerKey(" "), "first");
    assertEquals(triggerKey("ArrowUp"), "last");
    assertEquals(triggerKey("a"), null);
    assertEquals(triggerKey("Escape"), null);
    assertEquals([{ kind: "item" }, { kind: "link" }, { kind: "info" }, { kind: "separator" }, { kind: "heading" }, null].map(isFocusable), [true, true, false, false, false, false]);
});
