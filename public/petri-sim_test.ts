import { assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    getArcWeight,
    inArcsOf,
    outArcsOf,
    capacityOf,
    scalarCapacityOf,
    marking,
    enabled,
    fire,
    enabledTransitions,
} from "./petri-sim.js";

// --- helpers ---

/** Minimal model builder */
function model(
    places: Record<string, { initial?: number[]; capacity?: number[] }>,
    transitions: Record<string, Record<string, unknown>>,
    arcs: Array<{ source: string; target: string; weight?: number[]; inhibitTransition?: boolean }>,
) {
    return { places, transitions, arcs };
}

// --- getArcWeight ---

Deno.test("getArcWeight: null weight defaults to [1]", () => {
    assertEquals(getArcWeight({}), [1]);
    assertEquals(getArcWeight({ weight: null }), [1]);
});

Deno.test("getArcWeight: scalar weight normalised to array", () => {
    assertEquals(getArcWeight({ weight: 3 }), [3]);
});

Deno.test("getArcWeight: array weight preserved, 0 becomes 1", () => {
    assertEquals(getArcWeight({ weight: [2, 0, 5] }), [2, 1, 5]);
});

// --- capacityOf ---

Deno.test("capacityOf: missing place returns [Infinity]", () => {
    const m = model({}, {}, []);
    assertEquals(capacityOf(m, "nope"), [Infinity]);
});

Deno.test("capacityOf: capacity=0 treated as unbounded (Infinity)", () => {
    const m = model({ p: { initial: [0], capacity: [0] } }, {}, []);
    assertEquals(capacityOf(m, "p"), [Infinity]);
});

Deno.test("capacityOf: explicit positive capacity preserved", () => {
    const m = model({ p: { initial: [0], capacity: [5] } }, {}, []);
    assertEquals(capacityOf(m, "p"), [5]);
});

Deno.test("capacityOf: undefined capacity treated as Infinity", () => {
    const m = model({ p: { initial: [0] } }, {}, []);
    assertEquals(capacityOf(m, "p"), [Infinity]);
});

Deno.test("scalarCapacityOf: returns first element", () => {
    const m = model({ p: { initial: [0], capacity: [3, 5] } }, {}, []);
    assertEquals(scalarCapacityOf(m, "p"), 3);
});

// --- marking ---

Deno.test("marking: extracts token vectors from model", () => {
    const m = model(
        { a: { initial: [1] }, b: { initial: [0, 2] } },
        {},
        [],
    );
    assertEquals(marking(m), { a: [1], b: [0, 2] });
});

// --- basic firing ---

Deno.test("basic firing: token moves from input to output", () => {
    const m = model(
        { p1: { initial: [1] }, p2: { initial: [0] } },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p2", weight: [1] },
        ],
    );
    const marks = marking(m);
    assertEquals(enabled(m, "t1", marks), true);
    const result = fire(m, "t1", marks);
    assertNotEquals(result, null);
    assertEquals(result!["p1"], [0]);
    assertEquals(result!["p2"], [1]);
});

Deno.test("basic firing: transition blocked when no tokens", () => {
    const m = model(
        { p1: { initial: [0] }, p2: { initial: [0] } },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p2", weight: [1] },
        ],
    );
    assertEquals(enabled(m, "t1", marking(m)), false);
    assertEquals(fire(m, "t1", marking(m)), null);
});

// --- self-loop ---

Deno.test("self-loop: place with in+out arcs does not accumulate", () => {
    // p1 --1--> t1 --1--> p1 (self-loop)
    const m = model(
        { p1: { initial: [1] } },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p1", weight: [1] },
        ],
    );
    const marks = marking(m);
    assertEquals(enabled(m, "t1", marks), true);
    const result = fire(m, "t1", marks);
    assertNotEquals(result, null);
    assertEquals(result!["p1"], [1]); // unchanged
});

// --- capacity enforcement ---

Deno.test("capacity enforcement: output place at capacity blocks transition", () => {
    const m = model(
        {
            p1: { initial: [1] },
            p2: { initial: [2], capacity: [2] },
        },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p2", weight: [1] },
        ],
    );
    assertEquals(enabled(m, "t1", marking(m)), false);
    assertEquals(fire(m, "t1", marking(m)), null);
});

Deno.test("capacity enforcement: fires when output has room", () => {
    const m = model(
        {
            p1: { initial: [1] },
            p2: { initial: [1], capacity: [2] },
        },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p2", weight: [1] },
        ],
    );
    assertEquals(enabled(m, "t1", marking(m)), true);
    const result = fire(m, "t1", marking(m));
    assertNotEquals(result, null);
    assertEquals(result!["p2"], [2]);
});

// --- capacity=0 is unbounded ---

Deno.test("capacity=0 means unbounded: never blocks", () => {
    const m = model(
        {
            p1: { initial: [1] },
            p2: { initial: [999], capacity: [0] },
        },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p2", weight: [1] },
        ],
    );
    assertEquals(enabled(m, "t1", marking(m)), true);
    const result = fire(m, "t1", marking(m));
    assertNotEquals(result, null);
    assertEquals(result!["p2"], [1000]);
});

// --- inhibitor arcs ---

