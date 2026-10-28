// laws-live_test.ts — compare() and compareLayout() in laws-live.js: the only
// runtime check on what Chyp, run live under Pyodide, says about the theories.
//
// The Laws view (views/laws.js startLive) runs Chyp's checker in the browser and
// compares the verdicts with the precomputed ones (compare), then lays the
// diagrams out and compares the numbers (compareLayout). The view prints
// compare()'s `differences` verbatim when there are any, so the message text is
// part of the contract and is asserted exactly. Pyodide itself is not loaded here
// (no network); the inputs are the shapes check() returns, built by hand and
// from the precomputed assets/chyp/*.json, which are CheckReport.to_dict()s.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { compare, compareLayout } from "./laws-live.js";

const THEORIES = ["orderer-monoid", "filter-meet", "driver-wrap", "sync-spiders"];
const asset = async (t: string) => JSON.parse(await Deno.readTextFile(new URL(`./assets/chyp/${t}.json`, import.meta.url)));
const precomputed = async () => Object.fromEntries(await Promise.all(THEORIES.map(async (t) => [t, (await asset(t)).check])));

// A small check report: two rewrites, the second with two steps.
const report = () => ({
    rewrites: [
        { name: "assoc", status: "valid", steps: [{ status: "valid" }] },
        { name: "wrong", status: "invalid", steps: [{ status: "valid" }, { status: "invalid" }] },
    ],
});
const one = () => ({ t: report() });

Deno.test("compare: the same report on both sides agrees, rewrite by rewrite", () => {
    assertEquals(compare(one(), one()), { agree: 2, total: 2, differences: [] });
});

Deno.test("compare: the real precomputed reports agree with themselves (33 rewrites over four theories)", async () => {
    const pre = await precomputed();
    const r = compare(structuredClone(pre), pre);
    assertEquals(r.differences, []);
    assertEquals(r.agree, r.total);
    assertEquals(r.total, 33);
});

Deno.test("compare: a different rewrite status is a difference, with the verdicts named", () => {
    const live = one();
    live.t.rewrites[0].status = "invalid";
    const r = compare(live, one());
    assertEquals(r.differences, ["t/assoc: live invalid, precomputed valid"]);
    assertEquals([r.agree, r.total], [1, 2]);
});

Deno.test("compare: the same verdict reached by different steps is a difference, with the step verdicts listed", () => {
    const live = one();
    live.t.rewrites[1].steps[1].status = "valid";
    const r = compare(live, one());
    assertEquals(r.differences, ["t/wrong: steps live [valid,valid], precomputed [valid,invalid]"]);
    assertEquals([r.agree, r.total], [1, 2]);
    // a different number of steps differs the same way
    const fewer = one();
    fewer.t.rewrites[1].steps.pop();
    assertEquals(compare(fewer, one()).differences, ["t/wrong: steps live [valid], precomputed [valid,invalid]"]);
});

Deno.test("compare: a rewrite Chyp did not report live is 'missing live'", () => {
    const live = one();
    live.t.rewrites.pop();
    const r = compare(live, one());
    assertEquals(r.differences, ["t/wrong: missing live"]);
    assertEquals([r.agree, r.total], [1, 2]);
});

Deno.test("compare: a rewrite only the live run has is reported, and does not count against the agreement", () => {
    const live = one();
    live.t.rewrites.push({ name: "extra", status: "valid", steps: [] });
    const r = compare(live, one());
    assertEquals(r.differences, ["t/extra: only live"]);
    assertEquals([r.agree, r.total], [2, 2]);
});

Deno.test("compare: a theory the live run did not check is named, and nothing else about it is said", () => {
    const pre = { a: report(), b: report() };
    const r = compare({ a: report() }, pre);
    assertEquals(r.differences, ["b: not checked live"]);
    // (agree is total minus the differences, so a skipped theory, which adds none to total, lowers it;
    // the view prints agree/total only when there are no differences, so the figure is not shown then.)
    assertEquals(r.total, 2);
});

Deno.test("compare: differences are collected across theories, in the precomputed order", () => {
    const pre = { a: report(), b: report() };
    const live = { a: report(), b: report() };
    live.a.rewrites[0].status = "invalid";
    live.b.rewrites[1].steps[0].status = "invalid";
    const r = compare(live, pre);
    assertEquals(r.differences, ["a/assoc: live invalid, precomputed valid", "b/wrong: steps live [invalid,invalid], precomputed [valid,invalid]"]);
    assertEquals([r.agree, r.total], [2, 4]);
});

