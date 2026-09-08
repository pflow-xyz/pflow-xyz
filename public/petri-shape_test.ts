import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromJSON } from "./petri-solver.js";
import { expandColors } from "./petri-colors.js";

// Editor-shape parse parity: the browser's reading of a pflow.xyz document
// (fromJSON) and its color unfolding (expandColors) must match go-pflow's
// parser byte for byte on the shared goldens under parity/editor-shape —
// copies of go-pflow's parser/testdata/editor-shape, one per fixture, each
// carrying the input, go-pflow's parsed net and its expansion. Readers may
// stay plural across the ecosystem; their answers may not.

function normalize(net: any) {
    const places: Record<string, unknown> = {};
    for (const [id, p] of net.places) {
        const np: Record<string, unknown> = {
            initial: [...p.initial], capacity: [...p.capacity], x: p.x, y: p.y,
        };
        if (p.labelText) np.label = p.labelText;
        places[id] = np;
    }
    const transitions: Record<string, unknown> = {};
    for (const [id, t] of net.transitions) {
        const nt: Record<string, unknown> = { x: t.x, y: t.y };
        if (t.role) nt.role = t.role;
        if (t.labelText) nt.label = t.labelText;
        transitions[id] = nt;
    }
    const arcs = net.arcs.map((a: any) => ({
        source: a.source, target: a.target, weight: [...a.weight], inhibit: Boolean(a.inhibitTransition),
    }));
    return { token: [...net.token], places, transitions, arcs };
}

// Drop keys the golden omits (omitempty on go-pflow's side) so the shapes compare.
function strip(v: any): any {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) {
            if (x === "" || x === null || x === undefined) continue;
            out[k] = strip(x);
        }
        return out;
    }
    return v;
}

const dir = new URL("../parity/editor-shape/", import.meta.url);
for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".json")) continue;
    const golden = JSON.parse(await Deno.readTextFile(new URL(entry.name, dir)));
    Deno.test(`editor-shape parity: ${entry.name} parses like go-pflow`, () => {
        const net = fromJSON(golden.input);
        assertEquals(strip(normalize(net)), strip(golden.parsed));
    });
    Deno.test(`editor-shape parity: ${entry.name} expands colors like go-pflow`, () => {
        const net = fromJSON(golden.input);
        const { net: expanded } = expandColors(net);
        assertEquals(strip(normalize(expanded)), strip(golden.expanded));
    });
}
