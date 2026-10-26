import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    choosePaste, CLIP_ORIGIN, CLIP_VERSION, CLIPBOARD_EVENT_WAIT_MS, clipboardEventText, clipboardShortcut, clipFromText,
    clipToText, colorMappingNote, copySelection, declaredColors, editableTarget, freshId, hasTextSelection, pasteClip,
    pasteInto, readClipboardText, usesCommandKey, writeClipboardText,
} from "./petri-clipboard.js";
import { normalizeModel } from "./petri-sim.js";
import { validateNet } from "./petri-validate.js";

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

Deno.test("pasteInto takes the same ids as one freshId scan from 0 per node, on a net with gaps", () => {
    // a place named t3 and a transition named p3 block those ids for the other kind
    const m: any = {
        places: { p0: place(0, 0), p2: place(0, 0), p5: place(0, 0), t3: place(0, 0) },
        transitions: { t1: transition(0, 0), p3: transition(0, 0), t4: transition(0, 0) },
        arcs: [],
    };
    const clip: any = {
        places: Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, node: place(i, 0) })),
        transitions: Array.from({ length: 4 }, (_, i) => ({ id: `y${i}`, node: transition(i, 0) })),
        arcs: [],
    };
    // the ids pasteInto used to take: freshId from 0 for every node
    const ref = structuredClone(m);
    const expected: string[] = [];
    for (const [kind, prefix] of [["places", "p"], ["transitions", "t"]]) {
        for (const _ of clip[kind]) {
            const id = freshId(ref, prefix);
            ref[kind][id] = {};
            expected.push(id);
        }
    }
    assertEquals(expected, ["p1", "p4", "p6", "p7", "p8", "p9", "t0", "t2", "t5", "t6"]);
    // freshId's optional start: the first free id at or above it
    assertEquals(freshId(m, "p", 2), "p4");
    assertEquals(freshId(m, "t", 0), "t0");
    assertEquals(freshId(m, "t", 4), "t5");
    assertEquals(pasteInto(m, clip), expected);
});

Deno.test("a 20,000-place paste does not rescan from p0 for every node", () => {
    const clip = { places: Array.from({ length: 20000 }, (_, i) => ({ id: `n${i}`, node: place(i, 0) })), transitions: [], arcs: [] };
    const model = emptyNet();
    const start = performance.now();
    const newIds = pasteInto(model, clip);
    const ms = performance.now() - start;
    assertEquals(newIds.length, 20000);
    assertEquals(newIds[19999], "p19999");
    assert(ms < 5000, `${ms.toFixed(0)} ms`); // the scan from 0 per node took about 30 s
});

// ---------------- token colors ----------------
// pflow-native's edit.paste resizes initial, capacity and weight to the target
// net's colors (Vec::resize(ncol, 0.0)); the web paste does the same, so a clip
// from a net with other colors still pastes as a well-formed net.

const RED = "https://pflow.xyz/tokens/red", BLUE = "https://pflow.xyz/tokens/blue";
const redBlueNet = (): any => normalizeModel({ token: [RED, BLUE] });

/** p --> t --> q copied from a red/blue net. */
function redBlueClip(): any {
    const m: any = {
        token: [RED, BLUE],
        places: {
            p: place(100, 100, { initial: [1, 2], capacity: [3, Infinity] }),
            q: place(300, 100, { initial: [0, 4], capacity: [Infinity, 5] }),
        },
        transitions: { t: transition(200, 100, { rate: 1.5 }) },
        arcs: [arc("p", "t", { weight: [1, 1] }), arc("t", "q", { weight: [2, 0] })],
    };
    return copySelection(m, ["p", "t", "q"]);
}

/** What the editor's Check net validates: the model as JSON. */
const check = (model: any) => validateNet(JSON.parse(JSON.stringify(model)));

Deno.test("declaredColors: the token list's length, at least 1", () => {
    assertEquals(declaredColors(emptyNet()), 1);
    assertEquals(declaredColors({ token: [RED, BLUE] }), 2);
    assertEquals(declaredColors({ token: [] }), 1);
    assertEquals(declaredColors({}), 1);
    assertEquals(declaredColors(null), 1);
});

Deno.test("copy keeps the source net's token list on the clip", () => {
    assertEquals(redBlueClip().token, [RED, BLUE]);
    assert(!Object.hasOwn(copySelection(sir(), ["S"])!, "token")); // no list in the net, none on the clip
});

Deno.test("a red/blue clip pasted into a black net is cut to one color and validates clean", () => {
    const model = emptyNet(); // one black token
    const newIds = pasteInto(model, redBlueClip());
    assertEquals(newIds, ["p0", "p1", "t0"]);
    assertEquals(model.places.p0.initial, [1]);
    assertEquals(model.places.p0.capacity, [3]);
    assertEquals(model.places.p1.initial, [0]);
    assertEquals(model.places.p1.capacity, [Infinity]);
    assertEquals(model.arcs.map((a: any) => a.weight), [[1], [2]]);
    normalizeModel(model); // what _pasteClip does next
    const report = check(model);
    assertEquals(report.errors, []);
    assertEquals(report.warnings, []); // no "has 2 components but the net declares 1 token color"
});

Deno.test("a black clip pasted into a two-color net is padded with 0", () => {
    const { clip } = clipFromText(clipV1Text()) as any;
    const model = redBlueNet();
    pasteInto(model, clip);
    assertEquals(model.places.p0.initial, [2, 0]);
    assertEquals(model.places.p0.capacity, [0, 0]); // 0 is unbounded, as in the clip
    assertEquals(model.arcs.map((a: any) => a.weight), [[1, 0], [1, 0]]); // red only, as black was
    normalizeModel(model);
    assertEquals(model.places.p0.capacity, [Infinity, Infinity]);
    const report = check(model);
    assertEquals(report.errors, []);
    assertEquals(report.warnings, []);
});

Deno.test("bare and null vectors are read as normalizeModel reads them before the resize; missing ones stay missing", () => {
    const clip: any = {
        places: [
            { id: "a", node: { x: 0, y: 0, initial: 3, capacity: null } },
            { id: "b", node: { x: 0, y: 0 } },
        ],
        transitions: [{ id: "t", node: { x: 0, y: 0 } }],
        arcs: [
            { source: "a", target: "t", weight: 2 },
            { source: "t", target: "b", weight: null }, // null reads as 1, not as a padded null (0)
            { source: "b", target: "t", weight: 0, inhibitTransition: true }, // a bare 0 reads as 1
            { source: "t", target: "a" },
        ],
    };
    const model = redBlueNet();
    pasteInto(model, clip, { dx: 0, dy: 0 });
    assertEquals(model.places.p0.initial, [3, 0]);
    assertEquals(model.places.p0.capacity, [null, 0]);
    assert(!Object.hasOwn(model.places.p1, "initial") && !Object.hasOwn(model.places.p1, "capacity"));
    assertEquals(model.arcs.map((a: any) => a.weight), [[2, 0], [1, 0], [1, 0], undefined]);
    normalizeModel(model);
    assertEquals(model.places.p0.capacity, [Infinity, Infinity]);
    assertEquals(model.arcs[3].weight, [1]);
    assertEquals(check(model).errors, []);
});

