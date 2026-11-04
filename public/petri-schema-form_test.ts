import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    formModel, goalFormModel, noFormReason, readForm, readValues, renderFormHtml, showFormErrors,
} from "./petri-schema-form.js";
import { Registry, createHeadlessHost, checkArgs } from "./petri-commands.js";

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const specs: any[] = new Registry(createHeadlessHost()).list();
const spec = (id: string) => specs.find((s) => s.id === id)!;
const field = (model: any, name: string) => model.fields.find((f: any) => f.name === name);

// ---- formModel on real command schemas ----

Deno.test("formModel: numbers carry their min and max, integers are told apart, required fields come first", () => {
    const m = formModel(spec("sim.ssa").args);
    assertEquals(m.noForm, null);
    assertEquals(m.fields.map((f: any) => f.name), ["t_end", "seed", "runs", "points", "places"]);
    const runs = field(m, "runs");
    assertEquals([runs.kind, runs.min, runs.max, runs.required], ["integer", 1, 200, false]);
    const tEnd = field(m, "t_end");
    assertEquals([tEnd.kind, tEnd.min, tEnd.max], ["number", 1e-9, 10000]);
    assert(tEnd.help.length > 0, "the schema's description is the help");

    const scan = formModel(spec("opt.rate_scan").args);
    assertEquals(scan.fields.slice(0, 3).map((f: any) => f.name), ["transition", "from", "to"]);
    assert(scan.fields.slice(0, 3).every((f: any) => f.required));
    assert(scan.fields.slice(3).every((f: any) => !f.required));
});

Deno.test("formModel: an enum is a select, a free-form object argument is JSON text", () => {
    const m = formModel(spec("export.artifact").args);
    const format = field(m, "format");
    assertEquals([format.kind, format.enum], ["enum", ["csv", "json"]]);
    assertEquals(field(m, "id").required, true);

    const sc = formModel(spec("sim.scenario").args);
    assertEquals(field(sc, "scenario").kind, "json");
    assertEquals(field(sc, "scenario").required, true);
    // a union of integer and array (the per-colour count) is JSON text too
    const place = formModel(spec("net.add_place").args);
    assertEquals(field(place, "initial").kind, "json");
    assertEquals(field(place, "capacity").kind, "json");
    assertEquals(field(place, "x").kind, "number");
    // an array of strings keeps its item type
    const ode = formModel(spec("sim.ode").args);
    assertEquals([field(ode, "places").kind, field(ode, "places").itemType], ["json", "string"]);
});

Deno.test("formModel: place and transition arguments are inferred from the description or name, nothing else is", () => {
    const inferred: Record<string, string> = {};
    for (const s of specs) {
        for (const f of formModel(s.args).fields) if (f.kind === "place" || f.kind === "transition") inferred[`${s.id}.${f.name}`] = f.kind;
    }
    // pinned: a new command that says "place id" shows up here on purpose
    assertEquals(inferred, {
        "net.set_place.id": "place", "net.add_tokens.id": "place",
        "sim.fire.id": "transition", "sim.set_rate.id": "transition",
        "opt.rate_scan.transition": "transition", "opt.sweep.transition": "transition", "opt.sweep.place": "place",
        "sim.what_if.place": "place", "analysis.diagnose_ssa.observable": "place", "analysis.diagnose.observable": "place",
        "opt.heatmap.param_x": "transition", "opt.heatmap.param_y": "transition", "opt.heatmap.observable": "place",
    });
    // a new id, a role name and an either-or id are strings
    assertEquals(field(formModel(spec("net.add_place").args), "id").kind, "string");
    assertEquals(field(formModel(spec("sim.evaluate").args), "player").kind, "string");
    assertEquals(field(formModel(spec("note.add").args), "node").kind, "string");
    assertEquals(field(formModel(spec("net.move").args), "id").kind, "string");
});

