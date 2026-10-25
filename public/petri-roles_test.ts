import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyDisruptions, groupDisruptions, rolesOf, toSim } from "./petri-roles.js";
import { validateNet } from "./petri-validate.js";

// sim's model shape → the editor's (the inverse of petri-roles.js toSim).
function editorNet(m: any) {
    const places: any = {}, transitions: any = {};
    for (const p of m.places) places[p.id] = { initial: [p.initial ?? 0], capacity: [0], x: 0, y: 0, ...(p.tags?.label ? { label: p.tags.label } : {}) };
    for (const t of m.transitions) transitions[t.id] = { x: 0, y: 0, ...(t.rate !== undefined ? { rate: t.rate } : {}), ...(t.tags?.label ? { label: t.tags.label } : {}) };
    const arcs = m.arcs.map((a: any) => a.type === "read"
        ? { source: a.to, target: a.from, weight: [a.weight ?? 1], inhibitTransition: true }
        : { source: a.from, target: a.to, weight: [a.weight ?? 1], inhibitTransition: a.type === "inhibitor" });
    return { "@context": "https://pflow.xyz/schema", "@type": "PetriNet", token: ["https://pflow.xyz/tokens/black"], places, transitions, arcs };
}

const dir = new URL("../parity/roles/", import.meta.url);
const goldens: Array<[string, any]> = [];
for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".json")) goldens.push([e.name, JSON.parse(await Deno.readTextFile(new URL(e.name, dir)))]);

Deno.test("roles: there are goldens from sim's own derivation", () => assert(goldens.length >= 7));

for (const [name, g] of goldens) {
    Deno.test(`roles: ${name} derives what sim's console derives`, () => {
        const net = editorNet(g.model);
        const { roles, disruptions } = rolesOf(net, 8);
        assertEquals(roles, g.roles);
        assertEquals(disruptions, g.disruptions);
    });
}

Deno.test("roles: the vet clinic's disruptions group by the question they ask", () => {
    const g = goldens.find(([n]) => n === "vet-clinic.json")![1];
    const groups = groupDisruptions(g.disruptions);
    assertEquals(groups.map((x: any) => x.question), ["Something is unavailable", "A rush arrives", "Work is already waiting", "A service is closed"]);
    assertEquals(groups.reduce((s: number, x: any) => s + x.items.length, 0), g.disruptions.length);
});

Deno.test("roles: read and inhibitor arcs survive the round trip to sim's shape", () => {
    const net: any = {
        places: { door: { initial: [1] }, q: { initial: [0] }, done: { initial: [0] } },
        transitions: { arrive: {}, serve: { rate: 2 } },
        arcs: [
            { source: "arrive", target: "door", inhibitTransition: true }, // read arc
            { source: "arrive", target: "q" }, { source: "q", target: "serve" },
            { source: "done", target: "serve", inhibitTransition: true }, // inhibitor
            { source: "serve", target: "done" },
        ],
    };
    const { model, rates } = toSim(net);
    assertEquals(model.arcs[0], { from: "door", to: "arrive", type: "read" });
    assertEquals(model.arcs[3], { from: "done", to: "serve", type: "inhibitor" });
    assertEquals(rates.rates, { arrive: 1, serve: 2 });
    // the gated arrival is still a source (sim's rule: a gate does not feed)
    assertEquals(rolesOf(net).roles.sources.map((s: any) => s.id), ["arrive"]);
});

Deno.test("roles: applyDisruptions merges into a scenario", () => {
    const s = applyDisruptions({ hours: 8 }, [{ marking: { a: 0 } }, { rates: { t: 0 } }, { amount: { place: "q", default: 3 } }]);
    assertEquals(s, { hours: 8, marking: { a: 0, q: 3 }, rates: { t: 0 } });
});

Deno.test("roles: every golden converts to a net the editor's check accepts", () => {
    for (const [name, g] of goldens) assertEquals(validateNet(editorNet(g.model)).errors, [], name);
});

