import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { copySelection, freshId, pasteClip, pasteInto } from "./petri-clipboard.js";

// Contract mirrored from pflow-native crates/core/src/commands/clipboard.rs:
// copy keeps arcs only between selected nodes, paste mints p{n}/t{n} ids that
// ignore the old ones, positions are the copied coordinates + (dx, dy), and
// duplicate is copy+paste that leaves the clipboard alone.

function place(x: number, y: number, extra: Record<string, unknown> = {}) {
    return { "@type": "Place", offset: 0, x, y, initial: [0], capacity: [Infinity], ...extra };
}
function transition(x: number, y: number, extra: Record<string, unknown> = {}) {
    return { "@type": "Transition", x, y, ...extra };
}
const arc = (source: string, target: string, extra: Record<string, unknown> = {}) =>
    ({ "@type": "Arrow", source, target, weight: [1], inhibitTransition: false, ...extra });

// S --> infect, I --> infect, infect --> I, I --> recover --> R
function sir(): any {
    return {
        places: {
            S: place(100, 100, { label: "S", initial: [99], capacity: [200] }),
            I: place(300, 100, { label: "I", initial: [1] }),
            R: place(500, 100, { label: "R" }),
        },
        transitions: {
            infect: transition(200, 100, { label: "infect", rate: 0.3 }),
            recover: transition(400, 100, { label: "recover", rate: 0.1, role: "x" }),
        },
        arcs: [
            arc("S", "infect"), arc("I", "infect"), arc("infect", "I"),
            arc("I", "recover"), arc("recover", "R"),
        ],
    };
}

Deno.test("copy keeps arcs only when both ends are selected", () => {
    const m = sir();
    const clip = copySelection(m, ["S", "infect"])!;
    assertEquals(clip.arcs.map((a: any) => [a.source, a.target]), [["S", "infect"]]);
    // I --> infect has only one selected end
    const clip2 = copySelection(m, ["infect", "recover"])!;
    assertEquals(clip2.arcs.length, 0);
});

Deno.test("copy of an empty or unknown selection is null and changes nothing", () => {
    const m = sir();
    const before = JSON.stringify(m);
    assertEquals(copySelection(m, []), null);
    assertEquals(copySelection(m, ["nope"]), null);
    assertEquals(copySelection(m, undefined as any), null);
    assertEquals(JSON.stringify(m), before);
    copySelection(m, ["S", "infect"]);
    assertEquals(JSON.stringify(m), before);
});

Deno.test("inhibitor arcs and extra arc fields survive", () => {
    const m = sir();
    m.arcs.push(arc("R", "infect", { inhibitTransition: true, weight: [2], note: "keep" }));
    const clip = copySelection(m, ["R", "infect"])!;
    const { model, newIds } = pasteClip(m, clip);
    const pasted = model.arcs[model.arcs.length - 1];
    assertEquals(pasted.inhibitTransition, true);
    assertEquals(pasted.weight, [2]);
    assertEquals(pasted.note, "keep");
    assertEquals(newIds.length, 2);
});

Deno.test("labels, rate, role, initial and capacity are carried and deep-cloned", () => {
    const m = sir();
    const clip = copySelection(m, ["S", "recover"])!;
    const { model, newIds } = pasteClip(m, clip);
    const [pid, tid] = newIds;
    assertEquals(model.places[pid].label, "S");
    assertEquals(model.places[pid].initial, [99]);
    assertEquals(model.places[pid].capacity, [200]);
    assertEquals(model.transitions[tid].label, "recover");
    assertEquals(model.transitions[tid].rate, 0.1);
    assertEquals(model.transitions[tid].role, "x");
    // mutating the pasted copy must not reach the original or the clip
    model.places[pid].initial[0] = 7;
    assertEquals(m.places.S.initial, [99]);
    assertEquals(clip.places[0].node.initial, [99]);
});

Deno.test("capacity Infinity survives the clone", () => {
    const m = sir();
    const { model, newIds } = pasteClip(m, copySelection(m, ["I"])!);
    assertEquals(model.places[newIds[0]].capacity, [Infinity]);
});

Deno.test("freshId takes the first free n, skipping ids used by either kind", () => {
    const m = { places: { p0: {}, p1: {}, p3: {} }, transitions: { t0: {}, p2: {} } };
    assertEquals(freshId(m, "p"), "p4"); // p2 is a TRANSITION id but still taken
    assertEquals(freshId(m, "t"), "t1");
    assertEquals(freshId({ places: {}, transitions: {} }, "p"), "p0");
    // the other direction: a place named t0 blocks the transition id
    assertEquals(freshId({ places: { t0: {} }, transitions: {} }, "t"), "t1");
});

