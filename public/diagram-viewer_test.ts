import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    translatePetriNet,
    buildBoxes,
    buildDAG,
    breakCycles,
    assignLayers,
    findBoundaries,
    generateSVG,
} from "./diagram-viewer.js";

// deno-lint-ignore-file no-explicit-any
// --- helpers ---

// Type aliases for untyped JS returns
type DAGMap = Record<string, string[]>;
type LevelMap = Record<string, number>;

function model(
    places: Record<string, { initial?: number[]; capacity?: number[] }>,
    transitions: Record<string, Record<string, unknown>>,
    arcs: Array<{ source: string; target: string; weight?: number[]; inhibitTransition?: boolean }>,
) {
    return { places, transitions, arcs };
}

// --- buildBoxes ---

Deno.test("buildBoxes: empty model", () => {
    const boxes = buildBoxes({ places: {}, transitions: {}, arcs: [] });
    assertEquals(boxes.length, 0);
});

Deno.test("buildBoxes: single transition with inputs and outputs", () => {
    const m = model(
        { p0: { initial: [1] }, p1: { initial: [0] } },
        { t0: {} },
        [
            { source: "p0", target: "t0", weight: [1] },
            { source: "t0", target: "p1", weight: [1] },
        ]
    );
    const boxes = buildBoxes(m);
    assertEquals(boxes.length, 1);
    assertEquals(boxes[0].id, "t0");
    assertEquals(boxes[0].inputs.length, 1);
    assertEquals(boxes[0].inputs[0].wireType, "p0");
    assertEquals(boxes[0].outputs.length, 1);
    assertEquals(boxes[0].outputs[0].wireType, "p1");
});

Deno.test("buildBoxes: inhibitor arc marks input as inhibit", () => {
    const m = model(
        { p0: {} },
        { t0: {} },
        [{ source: "p0", target: "t0", weight: [1], inhibitTransition: true }]
    );
    const boxes = buildBoxes(m);
    assertEquals(boxes[0].inputs[0].inhibit, true);
});

// --- buildDAG ---

Deno.test("buildDAG: sequential transitions share dependency", () => {
    const m = model(
        { p0: {}, p1: {}, p2: {} },
        { t0: {}, t1: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
            { source: "p1", target: "t1" },
            { source: "t1", target: "p2" },
        ]
    );
    const boxes = buildBoxes(m);
    const { outgoing, incoming } = buildDAG(boxes, m) as { outgoing: DAGMap; incoming: DAGMap };
    assert(outgoing["t0"].includes("t1"));
    assert(incoming["t1"].includes("t0"));
    assertEquals(outgoing["t1"].filter((x: string) => x === "t0").length, 0);
});

Deno.test("buildDAG: independent transitions have no edges", () => {
    const m = model(
        { p0: {}, p1: {}, p2: {}, p3: {} },
        { t0: {}, t1: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
            { source: "p2", target: "t1" },
            { source: "t1", target: "p3" },
        ]
    );
    const boxes = buildBoxes(m);
    const { outgoing } = buildDAG(boxes, m) as { outgoing: DAGMap; incoming: DAGMap };
    assertEquals(outgoing["t0"].length, 0);
    assertEquals(outgoing["t1"].length, 0);
});

// --- breakCycles ---

Deno.test("breakCycles: no cycles returns empty set", () => {
    const m = model(
        { p0: {}, p1: {}, p2: {} },
        { t0: {}, t1: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
            { source: "p1", target: "t1" },
            { source: "t1", target: "p2" },
        ]
    );
    const boxes = buildBoxes(m);
    const { outgoing } = buildDAG(boxes, m);
    const backEdges = breakCycles(boxes, outgoing);
    assertEquals(backEdges.size, 0);
});

Deno.test("breakCycles: cycle produces back edge", () => {
    const m = model(
        { p0: {}, p1: {} },
        { t0: {}, t1: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
            { source: "p1", target: "t1" },
            { source: "t1", target: "p0" },
        ]
    );
    const boxes = buildBoxes(m);
    const { outgoing } = buildDAG(boxes, m);
    const backEdges = breakCycles(boxes, outgoing);
    assertEquals(backEdges.size, 1);
    assert(backEdges.has("t1->t0"));
});

// --- assignLayers ---

Deno.test("assignLayers: sequential chain gets increasing layers", () => {
    const m = model(
        { p0: {}, p1: {}, p2: {}, p3: {} },
        { t0: {}, t1: {}, t2: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
            { source: "p1", target: "t1" },
            { source: "t1", target: "p2" },
            { source: "p2", target: "t2" },
            { source: "t2", target: "p3" },
        ]
    );
    const boxes = buildBoxes(m);
    const { outgoing, incoming } = buildDAG(boxes, m) as { outgoing: DAGMap; incoming: DAGMap };
    const backEdges = breakCycles(boxes, outgoing);
    const level = assignLayers(boxes, outgoing, incoming, backEdges) as LevelMap;
    assertEquals(level["t0"], 0);
    assertEquals(level["t1"], 1);
    assertEquals(level["t2"], 2);
});