Deno.test("colorMappingNote: a status line when the clip's token colors are not the net's", () => {
    const note = colorMappingNote(redBlueClip(), emptyNet());
    assert(note && /mapped by position/.test(note) && /red, blue/.test(note) && /black/.test(note), String(note));
    assert(colorMappingNote((clipFromText(clipV1Text()) as any).clip, redBlueNet()));
    assert(colorMappingNote({ token: [BLUE, RED] }, { token: [RED, BLUE] })); // the same colors in another order: still by position
    assertEquals(colorMappingNote(redBlueClip(), { token: [RED, BLUE] }), null);
    assertEquals(colorMappingNote(copySelection(sir(), ["S"]), emptyNet()), null); // no list reads as black
    assertEquals(colorMappingNote({ token: [] }, emptyNet()), null);
    assertEquals(colorMappingNote({}, {}), null);
});

// ---------------- the system clipboard (docs/clipboard-format.md) ----------------
// parity/clipboard/clip-v1.json is the fixture pflow-native's tests read too,
// byte-identical in both repos; the spec names its sha256.

const CLIP_V1_SHA256 = "ba8ff2db4b2dca16baa83bbe9c35145ea99e0887d4512a68e8b1a0ef5d146276";
const clipV1Url = new URL("../parity/clipboard/clip-v1.json", import.meta.url);
const clipV1Text = () => Deno.readTextFileSync(clipV1Url);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const ids = (entries: any[]) => entries.map((e: any) => e.id);
const ends = (arcs: any[]) => arcs.map((a: any) => [a.source, a.target]);
const emptyNet = (): any => normalizeModel({});
const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("clip-v1.json is the spec's fixture, byte for byte", async () => {
    assertEquals(await sha256Hex(Deno.readFileSync(clipV1Url)), CLIP_V1_SHA256);
});

Deno.test("clip-v1.json parses as a version 1 clip", () => {
    const read = clipFromText(clipV1Text()) as any;
    assertEquals(read.kind, "clip");
    assertEquals(read.origin, "pflow.xyz");
    assertEquals(ids(read.clip.places), ["Queue", "Done"]);
    assertEquals(ids(read.clip.transitions), ["Serve"]);
    assertEquals(ends(read.clip.arcs), [["Queue", "Serve"], ["Serve", "Done"]]);
    assertEquals(read.clip.transitions[0].node.rate, 2.5);
    assertEquals(read.clip.token, ["https://pflow.xyz/tokens/black"]); // kept, for colorMappingNote
});

Deno.test("clip-v1.json pasted into an empty net: 2 places, 1 transition at rate 2.5, 2 arcs, fresh ids", () => {
    const { clip } = clipFromText(clipV1Text()) as any;
    const { model, newIds } = pasteClip(emptyNet(), clip);
    assertEquals(newIds, ["p0", "p1", "t0"]);
    assertEquals(Object.keys(model.places), ["p0", "p1"]);
    assertEquals(Object.keys(model.transitions), ["t0"]);
    for (const id of ["Queue", "Done", "Serve"]) {
        assert(!Object.hasOwn(model.places, id) && !Object.hasOwn(model.transitions, id), `${id} must not survive the paste`);
    }
    assertEquals(model.transitions.t0.rate, 2.5);
    assertEquals(model.transitions.t0.label, "Serve");
    assertEquals(model.places.p0.label, "Queue");
    assertEquals(model.places.p0.initial, [2]);
    assertEquals([model.places.p0.x, model.places.p0.y], [140, 160]); // (100, 120) + (40, 40)
    assertEquals([model.transitions.t0.x, model.transitions.t0.y], [240, 160]);
    assertEquals(ends(model.arcs), [["p0", "t0"], ["t0", "p1"]]);
});

Deno.test("Copy of the pasted fixture parses back to the same nodes and arcs", () => {
    const { clip } = clipFromText(clipV1Text()) as any;
    const { model, newIds } = pasteClip(emptyNet(), clip);
    const text = clipToText(copySelection(model, newIds)!, { token: model.token });
    const back = clipFromText(text) as any;
    assertEquals(back.kind, "clip");
    assertEquals(back.clip.places, [{ id: "p0", node: model.places.p0 }, { id: "p1", node: model.places.p1 }]);
    assertEquals(back.clip.transitions, [{ id: "t0", node: model.transitions.t0 }]);
    assertEquals(back.clip.arcs, model.arcs);
    // and the same as the fixture's nodes, moved by the paste offset
    for (const [i, { node }] of back.clip.places.entries()) {
        const src = clip.places[i].node;
        assertEquals({ ...node, x: node.x - 40, y: node.y - 40 }, src);
    }
});

Deno.test("the same round trip through the editor's normalizeModel (capacity 0 -> Infinity -> 0)", () => {
    const { clip } = clipFromText(clipV1Text()) as any;
    const { model, newIds } = pasteClip(emptyNet(), clip);
    normalizeModel(model); // what _pasteClip does after pasteInto
    assertEquals(model.places.p0.capacity, [Infinity]);
    const text = clipToText(copySelection(model, newIds)!, { token: model.token });
    assert(text.includes('"capacity": [\n        0\n      ]'), "unbounded capacity is written as 0, as the fixture and pflow-native write it");
    assert(!text.includes("null"), text);
    const back = clipFromText(text) as any;
    const again = pasteClip(emptyNet(), back.clip, { dx: 0, dy: 0 }).model;
    normalizeModel(again);
    assertEquals(again.places, model.places);
    assertEquals(again.transitions, model.transitions);
    assertEquals(again.arcs, model.arcs);
});

Deno.test("clipToText reproduces clip-v1.json byte for byte from its own clip", () => {
    const text = clipV1Text();
    const { clip } = clipFromText(text) as any;
    assertEquals(clipToText(clip, { token: JSON.parse(text).token }), text);
    assertEquals(clipToText(clip), text); // the clip's own token list is the default
});

