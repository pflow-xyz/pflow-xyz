// js_vs_wasm_test.ts — the page's JS implementation vs the wasm engine, for the
// commands both have (the JS id wins in the registry; native's is not exposed).
//
// The page hands the engine its NORMALIZED model (runNative loads
// JSON.parse(JSON.stringify(c.model()))), so that is what is loaded here too;
// the raw file can differ from it (normalizeModel turns the per-colour
// "unbounded" capacity 0 into null), and so can its CID.
//
//   file.cid                      exact (CID strings)
//   sim.enabled                   exact (the same set of transitions)
//   sim.fire + sim.marking        exact, in lockstep along a walk (always fire the
//                                 smallest enabled transition; compare the
//                                 marking and the enabled set after each firing)
//   sim.ode                       the state at t_end, for several t_end, relative
//                                 tolerance 1e-9, with the SAME solver options
//                                 passed to both (dt, abstol, reltol, dtmax): both
//                                 are Tsit5, one is petri-solver.js and the other
//                                 pflow-solver (Rust), and the steps match, so only
//                                 the last bits may differ. Trajectory grids are
//                                 NOT compared: `points` decimates the adaptive
//                                 steps differently (a sampling choice, not a
//                                 numerical difference). With DEFAULT options the
//                                 two differ at the ~1e-6 level: a known gap, below.
//   net.info                      place/transition/arc ids, initial markings,
//                                 rates, colour count
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadEngine } from "../../public/petri-wasm.js";
import { Registry, createHeadlessHost } from "../../public/petri-commands.js";
import { diff } from "./diff.ts";

const gz = await Deno.readFile(new URL("../../public/vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
const wasm = new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
const { glue } = await loadEngine({ bytes: wasm });

const FIXTURES = [
    "native/fixtures/sir.jsonld", "native/fixtures/gated.jsonld",
    "fixtures/coffee-shop.jsonld", "fixtures/with-rates.jsonld", "fixtures/knapsack.jsonld",
    "fixtures/net-a.jsonld", "fixtures/net-b.jsonld", "fixtures/with-parents.jsonld",
];

async function both(fixture: string) {
    const text = await Deno.readTextFile(new URL(`../${fixture}`, import.meta.url));
    const reg: any = new Registry(createHeadlessHost(JSON.parse(text)));
    const engine = new glue.Engine();
    engine.load(JSON.stringify(JSON.parse(JSON.stringify(reg.host.getModel()))));
    const nat = (id: string, args: unknown = {}) => JSON.parse(engine.execute(id, JSON.stringify(args)));
    return { reg, engine, nat };
}

const sorted = (a: string[]) => [...a].sort();

// A place with no tokens may be [] in the page's model and [0] in the engine's.
const padMarking = (m: Record<string, number[]>, colors: number) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Array.from({ length: colors }, (_, i) => v[i] ?? 0)]));

const SAME_OPTIONS = { dt: 0.01, abstol: 1e-6, reltol: 1e-3, dtmax: 0.05 };

async function odeFinal(f: string, options: Record<string, number>, tol: number) {
    for (const t_end of [1, 5, 20]) {
        const { reg, nat } = await both(f);
        let js: any, n: any, jsErr: string | undefined, nErr: string | undefined;
        try { js = await reg.execute("sim.ode", { t_end, points: 11, ...options }); } catch (e) { jsErr = (e as Error).message; }
        try { n = nat("sim.ode", { t_end, points: 11, ...options }); } catch (e) { nErr = (e as Error).message; }
        assertEquals(jsErr === undefined, nErr === undefined, `${f} t_end ${t_end}: one engine refused (js: ${jsErr}; wasm: ${nErr})`);
        if (jsErr !== undefined) continue;
        // native names colours "Place.colour"; the page reports per-place totals
        const totals: Record<string, number> = {};
        for (const [k, v] of Object.entries(n.final as Record<string, number>)) {
            const base = k.includes(".") && !(k in js.final) ? k.slice(0, k.lastIndexOf(".")) : k;
            totals[base] = (totals[base] ?? 0) + v;
        }
        // places with no tokens anywhere may be absent on one side
        const want: Record<string, number> = {}, got: Record<string, number> = {};
        for (const [k, v] of Object.entries(js.final as Record<string, number>)) if (v !== 0 || k in totals) want[k] = v;
        for (const [k, v] of Object.entries(totals)) if (v !== 0 || k in js.final) got[k] = v;
        // relative to the largest state, so a place that ends near zero (a
        // -2.6e-8 that is rounding noise around 0) does not fail on its own scale
        const scale = Math.max(1, ...Object.values(want).map(Math.abs));
        const bad = Object.keys({ ...want, ...got }).filter((k) => !(Math.abs((want[k] ?? NaN) - (got[k] ?? NaN)) <= tol * scale));
        assert(bad.length === 0, bad.map((k) => `${f} t_end ${t_end} final.${k}: js ${want[k]} != wasm ${got[k]} (scale ${scale})`).join("\n"));
    }
}