// ---- views, the sim export and analysis.roles through the registry ----
import { CommandError, Registry, createHeadlessHost } from "./petri-commands.js";
import { assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

const desk = () => ({
    places: { q: { initial: [0], capacity: [0], x: 0, y: 0, label: "Waiting" }, staff: { initial: [2], capacity: [0], x: 0, y: 0 }, busy: { initial: [0], capacity: [0], x: 0, y: 0 }, served: { initial: [0], capacity: [0], x: 0, y: 0 }, lost: { initial: [0], capacity: [0], x: 0, y: 0 }, open: { initial: [1], capacity: [0], x: 0, y: 0 } },
    transitions: { arrive: { x: 0, y: 0, rate: 10 }, pickup: { x: 0, y: 0, rate: 720 }, finish: { x: 0, y: 0, rate: 4 }, give_up: { x: 0, y: 0, rate: 6 } },
    arcs: [
        { source: "arrive", target: "q", weight: [1] }, { source: "arrive", target: "open", weight: [1], inhibitTransition: true },
        { source: "q", target: "pickup", weight: [1] }, { source: "staff", target: "pickup", weight: [1] }, { source: "pickup", target: "busy", weight: [1] },
        { source: "busy", target: "finish", weight: [1] }, { source: "finish", target: "served", weight: [1] }, { source: "finish", target: "staff", weight: [1] },
        { source: "q", target: "give_up", weight: [1] }, { source: "give_up", target: "lost", weight: [1] },
    ],
});

Deno.test("views: set, validated by sim's rules, removed", async () => {
    const r: any = new Registry(createHeadlessHost(desk()));
    await r.execute("net.set_views", { views: [
        { id: "floor", role: "board", title: "The floor", places: ["q", "busy"], transitions: ["pickup"], links: ["levers"] },
        { id: "levers", role: "controls", places: ["staff"], transitions: ["arrive"] },
    ] });
    assertEquals(r.host.getModel().views.length, 2);
    assertEquals(validateNet(JSON.parse(JSON.stringify(r.host.getModel()))).errors, []);
    await assertRejects(() => r.execute("net.set_views", { views: [{ id: "x", role: "sidebar" }] }), CommandError, "known roles");
    await assertRejects(() => r.execute("net.set_views", { views: [{ id: "x", places: ["nowhere"] }] }), CommandError, "not a place");
    await assertRejects(() => r.execute("net.set_views", { views: [{ id: "x", links: ["y"] }] }), CommandError, "not a view");
    await assertRejects(() => r.execute("net.set_views", { views: [{ id: "a b" }] }), CommandError, "bare identifier");
    await r.execute("net.set_views", { views: [] });
    assert(!("views" in r.host.getModel()));
});

Deno.test("file.export_sim: sim's shape, read arcs place → transition, rates and labels", async () => {
    const r: any = new Registry(createHeadlessHost(desk()));
    const { model } = await r.execute("file.export_sim");
    assertEquals(model.places.find((p: any) => p.id === "staff").initial, 2);
    assertEquals(model.places.find((p: any) => p.id === "q").tags, { label: "Waiting" });
    assertEquals(model.transitions.find((t: any) => t.id === "finish").rate, 4);
    assert(model.arcs.some((a: any) => a.from === "open" && a.to === "arrive" && a.type === "read"));
});

Deno.test("analysis.roles: the help desk's pools, sources, losses and grouped what-ifs", async () => {
    const r: any = new Registry(createHeadlessHost(desk()));
    const out = await r.execute("analysis.roles");
    assertEquals(out.roles.pools.map((p: any) => p.id), ["staff"]);
    assertEquals(out.roles.sources.map((s: any) => s.id), ["arrive"]); // gated by a read arc, still a source
    assertEquals(out.roles.losses.map((l: any) => l.id), ["give_up"]);
    assertEquals(out.groups.map((g: any) => g.question), ["Something is unavailable", "A rush arrives", "Work is already waiting", "A service is closed"]);
});