Deno.test("Copy of the pasted fixture writes capacity [0], as the fixture and pflow-native do", () => {
    const fixture = JSON.parse(clipV1Text());
    const { clip } = clipFromText(clipV1Text()) as any;
    const { model, newIds } = pasteClip(emptyNet(), clip, { dx: 0, dy: 0 });
    normalizeModel(model); // as _pasteClip does: capacity [0] becomes [Infinity] in the editor
    assertEquals(model.places.p0.capacity, [Infinity]);
    const doc = JSON.parse(clipToText(copySelection(model, newIds)!));
    assertEquals(doc.places.p0.capacity, [0]);
    assertEquals(doc.places.p1.capacity, [0]);
    // the whole Copy is the fixture under the fresh ids
    assertEquals(doc, {
        ...fixture,
        places: { p0: fixture.places.Queue, p1: fixture.places.Done },
        transitions: { t0: fixture.transitions.Serve },
        arcs: [{ ...fixture.arcs[0], source: "p0", target: "t0" }, { ...fixture.arcs[1], source: "t0", target: "p1" }],
    });
    // a bare unbounded capacity too, and a bounded one is kept
    const bare = JSON.parse(clipToText({ places: [{ id: "a", node: place(0, 0, { capacity: null }) }, { id: "b", node: place(0, 0, { capacity: [Infinity, 4, null] }) }], transitions: [], arcs: [] }));
    assertEquals(bare.places.a.capacity, 0);
    assertEquals(bare.places.b.capacity, [0, 4, 0]);
});

Deno.test("serialised text: a PetriNet document with pflowClip {version 1, origin pflow.xyz} and no @id", () => {
    const m = sir();
    const text = clipToText(copySelection(m, ["S", "infect", "I"])!);
    const doc = JSON.parse(text);
    assertEquals(doc["@context"], "https://pflow.xyz/schema");
    assertEquals(doc["@type"], "PetriNet");
    assertEquals(doc["@version"], "1.1");
    assertEquals(doc.pflowClip, { version: 1, origin: "pflow.xyz" });
    assertEquals([CLIP_VERSION, CLIP_ORIGIN], [1, "pflow.xyz"]);
    assert(!Object.hasOwn(doc, "@id"), "a clip is not sealed");
    assertEquals(doc.token, ["https://pflow.xyz/tokens/black"]); // default when the net names none
    assertEquals(Object.keys(doc.places), ["S", "I"]);
    assertEquals(doc.transitions.infect, { "@type": "Transition", x: 200, y: 100, label: "infect", rate: 0.3 });
    assertEquals(ends(doc.arcs), [["S", "infect"], ["I", "infect"], ["infect", "I"]]);
    // the source net's token list travels
    const colored = JSON.parse(clipToText(copySelection(m, ["S"])!, { token: ["https://pflow.xyz/tokens/red", "https://pflow.xyz/tokens/blue"] }));
    assertEquals(colored.token, ["https://pflow.xyz/tokens/red", "https://pflow.xyz/tokens/blue"]);
});

Deno.test("Copy of only one end of an arc leaves the arc out of the text", () => {
    const m = sir();
    const doc = JSON.parse(clipToText(copySelection(m, ["infect", "recover"])!));
    assertEquals(doc.arcs, []);
});

Deno.test("parse drops arcs whose source or target is not in the clip, and arcs that are not objects", () => {
    const text = JSON.stringify({
        "@context": "https://pflow.xyz/schema", "@type": "PetriNet", pflowClip: { version: 1, origin: "pflow-native" },
        places: { a: place(0, 0) }, transitions: { t: transition(10, 0) },
        arcs: [arc("a", "t"), arc("t", "gone"), arc("gone", "a"), null, 7, arc("t", "a")],
    });
    const read = clipFromText(text) as any;
    assertEquals(read.kind, "clip");
    assertEquals(read.origin, "pflow-native");
    assertEquals(ends(read.clip.arcs), [["a", "t"], ["t", "a"]]);
    const { model } = pasteClip(emptyNet(), read.clip);
    assertEquals(model.arcs.length, 2);
});

Deno.test("a pflowClip version above 1 is refused, with a message, and nothing is pasted", () => {
    const doc = JSON.parse(clipV1Text());
    doc.pflowClip.version = 2;
    const read = clipFromText(JSON.stringify(doc)) as any;
    assertEquals(read.kind, "refused");
    assertEquals(read.version, 2);
    assert(/version 2/.test(read.message) && /version 1/.test(read.message), read.message);
    // the in-memory clip is NOT used instead: a refusal is a status, not a fallback
    const memory = copySelection(sir(), ["S"]);
    const pick = choosePaste(JSON.stringify(doc), memory);
    assertEquals(pick.clip, null);
    assertEquals(pick.refusal, read.message);
});

Deno.test("a plain pflow PetriNet document (no pflowClip) pastes as a whole-net clip", () => {
    const text = Deno.readTextFileSync(new URL("../parity/fixtures/with-rates.jsonld", import.meta.url));
    const net = JSON.parse(text);
    const read = clipFromText(text) as any;
    assertEquals(read.kind, "clip");
    assertEquals(read.origin, null);
    assertEquals(ids(read.clip.places), Object.keys(net.places));
    assertEquals(ids(read.clip.transitions), Object.keys(net.transitions));
    assertEquals(read.clip.arcs.length, net.arcs.length);
    assertEquals(read.clip.transitions[1].node.rate, 0.25);
    // a sealed one (top-level @id) too; the @id is ignored
    const sealed = clipFromText(JSON.stringify({ "@id": "zSomething", ...net })) as any;
    assertEquals(sealed.kind, "clip");
    assertEquals(choosePaste(text, null).from, "system");
    // a minimal one, no @context
    const bare = clipFromText(JSON.stringify({ "@type": "PetriNet", places: { a: place(1, 2) } })) as any;
    assertEquals(bare.kind, "clip");
    assertEquals(ids(bare.clip.places), ["a"]);
    assertEquals(bare.clip.transitions, []);
});

Deno.test("anything else is not a clip, and Paste falls back to the in-memory clip", () => {
    const memory = copySelection(sir(), ["S"]);
    const notClips: unknown[] = [
        null, undefined, "", "   ", "hello", "{not json", "[1, 2]", "42", '"text"', "null",
        JSON.stringify({ hello: "world" }),
        JSON.stringify({ "@type": "Thing", places: {} }),
        JSON.stringify({ "@context": "https://example.com/other", "@type": "PetriNet", places: {} }),
        JSON.stringify({ pflowClip: { version: 0 }, places: {} }),
        JSON.stringify({ pflowClip: { version: "1" }, places: {} }),
        JSON.stringify({ pflowClip: 1, places: {} }),
        JSON.stringify({ pflowClip: { version: 1 }, places: [] }),
        JSON.stringify({ pflowClip: { version: 1 }, places: { a: 3 } }),
        JSON.stringify({ pflowClip: { version: 1 }, transitions: { t: null } }),
        JSON.stringify({ "@type": "PetriNet", arcs: {} }),
        42,
    ];
    for (const t of notClips) {
        assertEquals((clipFromText(t) as any).kind, "none", String(t));
        const pick = choosePaste(t, memory);
        assertEquals(pick.from, "memory", String(t));
        assertEquals(pick.clip, memory);
    }
    assertEquals(choosePaste("hello", null), { clip: null, from: null });
    assertEquals(choosePaste(null, null), { clip: null, from: null });
});

Deno.test("a clip on the system clipboard wins over the in-memory one", () => {
    const memory = copySelection(sir(), ["R"]);
    const pick = choosePaste(clipV1Text(), memory) as any;
    assertEquals(pick.from, "system");
    assertEquals(ids(pick.clip.places), ["Queue", "Done"]);
});

