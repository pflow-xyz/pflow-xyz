// laws-live_test.ts — what the Laws view's live check says, and that it says what Chyp says.
//
// The Laws view (views/laws.js startLive) runs chyp-rs in the browser and compares the verdicts with the precomputed
// ones (compare). The view prints compare()'s `differences` verbatim when there are any, so the message text is part
// of the contract and is asserted exactly. The inputs are the shapes check() returns, built by hand and from the
// precomputed assets/chyp/*.json, which are Chyp's own CheckReport.to_dict()s; the parity tests below run the
// vendored wasm on the theories and hold it to those.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkSource, compare, createShownGate, reportOf } from "./laws-live.js";

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

// --- reportOf: chyp-rs's outline as the report compare() reads ------------------------------------

const rw = (name: string, line: number, start: number, end: number, status: string) => ({ kind: "RewritePart", name, line, start, end, status });

Deno.test("reportOf: consecutive steps of one statement are one rewrite; a parsed rule between them ends it", () => {
    const r = reportOf({
        errors: [],
        parts: [
            { kind: "GenPart", name: "f", line: 1, start: 0, end: 5, status: "unchecked" },
            rw("a", 3, 10, 20, "valid"), rw("a", 4, 20, 30, "valid"),
            { kind: "RulePart", name: "r", line: 5, start: 30, end: 40, status: "unchecked" },
            rw("b", 7, 50, 60, "valid"), rw("b", 8, 60, 70, "invalid"),
            rw("b", 9, 75, 80, "valid"), // the same name, not continuing the last one: another statement
        ],
    });
    assertEquals(r.rewrites.map((x: any) => [x.name, x.status, x.steps.map((s: any) => s.status)]), [
        ["a", "valid", ["valid", "valid"]],
        ["b", "invalid", ["valid", "invalid"]],
        ["b", "valid", ["valid"]],
    ]);
});

Deno.test("reportOf: a message on a step's line makes it an error, and an error outranks invalid", () => {
    const r = reportOf({
        errors: [{ line: 8, msg: "Rule x not defined." }],
        parts: [rw("a", 7, 0, 10, "invalid"), rw("a", 8, 10, 20, "invalid"), rw("c", 9, 30, 40, "checking")],
    });
    assertEquals(r.rewrites.map((x: any) => [x.name, x.status]), [["a", "error"], ["c", "error"]]);
    assertEquals(r.rewrites[0].steps[1].messages, ["Rule x not defined."]);
});

// --- the vendored bundle against what Chyp itself decided --------------------------------------------------

/** The vendored chyp-rs, instantiated from the .gz the server would decompress. */
const engine = async () => {
    const chyp = await import("../vendor/chyp-rs-wasm/chyp_rs.js");
    const gz = await Deno.readFile(new URL("../vendor/chyp-rs-wasm/chyp_rs_bg.wasm.gz", import.meta.url));
    const body = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
    await chyp.default({ module_or_path: await new Response(body).arrayBuffer() });
    return chyp;
};
const theory = (t: string) => Deno.readTextFile(new URL(`./chyp/${t}.chyp`, import.meta.url));

Deno.test("parity: the vendored chyp-rs gives every verdict Chyp gave under CPython (33 rewrites, every step)", async () => {
    const chyp = await engine();
    const pre = await precomputed();
    const live = Object.fromEntries(await Promise.all(THEORIES.map(async (t) => [t, checkSource(chyp, await theory(t))])));
    const r = compare(live, pre);
    assertEquals(r.differences, []);
    assertEquals([r.agree, r.total], [33, 33]);
    // the must-fail controls are in there, failing: agreement is not everything passing
    const statuses = Object.values(live).flatMap((rep: any) => rep.rewrites.map((x: any) => x.status));
    assertEquals(statuses.filter((s) => s === "valid").length, 30);
    assertEquals(statuses.filter((s) => s === "invalid").length, 3);
    // and step by step, line by line, beyond what compare() prints
    for (const t of THEORIES) {
        assertEquals(live[t].errors, []);
        const steps = (rep: any) => rep.rewrites.flatMap((x: any) => x.steps.map((s: any) => [x.name, s.line, s.status]));
        assertEquals(steps(live[t]), steps(pre[t]), t);
    }
});

Deno.test("parity: a theory with a proof changed is caught by the check, not only by a hash", async () => {
    const chyp = await engine();
    const pre = await precomputed();
    const broken = (await theory("driver-wrap")).replace("= doc_solver by reads_nw_budget", "= doc_solver by reads_budget");
    const live = { ...pre, "driver-wrap": checkSource(chyp, broken) };
    assertEquals(compare(live, pre).differences, ["driver-wrap/doc_plan: live invalid, precomputed valid"]);
});

Deno.test("parity: a theory that does not parse is one report with no rewrites and its error", async () => {
    const r = checkSource(await engine(), "gen f : 1 ->\n");
    assertEquals(r.rewrites, []);
    assertEquals(r.errors.length, 1);
});

// The Laws view's background work must not speak, or redraw, while another view is shown (views/laws.js).
const gate = () => {
    const said: string[] = [];
    const later: Array<() => void> = [];
    const g = createShownGate({ announce: (t: string) => said.push(t), defer: (f: () => void) => later.push(f) });
    return { g, said, later, run: () => { while (later.length) later.shift()!(); } };
};

Deno.test("createShownGate: while Laws is shown it speaks at once", () => {
    const { g, said } = gate();
    g.say(true, "Laws: the live layout is drawn.");
    assertEquals(said, ["Laws: the live layout is drawn."]);
    assertEquals(g.missed(), null);
});

Deno.test("createShownGate: away, it says nothing and keeps the latest message only", () => {
    const { g, said } = gate();
    g.say(false, "Laws: the live check agrees. Laying the diagrams out live.");
    g.say(false, "Laws: the live layout is drawn.");
    assertEquals(said, []);
    assertEquals(g.missed(), "Laws: the live layout is drawn.");
});

Deno.test("createShownGate: arrive() gives back what was missed, once, and after the page's own announcement", () => {
    const { g, said, later, run } = gate();
    g.say(false, "Laws: the live layout is drawn.");
    g.arrive();
    assertEquals(said, [], "deferred: the view's label (announced in the same render) goes first");
    assertEquals(later.length, 1);
    run();
    assertEquals(said, ["Laws: the live layout is drawn."]);
    g.arrive();
    assertEquals(later.length, 0, "and only once");
    assertEquals(g.missed(), null);
});

Deno.test("createShownGate: arrive() with nothing missed does nothing", () => {
    const { g, later, said } = gate();
    g.say(true, "spoken while shown");
    g.arrive();
    assertEquals(later.length, 0);
    assertEquals(said, ["spoken while shown"]);
});