Deno.test("formModel: defaults prefill, and a schema with its own default or title is honoured", () => {
    const m = formModel({ type: "object", properties: { n: { type: "integer", default: 3, title: "How many" }, s: { type: "string" } }, required: [] }, { s: "x" });
    assertEquals(field(m, "n").default, 3);
    assertEquals(field(m, "n").label, "How many");
    assertEquals(field(m, "s").default, "x");
    // defaults beat the schema's own
    assertEquals(field(formModel({ type: "object", properties: { n: { type: "integer", default: 3 } } }, { n: 9 }), "n").default, 9);
    // text to write is multiline, an id is not
    const w = formModel(spec("file.write").args);
    assertEquals([field(w, "content").multiline, field(w, "name").multiline], [true, undefined]);
});

Deno.test("noFormReason: the shapes a form cannot be made for say why", () => {
    assertEquals(noFormReason({ type: "object", properties: {}, required: [] }), null);
    assertEquals(noFormReason({ type: "object", properties: { a: {} }, required: ["a"] }), null);
    assert(noFormReason(undefined)!.includes("no argument schema"));
    assert(noFormReason(null)!.includes("no argument schema"));
    assert(noFormReason({ type: "array" })!.includes("not an object"));
    assert(noFormReason({ type: "object", oneOf: [{}] })!.includes("oneOf"));
    assert(noFormReason({ type: "object", properties: [] })!.includes("named arguments"));
    assert(noFormReason({ type: "object", properties: { a: 3 } })!.includes('"a"'));
    assert(noFormReason({ type: "object", properties: {}, required: ["z"] })!.includes('"z"'));
    assert(noFormReason({ type: "object", properties: {}, required: "z" })!.includes("required"));
    const none = formModel(undefined as any);
    assertEquals(none.fields, []);
    assert(none.noForm);
    assert(renderFormHtml(none).includes(none.noForm!), "the reason is what the form shows");
});

// ---- readValues ----

const ssa = formModel(spec("sim.ssa").args);

Deno.test("readValues: numbers are parsed and range-checked, empty optional fields are dropped", () => {
    assertEquals(readValues(ssa, { t_end: "12.5", seed: "", runs: "20", points: "  ", places: "" }), { args: { t_end: 12.5, runs: 20 }, errors: [] });
    assertEquals(readValues(ssa, {}).args, {});
    // exponent notation, a number that is already a number
    assertEquals(readValues(ssa, { t_end: "1e3", runs: 7 }).args, { t_end: 1000, runs: 7 });

    const bad = readValues(ssa, { t_end: "abc", runs: "500", seed: "-1", points: "1.5" });
    assertEquals(bad.args, {});
    assertEquals(bad.errors.map((e) => e.name).sort(), ["points", "runs", "seed", "t_end"]);
    const msg = (n: string) => bad.errors.find((e) => e.name === n)!.message;
    assert(msg("t_end").includes("enter a number"), msg("t_end"));
    assert(msg("runs").includes("at most 200"), msg("runs"));
    assert(msg("seed").includes("at least 0"), msg("seed"));
    assert(msg("points").includes("whole number"), msg("points"));
    // the lower bound is inclusive and the upper one too
    assertEquals(readValues(ssa, { runs: "1" }).errors, []);
    assertEquals(readValues(ssa, { runs: "200" }).errors, []);
    assertEquals(readValues(ssa, { runs: "201" }).errors.length, 1);
    // not a number the checker could swallow
    for (const t of ["0x10", "Infinity", "NaN", "1,5", "--1", "1 2"]) assertEquals(readValues(ssa, { t_end: t }).errors.length, 1, t);
});

Deno.test("readValues: a required field that is empty is reported, once, by name", () => {
    const scan = formModel(spec("opt.rate_scan").args);
    const r = readValues(scan, { transition: "", from: "0" });
    assertEquals(r.errors.map((e) => e.name), ["transition", "to"]);
    assert(r.errors.every((e) => e.message.endsWith(": required")));
    assertEquals(r.args, { from: 0 }, "what was valid is still returned");
    assertEquals(readValues(scan, { transition: " recover ", from: "0", to: "2" }), { args: { transition: "recover", from: 0, to: 2 }, errors: [] });
});