Deno.test("an empty clip or net on the system clipboard is nothing to paste, so the buffer is used", () => {
    const memory = copySelection(sir(), ["S"]);
    const empties = [
        JSON.stringify({ pflowClip: { version: 1, origin: "pflow-native" }, token: [], places: {}, transitions: {}, arcs: [] }),
        clipToText({ places: [], transitions: [], arcs: [] }),
        JSON.stringify(emptyNet()), // a plain empty net
        JSON.stringify({ "@type": "PetriNet" }),
    ];
    for (const t of empties) {
        assertEquals((clipFromText(t) as any).kind, "none", t);
        assertEquals(choosePaste(t, memory), { clip: memory, from: "memory" });
    }
    // one transition is not empty
    assertEquals((clipFromText(JSON.stringify({ pflowClip: { version: 1 }, transitions: { t: transition(0, 0) } })) as any).kind, "clip");
});

Deno.test("choosePaste with preferMemory: the buffer wins over whatever the system clipboard holds", () => {
    const memory = copySelection(sir(), ["R"]);
    const v2 = JSON.parse(clipV1Text());
    v2.pflowClip.version = 2;
    for (const t of [clipV1Text(), JSON.stringify(v2), "text", null]) {
        assertEquals(choosePaste(t, memory, { preferMemory: true }), { clip: memory, from: "memory" });
    }
    // with no buffer the system clipboard is read as usual
    assertEquals(choosePaste(clipV1Text(), null, { preferMemory: true }).from, "system");
    const refused = choosePaste(JSON.stringify(v2), null, { preferMemory: true });
    assertEquals(refused.clip, null);
    assert(refused.refusal);
});

Deno.test("integer-like ids keep their written order, in and out", () => {
    // JS would enumerate {"b", "10", "2", "a"} as 2, 10, b, a, so the text is
    // written by hand (JSON.stringify of an object would reorder it first)
    const P = (x: number) => JSON.stringify(place(x, 0));
    const T = (x: number) => JSON.stringify(transition(x, 9));
    const text = `{"pflowClip":{"version":1,"origin":"pflow-native"},` +
        `"places":{"b":${P(0)},"10":${P(1)},"2":${P(2)},"a":${P(3)}},` +
        `"transitions":{"9":${T(0)},"t":${T(1)},"1":${T(2)}},"arcs":[]}`;
    assertEquals(Object.keys(JSON.parse(text).places), ["2", "10", "b", "a"]); // what JSON.parse alone would give
    const read = clipFromText(text) as any;
    assertEquals(ids(read.clip.places), ["b", "10", "2", "a"]);
    assertEquals(ids(read.clip.transitions), ["9", "t", "1"]);
    // paste numbers them in that order: b -> p0 (x 0), 10 -> p1 (x 1), 2 -> p2 (x 2)
    const { model } = pasteClip(emptyNet(), read.clip, { dx: 0, dy: 0 });
    assertEquals([model.places.p0.x, model.places.p1.x, model.places.p2.x, model.places.p3.x], [0, 1, 2, 3]);
    assertEquals([model.transitions.t0.x, model.transitions.t1.x, model.transitions.t2.x], [0, 1, 2]);
    // and the writer keeps clip order rather than JS's
    const out = clipToText(read.clip);
    assertEquals(ids((clipFromText(out) as any).clip.places), ["b", "10", "2", "a"]);
    assert(out.indexOf('"b": {') < out.indexOf('"10": {') && out.indexOf('"10": {') < out.indexOf('"2": {'), out);
});

Deno.test("order scan copes with escapes, nested objects and a repeated member", () => {
    const text = `{"pflowClip":{"version":1},"places":{"q\\"1":{"label":"a \\"}\\" b","nested":{"2":{}}},"3":{},"x":{}},` +
        `"transitions":{},"places":{"9":{"x":9},"z":{"x":0}},"arcs":[]}`;
    const read = clipFromText(text) as any;
    // JSON.parse keeps the last "places"; its order is 9, z
    assertEquals(ids(read.clip.places), ["9", "z"]);
    const one = clipFromText(`{"pflowClip":{"version":1},"places":{"q\\"1":{"label":"a \\"}\\" b","nested":{"2":{}}},"3":{},"x":{}}}`) as any;
    assertEquals(ids(one.clip.places), ['q"1', "3", "x"]);
});

Deno.test("clipboardShortcut: Ctrl (Cmd on a Mac) with C/X/V/D, never while typing, never with Alt or Shift", () => {
    const pc = { mac: false }, mac = { mac: true };
    assertEquals(clipboardShortcut({ key: "c", ctrlKey: true }, pc), "copy");
    assertEquals(clipboardShortcut({ key: "C", metaKey: true }, mac), "copy");
    assertEquals(clipboardShortcut({ key: "x", ctrlKey: true }, pc), "cut");
    assertEquals(clipboardShortcut({ key: "v", metaKey: true }, mac), "paste");
    assertEquals(clipboardShortcut({ key: "d", ctrlKey: true }, pc), "duplicate");
    assertEquals(clipboardShortcut({ key: "c", ctrlKey: true }, { ...pc, typing: true }), null);
    assertEquals(clipboardShortcut({ key: "v", ctrlKey: true }, { ...pc, typing: true }), null);
    assertEquals(clipboardShortcut({ key: "v", metaKey: true }, { ...mac, typing: true }), null);
    assertEquals(clipboardShortcut({ key: "v", ctrlKey: true, shiftKey: true }, pc), null);
    assertEquals(clipboardShortcut({ key: "c", ctrlKey: true, altKey: true }, pc), null);
    assertEquals(clipboardShortcut({ key: "c" }, pc), null);
    assertEquals(clipboardShortcut({ key: "c" }, mac), null);
    assertEquals(clipboardShortcut({ key: "z", ctrlKey: true }, pc), null);
    assertEquals(clipboardShortcut({ ctrlKey: true }, pc), null);
    assertEquals(clipboardShortcut(null as any), null);
});

Deno.test("clipboardShortcut: on a Mac only Cmd is the clipboard modifier, elsewhere only Ctrl", () => {
    // Ctrl+C on a Mac fires no copy event; arming for it would end in a navigator.clipboard read prompt
    for (const key of ["c", "x", "v", "d"]) {
        assertEquals(clipboardShortcut({ key, ctrlKey: true }, { mac: true }), null, `Ctrl+${key} on a Mac`);
        assertEquals(clipboardShortcut({ key, metaKey: true }, { mac: false }), null, `Meta+${key} off a Mac`);
        assertEquals(clipboardShortcut({ key, ctrlKey: true, metaKey: true }, { mac: true }), null);
        assertEquals(clipboardShortcut({ key, ctrlKey: true, metaKey: true }, { mac: false }), null);
    }
    // the default comes from the platform this runs on
    assertEquals(clipboardShortcut({ key: "c", ctrlKey: true }), usesCommandKey() ? null : "copy");
});

