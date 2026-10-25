import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatIssue, labelProblem, smokeCheck, validateNet } from "./petri-validate.js";
import { normalizeModel } from "./petri-sim.js";

// A small valid net in the editor's own format.
function net(): any {
    return {
        "@context": "https://pflow.xyz/schema",
        "@type": "PetriNet",
        "@version": "1.1",
        token: ["https://pflow.xyz/tokens/black"],
        places: {
            queue: { "@type": "Place", label: "Queue", initial: [2], capacity: [0], x: 10, y: 10, offset: 0 },
            done: { "@type": "Place", initial: [0], capacity: [null], x: 50, y: 10, offset: 0 },
        },
        transitions: {
            serve: { "@type": "Transition", x: 30, y: 10, rate: 2.5 },
        },
        arcs: [
            { "@type": "Arrow", source: "queue", target: "serve", weight: [1], inhibitTransition: false },
            { "@type": "Arrow", source: "serve", target: "done", weight: [1], inhibitTransition: false },
        ],
    };
}

const paths = (issues: Array<{ path: string }>) => issues.map((i) => i.path);

Deno.test("validateNet: a well-formed net has no errors and no warnings", () => {
    const r = validateNet(net());
    assertEquals(r.errors, []);
    assertEquals(r.warnings, []);
    assert(r.ok);
});

Deno.test("validateNet: never changes its input", () => {
    const n = net();
    n.places.queue.initial = [5];
    n.places.queue.capacity = [3];
    const before = JSON.stringify(n);
    validateNet(n);
    assertEquals(JSON.stringify(n), before);
});

Deno.test("validateNet: what normalizeModel would clamp or coerce is an error", () => {
    const n = net();
    n.places.queue.initial = [5];
    n.places.queue.capacity = [3];
    n.places.done.initial = ["1"];
    n.transitions.serve.rate = -1;
    n.transitions.serve.x = "30";
    n.arcs[0].weight = 0;
    n.arcs[1].inhibitTransition = "no";
    const r = validateNet(n);
    assertEquals(paths(r.errors).sort(), [
        "arcs[0].weight",
        "arcs[1].inhibitTransition",
        "places.done.initial[0]",
        "places.queue.initial[0]",
        "transitions.serve.rate",
        "transitions.serve.x",
    ]);
    assert(!r.ok);
});

Deno.test("validateNet: references the engines cannot follow are errors", () => {
    const n = net();
    n.arcs.push({ source: "queue", target: "done", weight: [1] }); // place → place: a warning
    n.arcs.push({ source: "serve", target: "nowhere", weight: [1] });
    n.transitions.queue = { x: 0, y: 0 }; // an id used twice
    const r = validateNet(n);
    assertEquals(paths(r.errors).sort(), ["arcs[3].target", "transitions.queue"]);
    const m = net();
    m.arcs.push({ source: "queue", target: "done", weight: [1] });
    assert(validateNet(m).warnings.some((w) => w.path === "arcs[2]" && /no engine fires/.test(w.message)));
});

Deno.test("validateNet: reserved and empty ids", () => {
    const n = net();
    n.places[""] = { initial: [0], capacity: [0], x: 0, y: 0 };
    Object.defineProperty(n.places, "__proto__", {
        value: { initial: [0], capacity: [0], x: 0, y: 0 }, enumerable: true, configurable: true, writable: true,
    });
    const r = validateNet(n);
    assert(paths(r.errors).includes('places[""]'));
    assert(paths(r.errors).includes("places.__proto__"));
});

Deno.test("validateNet: labels follow the label editor's rule", () => {
    const n = net();
    n.places.queue.label = "two\nlines";
    n.transitions.serve.label = "x".repeat(101);
    const r = validateNet(n);
    assertEquals(paths(r.errors).sort(), ["places.queue.label", "transitions.serve.label"]);
    assertEquals(labelProblem("ok"), null);
    assertEquals(labelProblem("   "), "Label cannot be empty");
});

Deno.test("validateNet: sim.pflow.xyz's list format is named, not misread", () => {
    const r = validateNet({ places: [{ id: "a" }], transitions: [{ id: "t" }], arcs: [] });
    assert(r.errors.some((e) => e.path === "places" && /keyed by id/.test(e.message)));
});