Deno.test("assignLayers: independent transitions share layer 0", () => {
    const m = model(
        { p0: {}, p1: {}, p2: {}, p3: {} },
        { t0: {}, t1: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
            { source: "p2", target: "t1" },
            { source: "t1", target: "p3" },
        ]
    );
    const boxes = buildBoxes(m);
    const { outgoing, incoming } = buildDAG(boxes, m) as { outgoing: DAGMap; incoming: DAGMap };
    const backEdges = breakCycles(boxes, outgoing);
    const level = assignLayers(boxes, outgoing, incoming, backEdges) as LevelMap;
    assertEquals(level["t0"], 0);
    assertEquals(level["t1"], 0);
});

// --- findBoundaries ---

Deno.test("findBoundaries: source and sink places", () => {
    const m = model(
        { src: {}, mid: {}, sink: {} },
        { t0: {}, t1: {} },
        [
            { source: "src", target: "t0" },
            { source: "t0", target: "mid" },
            { source: "mid", target: "t1" },
            { source: "t1", target: "sink" },
        ]
    );
    const boxes = buildBoxes(m);
    const { boundaryInputs, boundaryOutputs } = findBoundaries(boxes, m);
    assert(boundaryInputs.includes("src"));
    assert(boundaryOutputs.includes("sink"));
    assert(!boundaryInputs.includes("mid"));
    assert(!boundaryOutputs.includes("mid"));
});

// --- translatePetriNet ---

Deno.test("translatePetriNet: null model returns empty diagram", () => {
    const d = translatePetriNet(null);
    assertEquals(d.boxes.length, 0);
    assertEquals(d.wires.length, 0);
});

Deno.test("translatePetriNet: simple chain produces wires", () => {
    const m = model(
        { p0: {}, p1: {}, p2: {} },
        { t0: {}, t1: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
            { source: "p1", target: "t1" },
            { source: "t1", target: "p2" },
        ]
    );
    const d = translatePetriNet(m);
    assertEquals(d.boxes.length, 2);
    // Wire connecting t0 output to t1 input through p1
    const p1Wire = d.wires.find(w => w.wireType === "p1");
    assert(p1Wire !== undefined, "should have a wire for place p1");
    assert(!p1Wire!.isBack, "should not be a back edge");
});

Deno.test("translatePetriNet: cycle produces back edge", () => {
    const m = model(
        { p0: {}, p1: {} },
        { t0: {}, t1: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
            { source: "p1", target: "t1" },
            { source: "t1", target: "p0" },
        ]
    );
    const d = translatePetriNet(m);
    assert(d.backEdges.length > 0, "should detect back edges");
    const backWire = d.wires.find(w => w.isBack);
    assert(backWire !== undefined, "should have a back-edge wire");
});

// --- generateSVG ---

Deno.test("generateSVG: produces valid SVG string", () => {
    const m = model(
        { p0: {}, p1: {} },
        { t0: {} },
        [
            { source: "p0", target: "t0" },
            { source: "t0", target: "p1" },
        ]
    );
    const d = translatePetriNet(m);
    const svg = generateSVG(d);
    assert(svg.startsWith("<svg"));
    assert(svg.includes("</svg>"));
    assert(svg.includes("t0"), "should contain transition label");
});

Deno.test("generateSVG: empty diagram produces minimal SVG", () => {
    const d = translatePetriNet(null);
    const svg = generateSVG(d);
    assert(svg.startsWith("<svg"));
    assert(svg.includes("</svg>"));
});

Deno.test("translatePetriNet: multi-weight arcs preserved", () => {
    const m = model(
        { p0: {}, p1: {} },
        { t0: {} },
        [
            { source: "p0", target: "t0", weight: [3] },
            { source: "t0", target: "p1", weight: [2] },
        ]
    );
    const d = translatePetriNet(m);
    const box = d.boxes[0];
    assertEquals(box.inputs[0].weight[0], 3);
    assertEquals(box.outputs[0].weight[0], 2);
});

Deno.test("translatePetriNet: disconnected transitions", () => {
    const m = model(
        {},
        { t0: {}, t1: {} },
        []
    );
    const d = translatePetriNet(m);
    assertEquals(d.boxes.length, 2);
    assertEquals(d.wires.length, 0);
});