Deno.test("usesCommandKey: macOS, iPhone and iPad (which reports MacIntel) use Cmd; the rest Ctrl", () => {
    assert(usesCommandKey({ platform: "MacIntel" }));
    assert(usesCommandKey({ platform: "iPhone" }));
    assert(usesCommandKey({ platform: "iPad" }));
    assert(usesCommandKey({ userAgentData: { platform: "macOS" }, platform: "" }));
    assert(!usesCommandKey({ platform: "Win32" }));
    assert(!usesCommandKey({ platform: "Linux x86_64" }));
    assert(!usesCommandKey({ userAgentData: { platform: "Windows" }, platform: "Win32" }));
    assert(!usesCommandKey({ userAgentData: { platform: "Android" } }));
    assert(!usesCommandKey({}));
    assert(!usesCommandKey(undefined));
    assertEquals(usesCommandKey(), false); // Deno reports Linux here, as CI does
});

Deno.test("clipboardShortcut: selected text on the page keeps Ctrl+C and Ctrl+X for the browser", () => {
    // a dialog or the Assistant panel (appended to document.body) with text selected: that is what Ctrl+C copies
    const sel = { textSelected: true, mac: false };
    assertEquals(clipboardShortcut({ key: "c", ctrlKey: true }, sel), null);
    assertEquals(clipboardShortcut({ key: "x", ctrlKey: true }, sel), null);
    assertEquals(clipboardShortcut({ key: "c", metaKey: true }, { textSelected: true, mac: true }), null);
    // paste and duplicate do not copy anything over it
    assertEquals(clipboardShortcut({ key: "v", ctrlKey: true }, sel), "paste");
    assertEquals(clipboardShortcut({ key: "d", ctrlKey: true }, sel), "duplicate");
    // and the keydown's view of the page selection
    assert(hasTextSelection({ rangeCount: 1, isCollapsed: false }));
    assert(!hasTextSelection({ rangeCount: 1, isCollapsed: true })); // a caret, nothing selected
    assert(!hasTextSelection({ rangeCount: 0, isCollapsed: true }));
    assert(!hasTextSelection(null));
    assert(!hasTextSelection(undefined));
    assert(!hasTextSelection({ get rangeCount(): number { throw new Error("gone"); } }));
});

Deno.test("clipboardShortcut: a key aimed at an input inside a shadow root is the input's", () => {
    // document.activeElement stops at the shadow host, so the keydown's typing check misses it;
    // composedPath()[0] is the input, and Ctrl+X must not cut nodes there
    const inShadow = (key: string) => ({
        key, ctrlKey: true, target: { tagName: "HOST-WIDGET" },
        composedPath: () => [{ tagName: "INPUT" }, { tagName: "HOST-WIDGET" }],
    });
    for (const key of ["c", "x", "v", "d"]) assertEquals(clipboardShortcut(inShadow(key), { mac: false }), null, key);
    const editable = { key: "x", ctrlKey: true, composedPath: () => [{ tagName: "DIV", isContentEditable: true }] };
    assertEquals(clipboardShortcut(editable, { mac: false }), null);
    // the canvas itself is not editable
    assertEquals(clipboardShortcut({ key: "x", ctrlKey: true, composedPath: () => [{ tagName: "DIV" }] }, { mac: false }), "cut");
});

Deno.test("editableTarget: inputs, textareas and contenteditables, looking through shadow roots", () => {
    assert(editableTarget({ target: { tagName: "INPUT" } }));
    assert(editableTarget({ target: { tagName: "TEXTAREA" } }));
    assert(editableTarget({ target: { tagName: "DIV", isContentEditable: true } }));
    assert(!editableTarget({ target: { tagName: "BODY", isContentEditable: false } }));
    assert(!editableTarget({ target: { tagName: "PETRI-VIEW" } }));
    // a shadow host is the target at document level; composedPath()[0] is the real one
    assert(editableTarget({ target: { tagName: "MY-WIDGET" }, composedPath: () => [{ tagName: "INPUT" }, { tagName: "MY-WIDGET" }] }));
    assert(!editableTarget({ target: { tagName: "INPUT" }, composedPath: () => [{ tagName: "SPAN" }] }));
    assert(editableTarget({ target: { tagName: "INPUT" }, composedPath: () => { throw new Error("detached"); } }));
    assert(!editableTarget({}));
    assert(!editableTarget(null));
});

Deno.test("the shortcut waits a moment for the ClipboardEvent, inside the keystroke's activation", () => {
    // > 0: macOS delivers Cmd+C/V's ClipboardEvent a task after the keydown
    assert(CLIPBOARD_EVENT_WAIT_MS > 0 && CLIPBOARD_EVENT_WAIT_MS < 1000, String(CLIPBOARD_EVENT_WAIT_MS));
});

function fakeClipboardEvent(text = "") {
    const data = new Map<string, string>([["text/plain", text]]);
    return {
        prevented: false,
        clipboardData: { setData: (t: string, v: string) => data.set(t, v), getData: (t: string) => data.get(t) ?? "" },
        preventDefault() { this.prevented = true; },
        data,
    };
}

Deno.test("writeClipboardText: a copy/cut event gets the text in clipboardData and is cancelled", () => {
    const e = fakeClipboardEvent();
    const api = { calls: 0, writeText() { this.calls++; return Promise.resolve(); } };
    assertEquals(writeClipboardText("clip", { event: e, clipboard: api }), "event");
    assertEquals(e.data.get("text/plain"), "clip");
    assert(e.prevented);
    assertEquals(api.calls, 0); // the event route needs no Clipboard API
});

Deno.test("writeClipboardText: without an event, navigator.clipboard.writeText; a rejection stays quiet", async () => {
    const written: string[] = [];
    assertEquals(writeClipboardText("a", { clipboard: { writeText: (t: string) => { written.push(t); return Promise.resolve(); } } }), "api");
    assertEquals(written, ["a"]);
    // denied: no unhandled rejection (Deno fails the test if there is one)
    assertEquals(writeClipboardText("b", { clipboard: { writeText: () => Promise.reject(new Error("NotAllowedError")) } }), "api");
    await new Promise((r) => setTimeout(r, 0));
    // throws synchronously, missing, or no writeText: nothing happens
    assertEquals(writeClipboardText("c", { clipboard: { writeText: () => { throw new Error("boom"); } } }), "none");
    assertEquals(writeClipboardText("d", { clipboard: undefined }), "none");
    assertEquals(writeClipboardText("e", { clipboard: {} }), "none");
    // an event without clipboardData falls through to the API
    assertEquals(writeClipboardText("f", { event: { preventDefault() {} } as any, clipboard: { writeText: () => Promise.resolve() } }), "api");
});