Deno.test("validateNet: defaults and unknown keys warn; strict makes unknown keys errors", () => {
    const n = net();
    delete n.token;
    n.presentation = { accent: "#fff" }; // sim's theming block: not an editor term
    n.transitions.serve.event = "served";
    const r = validateNet(n);
    assertEquals(r.errors, []);
    assertEquals(paths(r.warnings).sort(), ["presentation", "token", "transitions.serve.event"]);
    const s = validateNet(n, { strict: true });
    assertEquals(paths(s.errors).sort(), ["presentation", "transitions.serve.event"]);
});

Deno.test("validateNet: shape warnings — unconnected nodes, nothing enabled, all-zero weights", () => {
    const n = net();
    n.places.queue.initial = [0];
    n.places.lonely = { initial: [0], capacity: [0], x: 0, y: 0 };
    n.arcs[0].weight = [0];
    const r = validateNet(n);
    assertEquals(r.errors, []);
    const w = r.warnings.map(formatIssue);
    assert(w.some((s) => s.startsWith("places.lonely:")));
    assert(w.some((s) => s.startsWith("arcs[0].weight:") && /go-pflow/.test(s)));
    // the all-zero arc means serve needs nothing, so it IS enabled
    assert(!w.some((s) => /nothing is enabled/.test(s)));
    n.arcs[0].weight = [1];
    assert(validateNet(n).warnings.some((i) => /nothing is enabled/.test(i.message)));
});

Deno.test("validateNet: colored vectors longer than the declared token list warn", () => {
    const n = net();
    n.places.queue.initial = [1, 1];
    n.places.queue.capacity = [0, 0];
    const r = validateNet(n);
    assertEquals(r.errors, []);
    assertEquals(paths(r.warnings).sort(), ["places.queue.capacity", "places.queue.initial"]);
});

// The contract the module exists for: a net with no errors is one normalizeModel
// leaves alone, apart from the defaults it fills and the capacity encoding
// (0, null and Infinity all mean unbounded). Run over every editor-format net in
// the repo, so a new coercion in normalizeModel without a matching check fails here.
function sameAfterNormalize(doc: any) {
    const canon = (m: any) => {
        const c = JSON.parse(JSON.stringify(m));
        delete c["@version"];
        for (const p of Object.values<any>(c.places || {})) {
            delete p.offset;
            delete p["@type"];
            p.capacity = (p.capacity || []).map((v: any) => (v === 0 ? null : v));
        }
        for (const t of Object.values<any>(c.transitions || {})) delete t["@type"];
        for (const a of c.arcs || []) {
            delete a["@type"];
            a.inhibitTransition = !!a.inhibitTransition;
        }
        return c;
    };
    const normalized = normalizeModel(structuredClone(doc));
    assertEquals(canon(normalized), canon(doc));
}

const editorFormat = (d: any) => d && typeof d === "object" && !Array.isArray(d.places) && d.places && d.transitions;
const fixtures: Array<[string, any]> = [];
for (const dir of ["../parity/fixtures/", "../examples/"]) {
    const base = new URL(dir, import.meta.url);
    for await (const e of Deno.readDir(base)) {
        if (!/\.json(ld)?$/.test(e.name)) continue;
        const d = JSON.parse(await Deno.readTextFile(new URL(e.name, base)));
        if (editorFormat(d)) fixtures.push([dir + e.name, d]);
    }
}

Deno.test("fixtures: there are editor-format nets to check", () => {
    assert(fixtures.length >= 5, `found ${fixtures.length}`);
});

for (const [name, doc] of fixtures) {
    Deno.test(`fixtures: ${name} has no errors, and normalizeModel leaves it alone`, () => {
        const r = validateNet(doc);
        assertEquals(r.errors.map(formatIssue), []);
        sameAfterNormalize(doc);
    });
}

Deno.test("smokeCheck: the engines accept a valid net, and it seals", async () => {
    const r = await smokeCheck(net());
    assertEquals(r.errors, []);
    assert(r.cid && r.cid.startsWith("z"));
});
