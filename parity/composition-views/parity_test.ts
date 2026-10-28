// parity_test.ts — the composition views, drawn by the web renderers
// (public/compose/views/), against pflow-native's egui renderers.
//
// The contract is pflow-native docs/composition-views-scene.md: for each view ×
// example × state, both renderers collect a scene manifest WHILE they draw (the
// elements drawn and what each says; no coordinates, colours or fonts) and the
// two must be equal. pflow-native generates goldens.json from its egui
// renderers, run headless; it is vendored here with goldens.lock (the
// pflow-native commit and sha256 it was copied at), like parity/native/'s
// goldens (refresh with `make sync-composition-goldens FROM=<pflow-native
// checkout> COMMIT=<sha>`, the commit the wasm was built from). Each state is
// reached by registry commands only, from a fresh session (render.js STATES), on
// the vendored wasm.
//
// A failing comparison is a finding about one renderer. It is never fixed by
// regenerating the goldens.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { EXAMPLES, renderManifest, setup, STATES, VIEW_IDS } from "./render.js";

await setup();

const read = async (name: string) => {
    try { return await Deno.readTextFile(new URL(name, import.meta.url)); } catch { return null; }
};
const goldensText = await read("./goldens.json");
const lockText = await read("./goldens.lock");
const wasmLock = JSON.parse(await Deno.readTextFile(new URL("../../pflow-native-wasm.lock", import.meta.url)));

const hex = async (s: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");

// The manifests the goldens hold, however the generator lays the file out.
function goldenManifests(g: any): any[] {
    if (Array.isArray(g)) return g;
    return g.manifests || g.cases || g.goldens || [];
}

// --- what holds with or without goldens --------------------------------------------

for (const example of EXAMPLES) {
    for (const stateId of Object.keys(STATES)) {
        Deno.test(`manifest well-formed: ${example} / ${stateId} (every view)`, async () => {
            for (const view of VIEW_IDS) {
                const { manifest, conflicts } = await renderManifest(view, example, stateId);
                assertEquals(conflicts, [], `${view}: an element emitted twice with different attrs`);
                const keys = manifest.elements.map((e: any) => `${e.kind}\u0000${e.id}`);
                assertEquals(keys, [...keys].sort(), `${view}: elements sorted by (kind, id)`);
                assertEquals(new Set(keys).size, keys.length, `${view}: no duplicates`);
                for (const e of manifest.elements) {
                    for (const [k, v] of Object.entries(e.attrs)) {
                        if (typeof v === "number") assert(Number.isInteger(v), `${view} ${e.kind} ${e.id}.${k}: numbers are integers`);
                        if (Array.isArray(v)) assertEquals(v, [...v].sort(), `${view} ${e.kind} ${e.id}.${k}: arrays sorted`);
                    }
                }
                if (manifest.elements.some((e: any) => e.kind === "na")) {
                    assertEquals(manifest.elements.filter((e: any) => e.kind === "na").map((e: any) => e.id), [view]);
                }
            }
        });
    }
}

// --- against pflow-native's goldens ---------------------------------------------------

if (!goldensText) {
    Deno.test({
        name: "web == native: waiting on pflow-native's goldens (parity/composition-views/goldens.json not vendored yet)",
        ignore: true,
        fn() {},
    });
} else {
    const goldens = JSON.parse(goldensText);
    const lock = lockText ? JSON.parse(lockText) : null;

    Deno.test("goldens: vendored with a lock, from the pflow-native commit the wasm was built from", async () => {
        assert(lock, "goldens.json needs goldens.lock (pflow-native commit and sha256)");
        assertEquals(await hex(goldensText), lock.sha256, "goldens.json was edited after it was vendored");
        assertEquals(lock.commit, wasmLock.commit, "the goldens and the vendored wasm come from different pflow-native commits");
        if (goldens.pflow_native) assertEquals(goldens.pflow_native, lock.commit);
    });

    const manifests = goldenManifests(goldens);
    Deno.test("goldens: every view × example × state of the contract is there", () => {
        const have = new Set(manifests.map((m: any) => `${m.view}/${m.example}/${m.state}`));
        const missing = [];
        for (const v of VIEW_IDS) for (const ex of EXAMPLES) for (const st of Object.keys(STATES)) if (!have.has(`${v}/${ex}/${st}`)) missing.push(`${v}/${ex}/${st}`);
        assertEquals(missing, []);
    });

    for (const g of manifests) {
        Deno.test(`web == native: ${g.view} / ${g.example} / ${g.state}`, async () => {
            assert(STATES[g.state as keyof typeof STATES] !== undefined, `unknown state ${g.state}`);
            const { manifest } = await renderManifest(g.view, g.example, g.state);
            // attrs compared by value: the contract fixes their fields, not the order of keys
            const attrs = (a: any) => JSON.stringify(Object.fromEntries(Object.entries(a).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))));
            const show = (els: any[]) => els.map((e) => `${e.kind} ${e.id} ${attrs(e.attrs)}`);
            const web = new Set(show(manifest.elements)), nat = new Set(show(g.elements));
            const onlyWeb = [...web].filter((x) => !nat.has(x)), onlyNative = [...nat].filter((x) => !web.has(x));
            assertEquals({ onlyWeb, onlyNative }, { onlyWeb: [], onlyNative: [] }, `${g.view}/${g.example}/${g.state}: the renderers drew different things`);
        });
    }
}
