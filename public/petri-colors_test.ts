import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    ColorMap,
    colorCount,
    isMultiColor,
    expandColors,
    expandState,
} from "./petri-colors.js";
import { PetriNet, fromJSON, setState, setRates, ODEProblem, solve, Tsit5 } from "./petri-solver.js";

// --- helpers ---

/** Two-color net whose only transition consumes RED. */
function coloredNet(poolRed: number, poolBlue: number) {
    const n = new PetriNet();
    n.token = ["red", "blue"];
    n.addPlace("pool", [poolRed, poolBlue], [], 0, 0, null);
    n.addPlace("out", [0, 0], [], 0, 0, null);
    n.addTransition("drain", "default", 0, 0, null);
    n.addArc("pool", "drain", [1, 0], false);
    n.addArc("drain", "out", [1, 0], false);
    return n;
}

// --- colorCount / isMultiColor ---

Deno.test("colorCount: from token names, place vectors and arc weights", () => {
    const empty = new PetriNet();
    assertEquals(colorCount(empty), 0);
    assertEquals(isMultiColor(empty), false);

    const single = new PetriNet();
    single.addPlace("p", [1], [], 0, 0, null);
    assertEquals(isMultiColor(single), false);

    const byToken = new PetriNet();
    byToken.token = ["red", "blue"];
    byToken.addPlace("p", [1], [], 0, 0, null);
    assertEquals(colorCount(byToken), 2);
    assertEquals(isMultiColor(byToken), true);

    const byInitial = new PetriNet();
    byInitial.addPlace("p", [1, 2], [], 0, 0, null);
    assertEquals(isMultiColor(byInitial), true);

    const byCapacity = new PetriNet();
    byCapacity.addPlace("p", [1], [3, 3], 0, 0, null);
    assertEquals(isMultiColor(byCapacity), true);

    const byWeight = new PetriNet();
    byWeight.addPlace("p", [1], [], 0, 0, null);
    byWeight.addTransition("t", "default", 0, 0, null);
    byWeight.addArc("p", "t", [1, 1], false);
    assertEquals(isMultiColor(byWeight), true);
});

// --- expandColors ---

Deno.test("expandColors: single-color net is returned as-is with a null colorMap", () => {
    const n = new PetriNet();
    n.addPlace("p", [1], [], 0, 0, null);

    const { net, colorMap } = expandColors(n);
    assertEquals(colorMap, null);
    assertEquals(net, n);
});

Deno.test("expandColors: one place per color, named from token", () => {
    const { net, colorMap } = expandColors(coloredNet(2, 6));

    assertEquals(colorMap!.colors, ["red", "blue"]);
    assertEquals([...net.places.keys()].sort(), ["out.blue", "out.red", "pool.blue", "pool.red"]);
    assertEquals(net.places.get("pool.red")!.initial, [2]);
    assertEquals(net.places.get("pool.blue")!.initial, [6]);
    // The unfolded net is single-color by construction.
    assertEquals(net.token, []);
    assertEquals(isMultiColor(net), false);
});

Deno.test("expandColors: undeclared color names fall back to c0, c1", () => {
    const n = new PetriNet();
    n.addPlace("p", [3, 5], [], 0, 0, null);

    const { colorMap } = expandColors(n);
    assertEquals(colorMap!.colors, ["c0", "c1"]);
    assertEquals(colorMap!.expanded.get("p"), ["p.c0", "p.c1"]);
});

Deno.test("expandColors: a zero weight component creates no arc for that color", () => {
    const { net } = expandColors(coloredNet(2, 6));

    // [1,0] on each arc -> one red arc each, no blue arcs.
    assertEquals(net.arcs.length, 2);
    for (const a of net.arcs) {
        assertEquals(a.weight, [1]);
        assertEquals(a.source.endsWith(".blue") || a.target.endsWith(".blue"), false);
    }
});

Deno.test("expandColors: an arc with no declared weight defaults to one token of color 0", () => {
    const n = new PetriNet();
    n.token = ["red", "blue"];
    n.addPlace("a", [1, 1], [], 0, 0, null);
    n.addPlace("b", [0, 0], [], 0, 0, null);
    n.addTransition("t", "default", 0, 0, null);
    n.addArc("a", "t", [], false);
    n.addArc("t", "b", [], false);

    const { net } = expandColors(n);
    assertEquals(net.arcs.length, 2);
    assertEquals(net.arcs[0].source, "a.red");
    assertEquals(net.arcs[1].target, "b.red");
});

Deno.test("expandColors: a zero capacity component means unbounded", () => {
    const n = new PetriNet();
    n.token = ["red", "blue"];
    n.addPlace("p", [1, 1], [2, 0], 0, 0, null);

    const { net } = expandColors(n);
    assertEquals(net.places.get("p.red")!.capacity, [2]);
    assertEquals(net.places.get("p.blue")!.capacity, []);
});

Deno.test("expandColors: separator doubles until expanded names are unique", () => {
    // A literal "pool.red" place already exists, so "pool" must expand to
    // "pool..red" / "pool..blue" rather than colliding with it.
    const n = new PetriNet();
    n.token = ["red", "blue"];
    n.addPlace("pool", [1, 1], [], 0, 0, null);
    n.addPlace("pool.red", [7], [], 0, 0, null);

    const { net, colorMap } = expandColors(n);
    assertEquals(colorMap!.expanded.get("pool"), ["pool..red", "pool..blue"]);
    // Every expanded name is distinct.
    const names = [...colorMap!.base.keys()];
    assertEquals(new Set(names).size, names.length);
    // The literal place keeps its own tokens.
    assertEquals(net.places.get("pool.red..red")!.initial, [7]);
});