Deno.test("writeClipboardText tells done whether the text got there", async () => {
    const heard: boolean[] = [];
    const done = (ok: boolean) => { heard.push(ok); };
    writeClipboardText("a", { event: fakeClipboardEvent(), done });
    assertEquals(heard, [true]); // the event route, at once
    writeClipboardText("b", { event: { clipboardData: { setData() { throw new Error("no"); } }, preventDefault() {} } as any, done });
    writeClipboardText("c", { clipboard: undefined, done });
    writeClipboardText("d", { clipboard: { writeText: () => { throw new Error("boom"); } }, done });
    assertEquals(heard, [true, false, false, false]);
    writeClipboardText("e", { clipboard: { writeText: () => Promise.resolve() }, done });
    writeClipboardText("f", { clipboard: { writeText: () => Promise.reject(new Error("NotAllowedError")) }, done });
    assertEquals(heard.length, 4); // the API route settles later
    await tick();
    assertEquals(heard.slice(4), [true, false]);
});

Deno.test("writeClipboardText and readClipboardText work where there is no navigator.clipboard (Deno, a headless host)", async () => {
    assertEquals((globalThis as any).navigator?.clipboard, undefined);
    assertEquals(writeClipboardText("x"), "none");
    assertEquals(await readClipboardText(), null);
});

Deno.test("clipboardEventText reads a paste event's text/plain; null without clipboardData", () => {
    assertEquals(clipboardEventText(fakeClipboardEvent(clipV1Text())), clipV1Text());
    assertEquals(clipboardEventText({}), null);
    assertEquals(clipboardEventText(null), null);
    assertEquals(clipboardEventText({ clipboardData: { getData: () => { throw new Error("gone"); } } }), null);
});

Deno.test("readClipboardText: the API's text, or null when denied or not a string", async () => {
    assertEquals(await readClipboardText({ clipboard: { readText: () => Promise.resolve("t") } }), "t");
    assertEquals(await readClipboardText({ clipboard: { readText: () => Promise.reject(new Error("denied")) } }), null);
    assertEquals(await readClipboardText({ clipboard: { readText: () => Promise.resolve(5) } }), null);
    assertEquals(await readClipboardText({ clipboard: {} }), null);
});

Deno.test("the editor's paste path end to end: paste event text -> choosePaste -> pasteInto", () => {
    // what _onClipboardEvent + _pasteText + _pasteClip do, minus the DOM
    const e = fakeClipboardEvent(clipV1Text());
    const model = emptyNet();
    const pick = choosePaste(clipboardEventText(e), null);
    const newIds = pasteInto(model, pick.clip);
    assertEquals(newIds, ["p0", "p1", "t0"]);
    // and the copy path: copySelection -> clipToText -> clipboardData
    const out = fakeClipboardEvent();
    writeClipboardText(clipToText(copySelection(model, newIds)!, { token: model.token }), { event: out });
    const back = clipFromText(out.data.get("text/plain")) as any;
    assertEquals(ids(back.clip.places), ["p0", "p1"]);
    assertEquals(back.clip.transitions[0].node.rate, 2.5);
});

// ---------------- the <petri-view> glue, without a DOM ----------------
// petri-view.js defines its class only where HTMLElement exists; a bare shim is
// enough to reach the real prototype methods (each deno test module runs in its
// own worker, so the shim stays here). The instance skips the constructor,
// which reads window and localStorage, and stubs what draws or records history.

async function petriViewClass(): Promise<any> {
    const g = globalThis as any;
    g.HTMLElement ??= class {};
    g.customElements ??= { define() {} };
    return (await import("./petri-view.js")).PetriView;
}

const stubViews: any[] = [];

async function stubView(model: any = emptyNet()) {
    const PetriView = await petriViewClass();
    const v: any = Object.create(PetriView.prototype);
    stubViews.push(v);
    Object.defineProperty(v, "isConnected", { value: true, configurable: true });
    Object.assign(v, {
        _model: model, _mode: "select", _selectedNodes: new Set(), _clipboard: null, _clipArms: {},
        toasts: [] as string[], deleted: [] as string[][], history: 0,
        _pushHistory() { this.history++; }, _scheduleSync() {}, _scheduleRender() {},
        _toast(msg: string) { this.toasts.push(msg); },
        _deleteNodes(ids: string[]) {
            this.deleted.push(ids);
            for (const id of ids) { delete this._model.places[id]; delete this._model.transitions[id]; }
            this._model.arcs = this._model.arcs.filter((a: any) => !ids.includes(a.source) && !ids.includes(a.target));
        },
        _clearSelection() { this._selectedNodes = new Set(); },
    });
    return v;
}

function clipboardEvent(type: string, text = "", extra: Record<string, unknown> = {}) {
    return { type, ...fakeClipboardEvent(text), ...extra };
}

/** Run `fn` with navigator.clipboard set to `fake`, then put it back. */
async function withNavigatorClipboard(fake: unknown, fn: () => Promise<void>) {
    const nav = (globalThis as any).navigator;
    Object.defineProperty(nav, "clipboard", { value: fake, configurable: true });
    try {
        await fn();
    } finally {
        delete nav.clipboard;
    }
}

const waitPastArm = () => new Promise((r) => setTimeout(r, CLIPBOARD_EVENT_WAIT_MS + 50));

Deno.test("view: Ctrl+C arms, and the copy event gets the clip text (no navigator.clipboard needed)", async () => {
    const v = await stubView(sir());
    v._selectedNodes = new Set(["S", "infect", "I"]);
    assert(v._copySelection({ shortcut: true }));
    assertEquals(ids(v._clipboard.places), ["S", "I"]); // the in-memory buffer is filled at once
    const e = clipboardEvent("copy");
    v._onClipboardEvent(e);
    assert(e.prevented);
    const back = clipFromText(e.data.get("text/plain")) as any;
    assertEquals(back.origin, "pflow.xyz");
    assertEquals(ids(back.clip.places), ["S", "I"]);
    assertEquals(ids(back.clip.transitions), ["infect"]);
    assertEquals(back.clip.arcs.length, 3);
    assertEquals(v._clipArms, {}); // claimed once; the fallback timer is cancelled
    // a second copy event, not armed, is left alone
    const other = clipboardEvent("copy");
    v._onClipboardEvent(other);
    assert(!other.prevented);
    assertEquals(other.data.get("text/plain"), "");
});

Deno.test("view: Ctrl+X cuts at once and the cut event carries the clip", async () => {
    const v = await stubView(sir());
    v._selectedNodes = new Set(["R"]);
    assert(v._cutSelection({ shortcut: true }));
    assertEquals(v.deleted, [["R"]]);
    assert(!Object.hasOwn(v._model.places, "R"));
    const copy = clipboardEvent("copy");
    v._onClipboardEvent(copy); // a copy event does not satisfy a cut
    assert(!copy.prevented);
    const cut = clipboardEvent("cut");
    v._onClipboardEvent(cut);
    assert(cut.prevented);
    assertEquals(ids((clipFromText(cut.data.get("text/plain")) as any).clip.places), ["R"]);
});