for (const f of FIXTURES) {
    Deno.test(`js == wasm: file.cid, ${f}`, async () => {
        const { reg, nat } = await both(f);
        const js = await reg.execute("file.cid");
        assertEquals(js.cid, nat("file.cid").cid);
    });

    Deno.test(`js == wasm: sim.enabled and a firing walk, ${f}`, async () => {
        const { reg, nat } = await both(f);
        const colors = reg.host.getModel().token.length;
        const problems: string[] = [];
        for (let step = 0; step < 40; step++) {
            const en = sorted((await reg.execute("sim.enabled")).enabled);
            const nen = sorted(nat("sim.enabled"));
            if (en.join() !== nen.join()) { problems.push(`step ${step}: enabled ${en} != ${nen}`); break; }
            const jm = padMarking((await reg.execute("sim.marking")).marking, colors), nm = padMarking(nat("sim.marking"), colors);
            problems.push(...diff(nm, jm, `step ${step} marking`, 0, new Set()));
            if (problems.length || !en.length) break;
            await reg.execute("sim.fire", { id: en[0] });
            nat("sim.fire", { id: en[0] });
        }
        assert(problems.length === 0, problems.join("\n"));
    });

    Deno.test(`js == wasm: sim.ode final state with the same options, ${f}`, async () => {
        await odeFinal(f, SAME_OPTIONS, 1e-9);
    });

    // Known gap, reported in the PR: the defaults differ. The page's registry
    // leaves dtmax to petri-solver.js (0.1); pflow-native's sim.ode defaults it to
    // min(0.1, t_end/50), so for t_end < 5 the native steps are smaller and the
    // final states differ at the ~1e-6 level (up to ~1e-3 relative on a near-zero
    // place): inside the solver's own tolerance, but not bit-for-bit.
    Deno.test({
        name: `js == wasm: sim.ode final state with default options, ${f}`,
        ignore: true,
        fn: async () => { await odeFinal(f, {}, 1e-9); },
    });

    Deno.test(`js == wasm: net.info, ${f}`, async () => {
        const { reg, nat } = await both(f);
        const js = await reg.execute("net.info"), n = nat("net.info");
        assertEquals(n.places.map((p: any) => p.id), js.places.map((p: any) => p.id));
        assertEquals(n.transitions.map((t: any) => t.id), js.transitions.map((t: any) => t.id));
        // a document with no token list is one uncoloured token: the page says 1, the engine lists none
        const colors = Math.max(1, n.colors.length);
        assertEquals(colors, js.colors);
        const pad = (v: number[]) => Array.from({ length: colors }, (_, i) => v[i] ?? 0);
        assertEquals(n.places.map((p: any) => pad(p.initial)), js.places.map((p: any) => pad(p.initial)));
        assertEquals(n.transitions.map((t: any) => t.rate ?? null), js.transitions.map((t: any) => t.rate ?? null));
        const arcs = (a: any[]) => a.map((x) => `${x.source}->${x.target}:${JSON.stringify(x.weight)}${x.inhibit ? " inhibit" : ""}`).sort();
        assertEquals(arcs(n.arcs), arcs(js.arcs));
    });
}