Deno.test("readValues: JSON is parsed with a readable error, bare words stay strings where a string is allowed", () => {
    const sc = formModel(spec("sim.scenario").args);
    assertEquals(readValues(sc, { scenario: '{"hours": 8, "seed": 1}' }).args, { scenario: { hours: 8, seed: 1 } });
    const bad = readValues(sc, { scenario: '{"hours": ' });
    assertEquals(bad.errors.length, 1);
    assert(bad.errors[0].message.startsWith("scenario: not valid JSON ("), bad.errors[0].message);
    // an untyped argument keeps a bare word as a string and a number as a number
    assertEquals(readValues(sc, { scenario: "demo" }).args, { scenario: "demo" });
    assertEquals(readValues(sc, { scenario: "3" }).args, { scenario: 3 });
    // but something that starts like JSON must be JSON
    assertEquals(readValues(sc, { scenario: "{hours: 8}" }).errors.length, 1);

    // a union of integer and array: "3" is 3, "[1, 2]" is a vector, a word is an error, null is allowed for capacity
    const place = formModel(spec("net.add_place").args);
    assertEquals(readValues(place, { x: "0", y: "0", initial: "3" }).args, { x: 0, y: 0, initial: 3 });
    assertEquals(readValues(place, { x: "0", y: "0", initial: "[1, 2]" }).args.initial, [1, 2]);
    assertEquals(readValues(place, { x: "0", y: "0", capacity: "null" }).args.capacity, null);
    const word = readValues(place, { x: "0", y: "0", initial: "three" });
    assert(word.errors[0].message.includes("not valid JSON"), word.errors[0].message);
    const wrong = readValues(place, { x: "0", y: "0", initial: '{"a": 1}' });
    assert(wrong.errors[0].message.includes("expected integer or array, got object"), wrong.errors[0].message);

    // a list of strings: JSON, or a plain list, items checked
    const ode = formModel(spec("sim.ode").args);
    assertEquals(readValues(ode, { places: '["S", "I"]' }).args.places, ["S", "I"]);
    assertEquals(readValues(ode, { places: "S, I  R" }).args.places, ["S", "I", "R"]);
    assert(readValues(ode, { places: "[1, 2]" }).errors[0].message.includes("item 1 must be a string"));
    assert(readValues(ode, { places: '{"a": 1}' }).errors[0].message.includes("expected array, got object"));
    // an object-or-string argument takes the JSON text as the string when it is not an object
    const load = formModel(spec("file.load_json").args);
    assertEquals(readValues(load, { json: '{"places": {}}' }).args.json, { places: {} });
    assert(readValues(load, { json: "[]" }).errors[0].message.includes("expected object or string, got array"));
});