Deno.test("places get ids before transitions, in clipboard order", () => {
    const m = sir();
    const clip = copySelection(m, ["infect", "I", "S"])!; // selection order is irrelevant
    const { model, newIds } = pasteClip(m, clip);
    // model order: S, I (places) then infect (transition)
    assertEquals(newIds, ["p0", "p1", "t0"]);
    assertEquals(model.places.p0.label, "S");
    assertEquals(model.places.p1.label, "I");
    assertEquals(model.transitions.t0.label, "infect");
});

Deno.test("paste ids ignore the old ids and avoid collisions", () => {
    const m: any = { places: { p0: place(0, 0), p1: place(10, 0) }, transitions: { t0: transition(5, 0) }, arcs: [arc("p0", "t0"), arc("t0", "p1")] };
    const { model, newIds } = pasteClip(m, copySelection(m, ["p0", "t0", "p1"])!);
    assertEquals(newIds, ["p2", "p3", "t1"]);
    assertEquals(Object.keys(model.places), ["p0", "p1", "p2", "p3"]);
});

Deno.test("arcs are remapped through the old to new ids", () => {
    const m = sir();
    const { model, newIds } = pasteClip(m, copySelection(m, ["S", "infect", "I"])!);
    assertEquals(newIds, ["p0", "p1", "t0"]); // S->p0, I->p1, infect->t0
    const added = model.arcs.slice(m.arcs.length).map((a: any) => [a.source, a.target]);
    assertEquals(added, [["p0", "t0"], ["p1", "t0"], ["t0", "p1"]]);
});

Deno.test("default offset is +40,+40 and dx/dy are honoured", () => {
    const m = sir();
    const clip = copySelection(m, ["S", "infect"])!;
    const a = pasteClip(m, clip);
    assertEquals([a.model.places[a.newIds[0]].x, a.model.places[a.newIds[0]].y], [140, 140]);
    assertEquals([a.model.transitions[a.newIds[1]].x, a.model.transitions[a.newIds[1]].y], [240, 140]);
    const b = pasteClip(m, clip, { dx: -10, dy: 5 });
    assertEquals([b.model.places[b.newIds[0]].x, b.model.places[b.newIds[0]].y], [90, 105]);
    const z = pasteClip(m, clip, { dx: 0, dy: 0 });
    assertEquals(z.model.places[z.newIds[0]].x, 100);
});

Deno.test("pasting twice overlaps (no cascade) and uses distinct ids", () => {
    const m = sir();
    const clip = copySelection(m, ["S"])!;
    const ids1 = pasteInto(m, clip);
    const ids2 = pasteInto(m, clip);
    assertNotEquals(ids1[0], ids2[0]);
    assertEquals([m.places[ids1[0]].x, m.places[ids1[0]].y], [m.places[ids2[0]].x, m.places[ids2[0]].y]);
    assertEquals(m.places[ids2[0]].x, 140);
});

Deno.test("pasteClip is pure; pasteInto mutates", () => {
    const m = sir();
    const before = JSON.stringify(m);
    pasteClip(m, copySelection(m, ["S"])!);
    assertEquals(JSON.stringify(m), before);
    pasteInto(m, copySelection(m, ["S"])!);
    assertNotEquals(JSON.stringify(m), before);
});

Deno.test("paste with no clipboard does nothing", () => {
    const m = sir();
    assertEquals(pasteInto(m, null), []);
    const r = pasteClip(m, null);
    assertEquals(r.newIds, []);
    assertEquals(r.model, m);
});

Deno.test("duplicate (copy + paste) leaves the clipboard unchanged", () => {
    // the editor's duplicate saves and restores its buffer; this is the same
    // sequence on the pure functions: the clip a paste reads is never mutated.
    const m = sir();
    const clipboard = copySelection(m, ["R"])!;
    const snapshot = JSON.stringify(clipboard);
    const dup = copySelection(m, ["S", "infect"])!;
    pasteInto(m, dup);
    pasteInto(m, clipboard);
    assertEquals(JSON.stringify(clipboard), snapshot);
});

Deno.test("repeated duplicate steps down-right when the selection follows the copies", () => {
    const m = sir();
    let sel: string[] = ["S"];
    for (let i = 1; i <= 3; i++) {
        sel = pasteInto(m, copySelection(m, sel)!);
        assertEquals(m.places[sel[0]].x, 100 + 40 * i);
        assertEquals(m.places[sel[0]].y, 100 + 40 * i);
    }
});

Deno.test("native phase2 port: select S, infect, I of a SIR-like net", () => {
    const m = sir();
    assertEquals(Object.keys(m.places).length, 3);
    assertEquals(m.arcs.length, 5);
    const clip = copySelection(m, ["S", "infect", "I"])!;
    const newIds = pasteInto(m, clip);
    assertEquals(newIds.length, 3);
    assertEquals(Object.keys(m.places).length, 5);
    assertEquals(m.arcs.length, 8);
    // every arc still joins existing nodes
    const ids = new Set([...Object.keys(m.places), ...Object.keys(m.transitions)]);
    for (const a of m.arcs) assert(ids.has(a.source) && ids.has(a.target));
});
