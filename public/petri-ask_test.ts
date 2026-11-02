import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
    INTENTS, answerLabel, askState, assumptionLine, assumptionLines, errorKind, followUpsFor, gatingHints, intentChip, isTransient,
    looksLikeGame, normalizeIntent, numeralsOutside, otherIntents, routeWords, sinksOf, suggestPrompts, suggestPromptsFor, taggedLines,
} from "./petri-ask.js";
import { matchGoals } from "./petri-goals.js";
import { Registry, createHeadlessHost } from "./petri-commands.js";
import { loadEngine } from "./petri-wasm.js";

const catalog = JSON.parse(await Deno.readTextFile(new URL("./goals.json", import.meta.url)));
const gz = await Deno.readFile(new URL("./vendor/pflow-native-wasm/pflow_native_wasm_bg.wasm.gz", import.meta.url));
await loadEngine({ bytes: new Uint8Array(await new Response(new Blob([gz as BufferSource]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) });

const fixture = async (path: string) => JSON.parse(await Deno.readTextFile(new URL(`../${path}`, import.meta.url)));
const registryOf = async (path: string): Promise<any> => new Registry(createHeadlessHost(await fixture(path)) as any);
const modelOf = async (path: string) => (await registryOf(path)).host.getModel();

// ---- the input's state (design section 9) ----

const signedIn = { enabled: true, chat: true, signed_in: true, allowed: true, remaining_today: 12, reset: "2026-11-02T00:00:00Z", toolsets: ["all", "goals"] };

Deno.test("askState: signed in with quota left is the full agent", () => {
    assertEquals(askState(signedIn), { state: "agent", words: "", canAsk: true, router: false, signIn: false, toolset: "goals" });
    // a status with no allowed field (a server with no allow list) is allowed
    assertEquals(askState({ ...signedIn, allowed: undefined }).state, "agent");
});

Deno.test("askState: signed out gets the router and the cards, and one line inviting a sign-in", () => {
    const s = askState({ enabled: true, chat: true, signed_in: false, toolsets: ["all", "goals"] });
    assertEquals([s.state, s.canAsk, s.router, s.signIn], ["signed-out", false, true, true]);
    assert(s.words.startsWith("Sign in to ask in your own words"), s.words);
});

Deno.test("askState: not on the allow list is the router with no sign-in nag", () => {
    const s = askState({ ...signedIn, allowed: false });
    assertEquals([s.state, s.canAsk, s.router, s.signIn], ["not-allowed", false, true, false]);
    assert(!/sign in/i.test(s.words), s.words);
});

Deno.test("askState: a server with no chat, or no LLM at all, is off: the router, no sign-in", () => {
    for (const status of [undefined, null, {}, { enabled: false, signed_in: false }, { enabled: true, chat: false, signed_in: true }]) {
        const s = askState(status as any);
        assertEquals([s.state, s.canAsk, s.router, s.signIn], ["off", false, true, false], JSON.stringify(status));
    }
});

Deno.test("askState: quota used up says when it resets (the status's own time, else 00:00 UTC), whether the status or the page knows", () => {
    const q = askState({ ...signedIn, remaining_today: 0, reset: "2026-11-02T00:00:00Z" });
    assertEquals([q.state, q.router, q.canAsk, q.signIn], ["quota", true, false, false]);
    assertEquals(q.words, "Model calls are used up for today (resets 00:00 UTC)");
    assertEquals(askState({ ...signedIn, remaining_today: 0, reset: "2026-11-02T06:30:00Z" }).words, "Model calls are used up for today (resets 06:30 UTC)");
    assertEquals(askState({ ...signedIn, remaining_today: 0, reset: undefined }).words, "Model calls are used up for today (resets 00:00 UTC)");
    assertEquals(askState({ ...signedIn, reset: "garbage", remaining_today: 0 }).reset, "00:00");
    // the page saw the last turn's quota event: 0 left, though the status read earlier said 12
    assertEquals(askState(signedIn, { quotaLeft: 0 }).state, "quota");
    assertEquals(askState({ ...signedIn, remaining_today: 0 }, { quotaLeft: 3 }).state, "agent");
    assertEquals(askState(signedIn, { quotaLeft: 5 }).state, "agent");
});

Deno.test("askState: an upstream failure retries once when transient, then degrades and keeps the message", () => {
    const e = Object.assign(new Error("the model took too long to answer; try again"), { status: 504 });
    const first = askState(signedIn, { error: e });
    assertEquals([first.state, first.retry, first.canAsk, first.router], ["upstream", true, false, true]);
    assert(first.words.includes("Trying once more"), first.words);
    const second = askState(signedIn, { error: e, retried: true });
    assertEquals([second.state, second.retry], ["upstream", false]);
    assert(second.words.includes("Your message is kept"), second.words);
    assertEquals(second.error, "the model took too long to answer; try again");
    // a failure with no status at all (the network) is transient too; a 400 is not
    assertEquals(askState(signedIn, { error: new Error("Failed to fetch") }).retry, true);
    assertEquals(askState(signedIn, { error: Object.assign(new Error("bad"), { status: 400 }) }).retry, false);
});

Deno.test("askState: an error that is really the sign-in, the allow list or the daily limit gives that state", () => {
    assertEquals(askState(signedIn, { error: Object.assign(new Error("x"), { status: 401 }) }).state, "signed-out");
    assertEquals(askState(signedIn, { error: Object.assign(new Error("x"), { status: 403 }) }).state, "not-allowed");
    const daily = askState(signedIn, { error: Object.assign(new Error("daily"), { status: 429, retryAfter: 7200 }) });
    assertEquals([daily.state, daily.router], ["quota", true]);
    // a short 429 is the per-minute limit: transient
    assertEquals(askState(signedIn, { error: Object.assign(new Error("slow"), { status: 429, retryAfter: 17 }) }).state, "upstream");
    assertEquals([errorKind({ status: 503 }), isTransient({ status: 503 }), isTransient({ status: 404 }), isTransient({ status: 429, retryAfter: 3600 })], ["upstream", true, false, false]);
    // the status wins over an error for who may ask at all
    assertEquals(askState({ enabled: true, chat: true, signed_in: false }, { error: new Error("x") }).state, "signed-out");
});

Deno.test("askState: the toolset to ask for follows what the server lists; an older server lists none", () => {
    assertEquals(askState(signedIn).toolset, "goals");
    assertEquals(askState({ ...signedIn, toolsets: ["all"] }).toolset, "all");
    assertEquals(askState({ ...signedIn, toolsets: undefined }).toolset, "all");
});

// ---- the intent chip ----

Deno.test("intents: Build, Analyse, Explain; design is build; auto is nobody's intent", () => {
    assertEquals(INTENTS, [
        { id: "build", label: "Build", chip: "Building" },
        { id: "analyse", label: "Analyse", chip: "Analysing" },
        { id: "explain", label: "Explain", chip: "Explaining" },
    ]);
    assertEquals(intentChip("analyse"), INTENTS[1]);
    assertEquals(intentChip("design"), INTENTS[0]);
    assertEquals([intentChip("auto"), intentChip(null), intentChip("explore"), intentChip(undefined)], [null, null, null, null]);
    assertEquals([normalizeIntent("design"), normalizeIntent("auto"), normalizeIntent("explain")], ["build", null, "explain"]);
    assertEquals(otherIntents("analyse").map((i: any) => [i.id, i.instead]), [["build", "Build instead"], ["explain", "Explain instead"]]);
    assertEquals(otherIntents("design").map((i: any) => i.id), ["analyse", "explain"]);
    assertEquals(otherIntents(null).map((i: any) => i.id), ["build", "analyse", "explain"]);
});

// ---- reading a net ----

Deno.test("gatingHints reads the same constraints sim.recommend reports, on the repo's own nets", async () => {
    for (const f of ["examples/showcase/cafe.jsonld", "parity/native/fixtures/gated.jsonld", "parity/native/fixtures/sir.jsonld", "parity/native/fixtures/explode.jsonld",
        "parity/native/fixtures/colored.jsonld", "parity/native/fixtures/inert.jsonld", "parity/native/fixtures/tie.jsonld", "parity/native/fixtures/game-nim.jsonld", "parity/native/fixtures/game-tic-tac-toe.jsonld"]) {
        const reg = await registryOf(f);
        const rec = await reg.execute("sim.recommend");
        assertEquals(gatingHints(reg.host.getModel()).length, rec.gating.length, f);
    }
    const hints = gatingHints(await modelOf("examples/showcase/cafe.jsonld"));
    assert(hints.some((h) => h.startsWith("inhibitor arc(s) pantry → restock")) && hints.some((h) => h.startsWith("read arc(s) order_espresso → open")) && hints.some((h) => h.startsWith("capacity on open, queue")), hints.join(" | "));
    assertEquals(gatingHints({}), []);
});

Deno.test("sinksOf: places tokens reach and never leave; an inhibitor arc consumes nothing", async () => {
    assertEquals(sinksOf(await modelOf("parity/native/fixtures/sir.jsonld")), ["R"]);
    assertEquals(sinksOf(await modelOf("parity/native/fixtures/tie.jsonld")), ["R", "B"]);
    assertEquals(sinksOf(await modelOf("examples/showcase/cafe.jsonld")), [], "served is consumed by leave");
    const net = { places: { a: {}, b: {} }, transitions: { t: {} }, arcs: [{ source: "a", target: "t" }, { source: "t", target: "b" }, { source: "b", target: "t", inhibitTransition: true }] };
    assertEquals(sinksOf(net), ["b"]);
});

Deno.test("looksLikeGame: every game fixture, and none of the other nets", async () => {
    for (const f of ["game-bucket", "game-colored-nim", "game-colored-nim3", "game-colored-spare", "game-connect-3", "game-connect-4", "game-nim", "game-prizes-1111", "game-prizes-123",
        "game-tic-tac-toe", "game-ttt-count", "game-ttt-double", "game-ttt-wide"]) assert(looksLikeGame(await modelOf(`parity/native/fixtures/${f}.jsonld`)), f);
    assert(looksLikeGame(await modelOf("parity/native/fixtures/tic-tac-toe.json")));
    for (const f of ["examples/showcase/cafe.jsonld", "parity/native/fixtures/sir.jsonld", "parity/native/fixtures/gated.jsonld", "parity/native/fixtures/explode.jsonld",
        "parity/native/fixtures/colored.jsonld", "parity/native/fixtures/inert.jsonld", "parity/native/fixtures/tie.jsonld"]) assertFalse(looksLikeGame(await modelOf(f)), f);
    assertFalse(looksLikeGame({ places: { my_turn: {} }, transitions: { my_move: {} } }), "one side is not a game");
});

// ---- suggested prompts ----

Deno.test("suggestPrompts: a net with capacities and inhibitors is asked how bad it can get and whether it can get stuck", async () => {
    const p = suggestPrompts(await modelOf("examples/showcase/cafe.jsonld"), catalog);
    assertEquals(p.map((x: any) => x.goal), ["risk", "stuck", "average", "conserved"]);
    assertEquals(p[0].text, "How bad can it get?");
    assertEquals(p[1].text, "Can it get stuck?");
    assert(p[0].why.includes("inhibitor arc(s) pantry → restock"), p[0].why);
});

Deno.test("suggestPrompts: two or more sinks suggest which knob matters", async () => {
    const p = suggestPrompts(await modelOf("parity/native/fixtures/tie.jsonld"), catalog);
    assertEquals(p.map((x: any) => x.goal), ["knob", "average", "conserved", "stuck"]);
    assertEquals(p[0].text, "Which knob matters?");
    assert(p[0].why.includes("2 outcomes (R, B)"), p[0].why);
    // one sink is not a choice of outcomes
    assertFalse(suggestPrompts(await modelOf("parity/native/fixtures/sir.jsonld"), catalog).some((x: any) => x.goal === "knob"));
});

Deno.test("suggestPrompts: a two-sided game leads with best play", async () => {
    const p = suggestPrompts(await modelOf("parity/native/fixtures/game-tic-tac-toe.jsonld"), catalog);
    assertEquals(p[0], { goal: "best_play", text: "Who wins with best play?", why: "this is a two-sided game" });
    assertEquals(p.map((x: any) => x.goal), ["best_play", "knob", "average", "conserved"]);
    // nowhere else
    for (const f of ["examples/showcase/cafe.jsonld", "parity/native/fixtures/sir.jsonld", "parity/native/fixtures/tie.jsonld"]) {
        assertFalse(suggestPrompts(await modelOf(f), catalog, { limit: 9 }).some((x: any) => x.goal === "best_play"), f);
    }
});

Deno.test("suggestPrompts: every net gets average and conserved; deterministic; limited; only available goals", async () => {
    for (const f of ["parity/native/fixtures/sir.jsonld", "parity/native/fixtures/explode.jsonld", "parity/native/fixtures/inert.jsonld"]) {
        const m = await modelOf(f);
        const p = suggestPrompts(m, catalog);
        assertEquals(p.map((x: any) => x.goal), ["average", "conserved", "stuck", "unbounded"], f);
        assertEquals(suggestPrompts(m, catalog), p, "same net, same prompts");
    }
    const m = await modelOf("examples/showcase/cafe.jsonld");
    assertEquals(suggestPrompts(m, catalog, { limit: 2 }).map((x: any) => x.goal), ["risk", "stuck"]);
    assertEquals(suggestPrompts(m, catalog, { limit: 0 }), []);
    assertEquals(suggestPrompts(m, catalog, { limit: 99 }).map((x: any) => x.goal), ["risk", "stuck", "average", "conserved", "unbounded"]);
    // a goal the catalogue does not offer is not suggested
    const none = { goals: catalog.goals.map((g: any) => (g.id === "average" ? { ...g, available: false } : g)) };
    assertFalse(suggestPrompts(m, none).some((x: any) => x.goal === "average"));
    assertEquals(suggestPrompts({}, { goals: [] }), []);
});

Deno.test("suggestPrompts: every suggested text lands on its own goal when the router reads it (the degraded mode)", async () => {
    const seen = new Set<string>();
    for (const f of ["examples/showcase/cafe.jsonld", "parity/native/fixtures/tie.jsonld", "parity/native/fixtures/game-tic-tac-toe.jsonld", "parity/native/fixtures/sir.jsonld"]) {
        for (const p of suggestPrompts(await modelOf(f), catalog, { limit: 9 })) {
            seen.add(p.goal);
            assertEquals(matchGoals(catalog, p.text)[0]?.id, p.goal, `"${p.text}"`);
        }
    }
    assertEquals([...seen].sort(), ["average", "best_play", "conserved", "knob", "risk", "stuck", "unbounded"]);
});

Deno.test("suggestPromptsFor: sim.recommend's own gating decides; a large unconstrained net gets neither risk nor stuck first", async () => {
    const cafe = await registryOf("examples/showcase/cafe.jsonld");
    assertEquals((await suggestPromptsFor(cafe, catalog)).map((x: any) => x.goal), ["risk", "stuck", "average", "conserved"]);
    // a registry that cannot recommend falls back on reading the arcs
    const broken: any = { host: cafe.host, execute: async () => { throw new Error("no engine"); } };
    assertEquals((await suggestPromptsFor(broken, catalog)).map((x: any) => x.goal), ["risk", "stuck", "average", "conserved"]);
    // a recommendation the caller already has is used as is
    const m = await modelOf("parity/native/fixtures/sir.jsonld");
    assertEquals(suggestPrompts(m, catalog, { recommendation: { engine: "ssa", gating: ["capacity on S"] } }).map((x: any) => x.goal).slice(0, 2), ["risk", "stuck"]);
    assertEquals(suggestPrompts(m, catalog, { recommendation: { engine: "ode", gating: [] } }).map((x: any) => x.goal).slice(0, 2), ["average", "conserved"]);
});

// ---- the router ----

Deno.test("routeWords: up to three cards, the places the words name proposed as assumptions, the inputs still missing listed; nothing runs", async () => {
    const cafe = await modelOf("examples/showcase/cafe.jsonld");
    const cards = routeWords(catalog, cafe, "what if I had one more barista?");
    assertEquals(cards[0].goal.id, "one_more");
    assertEquals(cards[0].inputs, { place: "barista_free" });
    assertEquals(cards[0].assumed.length, 1);
    assertEquals(cards[0].assumed[0], {
        key: "place", how: "inferred", label: "one more token in", value: "barista_free", text: "one more token in = barista_free (taken from your words)",
        change: { input: "place", kind: "place", options: ["open", "queue", "pantry", "barista_free", "brewing", "served"] },
    });
    assertEquals([cards[0].missing, cards[0].ready], [[], true]);
    assertEquals(cards[0].form.fields.map((f: any) => f.name), ["place"]);
    assert(cards.length <= 3);
    // words that name nothing leave the input missing, and the form is there to fill it
    const open = routeWords(catalog, cafe, "what if I had one more of something?")[0];
    assertEquals([open.goal.id, open.inputs, open.ready], ["one_more", {}, false]);
    assertEquals(open.missing.map((i: any) => i.name), ["place"]);
    assertEquals(open.form.fields[0].kind, "place");
    // an optional input is not missing, and a goal with none is ready
    const stuck = routeWords(catalog, cafe, "can it get stuck?")[0];
    assertEquals([stuck.goal.id, stuck.ready, stuck.assumed], ["stuck", true, []]);
    const knob = routeWords(catalog, cafe, "which knob matters for the served?")[0];
    assertEquals([knob.goal.id, knob.inputs.observable, knob.ready], ["knob", "served", true]);
});

Deno.test("routeWords: a miss is an empty list, never a guess; blank words route nowhere; unavailable goals are not offered; the limit holds", async () => {
    const cafe = await modelOf("examples/showcase/cafe.jsonld");
    assertEquals(routeWords(catalog, cafe, "zxqv blorp"), []);
    assertEquals(routeWords(catalog, cafe, "   "), []);
    assertEquals(routeWords(catalog, cafe, ""), []);
    assertFalse(routeWords(catalog, cafe, "does my event log match the model?").some((c: any) => c.goal.id === "data_match"));
    const many = routeWords(catalog, cafe, "what is the best worst case spread on average when stuck", { limit: 3 });
    assert(many.length <= 3 && many.length >= 2, String(many.length));
    assertEquals(routeWords(catalog, cafe, "what is the best worst case spread on average when stuck", { limit: 1 }).length, 1);
    // the ranking is the matcher's
    assertEquals(routeWords(catalog, cafe, "can it deadlock").map((c: any) => c.goal.id), matchGoals(catalog, "can it deadlock").filter((g: any) => g.available !== false).slice(0, 3).map((g: any) => g.id));
});

// ---- follow-ups ----

Deno.test("goals.json followUps: 2 to 3 ids of other available goals for each available goal, none for an unavailable one", () => {
    const ids = new Set(catalog.goals.map((g: any) => g.id));
    for (const g of catalog.goals) {
        assert(Array.isArray(g.followUps), `${g.id} has followUps`);
        if (g.available === false) { assertEquals(g.followUps, [], g.id); continue; }
        assert(g.followUps.length >= 2 && g.followUps.length <= 3, `${g.id}: ${g.followUps.length}`);
        assertEquals(new Set(g.followUps).size, g.followUps.length, `${g.id}: duplicates`);
        for (const id of g.followUps) {
            assert(ids.has(id), `${g.id} → ${id}: no such goal`);
            assert(id !== g.id, `${g.id} follows itself`);
            assert(catalog.goals.find((x: any) => x.id === id).available !== false, `${g.id} → ${id}: not available`);
        }
    }
    // the ones the design names
    const f = (id: string) => catalog.goals.find((g: any) => g.id === id).followUps;
    assertEquals(f("risk").slice(0, 2), ["knob", "average"]);
    assertEquals(f("stuck").slice(0, 2), ["conserved", "can_happen"]);
    assert(f("unbounded").includes("conserved"));
    assertEquals(f("knob").slice(0, 2), ["one_more", "best_setting"]);
});

Deno.test("followUpsFor: the goals themselves, available ones, from a goal or its id", () => {
    assertEquals(followUpsFor("risk", catalog).map((g: any) => g.id), ["knob", "average"]);
    assertEquals(followUpsFor(catalog.goals.find((g: any) => g.id === "knob"), catalog).map((g: any) => g.question), ["What if I had one more …?", "What's the best setting for a rate?"]);
    assertEquals(followUpsFor("data_match", catalog), []);
    assertEquals(followUpsFor("nope", catalog), []);
    assertEquals(followUpsFor(undefined as any, catalog), []);
    const withGone = { goals: catalog.goals.map((g: any) => (g.id === "knob" ? { ...g, available: false } : g)) };
    assertEquals(followUpsFor("risk", withGone).map((g: any) => g.id), ["average"], "a goal that went away drops out");
});

// ---- saying what was assumed ----

Deno.test("assumptionLine: what the code and the model each took, as a sentence", () => {
    assertEquals(assumptionLine({ how: "inferred", label: "the outcome to watch", key: "observable", value: "I" }), "I took the outcome to watch to be I.");
    assertEquals(assumptionLine({ how: "default", label: "up to rate", key: "max_rate", value: 2 }), "Up to rate is 2, the goal's default.");
    assertEquals(assumptionLine({ how: "unnamed", label: "the outcome to watch", key: "observable" }), "The outcome to watch was not named, so the command picked its own default.");
    assertEquals(assumptionLine({ how: "plan", key: "t_end", text: "t_end = 5 from sim.recommend" }), "t_end = 5 from sim.recommend");
    assertEquals(assumptionLine({ how: "decided", key: "decided", text: "You left “Which place?” to me; I took I." }), "You left “Which place?” to me; I took I.");
    assertEquals(assumptionLine({ key: "k" }), "k");
    assertEquals(assumptionLine(null as any), "");
    assertEquals(assumptionLines([{ how: "inferred", key: "p", value: "S" }, null, { text: "x" }] as any), ["I took p to be S.", "x"]);
});

Deno.test("answerLabel and taggedLines: every line is the engine's or the assistant's; 'you decide' is the assistant's judgment", () => {
    assertEquals(answerLabel("assistant").id, "assistant");
    for (const by of ["engine", "goal", undefined, "anything"]) assertEquals(answerLabel(by as any).id, "engine");
    assert(answerLabel("assistant").title.includes("not the engine's"));
    const result = {
        answer: { by: "assistant", text: "The infection peaks early." },
        record: { engine: { name: "SSA", reason: "the net has a capacity", overridden: true } },
        warnings: ["SSA on a net where ..."],
        assumed: [{ how: "inferred", label: "the outcome to watch", key: "observable", value: "I" }, { how: "decided", key: "decided", text: "You left “Which?” to me; I took S." }],
        caveat: "Twenty runs give a spread.",
    };
    assertEquals(taggedLines(result), [
        { by: "assistant", kind: "answer", text: "The infection peaks early." },
        { by: "engine", kind: "engine", text: "SSA — the net has a capacity (overridden)" },
        { by: "engine", kind: "warning", text: "SSA on a net where ..." },
        { by: "engine", kind: "assumed", text: "I took the outcome to watch to be I." },
        { by: "assistant", kind: "assumed", text: "You left “Which?” to me; I took S." },
        { by: "engine", kind: "caveat", text: "Twenty runs give a spread." },
    ]);
    assertEquals(taggedLines({}), []);
    assertEquals(taggedLines({ caveat: "c" }).map((l: any) => l.by), ["engine"]);
});

// ---- R3: numbers in the model's prose ----

const artifact = { id: "a1", title: "SSA", data: { kind: "timeseries", x: [0, 2.5, 5], series: [{ name: "I", values: [10, 41.237, 0.35] }] } };

Deno.test("numeralsOutside: a number in no artifact, result or call is reported; the ones the evidence holds are not", () => {
    // 41.237 written as 41.2 and as about 41; 0.35 as 35%; 20 runs from the call; the time of the peak
    const prose = "I is about 41 at its peak (41.2 on average), 35% of the way there, over 20 runs by t = 2.5.";
    assertEquals(numeralsOutside(prose, [artifact, { calls: [{ command: "sim.ssa", args: { runs: 20, t_end: 5 } }] }]), []);
    assertEquals(numeralsOutside("It reaches 57 and then 41.9.", [artifact]), ["57", "41.9"]);
    // once each, in order of appearance
    assertEquals(numeralsOutside("57, 57 again, then 58", [artifact]), ["57", "58"]);
    // zero and one are not checked, but a decimal one is
    assertEquals(numeralsOutside("0 deadlocks in 1 run; 1.5 times", [artifact]), ["1.5"]);
    assertEquals(numeralsOutside("0 deadlocks in 1 run", [{}], { ignore: [] }), ["0", "1"]);
    assertEquals(numeralsOutside("0 deadlocks in 1 run", [{}]), []);
    // numbers in names are names
    assertEquals(numeralsOutside("S2 and t1 and 40s", [artifact]), []);
    assertEquals(numeralsOutside("1,000 tokens", [{ n: 1000 }]), []);
    assertEquals(numeralsOutside("1,000 tokens", [{ n: 999 }]), ["1,000"]);
    // a percentage is a ratio written differently; 'percent' counts as %
    assertEquals(numeralsOutside("35 percent and 36%", [artifact]), ["36"]);
    // truncation and rounding both count: 41.237 → 41.2, and 41.3 is neither
    assertEquals(numeralsOutside("41.2 and 41.3", [artifact]), ["41.3"]);
    // the person's own numbers are evidence
    assertEquals(numeralsOutside("With 6 more baristas.", [artifact]), ["6"]);
    assertEquals(numeralsOutside("With 6 more baristas.", [artifact], { also: "what if I had 6 more baristas?" }), []);
    // nothing to check
    assertEquals(numeralsOutside("No numbers here.", [artifact]), []);
    assertEquals(numeralsOutside("", [artifact]), []);
    assertEquals(numeralsOutside(undefined as any, undefined), []);
});

Deno.test("numeralsOutside: evidence is anything JSON-like, including numbers inside text, and survives cycles and big series", () => {
    assertEquals(numeralsOutside("It has 12 knobs and 3 seeds.", [{ summary: "12 knobs ranked over 3 seeds" }]), []);
    const cyc: any = { n: 7 };
    cyc.self = cyc;
    assertEquals(numeralsOutside("7 and 8", [cyc]), ["8"]);
    const big = { values: Array.from({ length: 20000 }, (_, i) => i * 0.5) };
    assertEquals(numeralsOutside("It reaches 4999.5 and 123456.", [big]), ["123456"]);
    // a registry-like object is skipped, not walked
    assertEquals(numeralsOutside("9", [{ execute() {}, secret: 9 }]), ["9"]);
});