Deno.test("readValues: enum, boolean, string and text arguments", () => {
    const ex = formModel(spec("export.artifact").args);
    assertEquals(readValues(ex, { id: "a1", format: "json" }).args, { id: "a1", format: "json" });
    assertEquals(readValues(ex, { id: "a1", format: "" }).args, { id: "a1" });
    assert(readValues(ex, { id: "a1", format: "xml" }).errors[0].message.includes("must be one of csv, json"));

    // an unticked box is dropped unless the field needs the false
    const save = formModel(spec("file.save").args);
    assertEquals(readValues(save, { name: "a.json", overwrite: false }).args, { name: "a.json" });
    assertEquals(readValues(save, { name: "a.json", overwrite: true }).args, { name: "a.json", overwrite: true });
    const on = formModel({ type: "object", properties: { strict: { type: "boolean" } } }, { strict: true });
    assertEquals(readValues(on, { strict: false }).args, { strict: false });
    const must = formModel({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
    assertEquals(readValues(must, { ok: false }).args, { ok: false });

    // ids are trimmed, text to write is kept as it is
    const w = formModel(spec("file.write").args);
    assertEquals(readValues(w, { name: " a.csv ", content: "a,b\n1,2\n" }).args, { name: "a.csv", content: "a,b\n1,2\n" });
    assertEquals(readValues(w, { name: "a.csv", content: "   " }).errors.length, 1, "whitespace is not content");
});

Deno.test("readValues: a name like __proto__ does not reach the prototype", () => {
    const m = formModel({ type: "object", properties: { ["__proto__"]: { type: "string" } } });
    const r = readValues(m, { ["__proto__"]: "x" });
    assertEquals(Object.getPrototypeOf(r.args), Object.prototype);
    assertEquals(Object.keys(r.args), ["__proto__"]);
});

// ---- goals ----

Deno.test("goalFormModel: every goal in the catalog has a form or says why not", () => {
    for (const g of catalog.goals) {
        const m = goalFormModel(g);
        if (g.available === false) {
            assertEquals(m.fields, []);
            assertEquals(m.noForm, g.caveat);
            continue;
        }
        assertEquals(m.noForm, null, g.id);
        assertEquals(m.fields.map((f: any) => f.name), (g.inputs || []).map((i: any) => i.name), g.id);
    }
});

Deno.test("goalFormModel: kinds, optional, default, label and example come across", () => {
    const goal = (id: string) => catalog.goals.find((g: any) => g.id === id);
    const knob = goalFormModel(goal("knob"));
    assertEquals([knob.fields[0].kind, knob.fields[0].required, knob.fields[0].label], ["place", false, "the outcome to watch"]);
    const best = goalFormModel(goal("best_setting"));
    assertEquals(best.fields.map((f: any) => [f.name, f.kind, f.required, f.default]), [["transition", "transition", true, undefined], ["max_rate", "number", false, 2]]);
    const reach = goalFormModel(goal("can_happen"));
    assertEquals([reach.fields[0].kind, reach.fields[0].required], ["marking", true]);
    const play = goalFormModel(goal("best_play"));
    const by = (n: string) => play.fields.find((f: any) => f.name === n);
    assertEquals([by("sides").kind, by("sides").types, by("auto").types], ["json", ["object"], ["array"]]);
    assert(by("sides").example.includes("x_"));
    assertEquals(goalFormModel(goal("stuck")), { fields: [], noForm: null });
    // an input kind the form does not know is text
    assertEquals(goalFormModel({ inputs: [{ name: "q", kind: "other" }] }).fields[0].kind, "string");
});

Deno.test("goalFormModel + readValues: the inputs runGoal wants", () => {
    const goal = (id: string) => catalog.goals.find((g: any) => g.id === id);
    const best = goalFormModel(goal("best_setting"));
    assertEquals(readValues(best, { transition: "recover", max_rate: "" }).args, { transition: "recover" }, "a blank default is left to runGoal");
    assertEquals(readValues(best, { transition: "recover", max_rate: "1.5" }).args, { transition: "recover", max_rate: 1.5 });
    assertEquals(readValues(best, {}).errors.map((e) => e.name), ["transition"]);

    const reach = goalFormModel(goal("can_happen"));
    assertEquals(readValues(reach, { to: { S: "0", I: "", R: "10" } }), { args: { to: { S: 0, R: 10 } }, errors: [] });
    assertEquals(readValues(reach, { to: { S: "", R: "" } }).errors.map((e) => e.name), ["to"], "an empty required marking is reported");
    assertEquals(readValues(reach, { to: '{"R": 10}' }).args, { to: { R: 10 } }, "the text box form");
    assert(readValues(reach, { to: { R: "-1" } }).errors[0].message.includes("whole number"));
    assert(readValues(reach, { to: { R: "1.5" } }).errors[0].message.includes("whole number"));
    assert(readValues(reach, { to: "[1]" }).errors[0].message.includes("expected {place: count}"));
    assertEquals(readValues(reach, { to: { R: [1, null] } }).args, { to: { R: [1, null] } });

    const play = goalFormModel(goal("best_play"));
    const ok = readValues(play, { sides: '{"x_": 1, "o_": -1}', reward: '{"win_x": 1}', auto: '["x_win_"]' });
    assertEquals(ok.errors, []);
    assertEquals(ok.args.sides, { x_: 1, o_: -1 });
    assertEquals(readValues(play, { sides: "[1]", reward: "{}", auto: "x_win_" }).errors.map((e) => e.name), ["sides"], "a bare word is no object, but the auto list takes a plain list");
    assertEquals(readValues(play, { sides: "{}", reward: "{}", auto: "x_win_, o_win_" }).args.auto, ["x_win_", "o_win_"]);
});

// ---- markup ----

const controls = (html: string) => [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, a: string) => new RegExp(`\\b${a}="([^"]*)"`).exec(tag)?.[1];

Deno.test("renderFormHtml: every control is labelled, described and marked required where it is", () => {
    const model = formModel(spec("opt.rate_scan").args);
    const html = renderFormHtml(model, { places: ["S", "I"], transitions: ["infect", "recover"] });
    const forIds = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
    const tags = controls(html);
    assertEquals(tags.length, model.fields.length);
    for (const t of tags) {
        assert(forIds.has(attr(t, "id")!), `no <label for> for ${t}`);
        assert(attr(t, "aria-describedby")!.split(" ").every((id) => html.includes(`id="${id}"`)), t);
        assert(attr(t, "data-field"));
    }
    // required controls say so, optional ones do not
    for (const f of model.fields) {
        const t = tags.find((x) => attr(x, "data-field") === f.name)!;
        assertEquals(t.includes('aria-required="true"'), f.required, f.name);
    }
    assert(html.includes('<span class="pv-form-req" aria-hidden="true"> *</span>'));
    assert(html.includes("required</p>"), "the key to the mark");
    // the transition is a select of the net's transitions with a blank first
    assert(html.includes('<option value="">(choose)</option><option value="infect">infect</option><option value="recover">recover</option>'));
    // numbers are text with a keypad hint, not type=number (what was typed is kept)
    assert(html.includes('inputmode="decimal"'));
    assert(!html.includes('type="number"'));
    // the range reads out
    assert(renderFormHtml(ssa).includes("at least 1, at most 200"));
});

Deno.test("renderFormHtml: place and transition are text boxes when the net's ids are not offered", () => {
    const html = renderFormHtml(formModel(spec("sim.what_if").args));
    assert(!html.includes("<select"));
    assert(html.includes('type="text"'));
    assert(renderFormHtml(formModel(spec("sim.what_if").args), { places: ["S"] }).includes("<select"));
});

Deno.test("renderFormHtml: enums, checkboxes, JSON text, a marking grid and a marking box", () => {
    const ex = renderFormHtml(formModel(spec("export.artifact").args));
    assert(ex.includes('<option value="csv">csv</option>'));
    assert(ex.includes('<option value="">(default)</option>'));
    const save = renderFormHtml(formModel(spec("file.save").args));
    assert(save.includes('type="checkbox"'));
    assert(/<input type="checkbox"[^>]*id="(pv-f-\d)"[^>]*> <label class="pv-form-label" for="\1">overwrite/.test(save), save);
    const sc = renderFormHtml(formModel(spec("sim.scenario").args));
    assert(sc.includes("<textarea"));
    const reach = goalFormModel(catalog.goals.find((g: any) => g.id === "can_happen"));
    const grid = renderFormHtml(reach, { places: ["S", "R"] });
    assert(grid.includes("<fieldset"));
    assertEquals([...grid.matchAll(/data-mark="([^"]+)"/g)].map((m) => m[1]), ["S", "R"]);
    assert(grid.includes("<legend"));
    const box = renderFormHtml(reach);
    assert(!box.includes("<fieldset") && box.includes("<textarea"));
    // placeholders: a goal's example, an array of strings
    const play = renderFormHtml(goalFormModel(catalog.goals.find((g: any) => g.id === "best_play")));
    assert(play.includes("placeholder=\"{&quot;x_&quot;: 1, &quot;o_&quot;: -1}\""), play);
    assert(renderFormHtml(formModel(spec("sim.ode").args)).includes("placeholder=\"[&quot;a&quot;, &quot;b&quot;]  or  a, b\""));
});

Deno.test("renderFormHtml: defaults prefill, and the HTML is escaped", () => {
    const best = renderFormHtml(goalFormModel(catalog.goals.find((g: any) => g.id === "best_setting")), { transitions: ["recover"] });
    assert(best.includes('value="2"'), "max_rate defaults to 2");
    const evil = renderFormHtml(formModel({ type: "object", properties: { "a\"><script>": { type: "string", description: "<img src=x onerror=1>", default: "\"x\"" } } }));
    assert(!evil.includes("<script>") && !evil.includes("<img"));
    assert(evil.includes("&lt;img"));
    assert(evil.includes("&quot;x&quot;"));
    // a caller's own esc is used
    assert(renderFormHtml(formModel({ type: "object", properties: { a: { type: "string" } } }), { esc: (s: any) => `<<${s}>>` }).includes("<<a>>"));
});

Deno.test("renderFormHtml: many optional arguments fold into a details, few do not", () => {
    const fit = renderFormHtml(formModel(spec("opt.fit").args));
    assert(fit.includes('<details class="pv-form-more">'), "closed: something is required");
    assert(fit.includes("Optional ("));
    const scan = renderFormHtml(formModel(spec("sim.ssa").args));
    assert(scan.includes("<details class=\"pv-form-more\" open>"), "open: nothing is required");
    assert(!renderFormHtml(formModel(spec("sim.what_if").args)).includes("<details"));
    // the controls inside a details are still found
    assertEquals(controls(fit).length, spec("opt.fit").args.properties ? Object.keys(spec("opt.fit").args.properties).length : 0);
    // two forms on one page do not share ids
    const a = renderFormHtml(ssa, { idPrefix: "a" });
    const b = renderFormHtml(ssa, { idPrefix: "b" });
    const ids = (h: string) => controls(h).map((t) => attr(t, "id"));
    assert(ids(a).every((i) => !ids(b).includes(i)));
});

// ---- readForm / showFormErrors on a minimal DOM stand-in ----

type Fake = { dataset: Record<string, string>; type?: string; value?: string; checked?: boolean; hidden?: boolean; textContent?: string; attrs: Record<string, string>; setAttribute(k: string, v: string): void; removeAttribute(k: string): void };
const fake = (dataset: Record<string, string>, extra: Partial<Fake> = {}): Fake => ({
    dataset, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, ...extra,
});
const root = (els: Fake[]) => ({ querySelectorAll: (sel: string) => els.filter((e) => (sel === "[data-field]" ? "field" in e.dataset : "errFor" in e.dataset)) });

Deno.test("readForm: collects text, checkboxes and marking cells off the controls", () => {
    const model = {
        fields: [
            { name: "t_end", label: "t_end", kind: "number", required: true },
            { name: "overwrite", label: "overwrite", kind: "boolean", required: false },
            { name: "to", label: "to", kind: "marking", required: true },
        ],
    };
    const els = [
        fake({ field: "t_end" }, { type: "text", value: "20" }),
        fake({ field: "overwrite" }, { type: "checkbox", checked: true }),
        fake({ field: "to", mark: "S" }, { type: "text", value: "" }),
        fake({ field: "to", mark: "R" }, { type: "text", value: "10" }),
    ];
    assertEquals(readForm(root(els), model), { args: { t_end: 20, overwrite: true, to: { R: 10 } }, errors: [] });
    els[0].value = "x";
    assertEquals(readForm(root(els), model).errors.map((e) => e.name), ["t_end"]);
});

Deno.test("showFormErrors: shows each message by its field and clears the others", () => {
    const e1 = fake({ errFor: "a" }, { hidden: true, textContent: "" });
    const e2 = fake({ errFor: "b" }, { hidden: false, textContent: "old" });
    const c1 = fake({ field: "a" });
    const c2 = fake({ field: "b" }, {});
    c2.attrs["aria-invalid"] = "true";
    const r = root([e1, e2, c1, c2]);
    showFormErrors(r, [{ name: "a", message: "a: required" }]);
    assertEquals([e1.hidden, e1.textContent, e2.hidden, e2.textContent], [false, "a: required", true, ""]);
    assertEquals([c1.attrs["aria-invalid"], c2.attrs["aria-invalid"]], ["true", undefined]);
});

// ---- the whole registry ----

Deno.test("registry sweep: every command has a form or an explicit reason", () => {
    let withForm = 0;
    let withReason = 0;
    for (const s of specs) {
        const model = formModel(s.args);
        const reason = noFormReason(s.args);
        assertEquals(model.noForm, reason, s.id);
        if (reason) {
            withReason++;
            assert(typeof reason === "string" && reason.length > 0, s.id);
            assertEquals(model.fields, [], s.id);
        } else {
            withForm++;
            // one field per declared argument, none lost
            assertEquals(model.fields.map((f: any) => f.name).sort(), Object.keys(s.args.properties || {}).sort(), s.id);
            assertEquals(model.fields.filter((f: any) => f.required).map((f: any) => f.name).sort(), [...(s.args.required || [])].sort(), s.id);
        }
        // and the markup draws without throwing, one labelled control per field
        const html = renderFormHtml(model, { places: ["p0", "p1"], transitions: ["t0"] });
        if (!reason) {
            assertEquals(controls(html).length, model.fields.length, s.id);
            const forIds = new Set([...html.matchAll(/<label[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
            for (const t of controls(html)) assert(forIds.has(attr(t, "id")!), `${s.id}: unlabelled ${t}`);
        }
    }
    assertEquals(withForm + withReason, specs.length);
    assert(specs.length >= 130, `the sweep saw ${specs.length} commands`);
});

// Sample text for a field: what a person would type to get a valid value.
function sample(f: any): any {
    switch (f.kind) {
    case "number": case "integer": return String(Math.min(f.max ?? Infinity, Math.max(f.min ?? 1, 1)));
    case "boolean": return true;
    case "enum": return String(f.enum[0]);
    case "json": {
        const t = f.types || [];
        if (t.includes("integer")) return "1";
        if (t.includes("array")) return f.itemType === "string" ? "a, b" : "[]";
        if (t.includes("object")) return "{}";
        return "{}";
    }
    default: return "x";
    }
}

Deno.test("registry sweep: what a form reads back is accepted by the registry's own argument check", () => {
    for (const s of specs) {
        const model = formModel(s.args);
        if (model.noForm) continue;
        // every field filled with a sample value
        const raw = Object.fromEntries(model.fields.map((f: any) => [f.name, sample(f)]));
        const all = readValues(model, raw);
        assertEquals(all.errors, [], s.id);
        checkArgs(s, all.args);
        // and only the required ones
        const need = Object.fromEntries(model.fields.filter((f: any) => f.required).map((f: any) => [f.name, sample(f)]));
        const some = readValues(model, need);
        assertEquals(some.errors, [], s.id);
        checkArgs(s, some.args);
        // and nothing at all: exactly the required fields are reported
        const none = readValues(model, {});
        assertEquals(none.errors.map((e) => e.name).sort(), model.fields.filter((f: any) => f.required && f.kind !== "boolean").map((f: any) => f.name).sort(), s.id);
    }
});