// --- ColorMap accessors ---

Deno.test("ColorMap: lookup, baseName and sumByBase", () => {
    const { colorMap } = expandColors(coloredNet(2, 6));
    const cm = colorMap as ColorMap;

    assertEquals(cm.lookup("pool"), ["pool.red", "pool.blue"]);
    // An expanded or unknown name is its own single-element lookup.
    assertEquals(cm.lookup("pool.red"), ["pool.red"]);
    assertEquals(cm.lookup("elsewhere"), ["elsewhere"]);

    assertEquals(cm.baseName("pool.blue"), { place: "pool", color: "blue", ok: true });
    assertEquals(cm.baseName("elsewhere"), { place: "elsewhere", color: "", ok: false });

    assertEquals(cm.sumByBase({ "pool.red": 2, "pool.blue": 3, unrelated: 7 }), {
        pool: 5,
        unrelated: 7,
    });
});

// --- expandState ---

Deno.test("expandState: expanding the net's own state reproduces the declared vectors", () => {
    const n = coloredNet(2, 6);
    assertEquals(expandState(n, setState(n)), {
        "pool.red": 2,
        "pool.blue": 6,
        "out.red": 0,
        "out.blue": 0,
    });
});

Deno.test("expandState: a base total scales every color by the same factor", () => {
    const n = coloredNet(2, 6);
    const got = expandState(n, { pool: 4 });
    assertEquals(got["pool.red"], 1);
    assertEquals(got["pool.blue"], 3);
});

Deno.test("expandState: a place declaring nothing sends the whole total to color 0", () => {
    const n = coloredNet(2, 6);
    const got = expandState(n, { out: 5 });
    assertEquals(got["out.red"], 5);
    assertEquals(got["out.blue"], 0);
});

Deno.test("expandState: is idempotent on already-expanded keys", () => {
    const n = coloredNet(2, 6);
    const once = expandState(n, setState(n));
    assertEquals(expandState(n, once), once);
});

Deno.test("expandState: single-color net is unchanged", () => {
    const n = new PetriNet();
    n.addPlace("p", [5], [], 0, 0, null);
    assertEquals(expandState(n, setState(n)), { p: 5 });
});

// --- solver integration ---

Deno.test("ODE: blue tokens cannot feed a red-only reaction", () => {
    const net = coloredNet(0, 10);
    const prob = new ODEProblem(net, setState(net), [0, 20], { drain: 1.0 });
    assertNotEquals(prob.colorMap, null);

    const final = solve(prob, Tsit5(), {}).getFinalState();

    // Summing the color vector would drain the pool completely.
    assertEquals(final.pool, 10);
    assertEquals(final.out, 0);
});

Deno.test("ODE: a red reaction consumes red only, leaving blue untouched", () => {
    const net = coloredNet(4, 6);
    const sol = solve(new ODEProblem(net, setState(net), [0, 30], { drain: 1.0 }), Tsit5(), {});

    const byColor = sol.getFinalStateByColor();
    assertEquals(byColor["pool.blue"], 6);
    assertEquals(byColor["out.blue"], 0);
    // Red mass is conserved between pool and out.
    const redTotal = byColor["pool.red"] + byColor["out.red"];
    assertEquals(Math.abs(redTotal - 4) < 1e-6, true);
});

Deno.test("ODE: results report base names by default, by-color on request", () => {
    const net = coloredNet(4, 6);
    const sol = solve(new ODEProblem(net, setState(net), [0, 30], { drain: 1.0 }), Tsit5(), {});

    const final = sol.getFinalState();
    assertEquals(Object.keys(final).sort(), ["out", "pool"]);

    const byColor = sol.getFinalStateByColor();
    assertEquals(Math.abs(final.pool - (byColor["pool.red"] + byColor["pool.blue"])) < 1e-9, true);

    // getVariable takes either name; a base name sums the colors, so a plot of
    // "pool" is unchanged by the unfolding.
    const total = sol.getVariable("pool");
    const red = sol.getVariable("pool.red");
    const blue = sol.getVariable("pool.blue");
    assertEquals(total.length, red.length);
    for (let i = 0; i < total.length; i++) {
        assertEquals(Math.abs(total[i] - (red[i] + blue[i])) < 1e-9, true);
    }
    assertEquals(blue[blue.length - 1], 6); // blue never moves

    assertEquals(sol.getVariableByColor("pool").length, 2);
});

Deno.test("ODE: a single-color problem is untouched", () => {
    const net = fromJSON({
        places: { a: { initial: [5] }, b: { initial: [0] } },
        transitions: { t: {} },
        arcs: [{ source: "a", target: "t", weight: [1] }, { source: "t", target: "b", weight: [1] }],
    });
    const prob = new ODEProblem(net, setState(net), [0, 10], setRates(net));

    assertEquals(prob.colorMap, null);
    assertEquals(prob.net, net);

    const sol = solve(prob, Tsit5(), {});
    assertEquals(sol.colorMap, null);
    const final = sol.getFinalState();
    assertEquals(Math.abs(final.a + final.b - 5) < 1e-6, true);
});