Deno.test("inhibitor arc: blocks when source place has tokens >= weight", () => {
    const m = model(
        { p1: { initial: [1] }, p2: { initial: [1] } },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },  // normal input
            { source: "p2", target: "t1", weight: [1], inhibitTransition: true }, // inhibitor
            { source: "t1", target: "p1", weight: [1] },  // output (self-loop)
        ],
    );
    // p2 has 1 token, inhibitor weight is 1 → blocked
    assertEquals(enabled(m, "t1", marking(m)), false);
});

Deno.test("inhibitor arc: allows when source place has fewer tokens than weight", () => {
    const m = model(
        { p1: { initial: [1] }, p2: { initial: [0] } },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "p2", target: "t1", weight: [1], inhibitTransition: true },
            { source: "t1", target: "p1", weight: [1] },
        ],
    );
    assertEquals(enabled(m, "t1", marking(m)), true);
});

// --- weight-0 treated as weight-1 ---

Deno.test("weight-0 arc: treated as weight 1, consumes token", () => {
    // weight=0 is normalized to 1 (same as null/undefined)
    const m = model(
        { p1: { initial: [5] }, p2: { initial: [0] } },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [0] }, // becomes weight 1
            { source: "t1", target: "p2", weight: [1] },
        ],
    );
    assertEquals(enabled(m, "t1", marking(m)), true);
    const result = fire(m, "t1", marking(m));
    assertNotEquals(result, null);
    assertEquals(result!["p1"], [4]); // consumed 1 (weight 0 → 1)
    assertEquals(result!["p2"], [1]);
});

Deno.test("weight-0 arc: blocks when place is empty", () => {
    const m = model(
        { p1: { initial: [0] }, p2: { initial: [0] } },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [0] }, // becomes weight 1
            { source: "t1", target: "p2", weight: [1] },
        ],
    );
    assertEquals(enabled(m, "t1", marking(m)), false);
});

// --- bounded buffer (producer-consumer) ---

Deno.test("bounded buffer: producer-consumer full cycle", () => {
    // Classic producer-consumer with buffer capacity 2
    // Places: ready (1 token), buffer (0 tokens, cap 2), done (0 tokens)
    // Transitions: produce (ready -> buffer), consume (buffer -> done)
    const m = model(
        {
            ready: { initial: [3] },
            buffer: { initial: [0], capacity: [2] },
            done: { initial: [0] },
        },
        { produce: {}, consume: {} },
        [
            { source: "ready", target: "produce", weight: [1] },
            { source: "produce", target: "buffer", weight: [1] },
            { source: "buffer", target: "consume", weight: [1] },
            { source: "consume", target: "done", weight: [1] },
        ],
    );

    let marks = marking(m);

    // Fire produce twice (fills buffer to capacity)
    marks = fire(m, "produce", marks)!;
    assertNotEquals(marks, null);
    assertEquals(marks["buffer"], [1]);

    marks = fire(m, "produce", marks)!;
    assertNotEquals(marks, null);
    assertEquals(marks["buffer"], [2]);

    // Third produce blocked (buffer full)
    assertEquals(enabled(m, "produce", marks), false);

    // Consume once to make room
    marks = fire(m, "consume", marks)!;
    assertNotEquals(marks, null);
    assertEquals(marks["buffer"], [1]);
    assertEquals(marks["done"], [1]);

    // Now produce works again
    marks = fire(m, "produce", marks)!;
    assertNotEquals(marks, null);
    assertEquals(marks["buffer"], [2]);
    assertEquals(marks["ready"], [0]);

    // Drain buffer
    marks = fire(m, "consume", marks)!;
    marks = fire(m, "consume", marks)!;
    assertEquals(marks["buffer"], [0]);
    assertEquals(marks["done"], [3]);

    // No transitions enabled (deadlock — all tokens consumed)
    assertEquals(enabledTransitions(m, marks), []);
});

// --- enabledTransitions ---

Deno.test("enabledTransitions: returns correct set", () => {
    const m = model(
        {
            p1: { initial: [1] },
            p2: { initial: [0] },
            p3: { initial: [1] },
        },
        { t1: {}, t2: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p2", weight: [1] },
            { source: "p2", target: "t2", weight: [1] },
            { source: "t2", target: "p3", weight: [1] },
        ],
    );
    const marks = marking(m);
    // t1 enabled (p1 has token), t2 not (p2 empty)
    assertEquals(enabledTransitions(m, marks), ["t1"]);
});

Deno.test("enabledTransitions: multiple transitions enabled", () => {
    const m = model(
        { p1: { initial: [2] }, p2: { initial: [0] }, p3: { initial: [0] } },
        { t1: {}, t2: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p2", weight: [1] },
            { source: "p1", target: "t2", weight: [1] },
            { source: "t2", target: "p3", weight: [1] },
        ],
    );
    const et = enabledTransitions(m, marking(m));
    assertEquals(et.sort(), ["t1", "t2"]);
});

// --- fire does not mutate input marking ---

Deno.test("fire: does not mutate the input marking", () => {
    const m = model(
        { p1: { initial: [3] }, p2: { initial: [0] } },
        { t1: {} },
        [
            { source: "p1", target: "t1", weight: [1] },
            { source: "t1", target: "p2", weight: [1] },
        ],
    );
    const marks = marking(m);
    const original = JSON.parse(JSON.stringify(marks));
    fire(m, "t1", marks);
    assertEquals(marks, original); // original untouched
});