Deno.test("view: Ctrl+C with nothing selected arms nothing, so the browser's own copy goes ahead", async () => {
    const v = await stubView(sir());
    assert(!v._copySelection({ shortcut: true }));
    assertEquals(v._clipArms, {});
    const e = clipboardEvent("copy");
    v._onClipboardEvent(e);
    assert(!e.prevented);
});

Deno.test("view: Ctrl+V pastes the paste event's clip-v1.json: fresh ids, selected, one undo step", async () => {
    const v = await stubView();
    assert(v._pasteFromSystem({ shortcut: true }));
    const e = clipboardEvent("paste", clipV1Text());
    v._onClipboardEvent(e);
    assert(e.prevented);
    assertEquals(Object.keys(v._model.places), ["p0", "p1"]);
    assertEquals(Object.keys(v._model.transitions), ["t0"]);
    assertEquals(v._model.transitions.t0.rate, 2.5);
    assertEquals(v._model.arcs.length, 2);
    assertEquals([...v._selectedNodes], ["p0", "p1", "t0"]);
    assertEquals(v.history, 1);
    assertEquals(v._model.places.p0.capacity, [Infinity]); // normalized, as every paste is
    assertEquals(v._clipboard, null); // pasting from the system leaves the buffer as it was
});

Deno.test("view: a newer clip version is refused with a toast and pastes nothing, not even the buffer", async () => {
    // fill the buffer with a copy that reached the system clipboard, so the v2
    // clip there came later (after a FAILED write the buffer wins; see below)
    await withNavigatorClipboard({ writeText: () => Promise.resolve() }, async () => {
        const v = await stubView(sir());
        v._selectedNodes = new Set(["S"]);
        v._copySelection(); // fill the buffer (no shortcut: navigator.clipboard)
        await tick();
        assertEquals(v._systemClipStale, false);
        const doc = JSON.parse(clipV1Text());
        doc.pflowClip.version = 2;
        v._pasteFromSystem({ shortcut: true });
        const before = JSON.stringify(v._model);
        const e = clipboardEvent("paste", JSON.stringify(doc));
        v._onClipboardEvent(e);
        assert(!e.prevented);
        assertEquals(JSON.stringify(v._model), before);
        assertEquals(v.toasts.length, 1);
        assert(/version 2/.test(v.toasts[0]), v.toasts[0]);
    });
});

Deno.test("view: other text on the system clipboard pastes the in-memory buffer", async () => {
    const v = await stubView(sir());
    v._selectedNodes = new Set(["S"]);
    v._copySelection();
    v._pasteFromSystem({ shortcut: true });
    const e = clipboardEvent("paste", "just some text");
    v._onClipboardEvent(e);
    assert(e.prevented);
    assertEquals([...v._selectedNodes], ["p0"]);
    assertEquals(v._model.places.p0.label, "S");
    // nothing anywhere: nothing pasted and the event is not cancelled
    const empty = await stubView();
    empty._pasteFromSystem({ shortcut: true });
    const e2 = clipboardEvent("paste", "just some text");
    empty._onClipboardEvent(e2);
    assert(!e2.prevented);
    assertEquals(empty.history, 0);
});

Deno.test("view: a mode that cannot paste does not arm, so the paste event is not claimed", async () => {
    const v = await stubView();
    v._mode = "delete"; // no canGroupDrag
    assert(!v._pasteFromSystem({ shortcut: true }));
    const e = clipboardEvent("paste", clipV1Text());
    v._onClipboardEvent(e);
    assert(!e.prevented);
    assertEquals(Object.keys(v._model.places), []);
});

Deno.test("view: a ClipboardEvent aimed at an input is never claimed, and its fallback is dropped", async () => {
    const written: string[] = [];
    await withNavigatorClipboard({ writeText: (t: string) => { written.push(t); return Promise.resolve(); }, readText: () => Promise.resolve(clipV1Text()) }, async () => {
        const v = await stubView(sir());
        v._selectedNodes = new Set(["S"]);
        v._copySelection({ shortcut: true });
        const e = clipboardEvent("copy", "", { composedPath: () => [{ tagName: "INPUT" }] });
        v._onClipboardEvent(e);
        assert(!e.prevented);
        assertEquals(e.data.get("text/plain"), "");
        v._pasteFromSystem({ shortcut: true });
        const p = clipboardEvent("paste", clipV1Text(), { target: { tagName: "TEXTAREA" } });
        v._onClipboardEvent(p);
        assert(!p.prevented);
        await waitPastArm();
        assertEquals(written, []); // no fallback write
        assertEquals(Object.keys(v._model.places), ["S", "I", "R"]); // no fallback paste
    });
});

Deno.test("view: with no ClipboardEvent, copy falls back to navigator.clipboard.writeText", async () => {
    const written: string[] = [];
    await withNavigatorClipboard({ writeText: (t: string) => { written.push(t); return Promise.resolve(); } }, async () => {
        const v = await stubView(sir());
        v._selectedNodes = new Set(["S", "infect"]);
        v._copySelection({ shortcut: true });
        assertEquals(written, []); // not before the wait
        await waitPastArm();
        assertEquals(written.length, 1);
        assertEquals(ids((clipFromText(written[0]) as any).clip.places), ["S"]);
    });
});

Deno.test("view: with no ClipboardEvent, paste falls back to navigator.clipboard.readText", async () => {
    await withNavigatorClipboard({ readText: () => Promise.resolve(clipV1Text()) }, async () => {
        const v = await stubView();
        v._pasteFromSystem({ shortcut: true });
        await waitPastArm();
        assertEquals(Object.keys(v._model.places), ["p0", "p1"]);
        assertEquals(v._model.transitions.t0.rate, 2.5);
    });
    // and a denied read pastes the buffer
    await withNavigatorClipboard({ readText: () => Promise.reject(new Error("NotAllowedError")) }, async () => {
        const v = await stubView(sir());
        v._selectedNodes = new Set(["R"]);
        v._copySelection();
        v._pasteFromSystem();
        await new Promise((r) => setTimeout(r, 0));
        assertEquals([...v._selectedNodes], ["p0"]);
        assertEquals(v._model.places.p0.label, "R");
    });
});

Deno.test("view: duplicate touches neither the buffer nor the system clipboard", async () => {
    const written: string[] = [];
    await withNavigatorClipboard({ writeText: (t: string) => { written.push(t); return Promise.resolve(); } }, async () => {
        const v = await stubView(sir());
        v._selectedNodes = new Set(["R"]);
        v._copySelection();
        assertEquals(written.length, 1);
        const buffer = v._clipboard;
        v._selectedNodes = new Set(["S", "infect"]);
        assert(v._duplicateSelection());
        assertEquals(v._clipboard, buffer);
        assertEquals(written.length, 1);
        assertEquals(v._clipArms, {});
        assertEquals([...v._selectedNodes], ["p0", "t0"]);
    });
});