Deno.test("compare: a real verdict flipped in a real report is caught", async () => {
    const pre = await precomputed();
    const live = structuredClone(pre);
    const first = live["driver-wrap"].rewrites[0];
    first.status = first.status === "valid" ? "invalid" : "valid";
    const r = compare(live, pre);
    assertEquals(r.differences.length, 1);
    assert(r.differences[0].startsWith(`driver-wrap/${first.name}: live `), r.differences[0]);
    assertEquals([r.agree, r.total], [32, 33]);
});

// --- compareLayout ---------------------------------------------------------------

const doc = () => ({
    layout: { used: "chyp", engine: "chyp.layout convex_layout" },
    gens: { f: { x: 1.5, y: -2, ports: [0, 0.5, 1] } },
    rewrites: [{ id: 0, pos: [{ x: 0, y: 1 }, { x: 2, y: 3 }] }],
});

Deno.test("compareLayout: identical documents agree to the last bit, every number counted", () => {
    const r = compareLayout(doc(), doc());
    assertEquals(r, { numbers: 10, maxDiff: 0, shapeDiffers: false });
});

Deno.test("compareLayout: the largest difference between two numbers is reported, structure unchanged", () => {
    const live: any = doc();
    live.gens.f.x = 1.75; // 0.25
    live.rewrites[0].pos[1].y = 3 - 1e-9; // tiny
    const r = compareLayout(live, doc());
    assertEquals(r.numbers, 10);
    assertEquals(r.maxDiff, 0.25);
    assertEquals(r.shapeDiffers, false);
});

Deno.test("compareLayout: the live run having a list of another length, or a key the precomputed one lacks, is a different structure", () => {
    const longer: any = doc();
    longer.gens.f.ports.push(2);
    const a = compareLayout(longer, doc());
    assertEquals(a.shapeDiffers, true);
    assertEquals(a.numbers, 10, "the common prefix of the lists is still compared");

    const shorter: any = doc();
    shorter.rewrites[0].pos.pop();
    assertEquals(compareLayout(shorter, doc()).shapeDiffers, true);

    const extra: any = doc();
    extra.gens.g = { x: 0, y: 0 };
    assertEquals(compareLayout(extra, doc()).shapeDiffers, true);
});

Deno.test("compareLayout: a value of another kind is a different structure; two different strings are not", () => {
    const wrongKind: any = doc();
    wrongKind.gens.f.x = "1.5";
    assertEquals(compareLayout(wrongKind, doc()).shapeDiffers, true);

    const nulled: any = doc();
    nulled.gens.f = null;
    assertEquals(compareLayout(nulled, doc()).shapeDiffers, true);

    // labels and engine names may legitimately differ between the exports (a Pyodide build
    // names its own engine), so strings are not compared
    const renamed: any = doc();
    renamed.layout.engine = "chyp.layout (Pyodide)";
    assertEquals(compareLayout(renamed, doc()), { numbers: 10, maxDiff: 0, shapeDiffers: false });
});

Deno.test("compareLayout: a real export agrees with itself, and a moved box shows as a difference", async () => {
    for (const t of THEORIES) {
        const { diagrams } = await asset(t);
        const same = compareLayout(structuredClone(diagrams), diagrams);
        assertEquals(same.shapeDiffers, false, t);
        assertEquals(same.maxDiff, 0, t);
        assert(same.numbers > 100, `${t}: only ${same.numbers} numbers compared`);
    }
    const { diagrams } = await asset("orderer-monoid");
    const moved = structuredClone(diagrams);
    // nudge the first number found anywhere in the rewrites
    let nudged = false;
    const nudge = (o: any) => {
        for (const k of Object.keys(o)) {
            if (nudged) return;
            if (typeof o[k] === "number") { o[k] += 0.5; nudged = true; return; }
            if (o[k] && typeof o[k] === "object") nudge(o[k]);
        }
    };
    nudge(moved.rewrites);
    assert(nudged);
    const r = compareLayout(moved, diagrams);
    assertEquals(r.maxDiff, 0.5);
    assertEquals(r.shapeDiffers, false);
});