Deno.test("view: a red/blue clip pasted into a black net: one color, a toast that they were mapped by position", async () => {
    const v = await stubView(); // one black token
    v._pasteFromSystem({ shortcut: true });
    const e = clipboardEvent("paste", clipToText(redBlueClip()));
    v._onClipboardEvent(e);
    assert(e.prevented);
    assertEquals(v._model.places.p0.initial, [1]);
    assertEquals(v._model.places.p0.capacity, [3]);
    assertEquals(v._model.places.p1.capacity, [Infinity]);
    assertEquals(v._model.arcs.map((a: any) => a.weight), [[1], [2]]);
    assertEquals(check(v._model).warnings, []);
    assertEquals(v.history, 1);
    assertEquals(v.toasts.length, 1);
    assert(/mapped by position/.test(v.toasts[0]), v.toasts[0]);
    // copy and paste within one net says nothing
    v._selectedNodes = new Set(["p0"]);
    assert(v._duplicateSelection());
    v._copySelection();
    v._pasteText(null);
    assertEquals(v.toasts.length, 1);
});

Deno.test("view: after a failed system write Paste prefers the buffer, until a later write gets there", async () => {
    let deny = true;
    await withNavigatorClipboard({ writeText: () => (deny ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve()) }, async () => {
        const v = await stubView(sir());
        v._selectedNodes = new Set(["R"]);
        v._copySelection({ shortcut: true });
        // a copy event without clipboardData (setData unavailable) goes to writeText, which is denied
        v._onClipboardEvent({ type: "copy", preventDefault() {} });
        await tick();
        assertEquals(v._systemClipStale, true);
        // the system clipboard still holds an older pflow clip (clip-v1.json): the newer buffer wins
        v._pasteFromSystem({ shortcut: true });
        const e = clipboardEvent("paste", clipV1Text());
        v._onClipboardEvent(e);
        assert(e.prevented);
        assertEquals([...v._selectedNodes], ["p0"]);
        assertEquals(v._model.places.p0.label, "R");
        // a later copy that gets there makes the system clipboard current again
        deny = false;
        v._selectedNodes = new Set(["S"]);
        v._copySelection();
        assertEquals(v._systemClipStale, true); // not before writeText settles
        await tick();
        assertEquals(v._systemClipStale, false);
        v._pasteFromSystem({ shortcut: true });
        const e2 = clipboardEvent("paste", clipV1Text()); // what pflow-native put there since
        v._onClipboardEvent(e2);
        assertEquals([...v._selectedNodes], ["p1", "p2", "t0"]);
        assertEquals(v._model.places.p1.label, "Queue");
    });
});

Deno.test("view: a copy event's clipboardData write counts at once; only the latest API write's outcome counts", async () => {
    const v = await stubView(sir());
    v._selectedNodes = new Set(["S"]);
    v._copySelection({ shortcut: true });
    assertEquals(v._systemClipStale, true); // armed, not written yet
    v._onClipboardEvent(clipboardEvent("copy"));
    assertEquals(v._systemClipStale, false);
    // two copies whose writes settle out of order: the older one's failure does not count
    const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    await withNavigatorClipboard({ writeText: () => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); }) }, async () => {
        v._copySelection();
        v._copySelection();
        pending[1].resolve();
        await tick();
        assertEquals(v._systemClipStale, false);
        pending[0].reject(new Error("NotAllowedError"));
        await tick();
        assertEquals(v._systemClipStale, false);
    });
});

Deno.test("view: Cut is exactly one undo step; undo brings the nodes back and the buffer stays", async () => {
    // real _pushHistory, _deleteNodes, _clearSelection and _undoAction; only drawing is stubbed
    const PetriView = await petriViewClass();
    const v: any = Object.create(PetriView.prototype);
    stubViews.push(v);
    Object.defineProperty(v, "isConnected", { value: true, configurable: true });
    Object.assign(v, {
        _model: normalizeModel(sir()), _mode: "select", _selectedNodes: new Set(["S", "infect"]), _clipboard: null, _clipArms: {},
        _history: [], _redo: [],
        _scheduleSync() {}, _scheduleRender() {}, _renderUI() {}, _syncLD() {}, dispatchEvent() { return true; },
    });
    v._pushHistory(true); // the seed connectedCallback records
    const before = v._history[0];
    assert(v._cutSelection({ shortcut: true }));
    assertEquals(v._history.length, 2); // the seed + the cut, nothing more
    assert(!Object.hasOwn(v._model.places, "S") && !Object.hasOwn(v._model.transitions, "infect"));
    assertEquals(v._model.arcs.length, 2); // I -> recover -> R
    assertEquals(v._selectedNodes.size, 0);
    v._undoAction();
    assertEquals(v._history.length, 1);
    assertEquals(v._stableStringify(v._model), before);
    assertEquals(ids(v._clipboard.places), ["S"]);
    assertEquals(ids(v._clipboard.transitions), ["infect"]);
    for (const arm of Object.values(v._clipArms) as any[]) clearTimeout(arm.timer);
});

/** A stub view put through the real _wireClipboard, with its own pointerdown/focusin listeners captured. */
async function wiredView() {
    const v = await stubView();
    const on: Record<string, () => void> = {};
    v.addEventListener = (type: string, fn: () => void) => { on[type] = fn; };
    v._wireClipboard();
    return { v, on };
}

Deno.test("view: on a page with several editors the clipboard keys belong to the one pressed or focused in", async () => {
    // detach every editor the tests above made, so none of them is the owner or counts
    for (const old of stubViews) Object.defineProperty(old, "isConnected", { value: false });
    const g = globalThis as any;
    g.document = { addEventListener() {} }; // _wireClipboard's copy/cut/paste listeners
    try {
        const a = await wiredView();
        assert(a.v._ownsClipboard()); // the page's only editor needs no click first
        const b = await wiredView();
        // two, and nobody pressed or focused in either (pointerdown/focusin set the owner): neither takes the keys
        assert(!a.v._ownsClipboard());
        assert(!b.v._ownsClipboard());
        b.on.pointerdown();
        assert(b.v._ownsClipboard());
        assert(!a.v._ownsClipboard());
        a.on.focusin();
        assert(a.v._ownsClipboard());
        assert(!b.v._ownsClipboard());
        Object.defineProperty(a.v, "isConnected", { value: false });
        assert(!a.v._ownsClipboard()); // a detached editor never claims
        assert(b.v._ownsClipboard()); // and the sole connected one takes the keys
        const c = await wiredView();
        assert(!b.v._ownsClipboard() && !c.v._ownsClipboard()); // two connected again, the owner gone: neither
        // an editor that never wired its listeners does not count as the page's editor
        Object.defineProperty(c.v, "isConnected", { value: false });
        const loose = await stubView();
        assert(!loose._ownsClipboard());
        assert(b.v._ownsClipboard());
    } finally {
        delete g.document;
        for (const old of stubViews) Object.defineProperty(old, "isConnected", { value: false });
    }
});
